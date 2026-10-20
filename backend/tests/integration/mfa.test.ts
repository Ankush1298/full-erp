import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { hotp, totpStep } from '../../src/modules/auth/mfa/totp.js';
import { issueFirstAdminBootstrapTicket } from '../../src/shared/authorization/mfa-bootstrap.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { loggerOptions } from '../../src/shared/logging/logger-options.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, runAs } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// TOTP MFA end to end (migration 0030, docs/architecture/v3/23-mfa.md) over HTTP against the shared DISPOSABLE integration
// database. Everything commits, so it runs in PRIVATE tenants (never ORG_A/ORG_B, whose users other files sign in as).
// The step-up clock is real; only the TOTP clock is advanced, one 30-second step at a time, to produce fresh codes.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 14 }));
const MFA_KEYS = {
  MFA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
  MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
};
const big = (): FixedWindowLimiter =>
  new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 10_000 });

let totpOffset = 0;
const totpNow = (): number => Date.now() + totpOffset;
const logLines: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _enc, cb) {
    logLines.push(chunk.toString());
    cb();
  },
});

const config = loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN, ...MFA_KEYS });
const app = buildApp({
  config,
  db,
  logger: { ...loggerOptions('trace'), stream: logStream },
  stepUpLimiter: big(),
  mfaLimiter: big(),
  totpClock: totpNow,
});

let passwordHash: string;
let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Session = { cookie: string; csrf: string };

async function login(address: string, target = app): Promise<Session> {
  const r = await target.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: address, password: PASSWORD },
  });
  expect(r.statusCode, address).toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

const call = (
  s: Session | null,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  payload?: unknown,
  target = app,
) =>
  target.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    cookies: s ? { session_token: s.cookie } : {},
    headers: { origin: APP_ORIGIN, ...(s ? { 'x-csrf-token': s.csrf } : {}) },
  });
const codeOf = (r: { json: <T>() => T }): string | undefined =>
  r.json<{ error?: { code?: string } }>().error?.code;

function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** A code for the CURRENT TOTP step after moving the TOTP clock one step forward (so it was never used). */
const freshCode = (seed: Buffer): string => {
  totpOffset += 30_000;
  return hotp(seed, totpStep(totpNow()));
};
const currentCode = (seed: Buffer): string => hotp(seed, totpStep(totpNow()));

const stepUpPassword = async (s: Session): Promise<void> => {
  const r = await call(s, 'POST', '/auth/step-up', { password: PASSWORD });
  expect(r.statusCode).toBe(200);
};

