import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const WRONG_PASSWORD = /* secret-scan:allow */ 'WrongPassword999!';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 5 });
const db = new Database(pool);

// Default app: minAssuranceForCritical defaults to 'PASSWORD_MFA' (production fail-closed baseline)
const defaultApp = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db,
  logger: false,
  stepUpLimiter: new FixedWindowLimiter({ limit: 1000, windowMs: 60_000, maxKeys: 10_000 }),
});

defaultApp.get(
  '/test/mixed-permissions',
  {
    config: { permission: ['org.structure.read', 'org.settings.manage'] },
  },
  () => ({ success: true }),
);

// Test app configured with minAssuranceForCritical: 'PASSWORD_REAUTH' to verify reauth elevation
let fakeNow = Date.now();
const testApp = buildApp({
  config: loadConfig({ DATABASE_URL: url }),
  db,
  logger: false,
  minAssuranceForCritical: 'PASSWORD_REAUTH',
  stepUpMaxAgeMs: 600_000, // 10 minutes
  stepUpClock: () => fakeNow,
  stepUpLimiter: new FixedWindowLimiter({ limit: 1000, windowMs: 60_000, maxKeys: 10_000 }),
});

const EMAIL = 'staff.a@college-a.test';

beforeEach(async () => {
  fakeNow = Date.now();
  await adminQuery(
    'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE email = $1',
    [EMAIL],
  );
});

beforeAll(async () => {
  await defaultApp.ready();
  await testApp.ready();
  await adminQuery('UPDATE platform.identities SET password_hash = $1 WHERE email = $2', [
    await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    EMAIL,
  ]);
});

afterAll(async () => {
  await adminQuery(
    'UPDATE platform.identities SET failed_login_count = 0, locked_until = NULL WHERE email = $1',
    [EMAIL],
  );
  await defaultApp.close();
  await testApp.close();
  await pool.end().catch(() => undefined);
});

async function login(app = defaultApp): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(r.statusCode).toBe(200);
  const cookie = await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value);
  const csrf = r.json<{ csrf_token: string }>().csrf_token;
  return { cookie, csrf };
}

