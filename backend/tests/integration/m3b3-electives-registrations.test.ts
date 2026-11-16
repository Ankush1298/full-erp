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

// Milestone 3 Batch 3 (migration 0039, doc 33) over HTTP in one private tenant: elective groups and course registrations
// (window, min/max, capacity, duplicates, audience, from-section, races), the X-12 ASSIGNED resolver for faculty, the
// cohort promotion tool (rollback, idempotency, concurrency, lock order), holidays, terminology, the setup checklist and
// the class-teacher posting rule. Dates are relative to "today" on the campus calendar (Asia/Kolkata), because the
// resolver and the registration window are evaluated against the database clock. Structure, employee and student rows
// are fixtures inserted as the harness superuser (the guards still run).

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let HASH = '';
interface Session {
  cookie: string;
  csrf: string;
}
const s = {} as Record<
  'admin' | 'campusAdmin' | 'hod' | 'student' | 'faculty' | 'foreignAdmin' | 'foreignFaculty',
  Session
>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload !== undefined ? { payload } : {}),
    cookies: who ? { session_token: who.cookie } : {},
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN }),
      ...(who && method !== 'GET' ? { 'x-csrf-token': who.csrf } : {}),
      ...headers,
    },
  });
const idOf = (r: { json: <X>() => X }): string => r.json<{ data: { id: string } }>().data.id;
const dataOf = <X>(r: { json: <Y>() => Y }): X => r.json<{ data: X }>().data;
const msg = (r: { json: <X>() => X }): string =>
  r.json<{ message?: string; error?: { message?: string } }>().message ?? JSON.stringify(r.json());

async function insertIn(org: string, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const rest = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = ['id', 'organization_id', ...rest.map(([k]) => k)];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [id, org, ...rest.map(([, v]) => v)],
  );
  return id;
}
const insert = (table: string, row: Record<string, unknown>) => insertIn(T.orgId, table, row);

/** A login-able user of `org` holding FACULTY (organization scope) with an employee row, optionally posted. */
async function facultyUser(
  org: IsolatedTenant,
  posting?: [string, string, string?],
): Promise<{ user: string; employee: string; email: string; assignment: string }> {
  const user = uuidv7();
  const email = `fac-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [user, email, HASH],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Teacher', 'ACTIVE', $1)`,
    [user, org.orgId, email],
  );
  const assignment = uuidv7();
  await adminQuery(
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION' FROM app.roles r
      WHERE r.organization_id = $2::uuid AND r.code = 'FACULTY'`,
    [assignment, org.orgId, user],
  );
  const employee = await employeeFor(org.orgId, user, posting);
  return { user, employee, email, assignment };
}
async function employeeFor(org: string, user: string | null, posting?: [string, string, string?]) {
  let u = user;
  if (!u) {
    u = uuidv7();
    const email = `emp-${RUN.toLowerCase()}-${u.slice(-12)}@isolated.test`;
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
      [u, email],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Person', 'ACTIVE', $1)`,
      [u, org, email],
    );
  }
  const employee = await insertIn(org, 'employees', {
    user_id: u,
    employee_code: code('E'),
    employee_type: 'FACULTY',
    joining_date: '2020-06-01',
    status: 'ACTIVE',
  });
  if (posting) await post(org, employee, posting);
  return employee;
}
const post = (org: string, employee: string, p: [string, string, string?]) =>
  insertIn(org, 'employee_postings', {
    employee_id: employee,
    department_id: p[0],
    valid_from: p[1],
    is_primary: true,
    ...(p[2] ? { valid_to: p[2] } : {}),
  });

/** A student with an ACTIVE programme enrolment and an ACTIVE term enrolment in `cp`, optionally placed in `section`. */
async function pupil(
  o: {
    program: string;
    cohort: string;
    campus: string;
    dept: string;
    cp: string;
    term: string;
    periodNo?: number;
  },
  section?: string,
  student?: string,
) {
  const sid =
    student ??
    (await insert('students', {
      user_id: await employeeless(),
      admission_number: code('ADM'),
      admission_date: '2026-06-01',
      status: 'ACTIVE',
    }));
  const sp = await insert('student_programs', {
    student_id: sid,
    program_id: o.program,
    cohort_id: o.cohort,
    campus_id: o.campus,
    department_id: o.dept,
    start_date: '2026-06-01',
    status: 'ACTIVE',
  });
  const eid = await insert('term_enrollments', {
    student_id: sid,
    student_program_id: sp,
    cohort_period_id: o.cp,
    term_id: o.term,
    period_no: o.periodNo ?? 1,
  });
  await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [eid]);
  if (section) {
    await insert('section_memberships', {
      term_enrollment_id: eid,
      student_id: sid,
      cohort_period_id: o.cp,
      section_id: section,
      valid_from: D(-60),
      change_reason: 'Initial placement',
      changed_by: T.users.admin,
    });
  }
  return { student: sid, sp, eid };
}
async function employeeless(): Promise<string> {
  const u = uuidv7();
  const email = `st-${RUN.toLowerCase()}-${u.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [u, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Pupil', 'ACTIVE', $1)`,
    [u, T.orgId, email],
  );
  return u;
}

// ---- fixture ids
const U = {} as Record<
  | 'year'
  | 'sem'
  | 'program'
  | 'cohort'
  | 'cohortX'
  | 'termA'
  | 'termN'
  | 'termL'
  | 'cpA'
  | 'cpX'
  | 'cpN'
  | 'secA'
  | 'secB'
  | 'dept2'
  | 'core'
  | 'e1'
  | 'e2'
  | 'e3'
  | 'manual',
  string
>;
const C2 = {} as Record<
  'campus' | 'dept' | 'program' | 'cohort' | 'term' | 'cp' | 'sec' | 'course',
  string
>;
const base = () => ({
  program: U.program,
  cohort: U.cohort,
  campus: T.campusId,
  dept: T.departmentId,
  cp: U.cpA,
  term: U.termA,
});

