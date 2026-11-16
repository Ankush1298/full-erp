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

const PASSWORD = /* secret-scan:allow */ 'AttachPass123!Secure';
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

const s = {} as Record<'teacher' | 'studentOne' | 'studentTwo', Session>;

let courseOfferingId: string;
let sectionAId: string;
let sectionBId: string;
let employeeId: string;
let termId: string;
let student1Id: string;
let student2Id: string;
let homeworkId: string;
let teacherUploadedFileId: string;
let studentUploadedFileId: string;

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

describe('Homework Attachments: Dual-Mode Upload, DB Integrity & RBAC Access Flow', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);

    student1Id = T.students.one;
    student2Id = T.students.two;

    await adminQuery(
      `UPDATE platform.identities SET password_hash = $1 WHERE id IN ($2, $3, $4)`,
      [HASH, T.users.faculty, T.users.studentOne, T.users.studentTwo],
    );

    employeeId = await insert('employees', {
      user_id: T.users.faculty,
      employee_code: `EMP-ATT-${RUN}`,
      employee_type: 'FACULTY',
      status: 'ACTIVE',
      joining_date: '2025-06-01',
    });

    const year = await insert('academic_years', {
      label: `AY${RUN}`,
      start_date: '2026-06-01',
      end_date: '2027-05-31',
    });

    const sem = await insert('period_types', {
      code: `S_${RUN}`.slice(0, 10),
      label: 'Semester',
      label_plural: 'Semesters',
    });

    const program = await insert('programs', {
      department_id: T.departmentId,
      period_type_id: sem,
      name: 'Grade 10',
      code: `G10_${RUN}`.slice(0, 20),
      degree_level: 'HIGH_SCHOOL',
      duration_periods: 2,
    });

    const cohort = await insert('cohorts', {
      program_id: program,
      admission_year: 2026,
      name: 'Class of 2026',
    });

    termId = await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: year,
      code: 'T1',
      name: 'Term 1',
      start_date: '2026-06-01',
      end_date: '2026-11-30',
    });

    const cp = await insert('cohort_periods', {
      cohort_id: cohort,
      term_id: termId,
      period_no: 1,
    });

    sectionAId = await insert('sections', { cohort_period_id: cp, name: 'A' });
    sectionBId = await insert('sections', { cohort_period_id: cp, name: 'B' });

    const course = await insert('courses', {
      owning_department_id: T.departmentId,
      code: `M101_${RUN}`.slice(0, 30),
      title: 'Mathematics 101',
      credits: 4,
      course_type: 'THEORY',
    });

    courseOfferingId = await insert('course_offerings', {
      campus_id: T.campusId,
      department_id: T.departmentId,
      term_id: termId,
      course_id: course,
      cohort_period_id: cp,
      offering_kind: 'CORE',
      code_snapshot: 'MATH101',
      title_snapshot: 'Mathematics 101',
      credits_snapshot: 4.0,
      tracks_attendance: true,
      registration_policy: 'MANUAL',
      status: 'DRAFT',
    });

    await adminQuery(
      `UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`,
      [courseOfferingId],
    );

    await insert('faculty_assignments', {
      course_offering_id: courseOfferingId,
      employee_id: employeeId,
      role: 'PRIMARY',
      valid_from: '2026-06-01',
    });

    const sp1 = await insert('student_programs', {
      student_id: student1Id,
      program_id: program,
      cohort_id: cohort,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });

    const sp2 = await insert('student_programs', {
      student_id: student2Id,
      program_id: program,
      cohort_id: cohort,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: '2026-06-01',
      status: 'ACTIVE',
    });

    const te1 = await insert('term_enrollments', {
      student_id: student1Id,
      student_program_id: sp1,
      cohort_period_id: cp,
      term_id: termId,
      period_no: 1,
      status: 'REGISTERED',
    });

    const te2 = await insert('term_enrollments', {
      student_id: student2Id,
      student_program_id: sp2,
      cohort_period_id: cp,
      term_id: termId,
      period_no: 1,
      status: 'REGISTERED',
    });

    await adminQuery(
      `UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id IN ($1, $2)`,
      [te1, te2],
    );

    await insert('section_memberships', {
      student_id: student1Id,
      term_enrollment_id: te1,
      cohort_period_id: cp,
      section_id: sectionAId,
      valid_from: '2026-06-01',
      changed_by: T.users.admin,
    });

    await insert('section_memberships', {
      student_id: student2Id,
      term_enrollment_id: te2,
      cohort_period_id: cp,
      section_id: sectionBId,
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

    await insert('course_registrations', {
      term_enrollment_id: te2,
      student_id: student2Id,
      course_offering_id: courseOfferingId,
      status: 'REGISTERED',
      source: 'MANUAL',
      valid_from: '2026-06-01',
    });

    s.teacher = await login(T.emails.faculty);
    s.studentOne = await login(T.emails.studentOne);
    s.studentTwo = await login(T.emails.studentTwo);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('1. Teacher uploads assignment attachment directly into verified storage (ADR-010)', async () => {
    const fakePdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/attachments/upload',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        fileName: 'Calculus_Problem_Set_1.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: fakePdfBytes.length,
        contentBase64: fakePdfBytes.toString('base64'),
      },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{ success: boolean; data: { fileId: string; fileName: string; mimeType: string } }>();
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('Calculus_Problem_Set_1.pdf');
    expect(body.data.mimeType).toBe('application/pdf');
    expect(body.data.fileId).toBeDefined();

    teacherUploadedFileId = body.data.fileId;

    // Verify row in app.files was authored by DocumentService with status AVAILABLE and INTERNAL
    const filesRes = await adminQuery(
      `SELECT id, organization_id, original_name, status, classification, scan_result
       FROM app.files WHERE id = $1`,
      [teacherUploadedFileId],
    );
    expect(filesRes).toHaveLength(1);
    expect(filesRes[0]!.organization_id).toBe(T.orgId);
    expect(filesRes[0]!.original_name).toBe('Calculus_Problem_Set_1.pdf');
    expect(filesRes[0]!.status).toBe('AVAILABLE');
    expect(filesRes[0]!.classification).toBe('INTERNAL');
    expect(filesRes[0]!.scan_result).toBe('CLEAN');
  });

  it('2. Teacher lists available institutional documents and finds the uploaded file', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/attachments/available-documents',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        origin: APP_ORIGIN,
      },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{ success: boolean; data: Array<{ id: string; fileName: string }> }>();
    expect(body.success).toBe(true);
    const found = body.data.find((d) => d.id === teacherUploadedFileId);
    expect(found).toBeDefined();
    expect(found?.fileName).toBe('Calculus_Problem_Set_1.pdf');
  });

  it('3. Teacher creates homework assignment with verified file attachment and satisfies FK constraint', async () => {
    const r = await app.inject({
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
        title: 'Weekly Problem Set 1: Differential Equations',
        instructions: 'Please review the attached problem set and submit your solutions.',
        submissionType: 'ONLINE',
        maxMarks: 100,
        dueDate: '2026-06-30',
        dueTime: '23:59',
        attachments: [
          {
            fileId: teacherUploadedFileId,
            fileName: 'Calculus_Problem_Set_1.pdf',
            fileSizeBytes: 64,
            mimeType: 'application/pdf',
          },
        ],
      },
    });

    expect(r.statusCode).toBe(200);
    const body = r.json<{ success: boolean; data: { id: string } }>();
    homeworkId = body.data.id;
    expect(homeworkId).toBeDefined();

    // Verify foreign key integrity in app.homework_attachments
    const attachRows = await adminQuery(
      `SELECT ha.id, ha.homework_id, ha.file_id, ha.file_name, f.original_name, f.status
       FROM app.homework_attachments ha
       JOIN app.files f ON ha.file_id = f.id
       WHERE ha.homework_id = $1`,
      [homeworkId],
    );
    expect(attachRows).toHaveLength(1);
    expect(attachRows[0]!.file_id).toBe(teacherUploadedFileId);
    expect(attachRows[0]!.file_name).toBe('Calculus_Problem_Set_1.pdf');
    expect(attachRows[0]!.status).toBe('AVAILABLE');
  });

  it('4. Teacher publishes the homework assignment', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/teacher/assignments/${homeworkId}/publish`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
    });
    expect(r.statusCode).toBe(200);
  });

  it('5. Student 1 (enrolled in Section A) downloads the teacher attachment', async () => {
    // 5a. Fetch download URL
    const rUrl = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/download-url`,
      headers: {
        cookie: `session_token=${s.studentOne.cookie}`,
        origin: APP_ORIGIN,
      },
    });
    expect(rUrl.statusCode).toBe(200);
    const bodyUrl = rUrl.json<{ success: boolean; data: { downloadUrl: string; fileName: string } }>();
    expect(bodyUrl.success).toBe(true);
    expect(bodyUrl.data.fileName).toBe('Calculus_Problem_Set_1.pdf');
    expect(bodyUrl.data.downloadUrl).toContain('/api/v1/homework/attachments/');

    // 5b. Fetch content directly
    const rContent = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/content`,
      headers: {
        cookie: `session_token=${s.studentOne.cookie}`,
        origin: APP_ORIGIN,
      },
    });
    expect(rContent.statusCode).toBe(200);
    expect(rContent.headers['content-type']).toContain('application/pdf');
    expect(rContent.headers['content-disposition']).toContain('Calculus_Problem_Set_1.pdf');
  });

  it('6. Student 1 uploads homework submission file and submits work', async () => {
    // Upload student submission file
    const subBytes = Buffer.from('%PDF-1.4\nStudent Solutions\n%%EOF');
    const rUp = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/attachments/upload',
      headers: {
        cookie: `session_token=${s.studentOne.cookie}`,
        'x-csrf-token': s.studentOne.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        fileName: 'Student1_Solutions_Set1.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: subBytes.length,
        contentBase64: subBytes.toString('base64'),
      },
    });
    expect(rUp.statusCode).toBe(200);
    studentUploadedFileId = rUp.json<{ data: { fileId: string } }>().data.fileId;
    expect(studentUploadedFileId).toBeDefined();

    // Submit homework
    const rSub = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/student/assignments/${homeworkId}/submit`,
      headers: {
        cookie: `session_token=${s.studentOne.cookie}`,
        'x-csrf-token': s.studentOne.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        submissionText: 'Completed all problems including bonus questions in attached PDF.',
        files: [
          {
            fileId: studentUploadedFileId,
            fileName: 'Student1_Solutions_Set1.pdf',
            fileSizeBytes: subBytes.length,
            mimeType: 'application/pdf',
          },
        ],
      },
    });
    expect(rSub.statusCode).toBe(200);
  });

  it('7. Teacher downloads student submission attachment', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${studentUploadedFileId}/download-url`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        origin: APP_ORIGIN,
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ success: boolean; data: { fileName: string } }>();
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('Student1_Solutions_Set1.pdf');
  });

  it('8. File size limit enforcement: uploads > 25MB are rejected with 400 Bad Request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/attachments/upload',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
        origin: APP_ORIGIN,
      },
      payload: {
        fileName: 'Huge_Video_Lecture.mp4',
        mimeType: 'video/mp4',
        fileSizeBytes: 30 * 1024 * 1024, // 30 MB > 25 MB max limit
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it('9. Unauthorized user cannot access attachments without active session', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/download-url`,
      headers: {
        origin: APP_ORIGIN,
      },
    });
    expect(r.statusCode).toBe(401);
  });

  it('10. Student 2 (enrolled in Section B, not Section A) is denied download access to Section A attachments (403 Forbidden)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/attachments/${teacherUploadedFileId}/download-url`,
      headers: {
        cookie: `session_token=${s.studentTwo.cookie}`,
        origin: APP_ORIGIN,
      },
    });
    expect(r.statusCode).toBe(403);
    const body = r.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('FORBIDDEN_SECTION');
  });
});
