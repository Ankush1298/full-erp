import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified, runAs } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { activateTermFixture } from '../support/term-fixture.js';

// Milestone 4, Slice 1 (migration 0040, doc 41) over HTTP in private tenants: class sessions, first submission of
// attendance (record + revision 1 + session state in one transaction), the X-12 ASSIGNED resolver for attendance.session.mark
// and attendance.record.read, idempotency, tenant isolation, and the database guarantees (append-only revisions, record <->
// revision pairing, roster rule, student-self row security). Synthetic data only. Dates are relative to "today" on the
// campus calendar (Asia/Kolkata), because the resolver and the guards evaluate the session date, not the wall clock.

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
const isoWeekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
/** 10:00-11:00 Asia/Kolkata on `date`, as instants. */
const slot = (date: string, hour = 10) => {
  const start = Date.parse(`${date}T00:00:00Z`) + (hour - 5.5) * 3_600_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  };
};

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let HASH = '';
interface Session {
  cookie: string;
  csrf: string;
}
const s = {} as Record<
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'student'
  | 'main'
  | 'ended'
  | 'future'
  | 'stranger'
  | 'foreignAdmin'
  | 'foreignFaculty',
  Session
>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);
const key = (): string => `k-${randomBytes(12).toString('hex')}`;

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

