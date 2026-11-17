import { ROLE_MATRIX, type RoleCode } from './role-matrix.js';
import type { SqlExecutor } from './seed.js';

/**
 * Set of critical security and financial permissions that must NEVER be granted automatically
 * during background or bulk reconciliation without explicit administrative authorization.
 */
export const CRITICAL_PERMISSIONS: ReadonlySet<string> = new Set([
  'fee.gateway.manage',
  'fee.refund.initiate',
  'fee.receipt.reverse',
  'vault.authority.manage',
  'vault.recovery.initiate',
  'vault.grant.issue',
  'vault.device.manage',
  'student.status.change',
  'user.account.suspend',
  'user.account.reset_mfa',
  'org.settings.manage',
  'attendance.session.lock',
  'role.assignment.grant',
  'role.assignment.revoke',
  'result.publish',
]);

export interface ReconciliationOptions {
  /** If true, calculates the diff without modifying the database. Defaults to false. */
  dryRun?: boolean;
  /**
   * If true, allows adding permissions classified as CRITICAL.
   * Defaults to false: critical capabilities are skipped and surfaced in skippedCritical.
   */
  allowCriticalGrants?: boolean;
  /**
   * If true, existing permissions in DB not present in the canonical matrix are preserved.
   * Defaults to true (safe non-destructive reconciliation).
   */
  preserveCustomizations?: boolean;
  /** Filter to specific role codes. */
  roles?: RoleCode[];
}

export interface ProposedAddition {
  roleCode: RoleCode;
  permissionCode: string;
  scopeMode: string;
  isCritical: boolean;
}

export interface SkippedPermission {
  roleCode: RoleCode;
  permissionCode: string;
  reason: string;
}

export interface PreservedCustomGrant {
  roleCode: RoleCode;
  permissionCode: string;
  scopeMode: string;
}

export interface ScopeChange {
  roleCode: RoleCode;
  permissionCode: string;
  currentScopeMode: string;
  newScopeMode: string;
}

export interface ReconciliationPlan {
  organizationId: string;
  proposedAdditions: ProposedAddition[];
  skippedCritical: SkippedPermission[];
  explicitDenials: SkippedPermission[];
  preservedCustomizations: PreservedCustomGrant[];
  proposedScopeChanges: ScopeChange[];
  alreadyPresentCount: number;
}

export interface ReconciliationResult {
  organizationId: string;
  plan: ReconciliationPlan;
  addedGrants: { roleCode: string; permissionCode: string; scopeMode: string }[];
  preservedCustomGrants: { roleCode: string; permissionCode: string }[];
  alreadyPresentCount: number;
  skippedCriticalCount: number;
  executed: boolean;
}

/**
 * Computes a detailed dry-run diff (ReconciliationPlan) of proposed additions,
 * skipped critical capabilities, preserved customizations, and explicit denials
 * for a tenant organization against the canonical ROLE_MATRIX.
 */
