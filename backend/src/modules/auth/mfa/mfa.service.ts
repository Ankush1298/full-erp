import { createHash, randomBytes } from 'node:crypto';
import { AppError, resourceNotFound } from '../../../shared/errors/http-errors.js';
import type { Database, TenantTx } from '../../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../../shared/ids/uuidv7.js';
import { recordAudit, type AuditRequestMeta } from '../../../shared/audit/index.js';
import { AuthorizationEngine } from '../../../shared/authorization/engine.js';
import {
  hasActiveVerifiedAdminMfa,
  isMfaRequired,
  mayActOnAllRolesOf,
} from '../../../shared/authorization/mfa-policy.js';
import type { KeyRingConfig } from '../../../config/env.js';
import {
  isTrustedContext,
  type AuthStrength,
  type TrustedContext,
} from '../../../shared/tenancy/trusted-context.js';
import { invalid, parseReason } from '../../people/validation.js';
import { AuthRepository } from '../auth.repository.js';
import { isStepUpSatisfied } from '../auth.hook.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  mfaUnavailable,
  MfaSecretBox,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
  type SecretBinding,
} from './mfa-crypto.js';
import {
  base32Encode,
  generateTotpSecret,
  provisioningUri,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  verifyTotp,
} from './totp.js';

/**
 * TOTP MFA lifecycle (docs/architecture/v3/23-mfa.md). Every operation acts on the CALLER ONLY: the user, tenant and
 * session come from the TrustedContext; no request field names a user. Row security on app.user_mfa_factors /
 * app.user_recovery_codes independently restricts the runtime role to the caller's own rows.
 *
 * Secrets: generated here, sealed with the dedicated MFA keyring before they touch the database, returned to the caller
 * exactly once (enrollment start) and never logged or audited. Recovery codes: returned once, stored as salted hashes.
 */
export const MFA_ISSUER = 'Anesa';
/** A started enrollment must be confirmed from the same session within this time. */
export const ENROLLMENT_TTL_SECONDS = 600;

const repo = new AuthRepository();

interface FactorRow {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  secret_enc: Buffer;
  secret_key_label: string;
  enroll_session_id: string | null;
  pending_expired: boolean;
  confirmed_at: Date | null;
  last_used_step: string | null; // bigint arrives as a string
  last_used_at: Date | null;
  enrollment_ticket_id: string | null;
  verified_enrollment: boolean;
}

interface SessionFacts {
  sessionId: string;
  identityId: string;
}

export interface MfaStatus {
  enrolled: boolean;
  required: boolean;
  sessionVerified: boolean;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  pendingEnrollment: boolean;
  unusedRecoveryCodes: number;
}

export interface StepUpResult {
  steppedUp: true;
  authStrength: AuthStrength;
  stepUpAt: Date;
  maxAgeSeconds: number;
}

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/** One answer for every wrong, malformed, replayed or unusable code. */
function invalidCode(): AppError {
  return new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
}

function stepUpRequired(): AppError {
  return new AppError(403, 'STEP_UP_REQUIRED', 'Step-up authentication required for this action.');
}

export class MfaService {
  /** Undefined when MFA_ENCRYPTION_KEYS is not configured (development/test only): every sealing operation is a 503. */
  private readonly box: MfaSecretBox | undefined;

  constructor(
    private readonly db: Database,
    keyRing: KeyRingConfig | undefined,
    private readonly stepUpMaxAgeMs: number,
    private readonly now: () => number = Date.now,
    /** Clock for TOTP time steps only (tests advance it without ageing step-ups). Defaults to `now`. */
    private readonly totpNow: () => number = now,
  ) {
    this.box = keyRing ? new MfaSecretBox(keyRing) : undefined;
  }

  private requireBox(): MfaSecretBox {
    if (!this.box) throw mfaUnavailable();
    return this.box;
  }

  private binding(ctx: TrustedContext, factorId: string): SecretBinding {
    return { organizationId: ctx.tenantId, userId: ctx.userId, factorId };
  }

  private hasFresh(ctx: TrustedContext, min: AuthStrength): boolean {
    return isStepUpSatisfied(ctx, min, this.now(), this.stepUpMaxAgeMs);
  }

