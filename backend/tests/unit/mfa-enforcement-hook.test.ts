import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import authHook from '../../src/modules/auth/auth.hook.js';
import { SESSION_COOKIE } from '../../src/modules/auth/session-cookie.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import {
  MFA_EXEMPT_PERMISSIONS,
  MFA_REQUIRED_ROLES,
} from '../../src/shared/authorization/mfa-policy.js';
import { ROLE_CODES } from '../../src/shared/authorization/role-matrix.js';

// Database-free: the REAL auth hook on a bare Fastify instance. The stand-in database answers the role-code query of the
// MFA policy, the grants query and the denial-audit insert; anything else is an error. Time is injected.

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const tenantId = uuidv7();
const userId = uuidv7();
const GRANT = { scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null };

function standIn(roles: readonly string[], perms: readonly string[], failPolicy = false) {
  const audits: unknown[][] = [];
  let policyQueries = 0;
  const db = {
    withTenant: (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) =>
      work({
        query: (sql: string, params: unknown[] = []) => {
          const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
          if (sql.includes('JOIN app.roles r')) {
            policyQueries += 1;
            if (failPolicy) return Promise.reject(new Error('connection lost'));
            return rows(roles.map((code) => ({ code })));
          }
          if (sql.includes('role_permissions'))
            return rows(perms.includes(params[2] as string) ? [GRANT] : []);
          if (sql.includes('INSERT INTO app.audit_events')) {
            audits.push(params);
            return rows([]);
          }
          return Promise.reject(new Error(`unexpected statement: ${sql}`));
        },
      }),
  };
  return { db, audits, policyQueries: () => policyQueries };
}

const ctxWith = (o: {
  mfaVerifiedAt?: Date | null;
  stepUpAt?: Date | null;
  authStrength?: 'PASSWORD' | 'PASSWORD_REAUTH' | 'PASSWORD_MFA';
}) =>
  issueTrustedContext({
    tenantId,
    userId,
    actorKind: 'STAFF',
    sessionId: uuidv7(),
    mfaVerifiedAt: o.mfaVerifiedAt ?? null,
    stepUpAt: o.stepUpAt ?? null,
    authStrength: o.authStrength ?? 'PASSWORD',
  });

async function call(
  ctx: ReturnType<typeof ctxWith>,
  stand: ReturnType<typeof standIn>,
  url: string,
): Promise<{ status: number; code: string | undefined }> {
  const app = Fastify({ logger: false, genReqId: () => randomUUID() }); // as buildApp does
  await app.register(cookie);
  await app.register(authHook, {
    authService: { validateSession: () => Promise.resolve(ctx) } as never,
    db: stand.db as never,
    allowedOrigins: [],
    now: () => NOW,
  });
  app.get('/normal', { config: { permission: 'org.structure.read' } }, () => ({ ok: true }));
  app.get('/critical', { config: { permission: 'org.settings.manage' } }, () => ({ ok: true }));
  app.get('/me', { config: { permission: 'session.read' } }, () => ({ ok: true }));
  app.get('/mfa', { config: { permission: 'auth.mfa.manage' } }, () => ({ ok: true }));
  app.get('/mixed', { config: { permission: ['auth.mfa.manage', 'org.structure.read'] } }, () => ({
    ok: true,
  }));
  try {
    const res = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: 't' } });
    const body = res.json<{ code?: string; error?: { code?: string } }>();
    return { status: res.statusCode, code: body.code ?? body.error?.code };
  } finally {
    await app.close();
  }
}

const ALL = [
  'org.structure.read',
  'org.settings.manage',
  'session.read',
  'auth.mfa.manage',
] as const;

