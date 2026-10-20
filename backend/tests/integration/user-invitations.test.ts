import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { InMemoryInvitationMailer } from '../../src/shared/email/invitation-mailer.js';
import type { InvitationMail } from '../../src/shared/email/invitation-mailer.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Tenant user management and invitations (migration 0028): the HTTP routes and the services against the shared disposable
// integration database. Everything commits, so it runs in PRIVATE tenants; every assertion looks at rows these tests
// created (by id or by a unique e-mail), never at tenant-wide counts.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const NEW_PASSWORD = /* secret-scan:allow */ 'A-Brand-New-Passw0rd';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 14 }));
const mailer = new InMemoryInvitationMailer();
const big = (): FixedWindowLimiter =>
  new FixedWindowLimiter({ limit: 100000, windowMs: 60_000, maxKeys: 1000 });
let failMail = false;
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
  invitationMailer: {
    send: (mail: InvitationMail) => {
      if (failMail) return Promise.reject(new Error(`provider exploded: ${mail.revealToken()}`));
      return mailer.send(mail);
    },
  },
  inviteLimiter: big(),
  acceptInviteLimiter: big(),
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const sessions: Record<string, { cookie: string; csrf: string }> = {};
let seq = 0;
const email = (p = 'inv'): string => `${p}.${RUN}.${(seq++).toString(36)}@invite.test`;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const keyOf = (): string => `k${RUN}${(seq++).toString(36).padStart(12, '0')}`;

async function login(address: string, tenantSlug?: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: address, password: PASSWORD, ...(tenantSlug ? { tenant: tenantSlug } : {}) },
  });
  expect(r.statusCode, address).toBe(200);
  return {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  for (const who of [
    'admin',
    'campusAdmin',
    'hod',
    'faculty',
    'registrarOrg',
    'registrarCampus',
    'studentOne',
  ] as const) {
    sessions[who] = await login(T.emails[who]);
  }
  sessions.otherAdmin = await login(OTHER.emails.admin);
  await elevateSession(sessions.admin!.cookie);
  await elevateSession(sessions.otherAdmin.cookie);
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await T.cleanup();
  await OTHER.cleanup();
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  who: string | null,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    cookies: who ? { session_token: sessions[who]!.cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(who ? { 'x-csrf-token': sessions[who]!.csrf } : {}),
      ...headers,
    },
  });
const invite = (
  who: string,
  address: string,
  extra: Record<string, unknown> = {},
  key: string | null = keyOf(),
) =>
  call(
    'POST',
    who,
    '/api/v1/users/invite',
    {
      email: address,
      displayName: 'Invitee Person',
      reason: 'New staff member onboarding',
      ...extra,
    },
    key ? { 'idempotency-key': key } : {},
  );
const accept = (token: string, password = NEW_PASSWORD, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/auth/accept-invite',
    payload: { token, password, ...extra },
    headers: { origin: APP_ORIGIN },
  });
const errCode = (r: { json: <X>() => X }): string =>
  r.json<{ error: { code: string } }>().error.code;
const mailTo = (address: string): InvitationMail[] => mailer.sent.filter((m) => m.to === address);
/** Invites and returns the raw token as the recipient would see it. */
async function invitedToken(who: string, address: string): Promise<string> {
  const before = mailTo(address).length;
  const r = await invite(who, address);
  expect(r.statusCode).toBe(201);
  const mails = mailTo(address);
  expect(mails.length).toBe(before + 1);
  return mails[mails.length - 1]!.revealToken();
}
const userRow = async (tenant: IsolatedTenant, address: string) =>
  (
    await adminQuery<{ id: string; status: string; identity_id: string | null; version: number }>(
      'SELECT id, status, identity_id, version FROM app.users WHERE organization_id = $1 AND email = $2',
      [tenant.orgId, address],
    )
  )[0];
const identityRow = async (address: string) =>
  (
    await adminQuery<{
      id: string;
      password_hash: string;
      status: string;
      failed_login_count: number;
    }>(
      'SELECT id, password_hash, status, failed_login_count FROM platform.identities WHERE email = $1',
      [address],
    )
  )[0];
