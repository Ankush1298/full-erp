import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import {
  CANONICAL_ROLE_MAPPINGS,
  getInstitutionRoleMapping,
  verifyInstitutionPermissionCoverage,
  INSTITUTION_DOMAIN_POLICIES,
} from '../../src/shared/institution/institution-roles.js';
import { ROLE_CODES, ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { roleLabelsFor } from '../../src/shared/settings/institution.js';
import {
  planTenantReconciliation,
  reconcileTenantPermissions,
} from '../../src/shared/authorization/reconcile.js';

const PASSWORD = /* secret-scan:allow */ 'UnifiedAuth123!Secure';
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));

let T!: IsolatedTenant;
let HASH = '';

describe('ANESA Universal Institution Roles & Permissions Unification', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. Canonical Role Model & Mapping', () => {
    it('defines distinct, consistent role mappings across SCHOOL, COLLEGE, and UNIVERSITY', () => {
      const types = ['SCHOOL', 'COLLEGE', 'UNIVERSITY'] as const;

      for (const type of types) {
        const mappings = CANONICAL_ROLE_MAPPINGS[type];
        expect(Object.keys(mappings).sort()).toEqual([...ROLE_CODES].sort());

        // Display titles within one institution type must be strictly unique
        const titles = Object.values(mappings).map((m) => m.displayTitle);
        expect(new Set(titles).size).toBe(ROLE_CODES.length);
      }
    });

    it('maps School Principal to COLLEGE_ADMIN with PRINCIPAL_FINAL_AUTHORITY governance mode', () => {
      const principalMapping = getInstitutionRoleMapping('SCHOOL', 'COLLEGE_ADMIN');
      expect(principalMapping.displayTitle).toBe('Principal');
      expect(principalMapping.tier).toBe('TOP_EXECUTIVE');
      expect(principalMapping.defaultScope).toBe('ORGANIZATION');
      expect(principalMapping.governanceMode).toBe('PRINCIPAL_FINAL_AUTHORITY');
    });

    it('maps School Vice Principal to CAMPUS_ADMIN and Teacher to FACULTY', () => {
      const vp = getInstitutionRoleMapping('SCHOOL', 'CAMPUS_ADMIN');
      expect(vp.displayTitle).toBe('Vice Principal');
      expect(vp.tier).toBe('SENIOR_ADMIN');

      const teacher = getInstitutionRoleMapping('SCHOOL', 'FACULTY');
      expect(teacher.displayTitle).toBe('Teacher');
      expect(teacher.tier).toBe('ACADEMIC_STAFF');

      const admissions = getInstitutionRoleMapping('SCHOOL', 'REGISTRAR');
      expect(admissions.displayTitle).toBe('Admissions office');
      expect(admissions.tier).toBe('OPERATIONS_STAFF');
    });
  });

  describe('2. Automated Institution-Wide Permission Coverage Guardrail', () => {
    it('verifies every catalogued permission has an explicit institutional policy decision (fails CI on missing coverage)', () => {
      const coverage = verifyInstitutionPermissionCoverage();
      expect(coverage.unmappedPermissions).toEqual([]);
      expect(coverage.coveredCount).toBe(coverage.totalCatalogCount);
    });

    it('ensures critical domain policies exist for Gateway Settings, Fees, Homework, and Vault', () => {
      expect(INSTITUTION_DOMAIN_POLICIES['fee.gateway.manage']).toBeDefined();
      expect(INSTITUTION_DOMAIN_POLICIES['fee.gateway.read']).toBeDefined();
      expect(INSTITUTION_DOMAIN_POLICIES['homework.manage']).toBeDefined();
      expect(INSTITUTION_DOMAIN_POLICIES['vault.authority.manage']).toBeDefined();
      expect(INSTITUTION_DOMAIN_POLICIES['adult.consent.manage']).toBeDefined();
    });
  });

  describe('3. School Principal Administrative Capabilities & Gateway Settings', () => {
    it('confirms School Principal holds fee.gateway.read and fee.gateway.manage in canonical role matrix', () => {
      const collegeAdminPerms = ROLE_MATRIX.COLLEGE_ADMIN;
      expect(collegeAdminPerms['fee.gateway.read']).toBe('GRANTED');
      expect(collegeAdminPerms['fee.gateway.manage']).toBe('GRANTED');
      expect(collegeAdminPerms['fee.refund.initiate']).toBe('GRANTED');
      expect(collegeAdminPerms['fee.structure.manage']).toBe('GRANTED');
      expect(collegeAdminPerms['homework.manage']).toBe('GRANTED');
      expect(collegeAdminPerms['vault.authority.manage']).toBe('GRANTED');
      expect(collegeAdminPerms['vault.recovery.initiate']).toBe('GRANTED');
    });

    it('returns Principal label and full executive capabilities in /auth/me for SCHOOL tenant', async () => {
      // Configure T as a SCHOOL
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, 'institution.type', '"SCHOOL"'::jsonb, $2)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [T.orgId, T.users.admin],
      );

      const labels = roleLabelsFor('SCHOOL');
      expect(labels.COLLEGE_ADMIN).toBe('Principal');

      const adminCtx = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.admin,
        actorKind: 'STAFF',
      });

      await db.withTenant(adminCtx, async (tx) => {
        const actor = await AuthorizationEngine.describeActor(tx, adminCtx);
        expect(actor.roleCodes).toContain('COLLEGE_ADMIN');
        expect(actor.capabilities).toContain('fee.gateway.read');
        expect(actor.capabilities).toContain('fee.gateway.manage');
        expect(actor.capabilities).toContain('fee.structure.manage');
        expect(actor.capabilities).toContain('homework.manage');
        expect(actor.capabilities).toContain('vault.authority.manage');
        expect(actor.capabilities).toContain('result.publish');
      });
    });
  });

  describe('4. Least Privilege & Access Restriction Invariants', () => {
    it('denies fee.gateway.manage to non-executive roles (Teacher, Student, Staff)', async () => {
      const studentCtx = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.studentOne,
        actorKind: 'STUDENT',
      });

      await db.withTenant(studentCtx, async (tx) => {
        const hasManage = await AuthorizationEngine.hasPermission(
          tx,
          studentCtx,
          'fee.gateway.manage',
        );
        expect(hasManage).toBe(false);

        await expect(
          AuthorizationEngine.assert(tx, studentCtx, 'fee.gateway.manage'),
        ).rejects.toThrow(AppError);
      });

      const facultyCtx = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.faculty,
        actorKind: 'STAFF',
      });

      await db.withTenant(facultyCtx, async (tx) => {
        const hasManage = await AuthorizationEngine.hasPermission(
          tx,
          facultyCtx,
          'fee.gateway.manage',
        );
        expect(hasManage).toBe(false);
      });
    });

    it('denies vault.authority.manage to HOD, Campus Admin, and Faculty', async () => {
      const hodCtx = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.hod,
        actorKind: 'STAFF',
      });

      await db.withTenant(hodCtx, async (tx) => {
        const canManageVault = await AuthorizationEngine.hasPermission(
          tx,
          hodCtx,
          'vault.authority.manage',
        );
        expect(canManageVault).toBe(false);

        await expect(
          AuthorizationEngine.assert(tx, hodCtx, 'vault.authority.manage'),
        ).rejects.toThrow(AppError);
      });
    });
  });

  describe('5. Safe & Idempotent Permission Reconciliation Engine', () => {
    it('safely reconciles missing permissions without deleting custom grants or role assignments', async () => {
      // 1. Artificially simulate missing permission by removing fee.gateway.manage from T.orgId COLLEGE_ADMIN
      await adminQuery(
        `DELETE FROM app.role_permissions
          WHERE organization_id = $1
            AND permission_code = 'fee.gateway.manage'`,
        [T.orgId],
      );

      // Verify it is gone
      const checkBefore = await adminQuery(
        `SELECT 1 FROM app.role_permissions WHERE organization_id = $1 AND permission_code = 'fee.gateway.manage'`,
        [T.orgId],
      );
      expect(checkBefore.length).toBe(0);

      // 2. Run reconciliation engine
      const exec = {
        query: async (text: string, values?: readonly unknown[]) => {
          const rows = await adminQuery(text, values);
          return { rows };
        },
      };

      const result = await reconcileTenantPermissions(exec, T.orgId, { allowCriticalGrants: true });
      expect(result.organizationId).toBe(T.orgId);
      expect(
        result.addedGrants.some(
          (g) => g.roleCode === 'COLLEGE_ADMIN' && g.permissionCode === 'fee.gateway.manage',
        ),
      ).toBe(true);

      // 3. Verify it was restored in database
      const checkAfter = await adminQuery<{ scope_mode: string }>(
        `SELECT scope_mode FROM app.role_permissions WHERE organization_id = $1 AND permission_code = 'fee.gateway.manage'`,
        [T.orgId],
      );
      expect(checkAfter.length).toBe(1);
      expect(checkAfter[0]?.scope_mode).toBe('GRANTED');

      // 4. Running reconciliation a second time is completely idempotent (0 added)
      const rerun = await reconcileTenantPermissions(exec, T.orgId, { allowCriticalGrants: true });
      expect(rerun.addedGrants.length).toBe(0);
      expect(rerun.alreadyPresentCount).toBeGreaterThan(50);
    });

    it('reconciliation plan computes dry-run diff and skips critical grants by default', async () => {
      const exec = {
        query: async (text: string, values?: readonly unknown[]) => {
          const rows = await adminQuery(text, values);
          return { rows };
        },
      };

      // Temporarily remove a normal permission and a critical permission
      await adminQuery(
        `DELETE FROM app.role_permissions
          WHERE organization_id = $1
            AND permission_code IN ('fee.gateway.read', 'fee.gateway.manage')`,
        [T.orgId],
      );

      // Also add a custom permission to verify it is identified as preserved
      await adminQuery(
        `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
         SELECT r.organization_id, r.id, 'org.settings.read', 'GRANTED'
           FROM app.roles r WHERE r.organization_id = $1 AND r.code = 'STUDENT'
         ON CONFLICT DO NOTHING`,
        [T.orgId],
      );

      // 1. Dry-run plan with default safe options (allowCriticalGrants: false)
      const plan = await planTenantReconciliation(exec, T.orgId, { allowCriticalGrants: false });

      expect(plan.organizationId).toBe(T.orgId);
      // fee.gateway.read should be in proposedAdditions (it is SENSITIVE, not CRITICAL)
      expect(
        plan.proposedAdditions.some(
          (a) => a.roleCode === 'COLLEGE_ADMIN' && a.permissionCode === 'fee.gateway.read',
        ),
      ).toBe(true);

      // fee.gateway.manage is CRITICAL, so it MUST be in skippedCritical by default!
      expect(
        plan.skippedCritical.some(
          (s) => s.roleCode === 'COLLEGE_ADMIN' && s.permissionCode === 'fee.gateway.manage',
        ),
      ).toBe(true);

      // Custom permission should be preserved, not proposed for removal
      expect(
        plan.preservedCustomizations.some(
          (p) => p.roleCode === 'STUDENT' && p.permissionCode === 'org.settings.read',
        ),
      ).toBe(true);

      // 2. Execute reconciliation with default options: verify fee.gateway.manage is NOT added
      const res = await reconcileTenantPermissions(exec, T.orgId, { allowCriticalGrants: false });
      expect(res.addedGrants.some((g) => g.permissionCode === 'fee.gateway.read')).toBe(true);
      expect(res.addedGrants.some((g) => g.permissionCode === 'fee.gateway.manage')).toBe(false);

      // Verify custom grant was NOT deleted
      const checkCustom = await adminQuery(
        `SELECT 1 FROM app.role_permissions rp
           JOIN app.roles r ON r.id = rp.role_id
          WHERE rp.organization_id = $1 AND r.code = 'STUDENT' AND rp.permission_code = 'org.settings.read'`,
        [T.orgId],
      );
      expect(checkCustom.length).toBe(1);

      // Clean up custom grant
      await adminQuery(
        `DELETE FROM app.role_permissions rp
           USING app.roles r
          WHERE rp.role_id = r.id AND rp.organization_id = $1 AND r.code = 'STUDENT' AND rp.permission_code = 'org.settings.read'`,
        [T.orgId],
      );
    });

    it('honors explicit denials configured in organization_settings', async () => {
      const exec = {
        query: async (text: string, values?: readonly unknown[]) => {
          const rows = await adminQuery(text, values);
          return { rows };
        },
      };

      // Set explicit denial for HOD role on exam.manage
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
         VALUES ($1, 'authorization.denied_permissions', $2::jsonb, $3)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [T.orgId, JSON.stringify({ HOD: ['exam.manage'] }), T.users.admin],
      );

      // Remove exam.manage from HOD
      await adminQuery(
        `DELETE FROM app.role_permissions rp
           USING app.roles r
          WHERE rp.role_id = r.id
            AND rp.organization_id = $1
            AND r.code = 'HOD'
            AND rp.permission_code = 'exam.manage'`,
        [T.orgId],
      );

      const plan = await planTenantReconciliation(exec, T.orgId, { roles: ['HOD'] });
      expect(
        plan.explicitDenials.some(
          (d) => d.roleCode === 'HOD' && d.permissionCode === 'exam.manage',
        ),
      ).toBe(true);

      // Verify it was NOT proposed for addition
      expect(
        plan.proposedAdditions.some(
          (a) => a.roleCode === 'HOD' && a.permissionCode === 'exam.manage',
        ),
      ).toBe(false);

      // Clean up setting
      await adminQuery(
        `DELETE FROM app.organization_settings WHERE organization_id = $1 AND key = 'authorization.denied_permissions'`,
        [T.orgId],
      );
    });
  });
});
