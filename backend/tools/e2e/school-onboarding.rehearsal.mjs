/* eslint-disable */
// Browser rehearsal of secure school onboarding (doc 47 A2). DEVELOPER TOOL, not part of the build or the test suites.
//
// Starts a THROW-AWAY PostgreSQL (random port and passwords, temp directory), the real API on 127.0.0.1 and the real Vite
// dev server on free ports, then drives real Chrome through: operator provisions a synthetic school -> invitation ->
// password -> MFA ticket and TOTP enrolment -> sign-in with MFA -> institution type SCHOOL -> academic setup -> staff
// invitation and role grant -> attendance marking, plus negative cases. It never touches a persistent database, `.env`
// or the development servers. Secrets (tokens, tickets, TOTP seeds, recovery codes) stay in memory and are never printed.
//
// Usage (from backend/):  PLAYWRIGHT_CORE_DIR=<dir containing node_modules/playwright-core> node --import tsx tools/e2e/school-onboarding.rehearsal.mjs
// Optional: CHROME_PATH (default: macOS Google Chrome), SHOTS_DIR (screenshots, taken only on pages without secrets).
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
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('PASS', name);
  } catch (e) {
    results.push(['FAIL', name, String(e.message).split('\n')[0].slice(0, 200)]);
    console.log('FAIL', name, '->', String(e.message).split('\n')[0].slice(0, 200));
  }
};
const eq = (a, b, m) => {
  if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`);
};
const GOOD = 'Synthetic-Pass-2026!';
const env = await startAll();
const { stack, webOrigin, browser } = env;
const SHOTS = process.env.SHOTS_DIR;
try {
  const slug = 'synthetic-school-a',
    slugB = 'synthetic-school-b';
  const emailA = `principal@${slug}.test`,
    emailB = `principal@${slugB}.test`;
  let A, B;
  await step('operator creates two isolated synthetic schools', async () => {
    A = await stack.operator.createSchool('Synthetic Public School', slug, emailA);
    B = await stack.operator.createSchool('Synthetic Other School', slugB, emailB);
  });
  await step(
    'operator cannot issue an MFA ticket before the administrator is activated',
    async () => {
      let err;
      try {
        await stack.operator.mfaTicket(slug);
      } catch (e) {
        err = e;
      }
      eq(err?.code, 'NO_ACTIVE_ADMIN', 'code');
    },
  );
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const acceptUrl = (t) => `${webOrigin}/accept-invite?token=${t}`;
  const submitAccept = async (pw) => {
    await page.getByLabel('New password', { exact: true }).fill(pw);
    await page.getByLabel('Confirm password').fill(pw);
    await page.getByRole('button', { name: /accept invitation/i }).click();
  };
  await step(
    'NEGATIVE expired invitation is refused in the browser and consumes nothing',
    async () => {
      const inv = await stack.operator.inviteAdmin(slug);
      await stack.sql(
        `BEGIN; SET LOCAL session_replication_role = replica; UPDATE app.invite_tokens SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = '${inv.invitationId}'; COMMIT;`,
      );
      await page.goto(acceptUrl(inv.token));
      await submitAccept(GOOD);
      await page.getByRole('alert').first().waitFor({ timeout: 8000 });
      eq(
        (await stack.sql(`SELECT status FROM app.users WHERE id = $1`, [A.adminUserId]))[0].status,
        'INVITED',
        'user still invited',
      );
    },
  );
  let tokenA;
  await step(
    'operator re-issues; a weak password is refused and does not consume the invitation',
    async () => {
      tokenA = (await stack.operator.inviteAdmin(slug)).token;
      await page.goto(acceptUrl(tokenA));
      await submitAccept('short');
      await page
        .getByRole('alert')
        .first()
        .waitFor({ timeout: 8000 })
        .catch(() => {});
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.invite_tokens WHERE user_id = $1 AND used_at IS NOT NULL`,
            [A.adminUserId],
          )
        )[0].n,
        0,
        'token unused',
      );
    },
  );
  await step('the principal sets a compliant password through the invitation page', async () => {
    await page.goto(acceptUrl(tokenA));
    await submitAccept(GOOD);
    await page.waitForFunction(
      () => /success|activated|sign in|log in/i.test(document.body.innerText),
      null,
      { timeout: 10000 },
    );
    eq(
      (await stack.sql(`SELECT status FROM app.users WHERE id = $1`, [A.adminUserId]))[0].status,
      'ACTIVE',
      'activated',
    );
  });
  await step('NEGATIVE reused invitation is refused', async () => {
    await page.goto(acceptUrl(tokenA));
    await submitAccept(GOOD);
    await page.getByRole('alert').first().waitFor({ timeout: 8000 });
  });
  await step(
    'NEGATIVE duplicate bootstrap: a second first-administrator invitation is refused',
    async () => {
      let err;
      try {
        await stack.operator.inviteAdmin(slug);
      } catch (e) {
        err = e;
      }
      eq(err?.code, 'ADMIN_ALREADY_ACTIVE', 'code');
    },
  );
  await step('NEGATIVE wrong tenant: school B token activates only school B', async () => {
    const tb = (await stack.operator.inviteAdmin(slugB)).token;
    const p2 = await (await browser.newContext()).newPage();
    await p2.goto(acceptUrl(tb));
    await p2.getByLabel('New password', { exact: true }).fill(GOOD);
    await p2.getByLabel('Confirm password').fill(GOOD);
    await p2.getByRole('button', { name: /accept invitation/i }).click();
    await p2.waitForFunction(
      () => /success|activated|sign in|log in/i.test(document.body.innerText),
      null,
      { timeout: 10000 },
    );
    eq(
      (await stack.sql(`SELECT status FROM app.users WHERE id = $1`, [B.adminUserId]))[0].status,
      'ACTIVE',
      'B active',
    );
    eq(
      (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.users WHERE organization_id = $1 AND status = 'ACTIVE'`,
          [A.id],
        )
      )[0].n,
      1,
      'A unaffected',
    );
  });
  const login = async (pg, email, pw = GOOD) => {
    await pg.goto(webOrigin + '/login');
    const dlg = pg.getByRole('dialog');
    await dlg.locator('input[name=email]').fill(email);
    await dlg.locator('input[autocomplete=current-password]').fill(pw);
    await dlg.getByRole('button', { name: /sign in|log in/i }).click();
  };
  await step(
    'sign in; before MFA the app demands enrollment (no administrative access)',
    async () => {
      await login(page, emailA);
      await page.waitForTimeout(2500);
      const txt = await page.innerText('body');
      console.log(
        '   path:',
        new URL(page.url()).pathname,
        '| enrollment prompt:',
        /Enrollment Ticket|Two-Factor/i.test(txt),
      );
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/01-after-login-mfa-required.png` });
      const api = await page.evaluate(
        async () => (await fetch('/api/v1/organization/settings')).status,
      );
      eq(api, 403, 'settings blocked before MFA');
    },
  );
  let seedKey;
  let recoveryShown = false;
  const scanDlg = () =>
    page.locator('[role=dialog]').filter({ has: page.getByLabel('6-Digit Verification Code') });
  const mfaDlg = page.locator('[role=dialog]').filter({ has: page.locator('input[name=ticket]') });
  const stepUpDlg = page
    .locator('[role=dialog]')
    .filter({ has: page.locator('input[name=stepUpPassword]') });
  await step(
    'NEGATIVE enrollment without an operator ticket is refused (after password step-up)',
    async () => {
      await mfaDlg.getByRole('button', { name: 'Begin Setup' }).click();
      await stepUpDlg.locator('input[name=stepUpPassword]').fill(GOOD);
      await stepUpDlg.getByRole('button', { name: 'Verify' }).click();
      await mfaDlg.getByRole('alert').first().waitFor({ timeout: 10000 });
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.user_mfa_factors WHERE user_id = $1`,
            [A.adminUserId],
          )
        )[0].n,
        0,
        'no factor created',
      );
    },
  );
  await step('NEGATIVE a made-up ticket is refused', async () => {
    await mfaDlg.locator('input[name=ticket]').fill('0'.repeat(64));
    await mfaDlg.getByRole('button', { name: 'Begin Setup' }).click();
    await mfaDlg.getByRole('alert').first().waitFor({ timeout: 8000 });
    eq(await mfaDlg.isVisible(), true, 'the dialog stays open (the user is not signed out)');
    eq(
      (
        await stack.sql(`SELECT count(*)::int AS n FROM app.user_mfa_factors WHERE user_id = $1`, [
          A.adminUserId,
        ])
      )[0].n,
      0,
      'no factor created',
    );
  });
  await step(
    'operator issues the MFA ticket; the principal starts enrollment and sees an authenticator QR/setup key',
    async () => {
      const { ticket } = await stack.operator.mfaTicket(slug);
      await mfaDlg.locator('input[name=ticket]').fill(ticket);
      await mfaDlg.getByRole('button', { name: 'Begin Setup' }).click();
      await page.getByLabel('6-Digit Verification Code').waitFor({ timeout: 10000 });
      const txt = await page.locator('[role=dialog]').last().innerText();
      const m = txt.match(/\b([A-Z2-7]{32})\b/) ?? txt.replace(/\s+/g, '').match(/([A-Z2-7]{32})/);
      if (!m) throw new Error('setup key not found on the page');
      seedKey = m[1];
      eq((await page.locator('[role=dialog] svg').count()) > 0, true, 'inline SVG QR present');
    },
  );
  await step('NEGATIVE an invalid authenticator code is refused', async () => {
    await scanDlg().getByLabel('6-Digit Verification Code').fill('000000');
    await scanDlg().locator('button[type=submit]').click();
    await scanDlg().getByRole('alert').first().waitFor({ timeout: 8000 });
    eq(await scanDlg().isVisible(), true, 'still enrolling, not signed out');
    eq(
      (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.user_mfa_factors WHERE user_id = $1 AND status = 'ACTIVE'`,
          [A.adminUserId],
        )
      )[0].n,
      0,
      'factor still inactive',
    );
  });
  await step(
    'a valid TOTP code completes enrollment; recovery codes are shown once (not recorded here)',
    async () => {
      await scanDlg().getByLabel('6-Digit Verification Code').fill(stack.totp(seedKey));
      await scanDlg().locator('button[type=submit]').click();
      await page
        .getByText(/recovery code/i)
        .first()
        .waitFor({ timeout: 10000 });
      recoveryShown = true;
      await page.getByRole('button', { name: /saved my recovery codes/i }).click();
      await page.waitForTimeout(800);
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.user_mfa_factors WHERE user_id = $1 AND status = 'ACTIVE' AND verified_enrollment`,
            [A.adminUserId],
          )
        )[0].n,
        1,
        'active verified factor',
      );
    },
  );
  await step(
    'NEGATIVE bootstrap is closed after enrollment; the ticket cannot be re-issued',
    async () => {
      let err;
      try {
        await stack.operator.mfaTicket(slug);
      } catch (e) {
        err = e;
      }
      if (!err) throw new Error('second ticket was issued');
    },
  );
  await step('the principal now reaches administrative settings', async () => {
    await page.reload();
    await page.waitForTimeout(1500);
    const st = await page.evaluate(
      async () => (await fetch('/api/v1/organization/settings')).status,
    );
    eq(st, 200, 'settings');
  });
  const waitNextStep = async () => {
    const ms = 30000 - (Date.now() % 30000) + 1500;
    await page.waitForTimeout(ms);
  };
  await step(
    'sign out, then sign in again: an INVALID authenticator code is refused, a valid one admits',
    async () => {
      await page.goto(webOrigin + '/account');
      await page
        .getByRole('button', { name: /account|Principal|Synthetic/i })
        .first()
        .click()
        .catch(() => {});
      await page.getByRole('button', { name: /sign out/i }).click();
      await page.waitForTimeout(1200);
      await login(page, emailA);
      await page.getByLabel('Verification code').waitFor({ timeout: 10000 });
      await page.getByLabel('Verification code').fill('000000');
      await page.locator('button[type=submit]').last().click();
      await page.getByRole('alert').first().waitFor({ timeout: 8000 });
      await waitNextStep();
      await page.getByLabel('Verification code').fill(stack.totp(seedKey));
      await page.locator('button[type=submit]').last().click();
      await page.waitForTimeout(2500);
      eq(
        await page.evaluate(async () => (await fetch('/api/v1/organization/settings')).status),
        200,
        'admin reaches settings after MFA sign-in',
      );
    },
  );
  console.log('   state: recoveryShown=' + recoveryShown);
  const stepUp = async () => {
    const d = page
      .locator('[role=dialog]')
      .filter({ has: page.locator('input[name=stepUpPassword]') });
    try {
      await d.waitFor({ timeout: 2500 });
    } catch {
      return false;
    }
    await d.locator('input[name=stepUpPassword]').fill(GOOD);
    await d.getByRole('button', { name: 'Verify' }).click();
    await d.waitFor({ state: 'hidden', timeout: 10000 });
    return true;
  };
  const form = (name) => page.getByRole('form', { name });
  const forms = async () =>
    page.locator('form[aria-label]').evaluateAll((f) => f.map((x) => x.getAttribute('aria-label')));
  const fillSel = async (f, label, idx = 1) => {
    await f.getByLabel(label).selectOption({ index: idx });
  };
  await page.goto(webOrigin + '/academics');
  await page.getByRole('button', { name: 'Setup wizard' }).click();
  await step(
    'SCHOOL is selected in the setup wizard (step-up + reason), and the Principal label appears',
    async () => {
      await page.getByRole('button', { name: /Institution and terminology/ }).click();
      const f = form('Institution type');
      await f.getByLabel('Type of institution').selectOption('SCHOOL');
      await f.getByLabel('Reason').fill('Chosen during onboarding');
      await f.getByRole('button', { name: 'Save institution type' }).click();
      await stepUp();
      await f.getByText(/Institution type saved/).waitFor({ timeout: 10000 });
      eq(
        (
          await stack.sql(
            `SELECT value #>> '{}' AS v FROM app.organization_settings WHERE organization_id = $1 AND key = 'institution.type'`,
            [A.id],
          )
        )[0].v,
        'SCHOOL',
        'stored SCHOOL',
      );
      const me = await page.evaluate(
        async () => (await (await fetch('/api/auth/me')).json()).role_labels,
      );
      eq(me.COLLEGE_ADMIN, 'Principal', 'server role label');
    },
  );
  await step('school terminology preset is saved through the wizard', async () => {
    const f = form('Terminology');
    await f.getByRole('button', { name: 'School preset' }).click();
    await f.getByLabel('Reason for the change').fill('School vocabulary');
    await f.getByRole('button', { name: 'Save labels' }).click();
    await stepUp();
    await f.getByText(/Labels saved/).waitFor({ timeout: 10000 });
  });
  await step('campus and department are created through the wizard', async () => {
    await page.getByRole('button', { name: /Campuses and departments/ }).click();
    const c = form('Add a campus');
    await c.getByLabel('Campus name').fill('Main Campus');
    await c.getByLabel('Campus code').fill('MAIN');
    await c.locator('button[type=submit]').click();
    await stepUp();
    await page
      .getByText(/Main Campus/)
      .first()
      .waitFor({ timeout: 10000 });
    const d = form('Add a department');
    await fillSel(d, 'Campus');
    await d.getByLabel('Department name').fill('Primary Wing');
    await d.getByLabel('Department code').fill('PW');
    await d.locator('button[type=submit]').click();
    await stepUp();
    await page.waitForTimeout(1500);
    eq(
      (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.departments WHERE organization_id = $1`,
          [A.id],
        )
      )[0].n,
      1,
      'department',
    );
  });
  const api = (method, path, body, headers = {}) =>
    page.evaluate(
      async ([method, path, body, headers]) => {
        const me = await (await fetch('/api/auth/me')).json();
        const r = await fetch('/api' + path, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': me.csrf_token,
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        let j = null;
        try {
          j = await r.json();
        } catch {}
        return { status: r.status, body: j };
      },
      [method, path, body, headers],
    );
  const today = new Date(Date.now() + 5.5 * 3600e3),
    iso = (d) => d.toISOString().slice(0, 10);
  const plus = (n) => iso(new Date(today.getTime() + n * 86400e3));
  let yearId, termId;
  await step(
    'academic year and term are created (via the authenticated API from the same browser session; the calendar step links to the Calendar tab)',
    async () => {
      const y = await api('POST', '/v1/academics/academic-years', {
        label: '2026-27',
        startDate: plus(-100),
        endDate: plus(260),
      });
      eq(y.status, 201, 'year ' + JSON.stringify(y.body).slice(0, 120));
      yearId = y.body.data.id;
      const campusId = (
        await stack.sql(`SELECT id FROM app.campuses WHERE organization_id = $1`, [A.id])
      )[0].id;
      const t = await api('POST', '/v1/academics/terms', {
        campusId,
        academicYearId: yearId,
        code: 'T1',
        name: 'Term 1',
        startDate: plus(-60),
        endDate: plus(60),
      });
      eq(t.status, 201, 'term ' + JSON.stringify(t.body).slice(0, 160));
      termId = t.body.data.id;
    },
  );
  await step(
    'period type, class (programme) and batch are created through the wizard (school wording)',
    async () => {
      await page.reload();
      await page.getByRole('button', { name: 'Setup wizard' }).click();
      await page.getByRole('button', { name: /intakes and/ }).click();
      const pt = form('Add a period type');
      await pt.getByLabel('Code', { exact: true }).fill('GRADE');
      await pt.getByLabel('Label', { exact: true }).fill('Grade');
      await pt.getByLabel('Plural label').fill('Grades');
      await pt.locator('button[type=submit]').click();
      await stepUp();
      await page.waitForTimeout(1500);
      const pr = form('Add a class');
      await fillSel(pr, 'Owning department');
      await fillSel(pr, 'Period type');
      await pr.getByLabel('Name', { exact: true }).fill('Class 5');
      await pr.getByLabel('Code', { exact: true }).fill('C5');
      await pr.getByLabel('Level').fill('SCHOOL');
      await pr.getByLabel('Number of grades').fill('1');
      await pr.locator('button[type=submit]').click();
      await stepUp();
      await page.waitForTimeout(1500);
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.programs WHERE organization_id = $1`,
            [A.id],
          )
        )[0].n,
        1,
        'programme',
      );
      const co = form('Add a batch');
      await fillSel(co, 'Class');
      await co.getByLabel('Admission year').fill('2026');
      await co.getByLabel('Name', { exact: true }).fill('Class 5 - 2026');
      await co.locator('button[type=submit]').click();
      await stepUp();
      await page.waitForTimeout(1500);
      eq(
        (
          await stack.sql(`SELECT count(*)::int AS n FROM app.cohorts WHERE organization_id = $1`, [
            A.id,
          ])
        )[0].n,
        1,
        'cohort',
      );
    },
  );
  await step('the batch is opened in the term through the wizard', async () => {
    const f = form('Open a grade in a term');
    await fillSel(f, 'Batch');
    await fillSel(f, 'Term');
    await f.getByLabel(/number/i).fill('1');
    await f.locator('button[type=submit]').click();
    await stepUp();
    await page.waitForTimeout(1500);
    eq(
      (
        await stack.sql(
          `SELECT count(*)::int AS n FROM app.cohort_periods WHERE organization_id = $1`,
          [A.id],
        )
      )[0].n,
      1,
      'cohort period',
    );
  });
  // ---- staff invitation ------------------------------------------------------------------------------------------
  const staffEmail = `teacher@${slug}.test`;
  // The teacher's BROWSER is deliberately set to a zone far from the campus (Asia/Kolkata): campus time must not depend on it.
  const staffPage = await (
    await browser.newContext({ timezoneId: 'America/Los_Angeles' })
  ).newPage();
  await step(
    'the principal invites a teacher from the Users page (token captured locally; no e-mail provider exists)',
    async () => {
      await page.goto(webOrigin + '/users');
      await page.getByRole('button', { name: 'Invite user' }).click();
      const f = form('Invite user');
      await f.getByLabel('Email address').fill(staffEmail);
      await f.getByLabel('Full name').fill('Synthetic Teacher');
      await f.getByLabel('Reason for invitation').fill('Staff onboarding rehearsal');
      await f.locator('button[type=submit]').click();
      await stepUp();
      await page.waitForTimeout(2000);
      eq(
        (
          await stack.sql(
            `SELECT status FROM app.users WHERE organization_id = $1 AND email = $2`,
            [A.id, staffEmail],
          )
        )[0].status,
        'INVITED',
        'invited',
      );
    },
  );
  await step(
    'the teacher accepts the invitation in a separate browser session and signs in; holding no role, they have no access',
    async () => {
      const t = stack.takeInvitationToken(staffEmail);
      if (!t) throw new Error('no invitation was delivered to the (in-memory) mailer');
      await staffPage.goto(acceptUrl(t));
      await staffPage.getByLabel('New password', { exact: true }).fill(GOOD);
      await staffPage.getByLabel('Confirm password').fill(GOOD);
      await staffPage.getByRole('button', { name: /accept invitation/i }).click();
      await staffPage.waitForFunction(
        () => /success|activated|sign in|log in/i.test(document.body.innerText),
        null,
        { timeout: 10000 },
      );
      await login(staffPage, staffEmail);
      await staffPage.waitForTimeout(2500);
      console.log(
        '   teacher without a role sees:',
        (await staffPage.innerText('body')).replace(/\s+/g, ' ').slice(0, 140),
      );
      eq(
        await staffPage.evaluate(async () => (await fetch('/api/v1/academics/terminology')).status),
        403,
        'no capability yet',
      );
    },
  );
  await step(
    'the principal grants the FACULTY role from the Access page (CRITICAL: step-up + reason); the teacher then sees "Teacher"',
    async () => {
      await page.goto(webOrigin + '/access');
      await page.getByRole('button', { name: `Manage access for ${staffEmail}` }).click();
      const g = form('Grant a role');
      await g
        .getByLabel('Role')
        .selectOption({ label: /Faculty/ ? undefined : undefined, index: 0 })
        .catch(() => {});
      const opts = await g.getByLabel('Role').locator('option').allInnerTexts();
      const idx = opts.findIndex((o) => /\(FACULTY\)/.test(o));
      if (idx < 0) throw new Error('FACULTY not offered: ' + opts.join('|'));
      await g.getByLabel('Role').selectOption({ index: idx });
      const scope = g.getByLabel('Applies to');
      if (await scope.count()) {
        const so = await scope.locator('option').allInnerTexts();
        const oi = so.findIndex((o) => /organi[sz]ation|whole|entire/i.test(o));
        if (oi >= 0) await scope.selectOption({ index: oi });
      }
      await g.getByLabel('Reason').fill('Appointed as class teacher');
      await g.getByRole('button', { name: 'Grant role' }).click();
      await stepUp();
      await page.waitForTimeout(2000);
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.role_assignments ra JOIN app.roles r ON r.id = ra.role_id JOIN app.users u ON u.id = ra.user_id WHERE u.email = $1 AND r.code = 'FACULTY' AND ra.status = 'ACTIVE'`,
            [staffEmail],
          )
        )[0].n,
        1,
        'FACULTY assignment',
      );
      await staffPage.reload();
      await staffPage.waitForTimeout(2500);
      const labels = await staffPage.evaluate(
        async () => (await (await fetch('/api/auth/me')).json()).role_labels,
      );
      eq(labels.FACULTY, 'Teacher', 'teacher label');
    },
  );
  await step(
    'NEGATIVE unauthorized institution setup: the Teacher cannot change institution type, terminology, invite users or grant roles (server)',
    async () => {
      const t = (m, p, b, h) =>
        staffPage.evaluate(
          async ([m, p, b, h]) => {
            const me = await (await fetch('/api/auth/me')).json();
            const r = await fetch('/api' + p, {
              method: m,
              headers: {
                'content-type': 'application/json',
                'x-csrf-token': me.csrf_token,
                'idempotency-key': 'k' + Math.random().toString(16).slice(2).padEnd(20, '0'),
                ...h,
              },
              body: b ? JSON.stringify(b) : undefined,
            });
            return r.status;
          },
          [m, p, b, h ?? {}],
        );
      eq(
        await t(
          'PUT',
          '/v1/organization/settings/institution.type',
          { value: 'COLLEGE', reason: 'Trying to change it' },
          { 'if-match': '"1"' },
        ),
        403,
        'institution type',
      );
      eq(
        await t(
          'PUT',
          '/v1/organization/settings/terminology',
          { value: { program: 'Course' }, reason: 'Trying to change it' },
          { 'if-match': '"0"' },
        ),
        403,
        'terminology',
      );
      eq(
        await t('POST', '/v1/users/invite', {
          email: 'x@y.test',
          displayName: 'X',
          reason: 'Not allowed here',
        }),
        403,
        'invite',
      );
      eq(
        await t('POST', '/v1/organization/campuses', {
          name: 'X',
          code: 'XX',
          timezone: 'Asia/Kolkata',
        }),
        403,
        'campus',
      );
      eq(
        (
          await stack.sql(
            `SELECT value #>> '{}' AS v FROM app.organization_settings WHERE organization_id = $1 AND key = 'institution.type'`,
            [A.id],
          )
        )[0].v,
        'SCHOOL',
        'unchanged',
      );
    },
  );
  await step(
    'NEGATIVE unauthorized institution setup: the Teacher sees no Setup wizard in the browser',
    async () => {
      await staffPage.goto(webOrigin + '/academics');
      await staffPage.waitForTimeout(2500);
      eq(await staffPage.getByRole('button', { name: 'Setup wizard' }).count(), 0, 'no wizard tab');
    },
  );
  await step(
    "NEGATIVE cross-tenant: school B's principal cannot read or change school A's data, and sees none of its users",
    async () => {
      const pb = await (await browser.newContext()).newPage();
      await login(pb, emailB);
      await pb.waitForTimeout(2500);
      // STAND-IN: school B's principal has not enrolled MFA in this rehearsal; mark the session verified so authorization (not the MFA gate) is what is tested.
      await stack.sql(
        `UPDATE platform.auth_sessions SET mfa_verified_at = now(), step_up_at = now(), auth_strength = 'PASSWORD_MFA' WHERE identity_id = (SELECT identity_id FROM app.users WHERE id = $1)`,
        [B.adminUserId],
      );
      const campusA = (
        await stack.sql(`SELECT id FROM app.campuses WHERE organization_id = $1`, [A.id])
      )[0].id;
      const deptA = (
        await stack.sql(`SELECT id FROM app.departments WHERE organization_id = $1`, [A.id])
      )[0].id;
      const staffA = (await stack.sql(`SELECT id FROM app.users WHERE email = $1`, [staffEmail]))[0]
        .id;
      const g = (p) =>
        pb.evaluate(async (p) => {
          const r = await fetch('/api' + p);
          let j = null;
          try {
            j = await r.json();
          } catch {}
          return { status: r.status, body: j };
        }, p);
      eq((await g(`/v1/organization/campuses/${campusA}`)).status, 404, 'campus of A');
      eq((await g(`/v1/organization/departments/${deptA}`)).status, 404, 'department of A');
      eq((await g(`/v1/users/${staffA}`)).status, 404, 'user of A');
      const users = await g('/v1/users');
      eq(JSON.stringify(users.body).includes(`@${slug}.test`), false, 'A users not listed in B');
      const t = (await g('/v1/academics/terminology')).body.data;
      eq(t.institutionType, null, 'B has not chosen a type');
      const labelsB = (await await pb.evaluate(async () => (await fetch('/api/auth/me')).json()))
        .role_labels;
      eq(labelsB.COLLEGE_ADMIN, 'College administrator', 'B keeps the default label');
    },
  );
  // ---- attendance UI review (limited) -----------------------------------------------------------------------------
  const { uuidv7 } = await import(`${REPO}/backend/src/shared/ids/uuidv7.ts`);
  const ins = async (table, row) => {
    const id = row.id ?? uuidv7();
    const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
    await stack.sql(
      `INSERT INTO app.${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      [
        id,
        A.id,
        ...Object.keys(row)
          .filter((k) => k !== 'id')
          .map((k) => row[k]),
      ],
    );
    return id;
  };
  let offeringId;
  const students = [];
  await step(
    'fixture: an ACTIVE term, a published offering with the teacher as PRIMARY, and a registered roster (SQL + admin API; synthetic)',
    async () => {
      await stack.sql(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [yearId]);
      await stack.sql(`UPDATE app.terms SET status = 'ACTIVE' WHERE id = $1`, [termId]);
      const dept = (
        await stack.sql(`SELECT id, campus_id FROM app.departments WHERE organization_id = $1`, [
          A.id,
        ])
      )[0];
      const prog = (
        await stack.sql(`SELECT id FROM app.programs WHERE organization_id = $1`, [A.id])
      )[0].id;
      const cohort = (
        await stack.sql(`SELECT id FROM app.cohorts WHERE organization_id = $1`, [A.id])
      )[0].id;
      const cp = (
        await stack.sql(`SELECT id FROM app.cohort_periods WHERE organization_id = $1`, [A.id])
      )[0].id;
      const course = await ins('courses', {
        tracks_attendance: true,
        owning_department_id: dept.id,
        code: 'MATH5',
        title: 'Mathematics',
        credits: 3,
        course_type: 'THEORY',
      });
      const off = await api('POST', '/v1/academics/course-offerings', {
        termId,
        courseId: course,
        cohortPeriodId: cp,
        offeringKind: 'OPTIONAL',
        registrationPolicy: 'MANUAL',
      });
      eq(off.status, 201, 'offering ' + JSON.stringify(off.body).slice(0, 150));
      offeringId = off.body.data.id;
      eq(
        (
          await api(
            'PATCH',
            `/v1/academics/course-offerings/${offeringId}`,
            { status: 'PUBLISHED' },
            { 'if-match': '"1"' },
          )
        ).status,
        200,
        'publish',
      );
      const teacherUser = (
        await stack.sql(`SELECT id FROM app.users WHERE email = $1`, [staffEmail])
      )[0].id;
      const emp = await ins('employees', {
        user_id: teacherUser,
        employee_code: 'T001',
        employee_type: 'FACULTY',
        joining_date: '2020-06-01',
        status: 'ACTIVE',
      });
      await ins('faculty_assignments', {
        course_offering_id: offeringId,
        employee_id: emp,
        role: 'PRIMARY',
        valid_from: plus(-60),
      });
      for (let i = 1; i <= 3; i++) {
        const u = uuidv7();
        const em = `pupil${i}@${slug}.test`;
        await stack.sql(
          `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE')`,
          [u, em],
        );
        await ins('users', {
          id: u,
          email: em,
          display_name: `Pupil ${i}`,
          status: 'ACTIVE',
          identity_id: u,
        });
        const st = await ins('students', {
          user_id: u,
          admission_number: `ADM${i}`,
          admission_date: '2026-06-01',
          status: 'ACTIVE',
        });
        const sp = await ins('student_programs', {
          student_id: st,
          program_id: prog,
          cohort_id: cohort,
          campus_id: dept.campus_id,
          department_id: dept.id,
          start_date: '2026-06-01',
          status: 'ACTIVE',
        });
        const te = await ins('term_enrollments', {
          student_id: st,
          student_program_id: sp,
          cohort_period_id: cp,
          term_id: termId,
          period_no: 1,
        });
        await stack.sql(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [te]);
        const reg = await api(
          'POST',
          `/v1/academics/course-offerings/${offeringId}/registrations`,
          {
            termEnrollmentId: te,
            validFrom: plus(-30),
            source: 'MANUAL',
            reason: 'Registered by the office',
          },
        );
        eq(reg.status, 201, 'registration ' + JSON.stringify(reg.body).slice(0, 120));
        students.push({ st, name: `Pupil ${i}` });
      }
    },
  );
  await staffPage.goto(webOrigin + '/attendance');
  await staffPage.waitForTimeout(2500);
  const modal = () =>
    staffPage
      .locator('[role=dialog]')
      .filter({ has: staffPage.getByText('Schedule Class Session') });
  const utcToday = new Date().toISOString().slice(0, 10),
    istToday = plus(0);
  console.log(
    `   dates: UTC today=${utcToday} campus(IST) today=${istToday} ${utcToday === istToday ? '(same day now)' : '(DIFFERENT DAYS NOW: UTC date != IST date)'}`,
  );
  let defaultsInfo;
  await step('the teacher schedules a session through the browser', async () => {
    const sel = staffPage.locator('#offering-select, select[name="offering-select"]').first();
    await sel.waitFor({ timeout: 10000 });
    await sel.selectOption({ index: 0 });
    await staffPage.getByRole('button', { name: /Schedule New Session/ }).click();
    const m = modal();
    defaultsInfo = {
      date: await m.getByLabel('Session Date').inputValue(),
      start: await m.getByLabel('Start Time').inputValue(),
      end: await m.getByLabel('End Time').inputValue(),
    };
    // ATT-1: the form defaults to the CAMPUS date (not the UTC date, not the Los Angeles browser date) and 09:00 stays 09:00
    eq(defaultsInfo.date, istToday, 'default date is the campus date');
    await m.getByLabel('Start Time').fill('09:00');
    await m.getByLabel('End Time').fill('10:00');
    await m
      .getByRole('button', { name: /schedule|create|save/i })
      .last()
      .click();
    await staffPage.waitForTimeout(2500);
    const created = await stack.sql(
      `SELECT to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS local_start, to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc_start, session_date::text AS d FROM app.class_sessions WHERE organization_id = $1`,
      [A.id],
    );
    eq(
      JSON.stringify(created),
      JSON.stringify([{ local_start: '09:00', utc_start: '03:30', d: istToday }]),
      'stored as 09:00 campus time',
    );
  });
  console.log('   modal defaults:', JSON.stringify(defaultsInfo));
  let sessionId;
  await step(
    'the teacher marks Pupil 2 absent and submits the register through the browser',
    async () => {
      const rg = staffPage.getByRole('radiogroup', { name: 'Attendance for Pupil 2' });
      await rg.getByRole('radio', { name: /absent/i }).click();
      await staffPage.getByRole('button', { name: /Submit Attendance/ }).click();
      await staffPage
        .getByText(/submitted|Submitted/)
        .first()
        .waitFor({ timeout: 10000 });
      const rows = await stack.sql(
        `SELECT s.full_name AS n, r.status, r.revision_no FROM app.attendance_records r JOIN (SELECT st.id, u.display_name AS full_name FROM app.students st JOIN app.users u ON u.id = st.user_id) s ON s.id = r.student_id ORDER BY 1`,
      );
      eq(
        JSON.stringify(rows.map((r) => [r.n, r.status, r.revision_no])),
        JSON.stringify([
          ['Pupil 1', 'PRESENT', 1],
          ['Pupil 2', 'ABSENT', 1],
          ['Pupil 3', 'PRESENT', 1],
        ]),
        'stored register',
      );
      const sess = (
        await stack.sql(
          `SELECT id, attendance_state, status FROM app.class_sessions WHERE organization_id = $1`,
          [A.id],
        )
      )[0];
      sessionId = sess.id;
      eq(sess.attendance_state, 'SUBMITTED', 'state');
    },
  );
  await step(
    'CORRECTION flag off: attempting a correction shows a clear refusal and writes nothing (the server decides)',
    async () => {
      await staffPage
        .getByRole('button', { name: /^Correct/ })
        .first()
        .click();
      const dlg = staffPage
        .locator('[role=dialog]')
        .filter({ has: staffPage.locator('#correction-title') });
      await dlg.locator('#correction-status').selectOption('ABSENT');
      await dlg.locator('#correction-reason-code').selectOption('FACULTY_ERROR');
      await dlg.locator('button[type=submit]').click();
      await dlg.getByRole('alert').first().waitFor({ timeout: 8000 });
      console.log(
        '   refusal text:',
        JSON.stringify(await dlg.getByRole('alert').first().innerText()),
      );
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.attendance_record_revisions WHERE organization_id = $1 AND revision_no > 1`,
            [A.id],
          )
        )[0].n,
        0,
        'no correction revision',
      );
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.attendance_correction_requests WHERE organization_id = $1`,
            [A.id],
          )
        )[0].n,
        0,
        'no request',
      );
      await dlg
        .getByRole('button', { name: /cancel/i })
        .first()
        .click();
    },
  );
  await step(
    'an authorized administrator (the principal) inspects the register for the date and opens the session',
    async () => {
      await page.goto(webOrigin + '/attendance');
      await page.waitForTimeout(2000);
      await page.getByRole('tab', { name: /School Registers/ }).click();
      const t = page.locator('table[aria-label="Daily school attendance register table"]');
      await t.waitFor({ timeout: 10000 });
      const txt = (await t.innerText()).replace(/\s+/g, ' ');
      console.log('   REGISTER:', txt.slice(0, 260));
      if (!/MATH5|Mathematics/.test(txt))
        throw new Error('the session is not in the daily register');
      if (!/09:00 – 10:00/.test(txt))
        throw new Error('the register does not show 09:00 – 10:00 campus time');
      eq(
        await page.locator('#register-date').inputValue(),
        istToday,
        'register opens on the campus date',
      );
    },
  );
  await step(
    'ATT-1: an evening class (20:00 to 21:00 campus time) is accepted; the teacher sees it on the campus clock although the browser is in Los Angeles',
    async () => {
      await staffPage.goto(webOrigin + '/attendance');
      await staffPage.locator('#offering-select').waitFor({ timeout: 10000 });
      await staffPage.getByRole('button', { name: /Schedule New Session/ }).click();
      const m = staffPage
        .locator('[role=dialog]')
        .filter({ has: staffPage.getByText('Schedule Class Session') });
      await m.getByLabel('Start Time').fill('20:00');
      await m.getByLabel('End Time').fill('21:00');
      await m
        .getByRole('button', { name: /schedule|create|save/i })
        .last()
        .click();
      await staffPage.waitForTimeout(2500);
      const rows = await stack.sql(
        `SELECT to_char(starts_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS l FROM app.class_sessions WHERE organization_id = $1 ORDER BY starts_at`,
        [A.id],
      );
      eq(
        JSON.stringify(rows.map((r) => r.l)),
        JSON.stringify(['09:00', '20:00']),
        'both sessions stored in campus time',
      );
      await staffPage.getByRole('button', { name: /Back to Sessions/ }).click();
      const list = (await staffPage.locator('body').innerText()).replace(/\s+/g, ' ');
      if (!/20:00 – 21:00/.test(list))
        throw new Error('the evening class is not shown as 20:00 – 21:00');
    },
  );
  await step(
    'ATT-2: the server reports the campus clock and the correction window for the session (campus date, 3 days)',
    async () => {
      const r = await api('GET', `/v1/attendance/sessions/${sessionId}`);
      eq(r.status, 200, 'session read');
      const d = r.body.data;
      eq(
        JSON.stringify([
          d.campusTimezone,
          d.campusToday,
          d.correctionWindowDays,
          d.insideCorrectionWindow,
        ]),
        JSON.stringify(['Asia/Kolkata', istToday, 3, true]),
        'clock and window',
      );
    },
  );
  await step(
    'ATT-3: with the correction switch off the Correct dialog says so in specific words, and nothing is written',
    async () => {
      await staffPage.goto(webOrigin + '/attendance');
      await staffPage.locator('#offering-select').waitFor({ timeout: 10000 });
      const rowBtn = staffPage.getByRole('button', { name: /^(View|Open)/ }).first();
      await rowBtn.click();
      await staffPage
        .getByRole('button', { name: /^Correct/ })
        .first()
        .click();
      const dlg = staffPage
        .locator('[role=dialog]')
        .filter({ has: staffPage.locator('#correction-title') });
      await dlg.locator('#correction-status').selectOption('ABSENT');
      await dlg.locator('button[type=submit]').click();
      await dlg.getByRole('alert').first().waitFor({ timeout: 8000 });
      const msg = await dlg.getByRole('alert').first().innerText();
      if (!/switched off for this institution/.test(msg))
        throw new Error('unexpected wording: ' + msg);
      eq(
        (
          await stack.sql(
            `SELECT count(*)::int AS n FROM app.attendance_record_revisions WHERE organization_id = $1 AND revision_no > 1`,
            [A.id],
          )
        )[0].n,
        0,
        'no revision',
      );
    },
  );
} finally {
  console.log(
    'SUMMARY',
    JSON.stringify({
      pass: results.filter((r) => r[0] === 'PASS').length,
      fail: results.filter((r) => r[0] === 'FAIL').length,
    }),
  );
  await env.stop();
}
process.exit(0);
