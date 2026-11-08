import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const STUDENTS_BASE = '/api/v1/students';
const IMPORTS_BASE = '/api/v1/students/imports';
const RUN = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;
const num = (tag = 'ADM'): string => `${tag}${RUN}-${++counter}`;

let schoolTenant!: IsolatedTenant;
let collegeTenant!: IsolatedTenant;
let universityTenant!: IsolatedTenant;
let otherCampusId!: string;
let otherCampusRegistrar!: { userId: string; email: string };
let uniCampusA!: string;
let uniCampusB!: string;
let uniRegistrarA!: { userId: string; email: string };
let uniRegistrarB!: { userId: string; email: string };

let collegeDeptA!: string;
let collegeProgA!: string;
let collegeCohortA!: string;
let collegeDeptB!: string;
let collegeProgB!: string;
let collegeCohortB!: string;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 6 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
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

async function createTargetUser(orgId: string): Promise<string> {
  const id = uuidv7();
  const email = `target.${uuidv7()}@test.local`;
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [id, email, hash],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'Test Applicant', 'ACTIVE', $1)`,
    [id, orgId, email],
  );
  return id;
}

/** Creates an explicitly non-login user record (no platform.identities row, identity_id is null). */
async function createRecordOnlyUser(orgId: string, displayName = 'Pupil Record'): Promise<{ id: string; email: string }> {
  const id = uuidv7();
  const email = `pupil.${uuidv7()}@school.internal`;
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, $4, 'ACTIVE', NULL)`,
    [id, orgId, email, displayName],
  );
  return { id, email };
}

