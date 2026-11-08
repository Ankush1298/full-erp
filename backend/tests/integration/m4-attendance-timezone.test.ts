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

// Attendance time-zone correctness (doc 49 ATT-1 to ATT-3) over HTTP in private tenants:
// campus-local session instants and dates, the server-provided correction-window eligibility on the campus calendar, stable
// error codes, and the read-only campus clock. Synthetic data only.

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

// ---- campus clock helpers (independent of the production code) -----------------------------------------------------------
const dtf = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
const parts = (ms: number, tz: string) => {
  const p = Object.fromEntries(
    dtf(tz)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p['year']}-${p['month']}-${p['day']}`, time: `${p['hour']}:${p['minute']}` };
};
const tzToday = (tz: string): string => parts(Date.now(), tz).date;
const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** The instant at which `date` `HH:MM` is shown on the wall clocks of `tz` (no DST ambiguity is used in these tests). */
function localInstant(date: string, hhmm: string, tz: string): string {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  let ms = guess;
  for (let i = 0; i < 3; i++) {
    const p = parts(ms, tz);
    const shownAsUtc = Date.parse(`${p.date}T${p.time}:00Z`);
    ms += guess - shownAsUtc;
  }
  return new Date(ms).toISOString();
}
const setZone = (tz: string) =>
  adminQuery(`UPDATE app.campuses SET timezone = $1 WHERE id = $2`, [tz, T.campusId]);

let hourCursor = 0;
async function newSession(date: string, from: string, to: string, who: Session | null = s.main) {
  return call(
    'POST',
    who,
    '/attendance/sessions',
    {
      courseOfferingId: U.offering,
      sessionDate: date,
      startsAt: from,
      endsAt: to,
    },
    { 'idempotency-key': key() },
  );
}
/** Create a session at LOCAL 09:00-10:00 + a distinct minute offset in `tz`, submit it, and read it back. */
async function submittedLocal(date: string, tz: string) {
  const minute = String(hourCursor++ % 50).padStart(2, '0');
  const created = await newSession(
    date,
    localInstant(date, `09:${minute}`, tz),
    localInstant(date, `10:${minute}`, tz),
  );
  expect(created.statusCode, created.body).toBe(201);
  const id = idOf(created);
  const sub = await call(
    'POST',
    s.main,
    `/attendance/sessions/${id}/attendance`,
    {
      records: roster.map((m) => ({ studentId: m.student, status: 'PRESENT' })),
    },
    { 'idempotency-key': key() },
  );
  expect(sub.statusCode, sub.body).toBe(201);
  const dto = dataOf<Record<string, unknown>>(
    await call('GET', s.main, `/attendance/sessions/${id}`),
  );
  const recs = dataOf<Array<{ id: string; revisionNo: number }>>(
    await call('GET', s.main, `/attendance/sessions/${id}/records`),
  );
  return { id, dto, recs };
}
const errCode = (r: { json: <X>() => X }): string | undefined =>
  r.json<{ error?: { code?: string } }>().error?.code;
const corr = (
  rec: { id: string; revisionNo: number },
  route: 'corrections' | 'correction-requests',
) =>
  call(
    'POST',
    s.main,
    `/attendance/records/${rec.id}/${route}`,
    { status: 'ABSENT', expectedRevisionNo: rec.revisionNo, reasonCode: 'FACULTY_ERROR' },
    { 'idempotency-key': key() },
  );

describe('ATT-1: session instants are campus-local and read back in the campus zone', () => {
  it('09:00 entered for an India campus is stored as 03:30Z, reads back as 09:00 local, and evening classes are accepted', async () => {
    await setZone('Asia/Kolkata');
    const date = shift(tzToday('Asia/Kolkata'), -1);
    const { dto, id } = await submittedLocal(date, 'Asia/Kolkata');
    expect(dto['campusTimezone']).toBe('Asia/Kolkata');
    expect(String(dto['startsAt'])).toMatch(/T03:30:00\.000Z$/); // 09:00 India time is 03:30Z
    const row = (
      await adminQuery<{ local: string }>(
        `SELECT to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'HH24') AS local FROM app.class_sessions WHERE id = $1`,
        [id],
      )
    )[0]!;
    expect(row.local).toBe('09');
    // an evening class 20:00-21:00 local on the campus date (refused before the fix, because it was read as UTC)
    const ev = await newSession(
      date,
      localInstant(date, '20:00', 'Asia/Kolkata'),
      localInstant(date, '21:00', 'Asia/Kolkata'),
    );
    expect(ev.statusCode, ev.body).toBe(201);
  });

  it('a class that crosses midnight, or whose times fall on another local day, is refused with a stable code', async () => {
    await setZone('Asia/Kolkata');
    const date = shift(tzToday('Asia/Kolkata'), -1);
    const cross = await newSession(
      date,
      localInstant(date, '23:00', 'Asia/Kolkata'),
      localInstant(shift(date, 1), '01:00', 'Asia/Kolkata'),
    );
    expect([cross.statusCode, errCode(cross)]).toEqual([409, 'SESSION_TIME_OUTSIDE_DAY']);
    // the UTC reading of 20:00 is next-day 01:30 in India: exactly the old defect
    const utcRead = await newSession(date, `${date}T20:00:00.000Z`, `${date}T21:00:00.000Z`);
    expect([utcRead.statusCode, errCode(utcRead)]).toEqual([409, 'SESSION_TIME_OUTSIDE_DAY']);
  });

  it('other IANA zones round-trip: 09:xx local stays 09:xx local in New York, Kiritimati, Pago Pago and UTC', async () => {
    for (const tz of ['America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
      await setZone(tz);
      const date = shift(tzToday(tz), -1);
      const { dto, id } = await submittedLocal(date, tz);
      expect(dto['campusTimezone'], tz).toBe(tz);
      expect(dto['sessionDate'], tz).toBe(date);
      const row = (
        await adminQuery<{ local: string; d: string }>(
          `SELECT to_char(starts_at AT TIME ZONE $2, 'HH24') AS local, (starts_at AT TIME ZONE $2)::date::text AS d FROM app.class_sessions WHERE id = $1`,
          [id, tz],
        )
      )[0]!;
      expect([row.local, row.d], tz).toEqual(['09', date]);
    }
  });

  it('the campus-local "today" comes from the server in each campus zone, and differs from the UTC date in at least one far zone', async () => {
    const seen: Record<string, string> = {};
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata']) {
      await setZone(tz);
      const offerings = dataOf<Array<{ campusTimezone: string; campusToday: string }>>(
        await call('GET', s.main, '/attendance/my-offerings'),
      );
      expect(offerings.length).toBeGreaterThan(0);
      expect(offerings[0]!.campusTimezone).toBe(tz);
      expect(offerings[0]!.campusToday).toBe(tzToday(tz));
      seen[tz] = offerings[0]!.campusToday;
    }
    const utc = new Date().toISOString().slice(0, 10);
    expect(seen['Pacific/Kiritimati'] !== utc || seen['Pacific/Pago_Pago'] !== utc).toBe(true);
  });

  it('a duplicate start time gives SESSION_EXISTS', async () => {
    await setZone('Asia/Kolkata');
    const date = shift(tzToday('Asia/Kolkata'), -2);
    const a = localInstant(date, '07:05', 'Asia/Kolkata');
    const b = localInstant(date, '08:05', 'Asia/Kolkata');
    expect((await newSession(date, a, b)).statusCode).toBe(201);
    const dup = await newSession(date, a, b);
    expect([dup.statusCode, errCode(dup)]).toEqual([409, 'SESSION_EXISTS']);
  });
});

describe('ATT-2: the three-calendar-day window is read from the server on the campus calendar', () => {
  it('insideCorrectionWindow equals what the server enforces, in every zone, on both sides of the boundary', async () => {
    for (const tz of [
      'Asia/Kolkata',
      'Pacific/Kiritimati',
      'Pacific/Pago_Pago',
      'America/New_York',
    ]) {
      await setZone(tz);
      const today = tzToday(tz);
      const inside = await submittedLocal(shift(today, -3), tz);
      const outside = await submittedLocal(shift(today, -4), tz);
      expect(
        [
          inside.dto['insideCorrectionWindow'],
          inside.dto['correctionWindowDays'],
          inside.dto['campusToday'],
        ],
        tz,
      ).toEqual([true, 3, today]);
      expect(outside.dto['insideCorrectionWindow'], tz).toBe(false);
      // enforcement agrees with the flag: direct correction inside, request outside; the wrong route is refused with a stable code
      expect((await corr(inside.recs[0]!, 'corrections')).statusCode, `${tz} inside direct`).toBe(
        200,
      );
      const wrongRequest = await corr(inside.recs[1]!, 'correction-requests');
      expect([wrongRequest.statusCode, errCode(wrongRequest)], tz).toEqual([
        409,
        'CORRECTION_WINDOW_OPEN',
      ]);
      const wrongDirect = await corr(outside.recs[0]!, 'corrections');
      expect([wrongDirect.statusCode, errCode(wrongDirect)], tz).toEqual([
        409,
        'CORRECTION_WINDOW_PASSED',
      ]);
      expect(
        (await corr(outside.recs[0]!, 'correction-requests')).statusCode,
        `${tz} outside request`,
      ).toBe(201);
    }
  });

  it('a campus policy row changes the reported window (and the flag) consistently', async () => {
    await setZone('Asia/Kolkata');
    const pol = uuidv7();
    await adminQuery(
      `INSERT INTO app.attendance_policies (id, organization_id, campus_id, edit_window_days) VALUES ($1, $2, $3, 1)`,
      [pol, T.orgId, T.campusId],
    );
    try {
      const today = tzToday('Asia/Kolkata');
      const two = await submittedLocal(shift(today, -2), 'Asia/Kolkata');
      expect([two.dto['correctionWindowDays'], two.dto['insideCorrectionWindow']]).toEqual([
        1,
        false,
      ]);
      const wrong = await corr(two.recs[0]!, 'corrections');
      expect(errCode(wrong)).toBe('CORRECTION_WINDOW_PASSED');
    } finally {
      await adminQuery(`UPDATE app.attendance_policies SET edit_window_days = 3 WHERE id = $1`, [
        pol,
      ]);
    }
  });
});

describe('ATT-3: distinguishable refusals', () => {
  it('feature switched off, missing permission, locked session and unassigned teacher each answer differently', async () => {
    await setZone('Asia/Kolkata');
    const today = tzToday('Asia/Kolkata');
    const x = await submittedLocal(shift(today, -1), 'Asia/Kolkata');
    // feature disabled (the deployment switch): a permission holder is told so, with a stable code
    const off = await appOff.inject({
      method: 'POST',
      url: `/api/v1/attendance/records/${x.recs[0]!.id}/corrections`,
      payload: { status: 'ABSENT', expectedRevisionNo: 1, reasonCode: 'FACULTY_ERROR' },
      cookies: { session_token: s.main.cookie },
      headers: { origin: APP_ORIGIN, 'x-csrf-token': s.main.csrf, 'idempotency-key': key() },
    });
    expect([off.statusCode, errCode(off)]).toEqual([403, 'ATTENDANCE_CORRECTIONS_DISABLED']);
    // missing permission: a student is refused at the route as FORBIDDEN (and learns nothing about the switch)
    const student = await call(
      'POST',
      s.student,
      `/attendance/records/${x.recs[0]!.id}/corrections`,
      { status: 'ABSENT', expectedRevisionNo: 1, reasonCode: 'FACULTY_ERROR' },
      { 'idempotency-key': key() },
    );
    expect([student.statusCode, errCode(student)]).toEqual([403, 'FORBIDDEN']);
    // outside the teacher's assignment: the same 404 as a missing record
    const stranger = await call(
      'POST',
      s.stranger,
      `/attendance/records/${x.recs[1]!.id}/corrections`,
      { status: 'ABSENT', expectedRevisionNo: 1, reasonCode: 'FACULTY_ERROR' },
      { 'idempotency-key': key() },
    );
    expect([stranger.statusCode, errCode(stranger)]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    // locked session
    await elevateSession(s.campusAdmin.cookie);
    expect(
      (
        await call(
          'POST',
          s.campusAdmin,
          `/attendance/sessions/${x.id}/lock`,
          { reason: 'Results frozen for the audit' },
          { 'idempotency-key': key() },
        )
      ).statusCode,
    ).toBe(200);
    const locked = await corr(x.recs[1]!, 'corrections');
    expect([locked.statusCode, errCode(locked)]).toEqual([409, 'SESSION_LOCKED']);
  });
});

describe('the campus clock endpoint and tenant/campus scope', () => {
  it('lists only the campuses the caller reads through an institutional grant; assigned faculty and students get none; no other tenant leaks', async () => {
    await setZone('Asia/Kolkata');
    const other = await adminQuery<{ id: string }>(
      `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Second campus', $3, 'America/New_York') RETURNING id`,
      [uuidv7(), T.orgId, code('SC')],
    );
    const list = async (who: Session) =>
      dataOf<Array<{ id: string; timezone: string; today: string }>>(
        await call('GET', who, '/attendance/campuses'),
      );
    const college = await list(s.admin);
    expect(college.map((c) => c.id).sort()).toEqual([T.campusId, other[0]!.id].sort());
    const ny = college.find((c) => c.id === other[0]!.id)!;
    expect([ny.timezone, ny.today]).toEqual(['America/New_York', tzToday('America/New_York')]);
    expect((await list(s.campusAdmin)).map((c) => c.id)).toEqual([T.campusId]); // campus-scoped: not the second campus
    expect((await list(s.hod)).map((c) => c.id)).toEqual([T.campusId]); // department-scoped: its campus only
    expect(await list(s.main)).toEqual([]); // ASSIGNED faculty read their clock from my-offerings
    expect((await call('GET', s.student, '/attendance/campuses')).statusCode).toBe(403);
    expect((await call('GET', null, '/attendance/campuses')).statusCode).toBe(401);
    expect((await list(s.foreignAdmin)).map((c) => c.id)).not.toContain(T.campusId);
    expect((await list(s.foreignAdmin)).map((c) => c.id)).not.toContain(other[0]!.id);
  });

  it('the session read carries the clock only for sessions the caller is allowed to read (no cross-tenant read)', async () => {
    await setZone('Asia/Kolkata');
    const x = await submittedLocal(shift(tzToday('Asia/Kolkata'), -1), 'Asia/Kolkata');
    expect((await call('GET', s.foreignAdmin, `/attendance/sessions/${x.id}`)).statusCode).toBe(
      404,
    );
    expect((await call('GET', s.student, `/attendance/sessions/${x.id}`)).statusCode).toBe(403);
  });
});
