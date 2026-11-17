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

const PASSWORD = /* secret-scan:allow */ 'MasterErpSecurePass123!';
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
let HASH = '';

interface Session {
  cookie: string;
  csrf: string;
}

const s = {} as Record<
  'principal' | 'teacher' | 'registrar' | 'student1' | 'student2' | 'parent1',
  Session
>;

let employeeId: string;
let academicYearId: string;
let termId: string;
let programId: string;
let cohortId: string;
let cohortPeriodId: string;
let courseId: string;
let courseOfferingId: string;
let sectionAId: string;
let sectionBId: string;
let student1Id: string;
let student2Id: string;
let guardian1Id: string;
let homeworkId: string;
let teacherUploadedFileId: string;
let studentUploadedFileId: string;
let examId: string;
let examScheduleId: string;
let feeStructureId: string;
let studentDueId: string;

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

describe('Master ERP Quality Assurance: End-to-End Workflow & Multi-Role Acceptance', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);

    student1Id = T.students.one;
    student2Id = T.students.two;

    // 1. Reset passwords for test identities
    await adminQuery(
      `UPDATE platform.identities SET password_hash = $1 WHERE id IN ($2, $3, $4, $5)`,
      [HASH, T.users.admin, T.users.faculty, T.users.studentOne, T.users.studentTwo],
    );

    // 2. Set Institution Type to SCHOOL on app.organizations and app.organization_settings
    await adminQuery(
      `UPDATE app.organizations
          SET institution_type = 'SCHOOL',
              name = 'Anesa Master Demonstration School'
        WHERE id = $1`,
      [T.orgId],
    );
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'institution.type', to_jsonb('SCHOOL'::text), $2)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = to_jsonb('SCHOOL'::text), updated_by = $2`,
      [T.orgId, T.users.admin],
    );

    // 3. Provision Registrar User and Role
    const registrarUserId = uuidv7();
    const registrarEmail = `registrar.${RUN}@anesa.test`.toLowerCase();
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [registrarUserId, registrarEmail, HASH],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'Rita Registrar', 'ACTIVE', $1)`,
      [registrarUserId, T.orgId, registrarEmail],
    );
    // Grant REGISTRAR role
    const regRoleRes = await adminQuery(
      `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'REGISTRAR'`,
      [T.orgId],
    );
    if (regRoleRes[0]) {
      await insert('role_assignments', {
        user_id: registrarUserId,
        role_id: regRoleRes[0].id,
        scope_type: 'ORGANIZATION',
        status: 'ACTIVE',
      });
    }

    // 4. Provision Parent User and Guardian
    const parentUserId = uuidv7();
    const parentEmail = `parent.${RUN}@anesa.test`.toLowerCase();
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [parentUserId, parentEmail, HASH],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'Priya Parent', 'ACTIVE', $1)`,
      [parentUserId, T.orgId, parentEmail],
    );
    guardian1Id = await insert('guardians', {
      user_id: parentUserId,
      full_name: 'Priya Parent',
      phone: '+919876543200',
      email: parentEmail,
    });
    // Link Guardian to Student 1
    await insert('student_guardians', {
      student_id: student1Id,
      guardian_id: guardian1Id,
      relation: 'Mother',
      is_primary: true,
      can_view_academics: true,
      can_receive_notifications: true,
      valid_from: '2026-06-01',
    });

    // 5. Establish Employee record for teacher
    employeeId = await insert('employees', {
      user_id: T.users.faculty,
      employee_code: `EMP-MTR-${RUN}`,
      employee_type: 'FACULTY',
      status: 'ACTIVE',
      joining_date: '2025-06-01',
    });

    // 6. Establish Academic Structure
    academicYearId = await insert('academic_years', {
      label: `AY-2026-${RUN}`,
      start_date: '2026-06-01',
      end_date: '2027-05-31',
    });
    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [
      academicYearId,
    ]);

    const semType = await insert('period_types', {
      code: `SEM_${RUN}`.slice(0, 10),
      label: 'Semester',
      label_plural: 'Semesters',
    });

    programId = await insert('programs', {
      department_id: T.departmentId,
      period_type_id: semType,
      name: 'Secondary Grade 10',
      code: `G10_${RUN}`.slice(0, 20),
      degree_level: 'HIGH_SCHOOL',
      duration_periods: 2,
    });

    cohortId = await insert('cohorts', {
      program_id: programId,
      admission_year: 2026,
      name: 'Class of 2026',
    });

    termId = await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: academicYearId,
      code: 'T1',
      name: 'Term 1 (Autumn)',
      start_date: '2026-06-01',
      end_date: '2026-11-30',
    });
    await adminQuery(`UPDATE app.terms SET status = 'ACTIVE' WHERE id = $1`, [termId]);

    cohortPeriodId = await insert('cohort_periods', {
      cohort_id: cohortId,
      term_id: termId,
      period_no: 1,
    });

    sectionAId = await insert('sections', { cohort_period_id: cohortPeriodId, name: 'A' });
    sectionBId = await insert('sections', { cohort_period_id: cohortPeriodId, name: 'B' });

    courseId = await insert('courses', {
      owning_department_id: T.departmentId,
      code: `SCI101_${RUN}`.slice(0, 30),
      title: 'General Science & Physics',
      credits: 4,
      course_type: 'THEORY',
    });

    courseOfferingId = await insert('course_offerings', {
      campus_id: T.campusId,
      department_id: T.departmentId,
      term_id: termId,
      course_id: courseId,
      cohort_period_id: cohortPeriodId,
      offering_kind: 'CORE',
      code_snapshot: 'SCI101',
      title_snapshot: 'General Science & Physics',
      credits_snapshot: 4.0,
      tracks_attendance: true,
      registration_policy: 'MANUAL',
      status: 'DRAFT',
    });

    await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
      courseOfferingId,
    ]);

    // Assign Teacher to Course Offering
    await insert('faculty_assignments', {
      course_offering_id: courseOfferingId,
      employee_id: employeeId,
      role: 'PRIMARY',
      valid_from: '2026-06-01',
    });

    // Enroll Student 1 in Section A
    const sp1 = await insert('student_programs', {
      student_id: student1Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });
    const te1 = await insert('term_enrollments', {
      student_id: student1Id,
      student_program_id: sp1,
      cohort_period_id: cohortPeriodId,
      term_id: termId,
      period_no: 1,
      status: 'REGISTERED',
    });
    await insert('section_memberships', {
      student_id: student1Id,
      term_enrollment_id: te1,
      cohort_period_id: cohortPeriodId,
      section_id: sectionAId,
      valid_from: '2026-06-01',
      changed_by: T.users.admin,
    });
    await insert('course_registrations', {
      term_enrollment_id: te1,
      student_id: student1Id,
      course_offering_id: courseOfferingId,
      status: 'REGISTERED',
      source: 'MANUAL',
      valid_from: '2026-06-01',
    });

    // Enroll Student 2 in Section B
    const sp2 = await insert('student_programs', {
      student_id: student2Id,
      program_id: programId,
      cohort_id: cohortId,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });
    const te2 = await insert('term_enrollments', {
      student_id: student2Id,
      student_program_id: sp2,
      cohort_period_id: cohortPeriodId,
      term_id: termId,
      period_no: 1,
      status: 'REGISTERED',
    });

    await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id IN ($1, $2)`, [
      te1,
      te2,
    ]);
    await insert('section_memberships', {
      student_id: student2Id,
      term_enrollment_id: te2,
      cohort_period_id: cohortPeriodId,
      section_id: sectionBId,
      valid_from: '2026-06-01',
      changed_by: T.users.admin,
    });
    await insert('course_registrations', {
      term_enrollment_id: te2,
      student_id: student2Id,
      course_offering_id: courseOfferingId,
      status: 'REGISTERED',
      source: 'MANUAL',
      valid_from: '2026-06-01',
    });

    // Register physical room
    await insert('rooms', {
      campus_id: T.campusId,
      code: `LH-MTR-${RUN}`.slice(0, 20),
      kind: 'Lecture Hall',
      name: 'Main Academic Lecture Hall',
      capacity: 80,
    });

    // 7. Authenticate all actors
    s.principal = await login(T.emails.admin);
    s.teacher = await login(T.emails.faculty);
    s.registrar = await login(registrarEmail);
    s.student1 = await login(T.emails.studentOne);
    s.student2 = await login(T.emails.studentTwo);
    s.parent1 = await login(parentEmail);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  // =========================================================================
  // STAGE 1: INSTITUTION PROFILE & ROLE CONTEXT
  // =========================================================================
  it('Stage 1: Verified identity and dynamic role labeling for School Principal', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: `session_token=${s.principal.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json<{
      roles: string[];
      role_labels: Record<string, string>;
      institution_type: string;
      capabilities: string[];
    }>();
    expect(me.roles).toContain('COLLEGE_ADMIN');
    expect(me.institution_type).toBe('SCHOOL');
    expect(me.capabilities).toContain('org.settings.manage');
    expect(me.capabilities).toContain('org.campus.manage');
    expect(me.capabilities).toContain('result.publish');
  });

  // =========================================================================
  // STAGE 2: ATTENDANCE SESSION WORKFLOW
  // =========================================================================
  it('Stage 2: Teacher takes daily attendance session for enrolled Section A', async () => {
    // 2a. Teacher creates attendance session
    const resCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/sessions',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        'idempotency-key': uuidv7(),
        origin: APP_ORIGIN,
      },
      payload: {
        courseOfferingId,
        sessionDate: '2026-09-15',
        startsAt: '2026-09-15T09:00:00Z',
        endsAt: '2026-09-15T10:00:00Z',
      },
    });
    expect(resCreate.statusCode).toBe(201);
    const sessionId = resCreate.json<{ success: boolean; data: { id: string } }>().data.id;
    expect(sessionId).toBeDefined();

    // 2b. Teacher marks Student 1 as PRESENT and Student 2 as ABSENT
    const resMark = await app.inject({
      method: 'POST',
      url: `/api/v1/attendance/sessions/${sessionId}/attendance`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        'idempotency-key': uuidv7(),
        origin: APP_ORIGIN,
      },
      payload: {
        records: [
          { studentId: student1Id, status: 'PRESENT' },
          { studentId: student2Id, status: 'ABSENT' },
        ],
      },
    });
    expect(resMark.statusCode).toBe(201);

    // 2c. Student 1 queries own attendance and sees PRESENT status
    const resStu = await app.inject({
      method: 'GET',
      url: '/api/v1/attendance/me/records',
      headers: { cookie: `session_token=${s.student1.cookie}` },
    });
    expect(resStu.statusCode).toBe(200);
    const stuAtt = resStu.json<{ success: boolean; data: Array<{ status: string }> }>();
    expect(stuAtt.data.some((sess) => sess.status === 'PRESENT')).toBe(true);

    // 2d. Security: Teacher cannot create session for unassigned offering
    const otherCourseId = await insert('courses', {
      owning_department_id: T.departmentId,
      code: `MTH101_${RUN}`.slice(0, 30),
      title: 'Advanced Mathematics',
      credits: 4,
      course_type: 'THEORY',
    });

    const otherOfferingId = await insert('course_offerings', {
      campus_id: T.campusId,
      department_id: T.departmentId,
      term_id: termId,
      course_id: otherCourseId,
      cohort_period_id: cohortPeriodId,
      offering_kind: 'CORE',
      code_snapshot: 'MTH101',
      title_snapshot: 'Advanced Mathematics',
      credits_snapshot: 4.0,
      tracks_attendance: true,
      registration_policy: 'MANUAL',
      status: 'DRAFT',
    });
    await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
      otherOfferingId,
    ]);

    const resUnassigned = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/sessions',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        courseOfferingId: otherOfferingId,
        sessionDate: '2026-09-15',
        startsAt: '2026-09-15T09:00:00Z',
        endsAt: '2026-09-15T10:00:00Z',
      },
    });
    expect([403, 404]).toContain(resUnassigned.statusCode);
  });

  // =========================================================================
  // STAGE 3: HOMEWORK ASSIGNMENT, DUAL-MODE ATTACHMENTS & REVIEW
  // =========================================================================
  it('Stage 3: Teacher creates homework with verified attachment, Student submits, Teacher reviews', async () => {
    // 3a. Teacher uploads worksheet file (ADR-010 compliance)
    const pdfBuf = Buffer.from('%PDF-1.4\nPhysics Optics Assignment\n%%EOF');
    const resUpload = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/attachments/upload',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        fileName: 'Optics_Worksheet_Ch4.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: pdfBuf.length,
        contentBase64: pdfBuf.toString('base64'),
      },
    });
    expect(resUpload.statusCode).toBe(200);
    teacherUploadedFileId = resUpload.json<{ data: { fileId: string } }>().data.fileId;
    expect(teacherUploadedFileId).toBeDefined();

    // 3b. Teacher creates and publishes homework for Section A
    const resHw = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/teacher/assignments',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        courseOfferingId,
        sectionId: sectionAId,
        title: 'Optics & Refraction Problems',
        instructions: 'Solve problems 1-10 on page 84. Submit PDF with diagrams.',
        submissionType: 'ONLINE',
        maxMarks: 100,
        dueDate: '2026-10-01',
        dueTime: '23:59',
        publishNow: true,
        attachments: [
          {
            fileId: teacherUploadedFileId,
            fileName: 'Optics_Worksheet_Ch4.pdf',
            fileSizeBytes: pdfBuf.length,
            mimeType: 'application/pdf',
          },
        ],
      },
    });
    expect(resHw.statusCode).toBe(200);
    homeworkId = resHw.json<{ data: { id: string } }>().data.id;
    expect(homeworkId).toBeDefined();

    // 3c. Student 1 downloads teacher attachment
    const resDl = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/download-url`,
      headers: { cookie: `session_token=${s.student1.cookie}` },
    });
    expect(resDl.statusCode).toBe(200);
    expect(resDl.json<{ data: { fileName: string } }>().data.fileName).toBe(
      'Optics_Worksheet_Ch4.pdf',
    );

    // 3d. Student 1 uploads submission file and submits homework
    const solBuf = Buffer.from('%PDF-1.4\nStudent 1 Optics Solutions\n%%EOF');
    const resSolUp = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/attachments/upload',
      headers: {
        cookie: `session_token=${s.student1.cookie}`,
        'x-csrf-token': s.student1.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        fileName: 'Student1_Optics_Answers.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: solBuf.length,
        contentBase64: solBuf.toString('base64'),
      },
    });
    expect(resSolUp.statusCode).toBe(200);
    studentUploadedFileId = resSolUp.json<{ data: { fileId: string } }>().data.fileId;

    const resSubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/student/assignments/${homeworkId}/submit`,
      headers: {
        cookie: `session_token=${s.student1.cookie}`,
        'x-csrf-token': s.student1.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        submissionText: 'All diagrams and derivations completed in attached file.',
        files: [
          {
            fileId: studentUploadedFileId,
            fileName: 'Student1_Optics_Answers.pdf',
            fileSizeBytes: solBuf.length,
            mimeType: 'application/pdf',
          },
        ],
      },
    });
    expect(resSubmit.statusCode).toBe(200);

    // 3e. Teacher reviews and grades submission
    const subListRes = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/teacher/assignments/${homeworkId}/submissions`,
      headers: { cookie: `session_token=${s.teacher.cookie}` },
    });
    expect(subListRes.statusCode).toBe(200);
    const submissions = subListRes.json<{ data: Array<{ id: string }> }>().data;
    expect(submissions.length).toBe(1);
    const submissionId = submissions[0]!.id;

    const resGrade = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/teacher/submissions/${submissionId}/review`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        status: 'REVIEWED',
        marksObtained: 95,
        feedback: 'Excellent work on the Snell law derivation.',
      },
    });
    expect(resGrade.statusCode).toBe(200);

    // 3f. Security: Student 2 in Section B cannot download Section A attachment
    const resForbiddenDl = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/download-url`,
      headers: { cookie: `session_token=${s.student2.cookie}` },
    });
    expect(resForbiddenDl.statusCode).toBe(403);
  });

  // =========================================================================
  // STAGE 4: EXAMINATION LIFECYCLE & PUBLISHED RESULTS
  // =========================================================================
  it('Stage 4: Examination schedule, marks entry, and publication of results', async () => {
    // 4a. Create Examination
    examId = await insert('examinations', {
      campus_id: T.campusId,
      term_id: termId,
      name: 'Midterm Science Examination 2026',
      exam_type: 'MID_TERM',
      starts_on: '2026-09-10',
      ends_on: '2026-09-20',
      status: 'SCHEDULED',
      created_by_user_id: T.users.admin,
    });

    // 4b. Create Exam Schedule for Course Offering
    examScheduleId = await insert('exam_schedules', {
      examination_id: examId,
      course_offering_id: courseOfferingId,
      exam_date: '2026-09-12',
      start_time: '09:00',
      end_time: '12:00',
      max_marks: 100,
      pass_marks: 40,
      status: 'SCHEDULED',
    });

    // 4c. Teacher submits marks for Student 1
    const resMarks = await app.inject({
      method: 'POST',
      url: `/api/v1/examinations/schedules/${examScheduleId}/marks`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        action: 'SUBMIT',
        entries: [
          {
            student_id: student1Id,
            status: 'ENTERED',
            marks_obtained: 88,
            remarks: 'Strong theoretical comprehension',
          },
        ],
      },
    });
    expect(resMarks.statusCode).toBe(200);

    // 4d. Un-elevated Principal session is blocked with 403 STEP_UP_REQUIRED (CRITICAL operation)
    const resBlockedPublish = await app.inject({
      method: 'POST',
      url: `/api/v1/examinations/schedules/${examScheduleId}/publish`,
      headers: {
        cookie: `session_token=${s.principal.cookie}`,
        'x-csrf-token': s.principal.csrf,
        origin: APP_ORIGIN,
      },
    });
    expect(resBlockedPublish.statusCode).toBe(403);
    expect(resBlockedPublish.json<{ error: { code: string } }>().error.code).toBe(
      'STEP_UP_REQUIRED',
    );

    // Elevate Principal session for CRITICAL result publication
    await elevateSession(s.principal.cookie);

    // 4e. Elevated Principal publishes examination results (result.publish)
    const resPublish = await app.inject({
      method: 'POST',
      url: `/api/v1/examinations/schedules/${examScheduleId}/publish`,
      headers: {
        cookie: `session_token=${s.principal.cookie}`,
        'x-csrf-token': s.principal.csrf,
        origin: APP_ORIGIN,
      },
    });
    expect(resPublish.statusCode).toBe(200);

    // 4f. Student 1 views published result
    const resStuReport = await app.inject({
      method: 'GET',
      url: `/api/v1/examinations/students/${student1Id}/results`,
      headers: { cookie: `session_token=${s.student1.cookie}` },
    });
    expect(resStuReport.statusCode).toBe(200);
    const results = resStuReport.json<{
      data: Array<{ marks_obtained: unknown; is_passing: boolean }>;
    }>().data;
    expect(results.some((r) => Number(r.marks_obtained) === 88 && r.is_passing === true)).toBe(
      true,
    );

    // 4g. Security: Student 2 cannot view Student 1 results (403)
    const resSecRes = await app.inject({
      method: 'GET',
      url: `/api/v1/examinations/students/${student1Id}/results`,
      headers: { cookie: `session_token=${s.student2.cookie}` },
    });
    expect(resSecRes.statusCode).toBe(403);
  });

  // =========================================================================
  // STAGE 5: FEES & FINANCE LIFECYCLE
  // =========================================================================
  it('Stage 5: Fee structures, student dues generation, offline receipt, and balance decrement', async () => {
    // 5a. Create Fee Category and Structure
    const feeCatId = await insert('fee_categories', {
      name: 'Tuition & Academic Facilities',
      code: `TUI_MTR_${RUN}`.slice(0, 30),
    });

    feeStructureId = await insert('fee_structures', {
      campus_id: T.campusId,
      academic_year_id: academicYearId,
      name: 'Term 1 Standard Tuition',
      code: `STR_MTR_${RUN}`.slice(0, 30),
      currency: 'INR',
      due_date: '2026-10-31',
      status: 'ACTIVE',
      created_by_user_id: T.users.admin,
    });

    await insert('fee_structure_components', {
      fee_structure_id: feeStructureId,
      fee_category_id: feeCatId,
      amount: 1500000,
      description: 'Standard tuition component',
    });

    // 5b. Generate Student Dues for Student 1
    studentDueId = await insert('student_dues', {
      campus_id: T.campusId,
      student_id: student1Id,
      fee_structure_id: feeStructureId,
      academic_year_id: academicYearId,
      term_id: termId,
      due_number: `DUE-${RUN}-01`,
      gross_amount: 1500000,
      discount_amount: 0,
      net_amount: 1500000,
      paid_amount: 0,
      balance_amount: 1500000,
      status: 'PENDING',
      due_date: '2026-10-31',
      generated_by_user_id: T.users.admin,
    });

    // 5c. Record Offline Receipt of 10,000.00 INR (1,000,000 paisa)
    const resReceipt = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/receipts',
      headers: {
        cookie: `session_token=${s.principal.cookie}`,
        'x-csrf-token': s.principal.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        campus_id: T.campusId,
        student_id: student1Id,
        payment_date: '2026-09-20',
        payment_method: 'CASH',
        amount: 1000000,
        currency: 'INR',
        allocations: [{ student_due_id: studentDueId, amount: 1000000 }],
      },
    });
    expect(resReceipt.statusCode).toBe(201);

    // 5d. Verify updated student due balance is now 5,000.00 INR (500,000 paisa)
    const dueCheck = await adminQuery(
      `SELECT paid_amount, balance_amount, status FROM app.student_dues WHERE id = $1`,
      [studentDueId],
    );
    expect(dueCheck[0]!.paid_amount).toBe('1000000');
    expect(dueCheck[0]!.balance_amount).toBe('500000');
    expect(dueCheck[0]!.status).toBe('PARTIAL');
  });

  // =========================================================================
  // STAGE 6: PARENT PORTAL UNIFIED GUARDIAN ACCESS
  // =========================================================================
  it('Stage 6: Parent Portal displays verified child attendance, homework, report card & fee dues', async () => {
    // 6a. Parent lists linked children and sees Student 1
    const resChildren = await app.inject({
      method: 'GET',
      url: '/api/v1/parent/children',
      headers: { cookie: `session_token=${s.parent1.cookie}` },
    });
    expect(resChildren.statusCode).toBe(200);
    const children = resChildren.json<{ success: boolean; data: Array<{ studentId: string }> }>()
      .data;
    expect(children.length).toBe(1);
    expect(children[0]!.studentId).toBe(student1Id);

    // 6b. Parent views Student 1 dashboard summary (attendance and fee summary)
    const resSummary = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student1Id}/summary`,
      headers: { cookie: `session_token=${s.parent1.cookie}` },
    });
    expect(resSummary.statusCode).toBe(200);
    const summary = resSummary.json<{
      success: boolean;
      data: {
        fees: { totalDues: number; totalPaid: number; totalOutstanding: number };
        attendance: { present: number };
      };
    }>().data;
    expect(summary.fees.totalOutstanding).toBe(500000);
    expect(summary.attendance.present).toBeGreaterThanOrEqual(1);

    // 6c. Parent views Student 1 homework assignments with evaluated feedback
    const resHw = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/parent/children/${student1Id}/assignments`,
      headers: { cookie: `session_token=${s.parent1.cookie}` },
    });
    expect(resHw.statusCode).toBe(200);
    const hwList = resHw.json<{
      success: boolean;
      data: Array<{ title: string; submissionStatus: string }>;
    }>().data;
    expect(
      hwList.some(
        (h) => h.title === 'Optics & Refraction Problems' && h.submissionStatus === 'REVIEWED',
      ),
    ).toBe(true);

    // 6d. Security: Parent cannot query unlinked Student 2 (403 Forbidden)
    const resForbiddenChild = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student2Id}/summary`,
      headers: { cookie: `session_token=${s.parent1.cookie}` },
    });
    expect(resForbiddenChild.statusCode).toBe(403);
  });

  // =========================================================================
  // STAGE 7: CROSS-ROLE LEAST PRIVILEGE BOUNDARIES
  // =========================================================================
  it('Stage 7: Strict role least privilege gating and denial of unauthorized actions', async () => {
    // 7a. Teacher cannot manage organization settings (403/404)
    const resTeachOrg = await app.inject({
      method: 'PUT',
      url: '/api/v1/organization/settings/institution.type',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: { value: 'COLLEGE', reason: 'Attempt unauthorized update' },
    });
    expect([403, 404]).toContain(resTeachOrg.statusCode);

    // 7b. Student cannot create homework assignments (403/404)
    const resStuHw = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/teacher/assignments',
      headers: {
        cookie: `session_token=${s.student1.cookie}`,
        'x-csrf-token': s.student1.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        courseOfferingId,
        sectionId: sectionAId,
        title: 'Unauthorized Student Homework',
        instructions: 'Test',
        submissionType: 'ONLINE',
        maxMarks: 100,
        dueDate: '2026-10-01',
        dueTime: '23:59',
        publishNow: true,
      },
    });
    expect([403, 404]).toContain(resStuHw.statusCode);

    // 7c. Student cannot access offline receipt recording (403/404)
    const resStuReceipt = await app.inject({
      method: 'POST',
      url: '/api/v1/finance/receipts',
      headers: {
        cookie: `session_token=${s.student1.cookie}`,
        'x-csrf-token': s.student1.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        campus_id: T.campusId,
        student_id: student1Id,
        payment_date: '2026-09-20',
        payment_method: 'CASH',
        amount: 500000,
        currency: 'INR',
        allocations: [],
      },
    });
    expect([403, 404]).toContain(resStuReceipt.statusCode);

    // 7d. Parent cannot mark attendance sessions (403/404)
    const resParentAtt = await app.inject({
      method: 'POST',
      url: '/api/v1/attendance/sessions',
      headers: {
        cookie: `session_token=${s.parent1.cookie}`,
        'x-csrf-token': s.parent1.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        courseOfferingId,
        sessionDate: '2026-09-16',
        startsAt: '2026-09-16T09:00:00Z',
        endsAt: '2026-09-16T10:00:00Z',
      },
    });
    expect([403, 404]).toContain(resParentAtt.statusCode);
  });
});
