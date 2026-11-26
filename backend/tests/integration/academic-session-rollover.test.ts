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
interface Session {
  cookie: string;
  csrf: string;
}
const s = {} as Record<'admin' | 'campusAdmin' | 'foreignAdmin', Session>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

// IDs for the test school environment
const SC = {} as Record<
  | 'campus'
  | 'dept'
  | 'program'
  | 'cohortG6'
  | 'cohortJuniorG6'
  | 'cohortG10'
  | 'cohortG12'
  | 's26'
  | 's27'
  | 'cp6_s26'
  | 'cp7_s27'
  | 'cp6_s27'
  | 'cp10_s26'
  | 'cp11_s27'
  | 'cp12_s26'
  | 'sec6A'
  | 'sec7A'
  | 'sec6Repeat'
  | 'sec10A'
  | 'sec11Sci'
  | 'sec12A'
  | 'cMath'
  | 'cSci'
  | 'cEng'
  | 'offMath'
  | 'offSci'
  | 'offEng'
  | 'exam'
  | 'schMath'
  | 'schSci'
  | 'schEng',
  string
>;

const students = {} as Record<
  'stu1_promoted' | 'stu2_retained' | 'stu3_draft' | 'stu4_stream' | 'stu5_graduated',
  { studentId: string; spId: string; enrollmentId: string }
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
  const vals = [
    id,
    T.orgId,
    ...Object.entries(row)
      .filter(([k]) => k !== 'id')
      .map(([, v]) => v),
  ];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  return id;
}

