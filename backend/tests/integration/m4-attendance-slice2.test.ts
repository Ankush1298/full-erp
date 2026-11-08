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
import { activateTermFixture } from '../support/term-fixture.js';

// Milestone 4, Slice 2 (migrations 0040-0041, doc 41 §6) over HTTP in private tenants: class sessions, first submission of
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
/** A fresh submitted session on its own date; returns the session id and the records by student. */
// Slice 4: corrections are direct only inside the 3-calendar-day faculty window, so these sessions sit on D(0)..D(-3) at
// distinct hours (the roster exists from D(-30); the `ended` teacher's assignment ends at D(-10), so tests about it use their own dates)
let used = 0;
async function submitted(): Promise<{ sessionId: string; records: Rec[] }> {
  const n = used++;
  const sessionId = idOf(
    await createSession(s.main, sessionBody(D(-(n % 4)), 5 + Math.floor(n / 4))),
  );
  const r = await submit(s.main, sessionId, fullRoster());
  expect(r.statusCode, r.body).toBe(201);
  const list = await call('GET', s.main, `/attendance/sessions/${sessionId}/records`);
  return { sessionId, records: dataOf<Rec[]>(list) };
}
const body = (rec: Rec, extra: Record<string, unknown> = {}) => ({
  status: 'ABSENT',
  expectedRevisionNo: rec.revisionNo,
  reasonCode: 'FACULTY_ERROR',
  ...extra,
});
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

describe('corrections: authorization (attendance.record.correct, ASSIGNED)', () => {
  it('only an assigned teacher may correct; everyone else is 403 or the same 404 as a missing record, and nothing changes', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    // not held at all: students (administrators hold it since AD-3; tests/integration/m4-attendance-slice4.test.ts)
    for (const who of [s.student]) {
      expect((await correct(who, rec.id, body(rec))).statusCode).toBe(403);
    }
    expect((await correct(null, rec.id, body(rec))).statusCode).toBe(401);
    // held, but not assigned to this offering on the date / another tenant / unknown record
    const missing = await correct(s.main, uuidv7(), body(rec));
    expect(missing.statusCode).toBe(404);
    for (const who of [s.stranger, s.future, s.foreignFaculty]) {
      const r = await correct(who, rec.id, body(rec));
      expect(r.statusCode, r.body).toBe(404);
      expect(r.json<{ error: object }>().error).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    }
    expect(await recordRow(rec.id)).toMatchObject({
      status: 'PRESENT',
      revision_no: 1,
      source: 'MANUAL',
    });
    expect(await revisionCount(rec.id)).toBe(1);
  });

  it('the assignment is judged on the session date: `ended` (assignment to D(-10)) may correct a session inside it, not one after it', async () => {
    // Slice 4: `ended` is a CO_INSTRUCTOR until D(-10), so inside the 3-day window they hold no assignment (404), while a
    // request for a session that lies inside their assignment is accepted; one after the assignment is not.
    const inside = idOf(await createSession(s.ended, sessionBody(D(-12), 16)));
    expect((await submit(s.ended, inside, fullRoster())).statusCode).toBe(201);
    const rec = dataOf<Rec[]>(
      await call('GET', s.ended, `/attendance/sessions/${inside}/records`),
    )[0]!;
    const req = (who: Session, r: Rec) =>
      call('POST', who, `/attendance/records/${r.id}/correction-requests`, body(r), {
        'idempotency-key': key(),
      });
    expect((await req(s.ended, rec)).statusCode).toBe(201);

    const after = idOf(await createSession(s.main, sessionBody(D(-5))));
    expect((await submit(s.main, after, fullRoster())).statusCode).toBe(201);
    const late = dataOf<Rec[]>(
      await call('GET', s.main, `/attendance/sessions/${after}/records`),
    )[0]!;
    expect((await correct(s.ended, late.id, body(late))).statusCode).toBe(404);
    expect((await req(s.ended, late)).statusCode).toBe(404);
    expect((await cancel(s.ended, after, { reason: 'Not their session' })).statusCode).toBe(404);
    expect(await revisionCount(late.id)).toBe(1);
  });

  it('strict body: unknown fields, SYSTEM_RECOMPUTE, a bad status and a missing revision are rejected before any write', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    for (const bad of [
      { ...body(rec), changedByUserId: F.stranger.user },
      { ...body(rec), source: 'IMPORT' },
      { ...body(rec), reasonCode: 'SYSTEM_RECOMPUTE' },
      { ...body(rec), status: 'GONE' },
      { status: 'ABSENT', reasonCode: 'FACULTY_ERROR' },
    ]) {
      expect((await correct(s.main, rec.id, bad)).statusCode).toBe(400);
    }
    expect((await correct(s.main, rec.id, body(rec, { reasonCode: 'OTHER' }))).statusCode).toBe(
      400,
    ); // OTHER needs text
    expect(await revisionCount(rec.id)).toBe(1);
  });
});