  /**
   * The authoritative session behind the context: live, same tenant, identity ACTIVE and not locked. Re-read inside the
   * transaction so a session revoked a moment ago cannot verify anything.
   */
  private async session(tx: TenantTx, ctx: TrustedContext): Promise<SessionFacts> {
    if (!ctx.sessionId) throw new AppError(401, 'UNAUTHORIZED', 'Session required.');
    const s = await repo.findSessionById(tx, ctx.sessionId);
    if (!s || s.revoked_at || s.expires_at < new Date() || s.tenant_id !== ctx.tenantId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Session expired or revoked.');
    }
    const identity = await repo.findIdentityById(tx, s.identity_id);
    if (
      !identity ||
      identity.status !== 'ACTIVE' ||
      (identity.locked_until && identity.locked_until > new Date())
    ) {
      throw invalidCode();
    }
    return { sessionId: s.id, identityId: s.identity_id };
  }

  private async factor(
    tx: TenantTx,
    ctx: TrustedContext,
    status: 'PENDING' | 'ACTIVE',
  ): Promise<FactorRow | undefined> {
    const res = await tx.query<FactorRow>(
      `SELECT id, status, secret_enc, secret_key_label, enroll_session_id,
              (pending_expires_at IS NOT NULL AND pending_expires_at <= now()) AS pending_expired,
              confirmed_at, last_used_step, last_used_at, enrollment_ticket_id, verified_enrollment
         FROM app.user_mfa_factors
        WHERE organization_id = $1 AND user_id = $2 AND status = $3
        FOR UPDATE`,
      [ctx.tenantId, ctx.userId, status],
    );
    return res.rows[0];
  }

