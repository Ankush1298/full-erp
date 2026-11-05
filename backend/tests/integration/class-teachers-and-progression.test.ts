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

// Migration 0038 (doc 32) over HTTP, in one private tenant with a SCHOOL campus (12-grade programme, two G1 intakes a
// year apart, annual sessions 2025-26 .. 2027-28) and the UNIVERSITY campus of the tenant (B.Tech, semesters, cohorts
// 2025 and 2026): class teachers of sections, promotion, repeating a grade / a year-back, history, duplicate and
// concurrent enrolment, scope and tenant isolation, privileged writers, and the B6 student-profile scope. Structure,
// employee and student rows are fixtures inserted as the harness superuser (the guards still run).

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

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
interface Session {
  cookie: string;
  csrf: string;
}
const s = {} as Record<
  'admin' | 'campusAdmin' | 'registrarCampus' | 'hod' | 'student' | 'foreignAdmin',
  Session
>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

/** School: campus, department, programme, cohorts A (G1 2020) and B (G1 2021), sessions, cohort periods, sections. */
const SC = {} as Record<
  | 'campus'
  | 'dept'
  | 'program'
  | 'cohortA'
  | 'cohortB'
  | 's25'
  | 's26'
  | 's27'
  | 'a6'
  | 'a7'
  | 'b6'
  | 'b7'
  | 'b6A'
  | 'b6B'
  | 'a7A'
  | 'a6A',
  string
>;
/** University (T.campusId): B.Tech cohorts 2025 and 2026, ODD 2025, ODD 2026, EVEN 2027, and a clash cohort. */
const U = {} as Record<
  | 'program'
  | 'c25'
  | 'c26'
  | 'cX'
  | 'odd25'
  | 'odd26'
  | 'even27'
  | 'p25s1'
  | 'p26s1'
  | 'p26s2'
  | 'pXs1',
  string
