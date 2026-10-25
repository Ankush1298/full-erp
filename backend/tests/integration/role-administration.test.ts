import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Milestone 2 B2: role administration API (roles, user detail, a user's assignments, grant with expiry, expiry change,
// revoke, last-administrator protection). Everything commits, so it runs in PRIVATE tenants.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 12 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let HASH = '';
const extraTenants: IsolatedTenant[] = [];
let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Who = 'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'registrarOrg' | 'studentOne';
const sessions = {} as Record<Who, { cookie: string; csrf: string }>;
let ambient!: { cookie: string; csrf: string }; // the admin WITHOUT a step-up

async function login(
  email: string,
  o: { elevate: boolean } = { elevate: true },
): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  const cookie = await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value);
  if (o.elevate) await elevateSession(cookie); // PASSWORD_MFA, fresh: what CRITICAL routes require
  return { cookie, csrf: r.json<{ csrf_token: string }>().csrf_token };
}

beforeAll(async () => {
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(HASH);
  OTHER = await createIsolatedTenant(HASH);
  await app.ready();
  for (const w of [
    'admin',
    'campusAdmin',
    'hod',
    'faculty',
    'registrarOrg',
    'studentOne',
  ] as Who[]) {
    sessions[w] = await login(T.emails[w]);
  }
  ambient = await login(T.emails.admin, { elevate: false });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await T.cleanup();
  await OTHER.cleanup();
  for (const t of extraTenants) await t.cleanup();
});

type Sess = { cookie: string; csrf: string };

function http(
  method: 'GET' | 'POST' | 'PATCH',
  s: Sess | Who,
  path: string,
  payload?: InjectOptions['payload'],
  o: { ifMatch?: string } = {},
) {
  const sess = typeof s === 'string' ? sessions[s] : s;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { session_token: sess.cookie },
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': sess.csrf }),
      ...(o.ifMatch !== undefined ? { 'if-match': o.ifMatch } : {}),
    },
  });
}
const code = (r: { body: string }): string => r.body.match(/"code":"([A-Z_]+)"/)?.[1] ?? '';
const future = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

interface Account {
  id: string;
  email: string;
}
async function account(tenant: IsolatedTenant = T): Promise<Account> {
  const id = uuidv7();
  const email = `ra-${RUN}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, email, HASH],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [id, tenant.orgId, email, email],
  );
  return { id, email };
}
async function roleId(code: string, tenant: IsolatedTenant = T): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
    [tenant.orgId, code],
  );
  return rows[0]!.id;
}
/** A raw assignment (bypasses the service) for fixtures: scope columns kept consistent with the 0009 integrity check. */
async function rawAssign(
  userId: string,
  roleCode: string,
  o: {
    tenant?: IsolatedTenant;
    scopeType?: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
    scopeId?: string | null;
    validFrom?: string;
    validUntil?: string | null;
  } = {},
): Promise<string> {
  const tenant = o.tenant ?? T;
  const id = uuidv7();
  const scopeType = o.scopeType ?? 'ORGANIZATION';
  const scopeId = o.scopeId ?? null;
  await adminQuery(
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, valid_from, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10::timestamptz)`,
    [
      id,
      tenant.orgId,
      userId,
      await roleId(roleCode, tenant),
      scopeType,
      scopeId,
      scopeType === 'CAMPUS' ? scopeId : null,
      scopeType === 'DEPARTMENT' ? scopeId : null,
      o.validFrom ?? null,
      o.validUntil ?? null,
    ],
  );
  return id;
}
const roleAudit = (tenant: IsolatedTenant = T) =>
  adminQuery<{
    action: string;
    resource_id: string;
    changes: Record<string, { old: unknown; new: unknown }> | null;
    reason_text: string | null;
    risk_tier: number;
  }>(
    `SELECT action, resource_id, changes, reason_text, risk_tier FROM app.audit_events
      WHERE organization_id = $1 AND action LIKE 'role.assignment.%' ORDER BY occurred_at, id`,
    [tenant.orgId],
  );
const rowOf = async (id: string) =>
  (
    await adminQuery<{ status: string; valid_until: Date | null; version: number }>(
      'SELECT status, valid_until, version FROM app.role_assignments WHERE id = $1',
      [id],
    )
  )[0];
