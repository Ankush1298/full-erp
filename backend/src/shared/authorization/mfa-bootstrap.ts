import { createHash, randomBytes } from 'node:crypto';
import { recordOperationalAudit } from '../audit/index.js';
import { AppError } from '../errors/http-errors.js';
import { isUuidV7, uuidv7 } from '../ids/uuidv7.js';
import type { SqlExecutor } from './seed.js';

export interface BootstrapTicketOptions {
  organizationId: string;
  userId: string;
  reason?: string;
}

export interface BootstrapTicketResult {
  ticketId: string;
  ticket: string;
  expiresAt: string;
}

/**
 * Issues a one-time, auditable bootstrap enrollment ticket for the initial COLLEGE_ADMIN of a tenant.
 *
 * Requirements & Invariants:
 *  - Must be executed by trusted provisioning or operational tooling via privileged SqlExecutor (never app_runtime).
 *  - Target user must exist, be ACTIVE, and hold an active COLLEGE_ADMIN role assignment in the tenant.
 *  - Strictly disabled if ANY active, verified MFA factor already exists for an administrative role in the tenant.
 *  - Generates 32 bytes of random entropy (256-bit token); only the SHA-256 hash is persisted.
 *  - Ticket is single-use, expires in 24 hours, and records a risk-tier 3 operational audit event.
 *  - After the first administrator completes enrollment, the bootstrap path is closed.
 */
export async function issueFirstAdminBootstrapTicket(
  db: SqlExecutor,
  options: BootstrapTicketOptions,
): Promise<BootstrapTicketResult> {
  // If a connection pool is passed (e.g. operational CLI with pg.Pool), acquire a single client
  // and wrap the entire bootstrap operation in a transaction to guarantee atomic locking and audit.
  if ('connect' in db && typeof (db as { connect?: unknown }).connect === 'function') {
    const pool = db as { connect: () => Promise<SqlExecutor & { release: () => void }> };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await executeBootstrapTicket(client, options);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return executeBootstrapTicket(db, options);
}

async function executeBootstrapTicket(
  db: SqlExecutor,
  options: BootstrapTicketOptions,
): Promise<BootstrapTicketResult> {
  const { organizationId, userId, reason } = options;

  if (!isUuidV7(organizationId)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid organization ID.');
  }
  if (!isUuidV7(userId)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid user ID.');
  }

  // 0. Serialize bootstrap operations per tenant
  await db.query('SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `app.mfa_bootstrap_exclusive:${organizationId}`,
  ]);

  // 1. Lock and verify tenant exists and is ACTIVE
  const orgRes = await db.query(
    'SELECT id, status FROM app.organizations WHERE id = $1 FOR UPDATE',
    [organizationId],
  );
  if (!orgRes.rows[0] || orgRes.rows[0]['status'] !== 'ACTIVE') {
    throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Active organization not found.');
  }

  // 2. Lock and verify target user exists and is ACTIVE
  const userRes = await db.query(
    'SELECT id, status FROM app.users WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [organizationId, userId],
  );
  if (!userRes.rows[0] || userRes.rows[0]['status'] !== 'ACTIVE') {
    throw new AppError(404, 'USER_NOT_FOUND', 'Active user not found in organization.');
  }

  // 3. Verify user has an active COLLEGE_ADMIN role assignment
  const roleRes = await db.query(
    `SELECT 1 FROM app.role_assignments ra
       JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
      WHERE ra.organization_id = $1 AND ra.user_id = $2
        AND r.code = 'COLLEGE_ADMIN' AND ra.status = 'ACTIVE'
        AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())`,
    [organizationId, userId],
  );
  if (roleRes.rows.length === 0) {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'User does not hold an active COLLEGE_ADMIN role.',
    );
  }

  // 4. One-time check: Disabled if an active verified factor already exists for ANY required-role user in the tenant
  const activeAdminMfaRes = await db.query(
    `SELECT 1 FROM app.user_mfa_factors f
       JOIN app.role_assignments ra ON ra.organization_id = f.organization_id AND ra.user_id = f.user_id
       JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
      WHERE f.organization_id = $1
        AND f.status = 'ACTIVE'
        AND f.verified_enrollment IS TRUE
        AND r.code IN ('HOD', 'DEPARTMENT_ADMIN', 'CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR')`,
    [organizationId],
  );
  if (activeAdminMfaRes.rows.length > 0) {
    throw new AppError(
      409,
      'BOOTSTRAP_DISABLED',
      'First-administrator bootstrap is disabled: an active verified administrator already exists.',
    );
  }

  // 5. Revoke any prior unconsumed bootstrap tickets for this tenant or target user
  await db.query(
    `UPDATE app.mfa_enrollment_tickets
        SET revoked_at = now()
      WHERE organization_id = $1
        AND (user_id = $2 OR created_by IS NULL)
        AND used_at IS NULL AND revoked_at IS NULL`,
    [organizationId, userId],
  );

  // 6. Generate 32-byte cryptographic token and SHA-256 hash
  const ticketId = uuidv7();
  const token = randomBytes(32).toString('hex');
  const codeHash = createHash('sha256').update(token).digest('hex');

  const ticketInsert = await db.query(
    `INSERT INTO app.mfa_enrollment_tickets
       (id, organization_id, user_id, code_hash, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, NULL, now(), now() + interval '24 hours')
     RETURNING expires_at`,
    [ticketId, organizationId, userId, codeHash],
  );
  const expiresAt = (ticketInsert.rows[0]!['expires_at'] as Date).toISOString();

  // 7. Record operational audit event (SYSTEM actor, risk tier 3)
  await recordOperationalAudit(db, {
    organizationId,
    action: 'auth.mfa.bootstrap_ticket_issue',
    resourceType: 'user',
    resourceId: userId,
    riskTier: 3,
    reasonText: reason ?? 'First-administrator MFA bootstrap',
    metadata: { ticketId, expiresAt },
  });

  return { ticketId, ticket: token, expiresAt };
}
