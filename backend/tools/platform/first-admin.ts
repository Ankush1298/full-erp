import { createHash, randomBytes } from 'node:crypto';
import { recordOperationalAudit } from '../../src/shared/audit/index.js';
import { issueFirstAdminBootstrapTicket } from '../../src/shared/authorization/mfa-bootstrap.js';
import type { SqlExecutor } from '../../src/shared/authorization/seed.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { EMAIL_REGEX } from './platform-cli.js';

/**
 * Operator-only first-administrator onboarding (doc 45 gaps G1 and G3; runbook docs/runbooks/first-administrator-onboarding.md).
 *
 *  1. `issueFirstAdminInvitation` gives the tenant's designated, still-INVITED COLLEGE_ADMIN an ACCOUNT_INVITE token in the
 *     SAME `app.invite_tokens` table, hash format and acceptance path (`POST /auth/accept-invite`) as every other invitation:
 *     256-bit random token, only its SHA-256 stored, single use, time-limited, bound to one membership of one tenant. There is
 *     no separate password or login route: the administrator sets a policy-compliant password through the normal accept flow.
 *  2. `issueFirstAdminMfaTicket` issues the EXISTING one-time MFA bootstrap ticket to the activated administrator.
 *
 * Both run on a privileged operator connection (never app_runtime), inside one transaction on a DEDICATED client, take the
 * same per-tenant advisory lock as the ticket issuer, and write a tier-3 SYSTEM audit event that carries ids and expiry, never
 * a token. Nothing here is reachable over HTTP.
 */
export const FIRST_ADMIN_INVITE_DEFAULT_HOURS = 24;
export const FIRST_ADMIN_INVITE_MAX_HOURS = 72;

export class OnboardingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

interface Tenant {
  id: string;
  name: string;
}

async function inTransaction<T>(db: SqlExecutor, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const r = await fn();
    await db.query('COMMIT');
    return r;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Locks the tenant (serialising with MFA-ticket issuance) and requires it ACTIVE. `identifier` is an id or a slug. */
async function lockActiveTenant(db: SqlExecutor, identifier: string): Promise<Tenant> {
  const ident = identifier.trim();
  if (!ident) throw new OnboardingError('TENANT_REQUIRED', 'A tenant id or slug is required.');
  const found = await db.query(
    `SELECT id, name, status FROM app.organizations WHERE id::text = $1 OR slug = $1`,
    [ident],
  );
  const row = found.rows[0] as { id: string; name: string; status: string } | undefined;
  if (!row || row.status !== 'ACTIVE')
    throw new OnboardingError('TENANT_NOT_FOUND', 'Active organization not found.');
  await db.query('SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `app.mfa_bootstrap_exclusive:${row.id}`,
  ]);
  const locked = await db.query(
    `SELECT id FROM app.organizations WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [row.id],
  );
  if (locked.rows.length === 0)
    throw new OnboardingError('TENANT_NOT_FOUND', 'Active organization not found.');
  return { id: row.id, name: row.name };
}

const ORG_ADMIN_ASSIGNMENT = `
  EXISTS (SELECT 1 FROM app.role_assignments ra
            JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
           WHERE ra.organization_id = u.organization_id AND ra.user_id = u.id
             AND r.code = 'COLLEGE_ADMIN' AND ra.scope_type = 'ORGANIZATION' AND ra.status = 'ACTIVE'
             AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now()))`;

export interface FirstAdminInvitation {
  tenantId: string;
  userId: string;
  invitationId: string;
  expiresAt: string;
  /** The ONLY copy of the token. Shown once by the caller; never stored, logged or audited. */
  token: string;
  reissued: boolean;
}

export async function issueFirstAdminInvitation(
  db: SqlExecutor,
  input: { tenant: string; adminEmail?: string; ttlHours?: number; reason?: string },
): Promise<FirstAdminInvitation> {
  const ttl = input.ttlHours ?? FIRST_ADMIN_INVITE_DEFAULT_HOURS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > FIRST_ADMIN_INVITE_MAX_HOURS)
    throw new OnboardingError(
      'INVALID_TTL',
      `The invitation lifetime must be 1 to ${FIRST_ADMIN_INVITE_MAX_HOURS} hours.`,
    );
  const email = input.adminEmail?.trim().toLowerCase();

  return inTransaction(db, async () => {
    const tenant = await lockActiveTenant(db, input.tenant);

    // No second initial administrator: once any organization-scope administrator is ACTIVE, this path is closed.
    const active = await db.query(
      `SELECT 1 FROM app.users u WHERE u.organization_id = $1 AND u.status = 'ACTIVE' AND ${ORG_ADMIN_ASSIGNMENT} LIMIT 1`,
      [tenant.id],
    );
    if (active.rows.length > 0)
      throw new OnboardingError(
        'ADMIN_ALREADY_ACTIVE',
        'The first administrator is already active; this path is closed for the tenant.',
      );

    const candidates = await db.query(
      `SELECT u.id FROM app.users u
        WHERE u.organization_id = $1 AND u.status = 'INVITED' AND u.identity_id IS NULL
          AND ${ORG_ADMIN_ASSIGNMENT} AND ($2::text IS NULL OR u.email = $2)
        ORDER BY u.created_at`,
      [tenant.id, email ?? null],
    );
    if (candidates.rows.length === 0)
      throw new OnboardingError(
        'NO_DESIGNATED_ADMIN',
        'No invited, not yet activated COLLEGE_ADMIN matches. Create the tenant with --admin-email first.',
      );
    if (candidates.rows.length > 1)
      throw new OnboardingError(
        'AMBIGUOUS_ADMIN',
        'More than one invited COLLEGE_ADMIN exists; pass --admin-email to choose the designated one.',
      );
    const userId = (candidates.rows[0] as { id: string }).id;

    // Safe retries: a new issue withdraws every unused earlier token of this membership (at most one live token).
    const revoked = await db.query(
      `UPDATE app.invite_tokens SET revoked_at = now()
        WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [tenant.id, userId],
    );

    const token = randomBytes(32).toString('base64url'); // 43 characters, 256 bits: INVITE_TOKEN_PATTERN
    const invitationId = uuidv7();
    const inserted = await db.query(
      `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $3, now() + make_interval(hours => $5::int))
       RETURNING expires_at`,
      [invitationId, tenant.id, userId, createHash('sha256').update(token).digest('hex'), ttl],
    );
    const expiresAt = (inserted.rows[0] as { expires_at: Date }).expires_at.toISOString();

    await recordOperationalAudit(db, {
      organizationId: tenant.id,
      action: 'platform.first_admin.invite_issue',
      resourceType: 'user',
      resourceId: userId,
      riskTier: 3,
      reasonText: input.reason ?? 'First-administrator invitation',
      metadata: { invitationId, expiresAt, reissued: revoked.rows.length > 0 },
    });
    return {
      tenantId: tenant.id,
      userId,
      invitationId,
      expiresAt,
      token,
      reissued: revoked.rows.length > 0,
    };
  });
}