describe('D10 Step-Up Authentication Foundation', () => {
  describe('Central authorization enforcement', () => {
    it('NORMAL permissions (session.read, org.settings.read) succeed without step-up', async () => {
      const { cookie } = await login(defaultApp);

      const me = await defaultApp.inject({
        method: 'GET',
        url: '/auth/me',
        cookies: { session_token: cookie },
      });
      expect(me.statusCode).toBe(200);

      const settings = await defaultApp.inject({
        method: 'GET',
        url: '/api/v1/organization/settings',
        cookies: { session_token: cookie },
      });
      expect(settings.statusCode).toBe(200);
    });

    it('SENSITIVE permissions (user.account.read) succeed without step-up', async () => {
      const { cookie } = await login(defaultApp);

      const users = await defaultApp.inject({
        method: 'GET',
        url: '/api/v1/users',
        cookies: { session_token: cookie },
      });
      expect(users.statusCode).toBe(200);
    });

    it('CRITICAL permissions (org.settings.manage) are blocked with 403 STEP_UP_REQUIRED on initial login', async () => {
      const { cookie, csrf } = await login(defaultApp);

      const res = await defaultApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: {
          'x-csrf-token': csrf,
          'if-match': '"1"',
        },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Enabling DOB requirement for audit verification' },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('STEP_UP_REQUIRED');
      expect(body.error.message).toContain('Step-up authentication required');
    });

    it('CRITICAL permissions remain blocked when only PASSWORD_REAUTH exists but required assurance is PASSWORD_MFA', async () => {
      const { cookie, csrf } = await login(defaultApp);

      // Perform step-up on defaultApp (elevates session to PASSWORD_REAUTH)
      const stepUpRes = await defaultApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });
      expect(stepUpRes.statusCode).toBe(200);
      expect(stepUpRes.json<{ data: { authStrength: string } }>().data.authStrength).toBe(
        'PASSWORD_REAUTH',
      );

      // Attempt critical action: defaultApp requires PASSWORD_MFA, so PASSWORD_REAUTH must still be blocked
      const res = await defaultApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: {
          'x-csrf-token': csrf,
          'if-match': '"1"',
        },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Institutional check' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('route with mixed sensitivity permissions cannot bypass step-up even when authorized on non-critical permission', async () => {
      const { cookie } = await login(defaultApp);

      // staff.a holds COLLEGE_ADMIN, which possesses both org.structure.read (NORMAL) and org.settings.manage (CRITICAL).
      // Authorization on org.structure.read must NOT bypass the CRITICAL requirement of org.settings.manage on the route.
      const res = await defaultApp.inject({
        method: 'GET',
        url: '/test/mixed-permissions',
        cookies: { session_token: cookie },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');

      // Once properly elevated with required assurance, the route succeeds
      await elevateSession(cookie, 'PASSWORD_MFA');
      const resElevated = await defaultApp.inject({
        method: 'GET',
        url: '/test/mixed-permissions',
        cookies: { session_token: cookie },
      });
      expect(resElevated.statusCode).toBe(200);
      expect(resElevated.json<{ success: boolean }>().success).toBe(true);
    });
  });

  describe('Step-up verification endpoint (POST /auth/step-up)', () => {
    it('wrong password returns generic 401 INVALID_CREDENTIALS and increments failed_login_count', async () => {
      const { cookie, csrf } = await login(testApp);

      // Reset count first
      await adminQuery('UPDATE platform.identities SET failed_login_count = 0 WHERE email = $1', [
        EMAIL,
      ]);

      const res = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: WRONG_PASSWORD },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');

      const [row] = await adminQuery<{ failed_login_count: number }>(
        'SELECT failed_login_count FROM platform.identities WHERE email = $1',
        [EMAIL],
      );
      expect(row?.failed_login_count).toBe(1);
    });

    it('successful password verification elevates session to PASSWORD_REAUTH and writes audit event atomically', async () => {
      const { cookie, csrf } = await login(testApp);

      const beforeAudit = await adminQuery<{ count: string }>(
        "SELECT count(*)::text as count FROM app.audit_events WHERE action = 'auth.step_up'",
      );
      const countBefore = Number(beforeAudit[0]?.count ?? '0');

      const res = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<{
        data: { steppedUp: boolean; authStrength: string; maxAgeSeconds: number };
      }>().data;
      expect(data.steppedUp).toBe(true);
      expect(data.authStrength).toBe('PASSWORD_REAUTH');
      expect(data.maxAgeSeconds).toBe(600);

      // Verify session row in database
      const [session] = await adminQuery<{ auth_strength: string; step_up_at: Date; id: string }>(
        `SELECT s.auth_strength, s.step_up_at, s.id
           FROM platform.auth_sessions s
          WHERE s.token_hash = encode(sha256($1::bytea), 'hex')`,
        [cookie],
      );
      expect(session?.auth_strength).toBe('PASSWORD_REAUTH');
      expect(session?.step_up_at).not.toBeNull();

      // Verify audit row was created atomically with session_id
      const [audit] = await adminQuery<{
        action: string;
        resource_type: string;
        resource_id: string;
        session_id: string;
        risk_tier: number;
        metadata: { authStrength: string };
      }>(
        `SELECT action, resource_type, resource_id, session_id, risk_tier, metadata
           FROM app.audit_events
          WHERE action = 'auth.step_up'
          ORDER BY occurred_at DESC
          LIMIT 1`,
      );
      expect(audit?.action).toBe('auth.step_up');
      expect(audit?.resource_type).toBe('session');
      expect(audit?.resource_id).toBe(session?.id);
      expect(audit?.session_id).toBe(session?.id);
      expect(audit?.risk_tier).toBe(2);
      expect(audit?.metadata?.authStrength).toBe('PASSWORD_REAUTH');

      const afterAudit = await adminQuery<{ count: string }>(
        "SELECT count(*)::text as count FROM app.audit_events WHERE action = 'auth.step_up'",
      );
      expect(Number(afterAudit[0]?.count)).toBe(countBefore + 1);
    });

    it('in testApp (minAssurance: PASSWORD_REAUTH), stepped-up session allows CRITICAL actions', async () => {
      const { cookie, csrf } = await login(testApp);

      // Step up
      const stepUp = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });
      expect(stepUp.statusCode).toBe(200);

      // Call critical settings route without If-Match to verify we passed the step-up gate
      // (Precondition error 428 proves auth/step-up authorization check passed)
      const res = await testApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Valid step-up test reason' },
      });

      // 428 PRECONDITION_REQUIRED proves the route handler was reached past auth & step-up!
      expect(res.statusCode).toBe(428);
    });

    it('weaker password re-authentication does NOT downgrade active stronger assurance (PASSWORD_MFA) nor assign misleading timestamps', async () => {
      const { cookie, csrf } = await login(testApp);

      // Establish active PASSWORD_MFA with a known timestamp (2 minutes in the past)
      const pastTime = new Date(Date.now() - 120_000);
      await adminQuery(
        `UPDATE platform.auth_sessions
            SET step_up_at = $1, auth_strength = 'PASSWORD_MFA'
          WHERE token_hash = encode(sha256($2::bytea), 'hex')`,
        [pastTime, cookie],
      );

      // Perform password re-authentication on the active MFA session
      const stepUpRes = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });

      expect(stepUpRes.statusCode).toBe(200);
      const resData = stepUpRes.json<{ data: { authStrength: string; stepUpAt: string } }>().data;
      // Retains PASSWORD_MFA
      expect(resData.authStrength).toBe('PASSWORD_MFA');

      // Check DB row: auth_strength remains PASSWORD_MFA and step_up_at is NOT extended to now
      const [session] = await adminQuery<{ auth_strength: string; step_up_at: Date }>(
        `SELECT auth_strength, step_up_at
           FROM platform.auth_sessions
          WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
        [cookie],
      );
      expect(session?.auth_strength).toBe('PASSWORD_MFA');
      // The timestamp must match the original MFA timestamp, not now()
      expect(new Date(session!.step_up_at).getTime()).toBe(pastTime.getTime());
    });

    it('expired PASSWORD_MFA assurance transitions cleanly to fresh PASSWORD_REAUTH at current time', async () => {
      const { cookie, csrf } = await login(testApp);

      // Establish expired PASSWORD_MFA (15 minutes in the past, older than 10m window)
      const expiredMfaTime = new Date(Date.now() - 15 * 60_000);
      await adminQuery(
        `UPDATE platform.auth_sessions
            SET step_up_at = $1, auth_strength = 'PASSWORD_MFA'
          WHERE token_hash = encode(sha256($2::bytea), 'hex')`,
        [expiredMfaTime, cookie],
      );

      // Perform password re-authentication
      const beforeNow = Date.now();
      const stepUpRes = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });

      expect(stepUpRes.statusCode).toBe(200);
      const resData = stepUpRes.json<{ data: { authStrength: string; stepUpAt: string } }>().data;
      // Now legitimately PASSWORD_REAUTH matching the verification that just took place
      expect(resData.authStrength).toBe('PASSWORD_REAUTH');

      const [session] = await adminQuery<{ auth_strength: string; step_up_at: Date }>(
        `SELECT auth_strength, step_up_at
           FROM platform.auth_sessions
          WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
        [cookie],
      );
      expect(session?.auth_strength).toBe('PASSWORD_REAUTH');
      expect(new Date(session!.step_up_at).getTime()).toBeGreaterThanOrEqual(beforeNow - 1000);
    });

    it('configured stepUpMaxAgeMs determines maxAgeSeconds in response matching enforcement', async () => {
      // 5-minute (300_000 ms) configured app
      const customMaxAgeApp = buildApp({
        config: loadConfig({ DATABASE_URL: url }),
        db,
        logger: false,
        minAssuranceForCritical: 'PASSWORD_REAUTH',
        stepUpMaxAgeMs: 300_000,
        stepUpClock: () => fakeNow,
      });
      await customMaxAgeApp.ready();

      try {
        const { cookie, csrf } = await login(customMaxAgeApp);

        const stepUpRes = await customMaxAgeApp.inject({
          method: 'POST',
          url: '/auth/step-up',
          headers: { 'x-csrf-token': csrf },
          cookies: { session_token: cookie },
          payload: { password: PASSWORD },
        });

        expect(stepUpRes.statusCode).toBe(200);
        const data = stepUpRes.json<{ data: { maxAgeSeconds: number } }>().data;
        expect(data.maxAgeSeconds).toBe(300);

        // Within 300s window -> passes step-up gate (reaches 428 Precondition on PUT /settings)
        fakeNow += 290_000;
        const validRes = await customMaxAgeApp.inject({
          method: 'PUT',
          url: '/api/v1/organization/settings/identity.dob_required',
          headers: { 'x-csrf-token': csrf },
          cookies: { session_token: cookie },
          payload: { value: true, reason: 'Valid within 5m' },
        });
        expect(validRes.statusCode).toBe(428);

        // Past 300s window -> blocked with 403 STEP_UP_REQUIRED
        fakeNow += 20_000;
        const expiredRes = await customMaxAgeApp.inject({
          method: 'PUT',
          url: '/api/v1/organization/settings/identity.dob_required',
          headers: { 'x-csrf-token': csrf },
          cookies: { session_token: cookie },
          payload: { value: true, reason: 'Past 5m' },
        });
        expect(expiredRes.statusCode).toBe(403);
        expect(expiredRes.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');
      } finally {
        await customMaxAgeApp.close();
      }
    });
  });

  describe('Session isolation, expiry, and revocation', () => {
    it('stepping up session A does NOT elevate session B', async () => {
      const sessionA = await login(testApp);
      const sessionB = await login(testApp);

      // Elevate session A only
      const stepA = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': sessionA.csrf },
        cookies: { session_token: sessionA.cookie },
        payload: { password: PASSWORD },
      });
      expect(stepA.statusCode).toBe(200);

      // Session A passes step-up gate (reaches 428 Precondition)
      const resA = await testApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': sessionA.csrf },
        cookies: { session_token: sessionA.cookie },
        payload: { value: true, reason: 'A reason' },
      });
      expect(resA.statusCode).toBe(428);

      // Session B remains un-elevated: blocked with 403 STEP_UP_REQUIRED
      const resB = await testApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': sessionB.csrf },
        cookies: { session_token: sessionB.cookie },
        payload: { value: true, reason: 'B reason' },
      });
      expect(resB.statusCode).toBe(403);
      expect(resB.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('expired step-up assurance (> 10m) blocks critical actions', async () => {
      fakeNow = Date.now();
      const { cookie, csrf } = await login(testApp);

      // Step up at T=0
      await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });

      // Advance clock by 11 minutes (660,000 ms)
      fakeNow += 660_000;

      const res = await testApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Expired test reason' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');
    });

    it('revoked session immediately loses access and prior assurance', async () => {
      const { cookie, csrf } = await login(testApp);

      // Step up
      await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });

      // Logout
      const logoutRes = await testApp.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
      });
      expect(logoutRes.statusCode).toBe(200);

      // Attempting critical action fails with 401 UNAUTHORIZED
      const res = await testApp.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Revoked reason' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('logout and membership-wide revocation update platform.auth_sessions without privilege errors', async () => {
      const { cookie } = await login(testApp);

      // Verify logout sets revoked_at
      const [sessionBefore] = await adminQuery<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM platform.auth_sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
        [cookie],
      );
      expect(sessionBefore?.revoked_at).toBeNull();

      await testApp.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { session_token: cookie },
      });

      const [sessionAfter] = await adminQuery<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM platform.auth_sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
        [cookie],
      );
      expect(sessionAfter?.revoked_at).not.toBeNull();
    });
  });

  describe('Rate limiting on step-up', () => {
    it('step-up attempts are rate-limited per session / IP', async () => {
      const limiter = new FixedWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100 });
      const rateLimitedApp = buildApp({
        config: loadConfig({ DATABASE_URL: url }),
        db,
        logger: false,
        stepUpLimiter: limiter,
      });
      await rateLimitedApp.ready();

      try {
        const { cookie, csrf } = await login(rateLimitedApp);

        // Attempt 1, 2, 3 fail with 401 (password check)
        for (let i = 0; i < 3; i++) {
          const r = await rateLimitedApp.inject({
            method: 'POST',
            url: '/auth/step-up',
            headers: { 'x-csrf-token': csrf },
            cookies: { session_token: cookie },
            payload: { password: WRONG_PASSWORD },
          });
          expect(r.statusCode).toBe(401);
        }

        // Attempt 4 is rate-limited before password verification
        const blocked = await rateLimitedApp.inject({
          method: 'POST',
          url: '/auth/step-up',
          headers: { 'x-csrf-token': csrf },
          cookies: { session_token: cookie },
          payload: { password: WRONG_PASSWORD },
        });
        expect(blocked.statusCode).toBe(429);
        expect(blocked.headers['retry-after']).toBeDefined();
        expect(blocked.json<{ error: { code: string } }>().error.code).toBe('TOO_MANY_REQUESTS');
      } finally {
        await rateLimitedApp.close();
      }
    });
  });

  describe('Account lockout behavior on step-up', () => {
    it('10 consecutive failed step-up attempts lock the account across sessions and replicas', async () => {
      const { cookie, csrf } = await login(testApp);

      // Verify initial state
      const [initRow] = await adminQuery<{ failed_login_count: number; locked_until: Date | null }>(
        'SELECT failed_login_count, locked_until FROM platform.identities WHERE email = $1',
        [EMAIL],
      );
      expect(initRow?.failed_login_count).toBe(0);
      expect(initRow?.locked_until).toBeNull();

      // 10 failed step-up password attempts
      for (let i = 0; i < 10; i++) {
        const res = await testApp.inject({
          method: 'POST',
          url: '/auth/step-up',
          headers: { 'x-csrf-token': csrf },
          cookies: { session_token: cookie },
          payload: { password: WRONG_PASSWORD },
        });
        expect(res.statusCode).toBe(401);
      }

      // Check database state in platform.identities (shared across replicas)
      const [lockedRow] = await adminQuery<{
        failed_login_count: number;
        locked_until: Date | null;
      }>('SELECT failed_login_count, locked_until FROM platform.identities WHERE email = $1', [
        EMAIL,
      ]);
      expect(lockedRow?.failed_login_count).toBe(10);
      expect(lockedRow?.locked_until).not.toBeNull();
      expect(lockedRow!.locked_until!.getTime()).toBeGreaterThan(Date.now());

      // 11th step-up attempt with CORRECT password fails because account is locked
      const correctWhileLocked = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });
      expect(correctWhileLocked.statusCode).toBe(401);
      expect(correctWhileLocked.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_CREDENTIALS',
      );

      // Login from a fresh session/client is also locked out (proves account-level scope, not session-local)
      const freshLogin = await testApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: EMAIL, password: PASSWORD },
      });
      expect(freshLogin.statusCode).toBe(401);
      expect(freshLogin.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');

      // Reset lockout counter to 5 and verify successful step-up clears the failure counter to 0
      await adminQuery(
        'UPDATE platform.identities SET failed_login_count = 5, locked_until = NULL WHERE email = $1',
        [EMAIL],
      );

      const successfulStepUp = await testApp.inject({
        method: 'POST',
        url: '/auth/step-up',
        headers: { 'x-csrf-token': csrf },
        cookies: { session_token: cookie },
        payload: { password: PASSWORD },
      });
      expect(successfulStepUp.statusCode).toBe(200);

      const [resetRow] = await adminQuery<{
        failed_login_count: number;
        locked_until: Date | null;
      }>('SELECT failed_login_count, locked_until FROM platform.identities WHERE email = $1', [
        EMAIL,
      ]);
      expect(resetRow?.failed_login_count).toBe(0);
      expect(resetRow?.locked_until).toBeNull();
    });
  });
});
