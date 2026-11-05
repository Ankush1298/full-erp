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

// Milestone 3 Batch 2 (migration 0037, doc 31) over HTTP: course offerings, faculty assignments and timetable slots, for a
// UNIVERSITY (department CSE, semester programme, sections A/B) and a SCHOOL (second campus, a 12-year programme whose
// period_no is the grade, Grade 6 sections 6-A/6-B) in one private tenant. Org-structure, employee and room rows are
// fixtures inserted as the harness superuser (the guards still run); every behaviour under test goes through the API.

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
  'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'student' | 'registrarCampus' | 'foreignAdmin',
  Session
>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

/** University (T.campusId / T.departmentId) and school (a second campus) fixture ids. */
const U = {} as Record<
  'term' | 'cp' | 'secA' | 'secB' | 'course' | 'orgCourse' | 'lockTerm' | 'room1' | 'room2',
  string
>;
const SC = {} as Record<'campus' | 'dept' | 'term' | 'cp' | 'sec6A' | 'math' | 'room', string>;
const E = {} as Record<'u1' | 'u2' | 'u3' | 'school' | 'onLeave' | 'unposted', string>;

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
    url: `/api/v1/academics${path}`,
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
const errCode = (r: { json: <X>() => X }): string =>
  r.json<{ error: { code: string } }>().error.code;

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
/** An employee with an account and, unless `posted: null`, an active primary posting in `dept` since 2026-01-01. */
async function employee(dept: string | null, status = 'ACTIVE'): Promise<string> {
  const user = uuidv7();
  const email = `co-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Teacher', 'ACTIVE', $1)`,
    [user, T.orgId, email],
  );
  const id = await insert('employees', {
    user_id: user,
    employee_code: code('E'),
    employee_type: 'FACULTY',
    joining_date: '2025-06-01',
  });
  if (dept) {
    await insert('employee_postings', {
      employee_id: id,
      department_id: dept,
      valid_from: '2026-01-01',
      is_primary: true,
    });
  }
  if (status !== 'ACTIVE')
    await adminQuery(`UPDATE app.employees SET status = $2 WHERE id = $1`, [id, status]);
  return id;
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);

  const year = await insert('academic_years', {
    label: `AY${RUN}`,
    start_date: '2026-06-01',
    end_date: '2027-05-31',
  });
  const sem = await insert('period_types', {
    code: 'SEM',
    label: 'Semester',
    label_plural: 'Semesters',
  });
  const grade = await insert('period_types', {
    code: 'GRADE',
    label: 'Grade',
    label_plural: 'Grades',
  });

  // ---- university: B.Tech CSE, semester 1 in the ODD term, sections A and B
  const btech = await insert('programs', {
    department_id: T.departmentId,
    period_type_id: sem,
    name: 'B.Tech CSE',
    code: code('BT'),
    degree_level: 'UG',
    duration_periods: 8,
  });
  const cohort = await insert('cohorts', {
    program_id: btech,
    admission_year: 2026,
    name: 'CSE 2026',
  });
  U.term = await insert('terms', {
    campus_id: T.campusId,
    academic_year_id: year,
    code: 'ODD',
    name: 'Odd semester',
    start_date: '2026-07-01',
    end_date: '2026-12-31',
  });
  U.cp = await insert('cohort_periods', { cohort_id: cohort, term_id: U.term, period_no: 1 });
  U.secA = await insert('sections', { cohort_period_id: U.cp, name: 'A' });
  U.secB = await insert('sections', { cohort_period_id: U.cp, name: 'B' });
  U.course = await insert('courses', {
    owning_department_id: T.departmentId,
    code: code('CS'),
    title: 'Programming I',
    credits: 4,
    course_type: 'THEORY_PRACTICAL',
  });
  U.orgCourse = await insert('courses', {
    code: code('MA'),
    title: 'Mathematics I',
    credits: 3,
    course_type: 'THEORY',
  });
  U.lockTerm = await insert('terms', {
    campus_id: T.campusId,
    academic_year_id: year,
    code: 'SUMMER',
    name: 'Summer term',
    start_date: '2027-04-01',
    end_date: '2027-05-15',
  });
  U.room1 = await insert('rooms', { campus_id: T.campusId, code: code('R'), kind: 'CLASSROOM' });
  U.room2 = await insert('rooms', { campus_id: T.campusId, code: code('L'), kind: 'LAB' });

  // ---- school: a second campus; Grade 6 = period_no 6 of a 12-year programme; sections 6-A, 6-B
  SC.campus = await insert('campuses', {
    name: 'Junior school',
    code: code('JS'),
    timezone: 'Asia/Kolkata',
  });
  SC.dept = await insert('departments', {
    campus_id: SC.campus,
    name: 'Middle school',
    code: code('MS'),
  });
  const k12 = await insert('programs', {
    department_id: SC.dept,
    period_type_id: grade,
    name: 'School curriculum',
    code: code('K12'),
    degree_level: 'K12',
    duration_periods: 12,
  });
  const schoolCohort = await insert('cohorts', {
    program_id: k12,
    admission_year: 2021,
    intake_code: 'G1',
    name: 'Joined Grade 1 in 2021',
  });
  SC.term = await insert('terms', {
    campus_id: SC.campus,
    academic_year_id: year,
    code: 'ANNUAL',
    name: 'Academic session 2026-27',
    start_date: '2026-06-01',
    end_date: '2027-03-31',
  });
  SC.cp = await insert('cohort_periods', {
    cohort_id: schoolCohort,
    term_id: SC.term,
    period_no: 6,
  });
  SC.sec6A = await insert('sections', { cohort_period_id: SC.cp, name: '6-A' });
  await insert('sections', { cohort_period_id: SC.cp, name: '6-B' });
  SC.math = await insert('courses', {
    owning_department_id: SC.dept,
    code: code('M6'),
    title: 'Mathematics (Grade 6)',
    credits: 0,
    course_type: 'THEORY',
  });
  SC.room = await insert('rooms', { campus_id: SC.campus, code: code('C'), kind: 'CLASSROOM' });

  E.u1 = await employee(T.departmentId);
  E.u2 = await employee(T.departmentId);
  E.u3 = await employee(T.departmentId);
  E.school = await employee(SC.dept);
  E.onLeave = await employee(T.departmentId, 'ON_LEAVE');
  E.unposted = await employee(null);

  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.hod = await login(T.emails.hod);
  s.faculty = await login(T.emails.faculty);
  s.student = await login(T.emails.studentOne);
  s.registrarCampus = await login(T.emails.registrarCampus);
  s.foreignAdmin = await login(OTHER.emails.admin);
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await T.cleanup(); // removes slots, assignments, offerings, postings and employees
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'sections',
      'cohort_periods',
      'terms',
      'academic_years',
      'cohorts',
      'programs',
      'period_types',
      'courses',
      'rooms',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await OTHER.cleanup();
});