/** Withdraws the unused first-administrator invitation(s) of a tenant. Returns how many were withdrawn. */
export async function revokeFirstAdminInvitation(
  db: SqlExecutor,
  input: { tenant: string; reason?: string },
): Promise<{ tenantId: string; revoked: number }> {
  return inTransaction(db, async () => {
    const tenant = await lockActiveTenant(db, input.tenant);
    const res = await db.query(
      `UPDATE app.invite_tokens it SET revoked_at = now()
        FROM app.users u
        WHERE it.organization_id = $1 AND u.organization_id = it.organization_id AND u.id = it.user_id
          AND it.used_at IS NULL AND it.revoked_at IS NULL AND u.status = 'INVITED' AND ${ORG_ADMIN_ASSIGNMENT}
        RETURNING it.id`,
      [tenant.id],
    );
    await recordOperationalAudit(db, {
      organizationId: tenant.id,
      action: 'platform.first_admin.invite_revoke',
      resourceType: 'organization',
      resourceId: tenant.id,
      riskTier: 3,
      reasonText: input.reason ?? 'First-administrator invitation withdrawn',
      metadata: { revoked: res.rows.length },
    });
    return { tenantId: tenant.id, revoked: res.rows.length };
  });
}

/**
 * Issues the existing one-time MFA bootstrap ticket to the tenant's single ACTIVE organization-scope administrator, i.e. only
 * AFTER the invitation was accepted. `issueFirstAdminBootstrapTicket` itself enforces: user ACTIVE, active COLLEGE_ADMIN
 * assignment, bootstrap closed once any administrator has a verified factor, prior tickets revoked, 24 h, tier-3 audit.
 */
