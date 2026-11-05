import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import type { StudentTimelineDto } from '../../src/modules/students/student.schemas.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { activateTermFixture } from '../support/term-fixture.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Student academic timeline and as-of-date position (doc 34). One private tenant holding a school (GRADE periods),
// a year-based college programme, a semester-based college programme and a semester-based university programme on the
// SAME shared model. Every academic row is written over HTTP through the real services and guards; only accounts,
// employees/postings and student records (Milestone 1/2 rows) are inserted as the harness superuser. Dates are
// relative to today on the campus calendar (Asia/Kolkata).

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
type Who = 'admin' | 'hodA' | 'hodB' | 'faculty' | 'studentOne' | 'studentTwo' | 'foreignAdmin';
const s = {} as Record<Who, Session>;

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
  who: Session,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { session_token: who.cookie },
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': who.csrf }),
      ...headers,
    },
  });
type Res = Awaited<ReturnType<typeof call>>;
const dataOf = <X>(r: Res): X => r.json<{ data: X }>().data;
const created = (r: Res): string => {
  expect([200, 201], r.body).toContain(r.statusCode);
  return dataOf<{ id: string }>(r).id;
};
const ok = (r: Res): void => {
  expect(r.statusCode, r.body).toBe(200);
};
const key = () => ({ 'idempotency-key': randomUUID() });
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

async function timeline(who: Session, student: string, asOf?: string): Promise<StudentTimelineDto> {
  const r = await call('GET', who, `/students/${student}/timeline${asOf ? `?asOf=${asOf}` : ''}`);
  expect(r.statusCode, r.body).toBe(200);
  return dataOf<StudentTimelineDto>(r);
}
const types = (t: StudentTimelineDto) => t.events.map((e) => e.eventType);