export async function planTenantReconciliation(
  db: SqlExecutor,
  organizationId: string,
  options: ReconciliationOptions = {},
): Promise<ReconciliationPlan> {
  const allowCritical = options.allowCriticalGrants === true;
  const targetRoles = options.roles ? new Set(options.roles) : null;

  // 1. Fetch platform-registered permissions
  const registeredRes = await db.query('SELECT code FROM platform.permissions');
  const validCodes = new Set(registeredRes.rows.map((r) => r['code'] as string));

  // 2. Fetch tenant roles
  const rolesRes = await db.query('SELECT id, code FROM app.roles WHERE organization_id = $1', [
    organizationId,
  ]);
  const rolesByCode = new Map<string, string>(
    rolesRes.rows.map((r) => [r['code'] as string, r['id'] as string]),
  );

  // 3. Fetch explicit tenant denials from organization_settings if present
  let deniedMap: Record<string, string[]> = {};
  try {
    const tableCheck = await db.query(
      `SELECT to_regclass('app.organization_settings') IS NOT NULL AS has_table`,
    );
    if (tableCheck.rows[0]?.has_table) {
      const settingsRes = await db.query(
        `SELECT value FROM app.organization_settings
          WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
        [organizationId],
      );
      if (settingsRes.rows.length > 0 && settingsRes.rows[0]?.['value']) {
        let val: unknown = settingsRes.rows[0]['value'];
        if (typeof val === 'string') {
          try {
            val = JSON.parse(val) as unknown;
          } catch {
            val = {};
          }
        }
        if (typeof val === 'object' && val !== null) {
          deniedMap = val as Record<string, string[]>;
        }
      }
    }
  } catch {
    // If organization_settings is not queryable or table doesn't exist, proceed safely
    deniedMap = {};
  }

  // 4. Fetch existing role permissions for tenant
  const existingPermsRes = await db.query(
    `SELECT rp.role_id, r.code AS role_code, rp.permission_code, rp.scope_mode
       FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id
      WHERE rp.organization_id = $1`,
    [organizationId],
  );

  const existingByRolePerm = new Map<string, string>();
  for (const row of existingPermsRes.rows) {
    const rCode = row['role_code'] as string;
    const pCode = row['permission_code'] as string;
    const sMode = row['scope_mode'] as string;
    existingByRolePerm.set(`${rCode}:${pCode}`, sMode);
  }

  const proposedAdditions: ProposedAddition[] = [];
  const skippedCritical: SkippedPermission[] = [];
  const explicitDenials: SkippedPermission[] = [];
  const preservedCustomizations: PreservedCustomGrant[] = [];
  const proposedScopeChanges: ScopeChange[] = [];
  let alreadyPresentCount = 0;

  // Track preserved custom grants (permissions in DB absent from canonical ROLE_MATRIX)
  for (const row of existingPermsRes.rows) {
    const rCode = row['role_code'] as RoleCode;
    const pCode = row['permission_code'] as string;
    const sMode = row['scope_mode'] as string;
    const canonicalMode = ROLE_MATRIX[rCode]?.[pCode];
    if (canonicalMode === undefined) {
      preservedCustomizations.push({ roleCode: rCode, permissionCode: pCode, scopeMode: sMode });
    }
  }

  // Evaluate matrix permissions
  for (const [roleCodeStr, perms] of Object.entries(ROLE_MATRIX)) {
    const roleCode = roleCodeStr as RoleCode;
    if (targetRoles && !targetRoles.has(roleCode)) continue;
    if (!rolesByCode.has(roleCode)) continue;

    const deniedForRole = new Set(deniedMap[roleCode] || []);

    for (const [permCode, canonicalScopeMode] of Object.entries(perms)) {
      if (!validCodes.has(permCode)) continue;

      const key = `${roleCode}:${permCode}`;
      const existingScopeMode = existingByRolePerm.get(key);

      if (existingScopeMode !== undefined) {
        if (existingScopeMode === canonicalScopeMode) {
          alreadyPresentCount++;
        } else {
          proposedScopeChanges.push({
            roleCode,
            permissionCode: permCode,
            currentScopeMode: existingScopeMode,
            newScopeMode: canonicalScopeMode,
          });
        }
        continue;
      }

      // Check explicit denials
      if (deniedForRole.has(permCode)) {
        explicitDenials.push({
          roleCode,
          permissionCode: permCode,
          reason: 'Explicitly denied in organization_settings (authorization.denied_permissions)',
        });
        continue;
      }

      const isCritical = CRITICAL_PERMISSIONS.has(permCode);

      if (isCritical && !allowCritical) {
        skippedCritical.push({
          roleCode,
          permissionCode: permCode,
          reason:
            'Classified as CRITICAL. Requires explicit authorization (allowCriticalGrants: true).',
        });
      } else {
        proposedAdditions.push({
          roleCode,
          permissionCode: permCode,
          scopeMode: canonicalScopeMode,
          isCritical,
        });
      }
    }
  }

  return {
    organizationId,
    proposedAdditions,
    skippedCritical,
    explicitDenials,
    preservedCustomizations,
    proposedScopeChanges,
    alreadyPresentCount,
  };
}

/**
 * Executes a controlled reconciliation plan against the tenant database.
 * Strictly non-destructive: never deletes custom grants or explicit denials.
 */
export async function executeTenantReconciliation(
  db: SqlExecutor,
  plan: ReconciliationPlan,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const isDryRun = options.dryRun === true;
  const allowCritical = options.allowCriticalGrants === true;

  if (isDryRun) {
    return {
      organizationId: plan.organizationId,
      plan,
      addedGrants: [],
      preservedCustomGrants: plan.preservedCustomizations.map((c) => ({
        roleCode: c.roleCode,
        permissionCode: c.permissionCode,
      })),
      alreadyPresentCount: plan.alreadyPresentCount,
      skippedCriticalCount: plan.skippedCritical.length,
      executed: false,
    };
  }

  // Fetch role IDs
  const rolesRes = await db.query('SELECT id, code FROM app.roles WHERE organization_id = $1', [
    plan.organizationId,
  ]);
  const rolesByCode = new Map<string, string>(
    rolesRes.rows.map((r) => [r['code'] as string, r['id'] as string]),
  );

  const addedGrants: { roleCode: string; permissionCode: string; scopeMode: string }[] = [];

  for (const item of plan.proposedAdditions) {
    if (item.isCritical && !allowCritical) {
      continue;
    }
    const roleId = rolesByCode.get(item.roleCode);
    if (!roleId) continue;

    await db.query(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`,
      [plan.organizationId, roleId, item.permissionCode, item.scopeMode],
    );

    addedGrants.push({
      roleCode: item.roleCode,
      permissionCode: item.permissionCode,
      scopeMode: item.scopeMode,
    });
  }

  return {
    organizationId: plan.organizationId,
    plan,
    addedGrants,
    preservedCustomGrants: plan.preservedCustomizations.map((c) => ({
      roleCode: c.roleCode,
      permissionCode: c.permissionCode,
    })),
    alreadyPresentCount: plan.alreadyPresentCount,
    skippedCriticalCount: plan.skippedCritical.length,
    executed: true,
  };
}

/**
 * High-level entrypoint: reconciles permissions for one tenant organization.
 */
export async function reconcileTenantPermissions(
  db: SqlExecutor,
  organizationId: string,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult> {
  const plan = await planTenantReconciliation(db, organizationId, options);
  return executeTenantReconciliation(db, plan, options);
}

/**
 * Reconciles all organizations in the platform idempotently and safely.
 */
export async function reconcileAllOrganizations(
  db: SqlExecutor,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult[]> {
  const orgsRes = await db.query('SELECT id FROM app.organizations WHERE status = $1', ['ACTIVE']);
  const results: ReconciliationResult[] = [];

  for (const org of orgsRes.rows) {
    const orgId = org['id'] as string;
    const res = await reconcileTenantPermissions(db, orgId, options);
    results.push(res);
  }

  return results;
}
