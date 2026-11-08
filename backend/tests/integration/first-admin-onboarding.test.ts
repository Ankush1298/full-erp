import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { hotp, totpStep } from '../../src/modules/auth/mfa/totp.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { loggerOptions } from '../../src/shared/logging/logger-options.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery } from '../support/db-harness.js';
import {
  OnboardingError,
  issueFirstAdminInvitation,
  issueFirstAdminMfaTicket,
  revokeFirstAdminInvitation,
} from '../../tools/platform/first-admin.js';
import { createTenant } from '../../tools/platform/platform-cli.js';

// Operator-run first-administrator onboarding (doc 45 G1 and G3) end to end against the DISPOSABLE integration database:
// tenant:create -> admin:invite -> accept-invite (password policy) -> sign-in -> admin:mfa-ticket -> step-up + TOTP enrolment ->
// normal administrative access. Synthetic data only; no secret value is written to the test output.

const GOOD = /* secret-scan:allow */ 'A-Brand-New-Passw0rd';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 8 }));
const big = () => new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 10_000 });
let totpOffset = 0;
const totpNow = () => Date.now() + totpOffset;
const logLines: string[] = [];
const logStream = new Writable({
  write(chunk: Buffer, _e, cb) {
    logLines.push(chunk.toString());
    cb();
  },
});
const app = buildApp({
  config: loadConfig({
    DATABASE_URL: url,
    APP_ORIGINS: APP_ORIGIN,
    MFA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
    MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
  }),
  db,
  logger: { ...loggerOptions('trace'), stream: logStream },
  stepUpLimiter: big(),
  mfaLimiter: big(),
  acceptInviteLimiter: big(),
  totpClock: totpNow,
});
let op: pg.Client;
const secrets: string[] = [];
let seq = 0;
const slugOf = () => `fa-${RUN}-${(seq++).toString(36)}`;

interface Session {
  cookie: string;
  csrf: string;
}
const post = (path: string, payload: object, who: Session | null = null) =>
  app.inject({
    method: 'POST',
    url: path,
    payload,
    cookies: who ? { session_token: who.cookie } : {},
    headers: { origin: APP_ORIGIN, ...(who ? { 'x-csrf-token': who.csrf } : {}) },
  });
const get = (path: string, who: Session) =>
  app.inject({ method: 'GET', url: path, cookies: { session_token: who.cookie } });
const accept = (token: string, password: string) =>
  post('/auth/accept-invite', { token, password });
async function login(email: string, slug: string, password = GOOD): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, tenant: slug },
  });
  expect(r.statusCode, 'login').toBe(200);
  return {
    cookie: r.cookies.find((c) => c.name === 'session_token')!.value,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}
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
const freshCode = (seed: Buffer) => {
  totpOffset += 30_000;
  return hotp(seed, totpStep(totpNow()));
};
const count = async (sql: string, p: unknown[] = []) =>
  Number((await adminQuery<{ n: string }>(sql, p))[0]!.n);
const newSchool = async (withAdmin = true) => {
  const slug = slugOf();
  const email = `head@${slug}.test`;
  const t = await createTenant(op, {
    name: 'Synthetic School',
    slug,
    ...(withAdmin ? { adminEmail: email } : {}),
  });
  return { ...t, slug, email };
};
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof OnboardingError ? e.code : `OTHER:${(e as Error).message}`;
  }
};

beforeAll(async () => {
  await app.ready();
  op = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await op.connect();
}, 60_000);
afterAll(async () => {
  await app.close();
  await db.close();
  await op.end();
});

