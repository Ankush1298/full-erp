import { type RoleCode } from './role-matrix.js';
import {
  acquireDenialPolicyLock,
  getTenantExplicitDenials,
  reconcileTenantPermissions,
  type ReconciliationResult,
} from './reconcile.js';

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
   * Defaults to false for background and ordinary maintenance operations to prevent unintended privilege escalation.
   */
  allowCriticalGrants?: boolean | undefined;
  /**
   * If true, resets canonical scope mode drift back to the canonical matrix (operator re-seed).
   * Defaults to false (preserves tenant-customized scope modes during background reconciliation).
   */
  resetCanonicalScopes?: boolean | undefined;
  /** Filter to specific role codes. */
  roles?: RoleCode[] | undefined;
  /** Optional role display titles mapping (roleCode -> displayTitle). Defaults to roleCode. */
  roleDisplayTitles?: Record<string, string> | undefined;
  /** If true, calculates the diff without modifying the database. Defaults to false. */
  dryRun?: boolean | undefined;
}

/**
 * Seeds or reconciles system roles and baseline permissions for one tenant organization.
 *
 * Safety & Invariant Guarantees:
 * 1. Controlled non-destructive reconciliation by default: never blanket-deletes institution custom grants.
 * 2. Assigns institution-type-specific role display titles when provided.
 * 3. Idempotent: running repeatedly leaves matching permissions and assignments unchanged.
 * 4. Only purges orphaned grants when explicitly requested via purgeOrphanGrants: true.
 * 5. Fails safe by default: allowCriticalGrants defaults to false.
 * 6. Uses single authoritative role planning and execution path via reconcileTenantPermissions.
 */
export async function seedTenantRoles(
  db: SqlExecutor,
  organizationId: string,
  options: SeedTenantRolesOptions = {},
): Promise<ReconciliationResult> {
  const purgeOrphans = options.purgeOrphanGrants === true;
  const allowCritical = options.allowCriticalGrants ?? false;
  const resetScopes = options.resetCanonicalScopes ?? false;

  // 1. Fail closed: validate explicit denials configuration BEFORE any mutations
  await getTenantExplicitDenials(db, organizationId);

  // 2. Delegate directly to reconcileTenantPermissions (authoritative role-planning and execution path)
  return reconcileTenantPermissions(db, organizationId, {
    dryRun: options.dryRun,
    allowCriticalGrants: allowCritical,
    preserveCustomizations: options.preserveCustomizations ?? !purgeOrphans,
    purgeOrphanGrants: purgeOrphans,
    resetCanonicalScopes: resetScopes,
    roles: options.roles,
    roleDisplayTitles: options.roleDisplayTitles,
  });
}

export interface AddedMfaGrant {
  organizationId: string;
  roleCode: string;
  permissionCode: string;
  scopeMode: string;
}

export interface SeedMfaPermissionsOptions {
  /**
   * If true, allows granting user.account.reset_mfa (CRITICAL).
   * Defaults to false to prevent unverified administrative privilege grant during maintenance.
   */
  allowCriticalGrants?: boolean | undefined;
}

/**
 * Seeds MFA permissions (auth.mfa.manage and user.account.reset_mfa) for tenant roles
 * idempotently without overwriting tenant-customized permissions or deleting any existing grants.
 * Strictly validates explicit tenant denials using fail-closed getTenantExplicitDenials() across
 * both single-tenant and bulk execution paths.
 *
 * If organizationId is provided, seeds only that tenant; otherwise seeds all active tenants.
 */
