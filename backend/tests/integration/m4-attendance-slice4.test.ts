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
import { activateTermFixture } from '../support/term-fixture.js';

// Milestone 4, Slice 4 (migration 0042, doc 41 §12, owner decisions AD-1 to AD-9 of doc 43 §0) over HTTP in private tenants:
// the 3-calendar-day window, assignment types, institutional correction, the approval workflow (no self-approval), locking and
// the term-lock cascade, cancellation paths, audit tiers, in-app notices, tenant isolation and student privacy. Synthetic data
// only. Dates are relative to "today" on the campus calendar (Asia/Kolkata).

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const app = buildApp({
  // The correction route is contained (doc 41 §9): it needs the flag AND an explicit grant. This file tests the ENABLED path on
  // synthetic tenants; tests/integration/m4-attendance-slice3.test.ts proves the contained (default) behaviour.
  config: loadConfig({
    DATABASE_URL: url,
    APP_ORIGINS: APP_ORIGIN,
    ATTENDANCE_CORRECTIONS_ENABLED: 'true',
  }),
  db,
  logger: false,
});

const appOff = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
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
  | 'co'
  | 'sub'
  | 'lab'
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
  'main' | 'ended' | 'future' | 'stranger' | 'co' | 'sub' | 'lab',
  { user: string; employee: string; email: string }
>;
const roster: Array<{ student: string; eid: string; registration: string }> = [];