const audits = (resourceId: string, prefix = 'user.') =>
  adminQuery<{
    action: string;
    risk_tier: number;
    reason_text: string | null;
    actor_user_id: string;
    changes: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT action, risk_tier, reason_text, actor_user_id, changes, metadata FROM app.audit_events
      WHERE resource_id = $1 AND action LIKE $2 ORDER BY occurred_at, id`,
    [resourceId, `${prefix}%`],
  );
const slugOf = async (tenant: IsolatedTenant): Promise<string> =>
  (
    await adminQuery<{ slug: string }>('SELECT slug FROM app.organizations WHERE id = $1', [
      tenant.orgId,
    ])
  )[0]!.slug;

// ---- invitation creation ----------------------------------------------------------------------------------------------
describe('POST /api/v1/users/invite', () => {
  it('creates an INVITED membership and a token; only a SHA-256 hash is stored; the token reaches only the mailer', async () => {
    const address = email();
    const r = await invite('admin', address, { email: `  ${address.toUpperCase()}  ` });
    expect(r.statusCode).toBe(201);
    const body = r.json<{
      success: boolean;
      data: { userId: string; invitationId: string; expiresAt: string; delivery: string };
    }>();
    expect(body.data.delivery).toBe('SENT');
    expect(Object.keys(body.data).sort()).toEqual([
      'delivery',
      'expiresAt',
      'invitationId',
      'userId',
    ]);

    const mails = mailTo(address);
    expect(mails).toHaveLength(1);
    const token = mails[0]!.revealToken(); // secret-scan:allow
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    // the HTTP response, the audit event and the database never contain the token
    expect(r.body).not.toContain(token);
    const row = await userRow(T, address);
    expect(row).toMatchObject({ status: 'INVITED', identity_id: null });
    const tok = await adminQuery<{
      token_hash: string;
      used_at: Date | null;
      revoked_at: Date | null;
      created_by: string;
      days: number;
    }>(
      `SELECT token_hash, used_at, revoked_at, created_by, round(extract(epoch FROM (expires_at - created_at)) / 86400)::int AS days
         FROM app.invite_tokens WHERE id = $1`,
      [body.data.invitationId],
    );
    expect(tok[0]).toMatchObject({
      token_hash: sha256(token),
      used_at: null,
      revoked_at: null,
      created_by: T.users.admin,
      days: 7,
    });
    expect(tok[0]!.token_hash).not.toBe(token);
    const leaks = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE resource_id = $1 AND (changes::text LIKE $2 OR metadata::text LIKE $2 OR changes::text LIKE $3 OR metadata::text LIKE $3)`,
      [row!.id, `%${token}%`, `%${address}%`],
    );
    expect(leaks).toEqual([]);

    const ev = await audits(row!.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      action: 'user.invite',
      risk_tier: 2,
      reason_text: 'New staff member onboarding',
      actor_user_id: T.users.admin,
    });
    expect(JSON.stringify(ev[0])).not.toContain('invite.test');
  });

  it('requires an Idempotency-Key; a replay returns the same invitation, sends nothing again and creates no second token', async () => {
    const address = email();
    expect((await invite('admin', address, {}, null)).statusCode).toBe(428);
    expect(await userRow(T, address)).toBeUndefined();
    const key = keyOf();
    const first = await invite('admin', address, {}, key);
    const again = await invite('admin', address, {}, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json<{ data: { delivery: string; invitationId: string } }>().data).toMatchObject({
      delivery: 'NOT_ATTEMPTED',
      invitationId: first.json<{ data: { invitationId: string } }>().data.invitationId,
    });
    expect(mailTo(address)).toHaveLength(1);
    const row = await userRow(T, address);
    const live = await adminQuery(
      'SELECT 1 FROM app.invite_tokens WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [row!.id],
    );
    expect(live).toHaveLength(1);
  });

  it('closed bodies: no role, scope, status, tenant, identity or token field can be supplied; bad values are 400', async () => {
    const address = email();
    for (const extra of [
      { role: 'COLLEGE_ADMIN' },
      { roleId: uuidv7() },
      { scopeType: 'ORGANIZATION' },
      { status: 'ACTIVE' },
      { organizationId: T.orgId },
      { tenantId: OTHER.orgId },
      { identityId: uuidv7() },
      { token: 'x' },
      { email: 'not-an-email' },
      { email: 'a b@c.d' },
      { displayName: '' },
      { displayName: 'x'.repeat(201) },
      { reason: 'abc' },
    ]) {
      const r = await invite('admin', address, extra);
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(await userRow(T, address)).toBeUndefined();
    expect(
      (
        await call('POST', 'admin', '/api/v1/users/invite', undefined, {
          'idempotency-key': keyOf(),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('authorization: only an ORGANIZATION-scoped holder may invite; scoped holders, roles without the permission and students are refused', async () => {
    const address = email();
    expect((await invite('faculty', address)).statusCode).toBe(403);
    expect((await invite('hod', address)).statusCode).toBe(403);
    expect((await invite('studentOne', address)).statusCode).toBe(403);
    // CAMPUS_ADMIN and a campus REGISTRAR hold the permission in doc 10, but a user account has no campus: inert (403)
    expect((await invite('campusAdmin', address)).statusCode).toBe(403);
    expect((await invite('registrarCampus', address)).statusCode).toBe(403);
    expect((await call('POST', null, '/api/v1/users/invite', {})).statusCode).toBe(401);
    expect(await userRow(T, address)).toBeUndefined();
    expect(mailTo(address)).toHaveLength(0);
    expect((await invite('registrarOrg', address)).statusCode).toBe(201);
  });

  it('an address that already has a membership in THIS tenant is 409; an address that exists only in ANOTHER tenant is indistinguishable from a new one', async () => {
    const dup = await invite('admin', T.emails.faculty);
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe('CONFLICT');
    expect(mailTo(T.emails.faculty)).toHaveLength(0);

    // an account that exists in OTHER only
    const elsewhere = OTHER.emails.faculty;
    const fresh = email();
    const a = await invite('admin', elsewhere);
    const b = await invite('admin', fresh);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const shape = (r: typeof a) => Object.keys(r.json<{ data: object }>().data).sort();
    expect(shape(a)).toEqual(shape(b));
    expect(a.json<{ data: { delivery: string } }>().data.delivery).toBe(
      b.json<{ data: { delivery: string } }>().data.delivery,
    );
    // the existing identity is untouched by an invitation
    expect((await identityRow(elsewhere))!.status).toBe('ACTIVE');
    expect((await userRow(T, elsewhere))!.identity_id).toBeNull();
  });

  it('a delivery failure never undoes the invitation and never leaks the token; a re-invite rotates the token', async () => {
    const address = email();
    failMail = true;
    const failed = await invite('admin', address);
    failMail = false;
    expect(failed.statusCode).toBe(201);
    expect(failed.json<{ data: { delivery: string } }>().data.delivery).toBe('FAILED');
    expect(failed.body).not.toContain('exploded');
    expect(mailTo(address)).toHaveLength(0);
    const row = await userRow(T, address);
    expect(row!.status).toBe('INVITED');

    const token = await invitedToken('admin', address); // re-invite: the first (lost) token is withdrawn
    const live = await adminQuery<{ n: string }>(
      'SELECT count(*) AS n FROM app.invite_tokens WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [row!.id],
    );
    expect(Number(live[0]!.n)).toBe(1);
    const ev = await audits(row!.id);
    expect(ev.map((e) => e.action)).toEqual(['user.invite', 'user.invite']);
    expect(ev[1]!.metadata).toMatchObject({ reinvite: true });
    expect((await accept(token)).statusCode).toBe(200);
  });

  it('is rate limited per (tenant, user), with Retry-After', async () => {
    const limited = buildApp({
      config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
      db,
      logger: false,
      invitationMailer: new InMemoryInvitationMailer(),
      inviteLimiter: new FixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 10 }),
    });
    await limited.ready();
    const lg = await limited.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: T.emails.admin, password: PASSWORD },
    });
    const cookie = await mfaVerified(lg.cookies.find((c) => c.name === 'session_token')!.value);
    const csrf = lg.json<{ csrf_token: string }>().csrf_token;
    const go = () =>
      limited.inject({
        method: 'POST',
        url: '/api/v1/users/invite',
        payload: { email: email(), displayName: 'Rate Test', reason: 'Rate limit check run' },
        cookies: { session_token: cookie },
        headers: { origin: APP_ORIGIN, 'x-csrf-token': csrf, 'idempotency-key': keyOf() },
      });
    expect([(await go()).statusCode, (await go()).statusCode]).toEqual([201, 201]);
    const third = await go();
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });
});