async function facultyUser(
  org: IsolatedTenant,
): Promise<{ user: string; employee: string; email: string }> {
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
  await adminQuery(
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION' FROM app.roles r
      WHERE r.organization_id = $2::uuid AND r.code = 'FACULTY'`,
    [uuidv7(), org.orgId, user],
  );
  const employee = await insertIn(org.orgId, 'employees', {
    user_id: user,
    employee_code: code('E'),
    employee_type: 'FACULTY',
    joining_date: '2020-06-01',
    status: 'ACTIVE',
  });
  return { user, employee, email };
}

async function pupil(term: string, cp: string, program: string, cohort: string, student?: string) {
  const sid =
    student ??
    (await (async () => {
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
      return insert('students', {
        user_id: u,
        admission_number: code('ADM'),
        admission_date: '2026-06-01',
        status: 'ACTIVE',
      });
    })());
  const sp = await insert('student_programs', {
    student_id: sid,
    program_id: program,
    cohort_id: cohort,
    campus_id: T.campusId,
    department_id: T.departmentId,
    start_date: '2026-06-01',
    status: 'ACTIVE',
  });
  const eid = await insert('term_enrollments', {
    student_id: sid,
    student_program_id: sp,
    cohort_period_id: cp,
    term_id: term,
    period_no: 1,
  });
  await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [eid]);
  return { student: sid, eid };
}

const U = {} as Record<
  | 'year'
  | 'term'
  | 'program'
  | 'cohort'
  | 'cp'
  | 'offering'
  | 'draft'
  | 'other'
  | 'untracked'
  | 'closed',
  string
>;
const F = {} as Record<
  'main' | 'ended' | 'future' | 'stranger',
  { user: string; employee: string; email: string }
>;
const roster: Array<{ student: string; eid: string; registration: string }> = [];

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
  const sem = await insert('period_types', {
    code: 'SEM',
    label: 'Semester',
    label_plural: 'Semesters',
  });
  U.program = await insert('programs', {
    department_id: T.departmentId,
    period_type_id: sem,
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
  U.term = await insert('terms', {
    campus_id: T.campusId,
    academic_year_id: U.year,
    code: 'A',
    name: 'A',
    start_date: D(-60),
    end_date: D(60),
  });
  U.cp = await insert('cohort_periods', { cohort_id: U.cohort, term_id: U.term, period_no: 1 });
  const course = (title: string, tracks = true) =>
    insert('courses', {
      tracks_attendance: tracks,
      owning_department_id: T.departmentId,
      code: code('C'),
      title,
      credits: 3,
      course_type: 'THEORY',
    });

  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.hod = await login(T.emails.hod);
  s.student = await login(T.emails.studentOne);
  s.foreignAdmin = await login(OTHER.emails.admin);

  const publish = async (title: string, publishIt: boolean, tracks = true): Promise<string> => {
    const r = await call('POST', s.admin, '/academics/course-offerings', {
      termId: U.term,
      courseId: await course(title, tracks),
      cohortPeriodId: U.cp,
      offeringKind: 'OPTIONAL',
      registrationPolicy: 'MANUAL',
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = idOf(r);
    if (publishIt) {
      const p = await call(
        'PATCH',
        s.admin,
        `/academics/course-offerings/${id}`,
        { status: 'PUBLISHED' },
        { 'if-match': '"1"' },
      );
      expect(p.statusCode, p.body).toBe(200);
    }
    return id;
  };
  U.offering = await publish('Algorithms', true);
  U.draft = await publish('Draft course', false);
  U.other = await publish('Other course', true);
  U.untracked = await publish('Project work', true, false);
  U.closed = await publish('Closed course', true);

  for (const k of ['main', 'ended', 'future', 'stranger'] as const) F[k] = await facultyUser(T);
  const fa = (offering: string, emp: string, from: string, to?: string, role = 'PRIMARY') =>
    insert('faculty_assignments', {
      course_offering_id: offering,
      employee_id: emp,
      role,
      valid_from: from,
      ...(to ? { valid_to: to } : {}),
    });
  await fa(U.offering, F.main.employee, D(-60));
  await fa(U.offering, F.ended.employee, D(-60), D(-10), 'CO_INSTRUCTOR');
  await fa(U.offering, F.future.employee, D(30), undefined, 'CO_INSTRUCTOR');
  await fa(U.draft, F.main.employee, D(-60));
  await fa(U.untracked, F.main.employee, D(-60));
  await fa(U.closed, F.main.employee, D(-60));
  await adminQuery(`UPDATE app.course_offerings SET status = 'CLOSED' WHERE id = $1`, [U.closed]);
  await fa(U.other, F.stranger.employee, D(-60));
  s.main = await login(F.main.email);
  s.ended = await login(F.ended.email);
  s.future = await login(F.future.email);
  s.stranger = await login(F.stranger.email);
  const foreign = await facultyUser(OTHER);
  s.foreignFaculty = await login(foreign.email);

  // roster: the seeded student one (a login-able student) plus three more, all registered from D(-30)
  const members = [
    await pupil(U.term, U.cp, U.program, U.cohort, T.students.one),
    await pupil(U.term, U.cp, U.program, U.cohort),
    await pupil(U.term, U.cp, U.program, U.cohort),
    await pupil(U.term, U.cp, U.program, U.cohort),
  ];
  for (const m of members) {
    const r = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${U.offering}/registrations`,
      {
        termEnrollmentId: m.eid,
        validFrom: D(-30),
        source: 'MANUAL',
        reason: 'Registered by the office',
      },
    );
    expect(r.statusCode, r.body).toBe(201);
    roster.push({ ...m, registration: idOf(r) });
  }
  // a student registered only from D(5): not on the roster for earlier dates
  const late = await pupil(U.term, U.cp, U.program, U.cohort);
  const lr = await call(
    'POST',
    s.admin,
    `/academics/course-offerings/${U.offering}/registrations`,
    {
      termEnrollmentId: late.eid,
      validFrom: D(5),
      source: 'MANUAL',
      reason: 'Registered by the office',
    },
  );
  expect(lr.statusCode, lr.body).toBe(201);

  await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [U.year]);
  await activateTermFixture(U.term);
}, 240_000);

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
        'attendance_correction_requests',
        'attendance_policies',
        'attendance_record_revisions',
        'attendance_records',
        'class_sessions',
        'course_registrations',
        'holidays',
        'timetable_slots',
        'faculty_assignments',
        'course_offerings',
        'section_memberships',
        'term_enrollments',
        'student_programs',
        'organization_settings',
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

