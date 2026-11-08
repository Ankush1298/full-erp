import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Institution-aware onboarding foundation (doc 44): the institution type is a validated, audited, controlled setting, and
// the role names it selects are DISPLAY ONLY. Synthetic tenants only.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 5 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

interface Session {
  cookie: string;
  csrf: string;
}
let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const s = {} as Record<
  'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'student' | 'foreignAdmin',
  Session
>;

async function login(email: string): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}
const call = (
  method: 'GET' | 'PUT',
  who: Session,
  path: string,
  payload?: object,
  h: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: path,
    ...(payload ? { payload } : {}),
    cookies: { session_token: who.cookie },
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': who.csrf }),
      ...h,
    },
  });
const setType = (
  who: Session,
  value: unknown,
  version: number | null,
  reason: unknown = 'Chosen at onboarding',
) =>
  call(
    'PUT',
    who,
    '/api/v1/organization/settings/institution.type',
    { value, ...(reason === undefined ? {} : { reason }) },
    { 'if-match': `"${version ?? 0}"` },
  );
const terminology = async (who: Session) =>
  (await call('GET', who, '/api/v1/academics/terminology')).json<{
    data: { institutionType: string | null; roleLabels: Record<string, string> };
  }>().data;
const me = async (who: Session) => {
  const b = (await call('GET', who, '/auth/me')).json<{
    roles: string[];
    capabilities: string[];
    role_labels: Record<string, string>;
  }>();
  return { roles: b.roles, capabilities: b.capabilities, roleLabels: b.role_labels };
};
const storedVersion = async (org: string): Promise<number | null> =>
  (
    await adminQuery<{ version: number }>(
      `SELECT version FROM app.organization_settings WHERE organization_id = $1 AND key = 'institution.type'`,
      [org],
    )
  )[0]?.version ?? null;
/** Everything that decides what anybody may do in the tenant, plus the role names stored in the database. */
const authorityOf = async (org: string): Promise<string> =>
  JSON.stringify(
    await adminQuery(
      `SELECT 'role' AS k, r.code AS a, r.name AS b, NULL AS c FROM app.roles r WHERE r.organization_id = $1
       UNION ALL SELECT 'perm', r.code, rp.permission_code, rp.scope_mode FROM app.role_permissions rp
         JOIN app.roles r ON r.organization_id = rp.organization_id AND r.id = rp.role_id WHERE rp.organization_id = $1
       UNION ALL SELECT 'assign', ra.user_id::text, ra.role_id::text, ra.scope_type || ':' || COALESCE(ra.scope_id::text, '')
         FROM app.role_assignments ra WHERE ra.organization_id = $1
       ORDER BY 1, 2, 3, 4`,
      [org],
    ),
  );

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.hod = await login(T.emails.hod);
  s.faculty = await login(T.emails.faculty);
  s.student = await login(T.emails.studentOne);
  s.foreignAdmin = await login(OTHER.emails.admin);
  await elevateSession(s.admin.cookie);
  await elevateSession(s.foreignAdmin.cookie);
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const org of [T.orgId, OTHER.orgId]) {
      for (const t of ['organization_settings', 'academic_years']) {
        await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [org]);
      }
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

