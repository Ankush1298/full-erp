import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import authHook, { type AuthPluginOptions } from '../../src/modules/auth/auth.hook.js';
import { SESSION_COOKIE } from '../../src/modules/auth/session-cookie.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { registerIssued } from '../../src/shared/tenancy/context-registry.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';

// Database-free: the REAL auth hook (permission gate + CRITICAL step-up check) runs on a bare Fastify instance, with a
// stand-in authService that returns a fixed context and a stand-in database that only answers the grants query.
// `org.settings.manage` is CRITICAL, `org.settings.read` is NORMAL. Time is injected, so nothing here depends on the clock.

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const SKEW = 5_000;
const MAX_AGE = 600_000;
const tenantId = uuidv7();
const userId = uuidv7();

const GRANT = { scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null };
const fakeDb = {
  withTenant: (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) =>
    work({
      query: (sql: string) =>
        sql.includes('app.role_assignments')
          ? Promise.resolve({ rows: [GRANT], rowCount: 1 })
          : Promise.reject(new Error('unexpected statement')),
    }),
};

/** A context from the real issuer (validated). */
const issued = (
  stepUpAt: Date | null,
  authStrength: 'PASSWORD' | 'PASSWORD_REAUTH' | 'PASSWORD_MFA',
) => issueTrustedContext({ tenantId, userId, actorKind: 'STAFF', stepUpAt, authStrength });

/**
 * Simulates a bypassed or buggy issuer: an object that IS registered as trusted but carries malformed assurance data.
 * The hook must still refuse, because it re-validates instead of trusting the issuer.
 */
function bypassed(assurance: Record<string, unknown>): TrustedContext {
  const ctx = Object.freeze({
    tenantId,
    userId,
    actorKind: 'STAFF',
    sessionId: undefined,
    stepUpAt: null,
    authStrength: 'PASSWORD_MFA',
    ...assurance,
  });
  registerIssued(ctx);
  return ctx as unknown as TrustedContext;
}

async function get(
  ctx: TrustedContext,
  url: '/critical' | '/normal' = '/critical',
  options: Partial<AuthPluginOptions> = {},
) {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(authHook, {
    authService: { validateSession: () => Promise.resolve(ctx) } as never,
    db: fakeDb as never,
    allowedOrigins: [],
    now: () => NOW,
    ...options,
  });
  app.get('/critical', { config: { permission: 'org.settings.manage' } }, () => ({ ok: true }));
  app.get('/normal', { config: { permission: 'org.settings.read' } }, () => ({ ok: true }));
  try {
    const res = await app.inject({
      method: 'GET',
      url,
      cookies: { [SESSION_COOKIE]: 'session-token' },
    });
    return { status: res.statusCode, code: res.json<{ code?: string }>().code };
  } finally {
    await app.close();
  }
}

const OK = { status: 200, code: undefined };
const STEP_UP = { status: 403, code: 'STEP_UP_REQUIRED' };
const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

describe('CRITICAL routes: valid step-up passes only inside the window, at the required assurance', () => {
  it('fresh PASSWORD_MFA passes; the request without step-up data is refused', async () => {
    expect(await get(issued(at(-1_000), 'PASSWORD_MFA'))).toEqual(OK);
    expect(await get(issued(null, 'PASSWORD_MFA'))).toEqual(STEP_UP);
    expect(await get(issued(null, 'PASSWORD'))).toEqual(STEP_UP);
  });

  it('a NORMAL route never needs step-up', async () => {
    expect(await get(issued(null, 'PASSWORD'), '/normal')).toEqual(OK);
  });

  it('expiry: exactly the maximum age passes, one millisecond older is refused', async () => {
    expect(await get(issued(at(-MAX_AGE), 'PASSWORD_MFA'))).toEqual(OK);
    expect(await get(issued(at(-MAX_AGE - 1), 'PASSWORD_MFA'))).toEqual(STEP_UP);
  });

  it('clock skew: up to 5 s in the future is tolerated, 1 ms beyond that is refused', async () => {
    expect(await get(issued(at(SKEW), 'PASSWORD_MFA'))).toEqual(OK);
    expect(await get(issued(at(SKEW + 1), 'PASSWORD_MFA'))).toEqual(STEP_UP);
  });

  it('timestamps far in the future (an hour, a year, the largest Date) are refused', async () => {
    for (const offset of [3_600_000, 365 * 86_400_000, 8_640_000_000_000_000 - NOW]) {
      expect(await get(issued(at(offset), 'PASSWORD_MFA')), String(offset)).toEqual(STEP_UP);
    }
  });
});

