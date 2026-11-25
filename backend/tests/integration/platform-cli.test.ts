import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  SupportGrantsNotImplementedError,
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

  // M3 doc 39 PR-3: what a re-seed changes, what it never touches, and that a failure part-way changes nothing.
  it('re-seed: resets hand-made grant drift, never touches role assignments, and is all or nothing', async () => {
    const slug = `reseed-${Date.now().toString(36)}`;
    const tenant = await createTenant(client, {
      name: 'Reseed Drift School',
      slug,
      adminEmail: `a@${slug}.test`,
    });
    const grants = async () =>
      (
        await client.query<{ role: string; perm: string; mode: string }>(
          `SELECT r.code AS role, rp.permission_code AS perm, rp.scope_mode AS mode
             FROM app.role_permissions rp JOIN app.roles r ON r.id = rp.role_id
            WHERE rp.organization_id = $1 ORDER BY 1, 2`,
          [tenant.id],
        )
      ).rows;
    const assignments = async () =>
      (
        await client.query<Record<string, unknown>>(
          `SELECT id, user_id, role_id, scope_type, scope_id, status, valid_from, valid_until
             FROM app.role_assignments WHERE organization_id = $1 ORDER BY id`,
          [tenant.id],
        )
      ).rows;
    const matrix = await grants();
    const assigned = await assignments();
    expect(assigned).toHaveLength(1);

    // Drift a privileged session could create: an extra grant and a changed scope mode.
    await client.query(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT $1::uuid, r.id, 'academic.term.manage', 'GRANTED' FROM app.roles r WHERE r.organization_id = $1::uuid AND r.code = 'HOD'`,
      [tenant.id],
    );
    await client.query(
      `UPDATE app.role_permissions rp SET scope_mode = 'GRANTED' FROM app.roles r
        WHERE r.id = rp.role_id AND rp.organization_id = $1 AND r.code = 'FACULTY' AND rp.permission_code = 'student.profile.read'`,
      [tenant.id],
    );
    const drifted = await grants();
    expect(drifted).not.toEqual(matrix);

    const rolesBefore = (
      await client.query<{ id: string; code: string; version: number }>(
        'SELECT id, code, version FROM app.roles WHERE organization_id = $1 ORDER BY code',
        [tenant.id],
      )
    ).rows;

    // A failure part-way (after a meaningful reconciliation mutation has executed) rolls the whole re-sync back: the drift is still there.
    let mutationExecuted = false;
    const failing = {
      query: async (text: string, values?: readonly unknown[]) => {
        if (
          text.includes('UPDATE app.role_permissions') ||
          text.includes('INSERT INTO app.role_permissions')
        ) {
          const res = await client.query(text, values as unknown[]);
          if (res.rowCount && res.rowCount > 0) {
            mutationExecuted = true;
          }
          return res;
        }
        if (mutationExecuted && text.includes('COMMIT')) {
          throw new Error('simulated failure');
        }
        return client.query(text, values as unknown[]);
      },
    };
    await expect(seedTenant(failing, slug)).rejects.toThrow('simulated failure');
    expect(mutationExecuted).toBe(true);
    expect(await grants()).toEqual(drifted);
    expect(await assignments()).toEqual(assigned);

    const rolesAfterRollback = (
      await client.query<{ id: string; code: string; version: number }>(
        'SELECT id, code, version FROM app.roles WHERE organization_id = $1 ORDER BY code',
        [tenant.id],
      )
    ).rows;
    expect(rolesAfterRollback).toEqual(rolesBefore);

    // Safe reconciliation preserves custom grants, resets scope mode drift, and leaves every assignment as it was.
    await seedTenant(client, slug);
    const postReconcile = await grants();
    expect(
      postReconcile.find(
        (g: { role: string; perm: string }) =>
          g.role === 'FACULTY' && g.perm === 'student.profile.read',
      )?.mode,
    ).toBe('ASSIGNED');
    expect(
      postReconcile.some(
        (g: { role: string; perm: string }) =>
          g.role === 'HOD' && g.perm === 'academic.term.manage',
      ),
    ).toBe(true);

    // When explicitly instructed to purge orphans, it restores exactly the canonical matrix
    await seedTenant(client, slug, { purgeOrphanGrants: true });
    expect(await grants()).toEqual(matrix);
    expect(await assignments()).toEqual(assigned);
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

  it('support:grant is gone: nothing is issued, stored or audited for a real tenant', async () => {
    const slug = `granttest-${Date.now().toString(36)}`;
    const tenant = await createTenant(client, { name: 'Support Grant College', slug });
    const before = await client.query(
      'SELECT count(*)::int AS n FROM app.audit_events WHERE organization_id = $1',
      [tenant.id],
    );
    expect(() => createSupportGrant()).toThrow(SupportGrantsNotImplementedError);
    const after = await client.query(
      'SELECT count(*)::int AS n FROM app.audit_events WHERE organization_id = $1',
      [tenant.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('standalone tenant provisioning rolls back after real database mutation followed by injected failure', async () => {
    const slug = `rollback-${Date.now().toString(36)}`;
    const adminEmail = `admin@${slug}.test`;

    let orgInserted = false;
    let rolesInserted = false;
    const failingDb = {
      query: async (text: string, values?: readonly unknown[]) => {
        if (text.includes('INSERT INTO app.organizations')) {
          const res = await client.query(text, values as unknown[]);
          orgInserted = true;
          return res;
        }
        if (
          text.includes('INSERT INTO app.roles') ||
          text.includes('INSERT INTO app.role_permissions')
        ) {
          const res = await client.query(text, values as unknown[]);
          rolesInserted = true;
          return res;
        }
        if (
          orgInserted &&
          (text.includes('INSERT INTO app.users') || text.includes('COLLEGE_ADMIN'))
        ) {
          throw new Error('injected failure during admin user provisioning');
        }
        return client.query(text, values as unknown[]);
      },
    };

    await expect(
      createTenant(
        failingDb,
        { name: 'Rollback College', slug, adminEmail },
        { manageTransaction: true },
      ),
    ).rejects.toThrow('injected failure during admin user provisioning');

    expect(orgInserted).toBe(true);
    expect(rolesInserted).toBe(true);

    // Verify database was completely rolled back: no organization, no roles
    const orgCheck = await client.query('SELECT id FROM app.organizations WHERE slug = $1', [slug]);
    expect(orgCheck.rows.length).toBe(0);

    const rolesCheck = await client.query(
      `SELECT r.id FROM app.roles r JOIN app.organizations o ON o.id = r.organization_id WHERE o.slug = $1`,
      [slug],
    );
    expect(rolesCheck.rows.length).toBe(0);
  });

  it('preserves existing externally managed transactions without premature commit or conflict', async () => {
    const slug = `tx-intact-${Date.now().toString(36)}`;
    const adminEmail = `admin@${slug}.test`;

    // Caller manages outer transaction
    await client.query('BEGIN');
    try {
      // createTenant without manageTransaction: true runs inside caller's transaction
      const tenant = await createTenant(client, {
        name: 'Tx Intact University',
        slug,
        adminEmail,
      });

      expect(tenant.id).toBeDefined();

      // Transaction is still active and uncommitted; insert a campus in the same transaction
      const campusId = uuidv7();
      await client.query(
        `INSERT INTO app.campuses (id, organization_id, name, code, status, timezone)
         VALUES ($1, $2, 'North Campus', 'NORTH', 'ACTIVE', 'Asia/Kolkata')`,
        [campusId, tenant.id],
      );

      // Successfully commit outer transaction
      await client.query('COMMIT');

      // Verify both tenant and subsequent transaction writes are committed
      const orgCheck = await client.query('SELECT id FROM app.organizations WHERE id = $1', [
        tenant.id,
      ]);
      expect(orgCheck.rows.length).toBe(1);

      const campusCheck = await client.query('SELECT id FROM app.campuses WHERE id = $1', [
        campusId,
      ]);
      expect(campusCheck.rows.length).toBe(1);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
});
