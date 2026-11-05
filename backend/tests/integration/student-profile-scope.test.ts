import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// GET /api/v1/students/:id scope (student.profile.read). A CAMPUS/DEPARTMENT grant is judged against the student's ACTIVE
// enrolment (frozen campus and department in app.student_programs), read by the server; ORGANIZATION and SELF holders are
// unaffected. Out of scope, missing and other-tenant records are one indistinguishable 404. Private tenants only.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 6 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let HASH = '';
let PERIOD = '';
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);
type Session = { cookie: string };
const s = {} as Record<string, Session>;

interface Place {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Place; // T.campusId + T.departmentId: the seeded HOD / campus holders' scope
let sibling!: Place; // same campus, another department
let elsewhere!: Place; // another campus
const S = {} as Record<
  'inMain' | 'inSibling' | 'elsewhere' | 'unplaced' | 'closedOnly' | 'transferred',
  string
>;

async function login(email: string): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return { cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value) };
}
async function mkPlace(campus: string, dept?: string): Promise<Place> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Scope dept', $4)`,
      [d, T.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Scope program', $5, 'UG', 8)`,
    [program, T.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Scope cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
async function mkStudent(): Promise<string> {
  const user = uuidv7();
  const email = `ps-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'Scope Student', 'ACTIVE', $1)`,
    [user, T.orgId, email],
  );
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', 'ACTIVE')`,
    [id, T.orgId, user, code('PS')],
  );
  return id;
}
async function enrol(student: string, p: Place, status = 'ACTIVE'): Promise<void> {
  const open = status === 'ACTIVE';
  await adminQuery(
    `INSERT INTO app.student_programs
       (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, end_date, status, exit_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01', $8, $9, $10)`,
    [
      uuidv7(),
      T.orgId,
      student,
      p.program,
      p.cohort,
      p.campus,
      p.dept,
      open ? null : '2025-01-15',
      status,
      open ? null : 'Closed by the profile scope test',
    ],
  );
}
/** A staff account with exactly the given role assignments (raw fixtures, scope columns kept consistent). */
async function staff(
  assignments: {
    role: string;
    scope: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
    id: string | null;
    status?: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    validFrom?: string;
    validUntil?: string;
  }[],
): Promise<Session & { userId: string }> {
  const user = uuidv7();
  const email = `pstaff-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [user, email, HASH],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Scope Staff', 'ACTIVE', $1)`,
    [user, T.orgId, email],
  );
  for (const a of assignments) {
    await adminQuery(
      `INSERT INTO app.role_assignments
         (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, status, valid_from, valid_until)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
              CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END,
              $7, COALESCE($8::timestamptz, now()), $9::timestamptz
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [
        uuidv7(),
        T.orgId,
        user,
        a.role,
        a.scope,
        a.id,
        a.status ?? 'ACTIVE',
        a.validFrom ?? null,
        a.validUntil ?? null,
      ],
    );
  }
  return { ...(await login(email)), userId: user };
}

const get = (who: Session | null, path: string) =>
  app.inject({
    method: 'GET',
    url: path,
    cookies: who ? { session_token: who.cookie } : {},
  });
const profile = (who: Session, id: string, query = '') =>
  get(who, `/api/v1/students/${id}${query}`);
const status = async (who: Session, id: string): Promise<number> =>
  (await profile(who, id)).statusCode;
/** Everything a caller can observe about a refusal: status and the whole body minus the per-request id. */
const answer = async (who: Session, id: string) => {
  const r = await profile(who, id);
  const body = r.json<{ error?: { requestId?: string } }>();
  if (body.error) delete body.error.requestId;
  return { status: r.statusCode, body };
};
const hourAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeAll(async () => {
  await app.ready();
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(HASH);
  OTHER = await createIsolatedTenant(HASH);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkPlace(T.campusId, T.departmentId);
  sibling = await mkPlace(T.campusId);
  const campus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Other campus', $3, 'Asia/Kolkata')`,
    [campus, T.orgId, code('C')],
  );
  elsewhere = await mkPlace(campus);

  S.inMain = await mkStudent();
  await enrol(S.inMain, main);
  S.inSibling = await mkStudent();
  await enrol(S.inSibling, sibling);
  S.elsewhere = await mkStudent();
  await enrol(S.elsewhere, elsewhere);
  S.unplaced = await mkStudent();
  S.closedOnly = await mkStudent();
  await enrol(S.closedOnly, main, 'COMPLETED');
  // moved: a closed enrolment in the HOD's department, the ACTIVE one elsewhere
  S.transferred = await mkStudent();
  await enrol(S.transferred, main, 'TRANSFERRED_OUT');
  await enrol(S.transferred, elsewhere);

  for (const who of [
    'admin',
    'hod',
    'campusAdmin',
    'registrarOrg',
    'registrarCampus',
    'faculty',
    'studentOne',
  ] as const) {
    s[who] = await login(T.emails[who]);
  }
  s.foreignAdmin = await login(OTHER.emails.admin);
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'student_program_events',
      'student_programs',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await adminQuery('DELETE FROM app.students WHERE organization_id = $1', [T.orgId]);
  await T.cleanup();
  await OTHER.cleanup();
});

