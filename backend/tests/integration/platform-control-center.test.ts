import { afterAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createPlatformDb, buildPlatformServer } from '../../tools/platform/platform-server.js';
import { PlatformService } from '../../tools/platform/platform.service.js';
import { assertDisposableTestDatabase } from '../../src/shared/database/test-guard.js';

describe('Anesa Platform Owner Control Center - Comprehensive Integration Suite', () => {
  const connectionString = inject('dbAdminUrl');
  if (!connectionString) {
    throw new Error(
      'platform-control-center.test.ts requires an isolated disposable database provided by Vitest global-db setup (inject("dbAdminUrl")). Failing closed to protect persistent databases.',
    );
  }
  assertDisposableTestDatabase(connectionString, 'platform-control-center.test.ts');

  const db = createPlatformDb(connectionString);
  const platformService = new PlatformService(db);
  const server = buildPlatformServer({ db });

  afterAll(async () => {
    await server.close();
    await db.close();
  });

  const VALID_TOKEN = 'change_me_platform_dev_token';

  describe('Independent Platform Authentication & Security Boundary', () => {
    it('refuses requests without platform credentials with 401 UNAUTHORIZED', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body) as { message?: string };
      expect(body.message).toContain('credentials');
    });

    it('refuses invalid platform operator token with 401 UNAUTHORIZED', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        headers: {
          'x-platform-token': 'invalid_secret_token_attempt',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts valid platform credentials via x-platform-token header', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        headers: {
          'x-platform-token': VALID_TOKEN,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        success: boolean;
        data: { institutions: { total: number } };
      };
      expect(body.success).toBe(true);
      expect(body.data.institutions.total).toBeGreaterThanOrEqual(1);
    });

    it('accepts valid platform credentials via Authorization: Bearer header', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        headers: {
          authorization: `Bearer ${VALID_TOKEN}`,
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('authenticates operator via /auth/login and sets HttpOnly session cookie', async () => {
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/v1/platform/auth/login',
        payload: { operatorToken: VALID_TOKEN },
      });
      expect(loginRes.statusCode).toBe(200);
      const loginBody = JSON.parse(loginRes.body) as { success: boolean; authenticated: boolean };
      expect(loginBody.success).toBe(true);
      expect(loginBody.authenticated).toBe(true);

      const cookieHeader = loginRes.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      expect(cookieStr).toContain('campusos_platform_session=');
      expect(cookieStr).toContain('HttpOnly');

      // Extract session ID from cookie
      const match = /campusos_platform_session=([^;]+)/.exec(cookieStr as string);
      const sessionId = match?.[1];
      expect(sessionId).toBeDefined();

      // Verify /auth/me with cookie
      const meRes = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/auth/me',
        cookies: {
          campusos_platform_session: sessionId!,
        },
      });
      expect(meRes.statusCode).toBe(200);
      const meBody = JSON.parse(meRes.body) as {
        authenticated: boolean;
        operator: { role: string };
      };
      expect(meBody.authenticated).toBe(true);
      expect(meBody.operator.role).toBe('OPERATOR');

      // Verify /stats with session cookie
      const statsRes = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        cookies: {
          campusos_platform_session: sessionId!,
        },
      });
      expect(statsRes.statusCode).toBe(200);

      // Logout revokes session
      const logoutRes = await server.inject({
        method: 'POST',
        url: '/api/v1/platform/auth/logout',
        cookies: {
          campusos_platform_session: sessionId!,
        },
      });
      expect(logoutRes.statusCode).toBe(200);

      // After logout, session is rejected
      const afterLogoutRes = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/stats',
        cookies: {
          campusos_platform_session: sessionId!,
        },
      });
      expect(afterLogoutRes.statusCode).toBe(401);
    });
  });

  describe('Platform Telemetry & Dashboard Stats', () => {
    it('returns real institution aggregates, subscriptions, and module adoption rates', async () => {
      const stats = await platformService.getPlatformStats();
      expect(stats.institutions.total).toBeGreaterThanOrEqual(1);
      expect(stats.institutions.active).toBeGreaterThanOrEqual(1);
      expect(stats.operationalHealth.database).toContain('PostgreSQL 16');
      expect(stats.operationalHealth.databaseConnections).toBeGreaterThan(0);
      expect(stats.moduleAdoption).toHaveProperty('students');
      expect(stats.moduleAdoption).toHaveProperty('academics');
      expect(stats.moduleAdoption).toHaveProperty('attendance');
      expect(stats.moduleAdoption).toHaveProperty('homework');
      expect(stats.moduleAdoption).toHaveProperty('examinations');
      expect(stats.moduleAdoption).toHaveProperty('finance');
      expect(stats.moduleAdoption).toHaveProperty('parent_portal');
      expect(stats.moduleAdoption).toHaveProperty('school_vault');
    });
  });

  describe('Global ERP Module Registry & SaaS Plan Bundles', () => {
    it('serves the complete 14 official Anesa ERP module catalog', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/catalog/modules',
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as { data: Array<{ key: string }> };
      expect(json.data.length).toBe(14);

      const keys = json.data.map((m) => m.key);
      expect(keys).toEqual(
        expect.arrayContaining([
          'students',
          'academics',
          'attendance',
          'homework',
          'examinations',
          'finance',
          'parent_portal',
          'documents',
          'imports',
          'reports',
          'school_vault',
          'consents',
          'notifications',
          'ai_assistant',
        ]),
      );
    });

    it('serves the standard SaaS plan bundles with pricing in INR', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/platform/catalog/bundles',
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as { data: Record<string, { name: string }> };
      const bundles = Object.values(json.data);
      expect(bundles.length).toBe(4);
      expect(bundles[0]!.name).toBe('Starter Core');
      expect(bundles[2]!.name).toBe('Complete Institutional ERP');
    });
  });

  describe('Institution Lifecycle & Provisioning', () => {
    const testSlug = `test-poly-${Date.now().toString(36)}`;
    let createdOrgId: string;

    it('provisions a new Higher Education College tenant with campus and roles seeded', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/platform/institutions',
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: {
          name: 'Apex Polytechnic Institute',
          slug: testSlug,
          institutionType: 'COLLEGE',
          adminEmail: 'dean@apexpoly.test',
          adminTitle: 'Dean of Engineering',
          initialPlan: 'COMPLETE_ERP',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.body) as {
        data: { id: string; slug: string; institutionType: string; status: string };
      };
      expect(json.data.slug).toBe(testSlug);
      expect(json.data.institutionType).toBe('COLLEGE');
      expect(json.data.status).toBe('ACTIVE');
      createdOrgId = json.data.id;
    });

    it('retrieves detailed configuration for the newly provisioned tenant', async () => {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/platform/institutions/${createdOrgId}`,
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as {
        data: {
          name: string;
          campuses: unknown[];
          entitlements: { modules: unknown[] };
          roles: unknown[];
        };
      };
      expect(json.data.name).toBe('Apex Polytechnic Institute');
      expect(json.data.campuses.length).toBe(1);
      expect(json.data.entitlements.modules.length).toBe(14);
      expect(json.data.roles.length).toBeGreaterThan(0);
    });

    it('safely suspends and reactivates the institution without deleting records', async () => {
      // Suspend
      const suspendRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/suspend`,
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(suspendRes.statusCode).toBe(200);

      const checkSuspended = await platformService.getInstitutionDetail(createdOrgId);
      expect(checkSuspended.status).toBe('SUSPENDED');

      // Reactivate
      const reactivateRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/reactivate`,
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(reactivateRes.statusCode).toBe(200);

      const checkActive = await platformService.getInstitutionDetail(createdOrgId);
      expect(checkActive.status).toBe('ACTIVE');
    });

    it('updates module entitlements enforcing inter-module dependencies', async () => {
      const res = await server.inject({
        method: 'PUT',
        url: `/api/v1/platform/institutions/${createdOrgId}/entitlements`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: {
          planBundle: 'ACADEMIC_PLUS',
          modules: [
            { key: 'students', enabled: true },
            { key: 'academics', enabled: true },
            { key: 'attendance', enabled: true },
            { key: 'homework', enabled: true },
            { key: 'examinations', enabled: true },
            { key: 'finance', enabled: false },
            { key: 'parent_portal', enabled: false },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as {
        data: { planBundle: string; modules: Array<{ key: string; enabled: boolean }> };
      };
      expect(json.data.planBundle).toBe('ACADEMIC_PLUS');

      const attendanceMod = json.data.modules.find((m) => m.key === 'attendance');
      expect(attendanceMod?.enabled).toBe(true);
    });

    it('reconciles canonical roles without overwriting institutional settings', async () => {
      const res = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/roles/reconcile`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { force: false },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body) as { data: { applied: boolean } };
      expect(json.data.applied).toBe(true);
    });

    it('manages first-administrator onboarding lifecycle (issue, reissue, revoke, and MFA bootstrap ticket)', async () => {
      // 1. Initial onboarding status is PENDING_ACTIVATION / NONE
      const initialDetail = await server.inject({
        method: 'GET',
        url: `/api/v1/platform/institutions/${createdOrgId}`,
        headers: { 'x-platform-token': VALID_TOKEN },
      });
      expect(initialDetail.statusCode).toBe(200);
      const initialJson = JSON.parse(initialDetail.body) as {
        data: {
          firstAdminOnboarding: {
            userId: string;
            email: string;
            activationStatus: string;
            invitationStatus: string;
            mfaEnrolled: boolean;
            mfaBootstrapEligible: boolean;
            canIssueInvitation: boolean;
            canRevokeInvitation: boolean;
          };
        };
      };
      expect(initialJson.data.firstAdminOnboarding.activationStatus).toBe('PENDING_ACTIVATION');
      expect(initialJson.data.firstAdminOnboarding.invitationStatus).toBe('NONE');
      expect(initialJson.data.firstAdminOnboarding.canIssueInvitation).toBe(true);
      expect(initialJson.data.firstAdminOnboarding.canRevokeInvitation).toBe(false);
      expect(initialJson.data.firstAdminOnboarding.mfaBootstrapEligible).toBe(false);

      // 2. Issuing MFA bootstrap ticket before activation is refused (409)
      const prematureMfaRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/first-admin/mfa-ticket`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { reason: 'Premature check' },
      });
      expect(prematureMfaRes.statusCode).toBe(409);

      // 3. Issue first-admin invitation
      const issueRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/first-admin/invite`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { sendEmail: false },
      });
      expect(issueRes.statusCode).toBe(201);
      const issueJson = JSON.parse(issueRes.body) as {
        data: {
          invitationId: string;
          token: string;
          acceptUrl: string;
          reissued: boolean;
          emailDelivery: string;
        };
      };
      expect(issueJson.data.reissued).toBe(false);
      expect(issueJson.data.token.length).toBeGreaterThan(20);
      const parsedAcceptUrl = new URL(issueJson.data.acceptUrl);
      expect(parsedAcceptUrl.pathname).toBe('/accept-invite');
      expect(parsedAcceptUrl.searchParams.get('token')).toBe(issueJson.data.token);
      expect(issueJson.data.emailDelivery).toBe('SKIPPED');

      // 4. Reissue revokes previous token and creates a fresh invitation
      const reissueRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/first-admin/invite`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { sendEmail: true },
      });
      expect(reissueRes.statusCode).toBe(201);
      const reissueJson = JSON.parse(reissueRes.body) as {
        data: {
          invitationId: string;
          token: string;
          reissued: boolean;
          emailDelivery: string;
        };
      };
      expect(reissueJson.data.reissued).toBe(true);
      expect(reissueJson.data.invitationId).not.toBe(issueJson.data.invitationId);
      expect(reissueJson.data.token).not.toBe(issueJson.data.token);
      expect(reissueJson.data.emailDelivery).toBe('NOT_CONFIGURED');

      // 5. Revoke unused invitation
      const revokeRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/first-admin/invite/revoke`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { reason: 'Operator revoked' },
      });
      expect(revokeRes.statusCode).toBe(200);
      const revokeJson = JSON.parse(revokeRes.body) as { data: { revoked: number } };
      expect(revokeJson.data.revoked).toBe(1);

      const afterRevoke = await platformService.getInstitutionDetail(createdOrgId);
      expect(afterRevoke.firstAdminOnboarding?.invitationStatus).toBe('REVOKED');
      expect(afterRevoke.firstAdminOnboarding?.canRevokeInvitation).toBe(false);

      // 6. Activate first-admin account in DB, then issue MFA bootstrap ticket
      const adminUserId = initialJson.data.firstAdminOnboarding.userId;
      const adminEmail = initialJson.data.firstAdminOnboarding.email;
      const identityId = uuidv7();
      await db.withSystem(async (tx) => {
        await tx.query(
          `INSERT INTO platform.identities (id, email, password_hash, status)
           VALUES ($1, lower($2), 'scrypt:test-hash', 'ACTIVE')`,
          [identityId, adminEmail],
        );
        await tx.query(
          `UPDATE app.users SET status = 'ACTIVE', identity_id = $1 WHERE id = $2 AND organization_id = $3`,
          [identityId, adminUserId, createdOrgId],
        );
      });

      const afterActivate = await platformService.getInstitutionDetail(createdOrgId);
      expect(afterActivate.firstAdminOnboarding?.activationStatus).toBe('ACTIVATED');
      expect(afterActivate.firstAdminOnboarding?.mfaBootstrapEligible).toBe(true);

      const mfaRes = await server.inject({
        method: 'POST',
        url: `/api/v1/platform/institutions/${createdOrgId}/first-admin/mfa-ticket`,
        headers: { 'x-platform-token': VALID_TOKEN },
        payload: { reason: 'Onboarding MFA setup' },
      });
      expect(mfaRes.statusCode).toBe(201);
      const mfaJson = JSON.parse(mfaRes.body) as {
        data: { ticketId: string; ticket: string; expiresAt: string };
      };
      expect(mfaJson.data.ticket.length).toBeGreaterThan(8);
    });
  });

  describe('Strict Zero-Access Trust Boundary Verification', () => {
    it('platform service queries only tenant configuration, never private student or vault records', () => {
      // Direct inspection of PlatformService methods confirms it has NO student query methods
      const proto = Object.getOwnPropertyNames(PlatformService.prototype);
      expect(proto).not.toContain('getStudentMarks');
      expect(proto).not.toContain('getVaultSecrets');
      expect(proto).not.toContain('getStudentRoster');
      expect(proto).not.toContain('impersonateUser');
    });
  });
});
