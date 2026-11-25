import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  seedMfaPermissions,
  seedTenantRoles,
  type SqlExecutor,
} from '../../src/shared/authorization/seed.js';
import {
  planTenantReconciliation,
  type ReconciliationPlan,
  type ReconciliationResult,
} from '../../src/shared/authorization/reconcile.js';
import { getInstitutionRoleMapping } from '../../src/shared/institution/institution-roles.js';
import { roleLabelsFor, type InstitutionType } from '../../src/shared/settings/institution.js';

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail?: string | undefined;
  institutionType?: InstitutionType | undefined;
  adminTitle?: string | undefined;
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  institutionType: InstitutionType;
  adminUserId?: string | undefined;
  adminTitle?: string | undefined;
}

export function parseArgs(argv: readonly string[]): {
  command: string;
  flags: Record<string, string>;
} {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    throw new Error(
      'Usage: tsx tools/platform/cli.ts <tenant:create|tenant:seed|tenant:reconcile|tenant:suspend|admin:invite|admin:invite-revoke|admin:mfa-ticket|staff:invite-link> [options]',
    );
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }

  return { command, flags };
}

export interface CreateTenantOptions {
  /**
   * If true, wraps the provisioning sequence in an atomic transaction (BEGIN ... COMMIT / ROLLBACK).
   * Standalone CLI commands set this to true. Services managing their own outer transaction (e.g. withSystem) leave this false.
   */
  manageTransaction?: boolean;
}

/**
 * Validates and provisions a new tenant organization with canonical multi-tier role matrix.
 * Supports SCHOOL, COLLEGE, and UNIVERSITY institution types.
 *
 * Security Guarantee:
 * Displayed job titles (e.g. "Principal" or custom title) are purely descriptive metadata and
 * do NOT grant security privileges; authorization derives strictly from the assigned RoleCode
 * and scope (COLLEGE_ADMIN at ORGANIZATION scope for the initial top executive).
 */
export async function createTenant(
  db: SqlExecutor,
  input: CreateTenantInput,
  options?: CreateTenantOptions,
): Promise<TenantRecord> {
  const shouldManageTx = options?.manageTransaction === true;
  if (shouldManageTx) {
    await db.query('BEGIN');
  }

  try {
    const name = input.name?.trim();
    if (!name || name.length < 1 || name.length > 255) {
      throw new Error('Tenant name must be between 1 and 255 characters.');
    }

    const slug = input.slug?.trim().toLowerCase();
    if (!slug || !SLUG_REGEX.test(slug)) {
      throw new Error(
        'Tenant slug must consist of 3-63 lowercase alphanumeric characters or hyphens.',
      );
    }

    const adminEmail = input.adminEmail?.trim().toLowerCase();
    if (adminEmail && !EMAIL_REGEX.test(adminEmail)) {
      throw new Error('Invalid administrator email format.');
    }

    const rawType = input.institutionType ? input.institutionType.toUpperCase() : undefined;
    if (rawType && rawType !== 'SCHOOL' && rawType !== 'COLLEGE' && rawType !== 'UNIVERSITY') {
      throw new Error(
        `Invalid institution type: "${input.institutionType}". Allowed: SCHOOL, COLLEGE, UNIVERSITY.`,
      );
    }
    const institutionType: InstitutionType = (rawType as InstitutionType) || 'SCHOOL';

    // Check slug uniqueness
    const existing = await db.query('SELECT id FROM app.organizations WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      throw new Error(`An organization with slug "${slug}" already exists.`);
    }

    const tenantId = uuidv7();

    // 1. Insert organization (checking if institution_type column exists)
    let hasTypeCol: boolean;
    try {
      const colCheck = await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'organizations' AND column_name = 'institution_type'`,
      );
      hasTypeCol = colCheck.rows.length > 0;
    } catch {
      hasTypeCol = false;
    }

    if (hasTypeCol) {
      await db.query(
        `INSERT INTO app.organizations (id, name, slug, status, institution_type)
         VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [tenantId, name, slug, institutionType],
      );
    } else {
      await db.query(
        `INSERT INTO app.organizations (id, name, slug, status)
         VALUES ($1, $2, $3, 'ACTIVE')`,
        [tenantId, name, slug],
      );
    }

    // 2. Seed system roles & permissions with canonical display titles for institution type
    const roleDisplayTitles = institutionType ? roleLabelsFor(institutionType) : undefined;
    await seedTenantRoles(db, tenantId, { roleDisplayTitles, allowCriticalGrants: true });
    await seedMfaPermissions(db, tenantId, { allowCriticalGrants: true });

    let adminUserId: string | undefined;
    let finalAdminTitle: string | undefined;

    // 3. Provision initial administrator if email provided
    if (adminEmail) {
      adminUserId = uuidv7();
      if (input.adminTitle?.trim()) {
        finalAdminTitle = input.adminTitle.trim();
      } else if (input.institutionType) {
        const roleMapping = getInstitutionRoleMapping(institutionType, 'COLLEGE_ADMIN');
        finalAdminTitle = roleMapping.displayTitle;
      } else {
        finalAdminTitle = 'Administrator';
      }
      const displayName = `${name} ${finalAdminTitle}`;

      await db.query(
        `INSERT INTO app.users (id, organization_id, email, display_name, status)
         VALUES ($1, $2, $3, $4, 'INVITED')`,
        [adminUserId, tenantId, adminEmail, displayName],
      );

      const roleRes = await db.query(
        `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'COLLEGE_ADMIN'`,
        [tenantId],
      );
      const collegeAdminRoleId = roleRes.rows[0]?.['id'] as string | undefined;

      if (collegeAdminRoleId) {
        await db.query(
          `INSERT INTO app.role_assignments
             (id, organization_id, user_id, role_id, scope_type, scope_id, status)
           VALUES ($1, $2, $3, $4, 'ORGANIZATION', NULL, 'ACTIVE')`,
          [uuidv7(), tenantId, adminUserId, collegeAdminRoleId],
        );
      }
    }

    if (shouldManageTx) {
      await db.query('COMMIT');
    }

    return {
      id: tenantId,
      name,
      slug,
      status: 'ACTIVE',
      institutionType,
      ...(adminUserId ? { adminUserId } : {}),
      ...(finalAdminTitle ? { adminTitle: finalAdminTitle } : {}),
    };
  } catch (err) {
    if (shouldManageTx) {
      await db.query('ROLLBACK').catch(() => {});
    }
    throw err;
  }
}