describe('institution type: selection and persistence', () => {
  it('starts unset with the pre-onboarding role names; an organization administrator chooses SCHOOL (audited, tier 2, with a reason)', async () => {
    const before = await terminology(s.student);
    expect(before.institutionType).toBeNull();
    expect(before.roleLabels['COLLEGE_ADMIN']).toBe('College administrator');
    expect(before.roleLabels['FACULTY']).toBe('Faculty');

    const r = await setType(s.admin, 'SCHOOL', null);
    expect(r.statusCode, r.body).toBe(200);
    expect(await storedVersion(T.orgId)).toBe(1);
    const ev = await adminQuery<{ risk_tier: number; reason_text: string }>(
      `SELECT risk_tier, reason_text FROM app.audit_events
        WHERE organization_id = $1 AND action = 'organization.setting.update' AND metadata->>'settingKey' = 'institution.type'`,
      [T.orgId],
    );
    expect(ev).toEqual([{ risk_tier: 2, reason_text: 'Chosen at onboarding' }]);

    // every role of the tenant sees the school names; another tenant is untouched
    for (const who of [s.student, s.faculty, s.hod, s.campusAdmin, s.admin]) {
      const t = await terminology(who);
      expect(t.institutionType).toBe('SCHOOL');
      expect(t.roleLabels).toMatchObject({
        FACULTY: 'Teacher',
        COLLEGE_ADMIN: 'Principal',
        CAMPUS_ADMIN: 'Vice Principal',
        STUDENT: 'Student',
      });
    }
    expect((await terminology(s.foreignAdmin)).institutionType).toBeNull();
  });

  it('only a closed set of values, a reason and the right authority are accepted; nothing is stored otherwise', async () => {
    const v = await storedVersion(T.orgId);
    for (const bad of ['ACADEMY', 'school', '', null, 1, { type: 'SCHOOL' }, ['SCHOOL']]) {
      expect((await setType(s.admin, bad, v)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await setType(s.admin, 'COLLEGE', v, null)).statusCode).toBe(400);
    expect((await setType(s.admin, 'COLLEGE', v, 'abc')).statusCode).toBe(400);
    for (const who of [s.campusAdmin, s.hod, s.faculty, s.student]) {
      expect((await setType(who, 'UNIVERSITY', v)).statusCode).toBe(403);
    }
    // a stale version is a conflict; a foreign tenant's administrator writes only their own setting
    expect((await setType(s.admin, 'COLLEGE', 99)).statusCode).toBe(409);
    expect((await terminology(s.student)).institutionType).toBe('SCHOOL');
    expect(await storedVersion(T.orgId)).toBe(v);
  });
});

describe('role names are display only: no permission changes when the label changes', () => {
  it('switching SCHOOL -> COLLEGE -> UNIVERSITY changes the words and nothing in roles, grants, assignments or capabilities', async () => {
    const authority = await authorityOf(T.orgId);
    const other = await authorityOf(OTHER.orgId);
    const caps = async () =>
      JSON.stringify(
        (await Promise.all(Object.values(s).slice(0, 5).map(me))).map((m) => [
          m.roles,
          m.capabilities,
        ]),
      );
    const baseline = await caps();
    const names: string[] = [];
    for (const type of ['COLLEGE', 'UNIVERSITY', 'SCHOOL'] as const) {
      const r = await setType(s.admin, type, await storedVersion(T.orgId));
      expect(r.statusCode, r.body).toBe(200);
      names.push(`${type}:${(await terminology(s.faculty)).roleLabels['COLLEGE_ADMIN']}`);
      expect(await authorityOf(T.orgId)).toBe(authority);
      expect(await authorityOf(OTHER.orgId)).toBe(other);
      expect(await caps()).toBe(baseline);
    }
    expect(names).toEqual([
      'COLLEGE:College administrator',
      'UNIVERSITY:University administrator',
      'SCHOOL:Principal',
    ]);
  });

  it('a "Principal" is exactly the old college administrator: same grants, no extra reach; a "Teacher" gets no administrative access', async () => {
    const t = await terminology(s.admin);
    expect(t.roleLabels['COLLEGE_ADMIN']).toBe('Principal');
    const admin = await me(s.admin);
    expect(admin.roleLabels).toEqual({ COLLEGE_ADMIN: 'Principal' }); // only the caller's own roles are labelled
    expect((await me(s.faculty)).roleLabels).toEqual({ FACULTY: 'Teacher' });
    expect(admin.roles).toEqual(['COLLEGE_ADMIN']); // the CODE is what the server evaluates
    const teacher = await me(s.faculty);
    expect(teacher.roles).toEqual(['FACULTY']);
    expect(teacher.capabilities).not.toContain('org.settings.manage');
    expect(teacher.capabilities).not.toContain('role.assignment.grant');
    // being labelled "Vice Principal" does not make the campus administrator organization-wide
    expect((await me(s.campusAdmin)).capabilities).not.toContain('org.settings.manage');
    expect((await call('GET', s.faculty, '/api/v1/organization/settings')).statusCode).toBe(403);
  });
});

describe('controlled institution-type change', () => {
  it('allowed while the tenant has no academic year; refused (409) once one exists; re-sending the same value stays a no-op', async () => {
    await adminQuery(
      `INSERT INTO app.academic_years (id, organization_id, label, start_date, end_date) VALUES ($1, $2, $3, '2026-06-01', '2027-05-31')`,
      [uuidv7(), T.orgId, `Y${RUN}`],
    );
    const v = await storedVersion(T.orgId);
    const authority = await authorityOf(T.orgId);
    const refused = await setType(s.admin, 'UNIVERSITY', v);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toMatch(
      /academic years exist/,
    );
    expect((await terminology(s.student)).institutionType).toBe('SCHOOL');
    expect(await storedVersion(T.orgId)).toBe(v);
    expect((await setType(s.admin, 'SCHOOL', v)).statusCode).toBe(200); // same value: no write, no version bump
    expect(await storedVersion(T.orgId)).toBe(v);
    expect(await authorityOf(T.orgId)).toBe(authority);
    // a tenant WITHOUT academic years is unaffected by this one's data
    expect((await setType(s.foreignAdmin, 'UNIVERSITY', null)).statusCode).toBe(200);
    expect(
      (await setType(s.foreignAdmin, 'COLLEGE', await storedVersion(OTHER.orgId))).statusCode,
    ).toBe(200);
  });
});
