import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import {
  CAMPUS_2,
  CAMPUS_ADMIN_A,
  NOROLE_A,
  ORG_A,
  ORG_B,
  STAFF_A,
  STAFF_B,
  UNKNOWN_V7,
} from '../support/fixtures.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';

const LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  campusAdminA: 'campus.admin.a@college-a.test',
  noRoleA: 'norole.a@college-a.test',
  orgAdminB: 'staff.b@college-b.test', // another tenant
} as const;

type UserKey = keyof typeof LOGINS;

interface SessionInfo {
  cookie: string;
  csrf: string;
}

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

// The same application behind a proxy it trusts (TRUST_PROXY=true): request.ip then comes from the client-supplied
// X-Forwarded-For, which need not be an IP address.
const proxyApp = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN, TRUST_PROXY: 'true' }),
  db,
  logger: false,
});

const sessions = {} as Record<UserKey, SessionInfo>;

async function loginUser(email: string): Promise<SessionInfo> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, `login for ${email}`).toBe(200);
  const cookie = await mfaVerified(r.cookies.find((c) => c.name === 'session_token')?.value);
  expect(cookie).toBeDefined();
  const csrf = r.json<{ csrf_token: string }>().csrf_token;
  expect(csrf).toBeDefined();
  return { cookie: cookie!, csrf };
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  const emails = Object.values(LOGINS);
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, emails],
  );

  for (const [key, email] of Object.entries(LOGINS) as [UserKey, string][]) {
    sessions[key] = await loginUser(email);
  }
});

afterAll(async () => {
  await app.close();
  await proxyApp.close();
  await pool.end().catch(() => undefined);
});