export interface SeedTenantOptions {
  dryRun?: boolean;
  allowCritical?: boolean;
  purgeOrphanGrants?: boolean;
  resetCanonicalScopes?: boolean;
  /**
   * If false, does NOT issue BEGIN/COMMIT/ROLLBACK, leaving transaction ownership to the caller
   * (e.g. PlatformService running inside withSystem). Defaults to true when db is not already in an active transaction.
   */
  manageTransaction?: boolean;
}

export interface SeedTenantOutput {
  id: string;
  name: string;
  slug: string;
  dryRun?: boolean;
  plan?: ReconciliationPlan;
  reconciliation?: ReconciliationResult;
}

/**
 * Re-syncs or reconciles tenant roles and permissions for an existing organization.
 * Supports dry-run diffing and safe non-destructive reconciliation.
 */
export async function seedTenant(
  db: SqlExecutor,
  tenantIdentifier: string,
  options: SeedTenantOptions = {},
): Promise<SeedTenantOutput> {
  const ident = tenantIdentifier.trim();
  if (!ident) throw new Error('Tenant identifier (ID or slug) is required.');

  const res = await db.query(
    `SELECT id, name, slug FROM app.organizations WHERE id::text = $1 OR slug = $1`,
    [ident],
  );

  if (res.rows.length === 0) {
    throw new Error(`Organization "${ident}" not found.`);
  }

  const org = res.rows[0] as { id: string; name: string; slug: string };
  const allowCritical = options.allowCritical === true;
  const purgeOrphans = options.purgeOrphanGrants ?? false;
  // Operator CLI defaults to true to restore canonical scope drift
  const resetScopes = options.resetCanonicalScopes ?? true;

  if (options.dryRun) {
    const plan = await planTenantReconciliation(db, org.id, {
      allowCriticalGrants: allowCritical,
      purgeOrphanGrants: purgeOrphans,
      resetCanonicalScopes: resetScopes,
      preserveCustomizations: !purgeOrphans,
    });
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      dryRun: true,
      plan,
    };
  }

  // Transaction management: if caller manages tx (e.g. TenantTx or withSystem), do not issue nested BEGIN/COMMIT
  const clientWithTx = db as { getTransactionStatus?: () => string };
  const isManagedTx =
    typeof clientWithTx.getTransactionStatus === 'function'
      ? clientWithTx.getTransactionStatus() === 'T'
      : db.constructor.name === 'TenantTx';
  const shouldManageTx = options.manageTransaction ?? !isManagedTx;

  if (shouldManageTx) {
    await db.query('BEGIN');
  }
  try {
    const reconciliation = await seedTenantRoles(db, org.id, {
      allowCriticalGrants: allowCritical,
      preserveCustomizations: !purgeOrphans,
      purgeOrphanGrants: purgeOrphans,
      resetCanonicalScopes: resetScopes,
    });
    const mfaRes = await seedMfaPermissions(db, org.id, { allowCriticalGrants: allowCritical });
    for (const grant of mfaRes.addedMfaGrants) {
      const alreadyReported = reconciliation.addedGrants.some(
        (g) => g.roleCode === grant.roleCode && g.permissionCode === grant.permissionCode,
      );
      if (!alreadyReported) {
        reconciliation.addedGrants.push({
          roleCode: grant.roleCode,
          permissionCode: grant.permissionCode,
          scopeMode: grant.scopeMode,
        });
      }
    }
    if (shouldManageTx) {
      await db.query('COMMIT');
    }
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      reconciliation,
    };
  } catch (err) {
    if (shouldManageTx) {
      await db.query('ROLLBACK').catch(() => undefined);
    }
    throw err;
  }
}

