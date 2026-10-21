import { randomBytes, randomUUID } from 'node:crypto';
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

// HTTP-level tests of the Milestone 3 Batch 1 routes (/api/v1/academics/* and /api/v1/students/:id/term-enrollments*)
// against the shared disposable integration database. Everything commits, so it runs in two private tenants.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const ACA = '/api/v1/academics';
const STU = '/api/v1/students';
const RUN = randomBytes(3).toString('hex');

const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 6 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Actor = 'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'student' | 'foreignAdmin';
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

async function login(email: string) {
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

interface Opts {
  payload?: unknown;
  ifMatch?: string;
  key?: string;
  csrf?: string | null;
}
function call(
  user: Actor | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  o: Opts = {},
) {
  const csrf = o.csrf === undefined ? (user ? sessions[user].csrf : null) : o.csrf;
  return app.inject({
    method,
    url: path,
    ...(o.payload !== undefined ? { payload: o.payload as never } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(method !== 'GET' && csrf ? { 'x-csrf-token': csrf } : {}),
      ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}),
      ...(o.key ? { 'idempotency-key': o.key } : {}),
    },
  });
}
const idOf = (r: { json: <X>() => X }): string => r.json<{ data: { id: string } }>().data.id;

let PERIOD!: string;
let program!: string;
let cohort!: string;
let studentId!: string;
let studentTwo!: string;
let yearId!: string;
let termId!: string;
let cohortPeriodId!: string;
let sectionId!: string;
const YEAR_START = '2150-06-01';
const YEAR_END = '2151-05-31';

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  program = uuidv7();
  cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Route program', $5, 'UG', 8)`,
    [program, T.orgId, T.departmentId, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Route cohort')`,
    [cohort, T.orgId, program],
  );
  studentId = T.students.one;
  studentTwo = T.students.two;
  for (const s of [studentId, studentTwo]) {
    await adminQuery(
      `INSERT INTO app.student_programs (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01')`,
      [uuidv7(), T.orgId, s, program, cohort, T.campusId, T.departmentId],
    );
  }
  sessions.admin = await login(T.emails.admin);
  sessions.campusAdmin = await login(T.emails.campusAdmin);
  sessions.hod = await login(T.emails.hod);
  sessions.faculty = await login(T.emails.faculty);
  sessions.student = await login(T.emails.studentOne);
  sessions.foreignAdmin = await login(OTHER.emails.admin);
}, 90_000);

afterAll(async () => {
  await app.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'section_memberships',
      'term_enrollments',
      'sections',
      'cohort_periods',
      'curriculum_courses',
      'courses',
      'terms',
      'academic_years',
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
  await T.cleanup();
  await OTHER.cleanup();
});