const effectiveAdmins = async (tenant: IsolatedTenant = T): Promise<number> =>
  (
    await adminQuery(
      `SELECT DISTINCT ra.user_id FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
         JOIN app.users u ON u.organization_id = ra.organization_id AND u.id = ra.user_id
        WHERE ra.organization_id = $1 AND r.code = 'COLLEGE_ADMIN' AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now()) AND u.status = 'ACTIVE'`,
      [tenant.orgId],
    )
  ).length;

describe('GET /roles', () => {
  it('lists the tenant roles with scope types, permission counts and the caller’s grant rule', async () => {
    const r = await http('GET', 'admin', '/api/v1/roles');
    expect(r.statusCode, r.body).toBe(200);
    const roles = r.json<{
      data: {
        id: string;
        code: string;
        allowedScopeTypes: string[];
        permissionCount: number;
        criticalPermissionCount: number;
        grantable: boolean;
      }[];
    }>().data;
    expect(roles.map((x) => x.code)).toEqual([
      'CAMPUS_ADMIN',
      'COLLEGE_ADMIN',
      'DEPARTMENT_ADMIN',
      'FACULTY',
      'HOD',
      'REGISTRAR',
      'STAFF',
      'STUDENT',
    ]);
    expect(roles.every((x) => x.grantable)).toBe(true); // COLLEGE_ADMIN may grant every role
    expect(roles.find((x) => x.code === 'HOD')!.allowedScopeTypes).toEqual(['DEPARTMENT']);
    expect(roles.find((x) => x.code === 'COLLEGE_ADMIN')!.criticalPermissionCount).toBeGreaterThan(
      0,
    );
    expect(roles.find((x) => x.code === 'STUDENT')!.criticalPermissionCount).toBeLessThan(
      roles.find((x) => x.code === 'COLLEGE_ADMIN')!.criticalPermissionCount,
    );
    // grantable is the CALLER's rule: a campus administrator may grant four roles only
    expect(JSON.stringify(Object.keys(roles[0]!).sort())).not.toMatch(/organization|tenant/i);
  });

  it('never offers a role outside the platform role model, and shows only this tenant’s roles', async () => {
    const rogue = uuidv7();
    await adminQuery(
      `INSERT INTO app.roles (id, organization_id, code, name) VALUES ($1, $2, 'PLATFORM_OPERATOR', 'Platform operator')`,
      [rogue, T.orgId],
    );
    const mine = await http('GET', 'admin', '/api/v1/roles');
    expect(mine.body).not.toContain('PLATFORM_OPERATOR');
    expect(mine.body).not.toContain(rogue);
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      cookies: { session_token: (await login(OTHER.emails.admin)).cookie },
    });
    const ids = new Set(theirs.json<{ data: { id: string }[] }>().data.map((x) => x.id));
    for (const row of mine.json<{ data: { id: string }[] }>().data)
      expect(ids.has(row.id)).toBe(false);
  });

  it('requires user.account.read at organization scope: faculty, HOD, students and anonymous callers are refused', async () => {
    for (const w of ['faculty', 'hod', 'studentOne'] as Who[]) {
      expect((await http('GET', w, '/api/v1/roles')).statusCode, w).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/roles' })).statusCode).toBe(401);
  });

  it('reading does not need a step-up (SENSITIVE, not CRITICAL)', async () => {
    expect((await http('GET', ambient, '/api/v1/roles')).statusCode).toBe(200);
  });
});