const createSession = (
  who: Session | null,
  body: Record<string, unknown>,
  k: string | null = key(),
) => call('POST', who, '/attendance/sessions', body, k ? { 'idempotency-key': k } : {});
const sessionBody = (date: string, hour = 10, extra: Record<string, unknown> = {}) => ({
  courseOfferingId: U.offering,
  sessionDate: date,
  ...slot(date, hour),
  ...extra,
});
const submit = (who: Session | null, id: string, records: object[], k: string | null = key()) =>
  call(
    'POST',
    who,
    `/attendance/sessions/${id}/attendance`,
    { records },
    k ? { 'idempotency-key': k } : {},
  );
const fullRoster = (status = 'PRESENT') => roster.map((m) => ({ studentId: m.student, status }));
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await adminQuery<{ n: string }>(sql, p))[0]!.n);

describe('class sessions: authorization (X-12 ASSIGNED, 403/404 semantics)', () => {
  it('the permission is held by FACULTY only; admins and students get 403', async () => {
    expect((await createSession(s.admin, sessionBody(D(-3)))).statusCode).toBe(403);
    expect((await createSession(s.campusAdmin, sessionBody(D(-3)))).statusCode).toBe(403);
    expect((await createSession(s.student, sessionBody(D(-3)))).statusCode).toBe(403);
    expect((await createSession(null, sessionBody(D(-3)))).statusCode).toBe(401);
  });

  it("an assigned teacher creates a session; the teacher recorded is the actor's own employee row", async () => {
    const r = await createSession(s.main, sessionBody(D(-3)));
    expect(r.statusCode, r.body).toBe(201);
    const row = (
      await adminQuery<{
        conducted_by_employee_id: string;
        campus_id: string;
        status: string;
        attendance_state: string;
      }>(
        `SELECT conducted_by_employee_id, campus_id, status, attendance_state FROM app.class_sessions WHERE id = $1`,
        [idOf(r)],
      )
    )[0]!;
    expect(row.conducted_by_employee_id).toBe(F.main.employee);
    expect(row.campus_id).toBe(T.campusId);
    expect([row.status, row.attendance_state]).toEqual(['SCHEDULED', 'NOT_STARTED']);
  });

  it('no assignment, an ended or a future assignment, another tenant, and a missing offering all read as the same 404', async () => {
    const missing = await createSession(s.main, {
      ...sessionBody(D(-3)),
      courseOfferingId: uuidv7(),
    });
    expect(missing.statusCode).toBe(404);
    for (const who of [s.stranger, s.ended, s.future, s.foreignFaculty]) {
      const r = await createSession(who, sessionBody(D(-4)));
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json<{ error: object }>().error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested resource was not found.',
      });
    }
    // the ended assignment covered D(-20): the same teacher passes for a date inside the assignment
    expect((await createSession(s.ended, sessionBody(D(-20)))).statusCode).toBe(201);
    expect((await createSession(s.ended, sessionBody(D(-9)))).statusCode).toBe(404);
  });

  it('a body cannot name the teacher, campus or state: unknown fields are rejected', async () => {
    for (const extra of [
      { conductedByEmployeeId: F.stranger.employee },
      { campusId: OTHER.campusId },
      { attendanceState: 'SUBMITTED' },
    ]) {
      expect((await createSession(s.main, sessionBody(D(-5), 10, extra))).statusCode).toBe(400);
    }
  });
});

