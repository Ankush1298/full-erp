import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import authHook from '../../src/modules/auth/auth.hook.js';
import { SESSION_COOKIE } from '../../src/modules/auth/session-cookie.js';
import { AppError, resourceNotFound, scopeNotFound } from '../../src/shared/errors/http-errors.js';
import { registerHardening } from '../../src/shared/http/hardening.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';

// Database-free: the REAL auth hook (permission gate, step-up check and the D9 onError denial-audit hook), the REAL
// recordAudit validation and the REAL error handler run over a scripted stand-in for the database. The stand-in answers
// the grants query, records every audit INSERT (sql + parameters) and rejects every other statement.

const tenantId = uuidv7();
const userId = uuidv7();
const SESSION_TOKEN = 'secret-session-token-value'; // secret-scan:allow (fabricated test value)
const BEARER = 'Bearer top-secret-bearer-value'; // secret-scan:allow (fabricated test value)

// Positional parameters of recordAudit's INSERT, in order.
const P = {
  tenant: 1,
  actor: 2,
  session: 3,
  requestId: 4,
  ip: 5,
  userAgent: 6,
  action: 7,
  resourceType: 8,
  resourceId: 9,
  riskTier: 13,
  changes: 14,
  reasonCode: 15,
  reasonText: 16,
  metadata: 17,
} as const;

interface Options {
  granted?: boolean;
  failAudit?: 'insert' | 'transaction' | undefined;
  trustProxy?: boolean;
  unauthenticated?: boolean;
  authStrength?: 'PASSWORD' | 'PASSWORD_REAUTH' | 'PASSWORD_MFA';
}