describe('GET /users/:id and GET /users/:id/role-assignments', () => {
  it('returns the account and its assignments with scope names and computed states', async () => {
    const u = await account();
    const live = await rawAssign(u.id, 'FACULTY');
    const campus = await rawAssign(u.id, 'STAFF', { scopeType: 'CAMPUS', scopeId: T.campusId });
    const expired = await rawAssign(u.id, 'REGISTRAR', {
      validFrom: new Date(Date.now() - 7_200_000).toISOString(),
      validUntil: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const revoked = await rawAssign(u.id, 'FACULTY', {
      scopeType: 'DEPARTMENT',
      scopeId: T.departmentId,
    });
    await adminQuery(`UPDATE app.role_assignments SET status = 'REVOKED' WHERE id = $1`, [revoked]);

    const user = await http('GET', 'admin', `/api/v1/users/${u.id}`);
    expect(user.statusCode, user.body).toBe(200);
    expect(user.json<{ data: { email: string; status: string } }>().data).toMatchObject({
      email: u.email,
      status: 'ACTIVE',
    });
    expect(user.headers['etag']).toMatch(/^"\d+"$/);
    expect(user.body).not.toMatch(/password|identity|token|organization/i);

    const list = await http('GET', 'admin', `/api/v1/users/${u.id}/role-assignments`);
    expect(list.statusCode, list.body).toBe(200);
    const byId = new Map(
      list
        .json<{
          data: { id: string; state: string; scopeName: string | null; roleCode: string }[];
        }>()
        .data.map((a) => [a.id, a]),
    );
    expect(byId.get(live)).toMatchObject({
      state: 'EFFECTIVE',
      roleCode: 'FACULTY',
      scopeName: null,
    });
    expect(byId.get(campus)).toMatchObject({ state: 'EFFECTIVE', scopeName: 'Isolated campus' });
    expect(byId.get(expired)).toMatchObject({ state: 'EXPIRED' });
    expect(byId.get(revoked)).toMatchObject({ state: 'REVOKED', scopeName: 'Isolated department' });
  });

  it('an unknown, malformed or other-tenant user is the same 404 / 400, never a disclosure', async () => {
    const foreign = await account(OTHER);
    for (const path of [
      `/api/v1/users/${foreign.id}`,
      `/api/v1/users/${foreign.id}/role-assignments`,
      `/api/v1/users/${uuidv7()}`,
    ]) {
      const r = await http('GET', 'admin', path);
      expect(r.statusCode, path).toBe(404);
      expect(r.body).not.toContain(foreign.email);
    }
    expect((await http('GET', 'admin', '/api/v1/users/not-a-uuid')).statusCode).toBe(400);
    for (const w of ['faculty', 'hod', 'studentOne'] as Who[]) {
      expect((await http('GET', w, `/api/v1/users/${T.users.faculty}`)).statusCode, w).toBe(403);
    }
  });
});

describe('grant with an expiry', () => {
  it('stores the end, audits it, lists it, and an expired assignment confers nothing (enforced by authorization)', async () => {
    const u = await account();
    const before = (await roleAudit()).length;
    const end = future(2);
    const r = await http('POST', 'admin', `/api/v1/users/${u.id}/role-assignments`, {
      roleId: await roleId('REGISTRAR'),
      scopeType: 'ORGANIZATION',
      reason: 'Temporary registrar cover',
      validUntil: end,
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ data: { id: string } }>().data.id;
    expect((await rowOf(id))!.valid_until!.toISOString()).toBe(end);
    const audit = (await roleAudit()).slice(before);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'role.assignment.grant',
      resource_id: id,
      risk_tier: 2,
    });
    expect(audit[0]!.changes!['valid_until']).toEqual({ old: null, new: end });

    // effective: the grantee passes an authorization check that REGISTRAR holds (user list)
    const s = await login(u.email);
    expect((await http('GET', s, '/api/v1/users')).statusCode).toBe(200);

    // the same user with ONLY an expired assignment is refused by the engine (the UI is not involved)
    const e = await account();
    await rawAssign(e.id, 'REGISTRAR', {
      validFrom: new Date(Date.now() - 7_200_000).toISOString(),
      validUntil: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const es = await login(e.email);
    expect((await http('GET', es, '/api/v1/users')).statusCode).toBe(403);
    // ...and it can be granted again: an expired row does not count as a duplicate
    const again = await http('POST', 'admin', `/api/v1/users/${e.id}/role-assignments`, {
      roleId: await roleId('REGISTRAR'),
      scopeType: 'ORGANIZATION',
      reason: 'Renewed registrar cover',
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('rejects malformed, past, ambiguous or out-of-range ends and an administrator expiry, writing nothing', async () => {
    const u = await account();
    const before = (await roleAudit()).length;
    const body = (validUntil: unknown, role = 'FACULTY') => ({
      roleId: undefined as unknown as string,
      scopeType: 'ORGANIZATION',
      reason: 'Expiry validation case',
      validUntil,
      role,
    });
    const bad: [string, unknown, string?][] = [
      ['past', new Date(Date.now() - 60_000).toISOString()],
      ['date only', '2030-06-30'],
      ['no offset', '2030-06-30T10:00:00'],
      ['text', 'tomorrow'],
      ['number', 20300630],
      ['null', null],
      ['year 2999', '2999-01-01T00:00:00Z'],
      ['impossible', '2030-02-30T10:00:00Z'],
      ['administrator', future(24), 'COLLEGE_ADMIN'],
    ];
    for (const [label, value, role] of bad) {
      const b = body(value, role);
      const r = await http('POST', 'admin', `/api/v1/users/${u.id}/role-assignments`, {
        roleId: await roleId(b.role),
        scopeType: 'ORGANIZATION',
        reason: b.reason,
        validUntil: value,
      });
      expect(r.statusCode, `${label}: ${r.body}`).toBe(400);
      expect(code(r), label).toBe('VALIDATION_ERROR');
    }
    expect((await roleAudit()).length).toBe(before);
    const rows = await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [u.id]);
    expect(rows).toHaveLength(0);
  });

  it('duplicates, student accounts and escalation attempts are refused', async () => {
    const u = await account();
    const faculty = await roleId('FACULTY');
    const grant = (who: Who | Sess, userId: string, role: string, extra: object = {}) =>
      roleId(role).then((rid) =>
        http('POST', who, `/api/v1/users/${userId}/role-assignments`, {
          roleId: rid,
          scopeType: 'ORGANIZATION',
          reason: 'Role administration test',
          ...extra,
        }),
      );
    expect((await grant('admin', u.id, 'FACULTY')).statusCode).toBe(201);
    const dup = await grant('admin', u.id, 'FACULTY');
    expect(dup.statusCode).toBe(409);
    expect(faculty).toBeTruthy();
    // a student account takes no staff role
    expect((await grant('admin', T.users.studentOne, 'STAFF')).statusCode).toBe(409);
    // no self-grant, and a campus administrator cannot mint an organization administrator
    expect((await grant('admin', T.users.admin, 'REGISTRAR')).statusCode).toBe(403);
    expect((await grant('campusAdmin', u.id, 'COLLEGE_ADMIN')).statusCode).toBe(403);
    // non-grantors
    for (const w of ['faculty', 'hod', 'registrarOrg', 'studentOne'] as Who[]) {
      expect((await grant(w, u.id, 'STAFF')).statusCode, w).toBe(403);
    }
  });
});

describe('PATCH /role-assignments/:id (change or clear the expiry)', () => {
  async function granted(role = 'FACULTY', validUntil?: string) {
    const u = await account();
    const r = await http('POST', 'admin', `/api/v1/users/${u.id}/role-assignments`, {
      roleId: await roleId(role),
      scopeType: 'ORGANIZATION',
      reason: 'Fixture grant for expiry tests',
      ...(validUntil ? { validUntil } : {}),
    });
    expect(r.statusCode, r.body).toBe(201);
    return { user: u, id: r.json<{ data: { id: string } }>().data.id };
  }
  const patch = (id: string, body: object, version: number | string, who: Who | Sess = 'admin') =>
    http('PATCH', who, `/api/v1/role-assignments/${id}`, body, { ifMatch: `"${version}"` });

  it('changes the end with If-Match, bumps the version, audits old and new, and clears it with null', async () => {
    const { id } = await granted('FACULTY', future(2));
    const first = (await rowOf(id))!;
    const a = future(48);
    const r = await patch(id, { validUntil: a, reason: 'Extend by agreement' }, first.version);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ data: { validUntil: string; version: number } }>().data).toMatchObject({
      validUntil: a,
      version: first.version + 1,
    });
    expect(r.headers['etag']).toBe(`"${first.version + 1}"`);
    const audit = (await roleAudit()).filter(
      (x) => x.resource_id === id && x.action === 'role.assignment.update_expiry',
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason_text: 'Extend by agreement', risk_tier: 2 });
    expect(audit[0]!.changes!['valid_until']!.new).toBe(a);

    const cleared = await patch(
      id,
      { validUntil: null, reason: 'Make permanent' },
      first.version + 1,
    );
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await rowOf(id))!.valid_until).toBeNull();
  });

  it('is concurrency-safe and idempotent: stale or missing version, and an unchanged value, write nothing', async () => {
    const { id } = await granted('FACULTY', future(2));
    const v = (await rowOf(id))!.version;
    const auditBefore = (await roleAudit()).length;
    expect(
      (await patch(id, { validUntil: future(5), reason: 'Stale version case' }, v + 7)).statusCode,
    ).toBe(409);
    expect(
      (
        await http('PATCH', 'admin', `/api/v1/role-assignments/${id}`, {
          validUntil: future(5),
          reason: 'No header case',
        })
      ).statusCode,
    ).toBe(428);
    expect(
      (
        await patch(
          id,
          { validUntil: future(5), reason: 'Weak validator' },
          `W/${v}`.replace(/^/, ''),
        )
      ).statusCode,
    ).toBe(400);
    // an unchanged end is a no-op: same version, no audit
    const same = (await rowOf(id))!.valid_until!.toISOString();
    const noop = await patch(id, { validUntil: same, reason: 'Unchanged value' }, v);
    expect(noop.statusCode).toBe(200);
    expect((await rowOf(id))!.version).toBe(v);
    expect((await roleAudit()).length).toBe(auditBefore);
    // two concurrent changes with the same version: exactly one wins
    const race = await Promise.all([
      patch(id, { validUntil: future(10), reason: 'Concurrent one' }, v),
      patch(id, { validUntil: future(11), reason: 'Concurrent two' }, v),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('refuses expired, revoked and administrator assignments, bad values, self and foreign targets', async () => {
    const auditBefore = (await roleAudit()).length;
    const u = await account();
    const expired = await rawAssign(u.id, 'STAFF', {
      validFrom: new Date(Date.now() - 7_200_000).toISOString(),
      validUntil: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const ev = (await rowOf(expired))!.version;
    const e = await patch(expired, { validUntil: future(5), reason: 'Try to revive' }, ev);
    expect(e.statusCode).toBe(409);
    expect(code(e)).toBe('ASSIGNMENT_NOT_EFFECTIVE');

    const { id: live } = await granted('FACULTY', future(3));
    const lv = (await rowOf(live))!.version;
    for (const value of [new Date(Date.now() - 60_000).toISOString(), '2030-01-01', 5, 'soon']) {
      const r = await patch(live, { validUntil: value, reason: 'Bad value case' }, lv);
      expect(r.statusCode, String(value)).toBe(400);
    }
    expect((await patch(live, { reason: 'Missing value case' }, lv)).statusCode).toBe(400);

    // an administrator assignment never takes an end
    const admin2 = await account();
    const adminRow = await rawAssign(admin2.id, 'COLLEGE_ADMIN');
    const av = (await rowOf(adminRow))!.version;
    expect(
      (await patch(adminRow, { validUntil: future(5), reason: 'Admin expiry case' }, av))
        .statusCode,
    ).toBe(400);

    // never on yourself
    const mine = await adminQuery<{ id: string; version: number }>(
      `SELECT ra.id, ra.version FROM app.role_assignments ra WHERE ra.user_id = $1 AND ra.status = 'ACTIVE'`,
      [T.users.admin],
    );
    expect(
      (await patch(mine[0]!.id, { validUntil: null, reason: 'Self case here' }, mine[0]!.version))
        .statusCode,
    ).toBe(403);

    // another tenant's assignment, an unknown id and a revoked row are the same 404
    const foreign = await rawAssign((await account(OTHER)).id, 'STAFF', { tenant: OTHER });
    const rv = await http('POST', 'admin', `/api/v1/role-assignments/${live}/revoke`, {
      reason: 'Revoke for the test',
    });
    expect(rv.statusCode).toBe(200);
    for (const target of [foreign, uuidv7(), live]) {
      expect(
        (await patch(target, { validUntil: null, reason: 'Not reachable case' }, 1)).statusCode,
        target,
      ).toBe(404);
    }
    // only the successful revoke and the earlier grants were audited: no failed attempt wrote an expiry event
    const expiryEvents = (await roleAudit())
      .slice(auditBefore)
      .filter((x) => x.action === 'role.assignment.update_expiry');
    expect(expiryEvents).toHaveLength(0);
  });

  it('requires role.assignment.grant and a fresh PASSWORD_MFA step-up', async () => {
    const { id } = await granted('FACULTY');
    const v = (await rowOf(id))!.version;
    const noStepUp = await patch(
      id,
      { validUntil: future(5), reason: 'Ambient session case' },
      v,
      ambient,
    );
    expect(noStepUp.statusCode).toBe(403);
    expect(code(noStepUp)).toBe('STEP_UP_REQUIRED');
    for (const w of ['faculty', 'hod', 'registrarOrg', 'studentOne'] as Who[]) {
      expect(
        (await patch(id, { validUntil: future(5), reason: 'Not a grantor' }, v, w)).statusCode,
        w,
      ).toBe(403);
    }
    expect((await rowOf(id))!.version).toBe(v);
  });

  it('a campus administrator may change only what its own scope and rules allow (scope containment is exact-match)', async () => {
    const u = await account();
    // a STAFF assignment at the administrator's own campus: allowed (STAFF is in its grant rule, the scope is its own)
    const mine = await rawAssign(u.id, 'STAFF', { scopeType: 'CAMPUS', scopeId: T.campusId });
    const mv = (await rowOf(mine))!.version;
    expect(
      (await patch(mine, { validUntil: future(5), reason: 'Within my campus' }, mv, 'campusAdmin'))
        .statusCode,
    ).toBe(200);
    // a department-scoped assignment is NOT reachable: scope containment is exact-match and fails closed (docs: CAMPUS does
    // not implicitly contain DEPARTMENT), the same rule that already governs grant and revoke
    const dept = await rawAssign(u.id, 'HOD', { scopeType: 'DEPARTMENT', scopeId: T.departmentId });
    const dv = (await rowOf(dept))!.version;
    expect(
      (
        await patch(
          dept,
          { validUntil: future(5), reason: 'Department scope case' },
          dv,
          'campusAdmin',
        )
      ).statusCode,
    ).toBe(403);
    // ...but it may not touch an organization-level role
    const reg = await rawAssign(u.id, 'REGISTRAR');
    const rvn = (await rowOf(reg))!.version;
    expect(
      (await patch(reg, { validUntil: future(5), reason: 'Above my rank' }, rvn, 'campusAdmin'))
        .statusCode,
    ).toBe(403);
  });
});

describe('revoke and the last effective administrator', () => {
  it('revokes with a reason and an audit event; the revoked grantee loses the permission', async () => {
    const u = await account();
    const id = await rawAssign(u.id, 'REGISTRAR');
    const s = await login(u.email);
    expect((await http('GET', s, '/api/v1/users')).statusCode).toBe(200);
    const before = (await roleAudit()).length;
    const r = await http('POST', 'admin', `/api/v1/role-assignments/${id}/revoke`, {
      reason: 'No longer registrar',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await rowOf(id))!.status).toBe('REVOKED');
    expect((await roleAudit()).slice(before).map((x) => x.action)).toEqual([
      'role.assignment.revoke',
    ]);
    expect((await http('GET', s, '/api/v1/users')).statusCode).toBe(403);
  });

  /** A private tenant whose ORIGINAL administrator is revoked, so the accounts a test adds are the only administrators. */
  async function soloTenant(): Promise<IsolatedTenant> {
    const t = await createIsolatedTenant(HASH);
    extraTenants.push(t);
    await adminQuery(
      `UPDATE app.role_assignments SET status = 'REVOKED'
        WHERE organization_id = $1 AND user_id = $2`,
      [t.orgId, t.users.admin],
    );
    return t;
  }

  it('two administrators revoking each other at the same moment cannot leave the organization without one', async () => {
    for (let round = 0; round < 6; round++) {
      const t = await soloTenant();
      const a = await account(t);
      const b = await account(t);
      const ra = await rawAssign(a.id, 'COLLEGE_ADMIN', { tenant: t });
      const rb = await rawAssign(b.id, 'COLLEGE_ADMIN', { tenant: t });
      const sa = await login(a.email);
      const sb = await login(b.email);
      expect(await effectiveAdmins(t)).toBe(2);
      const [x, y] = await Promise.all([
        http('POST', sa, `/api/v1/role-assignments/${rb}/revoke`, { reason: 'Mutual revoke A' }),
        http('POST', sb, `/api/v1/role-assignments/${ra}/revoke`, { reason: 'Mutual revoke B' }),
      ]);
      const statuses = [x.statusCode, y.statusCode].sort();
      // exactly one revocation lands; the other caller has by then lost its own authority (403) or is refused as the last (409)
      expect(statuses[0], `round ${round}: ${x.body} ${y.body}`).toBe(200);
      expect([403, 409], `round ${round}`).toContain(statuses[1]);
      expect(await effectiveAdmins(t), `round ${round}`).toBe(1);
    }
  });

  it('suspending an administrator while that one revokes the other leaves an effective administrator', async () => {
    for (let round = 0; round < 4; round++) {
      const t = await soloTenant();
      const a = await account(t);
      const b = await account(t);
      const ra = await rawAssign(a.id, 'COLLEGE_ADMIN', { tenant: t });
      await rawAssign(b.id, 'COLLEGE_ADMIN', { tenant: t });
      const sa = await login(a.email);
      const sb = await login(b.email);
      const bUser = (
        await adminQuery<{ version: number }>('SELECT version FROM app.users WHERE id = $1', [b.id])
      )[0]!;
      const [x, y] = await Promise.all([
        http(
          'POST',
          sa,
          `/api/v1/users/${b.id}/suspend`,
          { reason: 'Suspend the other one' },
          { ifMatch: `"${bUser.version}"` },
        ),
        http('POST', sb, `/api/v1/role-assignments/${ra}/revoke`, {
          reason: 'Revoke the other one',
        }),
      ]);
      expect(
        [x.statusCode, y.statusCode].filter((c) => c === 200).length,
        `round ${round}: ${x.body} ${y.body}`,
      ).toBeGreaterThanOrEqual(1);
      expect(await effectiveAdmins(t), `round ${round}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('the revoker cannot be the target and an out-of-scope or foreign assignment is a 404', async () => {
    const mine = await adminQuery<{ id: string }>(
      `SELECT id FROM app.role_assignments WHERE user_id = $1 AND status = 'ACTIVE'`,
      [T.users.admin],
    );
    expect(
      (
        await http('POST', 'admin', `/api/v1/role-assignments/${mine[0]!.id}/revoke`, {
          reason: 'Self revoke attempt',
        })
      ).statusCode,
    ).toBe(403);
    const foreign = await rawAssign((await account(OTHER)).id, 'STAFF', { tenant: OTHER });
    expect(
      (
        await http('POST', 'admin', `/api/v1/role-assignments/${foreign}/revoke`, {
          reason: 'Cross tenant attempt',
        })
      ).statusCode,
    ).toBe(404);
    expect((await rowOf(foreign))!.status).toBe('ACTIVE');
    expect(await effectiveAdmins()).toBeGreaterThanOrEqual(1);
  });
});

describe('audit and isolation', () => {
  it('a failed attempt writes no success audit event, and the tenant boundary holds for every new read', async () => {
    const u = await account();
    const before = (await roleAudit()).length;
    // validation, duplicate-free refusals and a non-grantor: none may leave a role.assignment.* event behind
    const rid = await roleId('STAFF');
    await http('POST', 'admin', `/api/v1/users/${u.id}/role-assignments`, {
      roleId: rid,
      scopeType: 'ORGANIZATION',
      reason: 'Bad end case',
      validUntil: 'nope',
    });
    await http('POST', 'faculty', `/api/v1/users/${u.id}/role-assignments`, {
      roleId: rid,
      scopeType: 'ORGANIZATION',
      reason: 'Not allowed case',
    });
    await http('POST', 'admin', `/api/v1/users/${uuidv7()}/role-assignments`, {
      roleId: rid,
      scopeType: 'ORGANIZATION',
      reason: 'Unknown user case',
    });
    expect((await roleAudit()).length).toBe(before);

    // the other tenant's administrator reaches nothing of this tenant
    const other = await login(OTHER.emails.admin);
    for (const path of [`/api/v1/users/${u.id}`, `/api/v1/users/${u.id}/role-assignments`]) {
      expect((await http('GET', other, path)).statusCode, path).toBe(404);
    }
    const foreignGrant = await http('POST', other, `/api/v1/users/${u.id}/role-assignments`, {
      roleId: rid,
      scopeType: 'ORGANIZATION',
      reason: 'Cross tenant grant',
    });
    expect(foreignGrant.statusCode).toBe(404);
    expect(
      await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [u.id]),
    ).toHaveLength(0);
  });
});
