import { CRITICAL_PERMISSIONS } from './catalog.js';
import { ROLE_MATRIX, type RoleCode } from './role-matrix.js';
import type { SqlExecutor } from './seed.js';
import { uuidv7 } from '../ids/uuidv7.js';

export { CRITICAL_PERMISSIONS };

/**
 * Evaluates whether changing a permission's scope mode from `from` to `to` widens privileges.
 * In the CampusOS authorization engine (docs/architecture/v3/06 §1, 14-authorization-scopes):
 * - SELF: strictly bounded to the actor's own resources.
 * - ASSIGNED: bounded by a registered relationship (e.g. course teacher to student).
 * - GRANTED: full organizational, campus, or departmental authority conferred by role assignment.
 *
 * Therefore:
 * - SELF -> ASSIGNED or GRANTED is widening.
 * - ASSIGNED -> GRANTED is widening.
 * - Narrowing or unchanged scope transitions are NOT widening.
 */
export function isScopeWidening(from: string, to: string): boolean {
  if (from === to) return false;
  if (from === 'SELF') return to === 'ASSIGNED' || to === 'GRANTED';
  if (from === 'ASSIGNED') return to === 'GRANTED';
  return false;
}

export interface ReconciliationOptions {
  /** If true, calculates the diff without modifying the database. Defaults to false. */
  dryRun?: boolean | undefined;
  /**
   * If true, allows adding permissions classified as CRITICAL or widening scope on CRITICAL permissions.
   * Defaults to false: critical capabilities are skipped and surfaced in skippedCritical.
   */
  allowCriticalGrants?: boolean | undefined;
  /**
   * If true, existing permissions in DB not present in the canonical matrix are preserved.
   * Defaults to true (safe non-destructive reconciliation).
   */
  preserveCustomizations?: boolean | undefined;
  /**
   * If true, purges grants that left the canonical matrix or are not in the matrix for evaluated roles.
   */
  purgeOrphanGrants?: boolean | undefined;
  /**
   * If true, resets scope mode drift back to the canonical matrix.
   * Defaults to false (preserves tenant-customized scope modes during background reconciliation).
   */
  resetCanonicalScopes?: boolean | undefined;
  /** Filter to specific role codes. */
  roles?: RoleCode[] | undefined;
  /** Optional role display titles mapping (roleCode -> displayTitle). Defaults to roleCode. */
  roleDisplayTitles?: Record<string, string> | undefined;
}

export interface ProposedRoleChange {
  roleCode: RoleCode;
  action: 'CREATE' | 'UPDATE_NAME';
  currentName?: string | undefined;
  newName: string;
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
  proposedRoleChanges: ProposedRoleChange[];
  proposedAdditions: ProposedAddition[];
  skippedCritical: SkippedPermission[];
  explicitDenials: SkippedPermission[];
  preservedCustomizations: PreservedCustomGrant[];
  observedScopeDrifts: ScopeChange[];
  proposedScopeChanges: ScopeChange[];
  proposedOrphanPurges: PreservedCustomGrant[];
  proposedMfaAdditions: { roleCode: string; permissionCode: string; scopeMode: string }[];
  alreadyPresentCount: number;
}

export interface ReconciliationResult {
  organizationId: string;
  plan: ReconciliationPlan;
  createdRoles: { roleCode: RoleCode; name: string }[];
  updatedRoleNames: {
    roleCode: RoleCode;
    oldName?: string | undefined;
    newName: string;
  }[];
  addedGrants: { roleCode: string; permissionCode: string; scopeMode: string }[];
  appliedScopeChanges: {
    roleCode: string;
    permissionCode: string;
    oldScopeMode: string;
    newScopeMode: string;
  }[];
  purgedOrphanGrants: { roleCode: string; permissionCode: string }[];
  preservedCustomGrants: { roleCode: string; permissionCode: string }[];
  alreadyPresentCount: number;
  skippedCriticalCount: number;
  runtimeExplicitDenials?: SkippedPermission[] | undefined;
  runtimeSkippedCritical?: SkippedPermission[] | undefined;
  executed: boolean;
}