export async function issueFirstAdminMfaTicket(
  db: SqlExecutor,
  input: { tenant: string; adminEmail?: string; reason?: string },
): Promise<{
  tenantId: string;
  userId: string;
  ticketId: string;
  ticket: string;
  expiresAt: string;
}> {
  const email = input.adminEmail?.trim().toLowerCase();
  return inTransaction(db, async () => {
    const tenant = await lockActiveTenant(db, input.tenant);
    const admins = await db.query(
      `SELECT u.id FROM app.users u
        WHERE u.organization_id = $1 AND u.status = 'ACTIVE' AND ${ORG_ADMIN_ASSIGNMENT}
          AND ($2::text IS NULL OR u.email = $2) ORDER BY u.created_at`,
      [tenant.id, email ?? null],
    );
    if (admins.rows.length === 0)
      throw new OnboardingError(
        'NO_ACTIVE_ADMIN',
        'No activated COLLEGE_ADMIN yet: the administrator must accept the invitation first.',
      );
    if (admins.rows.length > 1)
      throw new OnboardingError(
        'AMBIGUOUS_ADMIN',
        'More than one active administrator; pass --admin-email.',
      );
    const userId = (admins.rows[0] as { id: string }).id;
    // A plain executor: the library function would open its own connection on a client that has one.
    const exec: SqlExecutor = { query: (t, v) => db.query(t, v) };
    const t = await issueFirstAdminBootstrapTicket(exec, {
      organizationId: tenant.id,
      userId,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return { tenantId: tenant.id, userId, ...t };
  });
}

/**
 * Credentials are shown on the operator's terminal only in an explicitly authorised LOCAL process: not production, the
 * operator has set PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT=true, and the database host is this machine. Anywhere else the command
 * refuses BEFORE issuing anything, so no token is created that nobody may see. (Delivery by e-mail is G4, not built.)
 */
export function assertLocalTokenOutput(
  connectionString: string,
  env: Record<string, string | undefined>,
): void {
  if (env['NODE_ENV'] === 'production')
    throw new OnboardingError('LOCAL_ONLY', 'Token output is refused when NODE_ENV=production.');
  if (env['PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT'] !== 'true')
    throw new OnboardingError(
      'LOCAL_ONLY',
      'Set PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT=true to print a token (local development only).',
    );
  const host = ((): string => {
    try {
      return new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return 'unparseable';
    }
  })();
  if (!['localhost', '127.0.0.1', '::1', ''].includes(host))
    throw new OnboardingError(
      'LOCAL_ONLY',
      'Token output is allowed only for a database on this machine.',
    );
}

export interface StaffInvitationResult {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  invitationId: string;
  expiresAt: string;
  token: string;
  acceptUrl: string;
  reissued: boolean;
}

/**
 * Local development only: Retrieves or re-issues an activation token for an ordinary staff member
 * who was already invited by the Principal in the web application (Users -> Invite User).
 * Requires assertLocalTokenOutput guards (non-production, local host, explicit permission).
 */
export async function issueStaffInvitationLink(
  db: SqlExecutor,
  input: { tenant: string; email: string; ttlHours?: number; reason?: string },
): Promise<StaffInvitationResult> {
  const ttl = input.ttlHours ?? FIRST_ADMIN_INVITE_DEFAULT_HOURS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > FIRST_ADMIN_INVITE_MAX_HOURS)
    throw new OnboardingError(
      'INVALID_TTL',
      `The invitation lifetime must be 1 to ${FIRST_ADMIN_INVITE_MAX_HOURS} hours.`,
    );
  const email = input.email?.trim().toLowerCase();
  if (!email || !EMAIL_REGEX.test(email))
    throw new OnboardingError('INVALID_EMAIL', 'A valid email address is required.');

  return inTransaction(db, async () => {
    const tenant = await lockActiveTenant(db, input.tenant);

    const candidates = await db.query(
      `SELECT u.id, u.display_name, u.status FROM app.users u
        WHERE u.organization_id = $1 AND u.email = $2`,
      [tenant.id, email],
    );

    const user = candidates.rows[0] as
      { id: string; display_name: string; status: string } | undefined;
    if (!user) {
      throw new OnboardingError(
        'USER_NOT_FOUND',
        `No user found with email "${email}" in organization "${tenant.name}". Please invite the user first via the web application (Users -> Invite User).`,
      );
    }

    if (user.status !== 'INVITED') {
      throw new OnboardingError(
        'USER_ALREADY_ACTIVE',
        `User "${email}" is in status "${user.status}", not "INVITED". Only pending invited users can receive an activation link.`,
      );
    }

    // Revoke any prior unused token for this user in this tenant
    const revoked = await db.query(
      `UPDATE app.invite_tokens SET revoked_at = now()
        WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [tenant.id, user.id],
    );
    const reissued = revoked.rows.length > 0;

    const rawToken = randomBytes(32).toString('base64url');
    const invitationId = uuidv7();

    const inserted = await db.query(
      `INSERT INTO app.invite_tokens
         (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() + make_interval(hours => $6::int))
       RETURNING expires_at`,
      [
        invitationId,
        tenant.id,
        user.id,
        createHash('sha256').update(rawToken).digest('hex'),
        user.id,
        ttl,
      ],
    );

    const expiresAt = (inserted.rows[0] as { expires_at: Date }).expires_at.toISOString();

    await recordOperationalAudit(db, {
      organizationId: tenant.id,
      action: 'platform.staff.invite_link_issue',
      resourceType: 'user',
      resourceId: user.id,
      riskTier: 2,
      reasonText: input.reason ?? 'Local staff invitation link issue (dev/manual test)',
      metadata: { invitationId, reissued },
    });

    const acceptLink = new URL('http://localhost:5173/accept-invite');
    acceptLink.searchParams.set('token', rawToken);
    acceptLink.searchParams.set('email', email);
    const acceptUrl = acceptLink.toString();

    return {
      tenantId: tenant.id,
      userId: user.id,
      email,
      displayName: user.display_name,
      invitationId,
      expiresAt,
      token: rawToken,
      acceptUrl,
      reissued,
    };
  });
}
