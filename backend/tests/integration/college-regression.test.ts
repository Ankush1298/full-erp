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
import { activateTermFixture } from '../support/term-fixture.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// College regression (unified-platform rule: a school pilot must not regress college/university capability).
// An affiliated, single-campus college in one private tenant: a YEAR-based programme (B.Com, 3 years, one period per
// year) and a SEMESTER-based programme (BCA, 6 semesters) on the SAME campus and the SAME shared period model
// (period_types + programs.period_type_id + period_no), with overlapping annual and semester terms. Everything
// academic is created over HTTP; only accounts, employees/postings and student records (Milestone 1/2 rows) are
// inserted as the harness superuser. Affiliation is represented the only way the model supports today: the affiliating
// university's PRN as a UNIVERSITY_PRN student identifier. Dates are relative to today on the campus calendar
// (Asia/Kolkata) because registration windows and the X-12 resolver read the database clock.

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
type Who =
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'deptAdmin'
  | 'faculty'
  | 'faculty2'
  | 'studentOne'
  | 'foreignAdmin';
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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
const ok = (r: Res, status = 200): void => {
  expect(r.statusCode, r.body).toBe(status);
};
const key = () => ({ 'idempotency-key': randomUUID() });
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

async function insertIn(org: string, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const rest = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = ['id', 'organization_id', ...rest.map(([k]) => k)];
  await adminQuery(
    `INSERT INTO ${table.includes('.') ? table : `app.${table}`} (${cols.join(', ')}) VALUES (${cols
      .map((_, i) => `$${i + 1}`)
      .join(', ')})`,
    [id, org, ...rest.map(([, v]) => v)],
  );
  return id;
}

/** A login-able account of the college (optionally with a role assignment). */
async function account(name: string, role?: [string, 'ORGANIZATION' | 'DEPARTMENT', string?]) {
  const user = uuidv7();
  const email = `${name.toLowerCase()}-${RUN.toLowerCase()}-${user.slice(-8)}@college.test`;
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
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
              NULL, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [uuidv7(), T.orgId, user, role[0], role[1], role[2] ?? null],
    );
  }
  return { user, email };
}
async function employeeFor(user: string, dept: string, code: string): Promise<string> {
  const employee = await insertIn(T.orgId, 'employees', {
    user_id: user,
    employee_code: `${code}${RUN}`,
    employee_type: 'FACULTY',
    joining_date: '2020-06-01',
    status: 'ACTIVE',
  });
  await insertIn(T.orgId, 'employee_postings', {
    employee_id: employee,
    department_id: dept,
    valid_from: '2020-06-01',
    is_primary: true,
  });
  return employee;
}
async function studentRecord(adm: string, user?: string): Promise<string> {
  const u = user ?? (await account(`st${adm}`)).user;
  return insertIn(T.orgId, 'students', {
    user_id: u,
    admission_number: `${adm}-${RUN}`,
    admission_date: '2025-07-01',
    status: 'ACTIVE',
  });
}

// ---- ids shared across the ordered scenarios
const X = {} as Record<
  | 'acc'
  | 'annual'
  | 'annual2'
  | 'bca'
  | 'bca25'
  | 'bcaS3'
  | 'bcaS4'
  | 'bcom'
  | 'bcom25'
  | 'bcom26'
  | 'bcom26Y2'
  | 'bcomY2'
  | 'bcomY3'
  | 'ca'
  | 'cloud'
  | 'commerce'
  | 'dbms'
  | 'emp1'
  | 'emp2'
  | 'even'
  | 'faAcc'
  | 'faDbmsByF1'
  | 'grp'
  | 'ml'
  | 'odd'
  | 'offAcc'
  | 'offCloud'
  | 'offDbms'
  | 'offMl'
  | 'ptSem'
  | 'ptYear'
  | 'secBA'
  | 'secBB'
  | 'secCA'
  | 'y1'
  | 'y2',
  string
>;
const students = {} as Record<'b1' | 'b2' | 'b3' | 'c1' | 'c2' | 'c3', string>;
const enr = {} as Record<keyof typeof students, string>;

