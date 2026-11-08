import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
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

const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const slot = (date: string, hour = 10) => {
  const start = Date.parse(`${date}T00:00:00Z`) + (hour - 5.5) * 3_600_000;
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  };
};

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

const createSession = (who: Session | null, body: Record<string, unknown>, k = uuidv7()) =>
  call('POST', who, '/attendance/sessions', body, { 'idempotency-key': k });

const submitAttendance = (who: Session | null, id: string, records: object[], k = uuidv7()) =>
  call('POST', who, `/attendance/sessions/${id}/attendance`, { records }, { 'idempotency-key': k });

interface CandidateItemDto {
  candidate_id: string;
  student_id: string;
  evaluation_status: string;
  override_status: string;
  final_status: string;
  evidence_summary: {
    attendance_percentage: number;
  };
}

interface CandidateListDto {
  list: {
    id: string;
    eligible_count: number;
    not_eligible_count: number;
  };
  candidates: CandidateItemDto[];
}

interface PolicyDto {
  id: string;
  min_attendance_percentage: number;
}

interface EntriesUpdatedDto {
  entries_updated: number;
}

interface IdDto {
  id: string;
}

interface ErrorDto {
  error: {
    code: string;
  };
}

describe('Examination Eligibility & Automatic Candidate Lists — Slice 2', () => {
  let yearId = '';
  let termId = '';
  let offeringId = '';
  let student1Id = '';
  let student2Id = '';
  let examId = '';
  let scheduleId = '';
  let candidateListId = '';
  let candidate2Id = '';

  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    T = await createIsolatedTenant(HASH);
    OTHER = await createIsolatedTenant(HASH);

    // Seed roles and permissions for both tenants
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
          AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read', 'attendance.session.mark', 'attendance.record.read')
          AND (
            (r.code = 'COLLEGE_ADMIN' AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read')) OR
            (r.code = 'CAMPUS_ADMIN' AND p.code IN ('exam.manage', 'exam.marks.enter', 'result.publish', 'result.read')) OR
            (r.code = 'REGISTRAR' AND p.code IN ('exam.manage', 'result.publish', 'result.read')) OR
            (r.code = 'FACULTY' AND p.code IN ('exam.marks.enter', 'result.read', 'attendance.session.mark', 'attendance.record.read')) OR
            (r.code = 'STUDENT' AND p.code = 'result.read')
          )
        ON CONFLICT DO NOTHING`,
      [T.orgId],
    );

    // Academic Structure
    yearId = await insertIn(T.orgId, 'academic_years', {
      label: `AY-${RUN}`,
      start_date: D(-100),
      end_date: D(260),
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
      start_date: D(-60),
      end_date: D(60),
    });
    const cohortPeriodId = await insertIn(T.orgId, 'cohort_periods', {
      cohort_id: cohortId,
      term_id: termId,
      period_no: 1,
    });
    const courseId = await insertIn(T.orgId, 'courses', {
      owning_department_id: T.departmentId,
      code: code('CRS'),
      title: 'Operating Systems',
      credits: 4,
      course_type: 'THEORY',
    });

    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [yearId]);
    await activateTermFixture(termId);

    // Course offering
    const offRes = await call('POST', await login(T.emails.admin), '/academics/course-offerings', {
      termId,
      courseId,
      cohortPeriodId,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    expect(offRes.statusCode).toBe(201);
    offeringId = offRes.json<{ data: { id: string } }>().data.id;

    await call(
      'PATCH',
      await login(T.emails.admin),
      `/academics/course-offerings/${offeringId}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );

    // Faculty 1 (Assigned) and Faculty 2 (Unassigned)
    const emp1 = await insertIn(T.orgId, 'employees', {
      user_id: T.users.faculty,
      employee_code: code('E1'),
      employee_type: 'FACULTY',
      joining_date: '2020-01-01',
      status: 'ACTIVE',
    });

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

    await insertIn(T.orgId, 'faculty_assignments', {
      course_offering_id: offeringId,
      employee_id: emp1,
      role: 'PRIMARY',
      valid_from: D(-60),
    });

    student1Id = T.students.one;
    student2Id = T.students.two;

    // Student enrollments and registrations
    const sp1 = await insertIn(T.orgId, 'student_programs', {
      student_id: student1Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: D(-60),
      status: 'ACTIVE',
    });
    const sp2 = await insertIn(T.orgId, 'student_programs', {
      student_id: student2Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: D(-60),
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
      valid_from: D(-30),
      source: 'MANUAL',
      registration_kind: 'REGULAR',
    });
    await insertIn(T.orgId, 'course_registrations', {
      term_enrollment_id: eid2,
      student_id: student2Id,
      course_offering_id: offeringId,
      status: 'REGISTERED',
      valid_from: D(-30),
      source: 'MANUAL',
      registration_kind: 'REGULAR',
    });

    // Logins
    s.admin = await login(T.emails.admin);
    s.teacherAssigned = await login(T.emails.faculty);
    s.teacherUnassigned = await login(f2Email);
    s.student1 = await login(T.emails.studentOne);
    s.student2 = await login(T.emails.studentTwo);
    s.otherAdmin = await login(OTHER.emails.admin);

    // Create 10 sessions and mark attendance via the official endpoints:
    // Student 1: 8 Present, 2 Absent = 80% (meets 75%)
    // Student 2: 6 Present, 4 Absent = 60% (below 75%)
    for (let i = 1; i <= 10; i++) {
      const sessDate = D(-25 + i);
      const sessRes = await createSession(s.teacherAssigned, {
        courseOfferingId: offeringId,
        sessionDate: sessDate,
        ...slot(sessDate, 10),
      });
      expect(sessRes.statusCode, sessRes.body).toBe(201);
      const sessId = sessRes.json<{ data: { id: string } }>().data.id;

      const s1Status = i <= 8 ? 'PRESENT' : 'ABSENT';
      const s2Status = i <= 6 ? 'PRESENT' : 'ABSENT';

      const subRes = await submitAttendance(s.teacherAssigned, sessId, [
        { studentId: student1Id, status: s1Status },
        { studentId: student2Id, status: s2Status },
      ]);
      expect(subRes.statusCode, subRes.body).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('1. creates examination and schedule for eligibility evaluation', async () => {
    const examRes = await call('POST', s.admin, '/examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Mid-Term Examinations 2026',
      exam_type: 'MID_TERM',
      starts_on: D(-5),
      ends_on: D(10),
    });
    expect(examRes.statusCode).toBe(201);
    examId = examRes.json<{ data: IdDto }>().data.id;

    const schedRes = await call('POST', s.admin, `/examinations/${examId}/schedules`, {
      course_offering_id: offeringId,
      exam_date: D(-4),
      max_marks: 100,
      pass_marks: 40,
    });
    expect(schedRes.statusCode).toBe(201);
    scheduleId = schedRes.json<{ data: IdDto }>().data.id;
  });

  it('2. sets and retrieves custom eligibility policy (75% attendance threshold)', async () => {
    const putPolicy = await call(
      'PUT',
      s.admin,
      `/examinations/schedules/${scheduleId}/eligibility-policy`,
      {
        name: 'Mid-Term Attendance Policy',
        min_attendance_percentage: 75,
        check_attendance: true,
        check_fees: false,
        attendance_cutoff_days_prior: 0,
        allow_late_enrolment_review: true,
      },
    );
    expect(putPolicy.statusCode).toBe(200);
    expect(Number(putPolicy.json<{ data: PolicyDto }>().data.min_attendance_percentage)).toBe(75);

    const getPolicy = await call(
      'GET',
      s.admin,
      `/examinations/schedules/${scheduleId}/eligibility-policy`,
    );
    expect(getPolicy.statusCode).toBe(200);
    expect(getPolicy.json<{ data: { name: string } }>().data.name).toBe(
      'Mid-Term Attendance Policy',
    );
  });

  it('3. automatically generates candidates and evaluates attendance threshold', async () => {
    const genRes = await call(
      'POST',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/generate`,
      {
        cutoff_date: D(-10),
      },
    );
    expect(genRes.statusCode).toBe(201);
    const body = genRes.json<{
      data: CandidateListDto & { list: { total_candidates: number; status: string } };
    }>().data;
    candidateListId = body.list.id;
    expect(body.list.total_candidates).toBe(2);
    expect(body.list.eligible_count).toBe(1);
    expect(body.list.not_eligible_count).toBe(1);
    expect(body.list.status).toBe('DRAFT');

    // Verify candidate 1: Student 1 (80% attendance >= 75%)
    const cand1 = body.candidates.find((c) => c.student_id === student1Id);
    expect(cand1).toBeDefined();
    expect(cand1?.evaluation_status).toBe('ELIGIBLE');
    expect(cand1?.final_status).toBe('ELIGIBLE');
    expect(cand1?.evidence_summary.attendance_percentage).toBe(80);
    expect(cand1?.candidate_id).toBeTruthy();

    // Verify candidate 2: Student 2 (60% attendance < 75%)
    const cand2 = body.candidates.find((c) => c.student_id === student2Id);
    expect(cand2).toBeDefined();
    expect(cand2?.evaluation_status).toBe('NOT_ELIGIBLE');
    expect(cand2?.final_status).toBe('NOT_ELIGIBLE');
    expect(cand2?.evidence_summary.attendance_percentage).toBe(60);
    candidate2Id = cand2?.candidate_id ?? '';
  });

  it('4. student can inspect own candidate status but not peers', async () => {
    const res1 = await call('GET', s.student1, `/examinations/schedules/${scheduleId}/candidates`);
    expect(res1.statusCode).toBe(200);
    const list1 = res1.json<{ data: { candidates: CandidateItemDto[] } }>().data.candidates;
    expect(list1.length).toBe(1);
    expect(list1[0]?.student_id).toBe(student1Id);

    const res2 = await call('GET', s.student2, `/examinations/schedules/${scheduleId}/candidates`);
    expect(res2.statusCode).toBe(200);
    const list2 = res2.json<{ data: { candidates: CandidateItemDto[] } }>().data.candidates;
    expect(list2.length).toBe(1);
    expect(list2[0]?.student_id).toBe(student2Id);
  });

  it('5. prevents unauthorized teacher or student from overriding candidate status', async () => {
    const overrideTeacher = await call(
      'PATCH',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/candidates/${candidate2Id}/override`,
      {
        override_status: 'EXEMPTED',
        override_reason: 'Teacher approved medical exemption',
      },
    );
    expect(overrideTeacher.statusCode).toBe(403);

    const overrideStudent = await call(
      'PATCH',
      s.student2,
      `/examinations/schedules/${scheduleId}/candidates/${candidate2Id}/override`,
      {
        override_status: 'EXEMPTED',
        override_reason: 'Self exemption',
      },
    );
    expect(overrideStudent.statusCode).toBe(403);
  });

  it('6. applies authorized administrative exemption override', async () => {
    const overrideRes = await call(
      'PATCH',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/${candidate2Id}/override`,
      {
        override_status: 'EXEMPTED',
        override_reason: 'Approved institutional sports tournament representation',
      },
    );
    expect(overrideRes.statusCode).toBe(200);
    const updated = overrideRes.json<{ data: CandidateItemDto }>().data;
    expect(updated.override_status).toBe('EXEMPTED');
    expect(updated.final_status).toBe('ELIGIBLE');

    // Verify candidate list summary updated
    const candListRes = await call(
      'GET',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates`,
    );
    expect(candListRes.statusCode).toBe(200);
    expect(candListRes.json<{ data: CandidateListDto }>().data.list.eligible_count).toBe(2);
    expect(candListRes.json<{ data: CandidateListDto }>().data.list.not_eligible_count).toBe(0);
  });

  it('7. approves candidate list', async () => {
    const appRes = await call(
      'POST',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/${candidateListId}/approve`,
      { freeze: false },
    );
    expect(appRes.statusCode).toBe(200);
    expect(appRes.json<{ data: { status: string } }>().data.status).toBe('APPROVED');
  });

  it('8. teacher can enter marks for approved eligible candidates', async () => {
    const marksRes = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            marks_obtained: 85,
            status: 'ENTERED',
            remarks: 'Strong performance',
          },
          {
            student_id: student2Id,
            marks_obtained: 72,
            status: 'ENTERED',
            remarks: 'Exempted candidate marks entered',
          },
        ],
      },
    );
    expect(marksRes.statusCode).toBe(200);
    expect(marksRes.json<{ data: EntriesUpdatedDto }>().data.entries_updated).toBe(2);
  });

  it('9. blocks marks entry when student is disqualified or not eligible', async () => {
    // Admin disqualifies Student 2
    const disqRes = await call(
      'PATCH',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/${candidate2Id}/override`,
      {
        override_status: 'DISQUALIFIED',
        override_reason: 'Disciplinary suspension during exam week',
      },
    );
    expect(disqRes.statusCode).toBe(200);
    expect(disqRes.json<{ data: CandidateItemDto }>().data.final_status).toBe('NOT_ELIGIBLE');

    // Teacher tries to enter marks for Student 2
    const marksFail = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student2Id,
            marks_obtained: 50,
            status: 'ENTERED',
          },
        ],
      },
    );
    expect(marksFail.statusCode).toBe(422);
    expect(marksFail.json<ErrorDto>().error.code).toBe('STUDENT_NOT_ELIGIBLE');

    // Student 1 remains eligible and can still have marks entered
    const marksOk = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${scheduleId}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            marks_obtained: 90,
            status: 'ENTERED',
          },
        ],
      },
    );
    expect(marksOk.statusCode).toBe(200);
  });

  it('10. freezing candidate list prevents subsequent overrides', async () => {
    // Freeze the candidate list
    const freezeRes = await call(
      'POST',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/${candidateListId}/approve`,
      { freeze: true },
    );
    expect(freezeRes.statusCode).toBe(200);
    expect(freezeRes.json<{ data: { status: string } }>().data.status).toBe('FROZEN');

    // Attempting override on frozen list returns 409 Conflict
    const tryOverride = await call(
      'PATCH',
      s.admin,
      `/examinations/schedules/${scheduleId}/candidates/${candidate2Id}/override`,
      {
        override_status: 'EXEMPTED',
        override_reason: 'Late medical note presented',
      },
    );
    expect(tryOverride.statusCode).toBe(409);
  });

  it('11. legacy schedule without candidate list allows marks entry for all enrolled students', async () => {
    // Create new course offering and schedule with NO candidate list
    const course2 = await insertIn(T.orgId, 'courses', {
      owning_department_id: T.departmentId,
      code: code('C2'),
      title: 'Database Systems',
      credits: 3,
      course_type: 'THEORY',
    });
    const off2Res = await call('POST', await login(T.emails.admin), '/academics/course-offerings', {
      termId,
      courseId: course2,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    expect(off2Res.statusCode).toBe(201);
    const offering2 = off2Res.json<{ data: { id: string } }>().data.id;

    await call(
      'PATCH',
      await login(T.emails.admin),
      `/academics/course-offerings/${offering2}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );

    const emp1Id = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.employees WHERE organization_id = $1 AND employee_code LIKE '%E1%'`,
        [T.orgId],
      )
    )[0]!.id;

    await insertIn(T.orgId, 'faculty_assignments', {
      course_offering_id: offering2,
      employee_id: emp1Id,
      role: 'PRIMARY',
      valid_from: D(-60),
    });

    const eid1 = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.term_enrollments WHERE organization_id = $1 AND student_id = $2`,
        [T.orgId, student1Id],
      )
    )[0]!.id;

    await insertIn(T.orgId, 'course_registrations', {
      term_enrollment_id: eid1,
      student_id: student1Id,
      course_offering_id: offering2,
      status: 'REGISTERED',
      valid_from: D(-30),
      source: 'MANUAL',
      registration_kind: 'REGULAR',
    });

    const sched2Res = await call('POST', s.admin, `/examinations/${examId}/schedules`, {
      course_offering_id: offering2,
      exam_date: D(-2),
      max_marks: 50,
      pass_marks: 20,
    });
    expect(sched2Res.statusCode).toBe(201);
    const sched2Id = sched2Res.json<{ data: IdDto }>().data.id;

    // Direct marks entry succeeds without candidate list
    const marksRes = await call(
      'POST',
      s.teacherAssigned,
      `/examinations/schedules/${sched2Id}/marks`,
      {
        action: 'DRAFT',
        entries: [
          {
            student_id: student1Id,
            marks_obtained: 45,
            status: 'ENTERED',
          },
        ],
      },
    );
    expect(marksRes.statusCode).toBe(200);
    expect(marksRes.json<{ data: EntriesUpdatedDto }>().data.entries_updated).toBe(1);
  });

  it('12. isolates cross-tenant candidate and policy requests', async () => {
    // Other admin cannot access this schedule's policy
    const crossPol = await call(
      'GET',
      s.otherAdmin,
      `/examinations/schedules/${scheduleId}/eligibility-policy`,
    );
    expect(crossPol.statusCode).toBe(404);

    // Other admin cannot generate candidates
    const crossGen = await call(
      'POST',
      s.otherAdmin,
      `/examinations/schedules/${scheduleId}/candidates/generate`,
      { cutoff_date: D(-10) },
    );
    expect(crossGen.statusCode).toBe(404);

    // Other admin cannot read candidates
    const crossCand = await call(
      'GET',
      s.otherAdmin,
      `/examinations/schedules/${scheduleId}/candidates`,
    );
    expect(crossCand.statusCode).toBe(404);
  });
});