async function createTicket(
  tenant: IsolatedTenant,
  targetUserId: string,
  createdByUserId: string | null = null,
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.mfa_enrollment_tickets
       (id, organization_id, user_id, code_hash, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + interval '24 hours')`,
    [id, tenant.orgId, targetUserId, hash, createdByUserId],
  );
  return token;
}

/** Full enrollment for a fresh session of `address`; returns the session (now MFA-verified), seed and recovery codes. */
async function enroll(
  address: string,
  ticket?: string,
): Promise<{ s: Session; seed: Buffer; codes: string[] }> {
  const s = await login(address);
  await stepUpPassword(s);
  let effectiveTicket = ticket;
  if (!effectiveTicket) {
    const tenant = T && Object.values(T.emails).includes(address) ? T : OTHER;
    if (tenant) {
      const userEntry = Object.entries(tenant.emails).find(([, email]) => email === address);
      if (userEntry) {
        const userKey = userEntry[0] as keyof typeof tenant.users;
        const userId = tenant.users[userKey];
        if (['admin', 'campusAdmin', 'hod', 'registrarOrg', 'registrarCampus'].includes(userKey)) {
          effectiveTicket = await createTicket(tenant, userId);
        }
      }
    }
  }
  const start = await call(
    s,
    'POST',
    '/me/mfa/totp/enroll',
    effectiveTicket ? { ticket: effectiveTicket } : undefined,
  );
  expect(start.statusCode, start.body).toBe(201);
  const seed = base32Decode(start.json<{ data: { secret: string } }>().data.secret);
  const confirm = await call(s, 'POST', '/me/mfa/totp/verify', { code: freshCode(seed) });
  expect(confirm.statusCode, confirm.body).toBe(200);
  return {
    s,
    seed,
    codes: confirm.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes,
  };
}

const auditsOf = (org: string, actions: string[]) =>
  adminQuery<{
    action: string;
    actor_user_id: string;
    resource_id: string | null;
    risk_tier: number;
    metadata: Record<string, unknown> | null;
    reason_text: string | null;
    reason_code: string | null;
  }>(
    `SELECT action, actor_user_id, resource_id, risk_tier, metadata, reason_text, reason_code
       FROM app.audit_events WHERE organization_id = $1 AND action = ANY($2::text[]) ORDER BY occurred_at, id`,
    [org, actions],
  );
const factorsOf = (org: string, user: string) =>
  adminQuery<{
    id: string;
    status: string;
    secret_enc: Buffer;
    secret_key_label: string;
    revoked_reason: string | null;
    last_used_step: string | null;
    verified_enrollment: boolean;
  }>(
    `SELECT id, status, secret_enc, secret_key_label, revoked_reason, last_used_step, verified_enrollment
       FROM app.user_mfa_factors WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at, id`,
    [org, user],
  );
const codesOf = (org: string, user: string) =>
  adminQuery<{ code_hash: string; used_at: Date | null; revoked_at: Date | null }>(
    `SELECT code_hash, used_at, revoked_at FROM app.user_recovery_codes
      WHERE organization_id = $1 AND user_id = $2 ORDER BY created_at, id`,
    [org, user],
  );

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(passwordHash);
  OTHER = await createIsolatedTenant(passwordHash);
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await T.cleanup();
  await OTHER.cleanup();
});

describe('MFA-required roles: a session without a verified second factor has no administrative capability', () => {
  it('HOD/admin/registrar: admin routes are 403 MFA_REQUIRED (audited); own session and own MFA status still work', async () => {
    for (const who of ['hod', 'admin', 'registrarOrg', 'campusAdmin'] as const) {
      const s = await login(T.emails[who]);
      const r = await call(s, 'GET', '/api/v1/organization/campuses');
      expect([r.statusCode, codeOf(r)], who).toEqual([403, 'MFA_REQUIRED']);
      expect((await call(s, 'GET', '/auth/me')).statusCode, who).toBe(200);
      const st = await call(s, 'GET', '/me/mfa');
      expect(st.statusCode).toBe(200);
      expect(st.json<{ data: Record<string, unknown> }>().data).toMatchObject({
        enrolled: false,
        required: true,
        sessionVerified: false,
      });
    }
    const denied = await auditsOf(T.orgId, ['auth.authorization_denied']);
    expect(denied.filter((a) => a.reason_code === 'MFA_REQUIRED').length).toBeGreaterThanOrEqual(4);
  });

  it('password re-authentication is not MFA: still MFA_REQUIRED after POST /auth/step-up', async () => {
    const s = await login(T.emails.registrarCampus);
    await stepUpPassword(s);
    const r = await call(s, 'GET', '/api/v1/organization/campuses');
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'MFA_REQUIRED']);
  });

  it('roles outside the policy (faculty, student) are not restricted', async () => {
    for (const who of ['faculty', 'studentOne'] as const) {
      const s = await login(T.emails[who]);
      expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode, who).toBe(200);
    }
  });
});

describe('enrollment (first factor = controlled bootstrap)', () => {
  it('requires a fresh password step-up on THIS session; returns the secret once (no-store) and stores only ciphertext', async () => {
    const s = await login(T.emails.hod);
    const blocked = await call(s, 'POST', '/me/mfa/totp/enroll');
    expect([blocked.statusCode, codeOf(blocked)]).toEqual([403, 'STEP_UP_REQUIRED']);

    await stepUpPassword(s);
    const noTicket = await call(s, 'POST', '/me/mfa/totp/enroll');
    expect([noTicket.statusCode, codeOf(noTicket)]).toEqual([403, 'MFA_TICKET_REQUIRED']);

    const ticket = await createTicket(T, T.users.hod, T.users.admin);
    const r = await call(s, 'POST', '/me/mfa/totp/enroll', { ticket });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const data = r.json<{
      data: {
        secret: string;
        otpauthUri: string;
        digits: number;
        period: number;
        factorId: string;
      };
    }>().data;
    expect(data.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(new URL(data.otpauthUri).searchParams.get('secret')).toBe(data.secret);
    expect([data.digits, data.period]).toEqual([6, 30]);
    const seed = base32Decode(data.secret);

    const rows = await factorsOf(T.orgId, T.users.hod);
    const pending = rows.find((f) => f.id === data.factorId)!;
    expect(pending.status).toBe('PENDING');
    expect(pending.secret_key_label).toBe('k1');
    expect(pending.secret_enc.includes(seed)).toBe(false);
    expect(pending.secret_enc.toString('hex')).not.toContain(seed.toString('hex'));

    // status never returns the secret
    const st = await call(s, 'GET', '/me/mfa');
    expect(st.body).not.toContain(data.secret);
    expect(st.json<{ data: { pendingEnrollment: boolean } }>().data.pendingEnrollment).toBe(true);

    // confirmation only from the session that started it
    const other = await login(T.emails.hod);
    const wrongSession = await call(other, 'POST', '/me/mfa/totp/verify', {
      code: currentCode(seed),
    });
    expect([wrongSession.statusCode, codeOf(wrongSession)]).toEqual([
      409,
      'MFA_ENROLLMENT_NOT_FOUND',
    ]);

    // a wrong code: generic 401, the shared failure counter moves, audited, factor stays PENDING
    const before = await adminQuery<{ n: number }>(
      'SELECT failed_login_count AS n FROM platform.identities WHERE id = $1',
      [T.users.hod],
    );
    const bad = String((Number(currentCode(seed)) + 500_000) % 1_000_000).padStart(6, '0');
    const wrong = await call(s, 'POST', '/me/mfa/totp/verify', { code: bad });
    expect([wrong.statusCode, codeOf(wrong)]).toEqual([401, 'INVALID_CREDENTIALS']);
    const after = await adminQuery<{ n: number }>(
      'SELECT failed_login_count AS n FROM platform.identities WHERE id = $1',
      [T.users.hod],
    );
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    expect(
      (await factorsOf(T.orgId, T.users.hod)).find((f) => f.id === data.factorId)!.status,
    ).toBe('PENDING');

    // malformed codes never reach the service (a JSON number is coerced to a string by Fastify's default AJV options, so it
    // is just another wrong code)
    for (const code of ['12345', '1234567', 'abcdef', '12 456', null]) {
      expect((await call(s, 'POST', '/me/mfa/totp/verify', { code })).statusCode).toBe(400);
    }

    // the right code activates, issues exactly 10 one-time codes (hashes only) and verifies THIS session
    const ok = await call(s, 'POST', '/me/mfa/totp/verify', { code: freshCode(seed) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const out = ok.json<{ data: { recoveryCodes: string[]; step: { authStrength: string } } }>()
      .data;
    expect(out.recoveryCodes).toHaveLength(10);
    expect(new Set(out.recoveryCodes).size).toBe(10);
    expect(out.step.authStrength).toBe('PASSWORD_MFA');
    const stored = await codesOf(T.orgId, T.users.hod);
    expect(stored.filter((c) => !c.used_at && !c.revoked_at)).toHaveLength(10);
    for (const c of stored) {
      for (const code of out.recoveryCodes) {
        expect(c.code_hash).not.toContain(code.replace(/-/g, '').toLowerCase());
      }
    }
    expect(
      (await factorsOf(T.orgId, T.users.hod)).filter((f) => f.status === 'ACTIVE'),
    ).toHaveLength(1);
    expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode).toBe(200);
    // the other session is still restricted: verification is per session
    const r2 = await call(other, 'GET', '/api/v1/organization/campuses');
    expect(codeOf(r2)).toBe('MFA_REQUIRED');
    // codes are never shown again
    const st2 = await call(s, 'GET', '/me/mfa');
    for (const code of out.recoveryCodes) expect(st2.body).not.toContain(code);
    expect(
      st2.json<{ data: { unusedRecoveryCodes: number; enrolled: boolean } }>().data,
    ).toMatchObject({
      enrolled: true,
      unusedRecoveryCodes: 10,
    });
  });

  it('concurrent first activations: exactly one ACTIVE factor (the database decides, not a count)', async () => {
    const ticket = await createTicket(T, T.users.registrarOrg, T.users.admin);
    const s = await login(T.emails.registrarOrg);
    await stepUpPassword(s);
    const start = await call(s, 'POST', '/me/mfa/totp/enroll', { ticket });
    const seed = base32Decode(start.json<{ data: { secret: string } }>().data.secret);
    const code = freshCode(seed);
    const results = await Promise.all([
      call(s, 'POST', '/me/mfa/totp/verify', { code }),
      call(s, 'POST', '/me/mfa/totp/verify', { code }),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(
      (await factorsOf(T.orgId, T.users.registrarOrg)).filter((f) => f.status === 'ACTIVE'),
    ).toHaveLength(1);
  });

  it('a started enrollment can be cancelled; an expired one cannot be confirmed', async () => {
    const s = await login(T.emails.studentTwo);
    await stepUpPassword(s);
    const a = await call(s, 'POST', '/me/mfa/totp/enroll');
    const seedA = base32Decode(a.json<{ data: { secret: string } }>().data.secret);
    expect((await call(s, 'DELETE', '/me/mfa/totp/enroll')).statusCode).toBe(200);
    const afterCancel = await call(s, 'POST', '/me/mfa/totp/verify', { code: freshCode(seedA) });
    expect(codeOf(afterCancel)).toBe('MFA_ENROLLMENT_NOT_FOUND');

    const b = await call(s, 'POST', '/me/mfa/totp/enroll');
    const { factorId, secret } = b.json<{ data: { factorId: string; secret: string } }>().data;
    // Test-only time travel of ONE pending row: the lifecycle trigger (rightly) forbids moving pending_expires_at, so the
    // harness bypasses triggers for this single statement on the disposable database.
    await adminQuery(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE app.user_mfa_factors SET pending_expires_at = now() - interval '1 second' WHERE id = '${factorId}';
      COMMIT;`);
    const expired = await call(s, 'POST', '/me/mfa/totp/verify', {
      code: freshCode(base32Decode(secret)),
    });
    expect(codeOf(expired)).toBe('MFA_ENROLLMENT_NOT_FOUND');
    expect((await factorsOf(T.orgId, T.users.studentTwo)).map((f) => f.status)).toEqual([
      'REVOKED',
      'PENDING',
    ]);
  });
});

