import { uuidv7 } from '../ids/uuidv7.js';
import { ROLE_MATRIX, type RoleCode } from './role-matrix.js';
import { reconcileTenantPermissions, type ReconciliationResult } from './reconcile.js';

/** Anything with a pg-style `query` (a TenantTx, or a provisioning client). */
export interface SqlExecutor {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SeedTenantRolesOptions {
  /**
   * If true, explicitly purges grants that left the canonical matrix.
   * Defaults to false to preserve institution-customized grants and explicit revocations.
   */
  purgeOrphanGrants?: boolean | undefined;
  /**
   * If true, preserves existing custom role permissions present in DB. Defaults to true.
   */
  preserveCustomizations?: boolean | undefined;
  /**
   * If true, allows granting permissions classified as CRITICAL (e.g. during initial tenant creation).
   * Defaults to true for initial tenant seeding; false for background maintenance.
   */
  allowCriticalGrants?: boolean | undefined;
  /** Optional role display titles mapping (roleCode -> displayTitle). Defaults to roleCode. */
  roleDisplayTitles?: Record<string, string> | undefined;
}

/**
 * Seeds or reconciles system roles and baseline permissions for one tenant organization.
 *
 * Safety & Invariant Guarantees:
 * 1. Controlled non-destructive reconciliation by default: never blanket-deletes institution custom grants.
 * 2. Assigns institution-type-specific role display titles when provided.
 * 3. Idempotent: running repeatedly leaves matching permissions and assignments unchanged.
 * 4. Only purges orphaned grants when explicitly requested via purgeOrphanGrants: true.
 */
export async function seedTenantRoles(
  db: SqlExecutor,
  organizationId: string,
  options: SeedTenantRolesOptions = {},
): Promise<ReconciliationResult> {
  const purgeOrphans = options.purgeOrphanGrants === true;
  const allowCritical = options.allowCriticalGrants ?? true;

  // 1. Fetch platform-registered permissions
  const registeredRes = await db.query('SELECT code FROM platform.permissions');
  const registeredCodes = new Set(registeredRes.rows.map((r) => r['code'] as string));

  // 2. Upsert roles with display titles if provided
  for (const code of Object.keys(ROLE_MATRIX) as RoleCode[]) {
    const displayTitle = options.roleDisplayTitles?.[code] ?? code;

    await db.query(
      `INSERT INTO app.roles (id, organization_id, code, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, code) DO UPDATE
         SET name = EXCLUDED.name
       WHERE app.roles.name = app.roles.code OR app.roles.name IS NULL`,
      [uuidv7(), organizationId, code, displayTitle],
    );
  }

  // 4. Synchronize matrix permissions with canonical scope_modes
  for (const [code, perms] of Object.entries(ROLE_MATRIX)) {
    const res = await db.query(
      'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
      [organizationId, code],
    );
    const roleId = res.rows[0]?.['id'] as string | undefined;
    if (!roleId) continue;

    const permsToSync = Object.entries(perms).filter(([p]) => registeredCodes.has(p));

    // Only purge grants that left the matrix when explicitly requested
    if (purgeOrphans) {
      await db.query(
        `DELETE FROM app.role_permissions
          WHERE organization_id = $1 AND role_id = $2
            AND NOT (permission_code = ANY($3::text[]))`,
        [organizationId, roleId, permsToSync.map(([p]) => p)],
      );
    }

    for (const [permission, mode] of permsToSync) {
      await db.query(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE
           SET scope_mode = EXCLUDED.scope_mode
         WHERE app.role_permissions.scope_mode IS DISTINCT FROM EXCLUDED.scope_mode`,
        [organizationId, roleId, permission, mode],
      );
    }
  }

  // 5. Execute controlled reconciliation for audit and reporting
  return reconcileTenantPermissions(db, organizationId, {
    allowCriticalGrants: allowCritical,
    preserveCustomizations: !purgeOrphans,
  });
}

/**
 * Seeds MFA permissions (auth.mfa.manage and user.account.reset_mfa) for existing tenant roles
 * idempotently without overwriting tenant-customized permissions or deleting any existing grants.
 * If organizationId is provided, seeds only that tenant; otherwise seeds all existing tenants.
 */
export async function seedMfaPermissions(db: SqlExecutor, organizationId?: string): Promise<void> {
  const params: unknown[] = organizationId ? [organizationId] : [];

  const queryManage = organizationId
    ? `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'auth.mfa.manage', 'SELF'
         FROM app.roles r
        WHERE r.code IN ('STUDENT', 'FACULTY', 'STAFF', 'HOD', 'DEPARTMENT_ADMIN', 'CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR')
          AND r.organization_id = $1
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`
    : `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'auth.mfa.manage', 'SELF'
         FROM app.roles r
        WHERE r.code IN ('STUDENT', 'FACULTY', 'STAFF', 'HOD', 'DEPARTMENT_ADMIN', 'CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR')
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`;

  await db.query(queryManage, params);

  const queryReset = organizationId
    ? `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'user.account.reset_mfa', 'GRANTED'
         FROM app.roles r
        WHERE r.code IN ('CAMPUS_ADMIN', 'COLLEGE_ADMIN')
          AND r.organization_id = $1
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`
    : `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'user.account.reset_mfa', 'GRANTED'
         FROM app.roles r
        WHERE r.code IN ('CAMPUS_ADMIN', 'COLLEGE_ADMIN')
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`;

  await db.query(queryReset, params);
}
