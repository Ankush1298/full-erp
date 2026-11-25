import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { PERMISSION_CATALOG } from '../../src/shared/authorization/catalog.js';
import { ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { seedTenantRoles, seedMfaPermissions } from '../../src/shared/authorization/seed.js';
import {
  acquireDenialPolicyLock,
  clearTenantExplicitDenials,
  denialPolicyLockKey,
  executeTenantReconciliation,
  planTenantReconciliation,
  setTenantExplicitDenials,
} from '../../src/shared/authorization/reconcile.js';
import { adminQuery } from '../support/db-harness.js';
import { ORG_C } from '../support/fixtures.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

const adminUrl = inject('dbAdminUrl');

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
           LEFT JOIN app.role_permissions p ON p.organization_id = r.organization_id AND p.role_id = r.id WHERE r.organization_id = $1 AND r.code != 'PARENT'`,
      [ORG_C],
    );
    const actual: Record<string, Record<string, string>> = {};
    for (const g of got) {
      actual[g.code] ??= {};
      if (g.permission_code && g.scope_mode) actual[g.code]![g.permission_code] = g.scope_mode;
    }
    expect(actual).toEqual(ROLE_MATRIX);
  }, 60_000);

  it('reconciliation preserves custom grants by default, and removes them when purgeOrphanGrants is true', async () => {
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT organization_id, id, 'org.settings.read', 'GRANTED' FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'
       ON CONFLICT DO NOTHING`,
      [ORG_C],
    );

    // Default safe reconciliation preserves custom grant
    await seedTenantRoles(exec, ORG_C);
    const preserved = await adminQuery(
      `SELECT 1 FROM app.role_permissions p JOIN app.roles r ON r.id = p.role_id WHERE r.organization_id = $1 AND r.code = 'STAFF' AND p.permission_code = 'org.settings.read'`,
      [ORG_C],
    );
    expect(preserved).toHaveLength(1);

    // Explicit purge removes the grant that is no longer in the matrix
    await seedTenantRoles(exec, ORG_C, { purgeOrphanGrants: true });
    const left = await adminQuery(
      `SELECT 1 FROM app.role_permissions p JOIN app.roles r ON r.id = p.role_id WHERE r.organization_id = $1 AND r.code = 'STAFF' AND p.permission_code = 'org.settings.read'`,
      [ORG_C],
    );
    expect(left).toEqual([]);
  });

  it('reseeding preserves customized role names without version churn', async () => {
    // 1. Set a custom role name on CAMPUS_ADMIN
    await adminQuery(
      `UPDATE app.roles SET name = 'Principal / Director' WHERE organization_id = $1 AND code = 'CAMPUS_ADMIN'`,
      [ORG_C],
    );

    const versionBefore = (
      await adminQuery<{ version: number }>(
        `SELECT version FROM app.roles WHERE organization_id = $1 AND code = 'CAMPUS_ADMIN'`,
        [ORG_C],
      )
    )[0]!.version;

    // 2. Reseed without custom display titles (default titles equal code)
    await seedTenantRoles(exec, ORG_C);

    const roleAfter = (
      await adminQuery<{ name: string; version: number }>(
        `SELECT name, version FROM app.roles WHERE organization_id = $1 AND code = 'CAMPUS_ADMIN'`,
        [ORG_C],
      )
    )[0]!;

    expect(roleAfter.name).toBe('Principal / Director');
    expect(roleAfter.version).toBe(versionBefore);

    // 3. Reseed with identical custom display title - still no version churn
    await seedTenantRoles(exec, ORG_C, {
      roleDisplayTitles: { CAMPUS_ADMIN: 'Principal / Director' },
    });

    const roleAfterRerun = (
      await adminQuery<{ name: string; version: number }>(
        `SELECT name, version FROM app.roles WHERE organization_id = $1 AND code = 'CAMPUS_ADMIN'`,
        [ORG_C],
      )
    )[0]!;

    expect(roleAfterRerun.name).toBe('Principal / Director');
    expect(roleAfterRerun.version).toBe(versionBefore);

    // Clean up role name back to code
    await adminQuery(
      `UPDATE app.roles SET name = 'CAMPUS_ADMIN' WHERE organization_id = $1 AND code = 'CAMPUS_ADMIN'`,
      [ORG_C],
    );
  });

  it('seedTenantRoles skips critical permissions when allowCriticalGrants is false', async () => {
    // Create an isolated test org to test clean seeding without critical permissions
    const nonCriticalOrgId = '018f0000-0000-7000-8000-000000000077';
    await adminQuery(
      `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Non-Critical Org', 'non-crit-org', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [nonCriticalOrgId],
    );

    // Seed with allowCriticalGrants: false
    const result = await seedTenantRoles(exec, nonCriticalOrgId, {
      allowCriticalGrants: false,
    });

    expect(result.skippedCriticalCount).toBeGreaterThan(0);
    expect(result.plan.skippedCritical.some((s) => s.permissionCode === 'fee.gateway.manage')).toBe(
      true,
    );

    // Verify in database that critical permissions were NOT inserted
    const criticalRows = await adminQuery(
      `SELECT rp.permission_code FROM app.role_permissions rp
        WHERE rp.organization_id = $1
          AND rp.permission_code IN ('fee.gateway.manage', 'vault.authority.manage', 'user.account.suspend', 'user.account.reset_mfa')`,
      [nonCriticalOrgId],
    );
    expect(criticalRows).toEqual([]);

    // Normal non-critical permissions ARE seeded
    const normalRows = await adminQuery(
      `SELECT rp.permission_code FROM app.role_permissions rp
        WHERE rp.organization_id = $1 AND rp.permission_code = 'academic.program.read'`,
      [nonCriticalOrgId],
    );
    expect(normalRows.length).toBeGreaterThan(0);
  });

  it('seedTenantRoles respects explicit tenant denials in organization_settings', async () => {
    const deniedOrgId = '018f0000-0000-7000-8000-000000000088';
    const deniedUserId = '018f0000-0000-7000-8000-000000000089';
    await adminQuery(
      `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Denied Org', 'denied-org', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [deniedOrgId],
    );
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'admin@denied.test', 'hash', 'ACTIVE')
       ON CONFLICT (id) DO NOTHING`,
      [deniedUserId],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'admin@denied.test', 'Admin', 'ACTIVE', $1)
       ON CONFLICT (id) DO NOTHING`,
      [deniedUserId, deniedOrgId],
    );

    // Configure explicit denial for STUDENT role on adult.consent.manage
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [deniedOrgId, JSON.stringify({ STUDENT: ['adult.consent.manage'] }), deniedUserId],
    );

    // Seed tenant roles
    const result = await seedTenantRoles(exec, deniedOrgId);

    // Verify denial was captured in plan
    expect(
      result.plan.explicitDenials.some(
        (d) => d.roleCode === 'STUDENT' && d.permissionCode === 'adult.consent.manage',
      ),
    ).toBe(true);

    // Verify it was NOT inserted in database for STUDENT
    const deniedInDb = await adminQuery(
      `SELECT 1 FROM app.role_permissions rp
         JOIN app.roles r ON r.id = rp.role_id
        WHERE rp.organization_id = $1 AND r.code = 'STUDENT' AND rp.permission_code = 'adult.consent.manage'`,
      [deniedOrgId],
    );
    expect(deniedInDb).toEqual([]);
  });

  it('preserves custom scope modes by default, and resets canonical scopes when resetCanonicalScopes: true', async () => {
    // 1. Manually drift FACULTY student.profile.read from ASSIGNED to GRANTED
    await adminQuery(
      `UPDATE app.role_permissions rp SET scope_mode = 'GRANTED'
         FROM app.roles r
        WHERE r.id = rp.role_id AND rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'student.profile.read'`,
      [ORG_C],
    );

    // 2. Default seedTenantRoles preserves the drifted scope mode
    const defaultRes = await seedTenantRoles(exec, ORG_C);
    expect(defaultRes.appliedScopeChanges).toEqual([]);

    const preservedMode = (
      await adminQuery<{ scope_mode: string }>(
        `SELECT rp.scope_mode FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'student.profile.read'`,
        [ORG_C],
      )
    )[0]!.scope_mode;
    expect(preservedMode).toBe('GRANTED');

    // 3. Operator re-seed with resetCanonicalScopes: true resets back to canonical ASSIGNED
    const resetRes = await seedTenantRoles(exec, ORG_C, { resetCanonicalScopes: true });
    expect(resetRes.appliedScopeChanges).toContainEqual({
      roleCode: 'FACULTY',
      permissionCode: 'student.profile.read',
      oldScopeMode: 'GRANTED',
      newScopeMode: 'ASSIGNED',
    });

    const restoredMode = (
      await adminQuery<{ scope_mode: string }>(
        `SELECT rp.scope_mode FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'student.profile.read'`,
        [ORG_C],
      )
    )[0]!.scope_mode;
    expect(restoredMode).toBe('ASSIGNED');

    // 4. Repeat execution reports 0 applied changes
    const repeatRes = await seedTenantRoles(exec, ORG_C, { resetCanonicalScopes: true });
    expect(repeatRes.appliedScopeChanges).toEqual([]);
    expect(repeatRes.addedGrants).toEqual([]);
  });

  it('skips critical scope widening when allowCriticalGrants is false', async () => {
    // Manually narrow a CRITICAL permission on COLLEGE_ADMIN (e.g. fee.gateway.manage to ASSIGNED)
    await adminQuery(
      `UPDATE app.role_permissions rp SET scope_mode = 'ASSIGNED'
         FROM app.roles r
        WHERE r.id = rp.role_id AND rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
      [ORG_C],
    );

    // With allowCriticalGrants: false, widening to GRANTED must be skipped
    const res = await seedTenantRoles(exec, ORG_C, {
      resetCanonicalScopes: true,
      allowCriticalGrants: false,
    });

    expect(
      res.plan.skippedCritical.some(
        (s) => s.roleCode === 'COLLEGE_ADMIN' && s.permissionCode === 'fee.gateway.manage',
      ),
    ).toBe(true);

    const checkMode = (
      await adminQuery<{ scope_mode: string }>(
        `SELECT rp.scope_mode FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
        [ORG_C],
      )
    )[0]!.scope_mode;
    expect(checkMode).toBe('ASSIGNED');

    // Restore back with allowCriticalGrants: true
    await seedTenantRoles(exec, ORG_C, {
      resetCanonicalScopes: true,
      allowCriticalGrants: true,
    });
    const restored = (
      await adminQuery<{ scope_mode: string }>(
        `SELECT rp.scope_mode FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
        [ORG_C],
      )
    )[0]!.scope_mode;
    expect(restored).toBe('GRANTED');
  });

  describe('Strict fail-closed explicit-denial validation (Task 1)', () => {
    const corruptOrgId = '018f0000-0000-7000-8000-000000000078';
    const corruptUserId = '018f0000-0000-7000-8000-000000000079';

    const setDenialSetting = async (valJson: string) => {
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Corrupt Org', 'corrupt-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [corruptOrgId],
      );
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'admin@corrupt.test', 'hash', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [corruptUserId],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'admin@corrupt.test', 'Admin', 'ACTIVE', $1)
         ON CONFLICT (id) DO NOTHING`,
        [corruptUserId, corruptOrgId],
      );
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [corruptOrgId, valJson, corruptUserId],
      );
    };

    it('rejects root null value', async () => {
      await setDenialSetting('null');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /cannot be null or undefined/,
      );
    });

    it('rejects root boolean value', async () => {
      await setDenialSetting('true');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected object mapping role codes/,
      );
    });

    it('rejects root numeric value', async () => {
      await setDenialSetting('12345');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected object mapping role codes/,
      );
    });

    it('rejects root array value', async () => {
      await setDenialSetting('["student.profile.read"]');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected object mapping role codes/,
      );
    });

    it('rejects role entry with non-array permissions', async () => {
      await setDenialSetting('{"STUDENT": "student.profile.read"}');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected array of permission codes/,
      );
    });

    it('rejects malformed permission array entries (numeric, null, empty string)', async () => {
      await setDenialSetting('{"STUDENT": [123]}');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected non-empty string/,
      );

      await setDenialSetting('{"STUDENT": ["  "]}');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Expected non-empty string/,
      );
    });

    it('rejects prototype collision attempts (__proto__, constructor, prototype)', async () => {
      await setDenialSetting('{"__proto__": ["student.profile.read"]}');
      await expect(seedTenantRoles(exec, corruptOrgId)).rejects.toThrow(
        /Prototype property names are forbidden/,
      );
    });

    afterAll(async () => {
      await adminQuery('DELETE FROM app.role_permissions WHERE organization_id = $1', [
        corruptOrgId,
      ]);
      await adminQuery('DELETE FROM app.roles WHERE organization_id = $1', [corruptOrgId]);
      await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
        corruptOrgId,
      ]);
      await adminQuery('DELETE FROM app.users WHERE organization_id = $1', [corruptOrgId]);
      await adminQuery('DELETE FROM app.organizations WHERE id = $1', [corruptOrgId]);
    });
  });

  describe('Concurrent scope correction safety & stale plan protection (Task 2)', () => {
    it('atomic compare-and-update prevents stale plan from bypassing critical scope widening restriction', async () => {
      // 1. Ensure ORG_C is at canonical state with allowCriticalGrants: true
      await seedTenantRoles(exec, ORG_C, { allowCriticalGrants: true, resetCanonicalScopes: true });

      // 2. Compute plan while COLLEGE_ADMIN fee.gateway.manage is canonical GRANTED
      const { planTenantReconciliation, executeTenantReconciliation } =
        await import('../../src/shared/authorization/reconcile.js');
      const stalePlan = await planTenantReconciliation(exec, ORG_C, {
        allowCriticalGrants: false,
        resetCanonicalScopes: true,
      });

      // 3. Concurrently narrow fee.gateway.manage to SELF
      await adminQuery(
        `UPDATE app.role_permissions rp SET scope_mode = 'SELF'
           FROM app.roles r
          WHERE r.id = rp.role_id AND rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
        [ORG_C],
      );

      // 4. Concurrently change stalePlan to propose widening fee.gateway.manage to GRANTED
      stalePlan.proposedScopeChanges.push({
        roleCode: 'COLLEGE_ADMIN',
        permissionCode: 'fee.gateway.manage',
        currentScopeMode: 'ASSIGNED', // Stale observation claiming previous was ASSIGNED
        newScopeMode: 'GRANTED',
      });

      // 5. Execute stale plan with allowCriticalGrants: false
      const execResult = await executeTenantReconciliation(exec, stalePlan, {
        allowCriticalGrants: false,
        resetCanonicalScopes: true,
      });

      // 6. Must NOT apply the widening change: persisted scope remains locked at SELF
      expect(
        execResult.appliedScopeChanges.some(
          (c) => c.roleCode === 'COLLEGE_ADMIN' && c.permissionCode === 'fee.gateway.manage',
        ),
      ).toBe(false);

      const persisted = (
        await adminQuery<{ scope_mode: string }>(
          `SELECT rp.scope_mode FROM app.role_permissions rp
             JOIN app.roles r ON r.id = rp.role_id
            WHERE rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
          [ORG_C],
        )
      )[0]!.scope_mode;
      expect(persisted).toBe('SELF');

      // Cleanup: restore to GRANTED
      await adminQuery(
        `UPDATE app.role_permissions rp SET scope_mode = 'GRANTED'
           FROM app.roles r
          WHERE r.id = rp.role_id AND rp.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND rp.permission_code = 'fee.gateway.manage'`,
        [ORG_C],
      );
    });
  });

  describe('Dry-run & execution parity and accurate reporting (Tasks 5 & 6)', () => {
    it('dry-run accurately plans missing canonical roles without writing, and execution achieves parity', async () => {
      const partialOrgId = '018f0000-0000-7000-8000-000000000068';
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Partial Org', 'partial-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [partialOrgId],
      );

      // Create only STUDENT role in DB; missing 7 canonical roles
      await adminQuery(
        `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, 'STUDENT', 'STUDENT')
         ON CONFLICT (organization_id, code) DO NOTHING`,
        [uuidv7(), partialOrgId],
      );

      const { planTenantReconciliation } =
        await import('../../src/shared/authorization/reconcile.js');

      // 1. Dry run plan
      const plan = await planTenantReconciliation(exec, partialOrgId, {
        allowCriticalGrants: true,
      });

      // Must accurately detect missing roles
      expect(plan.proposedRoleChanges.length).toBe(7);
      expect(plan.proposedRoleChanges.map((r) => r.roleCode).sort()).toEqual(
        [
          'CAMPUS_ADMIN',
          'COLLEGE_ADMIN',
          'DEPARTMENT_ADMIN',
          'FACULTY',
          'HOD',
          'REGISTRAR',
          'STAFF',
        ].sort(),
      );

      // Must propose grants for missing roles
      expect(plan.proposedAdditions.some((p) => p.roleCode === 'CAMPUS_ADMIN')).toBe(true);

      // Dry run must perform ZERO writes
      const rolesCountBefore = await adminQuery<{ count: string }>(
        'SELECT count(*)::text as count FROM app.roles WHERE organization_id = $1',
        [partialOrgId],
      );
      expect(rolesCountBefore[0]!.count).toBe('1');

      // 2. Execute reconciliation
      const res = await seedTenantRoles(exec, partialOrgId, { allowCriticalGrants: true });
      expect(res.executed).toBe(true);
      expect(res.addedGrants.length).toBeGreaterThan(0);

      const rolesCountAfter = await adminQuery<{ count: string }>(
        'SELECT count(*)::text as count FROM app.roles WHERE organization_id = $1',
        [partialOrgId],
      );
      expect(rolesCountAfter[0]!.count).toBe('8');

      // 3. Repeat execution against unchanged institution reports zero mutations
      const repeatRes = await seedTenantRoles(exec, partialOrgId, { allowCriticalGrants: true });
      expect(repeatRes.addedGrants).toEqual([]);
      expect(repeatRes.appliedScopeChanges).toEqual([]);
      expect(repeatRes.purgedOrphanGrants).toEqual([]);
    });

    it('purged grants are never reported as preserved when purgeOrphanGrants is true', async () => {
      // Add custom grant to STAFF in ORG_C
      await adminQuery(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         SELECT organization_id, id, 'org.settings.read', 'GRANTED' FROM app.roles WHERE organization_id = $1 AND code = 'STAFF'
         ON CONFLICT DO NOTHING`,
        [ORG_C],
      );

      // Reconcile with purgeOrphanGrants: true
      const purgeRes = await seedTenantRoles(exec, ORG_C, { purgeOrphanGrants: true });
      expect(
        purgeRes.purgedOrphanGrants.some(
          (p) => p.roleCode === 'STAFF' && p.permissionCode === 'org.settings.read',
        ),
      ).toBe(true);

      // The purged grant must NOT appear in preservedCustomGrants
      expect(
        purgeRes.preservedCustomGrants.some(
          (p) => p.roleCode === 'STAFF' && p.permissionCode === 'org.settings.read',
        ),
      ).toBe(false);
    });
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
        'PARENT',
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

      // 2. Run seedMfaPermissions for this tenant with allowCriticalGrants: true
      const { seedMfaPermissions } = await import('../../src/shared/authorization/seed.js');
      await seedMfaPermissions(exec, testOrgId, { allowCriticalGrants: true });

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

      // Verify that PARENT also received auth.mfa.manage (SELF)
      const parentRole = (
        await adminQuery<{ id: string }>(
          `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'PARENT'`,
          [testOrgId],
        )
      )[0]!.id;
      const parentMfa = await adminQuery<{ permission_code: string; scope_mode: string }>(
        `SELECT permission_code, scope_mode FROM app.role_permissions
          WHERE organization_id = $1 AND role_id = $2 AND permission_code = 'auth.mfa.manage'`,
        [testOrgId, parentRole],
      );
      expect(parentMfa).toEqual([{ permission_code: 'auth.mfa.manage', scope_mode: 'SELF' }]);

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

    it('seedMfaPermissions respects allowCriticalGrants: false and explicit tenant denials', async () => {
      const { seedMfaPermissions } = await import('../../src/shared/authorization/seed.js');
      const mfaOrgId = '018f0000-0000-7000-8000-000000000066';
      const mfaUserId = '018f0000-0000-7000-8000-000000000067';
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'MFA Org', 'mfa-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [mfaOrgId],
      );
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'admin@mfa.test', 'hash', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [mfaUserId],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'admin@mfa.test', 'Admin', 'ACTIVE', $1)
         ON CONFLICT (id) DO NOTHING`,
        [mfaUserId, mfaOrgId],
      );

      // Create roles: CAMPUS_ADMIN, COLLEGE_ADMIN, PARENT
      for (const roleCode of ['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'PARENT']) {
        await adminQuery(
          `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, $3, $3)
           ON CONFLICT (organization_id, code) DO NOTHING`,
          [uuidv7(), mfaOrgId, roleCode],
        );
      }

      // Configure explicit denial: deny auth.mfa.manage on PARENT, and user.account.reset_mfa on COLLEGE_ADMIN
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [
          mfaOrgId,
          JSON.stringify({
            PARENT: ['auth.mfa.manage'],
            COLLEGE_ADMIN: ['user.account.reset_mfa'],
          }),
          mfaUserId,
        ],
      );

      // 1. Seed with allowCriticalGrants: false -> neither CAMPUS_ADMIN nor COLLEGE_ADMIN gets user.account.reset_mfa
      await seedMfaPermissions(exec, mfaOrgId, { allowCriticalGrants: false });

      const resets = await adminQuery(
        `SELECT r.code, rp.permission_code FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND rp.permission_code = 'user.account.reset_mfa'`,
        [mfaOrgId],
      );
      expect(resets).toEqual([]);

      // PARENT was explicitly denied auth.mfa.manage, so PARENT must NOT receive it
      const parentMfa = await adminQuery(
        `SELECT 1 FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'PARENT' AND rp.permission_code = 'auth.mfa.manage'`,
        [mfaOrgId],
      );
      expect(parentMfa).toEqual([]);

      // CAMPUS_ADMIN was not denied auth.mfa.manage, so it DOES receive it
      const campusAdminMfa = await adminQuery(
        `SELECT 1 FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'CAMPUS_ADMIN' AND rp.permission_code = 'auth.mfa.manage'`,
        [mfaOrgId],
      );
      expect(campusAdminMfa).toHaveLength(1);

      // 2. Now seed with allowCriticalGrants: true -> CAMPUS_ADMIN gets reset_mfa, but COLLEGE_ADMIN is denied
      await seedMfaPermissions(exec, mfaOrgId, { allowCriticalGrants: true });

      const resetsAllowed = await adminQuery<{ code: string }>(
        `SELECT r.code FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND rp.permission_code = 'user.account.reset_mfa'`,
        [mfaOrgId],
      );
      expect(resetsAllowed.map((r) => r.code)).toEqual(['CAMPUS_ADMIN']);
    });

    it('bulk seedMfaPermissions validates explicit denials, respects allowCritical: false, and fails closed on corrupt config', async () => {
      const { seedMfaPermissions } = await import('../../src/shared/authorization/seed.js');

      // 1. Bulk execution with allowCriticalGrants: false seeds auth.mfa.manage on ACTIVE tenants
      const bulkRes = await seedMfaPermissions(exec, undefined, { allowCriticalGrants: false });
      expect(
        bulkRes.addedMfaGrants.every((g) => g.permissionCode !== 'user.account.reset_mfa'),
      ).toBe(true);

      // Verify PARENT never receives user.account.reset_mfa under any circumstances
      const parentReset = await adminQuery(
        `SELECT 1 FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE r.code = 'PARENT' AND rp.permission_code = 'user.account.reset_mfa'`,
      );
      expect(parentReset).toEqual([]);

      // 2. Introduce corrupt settings row in an active tenant
      const badOrgId = '018f0000-0000-7000-8000-000000000055';
      const badUserId = '018f0000-0000-7000-8000-000000000056';
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Bad Tenant', 'bad-tenant', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [badOrgId],
      );
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'bad@mfa.test', 'hash', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [badUserId],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'bad@mfa.test', 'Bad', 'ACTIVE', $1)
         ON CONFLICT (id) DO NOTHING`,
        [badUserId, badOrgId],
      );
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, 'authorization.denied_permissions', '"corrupt-string"'::jsonb, $2)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [badOrgId, badUserId],
      );

      // Bulk execution must fail closed!
      await expect(
        seedMfaPermissions(exec, undefined, { allowCriticalGrants: true }),
      ).rejects.toThrow(/authorization\.denied_permissions/);

      // Cleanup bad tenant
      await adminQuery('DELETE FROM app.role_permissions WHERE organization_id = $1', [badOrgId]);
      await adminQuery('DELETE FROM app.roles WHERE organization_id = $1', [badOrgId]);
      await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
        badOrgId,
      ]);
      await adminQuery('DELETE FROM app.users WHERE organization_id = $1', [badOrgId]);
      await adminQuery('DELETE FROM app.organizations WHERE id = $1', [badOrgId]);
    });
  });

  describe('Denial-policy concurrency & synchronization (Task 1)', () => {
    const staleOrgId = '018f0000-0000-7000-8000-000000000091';
    const staleUserId = '018f0000-0000-7000-8000-000000000092';

    afterAll(async () => {
      await adminQuery('DELETE FROM app.role_permissions WHERE organization_id = $1', [staleOrgId]);
      await adminQuery('DELETE FROM app.roles WHERE organization_id = $1', [staleOrgId]);
      await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
        staleOrgId,
      ]);
      await adminQuery('DELETE FROM app.users WHERE organization_id = $1', [staleOrgId]);
      await adminQuery('DELETE FROM app.organizations WHERE id = $1', [staleOrgId]);
    });

    it('blocks stale plan additions when an explicit denial is introduced between planning and execution', async () => {
      // 1. Provision test tenant
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Stale Plan Org', 'stale-plan-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [staleOrgId],
      );
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, 'stale@test.com', 'hash', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [staleUserId],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, 'stale@test.com', 'Stale', 'ACTIVE', $1)
         ON CONFLICT (id) DO NOTHING`,
        [staleUserId, staleOrgId],
      );

      // Provision roles
      await seedTenantRoles(exec, staleOrgId, { allowCriticalGrants: true });

      // Delete student.profile.read from STUDENT
      await adminQuery(
        `DELETE FROM app.role_permissions rp
          USING app.roles r
         WHERE rp.role_id = r.id AND rp.organization_id = $1 AND r.code = 'STUDENT' AND rp.permission_code = 'student.profile.read'`,
        [staleOrgId],
      );

      // 2. Generate plan: student.profile.read is proposed for addition
      const plan = await planTenantReconciliation(exec, staleOrgId, { allowCriticalGrants: true });
      expect(
        plan.proposedAdditions.some(
          (a) => a.roleCode === 'STUDENT' && a.permissionCode === 'student.profile.read',
        ),
      ).toBe(true);

      // 3. Between planning and execution, a denial is introduced via setTenantExplicitDenials
      await setTenantExplicitDenials(
        exec,
        staleOrgId,
        { STUDENT: ['student.profile.read'] },
        staleUserId,
      );

      // 4. Execute stale plan
      const execResult = await executeTenantReconciliation(exec, plan, {
        allowCriticalGrants: true,
      });

      // 5. Must NOT add student.profile.read because current denial policy at execution time prohibited it
      expect(
        execResult.addedGrants.some(
          (g) => g.roleCode === 'STUDENT' && g.permissionCode === 'student.profile.read',
        ),
      ).toBe(false);
      expect(
        execResult.runtimeExplicitDenials?.some(
          (d) => d.roleCode === 'STUDENT' && d.permissionCode === 'student.profile.read',
        ),
      ).toBe(true);

      // Database verification: row was not inserted
      const inDb = await adminQuery(
        `SELECT 1 FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'STUDENT' AND rp.permission_code = 'student.profile.read'`,
        [staleOrgId],
      );
      expect(inDb).toEqual([]);
    });

    it('synchronization lock accounts for both initially absent and existing settings rows', async () => {
      const lockOrgId = '018f0000-0000-7000-8000-000000000093';
      // Advisory lock key is deterministic
      const key = denialPolicyLockKey(lockOrgId);
      expect(key).toBe(`app.authorization_denials:${lockOrgId}`);

      // acquireDenialPolicyLock succeeds when no settings row exists
      await expect(acquireDenialPolicyLock(exec, lockOrgId)).resolves.not.toThrow();

      // acquireDenialPolicyLock succeeds when settings row exists
      await setTenantExplicitDenials(exec, staleOrgId, { FACULTY: ['consent.read'] }, staleUserId);
      await expect(acquireDenialPolicyLock(exec, staleOrgId)).resolves.not.toThrow();

      // clearTenantExplicitDenials clears settings and acquires lock
      await clearTenantExplicitDenials(exec, staleOrgId);
      const afterClear = await adminQuery(
        `SELECT 1 FROM app.organization_settings WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
        [staleOrgId],
      );
      expect(afterClear).toEqual([]);
    });

    it('concurrent connection attempting to change denial settings is blocked while lock is held, works when absent vs present, and releases on commit/rollback', async () => {
      const lockOrgId = '018f0000-0000-7000-8000-000000000095';
      const lockUserId = '018f0000-0000-7000-8000-000000000096';
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status)
         VALUES ($1, 'Lock Org', 'lock-org-95', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [lockOrgId],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status)
         VALUES ($1, $2, 'lock-admin@test.local', 'Lock Admin', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [lockUserId, lockOrgId],
      );

      const conn1 = new pg.Client({ connectionString: adminUrl });
      const conn2 = new pg.Client({ connectionString: adminUrl });
      await conn1.connect();
      await conn2.connect();

      try {
        // CASE A: Settings row is ABSENT initially. Lock blocks concurrent writer until COMMIT.
        await conn1.query('BEGIN');
        await acquireDenialPolicyLock(conn1, lockOrgId);

        let conn2Finished = false;
        const p1 = setTenantExplicitDenials(
          conn2,
          lockOrgId,
          { STUDENT: ['attendance.read'] },
          lockUserId,
        ).then(() => {
          conn2Finished = true;
        });

        // Give conn2 time to attempt acquiring the lock and block
        await new Promise((r) => setTimeout(r, 120));
        expect(conn2Finished).toBe(false);

        // conn1 commits -> releases lock -> conn2 unblocks and completes
        await conn1.query('COMMIT');
        await p1;
        expect(conn2Finished).toBe(true);

        const check1 = await adminQuery<{ value: Record<string, string[]> }>(
          `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
          [lockOrgId],
        );
        expect(check1[0]?.value).toEqual({ STUDENT: ['attendance.read'] });

        // CASE B: Settings row is PRESENT. Lock blocks concurrent writer until ROLLBACK.
        await conn1.query('BEGIN');
        await acquireDenialPolicyLock(conn1, lockOrgId);

        let conn2FinishedCaseB = false;
        const p2 = setTenantExplicitDenials(
          conn2,
          lockOrgId,
          { FACULTY: ['grade.edit'] },
          lockUserId,
        ).then(() => {
          conn2FinishedCaseB = true;
        });

        await new Promise((r) => setTimeout(r, 120));
        expect(conn2FinishedCaseB).toBe(false);

        // conn1 rolls back -> releases lock -> conn2 unblocks and completes
        await conn1.query('ROLLBACK');
        await p2;
        expect(conn2FinishedCaseB).toBe(true);

        const check2 = await adminQuery<{ value: Record<string, string[]> }>(
          `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
          [lockOrgId],
        );
        expect(check2[0]?.value).toEqual({ FACULTY: ['grade.edit'] });
      } finally {
        await conn1.end().catch(() => {});
        await conn2.end().catch(() => {});
        await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
          lockOrgId,
        ]);
        await adminQuery('DELETE FROM app.users WHERE organization_id = $1', [lockOrgId]);
        await adminQuery('DELETE FROM app.organizations WHERE id = $1', [lockOrgId]);
      }
    });
  });

  describe('Eliminate duplicate role provisioning logic (Task 2)', () => {
    const singlePathOrgId = '018f0000-0000-7000-8000-000000000094';

    afterAll(async () => {
      await adminQuery('DELETE FROM app.role_permissions WHERE organization_id = $1', [
        singlePathOrgId,
      ]);
      await adminQuery('DELETE FROM app.roles WHERE organization_id = $1', [singlePathOrgId]);
      await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
        singlePathOrgId,
      ]);
      await adminQuery('DELETE FROM app.organizations WHERE id = $1', [singlePathOrgId]);
    });

    it('seedTenantRoles uses single authoritative path, predicts changes in dryRun, preserves custom role names and titles', async () => {
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'Single Path Org', 'single-path-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [singlePathOrgId],
      );

      // 1. Dry run: zero database writes, accurately predicts 8 role creations
      const dryResult = await seedTenantRoles(exec, singlePathOrgId, {
        dryRun: true,
        allowCriticalGrants: true,
        roleDisplayTitles: { STUDENT: 'Scholar', FACULTY: 'Professor' },
      });
      expect(dryResult.executed).toBe(false);
      expect(dryResult.createdRoles).toEqual([]);
      expect(dryResult.plan.proposedRoleChanges.length).toBe(8);
      expect(
        dryResult.plan.proposedRoleChanges.find((r) => r.roleCode === 'STUDENT')?.newName,
      ).toBe('Scholar');
      expect(
        dryResult.plan.proposedRoleChanges.find((r) => r.roleCode === 'FACULTY')?.newName,
      ).toBe('Professor');

      const countZero = await adminQuery<{ cnt: string }>(
        'SELECT count(*)::text as cnt FROM app.roles WHERE organization_id = $1',
        [singlePathOrgId],
      );
      expect(countZero[0]!.cnt).toBe('0');

      // 2. Execution creates roles and applies titles
      const execResult = await seedTenantRoles(exec, singlePathOrgId, {
        allowCriticalGrants: true,
        roleDisplayTitles: { STUDENT: 'Scholar', FACULTY: 'Professor' },
      });
      expect(execResult.executed).toBe(true);
      expect(execResult.createdRoles.length).toBe(8);
      expect(execResult.createdRoles.find((r) => r.roleCode === 'STUDENT')?.name).toBe('Scholar');
      expect(execResult.addedGrants.length).toBeGreaterThan(0);

      // 3. Customize a role name in DB
      await adminQuery(
        `UPDATE app.roles SET name = 'Distinguished Professor' WHERE organization_id = $1 AND code = 'FACULTY'`,
        [singlePathOrgId],
      );

      // 4. Reseed with default display title: customized name must be preserved!
      const reseedResult = await seedTenantRoles(exec, singlePathOrgId, {
        allowCriticalGrants: true,
        roleDisplayTitles: { FACULTY: 'Faculty Member' },
      });
      expect(reseedResult.createdRoles).toEqual([]);
      expect(reseedResult.updatedRoleNames).toEqual([]); // Did NOT overwrite custom name

      const facultyRow = await adminQuery<{ name: string }>(
        `SELECT name FROM app.roles WHERE organization_id = $1 AND code = 'FACULTY'`,
        [singlePathOrgId],
      );
      expect(facultyRow[0]!.name).toBe('Distinguished Professor');

      // 5. Repeated execution on unchanged state reports zero mutations
      const repeatResult = await seedTenantRoles(exec, singlePathOrgId, {
        allowCriticalGrants: true,
      });
      expect(repeatResult.createdRoles).toEqual([]);
      expect(repeatResult.updatedRoleNames).toEqual([]);
      expect(repeatResult.addedGrants).toEqual([]);
      expect(repeatResult.appliedScopeChanges).toEqual([]);
      expect(repeatResult.purgedOrphanGrants).toEqual([]);
    });
  });

  describe('MFA planning and execution parity (Task 3)', () => {
    const mfaParityOrgId = '018f0000-0000-7000-8000-000000000095';

    afterAll(async () => {
      await adminQuery('DELETE FROM app.role_permissions WHERE organization_id = $1', [
        mfaParityOrgId,
      ]);
      await adminQuery('DELETE FROM app.roles WHERE organization_id = $1', [mfaParityOrgId]);
      await adminQuery('DELETE FROM app.organization_settings WHERE organization_id = $1', [
        mfaParityOrgId,
      ]);
      await adminQuery('DELETE FROM app.organizations WHERE id = $1', [mfaParityOrgId]);
    });

    it('planTenantReconciliation has zero duplicate proposals and achieves dry-run parity for MFA', async () => {
      await adminQuery(
        `INSERT INTO app.organizations (id, name, slug, status) VALUES ($1, 'MFA Parity Org', 'mfa-parity-org', 'ACTIVE')
         ON CONFLICT (id) DO NOTHING`,
        [mfaParityOrgId],
      );

      // Create PARENT role in DB for this tenant
      await adminQuery(
        `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, 'PARENT', 'Parent / Guardian')
         ON CONFLICT (organization_id, code) DO NOTHING`,
        [uuidv7(), mfaParityOrgId],
      );

      // 1. Dry run planning
      const plan = await planTenantReconciliation(exec, mfaParityOrgId, {
        allowCriticalGrants: true,
      });

      // No duplicated proposals: each (roleCode, permissionCode) appears at most once in proposedAdditions
      const pairs = plan.proposedAdditions.map((a) => `${a.roleCode}:${a.permissionCode}`);
      expect(new Set(pairs).size).toBe(pairs.length);

      // proposedMfaAdditions matches the MFA subset of proposedAdditions
      expect(plan.proposedMfaAdditions.length).toBeGreaterThan(0);
      for (const mfa of plan.proposedMfaAdditions) {
        expect(['auth.mfa.manage', 'user.account.reset_mfa']).toContain(mfa.permissionCode);
      }

      // PARENT receives only auth.mfa.manage (SELF)
      const parentMfa = plan.proposedAdditions.filter((a) => (a.roleCode as string) === 'PARENT');
      expect(parentMfa).toEqual([
        {
          roleCode: 'PARENT',
          permissionCode: 'auth.mfa.manage',
          scopeMode: 'SELF',
          isCritical: false,
        },
      ]);

      // PARENT never receives user.account.reset_mfa
      expect(
        plan.proposedAdditions.some(
          (a) =>
            (a.roleCode as string) === 'PARENT' && a.permissionCode === 'user.account.reset_mfa',
        ),
      ).toBe(false);

      // 2. Execute reconciliation
      const res = await seedTenantRoles(exec, mfaParityOrgId, { allowCriticalGrants: true });
      expect(res.executed).toBe(true);

      // 3. Subsequent seedMfaPermissions on the same tenant reports zero additional grants
      const mfaRes = await seedMfaPermissions(exec, mfaParityOrgId, { allowCriticalGrants: true });
      expect(mfaRes.addedMfaGrants).toEqual([]);

      // 4. Repeated seedTenantRoles reports zero mutations
      const repeatRes = await seedTenantRoles(exec, mfaParityOrgId, { allowCriticalGrants: true });
      expect(repeatRes.addedGrants).toEqual([]);
    });
  });
});