export type AuthorityType = 'SECURITY_AUTHORITY' | 'FINANCIAL_GATEWAY_AUTHORITY';

export interface GrantAuthorityInput {
  tenant: string;
  authority: AuthorityType;
  roleCode?: string;
  approvedBy: string;
  justification: string;
}

export interface GrantAuthorityOutput {
  organizationId: string;
  name: string;
  authority: AuthorityType;
  roleCode: string;
  grantedPermissions: string[];
  approvedBy: string;
  justification: string;
}

export const AUTHORITY_PERMISSIONS: Record<AuthorityType, readonly string[]> = {
  SECURITY_AUTHORITY: [
    'vault.authority.manage',
    'vault.device.manage',
    'vault.recovery.initiate',
    'vault.grant.issue',
  ],
  FINANCIAL_GATEWAY_AUTHORITY: ['fee.gateway.manage', 'fee.refund.initiate'],
};

/**
 * Grants high-privilege institutional authority (e.g. Institutional Security Authority or
 * Financial Gateway Authority) to a specific role within an institution.
 * Requires mandatory --approved-by and --justification flags for auditability.
 */
export async function grantAuthority(
  db: SqlExecutor,
  input: GrantAuthorityInput,
): Promise<GrantAuthorityOutput> {
  const ident = input.tenant?.trim();
  if (!ident) throw new Error('Tenant identifier (ID or slug) is required.');
  if (!input.approvedBy?.trim())
    throw new Error('--approved-by is required for critical authority delegation.');
  if (!input.justification?.trim())
    throw new Error('--justification is required for critical authority delegation.');

  const roleCode = (input.roleCode || 'COLLEGE_ADMIN').trim().toUpperCase();
  const perms = AUTHORITY_PERMISSIONS[input.authority];
  if (!perms) {
    throw new Error(
      `Invalid authority type "${input.authority}". Must be SECURITY_AUTHORITY or FINANCIAL_GATEWAY_AUTHORITY.`,
    );
  }

  const orgRes = await db.query(
    `SELECT id, name, slug FROM app.organizations WHERE id::text = $1 OR slug = $1`,
    [ident],
  );
  if (orgRes.rows.length === 0) {
    throw new Error(`Organization "${ident}" not found.`);
  }
  const org = orgRes.rows[0] as { id: string; name: string; slug: string };

  const roleRes = await db.query(
    `SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2`,
    [org.id, roleCode],
  );
  if (roleRes.rows.length === 0) {
    throw new Error(`Role "${roleCode}" not found for organization "${org.name}".`);
  }
  const roleId = roleRes.rows[0]!['id'] as string;

  await db.query('BEGIN');
  try {
    for (const perm of perms) {
      await db.query(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         VALUES ($1, $2, $3, 'GRANTED')
         ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`,
        [org.id, roleId, perm],
      );
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  return {
    organizationId: org.id,
    name: org.name,
    authority: input.authority,
    roleCode,
    grantedPermissions: [...perms],
    approvedBy: input.approvedBy,
    justification: input.justification,
  };
}

/**
 * Suspends an organization, preventing future logins or operations.
 */
export async function suspendTenant(
  db: SqlExecutor,
  tenantIdentifier: string,
  _reason?: string,
): Promise<{ id: string; name: string; status: string }> {
  const ident = tenantIdentifier.trim();
  if (!ident) throw new Error('Tenant identifier (ID or slug) is required.');

  const res = await db.query(
    `UPDATE app.organizations
        SET status = 'SUSPENDED', updated_at = now()
      WHERE id::text = $1 OR slug = $1
      RETURNING id, name, status`,
    [ident],
  );

  if (res.rows.length === 0) {
    throw new Error(`Organization "${ident}" not found.`);
  }

  return res.rows[0] as { id: string; name: string; status: string };
}

/**
 * Platform support grants are NOT implemented (doc 46 P0-3; doc 48).
 */
export const SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE =
  'Platform support grants are not implemented. No support access token can be issued; use the documented privileged-access procedure (docs/runbooks/database-credential-separation.md) until a tenant-approved, audited grant mechanism exists.';

export class SupportGrantsNotImplementedError extends Error {
  constructor() {
    super(SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE);
    this.name = 'SupportGrantsNotImplementedError';
  }
}

export function createSupportGrant(): never {
  throw new SupportGrantsNotImplementedError();
}