async function insertIn(table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const rest = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = ['id', 'organization_id', ...rest.map(([k]) => k)];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [id, T.orgId, ...rest.map(([, v]) => v)],
  );
  return id;
}
async function account(name: string, role?: [string, 'DEPARTMENT', string]) {
  const user = uuidv7();
  const email = `${name}-${RUN.toLowerCase()}-${user.slice(-8)}@timeline.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [user, email, HASH],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [user, T.orgId, email, name],
  );
  if (role) {
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'DEPARTMENT', $5::uuid, NULL, $5::uuid
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [uuidv7(), T.orgId, user, role[0], role[2]],
    );
  }
  return { user, email };
}
async function studentRecord(adm: string, admissionDate: string): Promise<string> {
  const { user } = await account(`st${adm.toLowerCase()}`);
  return insertIn('students', {
    user_id: user,
    admission_number: `${adm}-${RUN}`,
    admission_date: admissionDate,
    status: 'ACTIVE',
  });
}

const X = {} as Record<string, string>;
const st = {} as Record<'s1' | 's2' | 's3' | 's4' | 's5', string>;
const enr = {} as Record<string, string>;

async function join(student: string, program: string, cohort: string, startDate: string) {
  const r = await call(
    'POST',
    s.admin,
    `/students/${student}/programs`,
    { programId: program, cohortId: cohort, startDate, reason: 'Admission to programme' },
    key(),
  );
  expect(r.statusCode, r.body).toBe(201);
  return dataOf<{ id: string }>(r).id;
}
async function enrol(student: string, cp: string, roll: string): Promise<string> {
  const id = created(
    await call(
      'POST',
      s.admin,
      `/students/${student}/term-enrollments`,
      { cohortPeriodId: cp, rollNumber: `${roll}${RUN}`, reason: 'Term registration' },
      key(),
    ),
  );
  ok(
    await call(
      'PATCH',
      s.admin,
      `/students/${student}/term-enrollments/${id}`,
      { status: 'ACTIVE', reason: 'Term started' },
      ifMatch(1),
    ),
  );
  return id;
}
async function place(
  student: string,
  e: string,
  section: string,
  validFrom: string,
  reason = 'Section allocation',
) {
  ok(
    await call('POST', s.admin, `/students/${student}/term-enrollments/${e}/section`, {
      sectionId: section,
      validFrom,
      reason,
    }),
  );
}
async function progress(
  student: string,
  e: string,
  decision: 'PROMOTE' | 'REPEAT',
  cp: string,
): Promise<string> {
  const r = await call(
    'POST',
    s.admin,
    `/students/${student}/term-enrollments/${e}/progression`,
    { decision, cohortPeriodId: cp, reason: 'Year-end decision' },
    key(),
  );
  expect([200, 201], r.body).toContain(r.statusCode);
  const rows = await adminQuery<{ id: string }>(
    `SELECT id FROM app.term_enrollments WHERE student_id = $1 AND cohort_period_id = $2`,
    [student, cp],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await app.ready();
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(HASH);
  OTHER = await createIsolatedTenant(HASH);
  s.admin = await login(T.emails.admin);
  s.hodA = await login(T.emails.hod); // HOD of T.departmentId
  s.faculty = await login(T.emails.faculty);
  s.studentOne = await login(T.emails.studentOne);
  s.studentTwo = await login(T.emails.studentTwo);
  s.foreignAdmin = await login(OTHER.emails.admin);
});

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'course_registrations',
      'faculty_assignments',
      'course_offerings',
      'section_memberships',
      'term_enrollments',
      'student_program_events',
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

describe('fixtures: school, college (annual + semester) and university on one shared model', () => {
  it('builds structure, enrolments, placements, progressions and registrations over HTTP', async () => {
    X.deptA = T.departmentId;
    X.deptB = created(
      await call('POST', s.admin, '/organization/departments', {
        campusId: T.campusId,
        name: 'Engineering',
        code: `EN${RUN}`,
      }),
    );
    s.hodB = await login((await account('hodb', ['HOD', 'DEPARTMENT', X.deptB])).email);

    const pt = async (code: string, label: string) =>
      created(
        await call('POST', s.admin, '/academics/period-types', {
          code,
          label,
          labelPlural: `${label}s`,
        }),
      );
    X.ptGrade = await pt('GRADE', 'Grade');
    X.ptYear = await pt('YEAR', 'Year');
    X.ptSem = await pt('SEMESTER', 'Semester');
    const program = async (
      dept: string,
      periodType: string,
      code: string,
      name: string,
      n: number,
      perYear: number,
    ) =>
      created(
        await call('POST', s.admin, '/academics/programs', {
          departmentId: dept,
          periodTypeId: periodType,
          name,
          code: `${code}${RUN}`,
          degreeLevel: 'UG',
          durationPeriods: n,
          periodsPerYear: perYear,
        }),
      );
    X.school = await program(X.deptA, X.ptGrade, 'SCH', 'Primary and Secondary School', 12, 1);
    X.bcom = await program(X.deptA, X.ptYear, 'BCOM', 'Bachelor of Commerce', 3, 1);
    X.bca = await program(X.deptB, X.ptSem, 'BCA', 'Bachelor of Computer Applications', 6, 2);
    X.btech = await program(X.deptB, X.ptSem, 'BTECH', 'B.Tech Computer Science', 8, 2);
    const cohort = async (p: string, year: number, name: string) =>
      created(
        await call('POST', s.admin, '/academics/cohorts', {
          programId: p,
          admissionYear: year,
          name,
        }),
      );
    X.sch2019 = await cohort(X.school, 2019, 'Batch 2019');
    X.sch2020 = await cohort(X.school, 2020, 'Batch 2020');
    X.bcom25 = await cohort(X.bcom, 2025, 'B.Com 2025');
    X.bca26 = await cohort(X.bca, 2026, 'BCA 2026');
    X.btech25 = await cohort(X.btech, 2025, 'B.Tech 2025');

    const year = async (label: string, from: number, to: number) => {
      const id = created(
        await call('POST', s.admin, '/academics/academic-years', {
          label: `${label}-${RUN}`,
          startDate: D(from),
          endDate: D(to),
        }),
      );
      ok(
        await call(
          'PATCH',
          s.admin,
          `/academics/academic-years/${id}`,
          { status: 'ACTIVE' },
          ifMatch(1),
        ),
      );
      return id;
    };
    X.ay1 = await year('AY1', -520, -136);
    X.ay2 = await year('AY2', -135, 229);
    const term = async (ay: string, code: string, from: number, to: number) => {
      const id = created(
        await call('POST', s.admin, '/academics/terms', {
          campusId: T.campusId,
          academicYearId: ay,
          code: `${code}-${RUN}`,
          name: code,
          startDate: D(from),
          endDate: D(to),
        }),
      );
      await activateTermFixture(id); // activation readiness is term-activation.test.ts's subject
      return id;
    };
    X.t1 = await term(X.ay1, 'ANNUAL1', -500, -140);
    X.t2 = await term(X.ay2, 'ANNUAL2', -130, 220);
    X.sem1 = await term(X.ay2, 'SEM-ODD', -130, 20);
    X.sem2 = await term(X.ay2, 'SEM-EVEN', 30, 220);
    const cp = async (c: string, t: string, n: number) =>
      created(
        await call('POST', s.admin, '/academics/cohort-periods', {
          cohortId: c,
          termId: t,
          periodNo: n,
        }),
      );
    X.g5 = await cp(X.sch2019, X.t1, 5);
    X.g6 = await cp(X.sch2019, X.t2, 6);
    X.g5junior = await cp(X.sch2020, X.t2, 5);
    X.y1 = await cp(X.bcom25, X.t1, 1);
    X.y2 = await cp(X.bcom25, X.t2, 2);
    X.bcaS1 = await cp(X.bca26, X.sem1, 1);
    X.bcaS2 = await cp(X.bca26, X.sem2, 2);
    X.btS3 = await cp(X.btech25, X.sem1, 3);
    const section = async (c: string, name: string) =>
      created(
        await call('POST', s.admin, '/academics/sections', {
          cohortPeriodId: c,
          name,
          capacity: 40,
        }),
      );
    X.g5A = await section(X.g5, 'A');
    X.g5B = await section(X.g5, 'B');
    X.g6A = await section(X.g6, 'A');
    X.g5jA = await section(X.g5junior, 'A');
    X.y1A = await section(X.y1, 'A');
    X.bcaS1A = await section(X.bcaS1, 'A');
    X.btS3A = await section(X.btS3, 'A');

    // s1 school pupil (can log in as studentOne): Grade 5 -> section move -> promoted to Grade 6
    st.s1 = T.students.one;
    await join(st.s1, X.school, X.sch2019, D(-520));
    enr.s1g5 = await enrol(st.s1, X.g5, 'S1G5');
    await place(st.s1, enr.s1g5, X.g5A, D(-500));
    await place(st.s1, enr.s1g5, X.g5B, D(-300), 'Moved to section B');
    enr.s1g6 = await progress(st.s1, enr.s1g5, 'PROMOTE', X.g6);
    ok(
      await call(
        'PATCH',
        s.admin,
        `/students/${st.s1}/term-enrollments/${enr.s1g6}`,
        { status: 'ACTIVE', reason: 'Term started' },
        ifMatch(1),
      ),
    );
    await place(st.s1, enr.s1g6, X.g6A, D(-130));

    // s2 school pupil (studentTwo): Grade 5 -> DETAINED -> repeats Grade 5 with the junior batch
    st.s2 = T.students.two;
    await join(st.s2, X.school, X.sch2019, D(-520));
    enr.s2g5 = await enrol(st.s2, X.g5, 'S2G5');
    await place(st.s2, enr.s2g5, X.g5A, D(-500));
    ok(
      await call(
        'PATCH',
        s.admin,
        `/students/${st.s2}/term-enrollments/${enr.s2g5}`,
        { status: 'DETAINED', reason: 'Year-end detention' },
        ifMatch(2),
      ),
    );
    enr.s2rep = await progress(st.s2, enr.s2g5, 'REPEAT', X.g5junior);
    ok(
      await call(
        'PATCH',
        s.admin,
        `/students/${st.s2}/term-enrollments/${enr.s2rep}`,
        { status: 'ACTIVE', reason: 'Term started' },
        ifMatch(1),
      ),
    );
    await place(st.s2, enr.s2rep, X.g5jA, D(-130));

    // s3 college, annual: admission, programme, Year 1 and placement all on the same day; promoted to Year 2
    st.s3 = await studentRecord('S3', D(-500));
    await join(st.s3, X.bcom, X.bcom25, D(-500));
    enr.s3y1 = await enrol(st.s3, X.y1, 'S3Y1');
    await place(st.s3, enr.s3y1, X.y1A, D(-500));
    enr.s3y2 = await progress(st.s3, enr.s3y1, 'PROMOTE', X.y2);

    // s4 college, semester (department B): Semester 1 now, promoted into a FUTURE Semester 2
    st.s4 = await studentRecord('S4', D(-130));
    await join(st.s4, X.bca, X.bca26, D(-130));
    enr.s4s1 = await enrol(st.s4, X.bcaS1, 'S4S1');
    await place(st.s4, enr.s4s1, X.bcaS1A, D(-130));
    enr.s4s2 = await progress(st.s4, enr.s4s1, 'PROMOTE', X.bcaS2);

    // s5 university, semester: a B.Com year withdrawn and programme left (department A), then B.Tech (department B)
    st.s5 = await studentRecord('S5', D(-450));
    X.s5bcom = await join(st.s5, X.bcom, X.bcom25, D(-450));
    enr.s5y1 = created(
      await call(
        'POST',
        s.admin,
        `/students/${st.s5}/term-enrollments`,
        { cohortPeriodId: X.y1, reason: 'Term registration' },
        key(),
      ),
    );
    ok(
      await call(
        'PATCH',
        s.admin,
        `/students/${st.s5}/term-enrollments/${enr.s5y1}`,
        { status: 'WITHDRAWN', reason: 'Left the programme' },
        ifMatch(1),
      ),
    );
    ok(
      await call(
        'POST',
        s.admin,
        `/students/${st.s5}/programs/${X.s5bcom}/close`,
        {
          outcome: 'TRANSFERRED_OUT',
          endDate: D(-200),
          reason: 'Transfer to engineering',
        },
        { ...key(), ...ifMatch(1) },
      ),
    );
    await join(st.s5, X.btech, X.btech25, D(-199));
    enr.s5s3 = await enrol(st.s5, X.btS3, 'S5S3');
    await place(st.s5, enr.s5s3, X.btS3A, D(-120));

    // courses, offerings, registrations
    const course = async (dept: string, c: string, title: string) =>
      created(
        await call('POST', s.admin, '/academics/courses', {
          code: `${c}${RUN}`,
          title,
          credits: 4,
          courseType: 'THEORY',
          owningDepartmentId: dept,
        }),
      );
    const publish = async (body: Record<string, unknown>) => {
      const id = created(await call('POST', s.admin, '/academics/course-offerings', body));
      ok(
        await call(
          'PATCH',
          s.admin,
          `/academics/course-offerings/${id}`,
          { status: 'PUBLISHED' },
          ifMatch(1),
        ),
      );
      return id;
    };
    X.math6 = await publish({
      termId: X.t2,
      courseId: await course(X.deptA, 'MATH6', 'Mathematics'),
      cohortPeriodId: X.g6,
      sectionId: X.g6A,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    X.dsa = await publish({
      termId: X.sem1,
      courseId: await course(X.deptB, 'CS301', 'Data Structures'),
      cohortPeriodId: X.btS3,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    const register = async (off: string, e: string, validFrom: string, pendingApproval?: boolean) =>
      created(
        await call('POST', s.admin, `/academics/course-offerings/${off}/registrations`, {
          termEnrollmentId: e,
          validFrom,
          source: 'MANUAL',
          ...(pendingApproval ? { pendingApproval } : {}),
          reason: 'Course registration',
        }),
      );
    X.reg1 = await register(X.math6, enr.s1g6, D(-120));
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/course-registrations/${X.reg1}`,
        { status: 'DROPPED', validTo: D(-60), reason: 'Dropped the course' },
        ifMatch(1),
      ),
    );
    X.reg2 = await register(X.math6, enr.s1g6, D(-50));
    X.reg5 = await register(X.dsa, enr.s5s3, D(-100), true);
    X.eng5 = await publish({
      termId: X.t2,
      courseId: await course(X.deptA, 'ENG5', 'English'),
      cohortPeriodId: X.g5junior,
      sectionId: X.g5jA,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    X.regS2 = await register(X.eng5, enr.s2rep, D(0));

    // FACULTY (org-scoped role) teaching Mathematics to s1: an ACTIVE employee posted in department A
    const emp = await insertIn('employees', {
      user_id: T.users.faculty,
      employee_code: `F${RUN}`,
      employee_type: 'FACULTY',
      joining_date: '2020-06-01',
      status: 'ACTIVE',
    });
    await insertIn('employee_postings', {
      employee_id: emp,
      department_id: X.deptA,
      valid_from: '2020-06-01',
      is_primary: true,
    });
    created(
      await call('POST', s.admin, `/academics/course-offerings/${X.math6}/faculty-assignments`, {
        employeeId: emp,
        teachingRole: 'PRIMARY',
        validFrom: D(-120),
        reason: 'Subject teacher',
      }),
    );
  });
});