describe('access control and request hygiene', () => {
  it('requires a session (401) and a CSRF token on writes (403)', async () => {
    expect((await call(null, 'GET', `${ACA}/academic-years`)).statusCode).toBe(401);
    expect(
      (
        await call('admin', 'POST', `${ACA}/academic-years`, {
          csrf: null,
          payload: { label: 'x', startDate: YEAR_START, endDate: YEAR_END },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects unknown, tenant and identity fields and malformed ids with 400', async () => {
    const body = { label: code('V'), startDate: YEAR_START, endDate: YEAR_END };
    for (const extra of [
      { organizationId: OTHER.orgId },
      { tenantId: OTHER.orgId },
      { status: 'ACTIVE' },
      { id: uuidv7() },
    ]) {
      expect(
        (await call('admin', 'POST', `${ACA}/academic-years`, { payload: { ...body, ...extra } }))
          .statusCode,
      ).toBe(400);
    }
    expect((await call('admin', 'GET', `${ACA}/terms/not-a-uuid`)).statusCode).toBe(400);
    expect(
      (
        await call('admin', 'POST', `${STU}/${studentId}/term-enrollments`, {
          key: randomUUID(),
          payload: { cohortPeriodId: uuidv7(), reason: 'Registered', organizationId: OTHER.orgId },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('permission matrix: reads need academic.program.read (everyone), writes need the dedicated manage permissions', async () => {
    for (const who of ['admin', 'campusAdmin', 'hod', 'faculty', 'student'] as const) {
      expect((await call(who, 'GET', `${ACA}/academic-years`)).statusCode, who).toBe(200);
      expect((await call(who, 'GET', `${ACA}/courses`)).statusCode, who).toBe(200);
    }
    const yearBody = { label: code('PM'), startDate: '2198-01-01', endDate: '2198-02-01' };
    for (const who of ['campusAdmin', 'hod', 'faculty', 'student'] as const) {
      expect(
        (await call(who, 'POST', `${ACA}/academic-years`, { payload: yearBody })).statusCode,
        who,
      ).toBe(403);
    }
    for (const who of ['hod', 'faculty', 'student'] as const) {
      expect(
        (
          await call(who, 'POST', `${ACA}/courses`, {
            payload: { code: code('C'), title: 'T', credits: 1, courseType: 'THEORY' },
          })
        ).statusCode,
        who,
      ).toBe(403);
    }
  });
});

describe('academic calendar, curriculum and sections over HTTP', () => {
  it('creates a year, a term, a course, a curriculum entry, a cohort period and a section; optimistic concurrency applies', async () => {
    const y = await call('admin', 'POST', `${ACA}/academic-years`, {
      payload: { label: code('HY'), startDate: YEAR_START, endDate: YEAR_END },
    });
    expect(y.statusCode).toBe(201);
    yearId = idOf(y);
    const got = await call('admin', 'GET', `${ACA}/academic-years/${yearId}`);
    expect(got.headers.etag).toBe('"1"');

    // If-Match is mandatory (428), strong (400 for weak), and checked against the stored version (409)
    const patch = (ifMatch: string | undefined, payload: object) =>
      call('admin', 'PATCH', `${ACA}/academic-years/${yearId}`, {
        payload,
        ...(ifMatch ? { ifMatch } : {}),
      });
    expect((await patch(undefined, { status: 'ACTIVE' })).statusCode).toBe(428);
    expect((await patch('W/"1"', { status: 'ACTIVE' })).statusCode).toBe(400);
    expect((await patch('"7"', { status: 'ACTIVE' })).statusCode).toBe(409);
    const ok = await patch('"1"', { status: 'ACTIVE' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json<{ data: { status: string } }>().data.status).toBe('ACTIVE');

    const t = await call('campusAdmin', 'POST', `${ACA}/terms`, {
      payload: {
        campusId: T.campusId,
        academicYearId: yearId,
        code: 'ODD',
        name: 'Odd term',
        startDate: YEAR_START,
        endDate: YEAR_END,
      },
    });
    expect(t.statusCode).toBe(201);
    termId = idOf(t);
    expect(
      (
        await call('campusAdmin', 'POST', `${ACA}/terms`, {
          payload: {
            campusId: T.campusId,
            academicYearId: yearId,
            code: 'ODD',
            name: 'Dup',
            startDate: YEAR_START,
            endDate: YEAR_END,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('admin', 'PATCH', `${ACA}/terms/${termId}`, {
          ifMatch: '"1"',
          payload: { status: 'ACTIVE' },
        })
      ).statusCode,
    ).toBe(200);

    const course = await call('admin', 'POST', `${ACA}/courses`, {
      payload: {
        code: code('CRS'),
        title: 'Databases',
        credits: 4,
        courseType: 'THEORY_PRACTICAL',
        owningDepartmentId: T.departmentId,
      },
    });
    expect(course.statusCode).toBe(201);
    const courseId = idOf(course);
    const cc = await call('admin', 'POST', `${ACA}/curriculum-courses`, {
      payload: { programId: program, courseId, regulation: 'R2024', periodNo: 3, category: 'CORE' },
    });
    expect(cc.statusCode).toBe(201);
    const listed = await call(
      'hod',
      'GET',
      `${ACA}/curriculum-courses?programId=${program}&regulation=R2024`,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: unknown[] }>().data).toHaveLength(1);
    // a prescribed course cannot be deleted; DELETE also needs If-Match
    expect((await call('admin', 'DELETE', `${ACA}/courses/${courseId}`)).statusCode).toBe(428);
    expect(
      (await call('admin', 'DELETE', `${ACA}/courses/${courseId}`, { ifMatch: '"1"' })).statusCode,
    ).toBe(409);
    expect(
      (await call('admin', 'DELETE', `${ACA}/curriculum-courses/${idOf(cc)}`, { ifMatch: '"1"' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('admin', 'DELETE', `${ACA}/courses/${courseId}`, { ifMatch: '"1"' })).statusCode,
    ).toBe(200);

    const cp = await call('admin', 'POST', `${ACA}/cohort-periods`, {
      payload: { cohortId: cohort, termId, periodNo: 1 },
    });
    expect(cp.statusCode).toBe(201);
    cohortPeriodId = idOf(cp);
    const sec = await call('admin', 'POST', `${ACA}/sections`, {
      payload: { cohortPeriodId, name: 'A', capacity: 1 },
    });
    expect(sec.statusCode).toBe(201);
    sectionId = idOf(sec);
    expect(
      (await call('admin', 'POST', `${ACA}/sections`, { payload: { cohortPeriodId, name: 'A' } }))
        .statusCode,
    ).toBe(409);
  });

  it('a foreign tenant sees none of it: identical 404s for every resource kind', async () => {
    for (const path of [
      `${ACA}/academic-years/${yearId}`,
      `${ACA}/terms/${termId}`,
      `${ACA}/sections/${sectionId}`,
      `${ACA}/sections/${sectionId}/members`,
    ]) {
      expect((await call('foreignAdmin', 'GET', path)).statusCode, path).toBe(404);
    }
    expect(
      (
        await call('foreignAdmin', 'POST', `${ACA}/terms`, {
          payload: {
            campusId: T.campusId,
            academicYearId: yearId,
            code: 'X',
            name: 'X',
            startDate: YEAR_START,
            endDate: YEAR_END,
          },
        })
      ).statusCode,
    ).toBe(404);
    const years = await call('foreignAdmin', 'GET', `${ACA}/academic-years`);
    expect(years.json<{ data: Array<{ id: string }> }>().data.some((x) => x.id === yearId)).toBe(
      false,
    );
  });
});

describe('term enrolment and section placement over HTTP', () => {
  let enrollmentId: string;
  const key = randomUUID();

  it('requires an Idempotency-Key, creates once, replays, and rejects a different request under the same key', async () => {
    const path = `${STU}/${studentId}/term-enrollments`;
    const payload = { cohortPeriodId, rollNumber: `RN${RUN}`, reason: 'Registered for the term' };
    expect((await call('admin', 'POST', path, { payload })).statusCode).toBe(428);
    const first = await call('admin', 'POST', path, { payload, key });
    expect(first.statusCode).toBe(201);
    enrollmentId = idOf(first);
    const replay = await call('admin', 'POST', path, { payload, key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(idOf(replay)).toBe(enrollmentId);
    expect(
      (await call('admin', 'POST', path, { payload: { ...payload, rollNumber: 'OTHER1' }, key }))
        .statusCode,
    ).toBe(422);
    // the same student in the same cohort period again, under a new key, is a conflict
    expect((await call('admin', 'POST', path, { payload, key: randomUUID() })).statusCode).toBe(
      409,
    );
    // scope and role gates
    expect((await call('hod', 'POST', path, { payload, key: randomUUID() })).statusCode).toBe(403);
    expect((await call('student', 'POST', path, { payload, key: randomUUID() })).statusCode).toBe(
      403,
    );
    expect(
      (await call('foreignAdmin', 'POST', path, { payload, key: randomUUID() })).statusCode,
    ).toBe(404);
  });

  it('reads: staff in scope and the owning student 200; other students and tenants 404; faculty 403', async () => {
    const own = `${STU}/${studentId}/term-enrollments`;
    expect((await call('admin', 'GET', own)).statusCode).toBe(200);
    expect((await call('hod', 'GET', own)).statusCode).toBe(200);
    expect((await call('faculty', 'GET', own)).statusCode).toBe(403);
    const mine = await call('student', 'GET', own);
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ data: Array<{ id: string }> }>().data.map((e) => e.id)).toEqual([
      enrollmentId,
    ]);
    expect((await call('student', 'GET', `${STU}/${studentTwo}/term-enrollments`)).statusCode).toBe(
      404,
    );
    expect((await call('foreignAdmin', 'GET', own)).statusCode).toBe(404);
    const one = await call('student', 'GET', `${own}/${enrollmentId}`);
    expect(one.statusCode).toBe(200);
    expect(one.headers.etag).toBe('"1"');
    // an enrolment addressed under a different student is "not found"
    expect(
      (await call('admin', 'GET', `${STU}/${studentTwo}/term-enrollments/${enrollmentId}`))
        .statusCode,
    ).toBe(404);
  });

  it('updates status with If-Match and a reason, places the student in a section, and lists the roster for staff only', async () => {
    const path = `${STU}/${studentId}/term-enrollments/${enrollmentId}`;
    expect(
      (await call('admin', 'PATCH', path, { payload: { status: 'ACTIVE', reason: 'Fees paid' } }))
        .statusCode,
    ).toBe(428);
    expect(
      (await call('admin', 'PATCH', path, { ifMatch: '"1"', payload: { status: 'ACTIVE' } }))
        .statusCode,
    ).toBe(400); // reason is mandatory
    expect(
      (
        await call('admin', 'PATCH', path, {
          ifMatch: '"1"',
          payload: { status: 'PROMOTED', reason: 'Too early' },
        })
      ).statusCode,
    ).toBe(409);
    const ok = await call('admin', 'PATCH', path, {
      ifMatch: '"1"',
      payload: { status: 'ACTIVE', reason: 'Fees paid' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');

    const place = (user: Actor, body: object) =>
      call(user, 'POST', `${path}/section`, { payload: body });
    const body = { sectionId, validFrom: YEAR_START, reason: 'Allocated to section A' };
    expect((await place('hod', body)).statusCode).toBe(403);
    expect((await place('foreignAdmin', body)).statusCode).toBe(404);
    const placed = await place('admin', body);
    expect(placed.statusCode).toBe(200);
    expect(
      placed.json<{ data: { currentSection: { sectionId: string } } }>().data.currentSection
        .sectionId,
    ).toBe(sectionId);
    expect((await place('admin', body)).statusCode).toBe(409);

    const roster = await call('admin', 'GET', `${ACA}/sections/${sectionId}/members`);
    expect(roster.statusCode).toBe(200);
    expect(
      roster.json<{ data: Array<{ studentId: string }> }>().data.map((m) => m.studentId),
    ).toEqual([studentId]);
    expect((await call('student', 'GET', `${ACA}/sections/${sectionId}/members`)).statusCode).toBe(
      403,
    );

    // capacity 1: a second student cannot take the seat
    const second = await call('admin', 'POST', `${STU}/${studentTwo}/term-enrollments`, {
      payload: { cohortPeriodId, reason: 'Registered for the term' },
      key: randomUUID(),
    });
    expect(second.statusCode).toBe(201);
    expect(
      (
        await call(
          'admin',
          'POST',
          `${STU}/${studentTwo}/term-enrollments/${idOf(second)}/section`,
          { payload: body },
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe('student status change with live term enrolments (M4 error contract)', () => {
  it('POST /students/:id/status answers 409 STUDENT_PROGRAM_HAS_LIVE_TERM_ENROLLMENTS and commits nothing', async () => {
    // student.status.change is CRITICAL: the session needs the real PASSWORD_MFA step-up (the helper records it as the challenge does)
    await elevateSession(sessions.admin.cookie);
    // studentTwo holds a REGISTERED term enrolment from the previous describe (created through the API)
    const read = async () =>
      (
        await adminQuery<{ version: number; status: string }>(
          `SELECT version, status FROM app.students WHERE id = $1`,
          [studentTwo],
        )
      )[0]!;
    const before = await read();
    const auditCount = async () =>
      (
        await adminQuery(
          `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND subject_student_id = $2
              AND action IN ('student.status.change', 'student_program.close')`,
          [T.orgId, studentTwo],
        )
      ).length;
    const auditsBefore = await auditCount();

    for (const status of ['GRADUATED', 'DISCONTINUED']) {
      const r = await call('admin', 'POST', `${STU}/${studentTwo}/status`, {
        ifMatch: `"${before.version}"`,
        payload: { status, reason: 'Programme finished' },
      });
      expect(r.statusCode, status).toBe(409);
      expect(r.json<{ error: { code: string } }>().error.code).toBe(
        'STUDENT_PROGRAM_HAS_LIVE_TERM_ENROLLMENTS',
      );
    }
    expect(await read()).toEqual(before);
    expect(
      await adminQuery(
        `SELECT 1 FROM app.student_programs WHERE student_id = $1 AND status = 'ACTIVE'`,
        [studentTwo],
      ),
    ).toHaveLength(1);
    expect(await auditCount()).toBe(auditsBefore);

    // the direct close endpoint uses the same code
    const [sp] = await adminQuery<{ id: string; version: number }>(
      `SELECT id, version FROM app.student_programs WHERE student_id = $1 AND status = 'ACTIVE'`,
      [studentTwo],
    );
    const close = await call('admin', 'POST', `${STU}/${studentTwo}/programs/${sp!.id}/close`, {
      ifMatch: `"${sp!.version}"`,
      payload: { outcome: 'COMPLETED', endDate: '2025-01-15', reason: 'Programme completed' },
    });
    expect(close.statusCode).toBe(409);
    expect(close.json<{ error: { code: string } }>().error.code).toBe(
      'STUDENT_PROGRAM_HAS_LIVE_TERM_ENROLLMENTS',
    );
  });
});
