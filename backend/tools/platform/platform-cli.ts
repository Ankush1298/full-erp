import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  seedMfaPermissions,
  seedTenantRoles,
  type SqlExecutor,
} from '../../src/shared/authorization/seed.js';

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateTenantInput {
  name: string;
  slug: string;
  adminEmail?: string | undefined;
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  adminUserId?: string | undefined;
}

export function parseArgs(argv: readonly string[]): {
  command: string;
  flags: Record<string, string>;
} {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    throw new Error(
      'Usage: tsx tools/platform/cli.ts <tenant:create|tenant:seed|tenant:suspend|admin:invite|admin:invite-revoke|admin:mfa-ticket|staff:invite-link> [options]',
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

/**
 * Validates and provisions a new tenant organization with isolated role matrix.
 * Optionally provisions the initial College Administrator account in INVITED status.
 */
export async function createTenant(
  db: SqlExecutor,
  input: CreateTenantInput,
): Promise<TenantRecord> {
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

  // Check slug uniqueness
  const existing = await db.query('SELECT id FROM app.organizations WHERE slug = $1', [slug]);
  if (existing.rows.length > 0) {
    throw new Error(`An organization with slug "${slug}" already exists.`);
  }

  const tenantId = uuidv7();

  // 1. Insert organization
  await db.query(
    `INSERT INTO app.organizations (id, name, slug, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenantId, name, slug],
  );

  // 2. Seed system roles & permissions
  await seedTenantRoles(db, tenantId);
  await seedMfaPermissions(db, tenantId);

  let adminUserId: string | undefined;

  // 3. Provision initial College Admin if email provided
  if (adminEmail) {
    adminUserId = uuidv7();
    const displayName = `${name} Administrator`;

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

  return {
    id: tenantId,
    name,
    slug,
    status: 'ACTIVE',
    ...(adminUserId ? { adminUserId } : {}),
  };
}

/**
 * Re-syncs tenant roles and MFA permissions for an existing organization.
 */
export async function seedTenant(
  db: SqlExecutor,
  tenantIdentifier: string,
): Promise<{ id: string; name: string; slug: string }> {
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
  // One transaction (M3 doc 39, PR-3): seedTenantRoles deletes and re-inserts each role's grants, so in autocommit a
  // concurrent request could see a role without its grants, and a failure part-way left some roles re-synced and
  // others not. Now the re-sync is all or nothing. The caller passes a dedicated client (cli.ts), never a pooled one.
  await db.query('BEGIN');
  try {
    await seedTenantRoles(db, org.id);
    await seedMfaPermissions(db, org.id);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  return org;
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
 * Platform support grants are NOT implemented (doc 46 P0-3; doc 48). The earlier command signed a token with a fallback
 * key that nothing stored, audited or accepted, which looked like a control and was not one. It now fails closed: this
 * issues no token, reads nothing, and has no signing path. A real mechanism needs the designed platform realm (stored,
 * tenant-approved, time-boxed, audited grants; doc 05 and 06 §9) and its own owner-approved design.
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