describe('invitation issuance: preconditions, secrecy, expiry, retries', () => {
  it('refuses unknown tenants, bad lifetimes, a tenant without a designated administrator, and an MFA ticket before activation', async () => {
    expect(await code(issueFirstAdminInvitation(op, { tenant: 'no-such-school' }))).toBe(
      'TENANT_NOT_FOUND',
    );
    const s = await newSchool();
    for (const ttlHours of [0, 73, 1.5, -1]) {
      expect(
        await code(issueFirstAdminInvitation(op, { tenant: s.slug, ttlHours })),
        String(ttlHours),
      ).toBe('INVALID_TTL');
    }
    expect(await code(issueFirstAdminMfaTicket(op, { tenant: s.slug }))).toBe('NO_ACTIVE_ADMIN');
    const bare = await newSchool(false);
    expect(await code(issueFirstAdminInvitation(op, { tenant: bare.slug }))).toBe(
      'NO_DESIGNATED_ADMIN',
    );
    await op.query(`UPDATE app.organizations SET status = 'SUSPENDED' WHERE id = $1`, [bare.id]);
    expect(await code(issueFirstAdminInvitation(op, { tenant: bare.slug }))).toBe(
      'TENANT_NOT_FOUND',
    );
    expect(
      await count(`SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1`, [s.id]),
    ).toBe(0);
  });

  it('issues a 256-bit token bound to the designated administrator: only its hash is stored, the audit is tier 3 SYSTEM and holds no token', async () => {
    const s = await newSchool();
    const inv = await issueFirstAdminInvitation(op, {
      tenant: s.slug,
      ttlHours: 12,
      reason: 'Synthetic onboarding',
    });
    secrets.push(inv.token);
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inv.userId).toBe(s.adminUserId);
    const row = (
      await adminQuery<{ token_hash: string; created_by: string; hours: number }>(
        `SELECT token_hash, created_by, round(extract(epoch FROM (expires_at - created_at)) / 3600)::int AS hours FROM app.invite_tokens WHERE id = $1`,
        [inv.invitationId],
      )
    )[0]!;
    expect(row.token_hash).toBe(createHash('sha256').update(inv.token).digest('hex'));
    expect(row.hours).toBe(12);
    expect(row.created_by).toBe(s.adminUserId);
    const ev = await adminQuery<{
      risk_tier: number;
      actor_type: string;
      reason_text: string;
      blob: string;
    }>(
      `SELECT risk_tier, actor_type, reason_text, row_to_json(a)::text AS blob FROM app.audit_events a
        WHERE organization_id = $1 AND action = 'platform.first_admin.invite_issue'`,
      [s.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      risk_tier: 3,
      actor_type: 'SYSTEM',
      reason_text: 'Synthetic onboarding',
    });
    expect(ev[0]!.blob).not.toContain(inv.token);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1 AND token_hash <> $2 AND token_hash LIKE $3`,
        [s.id, row.token_hash, `%${inv.token.slice(0, 8)}%`],
      ),
    ).toBe(0);
  });

  it('a retry withdraws the earlier token (one live token): the old one stops working, the new one works; revocation withdraws it too', async () => {
    const s = await newSchool();
    const first = await issueFirstAdminInvitation(op, { tenant: s.slug });
    const second = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(first.token, second.token);
    expect(second.reissued).toBe(true);
    expect(first.invitationId).not.toBe(second.invitationId);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [s.id],
      ),
    ).toBe(1);
    expect((await accept(first.token, GOOD)).statusCode).toBe(400);
    const rev = await revokeFirstAdminInvitation(op, { tenant: s.slug, reason: 'Wrong recipient' });
    expect(rev.revoked).toBe(1);
    expect((await accept(second.token, GOOD)).statusCode).toBe(400);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE organization_id = $1 AND action = 'platform.first_admin.invite_revoke' AND risk_tier = 3`,
        [s.id],
      ),
    ).toBe(1);
    const third = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(third.token);
    expect((await accept(third.token, GOOD)).statusCode).toBe(200);
  });

  it('an expired token is rejected and consumes nothing', async () => {
    const s = await newSchool();
    const inv = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(inv.token);
    await adminQuery(`BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE app.invite_tokens SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = '${inv.invitationId}'; COMMIT;`);
    expect((await accept(inv.token, GOOD)).statusCode).toBe(400);
    expect(
      (
        await adminQuery<{ status: string }>(`SELECT status FROM app.users WHERE id = $1`, [
          s.adminUserId,
        ])
      )[0]!.status,
    ).toBe('INVITED');
    // a fresh issue works after expiry (safe retry)
    const again = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(again.token);
    expect((await accept(again.token, GOOD)).statusCode).toBe(200);
  });
});