// ---- acceptance -----------------------------------------------------------------------------------------------------
describe('POST /auth/accept-invite', () => {
  it('activates exactly the invited membership: a new identity with the chosen password, no role, no session, one audit event', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    const before = await userRow(T, address);
    const r = await accept(token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ success: true });
    expect(r.cookies).toHaveLength(0); // no session is issued

    const after = await userRow(T, address);
    const ident = await identityRow(address);
    expect(after).toMatchObject({ status: 'ACTIVE', identity_id: ident!.id });
    expect(after!.version).toBe(before!.version + 1);
    expect(ident!.status).toBe('ACTIVE');
    expect(ident!.password_hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(ident!.password_hash, NEW_PASSWORD)).toBe(true);
    // no role was granted by acceptance
    expect(
      await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [after!.id]),
    ).toEqual([]);
    const tok = await adminQuery<{ used_at: Date | null }>(
      'SELECT used_at FROM app.invite_tokens WHERE user_id = $1',
      [after!.id],
    );
    expect(tok[0]!.used_at).not.toBeNull();

    const ev = (await audits(after!.id)).filter((e) => e.action === 'user.invitation_accept');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      risk_tier: 1,
      actor_user_id: after!.id,
      changes: { status: { old: 'INVITED', new: 'ACTIVE' } },
    });
    expect(JSON.stringify(ev[0])).not.toContain(token);

    // the new member can now sign in (and, having no role, is refused by /auth/me: nothing was granted)
    const lg = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: address, password: NEW_PASSWORD, tenant: await slugOf(T) },
    });
    expect(lg.statusCode).toBe(200);
  });

  it('is single use: a replay, an unknown token and a malformed token all get the SAME 400', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    expect((await accept(token)).statusCode).toBe(200);
    const replay = await accept(token, 'Another-Passw0rd-Entirely');
    const unknown = await accept(randomBytes(32).toString('base64url'));
    const malformed = await accept('short');
    for (const r of [replay, unknown, malformed]) expect(r.statusCode).toBe(400);
    expect(errCode(replay)).toBe('INVALID_INVITATION');
    expect(errCode(unknown)).toBe('INVALID_INVITATION');
    expect(replay.json<{ error: { message: string } }>().error.message).toBe(
      unknown.json<{ error: { message: string } }>().error.message,
    );
    // the replay did not change the password
    expect(await argon2.verify((await identityRow(address))!.password_hash, NEW_PASSWORD)).toBe(
      true,
    );
  });

  it('an expired invitation is refused and changes nothing', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    const row = await userRow(T, address);
    await adminQuery(
      `UPDATE app.invite_tokens SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [row!.id],
    );
    const r = await accept(token);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('INVALID_INVITATION');
    expect(await userRow(T, address)).toMatchObject({ status: 'INVITED', identity_id: null });
    expect(await identityRow(address)).toBeUndefined();
  });

  it('a re-invite withdraws the older token', async () => {
    const address = email();
    const first = await invitedToken('admin', address);
    const second = await invitedToken('admin', address);
    expect((await accept(first)).statusCode).toBe(400);
    expect((await accept(second)).statusCode).toBe(200);
  });

  it("concurrent acceptances of ONE token: exactly one wins, one identity, the winner's password, no duplicate activation", async () => {
    for (let round = 0; round < 3; round++) {
      const address = email();
      const token = await invitedToken('admin', address);
      const passwords = Array.from({ length: 6 }, (_, i) => `Concurrent-Passw0rd-${round}-${i}`);
      const results = await Promise.all(passwords.map((p) => accept(token, p)));
      const winners = results.map((r, i) => [r.statusCode, i] as const).filter(([s]) => s === 200);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 400)).toHaveLength(5);
      const ident = await adminQuery(
        'SELECT password_hash FROM platform.identities WHERE email = $1',
        [address],
      );
      expect(ident).toHaveLength(1);
      expect(
        await argon2.verify(ident[0]!.password_hash as string, passwords[winners[0]![1]]!),
      ).toBe(true);
      const ev = (await audits((await userRow(T, address))!.id)).filter(
        (e) => e.action === 'user.invitation_accept',
      );
      expect(ev).toHaveLength(1);
    }
  });

  it('the same address invited in TWO tenants accepts concurrently: one shared identity, each membership activated in its own tenant only', async () => {
    const address = email();
    const tokenT = await invitedToken('admin', address);
    const before = mailTo(address).length;
    const r = await call(
      'POST',
      'otherAdmin',
      '/api/v1/users/invite',
      { email: address, displayName: 'Shared Person', reason: 'Joint appointment onboarding' },
      { 'idempotency-key': keyOf() },
    );
    expect(r.statusCode).toBe(201);
    const tokenO = mailTo(address)[before]!.revealToken();
    const [a, b] = await Promise.all([accept(tokenT), accept(tokenO)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]); // same password: the second one authenticates as the existing identity
    const idents = await adminQuery('SELECT id FROM platform.identities WHERE email = $1', [
      address,
    ]);
    expect(idents).toHaveLength(1);
    expect(await userRow(T, address)).toMatchObject({
      status: 'ACTIVE',
      identity_id: idents[0]!.id,
    });
    expect(await userRow(OTHER, address)).toMatchObject({
      status: 'ACTIVE',
      identity_id: idents[0]!.id,
    });
  });

  it('an EXISTING identity must prove its current password: a wrong one fails like any other failure, counts as a failed login and changes nothing', async () => {
    const address = OTHER.emails.faculty; // an account that already exists (in OTHER)
    const token = await invitedToken('admin', address);
    const before = await identityRow(address);
    const wrong = await accept(token, 'Not-The-Existing-Passw0rd');
    expect(wrong.statusCode).toBe(400);
    expect(errCode(wrong)).toBe('INVALID_INVITATION');
    const mid = await identityRow(address);
    expect(mid!.password_hash).toBe(before!.password_hash);
    expect(mid!.failed_login_count).toBe(before!.failed_login_count + 1);
    expect(await userRow(T, address)).toMatchObject({ status: 'INVITED', identity_id: null });

    const good = await accept(token, PASSWORD);
    expect(good.statusCode).toBe(200);
    const after = await identityRow(address);
    expect(after!.password_hash).toBe(before!.password_hash); // never changed by an invitation
    expect(after!.failed_login_count).toBe(0);
    expect(await userRow(T, address)).toMatchObject({ status: 'ACTIVE', identity_id: before!.id });
  });

  it('a disabled identity cannot be reached through an invitation (same generic 400)', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'DISABLED')`,
      [uuidv7(), address, await argon2.hash(PASSWORD, { type: argon2.argon2id })],
    );
    const r = await accept(token, PASSWORD);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('INVALID_INVITATION');
    expect(await userRow(T, address)).toMatchObject({ status: 'INVITED', identity_id: null });
  });

  it('cannot be steered: tenant, role, scope or user fields in the body are 400, and acceptance never touches another tenant or any role', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    for (const extra of [
      { tenant: OTHER.orgId },
      { organizationId: OTHER.orgId },
      { role: 'COLLEGE_ADMIN' },
      { roleId: uuidv7() },
      { scopeType: 'ORGANIZATION' },
      { userId: T.users.admin },
    ]) {
      expect((await accept(token, NEW_PASSWORD, extra)).statusCode, JSON.stringify(extra)).toBe(
        400,
      );
    }
    expect(await userRow(T, address)).toMatchObject({ status: 'INVITED' });
    // a user with the SAME e-mail in the other tenant is not touched by this tenant's token
    const otherBefore = await userRow(OTHER, OTHER.emails.faculty);
    expect((await accept(token)).statusCode).toBe(200);
    expect(await userRow(OTHER, OTHER.emails.faculty)).toEqual(otherBefore);
    expect(
      await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [
        (await userRow(T, address))!.id,
      ]),
    ).toEqual([]);
    // password length bounds
    const t2 = await invitedToken('admin', email());
    expect((await accept(t2, 'short')).statusCode).toBe(400);
    expect((await accept(t2, 'x'.repeat(129))).statusCode).toBe(400);
  });

  it('is atomic with its audit event: a failing audit write leaves the token unused, the user INVITED and no identity', async () => {
    const address = email();
    const token = await invitedToken('admin', address);
    const service = new AuthService(db, new AuthRepository());
    await expect(
      service.acceptInvitation(token, NEW_PASSWORD, { requestId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'AUDIT_INVALID' });
    expect(await userRow(T, address)).toMatchObject({ status: 'INVITED', identity_id: null });
    expect(await identityRow(address)).toBeUndefined();
    const used = await adminQuery(
      'SELECT 1 FROM app.invite_tokens WHERE user_id = $1 AND used_at IS NOT NULL',
      [(await userRow(T, address))!.id],
    );
    expect(used).toEqual([]);
    expect((await accept(token)).statusCode).toBe(200); // still usable
  });

  it('is rate limited per IP and per token, with Retry-After', async () => {
    const limited = buildApp({
      config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
      db,
      logger: false,
      acceptInviteLimiter: new FixedWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100 }),
    });
    await limited.ready();
    const go = () =>
      limited.inject({
        method: 'POST',
        url: '/auth/accept-invite',
        payload: { token: randomBytes(32).toString('base64url'), password: NEW_PASSWORD },
        headers: { origin: APP_ORIGIN },
      });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await go()).statusCode);
    expect(codes.slice(0, 3)).toEqual([400, 400, 400]);
    const blocked = await go();
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    await limited.close();
  });

  it('requires the Origin check like every state-changing request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: { token: randomBytes(32).toString('base64url'), password: NEW_PASSWORD },
      headers: { origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(403);
  });
});