describe('POST /auth/mfa/challenge: TOTP and recovery codes', () => {
  let hodSeed!: Buffer;
  let hodCodes!: string[];

  beforeAll(async () => {
    const e = await enroll(T.emails.campusAdmin);
    campusAdminSeed = e.seed;
    hodSeed = e.seed;
    hodCodes = e.codes;
  });

  it('a fresh TOTP code verifies a new session (PASSWORD_MFA); the same time step is never accepted twice', async () => {
    const s = await login(T.emails.campusAdmin);
    expect(codeOf(await call(s, 'GET', '/api/v1/organization/campuses'))).toBe('MFA_REQUIRED');
    const code = freshCode(hodSeed);
    const ok = await call(s, 'POST', '/auth/mfa/challenge', { code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ data: { authStrength: string; method: string } }>().data).toMatchObject({
      authStrength: 'PASSWORD_MFA',
      method: 'TOTP',
    });
    expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode).toBe(200);

    // replay of the same code, from this or any other session of the same user
    const s2 = await login(T.emails.campusAdmin);
    for (const who of [s, s2]) {
      const replay = await call(who, 'POST', '/auth/mfa/challenge', { code });
      expect([replay.statusCode, codeOf(replay)]).toEqual([401, 'INVALID_CREDENTIALS']);
    }
    // concurrent use of one fresh code: exactly one wins
    const c2 = freshCode(hodSeed);
    const both = await Promise.all([
      call(s2, 'POST', '/auth/mfa/challenge', { code: c2 }),
      call(s2, 'POST', '/auth/mfa/challenge', { code: c2 }),
    ]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('a code of the step BEFORE the last accepted one is refused even inside the skew window', async () => {
    const s = await login(T.emails.campusAdmin);
    const step = totpStep(totpNow());
    const ok = await call(s, 'POST', '/auth/mfa/challenge', { code: freshCode(hodSeed) });
    expect(ok.statusCode).toBe(200);
    const older = hotp(hodSeed, step); // one step older than the accepted code, still within +/- 1
    expect((await call(s, 'POST', '/auth/mfa/challenge', { code: older })).statusCode).toBe(401);
  });

  it('recovery codes: one use each (atomically, also under concurrency), normalised input, audited with the remaining count', async () => {
    const s = await login(T.emails.campusAdmin);
    const ok = await call(s, 'POST', '/auth/mfa/challenge', { recoveryCode: hodCodes[0] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ data: { method: string } }>().data.method).toBe('RECOVERY_CODE');
    expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode).toBe(200);

    const s2 = await login(T.emails.campusAdmin);
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { recoveryCode: hodCodes[0] })).statusCode,
    ).toBe(401);
    // lower case without hyphens is the same code
    const variant = hodCodes[1]!.replace(/-/g, '').toLowerCase();
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { recoveryCode: variant })).statusCode,
    ).toBe(200);
    const s3 = await login(T.emails.campusAdmin);
    const race = await Promise.all([
      call(s3, 'POST', '/auth/mfa/challenge', { recoveryCode: hodCodes[2] }),
      call(s3, 'POST', '/auth/mfa/challenge', { recoveryCode: hodCodes[2] }),
    ]);
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const left = (await codesOf(T.orgId, T.users.campusAdmin)).filter(
      (c) => !c.used_at && !c.revoked_at,
    );
    expect(left).toHaveLength(7);
    const audits = await auditsOf(T.orgId, ['auth.mfa.challenge']);
    const last = audits.filter((a) => a.actor_user_id === T.users.campusAdmin).at(-1)!;
    expect(last.metadata).toEqual({ method: 'RECOVERY_CODE', unusedCodes: 7 });
  });

  it('exactly one of code / recoveryCode; garbage and other users codes are refused with the same 401', async () => {
    const s = await login(T.emails.campusAdmin);
    expect((await call(s, 'POST', '/auth/mfa/challenge', {})).statusCode).toBe(400);
    expect(
      (
        await call(s, 'POST', '/auth/mfa/challenge', {
          code: '123456',
          recoveryCode: hodCodes[3],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call(s, 'POST', '/auth/mfa/challenge', { userId: T.users.hod, code: '123456' }))
        .statusCode,
    ).toBe(400); // no user can be named
    for (const recoveryCode of ['not-a-code', 'AAAAA-AAAAA-AAAAA-AAAAA']) {
      const r = await call(s, 'POST', '/auth/mfa/challenge', { recoveryCode });
      expect([r.statusCode, codeOf(r)]).toEqual([401, 'INVALID_CREDENTIALS']);
    }
  });

  it('regeneration needs a fresh PASSWORD_MFA step-up and invalidates every earlier unused code', async () => {
    const s = await login(T.emails.campusAdmin);
    await stepUpPassword(s);
    const blocked = await call(s, 'POST', '/me/mfa/recovery-codes/regenerate');
    // the session is not MFA-verified yet, so the route itself is still open (auth.mfa.manage) but the service refuses
    expect([blocked.statusCode, codeOf(blocked)]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(
      (await call(s, 'POST', '/auth/mfa/challenge', { code: freshCode(hodSeed) })).statusCode,
    ).toBe(200);
    const r = await call(s, 'POST', '/me/mfa/recovery-codes/regenerate');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const fresh = r.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes;
    expect(fresh).toHaveLength(10);
    const s2 = await login(T.emails.campusAdmin);
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { recoveryCode: hodCodes[5] })).statusCode,
    ).toBe(401);
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { recoveryCode: fresh[0] })).statusCode,
    ).toBe(200);
  });

  it('a user without an enrolled factor cannot challenge', async () => {
    const s = await login(T.emails.faculty);
    const r = await call(s, 'POST', '/auth/mfa/challenge', { code: '123456' });
    expect([r.statusCode, codeOf(r)]).toEqual([409, 'MFA_NOT_ENROLLED']);
  });
});