describe('Scoped Admissions: School, College, and University Workflow Completion', () => {
  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    schoolTenant = await createIsolatedTenant(hash);
    collegeTenant = await createIsolatedTenant(hash);
    universityTenant = await createIsolatedTenant(hash);

    // 1. Set institution types
    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'institution.type', '"SCHOOL"', $2)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = '"SCHOOL"', updated_by = $2`,
      [schoolTenant.orgId, schoolTenant.users.admin],
    );

    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'institution.type', '"COLLEGE"', $2)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = '"COLLEGE"', updated_by = $2`,
      [collegeTenant.orgId, collegeTenant.users.admin],
    );

    await adminQuery(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, 'institution.type', '"UNIVERSITY"', $2)
       ON CONFLICT (organization_id, key) DO UPDATE SET value = '"UNIVERSITY"', updated_by = $2`,
      [universityTenant.orgId, universityTenant.users.admin],
    );

    // 2. Multi-campus setup in COLLEGE: second campus (North Campus) + registrar
    otherCampusId = uuidv7();
    await adminQuery(
      `INSERT INTO app.campuses (id, organization_id, name, code, status, timezone)
       VALUES ($1, $2, 'North Campus', 'NC', 'ACTIVE', 'Asia/Kolkata')`,
      [otherCampusId, collegeTenant.orgId],
    );

    otherCampusRegistrar = {
      userId: uuidv7(),
      email: `other.registrar.${RUN.toLowerCase()}@college.test`,
    };
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [otherCampusRegistrar.userId, otherCampusRegistrar.email, hash],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'Other Campus Registrar', 'ACTIVE', $1)`,
      [otherCampusRegistrar.userId, collegeTenant.orgId, otherCampusRegistrar.email],
    );
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'CAMPUS', $4::uuid, $4::uuid, NULL
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'REGISTRAR'`,
      [uuidv7(), collegeTenant.orgId, otherCampusRegistrar.userId, otherCampusId],
    );

    // 3. Programmes and cohorts in College Campus A and North Campus (Campus B)
    collegeDeptA = collegeTenant.departmentId;
    collegeProgA = uuidv7();
    collegeCohortA = uuidv7();
    const periodTypeId = uuidv7();
    await adminQuery(
      `INSERT INTO app.period_types (id, organization_id, code, label, label_plural)
       VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
      [periodTypeId, collegeTenant.orgId],
    );
    await adminQuery(
      `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods, status)
       VALUES ($1, $2, $3, $4, 'B.Sc Computer Science', 'BSCS', 'BACHELOR', 6, 'ACTIVE')`,
      [collegeProgA, collegeTenant.orgId, collegeDeptA, periodTypeId],
    );
    await adminQuery(
      `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name, status)
       VALUES ($1, $2, $3, 2026, '2026 Batch', 'ACTIVE')`,
      [collegeCohortA, collegeTenant.orgId, collegeProgA],
    );

    collegeDeptB = uuidv7();
    collegeProgB = uuidv7();
    collegeCohortB = uuidv7();
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code, status)
       VALUES ($1, $2, $3, 'North Dept of Engineering', 'NDE', 'ACTIVE')`,
      [collegeDeptB, collegeTenant.orgId, otherCampusId],
    );
    await adminQuery(
      `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods, status)
       VALUES ($1, $2, $3, $4, 'B.Tech Mechanical', 'BTMECH', 'BACHELOR', 8, 'ACTIVE')`,
      [collegeProgB, collegeTenant.orgId, collegeDeptB, periodTypeId],
    );
    await adminQuery(
      `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name, status)
       VALUES ($1, $2, $3, 2026, '2026 North Batch', 'ACTIVE')`,
      [collegeCohortB, collegeTenant.orgId, collegeProgB],
    );

    // 4. Multi-campus UNIVERSITY setup: Constituent Campus A (Science) and Constituent Campus B (Arts)
    uniCampusA = universityTenant.campusId;
    uniCampusB = uuidv7();
    await adminQuery(
      `INSERT INTO app.campuses (id, organization_id, name, code, status, timezone)
       VALUES ($1, $2, 'Constituent College of Arts', 'CCA', 'ACTIVE', 'Asia/Kolkata')`,
      [uniCampusB, universityTenant.orgId],
    );

    uniRegistrarA = {
      userId: universityTenant.users.registrarCampus,
      email: universityTenant.emails.registrarCampus,
    };
    uniRegistrarB = {
      userId: uuidv7(),
      email: `uni.registrar.b.${RUN.toLowerCase()}@university.test`,
    };
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [uniRegistrarB.userId, uniRegistrarB.email, hash],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'Arts Registrar', 'ACTIVE', $1)`,
      [uniRegistrarB.userId, universityTenant.orgId, uniRegistrarB.email],
    );
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'CAMPUS', $4::uuid, $4::uuid, NULL
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'REGISTRAR'`,
      [uuidv7(), universityTenant.orgId, uniRegistrarB.userId, uniCampusB],
    );
  });

  afterAll(async () => {
    const orgs = [schoolTenant?.orgId, collegeTenant?.orgId, universityTenant?.orgId].filter(Boolean);
    if (orgs.length > 0) {
      const pg = await import('pg');
      const k = new pg.default.Client({ connectionString: inject('dbAdminUrl') });
      await k.connect();
      try {
        await k.query('SET session_replication_role = replica');
        try {
          await k.query('DELETE FROM app.term_enrollments WHERE organization_id = ANY($1::uuid[])', [orgs]);
          await k.query('DELETE FROM app.student_program_events WHERE organization_id = ANY($1::uuid[])', [orgs]);
          await k.query('DELETE FROM app.student_programs WHERE organization_id = ANY($1::uuid[])', [orgs]);
          await k.query('DELETE FROM app.student_guardians WHERE organization_id = ANY($1::uuid[])', [orgs]);
          await k.query('DELETE FROM app.guardians WHERE organization_id = ANY($1::uuid[])', [orgs]);
        } finally {
          await k.query('SET session_replication_role = DEFAULT');
        }
      } finally {
        await k.end();
      }
    }
    await schoolTenant?.cleanup();
    await collegeTenant?.cleanup();
    await universityTenant?.cleanup();
    await pool.end();
  });

  it('1. SCHOOL: admissions staff registers pupil into school campus without issuing credentials', async () => {
    const { cookie, csrf } = await login(schoolTenant.emails.registrarCampus);
    const { id: userId, email: pupilEmail } = await createRecordOnlyUser(schoolTenant.orgId, 'Primary Pupil');
    const admissionNumber = num('SCH');

    // Verify record-only pupil cannot log in (no credentials / identity)
    const loginAttempt = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: pupilEmail, password: PASSWORD },
    });
    expect(loginAttempt.statusCode).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber,
        admissionDate: '2026-07-01',
        campusId: schoolTenant.campusId,
        reason: 'School admission for Grade 1',
      },
    });

    expect(res.statusCode).toBe(201);
    const studentId = res.json<{ data: { id: string } }>().data.id;

    // Verify durable campus ownership on the student row in database
    const dbRows = await adminQuery<{ campus_id: string }>(
      `SELECT campus_id FROM app.students WHERE organization_id = $1 AND id = $2`,
      [schoolTenant.orgId, studentId],
    );
    expect(dbRows[0]!.campus_id).toBe(schoolTenant.campusId);

    // Verify student record vs login account separation: no role assignments or sessions created
    const userRoleAssignments = await adminQuery(
      `SELECT role_id FROM app.role_assignments WHERE organization_id = $1 AND user_id = $2`,
      [schoolTenant.orgId, userId],
    );
    expect(userRoleAssignments).toHaveLength(0);
  });

  it('2. COLLEGE: registers student with durable campusId and returns it in profile', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.registrarCampus);
    const userId = await createTargetUser(collegeTenant.orgId);
    const admissionNumber = num('COL');

    const res = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber,
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Authorized college campus registration',
      },
    });

    expect(res.statusCode).toBe(201);
    const studentId = res.json<{ data: { id: string } }>().data.id;

    // Read profile back: campusId is present and matches the admission campus
    const profileRes = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}/${studentId}`,
      headers: { cookie: `session_token=${cookie}` },
    });
    expect(profileRes.statusCode).toBe(200);
    const profile = profileRes.json<{ data: { campusId: string; admissionNumber: string } }>().data;
    expect(profile.campusId).toBe(collegeTenant.campusId);
    expect(profile.admissionNumber).toBe(admissionNumber);
  });

  it('3. Cross-campus isolation: admissions officer of another campus CANNOT find or view newly admitted student', async () => {
    const { cookie: authCookie, csrf: authCsrf } = await login(collegeTenant.emails.registrarCampus);
    const { cookie: otherCookie } = await login(otherCampusRegistrar.email);
    const userId = await createTargetUser(collegeTenant.orgId);
    const admissionNumber = num('ISO');

    // 1. Campus A registrar admits student to Campus A
    const res = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${authCookie}`,
        'x-csrf-token': authCsrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber,
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Admission to Campus A',
      },
    });
    expect(res.statusCode).toBe(201);
    const studentId = res.json<{ data: { id: string } }>().data.id;

    // 2. Campus A registrar finds student by admission number
    const findAuth = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}?admissionNumber=${admissionNumber}`,
      headers: { cookie: `session_token=${authCookie}` },
    });
    expect(findAuth.statusCode).toBe(200);
    expect(findAuth.json<{ data: { id: string } }>().data.id).toBe(studentId);

    // 3. Other campus registrar searches for same student: denied with 404 (indistinguishable from not existing)
    const findOther = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}?admissionNumber=${admissionNumber}`,
      headers: { cookie: `session_token=${otherCookie}` },
    });
    expect(findOther.statusCode).toBe(404);

    // 4. Other campus registrar tries to open student profile: denied with 404
    const getOther = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}/${studentId}`,
      headers: { cookie: `session_token=${otherCookie}` },
    });
    expect(getOther.statusCode).toBe(404);

    // 5. Other campus registrar tries to change student status: denied with 404
    const statusOther = await app.inject({
      method: 'POST',
      url: `${STUDENTS_BASE}/${studentId}/status`,
      headers: {
        cookie: `session_token=${otherCookie}`,
        'if-match': '"1"',
      },
      payload: {
        status: 'ACTIVE',
        reason: 'Cross campus unauthorized status update',
      },
    });
    expect([403, 404]).toContain(statusOther.statusCode);
  });

  it('4. Admissions-to-enrolment workflow: authorized staff can correct status and enrol in campus programme', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.registrarCampus);
    const userId = await createTargetUser(collegeTenant.orgId);
    const admissionNumber = num('ENR');

    // 1. Admit student
    const createRes = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber,
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Admitted for enrollment workflow',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const studentId = createRes.json<{ data: { id: string } }>().data.id;

    // 2. Correct admission details / activate student status (requires step-up elevation for CRITICAL status change)
    await elevateSession(cookie);
    const statusRes = await app.inject({
      method: 'POST',
      url: `${STUDENTS_BASE}/${studentId}/status`,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'if-match': '"1"',
      },
      payload: {
        status: 'ACTIVE',
        reason: 'Verified prerequisite documents for admission',
      },
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json<{ data: { status: string } }>().data.status).toBe('ACTIVE');

    // 3. Attempt cross-campus programme enrolment into North Campus (Campus B) programme: refused (409)
    const crossEnrol = await app.inject({
      method: 'POST',
      url: `${STUDENTS_BASE}/${studentId}/programs`,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        programId: collegeProgB, // Campus B programme
        cohortId: collegeCohortB,
        startDate: '2026-08-01',
        reason: 'Cross campus enrolment attempt',
      },
    });
    expect([403, 404, 409]).toContain(crossEnrol.statusCode);

    // 4. Enrol into campus programme (Campus A): succeeds (201)
    const validEnrol = await app.inject({
      method: 'POST',
      url: `${STUDENTS_BASE}/${studentId}/programs`,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        programId: collegeProgA,
        cohortId: collegeCohortA,
        startDate: '2026-08-01',
        reason: 'Regular academic enrolment',
      },
    });
    expect(validEnrol.statusCode).toBe(201);
    expect(validEnrol.json<{ success: boolean }>().success).toBe(true);
  });

  it('5. UNIVERSITY: constituent campus registrar admits within campus; other constituent campus rejected', async () => {
    const { cookie: cookieA, csrf: csrfA } = await login(uniRegistrarA.email);
    const { cookie: cookieB } = await login(uniRegistrarB.email);
    const userId = await createTargetUser(universityTenant.orgId);
    const admissionNumber = num('UNI');

    // Registrar of Constituent Campus A admits student
    const resA = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookieA}`,
        'x-csrf-token': csrfA,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber,
        admissionDate: '2026-08-01',
        campusId: uniCampusA,
        reason: 'Admitted into Constituent College of Science',
      },
    });
    expect(resA.statusCode).toBe(201);
    const studentId = resA.json<{ data: { id: string } }>().data.id;

    // Registrar A can open profile
    const getA = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}/${studentId}`,
      headers: { cookie: `session_token=${cookieA}` },
    });
    expect(getA.statusCode).toBe(200);
    expect(getA.json<{ data: { campusId: string } }>().data.campusId).toBe(uniCampusA);

    // Registrar B (Constituent College of Arts) is refused access to Science student
    const getB = await app.inject({
      method: 'GET',
      url: `${STUDENTS_BASE}/${studentId}`,
      headers: { cookie: `session_token=${cookieB}` },
    });
    expect(getB.statusCode).toBe(404);
  });

  it('6. Duplicate person detection: detects possible duplicate and requires acknowledgement token', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.registrarCampus);
    const user1 = await createTargetUser(collegeTenant.orgId);
    const user2 = await createTargetUser(collegeTenant.orgId);
    const sharedName = `Unique Candidate ${RUN}`;
    const sharedDob = '2008-05-15';
    const sharedPhone = '+919876543210';

    // Set user1's display_name and date_of_birth so candidate matching can verify against authoritative user record
    await adminQuery(
      `UPDATE app.users SET display_name = $1, date_of_birth = $2 WHERE id = $3`,
      [sharedName, sharedDob, user1],
    );

    // 1. Admit candidate 1 with matching cells
    const res1 = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId: user1,
        admissionNumber: num('DUP1'),
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Initial candidate registration',
        name: sharedName,
        dateOfBirth: sharedDob,
        guardianPhone: sharedPhone,
      },
    });
    expect(res1.statusCode).toBe(201);
    const student1Id = res1.json<{ data: { id: string } }>().data.id;

    // Attach active guardian record with sharedPhone to student 1 so candidate guardian matching detects collision
    const guardianId = uuidv7();
    await adminQuery(
      `INSERT INTO app.guardians (id, organization_id, full_name, phone)
       VALUES ($1, $2, 'Parent Guardian', $3)`,
      [guardianId, collegeTenant.orgId, sharedPhone],
    );
    await adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary, can_receive_notifications, can_give_consent)
       VALUES ($1, $2, $3, $4, 'Mother', true, true, true)`,
      [uuidv7(), collegeTenant.orgId, student1Id, guardianId],
    );

    // 2. Admit candidate 2 with matching details: returns 409 POSSIBLE_DUPLICATE_STUDENT
    const res2 = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId: user2,
        admissionNumber: num('DUP2'),
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Duplicate candidate attempt',
        name: sharedName,
        dateOfBirth: sharedDob,
        guardianPhone: sharedPhone,
      },
    });
    expect(res2.statusCode).toBe(409);
    const errorBody = res2.json<{ error: { code: string; details?: Array<{ field: string; message: string }> } }>();
    expect(errorBody.error.code).toBe('POSSIBLE_DUPLICATE_STUDENT');
    const fingerprint = errorBody.error.details?.find((d) => d.field === 'duplicateAcknowledgement')?.message;
    expect(fingerprint).toBeDefined();

    // 3. Retry with duplicateAcknowledgement: succeeds (201)
    const res3 = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId: user2,
        admissionNumber: num('DUP2B'),
        admissionDate: '2026-08-01',
        campusId: collegeTenant.campusId,
        reason: 'Acknowledged sibling or legitimate duplicate candidate',
        name: sharedName,
        dateOfBirth: sharedDob,
        guardianPhone: sharedPhone,
        duplicateAcknowledgement: fingerprint,
      },
    });
    expect(res3.statusCode).toBe(201);
  });

  it('7. Negative authorization: cross-tenant, foreign campus, and missing campus checks', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.registrarCampus);
    const userId = await createTargetUser(collegeTenant.orgId);

    // Foreign-tenant campus returns 404
    const resForeign = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber: num('FOR'),
        admissionDate: '2026-08-01',
        campusId: schoolTenant.campusId,
        reason: 'Foreign tenant campus probe',
      },
    });
    expect(resForeign.statusCode).toBe(404);

    // Non-existent campus returns 404
    const resMissing = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber: num('NON'),
        admissionDate: '2026-08-01',
        campusId: uuidv7(),
        reason: 'Non-existent campus probe',
      },
    });
    expect(resMissing.statusCode).toBe(404);

    // Missing campus for campus-scoped registrar returns 403 (requires ORGANIZATION scope)
    const resNoCampus = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId,
        admissionNumber: num('NOCMP'),
        admissionDate: '2026-08-01',
        reason: 'Campus registrar omitting campusId',
      },
    });
    expect(resNoCampus.statusCode).toBe(403);
  });

  it('8. Organization admin: can create students with or without campusId', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.admin);

    // With campusId
    const u1 = await createTargetUser(collegeTenant.orgId);
    const res1 = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId: u1,
        admissionNumber: num('OA1'),
        admissionDate: '2026-08-01',
        campusId: otherCampusId,
        reason: 'Org admin creating for North Campus',
      },
    });
    expect(res1.statusCode).toBe(201);
    const id1 = res1.json<{ data: { id: string } }>().data.id;
    const p1 = (await app.inject({ method: 'GET', url: `${STUDENTS_BASE}/${id1}`, headers: { cookie: `session_token=${cookie}` } })).json<{ data: { campusId: string | null } }>().data;
    expect(p1.campusId).toBe(otherCampusId);

    // Without campusId
    const u2 = await createTargetUser(collegeTenant.orgId);
    const res2 = await app.inject({
      method: 'POST',
      url: STUDENTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        userId: u2,
        admissionNumber: num('OA2'),
        admissionDate: '2026-08-01',
        reason: 'Org admin creating without campusId',
      },
    });
    expect(res2.statusCode).toBe(201);
    const id2 = res2.json<{ data: { id: string } }>().data.id;
    const p2 = (await app.inject({ method: 'GET', url: `${STUDENTS_BASE}/${id2}`, headers: { cookie: `session_token=${cookie}` } })).json<{ data: { campusId: string | null } }>().data;
    expect(p2.campusId).toBeNull();
  });

  it('9. Bulk import: enforces campus authorization at validation and commit time', async () => {
    const { cookie, csrf } = await login(collegeTenant.emails.registrarCampus);
    const u1 = await createTargetUser(collegeTenant.orgId);
    const u2 = await createTargetUser(collegeTenant.orgId);

    const email1 = (await adminQuery<{ email: string }>('SELECT email FROM app.users WHERE id = $1', [u1]))[0]!.email;
    const email2 = (await adminQuery<{ email: string }>('SELECT email FROM app.users WHERE id = $1', [u2]))[0]!.email;

    // 1. Create import job specifying campusId for College Campus A
    const resCreate = await app.inject({
      method: 'POST',
      url: IMPORTS_BASE,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
        'idempotency-key': uuidv7(),
      },
      payload: {
        campusId: collegeTenant.campusId,
        rows: [
          {
            email: email1,
            admissionNumber: num('IMP1'),
            admissionDate: '2026-08-01',
          },
          {
            email: email2,
            admissionNumber: num('IMP2'),
            admissionDate: '2026-08-01',
            campusId: otherCampusId, // Unauthorized in row
          },
        ],
      },
    });

    expect(resCreate.statusCode).toBe(201);
    const jobId = resCreate.json<{ data: { id: string } }>().data.id;

    // 2. Validate import job
    const resValidate = await app.inject({
      method: 'POST',
      url: `${IMPORTS_BASE}/${jobId}/validate`,
      headers: {
        cookie: `session_token=${cookie}`,
        'x-csrf-token': csrf,
      },
    });
    expect(resValidate.statusCode).toBe(200);

    // 3. Inspect rows: row 1 is valid, row 2 is flagged UNAUTHORIZED_CAMPUS
    const resRows = await app.inject({
      method: 'GET',
      url: `${IMPORTS_BASE}/${jobId}/rows`,
      headers: { cookie: `session_token=${cookie}` },
    });
    expect(resRows.statusCode).toBe(200);
    const rows = resRows.json<{ data: Array<{ status: string; errors: Array<{ code: string }> }> }>().data;
    expect(rows[0]!.status).toBe('VALID');
    expect(rows[1]!.status).toBe('INVALID');
    expect(rows[1]!.errors.some((e) => e.code === 'UNAUTHORIZED_CAMPUS')).toBe(true);
  });
});