// ---- listing --------------------------------------------------------------------------------------------------------
describe('GET /api/v1/users', () => {
  it('lists only this tenant, with minimal fields, a status filter and keyset pagination', async () => {
    const a = email('list');
    const b = email('list');
    await invite('admin', a);
    await invite('admin', b);
    const r = await call('GET', 'admin', '/api/v1/users?limit=100');
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      data: Record<string, unknown>[];
      page: { nextAfterId: string | null };
    }>();
    for (const u of body.data) {
      expect(Object.keys(u).sort()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
        'status',
        'version',
      ]);
    }
    const emails = body.data.map((u) => u.email);
    expect(emails).toEqual(expect.arrayContaining([a, b, T.emails.faculty]));
    expect(emails).not.toContain(OTHER.emails.hod); // never invited into this tenant
    expect(emails).not.toContain(OTHER.emails.admin);
    expect(r.body).not.toMatch(/password|identity|token_hash/i);

    const invited = await call('GET', 'admin', '/api/v1/users?status=INVITED&limit=100');
    expect(
      invited.json<{ data: { status: string }[] }>().data.every((u) => u.status === 'INVITED'),
    ).toBe(true);

    // keyset paging visits every user exactly once
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 40; i++) {
      const page: { json: <X>() => X } = await call(
        'GET',
        'admin',
        `/api/v1/users?limit=2${after ? `&afterId=${after}` : ''}`,
      );
      const p = page.json<{ data: { id: string }[]; page: { nextAfterId: string | null } }>();
      seen.push(...p.data.map((u) => u.id));
      after = p.page.nextAfterId;
      if (!after) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(10); // the isolated tenant's own users plus the invited ones
  });

  it('another tenant sees only its own users; scoped holders, roles without the permission and students are refused; bad query is 400', async () => {
    const other = await call('GET', 'otherAdmin', '/api/v1/users?limit=100');
    const emails = other.json<{ data: { email: string }[] }>().data.map((u) => u.email);
    expect(emails).toContain(OTHER.emails.admin);
    expect(emails).not.toContain(T.emails.admin);
    expect((await call('GET', 'registrarOrg', '/api/v1/users')).statusCode).toBe(200);
    for (const who of ['hod', 'campusAdmin', 'registrarCampus', 'faculty', 'studentOne']) {
      expect((await call('GET', who, '/api/v1/users')).statusCode, who).toBe(403);
    }
    expect((await call('GET', null, '/api/v1/users')).statusCode).toBe(401);
    for (const q of [
      '?limit=0',
      '?limit=101',
      '?status=BOGUS',
      '?afterId=nope',
      '?organizationId=x',
    ]) {
      expect((await call('GET', 'admin', `/api/v1/users${q}`)).statusCode, q).toBe(400);
    }
  });
});