describe('MFA policy constants', () => {
  it('required roles are exactly ADR-004: HOD and above plus REGISTRAR (all real role codes)', () => {
    expect([...MFA_REQUIRED_ROLES].sort()).toEqual(
      ['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'DEPARTMENT_ADMIN', 'HOD', 'REGISTRAR'].sort(),
    );
    for (const r of MFA_REQUIRED_ROLES) expect(ROLE_CODES).toContain(r);
  });
  it('a restricted session may only read its session and manage its own MFA', () => {
    expect([...MFA_EXEMPT_PERMISSIONS].sort()).toEqual(
      ['auth.mfa.manage', 'session.read', 'session.revoke'].sort(),
    );
  });
});

describe('auth hook: MFA-required roles without a verified second factor on this session', () => {
  for (const role of MFA_REQUIRED_ROLES) {
    it(`${role}: every non-exempt route is 403 MFA_REQUIRED (and audited); session and MFA routes still work`, async () => {
      const stand = standIn([role], ALL);
      const ctx = ctxWith({});
      expect(await call(ctx, stand, '/normal')).toEqual({ status: 403, code: 'MFA_REQUIRED' });
      expect(await call(ctx, stand, '/mixed')).toEqual({ status: 403, code: 'MFA_REQUIRED' });
      expect(await call(ctx, stand, '/me')).toEqual({ status: 200, code: undefined });
      expect(await call(ctx, stand, '/mfa')).toEqual({ status: 200, code: undefined });
      expect(stand.audits).toHaveLength(2);
      for (const a of stand.audits) {
        expect(a).toContain('auth.authorization_denied');
        expect(a).toContain('MFA_REQUIRED');
      }
    });
  }

  it('password re-authentication does not count as MFA: a fresh PASSWORD_REAUTH session is still restricted', async () => {
    const stand = standIn(['COLLEGE_ADMIN'], ALL);
    const ctx = ctxWith({ stepUpAt: new Date(NOW - 1000), authStrength: 'PASSWORD_REAUTH' });
    expect(await call(ctx, stand, '/normal')).toEqual({ status: 403, code: 'MFA_REQUIRED' });
  });

  it('is decided BEFORE the permission, so a restricted session learns nothing about its capabilities', async () => {
    const stand = standIn(['HOD'], []);
    expect(await call(ctxWith({}), stand, '/critical')).toEqual({
      status: 403,
      code: 'MFA_REQUIRED',
    });
  });

  it('a session that completed MFA passes the gate; CRITICAL still needs a fresh PASSWORD_MFA step-up', async () => {
    const stand = standIn(['COLLEGE_ADMIN'], ALL);
    const verified = ctxWith({ mfaVerifiedAt: new Date(NOW - 3_600_000) });
    expect(await call(verified, stand, '/normal')).toEqual({ status: 200, code: undefined });
    expect(await call(verified, stand, '/critical')).toEqual({
      status: 403,
      code: 'STEP_UP_REQUIRED',
    });
    const reauth = ctxWith({
      mfaVerifiedAt: new Date(NOW - 3_600_000),
      stepUpAt: new Date(NOW - 1000),
      authStrength: 'PASSWORD_REAUTH',
    });
    expect(await call(reauth, stand, '/critical')).toEqual({
      status: 403,
      code: 'STEP_UP_REQUIRED',
    });
    const fresh = ctxWith({
      mfaVerifiedAt: new Date(NOW - 1000),
      stepUpAt: new Date(NOW - 1000),
      authStrength: 'PASSWORD_MFA',
    });
    expect(await call(fresh, stand, '/critical')).toEqual({ status: 200, code: undefined });
    expect(stand.policyQueries()).toBe(0); // a verified session never needs the policy lookup
  });

  it('a verification timestamp from the future is not accepted', async () => {
    const stand = standIn(['HOD'], ALL);
    const ctx = ctxWith({ mfaVerifiedAt: new Date(NOW + 60_000) });
    expect(await call(ctx, stand, '/normal')).toEqual({ status: 403, code: 'MFA_REQUIRED' });
  });

  it('roles outside the policy (and no role at all) are not restricted', async () => {
    for (const roles of [['FACULTY'], ['STAFF'], ['STUDENT'], []]) {
      const stand = standIn(roles, ALL);
      expect(await call(ctxWith({}), stand, '/normal'), roles.join() || 'none').toEqual({
        status: 200,
        code: undefined,
      });
    }
  });

  it('a policy lookup failure fails closed (500), never open', async () => {
    const stand = standIn(['HOD'], ALL, true);
    const r = await call(ctxWith({}), stand, '/normal');
    expect(r.status).toBe(500);
  });
});