async function snapshotAcademic(org: string): Promise<string> {
  const tables = [
    'period_types',
    'programs',
    'cohorts',
    'academic_years',
    'terms',
    'cohort_periods',
    'sections',
    'section_memberships',
    'term_enrollments',
    'course_offerings',
    'elective_groups',
    'course_registrations',
  ];
  const rows = await adminQuery(
    `SELECT k, j FROM (${tables
      .map(
        (t) => `SELECT '${t}' AS k, to_jsonb(x) AS j FROM app.${t} x WHERE x.organization_id = $1`,
      )
      .join(' UNION ALL ')}) s ORDER BY k, j::text`,
    [org],
  );
  return JSON.stringify(rows);
}

beforeAll(async () => {
  await app.ready();
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(HASH);
  OTHER = await createIsolatedTenant(HASH);
  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.hod = await login(T.emails.hod); // HOD of T.departmentId (Commerce)
  s.faculty = await login(T.emails.faculty);
  s.studentOne = await login(T.emails.studentOne);
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
    for (const org of [T.orgId, OTHER.orgId]) {
      for (const t of [
        'course_registrations',
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

describe('college: institution configuration and campus scope', () => {
  it('one campus, two departments created over HTTP, campus admin scoped to it', async () => {
    X.commerce = T.departmentId;
    X.ca = created(
      await call('POST', s.admin, '/organization/departments', {
        campusId: T.campusId,
        name: 'Computer Applications',
        code: `CA${RUN}`.slice(0, 20),
      }),
    );
    const campuses = await call('GET', s.admin, '/organization/campuses');
    ok(campuses);
    expect(dataOf<Array<{ id: string }>>(campuses).map((c) => c.id)).toEqual([T.campusId]);
    const depts = await call('GET', s.campusAdmin, '/organization/departments');
    ok(depts);
    expect(
      dataOf<Array<{ id: string }>>(depts)
        .map((d) => d.id)
        .sort(),
    ).toEqual([X.commerce, X.ca].sort());

    // department-scoped roles of the new department, and faculty with postings in each department
    const da = await account('deptadmin', ['DEPARTMENT_ADMIN', 'DEPARTMENT', X.ca]);
    s.deptAdmin = await login(da.email);
    X.emp1 = await employeeFor(T.users.faculty, X.commerce, 'F1');
    const f2 = await account('faculty2', ['FACULTY', 'ORGANIZATION']);
    X.emp2 = await employeeFor(f2.user, X.ca, 'F2');
    s.faculty2 = await login(f2.email);
  });
});

describe('college: departments, programmes, batches and academic years (shared period model)', () => {
  it('a YEAR-based and a SEMESTER-based programme share period_types / period_no', async () => {
    X.ptYear = created(
      await call('POST', s.admin, '/academics/period-types', {
        code: 'YEAR',
        label: 'Year',
        labelPlural: 'Years',
      }),
    );
    X.ptSem = created(
      await call('POST', s.admin, '/academics/period-types', {
        code: 'SEMESTER',
        label: 'Semester',
        labelPlural: 'Semesters',
      }),
    );
    X.bcom = created(
      await call('POST', s.admin, '/academics/programs', {
        departmentId: X.commerce,
        periodTypeId: X.ptYear,
        name: 'Bachelor of Commerce',
        code: `BCOM${RUN}`,
        degreeLevel: 'UG',
        durationPeriods: 3,
        periodsPerYear: 1,
      }),
    );
    X.bca = created(
      await call('POST', s.admin, '/academics/programs', {
        departmentId: X.ca,
        periodTypeId: X.ptSem,
        name: 'Bachelor of Computer Applications',
        code: `BCA${RUN}`,
        degreeLevel: 'UG',
        durationPeriods: 6,
        periodsPerYear: 2,
      }),
    );
    const cohort = async (program: string, year: number, name: string) =>
      created(
        await call('POST', s.admin, '/academics/cohorts', {
          programId: program,
          admissionYear: year,
          name,
        }),
      );
    X.bcom25 = await cohort(X.bcom, 2025, 'B.Com 2025');
    X.bcom26 = await cohort(X.bcom, 2026, 'B.Com 2026');
    X.bca25 = await cohort(X.bca, 2025, 'BCA 2025');

    X.y1 = created(
      await call('POST', s.admin, '/academics/academic-years', {
        label: `AY1-${RUN}`,
        startDate: D(-150),
        endDate: D(214),
      }),
    );
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/academic-years/${X.y1}`,
        { status: 'ACTIVE' },
        ifMatch(1),
      ),
    );
    X.y2 = created(
      await call('POST', s.admin, '/academics/academic-years', {
        label: `AY2-${RUN}`,
        startDate: D(215),
        endDate: D(579),
      }),
    );
    const overlap = await call('POST', s.admin, '/academics/academic-years', {
      label: `AYX-${RUN}`,
      startDate: D(200),
      endDate: D(400),
    });
    expect(overlap.statusCode).toBe(409);

    const rows = await adminQuery<{
      code: string;
      label: string;
      duration_periods: number;
      periods_per_year: number;
    }>(
      `SELECT pt.code, pt.label, p.duration_periods, p.periods_per_year
         FROM app.programs p JOIN app.period_types pt ON pt.organization_id = p.organization_id AND pt.id = p.period_type_id
        WHERE p.id = ANY($1::uuid[]) ORDER BY pt.code DESC`,
      [[X.bcom, X.bca]],
    );
    expect(rows).toEqual([
      { code: 'YEAR', label: 'Year', duration_periods: 3, periods_per_year: 1 },
      { code: 'SEMESTER', label: 'Semester', duration_periods: 6, periods_per_year: 2 },
    ]);
  });

  it('a department-scoped admin manages programmes of its own department only', async () => {
    const own = await call('POST', s.deptAdmin, '/academics/cohorts', {
      programId: X.bca,
      admissionYear: 2027,
      name: 'BCA 2027',
    });
    expect(own.statusCode, own.body).toBe(201);
    const foreign = await call('POST', s.deptAdmin, '/academics/cohorts', {
      programId: X.bcom,
      admissionYear: 2027,
      name: 'B.Com 2027',
    });
    expect([403, 404]).toContain(foreign.statusCode);
  });
});

describe('college: terms, cohort periods, sections and memberships', () => {
  it('annual and semester terms overlap on the one campus; periods respect each duration', async () => {
    const term = async (year: string, code: string, from: number, to: number, active: boolean) => {
      const id = created(
        await call('POST', s.admin, '/academics/terms', {
          campusId: T.campusId,
          academicYearId: year,
          code: `${code}-${RUN}`,
          name: code,
          startDate: D(from),
          endDate: D(to),
        }),
      );
      // activation readiness (Task 9) is term-activation.test.ts's subject, college terms included
      if (active) await activateTermFixture(id);
      return id;
    };
    X.annual = await term(X.y1, 'ANNUAL', -140, 180, true);
    X.odd = await term(X.y1, 'ODD', -120, 40, true);
    X.even = await term(X.y1, 'EVEN', 45, 200, false);
    X.annual2 = await term(X.y2, 'ANNUAL2', 225, 560, false);

    const cp = async (cohort: string, termId: string, periodNo: number) =>
      call('POST', s.admin, '/academics/cohort-periods', { cohortId: cohort, termId, periodNo });
    X.bcomY2 = created(await cp(X.bcom25, X.annual, 2));
    X.bcomY3 = created(await cp(X.bcom25, X.annual2, 3));
    X.bcom26Y2 = created(await cp(X.bcom26, X.annual2, 2));
    X.bcaS3 = created(await cp(X.bca25, X.odd, 3));
    X.bcaS4 = created(await cp(X.bca25, X.even, 4));
    // beyond each programme's own duration: Year 4 of a 3-year programme, Semester 7 of a 6-semester one
    expect((await cp(X.bcom25, X.annual2, 4)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await cp(X.bca25, X.annual2, 7)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('students join their programme, enrol per period and are placed; a move keeps history', async () => {
    students.c1 = T.students.one; // studentOne: a BCA student who can log in
    students.b1 = await studentRecord('B1');
    students.b2 = await studentRecord('B2');
    students.b3 = await studentRecord('B3');
    students.c2 = await studentRecord('C2');
    students.c3 = await studentRecord('C3');
    const join = async (st: string, program: string, cohort: string) =>
      expect(
        (
          await call(
            'POST',
            s.admin,
            `/students/${st}/programs`,
            {
              programId: program,
              cohortId: cohort,
              startDate: '2025-07-01',
              reason: 'College admission',
            },
            key(),
          )
        ).statusCode,
      ).toBe(201);
    for (const b of ['b1', 'b2', 'b3'] as const) await join(students[b], X.bcom, X.bcom25);
    for (const c of ['c1', 'c2', 'c3'] as const) await join(students[c], X.bca, X.bca25);

    X.secBA = created(
      await call('POST', s.admin, '/academics/sections', {
        cohortPeriodId: X.bcomY2,
        name: 'A',
        capacity: 60,
      }),
    );
    X.secBB = created(
      await call('POST', s.admin, '/academics/sections', {
        cohortPeriodId: X.bcomY2,
        name: 'B',
        capacity: 60,
      }),
    );
    X.secCA = created(
      await call('POST', s.admin, '/academics/sections', {
        cohortPeriodId: X.bcaS3,
        name: 'A',
        capacity: 60,
      }),
    );

    const enrol = async (who: keyof typeof students, cp: string, section: string, from: string) => {
      const r = await call(
        'POST',
        s.admin,
        `/students/${students[who]}/term-enrollments`,
        {
          cohortPeriodId: cp,
          rollNumber: `${who.toUpperCase()}${RUN}`,
          reason: 'Term registration',
        },
        key(),
      );
      enr[who] = created(r);
      ok(
        await call(
          'PATCH',
          s.admin,
          `/students/${students[who]}/term-enrollments/${enr[who]}`,
          { status: 'ACTIVE', reason: 'Term started' },
          ifMatch(1),
        ),
      );
      ok(
        await call(
          'POST',
          s.admin,
          `/students/${students[who]}/term-enrollments/${enr[who]}/section`,
          { sectionId: section, validFrom: from, reason: 'Section allocation' },
        ),
      );
    };
    for (const b of ['b1', 'b2', 'b3'] as const) await enrol(b, X.bcomY2, X.secBA, D(-140));
    for (const c of ['c1', 'c2', 'c3'] as const) await enrol(c, X.bcaS3, X.secCA, D(-120));

    // a year-based student cannot be placed in a semester programme's section
    const wrong = await call(
      'POST',
      s.admin,
      `/students/${students.b1}/term-enrollments/${enr.b1}/section`,
      { sectionId: X.secCA, validFrom: D(0), reason: 'Wrong section' },
    );
    expect(wrong.statusCode).toBeGreaterThanOrEqual(400);
    ok(
      await call('POST', s.admin, `/students/${students.b2}/term-enrollments/${enr.b2}/section`, {
        sectionId: X.secBB,
        validFrom: D(-5),
        reason: 'Moved to division B',
      }),
    );
    const hist = await adminQuery<{ section_id: string; valid_to: string | null }>(
      `SELECT section_id, valid_to::text FROM app.section_memberships WHERE term_enrollment_id = $1 ORDER BY valid_from`,
      [enr.b2],
    );
    expect(hist).toEqual([
      { section_id: X.secBA, valid_to: D(-6) },
      { section_id: X.secBB, valid_to: null },
    ]);
    const periods = await adminQuery<{ period_no: number }>(
      `SELECT DISTINCT period_no FROM app.term_enrollments WHERE id = ANY($1::uuid[]) ORDER BY 1`,
      [Object.values(enr)],
    );
    expect(periods.map((p) => p.period_no)).toEqual([2, 3]); // Year 2 and Semester 3, one column
  });

  it('records the affiliating university PRN as a student identifier (unique per tenant)', async () => {
    const add = (st: string) =>
      call(
        'POST',
        s.admin,
        `/students/${st}/identifiers`,
        { idType: 'UNIVERSITY_PRN', value: `PRN${RUN}001`, issuer: 'Affiliating State University' },
        key(),
      );
    expect((await add(students.b1)).statusCode).toBe(201);
    expect((await add(students.b2)).statusCode).toBe(409);
  });
});

describe('college: permissions within the institution', () => {
  it('department, campus, faculty and student scopes', async () => {
    // HOD of Commerce: reads B.Com enrolments, not BCA; cannot manage sections
    ok(await call('GET', s.hod, `/students/${students.b1}/term-enrollments`));
    expect((await call('GET', s.hod, `/students/${students.c2}/term-enrollments`)).statusCode).toBe(
      404,
    );
    expect((await call('GET', s.hod, `/students/${students.c2}`)).statusCode).toBe(404);
    expect(
      (await call('POST', s.hod, '/academics/sections', { cohortPeriodId: X.bcomY2, name: 'C' }))
        .statusCode,
    ).toBe(403);
    // DEPARTMENT_ADMIN of Computer Applications: own programme's sections only
    expect(
      (
        await call('POST', s.deptAdmin, '/academics/sections', {
          cohortPeriodId: X.bcaS3,
          name: 'B',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', s.deptAdmin, '/academics/sections', {
          cohortPeriodId: X.bcomY2,
          name: 'D',
        })
      ).statusCode,
    ).toBe(404);
    // campus admin of the single campus: both departments
    ok(await call('GET', s.campusAdmin, `/students/${students.b1}/term-enrollments`));
    ok(await call('GET', s.campusAdmin, `/students/${students.c2}/term-enrollments`));
    // faculty: no structure writes
    expect(
      (
        await call('POST', s.faculty, '/academics/sections', {
          cohortPeriodId: X.bcomY2,
          name: 'E',
        })
      ).statusCode,
    ).toBe(403);
    // student: own enrolments only
    ok(await call('GET', s.studentOne, `/students/${students.c1}/term-enrollments`));
    expect(
      (await call('GET', s.studentOne, `/students/${students.c2}/term-enrollments`)).statusCode,
    ).toBe(404);
  });
});

describe('college: course offerings, faculty assignments and timetable', () => {
  it('year-based and semester-based offerings share the offering, assignment and conflict rules', async () => {
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
    X.acc = await course(X.commerce, 'COM2', 'Corporate Accounting');
    X.dbms = await course(X.ca, 'CA31', 'Database Systems');
    X.ml = await course(X.ca, 'CA35', 'Machine Learning');
    X.cloud = await course(X.ca, 'CA36', 'Cloud Computing');
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
    X.offAcc = await publish({
      termId: X.annual,
      courseId: X.acc,
      cohortPeriodId: X.bcomY2,
      sectionId: X.secBA,
      offeringKind: 'CORE',
      registrationPolicy: 'AUTO_FROM_SECTION',
    });
    X.offDbms = await publish({
      termId: X.odd,
      courseId: X.dbms,
      cohortPeriodId: X.bcaS3,
      sectionId: X.secCA,
      offeringKind: 'CORE',
      registrationPolicy: 'AUTO_FROM_SECTION',
    });
    const offered = dataOf<{ codeSnapshot: string; creditsSnapshot: string; termId: string }>(
      await call('GET', s.admin, `/academics/course-offerings/${X.offAcc}`),
    );
    expect(offered.codeSnapshot).toBe(`COM2${RUN}`);

    const assign = async (off: string, emp: string) =>
      created(
        await call('POST', s.admin, `/academics/course-offerings/${off}/faculty-assignments`, {
          employeeId: emp,
          teachingRole: 'PRIMARY',
          validFrom: D(-100),
          reason: 'Subject teacher',
        }),
      );
    X.faAcc = await assign(X.offAcc, X.emp1);
    X.faDbmsByF1 = await assign(X.offDbms, X.emp1); // the same teacher teaches in both programmes
    const room = await insertIn(T.orgId, 'rooms', {
      campus_id: T.campusId,
      code: `R${RUN}`,
      kind: 'CLASSROOM',
    });
    const slot = (off: string, body: Record<string, unknown>) =>
      call('POST', s.admin, `/academics/course-offerings/${off}/timetable-slots`, {
        weekday: 3,
        startTime: '10:00',
        endTime: '11:00',
        effectiveFrom: D(-90),
        ...body,
      });
    expect((await slot(X.offAcc, { roomId: room, facultyAssignmentId: X.faAcc })).statusCode).toBe(
      201,
    );
    // room clash across a year-based and a semester-based offering
    expect((await slot(X.offDbms, { roomId: room })).statusCode).toBe(409);
    // teacher clash across the two programmes
    expect((await slot(X.offDbms, { facultyAssignmentId: X.faDbmsByF1 })).statusCode).toBe(409);
    expect(
      (
        await slot(X.offDbms, {
          startTime: '11:00',
          endTime: '12:00',
          roomId: room,
          facultyAssignmentId: X.faDbmsByF1,
        })
      ).statusCode,
    ).toBe(201);

    // AUTO_FROM_SECTION registers each programme's own section roster
    const fs = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${X.offAcc}/registrations/from-section`,
      { validFrom: D(0), reason: 'Section roster' },
    );
    expect(dataOf<{ created: number }>(fs).created).toBe(2); // b1, b3 (b2 moved to division B)
    const fs2 = await call(
      'POST',
      s.admin,
      `/academics/course-offerings/${X.offDbms}/registrations/from-section`,
      { validFrom: D(0), reason: 'Section roster' },
    );
    expect(dataOf<{ created: number }>(fs2).created).toBe(3);
    // faculty cannot assign
    expect(
      (
        await call(
          'POST',
          s.faculty,
          `/academics/course-offerings/${X.offAcc}/faculty-assignments`,
          {
            employeeId: X.emp2,
            teachingRole: 'CO_INSTRUCTOR',
            validFrom: D(0),
            reason: 'Self assign',
          },
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('college: elective groups and course registrations', () => {
  it('semester elective basket: window, max, capacity, approval, drop and history', async () => {
    X.grp = created(
      await call('POST', s.admin, `/academics/cohort-periods/${X.bcaS3}/elective-groups`, {
        code: `PE${RUN}`,
        name: 'Discipline elective',
        minSelect: 1,
        maxSelect: 1,
        opensAt: new Date(Date.now() - 3_600_000).toISOString(),
        closesAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reason: 'Semester 3 elective basket',
      }),
    );
    const elective = async (course: string, capacity: number) => {
      const id = created(
        await call('POST', s.admin, '/academics/course-offerings', {
          termId: X.odd,
          courseId: course,
          cohortPeriodId: X.bcaS3,
          offeringKind: 'ELECTIVE',
          registrationPolicy: 'ELECTIVE_CHOICE',
          capacity,
          electiveGroupId: X.grp,
        }),
      );
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
    X.offMl = await elective(X.ml, 2);
    X.offCloud = await elective(X.cloud, 40);
    const choose = (who: keyof typeof students, off: string, extra: Record<string, unknown> = {}) =>
      call('POST', s.admin, `/academics/course-offerings/${off}/registrations`, {
        termEnrollmentId: enr[who],
        validFrom: D(0),
        source: 'ELECTIVE_CHOICE',
        reason: 'Elective form',
        ...extra,
      });
    expect((await choose('c2', X.offMl)).statusCode).toBe(409); // group still PLANNED
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/elective-groups/${X.grp}`,
        { status: 'OPEN', reason: 'Window opens' },
        ifMatch(1),
      ),
    );
    const c2 = await choose('c2', X.offMl);
    expect(c2.statusCode, c2.body).toBe(201);
    expect((await choose('c2', X.offCloud)).statusCode).toBe(409); // max_select 1
    const c3 = await choose('c3', X.offMl, { pendingApproval: true });
    expect(c3.statusCode).toBe(201);
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/course-registrations/${created(c3)}`,
        { status: 'REGISTERED', reason: 'Approved by advisor' },
        ifMatch(1),
      ),
    );
    expect((await choose('c1', X.offMl)).statusCode).toBe(409); // capacity 2 reached
    const c1 = await choose('c1', X.offCloud);
    expect(c1.statusCode).toBe(201);
    // a year-based (B.Com) enrolment is outside this semester basket's audience
    expect((await choose('b1', X.offCloud)).statusCode).toBeGreaterThanOrEqual(400);
    // drop and re-choose, history kept
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/course-registrations/${created(c1)}`,
        { status: 'DROPPED', validTo: D(0), reason: 'Changed elective' },
        ifMatch(1),
      ),
    );
    const again = await choose('c1', X.offCloud);
    expect(again.statusCode).toBe(201);
    const hist = dataOf<Array<{ status: string }>>(
      await call('GET', s.admin, `/academics/term-enrollments/${enr.c1}/course-registrations`),
    );
    expect(hist.map((r) => r.status).sort()).toEqual(['DROPPED', 'REGISTERED', 'REGISTERED']); // + DBMS from-section
    // the student reads their own registrations
    ok(
      await call('GET', s.studentOne, `/academics/term-enrollments/${enr.c1}/course-registrations`),
    );
    expect(
      (
        await call(
          'GET',
          s.studentOne,
          `/academics/term-enrollments/${enr.c2}/course-registrations`,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('X-12: a teacher reads only students registered on an offering they teach', async () => {
    created(
      await call('POST', s.admin, `/academics/course-offerings/${X.offMl}/faculty-assignments`, {
        employeeId: X.emp2,
        teachingRole: 'PRIMARY',
        validFrom: D(-10),
        reason: 'Elective teacher',
      }),
    );
    ok(await call('GET', s.faculty2, `/students/${students.c2}`)); // registered on ML
    expect((await call('GET', s.faculty2, `/students/${students.c1}`)).statusCode).toBe(404); // Cloud, not ML
    expect((await call('GET', s.faculty2, `/students/${students.b1}`)).statusCode).toBe(404); // B.Com
    ok(await call('GET', s.faculty, `/students/${students.b1}`)); // Accounting teacher, registered
  });
});

describe('college: promotion and repetition', () => {
  it('year-based: a detained student repeats Year 2 with the next batch; the rest are promoted to Year 3', async () => {
    ok(
      await call(
        'PATCH',
        s.admin,
        `/students/${students.b3}/term-enrollments/${enr.b3}`,
        { status: 'DETAINED', reason: 'Attendance shortfall' },
        ifMatch(2),
      ),
    );
    const rep = await call(
      'POST',
      s.admin,
      `/students/${students.b3}/term-enrollments/${enr.b3}/progression`,
      {
        decision: 'REPEAT',
        cohortPeriodId: X.bcom26Y2,
        reason: 'Repeats Year 2 with the 2026 batch',
      },
      key(),
    );
    expect(rep.statusCode, rep.body).toBe(201);
    const dry = dataOf<{ eligible: unknown[]; excluded: unknown[] }>(
      await call('POST', s.admin, `/academics/cohort-periods/${X.bcomY2}/promotion`, {
        targetCohortPeriodId: X.bcomY3,
        reason: 'Annual promotion',
        dryRun: true,
      }),
    );
    expect(dry.eligible).toHaveLength(2);
    const k = key();
    const body = { targetCohortPeriodId: X.bcomY3, reason: 'Annual promotion' };
    const run = await call(
      'POST',
      s.admin,
      `/academics/cohort-periods/${X.bcomY2}/promotion`,
      body,
      k,
    );
    expect(run.statusCode, run.body).toBe(201);
    expect(dataOf<{ promoted: number }>(run).promoted).toBe(2);
    const replay = await call(
      'POST',
      s.admin,
      `/academics/cohort-periods/${X.bcomY2}/promotion`,
      body,
      k,
    );
    expect(replay.body).toBe(run.body);
    const rows = await adminQuery<{ cp: string; status: string; type: string; n: number }>(
      `SELECT cohort_period_id AS cp, status, enrollment_type AS type, count(*)::int AS n FROM app.term_enrollments
        WHERE student_id = ANY($1::uuid[]) GROUP BY 1, 2, 3 ORDER BY 1, 2`,
      [[students.b1, students.b2, students.b3]],
    );
    const by = (cp: string) => rows.filter((r) => r.cp === cp).map((r) => [r.status, r.type, r.n]);
    expect(by(X.bcomY2)).toEqual([
      ['COMPLETED', 'REGULAR', 1],
      ['PROMOTED', 'REGULAR', 2],
    ]); // kept, not mutated away
    expect(by(X.bcomY3)).toEqual([['REGISTERED', 'REGULAR', 2]]);
    expect(by(X.bcom26Y2)).toEqual([['REGISTERED', 'REPEAT', 1]]);
  });

  it('semester-based: Semester 3 -> Semester 4 per student and by the promotion tool', async () => {
    const one = await call(
      'POST',
      s.admin,
      `/students/${students.c2}/term-enrollments/${enr.c2}/progression`,
      { decision: 'PROMOTE', cohortPeriodId: X.bcaS4, reason: 'Semester result declared' },
      key(),
    );
    expect(one.statusCode, one.body).toBe(201);
    const run = await call(
      'POST',
      s.admin,
      `/academics/cohort-periods/${X.bcaS3}/promotion`,
      { targetCohortPeriodId: X.bcaS4, reason: 'Semester promotion' },
      key(),
    );
    expect(run.statusCode, run.body).toBe(201);
    expect(dataOf<{ promoted: number }>(run).promoted).toBe(2);
    const s4 = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.term_enrollments WHERE cohort_period_id = $1 AND period_no = 4`,
      [X.bcaS4],
    );
    expect(s4[0]!.n).toBe(3);
    // registrations are not cascaded by promotion (doc 33 §8 item 3)
    const live = await adminQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.course_registrations WHERE term_enrollment_id = $1 AND valid_to IS NULL`,
      [enr.c2],
    );
    expect(live[0]!.n).toBe(2);
  });
});

describe('cross-institution: terminology is presentation only', () => {
  it('college labels change no academic row and stay in this tenant; period types keep Year and Semester', async () => {
    const before = await snapshotAcademic(T.orgId);
    const otherBefore = await snapshotAcademic(OTHER.orgId);
    await elevateSession(s.admin.cookie);
    const put = await call(
      'PUT',
      s.admin,
      '/organization/settings/terminology',
      {
        value: { program: 'Course', cohort: 'Batch', section: 'Division', course: 'Paper' },
        reason: 'College vocabulary',
      },
      { 'if-match': '"0"' },
    );
    expect(put.statusCode, put.body).toBe(200);
    const labels = dataOf<{ labels: Record<string, string>; customised: string[] }>(
      await call('GET', s.studentOne, '/academics/terminology'),
    );
    expect(labels.labels).toMatchObject({
      program: 'Course',
      section: 'Division',
      course: 'Paper',
      period: 'Semester',
    });
    expect(await snapshotAcademic(T.orgId)).toBe(before);
    expect(await snapshotAcademic(OTHER.orgId)).toBe(otherBefore);
    expect(
      dataOf<{ customised: string[] }>(await call('GET', s.foreignAdmin, '/academics/terminology'))
        .customised,
    ).toEqual([]);
    const pts = await adminQuery<{ label: string }>(
      `SELECT label FROM app.period_types WHERE organization_id = $1 ORDER BY label`,
      [T.orgId],
    );
    expect(pts.map((p) => p.label)).toEqual(['Semester', 'Year']);
  });
});

describe('cross-institution: tenant isolation', () => {
  it('another tenant can neither read nor change any college row, and the college none of theirs', async () => {
    const otherBefore = await snapshotAcademic(OTHER.orgId);
    for (const path of [
      `/students/${students.b1}`,
      `/students/${students.b1}/term-enrollments`,
      `/students/${students.b1}/identifiers`,
      `/academics/programs/${X.bcom}`,
      `/academics/terms/${X.annual}`,
      `/academics/sections/${X.secBA}`,
      `/academics/sections/${X.secBA}/members`,
      `/academics/course-offerings/${X.offAcc}`,
      `/academics/course-offerings/${X.offMl}/registrations`,
      `/academics/cohort-periods/${X.bcaS3}/elective-groups`,
      `/academics/term-enrollments/${enr.c1}/course-registrations`,
    ]) {
      const r = await call('GET', s.foreignAdmin, path);
      expect([404], `${path} ${r.statusCode}`).toContain(r.statusCode);
    }
    const lists = await Promise.all(
      [
        '/academics/programs',
        '/academics/terms',
        '/academics/cohort-periods',
        '/academics/sections',
      ].map((p) => call('GET', s.foreignAdmin, p)),
    );
    const ours = new Set(Object.values(X));
    for (const l of lists) {
      ok(l);
      expect(dataOf<Array<{ id: string }>>(l).filter((x) => ours.has(x.id))).toEqual([]);
    }
    const writes = [
      await call(
        'PATCH',
        s.foreignAdmin,
        `/academics/elective-groups/${X.grp}`,
        { name: 'Hijack', reason: 'Cross tenant' },
        ifMatch(2),
      ),
      await call(
        'PATCH',
        s.foreignAdmin,
        `/academics/sections/${X.secBA}`,
        { name: 'Z' },
        ifMatch(1),
      ),
      await call('POST', s.foreignAdmin, '/academics/sections', {
        cohortPeriodId: X.bcomY2,
        name: 'Z',
      }),
      await call(
        'POST',
        s.foreignAdmin,
        `/academics/course-offerings/${X.offAcc}/registrations/from-section`,
        { validFrom: D(0), reason: 'Cross tenant' },
      ),
      await call(
        'POST',
        s.foreignAdmin,
        `/students/${students.b1}/term-enrollments`,
        { cohortPeriodId: X.bcomY2, reason: 'Cross tenant' },
        key(),
      ),
    ];
    for (const w of writes) expect([404], w.body).toContain(w.statusCode);
    expect((await call('GET', s.admin, `/students/${OTHER.students.one}`)).statusCode).toBe(404);
    expect(await snapshotAcademic(OTHER.orgId)).toBe(otherBefore);
    const grp = await adminQuery<{ name: string }>(
      `SELECT name FROM app.elective_groups WHERE id = $1`,
      [X.grp],
    );
    expect(grp[0]!.name).toBe('Discipline elective');
  });
});