const offering = (who: Session, body: Record<string, unknown>) =>
  call('POST', who, '/course-offerings', body);
const core = (extra: Record<string, unknown> = {}) => ({
  termId: U.term,
  courseId: U.course,
  sectionId: U.secA,
  offeringKind: 'CORE',
  registrationPolicy: 'AUTO_FROM_SECTION',
  ...extra,
});
const patch = async (who: Session, id: string, body: object, version?: number) => {
  const v =
    version ??
    dataOf<{ version: number }>(await call('GET', s.admin, `/course-offerings/${id}`)).version;
  return call('PATCH', who, `/course-offerings/${id}`, body, { 'if-match': `"${v}"` });
};
const assign = (who: Session, offeringId: string, body: Record<string, unknown>) =>
  call('POST', who, `/course-offerings/${offeringId}/faculty-assignments`, {
    teachingRole: 'PRIMARY',
    validFrom: '2026-07-01',
    reason: 'Teaching load approved',
    ...body,
  });
const slot = (who: Session, offeringId: string, body: Record<string, unknown>) =>
  call('POST', who, `/course-offerings/${offeringId}/timetable-slots`, {
    weekday: 1,
    startTime: '09:00',
    endTime: '10:00',
    effectiveFrom: '2026-07-01',
    ...body,
  });

let uniOffering = '';