describe('production default minimum assurance is PASSWORD_MFA (never lowered)', () => {
  it('with no option, PASSWORD_REAUTH and PASSWORD are refused on CRITICAL routes', async () => {
    expect(await get(issued(at(-1_000), 'PASSWORD_REAUTH'))).toEqual(STEP_UP);
    expect(await get(issued(at(-1_000), 'PASSWORD'))).toEqual(STEP_UP);
    expect(await get(issued(at(-1_000), 'PASSWORD_MFA'))).toEqual(OK);
  });

  it('an explicit `undefined` option still means PASSWORD_MFA', async () => {
    const options = { minAssuranceForCritical: undefined };
    expect(await get(issued(at(-1_000), 'PASSWORD_REAUTH'), '/critical', options)).toEqual(STEP_UP);
    expect(await get(issued(at(-1_000), 'PASSWORD_MFA'), '/critical', options)).toEqual(OK);
  });

  it('only an explicit test-time override relaxes it, and it still requires a fresh step-up', async () => {
    const options = { minAssuranceForCritical: 'PASSWORD_REAUTH' } as const;
    expect(await get(issued(at(-1_000), 'PASSWORD_REAUTH'), '/critical', options)).toEqual(OK);
    expect(await get(issued(at(-1_000), 'PASSWORD'), '/critical', options)).toEqual(STEP_UP);
    expect(await get(issued(null, 'PASSWORD_REAUTH'), '/critical', options)).toEqual(STEP_UP);
  });
});

describe('fail closed on malformed assurance data that bypassed the issuer', () => {
  it('a stepUpAt that is not a real, valid Date is refused (no coercion, no look-alikes)', async () => {
    const malformed: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['ISO string', new Date(NOW - 1_000).toISOString()],
      ['numeric timestamp', NOW - 1_000],
      ['numeric string', String(NOW - 1_000)],
      ['Invalid Date', new Date(Number.NaN)],
      ['plain object with getTime', { getTime: () => NOW - 1_000 }],
      ['true', true],
      ['empty object', {}],
      // instanceof Date, but its real time is invalid while an own getTime claims a fresh one
      [
        'Invalid Date with own getTime',
        Object.assign(new Date(Number.NaN), { getTime: () => NOW }),
      ],
      // a real but long-expired Date whose own getTime claims "now": the real time must decide
      ['expired Date with own getTime', Object.assign(at(-10 * 3_600_000), { getTime: () => NOW })],
    ];
    for (const [label, stepUpAt] of malformed) {
      expect(await get(bypassed({ stepUpAt })), label).toEqual(STEP_UP);
    }
  });

  it('an authStrength that is not exactly a recognized level is refused, even with a fresh step-up', async () => {
    const unrecognized: unknown[] = [
      undefined,
      null,
      'ROOT',
      'password_mfa',
      'PASSWORD_MFA ',
      '',
      5,
      ['PASSWORD_MFA'],
      'constructor',
      '__proto__',
      'toString',
    ];
    for (const authStrength of unrecognized) {
      const ctx = bypassed({ stepUpAt: at(-1_000), authStrength });
      expect(await get(ctx), String(authStrength)).toEqual(STEP_UP);
      // and it cannot satisfy a relaxed minimum either
      expect(
        await get(ctx, '/critical', { minAssuranceForCritical: 'PASSWORD' }),
        `${String(authStrength)} vs PASSWORD`,
      ).toEqual(STEP_UP);
    }
  });

  it('a malformed configured minimum, clock or maximum age is refused rather than treated as satisfied', async () => {
    const ctx = issued(at(-1_000), 'PASSWORD_MFA');
    expect(await get(ctx, '/critical', { minAssuranceForCritical: 'GOD' as never })).toEqual(
      STEP_UP,
    );
    expect(
      await get(ctx, '/critical', { minAssuranceForCritical: 'constructor' as never }),
    ).toEqual(STEP_UP);
    expect(await get(ctx, '/critical', { now: () => Number.NaN })).toEqual(STEP_UP);
    expect(await get(ctx, '/critical', { stepUpMaxAgeMs: Number.NaN })).toEqual(STEP_UP);
    expect(await get(ctx, '/critical', { stepUpMaxAgeMs: Number.POSITIVE_INFINITY })).toEqual(
      STEP_UP,
    );
    // control: the same context passes with sane settings
    expect(await get(ctx)).toEqual(OK);
  });
});
