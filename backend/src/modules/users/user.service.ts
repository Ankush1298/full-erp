import { randomBytes } from 'node:crypto';
import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { RoleAssignmentService } from '../../shared/authorization/assignments.js';
import type { ScopeType } from '../../shared/authorization/catalog.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { InvitationMail } from '../../shared/email/invitation-mailer.js';
import { AuthRepository, hashToken } from '../auth/auth.repository.js';
import { invalid, parseReason } from '../people/validation.js';
import {
  USERS_DEFAULT_LIMIT,
  USERS_MAX_LIMIT,
  USER_STATUSES,
  type UserDto,
} from './user.schemas.js';

export const USER_READ_PERMISSION = 'user.account.read';
export const USER_INVITE_PERMISSION = 'user.account.invite';
/** Doc 10 has one account-state permission (row 9, CRITICAL): it governs suspension AND reactivation. */
export const USER_SUSPEND_PERMISSION = 'user.account.suspend';
export const INVITE_USER_OPERATION = 'POST /api/v1/users/invite';
export const INVITATION_LIFETIME_DAYS = 7;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const repo = new AuthRepository();

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: (typeof USER_STATUSES)[number];
  version: number;
  created_at: Date;
  identity_id?: string | null;
}
const COLS = 'id, email, display_name, status, version, created_at';
const toDto = (r: UserRow): UserDto => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  status: r.status,
  version: r.version,
  createdAt: r.created_at.toISOString(),
});

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/**
 * These permissions are evaluated at ORGANIZATION scope only. A user account has no campus or department of its own (doc 06
 * derives scope from relationships that do not exist for accounts), so a campus- or department-scoped holder could never
 * prove containment: the grant is seeded per doc 10 but INERT (403), exactly like the scoped `student.record.create` grants.
 * Whether scoped holders should reach accounts through the target's role assignments is an open product decision.
 */
async function assertOrganizationScope(
  tx: TenantTx,
  ctx: TrustedContext,
  permission: string,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, permission); // held at all: 403
  try {
    await AuthorizationEngine.assert(tx, ctx, permission, { organization_id: ctx.tenantId });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }
    throw err;
  }
}

function parseEmail(value: unknown): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const bad = Array.from(s).some((c) => (c.codePointAt(0) ?? 0) < 0x21 || c === '\u007f');
  if (s.length < 3 || s.length > 320 || !EMAIL_RE.test(s) || bad) {
    throw invalid('email must be a valid address of at most 320 characters.');
  }
  return s;
}

function parseDisplayName(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  const bad = Array.from(s).some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || n === 0x7f;
  });
  if (s.length < 1 || s.length > 200 || bad) {
    throw invalid('displayName must be 1 to 200 characters without control characters.');
  }
  return s;
}

function exactVersion(exp: ExpectedVersion): number {
  if (exp.type !== 'version') throw invalid('If-Match must carry the exact version of the user.');
  return exp.version;
}

export interface GrantRoleInput {
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string | undefined;
  reason: string;
}

export interface InviteInput {
  email: unknown;
  displayName: unknown;
  reason: unknown;
}
export interface InviteOutcome {
  result: IdempotentResult;
  /** Present only when a NEW token was issued by this call. Handed to the mailer AFTER commit; never stored or logged. */
  mail?: InvitationMail;
}

/**
 * Tenant user management (doc 11 §5.4 "Users"): list, invite, suspend, reactivate. Every mutation audits at tier 2 in the same
 * transaction with a mandatory reason (that is accountability, NOT step-up authentication, which does not exist: D10) and
 * denied requests are not audited (D9). Nothing here grants a role: roles go through RoleAssignmentService.
 */