>;
const E = {} as Record<
  'ct1' | 'ct2' | 'ct3' | 'onLeave' | 'separated' | 'unposted' | 'uni' | 'ended' | 'future',
  string
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
  method: 'GET' | 'POST' | 'PATCH',
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

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
  const vals = [
    id,
    T.orgId,
    ...Object.entries(row)
      .filter(([k]) => k !== 'id')
      .map(([, v]) => v),
  ];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  return id;
}
async function account(): Promise<string> {
  const user = uuidv7();
  const email = `cp-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Person', 'ACTIVE', $1)`,
    [user, T.orgId, email],
  );
  return user;
}
/** An employee; `posting` = [department, valid_from, valid_to?] of an active primary posting, or null. */
async function employee(
  posting: [string, string, string?] | null,
  status: 'ACTIVE' | 'ON_LEAVE' | 'SEPARATED' = 'ACTIVE',
): Promise<string> {
  const id = await insert('employees', {
    user_id: await account(),
    employee_code: code('E'),
    employee_type: 'FACULTY',
    joining_date: '2024-06-01',
    status,
    ...(status === 'SEPARATED' ? { leaving_date: '2026-05-31' } : {}),
  });
  if (posting) {
    await insert('employee_postings', {
      employee_id: id,
      department_id: posting[0],
      valid_from: posting[1],
      is_primary: true,
      ...(posting[2] ? { valid_to: posting[2] } : {}),
    });
  }
  return id;
}
/** A student with an ACTIVE programme enrolment in `cohort`. */
async function pupil(program: string, cohort: string, campus: string, dept: string) {
  const student = await insert('students', {
    user_id: await account(),
    admission_number: code('ADM'),
    admission_date: '2020-06-01',
    status: 'ACTIVE',
  });
  const sp = await insert('student_programs', {
    student_id: student,
    program_id: program,
    cohort_id: cohort,
    campus_id: campus,
    department_id: dept,
    start_date: '2020-06-01',
    status: 'ACTIVE',
  });
  return { student, sp };
}
/** An ACTIVE term enrolment (fixture: inserted REGISTERED, then activated, as the state machine requires). */
async function enrolled(
  p: { student: string; sp: string },
  cp: string,
  term: string,
  periodNo: number,
) {
  const id = await insert('term_enrollments', {
    student_id: p.student,
    student_program_id: p.sp,
    cohort_period_id: cp,
    term_id: term,
    period_no: periodNo,
  });
  await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [id]);
  return id;
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);

  const y25 = await insert('academic_years', {
    label: `A${RUN}25`,
    start_date: '2025-06-01',
    end_date: '2026-05-31',
  });
  const y26 = await insert('academic_years', {
    label: `A${RUN}26`,
    start_date: '2026-06-01',
    end_date: '2027-05-31',
  });
  const y27 = await insert('academic_years', {
    label: `A${RUN}27`,
    start_date: '2027-06-01',
    end_date: '2028-05-31',
  });
  const grade = await insert('period_types', {
    code: 'GRADE',
    label: 'Grade',
    label_plural: 'Grades',
  });
  const sem = await insert('period_types', {
    code: 'SEM',
    label: 'Semester',
    label_plural: 'Semesters',
  });

  // ---- school
  SC.campus = await insert('campuses', {
    name: 'Senior school',
    code: code('SS'),
    timezone: 'Asia/Kolkata',
  });
  SC.dept = await insert('departments', {
    campus_id: SC.campus,
    name: 'Middle school',
    code: code('MS'),
  });
  SC.program = await insert('programs', {
    department_id: SC.dept,
    period_type_id: grade,
    name: 'School curriculum',
    code: code('K12'),
    degree_level: 'K12',
    duration_periods: 12,
  });
  SC.cohortA = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2020,
    intake_code: 'G1',
    name: 'G1 2020',
  });
  SC.cohortB = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2021,
    intake_code: 'G1',
    name: 'G1 2021',
  });
  const session = (year: string, from: string, to: string, c: string) =>
    insert('terms', {
      campus_id: SC.campus,
      academic_year_id: year,
      code: c,
      name: c,
      start_date: from,
      end_date: to,
    });
  SC.s25 = await session(y25, '2025-06-01', '2026-03-31', 'S25');
  SC.s26 = await session(y26, '2026-06-01', '2027-03-31', 'S26');
  SC.s27 = await session(y27, '2027-06-01', '2028-03-31', 'S27');
  SC.a6 = await insert('cohort_periods', { cohort_id: SC.cohortA, term_id: SC.s25, period_no: 6 });
  SC.a7 = await insert('cohort_periods', { cohort_id: SC.cohortA, term_id: SC.s26, period_no: 7 });
  SC.b6 = await insert('cohort_periods', { cohort_id: SC.cohortB, term_id: SC.s26, period_no: 6 });
  SC.b7 = await insert('cohort_periods', { cohort_id: SC.cohortB, term_id: SC.s27, period_no: 7 });
  SC.a6A = await insert('sections', { cohort_period_id: SC.a6, name: '6-A' });
  SC.a7A = await insert('sections', { cohort_period_id: SC.a7, name: '7-A' });
  SC.b6A = await insert('sections', { cohort_period_id: SC.b6, name: '6-A' });
  SC.b6B = await insert('sections', { cohort_period_id: SC.b6, name: '6-B' });

  // ---- university (the tenant's own campus and department)
  U.program = await insert('programs', {
    department_id: T.departmentId,
    period_type_id: sem,
    name: 'B.Tech CSE',
    code: code('BT'),
    degree_level: 'UG',
    duration_periods: 8,
  });
  U.c25 = await insert('cohorts', {
    program_id: U.program,
    admission_year: 2025,
    name: 'CSE 2025',
  });
  U.c26 = await insert('cohorts', {
    program_id: U.program,
    admission_year: 2026,
    name: 'CSE 2026',
  });
  U.cX = await insert('cohorts', {
    program_id: U.program,
    admission_year: 2025,
    intake_code: 'LATE',
    name: 'CSE 2025 late',
  });
  const uterm = (year: string, c: string, from: string, to: string) =>
    insert('terms', {
      campus_id: T.campusId,
      academic_year_id: year,
      code: c,
      name: c,
      start_date: from,
      end_date: to,
    });
  U.odd25 = await uterm(y25, 'ODD', '2025-07-01', '2025-12-31');
  U.odd26 = await uterm(y26, 'ODD', '2026-07-01', '2026-12-31');
  U.even27 = await uterm(y26, 'EVEN', '2027-01-01', '2027-05-31');
  U.p25s1 = await insert('cohort_periods', { cohort_id: U.c25, term_id: U.odd25, period_no: 1 });
  U.pXs1 = await insert('cohort_periods', { cohort_id: U.cX, term_id: U.odd25, period_no: 1 });
  U.p26s1 = await insert('cohort_periods', { cohort_id: U.c26, term_id: U.odd26, period_no: 1 });
  U.p26s2 = await insert('cohort_periods', { cohort_id: U.c26, term_id: U.even27, period_no: 2 });

  E.ct1 = await employee([SC.dept, '2026-01-01']);
  E.ct2 = await employee([SC.dept, '2026-01-01']);
  E.ct3 = await employee([SC.dept, '2025-01-01']); // posted since before the 2025-26 session
  E.onLeave = await employee([SC.dept, '2026-01-01'], 'ON_LEAVE');
  E.separated = await employee(null, 'SEPARATED');
  E.unposted = await employee(null);
  E.uni = await employee([T.departmentId, '2026-01-01']); // posted on the other campus
  E.ended = await employee([SC.dept, '2025-01-01', '2026-03-31']); // posting closed (revoked / expired)
  E.future = await employee([SC.dept, '2099-01-01']); // posting not started yet

  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.registrarCampus = await login(T.emails.registrarCampus);
  s.hod = await login(T.emails.hod);
  s.student = await login(T.emails.studentOne);
  s.foreignAdmin = await login(OTHER.emails.admin);
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'section_class_teachers',
      'timetable_slots',
      'faculty_assignments',
      'course_offerings',
      'section_memberships',
      'term_enrollments',
      'student_programs',
      'sections',
      'cohort_periods',
      'terms',
      'academic_years',
      'cohorts',
      'programs',
      'period_types',
      'courses',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

