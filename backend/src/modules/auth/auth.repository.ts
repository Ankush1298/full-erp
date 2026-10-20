import { randomBytes, createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import type { TenantTx } from '../../shared/database/index.js';
import type { AuthStrength } from '../../shared/tenancy/trusted-context.js';

export interface IdentityRow {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}

export interface SessionRow {
  id: string;
  identity_id: string;
  tenant_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  step_up_at: Date | null;
  auth_strength: AuthStrength;
  mfa_verified_at: Date | null;
}

export interface MembershipRow {
  organization_id: string;
  user_id: string;
  status: string;
  org_slug: string;
  org_name: string;
}

export class AuthRepository {
  async findIdentityByEmail(tx: TenantTx, email: string): Promise<IdentityRow | null> {
    const res = await tx.query<IdentityRow>(
      `SELECT id, email, password_hash, status, failed_login_count, locked_until 
       FROM platform.identities WHERE email = lower($1)`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  async findIdentityById(tx: TenantTx, identityId: string): Promise<IdentityRow | null> {
    const res = await tx.query<IdentityRow>(
      `SELECT id, email, password_hash, status, failed_login_count, locked_until
       FROM platform.identities WHERE id = $1`,
      [identityId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Per-account safety net against DISTRIBUTED guessing (per-IP limits are in LoginRateLimiter).
   * Threshold is 10, the lock is fixed 15 minutes and is NEVER extended while active, and the counter
   * restarts once a lock has expired, so one attacker cannot keep a victim locked out indefinitely.
   */
  async recordFailedLogin(tx: TenantTx, identityId: string): Promise<void> {
    await tx.query(
      `UPDATE platform.identities i
          SET failed_login_count = n.c::smallint,
              locked_until = CASE WHEN i.locked_until > now() THEN i.locked_until
                                  WHEN n.c >= 10 THEN now() + interval '15 minutes'
                                  ELSE NULL END
         FROM (SELECT id, LEAST(100, CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                                          THEN 1 ELSE failed_login_count + 1 END) AS c
                 FROM platform.identities WHERE id = $1) n
        WHERE i.id = n.id`,
      [identityId],
    );
  }

  async recordSuccessfulLogin(tx: TenantTx, identityId: string): Promise<void> {
    await tx.query(
      `UPDATE platform.identities 
       SET failed_login_count = 0, locked_until = NULL 
       WHERE id = $1`,
      [identityId],
    );
  }

  async findMemberships(tx: TenantTx, identityId: string): Promise<MembershipRow[]> {
    const res = await tx.query<MembershipRow>(
      `SELECT organization_id, user_id, status, org_slug, org_name
       FROM platform.get_identity_memberships($1)`,
      [identityId],
    );
    return res.rows;
  }

  async createSession(
    tx: TenantTx,
    identityId: string,
    tenantId: string,
    sessionId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO platform.auth_sessions (id, identity_id, tenant_id, token_hash, expires_at) 
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, identityId, tenantId, tokenHash, expiresAt],
    );
  }

  async findSessionByToken(tx: TenantTx, tokenHash: string): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `SELECT id, identity_id, tenant_id, token_hash, expires_at, revoked_at, step_up_at, auth_strength,
              mfa_verified_at
       FROM platform.auth_sessions
       WHERE token_hash = $1`,
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  async findSessionById(tx: TenantTx, sessionId: string): Promise<SessionRow | null> {
    const res = await tx.query<SessionRow>(
      `SELECT id, identity_id, tenant_id, token_hash, expires_at, revoked_at, step_up_at, auth_strength,
              mfa_verified_at
       FROM platform.auth_sessions
       WHERE id = $1`,
      [sessionId],
    );
    return res.rows[0] ?? null;
  }

  async recordStepUp(
    tx: TenantTx,
    sessionId: string,
    authStrength: AuthStrength,
    maxAgeMs: number = 600_000,
  ): Promise<{ step_up_at: Date; auth_strength: AuthStrength }> {
    const res = await tx.query<{ step_up_at: Date; auth_strength: AuthStrength }>(
      `UPDATE platform.auth_sessions s
          SET step_up_at = CASE
                WHEN (
                  (CASE s.auth_strength WHEN 'PASSWORD_MFA' THEN 3 WHEN 'PASSWORD_REAUTH' THEN 2 ELSE 1 END) >
                  (CASE $1::text WHEN 'PASSWORD_MFA' THEN 3 WHEN 'PASSWORD_REAUTH' THEN 2 ELSE 1 END)
                  AND s.step_up_at IS NOT NULL
                  AND s.step_up_at > now() - ($3::bigint * interval '1 millisecond')
                ) THEN s.step_up_at
                ELSE now()
              END,
              auth_strength = CASE
                WHEN (
                  (CASE s.auth_strength WHEN 'PASSWORD_MFA' THEN 3 WHEN 'PASSWORD_REAUTH' THEN 2 ELSE 1 END) >
                  (CASE $1::text WHEN 'PASSWORD_MFA' THEN 3 WHEN 'PASSWORD_REAUTH' THEN 2 ELSE 1 END)
                  AND s.step_up_at IS NOT NULL
                  AND s.step_up_at > now() - ($3::bigint * interval '1 millisecond')
                ) THEN s.auth_strength
                ELSE $1
              END
        WHERE s.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
        RETURNING s.step_up_at, s.auth_strength`,
      [authStrength, sessionId, maxAgeMs],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Session expired or revoked.');
    return { step_up_at: row.step_up_at, auth_strength: row.auth_strength };
  }

  /**
   * THE ONLY WAY a session reaches PASSWORD_MFA (a static test pins it to the MFA service). Called only after a TOTP code or
   * a recovery code was verified for this session's own user, in the same transaction as the factor/code update and its
   * audit event. Sets the second-factor timestamp (login-time MFA for the session's lifetime) and a fresh PASSWORD_MFA
   * step-up (CRITICAL actions for the step-up window). PASSWORD_MFA is the strongest level, so this never downgrades.
   */
  async recordMfaVerification(
    tx: TenantTx,
    sessionId: string,
  ): Promise<{ step_up_at: Date; auth_strength: AuthStrength; mfa_verified_at: Date }> {
    const res = await tx.query<{
      step_up_at: Date;
      auth_strength: AuthStrength;
      mfa_verified_at: Date;
    }>(
      `UPDATE platform.auth_sessions
          SET mfa_verified_at = now(), step_up_at = now(), auth_strength = 'PASSWORD_MFA'
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
        RETURNING step_up_at, auth_strength, mfa_verified_at`,
      [sessionId],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Session expired or revoked.');
    return row;
  }

  /**
   * Drops every second-factor and step-up assurance of one membership's live sessions (factor disabled or replaced): the
   * sessions stay signed in but must verify again before anything that needs MFA. Returns how many sessions changed.
   */
  async clearMfaAssurance(tx: TenantTx, identityId: string, tenantId: string): Promise<number> {
    const res = await tx.query(
      `UPDATE platform.auth_sessions
          SET mfa_verified_at = NULL, step_up_at = NULL, auth_strength = 'PASSWORD'
        WHERE identity_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [identityId, tenantId],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Revokes every live session of ONE membership: the identity's sessions that were opened for THIS tenant. The same
   * identity's sessions in other tenants are untouched. Returns how many were revoked. (A suspended membership already
   * fails validateSession; this makes the end of access explicit and permanent.)
   */
  async revokeMembershipSessions(
    tx: TenantTx,
    identityId: string,
    tenantId: string,
  ): Promise<number> {
    const res = await tx.query(
      `UPDATE platform.auth_sessions SET revoked_at = now()
        WHERE identity_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [identityId, tenantId],
    );
    return res.rowCount ?? 0;
  }

  /** The identity row, locked until the transaction ends (serialises concurrent first-time acceptances of one e-mail). */
  async lockIdentityByEmail(tx: TenantTx, email: string): Promise<IdentityRow | null> {
    const res = await tx.query<IdentityRow>(
      `SELECT id, email, password_hash, status, failed_login_count, locked_until
         FROM platform.identities WHERE email = lower($1) FOR UPDATE`,
      [email],
    );
    return res.rows[0] ?? null;
  }

  /** Creates an ACTIVE identity. Null when the e-mail was taken meanwhile (the caller treats that as a failed attempt). */
  async createIdentity(
    tx: TenantTx,
    id: string,
    email: string,
    passwordHash: string,
  ): Promise<string | null> {
    const res = await tx.query<{ id: string }>(
      `INSERT INTO platform.identities (id, email, password_hash, status)
       VALUES ($1, lower($2), $3, 'ACTIVE')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [id, email, passwordHash],
    );
    return res.rows[0]?.id ?? null;
  }

  async revokeSession(tx: TenantTx, sessionId: string): Promise<void> {
    await tx.query(`UPDATE platform.auth_sessions SET revoked_at = now() WHERE id = $1`, [
      sessionId,
    ]);
  }
}

export function hashToken(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(plainPassword: string): Promise<string> {
  return argon2.hash(plainPassword, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
