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
import { ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { activateTermFixture } from '../support/term-fixture.js';

// Milestone 4, Slice 3 (doc 41 §9 and §10: correction containment and the student-self read) over HTTP in private tenants: class sessions, first submission of
// attendance (record + revision 1 + session state in one transaction), the X-12 ASSIGNED resolver for attendance.session.mark
// and attendance.record.read, idempotency, tenant isolation, and the database guarantees (append-only revisions, record <->
// revision pairing, roster rule, student-self row security). Synthetic data only. Dates are relative to "today" on the
// campus calendar (Asia/Kolkata), because the resolver and the guards evaluate the session date, not the wall clock.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
// DEFAULT configuration: the production default. The correction route is contained (ATTENDANCE_CORRECTIONS_ENABLED is off).
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});
// The same database with the flag on, to prove the term-status limit that applies even when enabled.
const appOn = buildApp({
  config: loadConfig({
    DATABASE_URL: url,
    APP_ORIGINS: APP_ORIGIN,
    ATTENDANCE_CORRECTIONS_ENABLED: 'true',
  }),
  db,
  logger: false,
});

const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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
  | 'student2'
  | 'foreignStudent'
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
const send = (
  target: typeof app,
  method: 'GET' | 'POST' | 'PATCH',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  target.inject({
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
const call = (
  method: 'GET' | 'POST' | 'PATCH',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) => send(app, method, who, path, payload, headers);
const callOn = (
  method: 'GET' | 'POST' | 'PATCH',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) => send(appOn, method, who, path, payload, headers);
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
  await appOn.ready();
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
  s.student2 = await login(T.emails.studentTwo);
  s.foreignStudent = await login(OTHER.emails.studentOne);
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
  await appOn.close();
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
const count = async (sql: string, p: unknown[] = []): Promise<number> =>
  Number((await adminQuery<{ n: string }>(sql, p))[0]!.n);

const correct = (
  target: 'off' | 'on',
  who: Session | null,
  recordId: string,
  payload: Record<string, unknown>,
  k: string | null = key(),
) =>
  (target === 'on' ? callOn : call)(
    'POST',
    who,
    `/attendance/records/${recordId}/corrections`,
    payload,
    k ? { 'idempotency-key': k } : {},
  );
interface Rec {
  id: string;
  studentId: string;
  status: string;
  revisionNo: number;
}
let used = 0;
/** A submitted session (roster D(-29)..D(-11)); `statusOf` chooses the status per student. */
async function submitted(statusOf: (studentId: string) => string = () => 'PRESENT') {
  const n = used++;
  const sessionId = idOf(
    await createSession(s.main, sessionBody(D(-(n % 4)), 5 + Math.floor(n / 4))),
  );
  const r = await submit(
    s.main,
    sessionId,
    roster.map((m) => ({ studentId: m.student, status: statusOf(m.student) })),
  );
  expect(r.statusCode, r.body).toBe(201);
  const records = dataOf<Rec[]>(
    await call('GET', s.main, `/attendance/sessions/${sessionId}/records`),
  );
  return { sessionId, records };
}
const revisionCount = (id: string) =>
  count(
    `SELECT count(*) AS n FROM app.attendance_record_revisions WHERE attendance_record_id = $1`,
    [id],
  );
type MyRow = Record<string, unknown> & {
  sessionDate: string;
  status: string;
  courseOfferingId: string;
};
const myRecords = (who: Session | null, query = '') =>
  call('GET', who, `/attendance/me/records${query}`);
const ownCount = () =>
  count(
    `SELECT count(*) AS n FROM app.attendance_records WHERE organization_id = $1 AND student_id = $2`,
    [T.orgId, T.students.one],
  );
const ownByStatus = async () => {
  const rows = await adminQuery<{ status: string; n: string }>(
    `SELECT status, count(*) AS n FROM app.attendance_records WHERE organization_id = $1 AND student_id = $2 GROUP BY status`,
    [T.orgId, T.students.one],
  );
  const t = { held: 0, present: 0, late: 0, excused: 0, absent: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    t.held += n;
    t[r.status.toLowerCase() as 'present' | 'late' | 'excused' | 'absent'] = n;
  }
  return t;
};
const OFF_MESSAGE = 'Attendance corrections are not enabled.';

// =============================================================================================================
// Containment of the correction routes (doc 41 §9, §12): the deployment switch stays off by default
// =============================================================================================================
describe('containment: the correction route is closed by default', () => {
  it('the role matrix grants attendance.record.correct exactly as approved (AD-1, AD-3): assigned faculty, HOD, campus and college administrators', () => {
    const holders = Object.entries(ROLE_MATRIX)
      .filter(([, perms]) => 'attendance.record.correct' in perms)
      .map(([role, perms]) => [role, perms['attendance.record.correct']]);
    expect(holders).toEqual([
      ['FACULTY', 'ASSIGNED'],
      ['HOD', 'GRANTED'],
      ['CAMPUS_ADMIN', 'GRANTED'],
      ['COLLEGE_ADMIN', 'GRANTED'],
    ]);
  });

  it('with the deployment switch off, everyone gets 403, before any lookup, and nothing is written', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    const payload = { status: 'ABSENT', expectedRevisionNo: 1, reasonCode: 'FACULTY_ERROR' };
    // everyone is refused with 403. A caller holding the surviving grant reaches the flag check and is told it is off;
    // callers without any grant are stopped earlier by the route's permission check ("Access denied."). Neither writes.
    const messages = new Map<Session, string>();
    for (const who of [s.main, s.stranger, s.admin, s.campusAdmin, s.hod, s.student]) {
      const r = await correct('off', who, rec.id, payload);
      expect(r.statusCode, r.body).toBe(403);
      const e = r.json<{ error: { code: string; message: string } }>().error;
      expect(e.code).toBe(
        e.message === OFF_MESSAGE ? 'ATTENDANCE_CORRECTIONS_DISABLED' : 'FORBIDDEN',
      );
      messages.set(who, e.message);
    }
    for (const who of [s.main, s.stranger, s.admin, s.campusAdmin, s.hod]) {
      expect(messages.get(who)).toBe(OFF_MESSAGE); // holders of the grant reach the switch and are told it is off
    }
    expect(messages.get(s.student)).toBe('Access denied.');
    // no existence oracle: an unknown record id and a real one answer exactly the same for the same caller
    for (const who of [s.main, s.foreignFaculty]) {
      const known = await correct('off', who, rec.id, payload);
      const unknown = await correct('off', who, uuidv7(), payload);
      expect(known.statusCode).toBe(403);
      expect(unknown.statusCode).toBe(403);
      expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
        known.json<{ error: { message: string } }>().error.message,
      );
    }
    expect((await correct('off', null, rec.id, payload)).statusCode).toBe(401);
    // a malformed request is still refused as forbidden first (the gate runs before validation of the body's meaning)
    expect((await correct('off', s.main, rec.id, payload, null)).statusCode).toBe(403);
    // nothing changed: record, revisions, audit, idempotency claims
    expect(await revisionCount(rec.id)).toBe(1);
    expect(
      (
        await adminQuery<{ status: string; revision_no: number }>(
          `SELECT status, revision_no FROM app.attendance_records WHERE id = $1`,
          [rec.id],
        )
      )[0],
    ).toEqual({ status: 'PRESENT', revision_no: 1 });
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE action = 'attendance.record.correct' AND resource_id = $1`,
        [rec.id],
      ),
    ).toBe(0);
  });

  it('the rest of attendance is unaffected: submission, cancellation, staff reads and revision history still work', async () => {
    const { sessionId, records } = await submitted();
    expect((await call('GET', s.hod, `/attendance/sessions/${sessionId}/records`)).statusCode).toBe(
      200,
    );
    const hist = await call('GET', s.main, `/attendance/records/${records[0]!.id}/revisions`);
    expect(hist.statusCode).toBe(200);
    expect(dataOf<unknown[]>(hist)).toHaveLength(1);
    const fresh = idOf(await createSession(s.main, sessionBody(D(-58))));
    expect(
      (
        await call(
          'POST',
          s.main,
          `/attendance/sessions/${fresh}/cancel`,
          { reason: 'Cancelled in the containment test' },
          { 'idempotency-key': key() },
        )
      ).statusCode,
    ).toBe(200);
  });

  it('the flag is strict: only the exact value "true" enables it; absent or anything else is off', () => {
    const base = { DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN };
    expect(loadConfig(base).attendanceCorrectionsEnabled).toBe(false);
    expect(
      loadConfig({ ...base, ATTENDANCE_CORRECTIONS_ENABLED: 'false' }).attendanceCorrectionsEnabled,
    ).toBe(false);
    expect(
      loadConfig({ ...base, ATTENDANCE_CORRECTIONS_ENABLED: 'true' }).attendanceCorrectionsEnabled,
    ).toBe(true);
    for (const bad of ['TRUE', '1', 'yes', '']) {
      expect(() => loadConfig({ ...base, ATTENDANCE_CORRECTIONS_ENABLED: bad })).toThrow();
    }
  });
});

// =============================================================================================================
// Student-self attendance read (doc 03 line 41 SELF; line 236 to 237 my attendance; doc 02 attendance_summaries columns)
// =============================================================================================================
describe('student-self attendance read', () => {
  const mine: Array<{ sessionId: string; date: string; status: string }> = [];
  let otherOffering = '';

  beforeAll(async () => {
    // student one: PRESENT, ABSENT, LATE in the main offering (other students always PRESENT)
    for (const status of ['PRESENT', 'ABSENT', 'LATE']) {
      const { sessionId } = await submitted((id) => (id === T.students.one ? status : 'PRESENT'));
      const date = (
        await adminQuery<{ d: string }>(
          `SELECT session_date::text AS d FROM app.class_sessions WHERE id = $1`,
          [sessionId],
        )
      )[0]!.d;
      mine.push({ sessionId, date, status });
    }
    // a second offering where student one is the only registered student: one EXCUSED record
    otherOffering = U.other;
    const reg = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${U.other}/registrations`,
      {
        termEnrollmentId: roster[0]!.eid,
        validFrom: D(-30),
        source: 'MANUAL',
        reason: 'Registered by the office',
      },
    );
    expect(reg.statusCode, reg.body).toBe(201);
    const sid = idOf(
      await createSession(s.stranger, { ...sessionBody(D(-14)), courseOfferingId: U.other }),
    );
    expect(
      (await submit(s.stranger, sid, [{ studentId: T.students.one, status: 'EXCUSED' }]))
        .statusCode,
    ).toBe(201);
    mine.push({ sessionId: sid, date: D(-14), status: 'EXCUSED' });
  });

  it("returns only the student's own records, newest first, with only student-safe fields", async () => {
    const r = await myRecords(s.student);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json<{ data: MyRow[]; hasMore: boolean }>();
    expect(body.hasMore).toBe(false);
    expect(body.data).toHaveLength(await ownCount());
    const dates = body.data.map((x) => x.sessionDate);
    expect(dates).toEqual([...dates].sort().reverse());
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'classSessionId',
          'courseCode',
          'courseOfferingId',
          'courseTitle',
          'kind',
          'sessionDate',
          'startsAt',
          'status',
        ].sort(),
      );
    }
    const bySession = new Map(body.data.map((x) => [x['classSessionId'] as string, x.status]));
    for (const m of mine) expect(bySession.get(m.sessionId), m.date).toBe(m.status);
    // other students' records exist in the same sessions but never appear
    const everyone = await count(
      `SELECT count(*) AS n FROM app.attendance_records WHERE organization_id = $1`,
      [T.orgId],
    );
    expect(everyone).toBeGreaterThan(body.data.length);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.attendance_records WHERE organization_id = $1 AND student_id = $2`,
        [T.orgId, T.students.one],
      ),
    ).toBe(body.data.length);
  });

  it('filters by offering and dates, and limit with hasMore', async () => {
    const inOther = (await myRecords(s.student, `?courseOfferingId=${otherOffering}`)).json<{
      data: MyRow[];
    }>().data;
    expect(inOther).toHaveLength(1);
    expect(inOther[0]).toMatchObject({ status: 'EXCUSED', sessionDate: D(-14) });
    const ranged = (await myRecords(s.student, `?from=${D(-14)}&to=${D(-14)}`)).json<{
      data: MyRow[];
    }>().data;
    expect(ranged.every((x) => x.sessionDate === D(-14))).toBe(true);
    const page = (await myRecords(s.student, '?limit=2')).json<{
      data: MyRow[];
      hasMore: boolean;
    }>();
    expect(page.data).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect((await myRecords(s.student, `?from=${D(-1)}&to=${D(-30)}`)).statusCode).toBe(400);
  });

  it('summary: per-offering and total counts of the current values, and no percentage or eligibility anywhere', async () => {
    const r = await call('GET', s.student, '/attendance/me/summary');
    expect(r.statusCode, r.body).toBe(200);
    const data = r.json<{
      data: { offerings: Array<Record<string, unknown>>; totals: Record<string, number> };
    }>().data;
    expect(data.totals).toEqual(await ownByStatus()); // the API equals the database truth for this student
    expect(data.totals.excused).toBe(1);
    expect(data.totals.late).toBe(1);
    const main = data.offerings.find((o) => o['courseOfferingId'] === U.offering)!;
    expect(main['held']).toBe(
      Number(main['present']) + Number(main['late']) + Number(main['absent']),
    );
    expect(main['late']).toBe(1);
    expect(main['absent']).toBe(1);
    const other = data.offerings.find((o) => o['courseOfferingId'] === otherOffering)!;
    expect(other).toMatchObject({ held: 1, present: 0, late: 0, excused: 1, absent: 0 });
    const text = JSON.stringify(r.json());
    expect(text).not.toMatch(/percent|eligib|warning|shortfall/i);
    const one = (
      await call('GET', s.student, `/attendance/me/summary?courseOfferingId=${U.offering}`)
    ).json<{ data: { offerings: unknown[]; totals: { held: number } } }>().data;
    expect(one.offerings).toHaveLength(1);
    expect(one.totals.held).toBe(Number(main['held']));
  });

  it('another student, and a student of another tenant, see only their own (nothing, here); no parameter selects someone else', async () => {
    for (const who of [s.student2, s.foreignStudent]) {
      const r = await myRecords(who);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json<{ data: unknown[] }>().data).toEqual([]);
      const sm = (await call('GET', who, '/attendance/me/summary')).json<{
        data: { offerings: unknown[]; totals: { held: number } };
      }>().data;
      expect(sm).toEqual({
        offerings: [],
        totals: { held: 0, present: 0, late: 0, excused: 0, absent: 0 },
      });
    }
    // an attempt to name another student is a validation error, not a silent filter
    for (const q of [
      `?studentId=${roster[1]!.student}`,
      `?student_id=${roster[1]!.student}`,
      '?userId=x',
      '?offset=1',
    ]) {
      expect((await myRecords(s.student, q)).statusCode, q).toBe(400);
    }
    expect(
      (await myRecords(s.student, `?courseOfferingId=${uuidv7()}`)).json<{ data: unknown[] }>()
        .data,
    ).toEqual([]);
    // a foreign offering id from another tenant yields nothing, never a lookup error that reveals it
    expect(
      (await myRecords(s.foreignStudent, `?courseOfferingId=${U.offering}`)).json<{
        data: unknown[];
      }>().data,
    ).toEqual([]);
  });

  it('staff are not students: every staff role gets 403 on the student routes, and an anonymous caller 401', async () => {
    for (const who of [s.main, s.stranger, s.hod, s.campusAdmin, s.admin]) {
      expect((await myRecords(who)).statusCode).toBe(403);
      expect((await call('GET', who, '/attendance/me/summary')).statusCode).toBe(403);
    }
    expect((await myRecords(null)).statusCode).toBe(401);
    expect((await call('GET', null, '/attendance/me/summary')).statusCode).toBe(401);
  });

  it('students cannot reach the staff views: records, revision history and sessions are 403', async () => {
    const { sessionId, records } = await submitted();
    expect(
      (await call('GET', s.student, `/attendance/sessions/${sessionId}/records`)).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', s.student, `/attendance/records/${records[0]!.id}/revisions`)).statusCode,
    ).toBe(403);
    expect((await call('GET', s.student, `/attendance/sessions/${sessionId}`)).statusCode).toBe(
      403,
    );
  });

  it('a correction (made on a disposable enabled instance) is visible to the student as the CURRENT value only, without history', async () => {
    const before = (await myRecords(s.student)).json<{ data: MyRow[] }>().data;
    const target = before.find((x) => x.status === 'PRESENT' && x.courseOfferingId === U.offering)!;
    const rec = (
      await adminQuery<{ id: string; revision_no: number }>(
        `SELECT id, revision_no FROM app.attendance_records WHERE class_session_id = $1 AND student_id = $2`,
        [target['classSessionId'], T.students.one],
      )
    )[0]!;
    const r = await correct('on', s.main, rec.id, {
      status: 'ABSENT',
      expectedRevisionNo: rec.revision_no,
      reasonCode: 'FACULTY_ERROR',
    });
    expect(r.statusCode, r.body).toBe(200);
    const after = (await myRecords(s.student)).json<{ data: MyRow[] }>().data;
    expect(after.find((x) => x['classSessionId'] === target['classSessionId'])!.status).toBe(
      'ABSENT',
    );
    expect(JSON.stringify(after)).not.toMatch(/revision|reason|CORRECTION|markedBy/i);
    const sm = (await call('GET', s.student, '/attendance/me/summary')).json<{
      data: { totals: Record<string, number> };
    }>().data.totals;
    expect(sm).toEqual(await ownByStatus());
    expect(sm['absent']).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================================================
// Limits that apply even when corrections are enabled (explicit canonical text, not an owner policy)
// =============================================================================================================
describe('enabled instance: term status limit (doc 02 line 168: CLOSED = admin corrections only)', () => {
  it('a CLOSED term refuses a teacher correction with 409 and writes nothing; this runs last because it closes the term', async () => {
    const { records } = await submitted();
    const rec = records[1]!;
    await adminQuery(`UPDATE app.terms SET status = 'CLOSED' WHERE id = $1`, [U.term]);
    const r = await correct('on', s.main, rec.id, {
      status: 'ABSENT',
      expectedRevisionNo: 1,
      reasonCode: 'FACULTY_ERROR',
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json<{ error: { message: string } }>().error.message).toMatch(/term is CLOSED/);
    expect(await revisionCount(rec.id)).toBe(1);
    expect(
      (
        await adminQuery<{ status: string }>(
          `SELECT status FROM app.attendance_records WHERE id = $1`,
          [rec.id],
        )
      )[0]!.status,
    ).toBe('PRESENT');
    // reads still work in a closed term
    expect((await myRecords(s.student)).statusCode).toBe(200);
  });
});