describe('D9 Centralized Authorization-Denial Auditing', () => {
  describe('Permission Denied (403 FORBIDDEN)', () => {
    it('audits permission denial as Tier 2 event with actor and safe request metadata', async () => {
      const { cookie } = sessions.noRoleA;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/organization/settings',
        cookies: { session_token: cookie },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
      const reqId = body.error.requestId;
      expect(reqId).toBeDefined();

      const rows = await adminQuery<{
        id: string;
        organization_id: string;
        actor_user_id: string;
        session_id: string;
        request_id: string;
        action: string;
        risk_tier: number;
        reason_code: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, organization_id, actor_user_id, session_id, request_id, action, risk_tier, reason_code, metadata
           FROM app.audit_events
          WHERE request_id = $1`,
        [reqId],
      );

      expect(rows).toHaveLength(1);
      const [audit] = rows;
      expect(audit!.organization_id).toBe(ORG_A);
      expect(audit!.actor_user_id).toBe(NOROLE_A);
      expect(audit!.session_id).toBeDefined();
      expect(audit!.action).toBe('auth.authorization_denied');
      expect(audit!.risk_tier).toBe(2);
      expect(audit!.reason_code).toBe('PERMISSION_DENIED');
      expect(audit!.metadata).toMatchObject({
        permission: 'org.settings.read',
        reason: 'PERMISSION_DENIED',
        outcome: 'DENIED',
        method: 'GET',
        route: '/api/v1/organization/settings',
      });
    });
  });

  describe('Step-Up Required (403 STEP_UP_REQUIRED)', () => {
    it('audits step-up denial as Tier 2 event with required and current assurance levels', async () => {
      const { cookie, csrf } = sessions.orgAdminA;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: {
          'x-csrf-token': csrf,
          'if-match': '"1"',
        },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Testing step-up denial audit' },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(body.error.code).toBe('STEP_UP_REQUIRED');
      const reqId = body.error.requestId;
      expect(reqId).toBeDefined();

      const rows = await adminQuery<{
        id: string;
        organization_id: string;
        actor_user_id: string;
        session_id: string;
        request_id: string;
        action: string;
        risk_tier: number;
        reason_code: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, organization_id, actor_user_id, session_id, request_id, action, risk_tier, reason_code, metadata
           FROM app.audit_events
          WHERE request_id = $1`,
        [reqId],
      );

      expect(rows).toHaveLength(1);
      const [audit] = rows;
      expect(audit!.organization_id).toBe(ORG_A);
      expect(audit!.actor_user_id).toBe(STAFF_A);
      expect(audit!.session_id).toBeDefined();
      expect(audit!.action).toBe('auth.authorization_denied');
      expect(audit!.risk_tier).toBe(2);
      expect(audit!.reason_code).toBe('STEP_UP_REQUIRED');
      expect(audit!.metadata).toMatchObject({
        permission: 'org.settings.manage',
        reason: 'STEP_UP_REQUIRED',
        outcome: 'DENIED',
        method: 'PUT',
        requiredAssurance: 'PASSWORD_MFA',
        currentAssurance: 'PASSWORD',
      });
    });
  });

  describe('Scope Denial (Hidden-Resource 404)', () => {
    it('audits out-of-scope access as Tier 2 event while returning identical 404 to non-existent resource', async () => {
      const { cookie } = sessions.campusAdminA;

      // 1. Out-of-scope existing campus (CAMPUS_2 is in ORG_A, but campusAdminA is scoped only to CAMPUS_1)
      const outOfScopeRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organization/campuses/${CAMPUS_2}`,
        cookies: { session_token: cookie },
      });

      // 2. Control: completely non-existent resource
      const notFoundRes = await app.inject({
        method: 'GET',
        url: `/api/v1/organization/campuses/${UNKNOWN_V7}`,
        cookies: { session_token: cookie },
      });

      // Status codes and error contract must be completely indistinguishable to the client
      expect(outOfScopeRes.statusCode).toBe(404);
      expect(notFoundRes.statusCode).toBe(404);

      const outOfScopeBody = outOfScopeRes.json<{
        error: { code: string; message: string; requestId: string };
      }>();
      const notFoundBody = notFoundRes.json<{
        error: { code: string; message: string; requestId: string };
      }>();

      expect(outOfScopeBody.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(notFoundBody.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(outOfScopeBody.error.message).toBe(notFoundBody.error.message);
      expect(outOfScopeBody.error.message).toBe('The requested resource was not found.');

      // 3. Out-of-scope request produces an audit record
      const outOfScopeAudit = await adminQuery<{
        id: string;
        organization_id: string;
        actor_user_id: string;
        session_id: string;
        request_id: string;
        action: string;
        risk_tier: number;
        reason_code: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, organization_id, actor_user_id, session_id, request_id, action, risk_tier, reason_code, metadata
           FROM app.audit_events
          WHERE request_id = $1`,
        [outOfScopeBody.error.requestId],
      );

      expect(outOfScopeAudit).toHaveLength(1);
      const [audit] = outOfScopeAudit;
      expect(audit!.organization_id).toBe(ORG_A);
      expect(audit!.actor_user_id).toBe(CAMPUS_ADMIN_A);
      expect(audit!.action).toBe('auth.authorization_denied');
      expect(audit!.risk_tier).toBe(2);
      expect(audit!.reason_code).toBe('OUT_OF_SCOPE');
      expect(audit!.metadata).toMatchObject({
        reason: 'OUT_OF_SCOPE',
        outcome: 'DENIED',
        method: 'GET',
      });
      // Metadata must NEVER confirm existence or leak internal identifiers
      expect(audit!.metadata).not.toHaveProperty('exists');
      expect(audit!.metadata).not.toHaveProperty('resourceExists');
    });
  });

  describe('Audit Idempotency & Tenant Safety', () => {
    it('records exactly one audit event for a denied request', async () => {
      const { cookie } = sessions.noRoleA;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/organization/settings',
        cookies: { session_token: cookie },
      });

      const reqId = res.json<{ error: { requestId: string } }>().error.requestId;

      const count = await adminQuery<{ count: string }>(
        `SELECT count(*) FROM app.audit_events WHERE request_id = $1`,
        [reqId],
      );
      expect(Number(count[0]!.count)).toBe(1);
    });

    it('does NOT record denial audit event for successful authorized request', async () => {
      // Responses carry no request id header, so each request is tagged with a unique user agent instead. The control
      // (a denied request with its own tag) proves the query below really does find a denial event when there is one.
      const denialsFor = (agent: string) =>
        adminQuery(
          `SELECT 1 FROM app.audit_events WHERE user_agent = $1 AND action = 'auth.authorization_denied'`,
          [agent],
        );
      const send = (who: UserKey, agent: string) =>
        app.inject({
          method: 'GET',
          url: '/api/v1/organization/settings',
          cookies: { session_token: sessions[who].cookie },
          headers: { 'user-agent': agent },
        });

      const deniedAgent = `d9-denied-${randomUUID()}`;
      expect((await send('noRoleA', deniedAgent)).statusCode).toBe(403);
      expect(await denialsFor(deniedAgent)).toHaveLength(1);

      const okAgent = `d9-ok-${randomUUID()}`;
      expect((await send('orgAdminA', okAgent)).statusCode).toBe(200);
      expect(await denialsFor(okAgent)).toHaveLength(0);
    });

    it('unauthenticated request (401) does not write to tenant audit logs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/organization/settings',
      });

      expect(res.statusCode).toBe(401);
      const reqId = res.json<{ error: { requestId: string } }>().error.requestId;
      expect(reqId).toBeDefined();

      const count = await adminQuery<{ count: string }>(
        `SELECT count(*) FROM app.audit_events WHERE request_id = $1`,
        [reqId],
      );
      expect(Number(count[0]!.count)).toBe(0);
    });
  });

  describe('Privacy and suppression resistance', () => {
    it('a denied write stores no request body, token or credential anywhere in the event', async () => {
      const { cookie, csrf } = sessions.orgAdminA;
      const agent = `d9-privacy-${randomUUID()}`;
      const marker = `body-marker-${randomUUID()}`;

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': csrf, 'if-match': '"1"', 'user-agent': agent },
        cookies: { session_token: cookie },
        payload: { value: true, reason: marker },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');

      const rows = await adminQuery<Record<string, unknown>>(
        `SELECT * FROM app.audit_events WHERE user_agent = $1`,
        [agent],
      );
      expect(rows).toHaveLength(1);
      const stored = JSON.stringify(rows[0]);
      for (const secret of [marker, cookie, csrf, PASSWORD]) {
        expect(stored, secret).not.toContain(secret);
      }
      expect(rows[0]!['changes']).toBeNull();
      expect(rows[0]!['reason_text']).toBeNull();
      expect(rows[0]!['resource_id']).toBeNull();
    });

    it('an unparsable X-Forwarded-For (TRUST_PROXY=true) cannot suppress the denial event; no address is stored', async () => {
      const { cookie } = sessions.noRoleA;
      for (const forwarded of ['garbage', 'not an ip, 10.0.0.1', '999.1.1.1']) {
        const agent = `d9-xff-${randomUUID()}`;
        const res = await proxyApp.inject({
          method: 'GET',
          url: '/api/v1/organization/settings',
          cookies: { session_token: cookie },
          headers: { 'x-forwarded-for': forwarded, 'user-agent': agent },
        });
        expect(res.statusCode, forwarded).toBe(403);
        const rows = await adminQuery<{ action: string; ip: string | null }>(
          `SELECT action, host(ip) AS ip FROM app.audit_events WHERE user_agent = $1`,
          [agent],
        );
        expect(rows, forwarded).toEqual([{ action: 'auth.authorization_denied', ip: null }]);
      }
    });

    it('a valid forwarded address is recorded as the event address', async () => {
      const agent = `d9-xff-${randomUUID()}`;
      const res = await proxyApp.inject({
        method: 'GET',
        url: '/api/v1/organization/settings',
        cookies: { session_token: sessions.noRoleA.cookie },
        headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': agent },
      });
      expect(res.statusCode).toBe(403);
      const rows = await adminQuery<{ ip: string | null }>(
        `SELECT host(ip) AS ip FROM app.audit_events WHERE user_agent = $1`,
        [agent],
      );
      expect(rows).toEqual([{ ip: '203.0.113.9' }]);
    });
  });

  describe('Tenant isolation of the audit trail', () => {
    it("a denial by a user of another tenant is recorded in THAT user's tenant only", async () => {
      const agent = `d9-xtenant-${randomUUID()}`;
      const { cookie, csrf } = sessions.orgAdminB;
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/organization/settings/identity.dob_required',
        headers: { 'x-csrf-token': csrf, 'if-match': '"1"', 'user-agent': agent },
        cookies: { session_token: cookie },
        payload: { value: true, reason: 'Cross-tenant isolation check' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');

      const rows = await adminQuery<{ organization_id: string; actor_user_id: string }>(
        `SELECT organization_id, actor_user_id FROM app.audit_events WHERE user_agent = $1`,
        [agent],
      );
      expect(rows).toEqual([{ organization_id: ORG_B, actor_user_id: STAFF_B }]);
    });

    it("probing another tenant's campus returns the generic 404 and writes nothing into that tenant", async () => {
      const { cookie } = sessions.orgAdminB;
      const agent = `d9-probe-${randomUUID()}`;
      const send = (id: string, userAgent: string) =>
        app.inject({
          method: 'GET',
          url: `/api/v1/organization/campuses/${id}`,
          cookies: { session_token: cookie },
          headers: { 'user-agent': userAgent },
        });

      const foreign = await send(CAMPUS_2, agent); // a real campus, but of ORG_A
      const missing = await send(UNKNOWN_V7, `${agent}-control`);
      const error = (r: typeof foreign) =>
        r.json<{ error: { code: string; message: string } }>().error;
      expect([foreign.statusCode, missing.statusCode]).toEqual([404, 404]);
      expect([error(foreign).code, error(foreign).message]).toEqual([
        error(missing).code,
        error(missing).message,
      ]);

      // nothing about the probe is written into the tenant that owns the campus
      const inOwner = await adminQuery(
        `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND user_agent LIKE $2`,
        [ORG_A, `${agent}%`],
      );
      expect(inOwner).toEqual([]);
    });
  });
});