describe('activation: password policy, single use, wrong tenant, no second initial administrator', () => {
  it('rejects a weak password without consuming the token, then activates once; reuse is refused; no role beyond COLLEGE_ADMIN appears', async () => {
    const s = await newSchool();
    const inv = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(inv.token);
    for (const weak of ['short', 'elevenchars', '']) {
      expect((await accept(inv.token, weak)).statusCode, weak).toBe(400);
    }
    expect(
      (
        await adminQuery<{ used_at: string | null }>(
          `SELECT used_at FROM app.invite_tokens WHERE id = $1`,
          [inv.invitationId],
        )
      )[0]!.used_at,
    ).toBeNull();
    expect((await accept(inv.token, GOOD)).statusCode).toBe(200);
    expect((await accept(inv.token, GOOD)).statusCode).toBe(400); // single use
    const u = (
      await adminQuery<{ status: string; identity_id: string | null }>(
        `SELECT status, identity_id FROM app.users WHERE id = $1`,
        [s.adminUserId],
      )
    )[0]!;
    expect(u.status).toBe('ACTIVE');
    expect(u.identity_id).not.toBeNull();
    const roles = await adminQuery<{ code: string }>(
      `SELECT r.code FROM app.role_assignments ra JOIN app.roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
      [s.adminUserId],
    );
    expect(roles.map((r) => r.code)).toEqual(['COLLEGE_ADMIN']);
    // the stored hash is a password hash, never the password
    const hash = (
      await adminQuery<{ password_hash: string }>(
        `SELECT password_hash FROM platform.identities WHERE id = $1`,
        [u.identity_id],
      )
    )[0]!.password_hash;
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain(GOOD);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE organization_id = $1 AND action = 'user.invitation_accept'`,
        [s.id],
      ),
    ).toBe(1);
  });

  it("wrong tenant: another school's administrator is never selected, and a token activates only its own membership", async () => {
    const a = await newSchool();
    const b = await newSchool();
    expect(await code(issueFirstAdminInvitation(op, { tenant: a.slug, adminEmail: b.email }))).toBe(
      'NO_DESIGNATED_ADMIN',
    );
    const inv = await issueFirstAdminInvitation(op, { tenant: a.slug });
    secrets.push(inv.token);
    expect((await accept(inv.token, GOOD)).statusCode).toBe(200);
    expect(
      (
        await adminQuery<{ status: string }>(`SELECT status FROM app.users WHERE id = $1`, [
          b.adminUserId,
        ])
      )[0]!.status,
    ).toBe('INVITED');
    expect(
      await count(`SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1`, [b.id]),
    ).toBe(0);
    expect(await code(issueFirstAdminMfaTicket(op, { tenant: a.slug, adminEmail: b.email }))).toBe(
      'NO_ACTIVE_ADMIN',
    );
    expect(await code(issueFirstAdminMfaTicket(op, { tenant: b.slug }))).toBe('NO_ACTIVE_ADMIN');
    expect((await login(a.email, a.slug)).cookie).toBeDefined();
  });

  it('no second initial administrator: ambiguity needs an explicit e-mail, and once one is ACTIVE the path is closed', async () => {
    const s = await newSchool();
    const second = `second@${s.slug}.test`;
    const secondId = (
      await adminQuery<{ id: string }>(
        `INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($3, $1, $2, 'Second', 'INVITED') RETURNING id`,
        [s.id, second, uuidv7()],
      )
    )[0]!.id;
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, status)
       SELECT $3::uuid, $1::uuid, $2::uuid, r.id, 'ORGANIZATION', NULL, 'ACTIVE' FROM app.roles r WHERE r.organization_id = $1::uuid AND r.code = 'COLLEGE_ADMIN'`,
      [s.id, secondId, uuidv7()],
    );
    expect(await code(issueFirstAdminInvitation(op, { tenant: s.slug }))).toBe('AMBIGUOUS_ADMIN');
    const inv = await issueFirstAdminInvitation(op, { tenant: s.slug, adminEmail: s.email });
    secrets.push(inv.token);
    expect((await accept(inv.token, GOOD)).statusCode).toBe(200);
    expect(await code(issueFirstAdminInvitation(op, { tenant: s.slug, adminEmail: second }))).toBe(
      'ADMIN_ALREADY_ACTIVE',
    );
    expect(await code(issueFirstAdminInvitation(op, { tenant: s.slug }))).toBe(
      'ADMIN_ALREADY_ACTIVE',
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1 AND user_id = $2`,
        [s.id, secondId],
      ),
    ).toBe(0);
  });
});