describe('timeline events (derived from the authoritative rows)', () => {
  it('school: placement, section transfer, promotion (undated), course drop and re-registration', async () => {
    const t = await timeline(s.admin, st.s1);
    expect(t.asOfDate).toBe(TODAY);
    expect(t.timezone).toBe('Asia/Kolkata');
    expect(types(t)).toEqual([
      'ADMISSION',
      'PROGRAMME_STARTED',
      'TERM_ENROLLED',
      'SECTION_PLACED',
      'SECTION_TRANSFERRED',
      'TERM_ENROLLED',
      'SECTION_PLACED',
      'COURSE_REGISTERED',
      'COURSE_DROPPED',
      'COURSE_REREGISTERED',
      'STUDENT_STATUS_CHANGED',
    ]);
    const ev = t.events;
    expect(ev[0]!.eventDate).toBe('2024-07-01');
    expect(ev[4]).toMatchObject({
      eventDate: D(-300),
      section: { name: 'B' },
      periodLabel: 'Grade',
      periodNo: 5,
      temporal: 'HISTORICAL',
    });
    expect(ev[5]).toMatchObject({
      eventDate: D(-130),
      periodNo: 6,
      temporal: 'CURRENT',
      status: 'ACTIVE',
    });
    expect(ev[8]).toMatchObject({
      eventType: 'COURSE_DROPPED',
      eventDate: D(-60),
      course: { code: `MATH6${RUN}` },
    });
    expect(ev[9]).toMatchObject({ eventDate: D(-50), temporal: 'CURRENT', status: 'REGISTERED' });
    // the promotion decision is not dated: never placed on the dated timeline
    expect(t.undatedOutcomes).toEqual([
      expect.objectContaining({
        eventType: 'PROMOTED',
        eventDate: null,
        temporal: 'UNDATED',
        periodNo: 5,
        sourceId: enr.s1g5,
      }),
    ]);
    expect(t.limitations.map((l) => l.code)).toContain('TERM_OUTCOMES_UNDATED');
    expect(t.position.terms).toHaveLength(1);
    expect(t.position.terms[0]).toMatchObject({
      termEnrollmentId: enr.s1g6,
      periodNo: 6,
      periodLabel: 'Grade',
      section: { name: 'A', validTo: null },
    });
    expect(
      t.position.terms[0]!.registrations.map((r) => [r.registrationId, r.statusOnDate]),
    ).toEqual([[X.reg2, 'REGISTERED']]);
  });

  it('school: detention and repetition with the junior batch', async () => {
    const t = await timeline(s.admin, st.s2);
    expect(types(t)).toContain('REPEAT_ENROLLED');
    const rep = t.events.find((e) => e.eventType === 'REPEAT_ENROLLED')!;
    expect(rep).toMatchObject({
      periodNo: 5,
      cohortName: 'Batch 2019',
      term: { id: X.t2 },
      temporal: 'CURRENT',
    });
    // DETAINED was recorded and later closed by the repeat as COMPLETED: only the recorded outcome is shown
    expect(t.undatedOutcomes.map((e) => [e.eventType, e.sourceId])).toEqual([
      ['TERM_COMPLETED', enr.s2g5],
    ]);
    expect(t.position.terms[0]).toMatchObject({
      enrollmentType: 'REPEAT',
      periodNo: 5,
      section: { id: X.g5jA },
    });
    // same day, rank decides (not row age): the registration (created later) precedes the status change of the
    // student row (created first)
    const today = t.events.filter((e) => e.eventDate === TODAY);
    expect(today.map((e) => e.eventType)).toEqual(['COURSE_REGISTERED', 'STUDENT_STATUS_CHANGED']);
    expect(today[0]!.sourceId > today[1]!.sourceId).toBe(true);
  });

  it('college annual: Year 1 to Year 2; same-date events in lifecycle order, deterministic', async () => {
    const t = await timeline(s.admin, st.s3);
    const day = t.events.filter((e) => e.eventDate === D(-500)).map((e) => e.eventType);
    expect(day).toEqual(['ADMISSION', 'PROGRAMME_STARTED', 'TERM_ENROLLED', 'SECTION_PLACED']);
    expect(
      t.events
        .filter((e) => e.eventType === 'TERM_ENROLLED')
        .map((e) => [e.periodLabel, e.periodNo]),
    ).toEqual([
      ['Year', 1],
      ['Year', 2],
    ]);
    expect(t.position.terms).toEqual([
      expect.objectContaining({ periodNo: 2, recordedStatus: 'REGISTERED', section: null }),
    ]);
    expect(await timeline(s.admin, st.s3)).toEqual(t);
    const dates = t.events.map((e) => e.eventDate!);
    expect([...dates].sort()).toEqual(dates);
  });

  it('college semester: a promotion into a future semester is excluded and counted', async () => {
    const t = await timeline(s.admin, st.s4);
    expect(t.events.some((e) => e.term?.id === X.sem2)).toBe(false);
    expect(t.futureEventsExcluded).toBe(1);
    expect(t.position.terms).toEqual([
      expect.objectContaining({ periodLabel: 'Semester', periodNo: 1, recordedStatus: 'PROMOTED' }),
    ]);
    expect(t.undatedOutcomes.map((e) => e.eventType)).toEqual(['PROMOTED']);
  });

  it('university semester: programme transfer, withdrawn year and a pending registration', async () => {
    const t = await timeline(s.admin, st.s5);
    expect(types(t)).toEqual([
      'ADMISSION',
      'PROGRAMME_STARTED',
      'TERM_ENROLLED',
      'PROGRAMME_ENDED',
      'PROGRAMME_STARTED',
      'TERM_ENROLLED',
      'SECTION_PLACED',
      'COURSE_REGISTERED',
      'STUDENT_STATUS_CHANGED',
    ]);
    expect(t.events[3]).toMatchObject({
      eventDate: D(-200),
      status: 'TRANSFERRED_OUT',
      programme: { id: X.bcom },
    });
    expect(t.events[7]).toMatchObject({
      status: 'PENDING_APPROVAL',
      course: { code: `CS301${RUN}` },
    });
    expect(t.undatedOutcomes.map((e) => e.eventType)).toEqual(['TERM_WITHDRAWN']);
    expect(t.position.programme).toMatchObject({ id: X.btech, startDate: D(-199), endDate: null });
    expect(t.position.terms[0]!.registrations).toEqual([
      expect.objectContaining({
        statusOnDate: 'PENDING_APPROVAL',
        recordedStatus: 'PENDING_APPROVAL',
      }),
    ]);
  });
});

