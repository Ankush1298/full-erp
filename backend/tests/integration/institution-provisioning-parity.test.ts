import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { createTenant } from '../../tools/platform/platform-cli.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  getInstitutionRoleMapping,
  INSTITUTION_DOMAIN_POLICIES,
} from '../../src/shared/institution/institution-roles.js';
import type { InstitutionType } from '../../src/shared/settings/institution.js';

const adminUrl = inject('dbAdminUrl');
const runtimeUrl = inject('dbRuntimeUrl');

let client: pg.Client;
let db: Database;

beforeAll(async () => {
  client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  db = new Database(createPool({ connectionString: runtimeUrl, ssl: false, max: 10 }));
});

afterAll(async () => {
  await client?.end().catch(() => undefined);
});

describe('ANESA Universal Institution Provisioning & Feature Parity', () => {
  const institutionTypes: InstitutionType[] = ['SCHOOL', 'COLLEGE', 'UNIVERSITY'];

  for (const instType of institutionTypes) {
    it(`provisions ${instType} with canonical role mapping, display titles, and executive scope`, async () => {
      const slug = `prov-${instType.toLowerCase()}-${Date.now().toString(36)}`;
      const name = `${instType} Test Institution`;
      const adminEmail = `admin@${slug}.test`;

      const tenant = await createTenant(client, {
        name,
        slug,
        adminEmail,
        institutionType: instType,
      });

      expect(tenant.id).toBeDefined();
      expect(tenant.status).toBe('ACTIVE');
      expect(tenant.institutionType).toBe(instType);
      expect(tenant.adminUserId).toBeDefined();

      // 1. Verify organization table stores correct institution_type
      const orgRes = await client.query<{ institution_type: string }>(
        "SELECT COALESCE(institution_type, 'SCHOOL') AS institution_type FROM app.organizations WHERE id = $1",
        [tenant.id],
      );
      expect(orgRes.rows[0]?.institution_type).toBe(instType);

      // 2. Verify roles table stores canonical display titles for this institution type
      const mapping = getInstitutionRoleMapping(instType, 'COLLEGE_ADMIN');
      const expectedTitle = mapping.displayTitle;

      const rolesRes = await client.query<{ code: string; name: string }>(
        "SELECT code, name FROM app.roles WHERE organization_id = $1 AND code = 'COLLEGE_ADMIN'",
        [tenant.id],
      );
      expect(rolesRes.rows.length).toBe(1);
      expect(rolesRes.rows[0]?.name).toBe(expectedTitle);

      // 3. Verify admin user was created with canonical display title in display_name
      const userRes = await client.query<{ display_name: string; status: string }>(
        'SELECT display_name, status FROM app.users WHERE id = $1 AND organization_id = $2',
        [tenant.adminUserId, tenant.id],
      );
      expect(userRes.rows[0]?.status).toBe('INVITED');
      expect(userRes.rows[0]?.display_name).toBe(`${name} ${expectedTitle}`);

      // 4. Verify role assignment: COLLEGE_ADMIN at ORGANIZATION scope
      const assignRes = await client.query<{ code: string; scope_type: string; status: string }>(
        `SELECT r.code, ra.scope_type, ra.status
           FROM app.role_assignments ra
           JOIN app.roles r ON r.id = ra.role_id AND r.organization_id = ra.organization_id
          WHERE ra.organization_id = $1 AND ra.user_id = $2`,
        [tenant.id, tenant.adminUserId],
      );
      expect(assignRes.rows.length).toBe(1);
      expect(assignRes.rows[0]?.code).toBe('COLLEGE_ADMIN');
      expect(assignRes.rows[0]?.scope_type).toBe('ORGANIZATION');
      expect(assignRes.rows[0]?.status).toBe('ACTIVE');

      // 5. Verify effective capabilities returned by AuthorizationEngine.describeActor()
      // Activate user so describeActor returns grants
      await client.query("UPDATE app.users SET status = 'ACTIVE' WHERE id = $1", [
        tenant.adminUserId,
      ]);

      const ctx = issueTrustedContext({
        tenantId: tenant.id,
        userId: tenant.adminUserId!,
        actorKind: 'STAFF',
      });

      const actorDesc = await db.withTenant(ctx, async (tx) => {
        return AuthorizationEngine.describeActor(tx, ctx);
      });

      expect(actorDesc.roleCodes).toContain('COLLEGE_ADMIN');

      // Verify executive capabilities across all core ERP domains are present
      expect(actorDesc.capabilities).toContain('fee.gateway.read');
      expect(actorDesc.capabilities).toContain('fee.gateway.manage');
      expect(actorDesc.capabilities).toContain('homework.manage');
      expect(actorDesc.capabilities).toContain('exam.manage');
      expect(actorDesc.capabilities).toContain('vault.authority.manage');
      expect(actorDesc.capabilities).toContain('attendance.record.correct');
      expect(actorDesc.capabilities).toContain('role.assignment.grant');
    });
  }

  it('provisions with custom adminTitle without granting extra security privileges', async () => {
    const slug = `custom-title-${Date.now().toString(36)}`;
    const name = 'Heritage Academy';
    const adminEmail = `headmaster@${slug}.test`;

    const tenant = await createTenant(client, {
      name,
      slug,
      adminEmail,
      institutionType: 'SCHOOL',
      adminTitle: 'Headmaster & Warden',
    });

    expect(tenant.adminTitle).toBe('Headmaster & Warden');

    // Display name reflects the custom title
    const userRes = await client.query<{ display_name: string }>(
      'SELECT display_name FROM app.users WHERE id = $1',
      [tenant.adminUserId],
    );
    expect(userRes.rows[0]?.display_name).toBe('Heritage Academy Headmaster & Warden');

    // Security privileges derive strictly from COLLEGE_ADMIN role assignment, not the title
    const assignRes = await client.query<{ code: string; scope_type: string }>(
      `SELECT r.code, ra.scope_type
         FROM app.role_assignments ra
         JOIN app.roles r ON r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2`,
      [tenant.id, tenant.adminUserId],
    );
    expect(assignRes.rows[0]?.code).toBe('COLLEGE_ADMIN');
    expect(assignRes.rows[0]?.scope_type).toBe('ORGANIZATION');
  });

  it('guarantees School Principal feature parity: school capabilities never vanish', () => {
    // Audit that all 10 ERP domains have explicit School policy decisions
    const domainKeys = Object.keys(INSTITUTION_DOMAIN_POLICIES);
    expect(domainKeys.length).toBeGreaterThanOrEqual(15);

    // Verify key school operations are covered
    const schoolPolicies = domainKeys.filter((k) => {
      const p = INSTITUTION_DOMAIN_POLICIES[k];
      return p && p.schoolRole.toLowerCase().includes('principal');
    });

    expect(schoolPolicies).toContain('fee.gateway.manage');
    expect(schoolPolicies).toContain('fee.refund.initiate');
    expect(schoolPolicies).toContain('vault.authority.manage');
    expect(schoolPolicies).toContain('vault.recovery.initiate');
    expect(schoolPolicies).toContain('result.publish');
    expect(schoolPolicies).toContain('role.assignment.grant');
  });
});
