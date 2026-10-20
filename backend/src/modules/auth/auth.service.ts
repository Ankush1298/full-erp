import { AppError } from '../../shared/errors/http-errors.js';
import type { Database } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import {
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './auth.repository.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import type { AuthRepository } from './auth.repository.js';
import { issueTrustedContext } from '../../shared/tenancy/issue-trusted-context.js';
import type { AuthStrength, TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';

/** 32 random bytes, base64url: 43 characters. */
export const INVITE_TOKEN_PATTERN = '^[A-Za-z0-9_-]{43}$';
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
export const DEFAULT_STEP_UP_MAX_AGE_MS = 600_000;

/** One answer for EVERY failure: unknown, expired, used, withdrawn, wrong password, locked or disabled identity. */
function invalidInvitation(): AppError {
  return new AppError(400, 'INVALID_INVITATION', 'The invitation is invalid or has expired.');
}

interface LockedInvitation {
  organization_id: string;
  user_id: string;
  email: string;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly repo: AuthRepository,
    private readonly stepUpMaxAgeMs: number = DEFAULT_STEP_UP_MAX_AGE_MS,
  ) {}

  async login(email: string, passwordPlain: string, selectedTenantSlug?: string) {
    // 1. Locate identity safely (without tenant context yet, as they are logging in)
    const result = await this.db.withSystem(async (tx) => {
      const identity = await this.repo.findIdentityByEmail(tx, email);

      // Enumeration resistance: we do the argon2 verify EVEN if identity is null
      // using a dummy hash to consume roughly the same amount of time.
      // For this spike, we'll just delay or use a known dummy hash.
      const dummyHash =
        '$argon2id$v=19$m=65536,p=4,t=3$GI/IaMNhy7fDZfTydHceqA$1TIQt3s6rKbgEXwrXDRpK4vc00Xvl4vlcUWy/neeQzA';
      const isPasswordValid = await verifyPassword(
        identity ? identity.password_hash : dummyHash,
        passwordPlain,
      );

      if (!identity || !isPasswordValid) {
        // Return (don't throw) so the failure counter COMMITS; a throw would roll it back and the
        // lockout could never trigger. The caller raises the error after the transaction.
        if (identity) await this.repo.recordFailedLogin(tx, identity.id);
        return null;
      }

      if (identity.locked_until && identity.locked_until > new Date()) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      if (identity.status !== 'ACTIVE') {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      // 2. Determine tenant membership
      const memberships = await this.repo.findMemberships(tx, identity.id);
      if (memberships.length === 0) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'); // No active memberships
      }

      let activeMembership = memberships[0]!;
      if (selectedTenantSlug) {
        const found = memberships.find((m) => m.org_slug === selectedTenantSlug);
        if (!found) {
          // Attack: Client requested a tenant they don't belong to.
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
        }
        activeMembership = found;
      }

      await this.repo.recordSuccessfulLogin(tx, identity.id);

      // 3. Create session
      const rawToken = generateSessionToken();
      const hashedToken = hashToken(rawToken);
      const sessionId = uuidv7();

      // Expire in 12 hours for the spike
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 12);

      await this.repo.createSession(
        tx,
        identity.id,
        activeMembership.organization_id,
        sessionId,
        hashedToken,
        expiresAt,
      );

      return {
        sessionToken: rawToken,
        identityId: identity.id,
        tenantId: activeMembership.organization_id,
        userId: activeMembership.user_id, // tenant-scoped membership id
      };
    });
    if (!result) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    return result;
  }

  /**
   * Accepts an invitation (`POST /auth/accept-invite`, public). The caller supplies ONLY the token and a password: the tenant,
   * the membership and the e-mail all come from the stored invitation (found by the token's hash), and no role or scope can be
   * named or changed (an invitation carries none; roles are granted later by an authorized human).
   *
   * ONE transaction (`withSystem`, no tenant context exists yet):
   *  1. `platform.lock_invitation` finds a usable invitation by hash and LOCKS it: concurrent acceptances of one token queue
   *     here, and the loser finds nothing after the winner commits (single use under concurrency).
   *  2. Identity: none for this e-mail yet -> an ACTIVE identity is created with the chosen password. One exists (for example
   *     from another tenant) -> its CURRENT password must be supplied and is verified; it is never changed here, so an
   *     invitation cannot take over an account. A wrong password counts as a failed login (the shared lockout).
   *  3. `platform.complete_invitation` consumes the token and activates the membership atomically (database-side checks:
   *     membership still INVITED, identity ACTIVE with the membership's own e-mail) and sets the transaction-local context.
   *  4. The audit event is written under that context in the same transaction: no audit, no acceptance.
   * No session is issued: the new member logs in through the normal flow. Every failure is the same 400, so the response never
   * says whether the e-mail already belongs to an account (in this or any other tenant).
   */
  async acceptInvitation(
    token: unknown,
    password: unknown,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (
      typeof token !== 'string' ||
      !new RegExp(INVITE_TOKEN_PATTERN).test(token) ||
      typeof password !== 'string' ||
      password.length < MIN_PASSWORD_LENGTH ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw invalidInvitation();
    }
    const tokenHash = hashToken(token);

    const ok = await this.db.withSystem(async (tx) => {
      const found = await tx.query<LockedInvitation>('SELECT * FROM platform.lock_invitation($1)', [
        tokenHash,
      ]);
      const invitation = found.rows[0];
      if (!invitation) return false;

      let identityId: string;
      let existing = await this.repo.lockIdentityByEmail(tx, invitation.email);
      let createdNow: string | null = null;
      if (!existing) {
        createdNow = await this.repo.createIdentity(
          tx,
          uuidv7(),
          invitation.email,
          await hashPassword(password),
        );
        // Lost a race with another first-time acceptance of the same address (typically another tenant's invitation): the
        // INSERT waited for that transaction, so the identity exists now and is treated like any existing one.
        if (!createdNow) existing = await this.repo.lockIdentityByEmail(tx, invitation.email);
        if (!createdNow && !existing) return false;
      }
      if (createdNow) {
        identityId = createdNow;
      } else {
        const identity = existing!;
        if (identity.status !== 'ACTIVE') return false;
        if (identity.locked_until && identity.locked_until > new Date()) return false;
        if (!(await verifyPassword(identity.password_hash, password))) {
          // Returned, not thrown: the failure counter must COMMIT (same reasoning as login).
          await this.repo.recordFailedLogin(tx, identity.id);
          return false;
        }
        await this.repo.recordSuccessfulLogin(tx, identity.id);
        identityId = identity.id;
      }

      try {
        await tx.query('SELECT * FROM platform.complete_invitation($1, $2)', [
          tokenHash,
          identityId,
        ]);
      } catch (err) {
        // 'no_data_found': the invitation stopped being usable between the lock and now. Roll everything back.
        if ((err as { code?: string }).code === 'P0002') throw invalidInvitation();
        throw err;
      }

      // The function set the transaction-local context from the invitation row; the user is ACTIVE now.
      const ctx = issueTrustedContext({
        tenantId: invitation.organization_id,
        userId: invitation.user_id,
        actorKind: 'STAFF',
      });
      await recordAudit(
        tx,
        ctx,
        {
          action: 'user.invitation_accept',
          resourceType: 'user',
          resourceId: invitation.user_id,
          riskTier: 1,
          changes: { status: { old: 'INVITED', new: 'ACTIVE' } },
        },
        meta,
      );
      return true;
    });
    if (!ok) throw invalidInvitation();
  }

  /** Display data for the signed-in user (UI only). Everything comes from the tenant transaction. */
  async describe(ctx: TrustedContext) {
    return this.db.withTenant(ctx, async (tx) => {
      const user = await tx.query<{ display_name: string }>(
        'SELECT display_name FROM app.users WHERE organization_id = $1 AND id = $2',
        [ctx.tenantId, ctx.userId],
      );
      const who = await AuthorizationEngine.describeActor(tx, ctx);
      return {
        display_name: user.rows[0]?.display_name ?? '',
        roles: who.roleCodes,
        capabilities: who.capabilities,
      };
    });
  }

  async logout(rawToken: string): Promise<void> {
    const hashed = hashToken(rawToken);
    await this.db.withSystem(async (tx) => {
      const session = await this.repo.findSessionByToken(tx, hashed);
      if (session) {
        await this.repo.revokeSession(tx, session.id);
      }
    });
  }

  async validateSession(rawToken: string): Promise<TrustedContext> {
    const hashed = hashToken(rawToken);
    const base = await this.db.withSystem(async (tx) => {
      const session = await this.repo.findSessionByToken(tx, hashed);

      if (!session) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid session');
      }
      if (session.revoked_at || session.expires_at < new Date()) {
        throw new AppError(401, 'UNAUTHORIZED', 'Session expired');
      }

      const identity = await tx.query<{ status: string }>(
        'SELECT status FROM platform.identities WHERE id = $1',
        [session.identity_id],
      );
      if (identity.rows[0]?.status !== 'ACTIVE') {
        throw new AppError(401, 'UNAUTHORIZED', 'Account suspended');
      }

      const memberships = await this.repo.findMemberships(tx, session.identity_id);
      const activeMembership = memberships.find((m) => m.organization_id === session.tenant_id);

      if (!activeMembership || activeMembership.status !== 'ACTIVE') {
        throw new AppError(401, 'UNAUTHORIZED', 'Membership suspended');
      }
      const userId = activeMembership.user_id;

      return {
        tenantId: session.tenant_id,
        userId,
        sessionId: session.id,
        stepUpAt: session.step_up_at,
        authStrength: session.auth_strength,
        mfaVerifiedAt: session.mfa_verified_at,
      };
    });

    return this.resolveContext(
      base.tenantId,
      base.userId,
      base.sessionId,
      base.stepUpAt,
      base.authStrength,
      base.mfaVerifiedAt,
    );
  }

  /**
   * Verifies the user's password to elevate the current session (PASSWORD_REAUTH).
   * Atomically records the session step-up and risk-tier-2 audit event in a tenant transaction.
   * On audit failure, transaction rolls back so the session is not elevated.
   * On incorrect password, updates the failure counter and commits it before throwing generic 401.
   */
  async stepUp(
    ctx: TrustedContext,
    passwordPlain: string,
    meta: AuditRequestMeta = {},
  ): Promise<{
    steppedUp: true;
    authStrength: AuthStrength;
    stepUpAt: Date;
    maxAgeSeconds: number;
  }> {
    if (!ctx.sessionId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Session required for step-up.');
    }
    if (
      typeof passwordPlain !== 'string' ||
      passwordPlain.length < MIN_PASSWORD_LENGTH ||
      passwordPlain.length > MAX_PASSWORD_LENGTH
    ) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    // 1. Look up authoritative session and identity to verify credentials
    const authData = await this.db.withSystem(async (tx) => {
      const session = await this.repo.findSessionById(tx, ctx.sessionId!);
      if (!session || session.revoked_at || session.expires_at < new Date()) {
        throw new AppError(401, 'UNAUTHORIZED', 'Session expired or revoked.');
      }
      if (session.tenant_id !== ctx.tenantId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Session tenant mismatch.');
      }

      const identity = await this.repo.findIdentityById(tx, session.identity_id);
      if (!identity || identity.status !== 'ACTIVE') {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }
      if (identity.locked_until && identity.locked_until > new Date()) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      }

      const isPasswordValid = await verifyPassword(identity.password_hash, passwordPlain);
      if (!isPasswordValid) {
        // Record failure so counter commits; return null to signal failure
        await this.repo.recordFailedLogin(tx, identity.id);
        return null;
      }

      return { session, identity };
    });

    if (!authData) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    const { session, identity } = authData;

    // 2. Atomically record step-up, reset lockout counter, and write audit event in a tenant transaction.
    // If audit insert fails, withTenant rolls back the transaction, leaving session untouched.
    const result = await this.db.withTenant(ctx, async (tx) => {
      const recorded = await this.repo.recordStepUp(
        tx,
        session.id,
        'PASSWORD_REAUTH',
        this.stepUpMaxAgeMs,
      );
      await this.repo.recordSuccessfulLogin(tx, identity.id);

      await recordAudit(
        tx,
        ctx,
        {
          action: 'auth.step_up',
          resourceType: 'session',
          resourceId: session.id,
          riskTier: 2,
          metadata: {
            authStrength: recorded.auth_strength,
          },
        },
        {
          ...meta,
          sessionId: session.id,
        },
      );

      return recorded;
    });

    return {
      steppedUp: true,
      authStrength: result.auth_strength,
      stepUpAt: result.step_up_at,
      maxAgeSeconds: Math.floor(this.stepUpMaxAgeMs / 1000),
    };
  }

  /**
   * actor_kind comes from the student mapping, read inside the tenant (RLS hides app.students from a
   * tenant-less connection). The probe context is STUDENT-kind on purpose: it is the *least*
   * privileged kind, so it can only ever see the user's own student row.
   */
  private async resolveContext(
    tenantId: string,
    userId: string,
    sessionId?: string,
    stepUpAt: Date | null = null,
    authStrength: AuthStrength = 'PASSWORD',
    mfaVerifiedAt: Date | null = null,
  ): Promise<TrustedContext> {
    const probe = issueTrustedContext({
      tenantId,
      userId,
      actorKind: 'STUDENT',
      sessionId,
      stepUpAt,
      authStrength,
      mfaVerifiedAt,
    });
    const isStudent = await this.db.withTenant(probe, async (tx) => {
      const r = await tx.query('SELECT 1 FROM app.students WHERE user_id = $1', [userId]);
      return (r.rowCount ?? 0) > 0;
    });
    return issueTrustedContext({
      tenantId,
      userId,
      actorKind: isStudent ? 'STUDENT' : 'STAFF',
      sessionId,
      stepUpAt,
      authStrength,
      mfaVerifiedAt,
    });
  }
}