describe('class sessions: guards and idempotency', () => {
  it('Idempotency-Key: 428 missing, 400 malformed, replay returns the same id, a different body is 422', async () => {
    expect((await createSession(s.main, sessionBody(D(-6)), null)).statusCode).toBe(428);
    expect((await createSession(s.main, sessionBody(D(-6)), 'short')).statusCode).toBe(400);
    const k = key();
    const first = await createSession(s.main, sessionBody(D(-6)), k);
    expect(first.statusCode, first.body).toBe(201);
    const again = await createSession(s.main, sessionBody(D(-6)), k);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(idOf(again)).toBe(idOf(first));
    expect(
      await count(
        `SELECT count(*) AS n FROM app.class_sessions WHERE organization_id = $1 AND session_date = $2`,
        [T.orgId, D(-6)],
      ),
    ).toBe(1);
    expect((await createSession(s.main, sessionBody(D(-6), 14), k)).statusCode).toBe(422);
    // another start time on the same day is a different session; the same start time is a 409 with a new key
    expect((await createSession(s.main, sessionBody(D(-6), 14))).statusCode).toBe(201);
    expect((await createSession(s.main, sessionBody(D(-6)))).statusCode).toBe(409);
  });

  it('the offering must be PUBLISHED and track attendance; the date must lie in an ACTIVE term; not on a holiday', async () => {
    // CLOSED passes the ASSIGNED proof but the database guard refuses a new session; an offering that does not track attendance too
    for (const offering of [U.closed, U.untracked]) {
      const r = await createSession(s.main, { ...sessionBody(D(-7)), courseOfferingId: offering });
      expect(r.statusCode, r.body).toBe(409);
    }
    expect((await createSession(s.main, sessionBody(D(-70)))).statusCode).toBe(404); // outside the assignment: scope first
    expect((await createSession(s.main, sessionBody(D(61)))).statusCode).toBe(404);
    await insert('holidays', {
      campus_id: T.campusId,
      holiday_date: D(-8),
      name: 'Founders day',
      kind: 'HOLIDAY',
    });
    const onHoliday = await createSession(s.main, sessionBody(D(-8)));
    expect(onHoliday.statusCode).toBe(409);
    expect(
      (await createSession(s.main, sessionBody(D(-8), 10, { kind: 'EXTRA' }))).statusCode,
    ).toBe(201);
  });

  it('the instants must fall on session_date in the campus time zone; a timetable slot must fit the offering and weekday', async () => {
    const wrongDay = { ...sessionBody(D(-11)), ...slot(D(-12)) };
    expect((await createSession(s.main, wrongDay)).statusCode).toBe(409);
    const good = await insert('timetable_slots', {
      course_offering_id: U.offering,
      weekday: isoWeekday(D(-13)),
      start_time: '10:00',
      end_time: '11:00',
      effective_from: D(-60),
    });
    const bad = await insert('timetable_slots', {
      course_offering_id: U.offering,
      weekday: (isoWeekday(D(-13)) % 7) + 1,
      start_time: '10:00',
      end_time: '11:00',
      effective_from: D(-60),
    });
    expect(
      (await createSession(s.main, sessionBody(D(-13), 10, { timetableSlotId: bad }))).statusCode,
    ).toBe(409);
    expect(
      (await createSession(s.main, sessionBody(D(-13), 10, { timetableSlotId: good }))).statusCode,
    ).toBe(201);
  });

  it('a draft offering fails closed even for a teacher with a valid assignment (not PUBLISHED: no ASSIGNED proof, 404)', async () => {
    const r = await createSession(s.main, { ...sessionBody(D(-9)), courseOfferingId: U.draft });
    expect(r.statusCode).toBe(404);
  });
});