/**
 * Canonical advisory lock key for tenant explicit denial policy synchronization.
 */
export function denialPolicyLockKey(organizationId: string): string {
  return `app.authorization_denials:${organizationId}`;
}

/**
 * Transaction-safe synchronization lock for tenant explicit denial policy.
 * Uses a transaction-scoped advisory lock keyed on the organization ID,
 * ensuring mutual exclusion between denial-policy writers and permission reconcilers
 * whether the setting row exists or is initially absent.
 * Also acquires a FOR SHARE row lock on app.organization_settings if the row already exists.
 *
 * Transaction Contract:
 * pg_advisory_xact_lock is an advisory transaction lock held until COMMIT or ROLLBACK.
 * In production, operations run within an active transaction (e.g. TenantTx via withTenant/withSystem).
 * If caller executes in autocommit mode, the advisory lock is released immediately upon query completion.
 * Callers performing non-dry-run writes must maintain an active transaction for the duration of the mutation.
 */
export async function acquireDenialPolicyLock(
  db: SqlExecutor,
  organizationId: string,
): Promise<void> {
  // 1. Transaction-level advisory lock accounts for both existing and initially absent rows
  await db.query(`SELECT pg_catalog.pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    denialPolicyLockKey(organizationId),
  ]);

  // 2. If app.organization_settings table exists and row exists, acquire row lock
  const tableCheck = await db.query(
    `SELECT to_regclass('app.organization_settings') IS NOT NULL AS has_table`,
  );
  if (tableCheck.rows[0]?.['has_table']) {
    await db.query(
      `SELECT 1 FROM app.organization_settings
        WHERE organization_id = $1 AND key = 'authorization.denied_permissions'
          FOR SHARE`,
      [organizationId],
    );
  }
}

/**
 * Updates or sets explicit permission denials for an organization in a transaction-safe manner.
 * Synchronizes with concurrent reconciliations and fails closed on malformed inputs.
 */
export async function setTenantExplicitDenials(
  db: SqlExecutor,
  organizationId: string,
  denials: Record<string, string[]>,
  updatedBy: string,
): Promise<void> {
  if (typeof denials !== 'object' || denials === null || Array.isArray(denials)) {
    throw new Error(
      `Invalid format for authorization.denied_permissions setting for tenant ${organizationId}. Expected object mapping role codes to permission arrays.`,
    );
  }

  for (const [roleCode, perms] of Object.entries(denials)) {
    if (roleCode === '__proto__' || roleCode === 'prototype' || roleCode === 'constructor') {
      throw new Error(
        `Invalid role code "${roleCode}" in authorization.denied_permissions for tenant ${organizationId}. Prototype property names are forbidden.`,
      );
    }
    if (!Array.isArray(perms)) {
      throw new Error(
        `Invalid format for authorization.denied_permissions[${roleCode}] for tenant ${organizationId}. Expected array of permission codes.`,
      );
    }
    for (let i = 0; i < perms.length; i++) {
      const p: unknown = perms[i];
      if (typeof p !== 'string' || !p.trim()) {
        throw new Error(
          `Invalid permission entry at index ${i} for role "${roleCode}" in authorization.denied_permissions for tenant ${organizationId}. Expected non-empty string.`,
        );
      }
    }
  }

  await acquireDenialPolicyLock(db, organizationId);

  const json = JSON.stringify(denials);
  await db.query(
    `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
     VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
     ON CONFLICT (organization_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
    [organizationId, json, updatedBy],
  );
}

/**
 * Removes explicit permission denials for an organization in a transaction-safe manner.
 */
export async function clearTenantExplicitDenials(
  db: SqlExecutor,
  organizationId: string,
): Promise<void> {
  await acquireDenialPolicyLock(db, organizationId);
  const tableCheck = await db.query(
    `SELECT to_regclass('app.organization_settings') IS NOT NULL AS has_table`,
  );
  if (tableCheck.rows[0]?.['has_table']) {
    await db.query(
      `DELETE FROM app.organization_settings
        WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
      [organizationId],
    );
  }
}

/**
 * Reads and validates explicit denials configured in app.organization_settings (authorization.denied_permissions).
 * Fails closed: if the table exists but settings are malformed, unreadable, null, non-object, contain invalid
 * array elements or prototype properties, throws an error rather than silently permitting unauthorized additions
 * or scope widening.
 *
 * An absent settings row indicates that no explicit denials are configured and returns an empty map Object.create(null).
 */
export async function getTenantExplicitDenials(
  db: SqlExecutor,
  organizationId: string,
): Promise<Record<string, Set<string>>> {
  const tableCheck = await db.query(
    `SELECT to_regclass('app.organization_settings') IS NOT NULL AS has_table`,
  );
  if (!tableCheck.rows[0]?.['has_table']) {
    return Object.create(null) as Record<string, Set<string>>;
  }

  const settingsRes = await db.query(
    `SELECT value FROM app.organization_settings
      WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
    [organizationId],
  );

  // Absent row: valid state meaning no explicit denials configured
  if (settingsRes.rows.length === 0) {
    return Object.create(null) as Record<string, Set<string>>;
  }

  const rawVal = settingsRes.rows[0]?.['value'];
  if (rawVal === undefined || rawVal === null) {
    throw new Error(
      `Invalid explicit denials configuration for tenant ${organizationId}: value cannot be null or undefined.`,
    );
  }

  let val: unknown = rawVal;
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val) as unknown;
    } catch (e) {
      throw new Error(
        `Failed to parse explicit denials setting (authorization.denied_permissions) for tenant ${organizationId}: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  if (typeof val !== 'object' || val === null || Array.isArray(val)) {
    throw new Error(
      `Invalid format for authorization.denied_permissions setting for tenant ${organizationId}. Expected object mapping role codes to permission arrays, received ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val}.`,
    );
  }

  const result: Record<string, Set<string>> = Object.create(null) as Record<string, Set<string>>;
  for (const [roleCode, perms] of Object.entries(val as Record<string, unknown>)) {
    if (roleCode === '__proto__' || roleCode === 'prototype' || roleCode === 'constructor') {
      throw new Error(
        `Invalid role code "${roleCode}" in authorization.denied_permissions for tenant ${organizationId}. Prototype property names are forbidden.`,
      );
    }
    if (!Array.isArray(perms)) {
      throw new Error(
        `Invalid format for authorization.denied_permissions[${roleCode}] for tenant ${organizationId}. Expected array of permission codes, received ${typeof perms}.`,
      );
    }
    const permList = perms as unknown[];
    const permSet = new Set<string>();
    for (let i = 0; i < permList.length; i++) {
      const p: unknown = permList[i];
      if (typeof p !== 'string' || !p.trim()) {
        throw new Error(
          `Invalid permission entry at index ${i} for role "${roleCode}" in authorization.denied_permissions for tenant ${organizationId}. Expected non-empty string, received ${JSON.stringify(p)}.`,
        );
      }
      permSet.add(p.trim());
    }
    result[roleCode] = permSet;
  }

  return result;
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
  const resetScopes = options.resetCanonicalScopes === true;

  // 1. Fetch platform-registered permissions
  const registeredRes = await db.query('SELECT code FROM platform.permissions');
  const validCodes = new Set(registeredRes.rows.map((r) => r['code'] as string));

  // 2. Fetch tenant roles (including name)
  const rolesRes = await db.query(
    'SELECT id, code, name FROM app.roles WHERE organization_id = $1',
    [organizationId],
  );
  const rolesByCode = new Map<string, { id: string; name: string | null }>(
    rolesRes.rows.map((r) => [
      r['code'] as string,
      { id: r['id'] as string, name: (r['name'] as string | null) ?? null },
    ]),
  );

  // 3. Fetch explicit tenant denials from organization_settings if present
  const deniedMap = await getTenantExplicitDenials(db, organizationId);

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

  const proposedRoleChanges: ProposedRoleChange[] = [];
  const proposedAdditions: ProposedAddition[] = [];
  const skippedCritical: SkippedPermission[] = [];
  const explicitDenials: SkippedPermission[] = [];
  const preservedCustomizations: PreservedCustomGrant[] = [];
  const observedScopeDrifts: ScopeChange[] = [];
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

  // 5. Evaluate canonical roles: check missing roles and name updates
  for (const code of Object.keys(ROLE_MATRIX) as RoleCode[]) {
    if (targetRoles && !targetRoles.has(code)) continue;
    const displayTitle = options.roleDisplayTitles?.[code] ?? code;
    const existingRole = rolesByCode.get(code);

    if (!existingRole) {
      proposedRoleChanges.push({
        roleCode: code,
        action: 'CREATE',
        newName: displayTitle,
      });
    } else if (
      (existingRole.name === code || existingRole.name === null) &&
      existingRole.name !== displayTitle
    ) {
      proposedRoleChanges.push({
        roleCode: code,
        action: 'UPDATE_NAME',
        currentName: existingRole.name ?? undefined,
        newName: displayTitle,
      });
    }
  }

  // 6. Evaluate matrix permissions for target roles
  for (const [roleCodeStr, perms] of Object.entries(ROLE_MATRIX)) {
    const roleCode = roleCodeStr as RoleCode;
    if (targetRoles && !targetRoles.has(roleCode)) continue;

    const deniedForRole = deniedMap[roleCode] ?? new Set<string>();

    for (const [permCode, canonicalScopeMode] of Object.entries(perms)) {
      if (!validCodes.has(permCode)) continue;

      const key = `${roleCode}:${permCode}`;
      const existingScopeMode = existingByRolePerm.get(key);

      if (existingScopeMode !== undefined) {
        if (existingScopeMode === canonicalScopeMode) {
          alreadyPresentCount++;
        } else {
          // Record observed scope drift
          const drift: ScopeChange = {
            roleCode,
            permissionCode: permCode,
            currentScopeMode: existingScopeMode,
            newScopeMode: canonicalScopeMode,
          };
          observedScopeDrifts.push(drift);

          // Only propose scope correction if resetCanonicalScopes is true
          if (resetScopes) {
            // Check explicit denials on scope changes
            if (deniedForRole.has(permCode)) {
              explicitDenials.push({
                roleCode,
                permissionCode: permCode,
                reason:
                  'Scope correction blocked: Explicitly denied in organization_settings (authorization.denied_permissions)',
              });
              continue;
            }

            const isCritical = CRITICAL_PERMISSIONS.has(permCode);
            const isWidening = isScopeWidening(existingScopeMode, canonicalScopeMode);

            if (isCritical && isWidening && !allowCritical) {
              skippedCritical.push({
                roleCode,
                permissionCode: permCode,
                reason:
                  'Scope widening classified as CRITICAL. Requires explicit authorization (allowCriticalGrants: true).',
              });
            } else {
              proposedScopeChanges.push(drift);
            }
          }
        }
        continue;
      }

      // Permission not present for role
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

  // 7. Proposed orphan purges (respecting targetRoles)
  const proposedOrphanPurges: PreservedCustomGrant[] = [];
  if (options.purgeOrphanGrants === true) {
    for (const cust of preservedCustomizations) {
      if (targetRoles && !targetRoles.has(cust.roleCode)) continue;
      if (ROLE_MATRIX[cust.roleCode]) {
        proposedOrphanPurges.push(cust);
      }
    }
  }

  // 8. Evaluate eligible MFA additions for non-matrix roles (specifically PARENT self-service MFA)
  const hasParentRole = rolesByCode.has('PARENT');
  if (
    hasParentRole &&
    (!targetRoles || targetRoles.has('PARENT' as RoleCode)) &&
    validCodes.has('auth.mfa.manage')
  ) {
    const parentMfaScope = existingByRolePerm.get('PARENT:auth.mfa.manage');
    if (parentMfaScope === undefined) {
      if (deniedMap['PARENT']?.has('auth.mfa.manage')) {
        explicitDenials.push({
          roleCode: 'PARENT' as RoleCode,
          permissionCode: 'auth.mfa.manage',
          reason: 'Explicitly denied in organization_settings (authorization.denied_permissions)',
        });
      } else {
        proposedAdditions.push({
          roleCode: 'PARENT' as RoleCode,
          permissionCode: 'auth.mfa.manage',
          scopeMode: 'SELF',
          isCritical: false,
        });
      }
    } else if (parentMfaScope === 'SELF') {
      alreadyPresentCount++;
    } else {
      const drift: ScopeChange = {
        roleCode: 'PARENT' as RoleCode,
        permissionCode: 'auth.mfa.manage',
        currentScopeMode: parentMfaScope,
        newScopeMode: 'SELF',
      };
      observedScopeDrifts.push(drift);
      if (resetScopes) {
        if (deniedMap['PARENT']?.has('auth.mfa.manage')) {
          explicitDenials.push({
            roleCode: 'PARENT' as RoleCode,
            permissionCode: 'auth.mfa.manage',
            reason:
              'Scope correction blocked: Explicitly denied in organization_settings (authorization.denied_permissions)',
          });
        } else {
          proposedScopeChanges.push(drift);
        }
      }
    }
  }

  // Derived MFA additions for plan inspection (zero duplicate proposals)
  const proposedMfaAdditions: { roleCode: string; permissionCode: string; scopeMode: string }[] =
    proposedAdditions
      .filter(
        (a) =>
          a.permissionCode === 'auth.mfa.manage' || a.permissionCode === 'user.account.reset_mfa',
      )
      .map((a) => ({
        roleCode: a.roleCode,
        permissionCode: a.permissionCode,
        scopeMode: a.scopeMode,
      }));

  return {
    organizationId,
    proposedRoleChanges,
    proposedAdditions,
    skippedCritical,
    explicitDenials,
    preservedCustomizations,
    observedScopeDrifts,
    proposedScopeChanges,
    proposedOrphanPurges,
    proposedMfaAdditions,
    alreadyPresentCount,
  };
}

/**
 * Executes a controlled reconciliation plan against the tenant database.
 * Strictly non-destructive: never deletes custom grants or explicit denials unless explicit purge is requested.
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
      createdRoles: [],
      updatedRoleNames: [],
      addedGrants: [],
      appliedScopeChanges: [],
      purgedOrphanGrants: [],
      preservedCustomGrants: plan.preservedCustomizations.map((c) => ({
        roleCode: c.roleCode,
        permissionCode: c.permissionCode,
      })),
      alreadyPresentCount: plan.alreadyPresentCount,
      skippedCriticalCount: plan.skippedCritical.length,
      executed: false,
    };
  }

  // 1. Transaction-safe synchronization lock with denial-policy writers
  await acquireDenialPolicyLock(db, plan.organizationId);

  // 2. Re-read effective explicit denials fresh under the synchronization lock
  const currentDenials = await getTenantExplicitDenials(db, plan.organizationId);

  // 3. Ensure any missing canonical roles are created and names updated if requested
  const createdRoles: { roleCode: RoleCode; name: string }[] = [];
  const updatedRoleNames: {
    roleCode: RoleCode;
    oldName?: string | undefined;
    newName: string;
  }[] = [];

  for (const roleChange of plan.proposedRoleChanges) {
    if (roleChange.action === 'CREATE') {
      const insRes = await db.query(
        `INSERT INTO app.roles (id, organization_id, code, name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, code) DO NOTHING
         RETURNING code, name`,
        [uuidv7(), plan.organizationId, roleChange.roleCode, roleChange.newName],
      );
      if (insRes.rows.length > 0) {
        createdRoles.push({
          roleCode: roleChange.roleCode,
          name: roleChange.newName,
        });
      }
    } else if (roleChange.action === 'UPDATE_NAME') {
      const updRes = await db.query(
        `UPDATE app.roles SET name = $3
          WHERE organization_id = $1 AND code = $2
            AND (name = code OR name IS NULL)
            AND name IS DISTINCT FROM $3
         RETURNING code, name`,
        [plan.organizationId, roleChange.roleCode, roleChange.newName],
      );
      if (updRes.rows.length > 0) {
        updatedRoleNames.push({
          roleCode: roleChange.roleCode,
          oldName: roleChange.currentName,
          newName: roleChange.newName,
        });
      }
    }
  }

  // Fetch role IDs (now includes any newly created roles)
  const rolesRes = await db.query('SELECT id, code FROM app.roles WHERE organization_id = $1', [
    plan.organizationId,
  ]);
  const rolesByCode = new Map<string, string>(
    rolesRes.rows.map((r) => [r['code'] as string, r['id'] as string]),
  );
  const rolesById = new Map<string, string>(
    rolesRes.rows.map((r) => [r['id'] as string, r['code'] as string]),
  );

  const appliedScopeChanges: {
    roleCode: string;
    permissionCode: string;
    oldScopeMode: string;
    newScopeMode: string;
  }[] = [];

  // 4. Apply canonical scope corrections with compare-and-update concurrency protection (operator re-seed)
  if (options.resetCanonicalScopes === true) {
    for (const change of plan.proposedScopeChanges) {
      // Re-validate explicit denials fresh under lock
      if (currentDenials[change.roleCode]?.has(change.permissionCode)) {
        continue;
      }

      // Lock and fetch current persisted scope mode
      const currentRes = await db.query(
        `SELECT rp.scope_mode
           FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1
            AND r.organization_id = $1
            AND r.code = $2
            AND rp.permission_code = $3
          FOR UPDATE`,
        [plan.organizationId, change.roleCode, change.permissionCode],
      );

      if (currentRes.rows.length === 0) {
        // Concurrently deleted
        continue;
      }

      const persistedScopeMode = currentRes.rows[0]?.['scope_mode'] as string;
      if (persistedScopeMode === change.newScopeMode) {
        // Already at canonical target
        continue;
      }

      // Authoritative critical check
      const isCritical = CRITICAL_PERMISSIONS.has(change.permissionCode);
      const isWidening = isScopeWidening(persistedScopeMode, change.newScopeMode);

      if (isCritical && isWidening && !allowCritical) {
        // Stale plan cannot bypass critical widening restriction
        continue;
      }

      // Atomic compare-and-update
      const updateRes = await db.query(
        `UPDATE app.role_permissions rp
            SET scope_mode = $4
           FROM app.roles r
          WHERE r.id = rp.role_id
            AND rp.organization_id = $1
            AND r.organization_id = $1
            AND r.code = $2
            AND rp.permission_code = $3
            AND rp.scope_mode = $5
         RETURNING r.code as role_code, rp.permission_code, rp.scope_mode`,
        [
          plan.organizationId,
          change.roleCode,
          change.permissionCode,
          change.newScopeMode,
          persistedScopeMode,
        ],
      );

      if (updateRes.rows.length > 0) {
        appliedScopeChanges.push({
          roleCode: change.roleCode,
          permissionCode: change.permissionCode,
          oldScopeMode: persistedScopeMode,
          newScopeMode: change.newScopeMode,
        });
      }
    }
  }

  // 5. Purge orphan grants if requested
  const purgedOrphanGrants: { roleCode: string; permissionCode: string }[] = [];

  if (options.purgeOrphanGrants === true) {
    const targetRoles = options.roles ? new Set(options.roles) : null;
    for (const [code, perms] of Object.entries(ROLE_MATRIX)) {
      const roleCode = code as RoleCode;
      if (targetRoles && !targetRoles.has(roleCode)) continue;
      const allowedPerms = Object.keys(perms);

      const delRes = await db.query(
        `DELETE FROM app.role_permissions rp
          USING app.roles r
          WHERE rp.role_id = r.id
            AND rp.organization_id = $1
            AND r.organization_id = $1
            AND r.code = $2
            AND NOT (rp.permission_code = ANY($3::text[]))
         RETURNING r.code as role_code, rp.permission_code`,
        [plan.organizationId, roleCode, allowedPerms],
      );

      for (const row of delRes.rows) {
        purgedOrphanGrants.push({
          roleCode: row['role_code'] as string,
          permissionCode: row['permission_code'] as string,
        });
      }
    }
  }

  // 6. Batched insert for proposed additions with RETURNING
  const addedGrants: { roleCode: string; permissionCode: string; scopeMode: string }[] = [];
  const runtimeExplicitDenials: SkippedPermission[] = [];
  const runtimeSkippedCritical: SkippedPermission[] = [];
  const itemsToInsert: {
    roleId: string;
    roleCode: RoleCode;
    permissionCode: string;
    scopeMode: string;
  }[] = [];

  for (const item of plan.proposedAdditions) {
    // 1. Re-validate effective explicit denials under lock
    if (currentDenials[item.roleCode]?.has(item.permissionCode)) {
      runtimeExplicitDenials.push({
        roleCode: item.roleCode,
        permissionCode: item.permissionCode,
        reason: 'Explicitly denied in organization_settings (authorization.denied_permissions)',
      });
      continue;
    }

    // 2. Verify critical permissions against the authoritative catalog at execution time
    const isCritical = CRITICAL_PERMISSIONS.has(item.permissionCode);
    if (isCritical && !allowCritical) {
      runtimeSkippedCritical.push({
        roleCode: item.roleCode,
        permissionCode: item.permissionCode,
        reason:
          'Classified as CRITICAL. Requires explicit authorization (allowCriticalGrants: true).',
      });
      continue;
    }

    const roleId = rolesByCode.get(item.roleCode);
    if (!roleId) continue;
    itemsToInsert.push({
      roleId,
      roleCode: item.roleCode,
      permissionCode: item.permissionCode,
      scopeMode: item.scopeMode,
    });
  }

  const BATCH_SIZE = 100;
  for (let i = 0; i < itemsToInsert.length; i += BATCH_SIZE) {
    const chunk = itemsToInsert.slice(i, i + BATCH_SIZE);
    const roleIds = chunk.map((c) => c.roleId);
    const permCodes = chunk.map((c) => c.permissionCode);
    const scopeModes = chunk.map((c) => c.scopeMode);

    const insertRes = await db.query(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT $1::uuid, u.role_id, u.permission_code, u.scope_mode
         FROM unnest($2::uuid[], $3::text[], $4::text[]) AS u(role_id, permission_code, scope_mode)
       ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING
       RETURNING role_id, permission_code, scope_mode`,
      [plan.organizationId, roleIds, permCodes, scopeModes],
    );

    for (const row of insertRes.rows) {
      const rId = row['role_id'] as string;
      const roleCode = rolesById.get(rId) ?? '';
      addedGrants.push({
        roleCode,
        permissionCode: row['permission_code'] as string,
        scopeMode: row['scope_mode'] as string,
      });
    }
  }

  // Compute preserved custom grants: exclude any that were purged!
  const purgedSet = new Set(purgedOrphanGrants.map((p) => `${p.roleCode}:${p.permissionCode}`));
  const preservedCustomGrants = plan.preservedCustomizations
    .filter((c) => !purgedSet.has(`${c.roleCode}:${c.permissionCode}`))
    .map((c) => ({
      roleCode: c.roleCode,
      permissionCode: c.permissionCode,
    }));

  return {
    organizationId: plan.organizationId,
    plan,
    createdRoles,
    updatedRoleNames,
    addedGrants,
    appliedScopeChanges,
    purgedOrphanGrants,
    preservedCustomGrants,
    alreadyPresentCount: plan.alreadyPresentCount,
    skippedCriticalCount: plan.skippedCritical.length + runtimeSkippedCritical.length,
    runtimeExplicitDenials: runtimeExplicitDenials.length > 0 ? runtimeExplicitDenials : undefined,
    runtimeSkippedCritical: runtimeSkippedCritical.length > 0 ? runtimeSkippedCritical : undefined,
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
 * Iterates through active organizations in deterministic order (ORDER BY id ASC) to prevent deadlock
 * when concurrent processes acquire per-tenant locks.
 */
export async function reconcileAllOrganizations(
  db: SqlExecutor,
  options: ReconciliationOptions = {},
): Promise<ReconciliationResult[]> {
  const orgsRes = await db.query(
    'SELECT id FROM app.organizations WHERE status = $1 ORDER BY id ASC',
    ['ACTIVE'],
  );
  const results: ReconciliationResult[] = [];

  for (const org of orgsRes.rows) {
    const orgId = org['id'] as string;
    const res = await reconcileTenantPermissions(db, orgId, options);
    results.push(res);
  }

  return results;
}
