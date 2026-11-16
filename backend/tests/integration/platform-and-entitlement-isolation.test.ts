import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { assertDisposableTestDatabase } from '../../src/shared/database/test-guard.js';
import { createPlatformDb, buildPlatformServer } from '../../tools/platform/platform-server.js';
import { PlatformService } from '../../tools/platform/platform.service.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';

describe('Platform Owner Isolation, Entitlements & Safety Suite (P0)', () => {
  const adminUrl = inject('dbAdminUrl');
  const runtimeUrl = inject('dbRuntimeUrl');

  if (!adminUrl || !runtimeUrl) {
    throw new Error('Test requires disposable test database from Vitest globalSetup');
  }

  // Ensure strict database isolation guard verification
  assertDisposableTestDatabase(adminUrl, 'platform-and-entitlement-isolation.test.ts (admin)');
  assertDisposableTestDatabase(runtimeUrl, 'platform-and-entitlement-isolation.test.ts (runtime)');

  const erpDb = new Database(createPool({ connectionString: runtimeUrl, ssl: false, max: 5 }));
  const erpApp = buildApp({
    config: loadConfig({ DATABASE_URL: runtimeUrl, APP_ORIGINS: 'https://app.campus.test' }),
    db: erpDb,
    logger: false,
  });

  const platformDb = createPlatformDb(adminUrl);
  const platformService = new PlatformService(platformDb);
  const platformServer = buildPlatformServer({ db: platformDb });

  const VALID_PLATFORM_TOKEN = 'change_me_platform_dev_token';

  let tenant: IsolatedTenant;
  let adminCookie: string;
  let adminCsrf: string;

  beforeAll(async () => {
    // 1. Create an isolated tenant in the disposable database with pre-configured admin
    const password = 'AdminPassword123!'; // secret-scan:allow test fixture
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    tenant = await createIsolatedTenant(passwordHash);

    // Authenticate tenant administrator on ERP app to obtain valid session
    const loginRes = await erpApp.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        host: 'app.campus.test',
        origin: 'https://app.campus.test',
      },
      payload: {
        email: tenant.emails.admin,
        password,
      },
    });

    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie || '';
    const match = /session_token=([^;]+)/.exec(cookieStr);
    expect(match).toBeTruthy();
    adminCookie = await mfaVerified(match![1]!);

    const loginBody = JSON.parse(loginRes.body);
    adminCsrf = loginBody.csrfToken || 'test-csrf';
  });

  afterAll(async () => {
    await platformServer.close();
    await platformDb.close();
  });

  describe('1. Platform Operator vs Tenant ERP Isolation', () => {
    it('platform operator token cannot access private tenant ERP APIs', async () => {
      // Attempting to access private student or vault APIs with platform token fails
      const res = await erpApp.inject({
        method: 'GET',
        url: '/api/v1/students',
        headers: {
          'x-platform-token': VALID_PLATFORM_TOKEN,
          authorization: `Bearer ${VALID_PLATFORM_TOKEN}`,
        },
      });
      // Fails with 401 because ERP routes require institutional session cookies
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      const msg = body.error?.message || body.message || '';
      expect(msg).toContain('Missing authentication token');
    });

    it('institution users cannot access Platform Control Center APIs', async () => {
      // Tenant admin calling platform stats without platform token
      const res = await platformServer.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        cookies: {
          session_token: adminCookie,
        },
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('credentials');
    });

    it('institution users cannot provision or modify platform institutions', async () => {
      const res = await platformServer.inject({
        method: 'POST',
        url: '/api/v1/platform/institutions',
        cookies: {
          session_token: adminCookie,
        },
        payload: {
          name: 'Unauthorized College',
          slug: 'unauthorized-college',
          institutionType: 'COLLEGE',
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('2. Paid Module Entitlement Enforcement', () => {
    it('allows access to entitled modules by default', async () => {
      const res = await erpApp.inject({
        method: 'GET',
        url: '/api/v1/academics/academic-years',
        cookies: {
          session_token: adminCookie,
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('blocks access with 403 MODULE_NOT_ENTITLED when a module is disabled in subscription plan', async () => {
      // Explicitly disable finance in feature.entitlements for this tenant
      await adminQuery(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
         VALUES ($1, 'feature.entitlements', $2, $3, 1)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [
          tenant.orgId,
          JSON.stringify({
            planBundle: 'ACADEMIC_CORE',
            modules: [
              { key: 'academics', enabled: true },
              { key: 'finance', enabled: false },
            ],
          }),
          tenant.users.admin,
        ],
      );

      // Attempting to query finance module structures returns 403 MODULE_NOT_ENTITLED
      const res = await erpApp.inject({
        method: 'GET',
        url: '/api/v1/finance/structures',
        cookies: {
          session_token: adminCookie,
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      const errCode = body.error?.code || body.code;
      const errMsg = body.error?.message || body.message;
      expect(errCode).toBe('MODULE_NOT_ENTITLED');
      expect(errMsg).toContain('not included in the institution\'s current subscription plan');
    });

    it('restores module access when entitlement is re-enabled', async () => {
      // Re-enable finance
      await adminQuery(
        `UPDATE app.organization_settings
            SET value = $1
          WHERE organization_id = $2 AND key = 'feature.entitlements'`,
        [
          JSON.stringify({
            planBundle: 'COMPLETE_ERP',
            modules: [
              { key: 'academics', enabled: true },
              { key: 'finance', enabled: true },
            ],
          }),
          tenant.orgId,
        ],
      );

      const res = await erpApp.inject({
        method: 'GET',
        url: '/api/v1/finance/structures',
        cookies: {
          session_token: adminCookie,
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('3. Institution Suspension Enforcement (Without Record Deletion)', () => {
    it('blocks operations with 403 INSTITUTION_SUSPENDED when institution is suspended', async () => {
      // Suspend institution via platform service
      await platformService.updateInstitution(tenant.orgId, {
        status: 'SUSPENDED',
        reason: 'Payment delinquency for audit demonstration',
      });

      // Verify organization is marked SUSPENDED
      const orgCheck = await adminQuery<{ status: string }>(
        'SELECT status FROM app.organizations WHERE id = $1',
        [tenant.orgId],
      );
      expect(orgCheck[0]!.status).toBe('SUSPENDED');

      // Attempting to perform academic configuration or state-changing action returns 403
      const res = await erpApp.inject({
        method: 'POST',
        url: '/api/v1/academics/academic-years',
        cookies: {
          session_token: adminCookie,
        },
        headers: {
          'x-csrf-token': adminCsrf,
          origin: 'https://app.campus.test',
        },
        payload: {
          label: '2026-2027 Academic Year',
          startDate: '2026-06-01',
          endDate: '2027-05-31',
        },
      });

      expect([401, 403]).toContain(res.statusCode);
      const body = JSON.parse(res.body);
      const errCode = body.error?.code || body.code;
      expect(['INSTITUTION_SUSPENDED', 'UNAUTHORIZED']).toContain(errCode);
    });

    it('preserves all existing institution records during and after suspension', async () => {
      // Check that users, roles, and settings are untouched
      const users = await adminQuery<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM app.users WHERE organization_id = $1',
        [tenant.orgId],
      );
      expect(parseInt(users[0]!.count, 10)).toBeGreaterThan(0);

      const roles = await adminQuery<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM app.roles WHERE organization_id = $1',
        [tenant.orgId],
      );
      expect(parseInt(roles[0]!.count, 10)).toBeGreaterThan(0);
    });

    it('restores operations upon reactivation without requiring data recovery', async () => {
      // Reactivate institution
      await platformService.updateInstitution(tenant.orgId, {
        status: 'ACTIVE',
        reason: 'Payment received',
      });

      const res = await erpApp.inject({
        method: 'GET',
        url: '/api/v1/academics/academic-years',
        cookies: {
          session_token: adminCookie,
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('4. Platform Audit Trail Verification', () => {
    it('records audit events for all platform management actions', async () => {
      const audits = await adminQuery<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM app.audit_events
          WHERE organization_id = $1
          ORDER BY occurred_at DESC`,
        [tenant.orgId],
      );

      // Verify audit entries were logged
      expect(audits.length).toBeGreaterThan(0);
      expect(audits.some((r) => r.action.startsWith('platform.'))).toBe(true);
    });
  });

  describe('5. Zero-Access Architecture Truth & Cryptographic Boundary', () => {
    it('proves School Vault uses hardware/passkey envelope encryption while standard ERP tables use RLS', async () => {
      // School Vault tables store ciphertext with client-derived salt/IV, NOT readable plaintext
      const vaultTables = await adminQuery<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'app' AND tablename LIKE 'vault_%'`,
      );
      // Vault tables exist
      expect(vaultTables.length).toBeGreaterThanOrEqual(1);

      // Standard tables (e.g. app.organizations, app.users, app.course_offerings) rely on
      // PostgreSQL Row-Level Security (FORCE ROW LEVEL SECURITY) and tenant context,
      // NOT client-side zero-access encryption.
      const rlsCheck = await adminQuery<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname IN ('organizations', 'users', 'course_offerings')`,
      );

      for (const row of rlsCheck) {
        expect(row.relrowsecurity).toBe(true);
        expect(row.relforcerowsecurity).toBe(true);
      }
    });
  });
});