async function build(options: Options = {}) {
  const inserts: unknown[][] = [];
  const unexpected: string[] = [];
  const GRANT = { scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null };
  let transactions = 0;
  const db = {
    withTenant: (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      // The hook opens exactly one transaction for the permission lookup; every later one belongs to the audit write.
      if (options.failAudit === 'transaction' && transactions > 1) {
        return Promise.reject(new Error('connection lost'));
      }
      return work({
        query: (sql: string, params: unknown[] = []) => {
          if (sql.includes('app.role_assignments')) {
            return Promise.resolve({ rows: options.granted ? [GRANT] : [], rowCount: 0 });
          }
          if (sql.includes('INSERT INTO app.audit_events')) {
            inserts.push(params);
            return options.failAudit === 'insert'
              ? Promise.reject(new Error('audit insert failed'))
              : Promise.resolve({ rows: [], rowCount: 1 });
          }
          unexpected.push(sql.slice(0, 60));
          return Promise.reject(new Error('unexpected statement'));
        },
      });
    },
  };
  const ctx = issueTrustedContext({
    tenantId,
    userId,
    actorKind: 'STAFF',
    sessionId: uuidv7(),
    stepUpAt: null,
    authStrength: options.authStrength ?? 'PASSWORD',
  });
  // Error-level log lines, captured: Fastify contains (and does not log) an exception thrown inside an onError hook, so
  // denial.ts's own log line is the only trace of a lost audit event.
  const logs: string[] = [];
  const app = Fastify({
    logger: { level: 'error', stream: { write: (line: string) => void logs.push(line) } },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: options.trustProxy ?? false,
  });
  registerHardening(app, { production: false });
  await app.register(cookie);
  await app.register(authHook, {
    authService: {
      validateSession: () =>
        options.unauthenticated
          ? Promise.reject(new AppError(401, 'UNAUTHORIZED', 'Invalid session'))
          : Promise.resolve(ctx),
    } as never,
    db: db as never,
    allowedOrigins: [],
  });
  const read = { config: { permission: 'org.settings.read' } };
  app.get('/ok', read, () => ({ ok: true }));
  app.get('/items/:id', read, () => ({ ok: true }));
  app.get('/critical', { config: { permission: 'org.settings.manage' } }, () => ({ ok: true }));
  app.get('/hidden-out-of-scope', read, () => {
    throw scopeNotFound('org.campus.manage');
  });
  app.get('/genuinely-missing', read, () => {
    throw resourceNotFound();
  });
  app.get('/csrf', read, () => {
    throw new AppError(403, 'CSRF_REJECTED', 'The request was rejected.');
  });
  app.get('/boom', read, () => {
    throw new Error('unexpected internal failure');
  });
  const get = (url: string, headers: Record<string, string> = {}, remoteAddress?: string) =>
    app.inject({
      method: 'GET',
      url,
      headers,
      cookies: { [SESSION_COOKIE]: SESSION_TOKEN },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  return { app, get, inserts, unexpected, logs };
}

const LOST_EVENT = 'Failed to persist authorization denial audit event';

const body = (res: { json: <T>() => T }) =>
  res.json<{ error: { code: string; message: string; requestId: string } }>().error;
const metadataOf = (insert: unknown[]) =>
  JSON.parse(String(insert[P.metadata])) as Record<string, unknown>;

describe('what a denial audit event contains', () => {
  it('permission denial: actor, tenant and session from the server-side context; safe metadata only', async () => {
    const { app, get, inserts, unexpected } = await build({ granted: false });
    const itemId = uuidv7();
    const res = await get(`/items/${itemId}?q=private-search-term&ref=query-probe-value`, {
      authorization: BEARER,
      'user-agent': 'unit-test-agent/1.0',
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('FORBIDDEN');
    expect(unexpected).toEqual([]);

    expect(inserts).toHaveLength(1);
    const e = inserts[0]!;
    expect(e[P.tenant]).toBe(tenantId);
    expect(e[P.actor]).toBe(userId);
    expect(e[P.requestId]).toBe(body(res).requestId);
    expect(e[P.action]).toBe('auth.authorization_denied');
    expect(e[P.resourceType]).toBe('authorization');
    expect(e[P.riskTier]).toBe(2);
    expect(e[P.reasonCode]).toBe('PERMISSION_DENIED');
    expect(e[P.userAgent]).toBe('unit-test-agent/1.0');
    // no resource id, no field diff, no free text
    expect([e[P.resourceId], e[P.changes], e[P.reasonText]]).toEqual([null, null, null]);

    const metadata = metadataOf(e);
    expect(metadata).toEqual({
      permission: 'org.settings.read',
      reason: 'PERMISSION_DENIED',
      outcome: 'DENIED',
      method: 'GET',
      route: '/items/:id', // the route PATTERN, never the concrete URL
    });
    // nothing the client sent (cookie, authorization header, query string, path id) appears in any parameter
    const everything = JSON.stringify(e);
    for (const secret of [
      SESSION_TOKEN,
      BEARER,
      'private-search-term',
      'query-probe-value',
      itemId,
    ]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it('a tenant or user supplied by the client can never become the audit actor or tenant', async () => {
    const { app, get, inserts } = await build({ granted: false });
    await get(`/ok?tenantId=${uuidv7()}&userId=${uuidv7()}`, {
      'x-tenant-id': uuidv7(),
      'x-user-id': uuidv7(),
    });
    await app.close();
    expect(inserts).toHaveLength(1);
    expect([inserts[0]![P.tenant], inserts[0]![P.actor]]).toEqual([tenantId, userId]);
  });

  it('step-up denial records the required and the current assurance, and the production minimum is PASSWORD_MFA', async () => {
    const { app, get, inserts } = await build({ granted: true, authStrength: 'PASSWORD_REAUTH' });
    const res = await get('/critical');
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('STEP_UP_REQUIRED');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![P.reasonCode]).toBe('STEP_UP_REQUIRED');
    expect(metadataOf(inserts[0]!)).toEqual({
      permission: 'org.settings.manage',
      reason: 'STEP_UP_REQUIRED',
      outcome: 'DENIED',
      method: 'GET',
      route: '/critical',
      requiredAssurance: 'PASSWORD_MFA',
      currentAssurance: 'PASSWORD_REAUTH',
    });
  });
});

describe('hidden-resource 404: audited server-side, indistinguishable to the client', () => {
  it('an out-of-scope 404 and a genuinely missing 404 have the same status, code and message; only the first is audited', async () => {
    const { app, get, inserts } = await build({ granted: true });
    const outOfScope = await get('/hidden-out-of-scope');
    const missing = await get('/genuinely-missing');
    await app.close();

    expect([outOfScope.statusCode, missing.statusCode]).toEqual([404, 404]);
    const a = body(outOfScope);
    const b = body(missing);
    expect([a.code, a.message]).toEqual([b.code, b.message]);
    expect(Object.keys(outOfScope.json<{ error: object }>().error).sort()).toEqual(
      Object.keys(missing.json<{ error: object }>().error).sort(),
    );
    // the response carries no trace of the server-side scope flag or the denied permission
    expect(outOfScope.body).not.toMatch(
      /isScopeDenial|deniedPermission|org\.campus\.manage|scope/i,
    );

    expect(inserts).toHaveLength(1); // the genuinely missing resource is not an authorization event
    expect(inserts[0]![P.reasonCode]).toBe('OUT_OF_SCOPE');
    expect(inserts[0]![P.requestId]).toBe(a.requestId);
    expect(metadataOf(inserts[0]!)).toMatchObject({
      permission: 'org.campus.manage',
      reason: 'OUT_OF_SCOPE',
      outcome: 'DENIED',
    });
    expect(inserts[0]![P.resourceId]).toBeNull(); // the existence of a specific resource is never recorded
  });
});

describe('what is NOT audited as an authorization denial', () => {
  it('success, CSRF rejection, unexpected errors and unauthenticated requests write nothing', async () => {
    const granted = await build({ granted: true });
    expect((await granted.get('/ok')).statusCode).toBe(200);
    expect(body(await granted.get('/csrf')).code).toBe('CSRF_REJECTED');
    expect((await granted.get('/boom')).statusCode).toBe(500);
    await granted.app.close();
    expect(granted.inserts).toEqual([]);

    const anonymous = await build({ unauthenticated: true });
    const res = await anonymous.get('/ok');
    await anonymous.app.close();
    expect(res.statusCode).toBe(401);
    expect(anonymous.inserts).toEqual([]);
  });
});

describe('an audit failure never turns a denial into anything else', () => {
  it.each([
    ['the audit INSERT fails', 'insert'],
    ['the audit transaction cannot be opened', 'transaction'],
  ] as const)(
    '%s: the client still gets the same refusal, there is no retry, and the lost event is logged without secrets',
    async (_name, failAudit) => {
      const cases = [
        { options: { granted: false }, url: '/ok', status: 403, code: 'FORBIDDEN' },
        { options: { granted: true }, url: '/critical', status: 403, code: 'STEP_UP_REQUIRED' },
        {
          options: { granted: true },
          url: '/hidden-out-of-scope',
          status: 404,
          code: 'RESOURCE_NOT_FOUND',
        },
      ];
      for (const c of cases) {
        const { app, get, inserts, logs } = await build({ ...c.options, failAudit });
        const res = await get(c.url, { authorization: BEARER });
        await app.close();
        expect([res.statusCode, body(res).code], c.url).toEqual([c.status, c.code]);
        expect(inserts.length, c.url).toBeLessThanOrEqual(1); // one attempt at most: no retry loop
        // the failure is visible to operators (nothing else records it) and carries no client secret
        const logged = logs.filter((l) => l.includes(LOST_EVENT));
        expect(logged, c.url).toHaveLength(1);
        for (const secret of [SESSION_TOKEN, BEARER]) {
          expect(logs.join(''), secret).not.toContain(secret);
        }
      }
    },
  );

  it('a successful audit write logs nothing', async () => {
    const { app, get, logs } = await build({ granted: false });
    await get('/ok');
    await app.close();
    expect(logs.filter((l) => l.includes(LOST_EVENT))).toEqual([]);
  });
});

describe('a client-supplied address cannot suppress the audit of its own denial (TRUST_PROXY=true)', () => {
  it('an unparsable X-Forwarded-For still produces exactly one event, with no address recorded', async () => {
    const { app, get, inserts } = await build({ granted: false, trustProxy: true });
    for (const forwarded of ['garbage', 'not an ip, 10.0.0.1', '999.1.1.1']) {
      const res = await get('/ok', { 'x-forwarded-for': forwarded }, '127.0.0.1');
      expect(res.statusCode, forwarded).toBe(403);
    }
    await app.close();
    expect(inserts).toHaveLength(3);
    for (const e of inserts) expect(e[P.ip]).toBeNull();
  });

  it('a valid forwarded address is recorded as given', async () => {
    const { app, get, inserts } = await build({ granted: false, trustProxy: true });
    await get('/ok', { 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1');
    await app.close();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![P.ip]).toBe('203.0.113.9');
  });
});