  /** Atomically claims a verified time step: it must be newer than every step this factor ever accepted. */
  private async claimStep(tx: TenantTx, factorId: string, step: number): Promise<boolean> {
    const res = await tx.query(
      `UPDATE app.user_mfa_factors
          SET last_used_step = $2, last_used_at = now()
        WHERE id = $1 AND status = 'ACTIVE' AND (last_used_step IS NULL OR last_used_step < $2)`,
      [factorId, step],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** Opportunistic re-encryption under the active key after a successful use (key rotation, runbook §4). */
  private async reencryptIfStale(
    tx: TenantTx,
    ctx: TrustedContext,
    f: FactorRow,
    seed: Buffer,
  ): Promise<void> {
    const box = this.requireBox();
    if (f.secret_key_label === box.activeKeyId) return;
    const sealed = box.seal(seed, this.binding(ctx, f.id));
    await tx.query(
      `UPDATE app.user_mfa_factors SET secret_enc = $2, secret_key_label = $3 WHERE id = $1 AND status = 'ACTIVE'`,
      [f.id, sealed.sealed, sealed.keyId],
    );
  }

  private async issueRecoveryCodes(tx: TenantTx, ctx: TrustedContext): Promise<string[]> {
    await tx.query(
      `UPDATE app.user_recovery_codes SET revoked_at = now()
        WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [ctx.tenantId, ctx.userId],
    );
    const codes = generateRecoveryCodes();
    for (const code of codes) {
      await tx.query(
        `INSERT INTO app.user_recovery_codes (id, organization_id, user_id, code_hash) VALUES ($1, $2, $3, $4)`,
        [
          uuidv7(),
          ctx.tenantId,
          ctx.userId,
          hashRecoveryCode(ctx.tenantId, ctx.userId, normaliseRecoveryCode(code)!),
        ],
      );
    }
    return codes;
  }

  private async unusedCodes(tx: TenantTx, ctx: TrustedContext): Promise<number> {
    const res = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.user_recovery_codes
        WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [ctx.tenantId, ctx.userId],
    );
    return res.rows[0]?.n ?? 0;
  }

  /** GET /me/mfa: never returns a secret, a code or a hash. */
  async status(ctx: TrustedContext): Promise<MfaStatus> {
    ensureTrusted(ctx);
    return this.db.withTenant(ctx, async (tx) => {
      const rows = await tx.query<{
        status: string;
        confirmed_at: Date | null;
        last_used_at: Date | null;
      }>(
        `SELECT status, confirmed_at, last_used_at FROM app.user_mfa_factors
          WHERE organization_id = $1 AND user_id = $2 AND status IN ('PENDING', 'ACTIVE')
            AND (status = 'ACTIVE' OR pending_expires_at > now())`,
        [ctx.tenantId, ctx.userId],
      );
      const active = rows.rows.find((r) => r.status === 'ACTIVE');
      return {
        enrolled: active !== undefined,
        required: await isMfaRequired(tx, ctx.tenantId, ctx.userId),
        sessionVerified: ctx.mfaVerifiedAt !== null,
        confirmedAt: active?.confirmed_at?.toISOString() ?? null,
        lastUsedAt: active?.last_used_at?.toISOString() ?? null,
        pendingEnrollment: rows.rows.some((r) => r.status === 'PENDING'),
        unusedRecoveryCodes: active ? await this.unusedCodes(tx, ctx) : 0,
      };
    });
  }

  /**
   * POST /me/mfa/totp/enroll. Starts (or restarts) an enrollment for the caller and returns the secret ONCE.
   *  - No ACTIVE factor (first enrollment, the controlled bootstrap): requires a fresh step-up of at least PASSWORD_REAUTH
   *    on THIS session, i.e. the password re-entered within the step-up window. For users in MFA-required roles, an
   *    administrator-issued enrollment ticket is mandatory.
   *  - An ACTIVE factor exists (replacing the authenticator): requires a fresh PASSWORD_MFA step-up (the current factor).
   * Any earlier PENDING enrollment is withdrawn. Two concurrent starts cannot both succeed (one-pending unique index).
   */
  async startEnrollment(
    ctx: TrustedContext,
    input?: { ticket?: string },
    meta: AuditRequestMeta = {},
  ): Promise<{
    factorId: string;
    secret: string;
    otpauthUri: string;
    algorithm: 'SHA1';
    digits: number;
    period: number;
    expiresInSeconds: number;
  }> {
    ensureTrusted(ctx);
    const box = this.requireBox();
    try {
      return await this.db.withTenant(ctx, async (tx) => {
        await this.session(tx, ctx);
        const active = await this.factor(tx, ctx, 'ACTIVE');
        if (!this.hasFresh(ctx, active ? 'PASSWORD_MFA' : 'PASSWORD_REAUTH'))
          throw stepUpRequired();

        const mfaRequired = await isMfaRequired(tx, ctx.tenantId, ctx.userId);
        let enrollmentTicketId: string | null = null;
        let verifiedEnrollment = false;

        const ticketToken =
          typeof input?.ticket === 'string' && input.ticket.trim().length > 0
            ? input.ticket.trim()
            : undefined;

        if (mfaRequired) {
          if (active && active.verified_enrollment) {
            verifiedEnrollment = true;
          } else {
            if (!ticketToken) {
              throw new AppError(
                403,
                'MFA_TICKET_REQUIRED',
                'An administrator-issued enrollment ticket is required to enroll MFA for this account.',
              );
            }
          }
        }

        if (ticketToken) {
          const codeHash = createHash('sha256').update(ticketToken).digest('hex');
          const ticketRes = await tx.query<{ id: string; created_by: string | null }>(
            `SELECT id, created_by FROM app.mfa_enrollment_tickets
              WHERE organization_id = $1 AND user_id = $2 AND code_hash = $3
                AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
            [ctx.tenantId, ctx.userId, codeHash],
          );
          if (ticketRes.rowCount === 0) {
            throw new AppError(401, 'INVALID_TICKET', 'Invalid or expired enrollment ticket.');
          }
          const ticket = ticketRes.rows[0]!;
          if (ticket.created_by === null) {
            // Serialize bootstrap operations per tenant
            await tx.query('SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))', [
              `app.mfa_bootstrap_exclusive:${ctx.tenantId}`,
            ]);
            // Operational bootstrap ticket: strictly disabled if an active verified administrator factor already exists
            if (await hasActiveVerifiedAdminMfa(tx, ctx.tenantId)) {
              throw new AppError(
                409,
                'BOOTSTRAP_DISABLED',
                'First-administrator bootstrap is disabled: an active verified administrator already exists.',
              );
            }
          }
          enrollmentTicketId = ticket.id;
          verifiedEnrollment = true;
        }

        await tx.query(
          `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'CANCELLED'
            WHERE organization_id = $1 AND user_id = $2 AND status = 'PENDING'`,
          [ctx.tenantId, ctx.userId],
        );
        const factorId = uuidv7();
        const seed = generateTotpSecret();
        const sealed = box.seal(seed, this.binding(ctx, factorId));
        await tx.query(
          `INSERT INTO app.user_mfa_factors
             (id, organization_id, user_id, status, secret_enc, secret_key_label,
              enroll_session_id, pending_expires_at, enrollment_ticket_id, verified_enrollment)
           VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, now() + make_interval(secs => $7), $8, $9)`,
          [
            factorId,
            ctx.tenantId,
            ctx.userId,
            sealed.sealed,
            sealed.keyId,
            ctx.sessionId,
            ENROLLMENT_TTL_SECONDS,
            enrollmentTicketId,
            verifiedEnrollment,
          ],
        );
        const email = await tx.query<{ email: string }>(
          'SELECT email FROM app.users WHERE organization_id = $1 AND id = $2',
          [ctx.tenantId, ctx.userId],
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'auth.mfa.enroll_start',
            resourceType: 'mfa_factor',
            resourceId: factorId,
            riskTier: 2,
            metadata: { replacing: active !== undefined, verified: verifiedEnrollment },
          },
          meta,
        );
        return {
          factorId,
          secret: base32Encode(seed),
          otpauthUri: provisioningUri(seed, MFA_ISSUER, email.rows[0]?.email ?? ctx.userId),
          algorithm: 'SHA1' as const,
          digits: TOTP_DIGITS,
          period: TOTP_PERIOD_SECONDS,
          expiresInSeconds: ENROLLMENT_TTL_SECONDS,
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'Another enrollment is in progress. Retry.');
      }
      throw err;
    }
  }

  /** DELETE /me/mfa/totp/enroll: withdraws the caller's pending enrollment (idempotent). */
  async cancelEnrollment(ctx: TrustedContext, meta: AuditRequestMeta = {}): Promise<void> {
    ensureTrusted(ctx);
    await this.db.withTenant(ctx, async (tx) => {
      const res = await tx.query<{ id: string }>(
        `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'CANCELLED'
          WHERE organization_id = $1 AND user_id = $2 AND status = 'PENDING' RETURNING id`,
        [ctx.tenantId, ctx.userId],
      );
      const id = res.rows[0]?.id;
      if (id) {
        await recordAudit(
          tx,
          ctx,
          {
            action: 'auth.mfa.enroll_cancel',
            resourceType: 'mfa_factor',
            resourceId: id,
            riskTier: 1,
          },
          meta,
        );
      }
    });
  }

  /**
   * POST /me/mfa/totp/verify. Confirms the pending enrollment with a current code, from the SAME session that started it
   * and before it expires. Activation is atomic: a replaced factor is revoked in the same transaction, and the one-active
   * unique index makes a concurrent second activation fail. Issues a fresh set of 10 recovery codes (returned once) and,
   * because a second factor was just proven on this session, marks the session MFA-verified (PASSWORD_MFA step-up).
   */
  async confirmEnrollment(
    ctx: TrustedContext,
    code: unknown,
    meta: AuditRequestMeta = {},
  ): Promise<{ recoveryCodes: string[]; step: StepUpResult }> {
    ensureTrusted(ctx);
    const box = this.requireBox();
    let outcome: { ok: true; recoveryCodes: string[]; step: StepUpResult } | { ok: false };
    try {
      outcome = await this.db.withTenant(ctx, async (tx) => {
        const s = await this.session(tx, ctx);
        const pending = await this.factor(tx, ctx, 'PENDING');
        if (!pending || pending.pending_expired || pending.enroll_session_id !== ctx.sessionId) {
          throw new AppError(
            409,
            'MFA_ENROLLMENT_NOT_FOUND',
            'No enrollment in progress for this session. Start again.',
          );
        }
        const seed = box.open(
          pending.secret_enc,
          pending.secret_key_label,
          this.binding(ctx, pending.id),
        );
        const step = verifyTotp(seed, code, this.totpNow());
        if (step === null) {
          await repo.recordFailedLogin(tx, s.identityId);
          await recordAudit(
            tx,
            ctx,
            {
              action: 'auth.mfa.enroll_confirm_failed',
              resourceType: 'mfa_factor',
              resourceId: pending.id,
              riskTier: 2,
            },
            meta,
          );
          return { ok: false as const };
        }

        if (pending.enrollment_ticket_id) {
          const ticketCheck = await tx.query<{ created_by: string | null }>(
            `SELECT created_by FROM app.mfa_enrollment_tickets
              WHERE id = $1 AND organization_id = $2`,
            [pending.enrollment_ticket_id, ctx.tenantId],
          );
          if (ticketCheck.rows[0]?.created_by === null) {
            // Serialize bootstrap confirmation per tenant
            await tx.query('SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))', [
              `app.mfa_bootstrap_exclusive:${ctx.tenantId}`,
            ]);
            // Re-verify no active verified administrator factor already exists
            if (await hasActiveVerifiedAdminMfa(tx, ctx.tenantId)) {
              throw new AppError(
                409,
                'BOOTSTRAP_DISABLED',
                'First-administrator bootstrap is disabled: an active verified administrator already exists.',
              );
            }
          }

          const ticketConsumed = await tx.query(
            `UPDATE app.mfa_enrollment_tickets
                SET used_at = now()
              WHERE id = $1 AND organization_id = $2 AND user_id = $3
                AND used_at IS NULL AND revoked_at IS NULL`,
            [pending.enrollment_ticket_id, ctx.tenantId, ctx.userId],
          );
          if ((ticketConsumed.rowCount ?? 0) !== 1) {
            throw new AppError(
              409,
              'CONFLICT',
              'Enrollment ticket was consumed or revoked concurrently.',
            );
          }
        }

        const replaced = await tx.query<{ id: string }>(
          `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'REPLACED'
            WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE' RETURNING id`,
          [ctx.tenantId, ctx.userId],
        );
        await tx.query(
          `UPDATE app.user_mfa_factors
              SET status = 'ACTIVE', confirmed_at = now(), last_used_step = $2, last_used_at = now()
            WHERE id = $1 AND status = 'PENDING'`,
          [pending.id, step],
        );
        if (pending.verified_enrollment) {
          // If this confirmation activates a verified factor, revoke any remaining bootstrap tickets for the organization
          await tx.query(
            `UPDATE app.mfa_enrollment_tickets
                SET revoked_at = now()
              WHERE organization_id = $1 AND created_by IS NULL
                AND used_at IS NULL AND revoked_at IS NULL`,
            [ctx.tenantId],
          );
        }
        const recoveryCodes = await this.issueRecoveryCodes(tx, ctx);
        await repo.recordSuccessfulLogin(tx, s.identityId);
        const recorded = await repo.recordMfaVerification(tx, s.sessionId);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'auth.mfa.enroll_confirm',
            resourceType: 'mfa_factor',
            resourceId: pending.id,
            riskTier: 2,
            metadata: {
              replacedFactorId: replaced.rows[0]?.id ?? null,
              issuedCodes: RECOVERY_CODE_COUNT,
            },
          },
          meta,
        );
        return {
          ok: true as const,
          recoveryCodes,
          step: {
            steppedUp: true as const,
            authStrength: recorded.auth_strength,
            stepUpAt: recorded.step_up_at,
            maxAgeSeconds: Math.floor(this.stepUpMaxAgeMs / 1000),
          },
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'CONFLICT', 'The factor was changed concurrently. Retry.');
      }
      throw err;
    }
    if (!outcome.ok) throw invalidCode();
    return { recoveryCodes: outcome.recoveryCodes, step: outcome.step };
  }

  /**
   * POST /auth/mfa/challenge: proves the second factor on THIS session with exactly one of a TOTP code or a recovery code.
   * Success sets mfa_verified_at and a fresh PASSWORD_MFA step-up on this session only. A TOTP time step is accepted at
   * most once (atomic compare-and-set on last_used_step); a recovery code is consumed atomically (UPDATE ... WHERE
   * used_at IS NULL). Failures increment the shared account lockout counter and are audited; the answer is always the
   * same 401.
   */
  async challenge(
    ctx: TrustedContext,
    input: { code?: unknown; recoveryCode?: unknown },
    meta: AuditRequestMeta = {},
  ): Promise<StepUpResult & { method: 'TOTP' | 'RECOVERY_CODE' }> {
    ensureTrusted(ctx);
    const useRecovery = input.recoveryCode !== undefined;
    if (useRecovery === (input.code !== undefined)) {
      throw invalid('Provide exactly one of code or recoveryCode.');
    }
    const method = useRecovery ? ('RECOVERY_CODE' as const) : ('TOTP' as const);
    const box = useRecovery ? undefined : this.requireBox();

    const outcome = await this.db.withTenant(ctx, async (tx) => {
      const s = await this.session(tx, ctx);
      const active = await this.factor(tx, ctx, 'ACTIVE');
      if (!active) {
        throw new AppError(409, 'MFA_NOT_ENROLLED', 'No second factor is enrolled.');
      }

      if (await isMfaRequired(tx, ctx.tenantId, ctx.userId)) {
        if (!active.verified_enrollment) {
          throw new AppError(
            403,
            'MFA_UNVERIFIED_FACTOR',
            'Your enrolled MFA factor is not verified by an administrator ticket. Re-enrollment with an enrollment ticket is required.',
          );
        }
      }

      let ok = false;
      let unused: number | undefined;
      if (useRecovery) {
        const normalised = normaliseRecoveryCode(input.recoveryCode);
        if (normalised) {
          const used = await tx.query(
            `UPDATE app.user_recovery_codes SET used_at = now()
              WHERE organization_id = $1 AND user_id = $2 AND code_hash = $3
                AND used_at IS NULL AND revoked_at IS NULL`,
            [ctx.tenantId, ctx.userId, hashRecoveryCode(ctx.tenantId, ctx.userId, normalised)],
          );
          ok = (used.rowCount ?? 0) === 1;
          if (ok) unused = await this.unusedCodes(tx, ctx);
        }
      } else {
        const seed = box!.open(
          active.secret_enc,
          active.secret_key_label,
          this.binding(ctx, active.id),
        );
        const step = verifyTotp(seed, input.code, this.totpNow());
        ok = step !== null && (await this.claimStep(tx, active.id, step));
        if (ok) await this.reencryptIfStale(tx, ctx, active, seed);
      }

      if (!ok) {
        await repo.recordFailedLogin(tx, s.identityId);
        await recordAudit(
          tx,
          ctx,
          {
            action: 'auth.mfa.challenge_failed',
            resourceType: 'mfa_factor',
            resourceId: active.id,
            riskTier: 2,
            metadata: { method },
          },
          meta,
        );
        return null;
      }

      await repo.recordSuccessfulLogin(tx, s.identityId);
      const recorded = await repo.recordMfaVerification(tx, s.sessionId);
      await recordAudit(
        tx,
        ctx,
        {
          action: 'auth.mfa.challenge',
          resourceType: 'mfa_factor',
          resourceId: active.id,
          riskTier: 2,
          metadata: { method, ...(unused !== undefined ? { unusedCodes: unused } : {}) },
        },
        meta,
      );
      return recorded;
    });
    if (!outcome) throw invalidCode();
    return {
      steppedUp: true,
      authStrength: outcome.auth_strength,
      stepUpAt: outcome.step_up_at,
      maxAgeSeconds: Math.floor(this.stepUpMaxAgeMs / 1000),
      method,
    };
  }

  /** POST /me/mfa/recovery-codes/regenerate: fresh PASSWORD_MFA step-up required; every earlier unused code is invalidated. */
  async regenerateRecoveryCodes(
    ctx: TrustedContext,
    meta: AuditRequestMeta = {},
  ): Promise<{ recoveryCodes: string[] }> {
    ensureTrusted(ctx);
    return this.db.withTenant(ctx, async (tx) => {
      await this.session(tx, ctx);
      if (!(await this.factor(tx, ctx, 'ACTIVE'))) {
        throw new AppError(409, 'MFA_NOT_ENROLLED', 'No second factor is enrolled.');
      }
      if (!this.hasFresh(ctx, 'PASSWORD_MFA')) throw stepUpRequired();
      const recoveryCodes = await this.issueRecoveryCodes(tx, ctx);
      await recordAudit(
        tx,
        ctx,
        {
          action: 'auth.mfa.recovery_codes_regenerate',
          resourceType: 'user',
          resourceId: ctx.userId,
          riskTier: 2,
          metadata: { issuedCodes: RECOVERY_CODE_COUNT },
        },
        meta,
      );
      return { recoveryCodes };
    });
  }

  /**
   * DELETE /me/mfa/totp: self-service disable. REFUSED for anyone who currently holds an MFA-required role (ADR-004,
   * doc 11 §5.4); otherwise requires a fresh PASSWORD_MFA step-up. Revokes the factor and every unused recovery code and
   * drops the MFA/step-up assurance of every live session of this membership.
   */
  async disable(ctx: TrustedContext, meta: AuditRequestMeta = {}): Promise<void> {
    ensureTrusted(ctx);
    await this.db.withTenant(ctx, async (tx) => {
      const s = await this.session(tx, ctx);
      if (await isMfaRequired(tx, ctx.tenantId, ctx.userId)) {
        throw new AppError(
          403,
          'MFA_DISABLE_FORBIDDEN',
          'Multi-factor authentication cannot be disabled for this account.',
        );
      }
      const active = await this.factor(tx, ctx, 'ACTIVE');
      if (!active) throw new AppError(409, 'MFA_NOT_ENROLLED', 'No second factor is enrolled.');
      if (!this.hasFresh(ctx, 'PASSWORD_MFA')) throw stepUpRequired();

      await tx.query(
        `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'DISABLED'
          WHERE organization_id = $1 AND user_id = $2 AND status IN ('PENDING', 'ACTIVE')`,
        [ctx.tenantId, ctx.userId],
      );
      await tx.query(
        `UPDATE app.user_recovery_codes SET revoked_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.tenantId, ctx.userId],
      );
      const sessions = await repo.clearMfaAssurance(tx, s.identityId, ctx.tenantId);
      await recordAudit(
        tx,
        ctx,
        {
          action: 'auth.mfa.disable',
          resourceType: 'mfa_factor',
          resourceId: active.id,
          riskTier: 2,
          metadata: { sessionsDowngraded: sessions },
        },
        meta,
      );
    });
  }
}

export const MFA_RESET_PERMISSION = 'user.account.reset_mfa';

/**
 * POST /api/v1/users/:id/mfa/reset (doc 10 row 10a, CRITICAL). Separately authorized administrative recovery for a user
 * who lost their authenticator and recovery codes:
 *  - the route gate requires `user.account.reset_mfa` AND (CRITICAL) a fresh PASSWORD_MFA step-up of the ADMINISTRATOR;
 *  - here: STAFF actor, the permission at ORGANIZATION scope (scoped holders are inert, like user.account.suspend), never
 *    the caller themself, a reason, and the grant rules: the administrator must be allowed to grant EVERY role the target
 *    holds, so a campus administrator can never reset a college administrator;
 *  - effect: the target's factors and unused recovery codes are revoked (only through platform.admin_reset_user_mfa) and EVERY
 *    live session of the target in this tenant is revoked. The administrator receives nothing: no secret, no code, no
 *    session and no assurance. The target signs in again with their own password and re-enrolls (first-enrollment rules).
 *  - audited at risk tier 3 with the reason, in the same transaction.
 */
export async function adminResetUserMfa(
  tx: TenantTx,
  ctx: TrustedContext,
  targetUserId: string,
  input: { reason: unknown },
  meta: AuditRequestMeta = {},
): Promise<{ factorsRevoked: number; codesRevoked: number; sessionsRevoked: number }> {
  ensureTrusted(ctx);
  if (!input || typeof input !== 'object') throw invalid('Payload is required.');
  if (!isUuidV7(targetUserId)) throw invalid('Invalid user ID.');
  const target = targetUserId.toLowerCase();
  const reason = parseReason(input.reason);

  AuthorizationEngine.assertStaffActor(ctx);
  await AuthorizationEngine.assert(tx, ctx, MFA_RESET_PERMISSION); // held at all: 403
  try {
    await AuthorizationEngine.assert(tx, ctx, MFA_RESET_PERMISSION, {
      organization_id: ctx.tenantId,
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }
    throw err;
  }
  if (target === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'Access denied.');

  const user = await tx.query<{ identity_id: string | null }>(
    `SELECT identity_id FROM app.users WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [ctx.tenantId, target],
  );
  const row = user.rows[0];
  if (!row) throw resourceNotFound();

  if (!(await mayActOnAllRolesOf(tx, ctx, target))) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied.');
  }

  const reset = await tx.query<{ factors_revoked: number; codes_revoked: number }>(
    'SELECT factors_revoked, codes_revoked FROM platform.admin_reset_user_mfa($1)',
    [target],
  );
  const sessionsRevoked = row.identity_id
    ? await repo.revokeMembershipSessions(tx, row.identity_id, ctx.tenantId)
    : 0;
  const factorsRevoked = reset.rows[0]?.factors_revoked ?? 0;
  const codesRevoked = reset.rows[0]?.codes_revoked ?? 0;
  await recordAudit(
    tx,
    ctx,
    {
      action: 'auth.mfa.admin_reset',
      resourceType: 'user',
      resourceId: target,
      riskTier: 3,
      reasonText: reason,
      metadata: { factorsRevoked, codesRevoked, sessionsRevoked },
    },
    meta,
  );
  return { factorsRevoked, codesRevoked, sessionsRevoked };
}

/**
 * POST /api/v1/users/:id/mfa/enrollment-ticket (doc 10 row 10a, CRITICAL). Issues a single-use 24-hour enrollment
 * ticket for another user:
 *  - Route gate requires user.account.reset_mfa and a fresh PASSWORD_MFA step-up of the administrator;
 *  - STAFF actor, ORGANIZATION scope, never the caller themself, reason required, and mayActOnAllRolesOf;
 *  - Any prior unused tickets for the target are revoked;
 *  - Returns a random 32-byte hex token once; only the SHA-256 hash is stored in app.mfa_enrollment_tickets.
 *  - Audited at risk tier 3 with the reason.
 */
export async function issueMfaEnrollmentTicket(
  tx: TenantTx,
  ctx: TrustedContext,
  targetUserId: string,
  input: { reason: unknown },
  meta: AuditRequestMeta = {},
): Promise<{ ticketId: string; ticket: string; expiresAt: string }> {
  ensureTrusted(ctx);
  if (!input || typeof input !== 'object') throw invalid('Payload is required.');
  if (!isUuidV7(targetUserId)) throw invalid('Invalid user ID.');
  const target = targetUserId.toLowerCase();
  const reason = parseReason(input.reason);

  AuthorizationEngine.assertStaffActor(ctx);
  await AuthorizationEngine.assert(tx, ctx, MFA_RESET_PERMISSION);
  try {
    await AuthorizationEngine.assert(tx, ctx, MFA_RESET_PERMISSION, {
      organization_id: ctx.tenantId,
    });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }
    throw err;
  }
  if (target === ctx.userId) throw new AppError(403, 'FORBIDDEN', 'Access denied.');

  const user = await tx.query<{ identity_id: string | null }>(
    `SELECT identity_id FROM app.users WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [ctx.tenantId, target],
  );
  if (!user.rows[0]) throw resourceNotFound();

  if (!(await mayActOnAllRolesOf(tx, ctx, target))) {
    throw new AppError(403, 'FORBIDDEN', 'Access denied.');
  }

  await tx.query(
    `UPDATE app.mfa_enrollment_tickets
        SET revoked_at = now()
      WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [ctx.tenantId, target],
  );

  const ticketId = uuidv7();
  const rawTicket = randomBytes(32).toString('hex');
  const codeHash = createHash('sha256').update(rawTicket).digest('hex');

  const ticketInsert = await tx.query<{ expires_at: Date }>(
    `INSERT INTO app.mfa_enrollment_tickets
       (id, organization_id, user_id, code_hash, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + interval '24 hours')
     RETURNING expires_at`,
    [ticketId, ctx.tenantId, target, codeHash, ctx.userId],
  );
  const expiresAt = ticketInsert.rows[0]!.expires_at;

  await recordAudit(
    tx,
    ctx,
    {
      action: 'auth.mfa.enrollment_ticket_issue',
      resourceType: 'user',
      resourceId: target,
      riskTier: 3,
      reasonText: reason,
      metadata: { ticketId, expiresAt: expiresAt.toISOString() },
    },
    meta,
  );

  return { ticketId, ticket: rawTicket, expiresAt: expiresAt.toISOString() };
}