describe('as-of-date reconstruction (inclusive effective dates, valid time)', () => {
  it('reconstructs the school pupil on historical dates and excludes later events', async () => {
    const at = async (d: number) => timeline(s.admin, st.s1, D(d));
    const g5 = await at(-400);
    expect(g5.position.programme).toMatchObject({ id: X.school });
    expect(g5.position.terms).toHaveLength(1);
    expect(g5.position.terms[0]).toMatchObject({ periodNo: 5, section: { id: X.g5A } });
    expect(g5.events.every((e) => e.eventDate! <= D(-400))).toBe(true);
    expect(types(g5)).toEqual([
      'ADMISSION',
      'PROGRAMME_STARTED',
      'TERM_ENROLLED',
      'SECTION_PLACED',
    ]);
    expect(g5.events.map((e) => e.temporal)).toEqual([
      'HISTORICAL',
      'CURRENT',
      'CURRENT',
      'CURRENT',
    ]);
    expect(g5.futureEventsExcluded).toBe(7);
    // the student was inserted ACTIVE today: the status on an earlier date is unknown, not guessed
    expect(g5.position.studentStatus).toBeNull();
    expect(g5.limitations.map((l) => l.code)).toContain('STATUS_BEFORE_LAST_CHANGE_UNKNOWN');

    // section boundary: the old membership ends the day before the move (valid_to inclusive)
    expect((await at(-301)).position.terms[0]!.section!.id).toBe(X.g5A);
    expect((await at(-300)).position.terms[0]!.section!.id).toBe(X.g5B);
    // between the two annual terms: in the programme, in no term
    const gap = await at(-135);
    expect(gap.position.programme).not.toBeNull();
    expect(gap.position.terms).toEqual([]);
    // registration window: in effect on its last day, gone after the drop, back from the re-registration
    expect((await at(-60)).position.terms[0]!.registrations.map((r) => r.registrationId)).toEqual([
      X.reg1,
    ]);
    expect((await at(-55)).position.terms[0]!.registrations).toEqual([]);
    const re = await at(-50);
    expect(re.position.terms[0]!.registrations.map((r) => r.registrationId)).toEqual([X.reg2]);
    expect(re.limitations.map((l) => l.code)).toContain('REGISTRATION_APPROVAL_UNDATED');
    // a DROPPED row is shown as it stood on the date (registered), not as its later status
    expect((await at(-100)).position.terms[0]!.registrations[0]).toMatchObject({
      recordedStatus: 'DROPPED',
      statusOnDate: 'REGISTERED',
    });
    // today: the latest status change is known
    expect((await at(0)).position.studentStatus).toBe('ACTIVE');
  });

  it('before admission, and a closed programme on and after its last day', async () => {
    const before = await timeline(s.admin, st.s5, D(-451));
    expect(before.events).toEqual([]);
    expect(before.position).toMatchObject({
      admitted: false,
      studentStatus: null,
      programme: null,
      terms: [],
    });
    expect(before.limitations.map((l) => l.code)).toContain('BEFORE_ADMISSION');
    expect((await timeline(s.admin, st.s5, D(-200))).position.programme).toMatchObject({
      id: X.bcom,
    });
    expect((await timeline(s.admin, st.s5, D(-199))).position.programme).toMatchObject({
      id: X.btech,
    });
  });

  it('refuses a future, malformed or impossible asOf', async () => {
    for (const q of [D(1), '2026-02-30', 'yesterday']) {
      const r = await call('GET', s.admin, `/students/${st.s1}/timeline?asOf=${q}`);
      expect(r.statusCode, q).toBe(400);
    }
  });
});