// =============================================================================================
// Class teachers
// =============================================================================================
const assignCT = (who: Session, section: string, body: Record<string, unknown>) =>
  call('POST', who, `/academics/sections/${section}/class-teachers`, {
    classTeacherRole: 'PRIMARY',
    validFrom: '2026-06-01',
    reason: 'Class teacher for the session',
    ...body,
  });
const listCT = (who: Session | null, section: string) =>
  call('GET', who, `/academics/sections/${section}/class-teachers`);
const endCT = (who: Session, id: string, version: number, validTo: string) =>
  call(
    'PATCH',
    who,
    `/academics/class-teachers/${id}`,
    { validTo, reason: 'Handing over the class' },
    { 'if-match': `"${version}"` },
  );

describe('class teachers of a section', () => {
  let first = '';
  it('assigns a PRIMARY class teacher with a reason at audit tier 2; a second PRIMARY is refused, an ASSISTANT is not', async () => {
    const r = await assignCT(s.admin, SC.b6A, { employeeId: E.ct1 });
    expect(r.statusCode, r.body).toBe(201);
    first = idOf(r);
    const [audit] = await adminQuery<{ risk_tier: number; reason_text: string; action: string }>(
      `SELECT risk_tier, reason_text, action FROM app.audit_events WHERE resource_id = $1`,
      [first],
    );
    expect(audit).toEqual({
      risk_tier: 2,
      reason_text: 'Class teacher for the session',
      action: 'academic.class_teacher.create',
    });
    expect((await assignCT(s.admin, SC.b6A, { employeeId: E.ct2 })).statusCode).toBe(409);
    expect(
      (await assignCT(s.admin, SC.b6A, { employeeId: E.ct2, classTeacherRole: 'ASSISTANT' }))
        .statusCode,
    ).toBe(201);
    // the same person twice on one section
    expect(
      (await assignCT(s.admin, SC.b6A, { employeeId: E.ct1, classTeacherRole: 'ASSISTANT' }))
        .statusCode,
    ).toBe(409);
  });

  it('one PRIMARY class per employee at a time; the same person may assist another section', async () => {
    expect((await assignCT(s.admin, SC.b6B, { employeeId: E.ct1 })).statusCode).toBe(409);
    expect(
      (await assignCT(s.admin, SC.b6B, { employeeId: E.ct1, classTeacherRole: 'ASSISTANT' }))
        .statusCode,
    ).toBe(201);
    // last session's open assignment counts only until its term ends: it never blocks this session
    expect(
      (await assignCT(s.admin, SC.a6A, { employeeId: E.ct3, validFrom: '2025-06-01' })).statusCode,
    ).toBe(201);
    expect((await assignCT(s.admin, SC.a7A, { employeeId: E.ct3 })).statusCode).toBe(201);
  });

  it('reassignment ends one row and opens another; history is kept; an ended row is final', async () => {
    const before = dataOf<{ id: string; version: number }[]>(await listCT(s.admin, SC.b6A));
    const row = before.find((x) => x.id === first)!;
    expect((await endCT(s.admin, first, row.version + 1, '2026-09-30')).statusCode).toBe(409); // stale
    const missing = await call('PATCH', s.admin, `/academics/class-teachers/${first}`, {
      validTo: '2026-09-30',
      reason: 'Handing over the class',
    });
    expect(missing.statusCode).toBe(428);
    expect((await endCT(s.admin, first, row.version, '2027-04-30')).statusCode).toBe(409); // after the term
    const ended = await endCT(s.admin, first, row.version, '2026-09-30');
    expect(ended.statusCode).toBe(200);
    expect((await endCT(s.admin, first, row.version + 1, '2026-10-31')).statusCode).toBe(409); // already ended
    // the successor cannot overlap the predecessor; it can start the next day
    const fresh = await employee([SC.dept, '2026-01-01']);
    expect(
      (await assignCT(s.admin, SC.b6A, { employeeId: fresh, validFrom: '2026-09-30' })).statusCode,
    ).toBe(409);
    expect(
      (await assignCT(s.admin, SC.b6A, { employeeId: fresh, validFrom: '2026-10-01' })).statusCode,
    ).toBe(201);
    const after = dataOf<
      { employeeId: string; classTeacherRole: string; validFrom: string; validTo: string | null }[]
    >(await listCT(s.admin, SC.b6A));
    expect(
      after
        .filter((x) => x.classTeacherRole === 'PRIMARY')
        .map((x) => [x.employeeId, x.validFrom, x.validTo]),
    ).toEqual([
      [E.ct1, '2026-06-01', '2026-09-30'],
      [fresh, '2026-10-01', null],
    ]);
    // the ended row itself never changes again
    const [kept] = await adminQuery<{ valid_to: string }>(
      `SELECT valid_to::text FROM app.section_class_teachers WHERE id = $1`,
      [first],
    );
    expect(kept?.valid_to).toBe('2026-09-30');
  });

  it('refuses inactive, separated, unposted, wrong-campus, ended-posting and future-posting employees, and bad dates', async () => {
    for (const [emp, label] of [
      [E.onLeave, 'on leave'],
      [E.separated, 'separated'],
      [E.unposted, 'no posting'],
      [E.uni, 'posted on another campus'],
      [E.ended, 'posting ended'],
      [E.future, 'posting not started'],
    ] as const) {
      expect(
        (await assignCT(s.admin, SC.a7A, { employeeId: emp, classTeacherRole: 'ASSISTANT' }))
          .statusCode,
        label,
      ).toBe(409);
    }
    expect(
      (
        await assignCT(s.admin, SC.b6B, {
          employeeId: E.ct2,
          classTeacherRole: 'ASSISTANT',
          validFrom: '2026-05-31',
        })
      ).statusCode,
    ).toBe(409); // before the term
    expect((await assignCT(s.admin, SC.b6B, { employeeId: E.ct2, reason: 'no' })).statusCode).toBe(
      400,
    );
    expect(
      (await assignCT(s.admin, SC.b6B, { employeeId: E.ct2, classTeacherRole: 'HOMEROOM' }))
        .statusCode,
    ).toBe(400);
    expect((await assignCT(s.admin, SC.b6B, { employeeId: uuidv7() })).statusCode).toBe(404);
  });

  it('two simultaneous PRIMARY assignments of one section, or of one teacher to two sections: exactly one wins', async () => {
    const sec1 = await insert('sections', { cohort_period_id: SC.b6, name: '6-C' });
    const sec2 = await insert('sections', { cohort_period_id: SC.b6, name: '6-D' });
    const [x, y] = [
      await employee([SC.dept, '2026-01-01']),
      await employee([SC.dept, '2026-01-01']),
    ];
    const [a, b] = await Promise.all([
      assignCT(s.admin, sec1, { employeeId: x }),
      assignCT(s.admin, sec1, { employeeId: y }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 201 ? y : x;
    const sec3 = await insert('sections', { cohort_period_id: SC.b6, name: '6-E' });
    const [c, d] = await Promise.all([
      assignCT(s.admin, sec2, { employeeId: loser }),
      assignCT(s.admin, sec3, { employeeId: loser }),
    ]);
    expect([c.statusCode, d.statusCode].sort()).toEqual([201, 409]);
  });

  it('a class teacher is not a subject teacher: no faculty assignment is created and no timetable teacher is inferred', async () => {
    const course = await insert('courses', {
      owning_department_id: SC.dept,
      code: code('SCI'),
      title: 'Science (Grade 6)',
      credits: 0,
      course_type: 'THEORY',
    });
    const off = (section: string) =>
      call('POST', s.admin, '/academics/course-offerings', {
        termId: SC.s26,
        courseId: course,
        sectionId: section,
        offeringKind: 'CORE',
        registrationPolicy: 'AUTO_FROM_SECTION',
      });
    const offA = idOf(await off(SC.b6A));
    const offB = idOf(await off(SC.b6B));
    expect(
      dataOf<unknown[]>(
        await call('GET', s.admin, `/academics/course-offerings/${offA}/faculty-assignments`),
      ),
    ).toEqual([]);
    const slot = (offering: string, body: object) =>
      call('POST', s.admin, `/academics/course-offerings/${offering}/timetable-slots`, {
        weekday: 2,
        startTime: '08:00',
        endTime: '08:45',
        effectiveFrom: '2026-06-01',
        ...body,
      });
    // 6-A's slot names no teacher; its (former) class teacher E.ct1 is not inferred, so E.ct1 can teach 6-B then
    expect((await slot(offA, {})).statusCode).toBe(201);
    const fa = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${offB}/faculty-assignments`,
      {
        employeeId: E.ct1,
        teachingRole: 'PRIMARY',
        validFrom: '2026-06-01',
        reason: 'Science teacher for 6-B',
      },
    );
    expect(fa.statusCode, fa.body).toBe(201);
    expect((await slot(offB, { facultyAssignmentId: idOf(fa) })).statusCode).toBe(201);
    // 0037's teacher rule is unchanged: E.ct1 cannot take a second class at that time (an offering without a cohort
    // period has no audience, so only the teacher rule can refuse it)
    const offB2 = idOf(
      await call('POST', s.admin, '/academics/course-offerings', {
        termId: SC.s26,
        courseId: course,
        offeringKind: 'OPTIONAL',
        groupLabel: 'X',
        registrationPolicy: 'MANUAL',
      }),
    );
    const fa2 = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${offB2}/faculty-assignments`,
      {
        employeeId: E.ct1,
        teachingRole: 'PRIMARY',
        validFrom: '2026-06-01',
        reason: 'Optional science club',
      },
    );
    expect((await slot(offB2, { facultyAssignmentId: idOf(fa2) })).statusCode).toBe(409);
    expect(
      (await slot(offB2, { facultyAssignmentId: idOf(fa2), startTime: '08:45', endTime: '09:30' }))
        .statusCode,
    ).toBe(201);
  });

  it('scope, roles and tenant isolation: 404 out of scope, 403 without the permission, staff-only rows', async () => {
    // the campus administrator and registrar of the university campus: the school section does not exist for them
    expect((await listCT(s.campusAdmin, SC.b6A)).statusCode).toBe(404);
    expect(
      (await assignCT(s.campusAdmin, SC.b6B, { employeeId: E.ct2, classTeacherRole: 'ASSISTANT' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await assignCT(s.registrarCampus, SC.b6B, {
          employeeId: E.ct2,
          classTeacherRole: 'ASSISTANT',
        })
      ).statusCode,
    ).toBe(404);
    const row = dataOf<{ id: string; version: number }[]>(await listCT(s.admin, SC.b6A))[0]!;
    expect((await endCT(s.campusAdmin, row.id, row.version, '2026-12-31')).statusCode).toBe(404);
    // HOD: reads its department only; never assigns
    expect(
      (await assignCT(s.hod, SC.b6B, { employeeId: E.ct2, classTeacherRole: 'ASSISTANT' }))
        .statusCode,
    ).toBe(403);
    // a student: reads nothing (staff-only rows), writes nothing
    const st = await listCT(s.student, SC.b6A);
    expect(st.statusCode).toBe(200);
    expect(dataOf<unknown[]>(st)).toEqual([]);
    expect((await assignCT(s.student, SC.b6B, { employeeId: E.ct2 })).statusCode).toBe(403);
    // another tenant
    expect((await listCT(s.foreignAdmin, SC.b6A)).statusCode).toBe(404);
    expect((await assignCT(s.foreignAdmin, SC.b6B, { employeeId: E.ct2 })).statusCode).toBe(404);
    expect((await endCT(s.foreignAdmin, row.id, row.version, '2026-12-31')).statusCode).toBe(404);
    // nonexistent, malformed, unauthenticated
    expect((await listCT(s.admin, uuidv7())).statusCode).toBe(404);
    expect(
      (await call('GET', s.admin, '/academics/sections/not-an-id/class-teachers')).statusCode,
    ).toBe(400);
    expect((await listCT(null, SC.b6A)).statusCode).toBe(401);
  });
});

// =============================================================================================
// Promotion and repetition
// =============================================================================================
const progress = (who: Session, student: string, enrolment: string, body: object, key = uuidv7()) =>
  call('POST', who, `/students/${student}/term-enrollments/${enrolment}/progression`, body, {
    'idempotency-key': key,
  });
const enrolments = async (student: string) =>
  dataOf<
    {
      id: string;
      cohortPeriodId: string;
      periodNo: number;
      status: string;
      enrollmentType: string;
      studentProgramId: string;
    }[]
  >(await call('GET', s.admin, `/students/${student}/term-enrollments`));
const school = () => pupil(SC.program, SC.cohortA, SC.campus, SC.dept);

describe('school: promotion and repeating a grade', () => {
  it('promotes Grade 6 to Grade 7 of the same cohort; the old enrolment is PROMOTED, its section closed, history kept', async () => {
    const p = await school();
    const g6 = await enrolled(p, SC.a6, SC.s25, 6);
    await insert('section_memberships', {
      term_enrollment_id: g6,
      student_id: p.student,
      cohort_period_id: SC.a6,
      section_id: SC.a6A,
      valid_from: '2025-06-01',
      change_reason: 'Initial placement',
      changed_by: T.users.admin,
    });
    const key = uuidv7();
    const body = {
      decision: 'PROMOTE',
      cohortPeriodId: SC.a7,
      rollNumber: '7A-01',
      reason: 'Passed Grade 6 annual exam',
    };
    const r = await progress(s.admin, p.student, g6, body, key);
    expect(r.statusCode, r.body).toBe(201);
    const g7 = idOf(r);
    const replay = await progress(s.admin, p.student, g6, body, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(idOf(replay)).toBe(g7);

    const rows = await enrolments(p.student);
    expect(
      rows.map((x) => [x.periodNo, x.status, x.enrollmentType, x.studentProgramId]).sort(),
    ).toEqual([
      [6, 'PROMOTED', 'REGULAR', p.sp],
      [7, 'REGISTERED', 'REGULAR', p.sp],
    ]);
    const [m] = await adminQuery<{ valid_to: string | null }>(
      `SELECT valid_to::text FROM app.section_memberships WHERE term_enrollment_id = $1`,
      [g6],
    );
    expect(m?.valid_to).not.toBeNull();
    const audits = await adminQuery<{ action: string; reason_text: string; resource_id: string }>(
      `SELECT action, reason_text, resource_id FROM app.audit_events WHERE resource_id = ANY($1::uuid[]) ORDER BY action`,
      [[g6, g7]],
    );
    expect(audits).toEqual([
      {
        action: 'enrollment.term.progress',
        reason_text: 'Passed Grade 6 annual exam',
        resource_id: g7,
      },
      {
        action: 'enrollment.term.update',
        reason_text: 'Passed Grade 6 annual exam',
        resource_id: g6,
      },
    ]);
    // the source is final: a second decision with a new key is refused, nothing changes
    expect(
      (await progress(s.admin, p.student, g6, { ...body, rollNumber: undefined })).statusCode,
    ).toBe(409);
    expect((await enrolments(p.student)).length).toBe(2);
  });

  it('repeats Grade 6 with the junior cohort: REPEAT enrolment, the same programme enrolment, no student duplication', async () => {
    const p = await school();
    const g6 = await enrolled(p, SC.a6, SC.s25, 6);
    const r = await progress(s.admin, p.student, g6, {
      decision: 'REPEAT',
      cohortPeriodId: SC.b6,
      reason: 'Did not meet the promotion criteria',
    });
    expect(r.statusCode, r.body).toBe(201);
    const rows = await enrolments(p.student);
    expect(rows.map((x) => [x.cohortPeriodId, x.status, x.enrollmentType]).sort()).toEqual(
      [
        [SC.a6, 'COMPLETED', 'REGULAR'],
        [SC.b6, 'REGISTERED', 'REPEAT'],
      ].sort(),
    );
    expect(new Set(rows.map((x) => x.studentProgramId))).toEqual(new Set([p.sp]));
    const [sp] = await adminQuery<{ cohort_id: string; status: string }>(
      `SELECT cohort_id, status FROM app.student_programs WHERE id = $1`,
      [p.sp],
    );
    expect(sp).toEqual({ cohort_id: SC.cohortA, status: 'ACTIVE' }); // the admission cohort is history, never rewritten

    // a year later: promoted with the cohort it joined (a REGULAR enrolment in cohort B is now allowed)
    const b6 = idOf(r);
    await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [b6]);
    const up = await progress(s.admin, p.student, b6, {
      decision: 'PROMOTE',
      cohortPeriodId: SC.b7,
      reason: 'Passed Grade 6',
    });
    expect(up.statusCode, up.body).toBe(201);
    expect((await enrolments(p.student)).find((x) => x.id === idOf(up))).toMatchObject({
      periodNo: 7,
      enrollmentType: 'REGULAR',
      cohortPeriodId: SC.b7,
    });
  });

  it('a DETAINED student repeats; the detained enrolment ends COMPLETED', async () => {
    const p = await school();
    const g6 = await enrolled(p, SC.a6, SC.s25, 6);
    const v = (await call('GET', s.admin, `/students/${p.student}/term-enrollments/${g6}`)).headers[
      'etag'
    ] as string;
    const det = await call(
      'PATCH',
      s.admin,
      `/students/${p.student}/term-enrollments/${g6}`,
      { status: 'DETAINED', reason: 'Attendance below the minimum' },
      { 'if-match': v },
    );
    expect(det.statusCode, det.body).toBe(200);
    expect(
      (
        await progress(s.admin, p.student, g6, {
          decision: 'PROMOTE',
          cohortPeriodId: SC.a7,
          reason: 'Try promote',
        })
      ).statusCode,
    ).toBe(409);
    const r = await progress(s.admin, p.student, g6, {
      decision: 'REPEAT',
      cohortPeriodId: SC.b6,
      reason: 'Detained, repeats Grade 6',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect((await enrolments(p.student)).find((x) => x.id === g6)?.status).toBe('COMPLETED');
  });

  it('refuses the wrong period, another cohort for promotion, another programme, and a cohort not joined by a repeat', async () => {
    const p = await school();
    const g6 = await enrolled(p, SC.a6, SC.s25, 6);
    const go = (decision: string, cohortPeriodId: string) =>
      progress(s.admin, p.student, g6, { decision, cohortPeriodId, reason: 'Year-end decision' });
    expect((await go('PROMOTE', SC.b6)).statusCode).toBe(409); // same period, other cohort
    expect((await go('PROMOTE', SC.b7)).statusCode).toBe(409); // next period but another cohort
    expect((await go('REPEAT', SC.a7)).statusCode).toBe(409); // a repeat keeps the period
    expect((await go('REPEAT', SC.b7)).statusCode).toBe(409);
    // the Batch 1 rule still holds for a plain enrolment: no other cohort without a repeat decision
    const plain = await call(
      'POST',
      s.admin,
      `/students/${p.student}/term-enrollments`,
      { cohortPeriodId: SC.b6, enrollmentType: 'REPEAT', reason: 'Back door repeat' },
      { 'idempotency-key': uuidv7() },
    );
    expect(plain.statusCode).toBe(409);
    expect((await enrolments(p.student)).map((x) => x.status)).toEqual(['ACTIVE']);
  });

  it('no duplicate live enrolment in one term; two simultaneous decisions on one enrolment: exactly one wins', async () => {
    const p = await school();
    const g6 = await enrolled(p, SC.a6, SC.s25, 6);
    const [a, b] = await Promise.all([
      progress(s.admin, p.student, g6, {
        decision: 'PROMOTE',
        cohortPeriodId: SC.a7,
        reason: 'Passed Grade 6',
      }),
      progress(s.admin, p.student, g6, {
        decision: 'REPEAT',
        cohortPeriodId: SC.b6,
        reason: 'Repeat Grade 6',
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await enrolments(p.student)).filter((x) => x.status === 'REGISTERED')).toHaveLength(1);
    // two simultaneous plain enrolments of a fresh student into one cohort period
    const q = await school();
    const enrol = () =>
      call(
        'POST',
        s.admin,
        `/students/${q.student}/term-enrollments`,
        { cohortPeriodId: SC.a7, reason: 'Late admission' },
        {
          'idempotency-key': uuidv7(),
        },
      );
    const [c, d] = await Promise.all([enrol(), enrol()]);
    expect([c.statusCode, d.statusCode].sort()).toEqual([201, 409]);
  });

  it('privileged writers: the database admits only a repeat of a held period in the same programme', async () => {
    const p = await school();
    await enrolled(p, SC.a6, SC.s25, 6);
    const raw = (cp: string, term: string, periodNo: number, type: string) =>
      adminQuery(
        `INSERT INTO app.term_enrollments (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no, enrollment_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), T.orgId, p.student, p.sp, cp, term, periodNo, type],
      ).then(
        () => 'ok',
        (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`,
      );
    expect(await raw(SC.b6, SC.s26, 6, 'REGULAR')).toBe('23514:term_enrollments_same_cohort_ck');
    expect(await raw(SC.b7, SC.s27, 7, 'REPEAT')).toBe('23514:term_enrollments_same_cohort_ck'); // period 7 never held
    expect(await raw(U.p26s1, U.odd26, 1, 'REPEAT')).toBe('23514:term_enrollments_same_program_ck');
    expect(await raw(SC.b6, SC.s26, 6, 'REPEAT')).toBe('ok');
  });
});

describe('university: a year-back with the junior batch, scope and B6 profile visibility', () => {
  const uni = () => pupil(U.program, U.c25, T.campusId, T.departmentId);

  it('a detained first-semester student repeats with the 2026 batch, then is promoted with it', async () => {
    const p = await uni();
    const s1 = await enrolled(p, U.p25s1, U.odd25, 1);
    await adminQuery(`UPDATE app.term_enrollments SET status = 'DETAINED' WHERE id = $1`, [s1]);
    // a junior cohort period in the SAME term is not "later": refused
    expect(
      (
        await progress(s.registrarCampus, p.student, s1, {
          decision: 'REPEAT',
          cohortPeriodId: U.pXs1,
          reason: 'Year back',
        })
      ).statusCode,
    ).toBe(409);
    const r = await progress(s.registrarCampus, p.student, s1, {
      decision: 'REPEAT',
      cohortPeriodId: U.p26s1,
      reason: 'Year back',
    });
    expect(r.statusCode, r.body).toBe(201);
    await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [idOf(r)]);
    const up = await progress(s.registrarCampus, p.student, idOf(r), {
      decision: 'PROMOTE',
      cohortPeriodId: U.p26s2,
      reason: 'Cleared semester 1',
    });
    expect(up.statusCode, up.body).toBe(201);
    expect(
      (await enrolments(p.student)).map((x) => [x.periodNo, x.status, x.enrollmentType]).sort(),
    ).toEqual([
      [1, 'COMPLETED', 'REGULAR'],
      [1, 'PROMOTED', 'REPEAT'],
      [2, 'REGISTERED', 'REGULAR'],
    ]);
    // B6: the programme enrolment (and so the profile scope) never moved; the campus registrar still reads the profile
    expect((await call('GET', s.registrarCampus, `/students/${p.student}`)).statusCode).toBe(200);
  });

  it('out of scope or another tenant: 404; without the permission: 403; another student in the path: 404', async () => {
    const sch = await school();
    const g6 = await enrolled(sch, SC.a6, SC.s25, 6);
    const body = { decision: 'PROMOTE', cohortPeriodId: SC.a7, reason: 'Passed Grade 6' };
    expect((await progress(s.campusAdmin, sch.student, g6, body)).statusCode).toBe(404);
    expect((await progress(s.registrarCampus, sch.student, g6, body)).statusCode).toBe(404);
    expect((await progress(s.foreignAdmin, sch.student, g6, body)).statusCode).toBe(404);
    expect((await progress(s.hod, sch.student, g6, body)).statusCode).toBe(403);
    expect((await progress(s.student, sch.student, g6, body)).statusCode).toBe(403);
    const other = await school();
    expect((await progress(s.admin, other.student, g6, body)).statusCode).toBe(404);
    // a university student cannot be moved into a school cohort period the caller cannot see (404, not a hint)
    const u = await uni();
    const s1 = await enrolled(u, U.p25s1, U.odd25, 1);
    expect(
      (
        await progress(s.registrarCampus, u.student, s1, {
          decision: 'REPEAT',
          cohortPeriodId: SC.b6,
          reason: 'Wrong place',
        })
      ).statusCode,
    ).toBe(404);
    // the organization administrator sees it, and the programme mismatch is a 409
    expect(
      (
        await progress(s.admin, u.student, s1, {
          decision: 'REPEAT',
          cohortPeriodId: SC.b6,
          reason: 'Wrong place',
        })
      ).statusCode,
    ).toBe(409);
    // missing Idempotency-Key, malformed ids
    const nokey = await call(
      'POST',
      s.admin,
      `/students/${sch.student}/term-enrollments/${g6}/progression`,
      body,
    );
    expect(nokey.statusCode).toBe(428);
    expect(
      (
        await call(
          'POST',
          s.admin,
          `/students/${sch.student}/term-enrollments/nope/progression`,
          body,
          { 'idempotency-key': uuidv7() },
        )
      ).statusCode,
    ).toBe(400);
    expect((await enrolments(sch.student)).map((x) => x.status)).toEqual(['ACTIVE']);
  });
});
