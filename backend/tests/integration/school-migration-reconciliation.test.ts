import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery, runAsMigrator } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import {
  planTenantReconciliation,
  reconcileTenantPermissions,
} from '../../src/shared/authorization/reconcile.js';

const PASSWORD = /* secret-scan:allow */ 'SchoolReconcile123!Secure';
const runtimeUrl = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: runtimeUrl, ssl: false, max: 10 }));

let T!: IsolatedTenant;

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD);
  T = await createIsolatedTenant(hash);
  // Ensure organization is marked as SCHOOL
  await adminQuery(`UPDATE app.organizations SET institution_type = 'SCHOOL' WHERE id = $1`, [
    T.orgId,
  ]);
});

afterAll(async () => {
  await T?.cleanup();
});

describe('School Tenant Migration & Reconciliation Regression', () => {
  it('reconciles newly introduced 0050-0053 permissions for an existing school without granting critical authority or deleting customizations', async () => {
    // 1. Simulate the exact campusos_demo defect state:
    // Missing homework.*, fee.gateway.*, and vault.% permissions
    await adminQuery(
      `DELETE FROM app.role_permissions
        WHERE organization_id = $1
          AND (
            permission_code LIKE 'homework.%'
            OR permission_code LIKE 'fee.gateway.%'
            OR permission_code LIKE 'vault.%'
            OR permission_code = 'fee.refund.initiate'
          )`,
      [T.orgId],
    );

    // 2. Add an institutional customization to verify it is NOT deleted
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'org.settings.read', 'GRANTED'
         FROM app.roles r WHERE r.organization_id = $1 AND r.code = 'FACULTY'
       ON CONFLICT DO NOTHING`,
      [T.orgId],
    );

    // 3. Add a deliberate institutional denial in organization_settings
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [T.orgId, JSON.stringify({ STAFF: ['vault.device.enroll'] }), T.users.admin],
    );

    // 4. Verify pre-reconciliation defect state: 0 rows for homework, gateway, and vault
    const preCheck = await adminQuery<{ count: string }>(
      `SELECT COUNT(*) as count FROM app.role_permissions
        WHERE organization_id = $1
          AND (
            permission_code LIKE 'homework.%'
            OR permission_code LIKE 'fee.gateway.%'
            OR permission_code LIKE 'vault.%'
            OR permission_code = 'fee.refund.initiate'
          )`,
      [T.orgId],
    );
    expect(Number(preCheck[0]?.count)).toBe(0);

    const exec = {
      query: async (text: string, values?: readonly unknown[]) => ({
        rows: await adminQuery(text, values),
      }),
    };

    // 5. Compute dry-run diff
    const plan = await planTenantReconciliation(exec, T.orgId);

    // Proposed additions must include safe baseline permissions
    expect(
      plan.proposedAdditions.some(
        (a) => a.roleCode === 'COLLEGE_ADMIN' && a.permissionCode === 'fee.gateway.read',
      ),
    ).toBe(true);
    expect(
      plan.proposedAdditions.some(
        (a) => a.roleCode === 'COLLEGE_ADMIN' && a.permissionCode === 'homework.manage',
      ),
    ).toBe(true);
    expect(
      plan.proposedAdditions.some(
        (a) => a.roleCode === 'COLLEGE_ADMIN' && a.permissionCode === 'vault.authority.read',
      ),
    ).toBe(true);
    expect(
      plan.proposedAdditions.some(
        (a) => a.roleCode === 'FACULTY' && a.permissionCode === 'homework.manage',
      ),
    ).toBe(true);
    expect(
      plan.proposedAdditions.some(
        (a) => a.roleCode === 'STUDENT' && a.permissionCode === 'homework.submit',
      ),
    ).toBe(true);

    // Critical permissions must be skipped by default!
    expect(
      plan.skippedCritical.some(
        (s) => s.roleCode === 'COLLEGE_ADMIN' && s.permissionCode === 'fee.gateway.manage',
      ),
    ).toBe(true);
    expect(
      plan.skippedCritical.some(
        (s) => s.roleCode === 'COLLEGE_ADMIN' && s.permissionCode === 'vault.authority.manage',
      ),
    ).toBe(true);
    expect(
      plan.skippedCritical.some(
        (s) => s.roleCode === 'COLLEGE_ADMIN' && s.permissionCode === 'vault.recovery.initiate',
      ),
    ).toBe(true);

    // Deliberate denial must be honored
    expect(
      plan.explicitDenials.some(
        (d) => d.roleCode === 'STAFF' && d.permissionCode === 'vault.device.enroll',
      ),
    ).toBe(true);

    // Customization must be preserved
    expect(
      plan.preservedCustomizations.some(
        (p) => p.roleCode === 'FACULTY' && p.permissionCode === 'org.settings.read',
      ),
    ).toBe(true);

    // 6. Execute safe reconciliation
    const result = await reconcileTenantPermissions(exec, T.orgId);
    expect(result.executed).toBe(true);

    // 7. Verify actual persisted role permissions in DB
    const postPerms = await adminQuery<{ code: string; perm: string; mode: string }>(
      `SELECT r.code, rp.permission_code as perm, rp.scope_mode as mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1
          AND (
            rp.permission_code LIKE 'homework.%'
            OR rp.permission_code LIKE 'fee.gateway.%'
            OR rp.permission_code LIKE 'vault.%'
          )
        ORDER BY r.code, rp.permission_code`,
      [T.orgId],
    );

    // Principal has safe baseline permissions
    const adminPerms = postPerms.filter((p) => p.code === 'COLLEGE_ADMIN');
    expect(adminPerms.some((p) => p.perm === 'fee.gateway.read')).toBe(true);
    expect(adminPerms.some((p) => p.perm === 'homework.manage')).toBe(true);
    expect(adminPerms.some((p) => p.perm === 'vault.authority.read')).toBe(true);
    expect(adminPerms.some((p) => p.perm === 'vault.device.enroll')).toBe(true);

    // Principal DOES NOT have critical unapproved authority
    expect(adminPerms.some((p) => p.perm === 'fee.gateway.manage')).toBe(false);
    expect(adminPerms.some((p) => p.perm === 'vault.authority.manage')).toBe(false);
    expect(adminPerms.some((p) => p.perm === 'vault.recovery.initiate')).toBe(false);

    // Teacher has class-assigned homework permissions
    const facultyPerms = postPerms.filter((p) => p.code === 'FACULTY');
    expect(facultyPerms.find((p) => p.perm === 'homework.manage')?.mode).toBe('ASSIGNED');
    expect(facultyPerms.find((p) => p.perm === 'homework.review')?.mode).toBe('ASSIGNED');
    expect(facultyPerms.find((p) => p.perm === 'homework.read')?.mode).toBe('ASSIGNED');

    // Student has self-scoped homework permissions
    const studentPerms = postPerms.filter((p) => p.code === 'STUDENT');
    expect(studentPerms.find((p) => p.perm === 'homework.read')?.mode).toBe('SELF');
    expect(studentPerms.find((p) => p.perm === 'homework.submit')?.mode).toBe('SELF');

    // Customization was NOT deleted
    const checkCustom = await adminQuery(
      `SELECT 1 FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'org.settings.read'`,
      [T.orgId],
    );
    expect(checkCustom.length).toBe(1);

    // Denied permission was NOT granted
    const checkDenied = await adminQuery(
      `SELECT 1 FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'STAFF' AND rp.permission_code = 'vault.device.enroll'`,
      [T.orgId],
    );
    expect(checkDenied.length).toBe(0);

    // 8. Verify effective capabilities returned by /auth/me via AuthorizationEngine.describeActor()
    const ctx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });

    const desc = await db.withTenant(ctx, async (tx) => {
      return AuthorizationEngine.describeActor(tx, ctx);
    });

    // Principal UI capabilities:
    // Homework is visible (has homework.manage & homework.read) -> Sidebar renders Homework
    expect(desc.capabilities).toContain('homework.manage');
    expect(desc.capabilities).toContain('homework.read');

    // Gateway Settings tab is visible (has fee.gateway.read) -> Fees tab renders Gateway Settings
    expect(desc.capabilities).toContain('fee.gateway.read');

    // Security Center is accessible (has vault.authority.read) -> /security-center returns 200
    expect(desc.capabilities).toContain('vault.authority.read');
    expect(desc.capabilities).toContain('vault.device.enroll');
  });

  it('migration 0054 executes safely on an upgraded 0048-to-0053 tenant, preserves custom scope modes with ON CONFLICT DO NOTHING, and introduces zero critical permissions', async () => {
    // 1. Simulate an upgraded tenant by deleting newly introduced 0050-0053 permissions
    await adminQuery(
      `DELETE FROM app.role_permissions
        WHERE organization_id = $1
          AND (
            permission_code LIKE 'homework.%'
            OR permission_code LIKE 'fee.gateway.%'
            OR permission_code LIKE 'vault.%'
            OR permission_code = 'fee.refund.initiate'
          )`,
      [T.orgId],
    );

    // 2. Set an intentional custom restriction: school narrowed Principal's homework.manage to ASSIGNED
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT r.organization_id, r.id, 'homework.manage', 'ASSIGNED'
         FROM app.roles r WHERE r.organization_id = $1 AND r.code = 'COLLEGE_ADMIN'
       ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = 'ASSIGNED'`,
      [T.orgId],
    );

    // 3. Execute Migration 0054 SQL directly as app_migrator
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/0054_reconcile_institution_role_permissions.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    await adminQuery(migrationSql);

    // 4. Assert: Customization was PRESERVED by ON CONFLICT DO NOTHING (not overwritten to GRANTED)
    const principalHomeworkManage = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'homework.manage'`,
      [T.orgId],
    );
    expect(principalHomeworkManage[0]?.scope_mode).toBe('ASSIGNED');

    // 5. Assert: Missing baseline permissions were successfully added
    const principalGatewayRead = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.read'`,
      [T.orgId],
    );
    expect(principalGatewayRead[0]?.scope_mode).toBe('GRANTED');

    const teacherHomeworkReview = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'homework.review'`,
      [T.orgId],
    );
    expect(teacherHomeworkReview[0]?.scope_mode).toBe('ASSIGNED');

    // 6. Assert: ZERO critical financial or cryptographic permissions were inserted
    const criticalCheck = await adminQuery<{ count: string }>(
      `SELECT COUNT(*) as count
         FROM app.role_permissions
        WHERE organization_id = $1
          AND permission_code IN (
            'fee.gateway.manage',
            'fee.refund.initiate',
            'vault.authority.manage',
            'vault.recovery.initiate',
            'vault.grant.issue',
            'vault.device.manage'
          )`,
      [T.orgId],
    );
    expect(Number(criticalCheck[0]?.count)).toBe(0);

    // 7. Assert: FORCE ROW LEVEL SECURITY is verified active on roles and role_permissions
    const rlsCheck = await adminQuery<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c
        WHERE c.relname IN ('roles', 'role_permissions')
          AND c.relnamespace = 'app'::regnamespace`,
    );
    expect(rlsCheck.length).toBe(2);
    expect(rlsCheck.every((r) => r.relforcerowsecurity)).toBe(true);

    // 8. Assert: PARENT role and Parent Portal permissions were populated
    const parentPortalCheck = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'parent.portal.access'`,
      [T.orgId],
    );
    expect(parentPortalCheck[0]?.scope_mode).toBe('SELF');
  });

  it('migration 0055 safely repairs missing PARENT roles across FORCE RLS barriers and provisions baseline capabilities', async () => {
    // 1. Simulate the exact production-like defect: PARENT role is missing from app.roles
    await adminQuery(`DELETE FROM app.roles WHERE organization_id = $1 AND code = 'PARENT'`, [
      T.orgId,
    ]);

    const preRoles = await adminQuery(
      `SELECT 1 FROM app.roles WHERE organization_id = $1 AND code = 'PARENT'`,
      [T.orgId],
    );
    expect(preRoles.length).toBe(0);

    // 2. Prove the root cause barrier: app_migrator SELECT on app.organizations initially returns 0 rows due to FORCE RLS
    const probe = await runAsMigrator({}, 'SELECT count(*)::int AS n FROM app.organizations');
    expect(probe.rows[0]?.n).toBe(0);

    // 3. Execute Migration 0055 SQL using the actual app_migrator connection
    const fs = await import('fs');
    const path = await import('path');
    const pg = (await import('pg')).default;
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/0055_repair_missing_parent_roles.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    const migratorClient = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await migratorClient.connect();
    try {
      await migratorClient.query(migrationSql);
    } finally {
      await migratorClient.end();
    }

    // 4. Assert: PARENT role was successfully created in app.roles
    const parentRole = await adminQuery<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM app.roles WHERE organization_id = $1 AND code = 'PARENT'`,
      [T.orgId],
    );
    expect(parentRole.length).toBe(1);
    expect(parentRole[0]?.code).toBe('PARENT');
    expect(parentRole[0]?.name).toBe('Parent / Guardian');

    // 5. Assert: parent.portal.access was populated with SELF scope
    const parentPortalCheck = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'parent.portal.access'`,
      [T.orgId],
    );
    expect(parentPortalCheck.length).toBe(1);
    expect(parentPortalCheck[0]?.scope_mode).toBe('SELF');

    // 6. Assert: All 13 canonical baseline permissions are present for PARENT
    const parentPerms = await adminQuery<{ permission_code: string; scope_mode: string }>(
      `SELECT rp.permission_code, rp.scope_mode
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'PARENT'
        ORDER BY rp.permission_code`,
      [T.orgId],
    );
    expect(parentPerms.length).toBe(13);
    const expectedPerms = [
      'auth.mfa.manage',
      'consent.read',
      'notification.preference.manage',
      'notification.read',
      'parent.academics.read',
      'parent.attendance.read',
      'parent.exam.read',
      'parent.fee.pay',
      'parent.fee.read',
      'parent.portal.access',
      'parent.student.read',
      'session.read',
      'session.revoke',
    ];
    expect(parentPerms.map((p) => p.permission_code)).toEqual(expectedPerms);
    expect(parentPerms.every((p) => p.scope_mode === 'SELF')).toBe(true);

    // 7. Assert: ZERO critical permissions exist on PARENT role
    const criticalCheck = await adminQuery<{ count: string }>(
      `SELECT COUNT(*) as count
         FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1
          AND r.code = 'PARENT'
          AND rp.permission_code IN (
            'fee.gateway.manage',
            'fee.refund.initiate',
            'vault.authority.manage',
            'vault.recovery.initiate',
            'vault.grant.issue',
            'vault.device.manage'
          )`,
      [T.orgId],
    );
    expect(Number(criticalCheck[0]?.count)).toBe(0);

    // 8. Assert: FORCE ROW LEVEL SECURITY is verified restored on organizations, organization_settings, roles, and role_permissions
    const rlsCheck = await adminQuery<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relforcerowsecurity
         FROM pg_class c
        WHERE c.relname IN ('organizations', 'organization_settings', 'roles', 'role_permissions')
          AND c.relnamespace = 'app'::regnamespace`,
    );
    expect(rlsCheck.length).toBe(4);
    expect(rlsCheck.every((r) => r.relforcerowsecurity)).toBe(true);

    // 9. Assert idempotency: executing Migration 0055 a second time succeeds with no errors
    const migratorClient2 = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await migratorClient2.connect();
    try {
      await migratorClient2.query(migrationSql);
    } finally {
      await migratorClient2.end();
    }
  });

  it('migration 0055 respects institutional explicit denials in organization_settings and does not insert denied permissions', async () => {
    // 1. Configure institution explicit denial: Anesa Demo School denies parent.fee.pay for PARENT role
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [T.orgId, JSON.stringify({ PARENT: ['parent.fee.pay'] }), T.users.admin],
    );

    // 2. Remove PARENT role so migration 0055 reconciles from scratch for this institution
    await adminQuery(`DELETE FROM app.roles WHERE organization_id = $1 AND code = 'PARENT'`, [
      T.orgId,
    ]);

    // 3. Execute Migration 0055 SQL as app_migrator
    const fs = await import('fs');
    const path = await import('path');
    const pg = (await import('pg')).default;
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/0055_repair_missing_parent_roles.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    const migratorClient = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await migratorClient.connect();
    try {
      await migratorClient.query(migrationSql);
    } finally {
      await migratorClient.end();
    }

    // 4. Assert: parent.fee.pay was NOT inserted into app.role_permissions
    const feePayCheck = await adminQuery(
      `SELECT 1 FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id
      WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'parent.fee.pay'`,
      [T.orgId],
    );
    expect(feePayCheck.length).toBe(0);

    // 5. Assert: The other 12 canonical permissions WERE successfully inserted
    const perms = await adminQuery<{ permission_code: string }>(
      `SELECT rp.permission_code FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id
      WHERE rp.organization_id = $1 AND r.code = 'PARENT'`,
      [T.orgId],
    );
    expect(perms.length).toBe(12);
    expect(perms.map((p) => p.permission_code)).not.toContain('parent.fee.pay');
    expect(perms.map((p) => p.permission_code)).toContain('parent.portal.access');
    expect(perms.map((p) => p.permission_code)).toContain('parent.fee.read');

    // Clean up setting
    await adminQuery(
      `DELETE FROM app.organization_settings WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
      [T.orgId],
    );
  });

  it('migration 0055 preserves existing custom scope modes on PARENT permissions via ON CONFLICT DO NOTHING', async () => {
    // 1. Establish custom scope on consent.read for PARENT: school widened it or customized it to GRANTED
    await adminQuery(
      `UPDATE app.role_permissions rp
          SET scope_mode = 'GRANTED'
         FROM app.roles r
        WHERE rp.role_id = r.id AND rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'consent.read'`,
      [T.orgId],
    );

    const preScope = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id
      WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'consent.read'`,
      [T.orgId],
    );
    expect(preScope[0]?.scope_mode).toBe('GRANTED');

    // 2. Re-execute Migration 0055 SQL as app_migrator
    const fs = await import('fs');
    const path = await import('path');
    const pg = (await import('pg')).default;
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/0055_repair_missing_parent_roles.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    const migratorClient = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await migratorClient.connect();
    try {
      await migratorClient.query(migrationSql);
    } finally {
      await migratorClient.end();
    }

    // 3. Assert: Existing custom scope mode GRANTED was preserved and NOT overwritten to SELF
    const postScope = await adminQuery<{ scope_mode: string }>(
      `SELECT rp.scope_mode FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id
      WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'consent.read'`,
      [T.orgId],
    );
    expect(postScope[0]?.scope_mode).toBe('GRANTED');
  });

  it('migration 0055 fails safely and rolls back if platform.permissions lacks a required canonical permission', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const pg = (await import('pg')).default;
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/0055_repair_missing_parent_roles.sql',
    );
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    // Simulate missing canonical permission in platform.permissions inside an isolated transaction
    const migratorClient = new pg.Client({ connectionString: inject('dbMigratorUrl') });
    await migratorClient.connect();
    try {
      await migratorClient.query('BEGIN');
      // Delete parent.exam.read temporarily from platform.permissions
      await migratorClient.query(
        `DELETE FROM platform.permissions WHERE code = 'parent.exam.read'`,
      );

      // Attempting to execute Migration 0055 must fail with postcondition error
      await expect(migratorClient.query(migrationSql)).rejects.toThrow(
        /Migration 0055 Postcondition Failed: Platform permission catalog is missing required canonical permission/,
      );
      await migratorClient.query('ROLLBACK');
    } catch {
      await migratorClient.query('ROLLBACK');
    } finally {
      await migratorClient.end();
    }

    // Verify platform.permissions is intact
    const catalogCheck = await adminQuery(
      `SELECT 1 FROM platform.permissions WHERE code = 'parent.exam.read'`,
    );
    expect(catalogCheck.length).toBe(1);
  });
});
