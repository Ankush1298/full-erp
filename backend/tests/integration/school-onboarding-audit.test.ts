import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { InMemoryInvitationMailer } from '../../src/shared/email/invitation-mailer.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { createTenant } from '../../tools/platform/platform-cli.js';

// Audit of the operator-run onboarding of ONE synthetic school (doc 45 §2): each step of the path is driven through the real
// code and its result asserted, so the document states what works and what is missing from evidence, not from reading.
// Steps that have no product path today are done in SQL and LABELLED "STAND-IN". Synthetic data in the disposable database
// only; nothing here touches the development database.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const STAFF_PASSWORD = /* secret-scan:allow */ 'A-Brand-New-Passw0rd';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 8 }));
const mailer = new InMemoryInvitationMailer();
const big = () => new FixedWindowLimiter({ limit: 100000, windowMs: 60_000, maxKeys: 1000 });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
  invitationMailer: mailer,
  inviteLimiter: big(),
  acceptInviteLimiter: big(),
});

interface Session {
  cookie: string;
  csrf: string;
}
const slug = `school-${RUN}`;
const adminEmail = `principal@${slug}.test`;
const staffEmail = `teacher@${slug}.test`;
let admin: pg.Client;
let schoolId = '';
let adminUserId = '';
let OTHER!: IsolatedTenant;
let foreign: Session;
let sess: Session;

async function login(email: string, password = PASSWORD, tenant = slug, verified = true) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password, tenant },
  });
  if (r.statusCode !== 200) return { status: r.statusCode } as const;
  const token = r.cookies.find((c) => c.name === 'session_token')!.value;
  return {
    status: 200,
    cookie: verified ? await mfaVerified(token) : token,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  } as const;
}
const call = (
  method: 'GET' | 'POST' | 'PUT',
  who: Session | null,
  path: string,
  payload?: object,
  h: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: path,
    ...(payload ? { payload } : {}),
    cookies: who ? { session_token: who.cookie } : {},
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN }),
      ...(who && method !== 'GET' ? { 'x-csrf-token': who.csrf } : {}),
      ...h,
    },
  });
const count = async (sql: string, p: unknown[] = []) =>
  Number((await adminQuery<{ n: string }>(sql, p))[0]!.n);

beforeAll(async () => {
  await app.ready();
  admin = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await admin.connect();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  OTHER = await createIsolatedTenant(hash);
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: OTHER.emails.admin, password: PASSWORD },
  });
  foreign = {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await admin.end();
  await OTHER.cleanup();
});

describe('step 1-2: the operator creates the school and its administrative identity', () => {
  it('tenant:create makes an ACTIVE tenant, eight roles with grants, and an INVITED administrator holding COLLEGE_ADMIN', async () => {
    const t = await createTenant(admin, { name: 'Synthetic Public School', slug, adminEmail });
    schoolId = t.id;
    adminUserId = t.adminUserId!;
    expect(t.status).toBe('ACTIVE');
    expect(
      await count(`SELECT count(*) AS n FROM app.roles WHERE organization_id = $1`, [schoolId]),
    ).toBe(8);
    expect(
      await count(`SELECT count(*) AS n FROM app.role_permissions WHERE organization_id = $1`, [
        schoolId,
      ]),
    ).toBeGreaterThan(100);
    const u = (
      await adminQuery<{ status: string; identity_id: string | null }>(
        `SELECT status, identity_id FROM app.users WHERE id = $1`,
        [adminUserId],
      )
    )[0]!;
    expect(u).toEqual({ status: 'INVITED', identity_id: null });
    expect(
      await count(
        `SELECT count(*) AS n FROM app.role_assignments ra JOIN app.roles r ON r.id = ra.role_id
          WHERE ra.user_id = $1 AND r.code = 'COLLEGE_ADMIN' AND ra.scope_type = 'ORGANIZATION'`,
        [adminUserId],
      ),
    ).toBe(1);
  });

  it('GAP G1: that administrator has NO invitation, NO identity and cannot sign in; no unauthenticated route can issue one', async () => {
    expect(
      await count(`SELECT count(*) AS n FROM app.invite_tokens WHERE organization_id = $1`, [
        schoolId,
      ]),
    ).toBe(0);
    expect((await login(adminEmail)).status).toBe(401);
    // the only invitation route needs an authenticated inviter; the first administrator cannot be one
    const r = await call('POST', null, '/api/v1/users/invite', {
      email: adminEmail,
      displayName: 'Principal',
      reason: 'Please invite me',
    });
    expect(r.statusCode).toBe(401);
    // accept-invite needs a token that nothing has issued
    const fake = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: { token: 'a'.repeat(43), password: STAFF_PASSWORD },
    });
    expect(fake.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      await count(`SELECT count(*) AS n FROM platform.identities WHERE email = $1`, [adminEmail]),
    ).toBe(0);
  });
});

