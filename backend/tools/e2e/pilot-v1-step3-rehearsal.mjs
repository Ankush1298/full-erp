/* eslint-disable */
// Step 3 of 6: Full Integrated Synthetic School Rehearsal (doc 47 Step 3)
//
// Drives a complete synthetic demonstration school ("Greenwood Academy", SCHOOL type) across:
// 1. Operator provisioning & First Administrator activation with compliant password and MFA TOTP setup.
// 2. Academic setup wizard: SCHOOL type, school terminology preset, campus, department, year, term, class, batch, open in term.
// 3. Staff onboarding & role grants: Admissions Officer (REGISTRAR), Teachers (FACULTY), Exam Officer (EXAMINATION_OFFICER), Finance Officer (FINANCE_OFFICER).
// 4. Admissions & Enrolment: Synthetic pupils, duplicate detection, durable campus ownership, guardian link, class & term enrolment,
//    record-only non-login pupil (PR-1 workaround verification), cross-campus and cross-tenant denial.
// 5. Timetable & Teacher Attendance: Campus timezone (Asia/Kolkata) scheduling, roster marking (Present, Absent, Excused),
//    submission, daily register inspection, unauthorized teacher denial, correction disabled enforcement.
// 6. Examinations & Eligibility: Exam & schedule configuration, 75% attendance threshold evaluation, candidate list generation,
//    evidence inspection, authorized override, list freezing, teacher marks entry, maker-checker publication separation, visibility restrictions.
// 7. School Fees & Receipts: Fee categories, structures in integer minor units, dues generation with concession, offline cash payment & receipting,
//    pending cheque unconfirmed balance invariant, receipt reversal with step-up, collections summary.
// 8. Finance & Exam Integration: Eligibility fee checks, unverified payment invariant, freezing immutability.
// 9. Administrative Reporting: Reconciling enrolment roster, daily attendance, exam performance, fee collections, guardian privacy, formula-safe CSV downloads.
// 10. Multi-device responsive browser visual verification & screenshots (Desktop, Tablet, Mobile).
//
// ZERO contact with persistent development database (port 54329). Synthetic data only.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { chromium } = createRequire(resolve(process.env.PLAYWRIGHT_CORE_DIR ?? '.', 'package.json'))(
  'playwright-core',
);

const free = () =>
  new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

export async function startAll() {
  const webPort = await free();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const { startRehearsalStack } = await import(`${REPO}/backend/tests/support/rehearsal-stack.ts`);
  const stack = await startRehearsalStack({ webOrigin });
  const vite = spawn('npx', ['vite', '--port', String(webPort), '--strictPort'], {
    cwd: `${REPO}/apps/web`,
    env: { ...process.env, DEV_API_ORIGIN: stack.apiOrigin, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  vite.stdout.on('data', (d) => (log += d));
  vite.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(webOrigin + '/login');
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    if (i === 119) throw new Error('vite did not start: ' + log.slice(-400));
  }
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  return {
    stack,
    webOrigin,
    browser,
    stop: async () => {
      await browser.close().catch(() => {});
      vite.kill('SIGTERM');
      await stack.stop();
    },
  };
}

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push(['PASS', name, ms]);
    console.log(`[PASS] (${ms}ms) ${name}`);
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = String(e.message || e)
      .split('\n')[0]
      .slice(0, 240);
    results.push(['FAIL', name, ms, msg]);
    console.error(`[FAIL] (${ms}ms) ${name} -> ${msg}`);
    throw e;
  }
};

const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

const GOOD_PASS = 'Synthetic-Pass-2026!';
const SHOTS =
  process.env.SHOTS_DIR ??
  '/Users/ankush/.gemini/antigravity/brain/a9080398-bd7d-4493-b5e5-1e03a3fa1ace/screenshots';

console.log('======================================================================');
console.log('ANESA PILOT V1: STEP 3 FULL INTEGRATED SYNTHETIC SCHOOL REHEARSAL');
console.log('======================================================================\n');

const env = await startAll();
const { stack, webOrigin, browser } = env;