describe('MFA: operator ticket, step-up, enrolment, then normal administrative access', () => {
  it('before MFA the administrator is gated; the ticket needs step-up, enrols once, closes bootstrap and unlocks normal access', async () => {
    const s = await newSchool();
    const inv = await issueFirstAdminInvitation(op, { tenant: s.slug });
    secrets.push(inv.token);
    expect((await accept(inv.token, GOOD)).statusCode).toBe(200);
    const sess = await login(s.email, s.slug);
    // gate: no administrative access without MFA
    expect((await get('/api/v1/organization/settings', sess)).statusCode).toBe(403);

    const t = await issueFirstAdminMfaTicket(op, {
      tenant: s.slug,
      reason: 'Synthetic MFA bootstrap',
    });
    secrets.push(t.ticket);
    expect(t.userId).toBe(s.adminUserId);
    // a retry replaces the earlier ticket
    const t2 = await issueFirstAdminMfaTicket(op, { tenant: s.slug });
    secrets.push(t2.ticket);
    // enrolment needs a recent password step-up: refused without it
    const noStep = await post('/me/mfa/totp/enroll', { ticket: t2.ticket }, sess);
    expect(noStep.statusCode).toBeGreaterThanOrEqual(400);
    expect((await post('/auth/step-up', { password: GOOD }, sess)).statusCode).toBe(200);
    // the first ticket was revoked by the second
    expect((await post('/me/mfa/totp/enroll', { ticket: t.ticket }, sess)).statusCode).toBe(401);
    const enr = await post('/me/mfa/totp/enroll', { ticket: t2.ticket }, sess);
    expect(enr.statusCode, enr.body).toBe(201);
    const seed = base32Decode(enr.json<{ data: { secret: string } }>().data.secret);
    expect((await post('/me/mfa/totp/verify', { code: freshCode(seed) }, sess)).statusCode).toBe(
      200,
    );
    // single use, and bootstrap is closed for this tenant
    expect((await post('/me/mfa/totp/enroll', { ticket: t2.ticket }, sess)).statusCode).toBe(401);
    expect(await code(issueFirstAdminMfaTicket(op, { tenant: s.slug }))).toMatch(
      /OTHER:First-administrator bootstrap is disabled|BOOTSTRAP/,
    );
    // normal administrative access now works (reads; CRITICAL writes still need their own step-up)
    expect((await get('/api/v1/organization/settings', sess)).statusCode).toBe(200);
    const audit = await adminQuery<{ action: string; risk_tier: number; actor_type: string }>(
      `SELECT action, risk_tier, actor_type FROM app.audit_events WHERE organization_id = $1 AND action LIKE 'platform.first_admin.%' OR (organization_id = $1 AND action = 'auth.mfa.bootstrap_ticket_issue') ORDER BY action`,
      [s.id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'auth.mfa.bootstrap_ticket_issue',
      'auth.mfa.bootstrap_ticket_issue',
      'platform.first_admin.invite_issue',
    ]);
    expect(audit.every((a) => a.risk_tier === 3 && a.actor_type === 'SYSTEM')).toBe(true);
  });

  it("role and tenant isolation: the new administrator reaches only their own school; another school's data is invisible both ways", async () => {
    const a = await newSchool();
    const b = await newSchool();
    for (const s of [a, b]) {
      const inv = await issueFirstAdminInvitation(op, { tenant: s.slug });
      secrets.push(inv.token);
      expect((await accept(inv.token, GOOD)).statusCode).toBe(200);
    }
    const sa = await login(a.email, a.slug);
    const me = (await get('/auth/me', sa)).json<{ tenant_id: string; roles: string[] }>();
    expect(me.tenant_id).toBe(a.id);
    expect(me.roles).toEqual(['COLLEGE_ADMIN']);
    // a's session cannot be turned into b's: b's e-mail does not log in under a's slug
    const cross = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: b.email, password: GOOD, tenant: a.slug },
    });
    expect(cross.statusCode).toBe(401);
  });
});

describe('secrets never reach logs or stored records', () => {
  it('no token or ticket appears in application logs, audit events or operational tables', async () => {
    expect(secrets.length).toBeGreaterThan(8);
    const logs = logLines.join('');
    const audits = (
      await adminQuery<{ blob: string }>(
        `SELECT row_to_json(a)::text AS blob FROM app.audit_events a`,
      )
    )
      .map((r) => r.blob)
      .join('');
    const tokens = (
      await adminQuery<{ blob: string }>(
        `SELECT row_to_json(t)::text AS blob FROM app.invite_tokens t`,
      )
    )
      .map((r) => r.blob)
      .join('');
    const tickets = (
      await adminQuery<{ blob: string }>(
        `SELECT row_to_json(t)::text AS blob FROM app.mfa_enrollment_tickets t`,
      )
    )
      .map((r) => r.blob)
      .join('');
    for (const secret of secrets) {
      expect(logs.includes(secret)).toBe(false);
      expect(audits.includes(secret)).toBe(false);
      expect(tokens.includes(secret)).toBe(false);
      expect(tickets.includes(secret)).toBe(false);
    }
    expect(logs.includes(GOOD)).toBe(false);
  });
});