describe('authorization and tenant isolation', () => {
  it('student self-access only', async () => {
    const own = await timeline(s.studentOne, st.s1);
    expect(types(own)).toContain('COURSE_REREGISTERED');
    expect((await call('GET', s.studentOne, `/students/${st.s2}/timeline`)).statusCode).toBe(404);
    expect((await call('GET', s.studentTwo, `/students/${st.s1}/timeline`)).statusCode).toBe(404);
  });

  it('HOD: own department students only, and never another department history row', async () => {
    expect(types(await timeline(s.hodA, st.s1))).toContain('SECTION_TRANSFERRED');
    for (const other of [st.s4, st.s5]) {
      expect((await call('GET', s.hodA, `/students/${other}/timeline`)).statusCode).toBe(404);
    }
    expect((await call('GET', s.hodB, `/students/${st.s1}/timeline`)).statusCode).toBe(404);
    // s5 is now in department B: HOD B sees the B.Tech rows, not the department A B.Com history
    const t = await timeline(s.hodB, st.s5);
    expect(t.events.some((e) => e.programme?.id === X.bcom)).toBe(false);
    expect(t.undatedOutcomes).toEqual([]);
    expect(types(t)).toEqual([
      'ADMISSION',
      'PROGRAMME_STARTED',
      'TERM_ENROLLED',
      'SECTION_PLACED',
      'COURSE_REGISTERED',
      'STUDENT_STATUS_CHANGED',
    ]);
    // as of a date inside the hidden B.Com period nothing of it leaks
    const past = await timeline(s.hodB, st.s5, D(-300));
    expect(past.position.programme).toBeNull();
    expect(types(past)).toEqual(['ADMISSION']);
  });

  it('FACULTY ASSIGNED: the taught student only, profile-level events only', async () => {
    const t = await timeline(s.faculty, st.s1);
    // FACULTY holds no enrollment.term.read: no programme, enrolment, section or course rows
    expect(types(t)).toEqual(['ADMISSION', 'STUDENT_STATUS_CHANGED']);
    expect(t.position.programme).toBeNull();
    for (const other of [st.s2, st.s3, st.s5]) {
      expect((await call('GET', s.faculty, `/students/${other}/timeline`)).statusCode).toBe(404);
    }
  });

  it('other tenant, missing and malformed ids', async () => {
    expect((await call('GET', s.foreignAdmin, `/students/${st.s1}/timeline`)).statusCode).toBe(404);
    expect(
      (await call('GET', s.admin, `/students/${OTHER.students.one}/timeline`)).statusCode,
    ).toBe(404);
    expect((await call('GET', s.admin, `/students/${uuidv7()}/timeline`)).statusCode).toBe(404);
    expect((await call('GET', s.admin, '/students/not-an-id/timeline')).statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: `/api/v1/students/${st.s1}/timeline` });
    expect(anon.statusCode).toBe(401);
  });

  it('is read-only: no write, no audit row', async () => {
    const before = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.audit_events WHERE organization_id = $1`,
      [T.orgId],
    );
    await timeline(s.admin, st.s1, D(-100));
    const after = await adminQuery<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.audit_events WHERE organization_id = $1`,
      [T.orgId],
    );
    expect(after).toEqual(before);
  });
});