describe('first submission of attendance', () => {
  let sessionId = '';
  let recordIds: string[] = [];

  it('the roster is the registrations live on the session date: an early date excludes a later registration', async () => {
    const r = await createSession(s.main, sessionBody(D(-2)));
    expect(r.statusCode, r.body).toBe(201);
    sessionId = idOf(r);
    // a partial, a padded (extra student) and an empty list are all refused; nothing is written
    expect((await submit(s.main, sessionId, fullRoster().slice(1))).statusCode).toBe(409);
    expect(
      (
        await submit(s.main, sessionId, [
          ...fullRoster(),
          { studentId: uuidv7(), status: 'ABSENT' },
        ])
      ).statusCode,
    ).toBe(409);
    expect((await submit(s.main, sessionId, [])).statusCode).toBe(400);
    expect((await submit(s.main, sessionId, [...fullRoster(), fullRoster()[0]!])).statusCode).toBe(
      400,
    );
    expect(
      await count(`SELECT count(*) AS n FROM app.attendance_records WHERE class_session_id = $1`, [
        sessionId,
      ]),
    ).toBe(0);
    const state = await adminQuery<{ attendance_state: string; status: string }>(
      `SELECT attendance_state, status FROM app.class_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(state[0]).toEqual({ attendance_state: 'NOT_STARTED', status: 'SCHEDULED' });
  });

  it('other teachers and roles cannot submit (404 for an unassigned teacher, 403 without the permission)', async () => {
    expect((await submit(s.stranger, sessionId, fullRoster())).statusCode).toBe(404);
    expect((await submit(s.foreignFaculty, sessionId, fullRoster())).statusCode).toBe(404);
    expect((await submit(s.admin, sessionId, fullRoster())).statusCode).toBe(403);
    expect((await submit(s.student, sessionId, fullRoster())).statusCode).toBe(403);
    expect((await submit(s.main, uuidv7(), fullRoster())).statusCode).toBe(404);
  });

  it('submits record + revision 1 (status_before NULL, reason OTHER) + SUBMITTED atomically, and audits it', async () => {
    const k = key();
    const body = [
      { studentId: roster[0]!.student, status: 'PRESENT' },
      { studentId: roster[1]!.student, status: 'ABSENT', remarks: 'No show' },
      { studentId: roster[2]!.student, status: 'LATE' },
      { studentId: roster[3]!.student, status: 'EXCUSED' },
    ];
    const r = await submit(s.main, sessionId, body, k);
    expect(r.statusCode, r.body).toBe(201);
    expect(dataOf<{ recordCount: number; counts: Record<string, number> }>(r)).toMatchObject({
      recordCount: 4,
      counts: { PRESENT: 1, ABSENT: 1, LATE: 1, EXCUSED: 1 },
    });
    const sess = (
      await adminQuery<{
        status: string;
        attendance_state: string;
        attendance_submitted_by: string;
      }>(
        `SELECT status, attendance_state, attendance_submitted_by FROM app.class_sessions WHERE id = $1`,
        [sessionId],
      )
    )[0]!;
    expect(sess).toEqual({
      status: 'CONDUCTED',
      attendance_state: 'SUBMITTED',
      attendance_submitted_by: F.main.user,
    });
    const revs = await adminQuery<{
      revision_no: number;
      status_before: string | null;
      reason_code: string;
      reason_text: string;
      source: string;
    }>(
      `SELECT v.revision_no, v.status_before, v.reason_code, v.reason_text, v.source
         FROM app.attendance_record_revisions v JOIN app.attendance_records r ON r.id = v.attendance_record_id
        WHERE r.class_session_id = $1`,
      [sessionId],
    );
    expect(revs).toHaveLength(4);
    for (const v of revs)
      expect(v).toEqual({
        revision_no: 1,
        status_before: null,
        reason_code: 'OTHER',
        reason_text: 'Initial marking',
        source: 'MANUAL',
      });
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE action = 'attendance.session.submit' AND resource_id = $1`,
        [sessionId],
      ),
    ).toBe(1);

    // same key and body: replay, nothing re-written; a new key: 409 (state is under the row lock); same key other body: 422
    const replay = await submit(s.main, sessionId, body, k);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await submit(s.main, sessionId, body)).statusCode).toBe(409);
    expect((await submit(s.main, sessionId, fullRoster('ABSENT'), k)).statusCode).toBe(422);
    expect(
      await count(`SELECT count(*) AS n FROM app.attendance_records WHERE class_session_id = $1`, [
        sessionId,
      ]),
    ).toBe(4);
  });

  it('two simultaneous submissions with different keys: exactly one wins, the other is 409', async () => {
    const r = await createSession(s.main, sessionBody(D(-14)));
    const id = idOf(r);
    const results = await Promise.all([
      submit(s.main, id, fullRoster()),
      submit(s.main, id, fullRoster('ABSENT')),
    ]);
    expect(results.map((x) => x.statusCode).sort()).toEqual([201, 409]);
    expect(
      await count(`SELECT count(*) AS n FROM app.attendance_records WHERE class_session_id = $1`, [
        id,
      ]),
    ).toBe(4);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.attendance_record_revisions v JOIN app.attendance_records r ON r.id = v.attendance_record_id WHERE r.class_session_id = $1`,
        [id],
      ),
    ).toBe(4);
  });

  it('the roster follows the date: a registration that starts later joins the roster of a later session only', async () => {
    const early = idOf(await createSession(s.main, sessionBody(D(-15))));
    expect((await submit(s.main, early, fullRoster())).statusCode).toBe(201);
    const lateSession = idOf(await createSession(s.main, sessionBody(D(-1), 15)));
    // registered from D(5): still not on the roster of D(-1)
    expect((await submit(s.main, lateSession, fullRoster())).statusCode).toBe(201);
  });

  describe('reads', () => {
    it('assigned faculty, HOD (department), CAMPUS_ADMIN and COLLEGE_ADMIN read the records; others get 404/403', async () => {
      for (const who of [s.main, s.hod, s.campusAdmin, s.admin]) {
        const r = await call('GET', who, `/attendance/sessions/${sessionId}/records`);
        expect(r.statusCode, r.body).toBe(200);
        const rows =
          dataOf<Array<{ id: string; studentId: string; status: string; revisionNo: number }>>(r);
        expect(rows).toHaveLength(4);
        recordIds = rows.map((x) => x.id);
        expect(rows.every((x) => x.revisionNo === 1)).toBe(true);
        expect((await call('GET', who, `/attendance/sessions/${sessionId}`)).statusCode).toBe(200);
      }
      const unknown = await call('GET', s.stranger, `/attendance/sessions/${uuidv7()}/records`);
      expect(unknown.statusCode).toBe(404);
      for (const who of [s.stranger, s.ended, s.future, s.foreignAdmin, s.foreignFaculty]) {
        const r = await call('GET', who, `/attendance/sessions/${sessionId}/records`);
        expect(r.statusCode, r.body).toBe(404);
        expect(r.json<{ error: object }>().error).toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
          message: 'The requested resource was not found.',
        });
      }
      expect(
        (await call('GET', s.student, `/attendance/sessions/${sessionId}/records`)).statusCode,
      ).toBe(403);
      expect(
        (await call('GET', null, `/attendance/sessions/${sessionId}/records`)).statusCode,
      ).toBe(401);
    });

    it("a record's revision history is readable by the same actors and no one else", async () => {
      const r = await call('GET', s.hod, `/attendance/records/${recordIds[0]}/revisions`);
      expect(r.statusCode, r.body).toBe(200);
      expect(dataOf<Array<{ revisionNo: number; statusBefore: string | null }>>(r)).toMatchObject([
        { revisionNo: 1, statusBefore: null },
      ]);
      expect(
        (await call('GET', s.stranger, `/attendance/records/${recordIds[0]}/revisions`)).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', s.foreignAdmin, `/attendance/records/${recordIds[0]}/revisions`))
          .statusCode,
      ).toBe(404);
    });
  });
});

describe('database guarantees (the guards run for every writer, the harness superuser included)', () => {
  let sessionId = '';
  let recordId = '';
  let studentOneRecord = '';

  beforeAll(async () => {
    sessionId = idOf(await createSession(s.main, sessionBody(D(-16))));
    expect((await submit(s.main, sessionId, fullRoster())).statusCode).toBe(201);
    const rows = await adminQuery<{ id: string; student_id: string }>(
      `SELECT id, student_id FROM app.attendance_records WHERE class_session_id = $1 ORDER BY student_id`,
      [sessionId],
    );
    recordId = rows[0]!.id;
    studentOneRecord = rows.find((r) => r.student_id === T.students.one)!.id;
  });

  const expectFails = async (sql: string, params: unknown[], pattern: RegExp) => {
    await expect(adminQuery(sql, params)).rejects.toThrow(pattern);
  };

  it('revisions are append-only for every role: UPDATE and DELETE are rejected', async () => {
    await expectFails(
      `UPDATE app.attendance_record_revisions SET reason_text = 'tamper' WHERE attendance_record_id = $1`,
      [recordId],
      /append-only/,
    );
    await expectFails(
      `DELETE FROM app.attendance_record_revisions WHERE attendance_record_id = $1`,
      [recordId],
      /append-only/,
    );
  });

  it('records and sessions are never deleted', async () => {
    await expectFails(
      `DELETE FROM app.attendance_records WHERE id = $1`,
      [recordId],
      /append-only/,
    );
    await expectFails(`DELETE FROM app.class_sessions WHERE id = $1`, [sessionId], /append-only/);
  });

  it('no silent overwrite: changing a record without a paired revision fails at commit and changes nothing', async () => {
    await expectFails(
      `UPDATE app.attendance_records SET status = 'ABSENT', revision_no = 2 WHERE id = $1`,
      [recordId],
      /out of step/,
    );
    await expectFails(
      `UPDATE app.attendance_records SET status = 'ABSENT' WHERE id = $1`,
      [recordId],
      /advance revision_no/,
    );
    const rec = (
      await adminQuery<{ status: string; revision_no: number }>(
        `SELECT status, revision_no FROM app.attendance_records WHERE id = $1`,
        [recordId],
      )
    )[0]!;
    expect(rec).toEqual({ status: 'PRESENT', revision_no: 1 });
  });

  it('a revision without a record change is refused as well (the pairing is checked both ways)', async () => {
    await expectFails(
      `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code)
       VALUES ($1, $2, $3, 2, 'PRESENT', 'ABSENT', 'CORRECTION', $4, 'FACULTY_ERROR')`,
      [uuidv7(), T.orgId, recordId, F.main.user],
      /out of step/,
    );
  });

  it('a correction is revision N+1 written with the record in ONE transaction; history stays complete', async () => {
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE app.attendance_records SET status = 'ABSENT', source = 'CORRECTION', marked_by_user_id = $2, marked_at = now(), revision_no = 2 WHERE id = $1`,
        [studentOneRecord, F.main.user],
      );
      await c.query(
        `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code, reason_text)
         VALUES ($1, $2, $3, 2, 'PRESENT', 'ABSENT', 'CORRECTION', $4, 'FACULTY_ERROR', 'Marked present by mistake')`,
        [uuidv7(), T.orgId, studentOneRecord, F.main.user],
      );
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    const r = await call('GET', s.hod, `/attendance/records/${studentOneRecord}/revisions`);
    expect(
      dataOf<
        Array<{
          revisionNo: number;
          statusBefore: string | null;
          statusAfter: string;
          reasonCode: string;
        }>
      >(r),
    ).toMatchObject([
      { revisionNo: 1, statusBefore: null, statusAfter: 'PRESENT' },
      {
        revisionNo: 2,
        statusBefore: 'PRESENT',
        statusAfter: 'ABSENT',
        reasonCode: 'FACULTY_ERROR',
      },
    ]);
  });

  it('revision rules: only revision 1 may have a NULL status_before, a later revision must chain and must change the value', async () => {
    const ins = (no: number, before: string | null, after: string) =>
      adminQuery(
        `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6, 'CORRECTION', $7, 'OTHER')`,
        [uuidv7(), T.orgId, studentOneRecord, no, before, after, F.main.user],
      );
    await expect(ins(3, null, 'LATE')).rejects.toThrow(/status_before must equal/);
    await expect(ins(3, 'ABSENT', 'ABSENT')).rejects.toThrow(/attendance_revisions_changed_ck/);
    await expect(ins(4, 'ABSENT', 'LATE')).rejects.toThrow(/contiguous/);
    await expect(ins(3, 'PRESENT', 'LATE')).rejects.toThrow(/status_before must equal/);
  });

  it('a record needs a live registration on the session date; a cancelled/submitted session takes no new record', async () => {
    const outsider = await pupil(U.term, U.cp, U.program, U.cohort);
    const reg = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${U.offering}/registrations`,
      {
        termEnrollmentId: outsider.eid,
        validFrom: D(10),
        source: 'MANUAL',
        reason: 'Registered by the office',
      },
    );
    const sid = idOf(await createSession(s.main, sessionBody(D(-17))));
    await expectFails(
      `INSERT INTO app.attendance_records (id, organization_id, class_session_id, student_id, course_registration_id, course_offering_id, session_date, status, source, marked_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PRESENT', 'MANUAL', $8)`,
      [uuidv7(), T.orgId, sid, outsider.student, idOf(reg), U.offering, D(-17), F.main.user],
      /no live registration/,
    );
    await expectFails(
      `INSERT INTO app.attendance_records (id, organization_id, class_session_id, student_id, course_registration_id, course_offering_id, session_date, status, source, marked_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PRESENT', 'MANUAL', $8)`,
      [uuidv7(), T.orgId, sessionId, outsider.student, idOf(reg), U.offering, D(-16), F.main.user],
      /not open for marking/,
    );
  });

  it('session identity and submission facts are immutable; the state machine only moves forward', async () => {
    await expectFails(
      `UPDATE app.class_sessions SET session_date = $2 WHERE id = $1`,
      [sessionId, D(-20)],
      /identity columns are immutable/,
    );
    await expectFails(
      `UPDATE app.class_sessions SET attendance_state = 'NOT_STARTED' WHERE id = $1`,
      [sessionId],
      /invalid attendance state transition/,
    );
    await expectFails(
      `UPDATE app.class_sessions SET status = 'CANCELLED', cancel_reason = 'x' WHERE id = $1`,
      [sessionId],
      /invalid class session status transition/,
    );
  });

  it('student-self row security: a student sees only their own records, revisions and sessions, and writes nothing', async () => {
    const me = { tenant: T.orgId, user: T.users.studentOne, kind: 'STUDENT' as const };
    const recs = await runAs(
      me,
      `SELECT student_id FROM app.attendance_records WHERE class_session_id = $1`,
      [sessionId],
    );
    expect(recs.rows.map((r) => r['student_id'])).toEqual([T.students.one]);
    const vs = await runAs(me, `SELECT attendance_record_id FROM app.attendance_record_revisions`);
    expect(vs.rows.length).toBeGreaterThan(0);
    const mine = await adminQuery<{ id: string }>(
      `SELECT id FROM app.attendance_records WHERE student_id = $1`,
      [T.students.one],
    );
    expect(new Set(vs.rows.map((r) => r['attendance_record_id']))).toEqual(
      new Set(mine.map((r) => r.id)),
    );
    expect((await runAs(me, `SELECT id FROM app.class_sessions`)).rows.length).toBeGreaterThan(0);
    const other = { tenant: T.orgId, user: T.users.studentTwo, kind: 'STUDENT' as const };
    const theirs = await runAs(other, `SELECT student_id FROM app.attendance_records`);
    expect(theirs.rows.every((r) => r['student_id'] === T.students.two)).toBe(true);
    const write = await runAs(
      me,
      `UPDATE app.attendance_records SET remarks = 'mine' WHERE id = $1`,
      [studentOneRecord],
    );
    expect(write.rowCount ?? 0).toBe(0);
    // another tenant sees nothing at all
    const foreign = { tenant: OTHER.orgId, user: OTHER.users.admin, kind: 'STAFF' as const };
    expect((await runAs(foreign, `SELECT id FROM app.attendance_records`)).rows).toEqual([]);
    expect((await runAs(foreign, `SELECT id FROM app.class_sessions`)).rows).toEqual([]);
  });
});
