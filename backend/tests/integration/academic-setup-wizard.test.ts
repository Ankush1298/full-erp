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

// Task 8 (doc 35): the guided academic setup wizard and the terminology editor's server side.
//  - School (synthetic fixture, NOT the pilot's real CBSE curriculum): three campuses, Grades 1-12 x 4 sections each,
//    built over HTTP step by step; the wizard is re-read after each step (save/resume = the records themselves).
//  - Checked activation: blocked with actionable codes, explicit, If-Match, scoped to the term's campus, idempotent.
//  - College: annual (YEAR) and semester (SEMESTER) programmes with their own period labels; university defaults.
//  - Terminology validation, authorization and "labels change no data".
// Accounts, employees, postings and student records (Milestone 1/2 rows) are inserted as the harness superuser.

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

interface Session {
  cookie: string;
  csrf: string;
}
let HASH = '';
let S!: IsolatedTenant; // school
let C!: IsolatedTenant; // college
let U!: IsolatedTenant; // university
const s = {} as Record<
  | 'admin'
  | 'campusAdmin'
  | 'registrarOrg'
  | 'registrarCampus'
  | 'hod'
  | 'faculty'
  | 'studentOne'
  | 'cAdmin'
  | 'cHod'
  | 'cStudent'
  | 'cRegistrar'
  | 'uAdmin',
  Session
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload !== undefined ? { payload } : {}),
    ...(who ? { cookies: { session_token: who.cookie } } : {}),
    headers: {
      ...(method === 'GET' || !who ? {} : { origin: APP_ORIGIN, 'x-csrf-token': who.csrf }),
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
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });

