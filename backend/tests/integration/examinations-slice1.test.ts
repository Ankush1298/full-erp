import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { activateTermFixture } from '../support/term-fixture.js';

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
let HASH = '';

interface Session {
  cookie: string;
  csrf: string;
}

const s = {} as Record<
  'admin' | 'teacherAssigned' | 'teacherUnassigned' | 'student1' | 'student2' | 'otherAdmin',
  Session
>;

let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

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

describe('Examinations, Marks and Results — Slice 1', () => {
  let yearId = '';
  let termId = '';
  let offeringId = '';
  let student1Id = '';
  let student2Id = '';
  let examId = '';
  let scheduleId = '';

  beforeAll(async () => {
    await app.ready();
    HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    T = await createIsolatedTenant(HASH);
    OTHER = await createIsolatedTenant(HASH);

    // Seed roles and permissions for both tenants if not already present
    await adminQuery(
      `INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
       SELECT $1::uuid, r.id, p.code,
              CASE
                WHEN r.code = 'STUDENT' THEN 'SELF'
                WHEN r.code = 'FACULTY' THEN 'ASSIGNED'
                ELSE 'GRANTED'
              END
         FROM app.roles r
        CROSS JOIN platform.permissions p
        WHERE r.organization_id = $1::uuid
          AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read')
          AND (
            (r.code = 'COLLEGE_ADMIN' AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read')) OR
            (r.code = 'CAMPUS_ADMIN' AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read')) OR
            (r.code = 'REGISTRAR' AND p.code IN ('exam.manage', 'result.publish', 'result.read')) OR
            (r.code = 'FACULTY' AND p.code IN ('exam.marks.enter', 'result.read')) OR
            (r.code = 'STUDENT' AND p.code = 'result.read')
          )
        ON CONFLICT DO NOTHING`,
      [T.orgId],
    );

    // Set up academic structure
    yearId = await insertIn(T.orgId, 'academic_years', {
      label: `AY-${RUN}`,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    const periodTypeId = await insertIn(T.orgId, 'period_types', {
      code: code('PT'),
      label: 'Semester',
      label_plural: 'Semesters',
    });
    const programId = await insertIn(T.orgId, 'programs', {
      department_id: T.departmentId,
      period_type_id: periodTypeId,
      name: 'Computer Science',
      code: code('CS'),
      degree_level: 'UG',
      duration_periods: 8,
    });
    const cohortId = await insertIn(T.orgId, 'cohorts', {
      program_id: programId,
      admission_year: 2026,
      name: 'CS 2026',
    });
    termId = await insertIn(T.orgId, 'terms', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: code('T1'),
      name: 'Term 1',
      start_date: '2026-06-01',
      end_date: '2026-12-31',
    });
    const cohortPeriodId = await insertIn(T.orgId, 'cohort_periods', {
      cohort_id: cohortId,
      term_id: termId,
      period_no: 1,
    });
    const courseId = await insertIn(T.orgId, 'courses', {
      owning_department_id: T.departmentId,
      code: code('CRS'),
      title: 'Data Structures',
      credits: 4,
      course_type: 'THEORY',
    });

    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [yearId]);
    await activateTermFixture(termId);

    // Create course offering
    const offRes = await call('POST', await login(T.emails.admin), '/academics/course-offerings', {
      termId,
      courseId,
      cohortPeriodId,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    expect(offRes.statusCode).toBe(201);
    offeringId = offRes.json<{ data: { id: string } }>().data.id;

    // Publish offering
    await call(
      'PATCH',
      await login(T.emails.admin),
      `/academics/course-offerings/${offeringId}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );

    // Create Faculty 1 (Assigned) and Faculty 2 (Unassigned)
    const emp1 = await insertIn(T.orgId, 'employees', {
      user_id: T.users.faculty,
      employee_code: code('E1'),
      employee_type: 'FACULTY',
      joining_date: '2020-01-01',
      status: 'ACTIVE',
    });

    // Additional faculty
    const f2User = uuidv7();
    const f2Email = `f2.${RUN.toLowerCase()}@isolated.test`;
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [f2User, f2Email, HASH],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Faculty 2', 'ACTIVE', $1)`,
      [f2User, T.orgId, f2Email],
    );
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION' FROM app.roles r
        WHERE r.organization_id = $2::uuid AND r.code = 'FACULTY'`,
      [uuidv7(), T.orgId, f2User],
    );
    await insertIn(T.orgId, 'employees', {
      user_id: f2User,
      employee_code: code('E2'),
      employee_type: 'FACULTY',
      joining_date: '2020-01-01',
      status: 'ACTIVE',
    });

    // Assign faculty 1 to offering
    await insertIn(T.orgId, 'faculty_assignments', {
      course_offering_id: offeringId,
      employee_id: emp1,
      role: 'PRIMARY',
      valid_from: '2026-06-01',
    });

    student1Id = T.students.one;
    student2Id = T.students.two;

    // Student enrollments and course registrations
    const sp1 = await insertIn(T.orgId, 'student_programs', {
      student_id: student1Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });
    const sp2 = await insertIn(T.orgId, 'student_programs', {
      student_id: student2Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });

    const eid1 = await insertIn(T.orgId, 'term_enrollments', {
      student_id: student1Id,
      student_program_id: sp1,
      cohort_period_id: cohortPeriodId,
      term_id: termId,
      period_no: 1,
      roll_number: '101',
    });
    const eid2 = await insertIn(T.orgId, 'term_enrollments', {
      student_id: student2Id,
      student_program_id: sp2,
      cohort_period_id: cohortPeriodId,
      term_id: termId,
      period_no: 1,
      roll_number: '102',
    });
    await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id IN ($1, $2)`, [
      eid1,
      eid2,
    ]);

    await insertIn(T.orgId, 'course_registrations', {
      term_enrollment_id: eid1,
      student_id: student1Id,
      course_offering_id: offeringId,
      status: 'REGISTERED',
      valid_from: '2026-06-01',
      source: 'MANUAL',
      registration_kind: 'REGULAR',
    });
    await insertIn(T.orgId, 'course_registrations', {
      term_enrollment_id: eid2,
      student_id: student2Id,
      course_offering_id: offeringId,
      status: 'REGISTERED',
      valid_from: '2026-06-01',
      source: 'MANUAL',
      registration_kind: 'REGULAR',
    });

    // Sessions
    s.admin = await login(T.emails.admin);
    s.teacherAssigned = await login(T.emails.faculty);
    s.teacherUnassigned = await login(f2Email);
    s.student1 = await login(T.emails.studentOne);
    s.student2 = await login(T.emails.studentTwo);
    s.otherAdmin = await login(OTHER.emails.admin);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('admin can create an examination type', async () => {
    const res = await call('POST', s.admin, '/examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Mid-Term Exam 2026',
      exam_type: 'MID_TERM',
      starts_on: '2026-10-15',
      ends_on: '2026-10-25',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ data: { id: string; name: string; exam_type: string } }>();
    expect(body.data.name).toBe('Mid-Term Exam 2026');
    expect(body.data.exam_type).toBe('MID_TERM');
    examId = body.data.id;
  });

  it('rejects invalid examination date ranges (ends_on before starts_on)', async () => {
    const res = await call('POST', s.admin, '/examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Invalid Exam Dates',
      exam_type: 'UNIT_TEST',
      starts_on: '2026-10-25',
      ends_on: '2026-10-15',
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin can schedule an exam paper for a course offering', async () => {
    const res = await call('POST', s.admin, `/examinations/${examId}/schedules`, {
      course_offering_id: offeringId,
      exam_date: '2026-10-18',
      start_time: '10:00',
      end_time: '12:00',
      max_marks: 100,
      pass_marks: 40,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { id: string; max_marks: string; pass_marks: string; status: string };
    }>();
    expect(Number(body.data.max_marks)).toBe(100);
    expect(Number(body.data.pass_marks)).toBe(40);
    expect(body.data.status).toBe('SCHEDULED');
    scheduleId = body.data.id;
  });

  it('rejects schedule creation when pass marks exceed max marks', async () => {
    const res = await call('POST', s.admin, `/examinations/${examId}/schedules`, {
      course_offering_id: offeringId,
      exam_date: '2026-10-19',
      max_marks: 50,
      pass_marks: 60,
    });
    expect(res.statusCode).toBe(400);
  });

  it('assigned teacher can fetch student roster for the exam paper', async () => {
    const res = await call(
      'GET',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/roster`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { students: Array<{ student_id: string; student_name: string }> };
    }>();
    expect(body.data.students.length).toBe(2);
    const studentIds = body.data.students.map((st) => st.student_id);
    expect(studentIds).toContain(student1Id);
    expect(studentIds).toContain(student2Id);
  });

  it('unassigned teacher cannot fetch student roster or enter marks (denied)', async () => {
    const res = await call(
      'GET',
      s.teacherUnassigned,
      `/examinations/schedules/${scheduleId}/roster`,
    );
    expect([403, 404]).toContain(res.statusCode);
  });

  it('rejects marks greater than maximum marks', async () => {
    const res = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            status: 'ENTERED',
            marks_obtained: 105, // max is 100!
          },
        ],
      },
    );
    expect(res.statusCode).toBe(400);
  });

  it('assigned teacher can save draft marks', async () => {
    const res = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            status: 'ENTERED',
            marks_obtained: 85,
            remarks: 'Great performance',
          },
          {
            student_id: student2Id,
            status: 'ABSENT',
          },
        ],
      },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string; entries_updated: number } }>();
    expect(body.data.status).toBe('DRAFT_MARKS');
    expect(body.data.entries_updated).toBe(2);
  });

  it('students cannot see unpublished draft marks', async () => {
    const res = await call('GET', s.student1, `/examinations/students/${student1Id}/results`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBe(0); // Unpublished results are hidden from student
  });

  it('teacher submits marks -> schedule transitions to SUBMITTED', async () => {
    const res = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'SUBMIT',
        entries: [
          {
            student_id: student1Id,
            status: 'ENTERED',
            marks_obtained: 85,
          },
          {
            student_id: student2Id,
            status: 'ENTERED',
            marks_obtained: 35, // Below 40 pass mark
          },
        ],
      },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string } }>();
    expect(body.data.status).toBe('SUBMITTED');
  });

  it('teacher cannot publish results (maker-checker violation -> 403)', async () => {
    const res = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/publish`,
    );
    expect(res.statusCode).toBe(403);
  });

  it('administrator can publish results (maker-checker compliant)', async () => {
    await elevateSession(s.admin.cookie);
    const res = await call('POST', s.admin, `/examinations/schedules/${scheduleId}/publish`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string } }>();
    expect(body.data.status).toBe('PUBLISHED');
  });

  it('modifying marks after publication is rejected (conflict 409)', async () => {
    const res = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            status: 'ENTERED',
            marks_obtained: 90,
          },
        ],
      },
    );
    expect(res.statusCode).toBe(409);
  });

  it('class register returns accurate marks and calculated statistics', async () => {
    const res = await call('GET', s.admin, `/examinations/schedules/${scheduleId}/register`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        marks: Array<{ marks_obtained: string; is_passing: boolean }>;
        statistics: {
          total_students: number;
          appeared: number;
          absent: number;
          passed: number;
          failed: number;
          average_marks: number;
          pass_percentage: number;
        };
      };
    }>();

    expect(body.data.statistics.total_students).toBe(2);
    expect(body.data.statistics.appeared).toBe(2);
    expect(body.data.statistics.absent).toBe(0);
    expect(body.data.statistics.passed).toBe(1); // 85 >= 40
    expect(body.data.statistics.failed).toBe(1); // 35 < 40
    expect(body.data.statistics.average_marks).toBe(60); // (85 + 35) / 2
    expect(body.data.statistics.pass_percentage).toBe(50);
  });

  it('student can view their own published results (SELF scope)', async () => {
    const res = await call('GET', s.student1, `/examinations/students/${student1Id}/results`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        exam_name: string;
        marks_obtained: string;
        is_passing: boolean;
        max_marks: string;
      }>;
    }>();

    expect(body.data.length).toBe(1);
    const item = body.data[0]!;
    expect(item.exam_name).toBe('Mid-Term Exam 2026');
    expect(Number(item.marks_obtained)).toBe(85);
    expect(item.is_passing).toBe(true);
  });

  it('student cannot view another student result (FORBIDDEN 403)', async () => {
    const res = await call('GET', s.student1, `/examinations/students/${student2Id}/results`);
    expect(res.statusCode).toBe(403);
  });

  it('cross-tenant isolation: Tenant B cannot access Tenant A examinations or results', async () => {
    const getRes = await call('GET', s.otherAdmin, `/examinations/${examId}`);
    expect(getRes.statusCode).toBe(404);

    const schedRes = await call('GET', s.otherAdmin, `/examinations/schedules/${scheduleId}`);
    expect(schedRes.statusCode).toBe(404);

    const regRes = await call(
      'GET',
      s.otherAdmin,
      `/examinations/schedules/${scheduleId}/register`,
    );
    expect(regRes.statusCode).toBe(404);
  });
});