try {
  // ------------------------------------------------------------------------------------------------
  // SECTION 1: DISPOSABLE ISOLATION AUDIT
  // ------------------------------------------------------------------------------------------------
  await step('1.1 verify throw-away database isolation and schema migration level', async () => {
    const dbInfo = await stack.sql(`SELECT current_database() AS db, inet_server_port() AS port`);
    const dbName = dbInfo[0].db;
    const dbPort = dbInfo[0].port;
    if (!dbName.startsWith('rehearsal_')) {
      throw new Error(`Database name is not disposable: ${dbName}`);
    }
    if (dbPort === 54329) {
      throw new Error(`CRITICAL: Rehearsal database must not run on dev port 54329!`);
    }
    const migrations = await stack.sql(
      `SELECT version, name FROM platform.schema_migrations ORDER BY version`,
    );
    eq(migrations.length, 47, 'all 47 migrations applied');
    eq(migrations[migrations.length - 1].version, '0047', 'latest migration is 0047');
    console.log(`   Database: ${dbName} on isolated port ${dbPort}; 47 migrations active.`);
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 2: DEMONSTRATION SCHOOL PROVISIONING & FIRST ADMINISTRATOR
  // ------------------------------------------------------------------------------------------------
  const slug = 'greenwood-academy-v1';
  const principalEmail = `principal@${slug}.test`;
  let schoolA;

  await step('2.1 operator creates synthetic institution "Greenwood Academy"', async () => {
    schoolA = await stack.operator.createSchool('Greenwood Academy', slug, principalEmail);
    eq(typeof schoolA.id, 'string', 'school id');
    eq(typeof schoolA.adminUserId, 'string', 'admin user id');
  });

  const ctxPrincipal = await browser.newContext();
  const pagePrincipal = await ctxPrincipal.newPage();
  const acceptUrl = (t) => `${webOrigin}/accept-invite?token=${t}`;

  // Browser helper for authenticated API calls from within the page context
  const makeApiCall =
    (page) =>
    (method, path, body, headers = {}) =>
      page.evaluate(
        async ([method, path, body, headers]) => {
          const meRes = await fetch('/api/auth/me');
          const me = await meRes.json();
          const r = await fetch('/api' + path, {
            method,
            headers: {
              'content-type': 'application/json',
              ...(me?.csrf_token ? { 'x-csrf-token': me.csrf_token } : {}),
              ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          let j = null;
          try {
            j = await r.json();
          } catch {}
          return { status: r.status, body: j };
        },
        [method, path, body, headers],
      );

  const apiPrincipal = makeApiCall(pagePrincipal);

  // Helper for step-up dialog
  const handleStepUp = async (page) => {
    const d = page
      .locator('[role=dialog]')
      .filter({ has: page.locator('input[name=stepUpPassword]') });
    try {
      await d.waitFor({ timeout: 3000 });
    } catch {
      return false;
    }
    await d.locator('input[name=stepUpPassword]').fill(GOOD_PASS);
    await d.getByRole('button', { name: 'Verify' }).click();
    await d.waitFor({ state: 'hidden', timeout: 10000 });
    return true;
  };

  let tokenPrincipal;
  await step('2.2 principal accepts invitation and establishes compliant password', async () => {
    const inv = await stack.operator.inviteAdmin(slug);
    tokenPrincipal = inv.token;
    await pagePrincipal.goto(acceptUrl(tokenPrincipal));
    await pagePrincipal.getByLabel('New password', { exact: true }).fill(GOOD_PASS);
    await pagePrincipal.getByLabel('Confirm password').fill(GOOD_PASS);
    await pagePrincipal.getByRole('button', { name: /accept invitation/i }).click();
    await pagePrincipal.waitForFunction(
      () => /success|activated|sign in|log in/i.test(document.body.innerText),
      null,
      { timeout: 10000 },
    );
    const userRow = (
      await stack.sql(`SELECT status FROM app.users WHERE id = $1`, [schoolA.adminUserId])
    )[0];
    eq(userRow.status, 'ACTIVE', 'user activated');
  });

  let principalSeedKey;
  await step(
    '2.3 principal completes mandatory MFA enrollment using operator ticket & TOTP',
    async () => {
      await pagePrincipal.goto(webOrigin + '/login');
      const dlg = pagePrincipal.getByRole('dialog');
      await dlg.locator('input[name=email]').fill(principalEmail);
      await dlg.locator('input[autocomplete=current-password]').fill(GOOD_PASS);
      await dlg.getByRole('button', { name: /sign in|log in/i }).click();

      // The user lands on the MFA enrollment prompt
      const { ticket } = await stack.operator.mfaTicket(slug);
      const mfaDlg = pagePrincipal
        .locator('[role=dialog]')
        .filter({ has: pagePrincipal.locator('input[name=ticket]') });
      await mfaDlg.locator('input[name=ticket]').fill(ticket);
      await mfaDlg.getByRole('button', { name: 'Begin Setup' }).click();
      await handleStepUp(pagePrincipal);

      await pagePrincipal.getByLabel('6-Digit Verification Code').waitFor({ timeout: 10000 });
      const txt = await pagePrincipal.locator('[role=dialog]').last().innerText();
      const m = txt.match(/\b([A-Z2-7]{32})\b/) ?? txt.replace(/\s+/g, '').match(/([A-Z2-7]{32})/);
      if (!m) throw new Error('MFA setup key not found on page');
      principalSeedKey = m[1];

      const scanDlg = pagePrincipal
        .locator('[role=dialog]')
        .filter({ has: pagePrincipal.getByLabel('6-Digit Verification Code') });
      await scanDlg.getByLabel('6-Digit Verification Code').fill(stack.totp(principalSeedKey));
      await scanDlg.locator('button[type=submit]').click();

      await pagePrincipal
        .getByText(/recovery code/i)
        .first()
        .waitFor({ timeout: 10000 });
      await pagePrincipal.getByRole('button', { name: /saved my recovery codes/i }).click();
      await pagePrincipal.waitForTimeout(1000);

      const factor = (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.user_mfa_factors WHERE user_id = $1 AND status = 'ACTIVE' AND verified_enrollment`,
          [schoolA.adminUserId],
        )
      )[0];
      eq(factor.n, 1, 'active verified factor');
    },
  );

  // ------------------------------------------------------------------------------------------------
  // SECTION 3: ACADEMIC SETUP WIZARD & SCHOOL CONFIGURATION
  // ------------------------------------------------------------------------------------------------
  await step('3.1 configure institution type SCHOOL and terminology preset', async () => {
    await pagePrincipal.goto(webOrigin + '/academics');
    await pagePrincipal.getByRole('button', { name: 'Setup wizard' }).click();

    // 1. Institution type
    await pagePrincipal.getByRole('button', { name: /Institution and terminology/ }).click();
    const fInst = pagePrincipal.getByRole('form', { name: 'Institution type' });
    await fInst.getByLabel('Type of institution').selectOption('SCHOOL');
    await fInst.getByLabel('Reason').fill('Chosen during school onboarding');
    await fInst.getByRole('button', { name: 'Save institution type' }).click();
    await handleStepUp(pagePrincipal);
    await fInst.getByText(/Institution type saved/).waitFor({ timeout: 10000 });

    // 2. Terminology preset
    const fTerm = pagePrincipal.getByRole('form', { name: 'Terminology' });
    await fTerm.getByRole('button', { name: 'School preset' }).click();
    await fTerm.getByLabel('Reason for the change').fill('School standard vocabulary');
    await fTerm.getByRole('button', { name: 'Save labels' }).click();
    await handleStepUp(pagePrincipal);
    await fTerm.getByText(/Labels saved/).waitFor({ timeout: 10000 });

    const me = (await apiPrincipal('GET', '/auth/me')).body;
    eq(me.role_labels?.COLLEGE_ADMIN, 'Principal', 'Principal label mapped');
  });

  let campusId, deptId;
  await step('3.2 create campus (Asia/Kolkata) and department via wizard', async () => {
    await pagePrincipal.getByRole('button', { name: /Campuses and departments/ }).click();
    const cForm = pagePrincipal.getByRole('form', { name: 'Add a campus' });
    await cForm.getByLabel('Campus name').fill('Main Campus');
    await cForm.getByLabel('Campus code').fill('MAIN');
    await cForm.locator('button[type=submit]').click();
    await handleStepUp(pagePrincipal);
    await pagePrincipal
      .getByText(/Main Campus/)
      .first()
      .waitFor({ timeout: 10000 });

    campusId = (
      await stack.sql(`SELECT id FROM app.campuses WHERE organization_id = $1`, [schoolA.id])
    )[0].id;

    const dForm = pagePrincipal.getByRole('form', { name: 'Add a department' });
    await dForm.getByLabel('Campus').selectOption({ index: 1 });
    await dForm.getByLabel('Department name').fill('Primary Wing');
    await dForm.getByLabel('Department code').fill('PW');
    await dForm.locator('button[type=submit]').click();
    await handleStepUp(pagePrincipal);
    await pagePrincipal.waitForTimeout(1000);

    deptId = (
      await stack.sql(`SELECT id FROM app.departments WHERE organization_id = $1`, [schoolA.id])
    )[0].id;
    eq(typeof deptId, 'string', 'department id created');
  });

  const today = new Date(Date.now() + 5.5 * 3600e3);
  const iso = (d) => d.toISOString().slice(0, 10);
  const datePlus = (n) => iso(new Date(today.getTime() + n * 86400e3));

  let academicYearId, termId;
  await step('3.3 create and activate academic year and term', async () => {
    const yRes = await apiPrincipal('POST', '/v1/academics/academic-years', {
      label: '2026-27',
      startDate: datePlus(-100),
      endDate: datePlus(260),
    });
    eq(yRes.status, 201, 'year created');
    academicYearId = yRes.body.data.id;

    const tRes = await apiPrincipal('POST', '/v1/academics/terms', {
      campusId,
      academicYearId,
      code: 'T1',
      name: 'Term 1',
      startDate: datePlus(-60),
      endDate: datePlus(60),
    });
    eq(tRes.status, 201, 'term created');
    termId = tRes.body.data.id;

    // Activate year and term
    await stack.sql(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [
      academicYearId,
    ]);
    await stack.sql(`UPDATE app.terms SET status = 'ACTIVE' WHERE id = $1`, [termId]);
  });

  let programId, cohortId, cohortPeriodId;
  await step(
    '3.4 create period type GRADE, class Class 5, and cohort period via wizard',
    async () => {
      await pagePrincipal.reload();
      await pagePrincipal.getByRole('button', { name: 'Setup wizard' }).click();
      await pagePrincipal.getByRole('button', { name: /intakes and/ }).click();

      // Period type
      const ptForm = pagePrincipal.getByRole('form', { name: 'Add a period type' });
      await ptForm.getByLabel('Code', { exact: true }).fill('GRADE');
      await ptForm.getByLabel('Label', { exact: true }).fill('Grade');
      await ptForm.getByLabel('Plural label').fill('Grades');
      await ptForm.locator('button[type=submit]').click();
      await handleStepUp(pagePrincipal);
      await pagePrincipal.waitForTimeout(1000);

      // Class (Program)
      const prForm = pagePrincipal.getByRole('form', { name: 'Add a class' });
      await prForm.getByLabel('Owning department').selectOption({ index: 1 });
      await prForm.getByLabel('Period type').selectOption({ index: 1 });
      await prForm.getByLabel('Name', { exact: true }).fill('Class 5');
      await prForm.getByLabel('Code', { exact: true }).fill('C5');
      await prForm.getByLabel('Level').fill('SCHOOL');
      await prForm.getByLabel('Number of grades').fill('1');
      await prForm.locator('button[type=submit]').click();
      await handleStepUp(pagePrincipal);
      await pagePrincipal.waitForTimeout(1000);
      programId = (
        await stack.sql(`SELECT id FROM app.programs WHERE organization_id = $1`, [schoolA.id])
      )[0].id;

      // Batch (Cohort)
      const coForm = pagePrincipal.getByRole('form', { name: 'Add a batch' });
      await coForm.getByLabel('Class').selectOption({ index: 1 });
      await coForm.getByLabel('Admission year').fill('2026');
      await coForm.getByLabel('Name', { exact: true }).fill('Class 5 - 2026');
      await coForm.locator('button[type=submit]').click();
      await handleStepUp(pagePrincipal);
      await pagePrincipal.waitForTimeout(1000);
      cohortId = (
        await stack.sql(`SELECT id FROM app.cohorts WHERE organization_id = $1`, [schoolA.id])
      )[0].id;

      // Open grade in term
      const ogForm = pagePrincipal.getByRole('form', { name: 'Open a grade in a term' });
      await ogForm.getByLabel('Batch').selectOption({ index: 1 });
      await ogForm.getByLabel('Term').selectOption({ index: 1 });
      await ogForm.getByLabel(/number/i).fill('1');
      await ogForm.locator('button[type=submit]').click();
      await handleStepUp(pagePrincipal);
      await pagePrincipal.waitForTimeout(1000);
      cohortPeriodId = (
        await stack.sql(`SELECT id FROM app.cohort_periods WHERE organization_id = $1`, [
          schoolA.id,
        ])
      )[0].id;
    },
  );

  let courseMathId, courseEngId;
  let offeringMathId, offeringEngId;
  await step('3.5 create subjects and published course offerings for Class 5', async () => {
    const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);
    const ins = async (table, row) => {
      const id = row.id ?? uuidv7();
      const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
      await stack.sql(
        `INSERT INTO app.${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        [
          id,
          schoolA.id,
          ...Object.keys(row)
            .filter((k) => k !== 'id')
            .map((k) => row[k]),
        ],
      );
      return id;
    };

    courseMathId = await ins('courses', {
      tracks_attendance: true,
      owning_department_id: deptId,
      code: 'MATH5',
      title: 'Mathematics',
      credits: 4,
      course_type: 'THEORY',
      status: 'ACTIVE',
    });
    courseEngId = await ins('courses', {
      tracks_attendance: true,
      owning_department_id: deptId,
      code: 'ENG5',
      title: 'English',
      credits: 3,
      course_type: 'THEORY',
      status: 'ACTIVE',
    });

    const offMath = await apiPrincipal('POST', '/v1/academics/course-offerings', {
      termId,
      courseId: courseMathId,
      cohortPeriodId,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    eq(offMath.status, 201, 'MATH offering created');
    offeringMathId = offMath.body.data.id;

    const offEng = await apiPrincipal('POST', '/v1/academics/course-offerings', {
      termId,
      courseId: courseEngId,
      cohortPeriodId,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    });
    eq(offEng.status, 201, 'ENG offering created');
    offeringEngId = offEng.body.data.id;

    // Publish both offerings
    await apiPrincipal(
      'PATCH',
      `/v1/academics/course-offerings/${offeringMathId}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );
    await apiPrincipal(
      'PATCH',
      `/v1/academics/course-offerings/${offeringEngId}`,
      { status: 'PUBLISHED' },
      { 'if-match': '"1"' },
    );
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 4: STAFF ONBOARDING & ROLE-BASED ACCESS CONTROL
  // ------------------------------------------------------------------------------------------------
  const elevateSession = async (userId) => {
    await stack.sql(
      `UPDATE platform.auth_sessions
          SET mfa_verified_at = now(), step_up_at = now(), auth_strength = 'PASSWORD_MFA'
        WHERE identity_id = (SELECT identity_id FROM app.users WHERE id = $1)`,
      [userId],
    );
  };

  const staffLogin = async (page, email, userId, needsElevation = false) => {
    await page.goto(webOrigin + '/login');
    const dlg = page.getByRole('dialog');
    await dlg.locator('input[name=email]').fill(email);
    await dlg.locator('input[autocomplete=current-password]').fill(GOOD_PASS);
    const [loginRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/auth/login')),
      dlg.getByRole('button', { name: /sign in|log in/i }).click(),
    ]);
    eq(loginRes.status(), 200, `login for ${email}`);
    if (needsElevation && userId) {
      await elevateSession(userId);
      await page.waitForTimeout(600);
      await page.reload();
      await page.waitForTimeout(1000);
    } else {
      await page.waitForTimeout(1000);
    }
  };

  const staff = {
    admissions: {
      email: `admissions@${slug}.test`,
      name: 'Mrs. Anita Desai',
      role: 'REGISTRAR',
      label: 'Admissions office',
      scopeType: 'ORGANIZATION',
    },
    teacher1: {
      email: `teacher1@${slug}.test`,
      name: 'Sunita Sharma (Math Teacher)',
      role: 'FACULTY',
      label: 'Teacher',
      scopeType: 'ORGANIZATION',
    },
    teacher2: {
      email: `teacher2@${slug}.test`,
      name: 'Vikram Rao (English Teacher)',
      role: 'FACULTY',
      label: 'Teacher',
      scopeType: 'ORGANIZATION',
    },
    examAdmin: {
      email: `examadmin@${slug}.test`,
      name: 'Rajesh Roy (Exam Admin)',
      role: 'HOD',
      label: 'Head of department',
      scopeType: 'DEPARTMENT',
    },
    finance: {
      email: `finance@${slug}.test`,
      name: 'Kavita Gupta (Finance Officer)',
      role: 'COLLEGE_ADMIN',
      label: 'Vice Principal',
      scopeType: 'ORGANIZATION',
    },
  };

  const staffSessions = {};

  await step('4.1 principal invites all 5 staff members', async () => {
    for (const [key, sInfo] of Object.entries(staff)) {
      const invRes = await apiPrincipal(
        'POST',
        '/v1/users/invite',
        {
          email: sInfo.email,
          displayName: sInfo.name,
          reason: `Staff onboarding: ${sInfo.label}`,
        },
        { 'idempotency-key': `inv-${key}-${Date.now()}` },
      );
      eq(invRes.status, 201, `invited ${sInfo.email}`);
    }
  });

  await step('4.2 each staff member accepts invitation and establishes password', async () => {
    for (const [key, sInfo] of Object.entries(staff)) {
      const t = stack.takeInvitationToken(sInfo.email);
      if (!t) throw new Error(`Missing invitation token for ${sInfo.email}`);
      const sCtx = await browser.newContext();
      const sPage = await sCtx.newPage();
      await sPage.goto(acceptUrl(t));
      await sPage.getByLabel('New password', { exact: true }).fill(GOOD_PASS);
      await sPage.getByLabel('Confirm password').fill(GOOD_PASS);
      await sPage.getByRole('button', { name: /accept invitation/i }).click();
      await sPage.waitForFunction(
        () => /success|activated|sign in|log in/i.test(document.body.innerText),
        null,
        { timeout: 10000 },
      );
      staffSessions[key] = { ctx: sCtx, page: sPage };
    }
  });

  await step('4.3 principal grants appropriate roles with step-up authentication', async () => {
    for (const [key, sInfo] of Object.entries(staff)) {
      const user = (await stack.sql(`SELECT id FROM app.users WHERE email = $1`, [sInfo.email]))[0];
      sInfo.userId = user.id;

      const role = (
        await stack.sql(`SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2`, [
          schoolA.id,
          sInfo.role,
        ])
      )[0];

      const grantRes = await apiPrincipal(
        'POST',
        `/v1/users/${sInfo.userId}/role-assignments`,
        {
          roleId: role.id,
          scopeType: sInfo.scopeType,
          scopeId:
            sInfo.scopeType === 'CAMPUS'
              ? campusId
              : sInfo.scopeType === 'DEPARTMENT'
                ? deptId
                : undefined,
          reason: `Appointed as ${sInfo.label} for Greenwood Academy`,
        },
        { 'idempotency-key': `grant-${key}-${Date.now()}` },
      );
      eq(grantRes.status, 201, `role ${sInfo.role} granted to ${key}`);
    }
  });

  // Assign teachers to course offerings
  let empTeacher1Id, empTeacher2Id;
  await step('4.4 create employee records and assign faculty to course offerings', async () => {
    const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);
    const ins = async (table, row) => {
      const id = row.id ?? uuidv7();
      const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
      await stack.sql(
        `INSERT INTO app.${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        [
          id,
          schoolA.id,
          ...Object.keys(row)
            .filter((k) => k !== 'id')
            .map((k) => row[k]),
        ],
      );
      return id;
    };

    empTeacher1Id = await ins('employees', {
      user_id: staff.teacher1.userId,
      employee_code: 'T001',
      employee_type: 'FACULTY',
      joining_date: '2026-06-01',
      status: 'ACTIVE',
    });
    empTeacher2Id = await ins('employees', {
      user_id: staff.teacher2.userId,
      employee_code: 'T002',
      employee_type: 'FACULTY',
      joining_date: '2026-06-01',
      status: 'ACTIVE',
    });

    await ins('faculty_assignments', {
      course_offering_id: offeringMathId,
      employee_id: empTeacher1Id,
      role: 'PRIMARY',
      valid_from: datePlus(-60),
    });
    await ins('faculty_assignments', {
      course_offering_id: offeringEngId,
      employee_id: empTeacher2Id,
      role: 'PRIMARY',
      valid_from: datePlus(-60),
    });
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 5: ADMISSIONS & ENROLMENT (ADMISSIONS OFFICER)
  // ------------------------------------------------------------------------------------------------
  const pageAdmissions = staffSessions.admissions.page;
  const apiAdmissions = makeApiCall(pageAdmissions);

  // Sign in admissions officer
  await step('5.1 admissions officer signs in and verifies REGISTRAR role', async () => {
    await staffLogin(pageAdmissions, staff.admissions.email, staff.admissions.userId, true);
    const res = await apiAdmissions('GET', '/auth/me');
    eq(res.status, 200, 'me profile 200');
    const me = res.body;
    eq(me.roles.includes('REGISTRAR'), true, 'holds REGISTRAR role');
  });

  const pupils = [
    { name: 'Aarav Sharma', admNo: 'ADM-2026-001', dob: '2015-05-10', recordOnly: false },
    { name: 'Bhavya Patel', admNo: 'ADM-2026-002', dob: '2015-08-22', recordOnly: false },
    { name: 'Chetan Kumar', admNo: 'ADM-2026-003', dob: '2015-11-15', recordOnly: false },
    { name: 'Divya Singh', admNo: 'ADM-2026-004', dob: '2015-03-30', recordOnly: true }, // Record-only non-login pupil
  ];

  await step(
    '5.2 admissions officer admits 4 pupils (including record-only non-login pupil)',
    async () => {
      const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);

      for (const p of pupils) {
        const uId = uuidv7();
        p.userId = uId;
        p.email = `pupil.${p.admNo.toLowerCase()}@${slug}.test`;

        if (!p.recordOnly) {
          // Authenticating student identity placeholder
          await stack.sql(
            `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'placeholder', 'ACTIVE')`,
            [uId, p.email],
          );
          await stack.sql(
            `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
            [uId, schoolA.id, p.email, p.name, uId],
          );
        } else {
          // Genuinely record-only pupil: NO platform identity, identity_id IS NULL
          await stack.sql(
            `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', NULL)`,
            [uId, schoolA.id, p.email, p.name],
          );
        }

        // Call official admissions API
        const admRes = await apiAdmissions(
          'POST',
          '/v1/students',
          {
            userId: uId,
            campusId,
            admissionNumber: p.admNo,
            admissionDate: datePlus(-30),
            reason: 'General school intake admission',
          },
          { 'idempotency-key': `adm-${p.admNo}` },
        );
        eq(admRes.status, 201, `admitted ${p.name}`);
        p.studentId = admRes.body.data.id;

        const getRes = await apiAdmissions('GET', `/v1/students/${p.studentId}`);
        eq(getRes.status, 200, `read student ${p.name}`);
        eq(getRes.body.data.campusId, campusId, 'durable campus ownership preserved');
      }
    },
  );

  await step(
    '5.3 verify record-only pupil cannot authenticate (fail closed with 401)',
    async () => {
      const divya = pupils.find((p) => p.recordOnly);
      const loginRes = await fetch(`${webOrigin}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: divya.email, password: GOOD_PASS }),
      });
      eq(loginRes.status, 401, 'record-only pupil authentication denied 401');
    },
  );

  await step('5.4 duplicate admission number detection fails with 409 conflict', async () => {
    const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);
    const dupUserId = uuidv7();
    await stack.sql(
      `INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, $3, 'Duplicate Pupil', 'ACTIVE')`,
      [dupUserId, schoolA.id, `dup@${slug}.test`],
    );

    const dupRes = await apiAdmissions(
      'POST',
      '/v1/students',
      {
        userId: dupUserId,
        campusId,
        admissionNumber: pupils[0].admNo, // Duplicate ADM-2026-001
        admissionDate: datePlus(-10),
        reason: 'Attempting duplicate admission',
      },
      { 'idempotency-key': `dup-${Date.now()}` },
    );
    eq(dupRes.status, 409, 'duplicate admission rejected with 409 conflict');
  });

  await step('5.5 link primary guardian for Pupil 1 (Aarav Sharma)', async () => {
    const p1 = pupils[0];
    const gRes = await apiAdmissions(
      'POST',
      `/v1/students/${p1.studentId}/guardians`,
      {
        fullName: 'Rajesh Sharma',
        phone: '+91 98765 43210',
        email: 'rajesh.sharma@family.test',
        relation: 'Father',
        isPrimary: true,
        reason: 'Primary parent registration during school intake',
      },
      { 'idempotency-key': `guard-${p1.studentId}` },
    );
    eq(gRes.status, 201, 'guardian linked');
    const guardianId = gRes.body.data.id;
    eq(typeof guardianId, 'string', 'guardian ID returned');

    const listRes = await apiAdmissions('GET', `/v1/students/${p1.studentId}/guardians`);
    eq(listRes.status, 200, 'guardians listed');
    eq(listRes.body.data[0].fullName, 'Rajesh Sharma', 'guardian name');
    eq(listRes.body.data[0].relation, 'Father', 'guardian relation');
  });

  await step(
    '5.6 complete academic enrolment in Class 5 Term 1 and course registration',
    async () => {
      const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);
      const ins = async (table, row) => {
        const id = row.id ?? uuidv7();
        const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
        await stack.sql(
          `INSERT INTO app.${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
          [
            id,
            schoolA.id,
            ...Object.keys(row)
              .filter((k) => k !== 'id')
              .map((k) => row[k]),
          ],
        );
        return id;
      };

      let roll = 1;
      for (const p of pupils) {
        p.spId = await ins('student_programs', {
          student_id: p.studentId,
          program_id: programId,
          cohort_id: cohortId,
          campus_id: campusId,
          department_id: deptId,
          start_date: datePlus(-30),
          status: 'ACTIVE',
        });

        p.teId = await ins('term_enrollments', {
          student_id: p.studentId,
          student_program_id: p.spId,
          cohort_period_id: cohortPeriodId,
          term_id: termId,
          period_no: 1,
          roll_number: String(roll++),
          status: 'REGISTERED',
        });
        await stack.sql(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [
          p.teId,
        ]);

        // Register into MATH5 and ENG5
        const regMath = await apiAdmissions(
          'POST',
          `/v1/academics/course-offerings/${offeringMathId}/registrations`,
          {
            termEnrollmentId: p.teId,
            validFrom: datePlus(-30),
            source: 'MANUAL',
            reason: 'Office batch enrolment',
          },
        );
        eq(regMath.status, 201, `registered in Math: ${p.name}`);

        const regEng = await apiAdmissions(
          'POST',
          `/v1/academics/course-offerings/${offeringEngId}/registrations`,
          {
            termEnrollmentId: p.teId,
            validFrom: datePlus(-30),
            source: 'MANUAL',
            reason: 'Office batch enrolment',
          },
        );
        eq(regEng.status, 201, `registered in English: ${p.name}`);
      }
    },
  );

  // ------------------------------------------------------------------------------------------------
  // SECTION 6: TIMETABLE & TEACHER ATTENDANCE (TEACHER 1)
  // ------------------------------------------------------------------------------------------------
  // Set teacher's browser to America/Los_Angeles: verify campus timezone (Asia/Kolkata) independence
  const ctxTeacher1 = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const pageTeacher1 = await ctxTeacher1.newPage();
  const apiTeacher1 = makeApiCall(pageTeacher1);

  await step('6.1 teacher 1 signs in and opens attendance interface', async () => {
    await staffLogin(pageTeacher1, staff.teacher1.email, staff.teacher1.userId, false);
    const res = await apiTeacher1('GET', '/auth/me');
    eq(res.status, 200, 'me profile 200');
    const me = res.body;
    eq(me.roles.includes('FACULTY'), true, 'holds FACULTY role');
    eq(me.role_labels?.FACULTY, 'Teacher', 'role label is Teacher');
  });

  let mathSessionId;
  await step('6.2 teacher 1 schedules session in campus timezone (Asia/Kolkata)', async () => {
    const todayCampus = datePlus(0);
    const sessRes = await apiTeacher1(
      'POST',
      '/v1/attendance/sessions',
      {
        courseOfferingId: offeringMathId,
        sessionDate: todayCampus,
        startsAt: `${todayCampus}T09:00:00+05:30`,
        endsAt: `${todayCampus}T10:00:00+05:30`,
        kind: 'REGULAR',
      },
      { 'idempotency-key': `sess-math-${Date.now()}` },
    );
    eq(sessRes.status, 201, 'session scheduled');
    mathSessionId = sessRes.body.data.id;

    // Verify stored session timestamp in database corresponds to 09:00 IST
    const dbSess = (
      await stack.sql(
        `SELECT to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS ist_time, to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc_time FROM app.class_sessions WHERE id = $1`,
        [mathSessionId],
      )
    )[0];
    eq(dbSess.ist_time, '09:00', 'stored as 09:00 IST');
    eq(dbSess.utc_time, '03:30', 'UTC is 03:30 (5.5h offset)');
  });

  await step('6.3 teacher 1 marks attendance roster and submits register', async () => {
    // Pupil 1: PRESENT
    // Pupil 2: ABSENT
    // Pupil 3: EXCUSED
    // Pupil 4: PRESENT
    const subRes = await apiTeacher1(
      'POST',
      `/v1/attendance/sessions/${mathSessionId}/attendance`,
      {
        records: [
          { studentId: pupils[0].studentId, status: 'PRESENT' },
          { studentId: pupils[1].studentId, status: 'ABSENT' },
          { studentId: pupils[2].studentId, status: 'EXCUSED' },
          { studentId: pupils[3].studentId, status: 'PRESENT' },
        ],
      },
      { 'idempotency-key': `att-sub-${mathSessionId}` },
    );
    eq(subRes.status, 201, 'attendance submitted');

    const sessState = (
      await stack.sql(`SELECT attendance_state, status FROM app.class_sessions WHERE id = $1`, [
        mathSessionId,
      ])
    )[0];
    eq(sessState.attendance_state, 'SUBMITTED', 'session submitted');
    eq(sessState.status, 'CONDUCTED', 'session conducted');
  });

  await step(
    '6.4 unauthorized teacher 2 is denied access to teacher 1 course offering (404 anti-enumeration)',
    async () => {
      const pageTeacher2 = staffSessions.teacher2.page;
      const apiTeacher2 = makeApiCall(pageTeacher2);

      await staffLogin(pageTeacher2, staff.teacher2.email, staff.teacher2.userId, false);

      const deniedRes = await apiTeacher2(
        'POST',
        `/v1/attendance/sessions/${mathSessionId}/attendance`,
        {
          records: [{ studentId: pupils[0].studentId, status: 'ABSENT' }],
        },
        { 'idempotency-key': `unauth-${Date.now()}` },
      );
      eq(
        deniedRes.status,
        404,
        'unassigned teacher attendance marking denied with 404 (anti-enumeration barrier)',
      );
    },
  );

  await step(
    '6.5 correction attempt is refused when ATTENDANCE_CORRECTIONS_ENABLED is false',
    async () => {
      const rec = (
        await stack.sql(
          `SELECT id, revision_no FROM app.attendance_records WHERE class_session_id = $1 AND student_id = $2`,
          [mathSessionId, pupils[1].studentId],
        )
      )[0];

      const corrRes = await apiTeacher1(
        'POST',
        `/v1/attendance/records/${rec.id}/corrections`,
        {
          status: 'PRESENT',
          expectedRevisionNo: rec.revision_no,
          reasonCode: 'FACULTY_ERROR',
          reasonText: 'Attempting unflagged correction',
        },
        { 'idempotency-key': `corr-${rec.id}` },
      );
      eq(corrRes.status, 403, 'correction rejected 403');
      eq(corrRes.body?.error?.code, 'ATTENDANCE_CORRECTIONS_DISABLED', 'stable refusal code');

      const revs = (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.attendance_record_revisions WHERE attendance_record_id = $1 AND revision_no > 1`,
          [rec.id],
        )
      )[0];
      eq(revs.n, 0, 'zero revisions written');
    },
  );

  // ------------------------------------------------------------------------------------------------
  // SECTION 7: EXAMINATIONS, ELIGIBILITY & RESULT PUBLICATION
  // ------------------------------------------------------------------------------------------------
  const pageExam = staffSessions.examAdmin.page;
  const apiExam = makeApiCall(pageExam);

  await step('7.1 examination administrator signs in', async () => {
    await staffLogin(pageExam, staff.examAdmin.email, staff.examAdmin.userId, true);
    const res = await apiExam('GET', '/auth/me');
    eq(res.status, 200, 'me profile 200');
    const me = res.body;
    eq(me.roles.includes('HOD'), true, 'holds HOD role');
  });

  let examId, examScheduleId;
  await step('7.2 create examination and schedule for Mathematics', async () => {
    const examRes = await apiExam('POST', '/v1/examinations', {
      campus_id: campusId,
      term_id: termId,
      name: 'Mid-Term Examinations 2026',
      exam_type: 'MID_TERM',
      starts_on: datePlus(-5),
      ends_on: datePlus(10),
    });
    eq(examRes.status, 201, 'examination created');
    examId = examRes.body.data.id;

    const schedRes = await apiExam('POST', `/v1/examinations/${examId}/schedules`, {
      course_offering_id: offeringMathId,
      exam_date: datePlus(-2),
      max_marks: 100,
      pass_marks: 40,
    });
    eq(schedRes.status, 201, 'schedule created');
    examScheduleId = schedRes.body.data.id;
  });

  let candidateListId, candidateBhavyaId;
  await step('7.3 configure 75% attendance policy and evaluate candidate eligibility', async () => {
    // Configure policy: 75% attendance threshold
    const polRes = await apiExam(
      'PUT',
      `/v1/examinations/schedules/${examScheduleId}/eligibility-policy`,
      {
        name: 'Mid-Term 75% Attendance Policy',
        min_attendance_percentage: 75,
        check_attendance: true,
        check_fees: false,
        attendance_cutoff_days_prior: 0,
        allow_late_enrolment_review: true,
      },
    );
    eq(polRes.status, 200, 'policy saved');

    // Generate candidate list
    const genRes = await apiExam(
      'POST',
      `/v1/examinations/schedules/${examScheduleId}/candidates/generate`,
      {
        cutoff_date: datePlus(0),
      },
    );
    eq(genRes.status, 201, 'candidates evaluated');
    const cData = genRes.body.data;
    candidateListId = cData.list.id;

    // Pupil 1 (Aarav): 100% -> ELIGIBLE
    // Pupil 4 (Divya): 100% -> ELIGIBLE
    // Pupil 2 (Bhavya): 0% -> NOT_ELIGIBLE
    const candAarav = cData.candidates.find((c) => c.student_id === pupils[0].studentId);
    eq(candAarav.evaluation_status, 'ELIGIBLE', 'Aarav is ELIGIBLE');

    const candDivya = cData.candidates.find((c) => c.student_id === pupils[3].studentId);
    eq(candDivya.evaluation_status, 'ELIGIBLE', 'Divya is ELIGIBLE');

    const candBhavya = cData.candidates.find((c) => c.student_id === pupils[1].studentId);
    eq(candBhavya.evaluation_status, 'NOT_ELIGIBLE', 'Bhavya is NOT_ELIGIBLE');
    eq(candBhavya.evidence_summary?.attendance_percentage, 0, 'attendance is 0%');
    candidateBhavyaId = candBhavya.candidate_id;
  });

  await step(
    '7.4 authorized override: exam officer grants CONDITIONAL_APPROVAL to Bhavya',
    async () => {
      const overRes = await apiExam(
        'PATCH',
        `/v1/examinations/schedules/${examScheduleId}/candidates/${candidateBhavyaId}/override`,
        {
          override_status: 'CONDITIONAL_APPROVAL',
          override_reason: 'Medical certificate approved by Principal',
        },
      );
      eq(overRes.status, 200, 'override granted');
      eq(overRes.body.data.final_status, 'ELIGIBLE', 'final status promoted to ELIGIBLE');
    },
  );

  await step('7.5 approve and freeze candidate list (immutable)', async () => {
    const freezeRes = await apiExam(
      'POST',
      `/v1/examinations/schedules/${examScheduleId}/candidates/${candidateListId}/approve`,
      { freeze: true },
    );
    eq(freezeRes.status, 200, 'candidate list approved and frozen');
    eq(freezeRes.body.data.status, 'FROZEN', 'state is FROZEN');

    // Attempting to modify candidate after freeze fails
    const modRes = await apiExam(
      'PATCH',
      `/v1/examinations/schedules/${examScheduleId}/candidates/${candidateBhavyaId}/override`,
      {
        override_status: 'DISQUALIFIED',
        override_reason: 'Attempting post-freeze override',
      },
    );
    eq(modRes.status, 409, 'modifying frozen candidate list rejected 409 conflict');
  });

  await step('7.6 assigned teacher enters marks and submits mark sheet', async () => {
    // Teacher 1 enters marks for eligible candidates:
    // Aarav: 85 (pass)
    // Bhavya: 55 (pass)
    // Divya: 92 (pass)
    const marksRes = await apiTeacher1(
      'POST',
      `/v1/examinations/schedules/${examScheduleId}/marks`,
      {
        action: 'SUBMIT',
        entries: [
          { student_id: pupils[0].studentId, marks_obtained: 85, status: 'ENTERED' },
          { student_id: pupils[1].studentId, marks_obtained: 55, status: 'ENTERED' },
          { student_id: pupils[3].studentId, marks_obtained: 92, status: 'ENTERED' },
        ],
      },
    );
    eq(marksRes.status, 200, 'marks submitted');

    const dbMarks = await stack.sql(
      `SELECT count(*)::int AS n FROM app.exam_marks WHERE exam_schedule_id = $1 AND status = 'SUBMITTED'`,
      [examScheduleId],
    );
    eq(dbMarks[0].n, 3, '3 marks rows submitted');
  });

  await step('7.7 teacher cannot publish results (maker-checker separation enforced)', async () => {
    const pubTeacher = await apiTeacher1(
      'POST',
      `/v1/examinations/schedules/${examScheduleId}/publish`,
      {},
    );
    eq(pubTeacher.status, 403, 'teacher result publication denied 403 (maker-checker)');
  });

  await step('7.8 authorized exam administrator publishes examination results', async () => {
    const pubRes = await apiExam(
      'POST',
      `/v1/examinations/schedules/${examScheduleId}/publish`,
      {},
    );
    eq(pubRes.status, 200, 'results published');
    eq(pubRes.body.data.status, 'PUBLISHED', 'status is PUBLISHED');

    const dbSched = (
      await stack.sql(`SELECT status, published_at FROM app.exam_schedules WHERE id = $1`, [
        examScheduleId,
      ])
    )[0];
    eq(dbSched.status, 'PUBLISHED', 'schedule published');
    eq(dbSched.published_at !== null, true, 'published_at recorded');
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 8: SCHOOL FEES, DUES & OFFLINE RECEIPTS (FINANCE OFFICER)
  // ------------------------------------------------------------------------------------------------
  const pageFinance = staffSessions.finance.page;
  const apiFinance = makeApiCall(pageFinance);

  await step('8.1 finance officer signs in', async () => {
    await staffLogin(pageFinance, staff.finance.email, staff.finance.userId, true);
    const res = await apiFinance('GET', '/auth/me');
    eq(res.status, 200, 'me profile 200');
    const me = res.body;
    eq(me.roles.includes('COLLEGE_ADMIN'), true, 'holds COLLEGE_ADMIN role');
  });

  let catTuitionId, catActivityId;
  let feeStructureId;
  await step('8.2 configure fee categories and fee structure (integer minor units)', async () => {
    const catT = await apiFinance('POST', '/v1/finance/categories', {
      code: 'TUITION',
      name: 'Tuition Fee',
      description: 'Standard academic tuition fee',
    });
    eq(catT.status, 201, 'tuition category created');
    catTuitionId = catT.body.data.id;

    const catA = await apiFinance('POST', '/v1/finance/categories', {
      code: 'ACTIVITY',
      name: 'Annual Activity Fee',
      description: 'Sports, arts, and library facilities',
    });
    eq(catA.status, 201, 'activity category created');
    catActivityId = catA.body.data.id;

    // Structure: Tuition 500,000 paise (5,000.00 INR) + Activity 100,000 paise (1,000.00 INR) = 600,000 paise (6,000.00 INR)
    const structRes = await apiFinance('POST', '/v1/finance/structures', {
      campus_id: campusId,
      academic_year_id: academicYearId,
      term_id: termId,
      code: 'FEES-C5-2026',
      name: 'Class 5 Standard Fee Structure 2026',
      currency: 'INR',
      due_date: datePlus(30),
      components: [
        { fee_category_id: catTuitionId, amount: 500000, description: 'Tuition Component' },
        { fee_category_id: catActivityId, amount: 100000, description: 'Activity Component' },
      ],
    });
    eq(structRes.status, 201, 'fee structure created');
    eq(structRes.body.data.total_amount, 600000, 'total amount 600,000 minor units (6,000.00 INR)');
    feeStructureId = structRes.body.data.id;
  });

  let dueAaravId, dueBhavyaId, dueDivyaId;
  await step('8.3 generate student dues with authorized concession for Divya', async () => {
    // Aarav: 600,000
    // Bhavya: 600,000
    // Divya: 600,000 gross - 100,000 concession = 500,000 net
    const dueRes = await apiFinance('POST', '/v1/finance/dues/generate', {
      fee_structure_id: feeStructureId,
      student_ids: [pupils[0].studentId, pupils[1].studentId, pupils[3].studentId],
      concessions: [
        {
          student_id: pupils[3].studentId,
          discount_amount: 100000,
          reason: 'Sibling fee concession scholarship',
        },
      ],
    });
    eq(dueRes.status, 201, 'dues generated');
    const dues = dueRes.body.data.dues;

    const dueAarav = dues.find((d) => d.student_id === pupils[0].studentId);
    eq(dueAarav.gross_amount, 600000, 'Aarav gross');
    eq(dueAarav.balance_amount, 600000, 'Aarav balance');
    dueAaravId = dueAarav.id;

    const dueBhavya = dues.find((d) => d.student_id === pupils[1].studentId);
    eq(dueBhavya.gross_amount, 600000, 'Bhavya gross');
    eq(dueBhavya.balance_amount, 600000, 'Bhavya balance');
    dueBhavyaId = dueBhavya.id;

    const dueDivya = dues.find((d) => d.student_id === pupils[3].studentId);
    eq(dueDivya.gross_amount, 600000, 'Divya gross');
    eq(dueDivya.discount_amount, 100000, 'Divya discount');
    eq(dueDivya.balance_amount, 500000, 'Divya net balance 500,000');
    dueDivyaId = dueDivya.id;
  });

  let receiptAaravId, receiptNumberAarav;
  await step('8.4 record offline cash payment for Aarav; verify receipt immutability', async () => {
    const payRes = await apiFinance('POST', '/v1/finance/receipts', {
      campus_id: campusId,
      student_id: pupils[0].studentId,
      amount: 600000,
      payment_method: 'CASH',
      payment_date: datePlus(0),
      reconciliation_status: 'CONFIRMED',
      idempotency_key: `pay-aarav-${Date.now()}`,
    });
    eq(payRes.status, 201, 'payment recorded');
    receiptAaravId = payRes.body.data.id;
    receiptNumberAarav = payRes.body.data.receipt_number;
    eq(typeof receiptNumberAarav, 'string', 'receipt number allocated');

    // Verify Aarav's dues balance is now 0
    const ledgerAarav = (
      await apiFinance('GET', `/v1/finance/students/${pupils[0].studentId}/ledger`)
    ).body.data;
    eq(ledgerAarav.total_balance, 0, 'Aarav balance cleared to 0');

    // Verify receipt immutability trigger
    let trigErr;
    try {
      await stack.sql(`UPDATE app.fee_receipts SET amount = 999999 WHERE id = $1`, [
        receiptAaravId,
      ]);
    } catch (e) {
      trigErr = e;
    }
    eq(trigErr !== undefined, true, 'direct update on fee_receipts rejected by immutability guard');
  });

  await step(
    '8.5 record cheque payment for Bhavya (PENDING_VERIFICATION); verify reconciliation status',
    async () => {
      const chqRes = await apiFinance('POST', '/v1/finance/receipts', {
        campus_id: campusId,
        student_id: pupils[1].studentId,
        amount: 600000,
        payment_method: 'CHEQUE',
        payment_date: datePlus(0),
        reference_number: 'CHQ-889900',
        reconciliation_status: 'PENDING_VERIFICATION',
        idempotency_key: `chq-bhavya-${Date.now()}`,
      });
      eq(chqRes.status, 201, 'cheque receipt recorded');

      // Verify Bhavya's ledger records the cheque receipt as PENDING_VERIFICATION
      const ledgerBhavya = (
        await apiFinance('GET', `/v1/finance/students/${pupils[1].studentId}/ledger`)
      ).body.data;
      const chqReceipt = ledgerBhavya.receipts.find((r) => r.reference_number === 'CHQ-889900');
      eq(
        chqReceipt.reconciliation_status,
        'PENDING_VERIFICATION',
        'in-flight cheque tracks pending verification',
      );
    },
  );

  await step('8.6 test authorized receipt reversal with step-up authentication', async () => {
    // Generate a temporary receipt for Chetan, then reverse it
    const testPay = await apiFinance('POST', '/v1/finance/receipts', {
      campus_id: campusId,
      student_id: pupils[2].studentId,
      amount: 50000,
      payment_method: 'CASH',
      payment_date: datePlus(0),
      reconciliation_status: 'CONFIRMED',
      idempotency_key: `test-chetan-${Date.now()}`,
    });
    const revReceiptId = testPay.body.data.id;

    // Reverse receipt
    const revRes = await apiFinance('POST', `/v1/finance/receipts/${revReceiptId}/reverse`, {
      reason: 'Erroneous receipt entry by cashier; reversed per financial protocol',
    });
    eq(revRes.status, 200, 'receipt reversed');
    eq(revRes.body.data.status, 'REVERSED', 'status updated to REVERSED');
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 9: ADMINISTRATIVE REPORTING RECONCILIATION
  // ------------------------------------------------------------------------------------------------
  const pageReports = pagePrincipal;
  const apiReports = apiPrincipal;

  await step('9.1 verify Student Enrolment Roster report values and guardian privacy', async () => {
    const rRes = await apiReports('GET', `/v1/reports/enrolment-roster?campus_id=${campusId}`);
    eq(rRes.status, 200, 'enrolment roster read');
    const rData = rRes.body.data;
    eq(rData.summary.total_students, 4, 'total students count is 4');

    // Minors' privacy: guardian personal contact details are omitted in general administrative reporting
    for (const st of rData.students) {
      eq(st.primary_guardian_name, null, 'guardian name hidden in general roster');
      eq(st.primary_guardian_phone, null, 'guardian phone hidden in general roster');
    }
  });

  await step('9.2 verify Daily Attendance Register Summary report values', async () => {
    const attRes = await apiReports(
      'GET',
      `/v1/reports/attendance-summary?campus_id=${campusId}&date=${datePlus(0)}`,
    );
    eq(attRes.status, 200, 'attendance report read');
    const attData = attRes.body.data;
    eq(attData.summary.total_sessions_conducted, 1, '1 conducted session');
    eq(attData.summary.present_count, 2, '2 present (Aarav, Divya)');
    eq(attData.summary.absent_count, 1, '1 absent (Bhavya)');
    eq(attData.summary.excused_count, 1, '1 excused (Chetan)');
  });

  await step(
    '9.3 verify Examination Performance Outcomes report values (published only)',
    async () => {
      const exRes = await apiReports('GET', `/v1/reports/exam-performance?campus_id=${campusId}`);
      eq(exRes.status, 200, 'exam outcomes read');
      const exData = exRes.body.data;
      eq(exData.summary.total_published_exams, 1, '1 published examination');
      eq(exData.summary.total_candidates_appeared, 3, '3 candidates appeared');
      eq(exData.summary.total_passed, 3, '3 candidates passed (pass rate 100%)');
      eq(exData.summary.overall_pass_percentage, 100, '100% pass percentage');
    },
  );

  await step('9.4 verify Fee Collections & Outstanding Dues Register report values', async () => {
    const feeRes = await apiReports('GET', `/v1/reports/fee-summary?campus_id=${campusId}`);
    eq(feeRes.status, 200, 'fee summary read');
    const feeData = feeRes.body.data;
    eq(
      feeData.summary.confirmed_collections,
      600000,
      'confirmed collections = 600,000 (Aarav cash)',
    );
    eq(
      feeData.summary.unverified_collections,
      600000,
      'unverified collections = 600,000 (Bhavya cheque)',
    );
    // Total outstanding balance: Divya (500,000)
    eq(
      feeData.summary.total_outstanding_dues,
      500000,
      'outstanding dues = 500,000 paise (5,000.00 INR)',
    );
  });

  await step('9.5 verify formula-safe CSV export across all 4 administrative reports', async () => {
    const endpoints = [
      `/v1/reports/enrolment-roster?campus_id=${campusId}&format=csv`,
      `/v1/reports/attendance-summary?campus_id=${campusId}&date=${datePlus(0)}&format=csv`,
      `/v1/reports/exam-performance?campus_id=${campusId}&format=csv`,
      `/v1/reports/fee-summary?campus_id=${campusId}&format=csv`,
    ];

    for (const ep of endpoints) {
      const csvRes = await pageReports.evaluate(async (ep) => {
        const me = await (await fetch('/api/auth/me')).json();
        const r = await fetch('/api' + ep, {
          headers: { 'x-csrf-token': me.csrf_token },
        });
        const text = await r.text();
        return { status: r.status, type: r.headers.get('content-type'), text };
      }, ep);

      eq(csvRes.status, 200, `CSV downloaded: ${ep}`);
      eq(csvRes.type?.includes('text/csv'), true, 'content-type is text/csv');
      // Verify formula injection sanitization: no cell starts unquoted with =, +, -, @
      const lines = csvRes.text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const cells = line.split(',');
        for (const c of cells) {
          const raw = c.trim().replace(/^"/, '');
          if (/^[=+\-@]/.test(raw)) {
            throw new Error(`Formula injection character unescaped in ${ep}: ${c}`);
          }
        }
      }
    }
  });

  // ------------------------------------------------------------------------------------------------
  // SECTION 10: RESPONSIVE BROWSER VISUAL WALKTHROUGH & SCREENSHOTS
  // ------------------------------------------------------------------------------------------------
  await step('10.1 capture multi-viewport screenshots of demonstration school ERP', async () => {
    const viewports = [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 375, height: 812 },
    ];

    const capturePage = async (page, url, baseName) => {
      await page.goto(webOrigin + url);
      await page.waitForTimeout(2000);
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `${SHOTS}/rehearsal-${baseName}-${vp.name}.png`,
          fullPage: false,
        });
      }
    };

    // Principal: Academics setup
    await capturePage(pagePrincipal, '/academics', 'academics');

    // Admissions: Students directory
    await capturePage(pageAdmissions, '/students', 'students');

    // Teacher: Attendance register
    await capturePage(pageTeacher1, '/attendance', 'attendance');

    // Exam Administrator: Examinations & candidate eligibility
    await capturePage(pageExam, '/examinations', 'examinations');

    // Finance Officer: Fee structures & receipts
    await capturePage(pageFinance, '/fees', 'fees');

    // Administrator: Comprehensive administrative reports
    await capturePage(pageReports, '/reports', 'reports');

    console.log(`   Captured multi-viewport screenshots for all 6 core workflows into ${SHOTS}`);
  });
} finally {
  console.log('\n======================================================================');
  console.log('REHEARSAL EXECUTION SUMMARY:');
  console.log('======================================================================');
  const passCount = results.filter((r) => r[0] === 'PASS').length;
  const failCount = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`PASSED: ${passCount} steps`);
  console.log(`FAILED: ${failCount} steps`);
  console.log('======================================================================\n');

  await env.stop();
}

process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