describe('university: course offerings', () => {
  it('creates a DRAFT offering whose campus, department and snapshots come from the server', async () => {
    const r = await offering(s.admin, core());
    expect(r.statusCode, r.body).toBe(201);
    uniOffering = idOf(r);
    const o = dataOf<Record<string, unknown>>(
      await call('GET', s.admin, `/course-offerings/${uniOffering}`),
    );
    expect(o).toMatchObject({
      campusId: T.campusId,
      departmentId: T.departmentId,
      termId: U.term,
      cohortPeriodId: U.cp, // derived from the section
      sectionId: U.secA,
      status: 'DRAFT',
      titleSnapshot: 'Programming I',
      creditsSnapshot: '4.0',
      tracksAttendance: true,
      publishedAt: null,
    });
  });

  it('never accepts a tenant, campus or department from the client', async () => {
    for (const extra of [
      { campusId: SC.campus },
      { departmentId: SC.dept },
      { organizationId: OTHER.orgId },
    ]) {
      expect((await offering(s.admin, core({ ...extra, sectionId: U.secB }))).statusCode).toBe(400);
    }
  });

  it('an organization-wide course needs a cohort period for its department; then it takes the programme department', async () => {
    const plain = await offering(s.admin, {
      ...core(),
      courseId: U.orgCourse,
      sectionId: undefined,
    });
    expect(plain.statusCode).toBe(400);
    const r = await offering(s.admin, { ...core(), courseId: U.orgCourse, sectionId: U.secB });
    expect(r.statusCode, r.body).toBe(201);
    expect(
      dataOf<{ departmentId: string }>(await call('GET', s.admin, `/course-offerings/${idOf(r)}`))
        .departmentId,
    ).toBe(T.departmentId);
  });

  it('one offering per (term, course, section, group); lab groups are distinct offerings', async () => {
    expect((await offering(s.admin, core())).statusCode).toBe(409);
    const lab = (g: string) =>
      offering(
        s.admin,
        core({ offeringKind: 'LAB_GROUP', groupLabel: g, registrationPolicy: 'ADMIN_ASSIGNED' }),
      );
    expect((await lab('G1')).statusCode).toBe(201);
    expect((await lab('G2')).statusCode).toBe(201);
    expect((await lab('G1')).statusCode).toBe(409);
  });

  it('a section of another cohort period, or a cohort period of another term, is refused', async () => {
    expect((await offering(s.admin, core({ cohortPeriodId: SC.cp }))).statusCode).toBe(400);
    expect(
      (await offering(s.admin, core({ sectionId: undefined, cohortPeriodId: SC.cp }))).statusCode,
    ).toBe(400);
  });

  it('publication freezes the catalogue snapshot; later catalogue edits do not touch it', async () => {
    await adminQuery(
      `UPDATE app.courses SET title = 'Programming I (2026 syllabus)' WHERE id = $1`,
      [U.course],
    );
    const missing = await call('PATCH', s.admin, `/course-offerings/${uniOffering}`, {
      status: 'PUBLISHED',
    });
    expect(missing.statusCode).toBe(428);
    expect((await patch(s.admin, uniOffering, { status: 'PUBLISHED' }, 99)).statusCode).toBe(409);
    const pub = await patch(s.admin, uniOffering, { status: 'PUBLISHED' });
    expect(pub.statusCode, pub.body).toBe(200);
    expect(dataOf(pub)).toMatchObject({
      status: 'PUBLISHED',
      titleSnapshot: 'Programming I (2026 syllabus)',
    });
    expect(dataOf<{ publishedAt: string | null }>(pub).publishedAt).not.toBeNull();
    await adminQuery(`UPDATE app.courses SET title = 'Renamed again' WHERE id = $1`, [U.course]);
    const after = dataOf<{ titleSnapshot: string }>(
      await call('GET', s.admin, `/course-offerings/${uniOffering}`),
    );
    expect(after.titleSnapshot).toBe('Programming I (2026 syllabus)');
    const audit = await adminQuery<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE resource_id = $1 ORDER BY occurred_at, id`,
      [uniOffering],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'academic.offering.create',
      'academic.offering.publish',
    ]);
  });

  it('the status machine is forward-only; ending an offering needs a reason; CANCELLED is final', async () => {
    const r = await offering(s.admin, core({ sectionId: U.secB }));
    const id = idOf(r);
    expect((await patch(s.admin, id, { status: 'DRAFT' })).statusCode).toBe(400); // not a target status
    expect(
      (await patch(s.admin, id, { status: 'CLOSED', reason: 'Closing a draft' })).statusCode,
    ).toBe(409);
    expect((await patch(s.admin, id, { status: 'CANCELLED' })).statusCode).toBe(400); // reason missing
    expect(
      (await patch(s.admin, id, { status: 'CANCELLED', reason: 'Not running this term' }))
        .statusCode,
    ).toBe(200);
    expect((await patch(s.admin, id, { capacity: 10 })).statusCode).toBe(409);
  });
});

describe('university: faculty assignments (A2)', () => {
  it('assigns a PRIMARY teacher with a reason at audit tier 2; a second overlapping PRIMARY is refused', async () => {
    const r = await assign(s.admin, uniOffering, { employeeId: E.u1 });
    expect(r.statusCode, r.body).toBe(201);
    const [audit] = await adminQuery<{ risk_tier: number; reason_text: string; action: string }>(
      `SELECT risk_tier, reason_text, action FROM app.audit_events WHERE resource_id = $1`,
      [idOf(r)],
    );
    expect(audit).toEqual({
      risk_tier: 2,
      reason_text: 'Teaching load approved',
      action: 'academic.faculty_assignment.create',
    });
    const second = await assign(s.admin, uniOffering, { employeeId: E.u2 });
    expect(second.statusCode).toBe(409);
    expect(errCode(second)).toBe('CONFLICT');
    expect(
      (await assign(s.admin, uniOffering, { employeeId: E.u2, teachingRole: 'CO_INSTRUCTOR' }))
        .statusCode,
    ).toBe(201);
    // the same person twice in one period
    expect(
      (await assign(s.admin, uniOffering, { employeeId: E.u2, teachingRole: 'LAB_INSTRUCTOR' }))
        .statusCode,
    ).toBe(409);
  });

  it('a faculty change ends one assignment and opens another (history kept)', async () => {
    const list = dataOf<{ id: string; employeeId: string; version: number }[]>(
      await call('GET', s.admin, `/course-offerings/${uniOffering}/faculty-assignments`),
    );
    const primary = list.find((a) => a.employeeId === E.u1)!;
    const end = (v: number) =>
      call(
        'PATCH',
        s.admin,
        `/faculty-assignments/${primary.id}`,
        { validTo: '2026-09-30', reason: 'Moved to research' },
        {
          'if-match': `"${v}"`,
        },
      );
    expect((await end(primary.version + 1)).statusCode).toBe(409);
    expect((await end(primary.version)).statusCode).toBe(200);
    expect((await end(primary.version + 1)).statusCode).toBe(409); // already ended
    expect(
      (await assign(s.admin, uniOffering, { employeeId: E.u3, validFrom: '2026-10-01' }))
        .statusCode,
    ).toBe(201);
    const after = dataOf<{ employeeId: string; validTo: string | null }[]>(
      await call('GET', s.admin, `/course-offerings/${uniOffering}/faculty-assignments`),
    );
    expect(after.map((a) => [a.employeeId, a.validTo])).toEqual(
      expect.arrayContaining([
        [E.u1, '2026-09-30'],
        [E.u3, null],
      ]),
    );
  });

  it('refuses teachers who are not ACTIVE, not posted on the campus, or dates outside the term', async () => {
    const target = idOf(
      await offering(
        s.admin,
        core({ offeringKind: 'LAB_GROUP', groupLabel: 'G9', registrationPolicy: 'ADMIN_ASSIGNED' }),
      ),
    );
    expect((await assign(s.admin, target, { employeeId: E.onLeave })).statusCode).toBe(409);
    expect((await assign(s.admin, target, { employeeId: E.unposted })).statusCode).toBe(409);
    expect((await assign(s.admin, target, { employeeId: E.school })).statusCode).toBe(409); // other campus
    expect(
      (await assign(s.admin, target, { employeeId: E.u1, validFrom: '2026-06-15' })).statusCode,
    ).toBe(409);
    expect(
      (await assign(s.admin, target, { employeeId: E.u1, validTo: '2027-01-15' })).statusCode,
    ).toBe(409);
    expect((await assign(s.admin, target, { employeeId: E.u1, reason: 'no' })).statusCode).toBe(
      400,
    );
    expect((await assign(s.admin, target, { employeeId: uuidv7() })).statusCode).toBe(404);
  });

  it('two simultaneous PRIMARY assignments: exactly one wins', async () => {
    const target = idOf(
      await offering(
        s.admin,
        core({ offeringKind: 'LAB_GROUP', groupLabel: 'G8', registrationPolicy: 'ADMIN_ASSIGNED' }),
      ),
    );
    const [a, b] = await Promise.all([
      assign(s.admin, target, { employeeId: E.u2 }),
      assign(s.admin, target, { employeeId: E.u3 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });
});

describe('university: timetable slots', () => {
  let lab = '';
  it('books rooms without double-booking (half-open times, open-ended dates)', async () => {
    expect((await slot(s.admin, uniOffering, { roomId: U.room1 })).statusCode).toBe(201);
    lab = idOf(
      await offering(
        s.admin,
        // section B, so only the ROOM rule is exercised here (section A has the core class at that hour)
        core({
          sectionId: U.secB,
          offeringKind: 'LAB_GROUP',
          groupLabel: 'G7',
          registrationPolicy: 'ADMIN_ASSIGNED',
        }),
      ),
    );
    const clash = await slot(s.admin, lab, {
      roomId: U.room1,
      startTime: '09:30',
      endTime: '10:30',
    });
    expect(clash.statusCode).toBe(409);
    expect(
      (await slot(s.admin, lab, { roomId: U.room1, startTime: '10:00', endTime: '11:00' }))
        .statusCode,
    ).toBe(201);
    expect((await slot(s.admin, lab, { roomId: U.room1, weekday: 2 })).statusCode).toBe(201);
    expect((await slot(s.admin, lab, { roomId: U.room2, weekday: 4 })).statusCode).toBe(201);
  });

  it('two simultaneous bookings of one room: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      slot(s.admin, uniOffering, {
        roomId: U.room2,
        weekday: 5,
        startTime: '14:00',
        endTime: '15:00',
      }),
      slot(s.admin, lab, { roomId: U.room2, weekday: 5, startTime: '14:30', endTime: '15:30' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it('an ended slot frees the room from the next day', async () => {
    const slots = dataOf<
      { id: string; weekday: number; startTime: string; version: number; roomId: string }[]
    >(await call('GET', s.admin, `/course-offerings/${uniOffering}/timetable-slots`));
    const mon = slots.find((x) => x.weekday === 1 && x.startTime === '09:00')!;
    const ended = await call(
      'PATCH',
      s.admin,
      `/timetable-slots/${mon.id}`,
      { effectiveTo: '2026-08-31' },
      {
        'if-match': `"${mon.version}"`,
      },
    );
    expect(ended.statusCode, ended.body).toBe(200);
    expect(
      (
        await slot(s.admin, lab, {
          roomId: U.room1,
          startTime: '09:00',
          endTime: '09:50',
          effectiveFrom: '2026-09-01',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await slot(s.admin, lab, {
          roomId: U.room1,
          startTime: '09:00',
          endTime: '09:50',
          effectiveFrom: '2026-08-15',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('refuses a room on another campus, a teacher of another offering, bad times and dates outside the term', async () => {
    expect((await slot(s.admin, lab, { roomId: SC.room, weekday: 3 })).statusCode).toBe(409);
    const foreignAssignment = dataOf<{ id: string }[]>(
      await call('GET', s.admin, `/course-offerings/${uniOffering}/faculty-assignments`),
    )[0]!.id;
    expect(
      (await slot(s.admin, lab, { weekday: 3, facultyAssignmentId: foreignAssignment })).statusCode,
    ).toBe(409);
    expect(
      (await slot(s.admin, lab, { weekday: 3, startTime: '11:00', endTime: '10:00' })).statusCode,
    ).toBe(400);
    expect((await slot(s.admin, lab, { weekday: 8 })).statusCode).toBe(400);
    expect((await slot(s.admin, lab, { weekday: 3, effectiveFrom: '2027-01-05' })).statusCode).toBe(
      409,
    );
  });
});

describe('university: room bookings are bounded by their term and their offering', () => {
  let even = '';
  const evenOffering = async (groupLabel: string) =>
    idOf(
      await offering(s.admin, {
        termId: even,
        courseId: U.course,
        offeringKind: 'CORE',
        registrationPolicy: 'MANUAL',
        groupLabel,
      }),
    );
  beforeAll(async () => {
    even = await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: (
        await adminQuery<{ academic_year_id: string }>(
          `SELECT academic_year_id FROM app.terms WHERE id = $1`,
          [U.term],
        )
      )[0]!.academic_year_id,
      code: 'EVEN',
      name: 'Even semester',
      start_date: '2027-01-01',
      end_date: '2027-03-31',
    });
  });

  it('an open-ended slot of the odd term does not block the same room, day and time in the next term', async () => {
    // the lab group holds room1, Monday 10:00-11:00, open-ended since 2026-07-01 (first slot test)
    const next = await evenOffering('N1');
    const r = await slot(s.admin, next, {
      roomId: U.room1,
      startTime: '10:00',
      endTime: '11:00',
      effectiveFrom: '2027-01-04',
    });
    expect(r.statusCode, r.body).toBe(201);
    // inside the even term the rule still holds
    const again = await evenOffering('N2');
    expect(
      (
        await slot(s.admin, again, {
          roomId: U.room1,
          startTime: '10:30',
          endTime: '11:30',
          effectiveFrom: '2027-02-01',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('a CANCELLED offering no longer holds its rooms', async () => {
    const first = await evenOffering('C1');
    const booking = {
      roomId: U.room2,
      weekday: 3,
      startTime: '15:00',
      endTime: '16:00',
      effectiveFrom: '2027-01-06',
    };
    expect((await slot(s.admin, first, booking)).statusCode).toBe(201);
    const second = await evenOffering('C2');
    expect((await slot(s.admin, second, booking)).statusCode).toBe(409);
    const cancelled = await patch(s.admin, first, {
      status: 'CANCELLED',
      reason: 'Merged into another group',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await slot(s.admin, second, booking)).statusCode).toBe(201);
  });
});

let schoolOffering = '';
describe('school: Grade 6 subject teaching on a second campus', () => {
  it('a Grade 6 section-bound subject offering takes the school campus and department', async () => {
    const r = await offering(s.admin, {
      termId: SC.term,
      courseId: SC.math,
      sectionId: SC.sec6A,
      offeringKind: 'CORE',
      registrationPolicy: 'AUTO_FROM_SECTION',
    });
    expect(r.statusCode, r.body).toBe(201);
    schoolOffering = idOf(r);
    expect(dataOf(await call('GET', s.admin, `/course-offerings/${schoolOffering}`))).toMatchObject(
      {
        campusId: SC.campus,
        departmentId: SC.dept,
        cohortPeriodId: SC.cp,
        creditsSnapshot: '0.0',
      },
    );
  });

  it('a subject teacher posted on the school campus is assigned; a university teacher is not', async () => {
    expect(
      (await assign(s.admin, schoolOffering, { employeeId: E.school, validFrom: '2026-06-01' }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await assign(s.admin, schoolOffering, {
          employeeId: E.u1,
          teachingRole: 'CO_INSTRUCTOR',
          validFrom: '2026-06-01',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('a daily period timetable (Mon-Fri 08:00-08:45) in the class room; a clash is refused', async () => {
    for (const weekday of [1, 2, 3, 4, 5]) {
      const r = await slot(s.admin, schoolOffering, {
        weekday,
        startTime: '08:00',
        endTime: '08:45',
        effectiveFrom: '2026-06-01',
        roomId: SC.room,
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const english = idOf(
      await offering(s.admin, {
        termId: SC.term,
        courseId: SC.math,
        sectionId: SC.sec6A,
        offeringKind: 'OPTIONAL',
        groupLabel: 'REMEDIAL',
        registrationPolicy: 'MANUAL',
      }),
    );
    expect(
      (
        await slot(s.admin, english, {
          weekday: 3,
          startTime: '08:30',
          endTime: '09:15',
          effectiveFrom: '2026-06-01',
          roomId: SC.room,
        })
      ).statusCode,
    ).toBe(409);
  });
});

// Teacher and section conflicts (doc 31 §3). Own term, programme, cohort period and sections X/Y on the university campus,
// and further subjects for Grade 6 on the school campus, so the bookings above cannot interfere.
describe('timetable conflicts: teacher and section (audience), schools and universities', () => {
  const C = {} as Record<
    'term' | 'cp' | 'x' | 'y' | 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'sci' | 'hin' | 'fre' | 'sec6B',
    string
  >;
  const O = {} as Record<string, string>;
  const mk = async (key: string, body: Record<string, unknown>) => {
    const r = await offering(s.admin, {
      termId: C.term,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
      ...body,
    });
    expect(r.statusCode, r.body).toBe(201);
    O[key] = idOf(r);
    return O[key];
  };
  const teach = async (
    offeringId: string,
    employeeId: string,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await assign(s.admin, offeringId, { employeeId, validFrom: '2027-01-01', ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return idOf(r);
  };
  // university bookings in the TT term carry no room unless stated, so only the audience / teacher rules apply
  const book = (offeringId: string, body: Record<string, unknown>) =>
    slot(s.admin, offeringId, { effectiveFrom: '2027-01-04', ...body });
  const errMsg = (r: { json: <X>() => X }) =>
    r.json<{ error: { message: string } }>().error.message;

  beforeAll(async () => {
    const yearId = (
      await adminQuery<{ academic_year_id: string }>(
        `SELECT academic_year_id FROM app.terms WHERE id = $1`,
        [U.term],
      )
    )[0]!.academic_year_id;
    const periodType = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.period_types WHERE organization_id = $1 AND code = 'SEM'`,
        [T.orgId],
      )
    )[0]!.id;
    const program = await insert('programs', {
      department_id: T.departmentId,
      period_type_id: periodType,
      name: 'B.Sc Physics',
      code: code('BS'),
      degree_level: 'UG',
      duration_periods: 6,
    });
    const cohort = await insert('cohorts', {
      program_id: program,
      admission_year: 2026,
      name: 'PHY 2026',
    });
    C.term = await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: 'TT',
      name: 'Timetable term',
      start_date: '2027-01-01',
      end_date: '2027-03-31',
    });
    C.cp = await insert('cohort_periods', { cohort_id: cohort, term_id: C.term, period_no: 2 });
    C.x = await insert('sections', { cohort_period_id: C.cp, name: 'X' });
    C.y = await insert('sections', { cohort_period_id: C.cp, name: 'Y' });
    for (const k of ['c1', 'c2', 'c3', 'c4', 'c5'] as const) {
      C[k] = await insert('courses', {
        owning_department_id: T.departmentId,
        code: code(k.toUpperCase()),
        title: `Course ${k}`,
        credits: 3,
        course_type: 'THEORY',
      });
    }
    for (const [k, title] of [
      ['sci', 'Science (Grade 6)'],
      ['hin', 'Hindi (Grade 6)'],
      ['fre', 'French (Grade 6)'],
    ] as const) {
      C[k] = await insert('courses', {
        owning_department_id: SC.dept,
        code: code(k.toUpperCase()),
        title,
        credits: 0,
        course_type: 'THEORY',
      });
    }
    C.sec6B = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.sections WHERE cohort_period_id = $1 AND name = '6-B'`,
        [SC.cp],
      )
    )[0]!.id;
  });

  it('a section cannot have two whole-section classes at once; adjacent slots and other sections are fine', async () => {
    const x1 = await mk('c1X', { courseId: C.c1, sectionId: C.x });
    const x2 = await mk('c2X', { courseId: C.c2, sectionId: C.x });
    const y2 = await mk('c2Y', { courseId: C.c2, sectionId: C.y });
    expect((await book(x1, { weekday: 1, startTime: '09:00', endTime: '10:00' })).statusCode).toBe(
      201,
    );
    const clash = await book(x2, { weekday: 1, startTime: '09:30', endTime: '10:30' });
    expect(clash.statusCode).toBe(409);
    expect(errMsg(clash)).toMatch(/section already has a class/);
    expect((await book(x2, { weekday: 1, startTime: '10:00', endTime: '11:00' })).statusCode).toBe(
      201,
    );
    expect((await book(y2, { weekday: 1, startTime: '09:00', endTime: '10:00' })).statusCode).toBe(
      201,
    );
    // the same offering cannot be in two places at once either
    expect((await book(x1, { weekday: 1, startTime: '09:15', endTime: '09:45' })).statusCode).toBe(
      409,
    );
  });

  it('a cohort-period-wide class blocks every section of the period', async () => {
    const all = await mk('c3all', { courseId: C.c3, cohortPeriodId: C.cp });
    expect((await book(all, { weekday: 2, startTime: '09:00', endTime: '10:00' })).statusCode).toBe(
      201,
    );
    expect(
      (await book(O['c1X']!, { weekday: 2, startTime: '09:30', endTime: '10:30' })).statusCode,
    ).toBe(409);
    expect(
      (await book(O['c2Y']!, { weekday: 2, startTime: '09:00', endTime: '09:45' })).statusCode,
    ).toBe(409);
    expect(
      (await book(O['c2Y']!, { weekday: 2, startTime: '10:00', endTime: '11:00' })).statusCode,
    ).toBe(201);
  });

  it('lab groups and parallel electives of one section may run together, but not against a whole-section class', async () => {
    const g1 = await mk('labG1', {
      courseId: C.c1,
      sectionId: C.x,
      offeringKind: 'LAB_GROUP',
      groupLabel: 'G1',
    });
    const g2 = await mk('labG2', {
      courseId: C.c1,
      sectionId: C.x,
      offeringKind: 'LAB_GROUP',
      groupLabel: 'G2',
    });
    expect((await book(g1, { weekday: 3, startTime: '14:00', endTime: '16:00' })).statusCode).toBe(
      201,
    );
    expect((await book(g2, { weekday: 3, startTime: '14:00', endTime: '16:00' })).statusCode).toBe(
      201,
    );
    expect(
      (await book(O['c1X']!, { weekday: 3, startTime: '15:00', endTime: '16:00' })).statusCode,
    ).toBe(409);
    const e1 = await mk('el1', { courseId: C.c3, sectionId: C.y, offeringKind: 'ELECTIVE' });
    const e2 = await mk('el2', { courseId: C.c4, sectionId: C.y, offeringKind: 'ELECTIVE' });
    expect((await book(e1, { weekday: 4, startTime: '11:00', endTime: '12:00' })).statusCode).toBe(
      201,
    );
    expect((await book(e2, { weekday: 4, startTime: '11:00', endTime: '12:00' })).statusCode).toBe(
      201,
    );
  });

  it('a teacher named on two slots cannot be in two places at once; adjacent slots are fine', async () => {
    const a1 = await teach(O['c1X']!, E.u1);
    const a2 = await teach(O['c2Y']!, E.u1);
    expect(
      (
        await book(O['c1X']!, {
          weekday: 5,
          startTime: '09:00',
          endTime: '10:00',
          facultyAssignmentId: a1,
        })
      ).statusCode,
    ).toBe(201);
    const clash = await book(O['c2Y']!, {
      weekday: 5,
      startTime: '09:30',
      endTime: '10:30',
      facultyAssignmentId: a2,
    });
    expect(clash.statusCode).toBe(409);
    expect(errMsg(clash)).toMatch(/teacher already has a class/);
    expect(
      (
        await book(O['c2Y']!, {
          weekday: 5,
          startTime: '10:00',
          endTime: '11:00',
          facultyAssignmentId: a2,
        })
      ).statusCode,
    ).toBe(201);
    // limitation pinned (doc 31 §3): a slot that names no assignment has no teacher and is not checked
    expect(
      (await book(O['c2Y']!, { weekday: 5, startTime: '09:00', endTime: '09:30' })).statusCode,
    ).toBe(201);
    // a slot cannot start before its teacher's assignment does
    const late = await teach(O['c2X']!, E.u2, { validFrom: '2027-02-01' });
    const early = await book(O['c2X']!, {
      weekday: 6,
      startTime: '09:00',
      endTime: '10:00',
      facultyAssignmentId: late,
    });
    expect(early.statusCode).toBe(409);
    expect(errMsg(early)).toMatch(/assignment is valid/);
  });

  it('two simultaneous conflicting bookings (same teacher, same section): exactly one wins each time', async () => {
    const t1 = await teach(O['c1X']!, E.u3, { teachingRole: 'CO_INSTRUCTOR' });
    const t2 = await teach(O['c2Y']!, E.u3, { teachingRole: 'CO_INSTRUCTOR' });
    const teacher = await Promise.all([
      book(O['c1X']!, {
        weekday: 6,
        startTime: '11:00',
        endTime: '12:00',
        facultyAssignmentId: t1,
      }),
      book(O['c2Y']!, {
        weekday: 6,
        startTime: '11:30',
        endTime: '12:30',
        facultyAssignmentId: t2,
      }),
    ]);
    expect(teacher.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const section = await Promise.all([
      book(O['c1X']!, { weekday: 7, startTime: '09:00', endTime: '10:00' }),
      book(O['c2X']!, { weekday: 7, startTime: '09:30', endTime: '10:30' }),
    ]);
    expect(section.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('a teacher race across offerings with no shared audience: exactly one wins (teacher lock alone)', async () => {
    const t = await employee(T.departmentId);
    // no cohort period: each offering is its own audience, so only the teacher lock serialises these two
    const p1 = await mk('free1', { courseId: C.c2, groupLabel: 'T1' });
    const p2 = await mk('free2', { courseId: C.c3, groupLabel: 'T2' });
    const [a1, a2] = [await teach(p1, t), await teach(p2, t)];
    for (let i = 0; i < 3; i++) {
      const at = `${String(14 + i)}:00`;
      const until = `${String(14 + i)}:50`;
      const race = await Promise.all([
        book(p1, { weekday: 2, startTime: at, endTime: until, facultyAssignmentId: a1 }),
        book(p2, { weekday: 2, startTime: at, endTime: until, facultyAssignmentId: a2 }),
      ]);
      expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    }
  });

  it('the rules bind privileged writers too (database guard, not the service)', async () => {
    const insertRaw = (offeringId: string, extra: Record<string, unknown>) =>
      insert('timetable_slots', {
        course_offering_id: offeringId,
        weekday: 1,
        start_time: '09:00',
        end_time: '10:00',
        effective_from: '2027-01-04',
        ...extra,
      });
    await expect(insertRaw(O['c2X']!, {})).rejects.toThrow(
      /timetable_slots_audience_excl|section already has a class/,
    );
    const a = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.faculty_assignments WHERE course_offering_id = $1 AND employee_id = $2`,
        [O['c2Y']!, E.u1],
      )
    )[0]!.id;
    await expect(
      insertRaw(O['c2Y']!, {
        weekday: 5,
        start_time: '09:30',
        end_time: '10:00',
        faculty_assignment_id: a,
      }),
    ).rejects.toThrow(/teacher already has a class/);
  });

  it('lifecycle: an ended assignment keeps its slots but stops blocking its teacher after validTo', async () => {
    const u2 = await employee(T.departmentId);
    const first = await teach(O['c1X']!, u2, { teachingRole: 'LAB_INSTRUCTOR' });
    const second = await teach(O['c2Y']!, u2, { teachingRole: 'LAB_INSTRUCTOR' });
    const booked = await book(O['c1X']!, {
      weekday: 1,
      startTime: '13:00',
      endTime: '14:00',
      facultyAssignmentId: first,
    });
    expect(booked.statusCode, booked.body).toBe(201);
    const slotId = idOf(booked);
    expect(
      (
        await book(O['c2Y']!, {
          weekday: 1,
          startTime: '13:00',
          endTime: '14:00',
          facultyAssignmentId: second,
        })
      ).statusCode,
    ).toBe(409);
    const ended = await call(
      'PATCH',
      s.admin,
      `/faculty-assignments/${first}`,
      { validTo: '2027-01-31', reason: 'Teacher moved to another lab' },
      { 'if-match': '"1"' },
    );
    expect(ended.statusCode, ended.body).toBe(200);
    // not cascaded: the slot still names the assignment and is still open
    const slots = dataOf<
      { id: string; facultyAssignmentId: string | null; effectiveTo: string | null }[]
    >(await call('GET', s.admin, `/course-offerings/${O['c1X']!}/timetable-slots`));
    expect(slots.find((x) => x.id === slotId)).toMatchObject({
      facultyAssignmentId: first,
      effectiveTo: null,
    });
    // ...but the teacher is free from 1 February, and still busy in January
    expect(
      (
        await book(O['c2Y']!, {
          weekday: 1,
          startTime: '13:00',
          endTime: '14:00',
          facultyAssignmentId: second,
          effectiveFrom: '2027-01-20',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await book(O['c2Y']!, {
          weekday: 1,
          startTime: '13:00',
          endTime: '14:00',
          facultyAssignmentId: second,
          effectiveFrom: '2027-02-01',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('lifecycle: a CANCELLED offering keeps its rows but frees its section and teacher; a CLOSED one still blocks', async () => {
    const u = await employee(T.departmentId);
    const cancelled = await mk('c5Y', { courseId: C.c5, sectionId: C.y });
    const ca = await teach(cancelled, u);
    expect(
      (
        await book(cancelled, {
          weekday: 4,
          startTime: '15:00',
          endTime: '16:00',
          facultyAssignmentId: ca,
        })
      ).statusCode,
    ).toBe(201);
    const other = await mk('c1Y', { courseId: C.c1, sectionId: C.y });
    expect(
      (await book(other, { weekday: 4, startTime: '15:00', endTime: '16:00' })).statusCode,
    ).toBe(409);
    expect(
      (
        await patch(s.admin, cancelled, {
          status: 'CANCELLED',
          reason: 'Course withdrawn this term',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await book(other, { weekday: 4, startTime: '15:00', endTime: '16:00' })).statusCode,
    ).toBe(201);
    const oa = await teach(O['c4X'] ?? (await mk('c4X', { courseId: C.c4, sectionId: C.x })), u);
    expect(
      (
        await book(O['c4X']!, {
          weekday: 4,
          startTime: '15:00',
          endTime: '16:00',
          facultyAssignmentId: oa,
        })
      ).statusCode,
    ).toBe(201);
    // history kept: the cancelled offering's assignment and slot are untouched
    expect(
      dataOf<{ validTo: string | null }[]>(
        await call('GET', s.admin, `/course-offerings/${cancelled}/faculty-assignments`),
      )[0],
    ).toMatchObject({ validTo: null });
    expect(
      dataOf<{ effectiveTo: string | null }[]>(
        await call('GET', s.admin, `/course-offerings/${cancelled}/timetable-slots`),
      )[0],
    ).toMatchObject({ effectiveTo: null });

    // CLOSED (A, owner decision doc 31 §4): its slots keep blocking until the term ends
    const closing = O['c4X']!;
    expect((await patch(s.admin, closing, { status: 'PUBLISHED' })).statusCode).toBe(200);
    expect(
      (await patch(s.admin, closing, { status: 'CLOSED', reason: 'Syllabus completed early' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await book(O['c2X']!, { weekday: 4, startTime: '15:30', endTime: '16:30' })).statusCode,
    ).toBe(409);
  });

  it('school: Grade 6-A cannot take two subjects in one period; second-language options run in parallel', async () => {
    const sci6A = await offering(s.admin, {
      termId: SC.term,
      courseId: C.sci,
      sectionId: SC.sec6A,
      offeringKind: 'CORE',
      registrationPolicy: 'AUTO_FROM_SECTION',
    });
    expect(sci6A.statusCode, sci6A.body).toBe(201);
    const sci = idOf(sci6A);
    // 6-A has Mathematics Mon-Fri 08:00-08:45 (school tests above)
    const clash = await slot(s.admin, sci, {
      weekday: 1,
      startTime: '08:15',
      endTime: '09:00',
      effectiveFrom: '2026-06-01',
    });
    expect(clash.statusCode).toBe(409);
    expect(
      (
        await slot(s.admin, sci, {
          weekday: 1,
          startTime: '08:45',
          endTime: '09:30',
          effectiveFrom: '2026-06-01',
        })
      ).statusCode,
    ).toBe(201);
    const lang = async (courseId: string) =>
      idOf(
        await offering(s.admin, {
          termId: SC.term,
          courseId,
          sectionId: C.sec6B,
          offeringKind: 'OPTIONAL',
          registrationPolicy: 'ADMIN_ASSIGNED',
        }),
      );
    for (const id of [await lang(C.hin), await lang(C.fre)]) {
      expect(
        (
          await slot(s.admin, id, {
            weekday: 2,
            startTime: '10:00',
            endTime: '10:45',
            effectiveFrom: '2026-06-01',
          })
        ).statusCode,
      ).toBe(201);
    }
  });

  it('school: a subject teacher cannot teach 6-A and 6-B in the same period', async () => {
    const mathAssignment = dataOf<{ id: string; employeeId: string; validTo: string | null }[]>(
      await call('GET', s.admin, `/course-offerings/${schoolOffering}/faculty-assignments`),
    ).find((a) => a.employeeId === E.school && a.validTo === null)!.id;
    const sci6B = idOf(
      await offering(s.admin, {
        termId: SC.term,
        courseId: C.sci,
        sectionId: C.sec6B,
        offeringKind: 'CORE',
        registrationPolicy: 'AUTO_FROM_SECTION',
      }),
    );
    const sciAssignment = idOf(
      await assign(s.admin, sci6B, { employeeId: E.school, validFrom: '2026-06-01' }),
    );
    const at = (id: string, a: string, startTime: string, endTime: string) =>
      slot(s.admin, id, {
        weekday: 3,
        startTime,
        endTime,
        effectiveFrom: '2026-06-01',
        facultyAssignmentId: a,
      });
    expect((await at(schoolOffering, mathAssignment, '11:00', '11:45')).statusCode).toBe(201);
    expect((await at(sci6B, sciAssignment, '11:00', '11:45')).statusCode).toBe(409);
    expect((await at(sci6B, sciAssignment, '11:45', '12:30')).statusCode).toBe(201);
  });
});

describe('scope, roles and tenant isolation', () => {
  it('a campus administrator manages its campus only; the school offering is invisible (404)', async () => {
    expect((await call('GET', s.campusAdmin, `/course-offerings/${uniOffering}`)).statusCode).toBe(
      200,
    );
    expect(
      (await call('GET', s.campusAdmin, `/course-offerings/${schoolOffering}`)).statusCode,
    ).toBe(404);
    expect((await patch(s.campusAdmin, schoolOffering, { capacity: 40 })).statusCode).toBe(404);
    expect(
      (
        await assign(s.campusAdmin, schoolOffering, {
          employeeId: E.school,
          teachingRole: 'SUBSTITUTE',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', s.campusAdmin, `/course-offerings/${schoolOffering}/timetable-slots`))
        .statusCode,
    ).toBe(404);
    const listed = dataOf<{ id: string }[]>(
      await call('GET', s.campusAdmin, '/course-offerings'),
    ).map((o) => o.id);
    expect(listed).toContain(uniOffering);
    expect(listed).not.toContain(schoolOffering);
    const r = await offering(s.campusAdmin, {
      termId: SC.term,
      courseId: SC.math,
      sectionId: SC.sec6A,
      offeringKind: 'ELECTIVE',
      groupLabel: 'X',
      registrationPolicy: 'MANUAL',
    });
    expect(r.statusCode).toBe(404);
  });

  it('an HOD reads its department (read permission) but cannot manage or assign (403)', async () => {
    expect((await call('GET', s.hod, `/course-offerings/${uniOffering}`)).statusCode).toBe(200);
    expect((await call('GET', s.hod, `/course-offerings/${schoolOffering}`)).statusCode).toBe(404);
    expect((await offering(s.hod, core({ groupLabel: 'H1' }))).statusCode).toBe(403);
    expect(
      (await assign(s.hod, uniOffering, { employeeId: E.u2, teachingRole: 'SUBSTITUTE' }))
        .statusCode,
    ).toBe(403);
    expect((await slot(s.hod, uniOffering, { weekday: 6 })).statusCode).toBe(403);
  });

  it('a student reads offerings and slots but never faculty assignments (staff-only rows)', async () => {
    expect((await call('GET', s.student, `/course-offerings/${uniOffering}`)).statusCode).toBe(200);
    const fa = await call('GET', s.student, `/course-offerings/${uniOffering}/faculty-assignments`);
    expect(fa.statusCode).toBe(200);
    expect(dataOf<unknown[]>(fa)).toEqual([]);
    expect((await offering(s.student, core({ groupLabel: 'S1' }))).statusCode).toBe(403);
  });

  it("another tenant's administrator gets 404 everywhere and sees none of these rows", async () => {
    for (const path of [
      `/course-offerings/${uniOffering}`,
      `/course-offerings/${uniOffering}/faculty-assignments`,
      `/course-offerings/${uniOffering}/timetable-slots`,
    ]) {
      expect((await call('GET', s.foreignAdmin, path)).statusCode, path).toBe(404);
    }
    expect((await patch(s.foreignAdmin, uniOffering, { capacity: 5 })).statusCode).toBe(404);
    expect(
      (await assign(s.foreignAdmin, uniOffering, { employeeId: E.u2, teachingRole: 'SUBSTITUTE' }))
        .statusCode,
    ).toBe(404);
    expect((await slot(s.foreignAdmin, uniOffering, { weekday: 7 })).statusCode).toBe(404);
    expect((await offering(s.foreignAdmin, core({ groupLabel: 'F1' }))).statusCode).toBe(404);
    const listed = dataOf<{ id: string }[]>(await call('GET', s.foreignAdmin, '/course-offerings'));
    expect(listed.map((o) => o.id)).not.toContain(uniOffering);
  });

  it('nonexistent, malformed and unauthenticated requests are safe', async () => {
    expect((await call('GET', s.admin, `/course-offerings/${uuidv7()}`)).statusCode).toBe(404);
    expect((await call('GET', s.admin, '/course-offerings/not-an-id')).statusCode).toBe(400);
    expect((await call('GET', null, `/course-offerings/${uniOffering}`)).statusCode).toBe(401);
  });
});

describe('a LOCKED term freezes everything under it', () => {
  it('no offering change, assignment or slot once the term is LOCKED', async () => {
    const id = idOf(
      await offering(s.admin, {
        termId: U.lockTerm,
        courseId: U.course,
        offeringKind: 'PROJECT',
        registrationPolicy: 'ADMIN_ASSIGNED',
      }),
    );
    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE organization_id = $1`, [
      T.orgId,
    ]);
    for (const st of ['ACTIVE', 'CLOSED']) {
      await adminQuery(`UPDATE app.terms SET status = $2 WHERE id = $1`, [U.lockTerm, st]);
    }
    await adminQuery(
      `UPDATE app.terms SET status = 'LOCKED', locked_at = now(), locked_by = $2 WHERE id = $1`,
      [U.lockTerm, T.users.admin],
    );
    expect((await patch(s.admin, id, { capacity: 3 })).statusCode).toBe(409);
    expect(
      (await assign(s.admin, id, { employeeId: E.u2, validFrom: '2027-04-01' })).statusCode,
    ).toBe(409);
    expect((await slot(s.admin, id, { weekday: 4, effectiveFrom: '2027-04-01' })).statusCode).toBe(
      409,
    );
    // and a new offering in a LOCKED term is refused too
    expect(
      (
        await offering(s.admin, {
          termId: U.lockTerm,
          courseId: U.orgCourse,
          cohortPeriodId: undefined,
          offeringKind: 'CORE',
          registrationPolicy: 'MANUAL',
        })
      ).statusCode,
    ).toBe(400); // an org-wide course without a cohort period is refused first (no department)
    expect(
      (
        await offering(s.admin, {
          termId: U.lockTerm,
          courseId: U.course,
          offeringKind: 'INTERNSHIP',
          registrationPolicy: 'ADMIN_ASSIGNED',
        })
      ).statusCode,
    ).toBe(409);
  });
});