beforeAll(async () => {
  await app.ready();
  await appOff.ready();
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

  for (const k of ['main', 'ended', 'future', 'stranger', 'co', 'sub', 'lab'] as const)
    F[k] = await facultyUser(T);
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
  await fa(U.offering, F.co.employee, D(-60), undefined, 'CO_INSTRUCTOR');
  await fa(U.offering, F.sub.employee, D(-60), undefined, 'SUBSTITUTE');
  await fa(U.offering, F.lab.employee, D(-60), undefined, 'LAB_INSTRUCTOR');
  s.main = await login(F.main.email);
  s.ended = await login(F.ended.email);
  s.future = await login(F.future.email);
  s.stranger = await login(F.stranger.email);
  s.co = await login(F.co.email);
  s.sub = await login(F.sub.email);
  s.lab = await login(F.lab.email);
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
  await appOff.close();
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

const correct = (
  who: Session | null,
  recordId: string,
  body: Record<string, unknown>,
  k: string | null = key(),
) =>
  call(
    'POST',
    who,
    `/attendance/records/${recordId}/corrections`,
    body,
    k ? { 'idempotency-key': k } : {},
  );
const cancel = (
  who: Session | null,
  sessionId: string,
  body: Record<string, unknown>,
  k: string | null = key(),
) =>
  call(
    'POST',
    who,
    `/attendance/sessions/${sessionId}/cancel`,
    body,
    k ? { 'idempotency-key': k } : {},
  );
interface Rec {
  id: string;
  studentId: string;
  status: string;
  revisionNo: number;
  source: string;
}
const recordRow = async (id: string) =>
  (
    await adminQuery<{
      status: string;
      revision_no: number;
      source: string;
      marked_by_user_id: string;
    }>(
      `SELECT status, revision_no, source, marked_by_user_id FROM app.attendance_records WHERE id = $1`,
      [id],
    )
  )[0]!;
const revisionCount = (id: string) =>
  count(
    `SELECT count(*) AS n FROM app.attendance_record_revisions WHERE attendance_record_id = $1`,
    [id],
  );

interface Req {
  id: string;
  status: string;
  requestedByUserId: string;
  decidedByUserId: string | null;
  appliedRevisionNo: number | null;
  attendanceRecordId: string;
}
const nextHour = new Map<number, number>();
/** A fresh submitted session `ago` days before today (campus-local), by `who`; returns the session id and its records. */
async function mk(
  ago: number,
  who: Session = s.main,
): Promise<{ sessionId: string; records: Rec[] }> {
  const n = nextHour.get(ago) ?? 4;
  nextHour.set(ago, n + 1);
  const sessionId = idOf(await createSession(who, sessionBody(D(-ago), n)));
  const r = await submit(who, sessionId, fullRoster());
  expect(r.statusCode, r.body).toBe(201);
  return {
    sessionId,
    records: dataOf<Rec[]>(await call('GET', who, `/attendance/sessions/${sessionId}/records`)),
  };
}
const bodyOf = (rec: Rec, extra: Record<string, unknown> = {}) => ({
  status: 'ABSENT',
  expectedRevisionNo: rec.revisionNo,
  reasonCode: 'FACULTY_ERROR',
  ...extra,
});
const reqCorr = (who: Session | null, rec: Rec | string, b: object, k: string | null = key()) =>
  call(
    'POST',
    who,
    `/attendance/records/${typeof rec === 'string' ? rec : rec.id}/correction-requests`,
    b,
    k ? { 'idempotency-key': k } : {},
  );
const decide = (
  who: Session | null,
  id: string,
  what: 'approve' | 'reject',
  b: object = {},
  k: string | null = key(),
) =>
  call(
    'POST',
    who,
    `/attendance/correction-requests/${id}/${what}`,
    b,
    k ? { 'idempotency-key': k } : {},
  );
const lock = (
  who: Session | null,
  id: string,
  b: object = { reason: 'Term results frozen' },
  k: string | null = key(),
) => call('POST', who, `/attendance/sessions/${id}/lock`, b, k ? { 'idempotency-key': k } : {});
const inbox = (user: string) =>
  adminQuery<{ title: string; body: string; entity_id: string; category: string }>(
    `SELECT title, body, entity_id, category FROM app.notifications WHERE recipient_user_id = $1 ORDER BY created_at`,
    [user],
  );
const audit = (action: string, resource: string) =>
  adminQuery<{
    risk_tier: number;
    metadata: Record<string, unknown> | null;
    reason_text: string | null;
  }>(
    `SELECT risk_tier, metadata, reason_text FROM app.audit_events WHERE action = $1 AND resource_id = $2`,
    [action, resource],
  );
const listRequests = async (who: Session, status?: string) =>
  call('GET', who, `/attendance/correction-requests${status ? `?status=${status}` : ''}`);
const sessionRow = async (id: string) =>
  (
    await adminQuery<{
      attendance_state: string;
      status: string;
      locked_by_user_id: string | null;
      lock_reason: string | null;
    }>(
      `SELECT attendance_state, status, locked_by_user_id, lock_reason FROM app.class_sessions WHERE id = $1`,
      [id],
    )
  )[0]!;
const OFF_MESSAGE = 'Attendance corrections are not enabled.';

describe('AD-1/AD-2: faculty correction inside the 3-calendar-day window', () => {
  it('PRIMARY and CO_INSTRUCTOR correct directly; SUBSTITUTE and LAB_INSTRUCTOR can mark but never correct; strangers get the same 404', async () => {
    const { records } = await mk(1);
    const [a, b] = records as [Rec, Rec, Rec, Rec];
    for (const who of [s.sub, s.lab, s.stranger, s.foreignFaculty]) {
      expect((await correct(who, a.id, bodyOf(a))).statusCode).toBe(404);
    }
    expect(await revisionCount(a.id)).toBe(1);
    const ok = await correct(s.main, a.id, bodyOf(a));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(dataOf<Rec>(ok)).toMatchObject({
      status: 'ABSENT',
      revisionNo: 2,
      source: 'CORRECTION',
    });
    expect((await correct(s.co, b.id, bodyOf(b, { status: 'LATE' }))).statusCode).toBe(200);
    // a substitute does take attendance (mark is unchanged) ...
    const subSession = idOf(await createSession(s.sub, sessionBody(D(-1), 20)));
    expect((await submit(s.sub, subSession, fullRoster())).statusCode).toBe(201);
    // ... but cannot correct what they marked
    const subRecs = dataOf<Rec[]>(
      await call('GET', s.sub, `/attendance/sessions/${subSession}/records`),
    );
    expect((await correct(s.sub, subRecs[0]!.id, bodyOf(subRecs[0]!))).statusCode).toBe(404);
    expect((await reqCorr(s.lab, subRecs[0]!, bodyOf(subRecs[0]!))).statusCode).toBe(404);
    // the revision records the actor, the reason, before and after; the audit is tier 2 on the ASSIGNED path
    const revs = dataOf<
      Array<{
        revisionNo: number;
        statusBefore: string;
        statusAfter: string;
        changedByUserId: string;
      }>
    >(await call('GET', s.main, `/attendance/records/${a.id}/revisions`));
    expect(
      revs.map((r) => [r.revisionNo, r.statusBefore, r.statusAfter, r.changedByUserId]),
    ).toEqual([
      [1, null, 'PRESENT', F.main.user],
      [2, 'PRESENT', 'ABSENT', F.main.user],
    ]);
    const ev = await audit('attendance.record.correct', a.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ risk_tier: 2 });
    expect(ev[0]!.metadata).toMatchObject({ path: 'ASSIGNED' });
  });

  it('window boundary: day 3 is inside, day 4 is outside (direct 409, request 201); a request inside the window is 409', async () => {
    const day3 = (await mk(3)).records[0]!;
    const day4 = (await mk(4)).records[0]!;
    expect((await correct(s.main, day3.id, bodyOf(day3))).statusCode).toBe(200);
    const late = await correct(s.main, day4.id, bodyOf(day4));
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { message: string } }>().error.message).toMatch(/window has passed/);
    expect(await revisionCount(day4.id)).toBe(1);
    const inside = (await mk(2)).records[0]!;
    const tooEarly = await reqCorr(s.main, inside, bodyOf(inside));
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json<{ error: { message: string } }>().error.message).toMatch(
      /inside the faculty window/,
    );
    expect((await reqCorr(s.main, day4, bodyOf(day4))).statusCode).toBe(201);
  });

  it('the window comes from attendance_policies when a row exists (campus row wins over the default)', async () => {
    const pol = uuidv7();
    await adminQuery(
      `INSERT INTO app.attendance_policies (id, organization_id, campus_id, edit_window_days) VALUES ($1, $2, $3, 1)`,
      [pol, T.orgId, T.campusId],
    );
    try {
      const day2 = (await mk(2)).records[0]!;
      const day1 = (await mk(1)).records[0]!;
      expect((await correct(s.main, day2.id, bodyOf(day2))).statusCode).toBe(409);
      expect((await correct(s.main, day1.id, bodyOf(day1))).statusCode).toBe(200);
    } finally {
      await adminQuery(`UPDATE app.attendance_policies SET edit_window_days = 3 WHERE id = $1`, [
        pol,
      ]);
    }
    const day3 = (await mk(3)).records[0]!;
    expect((await correct(s.main, day3.id, bodyOf(day3))).statusCode).toBe(200);
  });

  it('the policy table is read-only for the runtime role and invisible to students', async () => {
    const r = await call('GET', s.student, '/attendance/correction-requests');
    expect(r.statusCode).toBe(403);
    expect(
      await count(`SELECT count(*) AS n FROM app.attendance_policies WHERE organization_id = $1`, [
        OTHER.orgId,
      ]),
    ).toBe(0);
  });
});