export async function seedMfaPermissions(
  db: SqlExecutor,
  organizationId?: string,
  options: SeedMfaPermissionsOptions = {},
): Promise<{ addedMfaGrants: AddedMfaGrant[] }> {
  const allowCritical = options.allowCriticalGrants ?? false;
  const addedMfaGrants: AddedMfaGrant[] = [];

  const eligibleManageRoles = [
    'STUDENT',
    'FACULTY',
    'STAFF',
    'HOD',
    'DEPARTMENT_ADMIN',
    'CAMPUS_ADMIN',
    'COLLEGE_ADMIN',
    'REGISTRAR',
    'PARENT',
  ];
  // Administrative reset_mfa is restricted to executive roles only; PARENT NEVER receives it.
  const eligibleResetRoles = ['CAMPUS_ADMIN', 'COLLEGE_ADMIN'];

  // Verify that platform.permissions has registered MFA permissions before inserting into role_permissions
  const regCheck = await db.query(
    `SELECT code FROM platform.permissions WHERE code IN ('auth.mfa.manage', 'user.account.reset_mfa')`,
  );
  const registeredPerms = new Set(regCheck.rows.map((r) => r['code'] as string));
  const canManage = registeredPerms.has('auth.mfa.manage');
  const canReset = registeredPerms.has('user.account.reset_mfa');
  if (!canManage && !canReset) {
    return { addedMfaGrants };
  }

  const targetOrgIds: string[] = [];
  if (organizationId) {
    targetOrgIds.push(organizationId);
  } else {
    const orgsRes = await db.query(
      `SELECT id FROM app.organizations WHERE status = 'ACTIVE' ORDER BY id`,
    );
    for (const row of orgsRes.rows) {
      targetOrgIds.push(row['id'] as string);
    }
  }

  for (const orgId of targetOrgIds) {
    // Synchronize with denial-policy writers
    await acquireDenialPolicyLock(db, orgId);

    // Strict fail-closed validation for each tenant
    const deniedMap = await getTenantExplicitDenials(db, orgId);
    const rolesRes = await db.query('SELECT id, code FROM app.roles WHERE organization_id = $1', [
      orgId,
    ]);
    const rolesById = new Map<string, string>(
      rolesRes.rows.map((r) => [r['id'] as string, r['code'] as string]),
    );

    // 1. auth.mfa.manage with SELF scope
    if (canManage) {
      const allowedManageRoles = eligibleManageRoles.filter(
        (r) => !deniedMap[r]?.has('auth.mfa.manage'),
      );
      if (allowedManageRoles.length > 0) {
        const res = await db.query(
          `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
           SELECT r.organization_id, r.id, 'auth.mfa.manage', 'SELF'
             FROM app.roles r
            WHERE r.code = ANY($2::text[])
              AND r.organization_id = $1
           ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING
           RETURNING role_id, permission_code, scope_mode`,
          [orgId, allowedManageRoles],
        );
        for (const row of res.rows) {
          addedMfaGrants.push({
            organizationId: orgId,
            roleCode: rolesById.get(row['role_id'] as string) ?? '',
            permissionCode: row['permission_code'] as string,
            scopeMode: row['scope_mode'] as string,
          });
        }
      }
    }

    // 2. user.account.reset_mfa (CRITICAL) - strictly requires allowCritical: true
    if (canReset && allowCritical) {
      const allowedResetRoles = eligibleResetRoles.filter(
        (r) => !deniedMap[r]?.has('user.account.reset_mfa'),
      );
      if (allowedResetRoles.length > 0) {
        const res = await db.query(
          `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
           SELECT r.organization_id, r.id, 'user.account.reset_mfa', 'GRANTED'
             FROM app.roles r
            WHERE r.code = ANY($2::text[])
              AND r.organization_id = $1
           ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING
           RETURNING role_id, permission_code, scope_mode`,
          [orgId, allowedResetRoles],
        );
        for (const row of res.rows) {
          addedMfaGrants.push({
            organizationId: orgId,
            roleCode: rolesById.get(row['role_id'] as string) ?? '',
            permissionCode: row['permission_code'] as string,
            scopeMode: row['scope_mode'] as string,
          });
        }
      }
    }
  }

  return { addedMfaGrants };
}