export class UserService {
  /** Minimal user fields of the caller's own tenant. Not held: 403. Scoped (campus/department) holders: 403 (inert). */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    query: { status?: unknown; limit?: unknown; afterId?: unknown },
  ): Promise<{ data: UserDto[]; nextAfterId: string | null }> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    const status = query.status;
    if (status !== undefined && !(USER_STATUSES as readonly unknown[]).includes(status)) {
      throw invalid(`status must be one of ${USER_STATUSES.join(', ')}.`);
    }
    const limit = query.limit === undefined ? USERS_DEFAULT_LIMIT : query.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > USERS_MAX_LIMIT) {
      throw invalid(`limit must be an integer from 1 to ${USERS_MAX_LIMIT}.`);
    }
    const after = query.afterId;
    if (after !== undefined && !(typeof after === 'string' && isUuidV7(after))) {
      throw invalid('afterId must be a UUIDv7.');
    }
    await assertOrganizationScope(tx, ctx, USER_READ_PERMISSION);

    const n = limit as number;
    const res = await tx.query<UserRow>(
      `SELECT ${COLS} FROM app.users
        WHERE organization_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id LIMIT $4`,
      [ctx.tenantId, status ?? null, typeof after === 'string' ? after.toLowerCase() : null, n + 1],
    );
    const rows = res.rows.slice(0, n);
    return {
      data: rows.map(toDto),
      nextAfterId: res.rows.length > n ? (rows[n - 1]?.id ?? null) : null,
    };
  }

  /**
   * Creates (or re-issues) an invitation, idempotently. Order: shape (400) -> staff actor (403) -> permission and organization
   * scope (403) -> Idempotency-Key (428/400) -> claim/replay -> per-(tenant, e-mail) lock -> user row and token -> audit.
   *
   *  - New e-mail in this tenant: an INVITED membership (no identity, no role) and one token.
   *  - Existing INVITED membership: the outstanding tokens are withdrawn and a new one issued (re-invite).
   *  - Any other existing membership (ACTIVE, SUSPENDED, DEACTIVATED): 409. That is a fact about THIS tenant only; whether the
   *    address has an account anywhere else is never consulted here, so nothing about other tenants can leak.
   * The token is 32 random bytes; only its SHA-256 is stored. The raw token leaves only in the returned `mail`.
   */
  static async invite(
    tx: TenantTx,
    ctx: TrustedContext,
    input: InviteInput,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<InviteOutcome> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Invitation payload is required.');
    const email = parseEmail(input.email);
    const displayName = parseDisplayName(input.displayName);
    const reason = parseReason(input.reason);

    AuthorizationEngine.assertStaffActor(ctx);
    await assertOrganizationScope(tx, ctx, USER_INVITE_PERMISSION);
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};
    const issued: { mail?: InvitationMail } = {};

    const result = await runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: INVITE_USER_OPERATION,
        // The NORMALISED request: equal requests hash equally. The e-mail is part of the hash only, never stored.
        request: { email, displayName, reason },
      },
      async () => {
        // Serialises concurrent invitations of one address in this tenant (no 23505 race, no two live tokens).
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `app.user_invite:${ctx.tenantId}:${email}`,
        ]);
        const existing = await tx.query<{ id: string; status: string; display_name: string }>(
          `SELECT id, status, display_name FROM app.users
            WHERE organization_id = $1 AND email = $2 FOR NO KEY UPDATE`,
          [ctx.tenantId, email],
        );
        const found = existing.rows[0];
        if (found && found.status !== 'INVITED') {
          throw new AppError(
            409,
            'CONFLICT',
            'A user with this e-mail address already exists in this organization.',
          );
        }
        const userId = found?.id ?? uuidv7();
        if (!found) {
          await tx.query(
            `INSERT INTO app.users (id, organization_id, email, display_name, status)
             VALUES ($1, $2, $3, $4, 'INVITED')`,
            [userId, ctx.tenantId, email, displayName],
          );
        } else {
          await tx.query(
            `UPDATE app.invite_tokens SET revoked_at = now()
              WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
            [ctx.tenantId, userId],
          );
        }

        const rawToken = randomBytes(32).toString('base64url'); // 256 bits
        const invitationId = uuidv7();
        const inserted = await tx.query<{ expires_at: Date }>(
          `INSERT INTO app.invite_tokens
             (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
           VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() + make_interval(days => $6::int))
           RETURNING expires_at`,
          [
            invitationId,
            ctx.tenantId,
            userId,
            hashToken(rawToken),
            ctx.userId,
            INVITATION_LIFETIME_DAYS,
          ],
        );
        const expiresAt = inserted.rows[0]!.expires_at;

        const org = await tx.query<{ name: string }>(
          'SELECT name FROM app.organizations WHERE id = $1',
          [ctx.tenantId],
        );

        // No e-mail address, name or token in the audit event: the user id identifies the person.
        await recordAudit(
          tx,
          ctx,
          {
            action: 'user.invite',
            resourceType: 'user',
            resourceId: userId,
            riskTier: 2,
            reasonText: reason,
            changes: { status: { old: found ? 'INVITED' : null, new: 'INVITED' } },
            metadata: { invitationId, reinvite: found !== undefined },
          },
          meta,
        );

        issued.mail = new InvitationMail(
          email,
          found?.display_name ?? displayName,
          org.rows[0]?.name ?? '',
          rawToken,
          expiresAt,
        );
        return {
          status: 201,
          body: {
            success: true,
            data: { userId, invitationId, expiresAt: expiresAt.toISOString() },
          },
        };
      },
    );
    return { result, ...(issued.mail && !result.replayed ? { mail: issued.mail } : {}) };
  }

  /** ACTIVE -> SUSPENDED. Revokes this membership's sessions in the same transaction. */
  static async suspend(
    tx: TenantTx,
    ctx: TrustedContext,
    userId: string,
    input: { reason: unknown },
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<UserDto> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Payload is required.');
    if (!isUuidV7(userId)) throw invalid('Invalid user ID.');
    const id = userId.toLowerCase();
    const reason = parseReason(input.reason);
    const expected = exactVersion(options.expected);

    AuthorizationEngine.assertStaffActor(ctx);
    await assertOrganizationScope(tx, ctx, USER_SUSPEND_PERMISSION);
    if (id === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'Access denied.'); // never yourself

    // Serialises every "might remove the last administrator" decision of this tenant (two admins suspending each other).
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `app.user_admin_exclusive:${ctx.tenantId}`,
    ]);
    const current = await lockUser(tx, ctx.tenantId, id);
    if (current.version !== expected) throw new AppError(409, 'CONFLICT', 'User version mismatch.');
    if (current.status !== 'ACTIVE') {
      throw new AppError(
        409,
        'USER_STATUS_TRANSITION_INVALID',
        'Only an ACTIVE user can be suspended.',
      );
    }
    if (await isLastActiveAdministrator(tx, ctx.tenantId, id)) {
      throw new AppError(
        409,
        'LAST_ADMINISTRATOR',
        'The last active administrator of the organization cannot be suspended.',
      );
    }

    const updated = await tx.query<UserRow>(
      `UPDATE app.users SET status = 'SUSPENDED'
        WHERE organization_id = $1 AND id = $2 AND version = $3 AND status = 'ACTIVE'
        RETURNING ${COLS}`,
      [ctx.tenantId, id, current.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'User was changed concurrently. Retry.');

    const revoked = current.identity_id
      ? await repo.revokeMembershipSessions(tx, current.identity_id, ctx.tenantId)
      : 0;
    await recordAudit(
      tx,
      ctx,
      {
        action: 'user.suspend',
        resourceType: 'user',
        resourceId: id,
        riskTier: 2,
        reasonText: reason,
        changes: { status: { old: 'ACTIVE', new: 'SUSPENDED' } },
        metadata: { sessionsRevoked: revoked },
      },
      options.meta ?? {},
    );
    return toDto(saved);
  }

  /** SUSPENDED -> ACTIVE. Sessions that were revoked at suspension stay revoked: the user signs in again. */
  static async reactivate(
    tx: TenantTx,
    ctx: TrustedContext,
    userId: string,
    input: { reason: unknown },
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<UserDto> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Payload is required.');
    if (!isUuidV7(userId)) throw invalid('Invalid user ID.');
    const id = userId.toLowerCase();
    const reason = parseReason(input.reason);
    const expected = exactVersion(options.expected);

    AuthorizationEngine.assertStaffActor(ctx);
    await assertOrganizationScope(tx, ctx, USER_SUSPEND_PERMISSION);

    const current = await lockUser(tx, ctx.tenantId, id);
    if (current.version !== expected) throw new AppError(409, 'CONFLICT', 'User version mismatch.');
    if (current.status !== 'SUSPENDED' || !current.identity_id) {
      throw new AppError(
        409,
        'USER_STATUS_TRANSITION_INVALID',
        'Only a SUSPENDED user can be reactivated.',
      );
    }
    const updated = await tx.query<UserRow>(
      `UPDATE app.users SET status = 'ACTIVE'
        WHERE organization_id = $1 AND id = $2 AND version = $3 AND status = 'SUSPENDED'
        RETURNING ${COLS}`,
      [ctx.tenantId, id, current.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'User was changed concurrently. Retry.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'user.reactivate',
        resourceType: 'user',
        resourceId: id,
        riskTier: 2,
        reasonText: reason,
        changes: { status: { old: 'SUSPENDED', new: 'ACTIVE' } },
      },
      options.meta ?? {},
    );
    return toDto(saved);
  }

  /**
   * Grants a role to a user through the EXISTING RoleAssignmentService, which alone decides authorization (the grantor's
   * `role.assignment.grant` permission, grant rules, scope containment, mandatory reason, person-identity invariant, audit).
   * This wrapper only names the target; it adds no rule and bypasses none. The route's permission gate has already run, as
   * the service's lock-order note requires.
   */
  static async grantRole(
    tx: TenantTx,
    ctx: TrustedContext,
    targetUserId: string,
    input: GrantRoleInput,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    return RoleAssignmentService.grant(
      tx,
      ctx,
      {
        targetUserId,
        roleId: input.roleId,
        scopeType: input.scopeType,
        reason: input.reason,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      },
      meta,
    );
  }
}

/** The user row of THIS tenant, locked (`FOR NO KEY UPDATE`). Missing and other-tenant are the same 404. */
async function lockUser(tx: TenantTx, tenantId: string, id: string): Promise<UserRow> {
  const res = await tx.query<UserRow>(
    `SELECT ${COLS}, identity_id FROM app.users
      WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [tenantId, id],
  );
  const row = res.rows[0];
  if (!row) throw resourceNotFound();
  return row;
}

/**
 * True when `userId` is an effective administrator and no OTHER ACTIVE user is. Called under the tenant's administrator
 * advisory lock, so two concurrent suspensions cannot both pass.
 */
async function isLastActiveAdministrator(
  tx: TenantTx,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const admins = new Set(await AuthorizationEngine.effectiveAdministratorIds(tx, tenantId));
  return admins.has(userId) && admins.size === 1;
}