async function account(name: string): Promise<string> {
  const user = uuidv7();
  const email = `cp-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [user, T.orgId, email, name],
  );
  return user;
}

async function createStudentWithProgram(name: string, cohortId: string, admNo: string) {
  const userId = await account(name);
  const studentId = await insert('students', {
    user_id: userId,
    admission_number: admNo,
    admission_date: '2026-11-01',
    status: 'ACTIVE',
  });
  const spId = await insert('student_programs', {
    student_id: studentId,
    program_id: SC.program,
    cohort_id: cohortId,
    campus_id: SC.campus,
    department_id: SC.dept,
    start_date: '2026-11-01',
    status: 'ACTIVE',
  });
  return { studentId, spId };
}

async function enrollStudent(
  student: { studentId: string; spId: string },
  cohortPeriodId: string,
  termId: string,
  periodNo: number,
  sectionId?: string,
) {
  const enrollmentId = await insert('term_enrollments', {
    student_id: student.studentId,
    student_program_id: student.spId,
    cohort_period_id: cohortPeriodId,
    term_id: termId,
    period_no: periodNo,
    status: 'REGISTERED',
  });
  await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [
    enrollmentId,
  ]);

  if (sectionId) {
    await insert('section_memberships', {
      term_enrollment_id: enrollmentId,
      student_id: student.studentId,
      cohort_period_id: cohortPeriodId,
      section_id: sectionId,
      valid_from: '2026-11-01',
      changed_by: T.users.admin,
    });
  }

  return enrollmentId;
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);

  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin);
  s.foreignAdmin = await login(OTHER.emails.admin);

  // 1. Academic Years (non-standard custom school dates)
  const y26 = await insert('academic_years', {
    label: `AY-2026-27-${RUN}`,
    start_date: '2026-06-01',
    end_date: '2027-03-31',
  });
  await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [y26]);

  const y27 = await insert('academic_years', {
    label: `AY-2027-28-${RUN}`,
    start_date: '2027-04-01',
    end_date: '2028-03-31',
  });

  const grade = await insert('period_types', {
    code: `GRD${RUN}`.slice(0, 20),
    label: 'Grade',
    label_plural: 'Grades',
  });

  // 2. School Campus, Department, K-12 Program
  SC.campus = await insert('campuses', {
    name: 'Delhi Public School Model',
    code: code('DPS'),
    timezone: 'Asia/Kolkata',
  });
  SC.dept = await insert('departments', {
    campus_id: SC.campus,
    name: 'School Wing',
    code: code('SCH'),
  });
  SC.program = await insert('programs', {
    department_id: SC.dept,
    period_type_id: grade,
    name: 'CBSE K-12 Curriculum',
    code: code('CBSE'),
    degree_level: 'K12',
    duration_periods: 12,
  });

  // Cohorts for different grades in session 2026-27
  SC.cohortG6 = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2021,
    intake_code: 'MAIN',
    name: 'Class 6 Batch 2021',
  });
  SC.cohortJuniorG6 = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2022,
    intake_code: 'MAIN',
    name: 'Class 6 Batch 2022 Junior',
  });
  SC.cohortG10 = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2017,
    intake_code: 'MAIN',
    name: 'Class 10 Batch 2017',
  });
  SC.cohortG12 = await insert('cohorts', {
    program_id: SC.program,
    admission_year: 2015,
    intake_code: 'MAIN',
    name: 'Class 12 Batch 2015',
  });

  // 3. Terms (Session 2026-27 and Session 2027-28)
  SC.s26 = await insert('terms', {
    campus_id: SC.campus,
    academic_year_id: y26,
    code: `S26-${RUN}`.slice(0, 20),
    name: 'Annual Session 2026-27',
    start_date: '2026-06-01',
    end_date: '2027-03-31',
    status: 'PLANNED',
  });
  await adminQuery(`UPDATE app.terms SET status = 'ACTIVE' WHERE id = $1`, [SC.s26]);

  SC.s27 = await insert('terms', {
    campus_id: SC.campus,
    academic_year_id: y27,
    code: `S27-${RUN}`.slice(0, 20),
    name: 'Annual Session 2027-28',
    start_date: '2027-04-01',
    end_date: '2028-03-31',
    status: 'PLANNED',
  });

  // 4. Cohort Periods:
  SC.cp6_s26 = await insert('cohort_periods', {
    cohort_id: SC.cohortG6,
    term_id: SC.s26,
    period_no: 6,
  });
  SC.cp7_s27 = await insert('cohort_periods', {
    cohort_id: SC.cohortG6,
    term_id: SC.s27,
    period_no: 7,
  });
  SC.cp10_s26 = await insert('cohort_periods', {
    cohort_id: SC.cohortG10,
    term_id: SC.s26,
    period_no: 10,
  });
  SC.cp11_s27 = await insert('cohort_periods', {
    cohort_id: SC.cohortG10,
    term_id: SC.s27,
    period_no: 11,
  });
  SC.cp12_s26 = await insert('cohort_periods', {
    cohort_id: SC.cohortG12,
    term_id: SC.s26,
    period_no: 12,
  });

  // Junior cohort repeating Class 6 in S27
  SC.cp6_s27 = await insert('cohort_periods', {
    cohort_id: SC.cohortJuniorG6,
    term_id: SC.s27,
    period_no: 6,
  });

  // 5. Sections
  SC.sec6A = await insert('sections', { cohort_period_id: SC.cp6_s26, name: '6-A' });
  SC.sec7A = await insert('sections', { cohort_period_id: SC.cp7_s27, name: '7-A' });
  SC.sec6Repeat = await insert('sections', { cohort_period_id: SC.cp6_s27, name: '6-A' });
  SC.sec10A = await insert('sections', { cohort_period_id: SC.cp10_s26, name: '10-A' });
  SC.sec11Sci = await insert('sections', {
    cohort_period_id: SC.cp11_s27,
    name: '11-Science',
  });
  SC.sec12A = await insert('sections', { cohort_period_id: SC.cp12_s26, name: '12-A' });

  // 6. Courses & Course Offerings in S26
  SC.cMath = await insert('courses', {
    owning_department_id: SC.dept,
    code: code('MTH'),
    title: 'Mathematics Grade 6',
    credits: 4.0,
    course_type: 'THEORY',
  });
  SC.cSci = await insert('courses', {
    owning_department_id: SC.dept,
    code: code('SCI'),
    title: 'General Science Grade 6',
    credits: 4.0,
    course_type: 'THEORY',
  });
  SC.cEng = await insert('courses', {
    owning_department_id: SC.dept,
    code: code('ENG'),
    title: 'English Language Grade 6',
    credits: 3.0,
    course_type: 'THEORY',
  });

  SC.offMath = await insert('course_offerings', {
    term_id: SC.s26,
    course_id: SC.cMath,
    campus_id: SC.campus,
    department_id: SC.dept,
    cohort_period_id: SC.cp6_s26,
    offering_kind: 'CORE',
    code_snapshot: 'MTH6',
    title_snapshot: 'Mathematics Grade 6',
    credits_snapshot: 4.0,
    tracks_attendance: true,
    registration_policy: 'MANUAL',
    status: 'DRAFT',
  });
  await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
    SC.offMath,
  ]);

  SC.offSci = await insert('course_offerings', {
    term_id: SC.s26,
    course_id: SC.cSci,
    campus_id: SC.campus,
    department_id: SC.dept,
    cohort_period_id: SC.cp6_s26,
    offering_kind: 'CORE',
    code_snapshot: 'SCI6',
    title_snapshot: 'General Science Grade 6',
    credits_snapshot: 4.0,
    tracks_attendance: true,
    registration_policy: 'MANUAL',
    status: 'DRAFT',
  });
  await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
    SC.offSci,
  ]);

  SC.offEng = await insert('course_offerings', {
    term_id: SC.s26,
    course_id: SC.cEng,
    campus_id: SC.campus,
    department_id: SC.dept,
    cohort_period_id: SC.cp6_s26,
    offering_kind: 'CORE',
    code_snapshot: 'ENG6',
    title_snapshot: 'English Language Grade 6',
    credits_snapshot: 3.0,
    tracks_attendance: true,
    registration_policy: 'MANUAL',
    status: 'DRAFT',
  });
  await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
    SC.offEng,
  ]);

  // 7. Examination and Exam Schedules
  SC.exam = await insert('examinations', {
    campus_id: SC.campus,
    term_id: SC.s26,
    name: 'Annual Final Examination 2027',
    exam_type: 'FINAL',
    starts_on: '2027-02-15',
    ends_on: '2027-03-10',
    status: 'COMPLETED',
    created_by_user_id: T.users.admin,
  });

  SC.schMath = await insert('exam_schedules', {
    examination_id: SC.exam,
    course_offering_id: SC.offMath,
    exam_date: '2027-02-20',
    max_marks: 100,
    pass_marks: 33,
    status: 'SCHEDULED',
  });
  SC.schSci = await insert('exam_schedules', {
    examination_id: SC.exam,
    course_offering_id: SC.offSci,
    exam_date: '2027-02-22',
    max_marks: 100,
    pass_marks: 33,
    status: 'SCHEDULED',
  });
  SC.schEng = await insert('exam_schedules', {
    examination_id: SC.exam,
    course_offering_id: SC.offEng,
    exam_date: '2027-02-25',
    max_marks: 100,
    pass_marks: 33,
    status: 'SCHEDULED',
  });

  // 8. Students:
  // Student 1 (Class 6): High passing marks -> PROMOTED
  const p1 = await createStudentWithProgram('Aarav Sharma', SC.cohortG6, code('AAR'));
  const e1 = await enrollStudent(p1, SC.cp6_s26, SC.s26, 6, SC.sec6A);
  students.stu1_promoted = { studentId: p1.studentId, spId: p1.spId, enrollmentId: e1 };

  await insert('exam_marks', {
    exam_schedule_id: SC.schMath,
    student_id: p1.studentId,
    marks_obtained: 88,
    status: 'SUBMITTED',
    is_passing: true,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schSci,
    student_id: p1.studentId,
    marks_obtained: 82,
    status: 'SUBMITTED',
    is_passing: true,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schEng,
    student_id: p1.studentId,
    marks_obtained: 90,
    status: 'SUBMITTED',
    is_passing: true,
    marked_by_user_id: T.users.admin,
  });

  // Student 2 (Class 6): Failing marks in all subjects -> RETAINED (Repeat)
  const p2 = await createStudentWithProgram('Rohan Verma', SC.cohortG6, code('ROH'));
  const e2 = await enrollStudent(p2, SC.cp6_s26, SC.s26, 6, SC.sec6A);
  students.stu2_retained = { studentId: p2.studentId, spId: p2.spId, enrollmentId: e2 };

  await insert('exam_marks', {
    exam_schedule_id: SC.schMath,
    student_id: p2.studentId,
    marks_obtained: 18,
    status: 'SUBMITTED',
    is_passing: false,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schSci,
    student_id: p2.studentId,
    marks_obtained: 22,
    status: 'SUBMITTED',
    is_passing: false,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schEng,
    student_id: p2.studentId,
    marks_obtained: 25,
    status: 'SUBMITTED',
    is_passing: false,
    marked_by_user_id: T.users.admin,
  });

  // Student 3 (Class 6): Incomplete / DRAFT marks -> PENDING_REVIEW (Safety Gate)
  const p3 = await createStudentWithProgram('Priya Patel', SC.cohortG6, code('PRI'));
  const e3 = await enrollStudent(p3, SC.cp6_s26, SC.s26, 6, SC.sec6A);
  students.stu3_draft = { studentId: p3.studentId, spId: p3.spId, enrollmentId: e3 };

  await insert('exam_marks', {
    exam_schedule_id: SC.schMath,
    student_id: p3.studentId,
    marks_obtained: 75,
    status: 'SUBMITTED',
    is_passing: true,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schSci,
    student_id: p3.studentId,
    marks_obtained: null,
    status: 'DRAFT', // Triggers safety gate!
    is_passing: null,
    marked_by_user_id: T.users.admin,
  });
  await insert('exam_marks', {
    exam_schedule_id: SC.schEng,
    student_id: p3.studentId,
    marks_obtained: 78,
    status: 'SUBMITTED',
    is_passing: true,
    marked_by_user_id: T.users.admin,
  });

  // Student 4 (Class 10): Promoted with Stream Selection
  const p4 = await createStudentWithProgram('Aditya Sen', SC.cohortG10, code('ADI'));
  const e4 = await enrollStudent(p4, SC.cp10_s26, SC.s26, 10, SC.sec10A);
  students.stu4_stream = { studentId: p4.studentId, spId: p4.spId, enrollmentId: e4 };

  // Student 5 (Class 12): Terminal program completion -> GRADUATED
  const p5 = await createStudentWithProgram('Ananya Roy', SC.cohortG12, code('ANA'));
  const e5 = await enrollStudent(p5, SC.cp12_s26, SC.s26, 12, SC.sec12A);
  students.stu5_graduated = { studentId: p5.studentId, spId: p5.spId, enrollmentId: e5 };

  // Publish exam schedules now that marks are entered
  await adminQuery(`UPDATE app.exam_schedules SET status = 'PUBLISHED' WHERE id IN ($1, $2, $3)`, [
    SC.schMath,
    SC.schSci,
    SC.schEng,
  ]);
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'exam_marks',
      'exam_schedules',
      'examinations',
      'course_offerings',
      'courses',
      'section_memberships',
      'sections',
      'term_enrollments',
      'cohort_periods',
      'terms',
      'cohorts',
      'student_programs',
      'students',
      'programs',
      'period_types',
      'academic_years',
      'departments',
      'campuses',
      'organization_settings',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
});

describe('Automatic Academic Year Promotion & Session Rollover System', () => {
  let createdBatchId: string;

  it('retrieves and updates institution promotion policy with custom rules', async () => {
    // 1. Get default policy
    const getRes = await call('GET', s.admin, '/academics/promotion-policy');
    expect(getRes.statusCode).toBe(200);
    const policy = getRes.json<{ data: { mode: string; minimumAggregatePercentage: number } }>()
      .data;
    expect(policy.mode).toBe('PRINCIPAL_APPROVAL');
    expect(policy.minimumAggregatePercentage).toBe(33.0);

    // 2. Update policy with custom rules
    const putRes = await call('PUT', s.admin, '/academics/promotion-policy', {
      mode: 'PRINCIPAL_APPROVAL',
      minimumAggregatePercentage: 35.0,
      minimumSubjectPercentage: 35.0,
      maxFailingSubjectsForSupplementary: 2,
      graceMarksPolicy: {
        enabled: true,
        maxGraceMarksTotal: 6,
        maxGraceMarksPerSubject: 4,
      },
      streamSelectionPeriodNo: 10,
      terminalPeriodNo: 12,
      notifyGuardians: true,
    });
    expect(putRes.statusCode, putRes.body).toBe(200);
    const updated = putRes.json<{ data: { minimumAggregatePercentage: number } }>().data;
    expect(updated.minimumAggregatePercentage).toBe(35.0);
  });

  it('generates promotion preview with accurate 4-bucket classification and fail-closed safety gates', async () => {
    const res = await call('POST', s.admin, '/academics/rollover/preview', {
      sourceTermId: SC.s26,
      targetTermId: SC.s27,
      streamPreferences: [
        {
          studentId: students.stu4_stream.studentId,
          targetCohortPeriodId: SC.cp11_s27,
          targetSectionId: SC.sec11Sci,
        },
      ],
    });

    expect(res.statusCode, res.body).toBe(200);
    const batch = res.json<{
      data: {
        batchId: string;
        status: string;
        summary: {
          totalStudents: number;
          promoted: number;
          retained: number;
          pendingReview: number;
          graduated: number;
        };
        students: Array<{
          studentId: string;
          recommendedOutcome: string;
          finalOutcome: string;
          targetPeriodNo: number | null;
          evaluationDetails: {
            hasMissingMarks: boolean;
            aggregatePercentage: number | null;
            notes: string[];
          };
        }>;
      };
    }>().data;

    createdBatchId = batch.batchId;
    expect(batch.batchId).toBeDefined();
    expect(batch.status).toBe('PENDING_APPROVAL');

    // Summary counts check
    expect(batch.summary.totalStudents).toBe(5);
    expect(batch.summary.promoted).toBe(2); // Student 1 and Student 4
    expect(batch.summary.retained).toBe(1); // Student 2
    expect(batch.summary.pendingReview).toBe(1); // Student 3 (draft marks)
    expect(batch.summary.graduated).toBe(1); // Student 5 (Class 12)

    // Student 1 (Aarav): PROMOTED with 86.67% aggregate
    const s1 = batch.students.find((s) => s.studentId === students.stu1_promoted.studentId);
    expect(s1).toBeDefined();
    expect(s1!.recommendedOutcome).toBe('PROMOTED');
    expect(s1!.finalOutcome).toBe('PROMOTED');
    expect(s1!.targetPeriodNo).toBe(7);

    // Student 2 (Rohan): RETAINED (Failed all 3 subjects)
    const s2 = batch.students.find((s) => s.studentId === students.stu2_retained.studentId);
    expect(s2).toBeDefined();
    expect(s2!.recommendedOutcome).toBe('RETAINED');
    expect(s2!.targetPeriodNo).toBe(6);

    // Student 3 (Priya): PENDING_REVIEW (Draft marks trigger safety gate)
    const s3 = batch.students.find((s) => s.studentId === students.stu3_draft.studentId);
    expect(s3).toBeDefined();
    expect(s3!.recommendedOutcome).toBe('PENDING_REVIEW');
    expect(s3!.evaluationDetails.hasMissingMarks).toBe(true);

    // Student 4 (Aditya): Class 10 -> Class 11 Science Stream
    const s4 = batch.students.find((s) => s.studentId === students.stu4_stream.studentId);
    expect(s4).toBeDefined();
    expect(s4!.recommendedOutcome).toBe('PROMOTED');
    expect(s4!.targetPeriodNo).toBe(11);

    // Student 5 (Ananya): Class 12 -> GRADUATED
    const s5 = batch.students.find((s) => s.studentId === students.stu5_graduated.studentId);
    expect(s5).toBeDefined();
    expect(s5!.recommendedOutcome).toBe('GRADUATED');
    expect(s5!.targetPeriodNo).toBeNull();
  });

  it('allows Principal exception override and transitions batch to APPROVED', async () => {
    // Principal reviews Student 3 (Priya) who cleared supplementary examination
    const res = await call(
      'PATCH',
      s.admin,
      `/academics/rollover/preview/${createdBatchId}/exceptions`,
      {
        exceptions: [
          {
            studentId: students.stu3_draft.studentId,
            outcome: 'PROMOTED',
            reason: 'Cleared re-examination with 72% marks on 2027-03-25',
            targetCohortPeriodId: SC.cp7_s27,
            targetSectionId: SC.sec7A,
          },
        ],
      },
    );

    expect(res.statusCode, res.body).toBe(200);
    const updated = res.json<{
      data: {
        status: string;
        summary: {
          promoted: number;
          retained: number;
          pendingReview: number;
          graduated: number;
        };
        students: Array<{
          studentId: string;
          finalOutcome: string;
          overrideReason: string | null;
        }>;
      };
    }>().data;

    expect(updated.status).toBe('APPROVED');
    expect(updated.summary.promoted).toBe(3);
    expect(updated.summary.pendingReview).toBe(0);

    const s3 = updated.students.find((s) => s.studentId === students.stu3_draft.studentId);
    expect(s3!.finalOutcome).toBe('PROMOTED');
    expect(s3!.overrideReason).toBe('Cleared re-examination with 72% marks on 2027-03-25');
  });

  it('executes rollover batch atomically and updates student lifecycle correctly', async () => {
    const res = await call('POST', s.admin, '/academics/rollover/execute', {
      batchId: createdBatchId,
      notifyGuardians: true,
    });

    expect(res.statusCode, res.body).toBe(200);
    const result = res.json<{
      data: {
        promotedCount: number;
        retainedCount: number;
        graduatedCount: number;
        skippedCount: number;
      };
    }>().data;

    expect(result.promotedCount).toBe(3);
    expect(result.retainedCount).toBe(1);
    expect(result.graduatedCount).toBe(1);
    expect(result.skippedCount).toBe(0);

    // 1. Verify Promoted Student 1 (Aarav):
    // Source enrollment marked PROMOTED
    const enr1Old = await adminQuery<{ status: string }>(
      `SELECT status FROM app.term_enrollments WHERE id = $1`,
      [students.stu1_promoted.enrollmentId],
    );
    expect(enr1Old[0]?.status).toBe('PROMOTED');

    // New enrollment created in S27 for Class 7
    const enr1New = await adminQuery<{
      period_no: number;
      status: string;
      enrollment_type: string;
      term_id: string;
    }>(
      `SELECT period_no, status, enrollment_type, term_id
         FROM app.term_enrollments
        WHERE organization_id = $1 AND student_id = $2 AND term_id = $3`,
      [T.orgId, students.stu1_promoted.studentId, SC.s27],
    );
    expect(enr1New.length).toBe(1);
    expect(enr1New[0]?.period_no).toBe(7);
    expect(enr1New[0]?.status).toBe('REGISTERED');
    expect(enr1New[0]?.enrollment_type).toBe('REGULAR');

    // 2. Verify Retained Student 2 (Rohan):
    // Source enrollment marked COMPLETED
    const enr2Old = await adminQuery<{ status: string }>(
      `SELECT status FROM app.term_enrollments WHERE id = $1`,
      [students.stu2_retained.enrollmentId],
    );
    expect(enr2Old[0]?.status).toBe('COMPLETED');

    // New repeat enrollment created in junior cohort for Class 6 in S27
    const enr2New = await adminQuery<{
      period_no: number;
      status: string;
      enrollment_type: string;
      cohort_period_id: string;
    }>(
      `SELECT period_no, status, enrollment_type, cohort_period_id
         FROM app.term_enrollments
        WHERE organization_id = $1 AND student_id = $2 AND term_id = $3`,
      [T.orgId, students.stu2_retained.studentId, SC.s27],
    );
    expect(enr2New.length).toBe(1);
    expect(enr2New[0]?.period_no).toBe(6);
    expect(enr2New[0]?.enrollment_type).toBe('REPEAT');
    expect(enr2New[0]?.cohort_period_id).toBe(SC.cp6_s27);

    // 3. Verify Graduated Student 5 (Ananya):
    // Source enrollment marked COMPLETED
    const enr5Old = await adminQuery<{ status: string }>(
      `SELECT status FROM app.term_enrollments WHERE id = $1`,
      [students.stu5_graduated.enrollmentId],
    );
    expect(enr5Old[0]?.status).toBe('COMPLETED');

    // Student program status completed via StudentProgramService (with version increment, CLOSED event, and audit)!
    const prog5 = await adminQuery<{
      status: string;
      exit_reason: string | null;
      version: number;
      end_date: string | null;
    }>(
      `SELECT status, exit_reason, version, end_date::text FROM app.student_programs WHERE id = $1`,
      [students.stu5_graduated.spId],
    );
    expect(prog5[0]?.status).toBe('COMPLETED');
    expect(prog5[0]?.exit_reason).toBe('Graduated');
    expect(prog5[0]?.version).toBe(2);
    expect(prog5[0]?.end_date).toBe('2027-03-31');

    const spEvents5 = await adminQuery<{
      event_type: string;
      from_status: string | null;
      to_status: string;
      reason: string | null;
    }>(
      `SELECT event_type, from_status, to_status, reason
         FROM app.student_program_events
        WHERE organization_id = $1 AND student_program_id = $2`,
      [T.orgId, students.stu5_graduated.spId],
    );
    expect(spEvents5).toEqual([
      {
        event_type: 'CLOSED',
        from_status: 'ACTIVE',
        to_status: 'COMPLETED',
        reason: 'Graduated',
      },
    ]);

    const spAudit5 = await adminQuery<{ action: string }>(
      `SELECT action FROM app.audit_events
        WHERE organization_id = $1 AND resource_type = 'student_program' AND resource_id = $2`,
      [T.orgId, students.stu5_graduated.spId],
    );
    expect(spAudit5.map((a) => a.action)).toEqual(['student_program.close']);

    // No live enrollment in target term S27
    const enr5New = await adminQuery(
      `SELECT id FROM app.term_enrollments WHERE organization_id = $1 AND student_id = $2 AND term_id = $3`,
      [T.orgId, students.stu5_graduated.studentId, SC.s27],
    );
    expect(enr5New.length).toBe(0);
  });

  it('safely handles idempotent re-execution without duplicate records', async () => {
    const replayRes = await call('POST', s.admin, '/academics/rollover/execute', {
      batchId: createdBatchId,
    });
    expect(replayRes.statusCode).toBe(200);
    const result = replayRes.json<{ data: { promotedCount: number } }>().data;
    expect(result.promotedCount).toBe(3);

    // Confirm student 1 still only has 1 enrollment in S27
    const enr1Count = await adminQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.term_enrollments WHERE organization_id = $1 AND student_id = $2 AND term_id = $3`,
      [T.orgId, students.stu1_promoted.studentId, SC.s27],
    );
    expect(enr1Count[0]?.count).toBe('1');

    // Confirm graduated student 5 still has only 1 CLOSED program event and 1 student_program.close audit event
    const spEventCount5 = await adminQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.student_program_events WHERE organization_id = $1 AND student_program_id = $2`,
      [T.orgId, students.stu5_graduated.spId],
    );
    expect(spEventCount5[0]?.count).toBe('1');

    const spAuditCount5 = await adminQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.audit_events WHERE organization_id = $1 AND resource_type = 'student_program' AND resource_id = $2 AND action = 'student_program.close'`,
      [T.orgId, students.stu5_graduated.spId],
    );
    expect(spAuditCount5[0]?.count).toBe('1');
  });

  it('lists rollover batch in history and provides audit trail', async () => {
    // List batches
    const listRes = await call('GET', s.admin, '/academics/rollover/batches');
    expect(listRes.statusCode).toBe(200);
    const batches = listRes.json<{ data: Array<{ batchId: string; status: string }> }>().data;
    expect(batches.length).toBeGreaterThanOrEqual(1);
    const found = batches.find((b) => b.batchId === createdBatchId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('EXECUTED');

    // Single batch detail
    const detailRes = await call('GET', s.admin, `/academics/rollover/batches/${createdBatchId}`);
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json<{ data: { batchId: string; status: string } }>().data;
    expect(detail.batchId).toBe(createdBatchId);
    expect(detail.status).toBe('EXECUTED');

    // Audit log check
    const audits = await adminQuery<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE organization_id = $1 AND action LIKE 'academic.session.%'`,
      [T.orgId],
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('academic.session.rollover_preview');
    expect(actions).toContain('academic.session.rollover');
  });

  it('enforces tenant isolation preventing foreign tenant access', async () => {
    const crossRes = await call(
      'GET',
      s.foreignAdmin,
      `/academics/rollover/batches/${createdBatchId}`,
    );
    expect(crossRes.statusCode).toBe(404);
  });
});