describe('corrections: behaviour', () => {
  it('writes revision N+1 with before/after, reason and actor, updates the record, audits at tier 2, and keeps the history', async () => {
    const { records } = await submitted();
    const rec = records[1]!;
    const r = await correct(
      s.main,
      rec.id,
      body(rec, { reasonCode: 'STUDENT_DISPUTE', reasonText: 'Student showed a signed note' }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(dataOf<Rec>(r)).toMatchObject({
      id: rec.id,
      status: 'ABSENT',
      revisionNo: 2,
      source: 'CORRECTION',
    });
    expect(await recordRow(rec.id)).toMatchObject({
      status: 'ABSENT',
      revision_no: 2,
      source: 'CORRECTION',
      marked_by_user_id: F.main.user,
    });

    const history = dataOf<Array<Record<string, unknown>>>(
      await call('GET', s.hod, `/attendance/records/${rec.id}/revisions`),
    );
    expect(history).toMatchObject([
      { revisionNo: 1, statusBefore: null, statusAfter: 'PRESENT', reasonCode: 'OTHER' },
      {
        revisionNo: 2,
        statusBefore: 'PRESENT',
        statusAfter: 'ABSENT',
        source: 'CORRECTION',
        changedByUserId: F.main.user,
        reasonCode: 'STUDENT_DISPUTE',
        reasonText: 'Student showed a signed note',
      },
    ]);
    const audit = await adminQuery<{
      risk_tier: number;
      reason_code: string;
      subject_student_id: string;
      changes: Record<string, { old: unknown; new: unknown }>;
    }>(
      `SELECT risk_tier, reason_code, subject_student_id, changes FROM app.audit_events WHERE action = 'attendance.record.correct' AND resource_id = $1`,
      [rec.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      risk_tier: 2,
      reason_code: 'STUDENT_DISPUTE',
      subject_student_id: rec.studentId,
    });
    expect(audit[0]!.changes['status']).toEqual({ old: 'PRESENT', new: 'ABSENT' });

    // a second correction chains from the first (ABSENT -> EXCUSED), history grows by one
    const second = await correct(s.main, rec.id, {
      status: 'EXCUSED',
      expectedRevisionNo: 2,
      reasonCode: 'MEDICAL',
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(await revisionCount(rec.id)).toBe(3);
  });

  it('every status is reachable from every other, but a no-change correction is a 409', async () => {
    const { records } = await submitted();
    const rec = records[2]!;
    expect((await correct(s.main, rec.id, body(rec, { status: 'PRESENT' }))).statusCode).toBe(409);
    let revision = 1;
    for (const status of ['LATE', 'ABSENT', 'EXCUSED', 'PRESENT']) {
      const r = await correct(s.main, rec.id, {
        status,
        expectedRevisionNo: revision,
        reasonCode: 'FACULTY_ERROR',
      });
      expect(r.statusCode, `${status}: ${r.body}`).toBe(200);
      revision += 1;
    }
    expect(await revisionCount(rec.id)).toBe(5);
  });

  it('a stale expectedRevisionNo is a 409 and changes nothing (no silent overwrite)', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    expect((await correct(s.main, rec.id, body(rec))).statusCode).toBe(200);
    const stale = await correct(s.main, rec.id, body(rec, { status: 'LATE' })); // still says revision 1
    expect(stale.statusCode).toBe(409);
    expect(await recordRow(rec.id)).toMatchObject({ status: 'ABSENT', revision_no: 2 });
    expect(await revisionCount(rec.id)).toBe(2);
  });

  it('Idempotency-Key: 428 missing, 400 malformed, replay returns the stored result once, another body is 422', async () => {
    const { records } = await submitted();
    const rec = records[3]!;
    expect((await correct(s.main, rec.id, body(rec), null)).statusCode).toBe(428);
    expect((await correct(s.main, rec.id, body(rec), 'short')).statusCode).toBe(400);
    const k = key();
    const first = await correct(s.main, rec.id, body(rec), k);
    expect(first.statusCode, first.body).toBe(200);
    const replay = await correct(s.main, rec.id, body(rec), k);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect((await correct(s.main, rec.id, body(rec, { status: 'LATE' }), k)).statusCode).toBe(422);
    expect(await revisionCount(rec.id)).toBe(2); // the replay did not write a third
  });

  it('two simultaneous corrections with different keys: exactly one wins, the other is 409, history has exactly one new revision', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    const results = await Promise.all([
      correct(s.main, rec.id, body(rec, { status: 'ABSENT' })),
      correct(s.main, rec.id, body(rec, { status: 'LATE' })),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await revisionCount(rec.id)).toBe(2);
    expect((await recordRow(rec.id)).revision_no).toBe(2);
  });

  it('the same correction sent twice at once with ONE key writes once', async () => {
    const { records } = await submitted();
    const rec = records[1]!;
    const k = key();
    const results = await Promise.all([
      correct(s.main, rec.id, body(rec), k),
      correct(s.main, rec.id, body(rec), k),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await revisionCount(rec.id)).toBe(2);
  });
});

describe('corrections: lifecycle limits', () => {
  it('a LOCKED session cannot be corrected (409, nothing written); the database refuses the same change for every writer', async () => {
    const { sessionId, records } = await submitted();
    const rec = records[0]!;
    await adminQuery(
      `UPDATE app.class_sessions SET attendance_state = 'LOCKED', locked_at = now() WHERE id = $1`,
      [sessionId],
    );
    const r = await correct(s.main, rec.id, body(rec));
    expect(r.statusCode, r.body).toBe(409);
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 });
    expect(await revisionCount(rec.id)).toBe(1);
    // reads still work on a locked session
    expect(
      (await call('GET', s.main, `/attendance/sessions/${sessionId}/records`)).statusCode,
    ).toBe(200);
    await expect(
      adminQuery(
        `UPDATE app.attendance_records SET status = 'ABSENT', revision_no = 2 WHERE id = $1`,
        [rec.id],
      ),
    ).rejects.toThrow(/locked/i);
  });

  it('a record whose session never took attendance does not exist to correct; a cancelled session has no records', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-59))));
    expect((await cancel(s.main, id, { reason: 'Teacher unwell' })).statusCode).toBe(200);
    expect(
      await count(`SELECT count(*) AS n FROM app.attendance_records WHERE class_session_id = $1`, [
        id,
      ]),
    ).toBe(0);
    expect((await submit(s.main, id, fullRoster())).statusCode).toBe(409);
  });
});

