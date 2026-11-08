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

const s = {} as Record<'admin' | 'student1' | 'otherAdmin', Session>;

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

describe('Essential Administrative Reports — Slice 1', () => {
  let yearId = '';
  let termId = '';
  let courseId = '';
  let offeringId = '';
  let examId = '';
  let scheduleId = '';

  beforeAll(async () => {
    await app.ready();
    HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    T = await createIsolatedTenant(HASH);
    OTHER = await createIsolatedTenant(HASH);

    // Setup academic year and term
    yearId = await insertIn(T.orgId, 'academic_years', {
      label: `AY-${RUN}`,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [yearId]);

    termId = await insertIn(T.orgId, 'terms', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: code('T1'),
      name: 'Term 1',
      start_date: '2026-06-01',
      end_date: '2026-12-31',
    });
    await activateTermFixture(termId);

    // Setup period_type, program, cohort, cohort_period
    const ptId = await insertIn(T.orgId, 'period_types', {
      label: 'Semester',
      label_plural: 'Semesters',
      code: code('SEM'),
    });
    const progId = await insertIn(T.orgId, 'programs', {
      department_id: T.departmentId,
      period_type_id: ptId,
      name: 'Computer Science',
      code: code('CS'),
      degree_level: 'UG',
      duration_periods: 8,
    });
    const cohortId = await insertIn(T.orgId, 'cohorts', {
      program_id: progId,
      admission_year: 2026,
      name: '2026-CS',
    });
    const cpId = await insertIn(T.orgId, 'cohort_periods', {
      cohort_id: cohortId,
      term_id: termId,
      period_no: 1,
    });

    // Setup course and course offering
    courseId = await insertIn(T.orgId, 'courses', {
      owning_department_id: T.departmentId,
      code: code('MATH'),
      title: 'Mathematics I',
      credits: 4,
      course_type: 'THEORY',
      tracks_attendance: true,
      status: 'ACTIVE',
    });

    offeringId = await insertIn(T.orgId, 'course_offerings', {
      campus_id: T.campusId,
      department_id: T.departmentId,
      term_id: termId,
      cohort_period_id: cpId,
      course_id: courseId,
      offering_kind: 'CORE',
      registration_policy: 'MANUAL',
      credits_snapshot: 4,
      tracks_attendance: true,
      code_snapshot: 'MATH101',
      title_snapshot: 'Mathematics I',
      status: 'DRAFT',
    });
    await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
      offeringId,
    ]);

    // Setup Employee (Faculty)
    const empId = await insertIn(T.orgId, 'employees', {
      user_id: T.users.faculty,
      employee_code: code('EMP'),
      employee_type: 'FACULTY',
      joining_date: '2020-06-01',
      status: 'ACTIVE',
    });
    await insertIn(T.orgId, 'employee_postings', {
      employee_id: empId,
      department_id: T.departmentId,
      is_primary: true,
      valid_from: '2020-06-01',
    });

    // Assign faculty to offering
    await insertIn(T.orgId, 'faculty_assignments', {
      course_offering_id: offeringId,
      employee_id: empId,
      role: 'PRIMARY',
      valid_from: '2026-06-01',
    });

    // Enrol students into student_programs & term_enrollments
    const sp1 = await insertIn(T.orgId, 'student_programs', {
      student_id: T.students.one,
      program_id: progId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });
    const te1 = await insertIn(T.orgId, 'term_enrollments', {
      student_id: T.students.one,
      student_program_id: sp1,
      cohort_period_id: cpId,
      term_id: termId,
      period_no: 1,
      roll_number: 'CS-001',
      status: 'REGISTERED',
    });

    const sp2 = await insertIn(T.orgId, 'student_programs', {
      student_id: T.students.two,
      program_id: progId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });
    const te2 = await insertIn(T.orgId, 'term_enrollments', {
      student_id: T.students.two,
      student_program_id: sp2,
      cohort_period_id: cpId,
      term_id: termId,
      period_no: 1,
      roll_number: 'CS-002',
      status: 'REGISTERED',
    });

    // Enrol students into course offering
    const cr1 = await insertIn(T.orgId, 'course_registrations', {
      course_offering_id: offeringId,
      term_enrollment_id: te1,
      student_id: T.students.one,
      valid_from: '2026-06-01',
      source: 'ADMIN',
      registration_kind: 'REGULAR',
      status: 'REGISTERED',
    });
    const cr2 = await insertIn(T.orgId, 'course_registrations', {
      course_offering_id: offeringId,
      term_enrollment_id: te2,
      student_id: T.students.two,
      valid_from: '2026-06-01',
      source: 'ADMIN',
      registration_kind: 'REGULAR',
      status: 'REGISTERED',
    });

    // Create primary guardian for student 1
    await insertIn(T.orgId, 'student_guardians', {
      student_id: T.students.one,
      full_name: 'Dr. Jane Guardian',
      relation: 'MOTHER',
      is_primary: true,
      phone: '+919876543210',
    });

    // Setup Class Session & Attendance
    const sessionId = await insertIn(T.orgId, 'class_sessions', {
      campus_id: T.campusId,
      course_offering_id: offeringId,
      conducted_by_employee_id: empId,
      session_date: '2026-10-15',
      starts_at: '2026-10-15T09:00:00Z',
      ends_at: '2026-10-15T10:00:00Z',
      kind: 'REGULAR',
      attendance_state: 'NOT_STARTED',
      status: 'SCHEDULED',
    });
    await adminQuery(`UPDATE app.class_sessions SET attendance_state = 'OPEN' WHERE id = $1`, [
      sessionId,
    ]);

    const attRec1Id = uuidv7();
    const rev1Id = uuidv7();
    const attRec2Id = uuidv7();
    const rev2Id = uuidv7();

    const pgClient = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await pgClient.connect();
    try {
      await pgClient.query('BEGIN');
      await pgClient.query(
        `INSERT INTO app.attendance_records (id, organization_id, class_session_id, student_id, course_registration_id, course_offering_id, session_date, status, source, marked_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PRESENT', 'MANUAL', $8)`,
        [
          attRec1Id,
          T.orgId,
          sessionId,
          T.students.one,
          cr1,
          offeringId,
          '2026-10-15',
          T.users.admin,
        ],
      );
      await pgClient.query(
        `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code, reason_text)
         VALUES ($1, $2, $3, 1, null, 'PRESENT', 'MANUAL', $4, 'OTHER', 'Initial marking')`,
        [rev1Id, T.orgId, attRec1Id, T.users.admin],
      );
      await pgClient.query(
        `INSERT INTO app.attendance_records (id, organization_id, class_session_id, student_id, course_registration_id, course_offering_id, session_date, status, source, marked_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ABSENT', 'MANUAL', $8)`,
        [
          attRec2Id,
          T.orgId,
          sessionId,
          T.students.two,
          cr2,
          offeringId,
          '2026-10-15',
          T.users.admin,
        ],
      );
      await pgClient.query(
        `INSERT INTO app.attendance_record_revisions (id, organization_id, attendance_record_id, revision_no, status_before, status_after, source, changed_by_user_id, reason_code, reason_text)
         VALUES ($1, $2, $3, 1, null, 'ABSENT', 'MANUAL', $4, 'OTHER', 'Initial marking')`,
        [rev2Id, T.orgId, attRec2Id, T.users.admin],
      );
      await pgClient.query('COMMIT');
    } finally {
      await pgClient.end();
    }

    await adminQuery(
      `UPDATE app.class_sessions
          SET attendance_state = 'SUBMITTED',
              status = 'CONDUCTED',
              attendance_submitted_at = now(),
              attendance_submitted_by = $2
        WHERE id = $1`,
      [sessionId, T.users.admin],
    );

    // Setup second unsubmitted session (missing register)
    await insertIn(T.orgId, 'class_sessions', {
      campus_id: T.campusId,
      course_offering_id: offeringId,
      conducted_by_employee_id: empId,
      session_date: '2026-10-15',
      starts_at: '2026-10-15T11:00:00Z',
      ends_at: '2026-10-15T12:00:00Z',
      kind: 'REGULAR',
      attendance_state: 'NOT_STARTED',
      status: 'SCHEDULED',
    });

    // Setup Examination, Schedule, and Published Marks
    examId = await insertIn(T.orgId, 'examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Mid-Term Examinations 2026',
      exam_type: 'MID_TERM',
      status: 'COMPLETED',
      starts_on: '2026-10-20',
      ends_on: '2026-10-25',
      created_by_user_id: T.users.admin,
    });

    scheduleId = await insertIn(T.orgId, 'exam_schedules', {
      examination_id: examId,
      course_offering_id: offeringId,
      exam_date: '2026-10-20',
      start_time: '10:00',
      end_time: '12:00',
      max_marks: 100,
      pass_marks: 40,
      status: 'DRAFT_MARKS',
    });

    await insertIn(T.orgId, 'exam_marks', {
      exam_schedule_id: scheduleId,
      student_id: T.students.one,
      marks_obtained: 85,
      is_passing: true,
      status: 'SUBMITTED',
      marked_by_user_id: T.users.admin,
    });

    await insertIn(T.orgId, 'exam_marks', {
      exam_schedule_id: scheduleId,
      student_id: T.students.two,
      marks_obtained: 35,
      is_passing: false,
      status: 'SUBMITTED',
      marked_by_user_id: T.users.admin,
    });

    // Now publish the schedule
    await adminQuery(
      `UPDATE app.exam_schedules
          SET status = 'PUBLISHED',
              published_at = now(),
              published_by_user_id = $2
        WHERE id = $1`,
      [scheduleId, T.users.admin],
    );

    // Setup Fee Structures, Dues, and Receipts
    const catId = await insertIn(T.orgId, 'fee_categories', {
      code: code('TUITION'),
      name: 'Tuition Fee',
      is_active: true,
    });

    const structId = await insertIn(T.orgId, 'fee_structures', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: code('FS_REPORT'),
      name: 'Standard Fee Structure',
      currency: 'INR',
      due_date: '2026-11-15',
      created_by_user_id: T.users.admin,
    });

    await insertIn(T.orgId, 'fee_structure_components', {
      fee_structure_id: structId,
      fee_category_id: catId,
      amount: 500000,
    });

    // Student 1 Due (Partial payment)
    const due1Id = await insertIn(T.orgId, 'student_dues', {
      campus_id: T.campusId,
      student_id: T.students.one,
      fee_structure_id: structId,
      academic_year_id: yearId,
      due_number: code('DUE1'),
      gross_amount: 500000,
      discount_amount: 0,
      net_amount: 500000,
      paid_amount: 300000,
      balance_amount: 200000,
      status: 'PARTIAL',
      due_date: '2026-11-15',
      generated_by_user_id: T.users.admin,
    });

    // Confirmed cash receipt for student 1
    const rec1Id = await insertIn(T.orgId, 'fee_receipts', {
      campus_id: T.campusId,
      student_id: T.students.one,
      receipt_number: code('REC1'),
      payment_date: '2026-10-18',
      payment_method: 'CASH',
      amount: 300000,
      currency: 'INR',
      reconciliation_status: 'CONFIRMED',
      status: 'POSTED',
      received_by_user_id: T.users.admin,
    });

    await insertIn(T.orgId, 'fee_receipt_allocations', {
      receipt_id: rec1Id,
      student_due_id: due1Id,
      allocated_amount: 300000,
    });

    // Student 2 Due (Full pending)
    await insertIn(T.orgId, 'student_dues', {
      campus_id: T.campusId,
      student_id: T.students.two,
      fee_structure_id: structId,
      academic_year_id: yearId,
      due_number: code('DUE2'),
      gross_amount: 500000,
      discount_amount: 0,
      net_amount: 500000,
      paid_amount: 0,
      balance_amount: 500000,
      status: 'PENDING',
      due_date: '2026-11-15',
      generated_by_user_id: T.users.admin,
    });

    // In-flight unverified cheque receipt for student 2 (awaiting reconciliation)
    await insertIn(T.orgId, 'fee_receipts', {
      campus_id: T.campusId,
      student_id: T.students.two,
      receipt_number: code('REC2'),
      payment_date: '2026-10-19',
      payment_method: 'CHEQUE',
      amount: 500000,
      currency: 'INR',
      reference_number: 'CHQ-987654',
      reconciliation_status: 'PENDING_VERIFICATION',
      status: 'POSTED',
      received_by_user_id: T.users.admin,
    });

    // Login sessions
    s.admin = await login(T.emails.admin);
    s.student1 = await login(T.emails.studentOne);
    s.otherAdmin = await login(OTHER.emails.admin);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('1. generates student enrolment roster with terminology and guardian contact info', async () => {
    const res = await call('GET', s.admin, `/reports/enrolment-roster?campus_id=${T.campusId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        summary: { total_students: number; active_students: number };
        students: Array<{
          student_id: string;
          admission_number: string;
          primary_guardian_name: string | null;
          primary_guardian_phone: string | null;
          guardian_count: number;
        }>;
      };
    }>();

    expect(body.data.summary.total_students).toBeGreaterThanOrEqual(2);
    const s1 = body.data.students.find((s) => s.student_id === T.students.one);
    expect(s1).toBeDefined();
    // Privacy boundary: general enrolment roster excludes personal guardian contact information
    expect(s1?.guardian_count).toBe(0);
    expect(s1?.primary_guardian_name).toBeNull();
    expect(s1?.primary_guardian_phone).toBeNull();

    // CSV format test
    const csvRes = await call(
      'GET',
      s.admin,
      `/reports/enrolment-roster?campus_id=${T.campusId}&format=csv`,
    );
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('Admission No,Student Name,Campus');
    expect(csvRes.body).not.toContain('+919876543210');
    expect(csvRes.body).not.toContain('Dr. Jane Guardian');
  });

  it('2. generates daily attendance summary with conducted sessions vs missing registers', async () => {
    const res = await call(
      'GET',
      s.admin,
      `/reports/attendance-summary?campus_id=${T.campusId}&date=2026-10-15`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        summary: {
          total_sessions_scheduled: number;
          total_sessions_conducted: number;
          missing_registers_count: number;
          present_count: number;
          absent_count: number;
          attendance_rate: number;
        };
        sessions: Array<{
          session_id: string;
          course_name: string;
          attendance_state: string;
          present_count: number;
          absent_count: number;
        }>;
      };
    }>();

    expect(body.data.summary.total_sessions_scheduled).toBe(2);
    expect(body.data.summary.total_sessions_conducted).toBe(1);
    expect(body.data.summary.missing_registers_count).toBe(1);
    expect(body.data.summary.present_count).toBe(1);
    expect(body.data.summary.absent_count).toBe(1);
    expect(body.data.summary.attendance_rate).toBe(50); // 1 present out of 2 total marks

    // CSV format test
    const csvRes = await call(
      'GET',
      s.admin,
      `/reports/attendance-summary?campus_id=${T.campusId}&date=2026-10-15&format=csv`,
    );
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('Date,Campus,Course,Code,Faculty');
    expect(csvRes.body).toContain('Mathematics I');
  });

  it('3. generates examination marks summary strictly honoring published status', async () => {
    const res = await call('GET', s.admin, `/reports/exam-performance?campus_id=${T.campusId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        summary: {
          total_published_exams: number;
          total_candidates_appeared: number;
          total_passed: number;
          total_failed: number;
          overall_pass_percentage: number;
          average_score: number;
        };
        schedules: Array<{
          schedule_id: string;
          course_name: string;
          appeared_count: number;
          passed_count: number;
          failed_count: number;
          pass_percentage: number;
          highest_marks: number;
          lowest_marks: number;
          average_marks: number;
        }>;
      };
    }>();

    expect(body.data.summary.total_published_exams).toBe(1);
    expect(body.data.summary.total_candidates_appeared).toBe(2);
    expect(body.data.summary.total_passed).toBe(1);
    expect(body.data.summary.total_failed).toBe(1);
    expect(body.data.summary.overall_pass_percentage).toBe(50);
    expect(body.data.summary.average_score).toBe(60); // (85 + 35) / 2 = 60

    const sch = body.data.schedules[0]!;
    expect(sch.highest_marks).toBe(85);
    expect(sch.lowest_marks).toBe(35);
    expect(sch.average_marks).toBe(60);

    // Draft marks publication barrier check:
    // Create an unpublished examination with draft schedule - it must NOT appear in the report
    const draftExamId = await insertIn(T.orgId, 'examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Unpublished Draft Exam',
      exam_type: 'UNIT_TEST',
      status: 'ACTIVE',
      starts_on: '2026-10-22',
      ends_on: '2026-10-25',
      created_by_user_id: T.users.admin,
    });
    const draftSchedId = await insertIn(T.orgId, 'exam_schedules', {
      examination_id: draftExamId,
      course_offering_id: offeringId,
      exam_date: '2026-10-22',
      start_time: '14:00',
      end_time: '16:00',
      max_marks: 100,
      pass_marks: 40,
      status: 'DRAFT_MARKS', // Not published!
    });
    await insertIn(T.orgId, 'exam_marks', {
      exam_schedule_id: draftSchedId,
      student_id: T.students.one,
      marks_obtained: 99,
      is_passing: true,
      status: 'DRAFT',
      marked_by_user_id: T.users.admin,
    });

    const verifyRes = await call(
      'GET',
      s.admin,
      `/reports/exam-performance?campus_id=${T.campusId}`,
    );
    const verifyBody = verifyRes.json<{ data: { schedules: Array<{ schedule_id: string }> } }>();
    expect(verifyBody.data.schedules.some((s) => s.schedule_id === draftSchedId)).toBe(false);

    // CSV format test
    const csvRes = await call(
      'GET',
      s.admin,
      `/reports/exam-performance?campus_id=${T.campusId}&format=csv`,
    );
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
    expect(csvRes.body).toContain('Examination,Exam Type,Campus');
    expect(csvRes.body).toContain('Mid-Term Examinations 2026');
  });

  it('4. generates fee collections and outstanding dues summary segregating confirmed vs unverified payments', async () => {
    const res = await call('GET', s.admin, `/reports/fee-summary?campus_id=${T.campusId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        summary: {
          confirmed_collections: number;
          unverified_collections: number;
          total_outstanding_dues: number;
          confirmed_receipt_count: number;
          unverified_receipt_count: number;
          defaulters_count: number;
        };
        collections_by_method: Record<string, number>;
        defaulters: Array<{
          student_id: string;
          net_amount: number;
          paid_amount: number;
          balance_amount: number;
          has_unverified_receipt: boolean;
        }>;
      };
    }>();

    // Invariants check:
    // Confirmed cash = 300,000 (3,000 INR)
    // Unverified cheque = 500,000 (5,000 INR)
    // Total outstanding dues = 200,000 (student 1) + 500,000 (student 2) = 700,000 (7,000 INR)
    expect(body.data.summary.confirmed_collections).toBe(300000);
    expect(body.data.summary.unverified_collections).toBe(500000);
    expect(body.data.summary.total_outstanding_dues).toBe(700000);
    expect(body.data.summary.confirmed_receipt_count).toBe(1);
    expect(body.data.summary.unverified_receipt_count).toBe(1);
    expect(body.data.summary.defaulters_count).toBe(2);

    expect(body.data.collections_by_method['CASH']).toBe(300000);
    expect(body.data.collections_by_method['CHEQUE']).toBe(500000);

    const s2Defaulter = body.data.defaulters.find((d) => d.student_id === T.students.two);
    expect(s2Defaulter).toBeDefined();
    expect(s2Defaulter?.balance_amount).toBe(500000);
    expect(s2Defaulter?.has_unverified_receipt).toBe(true); // Flagged as having unverified cheque in clearing

    // CSV defaulters format test
    const csvDefaulters = await call(
      'GET',
      s.admin,
      `/reports/fee-summary?campus_id=${T.campusId}&format=csv&view=defaulters`,
    );
    expect(csvDefaulters.statusCode).toBe(200);
    expect(csvDefaulters.headers['content-type']).toContain('text/csv');
    expect(csvDefaulters.body).toContain('Admission No,Student Name,Campus');
    expect(csvDefaulters.body).toContain('5000.00'); // student 2 balance
  });

  it('5. strictly enforces multi-tenant isolation and prevents cross-tenant access', async () => {
    // Other tenant admin cannot see Tenant T's student roster
    const otherRoster = await call(
      'GET',
      s.otherAdmin,
      `/reports/enrolment-roster?campus_id=${T.campusId}`,
    );
    expect(otherRoster.statusCode).toBe(200);
    expect(otherRoster.json<{ data: { students: unknown[] } }>().data.students).toHaveLength(0);

    // Other tenant admin cannot see Tenant T's exam performance
    const otherExams = await call(
      'GET',
      s.otherAdmin,
      `/reports/exam-performance?campus_id=${T.campusId}`,
    );
    expect(otherExams.statusCode).toBe(200);
    expect(otherExams.json<{ data: { schedules: unknown[] } }>().data.schedules).toHaveLength(0);

    // Other tenant admin cannot see Tenant T's fee summary
    const otherFees = await call(
      'GET',
      s.otherAdmin,
      `/reports/fee-summary?campus_id=${T.campusId}`,
    );
    expect(otherFees.statusCode).toBe(200);
    expect(otherFees.json<{ data: { defaulters: unknown[] } }>().data.defaulters).toHaveLength(0);
  });

  it('6. refuses unauthorized student actor attempting to access administrative reports', async () => {
    const r1 = await call('GET', s.student1, '/reports/enrolment-roster');
    expect(r1.statusCode).toBe(403);

    const r2 = await call('GET', s.student1, '/reports/attendance-summary');
    expect(r2.statusCode).toBe(403);

    const r3 = await call('GET', s.student1, '/reports/fee-summary');
    expect(r3.statusCode).toBe(403);
  });
});