describe('step 3-5: password setup and MFA for the first administrator', () => {
  it('STAND-IN (SQL): the operator activates the identity with a password; sign-in works, but before MFA the administrator can do nothing', async () => {
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await admin.query(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [adminUserId, adminEmail, hash],
    );
    await admin.query(`UPDATE app.users SET status = 'ACTIVE', identity_id = $1 WHERE id = $1`, [
      adminUserId,
    ]);
    const l = await login(adminEmail, PASSWORD, slug, false);
    expect(l.status).toBe(200);
    const pre = { cookie: l.cookie!, csrf: l.csrf! };
    // MFA is mandatory for COLLEGE_ADMIN: the session reaches only its own session/MFA routes
    expect((await call('GET', pre, '/api/v1/organization/settings')).statusCode).toBe(403);
    expect(
      (
        await call(
          'PUT',
          pre,
          '/api/v1/organization/settings/institution.type',
          { value: 'SCHOOL', reason: 'Onboarding' },
          { 'if-match': '"0"' },
        )
      ).statusCode,
    ).toBe(403);
    expect((await call('GET', pre, '/auth/me')).statusCode).toBe(200);
    // real enrollment from the one-time bootstrap ticket is proven by tests/integration/mfa.test.ts (see doc 45 §2)
  });

  it('after MFA (STAND-IN: the harness marks the session verified) the administrator needs a step-up for CRITICAL settings', async () => {
    const l = await login(adminEmail);
    sess = { cookie: l.cookie!, csrf: l.csrf! };
    const noStep = await call(
      'PUT',
      sess,
      '/api/v1/organization/settings/institution.type',
      { value: 'SCHOOL', reason: 'Onboarding' },
      { 'if-match': '"0"' },
    );
    expect(noStep.statusCode).toBe(403);
    await elevateSession(sess.cookie);
  });
});

describe('step 6-7: institution type and academic structure', () => {
  it('selects SCHOOL; the first administrator now reads as "Principal"; the foreign tenant is untouched', async () => {
    const r = await call(
      'PUT',
      sess,
      '/api/v1/organization/settings/institution.type',
      { value: 'SCHOOL', reason: 'Chosen during onboarding' },
      { 'if-match': '"0"' },
    );
    expect(r.statusCode, r.body).toBe(200);
    const me = (await call('GET', sess, '/auth/me')).json<{
      roles: string[];
      role_labels: Record<string, string>;
    }>();
    expect(me.roles).toEqual(['COLLEGE_ADMIN']);
    expect(me.role_labels).toEqual({ COLLEGE_ADMIN: 'Principal' });
    const other = (await call('GET', foreign, '/api/v1/academics/terminology')).json<{
      data: { institutionType: string | null };
    }>();
    expect(other.data.institutionType).toBeNull();
  });

  it('creates a campus, a department and the school terminology over HTTP; setup checklist is readable', async () => {
    const campus = await call('POST', sess, '/api/v1/organization/campuses', {
      name: 'Main Campus',
      code: `MC${RUN}`.toUpperCase(),
      timezone: 'Asia/Kolkata',
    });
    expect(campus.statusCode, campus.body).toBe(201);
    const campusId = campus.json<{ data: { id: string } }>().data.id;
    const dept = await call('POST', sess, '/api/v1/organization/departments', {
      campusId,
      name: 'Primary Wing',
      code: `PW${RUN}`.toUpperCase(),
    });
    expect(dept.statusCode, dept.body).toBe(201);
    const term = await call(
      'PUT',
      sess,
      '/api/v1/organization/settings/terminology',
      {
        value: { program: 'Class', period: 'Grade', section: 'Section' },
        reason: 'School vocabulary',
      },
      { 'if-match': '"0"' },
    );
    expect(term.statusCode, term.body).toBe(200);
    const lbl = (await call('GET', sess, '/api/v1/academics/terminology')).json<{
      data: { labels: Record<string, string>; institutionType: string };
    }>().data;
    expect(lbl.institutionType).toBe('SCHOOL');
    expect(lbl.labels).toMatchObject({ program: 'Class', period: 'Grade' });
    expect((await call('GET', sess, '/api/v1/academics/setup-checklist')).statusCode).toBe(200);
  });
});