describe('who may read a student profile, by exact scope', () => {
  it('HOD (department scope): only students actively enrolled in that department', async () => {
    expect(await status(s.hod!, S.inMain)).toBe(200);
    expect(await status(s.hod!, S.inSibling)).toBe(404);
    expect(await status(s.hod!, S.elsewhere)).toBe(404);
    expect(await status(s.hod!, S.unplaced)).toBe(404);
    // a CLOSED enrolment in the department confers nothing
    expect(await status(s.hod!, S.closedOnly)).toBe(404);
    expect(await status(s.hod!, S.transferred)).toBe(404);
  });

  it('CAMPUS_ADMIN and a campus-scoped REGISTRAR: their campus (any department), never another campus', async () => {
    for (const who of [s.campusAdmin!, s.registrarCampus!]) {
      expect(await status(who, S.inMain)).toBe(200);
      expect(await status(who, S.inSibling)).toBe(200);
      expect(await status(who, S.elsewhere)).toBe(404);
      expect(await status(who, S.transferred)).toBe(404);
      expect(await status(who, S.unplaced)).toBe(404);
      expect(await status(who, S.closedOnly)).toBe(404);
    }
  });

  it('organization-scoped holders keep organization-wide access, placed or not', async () => {
    for (const who of [s.admin!, s.registrarOrg!]) {
      for (const id of Object.values(S)) expect(await status(who, id), id).toBe(200);
    }
  });

  it('SELF is unchanged: a student reads only its own record, placed or not', async () => {
    expect(await status(s.studentOne!, T.students.one)).toBe(200);
    expect(await status(s.studentOne!, T.students.two)).toBe(404);
    expect(await status(s.studentOne!, S.inMain)).toBe(404);
  });

  it('FACULTY holds student.profile.read only as ASSIGNED: without a teaching relationship the same 404 (doc 33 §2)', async () => {
    expect(await status(s.faculty!, S.inMain)).toBe(404);
  });

  it('request parameters cannot supply a scope: query campus/department ids change nothing', async () => {
    const q = `?campusId=${main.campus}&departmentId=${main.dept}&organizationId=${T.orgId}`;
    expect((await profile(s.hod!, S.inSibling, q)).statusCode).toBe(404);
    expect((await profile(s.hod!, S.elsewhere, q)).statusCode).toBe(404);
  });
});

describe('non-disclosure', () => {
  it('out of scope, nonexistent and other-tenant ids are the same answer for a scoped holder', async () => {
    const outOfScope = await answer(s.hod!, S.inSibling);
    expect(outOfScope.status).toBe(404);
    expect(await answer(s.hod!, uuidv7())).toEqual(outOfScope);
    expect(await answer(s.hod!, OTHER.students.one)).toEqual(outOfScope);
    expect(await answer(s.hod!, S.unplaced)).toEqual(outOfScope);
  });

  it('nonexistent and other-tenant ids are the same 404 for an organization administrator; malformed is 400', async () => {
    const missing = await answer(s.admin!, uuidv7());
    expect(missing.status).toBe(404);
    expect(await answer(s.admin!, OTHER.students.one)).toEqual(missing);
    expect(await answer(s.foreignAdmin!, S.inMain)).toEqual(missing);
    expect((await profile(s.hod!, 'not-a-student-id')).statusCode).toBe(400);
  });
});

describe('only current, effective assignments give scope', () => {
  const dept = (status?: 'REVOKED' | 'EXPIRED', extra: Record<string, string> = {}) => ({
    role: 'HOD',
    scope: 'DEPARTMENT' as const,
    id: T.departmentId,
    ...(status ? { status } : {}),
    ...extra,
  });

  it('a revoked, EXPIRED-status, ended or not-yet-started department assignment grants nothing', async () => {
    for (const a of [
      dept('REVOKED'),
      dept('EXPIRED'),
      dept(undefined, { validFrom: hourAgo(3), validUntil: hourAgo(1) }),
      dept(undefined, { validFrom: new Date(Date.now() + 3_600_000).toISOString() }),
    ]) {
      const who = await staff([a]);
      // no effective grant of the permission at all: the route gate refuses with 403
      expect(await status(who, S.inMain), JSON.stringify(a)).toBe(403);
    }
  });

  it('an ended assignment for the department does not add scope to a live assignment elsewhere', async () => {
    const who = await staff([
      { role: 'HOD', scope: 'DEPARTMENT', id: sibling.dept },
      dept(undefined, { validFrom: hourAgo(3), validUntil: hourAgo(1) }),
    ]);
    expect(await status(who, S.inSibling)).toBe(200);
    expect(await status(who, S.inMain)).toBe(404);
  });

  it('a suspended account cannot read anything (its session is refused before authorization)', async () => {
    const who = await staff([dept()]);
    expect(await status(who, S.inMain)).toBe(200);
    await adminQuery(`UPDATE app.users SET status = 'SUSPENDED' WHERE id = $1`, [who.userId]);
    expect(await status(who, S.inMain)).toBe(401);
  });
});

describe('sensitive data stays separately gated', () => {
  it('an HOD (no student.profile.read_sensitive) reads the profile but not the identifiers', async () => {
    expect(await status(s.hod!, S.inMain)).toBe(200);
    const ids = await get(s.hod!, `/api/v1/students/${S.inMain}/identifiers`);
    expect(ids.statusCode).toBe(403);
  });

  it('a campus administrator (holds read_sensitive) reads identifiers in its campus only', async () => {
    expect((await get(s.campusAdmin!, `/api/v1/students/${S.inMain}/identifiers`)).statusCode).toBe(
      200,
    );
    expect(
      (await get(s.campusAdmin!, `/api/v1/students/${S.elsewhere}/identifiers`)).statusCode,
    ).toBe(404);
  });

  it('the profile response carries no placement, guardian or identifier fields', async () => {
    const r = await profile(s.hod!, S.inMain);
    expect(Object.keys(r.json<{ data: object }>().data).sort()).toEqual(
      [
        'admissionDate',
        'admissionNumber',
        'createdAt',
        'id',
        'organizationId',
        'status',
        'statusChangedAt',
        'updatedAt',
        'userId',
        'version',
      ].sort(),
    );
  });
});