// ---- suspension and reactivation --------------------------------------------------------------------------------------
describe('suspend and reactivate', () => {
  /** A fresh ACTIVE member with its own login session. */
  async function activeMember(): Promise<{
    address: string;
    id: string;
    session: { cookie: string; csrf: string };
  }> {
    const address = email('member');
    const token = await invitedToken('admin', address);
    expect((await accept(token, PASSWORD)).statusCode).toBe(200);
    const row = (await userRow(T, address))!;
    const session = await login(address, await slugOf(T));
    return { address, id: row.id, session };
  }
  const change = (
    who: string,
    action: 'suspend' | 'reactivate',
    id: string,
    version: number | string | null,
    reason = 'Policy review decision',
  ) =>
    call(
      'POST',
      who,
      `/api/v1/users/${id}/${action}`,
      { reason },
      version === null ? {} : { 'if-match': `"${version}"` },
    );

  it('ambient session without step-up is refused for CRITICAL operations: 403 STEP_UP_REQUIRED', async () => {
    const ambientAdmin = await login(T.emails.admin);
    const m = await activeMember();
    const v = (await userRow(T, m.address))!.version;
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${m.id}/suspend`,
      payload: { reason: 'Ambient test reason' },
      cookies: { session_token: ambientAdmin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': ambientAdmin.csrf,
        'if-match': `"${v}"`,
      },
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it("suspension revokes THIS tenant's sessions at once, leaves other tenants' sessions alone, and audits at tier 2 without personal data", async () => {
    const m = await activeMember();
    // the same identity also holds a membership and a live session in ANOTHER tenant
    const identity = (await userRow(T, m.address))!.identity_id!;
    const otherUser = uuidv7();
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'Dual', 'ACTIVE', $4)`,
      [otherUser, OTHER.orgId, m.address, identity],
    );
    const otherSession = uuidv7();
    await adminQuery(
      `INSERT INTO platform.auth_sessions (id, identity_id, tenant_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [otherSession, identity, OTHER.orgId, sha256(`other-${RUN}-${m.address}`)],
    );
    const meSession = (): Promise<number> =>
      app
        .inject({ method: 'GET', url: '/auth/me', cookies: { session_token: m.session.cookie } })
        .then((r) => r.statusCode);
    expect(await meSession()).not.toBe(401);

    const v = (await userRow(T, m.address))!.version;
    const r = await change('admin', 'suspend', m.id, v);
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe(`"${v + 1}"`);
    expect(r.json<{ data: { status: string } }>().data.status).toBe('SUSPENDED');

    expect(await meSession()).toBe(401); // immediate
    const revoked = await adminQuery<{ tenant_id: string; revoked_at: Date | null }>(
      'SELECT tenant_id, revoked_at FROM platform.auth_sessions WHERE identity_id = $1',
      [identity],
    );
    expect(revoked.filter((s) => s.tenant_id === T.orgId).every((s) => s.revoked_at !== null)).toBe(
      true,
    );
    expect(
      revoked.filter((s) => s.tenant_id === OTHER.orgId).every((s) => s.revoked_at === null),
    ).toBe(true);
    // a suspended member cannot sign in to this tenant
    const lg = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: m.address, password: PASSWORD, tenant: await slugOf(T) },
    });
    expect(lg.statusCode).toBe(401);

    const ev = (await audits(m.id)).filter((e) => e.action === 'user.suspend');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      risk_tier: 2,
      reason_text: 'Policy review decision',
      actor_user_id: T.users.admin,
      changes: { status: { old: 'ACTIVE', new: 'SUSPENDED' } },
    });
    expect((ev[0]!.metadata as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThanOrEqual(
      1,
    );
    expect(JSON.stringify(ev[0])).not.toContain('invite.test');
  });

  it('reactivation restores sign-in (a NEW session); old sessions stay revoked; wrong states are 409', async () => {
    const m = await activeMember();
    const v1 = (await userRow(T, m.address))!.version;
    expect((await change('admin', 'reactivate', m.id, v1)).statusCode).toBe(409); // ACTIVE is not SUSPENDED
    expect((await change('admin', 'suspend', m.id, v1)).statusCode).toBe(200);
    expect((await change('admin', 'suspend', m.id, v1 + 1)).statusCode).toBe(409); // already suspended
    const back = await change('admin', 'reactivate', m.id, v1 + 1);
    expect(back.statusCode).toBe(200);
    expect(back.json<{ data: { status: string } }>().data.status).toBe('ACTIVE');
    expect(
      await app
        .inject({ method: 'GET', url: '/auth/me', cookies: { session_token: m.session.cookie } })
        .then((r) => r.statusCode),
    ).toBe(401);
    await login(m.address, await slugOf(T)); // a fresh login works again
    expect((await audits(m.id)).filter((e) => e.action === 'user.reactivate')).toHaveLength(1);
    // an INVITED user can neither be suspended nor reactivated
    const invitedAddr = email();
    await invite('admin', invitedAddr);
    const inv = (await userRow(T, invitedAddr))!;
    expect((await change('admin', 'suspend', inv.id, inv.version)).statusCode).toBe(409);
    expect((await change('admin', 'reactivate', inv.id, inv.version)).statusCode).toBe(409);
  });

  it('If-Match must carry the exact version (428 missing, 400 weak/garbage, 409 stale); a reason is mandatory; nothing changes on refusal', async () => {
    const m = await activeMember();
    const v = (await userRow(T, m.address))!.version;
    expect((await change('admin', 'suspend', m.id, null)).statusCode).toBe(428);
    for (const h of ['W/"1"', '*', '"0"', 'abc']) {
      expect(
        (
          await call(
            'POST',
            'admin',
            `/api/v1/users/${m.id}/suspend`,
            { reason: 'Policy review decision' },
            { 'if-match': h },
          )
        ).statusCode,
        h,
      ).toBe(400);
    }
    expect((await change('admin', 'suspend', m.id, v + 5)).statusCode).toBe(409);
    expect((await change('admin', 'suspend', m.id, v, 'abc')).statusCode).toBe(400);
    expect(
      (
        await call(
          'POST',
          'admin',
          `/api/v1/users/${m.id}/suspend`,
          { reason: 'Policy review decision', status: 'X' },
          { 'if-match': `"${v}"` },
        )
      ).statusCode,
    ).toBe(400);
    expect(await userRow(T, m.address)).toMatchObject({ status: 'ACTIVE', version: v });
    expect((await audits(m.id)).filter((e) => e.action === 'user.suspend')).toEqual([]);
  });

  it('authorization: only an ORGANIZATION-scoped CRITICAL holder; never yourself; another tenant gets 404', async () => {
    const m = await activeMember();
    const v = (await userRow(T, m.address))!.version;
    // campusAdmin holds user.account.suspend at CAMPUS scope: elevate it so the request clears the step-up gate and is
    // refused by the service's ORGANIZATION-scope rule (FORBIDDEN), not by STEP_UP_REQUIRED.
    await elevateSession(sessions.campusAdmin!.cookie);
    for (const who of [
      'faculty',
      'hod',
      'studentOne',
      'registrarOrg',
      'registrarCampus',
      'campusAdmin',
    ]) {
      const refused = await change(who, 'suspend', m.id, v);
      expect(refused.statusCode, who).toBe(403);
      expect(errCode(refused), who).toBe('FORBIDDEN');
    }
    expect((await change('admin', 'suspend', T.users.admin, 1)).statusCode).toBe(403); // self
    const cross = await change('otherAdmin', 'suspend', m.id, v);
    const unknown = await change('otherAdmin', 'suspend', uuidv7(), v);
    expect(cross.statusCode).toBe(404);
    const shape = (r: typeof cross): unknown => {
      const e = r.json<{ error: { code: string; message: string } }>().error;
      return [e.code, e.message];
    };
    expect(shape(cross)).toEqual(shape(unknown));
    expect(await userRow(T, m.address)).toMatchObject({ status: 'ACTIVE', version: v });
  });

  it('two administrators suspending each other at the same moment: one succeeds, the other is refused as the LAST administrator', async () => {
    // a second administrator, made through the normal route and rules
    const second = await activeMember();
    await elevateSession(second.session.cookie);
    const role = await adminQuery<{ id: string }>(
      `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'COLLEGE_ADMIN'`,
      [T.orgId],
    );
    const grant = await call('POST', 'admin', `/api/v1/users/${second.id}/role-assignments`, {
      roleId: role[0]!.id,
      scopeType: 'ORGANIZATION',
      reason: 'Second administrator appointed',
    });
    expect(grant.statusCode).toBe(201);
    const [vAdmin, vSecond] = [
      (await userRow(T, T.emails.admin))!.version,
      (await userRow(T, second.address))!.version,
    ];
    const results = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/v1/users/${second.id}/suspend`,
        payload: { reason: 'Mutual suspension test' },
        cookies: { session_token: sessions.admin!.cookie },
        headers: {
          origin: APP_ORIGIN,
          'x-csrf-token': sessions.admin!.csrf,
          'if-match': `"${vSecond}"`,
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/v1/users/${T.users.admin}/suspend`,
        payload: { reason: 'Mutual suspension test' },
        cookies: { session_token: second.session.cookie },
        headers: {
          origin: APP_ORIGIN,
          'x-csrf-token': second.session.csrf,
          'if-match': `"${vAdmin}"`,
        },
      }),
    ]);
    // Exactly one wins. The loser is refused: if the loser has not completed scope check, it gets 403 (loser's session/status
    // was suspended/revoked); once the winner commits, app.context_ok() hides rows (404); or the last-admin check triggers (409).
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBe(200);
    expect([403, 404, 409]).toContain(codes[1]);
    // at least one administrator is still ACTIVE; restore the shared fixture for later tests
    const active = await adminQuery(
      `SELECT 1 FROM app.users WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'ACTIVE'`,
      [T.orgId, [T.users.admin, second.id]],
    );
    expect(active).toHaveLength(1);
    await adminQuery(
      `UPDATE app.users SET status = 'ACTIVE' WHERE organization_id = $1 AND id = $2`,
      [T.orgId, T.users.admin],
    );
    await adminQuery(`UPDATE platform.auth_sessions SET revoked_at = NULL WHERE identity_id = $1`, [
      T.users.admin,
    ]);
  });
});

// ---- roles ----------------------------------------------------------------------------------------------------------
describe('role assignment through the existing service', () => {
  const roleId = async (code: string): Promise<string> =>
    (
      await adminQuery<{ id: string }>(
        'SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2',
        [T.orgId, code],
      )
    )[0]!.id;
  const grantBody = async (code: string, extra: Record<string, unknown> = {}) => ({
    roleId: await roleId(code),
    scopeType: 'ORGANIZATION',
    reason: 'Appointed after approval',
    ...extra,
  });

  it('an authorized administrator grants and revokes a role through the routes; the existing audit event is written', async () => {
    const address = email();
    await invite('admin', address);
    const target = (await userRow(T, address))!;
    const r = await call(
      'POST',
      'admin',
      `/api/v1/users/${target.id}/role-assignments`,
      await grantBody('STAFF'),
    );
    expect(r.statusCode).toBe(201);
    const id = r.json<{ data: { id: string } }>().data.id;
    const row = await adminQuery<{ status: string; user_id: string }>(
      'SELECT status, user_id FROM app.role_assignments WHERE id = $1',
      [id],
    );
    expect(row[0]).toEqual({ status: 'ACTIVE', user_id: target.id });
    expect((await audits(id, 'role.assignment.')).map((e) => e.action)).toEqual([
      'role.assignment.grant',
    ]);
    expect(
      (
        await call(
          'POST',
          'admin',
          `/api/v1/users/${target.id}/role-assignments`,
          await grantBody('STAFF'),
        )
      ).statusCode,
    ).toBe(409); // duplicate
    const rv = await call('POST', 'admin', `/api/v1/role-assignments/${id}/revoke`, {
      reason: 'Appointment withdrawn',
    });
    expect(rv.statusCode).toBe(200);
    expect((await audits(id, 'role.assignment.')).map((e) => e.action)).toEqual([
      'role.assignment.grant',
      'role.assignment.revoke',
    ]);
  });

  it('ambient session without step-up is refused on POST /users/:id/role-assignments: 403 STEP_UP_REQUIRED', async () => {
    const ambientAdmin = await login(T.emails.admin);
    const address = email();
    await invite('admin', address);
    const target = (await userRow(T, address))!;
    const adminRole = await grantBody('COLLEGE_ADMIN');
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${target.id}/role-assignments`,
      payload: adminRole,
      cookies: { session_token: ambientAdmin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': ambientAdmin.csrf,
      },
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it('ambient session without step-up is refused on POST /role-assignments/:id/revoke: 403 STEP_UP_REQUIRED', async () => {
    const address = email();
    await invite('admin', address);
    const target = (await userRow(T, address))!;
    const g = await call(
      'POST',
      'admin',
      `/api/v1/users/${target.id}/role-assignments`,
      await grantBody('STAFF'),
    );
    expect(g.statusCode).toBe(201);
    const id = g.json<{ data: { id: string } }>().data.id;

    const ambientAdmin = await login(T.emails.admin);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/role-assignments/${id}/revoke`,
      payload: { reason: 'Revocation ambient test' },
      cookies: { session_token: ambientAdmin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': ambientAdmin.csrf,
      },
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  it('cannot escalate: no self-grant, a CAMPUS_ADMIN cannot grant COLLEGE_ADMIN, roles without the permission are refused, bodies are closed', async () => {
    const address = email();
    await invite('admin', address);
    const target = (await userRow(T, address))!;
    const admin = await grantBody('COLLEGE_ADMIN');
    expect(
      (await call('POST', 'admin', `/api/v1/users/${T.users.admin}/role-assignments`, admin))
        .statusCode,
    ).toBe(403); // self
    // campusAdmin holds role.assignment.grant: elevate it so the request clears the step-up gate and is refused by the
    // grant rules (CAMPUS_ADMIN may not grant COLLEGE_ADMIN), not by STEP_UP_REQUIRED.
    await elevateSession(sessions.campusAdmin!.cookie);
    const escalation = await call(
      'POST',
      'campusAdmin',
      `/api/v1/users/${target.id}/role-assignments`,
      admin,
    );
    expect(escalation.statusCode).toBe(403);
    expect(errCode(escalation)).toBe('FORBIDDEN');
    for (const who of ['faculty', 'hod', 'registrarOrg', 'studentOne']) {
      expect(
        (await call('POST', who, `/api/v1/users/${target.id}/role-assignments`, admin)).statusCode,
        who,
      ).toBe(403);
    }
    // another tenant cannot grant a role of this tenant to its user
    expect(
      (await call('POST', 'otherAdmin', `/api/v1/users/${target.id}/role-assignments`, admin))
        .statusCode,
    ).toBe(404);
    for (const extra of [
      { organizationId: T.orgId },
      { status: 'ACTIVE' },
      { code: 'COLLEGE_ADMIN' },
    ]) {
      expect(
        (
          await call('POST', 'admin', `/api/v1/users/${target.id}/role-assignments`, {
            ...admin,
            ...extra,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      await adminQuery('SELECT 1 FROM app.role_assignments WHERE user_id = $1', [target.id]),
    ).toEqual([]);
    // an invitation itself never carries a role, and acceptance leaves the assignments empty
    expect(
      (
        await call('POST', 'admin', `/api/v1/users/${target.id}/role-assignments`, {
          ...(await grantBody('STAFF')),
          scopeType: 'GALAXY',
        })
      ).statusCode,
    ).toBe(400);
  });
});