describe('session cancellation', () => {
  it('an assigned teacher cancels a session that took no attendance, with a reason; it is audited and final', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-58))));
    const k = key();
    const r = await cancel(s.main, id, { reason: 'Public event on campus' }, k);
    expect(r.statusCode, r.body).toBe(200);
    expect(dataOf<{ status: string; attendanceState: string }>(r)).toMatchObject({
      status: 'CANCELLED',
      attendanceState: 'NOT_STARTED',
    });
    const row = (
      await adminQuery<{ cancel_reason: string; status: string }>(
        `SELECT cancel_reason, status FROM app.class_sessions WHERE id = $1`,
        [id],
      )
    )[0]!;
    expect(row).toEqual({ cancel_reason: 'Public event on campus', status: 'CANCELLED' });
    const audit = await adminQuery<{ risk_tier: number; reason_text: string }>(
      `SELECT risk_tier, reason_text FROM app.audit_events WHERE action = 'attendance.session.cancel' AND resource_id = $1`,
      [id],
    );
    expect(audit).toEqual([{ risk_tier: 2, reason_text: 'Public event on campus' }]);
    // replay with the same key: same result, no second audit row; a new key finds it already cancelled
    const replay = await cancel(s.main, id, { reason: 'Public event on campus' }, k);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await cancel(s.main, id, { reason: 'Public event on campus' })).statusCode).toBe(409);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE action = 'attendance.session.cancel' AND resource_id = $1`,
        [id],
      ),
    ).toBe(1);
    // a cancelled session cannot be revived, and an idempotency key cannot be reused with another reason
    await expect(
      adminQuery(
        `UPDATE app.class_sessions SET status = 'SCHEDULED', cancel_reason = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow();
    expect((await cancel(s.main, id, { reason: 'A different reason' }, k)).statusCode).toBe(422);
  });

  it('a conducted (submitted) session cannot be cancelled; its attendance changes only by correction', async () => {
    const { sessionId, records } = await submitted();
    const r = await cancel(s.main, sessionId, { reason: 'Entered by mistake' });
    expect(r.statusCode).toBe(409);
    expect((await recordRow(records[0]!.id)).status).toBe('PRESENT');
    expect(
      (
        await adminQuery<{ status: string }>(
          `SELECT status FROM app.class_sessions WHERE id = $1`,
          [sessionId],
        )
      )[0]!.status,
    ).toBe('CONDUCTED');
  });

  it('authorization and validation: 403 without the permission, the same 404 for an unassigned teacher or another tenant, 400 for a short reason', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-57))));
    // HOD holds neither the faculty path nor the administrative cancel permission; administrators do (AD-7, slice 4 tests)
    for (const who of [s.hod, s.student]) {
      expect((await cancel(who, id, { reason: 'Not allowed' })).statusCode).toBe(403);
    }
    for (const who of [s.stranger, s.future, s.foreignFaculty]) {
      expect((await cancel(who, id, { reason: 'Not allowed' })).statusCode).toBe(404);
    }
    expect((await cancel(s.main, uuidv7(), { reason: 'Unknown session' })).statusCode).toBe(404);
    for (const bad of [{ reason: 'abc' }, {}, { reason: 'Valid reason', status: 'SCHEDULED' }]) {
      expect((await cancel(s.main, id, bad)).statusCode).toBe(400);
    }
    expect((await cancel(s.main, id, { reason: 'Valid reason' }, null)).statusCode).toBe(428);
    expect(
      (
        await adminQuery<{ status: string }>(
          `SELECT status FROM app.class_sessions WHERE id = $1`,
          [id],
        )
      )[0]!.status,
    ).toBe('SCHEDULED');
  });

  it('cancel and submit racing on one session: exactly one wins and the session ends in a consistent state', async () => {
    const id = idOf(await createSession(s.main, sessionBody(D(-56))));
    const [c, sub] = await Promise.all([
      cancel(s.main, id, { reason: 'Cancelled at the same time' }),
      submit(s.main, id, fullRoster()),
    ]);
    const row = (
      await adminQuery<{ status: string; attendance_state: string }>(
        `SELECT status, attendance_state FROM app.class_sessions WHERE id = $1`,
        [id],
      )
    )[0]!;
    const recs = await count(
      `SELECT count(*) AS n FROM app.attendance_records WHERE class_session_id = $1`,
      [id],
    );
    if (row.status === 'CANCELLED') {
      expect([c.statusCode, sub.statusCode]).toEqual([200, 409]);
      expect(recs).toBe(0);
    } else {
      expect([c.statusCode, sub.statusCode]).toEqual([409, 201]);
      expect(row).toEqual({ status: 'CONDUCTED', attendance_state: 'SUBMITTED' });
      expect(recs).toBe(4);
    }
  });
});

describe('database invariants behind the API (Slice 2)', () => {
  it('a correction without its revision, and a revision without its record change, are refused; a mismatched actor is refused', async () => {
    const { records } = await submitted();
    const rec = records[0]!;
    await expect(
      adminQuery(
        `UPDATE app.attendance_records SET status = 'ABSENT', source = 'CORRECTION', revision_no = 2 WHERE id = $1`,
        [rec.id],
      ),
    ).rejects.toThrow(/out of step/);
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `UPDATE app.attendance_records SET status = 'ABSENT', source = 'CORRECTION', revision_no = 2, marked_by_user_id = $2 WHERE id = $1`,
        [rec.id, F.main.user],
      );
      await c.query(
        `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code)
         VALUES ($1, $2, $3, 2, 'PRESENT', 'ABSENT', 'CORRECTION', $4, 'FACULTY_ERROR')`,
        [uuidv7(), T.orgId, rec.id, F.stranger.user], // a different actor than the record's marked_by
      );
      await expect(c.query('COMMIT')).rejects.toThrow(/out of step/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await recordRow(rec.id)).toMatchObject({ status: 'PRESENT', revision_no: 1 });
  });
});