let adminSeed!: Buffer;
let campusAdminSeed!: Buffer;

describe('CRITICAL operations', () => {
  it('password step-up alone stays 403 STEP_UP_REQUIRED; a verified TOTP establishes PASSWORD_MFA and satisfies the threshold', async () => {
    const { seed } = await enroll(T.emails.admin);
    adminSeed = seed;
    // a NEW session of the same admin: MFA first
    const s2 = await login(T.emails.admin);
    const body = { reason: 'Lost authenticator, identity verified in person' };
    const restricted = await call(s2, 'POST', `/api/v1/users/${T.users.faculty}/mfa/reset`, body);
    expect(codeOf(restricted)).toBe('MFA_REQUIRED');
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { code: freshCode(seed) })).statusCode,
    ).toBe(200);
    // simulate the MFA step-up window having passed, then re-authenticate with the PASSWORD only
    await adminQuery(
      `UPDATE platform.auth_sessions SET step_up_at = now() - interval '11 minutes'
        WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [s2.cookie],
    );
    await stepUpPassword(s2);
    const reauthOnly = await call(s2, 'POST', `/api/v1/users/${T.users.faculty}/mfa/reset`, body);
    expect([reauthOnly.statusCode, codeOf(reauthOnly)]).toEqual([403, 'STEP_UP_REQUIRED']);
    // a fresh TOTP challenge: PASSWORD_MFA, the CRITICAL action is allowed
    expect(
      (await call(s2, 'POST', '/auth/mfa/challenge', { code: freshCode(seed) })).statusCode,
    ).toBe(200);
    const ok = await call(s2, 'POST', `/api/v1/users/${T.users.faculty}/mfa/reset`, body);
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('disable and administrative reset', () => {
  it('a user in an MFA-required role can never disable MFA themselves', async () => {
    const s = await login(T.emails.campusAdmin);
    const r = await call(s, 'DELETE', '/me/mfa/totp');
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'MFA_DISABLE_FORBIDDEN']);
    expect(
      (await factorsOf(T.orgId, T.users.campusAdmin)).filter((f) => f.status === 'ACTIVE'),
    ).toHaveLength(1);
  });

  it('a user outside those roles may disable with a fresh PASSWORD_MFA step-up; every session loses its MFA assurance', async () => {
    const { s, seed } = await enroll(T.emails.studentOne);
    const other = await login(T.emails.studentOne);
    expect(
      (await call(other, 'POST', '/auth/mfa/challenge', { code: freshCode(seed) })).statusCode,
    ).toBe(200);
    const r = await call(s, 'DELETE', '/me/mfa/totp');
    expect(r.statusCode, r.body).toBe(200);
    expect((await factorsOf(T.orgId, T.users.studentOne)).map((f) => f.status)).toEqual([
      'REVOKED',
    ]);
    expect(
      (await codesOf(T.orgId, T.users.studentOne)).filter((c) => !c.used_at && !c.revoked_at),
    ).toHaveLength(0);
    const sessions = await adminQuery<{ m: Date | null; a: string }>(
      `SELECT mfa_verified_at AS m, auth_strength AS a FROM platform.auth_sessions
        WHERE identity_id = $1 AND revoked_at IS NULL`,
      [T.users.studentOne],
    );
    for (const row of sessions) expect([row.m, row.a]).toEqual([null, 'PASSWORD']);
  });

  it('admin reset: CRITICAL + reason; never yourself; revokes factor, codes and every session of the target; tier-3 audit', async () => {
    // the hod enrolled in the enrollment suite
    const hodSession = await login(T.emails.hod);
    const admin = await login(T.emails.admin); // enrolled in the CRITICAL suite
    expect(
      (await call(admin, 'POST', '/auth/mfa/challenge', { code: freshCode(adminSeed) })).statusCode,
    ).toBe(200);
    const self = await call(admin, 'POST', `/api/v1/users/${T.users.admin}/mfa/reset`, {
      reason: 'Trying to reset my own factor',
    });
    expect([self.statusCode, codeOf(self)]).toEqual([403, 'FORBIDDEN']);
    const noReason = await call(admin, 'POST', `/api/v1/users/${T.users.hod}/mfa/reset`, {});
    expect(noReason.statusCode).toBe(400);

    const r = await call(admin, 'POST', `/api/v1/users/${T.users.hod}/mfa/reset`, {
      reason: 'Lost phone, identity verified by the registrar',
    });
    expect(r.statusCode, r.body).toBe(200);
    const data = r.json<{ data: Record<string, number> }>().data;
    expect(data.factorsRevoked).toBeGreaterThanOrEqual(1);
    expect(data.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(r.body).not.toMatch(/secret|otpauth/i);
    expect((await factorsOf(T.orgId, T.users.hod)).filter((f) => f.status !== 'REVOKED')).toEqual(
      [],
    );
    expect(
      (await factorsOf(T.orgId, T.users.hod)).some((f) => f.revoked_reason === 'ADMIN_RESET'),
    ).toBe(true);
    expect(
      (await codesOf(T.orgId, T.users.hod)).filter((c) => !c.used_at && !c.revoked_at),
    ).toHaveLength(0);
    expect((await call(hodSession, 'GET', '/auth/me')).statusCode).toBe(401); // signed out everywhere
    const audit = (await auditsOf(T.orgId, ['auth.mfa.admin_reset'])).at(-1)!;
    expect(audit).toMatchObject({
      actor_user_id: T.users.admin,
      resource_id: T.users.hod,
      risk_tier: 3,
      reason_text: 'Lost phone, identity verified by the registrar',
    });
    // the administrator gained nothing for the target: the target re-enrolls with their own password
    const again = await login(T.emails.hod);
    expect(codeOf(await call(again, 'GET', '/api/v1/organization/campuses'))).toBe('MFA_REQUIRED');
    expect(
      (await call(again, 'GET', '/me/mfa')).json<{ data: { enrolled: boolean } }>().data.enrolled,
    ).toBe(false);
  });

  it('a campus admin cannot reset (organization scope only, and grant rules); another tenant cannot reach the user', async () => {
    // CAMPUS_ADMIN of T, MFA-verified with a fresh PASSWORD_MFA step-up
    const ca = await login(T.emails.campusAdmin);
    const seedRow = await factorsOf(T.orgId, T.users.campusAdmin);
    expect(seedRow.some((f) => f.status === 'ACTIVE')).toBe(true);
    await adminQuery(
      `UPDATE platform.auth_sessions SET mfa_verified_at = now(), step_up_at = now(), auth_strength = 'PASSWORD_MFA'
        WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [ca.cookie],
    );
    const r = await call(ca, 'POST', `/api/v1/users/${T.users.admin}/mfa/reset`, {
      reason: 'Escalation attempt by a campus admin',
    });
    expect([r.statusCode, codeOf(r)]).toEqual([403, 'FORBIDDEN']);

    const { s: otherAdmin, seed } = await enroll(OTHER.emails.admin);
    expect(
      (await call(otherAdmin, 'POST', '/auth/mfa/challenge', { code: freshCode(seed) })).statusCode,
    ).toBe(200);
    const cross = await call(otherAdmin, 'POST', `/api/v1/users/${T.users.campusAdmin}/mfa/reset`, {
      reason: 'Cross tenant attempt',
    });
    expect([cross.statusCode, codeOf(cross)]).toEqual([404, 'RESOURCE_NOT_FOUND']);
    expect(
      (await factorsOf(T.orgId, T.users.campusAdmin)).filter((f) => f.status === 'ACTIVE'),
    ).toHaveLength(1);
  });
});

