import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import {
  createSupportGrant,
  createTenant,
  seedTenant,
  suspendTenant,
} from '../../tools/platform/platform-cli.js';

const adminUrl = inject('dbAdminUrl');
let client: pg.Client;

beforeAll(async () => {
  client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
});

afterAll(async () => {
  await client?.end().catch(() => undefined);
});

describe('Platform CLI (Integration, ADR-002 & Doc 05/11)', () => {
  it('provisions a complete new tenant with role matrix and college admin user', async () => {
    const slug = `polytech-${Date.now().toString(36)}`;
    const adminEmail = `registrar@${slug}.test`;

    const tenant = await createTenant(client, {
      name: 'Polytechnic Institute',
      slug,
      adminEmail,
    });

    expect(tenant.id).toBeDefined();
    expect(tenant.name).toBe('Polytechnic Institute');
    expect(tenant.slug).toBe(slug);
    expect(tenant.status).toBe('ACTIVE');
    expect(tenant.adminUserId).toBeDefined();

    // 1. Verify organization in database
    const orgRes = await client.query<{ id: string; name: string; slug: string; status: string }>(
      'SELECT id, name, slug, status FROM app.organizations WHERE id = $1',
      [tenant.id],
    );
    expect(orgRes.rows.length).toBe(1);
    expect(orgRes.rows[0]!.name).toBe('Polytechnic Institute');
    expect(orgRes.rows[0]!.slug).toBe(slug);
    expect(orgRes.rows[0]!.status).toBe('ACTIVE');

    // 2. Verify roles were seeded
    const rolesRes = await client.query<{ code: string }>(
      'SELECT code FROM app.roles WHERE organization_id = $1 ORDER BY code',
      [tenant.id],
    );
    expect(rolesRes.rows.length).toBeGreaterThanOrEqual(8);
    const roleCodes = rolesRes.rows.map((r: { code: string }) => r.code);
    expect(roleCodes).toContain('COLLEGE_ADMIN');
    expect(roleCodes).toContain('STUDENT');
    expect(roleCodes).toContain('FACULTY');

    // 3. Verify admin user was created in INVITED status
    const userRes = await client.query<{ id: string; email: string; status: string }>(
      'SELECT id, email, status FROM app.users WHERE id = $1 AND organization_id = $2',
      [tenant.adminUserId, tenant.id],
    );
    expect(userRes.rows.length).toBe(1);
    expect(userRes.rows[0]!.email).toBe(adminEmail);
    expect(userRes.rows[0]!.status).toBe('INVITED');

    // 4. Verify COLLEGE_ADMIN role assignment was granted
    const assignRes = await client.query<{ status: string; scope_type: string; code: string }>(
      `SELECT ra.status, ra.scope_type, r.code
         FROM app.role_assignments ra
         JOIN app.roles r ON r.id = ra.role_id AND r.organization_id = ra.organization_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2`,
      [tenant.id, tenant.adminUserId],
    );
    expect(assignRes.rows.length).toBe(1);
    expect(assignRes.rows[0]!.code).toBe('COLLEGE_ADMIN');
    expect(assignRes.rows[0]!.scope_type).toBe('ORGANIZATION');
    expect(assignRes.rows[0]!.status).toBe('ACTIVE');
  });

  it('re-seeds tenant roles idempotently (tenant:seed)', async () => {
    const slug = `seedtest-${Date.now().toString(36)}`;
    const tenant = await createTenant(client, {
      name: 'Seed Test University',
      slug,
    });

    const beforeCount = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM app.role_permissions WHERE organization_id = $1',
      [tenant.id],
    );

    // Re-seed
    const seedResult = await seedTenant(client, slug);
    expect(seedResult.id).toBe(tenant.id);

    const afterCount = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM app.role_permissions WHERE organization_id = $1',
      [tenant.id],
    );

    // Idempotent: exact same count of permissions
    expect(afterCount.rows[0]!.count).toBe(beforeCount.rows[0]!.count);
  });

  it('suspends an organization (tenant:suspend)', async () => {
    const slug = `suspendtest-${Date.now().toString(36)}`;
    const tenant = await createTenant(client, {
      name: 'Suspension Test College',
      slug,
    });

    const suspended = await suspendTenant(client, tenant.id, 'Terms violation');
    expect(suspended.status).toBe('SUSPENDED');

    const checkRes = await client.query<{ status: string }>(
      'SELECT status FROM app.organizations WHERE id = $1',
      [tenant.id],
    );
    expect(checkRes.rows[0]!.status).toBe('SUSPENDED');
  });

  it('generates a time-bounded support grant token (support:grant)', async () => {
    const slug = `granttest-${Date.now().toString(36)}`;
    const tenant = await createTenant(client, {
      name: 'Support Grant College',
      slug,
    });

    const grant = await createSupportGrant(client, {
      tenant: slug,
      adminEmail: 'ops@smartcampus.test',
      durationHours: 6,
      signingSecret: 'test-signing-secret',
    });

    expect(grant.tenantId).toBe(tenant.id);
    expect(grant.adminEmail).toBe('ops@smartcampus.test');
    expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(grant.grantToken).toBeDefined();
  });
});