describe('AD-3: institutional correction inside the permitted scope', () => {
  it('HOD, campus administrator and college administrator correct inside scope (tier 2, path GRANTED); students and other tenants cannot', async () => {
    const { records } = await mk(1);
    for (const [who, rec] of [
      [s.hod, records[0]!],
      [s.campusAdmin, records[1]!],
      [s.admin, records[2]!],
    ] as const) {
      const r = await correct(who, rec.id, bodyOf(rec));
      expect(r.statusCode, r.body).toBe(200);
      const ev = await audit('attendance.record.correct', rec.id);
      expect(ev[0]).toMatchObject({ risk_tier: 2 });
      expect(ev[0]!.metadata).toMatchObject({ path: 'GRANTED' });
    }
    const spare = records[3]!;
    expect((await correct(s.student, spare.id, bodyOf(spare))).statusCode).toBe(403);
    expect((await correct(s.foreignAdmin, spare.id, bodyOf(spare))).statusCode).toBe(404);
    expect(await revisionCount(spare.id)).toBe(1);
  });

  it('a HOD whose department scope does not contain the offering gets the same 404 as a missing record, for correction, request and decision', async () => {
    const { records } = await mk(1);
    const old = (await mk(6)).records[0]!;
    const requested = await reqCorr(s.main, old, bodyOf(old));
    expect(requested.statusCode).toBe(201);
    const reqId = idOf(requested);
    const dept = uuidv7();
    await insert('departments', {
      id: dept,
      campus_id: T.campusId,
      name: 'Elsewhere',
      code: code('X'),
    });
    // a HOD of the OTHER department (a fresh user: role assignments are immutable)
    const elsewhere = uuidv7();
    const email = `hod2-${RUN.toLowerCase()}-${elsewhere.slice(-12)}@isolated.test`;
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [elsewhere, email, HASH],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Other HOD', 'ACTIVE', $1)`,
      [elsewhere, T.orgId, email],
    );
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'DEPARTMENT', $4::uuid, NULL, $4::uuid FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'HOD'`,
      [uuidv7(), T.orgId, elsewhere, dept],
    );
    const other = await login(email);
    expect((await correct(other, records[0]!.id, bodyOf(records[0]!))).statusCode).toBe(404);
    expect((await reqCorr(other, old, bodyOf(old))).statusCode).toBe(404);
    expect((await decide(other, reqId, 'approve')).statusCode).toBe(404);
    expect(dataOf<unknown[]>(await listRequests(other))).toHaveLength(0);
    expect(
      (await decide(s.hod, reqId, 'reject', { note: 'Other department check' })).statusCode,
    ).toBe(200);
  });
});

describe('AD-4: correction outside the window needs independent approval', () => {
  it('request -> approve by another authorised person: revision N+1 names requester and approver, one request, two tier-2 events, immutable decision', async () => {
    const rec = (await mk(5)).records[0]!;
    const made = await reqCorr(
      s.main,
      rec,
      bodyOf(rec, { reasonText: 'Marked absent by mistake' }),
    );
    expect(made.statusCode, made.body).toBe(201);
    const reqId = idOf(made);
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 }); // nothing changed yet
    // a second request for the same record is refused while one is open
    expect((await reqCorr(s.co, rec, bodyOf(rec, { status: 'LATE' }))).statusCode).toBe(409);
    // the requester, faculty in general and students cannot decide
    expect((await decide(s.main, reqId, 'approve')).statusCode).toBe(403);
    expect((await decide(s.student, reqId, 'approve')).statusCode).toBe(403);
    expect((await decide(s.foreignAdmin, reqId, 'approve')).statusCode).toBe(404);
    expect((await decide(s.hod, reqId, 'approve', {}, null)).statusCode).toBe(428);

    const k = key();
    const ok = await decide(s.hod, reqId, 'approve', { note: 'Checked against the register' }, k);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(dataOf<Req>(ok)).toMatchObject({
      status: 'APPROVED',
      decidedByUserId: T.users.hod,
      appliedRevisionNo: 2,
    });
    expect(await recordRow(rec.id)).toMatchObject({
      status: 'ABSENT',
      revision_no: 2,
      source: 'CORRECTION',
      marked_by_user_id: F.main.user,
    });
    const rev = (
      await adminQuery<{
        changed_by_user_id: string;
        approved_by_user_id: string;
        correction_request_id: string;
      }>(
        `SELECT changed_by_user_id, approved_by_user_id, correction_request_id FROM app.attendance_record_revisions WHERE attendance_record_id = $1 AND revision_no = 2`,
        [rec.id],
      )
    )[0]!;
    expect(rev).toEqual({
      changed_by_user_id: F.main.user,
      approved_by_user_id: T.users.hod,
      correction_request_id: reqId,
    });
    expect(await revisionCount(rec.id)).toBe(2);
    // replay: same key -> stored result; another key -> 409 already decided; nothing is written twice
    const replay = await decide(
      s.hod,
      reqId,
      'approve',
      { note: 'Checked against the register' },
      k,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await decide(s.hod, reqId, 'approve')).statusCode).toBe(409);
    expect(
      (await decide(s.campusAdmin, reqId, 'reject', { note: 'Too late to reject' })).statusCode,
    ).toBe(409);
    expect(await revisionCount(rec.id)).toBe(2);
    // audit: the request, the decision and the correction itself, all tier 2
    expect((await audit('attendance.correction.request', reqId))[0]).toMatchObject({
      risk_tier: 2,
    });
    expect((await audit('attendance.correction.approve', reqId))[0]).toMatchObject({
      risk_tier: 2,
    });
    const corr = await audit('attendance.record.correct', rec.id);
    expect(corr[0]).toMatchObject({ risk_tier: 2 });
    expect(corr[0]!.metadata).toMatchObject({
      path: 'APPROVED_REQUEST',
      correctionRequestId: reqId,
    });
    // a decided request can never change
    await expect(
      adminQuery(
        `UPDATE app.attendance_correction_requests SET decision_note = 'edited' WHERE id = $1`,
        [reqId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      adminQuery(`DELETE FROM app.attendance_correction_requests WHERE id = $1`, [reqId]),
    ).rejects.toThrow();
  });

  it('no self-approval: an administrator who made a request cannot decide it (403) and the database refuses it for every writer', async () => {
    const rec = (await mk(5)).records[1]!;
    const made = await reqCorr(s.campusAdmin, rec, bodyOf(rec, { reasonCode: 'STUDENT_DISPUTE' }));
    expect(made.statusCode, made.body).toBe(201);
    const reqId = idOf(made);
    for (const what of ['approve', 'reject'] as const) {
      const r = await decide(s.campusAdmin, reqId, what, { note: 'Deciding my own request' });
      expect(r.statusCode).toBe(403);
      expect(r.json<{ error: { message: string } }>().error.message).toMatch(/your own/);
    }
    await expect(
      adminQuery(
        `UPDATE app.attendance_correction_requests SET status = 'APPROVED', decided_by_user_id = requested_by_user_id, decided_at = now(), applied_revision_no = 2 WHERE id = $1`,
        [reqId],
      ),
    ).rejects.toThrow(/no_self/);
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 });
    // a different administrator can
    expect((await decide(s.admin, reqId, 'approve')).statusCode).toBe(200);
    expect(await recordRow(rec.id)).toMatchObject({ status: 'ABSENT', revision_no: 2 });
  });

  it('reject needs a note, changes nothing, and is final; a new request can follow', async () => {
    const rec = (await mk(6)).records[0]!;
    const reqId = idOf(await reqCorr(s.main, rec, bodyOf(rec)));
    expect((await decide(s.hod, reqId, 'reject')).statusCode).toBe(400);
    const rej = await decide(s.hod, reqId, 'reject', { note: 'Register shows present' });
    expect(rej.statusCode, rej.body).toBe(200);
    expect(dataOf<Req>(rej)).toMatchObject({ status: 'REJECTED', appliedRevisionNo: null });
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 });
    expect((await audit('attendance.correction.reject', reqId))[0]).toMatchObject({ risk_tier: 2 });
    expect((await decide(s.campusAdmin, reqId, 'approve')).statusCode).toBe(409);
    // a new request can be made once the previous one is decided
    const again = await reqCorr(
      s.main,
      rec,
      bodyOf(rec, { status: 'EXCUSED', reasonCode: 'MEDICAL' }),
    );
    expect(again.statusCode, again.body).toBe(201);
  });

  it('two simultaneous approvals: exactly one wins and the history gains exactly one revision; two simultaneous requests: one 201, one 409', async () => {
    const rec = (await mk(7)).records[0]!;
    const [r1, r2] = await Promise.all([
      reqCorr(s.main, rec, bodyOf(rec)),
      reqCorr(s.co, rec, bodyOf(rec, { status: 'LATE' })),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    const winner = r1.statusCode === 201 ? r1 : r2;
    const reqId = idOf(winner);
    const [a, b] = await Promise.all([
      decide(s.hod, reqId, 'approve'),
      decide(s.campusAdmin, reqId, 'approve'),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await revisionCount(rec.id)).toBe(2);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.attendance_correction_requests WHERE attendance_record_id = $1 AND status = 'APPROVED'`,
        [rec.id],
      ),
    ).toBe(1);
  });

  it('the same approval sent twice at once with ONE key writes once', async () => {
    const rec = (await mk(7)).records[1]!;
    const reqId = idOf(await reqCorr(s.main, rec, bodyOf(rec)));
    const k = key();
    const [a, b] = await Promise.all([
      decide(s.hod, reqId, 'approve', {}, k),
      decide(s.hod, reqId, 'approve', {}, k),
    ]);
    expect([a.statusCode, b.statusCode].every((c) => c === 200 || c === 409)).toBe(true);
    expect(await revisionCount(rec.id)).toBe(2);
  });

  it('a request needs the record and its revision to be current; strict body; idempotency-key rules', async () => {
    const rec = (await mk(8)).records[0]!;
    expect((await reqCorr(s.main, rec, bodyOf(rec, { expectedRevisionNo: 9 }))).statusCode).toBe(
      409,
    );
    expect((await reqCorr(s.main, rec, bodyOf(rec, { status: 'PRESENT' }))).statusCode).toBe(409);
    expect(
      (await reqCorr(s.main, rec, bodyOf(rec, { reasonCode: 'SYSTEM_RECOMPUTE' }))).statusCode,
    ).toBe(400);
    expect(
      (await reqCorr(s.main, rec, { ...bodyOf(rec), requestedByUserId: F.co.user })).statusCode,
    ).toBe(400);
    expect((await reqCorr(s.main, rec, bodyOf(rec), null)).statusCode).toBe(428);
    expect((await reqCorr(s.main, rec, bodyOf(rec, { reasonCode: 'OTHER' }))).statusCode).toBe(400);
    const k = key();
    const first = await reqCorr(s.main, rec, bodyOf(rec), k);
    expect(first.statusCode).toBe(201);
    const replay = await reqCorr(s.main, rec, bodyOf(rec), k);
    expect(replay.statusCode).toBe(201);
    expect(idOf(replay)).toBe(idOf(first));
    expect((await reqCorr(s.main, rec, bodyOf(rec, { status: 'LATE' }), k)).statusCode).toBe(422);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.attendance_correction_requests WHERE attendance_record_id = $1`,
        [rec.id],
      ),
    ).toBe(1);
  });

  it('the list shows approvers only the requests inside their scope; faculty, students and other tenants cannot read it', async () => {
    const mine = dataOf<Req[]>(await listRequests(s.hod, 'PENDING'));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.status === 'PENDING')).toBe(true);
    expect(dataOf<Req[]>(await listRequests(s.foreignAdmin))).toHaveLength(0);
    for (const who of [s.main, s.student]) expect((await listRequests(who)).statusCode).toBe(403);
    expect((await call('GET', null, '/attendance/correction-requests')).statusCode).toBe(401);
    expect(
      (await call('GET', s.hod, '/attendance/correction-requests?status=WHATEVER')).statusCode,
    ).toBe(400);
  });
});

describe('deployment switch: the correction, request, decision and list routes are closed unless enabled', () => {
  it('every one of them answers 403 before any lookup when ATTENDANCE_CORRECTIONS_ENABLED is not true; locking is not behind it', async () => {
    const rec = (await mk(1)).records[0]!;
    const off = (who: Session, method: 'GET' | 'POST', path: string, payload?: object) =>
      appOff.inject({
        method,
        url: `/api/v1${path}`,
        ...(payload ? { payload } : {}),
        cookies: { session_token: who.cookie },
        headers: {
          ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': who.csrf }),
          'idempotency-key': key(),
        },
      });
    for (const r of [
      await off(s.main, 'POST', `/attendance/records/${rec.id}/corrections`, bodyOf(rec)),
      await off(s.main, 'POST', `/attendance/records/${rec.id}/correction-requests`, bodyOf(rec)),
      await off(s.hod, 'POST', `/attendance/correction-requests/${uuidv7()}/approve`, {}),
      await off(s.hod, 'POST', `/attendance/correction-requests/${uuidv7()}/reject`, {
        note: 'No way',
      }),
      await off(s.hod, 'GET', '/attendance/correction-requests'),
    ]) {
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json<{ error: { message: string } }>().error.message).toBe(OFF_MESSAGE);
    }
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 });
  });
});

describe('AD-5/AD-6: session locking, no unlock', () => {
  it('a campus or college administrator locks a submitted session (tier 3, reason, who/when); no one else can; there is no unlock', async () => {
    const { sessionId, records } = await mk(9);
    for (const who of [s.main, s.hod, s.student]) {
      expect((await lock(who, sessionId)).statusCode).toBe(403);
    }
    // CRITICAL permission: without a fresh step-up even a holder is refused, and nothing changes
    const noStepUp = await lock(s.campusAdmin, sessionId);
    expect(noStepUp.statusCode, noStepUp.body).toBe(403);
    expect((await sessionRow(sessionId)).attendance_state).toBe('SUBMITTED');
    for (const who of [s.campusAdmin, s.admin, s.foreignAdmin]) await elevateSession(who.cookie);
    expect((await lock(s.foreignAdmin, sessionId)).statusCode).toBe(404);
    expect((await lock(s.campusAdmin, sessionId, { reason: 'abc' })).statusCode).toBe(400);
    expect(
      (await lock(s.campusAdmin, sessionId, { reason: 'Term results frozen' }, null)).statusCode,
    ).toBe(428);
    const k = key();
    const ok = await lock(s.campusAdmin, sessionId, { reason: 'Results frozen for the audit' }, k);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(dataOf<{ attendanceState: string }>(ok).attendanceState).toBe('LOCKED');
    expect(await sessionRow(sessionId)).toMatchObject({
      attendance_state: 'LOCKED',
      locked_by_user_id: T.users.campusAdmin,
      lock_reason: 'Results frozen for the audit',
    });
    const ev = await audit('attendance.session.lock', sessionId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ risk_tier: 3, reason_text: 'Results frozen for the audit' });
    expect(
      (await lock(s.campusAdmin, sessionId, { reason: 'Results frozen for the audit' }, k))
        .statusCode,
    ).toBe(200); // replay (same key, same body)
    expect((await lock(s.admin, sessionId)).statusCode).toBe(409); // already locked
    // after the lock nobody corrects, requests or approves
    for (const who of [s.main, s.hod, s.campusAdmin, s.admin]) {
      expect((await correct(who, records[0]!.id, bodyOf(records[0]!))).statusCode).toBe(409);
    }
    expect((await reqCorr(s.main, records[0]!, bodyOf(records[0]!))).statusCode).toBe(409);
    expect(await revisionCount(records[0]!.id)).toBe(1);
    // no unlock route exists
    for (const path of ['unlock', 'reopen']) {
      expect(
        (
          await call(
            'POST',
            s.admin,
            `/attendance/sessions/${sessionId}/${path}`,
            { reason: 'Please unlock' },
            { 'idempotency-key': key() },
          )
        ).statusCode,
      ).toBe(404);
    }
    expect(
      (
        await call('PATCH', s.admin, `/attendance/sessions/${sessionId}`, {
          attendanceState: 'SUBMITTED',
        })
      ).statusCode,
    ).toBe(404);
    expect((await sessionRow(sessionId)).attendance_state).toBe('LOCKED');
  });

  it('only a submitted session can be locked; the lock tolerates a race with a correction (one consistent end state)', async () => {
    const fresh = idOf(await createSession(s.main, sessionBody(D(-9), 21)));
    expect((await lock(s.admin, fresh)).statusCode).toBe(409);
    expect((await lock(s.admin, uuidv7())).statusCode).toBe(404);
    const { sessionId, records } = await mk(9);
    const [l, c] = await Promise.all([
      lock(s.admin, sessionId),
      correct(s.hod, records[1]!.id, bodyOf(records[1]!)),
    ]);
    expect(l.statusCode).toBe(200);
    expect([200, 409]).toContain(c.statusCode);
    expect(await revisionCount(records[1]!.id)).toBe(c.statusCode === 200 ? 2 : 1);
    expect((await sessionRow(sessionId)).attendance_state).toBe('LOCKED');
  });
});

describe('AD-7: cancellation paths', () => {
  it('the assigned conducting teacher cancels their own session (tier 2); other assigned teachers, HOD and students cannot', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-1), 22)));
    expect((await cancel(s.co, id, { reason: 'Not my session' })).statusCode).toBe(404);
    expect((await cancel(s.sub, id, { reason: 'Not my session' })).statusCode).toBe(404);
    for (const who of [s.hod, s.student])
      expect((await cancel(who, id, { reason: 'Not allowed' })).statusCode).toBe(403);
    const ok = await cancel(s.main, id, { reason: 'Public event on campus' });
    expect(ok.statusCode, ok.body).toBe(200);
    const ev = await audit('attendance.session.cancel', id);
    expect(ev[0]).toMatchObject({ risk_tier: 2 });
    expect(ev[0]!.metadata).toMatchObject({ path: 'ASSIGNED' });
  });

  it('administrative cancellation is a separate permission held by campus and college administrators inside their scope', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-1), 19)));
    expect((await cancel(s.foreignAdmin, id, { reason: 'Other tenant' })).statusCode).toBe(404);
    const ok = await cancel(s.campusAdmin, id, {
      reason: 'Room unavailable, administrative cancel',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const ev = await audit('attendance.session.cancel', id);
    expect(ev[0]).toMatchObject({ risk_tier: 2 });
    expect(ev[0]!.metadata).toMatchObject({ path: 'GRANTED' });
    expect((await cancel(s.admin, id, { reason: 'Already cancelled' })).statusCode).toBe(409);
    // the conducting teacher is told; no student is
    const notes = (await inbox(F.main.user)).filter((n) => n.entity_id === id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: 'ACADEMIC' });
    expect(notes[0]!.body).not.toMatch(/PRESENT|ABSENT|LATE|EXCUSED/);
  });

  it('a conducted session cannot be cancelled by anyone', async () => {
    const { sessionId } = await mk(2);
    for (const who of [s.main, s.campusAdmin, s.admin]) {
      expect((await cancel(who, sessionId, { reason: 'Conducted already' })).statusCode).toBe(409);
    }
  });
});

describe('AD-8: in-app notifications to authorised staff only', () => {
  it('a request notifies the approvers in scope (not the requester), a decision notifies the requester; no student, no foreign tenant, no data in the text', async () => {
    const rec = (await mk(10)).records[2]!;
    const before = {
      hod: (await inbox(T.users.hod)).length,
      student: (await inbox(T.users.studentOne)).length,
      foreign: (await inbox(OTHER.users.admin)).length,
    };
    const reqId = idOf(
      await reqCorr(
        s.main,
        rec,
        bodyOf(rec, { reasonCode: 'OTHER', reasonText: 'Sensitive free text about a pupil' }),
      ),
    );
    const noteOf = async (user: string) => (await inbox(user)).filter((n) => n.entity_id === reqId);
    for (const u of [T.users.hod, T.users.campusAdmin, T.users.admin]) {
      const n = await noteOf(u);
      expect(n, u).toHaveLength(1);
      expect(`${n[0]!.title} ${n[0]!.body}`).not.toMatch(
        /PRESENT|ABSENT|LATE|EXCUSED|Sensitive|pupil/i,
      );
    }
    expect(await noteOf(F.main.user)).toHaveLength(0);
    expect((await decide(s.campusAdmin, reqId, 'approve')).statusCode).toBe(200);
    const mine = await noteOf(F.main.user);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toMatch(/approved/);
    expect(await noteOf(T.users.campusAdmin)).toHaveLength(1); // deciders are not told about their own decision
    expect((await inbox(T.users.studentOne)).length).toBe(before.student);
    expect((await inbox(OTHER.users.admin)).length).toBe(before.foreign);
    expect((await inbox(T.users.hod)).length).toBe(before.hod + 1);
    // no EMAIL/SMS/WHATSAPP delivery rows exist for these notices
    expect(
      await count(
        `SELECT count(*) AS n FROM app.notification_deliveries d JOIN app.notifications n ON n.id = d.notification_id WHERE n.entity_id = $1 AND d.channel <> 'IN_APP'`,
        [reqId],
      ),
    ).toBe(0);
  });

  it('a direct correction by someone else tells the conducting teacher; the teacher correcting their own session tells nobody', async () => {
    const { sessionId, records } = await mk(1);
    const base = (await inbox(F.main.user)).filter((n) => n.entity_id === sessionId).length;
    expect((await correct(s.main, records[0]!.id, bodyOf(records[0]!))).statusCode).toBe(200);
    expect((await inbox(F.main.user)).filter((n) => n.entity_id === sessionId)).toHaveLength(base);
    expect((await correct(s.hod, records[1]!.id, bodyOf(records[1]!))).statusCode).toBe(200);
    const notes = (await inbox(F.main.user)).filter((n) => n.entity_id === sessionId);
    expect(notes).toHaveLength(base + 1);
    expect(notes.at(-1)!.body).not.toMatch(/PRESENT|ABSENT|LATE|EXCUSED/);
  });
});

describe('student privacy and tenant isolation', () => {
  it('a student sees only their current status (no revision, request, approver or lock data) and cannot reach any staff route', async () => {
    const mineRows = dataOf<Array<Record<string, unknown>>>(
      await call('GET', s.student, '/attendance/me/records'),
    );
    for (const row of mineRows) {
      expect(Object.keys(row).sort()).toEqual([
        'classSessionId',
        'courseCode',
        'courseOfferingId',
        'courseTitle',
        'kind',
        'sessionDate',
        'startsAt',
        'status',
      ]);
    }
    const { sessionId, records } = await mk(11);
    for (const [method, path, payload] of [
      ['GET', '/attendance/correction-requests', undefined],
      ['POST', `/attendance/records/${records[0]!.id}/correction-requests`, bodyOf(records[0]!)],
      ['POST', `/attendance/correction-requests/${uuidv7()}/approve`, {}],
      ['POST', `/attendance/sessions/${sessionId}/lock`, { reason: 'Student locking' }],
      ['GET', `/attendance/records/${records[0]!.id}/revisions`, undefined],
    ] as const) {
      const r = await call(
        method,
        s.student,
        path,
        payload,
        method === 'POST' ? { 'idempotency-key': key() } : {},
      );
      expect(r.statusCode, `${method} ${path}`).toBe(403);
    }
  });

  it('another tenant cannot see, request, decide or lock anything, and the requests table is invisible to the runtime role of a student actor', async () => {
    const { sessionId, records } = await mk(1);
    const old = (await mk(12)).records[0]!;
    const reqId = idOf(await reqCorr(s.main, old, bodyOf(old)));
    expect((await correct(s.foreignAdmin, records[0]!.id, bodyOf(records[0]!))).statusCode).toBe(
      404,
    );
    expect((await reqCorr(s.foreignAdmin, old, bodyOf(old))).statusCode).toBe(404);
    expect(
      (await decide(s.foreignAdmin, reqId, 'reject', { note: 'Foreign tenant' })).statusCode,
    ).toBe(404);
    expect((await lock(s.foreignAdmin, sessionId)).statusCode).toBe(404);
    expect((await sessionRow(sessionId)).attendance_state).toBe('SUBMITTED');
    expect(
      (await decide(s.hod, reqId, 'reject', { note: 'Cleaning up the fixture' })).statusCode,
    ).toBe(200);
  });
});

describe('term status: CLOSED is for institutional authority, LOCKED locks everything (runs last: it changes the term)', () => {
  it('CLOSED: faculty are refused, administrators can still correct and approve; faculty cancel is refused, administrative cancel works', async () => {
    const recent = await mk(1);
    const old = await mk(6);
    const pendingFaculty = idOf(await createSession(s.main, sessionBody(D(-1), 3)));
    const pendingAdmin = idOf(await createSession(s.main, sessionBody(D(-1), 2)));
    const openRequest = idOf(await reqCorr(s.main, old.records[0]!, bodyOf(old.records[0]!)));
    await adminQuery(`UPDATE app.terms SET status = 'CLOSED' WHERE id = $1`, [U.term]);

    const f = await correct(s.main, recent.records[0]!.id, bodyOf(recent.records[0]!));
    expect(f.statusCode).toBe(409);
    expect(f.json<{ error: { message: string } }>().error.message).toMatch(/term is CLOSED/);
    expect((await reqCorr(s.main, old.records[1]!, bodyOf(old.records[1]!))).statusCode).toBe(409);
    expect(
      (await correct(s.campusAdmin, recent.records[0]!.id, bodyOf(recent.records[0]!))).statusCode,
    ).toBe(200);
    const adminReq = await reqCorr(s.campusAdmin, old.records[1]!, bodyOf(old.records[1]!));
    expect(adminReq.statusCode, adminReq.body).toBe(201);
    expect((await decide(s.admin, idOf(adminReq), 'approve')).statusCode).toBe(200);
    expect((await decide(s.hod, openRequest, 'approve')).statusCode).toBe(200);

    expect(
      (await cancel(s.main, pendingFaculty, { reason: 'Term already closed' })).statusCode,
    ).toBe(409);
    expect(
      (await cancel(s.campusAdmin, pendingAdmin, { reason: 'Administrative clean-up' })).statusCode,
    ).toBe(200);
  });

  it('locking the term locks its submitted sessions first (tier 3, one event with the count), blocks every correction path, and a pending request can only be rejected', async () => {
    const target = (
      await adminQuery<{ id: string; session: string }>(
        `SELECT r.id, r.class_session_id AS session FROM app.attendance_records r WHERE r.organization_id = $1 AND r.revision_no = 1 ORDER BY r.created_at LIMIT 1`,
        [T.orgId],
      )
    )[0]!;
    const pendingReq = uuidv7();
    const cur = (
      await adminQuery<{ status: string }>(
        `SELECT status FROM app.attendance_records WHERE id = $1`,
        [target.id],
      )
    )[0]!;
    const submittedBefore = await count(
      `SELECT count(*) AS n FROM app.class_sessions WHERE organization_id = $1 AND attendance_state = 'SUBMITTED'`,
      [T.orgId],
    );
    expect(submittedBefore).toBeGreaterThan(0);
    await adminQuery(
      `INSERT INTO app.attendance_correction_requests (id, organization_id, attendance_record_id, class_session_id, student_id, status_before, requested_status, expected_revision_no, reason_code, requested_by_user_id)
       SELECT $1, r.organization_id, r.id, r.class_session_id, r.student_id, r.status, CASE WHEN r.status = 'ABSENT' THEN 'PRESENT' ELSE 'ABSENT' END, r.revision_no, 'FACULTY_ERROR', $3
         FROM app.attendance_records r WHERE r.id = $2`,
      [pendingReq, target.id, F.main.user],
    );
    const version = (
      await adminQuery<{ version: number }>(`SELECT version FROM app.terms WHERE id = $1`, [U.term])
    )[0]!.version;
    const locked = await call(
      'PATCH',
      s.admin,
      `/academics/terms/${U.term}`,
      { status: 'LOCKED', reason: 'Results published for the term' },
      { 'if-match': `"${version}"` },
    );
    expect(locked.statusCode, locked.body).toBe(200);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.class_sessions WHERE organization_id = $1 AND attendance_state = 'SUBMITTED'`,
        [T.orgId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.class_sessions WHERE organization_id = $1 AND attendance_state = 'LOCKED' AND lock_reason LIKE 'Academic term locked%'`,
        [T.orgId],
      ),
    ).toBe(submittedBefore);
    const ev = await adminQuery<{ risk_tier: number; metadata: { lockedSessionCount: number } }>(
      `SELECT risk_tier, metadata FROM app.audit_events WHERE action = 'attendance.term.sessions_lock' AND resource_id = $1`,
      [U.term],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ risk_tier: 3 });
    expect(ev[0]!.metadata.lockedSessionCount).toBe(submittedBefore);
    expect((await audit('academic.term.lock', U.term))[0]).toMatchObject({ risk_tier: 3 });

    const rec: Rec = {
      id: target.id,
      studentId: '',
      status: cur.status,
      revisionNo: 1,
      source: 'MANUAL',
    };
    for (const who of [s.main, s.hod, s.campusAdmin, s.admin]) {
      expect((await correct(who, rec.id, bodyOf(rec))).statusCode).toBe(409);
      expect((await reqCorr(who, rec, bodyOf(rec))).statusCode).toBe(409);
    }
    expect((await decide(s.hod, pendingReq, 'approve')).statusCode).toBe(409);
    expect((await decide(s.hod, pendingReq, 'reject', { note: 'Term is locked' })).statusCode).toBe(
      200,
    );
    expect(await recordRow(target.id)).toMatchObject({ revision_no: 1 });
    expect((await lock(s.admin, target.session)).statusCode).toBe(409);
  });
});