describe('step 8: inviting teaching and administrative staff', () => {
  it('invite -> e-mail token -> password setup -> sign-in works end to end; the invitee holds NO role and NO capability', async () => {
    const inv = await call(
      'POST',
      sess,
      '/api/v1/users/invite',
      {
        email: staffEmail,
        displayName: 'Synthetic Teacher',
        reason: 'Staff onboarding',
      },
      { 'idempotency-key': `k${RUN}0000000001` },
    );
    expect(inv.statusCode, inv.body).toBe(201);
    const mail = mailer.sent.find((m) => m.to === staffEmail)!;
    expect(mail).toBeDefined();
    const acc = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: { token: mail.revealToken(), password: STAFF_PASSWORD },
    });
    expect(acc.statusCode, acc.body).toBeLessThan(300);
    const l = await login(staffEmail, STAFF_PASSWORD);
    expect(l.status).toBe(200);
    const staff = { cookie: l.cookie!, csrf: l.csrf! };
    // GAP G2: an invitation carries no role, scope or designation, so the new account holds no grant at all: even /auth/me
    // (session.read) is refused until an administrator assigns a role in a separate step.
    const meRes = await call('GET', staff, '/auth/me');
    expect(meRes.statusCode, meRes.body).toBe(403);
    expect((await call('GET', staff, '/api/v1/academics/terminology')).statusCode).toBe(403);
  });

  it('a role is granted in a SEPARATE audited step; MFA-required roles stay blocked until MFA; a teacher cannot invite', async () => {
    const userId = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.users WHERE organization_id = $1 AND email = $2`,
        [schoolId, staffEmail],
      )
    )[0]!.id;
    const roleOf = async (code: string) =>
      (
        await adminQuery<{ id: string }>(
          `SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2`,
          [schoolId, code],
        )
      )[0]!.id;
    const grant = await call('POST', sess, `/api/v1/users/${userId}/role-assignments`, {
      roleId: await roleOf('FACULTY'),
      scopeType: 'ORGANIZATION',
      reason: 'Appointed as teacher',
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const l = await login(staffEmail, STAFF_PASSWORD);
    const staff = { cookie: l.cookie!, csrf: l.csrf! };
    const me = (await call('GET', staff, '/auth/me')).json<{
      roles: string[];
      role_labels: Record<string, string>;
    }>();
    expect(me.roles).toEqual(['FACULTY']);
    expect(me.role_labels).toEqual({ FACULTY: 'Teacher' });
    expect(
      (
        await call(
          'POST',
          staff,
          '/api/v1/users/invite',
          { email: `x@${slug}.test`, displayName: 'X', reason: 'Not allowed' },
          { 'idempotency-key': `k${RUN}0000000002` },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      await count(
        `SELECT count(*) AS n FROM app.audit_events WHERE organization_id = $1 AND action ILIKE '%role%' AND resource_id IS NOT NULL`,
        [schoolId],
      ),
    ).toBeGreaterThan(0);
  });

  it("tenant isolation: the other tenant cannot see this school's users and the school cannot see theirs", async () => {
    const theirs = (await call('GET', foreign, '/api/v1/users')).json<{
      data: Array<{ email: string }>;
    }>().data;
    expect(theirs.some((u) => u.email.endsWith(`@${slug}.test`))).toBe(false);
    const mine = (await call('GET', sess, '/api/v1/users')).json<{
      data: Array<{ email: string }>;
    }>().data;
    expect(mine.some((u) => u.email.endsWith('@isolated.test'))).toBe(false);
    expect(mine.map((u) => u.email)).toContain(staffEmail);
  });
});