describe('role changes take effect on the next request', () => {
  it('a faculty member granted HOD is restricted at once until a second factor is verified', async () => {
    const s = await login(T.emails.faculty);
    expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode).toBe(200);
    const id = (
      await adminQuery<{ id: string }>(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
         SELECT $4::uuid, $1::uuid, $2::uuid, r.id, 'DEPARTMENT', $3::uuid, NULL, $3::uuid FROM app.roles r
          WHERE r.organization_id = $1::uuid AND r.code = 'HOD' RETURNING id`,
        [T.orgId, T.users.faculty, T.departmentId, uuidv7()],
      )
    )[0]!.id;
    expect(codeOf(await call(s, 'GET', '/api/v1/organization/campuses'))).toBe('MFA_REQUIRED');
    await adminQuery(`UPDATE app.role_assignments SET status = 'REVOKED' WHERE id = $1`, [id]);
    expect((await call(s, 'GET', '/api/v1/organization/campuses')).statusCode).toBe(200);
  });
});

describe('rate limiting, unavailable encryption and secret hygiene', () => {
  it('code guesses are budgeted per session, user and IP (429 with Retry-After)', async () => {
    const tight = buildApp({
      config,
      db,
      logger: false,
      mfaLimiter: new FixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100 }),
      totpClock: totpNow,
    });
    await tight.ready();
    try {
      const s = await login(T.emails.campusAdmin, tight);
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await call(s, 'POST', '/auth/mfa/challenge', { code: '000000' }, tight);
        codes.push(r.statusCode);
        if (r.statusCode === 429) expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(codes).toEqual([401, 401, 429]);
    } finally {
      await tight.close();
    }
  });

  it('without a configured keyring MFA enrollment is 503 MFA_UNAVAILABLE (never plaintext, never another key)', async () => {
    const bare = buildApp({
      config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
      db,
      logger: false,
    });
    await bare.ready();
    try {
      const s = await login(T.emails.faculty, bare);
      await call(s, 'POST', '/auth/step-up', { password: PASSWORD }, bare);
      const r = await call(s, 'POST', '/me/mfa/totp/enroll', undefined, bare);
      expect([r.statusCode, codeOf(r)]).toEqual([503, 'MFA_UNAVAILABLE']);
    } finally {
      await bare.close();
    }
  });

  it('no secret, provisioning URI or recovery code reaches the logs or the audit trail', async () => {
    const ticket = await createTicket(T, T.users.registrarCampus, T.users.admin);
    const s = await login(T.emails.registrarCampus);
    await stepUpPassword(s);
    const start = await call(s, 'POST', '/me/mfa/totp/enroll', { ticket });
    expect(start.statusCode, start.body).toBe(201);
    const { secret, otpauthUri } = start.json<{ data: { secret: string; otpauthUri: string } }>()
      .data;
    const ok = await call(s, 'POST', '/me/mfa/totp/verify', {
      code: freshCode(base32Decode(secret)),
    });
    const codes = ok.json<{ data: { recoveryCodes: string[] } }>().data.recoveryCodes;
    const logs = logLines.join('\n');
    const audits = JSON.stringify(
      await adminQuery(`SELECT * FROM app.audit_events WHERE organization_id = $1`, [T.orgId]),
    );
    for (const needle of [secret, otpauthUri, ...codes, ...codes.map((c) => c.replace(/-/g, ''))]) {
      expect(logs).not.toContain(needle);
      expect(audits).not.toContain(needle);
    }
  });

  it('enrollment tickets: issuance with PASSWORD_MFA, scoping, consumption, and promotion assurance invalidation', async () => {
    // 1. Unprivileged user cannot issue tickets
    const fac = await login(T.emails.faculty);
    const deniedFac = await call(
      fac,
      'POST',
      `/api/v1/users/${T.users.studentOne}/mfa/enrollment-ticket`,
      { reason: 'Attempt by faculty without reset permission' },
    );
    expect(deniedFac.statusCode).toBe(403);

    // 2. Admin with fresh PASSWORD_MFA
    const adminS = await login(T.emails.admin);
    expect(
      (await call(adminS, 'POST', '/auth/mfa/challenge', { code: freshCode(adminSeed) }))
        .statusCode,
    ).toBe(200);

    // Cannot issue ticket for oneself
    const selfIssue = await call(
      adminS,
      'POST',
      `/api/v1/users/${T.users.admin}/mfa/enrollment-ticket`,
      { reason: 'Self ticket issuance attempt' },
    );
    expect(selfIssue.statusCode).toBe(403);

    // CAMPUS_ADMIN cannot issue ticket for COLLEGE_ADMIN (mayActOnAllRolesOf)
    const campusAdminS = await login(T.emails.campusAdmin);
    expect(
      (
        await call(campusAdminS, 'POST', '/auth/mfa/challenge', {
          code: freshCode(campusAdminSeed),
        })
      ).statusCode,
    ).toBe(200);
    const deniedEscalation = await call(
      campusAdminS,
      'POST',
      `/api/v1/users/${T.users.admin}/mfa/enrollment-ticket`,
      { reason: 'Campus admin attempting to reset college admin' },
    );
    expect(deniedEscalation.statusCode).toBe(403);

    // Admin successfully issues ticket for HOD
    const issued = await call(
      adminS,
      'POST',
      `/api/v1/users/${T.users.hod}/mfa/enrollment-ticket`,
      { reason: 'Legitimate ticket issuance for new HOD enrollment' },
    );
    expect(issued.statusCode).toBe(201);
    const { ticketId, ticket, expiresAt } = issued.json<{
      data: { ticketId: string; ticket: string; expiresAt: string };
    }>().data;
    expect(ticketId).toBeDefined();
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Check audit
    const ticketAudits = await auditsOf(T.orgId, ['auth.mfa.enrollment_ticket_issue']);
    expect(ticketAudits.length).toBeGreaterThan(0);
    const lastAudit = ticketAudits[ticketAudits.length - 1]!;
    expect(lastAudit.resource_id).toBe(T.users.hod);
    expect(lastAudit.risk_tier).toBe(3);
    expect(lastAudit.reason_text).toBe('Legitimate ticket issuance for new HOD enrollment');
    expect(lastAudit.metadata).toEqual({ ticketId, expiresAt });

    // HOD enrolls with the issued ticket
    const hodSession = await login(T.emails.hod);
    await stepUpPassword(hodSession);

    // Invalid ticket fails
    const badTicket = await call(hodSession, 'POST', '/me/mfa/totp/enroll', {
      ticket: '0000000000000000000000000000000000000000000000000000000000000000',
    });
    expect([badTicket.statusCode, codeOf(badTicket)]).toEqual([401, 'INVALID_TICKET']);

    // Valid ticket starts enrollment and marks factor as verified
    const hodEnroll = await call(hodSession, 'POST', '/me/mfa/totp/enroll', { ticket });
    expect(hodEnroll.statusCode).toBe(201);
    const newHodSeed = base32Decode(hodEnroll.json<{ data: { secret: string } }>().data.secret);
    const hodConfirm = await call(hodSession, 'POST', '/me/mfa/totp/verify', {
      code: freshCode(newHodSeed),
    });
    expect(hodConfirm.statusCode).toBe(200);

    // Ticket is consumed and cannot be reused
    const reused = await call(hodSession, 'POST', '/me/mfa/totp/enroll', { ticket });
    expect([reused.statusCode, codeOf(reused)]).toEqual([401, 'INVALID_TICKET']);

    // 3. Role promotion invalidation:
    // Voluntary self-enrollment by studentOne (not MFA-required)
    const { s: studentSession, seed: studentSeed } = await enroll(T.emails.studentOne);
    // Student can challenge and get verified session
    const studentOk = await call(studentSession, 'POST', '/auth/mfa/challenge', {
      code: freshCode(studentSeed),
    });
    expect(studentOk.statusCode).toBe(200);

    // Check student's enrolled factor has verified_enrollment = false
    const studentFactors = await factorsOf(T.orgId, T.users.studentOne);
    const activeStudentFactor = studentFactors.find((f) => f.status === 'ACTIVE')!;
    expect(activeStudentFactor.verified_enrollment).toBe(false);
  });

  describe('first-administrator bootstrap (Issue 2)', () => {
    it('issues an auditable single-use bootstrap ticket for the initial COLLEGE_ADMIN, enrolls, and disables subsequent bootstrap', async () => {
      // 1. Create a brand new isolated tenant with only one administrator
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const adminUserId = freshTenant.users.admin;
        const adminEmail = freshTenant.emails.admin;

        const exec = {
          query: async (text: string, values?: readonly unknown[]) => ({
            rows: await adminQuery(text, values ?? []),
          }),
        };

        // 2. Issuing for non-existent org fails
        await expect(
          issueFirstAdminBootstrapTicket(exec, {
            organizationId: '018f0000-0000-7000-8000-000000000999',
            userId: adminUserId,
          }),
        ).rejects.toThrow('Active organization not found.');

        // 3. Issuing for non-COLLEGE_ADMIN (e.g. student) fails with 403
        await expect(
          issueFirstAdminBootstrapTicket(exec, {
            organizationId: freshTenant.orgId,
            userId: freshTenant.users.studentOne,
          }),
        ).rejects.toThrow('User does not hold an active COLLEGE_ADMIN role.');

        // 4. Successfully issue bootstrap ticket for the initial admin
        const bootstrap = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: adminUserId,
          reason: 'Operational onboarding of first college admin',
        });

        expect(bootstrap.ticketId).toBeDefined();
        expect(bootstrap.ticket).toMatch(/^[0-9a-f]{64}$/);
        expect(new Date(bootstrap.expiresAt).getTime()).toBeGreaterThan(Date.now());

        // 5. Verify audit trail was recorded (SYSTEM actor, risk tier 3)
        const bootstrapAudits = await adminQuery<{
          action: string;
          risk_tier: number;
          actor_type: string;
          resource_id: string;
          reason_text: string;
          metadata: { ticketId: string; expiresAt: string };
        }>(
          `SELECT action, risk_tier, actor_type, resource_id, reason_text, metadata
             FROM app.audit_events
            WHERE organization_id = $1 AND action = 'auth.mfa.bootstrap_ticket_issue'`,
          [freshTenant.orgId],
        );
        expect(bootstrapAudits).toHaveLength(1);
        expect(bootstrapAudits[0]!).toEqual({
          action: 'auth.mfa.bootstrap_ticket_issue',
          risk_tier: 3,
          actor_type: 'SYSTEM',
          resource_id: adminUserId,
          reason_text: 'Operational onboarding of first college admin',
          metadata: { ticketId: bootstrap.ticketId, expiresAt: bootstrap.expiresAt },
        });

        // 6. First administrator redeems the bootstrap ticket
        const s = await login(adminEmail);
        await stepUpPassword(s);

        const enrollRes = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: bootstrap.ticket,
        });
        expect(enrollRes.statusCode).toBe(201);
        const secret = base32Decode(enrollRes.json<{ data: { secret: string } }>().data.secret);

        const verifyRes = await call(s, 'POST', '/me/mfa/totp/verify', { code: freshCode(secret) });
        expect(verifyRes.statusCode).toBe(200);

        // Verify the factor is ACTIVE and verified_enrollment is true
        const factors = await factorsOf(freshTenant.orgId, adminUserId);
        const activeFactor = factors.find((f) => f.status === 'ACTIVE')!;
        expect(activeFactor.verified_enrollment).toBe(true);

        // Verify the ticket was consumed and cannot be reused
        const reuseRes = await call(s, 'POST', '/me/mfa/totp/enroll', { ticket: bootstrap.ticket });
        expect([reuseRes.statusCode, codeOf(reuseRes)]).toEqual([401, 'INVALID_TICKET']);

        // 7. Verify bootstrap is now DISABLED for this tenant because an active verified admin factor exists
        await expect(
          issueFirstAdminBootstrapTicket(exec, {
            organizationId: freshTenant.orgId,
            userId: adminUserId,
            reason: 'Attempted second bootstrap',
          }),
        ).rejects.toThrow('First-administrator bootstrap is disabled');
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('rejects bootstrap ticket redemption if ticket has expired', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const adminUserId = freshTenant.users.admin;
        const adminEmail = freshTenant.emails.admin;

        const exec = {
          query: async (text: string, values?: readonly unknown[]) => ({
            rows: await adminQuery(text, values ?? []),
          }),
        };

        const bootstrap = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: adminUserId,
        });

        // Manually age the ticket past 24 hours in the database using the test-only replica override
        await adminQuery(`BEGIN; SET LOCAL session_replication_role = replica;
          UPDATE app.mfa_enrollment_tickets
             SET created_at = now() - interval '25 hours',
                 expires_at = now() - interval '1 hour'
           WHERE id = '${bootstrap.ticketId}';
          COMMIT;`);

        const s = await login(adminEmail);
        await stepUpPassword(s);

        const enrollRes = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: bootstrap.ticket,
        });
        expect([enrollRes.statusCode, codeOf(enrollRes)]).toEqual([401, 'INVALID_TICKET']);
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('strictly forbids app_runtime from inserting bootstrap tickets with null created_by (RLS enforcement)', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const ticketId = uuidv7();
        const codeHash = createHash('sha256').update('arbitrary-token-value').digest('hex');
        const outcome = await runAs(
          { tenant: freshTenant.orgId, user: freshTenant.users.admin, kind: 'STAFF' },
          `INSERT INTO app.mfa_enrollment_tickets
             (id, organization_id, user_id, code_hash, created_by, created_at, expires_at)
           VALUES ($1, $2, $3, $4, NULL, now(), now() + interval '24 hours')`,
          [ticketId, freshTenant.orgId, freshTenant.users.admin, codeHash],
        );
        expect(outcome.error).toBeDefined();
        // 42501 = insufficient_privilege (row-level security violation)
        expect(outcome.error?.code).toBe('42501');
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('revokes prior unconsumed bootstrap tickets upon re-issuance and enforces the single-active-bootstrap index', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const adminUserId = freshTenant.users.admin;
        const adminEmail = freshTenant.emails.admin;

        const exec = {
          query: async (text: string, values?: readonly unknown[]) => ({
            rows: await adminQuery(text, values ?? []),
          }),
        };

        const firstTicket = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: adminUserId,
          reason: 'Initial ticket',
        });

        // Re-issuing for the tenant must succeed and revoke the first ticket
        const secondTicket = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: adminUserId,
          reason: 'Replacement ticket',
        });

        expect(secondTicket.ticketId).not.toBe(firstTicket.ticketId);

        // Check database: first ticket is revoked, second is active (unconsumed, unrevoked)
        const tickets = await adminQuery<{ id: string; revoked_at: Date | null }>(
          `SELECT id, revoked_at FROM app.mfa_enrollment_tickets
            WHERE organization_id = $1 AND created_by IS NULL
            ORDER BY created_at ASC`,
          [freshTenant.orgId],
        );
        expect(tickets).toHaveLength(2);
        expect(tickets[0]!.id).toBe(firstTicket.ticketId);
        expect(tickets[0]!.revoked_at).not.toBeNull();
        expect(tickets[1]!.id).toBe(secondTicket.ticketId);
        expect(tickets[1]!.revoked_at).toBeNull();

        // Redeeming first ticket fails
        const s = await login(adminEmail);
        await stepUpPassword(s);
        const failEnroll = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: firstTicket.ticket,
        });
        expect([failEnroll.statusCode, codeOf(failEnroll)]).toEqual([401, 'INVALID_TICKET']);

        // Redeeming second ticket succeeds
        const okEnroll = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: secondTicket.ticket,
        });
        expect(okEnroll.statusCode).toBe(201);
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('prevents redemption of a pre-issued bootstrap ticket once an administrator has verified MFA', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const adminUserId = freshTenant.users.admin;
        const adminEmail = freshTenant.emails.admin;

        const exec = {
          query: async (text: string, values?: readonly unknown[]) => ({
            rows: await adminQuery(text, values ?? []),
          }),
        };

        const bootstrap = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: adminUserId,
        });

        // Admin enrolls and completes MFA
        const s = await login(adminEmail);
        await stepUpPassword(s);
        const enrollRes = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: bootstrap.ticket,
        });
        expect(enrollRes.statusCode).toBe(201);
        const secret = base32Decode(enrollRes.json<{ data: { secret: string } }>().data.secret);
        const verifyRes = await call(s, 'POST', '/me/mfa/totp/verify', { code: freshCode(secret) });
        expect(verifyRes.statusCode).toBe(200);

        // Fabricate an unconsumed bootstrap ticket (as if issued concurrently before confirmation)
        const unconsumedBootstrapId = uuidv7();
        const unconsumedToken = randomBytes(32).toString('hex');
        const unconsumedHash = createHash('sha256').update(unconsumedToken).digest('hex');
        await adminQuery(
          `INSERT INTO app.mfa_enrollment_tickets
             (id, organization_id, user_id, code_hash, created_by, created_at, expires_at)
           VALUES ($1, $2, $3, $4, NULL, now(), now() + interval '24 hours')`,
          [unconsumedBootstrapId, freshTenant.orgId, adminUserId, unconsumedHash],
        );

        // Attempting to start enrollment with this bootstrap ticket must fail closed with BOOTSTRAP_DISABLED
        const raceEnroll = await call(s, 'POST', '/me/mfa/totp/enroll', {
          ticket: unconsumedToken,
        });
        expect([raceEnroll.statusCode, codeOf(raceEnroll)]).toEqual([409, 'BOOTSTRAP_DISABLED']);
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('ensures transactional rollback if operational audit recording fails', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const adminUserId = freshTenant.users.admin;

        const pool = createPool({ connectionString: inject('dbAdminUrl'), ssl: false, max: 2 });
        try {
          const failingPool = {
            query: (text: string, values?: readonly unknown[]) =>
              pool.query(text, values ? [...values] : []),
            connect: async () => {
              const client = await pool.connect();
              return {
                query: async (text: string, values?: readonly unknown[]) => {
                  if (text.includes('INSERT INTO app.audit_events')) {
                    throw new Error('Simulated audit insert failure');
                  }
                  return client.query(text, values ? [...values] : []);
                },
                release: () => client.release(),
              };
            },
          };

          await expect(
            issueFirstAdminBootstrapTicket(failingPool, {
              organizationId: freshTenant.orgId,
              userId: adminUserId,
            }),
          ).rejects.toThrow('Simulated audit insert failure');

          // Verify NO ticket was committed in app.mfa_enrollment_tickets
          const tickets = await adminQuery<{ id: string }>(
            `SELECT id FROM app.mfa_enrollment_tickets WHERE organization_id = $1`,
            [freshTenant.orgId],
          );
          expect(tickets).toHaveLength(0);
        } finally {
          await pool.end();
        }
      } finally {
        await freshTenant.cleanup();
      }
    });

    it('serializes concurrent bootstrap enrollments and guarantees at most one administrator factor is activated', async () => {
      const freshTenant = await createIsolatedTenant(passwordHash);
      try {
        const admin1Id = freshTenant.users.admin;
        const admin1Email = freshTenant.emails.admin;
        const admin2Id = freshTenant.users.campusAdmin;
        const admin2Email = freshTenant.emails.campusAdmin;

        // Grant COLLEGE_ADMIN to admin2 so they are eligible for bootstrap
        await adminQuery(
          `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id)
           SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'ORGANIZATION', NULL
             FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'COLLEGE_ADMIN'`,
          [uuidv7(), freshTenant.orgId, admin2Id],
        );

        // 1. Issue first bootstrap ticket for Admin 1
        const exec = {
          query: async (text: string, values?: readonly unknown[]) => ({
            rows: await adminQuery(text, values ?? []),
          }),
        };
        const ticket1 = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: admin1Id,
        });

        // 2. Both administrators log in and step up with password
        const s1 = await login(admin1Email);
        await stepUpPassword(s1);
        const s2 = await login(admin2Email);
        await stepUpPassword(s2);

        // 3. Admin 1 starts enrollment with Ticket 1
        const enroll1Res = await call(s1, 'POST', '/me/mfa/totp/enroll', {
          ticket: ticket1.ticket,
        });
        expect(enroll1Res.statusCode).toBe(201);
        const secret1 = base32Decode(enroll1Res.json<{ data: { secret: string } }>().data.secret);

        // 4. Issue a second bootstrap ticket for Admin 2 (which revokes Ticket 1 per policy)
        const ticket2 = await issueFirstAdminBootstrapTicket(exec, {
          organizationId: freshTenant.orgId,
          userId: admin2Id,
        });

        // Admin 2 starts enrollment with Ticket 2
        const enroll2Res = await call(s2, 'POST', '/me/mfa/totp/enroll', {
          ticket: ticket2.ticket,
        });
        expect(enroll2Res.statusCode).toBe(201);
        const secret2 = base32Decode(enroll2Res.json<{ data: { secret: string } }>().data.secret);

        // 5. Concurrently submit TOTP verification from both administrators
        const [res1, res2] = await Promise.all([
          call(s1, 'POST', '/me/mfa/totp/verify', { code: freshCode(secret1) }),
          call(s2, 'POST', '/me/mfa/totp/verify', { code: freshCode(secret2) }),
        ]);

        const statusCodes = [res1.statusCode, res2.statusCode].sort();
        expect(statusCodes).toEqual([200, 409]);

        const rejected = res1.statusCode === 409 ? res1 : res2;
        expect(['BOOTSTRAP_DISABLED', 'CONFLICT']).toContain(codeOf(rejected));

        // 6. Prove that in the database, exactly ONE active verified factor exists across the entire tenant
        const activeFactors = await adminQuery<{ id: string; user_id: string }>(
          `SELECT id, user_id FROM app.user_mfa_factors
            WHERE organization_id = $1 AND status = 'ACTIVE' AND verified_enrollment IS TRUE`,
          [freshTenant.orgId],
        );
        expect(activeFactors).toHaveLength(1);

        // 7. Verify all remaining bootstrap tickets in the tenant are marked revoked
        const activeBootstrapTickets = await adminQuery<{ id: string }>(
          `SELECT id FROM app.mfa_enrollment_tickets
            WHERE organization_id = $1 AND created_by IS NULL
              AND used_at IS NULL AND revoked_at IS NULL`,
          [freshTenant.orgId],
        );
        expect(activeBootstrapTickets).toHaveLength(0);
      } finally {
        await freshTenant.cleanup();
      }
    });
  });
});