interface Issue {
  code: string;
  severity: 'ERROR' | 'WARNING';
  count: number;
}
interface Step {
  key: string;
  required: boolean;
  status: 'COMPLETE' | 'ATTENTION' | 'INCOMPLETE';
  counts: Record<string, number>;
  issues: Issue[];
}
interface TermReady {
  id: string;
  code: string;
  status: string;
  version: number;
  campusId: string;
  activatable: boolean;
  blocking: Issue[];
  warnings: Issue[];
}
interface Wizard {
  organizationName: string;
  terminologyCustomised: boolean;
  requiredSteps: number;
  requiredComplete: number;
  steps: Step[];
  campuses: Array<{ id: string; openTerms: number; openSections: number; postedEmployees: number }>;
  terms: TermReady[];
}
const wizard = async (who: Session): Promise<Wizard> => {
  const r = await call('GET', who, '/academics/setup-wizard');
  ok(r);
  return dataOf<Wizard>(r);
};
const step = (w: Wizard, key: string): Step => w.steps.find((x) => x.key === key)!;
const codes = (list: Issue[]) => list.map((i) => i.code).sort();

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
async function employee(org: string, user: string, dept: string, code: string): Promise<string> {
  const e = await insertIn(org, 'employees', {
    user_id: user,
    employee_code: `${code}${RUN}`,
    employee_type: 'FACULTY',
    joining_date: '2020-06-01',
    status: 'ACTIVE',
  });
  await insertIn(org, 'employee_postings', {
    employee_id: e,
    department_id: dept,
    valid_from: '2020-06-01',
    is_primary: true,
  });
  return e;
}
/** Every academic row of a tenant, for "nothing else changed" checks. */
async function snapshot(org: string): Promise<string> {
  const tables = [
    'campuses',
    'departments',
    'period_types',
    'programs',
    'cohorts',
    'academic_years',
    'terms',
    'cohort_periods',
    'sections',
    'courses',
    'curriculum_courses',
    'course_offerings',
    'faculty_assignments',
    'section_class_teachers',
    'holidays',
    'term_enrollments',
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
const auditCount = async (org: string): Promise<number> =>
  Number(
    (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM app.audit_events WHERE organization_id = $1`,
        [org],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  await app.ready();
  HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  S = await createIsolatedTenant(HASH);
  C = await createIsolatedTenant(HASH);
  U = await createIsolatedTenant(HASH);
  s.admin = await login(S.emails.admin);
  s.campusAdmin = await login(S.emails.campusAdmin);
  s.registrarOrg = await login(S.emails.registrarOrg);
  s.registrarCampus = await login(S.emails.registrarCampus);
  s.hod = await login(S.emails.hod);
  s.faculty = await login(S.emails.faculty);
  s.studentOne = await login(S.emails.studentOne);
  s.cAdmin = await login(C.emails.admin);
  s.cHod = await login(C.emails.hod);
  s.cStudent = await login(C.emails.studentOne);
  s.cRegistrar = await login(C.emails.registrarOrg);
  s.uAdmin = await login(U.emails.admin);
});

afterAll(async () => {
  await app.close();
  await db.close();
  const k = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await k.connect();
  try {
    await k.query('BEGIN');
    await k.query('SET LOCAL session_replication_role = replica');
    for (const org of [S.orgId, C.orgId, U.orgId]) {
      for (const t of [
        'course_registrations',
        'timetable_slots',
        'faculty_assignments',
        'section_class_teachers',
        'course_offerings',
        'elective_groups',
        'section_memberships',
        'term_enrollments',
        'student_programs',
        'organization_settings',
        'holidays',
        'sections',
        'cohort_periods',
        'terms',
        'academic_years',
        'curriculum_courses',
        'cohorts',
        'programs',
        'period_types',
        'courses',
      ]) {
        await k.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [org]);
      }
    }
    await k.query('COMMIT');
  } finally {
    await k.query('ROLLBACK').catch(() => undefined);
    await k.end();
  }
  await S.cleanup();
  await C.cleanup();
  await U.cleanup();
});

// ---- school fixture ids
const SC = {
  campuses: [] as string[],
  depts: [] as string[],
  terms: [] as string[],
  periods: [] as Array<Record<number, string>>,
  sections: [] as string[][],
  employees: [] as string[],
} as {
  campuses: string[];
  depts: string[];
  terms: string[];
  periods: Array<Record<number, string>>;
  sections: string[][];
  employees: string[];
  year: string;
  periodType: string;
  programs: string[];
  course: string;
  offering: string;
};

describe('school: an incomplete tenant, read-only wizard, authorization', () => {
  it('lists what is missing with error codes; reading it writes nothing', async () => {
    const before = await snapshot(S.orgId);
    const audits = await auditCount(S.orgId);
    const w = await wizard(s.admin);
    expect(w.steps.map((x) => x.key)).toEqual([
      'institution',
      'campuses',
      'calendar',
      'programmes',
      'sections',
      'curriculum',
      'staff',
      'assignments',
      'classTeachers',
      'timetable',
      'holidays',
      'enrolment',
      'review',
    ]);
    // school-only and optional steps never count as required
    expect(w.steps.filter((x) => !x.required).map((x) => x.key)).toEqual([
      'classTeachers',
      'timetable',
      'holidays',
      'enrolment',
    ]);
    expect(step(w, 'campuses').status).toBe('COMPLETE');
    expect(codes(step(w, 'calendar').issues)).toEqual([
      'CAMPUS_WITHOUT_OPEN_TERM',
      'NO_OPEN_ACADEMIC_YEAR',
      'NO_OPEN_TERM',
    ]);
    expect(codes(step(w, 'programmes').issues)).toContain('NO_PERIOD_TYPE');
    expect(step(w, 'review').status).toBe('INCOMPLETE');
    expect(w.requiredComplete).toBeLessThan(w.requiredSteps);
    expect(w.terms).toEqual([]);
    expect(w.terminologyCustomised).toBe(false);
    expect(await snapshot(S.orgId)).toBe(before);
    expect(await auditCount(S.orgId)).toBe(audits);
  });

  it('only an organization-wide term manager may read it; other tenants see only themselves', async () => {
    for (const who of [s.campusAdmin, s.registrarCampus, s.hod, s.faculty, s.studentOne]) {
      expect((await call('GET', who, '/academics/setup-wizard')).statusCode).toBe(403);
    }
    expect((await call('GET', null, '/academics/setup-wizard')).statusCode).toBe(401);
    ok(await call('GET', s.registrarOrg, '/academics/setup-wizard'));
    const own = await wizard(s.admin);
    const other = await wizard(s.uAdmin);
    expect(other.organizationName).not.toBe(own.organizationName);
  });
});

describe('school: three campuses, Grades 1-12 x 4 sections, step by step', () => {
  it('campuses and departments; a retried create is refused and leaves no duplicate', async () => {
    SC.campuses = [S.campusId];
    SC.depts = [S.departmentId];
    for (const n of [2, 3]) {
      const body = { name: `Campus ${n}`, code: `C${n}${RUN}`, timezone: 'Asia/Kolkata' };
      SC.campuses.push(created(await call('POST', s.admin, '/organization/campuses', body)));
      expect((await call('POST', s.admin, '/organization/campuses', body)).statusCode).toBe(409);
    }
    let w = await wizard(s.admin);
    expect(step(w, 'campuses').counts.campuses).toBe(3);
    expect(codes(step(w, 'campuses').issues)).toEqual(['CAMPUS_WITHOUT_DEPARTMENT']);
    expect(step(w, 'campuses').status).toBe('ATTENTION');
    for (const n of [1, 2]) {
      SC.depts.push(
        created(
          await call('POST', s.admin, '/organization/departments', {
            campusId: SC.campuses[n],
            name: `School ${n + 1}`,
            code: `SCH${n + 1}${RUN}`,
          }),
        ),
      );
    }
    w = await wizard(s.admin);
    expect(step(w, 'campuses').status).toBe('COMPLETE');
    expect(w.campuses.map((c) => c.id).sort()).toEqual([...SC.campuses].sort());
  });

  it('academic year and one PLANNED term per campus; progress resumes from the records', async () => {
    SC.year = created(
      await call('POST', s.admin, '/academics/academic-years', {
        label: `SY-${RUN}`,
        startDate: D(10),
        endDate: D(370),
      }),
    );
    for (const [i, campus] of SC.campuses.entries()) {
      SC.terms.push(
        created(
          await call('POST', s.admin, '/academics/terms', {
            campusId: campus,
            academicYearId: SC.year,
            code: `SESSION-${i + 1}-${RUN}`,
            name: `Session (campus ${i + 1})`,
            startDate: D(10),
            endDate: D(370),
          }),
        ),
      );
    }
    const w = await wizard(s.admin);
    expect(step(w, 'calendar').status).toBe('COMPLETE');
    expect(w.terms.map((t) => t.id).sort()).toEqual([...SC.terms].sort());
    expect(w.terms.every((t) => t.status === 'PLANNED' && !t.activatable)).toBe(true);
    expect(codes(w.terms[0]!.blocking)).toEqual([
      'ACADEMIC_YEAR_NOT_ACTIVE',
      'NO_COHORT_PERIOD',
      'NO_PUBLISHED_OFFERING',
    ]);
  });

  it('a K-12 programme per campus with Grades 1-12 and four sections each (144 sections)', async () => {
    SC.periodType = created(
      await call('POST', s.admin, '/academics/period-types', {
        code: 'GRADE',
        label: 'Grade',
        labelPlural: 'Grades',
      }),
    );
    SC.programs = [];
    for (const [i, dept] of SC.depts.entries()) {
      const program = created(
        await call('POST', s.admin, '/academics/programs', {
          departmentId: dept,
          periodTypeId: SC.periodType,
          name: `School Grades 1-12 (campus ${i + 1})`,
          code: `K12-${i + 1}${RUN}`.slice(0, 20),
          degreeLevel: 'SCHOOL',
          durationPeriods: 12,
          periodsPerYear: 1,
        }),
      );
      SC.programs.push(program);
      const periods: Record<number, string> = {};
      const sections: string[] = [];
      for (let grade = 1; grade <= 12; grade += 1) {
        const cohort = created(
          await call('POST', s.admin, '/academics/cohorts', {
            programId: program,
            admissionYear: 2026 - grade + 1,
            name: `Intake ${2026 - grade + 1} (campus ${i + 1})`,
          }),
        );
        periods[grade] = created(
          await call('POST', s.admin, '/academics/cohort-periods', {
            cohortId: cohort,
            termId: SC.terms[i],
            periodNo: grade,
          }),
        );
        for (const letter of ['A', 'B', 'C', 'D']) {
          sections.push(
            created(
              await call('POST', s.admin, '/academics/sections', {
                cohortPeriodId: periods[grade],
                name: `${grade}-${letter}`,
                capacity: 40,
              }),
            ),
          );
        }
      }
      SC.periods.push(periods);
      SC.sections.push(sections);
    }
    // a retried section create is refused (duplicate name in the grade), so revisiting the step adds nothing
    expect(
      (
        await call('POST', s.admin, '/academics/sections', {
          cohortPeriodId: SC.periods[0]![6],
          name: '6-A',
          capacity: 40,
        })
      ).statusCode,
    ).toBe(409);
    const w = await wizard(s.admin);
    expect(step(w, 'programmes').status).toBe('COMPLETE');
    expect(step(w, 'programmes').counts).toMatchObject({ programmes: 3, cohortPeriods: 36 });
    expect(step(w, 'sections').status).toBe('COMPLETE');
    expect(step(w, 'sections').counts.sections).toBe(144);
    expect(w.campuses.map((c) => [c.openTerms, c.openSections])).toEqual([
      [1, 48],
      [1, 48],
      [1, 48],
    ]);
    // the class-teacher step is a recommendation: 144 sections without one, still optional
    const ct = step(w, 'classTeachers');
    expect(ct.required).toBe(false);
    expect(ct.issues).toEqual([
      { code: 'SECTION_WITHOUT_CLASS_TEACHER', severity: 'WARNING', count: 144 },
    ]);
    expect(codes(step(w, 'curriculum').issues)).toEqual([
      'NO_ACTIVE_COURSE',
      'PROGRAMME_WITHOUT_CURRICULUM',
    ]);
  });
});

describe('school: checked activation', () => {
  const activate = (who: Session, term: string, headers: Record<string, string>, body = {}) =>
    call('POST', who, `/academics/terms/${term}/activation`, body, headers);

  it('is refused with actionable codes while blocking items remain, and changes nothing', async () => {
    const before = await snapshot(S.orgId);
    const audits = await auditCount(S.orgId);
    const r = await activate(s.admin, SC.terms[0]!, ifMatch(1));
    expect(r.statusCode, r.body).toBe(409);
    const err = r.json<{ error: { code: string; details: Array<{ field: string }> } }>().error;
    expect(err.code).toBe('SETUP_INCOMPLETE');
    expect(err.details.map((d) => d.field)).toEqual([
      'ACADEMIC_YEAR_NOT_ACTIVE',
      'NO_PUBLISHED_OFFERING',
    ]);
    expect(await snapshot(S.orgId)).toBe(before);
    expect(await auditCount(S.orgId)).toBe(audits);
    // the academic year is activated explicitly through its own existing endpoint
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/academic-years/${SC.year}`,
        { status: 'ACTIVE' },
        ifMatch(1),
      ),
    );
  });

  it('a published offering without a teacher still blocks; a teacher makes the term ready', async () => {
    SC.course = created(
      await call('POST', s.admin, '/academics/courses', {
        code: `MATH6${RUN}`,
        title: 'Mathematics (Grade 6)',
        credits: 0,
        courseType: 'THEORY',
        owningDepartmentId: S.departmentId,
      }),
    );
    ok(
      await call('POST', s.admin, '/academics/curriculum-courses', {
        programId: SC.programs[0],
        courseId: SC.course,
        regulation: 'R2026',
        periodNo: 6,
        category: 'CORE',
      }),
      201,
    );
    SC.offering = created(
      await call('POST', s.admin, '/academics/course-offerings', {
        termId: SC.terms[0],
        courseId: SC.course,
        cohortPeriodId: SC.periods[0]![6],
        sectionId: SC.sections[0]![20], // 6-A
        offeringKind: 'CORE',
        registrationPolicy: 'AUTO_FROM_SECTION',
      }),
    );
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/course-offerings/${SC.offering}`,
        { status: 'PUBLISHED' },
        ifMatch(1),
      ),
    );
    const r = await activate(s.admin, SC.terms[0]!, ifMatch(1));
    expect(r.statusCode).toBe(409);
    expect(
      r.json<{ error: { details: Array<{ field: string; message: string }> } }>().error.details,
    ).toEqual([{ field: 'OFFERING_WITHOUT_TEACHER', message: '1' }]);

    SC.employees.push(await employee(S.orgId, S.users.faculty, S.departmentId, 'T1'));
    ok(
      await call(
        'POST',
        s.admin,
        `/academics/course-offerings/${SC.offering}/faculty-assignments`,
        {
          employeeId: SC.employees[0],
          teachingRole: 'PRIMARY',
          validFrom: D(10),
          reason: 'Subject teacher',
        },
      ),
      201,
    );
    const w = await wizard(s.admin);
    const t1 = w.terms.find((t) => t.id === SC.terms[0])!;
    expect(t1.activatable).toBe(true);
    expect(t1.blocking).toEqual([]);
    expect(codes(t1.warnings)).toEqual([
      'NO_OPEN_ENROLMENT',
      'OFFERING_WITHOUT_SLOT',
      'SECTION_WITHOUT_CLASS_TEACHER',
      'TERM_WITHOUT_HOLIDAY',
    ]);
    // the other campuses' terms are still blocked on their own data
    expect(w.terms.filter((t) => t.id !== SC.terms[0]).every((t) => !t.activatable)).toBe(true);
    expect(step(w, 'assignments').status).toBe('COMPLETE');
    expect(step(w, 'curriculum').issues).toEqual([
      { code: 'PROGRAMME_WITHOUT_CURRICULUM', severity: 'WARNING', count: 2 },
    ]);
  });

  it('needs If-Match and the term campus scope; activates once; a retry changes nothing', async () => {
    expect((await activate(s.admin, SC.terms[0]!, {})).statusCode).toBe(428);
    expect((await activate(s.admin, SC.terms[0]!, ifMatch(7))).statusCode).toBe(409);
    // the campus admin of campus 1 cannot see campus 2's term; faculty hold no term.manage
    expect((await activate(s.campusAdmin, SC.terms[1]!, ifMatch(1))).statusCode).toBe(404);
    expect((await activate(s.faculty, SC.terms[0]!, ifMatch(1))).statusCode).toBe(403);
    expect((await activate(s.cAdmin, SC.terms[0]!, ifMatch(1))).statusCode).toBe(404);
    expect((await activate(s.admin, 'not-a-uuid', ifMatch(1))).statusCode).toBe(400);
    expect((await activate(s.admin, uuidv7(), ifMatch(1))).statusCode).toBe(404);

    const r = await activate(s.campusAdmin, SC.terms[0]!, ifMatch(1), {
      reason: 'Session ready per setup wizard',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(dataOf<{ status: string; version: number }>(r)).toMatchObject({
      status: 'ACTIVE',
      version: 2,
    });
    const again = await activate(s.admin, SC.terms[0]!, ifMatch(2));
    expect(again.statusCode).toBe(200);
    expect(dataOf<{ version: number }>(again).version).toBe(2);
    const audit = await adminQuery<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'academic.term.update'`,
      [S.orgId, SC.terms[0]],
    );
    expect(audit).toHaveLength(1);
    const w = await wizard(s.admin);
    expect(step(w, 'review').status).not.toBe('INCOMPLETE');
    // an ACTIVE term can no longer be "activated" into anything else; CLOSED/LOCKED terms follow the lifecycle
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/terms/${SC.terms[0]}`,
        { status: 'CLOSED' },
        ifMatch(2),
      ),
    );
    expect((await activate(s.admin, SC.terms[0]!, ifMatch(3))).statusCode).toBe(409);
  });

  it('holidays and class teachers clear their warnings without touching other campuses', async () => {
    ok(
      await call('POST', s.admin, '/academics/holidays', {
        campusId: SC.campuses[1],
        holidayDate: D(40),
        name: 'Founders Day',
        kind: 'HOLIDAY',
        reason: 'Calendar approved',
      }),
      201,
    );
    const ctEmployee = await employee(
      S.orgId,
      (
        await adminQuery<{ id: string }>(
          `INSERT INTO app.users (id, organization_id, email, display_name, status)
           VALUES ($1, $2, $3, 'Class teacher', 'ACTIVE') RETURNING id`,
          [uuidv7(), S.orgId, `ct-${RUN.toLowerCase()}@school.test`],
        )
      )[0]!.id,
      SC.depts[1]!,
      'CT1',
    );
    ok(
      await call('POST', s.admin, `/academics/sections/${SC.sections[1]![0]}/class-teachers`, {
        employeeId: ctEmployee,
        classTeacherRole: 'PRIMARY',
        validFrom: D(10),
        reason: 'Class teacher for the session',
      }),
      201,
    );
    const w = await wizard(s.admin);
    const t2 = w.terms.find((t) => t.id === SC.terms[1])!;
    const t3 = w.terms.find((t) => t.id === SC.terms[2])!;
    expect(codes(t2.warnings)).not.toContain('TERM_WITHOUT_HOLIDAY');
    expect(codes(t3.warnings)).toContain('TERM_WITHOUT_HOLIDAY');
    expect(t2.warnings.find((x) => x.code === 'SECTION_WITHOUT_CLASS_TEACHER')!.count).toBe(47);
    expect(t3.warnings.find((x) => x.code === 'SECTION_WITHOUT_CLASS_TEACHER')!.count).toBe(48);
  });
});

describe('terminology: school preset, data unchanged, validation, authorization', () => {
  const putTerminology = async (who: Session, value: unknown, version: number) => {
    await elevateSession(who.cookie);
    return call(
      'PUT',
      who,
      '/organization/settings/terminology',
      { value, reason: 'Institution vocabulary' },
      ifMatch(version),
    );
  };

  it('the school preset changes labels only: no academic row, period type or other tenant changes', async () => {
    const before = await snapshot(S.orgId);
    const other = await snapshot(C.orgId);
    const r = await putTerminology(
      s.admin,
      { program: 'Class', period: 'Grade', course: 'Subject', section: 'Section', term: 'Term' },
      0,
    );
    expect(r.statusCode, r.body).toBe(200);
    const t = dataOf<{ labels: Record<string, string>; byCohort: Record<string, string> }>(
      await call('GET', s.studentOne, '/academics/terminology'),
    );
    expect(t.labels).toEqual({
      program: 'Class',
      cohort: 'Batch',
      period: 'Grade',
      section: 'Section',
      term: 'Term',
      course: 'Subject',
    });
    expect(t.byCohort).toEqual({});
    expect(await snapshot(S.orgId)).toBe(before);
    expect(await snapshot(C.orgId)).toBe(other);
    expect((await wizard(s.admin)).terminologyCustomised).toBe(true);
  });

  it('refuses blank, padded, bracketed, duplicate and clashing labels, without echoing them', async () => {
    const bad: unknown[] = [
      { program: 'Class', section: 'Class' },
      { section: 'batch' }, // the default cohort label
      { section: 'Class  ', program: 'Programme' },
      { section: '   ' },
      { section: ' Class' },
      { section: '<b>Class</b>' },
      { section: 'Cl\tass' },
      { grade: 'Grade' },
      { periodTypes: { YEAR: 'Term' } }, // clashes with the term label
      { periodTypes: { YEAR: '' } },
      {},
    ];
    for (const value of bad) {
      const r = await putTerminology(s.cAdmin, value, 0);
      expect(r.statusCode, JSON.stringify(value)).toBe(400);
      expect(r.body).not.toContain('<b>');
    }
    const dup = await putTerminology(s.cAdmin, { program: 'Class', section: 'Class' }, 0);
    expect(dup.json<{ error: { message: string } }>().error.message).toBe(
      'The labels of "program" and "section" must differ.',
    );
    // the legacy shape (slots only) stays valid
    ok(await putTerminology(s.cAdmin, { cohort: 'Intake' }, 0));
  });

  it('only an organization-wide settings manager may change labels', async () => {
    for (const who of [s.cRegistrar, s.cHod, s.cStudent]) {
      const r = await putTerminology(who, { cohort: 'Group' }, 1);
      expect(r.statusCode, r.body).toBe(403);
    }
    expect(
      dataOf<{ labels: { cohort: string } }>(await call('GET', s.cAdmin, '/academics/terminology'))
        .labels.cohort,
    ).toBe('Intake');
  });
});

describe('college: annual and semester programmes show their own period label', () => {
  const X = {} as Record<
    'ptYear' | 'ptSem' | 'other' | 'bcom' | 'bca' | 'bcom25' | 'bcom26' | 'bca25',
    string
  >;
  it('programme-aware labels follow each programme, within the reader own scope', async () => {
    X.ptYear = created(
      await call('POST', s.cAdmin, '/academics/period-types', {
        code: 'YEAR',
        label: 'Year',
        labelPlural: 'Years',
      }),
    );
    X.ptSem = created(
      await call('POST', s.cAdmin, '/academics/period-types', {
        code: 'SEMESTER',
        label: 'Semester',
        labelPlural: 'Semesters',
      }),
    );
    X.other = created(
      await call('POST', s.cAdmin, '/organization/departments', {
        campusId: C.campusId,
        name: 'Computer Applications',
        code: `CA${RUN}`,
      }),
    );
    const program = async (dept: string, pt: string, code: string, duration: number, ppy: number) =>
      created(
        await call('POST', s.cAdmin, '/academics/programs', {
          departmentId: dept,
          periodTypeId: pt,
          name: code,
          code: `${code}${RUN}`,
          degreeLevel: 'UG',
          durationPeriods: duration,
          periodsPerYear: ppy,
        }),
      );
    X.bcom = await program(C.departmentId, X.ptYear, 'BCOM', 3, 1); // the HOD's department
    X.bca = await program(X.other, X.ptSem, 'BCA', 6, 2);
    const cohort = async (p: string, year: number) =>
      created(
        await call('POST', s.cAdmin, '/academics/cohorts', {
          programId: p,
          admissionYear: year,
          name: `${year}`,
        }),
      );
    X.bcom25 = await cohort(X.bcom, 2025);
    X.bcom26 = await cohort(X.bcom, 2026);
    X.bca25 = await cohort(X.bca, 2025);

    // before any period-type label: the tenant-wide period label applies everywhere (backward compatible)
    let t = dataOf<{
      labels: Record<string, string>;
      byCohort: Record<string, string>;
      periodTypes: Array<{ code: string; label: string; customised: boolean }>;
    }>(await call('GET', s.cAdmin, '/academics/terminology'));
    expect(t.byCohort).toEqual({});
    expect(t.periodTypes.map((p) => [p.code, p.label, p.customised])).toEqual([
      ['SEMESTER', 'Semester', false],
      ['YEAR', 'Semester', false],
    ]);

    const before = await snapshot(C.orgId);
    await elevateSession(s.cAdmin.cookie);
    ok(
      await call(
        'PUT',
        s.cAdmin,
        '/organization/settings/terminology',
        {
          value: { cohort: 'Intake', periodTypes: { YEAR: 'Year', SEMESTER: 'Semester' } },
          reason: 'Annual and semester programmes',
        },
        ifMatch(1),
      ),
    );
    expect(await snapshot(C.orgId)).toBe(before);
    t = dataOf(await call('GET', s.cAdmin, '/academics/terminology'));
    expect(t.labels.period).toBe('Semester');
    expect(t.byCohort).toEqual({ [X.bcom25]: 'Year', [X.bcom26]: 'Year', [X.bca25]: 'Semester' });
    // the HOD lists only their department's cohorts, so the map holds only those
    t = dataOf(await call('GET', s.cHod, '/academics/terminology'));
    expect(t.byCohort).toEqual({ [X.bcom25]: 'Year', [X.bcom26]: 'Year' });
    // a student reads the labels; another tenant sees none of these cohorts
    ok(await call('GET', s.cStudent, '/academics/terminology'));
    const foreign = dataOf<{ byCohort: Record<string, string> }>(
      await call('GET', s.admin, '/academics/terminology'),
    );
    expect(Object.keys(foreign.byCohort)).toEqual([]);
  });

  it('the college wizard asks for no school-only step', async () => {
    const w = await wizard(s.cAdmin);
    expect(step(w, 'classTeachers').required).toBe(false);
    expect(step(w, 'programmes').counts).toMatchObject({
      periodTypes: 2,
      programmes: 2,
      cohorts: 3,
    });
  });
});

describe('university: semester programmes keep the defaults', () => {
  it('no terminology row: default labels, no per-cohort labels, wizard readable', async () => {
    created(
      await call('POST', s.uAdmin, '/academics/period-types', {
        code: 'SEMESTER',
        label: 'Semester',
        labelPlural: 'Semesters',
      }),
    );
    const t = dataOf<{
      labels: Record<string, string>;
      customised: string[];
      byCohort: Record<string, string>;
    }>(await call('GET', s.uAdmin, '/academics/terminology'));
    expect(t.labels).toEqual({
      program: 'Programme',
      cohort: 'Batch',
      period: 'Semester',
      section: 'Section',
      term: 'Term',
      course: 'Course',
    });
    expect(t.customised).toEqual([]);
    expect(t.byCohort).toEqual({});
    const w = await wizard(s.uAdmin);
    expect(w.terminologyCustomised).toBe(false);
    expect(step(w, 'programmes').counts.periodTypes).toBe(1);
  });
});
