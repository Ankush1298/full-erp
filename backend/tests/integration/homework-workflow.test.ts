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

const PASSWORD = /* secret-scan:allow */ 'HomeworkSecurePass123!';
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

const s = {} as Record<'teacher' | 'studentOne' | 'studentTwo' | 'parentA' | 'parentB', Session>;

let courseOfferingId: string;
let sectionAId: string;
let sectionBId: string;
let employeeId: string;
let termId: string;
let student1Id: string;
let student2Id: string;
let homeworkId: string;
let submissionId: string;
let futureDueDate: string;
let currentYear: number;

function getLocalCampusDate(ms: number, timeZone: string): { dateStr: string; year: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
  };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(Date.parse(`${dateStr}T12:00:00Z`) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

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

describe('Homework, Assignments & Secure Student Submissions Workflow', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);

    student1Id = T.students.one;
    student2Id = T.students.two;

    const campusTz =
      (
        await adminQuery<{ timezone: string }>('SELECT timezone FROM app.campuses WHERE id = $1', [
          T.campusId,
        ])
      )[0]?.timezone ?? 'Asia/Kolkata';

    const localToday = getLocalCampusDate(Date.now(), campusTz);
    currentYear = localToday.year;
    const today = localToday.dateStr;

    futureDueDate = addDays(today, 7);

    const termStart = addDays(today, -90);
    const termEnd = addDays(today, 90);
    const academicYearStart = addDays(today, -180);
    const academicYearEnd = addDays(today, 185);
    const validFrom = addDays(today, -60);
    const joiningDate = addDays(today, -365);

    // Reset passwords for students and faculty
    await adminQuery(`UPDATE platform.identities SET password_hash = $1 WHERE id IN ($2, $3, $4)`, [
      HASH,
      T.users.faculty,
      T.users.studentOne,
      T.users.studentTwo,
    ]);

    // Create employee record for faculty
    employeeId = await insert('employees', {
      user_id: T.users.faculty,
      employee_code: `EMP-${RUN}`,
      employee_type: 'FACULTY',
      status: 'ACTIVE',
      joining_date: joiningDate,
    });

    const year = await insert('academic_years', {
      label: `AY${RUN}`,
      start_date: academicYearStart,
      end_date: academicYearEnd,
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
      admission_year: currentYear,
      name: `Class of ${currentYear}`,
    });
    termId = await insert('terms', {
      campus_id: T.campusId,
      academic_year_id: year,
      code: 'T1',
      name: 'Term 1',
      start_date: termStart,
      end_date: termEnd,
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
    await adminQuery(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [
      courseOfferingId,
    ]);
    await insert('faculty_assignments', {
      course_offering_id: courseOfferingId,
      employee_id: employeeId,
      role: 'PRIMARY',
      valid_from: validFrom,
    });

    const sp1 = await insert('student_programs', {
      student_id: student1Id,
      program_id: program,
      cohort_id: cohort,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: validFrom,
      status: 'ACTIVE',
    });
    const sp2 = await insert('student_programs', {
      student_id: student2Id,
      program_id: program,
      cohort_id: cohort,
      campus_id: T.campusId,
      department_id: T.departmentId,
      start_date: validFrom,
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
    await adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id IN ($1, $2)`, [
      te1,
      te2,
    ]);
    await insert('section_memberships', {
      student_id: student1Id,
      term_enrollment_id: te1,
      cohort_period_id: cp,
      section_id: sectionAId,
      valid_from: validFrom,
      changed_by: T.users.admin,
    });
    await insert('section_memberships', {
      student_id: student2Id,
      term_enrollment_id: te2,
      cohort_period_id: cp,
      section_id: sectionBId,
      valid_from: validFrom,
      changed_by: T.users.admin,
    });
    await insert('course_registrations', {
      term_enrollment_id: te1,
      student_id: student1Id,
      course_offering_id: courseOfferingId,
      status: 'REGISTERED',
      source: 'MANUAL',
      valid_from: validFrom,
    });
    await insert('course_registrations', {
      term_enrollment_id: te2,
      student_id: student2Id,
      course_offering_id: courseOfferingId,
      status: 'REGISTERED',
      source: 'MANUAL',
      valid_from: validFrom,
    });

    // Create Parent Users and Guardians
    const parentAUserId = uuidv7();
    const parentBUserId = uuidv7();
    const parentAEmail = `hwparenta.${RUN}@anesa.test`.toLowerCase();
    const parentBEmail = `hwparentb.${RUN}@anesa.test`.toLowerCase();

    for (const u of [
      { id: parentAUserId, email: parentAEmail, name: 'Parent Alice' },
      { id: parentBUserId, email: parentBEmail, name: 'Parent Bob' },
    ]) {
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
        [u.id, u.email, HASH],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
        [u.id, T.orgId, u.email, u.name],
      );
    }

    const guardianAId = await insert('guardians', {
      user_id: parentAUserId,
      full_name: 'Parent Alice',
      phone: '+919876543220',
      email: parentAEmail,
    });
    const guardianBId = await insert('guardians', {
      user_id: parentBUserId,
      full_name: 'Parent Bob',
      phone: '+919876543221',
      email: parentBEmail,
    });

    // Link Parent A to Student 1, Parent B to Student 2
    await insert('student_guardians', {
      student_id: student1Id,
      guardian_id: guardianAId,
      relation: 'Mother',
      is_primary: true,
      can_view_academics: true,
      can_receive_notifications: true,
      valid_from: validFrom,
    });
    await insert('student_guardians', {
      student_id: student2Id,
      guardian_id: guardianBId,
      relation: 'Father',
      is_primary: true,
      can_view_academics: true,
      can_receive_notifications: true,
      valid_from: validFrom,
    });

    // Log in all sessions
    s.teacher = await login(T.emails.faculty);
    s.studentOne = await login(T.emails.studentOne);
    s.studentTwo = await login(T.emails.studentTwo);
    s.parentA = await login(parentAEmail);
    s.parentB = await login(parentBEmail);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('1. Teacher lists authorized teaching classes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/teacher/classes',
      headers: { cookie: `session_token=${s.teacher.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: Array<{ courseOfferingId: string; courseCode: string; courseTitle: string }>;
    }>();
    expect(body.success).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const found = body.data.find((c) => c.courseOfferingId === courseOfferingId);
    expect(found).toBeDefined();
    expect(found!.courseTitle).toBe('Mathematics 101');
  });

  it('2. Teacher previews recipients for Section A vs entire offering', async () => {
    // Entire offering preview (2 students)
    const resAll = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/teacher/preview-recipients?courseOfferingId=${courseOfferingId}`,
      headers: { cookie: `session_token=${s.teacher.cookie}` },
    });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = resAll.json<{
      success: boolean;
      data: { totalCount: number; students: { studentId: string }[] };
    }>();
    expect(bodyAll.data.totalCount).toBe(2);

    // Section A preview (only Student 1)
    const resSecA = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/teacher/preview-recipients?courseOfferingId=${courseOfferingId}&sectionId=${sectionAId}`,
      headers: { cookie: `session_token=${s.teacher.cookie}` },
    });
    expect(resSecA.statusCode).toBe(200);
    const bodySecA = resSecA.json<{
      success: boolean;
      data: { totalCount: number; students: { studentId: string }[] };
    }>();
    expect(bodySecA.data.totalCount).toBe(1);
    expect(bodySecA.data.students[0]!.studentId).toBe(student1Id);
  });

  it('3. Teacher creates a homework assignment for Section A (draft)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/homework/teacher/assignments',
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
      },
      payload: {
        courseOfferingId,
        sectionId: sectionAId,
        title: 'Math Homework: Algebra Chapter 3',
        instructions: 'Complete exercises 1 through 15 on page 42. Show all working clearly.',
        submissionType: 'ONLINE',
        dueDate: futureDueDate,
        dueTime: '17:00',
        maxMarks: 100,
        allowResubmission: true,
        publishNow: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: { id: string; status: string; totalRecipients: number };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('DRAFT');
    expect(body.data.totalRecipients).toBe(1);
    homeworkId = body.data.id;
  });

  it('4. Students cannot see draft homework', async () => {
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/student/assignments',
      headers: { cookie: `session_token=${s.studentOne.cookie}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{ success: boolean; data: Array<{ id: string }> }>();
    const found = body1.data.find((h) => h.id === homeworkId);
    expect(found).toBeUndefined();
  });

  it('5. Teacher publishes the homework assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/teacher/assignments/${homeworkId}/publish`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; message: string }>();
    expect(body.success).toBe(true);
  });

  it('6. Strict Section Isolation: Student 1 (Section A) sees homework, Student 2 (Section B) does NOT', async () => {
    // Student 1 in Section A must see the homework
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/student/assignments',
      headers: { cookie: `session_token=${s.studentOne.cookie}` },
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{
      success: boolean;
      data: Array<{ id: string; title: string; submissionStatus: string }>;
    }>();
    const found1 = body1.data.find((h) => h.id === homeworkId);
    expect(found1).toBeDefined();
    expect(found1?.title).toBe('Math Homework: Algebra Chapter 3');
    expect(found1?.submissionStatus).toBe('PENDING');

    // Student 2 in Section B MUST NOT see Section A homework
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/student/assignments',
      headers: { cookie: `session_token=${s.studentTwo.cookie}` },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ success: boolean; data: Array<{ id: string }> }>();
    const found2 = body2.data.find((h) => h.id === homeworkId);
    expect(found2).toBeUndefined();
  });

  it('7. Student 2 cannot submit to Section A homework (denied with 403/404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/student/assignments/${homeworkId}/submit`,
      headers: {
        cookie: `session_token=${s.studentTwo.cookie}`,
        'x-csrf-token': s.studentTwo.csrf,
      },
      payload: {
        submissionText: 'Unauthorized submission attempt',
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('8. Student 1 submits online homework successfully', async () => {
    const fileId = uuidv7();
    await insert('files', {
      id: fileId,
      uploaded_by: T.users.studentOne,
      storage_class: 'GENERAL',
      storage_key: `${T.orgId}/GENERAL/${currentYear}/${fileId}`,
      original_name: 'algebra_exercises_sol.pdf',
      declared_mime: 'application/pdf',
      detected_mime: 'application/pdf',
      size_bytes: 204850,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      classification: 'INTERNAL',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/student/assignments/${homeworkId}/submit`,
      headers: {
        cookie: `session_token=${s.studentOne.cookie}`,
        'x-csrf-token': s.studentOne.csrf,
      },
      payload: {
        submissionText: 'Here are the solutions to exercises 1 through 15 attached in PDF.',
        files: [
          {
            fileId,
            fileName: 'algebra_exercises_sol.pdf',
            fileSizeBytes: 204850,
            mimeType: 'application/pdf',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean }>();
    expect(body.success).toBe(true);
  });

  it('9. Teacher views submissions and reviews Student 1 submission', async () => {
    // List submissions
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/teacher/assignments/${homeworkId}/submissions`,
      headers: { cookie: `session_token=${s.teacher.cookie}` },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json<{
      success: boolean;
      data: Array<{ id: string; studentId: string; status: string; files: unknown[] }>;
    }>();
    expect(listBody.data.length).toBe(1);
    expect(listBody.data[0]!.studentId).toBe(student1Id);
    expect(listBody.data[0]!.status).toBe('SUBMITTED');
    expect(listBody.data[0]!.files.length).toBe(1);
    submissionId = listBody.data[0]!.id;

    // Review submission
    const reviewRes = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/teacher/submissions/${submissionId}/review`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
      },
      payload: {
        status: 'REVIEWED',
        marksObtained: 95,
        grade: 'A',
        feedback: 'Excellent work! Problem 12 had an elegant step.',
        resubmissionAllowed: false,
      },
    });
    expect(reviewRes.statusCode).toBe(200);
    const reviewBody = reviewRes.json<{ success: boolean; message: string }>();
    expect(reviewBody.success).toBe(true);
  });

  it('10. Student 1 views reviewed homework with feedback and marks', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/student/assignments',
      headers: { cookie: `session_token=${s.studentOne.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: Array<{
        id: string;
        submissionStatus: string;
        marksObtained: number;
        grade: string;
        feedback: string;
      }>;
    }>();
    const hw = body.data.find((h) => h.id === homeworkId);
    expect(hw).toBeDefined();
    expect(hw?.submissionStatus).toBe('REVIEWED');
    expect(hw?.marksObtained).toBe(95);
    expect(hw?.grade).toBe('A');
    expect(hw?.feedback).toContain('Excellent work!');
  });

  it('11. Parent Portal: Parent A views verified child homework & feedback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/parent/children/${student1Id}/assignments`,
      headers: { cookie: `session_token=${s.parentA.cookie}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: Array<{ id: string; marksObtained: number; feedback: string }>;
    }>();
    expect(body.success).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.id).toBe(homeworkId);
    expect(body.data[0]!.marksObtained).toBe(95);
    expect(body.data[0]!.feedback).toContain('Excellent work!');
  });

  it('12. Parent B cannot access Student 1 assignments (forbidden/not linked)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/homework/parent/children/${student1Id}/assignments`,
      headers: { cookie: `session_token=${s.parentB.cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('13. Student cannot access teacher endpoints (403 forbidden)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/homework/teacher/classes',
      headers: { cookie: `session_token=${s.studentOne.cookie}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('14. Teacher closes the homework assignment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/homework/teacher/assignments/${homeworkId}/close`,
      headers: {
        cookie: `session_token=${s.teacher.cookie}`,
        'x-csrf-token': s.teacher.csrf,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