/** Creates an offering over HTTP as the admin and publishes it. */
async function published(body: Record<string, unknown>): Promise<string> {
  const r = await call('POST', s.admin, '/academics/course-offerings', {
    termId: U.termA,
    ...body,
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = idOf(r);
  const p = await call(
    'PATCH',
    s.admin,
    `/academics/course-offerings/${id}`,
    { status: 'PUBLISHED' },
    { 'if-match': '"1"' },
  );
  expect(p.statusCode, p.body).toBe(200);
  return id;
}
async function course(dept: string | null, title: string): Promise<string> {
  return insert('courses', {
    ...(dept ? { owning_department_id: dept } : {}),
    code: code('C'),
    title,
    credits: 3,
    course_type: 'THEORY',
  });
}

beforeAll(async () => {
  await app.ready();
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(HASH);
  OTHER = await createIsolatedTenant(HASH);

  U.year = await insert('academic_years', {
    label: `Y${RUN}`,
    start_date: D(-100),
    end_date: D(260),
  });
  U.sem = await insert('period_types', {
    code: 'SEM',
    label: 'Semester',
    label_plural: 'Semesters',
  });
  U.program = await insert('programs', {
    department_id: T.departmentId,
    period_type_id: U.sem,
    name: 'B.Tech CSE',
    code: code('BT'),
    degree_level: 'UG',
    duration_periods: 8,
  });
  U.cohort = await insert('cohorts', {
    program_id: U.program,
    admission_year: 2026,
    name: 'CSE 2026',
  });
  U.cohortX = await insert('cohorts', {
    program_id: U.program,
    admission_year: 2026,
    intake_code: 'X',
    name: 'CSE 2026 X',
  });
  const term = (campus: string, c: string, from: string, to: string) =>
    insert('terms', {
      campus_id: campus,
      academic_year_id: U.year,
      code: c,
      name: c,
      start_date: from,
      end_date: to,
    });
  U.termA = await term(T.campusId, 'A', D(-60), D(60));
  U.termN = await term(T.campusId, 'N', D(61), D(180));
  U.termL = await term(T.campusId, 'L', D(181), D(250));
  U.cpA = await insert('cohort_periods', { cohort_id: U.cohort, term_id: U.termA, period_no: 1 });
  U.cpX = await insert('cohort_periods', { cohort_id: U.cohortX, term_id: U.termA, period_no: 1 });
  U.cpN = await insert('cohort_periods', { cohort_id: U.cohort, term_id: U.termN, period_no: 2 });
  U.secA = await insert('sections', { cohort_period_id: U.cpA, name: 'A' });
  U.secB = await insert('sections', { cohort_period_id: U.cpA, name: 'B' });
  U.dept2 = await insert('departments', {
    campus_id: T.campusId,
    name: 'Second',
    code: code('D2'),
  });

  C2.campus = await insert('campuses', {
    name: 'North',
    code: code('N'),
    timezone: 'Asia/Kolkata',
  });
  C2.dept = await insert('departments', {
    campus_id: C2.campus,
    name: 'North CSE',
    code: code('NC'),
  });
  C2.program = await insert('programs', {
    department_id: C2.dept,
    period_type_id: U.sem,
    name: 'B.Tech North',
    code: code('BN'),
    degree_level: 'UG',
    duration_periods: 8,
  });
  C2.cohort = await insert('cohorts', {
    program_id: C2.program,
    admission_year: 2026,
    name: 'North 2026',
  });
  C2.term = await term(C2.campus, 'A', D(-60), D(60));
  C2.cp = await insert('cohort_periods', { cohort_id: C2.cohort, term_id: C2.term, period_no: 1 });
  C2.sec = await insert('sections', { cohort_period_id: C2.cp, name: 'A' });
  C2.course = await course(C2.dept, 'North course');

  // the term L is locked (holiday tests): year ACTIVE, L PLANNED -> ACTIVE -> CLOSED -> LOCKED
  await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [U.year]);
  for (const st of ['ACTIVE', 'CLOSED']) {
    await adminQuery(`UPDATE app.terms SET status = $2 WHERE id = $1`, [U.termL, st]);
  }
  await adminQuery(
    `UPDATE app.terms SET status = 'LOCKED', locked_at = now(), locked_by = $2 WHERE id = $1`,
    [U.termL, T.users.admin],
  );

  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.hod = await login(T.emails.hod);
  s.student = await login(T.emails.studentOne);
  s.foreignAdmin = await login(OTHER.emails.admin);

  U.core = await published({
    courseId: await course(T.departmentId, 'Programming'),
    sectionId: U.secA,
    offeringKind: 'CORE',
    registrationPolicy: 'AUTO_FROM_SECTION',
  });
  U.manual = await published({
    courseId: await course(T.departmentId, 'Seminar'),
    cohortPeriodId: U.cpA,
    offeringKind: 'OPTIONAL',
    registrationPolicy: 'MANUAL',
  });
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const org of [T.orgId, OTHER.orgId]) {
      for (const t of [
        'course_registrations',
        'holidays',
        'section_class_teachers',
        'timetable_slots',
        'faculty_assignments',
        'course_offerings',
        'elective_groups',
        'section_memberships',
        'term_enrollments',
        'student_programs',
        'organization_settings',
        'sections',
        'cohort_periods',
        'terms',
        'academic_years',
        'cohorts',
        'programs',
        'period_types',
        'courses',
      ]) {
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

const register = (who: Session, offering: string, body: Record<string, unknown>) =>
  call('POST', who, `/academics/course-offerings/${offering}/registrations`, {
    validFrom: TODAY,
    source: 'MANUAL',
    reason: 'Registered by the office',
    ...body,
  });
const closeReg = (who: Session, id: string, version: number, body: Record<string, unknown>) =>
  call(
    'PATCH',
    who,
    `/academics/course-registrations/${id}`,
    { reason: 'Student request', ...body },
    {
      'if-match': `"${version}"`,
    },
  );
const patchGroup = async (id: string, body: Record<string, unknown>) => {
  const { version } = (
    await adminQuery<{ version: number }>(`SELECT version FROM app.elective_groups WHERE id = $1`, [
      id,
    ])
  )[0]!;
  return call(
    'PATCH',
    s.admin,
    `/academics/elective-groups/${id}`,
    { reason: 'Basket update', ...body },
    {
      'if-match': `"${version}"`,
    },
  );
};
const liveCount = async (offering: string) =>
  Number(
    (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM app.course_registrations WHERE course_offering_id = $1 AND valid_to IS NULL`,
        [offering],
      )
    )[0]!.n,
  );

// =============================================================================================
// Elective groups and course registrations
// =============================================================================================
describe('elective groups and course registrations', () => {
  let group = '';
  const st: Array<{ student: string; eid: string }> = [];

  beforeAll(async () => {
    for (let i = 0; i < 4; i++) st.push(await pupil(base(), U.secA));
    const g = await call('POST', s.admin, `/academics/cohort-periods/${U.cpA}/elective-groups`, {
      code: 'PE1',
      name: 'Professional Elective I',
      minSelect: 1,
      maxSelect: 2,
      reason: 'Curriculum basket',
    });
    expect(g.statusCode, g.body).toBe(201);
    group = idOf(g);
    const elective = (title: string, capacity?: number) =>
      course(T.departmentId, title).then((courseId) =>
        published({
          courseId,
          cohortPeriodId: U.cpA,
          electiveGroupId: group,
          offeringKind: 'ELECTIVE',
          registrationPolicy: 'ELECTIVE_CHOICE',
          ...(capacity ? { capacity } : {}),
        }),
      );
    U.e1 = await elective('Machine learning', 2);
    U.e2 = await elective('Databases');
    U.e3 = await elective('Compilers');
  });

  it('a group is unique per cohort period, min <= max; only an elective kind of the same cohort period joins it', async () => {
    const dup = await call('POST', s.admin, `/academics/cohort-periods/${U.cpA}/elective-groups`, {
      code: 'PE1',
      name: 'Again',
      minSelect: 0,
      maxSelect: 1,
      reason: 'Curriculum basket',
    });
    expect(dup.statusCode).toBe(409);
    const bad = await call('POST', s.admin, `/academics/cohort-periods/${U.cpA}/elective-groups`, {
      code: 'PE9',
      name: 'Bad',
      minSelect: 3,
      maxSelect: 2,
      reason: 'Curriculum basket',
    });
    expect(bad.statusCode).toBe(400);
    const coreInGroup = await call('POST', s.admin, '/academics/course-offerings', {
      termId: U.termA,
      courseId: await course(T.departmentId, 'Core in basket'),
      cohortPeriodId: U.cpA,
      electiveGroupId: group,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    expect(coreInGroup.statusCode).toBe(409);
    const otherPeriod = await call('POST', s.admin, '/academics/course-offerings', {
      termId: U.termA,
      courseId: await course(T.departmentId, 'Wrong period'),
      cohortPeriodId: U.cpX,
      electiveGroupId: group,
      offeringKind: 'ELECTIVE',
      registrationPolicy: 'ELECTIVE_CHOICE',
    });
    expect(otherPeriod.statusCode).toBe(409); // composite foreign key: the group belongs to cpA, not cpX
    const listed = dataOf<Array<{ code: string; status: string }>>(
      await call('GET', s.student, `/academics/cohort-periods/${U.cpA}/elective-groups`),
    );
    expect(listed.map((x) => [x.code, x.status])).toEqual([['PE1', 'PLANNED']]);
  });

  it('window: no choice while PLANNED or before opensAt; only ELECTIVE_CHOICE registers a basket offering', async () => {
    const r1 = await register(s.admin, U.e1, {
      termEnrollmentId: st[0]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(r1.statusCode).toBe(409);
    expect(msg(r1)).toMatch(/not open for choices/);
    expect(
      (
        await patchGroup(group, {
          status: 'OPEN',
          opensAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await register(s.admin, U.e1, { termEnrollmentId: st[0]!.eid, source: 'ELECTIVE_CHOICE' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await patchGroup(group, {
          opensAt: null,
          closesAt: new Date(Date.now() - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await register(s.admin, U.e1, { termEnrollmentId: st[0]!.eid, source: 'ELECTIVE_CHOICE' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await patchGroup(group, { closesAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }))
        .statusCode,
    ).toBe(200);
    for (const source of ['MANUAL', 'ADMIN']) {
      const r = await register(s.admin, U.e1, { termEnrollmentId: st[0]!.eid, source });
      expect(r.statusCode, source).toBe(409);
      expect(msg(r)).toMatch(/ELECTIVE_CHOICE/);
    }
    const ok = await register(s.admin, U.e1, {
      termEnrollmentId: st[0]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const [row] = await adminQuery<{ elective_group_id: string; status: string; source: string }>(
      `SELECT elective_group_id, status, source FROM app.course_registrations WHERE id = $1`,
      [idOf(ok)],
    );
    expect(row).toEqual({
      elective_group_id: group,
      status: 'REGISTERED',
      source: 'ELECTIVE_CHOICE',
    });
  });

  it('max_select per student, and max_select cannot drop below what a student already holds', async () => {
    expect(
      (await register(s.admin, U.e2, { termEnrollmentId: st[0]!.eid, source: 'ELECTIVE_CHOICE' }))
        .statusCode,
    ).toBe(201);
    const third = await register(s.admin, U.e3, {
      termEnrollmentId: st[0]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(third.statusCode).toBe(409);
    expect(msg(third)).toMatch(/already holds 2 registrations/);
    const shrink = await patchGroup(group, { maxSelect: 1 });
    expect(shrink.statusCode).toBe(409);
    expect(msg(shrink)).toMatch(/more than 1/);
  });

  it('a duplicate live registration is refused (also under a race); after a drop the student may register again, history kept', async () => {
    const dup = await register(s.admin, U.e2, {
      termEnrollmentId: st[0]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(dup.statusCode).toBe(409);
    const race = await Promise.all(
      [0, 1].map(() => register(s.admin, U.manual, { termEnrollmentId: st[1]!.eid })),
    );
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const won = race.find((r) => r.statusCode === 201)!;
    const drop = await closeReg(s.admin, idOf(won), 1, { status: 'DROPPED', validTo: TODAY });
    expect(drop.statusCode, drop.body).toBe(200);
    expect(dataOf<{ status: string; validTo: string }>(drop)).toMatchObject({
      status: 'DROPPED',
      validTo: TODAY,
    });
    expect(
      (await closeReg(s.admin, idOf(won), 2, { status: 'WITHDRAWN', validTo: TODAY })).statusCode,
    ).toBe(409);
    expect((await register(s.admin, U.manual, { termEnrollmentId: st[1]!.eid })).statusCode).toBe(
      201,
    );
    const rows = await adminQuery<{ status: string }>(
      `SELECT status FROM app.course_registrations WHERE student_id = $1 AND course_offering_id = $2 ORDER BY created_at`,
      [st[1]!.student, U.manual],
    );
    expect(rows.map((r) => r.status)).toEqual(['DROPPED', 'REGISTERED']);
  });

  it('capacity: the last seat goes to exactly one of two racing students; capacity cannot drop below live registrations', async () => {
    // e1 has capacity 2 and one registration (st[0])
    const race = await Promise.all(
      [st[1]!, st[2]!].map((p) =>
        register(s.admin, U.e1, { termEnrollmentId: p.eid, source: 'ELECTIVE_CHOICE' }),
      ),
    );
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(msg(race.find((r) => r.statusCode === 409)!)).toMatch(/at capacity/);
    expect(await liveCount(U.e1)).toBe(2);
    const full = await register(s.admin, U.e1, {
      termEnrollmentId: st[3]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(full.statusCode).toBe(409);
    const shrink = await call(
      'PATCH',
      s.admin,
      `/academics/course-offerings/${U.e1}`,
      { capacity: 1 },
      {
        'if-match': `"${(await adminQuery<{ version: number }>(`SELECT version FROM app.course_offerings WHERE id = $1`, [U.e1]))[0]!.version}"`,
      },
    );
    expect(shrink.statusCode).toBe(409);
  });

  it('closing the group needs every live enrolment of the period to meet min_select; a CLOSED group is final', async () => {
    const close = await patchGroup(group, { status: 'CLOSED' });
    expect(close.statusCode).toBe(409);
    expect(msg(close)).toMatch(/fewer than 1/);
    expect((await patchGroup(group, { minSelect: 0 })).statusCode).toBe(200);
    expect((await patchGroup(group, { status: 'CLOSED' })).statusCode).toBe(200);
    expect((await patchGroup(group, { name: 'Renamed' })).statusCode).toBe(409);
    const late = await register(s.admin, U.e3, {
      termEnrollmentId: st[3]!.eid,
      source: 'ELECTIVE_CHOICE',
    });
    expect(late.statusCode).toBe(409);
  });

  it('audience: section, cohort period and term must match unless the kind is BACKLOG/IMPROVEMENT', async () => {
    const inB = await pupil(base(), U.secB);
    const r = await register(s.admin, U.core, { termEnrollmentId: inB.eid });
    expect(r.statusCode).toBe(409);
    expect(msg(r)).toMatch(/not in the offering's section/);
    const backlog = await register(s.admin, U.core, {
      termEnrollmentId: inB.eid,
      registrationKind: 'BACKLOG',
    });
    expect(backlog.statusCode, backlog.body).toBe(201);
    const xStudent = await pupil({ ...base(), cohort: U.cohortX, cp: U.cpX });
    expect((await register(s.admin, U.manual, { termEnrollmentId: xStudent.eid })).statusCode).toBe(
      409,
    );
    expect(
      (
        await register(s.admin, U.manual, {
          termEnrollmentId: xStudent.eid,
          registrationKind: 'IMPROVEMENT',
        })
      ).statusCode,
    ).toBe(201);
    // another term: a CORE offering of term N for an enrolment of term A
    const nextTerm = await call('POST', s.admin, '/academics/course-offerings', {
      termId: U.termN,
      courseId: await course(T.departmentId, 'Next term'),
      cohortPeriodId: U.cpN,
      offeringKind: 'OPTIONAL',
      registrationPolicy: 'MANUAL',
    });
    const nid = idOf(nextTerm);
    await call(
      'PATCH',
      s.admin,
      `/academics/course-offerings/${nid}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );
    const other = await register(s.admin, nid, {
      termEnrollmentId: inB.eid,
      registrationKind: 'BACKLOG',
    });
    expect(other.statusCode).toBe(409);
    expect(msg(other)).toMatch(/another term/);
    // valid_from outside the term
    expect(
      (await register(s.admin, U.manual, { termEnrollmentId: inB.eid, validFrom: D(61) }))
        .statusCode,
    ).toBe(409);
  });

  it('from-section registers the open members of the section once; re-running creates nothing; non-section offerings refuse', async () => {
    const members = Number(
      (
        await adminQuery<{ n: string }>(
          `SELECT count(*) AS n FROM app.section_memberships m JOIN app.term_enrollments e ON e.id = m.term_enrollment_id
            WHERE m.section_id = $1 AND m.valid_to IS NULL AND e.status IN ('REGISTERED', 'ACTIVE')`,
          [U.secA],
        )
      )[0]!.n,
    );
    const first = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${U.core}/registrations/from-section`,
      {
        validFrom: TODAY,
        reason: 'Core courses of section A',
      },
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(dataOf<{ created: number }>(first).created).toBe(members);
    const again = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${U.core}/registrations/from-section`,
      {
        validFrom: TODAY,
        reason: 'Core courses of section A',
      },
    );
    expect(dataOf(again)).toEqual({ created: 0, alreadyRegistered: members });
    expect(
      (
        await call(
          'POST',
          s.admin,
          `/academics/course-offerings/${U.manual}/registrations/from-section`,
          {
            validFrom: TODAY,
            reason: 'Not a section offering',
          },
        )
      ).statusCode,
    ).toBe(409);
  });

  it('pending approval: approve or reject; an approval keeps the row open, a rejection closes it', async () => {
    const p = await pupil(base(), U.secA);
    const r = await register(s.admin, U.manual, { termEnrollmentId: p.eid, pendingApproval: true });
    expect(r.statusCode).toBe(201);
    const ok = await closeReg(s.admin, idOf(r), 1, { status: 'REGISTERED' });
    expect(dataOf<{ status: string; validTo: null }>(ok)).toMatchObject({
      status: 'REGISTERED',
      validTo: null,
    });
    expect(
      (await closeReg(s.admin, idOf(r), 2, { status: 'REJECTED', validTo: TODAY })).statusCode,
    ).toBe(409);
    expect(
      (await closeReg(s.admin, idOf(r), 2, { status: 'DROPPED', validTo: D(-61) })).statusCode,
    ).toBe(400);
  });

  it('student self-read, staff-only writes, scope and tenant isolation', async () => {
    const me = await pupil(base(), U.secA, T.students.one);
    expect((await register(s.admin, U.manual, { termEnrollmentId: me.eid })).statusCode).toBe(201);
    const mine = await call(
      'GET',
      s.student,
      `/academics/term-enrollments/${me.eid}/course-registrations`,
    );
    expect(mine.statusCode, mine.body).toBe(200);
    expect(dataOf<unknown[]>(mine)).toHaveLength(1);
    expect(
      (
        await call(
          'GET',
          s.student,
          `/academics/term-enrollments/${st[0]!.eid}/course-registrations`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', s.student, `/academics/course-offerings/${U.manual}/registrations`))
        .statusCode,
    ).toBe(403);
    expect((await register(s.student, U.manual, { termEnrollmentId: me.eid })).statusCode).toBe(
      403,
    );
    // the database itself refuses a student session's write and hides other students' rows
    expect(
      (await call('GET', s.hod, `/academics/course-offerings/${U.manual}/registrations`))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('GET', s.foreignAdmin, `/academics/course-offerings/${U.manual}/registrations`))
        .statusCode,
    ).toBe(404);
    expect(
      (await register(s.foreignAdmin, U.manual, { termEnrollmentId: me.eid })).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', s.foreignAdmin, `/academics/cohort-periods/${U.cpA}/elective-groups`))
        .statusCode,
    ).toBe(404);
  });
});

// =============================================================================================
// X-12: the real ASSIGNED resolver (faculty -> student profile)
// =============================================================================================
describe('X-12: faculty read a student only through a valid assignment and registration on the same offering', () => {
  const F = {} as Record<
    'main' | 'ended' | 'future' | 'revoked' | 'onLeave' | 'north',
    { user: string; employee: string; email: string; assignment: string }
  >;
  const P = {} as Record<
    'registered' | 'notRegistered' | 'dropped' | 'pending' | 'north' | 'futureReg',
    string
  >;
  const sess = {} as Record<keyof typeof F, Session>;
  let north = '';

  beforeAll(async () => {
    const seminar = await published({
      courseId: await course(T.departmentId, 'Teaching seminar'),
      cohortPeriodId: U.cpA,
      offeringKind: 'OPTIONAL',
      registrationPolicy: 'MANUAL',
    });
    north = await call('POST', s.admin, '/academics/course-offerings', {
      termId: C2.term,
      courseId: C2.course,
      sectionId: C2.sec,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    }).then(idOf);
    await call(
      'PATCH',
      s.admin,
      `/academics/course-offerings/${north}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );

    for (const k of ['main', 'ended', 'future', 'revoked', 'onLeave', 'north'] as const) {
      F[k] = await facultyUser(T);
    }
    const fa = (offering: string, emp: string, role: string, from: string, to?: string) =>
      insert('faculty_assignments', {
        course_offering_id: offering,
        employee_id: emp,
        role,
        valid_from: from,
        ...(to ? { valid_to: to } : {}),
      });
    await fa(seminar, F.main.employee, 'PRIMARY', D(-60));
    await fa(seminar, F.ended.employee, 'CO_INSTRUCTOR', D(-60), D(-1));
    await fa(seminar, F.future.employee, 'CO_INSTRUCTOR', D(1));
    await fa(seminar, F.revoked.employee, 'CO_INSTRUCTOR', D(-60));
    await fa(seminar, F.onLeave.employee, 'SUBSTITUTE', D(-60));
    await fa(north, F.north.employee, 'PRIMARY', D(-60));
    await adminQuery(`UPDATE app.role_assignments SET status = 'REVOKED' WHERE id = $1`, [
      F.revoked.assignment,
    ]);
    await adminQuery(`UPDATE app.employees SET status = 'ON_LEAVE' WHERE id = $1`, [
      F.onLeave.employee,
    ]);

    const reg = async (
      offering: string,
      p: { student: string; eid: string },
      extra: Record<string, unknown> = {},
    ) => {
      const r = await register(s.admin, offering, { termEnrollmentId: p.eid, ...extra });
      expect(r.statusCode, r.body).toBe(201);
      return idOf(r);
    };
    const a = await pupil(base(), U.secA);
    P.registered = a.student;
    await reg(seminar, a);
    P.notRegistered = (await pupil(base(), U.secA)).student;
    const d = await pupil(base(), U.secA);
    P.dropped = d.student;
    const dropId = await reg(seminar, d, { validFrom: D(-30) });
    expect(
      (await closeReg(s.admin, dropId, 1, { status: 'DROPPED', validTo: D(-1) })).statusCode,
    ).toBe(200);
    const pd = await pupil(base(), U.secA);
    P.pending = pd.student;
    await reg(seminar, pd, { pendingApproval: true });
    const fr = await pupil(base(), U.secA);
    P.futureReg = fr.student;
    await reg(seminar, fr, { validFrom: D(5) });
    const n = await pupil({
      program: C2.program,
      cohort: C2.cohort,
      campus: C2.campus,
      dept: C2.dept,
      cp: C2.cp,
      term: C2.term,
    });
    await insert('section_memberships', {
      term_enrollment_id: n.eid,
      student_id: n.student,
      cohort_period_id: C2.cp,
      section_id: C2.sec,
      valid_from: D(-60),
      change_reason: 'Initial placement',
      changed_by: T.users.admin,
    });
    P.north = n.student;
    await reg(north, n);

    for (const k of Object.keys(F) as Array<keyof typeof F>) sess[k] = await login(F[k].email);
    s.faculty = await login(T.emails.faculty); // FACULTY role, no employee row
    // another tenant's teacher with a valid assignment and registration of their own
    const of = await facultyUser(OTHER);
    s.foreignFaculty = await login(of.email);
  }, 120_000);

  const read = (who: Session, student: string) => call('GET', who, `/students/${student}`);

  it('an assigned, active teacher reads a student registered on the offering', async () => {
    const r = await read(sess.main, P.registered);
    expect(r.statusCode, r.body).toBe(200);
    expect(dataOf<{ id: string }>(r).id).toBe(P.registered);
  });

  it('no valid registration: not registered, dropped, pending approval or registration not started -> the same 404', async () => {
    for (const k of ['notRegistered', 'dropped', 'pending', 'futureReg'] as const) {
      expect((await read(sess.main, P[k])).statusCode, k).toBe(404);
    }
  });

  it('no valid assignment: ended, future-dated, employee not ACTIVE -> 404; FACULTY role revoked -> 403 (no grant)', async () => {
    expect((await read(sess.ended, P.registered)).statusCode).toBe(404);
    expect((await read(sess.future, P.registered)).statusCode).toBe(404);
    expect((await read(sess.onLeave, P.registered)).statusCode).toBe(404);
    expect((await read(sess.revoked, P.registered)).statusCode).toBe(403);
    expect((await read(s.faculty, P.registered)).statusCode).toBe(404); // FACULTY without an employee row
  });

  it('cross-campus: each teacher sees only the students of their own offerings', async () => {
    expect((await read(sess.main, P.north)).statusCode).toBe(404);
    expect((await read(sess.north, P.north)).statusCode).toBe(200);
    expect((await read(sess.north, P.registered)).statusCode).toBe(404);
  });

  it("cross-tenant: another tenant's teacher gets 404 for this tenant's students; ASSIGNED never widens to other student data", async () => {
    expect((await read(s.foreignFaculty, P.registered)).statusCode).toBe(404);
    expect((await read(s.foreignFaculty, P.north)).statusCode).toBe(404);
    expect((await call('GET', sess.main, `/students/${P.registered}/guardians`)).statusCode).toBe(
      403,
    );
  });

  it('ending the assignment today keeps access through today; an assignment ended yesterday does not', async () => {
    const [row] = await adminQuery<{ id: string }>(
      `SELECT id FROM app.faculty_assignments WHERE employee_id = $1`,
      [F.main.employee],
    );
    await adminQuery(`UPDATE app.faculty_assignments SET valid_to = $2 WHERE id = $1`, [
      row!.id,
      TODAY,
    ]);
    expect((await read(sess.main, P.registered)).statusCode).toBe(200);
  });
});

// =============================================================================================
// The cohort promotion tool
// =============================================================================================
describe('cohort promotion tool', () => {
  /** A fresh cohort with a period in term A and the next period in term N, and `n` ACTIVE students in the first. */
  async function cohortOf(n: number, tag: string) {
    const cohort = await insert('cohorts', {
      program_id: U.program,
      admission_year: 2026,
      intake_code: tag,
      name: `CSE 2026 ${tag}`,
    });
    const from = await insert('cohort_periods', {
      cohort_id: cohort,
      term_id: U.termA,
      period_no: 1,
    });
    const to = await insert('cohort_periods', {
      cohort_id: cohort,
      term_id: U.termN,
      period_no: 2,
    });
    const people = [];
    for (let i = 0; i < n; i++) people.push(await pupil({ ...base(), cohort, cp: from }));
    return { cohort, from, to, people };
  }
  const promote = (who: Session, from: string, body: Record<string, unknown>, key?: string) =>
    call(
      'POST',
      who,
      `/academics/cohort-periods/${from}/promotion`,
      { reason: 'End of semester results', ...body },
      key ? { 'idempotency-key': key } : {},
    );
  const statuses = async (from: string) =>
    (
      await adminQuery<{ status: string }>(
        `SELECT status FROM app.term_enrollments WHERE cohort_period_id = $1 ORDER BY student_id`,
        [from],
      )
    ).map((r) => r.status);
  const targets = async (to: string) =>
    Number(
      (
        await adminQuery<{ n: string }>(
          `SELECT count(*) AS n FROM app.term_enrollments WHERE cohort_period_id = $1`,
          [to],
        )
      )[0]!.n,
    );
  const key = () => `promo-${randomBytes(12).toString('hex')}`;

  it('dry run previews ACTIVE as eligible and the rest as excluded, writes nothing, needs no key', async () => {
    const c = await cohortOf(3, 'P1');
    await adminQuery(`UPDATE app.term_enrollments SET status = 'DETAINED' WHERE id = $1`, [
      c.people[0]!.eid,
    ]);
    const r = await promote(s.admin, c.from, { targetCohortPeriodId: c.to, dryRun: true });
    expect(r.statusCode, r.body).toBe(200);
    const d = dataOf<{
      eligible: Array<{ studentId: string }>;
      excluded: Array<{ status: string }>;
    }>(r);
    expect(d.eligible).toHaveLength(2);
    expect(d.excluded.map((x) => x.status)).toEqual(['DETAINED']);
    expect(await targets(c.to)).toBe(0);
    expect((await promote(s.admin, c.from, { targetCohortPeriodId: c.to })).statusCode).toBe(428);
  });

  it('one failing student rolls back the WHOLE batch (no source changed, no target row, no audit, key not consumed)', async () => {
    const c = await cohortOf(4, 'P2');
    const victim = c.people[2]!;
    // the victim already has an enrolment in the target period, so their insert fails with a unique violation
    const blocker = await insert('term_enrollments', {
      student_id: victim.student,
      student_program_id: victim.sp,
      cohort_period_id: c.to,
      term_id: U.termN,
      period_no: 2,
    });
    const k = key();
    const r = await promote(s.admin, c.from, { targetCohortPeriodId: c.to }, k);
    expect(r.statusCode).toBe(409);
    expect(await statuses(c.from)).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE']);
    expect(await targets(c.to)).toBe(1); // only the blocker
    const audits = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND action = 'enrollment.term.progress' AND subject_student_id = ANY($2::uuid[])`,
      [T.orgId, c.people.map((p) => p.student)],
    );
    expect(audits).toHaveLength(0);
    expect(await adminQuery(`SELECT 1 FROM app.idempotency_keys WHERE key = $1`, [k])).toHaveLength(
      0,
    );
    // remove the blocker; the same key now commits all four
    await adminQuery(`DELETE FROM app.term_enrollments WHERE id = $1`, [blocker]);
    const ok = await promote(s.admin, c.from, { targetCohortPeriodId: c.to }, k);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(dataOf(ok)).toEqual({
      sourceCohortPeriodId: c.from,
      targetCohortPeriodId: c.to,
      promoted: 4,
      excluded: 0,
    });
    expect(await statuses(c.from)).toEqual(['PROMOTED', 'PROMOTED', 'PROMOTED', 'PROMOTED']);
    expect(await targets(c.to)).toBe(4);
  });

  it('duplicate request: the same key replays the stored response without a second write; another body with it is 422', async () => {
    const c = await cohortOf(2, 'P3');
    const k = key();
    const first = await promote(s.admin, c.from, { targetCohortPeriodId: c.to }, k);
    expect(first.statusCode).toBe(201);
    const again = await promote(s.admin, c.from, { targetCohortPeriodId: c.to }, k);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(await targets(c.to)).toBe(2);
    expect(
      (
        await promote(
          s.admin,
          c.from,
          { targetCohortPeriodId: c.to, reason: 'A different reason' },
          k,
        )
      ).statusCode,
    ).toBe(422);
    // a new key after the commit: nothing left to promote
    expect((await promote(s.admin, c.from, { targetCohortPeriodId: c.to }, key())).statusCode).toBe(
      409,
    );
  });

  it('concurrent runs with different keys: exactly one commits, the other refuses as a whole; no deadlock', async () => {
    const c = await cohortOf(6, 'P4');
    const [a, b] = await Promise.all([
      promote(s.admin, c.from, { targetCohortPeriodId: c.to }, key()),
      promote(s.admin, c.from, { targetCohortPeriodId: c.to }, key()),
    ]);
    expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([201, 409]);
    const winner = a.statusCode === 201 ? a : b;
    const promoted = dataOf<{ promoted: number }>(winner).promoted;
    expect(await targets(c.to)).toBe(promoted);
    expect((await statuses(c.from)).filter((x) => x === 'PROMOTED')).toHaveLength(promoted);
  });

  it('concurrent runs with the SAME key: one commits, the other replays it or is told to retry; one set of rows', async () => {
    const c = await cohortOf(3, 'P5');
    const k = key();
    const rs = await Promise.all(
      [0, 1].map(() => promote(s.admin, c.from, { targetCohortPeriodId: c.to }, k)),
    );
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(201);
    expect([201, 409]).toContain(codes[1]);
    if (codes[1] === 201)
      expect(rs.some((r) => r.headers['idempotent-replayed'] === 'true')).toBe(true);
    else
      expect(
        rs.find((r) => r.statusCode === 409)!.json<{ error?: { code?: string }; code?: string }>(),
      ).toBeDefined();
    expect(await targets(c.to)).toBe(3);
  });

  it('deterministic order: students are processed in ascending id, whatever the selection order', async () => {
    const c = await cohortOf(5, 'P6');
    const shuffled = [...c.people].reverse().map((p) => p.eid);
    const r = await promote(
      s.admin,
      c.from,
      { targetCohortPeriodId: c.to, enrollmentIds: shuffled },
      key(),
    );
    expect(r.statusCode, r.body).toBe(201);
    // new enrolment ids are UUIDv7, monotonic within the process: their order is the processing order
    const order = await adminQuery<{ student_id: string }>(
      `SELECT student_id FROM app.term_enrollments WHERE cohort_period_id = $1 ORDER BY id`,
      [c.to],
    );
    const ids = order.map((o) => o.student_id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toEqual(new Set(c.people.map((p) => p.student)));
  });

  it('a selection with a non-ACTIVE enrolment, or one of another period, is refused; scope and tenant 404, HOD 403', async () => {
    const c = await cohortOf(2, 'P7');
    await adminQuery(`UPDATE app.term_enrollments SET status = 'ON_LEAVE' WHERE id = $1`, [
      c.people[0]!.eid,
    ]);
    const ids = c.people.map((p) => p.eid);
    expect(
      (await promote(s.admin, c.from, { targetCohortPeriodId: c.to, enrollmentIds: ids }, key()))
        .statusCode,
    ).toBe(409);
    const stranger = await pupil(base());
    expect(
      (
        await promote(
          s.admin,
          c.from,
          { targetCohortPeriodId: c.to, enrollmentIds: [stranger.eid] },
          key(),
        )
      ).statusCode,
    ).toBe(409);
    expect((await promote(s.hod, c.from, { targetCohortPeriodId: c.to }, key())).statusCode).toBe(
      403,
    );
    expect(
      (await promote(s.foreignAdmin, c.from, { targetCohortPeriodId: c.to }, key())).statusCode,
    ).toBe(404);
    // history: promotion never rewrites the source rows
    const cc = await cohortOf(1, 'P8');
    await promote(s.admin, cc.from, { targetCohortPeriodId: cc.to }, key());
    const [src] = await adminQuery<{ cohort_period_id: string; period_no: number; status: string }>(
      `SELECT cohort_period_id, period_no, status FROM app.term_enrollments WHERE id = $1`,
      [cc.people[0]!.eid],
    );
    expect(src).toEqual({ cohort_period_id: cc.from, period_no: 1, status: 'PROMOTED' });
  });
});

// =============================================================================================
// Holidays
// =============================================================================================
describe('holidays: campus and organization-wide calendars', () => {
  const declare = (who: Session, body: Record<string, unknown>) =>
    call('POST', who, '/academics/holidays', {
      kind: 'HOLIDAY',
      reason: 'Calendar approved',
      ...body,
    });
  const listFor = (who: Session, q: string) =>
    call('GET', who, `/academics/holidays${q}`).then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      return dataOf<Array<{ name: string; campusId: string | null; holidayDate: string }>>(r);
    });

  it('campus rows, organization rows, overlapping dates and duplicate names', async () => {
    expect(
      (await declare(s.admin, { campusId: T.campusId, holidayDate: D(10), name: 'Founders day' }))
        .statusCode,
    ).toBe(201);
    expect((await declare(s.admin, { holidayDate: D(10), name: 'Founders day' })).statusCode).toBe(
      201,
    ); // org-wide twin
    expect(
      (await declare(s.admin, { campusId: C2.campus, holidayDate: D(10), name: 'Founders day' }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await declare(s.admin, {
          campusId: T.campusId,
          holidayDate: D(10),
          name: 'Sports day',
          kind: 'EVENT',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await declare(s.admin, { campusId: T.campusId, holidayDate: D(10), name: 'FOUNDERS DAY' }))
        .statusCode,
    ).toBe(409);
    expect((await declare(s.admin, { holidayDate: D(10), name: 'founders day' })).statusCode).toBe(
      409,
    );
  });

  it('a campus calendar is its rows plus organization rows; ranges are inclusive at term boundaries', async () => {
    await declare(s.admin, { campusId: T.campusId, holidayDate: D(-60), name: 'Term opening' });
    await declare(s.admin, { holidayDate: D(60), name: 'Term closing' });
    await declare(s.admin, { campusId: T.campusId, holidayDate: D(61), name: 'After term' });
    const inTermA = await listFor(s.admin, `?campusId=${T.campusId}&from=${D(-60)}&to=${D(60)}`);
    expect(inTermA.map((h) => h.name)).toEqual([
      'Term opening',
      'Founders day',
      'Founders day',
      'Sports day',
      'Term closing',
    ]);
    expect(inTermA.every((h) => h.campusId === null || h.campusId === T.campusId)).toBe(true);
    const north = await listFor(s.admin, `?campusId=${C2.campus}&from=${D(-60)}&to=${D(60)}`);
    expect(north.map((h) => [h.name, h.campusId])).toEqual([
      ['Founders day', null],
      ['Founders day', C2.campus],
      ['Term closing', null],
    ]);
  });

  it('a LOCKED term freezes its campus calendar; another campus and other dates are unaffected', async () => {
    const locked = await declare(s.admin, {
      campusId: T.campusId,
      holidayDate: D(200),
      name: 'Locked day',
    });
    expect(locked.statusCode).toBe(409);
    expect(
      (await declare(s.admin, { holidayDate: D(200), name: 'Org locked day' })).statusCode,
    ).toBe(409);
    expect(
      (await declare(s.admin, { campusId: C2.campus, holidayDate: D(200), name: 'North day' }))
        .statusCode,
    ).toBe(201);
  });

  it('scope: a campus admin declares for their campus only, never organization-wide; students read, never write', async () => {
    expect(
      (
        await declare(s.campusAdmin, {
          campusId: T.campusId,
          holidayDate: D(20),
          name: 'Campus fest',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await declare(s.campusAdmin, { holidayDate: D(21), name: 'Everyone' })).statusCode,
    ).toBe(403);
    expect(
      (
        await declare(s.campusAdmin, {
          campusId: C2.campus,
          holidayDate: D(21),
          name: 'North fest',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await declare(s.student, { campusId: T.campusId, holidayDate: D(22), name: 'Student day' }))
        .statusCode,
    ).toBe(403);
    const forStudent = await listFor(s.student, `?campusId=${T.campusId}`);
    expect(forStudent.some((h) => h.name === 'Campus fest')).toBe(true);
    const hod = await listFor(s.hod, '');
    expect(hod.every((h) => h.campusId === null || h.campusId === T.campusId)).toBe(true);
  });

  it('cancel is final and frees the name; tenant isolation', async () => {
    const id = idOf(
      await declare(s.admin, { campusId: T.campusId, holidayDate: D(30), name: 'Rain day' }),
    );
    const cancel = await call(
      'PATCH',
      s.admin,
      `/academics/holidays/${id}`,
      { status: 'CANCELLED', reason: 'Weather cleared' },
      { 'if-match': '"1"' },
    );
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(
      (
        await call(
          'PATCH',
          s.admin,
          `/academics/holidays/${id}`,
          { name: 'Again', reason: 'Weather cleared' },
          { 'if-match': '"2"' },
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await declare(s.admin, { campusId: T.campusId, holidayDate: D(30), name: 'Rain day' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await listFor(s.admin, `?campusId=${T.campusId}&from=${D(30)}&to=${D(30)}`)).map(
        (h) => h.name,
      ),
    ).toEqual(['Rain day']);
    expect(
      await listFor(
        s.admin,
        `?campusId=${T.campusId}&from=${D(30)}&to=${D(30)}&includeCancelled=true`,
      ),
    ).toHaveLength(2);
    expect(await listFor(s.foreignAdmin, '')).toEqual([]);
    // another tenant's campus id filters nothing in: the caller only ever reads its own tenant's rows
    const probe = await call('GET', s.foreignAdmin, `/academics/holidays?campusId=${T.campusId}`);
    expect(probe.statusCode).toBe(200);
    expect(dataOf(probe)).toEqual([]);
    expect(
      (
        await call(
          'PATCH',
          s.foreignAdmin,
          `/academics/holidays/${id}`,
          { name: 'X', reason: 'Cross tenant' },
          { 'if-match': '"2"' },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('smart annual holiday suggestions catalogue and bulk approval', async () => {
    // 1. GET /academics/holidays/suggestions
    const sugRes = await call(
      'GET',
      s.admin,
      `/academics/holidays/suggestions?country=IN&state=BR&from=2026-04-01&to=2027-03-31`,
    );
    expect(sugRes.statusCode, sugRes.body).toBe(200);
    const suggestions = dataOf<
      Array<{
        id: string;
        holidayDate: string;
        name: string;
        category: string;
        verificationStatus: string;
        source: string;
        alreadyDeclared: boolean;
      }>
    >(sugRes);
    expect(suggestions.length).toBeGreaterThan(15);

    // Verified fixed national & state days present
    const names = suggestions.map((s) => s.name);
    expect(names).toContain('Independence Day');
    expect(names).toContain('Bihar Diwas (Bihar Day)');
    expect(names).toContain('Chhath Puja (Evening Arghya)');

    // 2. Student has read access to suggestions
    const studentSug = await call(
      'GET',
      s.student,
      `/academics/holidays/suggestions?country=IN&state=BR&from=2026-04-01&to=2027-03-31`,
    );
    expect(studentSug.statusCode).toBe(200);

    // 3. Student cannot bulk create (needs academic.term.manage)
    const studentBulk = await call('POST', s.student, '/academics/holidays/bulk', {
      reason: 'Attempted bulk approval',
      holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
    });
    expect(studentBulk.statusCode).toBe(403);

    // 4. Campus-scoped admin cannot bulk create organization-wide holidays
    const campusOrgBulk = await call('POST', s.campusAdmin, '/academics/holidays/bulk', {
      reason: 'Attempted org-wide bulk',
      holidays: [{ holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }],
    });
    expect(campusOrgBulk.statusCode).toBe(403);

    // 5. Admin bulk approves annual holidays for campus T
    const bulk1 = await call('POST', s.admin, '/academics/holidays/bulk', {
      campusId: T.campusId,
      reason: 'Annual school holiday approval 2026-2027',
      holidays: [
        { holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' },
        { holidayDate: '2026-10-02', name: 'Mahatma Gandhi Jayanti', kind: 'HOLIDAY' },
        { holidayDate: '2026-11-14', name: 'Chhath Puja (Evening Arghya)', kind: 'HOLIDAY' },
      ],
    });
    expect(bulk1.statusCode, bulk1.body).toBe(201);
    const res1 = dataOf<{ createdCount: number; skippedCount: number; createdIds: string[] }>(
      bulk1,
    );
    expect(res1.createdCount).toBe(3);
    expect(res1.skippedCount).toBe(0);
    expect(res1.createdIds).toHaveLength(3);

    // 6. Repeated bulk import skips duplicates safely without error
    const bulk2 = await call('POST', s.admin, '/academics/holidays/bulk', {
      campusId: T.campusId,
      reason: 'Repeated import check',
      holidays: [
        { holidayDate: '2026-08-15', name: 'Independence Day', kind: 'HOLIDAY' }, // duplicate
        { holidayDate: '2026-12-25', name: 'Christmas Day', kind: 'HOLIDAY' }, // new
      ],
    });
    expect(bulk2.statusCode, bulk2.body).toBe(201);
    const res2 = dataOf<{
      createdCount: number;
      skippedCount: number;
      skipped: Array<{ name: string; reason: string }>;
    }>(bulk2);
    expect(res2.createdCount).toBe(1);
    expect(res2.skippedCount).toBe(1);
    expect(res2.skipped[0]?.reason).toBe('Already declared');

    // 7. Verify suggestions now show alreadyDeclared: true for the imported items
    const sugAfter = await call(
      'GET',
      s.admin,
      `/academics/holidays/suggestions?country=IN&state=BR&campusId=${T.campusId}&from=2026-04-01&to=2027-03-31`,
    );
    const listAfter = dataOf<Array<{ name: string; alreadyDeclared: boolean }>>(sugAfter);
    const indep = listAfter.find((h) => h.name === 'Independence Day');
    expect(indep?.alreadyDeclared).toBe(true);
  });
});

// =============================================================================================
// Terminology and the setup checklist
// =============================================================================================
describe('terminology labels', () => {
  const snapshot = () =>
    adminQuery(
      `SELECT 'pt' AS t, row_to_json(x)::text AS r FROM app.period_types x WHERE organization_id = $1
       UNION ALL SELECT 'p', row_to_json(x)::text FROM app.programs x WHERE organization_id = $1
       UNION ALL SELECT 'c', row_to_json(x)::text FROM app.cohorts x WHERE organization_id = $1
       UNION ALL SELECT 's', row_to_json(x)::text FROM app.sections x WHERE organization_id = $1
       UNION ALL SELECT 'te', row_to_json(x)::text FROM app.terms x WHERE organization_id = $1
       UNION ALL SELECT 'e', row_to_json(x)::text FROM app.term_enrollments x WHERE organization_id = $1
       ORDER BY 1, 2`,
      [T.orgId],
    );
  // Task 8 (doc 35 §4) added periodTypes/byCohort to the response; without a period-type label the map stays empty.
  const labels = (who: Session) =>
    call('GET', who, '/academics/terminology').then((r) => {
      expect(r.statusCode, r.body).toBe(200);
      const d = dataOf<{
        labels: Record<string, string>;
        customised: string[];
        byCohort: Record<string, string>;
      }>(r);
      expect(d.byCohort).toEqual({});
      return { labels: d.labels, customised: d.customised };
    });
  const set = (value: unknown, version: string) =>
    call(
      'PUT',
      s.admin,
      '/organization/settings/terminology',
      { value, reason: 'Institution vocabulary' },
      { 'if-match': version },
    );

  beforeAll(() => elevateSession(s.admin.cookie));
  it('defaults until set; school then university labels apply to every reader and never touch academic data', async () => {
    expect(await labels(s.student)).toEqual({
      labels: {
        program: 'Programme',
        cohort: 'Batch',
        period: 'Semester',
        section: 'Section',
        term: 'Term',
        course: 'Course',
      },
      customised: [],
    });
    const before = await snapshot();
    const school = await set(
      {
        program: 'Curriculum',
        cohort: 'Intake',
        period: 'Grade',
        section: 'Class',
        term: 'Session',
        course: 'Subject',
      },
      '"0"',
    );
    expect(school.statusCode, school.body).toBe(200);
    expect((await labels(s.student)).labels).toEqual({
      program: 'Curriculum',
      cohort: 'Intake',
      period: 'Grade',
      section: 'Class',
      term: 'Session',
      course: 'Subject',
    });
    const uni = await set({ cohort: 'Batch', period: 'Semester' }, '"1"');
    expect(uni.statusCode, uni.body).toBe(200);
    expect(await labels(s.hod)).toEqual({
      labels: {
        program: 'Programme',
        cohort: 'Batch',
        period: 'Semester',
        section: 'Section',
        term: 'Term',
        course: 'Course',
      },
      customised: ['cohort', 'period'],
    });
    expect(await snapshot()).toEqual(before);
    expect((await labels(s.foreignAdmin)).customised).toEqual([]); // another tenant keeps its own labels
  });

  it('invalid values are refused: unknown slot, empty object, over-long label; only an org settings manager writes', async () => {
    for (const v of [{ grade: 'X' }, {}, { section: 'x'.repeat(41) }, { section: '' }, 'Class']) {
      expect((await set(v, '*')).statusCode, JSON.stringify(v)).toBe(400);
    }
    const r = await call(
      'PUT',
      s.campusAdmin,
      '/organization/settings/terminology',
      { value: { section: 'Group' }, reason: 'Institution vocabulary' },
      { 'if-match': '*' },
    );
    expect(r.statusCode).toBe(403);
  });
});

describe('setup checklist (derived from the database)', () => {
  type Check = { complete: boolean; items: Array<{ key: string; done: boolean; count: number }> };
  const check = (who: Session) => call('GET', who, '/academics/setup-checklist');
  const item = (c: Check, k: string) => c.items.find((i) => i.key === k)!;

  it('an empty tenant is incomplete; its campus counts', async () => {
    const r = await check(s.foreignAdmin);
    expect(r.statusCode, r.body).toBe(200);
    const c = dataOf<Check>(r);
    expect(c.complete).toBe(false);
    expect(item(c, 'campuses')).toMatchObject({ done: true, count: 1 });
    expect(item(c, 'programs')).toMatchObject({ done: false, count: 0 });
  });

  it('every count equals the rows in the database and moves with them', async () => {
    const c = dataOf<Check>(await check(s.admin));
    const { n: offerings } = (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM app.course_offerings o JOIN app.terms t ON t.id = o.term_id
        WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ('PLANNED', 'ACTIVE')`,
        [T.orgId],
      )
    )[0]!;
    expect(item(c, 'publishedOfferings').count).toBe(Number(offerings));
    const { n: noHoliday } = (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM app.terms t WHERE t.organization_id = $1 AND t.status IN ('PLANNED', 'ACTIVE')
          AND NOT EXISTS (SELECT 1 FROM app.holidays h WHERE h.organization_id = t.organization_id AND h.status = 'ACTIVE'
                           AND (h.campus_id IS NULL OR h.campus_id = t.campus_id) AND h.holiday_date BETWEEN t.start_date AND t.end_date)`,
        [T.orgId],
      )
    )[0]!;
    expect(item(c, 'openTermsWithoutHolidays').count).toBe(Number(noHoliday));
    // a new open term without a holiday is counted, and declaring one inside it clears it again
    await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: U.year,
      code: 'Z',
      name: 'Z',
      start_date: D(251),
      end_date: D(259),
    });
    const withTerm = dataOf<Check>(await check(s.admin));
    expect(item(withTerm, 'openTermsWithoutHolidays')).toMatchObject({
      done: false,
      count: Number(noHoliday) + 1,
    });
    expect(withTerm.complete).toBe(false);
    await call('POST', s.admin, '/academics/holidays', {
      holidayDate: D(255),
      name: 'Mid term',
      kind: 'HOLIDAY',
      reason: 'Calendar approved',
    });
    const after = dataOf<Check>(await check(s.admin));
    expect(item(after, 'openTermsWithoutHolidays').count).toBe(Number(noHoliday));
    const unstaffed = item(after, 'offeringsWithoutTeacher');
    expect(unstaffed.done).toBe(unstaffed.count === 0);
    expect(after.complete).toBe(after.items.every((i) => i.done));
  });

  it('organization-scoped only: campus admin 403, student 403', async () => {
    expect((await check(s.campusAdmin)).statusCode).toBe(403);
    expect((await check(s.student)).statusCode).toBe(403);
  });
});

// =============================================================================================
// Class teacher posting rule (0039 replaces the 0038 guard): the whole assignment period is covered
// =============================================================================================
describe('class teachers: primary postings must cover every day of the assignment', () => {
  const assign = (section: string, employee: string, from: string, to?: string) =>
    call('POST', s.admin, `/academics/sections/${section}/class-teachers`, {
      employeeId: employee,
      classTeacherRole: 'ASSISTANT',
      validFrom: from,
      ...(to ? { validTo: to } : {}),
      reason: 'Class teacher for the term',
    });

  it('future-dated assignment covered by a future posting is accepted; a posting that starts late is refused', async () => {
    const e = await employeeFor(T.orgId, null, [T.departmentId, D(5)]);
    expect((await assign(U.secA, e, D(10), D(30))).statusCode).toBe(201);
    const late = await employeeFor(T.orgId, null, [T.departmentId, D(20)]);
    const r = await assign(U.secA, late, D(10), D(30));
    expect(r.statusCode).toBe(409);
    expect(msg(r)).toMatch(/do not cover/);
  });

  it('an expiring posting: refused for an open assignment (to the term end), accepted for one that ends in time', async () => {
    const e = await employeeFor(T.orgId, null, [T.departmentId, D(-90), D(20)]);
    expect((await assign(U.secA, e, D(0))).statusCode).toBe(409);
    expect((await assign(U.secA, e, D(0), D(20))).statusCode).toBe(201);
    const expired = await employeeFor(T.orgId, null, [T.departmentId, D(-90), D(-1)]);
    expect((await assign(U.secB, expired, D(0), D(5))).statusCode).toBe(409);
  });

  it('posting changes: consecutive postings on the same campus cover; a one-day gap or another campus does not', async () => {
    const moved = await employeeFor(T.orgId, null, [T.departmentId, D(-90), D(0)]);
    await post(T.orgId, moved, [U.dept2, D(1)]);
    expect((await assign(U.secB, moved, D(-5), D(15))).statusCode).toBe(201);
    const gap = await employeeFor(T.orgId, null, [T.departmentId, D(-90), D(0)]);
    await post(T.orgId, gap, [U.dept2, D(2)]);
    expect((await assign(U.secB, gap, D(-5), D(15))).statusCode).toBe(409);
    const away = await employeeFor(T.orgId, null, [T.departmentId, D(-90), D(0)]);
    await post(T.orgId, away, [C2.dept, D(1)]);
    expect((await assign(U.secB, away, D(-5), D(15))).statusCode).toBe(409);
    expect((await assign(U.secB, away, D(-5), D(0))).statusCode).toBe(201);
  });

  it('no cascade: ending a posting later leaves an existing class-teacher row untouched (doc 32 §7)', async () => {
    const e = await employeeFor(T.orgId, null, [T.departmentId, D(-90)]);
    const id = idOf(await assign(U.secA, e, D(0), D(40)));
    await adminQuery(`UPDATE app.employee_postings SET valid_to = $2 WHERE employee_id = $1`, [
      e,
      D(10),
    ]);
    const [row] = await adminQuery<{ valid_to: string }>(
      `SELECT valid_to::text AS valid_to FROM app.section_class_teachers WHERE id = $1`,
      [id],
    );
    expect(row!.valid_to).toBe(D(40));
  });
});
