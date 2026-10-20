import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG } from '../../src/shared/authorization/catalog.js';
import { ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { seedTenantRoles } from '../../src/shared/authorization/seed.js';
import { adminQuery } from '../support/db-harness.js';
import { ORG_C } from '../support/fixtures.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

// ORG_C is the tenant reserved for tests that commit writes.
const exec = {
  query: async (text: string, values?: readonly unknown[]) => ({
    rows: await adminQuery(text, values ?? []),
  }),
};
const snapshot = async (): Promise<string> =>
  JSON.stringify(
    await adminQuery(
      `SELECT r.id, r.code, r.version, p.permission_code, p.scope_mode FROM app.roles r
         LEFT JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id
        WHERE r.organization_id = $1 ORDER BY r.code, p.permission_code`,
      [ORG_C],
    ),
  );

describe('permission seed', () => {
  it('platform.permissions equals the code catalog exactly', async () => {
    const rows = await adminQuery<{ code: string; sensitivity: string }>(
      'SELECT code, sensitivity FROM platform.permissions ORDER BY code',
    );
    expect(rows).toEqual(
      [...PERMISSION_CATALOG]
        .sort((a, b) => a.code.localeCompare(b.code, 'en'))
        .map((p) => ({ code: p.code, sensitivity: p.sensitivity })),
    );
  });

  it('the seeded fixtures equal ROLE_MATRIX and seeding is idempotent (same rows, same ids, no version churn)', async () => {
    await seedTenantRoles(exec, ORG_C);
    const first = await snapshot();
    await seedTenantRoles(exec, ORG_C);
    expect(await snapshot()).toBe(first);

    const got = await adminQuery<{
      code: string;
      permission_code: string | null;
      scope_mode: string | null;
    }>(
      `SELECT r.code, p.permission_code, p.scope_mode FROM app.roles r
           LEFT JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id WHERE r.organization_id = $1`,
      [ORG_C],
    );
    const actual: Record<string, Record<string, string>> = {};
    for (const g of got) {
      actual[g.code] ??= {};
      if (g.permission_code && g.scope_mode) actual[g.code]![g.permission_code] = g.scope_mode;
    }
    expect(actual).toEqual(ROLE_MATRIX);
  }, 60_000);

  it('re-seeding removes a grant that is no longer in the matrix', async () => {
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT organization_id, id, 'org.settings.read', 'GRANTED' FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'`,
      [ORG_C],
    );
    await seedTenantRoles(exec, ORG_C);
    const left = await adminQuery(
      `SELECT 1 FROM app.role_permissions p JOIN app.roles r ON r.id = p.role_id WHERE r.organization_id = $1 AND r.code = 'STAFF' AND p.permission_code = 'org.settings.read'`,
      [ORG_C],
    );
    expect(left).toEqual([]);
  });

  describe('MFA permission seeding (Issue 1)', () => {
    it('new tenants receive auth.mfa.manage on all roles and user.account.reset_mfa on administrative roles', async () => {
      await seedTenantRoles(exec, ORG_C);
      const rows = await adminQuery<{ code: string; permission_code: string; scope_mode: string }>(
        `SELECT r.code, p.permission_code, p.scope_mode FROM app.roles r
           JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id
          WHERE r.organization_id = $1 AND p.permission_code IN ('auth.mfa.manage', 'user.account.reset_mfa')
          ORDER BY r.code, p.permission_code`,
        [ORG_C],
      );

      // Every system role has auth.mfa.manage (SELF)
      const mfaManage = rows.filter((r) => r.permission_code === 'auth.mfa.manage');
      expect(mfaManage.map((r) => r.code).sort()).toEqual(
        [
          'CAMPUS_ADMIN',
          'COLLEGE_ADMIN',
          'DEPARTMENT_ADMIN',
          'FACULTY',
          'HOD',
          'REGISTRAR',
          'STAFF',
          'STUDENT',
        ].sort(),
      );
      for (const m of mfaManage) {
        expect(m.scope_mode).toBe('SELF');
      }

      // Only CAMPUS_ADMIN and COLLEGE_ADMIN have user.account.reset_mfa (GRANTED)
      const mfaReset = rows.filter((r) => r.permission_code === 'user.account.reset_mfa');
      expect(mfaReset.map((r) => r.code).sort()).toEqual(['CAMPUS_ADMIN', 'COLLEGE_ADMIN']);
      for (const m of mfaReset) {
        expect(m.scope_mode).toBe('GRANTED');
      }
    });

    it('existing tenants receive MFA permissions without deleting or modifying tenant-customized permissions', async () => {
      // 1. Create a simulated existing tenant with roles and custom permissions
      const testOrgId = '018f0000-0000-7000-8000-000000000099';
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Old Tenant', 'old-tenant', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [testOrgId],
      );

      // Create standard roles for this tenant
      for (const roleCode of [
        'STUDENT',
        'FACULTY',
        'STAFF',
        'HOD',
        'DEPARTMENT_ADMIN',
        'CAMPUS_ADMIN',
        'COLLEGE_ADMIN',
        'REGISTRAR',
      ]) {
        await adminQuery(
          `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, $3, $3)
           ON CONFLICT (organization_id, code) DO NOTHING`,
          [uuidv7(), testOrgId, roleCode],
        );
      }

      // Add a customized permission to STAFF (e.g. an extra permission grant that is NOT in the default role matrix)
      const staffRole = (
        await adminQuery<{ id: string }>(
          `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'`,
          [testOrgId],
        )
      )[0]!.id;

      await adminQuery(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         VALUES ($1, $2, 'org.settings.read', 'GRANTED')
         ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING`,
        [testOrgId, staffRole],
      );

      // 2. Run seedMfaPermissions for this tenant
      const { seedMfaPermissions } = await import('../../src/shared/authorization/seed.js');
      await seedMfaPermissions(exec, testOrgId);

      // Verify that the customized permission on STAFF was NOT deleted or overwritten
      const customGrant = await adminQuery<{ permission_code: string; scope_mode: string }>(
        `SELECT permission_code, scope_mode FROM app.role_permissions
          WHERE organization_id = $1 AND role_id = $2 AND permission_code = 'org.settings.read'`,
        [testOrgId, staffRole],
      );
      expect(customGrant).toEqual([
        { permission_code: 'org.settings.read', scope_mode: 'GRANTED' },
      ]);

      // Verify that STAFF also received auth.mfa.manage (SELF)
      const staffMfa = await adminQuery<{ permission_code: string; scope_mode: string }>(
        `SELECT permission_code, scope_mode FROM app.role_permissions
          WHERE organization_id = $1 AND role_id = $2 AND permission_code = 'auth.mfa.manage'`,
        [testOrgId, staffRole],
      );
      expect(staffMfa).toEqual([{ permission_code: 'auth.mfa.manage', scope_mode: 'SELF' }]);

      // Verify that COLLEGE_ADMIN received both auth.mfa.manage and user.account.reset_mfa
      const collegeAdminRole = (
        await adminQuery<{ id: string }>(
          `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'COLLEGE_ADMIN'`,
          [testOrgId],
        )
      )[0]!.id;
      const collegeAdminPerms = await adminQuery<{ permission_code: string; scope_mode: string }>(
        `SELECT permission_code, scope_mode FROM app.role_permissions
          WHERE organization_id = $1 AND role_id = $2 AND permission_code IN ('auth.mfa.manage', 'user.account.reset_mfa')
          ORDER BY permission_code`,
        [testOrgId, collegeAdminRole],
      );
      expect(collegeAdminPerms).toEqual([
        { permission_code: 'auth.mfa.manage', scope_mode: 'SELF' },
        { permission_code: 'user.account.reset_mfa', scope_mode: 'GRANTED' },
      ]);

      // 3. Repeated execution is completely idempotent
      const beforeSnapshot = JSON.stringify(
        await adminQuery(
          `SELECT role_id, permission_code, scope_mode FROM app.role_permissions
            WHERE organization_id = $1 ORDER BY role_id, permission_code`,
          [testOrgId],
        ),
      );
      await seedMfaPermissions(exec, testOrgId);
      const afterSnapshot = JSON.stringify(
        await adminQuery(
          `SELECT role_id, permission_code, scope_mode FROM app.role_permissions
            WHERE organization_id = $1 ORDER BY role_id, permission_code`,
          [testOrgId],
        ),
      );
      expect(afterSnapshot).toBe(beforeSnapshot);

      // 4. Least privilege invariant: unprivileged roles never receive user.account.reset_mfa
      const unprivilegedResetGrants = await adminQuery(
        `SELECT r.code, p.permission_code FROM app.roles r
           JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id
          WHERE r.organization_id = $1
            AND r.code NOT IN ('CAMPUS_ADMIN', 'COLLEGE_ADMIN')
            AND p.permission_code = 'user.account.reset_mfa'`,
        [testOrgId],
      );
      expect(unprivilegedResetGrants).toEqual([]);
    });
  });
});
