import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { StudentDuplicateService } from '../../src/modules/students/index.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Possible-duplicate detection (owner decisions 2026-10-22, doc 26 §3.5): normalised name + date of birth + guardian phone,
// at admission (POST /students) and import. Everything commits, so it runs in PRIVATE tenants.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 12 }));
// The dedicated import matching-data HMAC ring (doc 26 §3.5.4). Generated at run time; not real credentials.
const K1 = randomBytes(32).toString('base64url');
const K2 = randomBytes(32).toString('base64url');
const appWith = (ring: Record<string, string>): FastifyInstance =>
  buildApp({
    config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN, ...ring }),
    db,
    logger: false,
  });
const app = appWith({ IMPORT_MATCHING_KEYS: `k1:${K1}`, IMPORT_MATCHING_ACTIVE_KEY_ID: 'k1' });
/** The same deployment without the ring, after a rotation to k2 (k1 retiring), and after k1 was removed. */
const noKeyApp = appWith({});
const rotatedApp = appWith({
  IMPORT_MATCHING_KEYS: `k1:${K1},k2:${K2}`,
  IMPORT_MATCHING_ACTIVE_KEY_ID: 'k2',
});
const retiredApp = appWith({
  IMPORT_MATCHING_KEYS: `k2:${K2}`,
  IMPORT_MATCHING_ACTIVE_KEY_ID: 'k2',
});
const extraApps = [noKeyApp, rotatedApp, retiredApp];

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Who = 'admin' | 'registrarOrg' | 'registrarCampus' | 'hod' | 'faculty';
const WHO: Who[] = ['admin', 'registrarOrg', 'registrarCampus', 'hod', 'faculty'];
const sessions = {} as Record<Who, { cookie: string; csrf: string }>;

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  await app.ready();
  for (const a of extraApps) await a.ready();
  for (const w of WHO) sessions[w] = await login(T.emails[w]);
}, 120_000);

afterAll(async () => {
  await app.close();
  for (const a of extraApps) await a.close();
  await db.close();
  await T.cleanup();
  await OTHER.cleanup();
});

let kseq = 0;
const newKey = (): string => `k${RUN}${(kseq++).toString(36).padStart(12, '0')}`;
let nseq = 0;
const adm = (): string => `DU${RUN}${(nseq++).toString(36).toUpperCase()}`;
const DOB = '2005-03-04';
const RUN_NUM = String(parseInt(RUN, 16) % 100000).padStart(5, '0');
const uniq = (): { name: string; phone: string } => {
  const n = nseq++;
  return { name: `Pat ${RUN} ${n}`, phone: `9${RUN_NUM}${String(n).padStart(5, '0')}` };
};

function http(
  method: 'GET' | 'POST',
  who: Who,
  path: string,
  payload?: InjectOptions['payload'],
  o: { key?: string | null; ifMatch?: string; via?: FastifyInstance } = {},
) {
  const s = sessions[who];
  const key = o.key === undefined && method === 'POST' ? newKey() : o.key;
  return (o.via ?? app).inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { session_token: s.cookie },
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': s.csrf }),
      ...(key ? { 'idempotency-key': key } : {}),
      ...(o.ifMatch !== undefined ? { 'if-match': o.ifMatch } : {}),
    },
  });
}

interface Account {
  id: string;
  email: string;
}
async function account(tenant: IsolatedTenant = T, displayName?: string): Promise<Account> {
  const id = uuidv7();
  const email = `du-${RUN}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [id, tenant.orgId, email, displayName ?? email],
  );
  return { id, email };
}

interface Candidate {
  studentId: string;
  userId: string;
  admissionNumber: string;
  guardianId: string | null;
  linkId: string;
}
/** An existing student with a date of birth and one guardian phone (new-shape guardian, or a legacy contact row). */
async function candidate(o: {
  name: string;
  dob?: string | null;
  phone?: string | null;
  legacy?: boolean;
  tenant?: IsolatedTenant;
}): Promise<Candidate> {
  const tenant = o.tenant ?? T;
  const a = await account(tenant, o.name);
  if (o.dob !== null) {
    await adminQuery(`UPDATE app.users SET date_of_birth = $2 WHERE id = $1`, [a.id, o.dob ?? DOB]);
  }
  const studentId = uuidv7();
  const admissionNumber = adm();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', 'ACTIVE')`,
    [studentId, tenant.orgId, a.id, admissionNumber],
  );
  const linkId = uuidv7();
  let guardianId: string | null = null;
  if (o.phone) {
    if (o.legacy) {
      await adminQuery(
        `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation)
         VALUES ($1, $2, $3, 'Legacy Contact', $4, 'Parent')`,
        [linkId, tenant.orgId, studentId, o.phone],
      );
    } else {
      guardianId = uuidv7();
      await adminQuery(
        `INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, 'Guardian', $3)`,
        [guardianId, tenant.orgId, o.phone],
      );
      await adminQuery(
        `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation)
         VALUES ($1, $2, $3, $4, 'Mother')`,
        [linkId, tenant.orgId, studentId, guardianId],
      );
    }
  }
  return { studentId, userId: a.id, admissionNumber, guardianId, linkId };
}

const staffCtx = (tenant: IsolatedTenant, user: string) =>
  issueTrustedContext({ tenantId: tenant.orgId, userId: user, actorKind: 'STAFF' });
async function find(
  probe: Parameters<typeof StudentDuplicateService.find>[2][number],
  tenant: IsolatedTenant = T,
  user: string = T.users.admin,
): Promise<string | null> {
  const ctx = staffCtx(tenant, user);
  const [r] = await db.withTenant(ctx, (tx) => StudentDuplicateService.find(tx, ctx, [probe]));
  return r ?? null;
}

describe('the matcher: normalisation and the all-three rule', () => {
  it('matches names that differ only by surrounding whitespace and case, and phones that differ only in formatting', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const fp = await find({
      name: `   ${u.name.toUpperCase()}\t`,
      dateOfBirth: DOB,
      guardianPhone: `+${u.phone.slice(0, 2)} (${u.phone.slice(2, 5)}) ${u.phone.slice(5)}-`,
    });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not match when the date of birth, the normalised name or the phone digits differ', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const base = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    expect(await find(base)).not.toBeNull();
    expect(await find({ ...base, dateOfBirth: '2005-03-05' })).toBeNull();
    expect(await find({ ...base, name: `${u.name} x` })).toBeNull();
    expect(await find({ ...base, name: u.name.replace(' ', '  ') })).toBeNull(); // inner whitespace is NOT collapsed
    expect(await find({ ...base, guardianPhone: `${u.phone}1` })).toBeNull();
    expect(await find({ ...base, guardianPhone: `0${u.phone}` })).toBeNull(); // no leading-zero or country-code inference
  });

  it('treats a missing or unusable value on EITHER side as no match (missing is never equal to missing)', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const noDob = uniq();
    await candidate({ name: noDob.name, phone: noDob.phone, dob: null });
    const noPhone = uniq();
    await candidate({ name: noPhone.name, phone: null });
    const base = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    expect(await find({ ...base, dateOfBirth: null })).toBeNull();
    expect(await find({ name: u.name, guardianPhone: u.phone })).toBeNull();
    expect(await find({ ...base, guardianPhone: null })).toBeNull();
    expect(await find({ ...base, guardianPhone: '---  ()' })).toBeNull(); // no digit: unusable
    expect(await find({ ...base, name: '   ' })).toBeNull();
    expect(await find({ ...base, name: null })).toBeNull();
    // candidate without a date of birth / without a guardian phone: nothing to compare
    expect(
      await find({ name: noDob.name, dateOfBirth: DOB, guardianPhone: noDob.phone }),
    ).toBeNull();
    expect(await find({ name: noPhone.name, dateOfBirth: DOB, guardianPhone: '' })).toBeNull();
    expect(await find({ name: noPhone.name, dateOfBirth: DOB, guardianPhone: '0' })).toBeNull();
  });

  it('uses active guardians and legacy contacts only; ended links and soft-deleted guardians do not count', async () => {
    const legacy = uniq();
    await candidate({ name: legacy.name, phone: legacy.phone, legacy: true });
    expect(
      await find({ name: legacy.name, dateOfBirth: DOB, guardianPhone: legacy.phone }),
    ).not.toBeNull();

    const ended = uniq();
    const c = await candidate({ name: ended.name, phone: ended.phone });
    await adminQuery(`UPDATE app.student_guardians SET valid_to = current_date WHERE id = $1`, [
      c.linkId,
    ]);
    expect(
      await find({ name: ended.name, dateOfBirth: DOB, guardianPhone: ended.phone }),
    ).toBeNull();

    const gone = uniq();
    const g = await candidate({ name: gone.name, phone: gone.phone });
    await adminQuery(`UPDATE app.guardians SET deleted_at = now() WHERE id = $1`, [g.guardianId]);
    expect(await find({ name: gone.name, dateOfBirth: DOB, guardianPhone: gone.phone })).toBeNull();
  });

  it('never matches the probe’s own account, keeps admission numbers exact, and fingerprints the SET of matches', async () => {
    const u = uniq();
    const c1 = await candidate({ name: u.name, phone: u.phone });
    const probe = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    expect(await find({ ...probe, excludeUserId: c1.userId })).toBeNull();
    const one = await find(probe);
    expect(await find(probe)).toBe(one); // deterministic
    await candidate({ name: u.name, phone: u.phone });
    const two = await find(probe);
    expect(two).not.toBe(one);
    expect(two).toMatch(/^[0-9a-f]{64}$/);
    // admission numbers are never normalised: the same letters in another case are another number
    const lower = adm().toLowerCase();
    const a = await account();
    const b = await account();
    for (const [acc, n] of [
      [a, lower],
      [b, lower.toUpperCase()],
    ] as const) {
      const r = await http('POST', 'admin', '/api/v1/students', {
        userId: acc.id,
        admissionNumber: n,
        admissionDate: '2024-07-01',
        reason: 'Admission register entry',
      });
      expect(r.statusCode, r.body).toBe(201);
    }
  });

  it('cannot see another tenant’s records, and refuses callers who may not create students', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone, tenant: OTHER });
    const probe = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    expect(await find(probe)).toBeNull(); // from tenant T
    expect(await find(probe, OTHER, OTHER.users.admin)).not.toBeNull(); // visible only inside its own tenant
    for (const user of [T.users.faculty, T.users.hod, T.users.registrarCampus]) {
      const err = await find(probe, T, user).catch((e: unknown) => e);
      expect(err, user).toMatchObject({ statusCode: 403 });
    }
    const studentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });
    const refused = await db
      .withTenant(studentCtx, (tx) => StudentDuplicateService.find(tx, studentCtx, [probe]))
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ statusCode: 403 });
  });
});

describe('the matcher under a non-ISO session DateStyle (F5)', () => {
  it('still matches: the candidate date is rendered as YYYY-MM-DD explicitly, not by DateStyle', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const probe = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    const iso = await find(probe);
    expect(iso).toMatch(/^[0-9a-f]{64}$/);
    // a separate pool on the SAME disposable test database whose sessions start with DateStyle 'SQL, DMY'
    const dmyUrl = new URL(url);
    dmyUrl.searchParams.set('options', '-c DateStyle=SQL,DMY');
    const dmyPool = createPool({ connectionString: dmyUrl.toString(), ssl: false, max: 1 });
    const dmyDb = new Database(dmyPool);
    try {
      // proof that sessions of this pool really are non-ISO: a plain ::text of a date is not YYYY-MM-DD (raw pool query:
      // the tenant transaction's SQL guard rightly refuses current_setting)
      const proof = await dmyPool.query<{ s: string; t: string }>(
        `SELECT current_setting('DateStyle') AS s, (DATE '2005-03-04')::text AS t`,
      );
      expect(proof.rows[0]).toEqual({ s: 'SQL, DMY', t: '04/03/2005' });
      const ctx = staffCtx(T, T.users.admin);
      const fp = await dmyDb.withTenant(
        ctx,
        async (tx) => (await StudentDuplicateService.find(tx, ctx, [probe]))[0],
      );
      // ...and the matcher still finds the same candidate set
      expect(fp).toBe(iso);
    } finally {
      await dmyDb.close();
    }
  });
});

describe('admission: POST /students', () => {
  const body = (a: Account, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    userId: a.id,
    admissionNumber: adm(),
    admissionDate: '2024-07-01',
    reason: 'Admission register entry',
    ...over,
  });
  const post = (b: Record<string, unknown>, key?: string, who: Who = 'admin') =>
    http('POST', who, '/api/v1/students', b, key ? { key } : {});
  const studentOf = async (a: Account): Promise<number> =>
    (
      await adminQuery(`SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2`, [
        T.orgId,
        a.id,
      ])
    ).length;

  it('warns without creating, leaks nothing about the candidate, and creates once the exact warning is acknowledged', async () => {
    const u = uniq();
    const cand = await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const key = newKey();
    const matching = {
      name: ` ${u.name.toUpperCase()} `,
      dateOfBirth: DOB,
      guardianPhone: `+91 ${u.phone}`,
    };
    // the phone differs from the stored digits ("91" + digits), so this first probe must NOT match
    const miss = await post(body(a, matching));
    expect(miss.statusCode, miss.body).toBe(201);

    const b = await account();
    const probe = {
      name: ` ${u.name.toUpperCase()} `,
      dateOfBirth: DOB,
      guardianPhone: u.phone.replace(/(\d{3})/, '$1 '),
    };
    const req = body(b, probe);
    const warned = await post(req, key);
    expect(warned.statusCode, warned.body).toBe(409);
    const err = warned.json<{
      error: { code: string; message: string; details: { field: string; message: string }[] };
    }>().error;
    expect(err.code).toBe('POSSIBLE_DUPLICATE_STUDENT');
    expect(err.details).toHaveLength(1);
    expect(err.details[0]!.field).toBe('duplicateAcknowledgement');
    const token = err.details[0]!.message;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [
      DOB,
      u.phone,
      u.name,
      cand.studentId,
      cand.userId,
      cand.admissionNumber,
    ]) {
      expect(warned.body).not.toContain(secret);
    }
    expect(await studentOf(b)).toBe(0); // nothing created, and the failed attempt left no audit event
    const audits = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND action = 'student.record.create' AND subject_student_id IN
         (SELECT id FROM app.students WHERE user_id = $2)`,
      [T.orgId, b.id],
    );
    expect(audits).toHaveLength(0);

    // a made-up or malformed acknowledgement does not pass; a well-formed wrong one is answered with the real warning
    expect((await post({ ...req, duplicateAcknowledgement: 'x' })).statusCode).toBe(400);
    const wrong = await post({ ...req, duplicateAcknowledgement: 'a'.repeat(64) });
    expect(wrong.statusCode).toBe(409);
    expect(
      wrong.json<{ error: { details: { message: string }[] } }>().error.details[0]!.message,
    ).toBe(token);

    // the exact acknowledgement creates the record (the failed attempts did not claim the key)
    const ok = await post({ ...req, duplicateAcknowledgement: token }, key);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(await studentOf(b)).toBe(1);
    const replay = await post({ ...req, duplicateAcknowledgement: token }, key);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await studentOf(b)).toBe(1);

    // the audit event records only the FACT of the acknowledgement
    const ev = await adminQuery<{ metadata: unknown; changes: unknown; reason_text: string }>(
      `SELECT metadata, changes, reason_text FROM app.audit_events
        WHERE organization_id = $1 AND action = 'student.record.create'
          AND subject_student_id = (SELECT id FROM app.students WHERE user_id = $2)`,
      [T.orgId, b.id],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.metadata).toMatchObject({ duplicateAcknowledgementSupplied: true });
    const dump = JSON.stringify(ev);
    for (const secret of [DOB, u.phone, u.name]) expect(dump).not.toContain(secret);
  });

  it('does not persist the matching inputs anywhere: no date of birth on the account, no new guardian, no phone in any table', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const guardiansBefore = await adminQuery(
      `SELECT 1 FROM app.guardians WHERE organization_id = $1`,
      [T.orgId],
    );
    const r = await post(
      body(a, { name: 'Somebody Else', dateOfBirth: '2001-01-01', guardianPhone: '8887776665' }),
    );
    expect(r.statusCode, r.body).toBe(201);
    expect(
      (
        await adminQuery<{ date_of_birth: string | null }>(
          `SELECT date_of_birth::text FROM app.users WHERE id = $1`,
          [a.id],
        )
      )[0]!.date_of_birth,
    ).toBeNull();
    const guardiansAfter = await adminQuery(
      `SELECT 1 FROM app.guardians WHERE organization_id = $1`,
      [T.orgId],
    );
    expect(guardiansAfter.length).toBe(guardiansBefore.length);
    // not even the idempotency store holds the values (it keeps a digest and the 201 body)
    const stored = await adminQuery(
      `SELECT to_jsonb(k)::text AS j FROM app.idempotency_keys k WHERE organization_id = $1 AND user_id = $2`,
      [T.orgId, T.users.admin],
    );
    for (const row of stored as { j: string }[]) {
      expect(row.j).not.toContain('8887776665');
      expect(row.j).not.toContain('2001-01-01');
    }
  });

  it('a changed candidate set cannot be accepted with the old acknowledgement', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const probe = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    const req = body(a, probe);
    const first = await post(req);
    expect(first.statusCode).toBe(409);
    const oldToken = first.json<{ error: { details: { message: string }[] } }>().error.details[0]!
      .message;
    await candidate({ name: u.name, phone: u.phone }); // a second possible duplicate appears
    const second = await post({ ...req, duplicateAcknowledgement: oldToken });
    expect(second.statusCode).toBe(409);
    const newToken = second.json<{ error: { details: { message: string }[] } }>().error.details[0]!
      .message;
    expect(newToken).not.toBe(oldToken);
    expect(await studentOf(a)).toBe(0);
    expect((await post({ ...req, duplicateAcknowledgement: newToken })).statusCode).toBe(201);
  });

  it('an acknowledgement is bound to the account it was issued for and to the person who reviewed it', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const probe = { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone };
    const [a, b] = [await account(), await account()];
    const first = await post(body(a, probe));
    expect(first.statusCode).toBe(409);
    const detail = (r: { json: <T>() => T }): string =>
      r.json<{ error: { details: { message: string }[] } }>().error.details[0]!.message;
    const token = detail(first);
    // the same candidates, another account: the token does not carry over
    const other = await post(body(b, { ...probe, duplicateAcknowledgement: token }));
    expect(other.statusCode).toBe(409);
    expect(detail(other)).not.toBe(token);
    expect(await studentOf(b)).toBe(0);
    // the same account, but another administrator's session: the token does not carry over either
    const byOther = await post(
      body(a, { ...probe, duplicateAcknowledgement: token }),
      undefined,
      'registrarOrg',
    );
    expect(byOther.statusCode).toBe(409);
    expect(await studentOf(a)).toBe(0);
    expect((await post(body(a, { ...probe, duplicateAcknowledgement: token }))).statusCode).toBe(
      201,
    );
  });

  it('creates straight away when any of the three values is missing or different (the warning is not a hard error)', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const variants: Record<string, unknown>[] = [
      { name: u.name, guardianPhone: u.phone }, // no date of birth
      { name: u.name, dateOfBirth: DOB }, // no phone
      { dateOfBirth: DOB, guardianPhone: u.phone }, // no name
      { name: u.name, dateOfBirth: '2005-03-05', guardianPhone: u.phone },
      { name: `${u.name}!`, dateOfBirth: DOB, guardianPhone: u.phone },
      { name: u.name, dateOfBirth: DOB, guardianPhone: '1234567' },
      {},
    ];
    for (const v of variants) {
      const a = await account();
      const r = await post(body(a, v));
      expect(r.statusCode, JSON.stringify(v) + r.body).toBe(201);
    }
  });

  it('keeps an exact admission-number conflict a hard error, ahead of the warning', async () => {
    const u = uniq();
    const cand = await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const r = await post(
      body(a, {
        admissionNumber: cand.admissionNumber,
        name: u.name,
        dateOfBirth: DOB,
        guardianPhone: u.phone,
      }),
    );
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    expect(r.body).not.toContain('POSSIBLE_DUPLICATE');
    expect(await studentOf(a)).toBe(0);
  });

  it('validates the matching inputs strictly (400, nothing created) and refuses callers who may not create students', async () => {
    const a = await account();
    for (const bad of [
      { dateOfBirth: '2005-02-30' },
      { dateOfBirth: '2005-3-4' },
      { dateOfBirth: '04/03/2005' },
      { dateOfBirth: '2999-01-01' },
      { name: '' },
      { name: 'x'.repeat(201) },
      { guardianPhone: 'y'.repeat(31) },
      { duplicateAcknowledgement: 'ABC' },
      { duplicateAcknowledgement: 5 },
      { acknowledge: true },
    ]) {
      const r = await post(body(a, bad));
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await studentOf(a)).toBe(0);
    for (const who of ['faculty', 'hod', 'registrarCampus'] as Who[]) {
      expect((await post(body(a), undefined, who)).statusCode, who).toBe(403);
    }
  });

  it('L2: name and guardianPhone must be JSON strings (no coercion), and a mistyped value can neither create a record nor skip the warning', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const traces = async (a: Account, key: string) => ({
      students: await studentOf(a),
      audits: (
        await adminQuery(
          `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND action = 'student.record.create' AND changes->'userId'->>'new' = $2`,
          [T.orgId, a.id],
        )
      ).length,
      claims: (
        await adminQuery(
          `SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2`,
          [T.orgId, key],
        )
      ).length,
    });
    const a = await account();
    const mistyped: Record<string, unknown>[] = [
      { name: 12345 },
      { name: true },
      { name: null },
      { name: ['Pat'] },
      { name: { first: 'Pat' } },
      { guardianPhone: Number(u.phone) },
      { guardianPhone: false },
      { guardianPhone: null },
      { guardianPhone: [u.phone] },
      { guardianPhone: { number: u.phone } },
    ];
    for (const bad of mistyped) {
      const key = newKey();
      // the other two matching fields are a real duplicate: a coerced value would otherwise reach the matcher
      const r = await post(
        body(a, { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone, ...bad }),
        key,
      );
      expect(r.statusCode, JSON.stringify(bad) + r.body).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
      expect(r.body).not.toContain(u.phone);
      expect(await traces(a, key), JSON.stringify(bad)).toEqual({
        students: 0,
        audits: 0,
        claims: 0,
      });
    }
    // valid strings are unchanged: formatted phone and padded name still reach the matcher (a warning, then 201 with it)
    const warned = await post(
      body(a, {
        name: ` ${u.name} `,
        dateOfBirth: DOB,
        guardianPhone: `+${u.phone.slice(0, 3)} ${u.phone.slice(3)}`,
      }),
    );
    expect(warned.statusCode, warned.body).toBe(409);
    expect(warned.json<{ error: { code: string } }>().error.code).toBe(
      'POSSIBLE_DUPLICATE_STUDENT',
    );
    expect(await studentOf(a)).toBe(0);
    // an omitted optional phone (and an omitted name) is still accepted: the check simply cannot match
    for (const over of [
      { name: u.name, dateOfBirth: DOB },
      { dateOfBirth: DOB, guardianPhone: u.phone },
    ]) {
      const b = await account();
      const r = await post(body(b, over));
      expect(r.statusCode, JSON.stringify(over) + r.body).toBe(201);
      expect(await studentOf(b)).toBe(1);
    }
  });

  it('does not match across tenants', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone, tenant: OTHER });
    const a = await account();
    const r = await post(body(a, { name: u.name, dateOfBirth: DOB, guardianPhone: u.phone }));
    expect(r.statusCode, r.body).toBe(201);
  });
});

describe('import: resupplied matching data, warnings, acknowledgement and the idempotency binding', () => {
  const root = '/api/v1/students/imports';
  type Row = Record<string, string>;
  interface Job {
    id: string;
    status: string;
    summary: Record<string, number>;
    version: number;
  }
  interface RowDto {
    rowNo: number;
    status: string;
    raw: Row;
    normalized: Record<string, unknown> | null;
    errors: { code: string; field?: string; message: string }[];
    warnings: { code: string; field?: string; message: string; relatedRow?: number }[];
  }
  interface Cells {
    dateOfBirth?: string;
    guardianPhone?: string;
  }
  interface Entry extends Cells {
    rowNo: number;
    email: string;
  }
  const rowFor = (a: Account, over: Row = {}): Row => ({
    email: a.email,
    admissionNumber: adm(),
    admissionDate: '2024-07-01',
    ...over,
  });
  const entry = (rowNo: number, a: Account, cells: Cells): Entry => ({
    rowNo,
    email: a.email,
    ...cells,
  });
  async function newJob(rows: Row[], who: Who = 'admin'): Promise<string> {
    const r = await http('POST', who, root, { rows });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<{ data: { id: string } }>().data.id;
  }
  const validateRaw = (id: string, body?: object, who: Who = 'admin') =>
    http('POST', who, `${root}/${id}/validate`, body, { key: null });
  async function validate(id: string, matching?: Entry[]): Promise<Job> {
    const r = await validateRaw(id, matching ? { matching } : undefined);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ data: Job }>().data;
  }
  async function rowsOf(id: string): Promise<RowDto[]> {
    const r = await http('GET', 'admin', `${root}/${id}/rows`);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<{ data: RowDto[] }>().data;
  }
  const getJob = async (id: string): Promise<Job> =>
    (await http('GET', 'admin', `${root}/${id}`)).json<{ data: Job }>().data;
  const commit = (id: string, version: number, body: object, key?: string, via?: FastifyInstance) =>
    http('POST', 'admin', `${root}/${id}/commit`, body, {
      ifMatch: `"${version}"`,
      ...(key ? { key } : {}),
      ...(via ? { via } : {}),
    });
  const REASON = { reason: 'Import approved by the registrar' };
  const studentOf = async (a: Account): Promise<number> =>
    (
      await adminQuery(`SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2`, [
        T.orgId,
        a.id,
      ])
    ).length;
  const code = (r: { body: string }): string => r.body.match(/"code":"([A-Z_]+)"/)?.[1] ?? '';
  const jobRow = async (id: string) =>
    (
      await adminQuery<{
        version: number;
        status: string;
        validation_hash: string;
        mac_bytes: number | null;
        key_id: string | null;
        mac_hex: string | null;
      }>(
        `SELECT version, status, validation_hash, octet_length(match_binding) AS mac_bytes,
                match_binding_key_label AS key_id, encode(match_binding, 'hex') AS mac_hex
           FROM app.import_jobs WHERE id = $1`,
        [id],
      )
    )[0]!;
  /** Everything the import tables and the idempotency store hold for this tenant, as text. */
  const everythingStored = async (): Promise<string> =>
    JSON.stringify(
      await adminQuery(
        `SELECT to_jsonb(r)::text AS j FROM app.import_job_rows r WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(j)::text FROM app.import_jobs j WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(k)::text FROM app.idempotency_keys k WHERE organization_id = $1
         UNION ALL SELECT to_jsonb(e)::text FROM app.audit_events e WHERE organization_id = $1`,
        [T.orgId],
      ),
    );

  it('create refuses the matching-only columns outright and stores nothing', async () => {
    const a = await account();
    const before = (
      await adminQuery(`SELECT 1 FROM app.import_jobs WHERE organization_id = $1`, [T.orgId])
    ).length;
    for (const col of ['dateOfBirth', 'guardianPhone']) {
      for (const path of [root, '/api/v1/faculty/imports']) {
        const r = await http('POST', 'admin', path, { rows: [rowFor(a, { [col]: '2005-03-04' })] });
        expect(r.statusCode, `${path} ${col}`).toBe(400);
        expect(r.body).not.toContain('2005-03-04');
      }
    }
    const after = (
      await adminQuery(`SELECT 1 FROM app.import_jobs WHERE organization_id = $1`, [T.orgId])
    ).length;
    expect(after).toBe(before);
  });

  it('previews the warning without any sensitive or candidate data and persists neither value anywhere', async () => {
    const u = uniq();
    const cand = await candidate({ name: u.name, phone: u.phone });
    const [a, b] = [await account(), await account()];
    const id = await newJob([rowFor(a, { name: ` ${u.name.toUpperCase()} ` }), rowFor(b)]);
    const job = await validate(id, [
      entry(1, a, { dateOfBirth: DOB, guardianPhone: `+${u.phone}` }),
    ]);
    expect(job.status).toBe('VALIDATED');
    expect(job.summary).toMatchObject({
      validRows: 2,
      invalidRows: 0,
      rowsWithWarnings: 1,
      warningCount: 1,
    });
    const rows = await rowsOf(id);
    expect(rows[0]!.warnings).toEqual([
      {
        code: 'POSSIBLE_DUPLICATE_STUDENT',
        message:
          'A student with the same name, date of birth and guardian phone number may already exist.',
      },
    ]);
    expect(rows[1]!.warnings).toEqual([]);
    expect(Object.keys(rows[0]!.raw).sort()).toEqual([
      'admissionDate',
      'admissionNumber',
      'email',
      'name',
    ]);

    const presence = await adminQuery<{ row_no: number; match_presence: number }>(
      'SELECT row_no, match_presence FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no',
      [id],
    );
    expect(presence.map((p) => p.match_presence)).toEqual([3, 0]);

    const report = await http('GET', 'admin', `${root}/${id}/error-report`);
    const visible = JSON.stringify(rows) + report.body + JSON.stringify(job);
    const stored = await everythingStored();
    for (const secret of [DOB, u.phone, cand.studentId, cand.userId, cand.admissionNumber]) {
      expect(visible).not.toContain(secret);
    }
    for (const secret of [DOB, u.phone]) expect(stored).not.toContain(secret);
  });

  it('binds the matching entries to the stored rows and refuses anything else without changing the job', async () => {
    const [a, b] = [await account(), await account()];
    const id = await newJob([rowFor(a), rowFor(b)]);
    const first = await validate(id, [entry(1, a, { dateOfBirth: DOB, guardianPhone: '5551234' })]);
    const cells = { dateOfBirth: DOB, guardianPhone: '5551234' };
    const bad: [string, object, number, string?][] = [
      ['unknown top-level field', { matching: [], extra: 1 }, 400],
      ['not a list', { matching: 'x' }, 400],
      ['unknown row', { matching: [entry(3, a, cells)] }, 400],
      ['row zero', { matching: [entry(0, a, cells)] }, 400],
      ['duplicate row', { matching: [entry(1, a, cells), entry(1, a, cells)] }, 400],
      ['entry with unknown key', { matching: [{ ...entry(1, a, cells), name: 'x' }] }, 400],
      ['entry with no cell', { matching: [{ rowNo: 1, email: a.email }] }, 400],
      ['cell not text', { matching: [{ rowNo: 1, email: a.email, dateOfBirth: 5 }] }, 400],
      ['cell too long', { matching: [entry(1, a, { dateOfBirth: 'x'.repeat(41) })] }, 400],
      ['control character', { matching: [entry(1, a, { guardianPhone: '12\u0000' })] }, 400],
      ['another row’s e-mail', { matching: [entry(1, b, cells)] }, 409, 'IMPORT_MATCHING_MISMATCH'],
      [
        'e-mail of no row',
        { matching: [{ rowNo: 2, email: 'nobody@isolated.test', ...cells }] },
        409,
        'IMPORT_MATCHING_MISMATCH',
      ],
    ];
    for (const [label, body, status, c] of bad) {
      const r = await validateRaw(id, body);
      expect(r.statusCode, label + r.body).toBe(status);
      if (c) expect(code(r), label).toBe(c);
      expect(r.body, label).not.toContain(DOB);
    }
    // case and surrounding space of the e-mail do not matter
    const ok = await validateRaw(id, {
      matching: [{ ...entry(1, a, cells), email: `  ${a.email.toUpperCase()} ` }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    // every refusal left the job exactly as the last successful validation made it
    expect((await jobRow(id)).version).toBe(first.version + 1);
    // employee imports take no matching data
    const emp = await http('POST', 'admin', '/api/v1/faculty/imports', {
      rows: [
        {
          email: a.email,
          employeeCode: `E${adm()}`,
          employeeType: 'FACULTY',
          joiningDate: '2024-06-01',
        },
      ],
    });
    const empId = emp.json<{ data: { id: string } }>().data.id;
    const r = await http(
      'POST',
      'admin',
      `/api/v1/faculty/imports/${empId}/validate`,
      { matching: [entry(1, a, cells)] },
      { key: null },
    );
    expect(r.statusCode).toBe(400);
  });

  it('the same inputs give the same result and hash; validation, preview and report stay free of the values', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    await validate(id, m);
    const h1 = (await jobRow(id)).validation_hash;
    const r1 = JSON.stringify(await rowsOf(id));
    await validate(id, [{ ...m[0]!, guardianPhone: `(${u.phone})` }]); // same digits, other formatting
    expect((await jobRow(id)).validation_hash).toBe(h1);
    expect(JSON.stringify(await rowsOf(id))).toBe(r1);
  });

  it('refuses a commit without the acknowledgement, then commits with it; an equivalent retry replays, a different one conflicts, and nothing persists a value', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const { version } = await validate(id, m);

    const refused = await commit(id, version, { ...REASON, matching: m });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('IMPORT_WARNINGS_UNACKNOWLEDGED');
    expect(await studentOf(a)).toBe(0);

    const key = newKey();
    const body = { ...REASON, acknowledgeWarnings: true, matching: m };
    const ok = await commit(id, version, body, key);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await studentOf(a)).toBe(1);

    // same key, equivalent matching data (the phone only formatted differently, entry e-mail in other case): a replay
    for (const retry of [
      [{ ...m[0]!, guardianPhone: `+(${u.phone})` }],
      [{ ...m[0]!, email: a.email.toUpperCase(), dateOfBirth: ` ${DOB} ` }],
    ]) {
      const r = await commit(id, version, { ...body, matching: retry }, key);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(r.body).toBe(ok.body);
    }
    expect(await studentOf(a)).toBe(1);

    // same key, materially different matching data: the idempotency conflict, never a replay. Changed values with
    // UNCHANGED presence (other date, other phone) and every presence change alike.
    const mac = (await jobRow(id)).mac_hex!;
    for (const changed of [
      [entry(1, a, { dateOfBirth: '2005-03-05', guardianPhone: u.phone })],
      [entry(1, a, { dateOfBirth: DOB, guardianPhone: `${u.phone}1` })],
      [entry(1, a, { dateOfBirth: DOB })],
      [entry(1, a, { guardianPhone: u.phone })],
      [] as Entry[],
      undefined,
    ]) {
      const r = await commit(
        id,
        version,
        { ...REASON, acknowledgeWarnings: true, ...(changed ? { matching: changed } : {}) },
        key,
      );
      expect(r.statusCode, JSON.stringify(changed)).toBe(422);
      expect(code(r)).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(r.headers['idempotent-replayed']).toBeUndefined();
      // safe error: fixed text, no value, no MAC
      for (const secret of [DOB, '2005-03-05', u.phone, mac]) expect(r.body).not.toContain(secret);
    }
    expect(await studentOf(a)).toBe(1);
    // a new key on a finished job is not a retry
    const again = await commit(id, version, body);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('IMPORT_JOB_COMMITTED');

    // what is kept: a 32-byte HMAC under the named key, and no value or unkeyed digest anywhere (import tables,
    // idempotency store, audit)
    const job = await jobRow(id);
    expect(job).toMatchObject({ status: 'COMMITTED', mac_bytes: 32, key_id: 'k1' });
    const stored = await everythingStored();
    for (const secret of [DOB, u.phone]) expect(stored).not.toContain(secret);
    for (const guess of [
      JSON.stringify([[1, DOB, u.phone]]),
      `${DOB}${u.phone}`,
      `${DOB}|${u.phone}`,
      `${DOB}\n${u.phone}`,
      u.phone,
      DOB,
    ]) {
      for (const algo of ['sha256', 'sha1', 'md5']) {
        expect(stored).not.toContain(createHash(algo).update(guess).digest('hex'));
      }
    }
    expect(stored).not.toContain('$argon2');
    for (const k of [K1, K2, Buffer.from(K1, 'base64url').toString('hex')]) {
      expect(stored).not.toContain(k);
    }
    const audit = await adminQuery<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'import_job.commit'`,
      [T.orgId, id],
    );
    expect(audit[0]!.metadata).toMatchObject({
      acknowledgedWarnings: true,
      duplicateWarningRows: 1,
      matchingRowsSupplied: 1,
    });
  });

  it('a commit whose matching data is omitted, added or relocated is refused without touching the stored preview', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const [a, b] = [await account(), await account()];
    const id = await newJob([rowFor(a, { name: u.name }), rowFor(b)]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const { version } = await validate(id, m);
    const snapshot = async () =>
      JSON.stringify(
        await adminQuery(
          'SELECT row_no, status, normalized, errors, warnings, match_presence, version FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no',
          [id],
        ),
      ) + JSON.stringify(await jobRow(id));
    const before = await snapshot();
    const ack = { ...REASON, acknowledgeWarnings: true };
    const variants: [string, Entry[] | undefined][] = [
      ['omitted', undefined],
      ['empty', []],
      ['phone dropped', [entry(1, a, { dateOfBirth: DOB })]],
      [
        'extra cell',
        [
          entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone }),
          entry(2, b, { dateOfBirth: DOB }),
        ],
      ],
      ['moved to the other row', [entry(2, b, { dateOfBirth: DOB, guardianPhone: u.phone })]],
    ];
    for (const [label, matching] of variants) {
      const r = await commit(id, version, { ...ack, ...(matching ? { matching } : {}) });
      expect(r.statusCode, label + r.body).toBe(409);
      expect(code(r), label).toBe('IMPORT_MATCHING_MISMATCH');
    }
    expect(await snapshot()).toBe(before);
    expect(await studentOf(a)).toBe(0);
    expect(await studentOf(b)).toBe(0);
  });

  it('data that changes the warning set is answered with a refreshed preview and cannot use the old acknowledgement', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const { version } = await validate(id, [
      entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone }),
    ]);
    // same presence, another date of birth: the duplicate disappears
    const r = await commit(id, version, {
      ...REASON,
      acknowledgeWarnings: true,
      matching: [entry(1, a, { dateOfBirth: '2005-03-05', guardianPhone: u.phone })],
    });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('IMPORT_PREVIEW_CHANGED');
    expect(await studentOf(a)).toBe(0);
    const j = await getJob(id);
    expect(j.version).toBeGreaterThan(version);
    expect(j.summary.rowsWithWarnings).toBe(0);
    // the old version is dead
    expect(
      (
        await commit(id, version, {
          ...REASON,
          acknowledgeWarnings: true,
          matching: [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })],
        })
      ).statusCode,
    ).toBe(409);
  });

  it('a record that becomes a duplicate after the preview changes the result and needs a fresh acknowledgement', async () => {
    const u = uniq();
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const v1 = await validate(id, m);
    expect(v1.summary.rowsWithWarnings).toBe(0);
    await candidate({ name: u.name, phone: u.phone });
    const stale = await commit(id, v1.version, {
      ...REASON,
      acknowledgeWarnings: true,
      matching: m,
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('IMPORT_PREVIEW_CHANGED');
    expect(await studentOf(a)).toBe(0);
    const j = await getJob(id);
    expect(j.summary.rowsWithWarnings).toBe(1);
    expect(code(await commit(id, j.version, { ...REASON, matching: m }))).toBe(
      'IMPORT_WARNINGS_UNACKNOWLEDGED',
    );
    expect(
      (await commit(id, j.version, { ...REASON, acknowledgeWarnings: true, matching: m }))
        .statusCode,
    ).toBe(200);
    expect(await studentOf(a)).toBe(1);
  });

  it('flags only complete matches: existing records, missing values and other values', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const noDobCand = uniq();
    await candidate({ name: noDobCand.name, phone: noDobCand.phone, dob: null });
    const accounts = await Promise.all(Array.from({ length: 8 }, () => account()));
    const rows = [
      rowFor(accounts[0]!, { name: `  ${u.name.toLowerCase()}  ` }),
      rowFor(accounts[1]!, { name: u.name }),
      rowFor(accounts[2]!, { name: u.name }),
      rowFor(accounts[3]!, { name: u.name }),
      rowFor(accounts[4]!, { name: `${u.name} Jr` }),
      rowFor(accounts[5]!, { name: u.name }),
      rowFor(accounts[6]!),
      rowFor(accounts[7]!, { name: noDobCand.name }),
    ];
    const id = await newJob(rows);
    const A = accounts;
    const job = await validate(id, [
      entry(1, A[0]!, { dateOfBirth: DOB, guardianPhone: `(${u.phone})` }), // match
      entry(2, A[1]!, { guardianPhone: u.phone }), // no date of birth
      entry(3, A[2]!, { dateOfBirth: DOB, guardianPhone: '---' }), // unusable phone
      entry(4, A[3]!, { dateOfBirth: '2005-03-05', guardianPhone: u.phone }), // other date
      entry(5, A[4]!, { dateOfBirth: DOB, guardianPhone: u.phone }), // other name
      entry(6, A[5]!, { dateOfBirth: DOB, guardianPhone: `${u.phone}0` }), // other phone
      entry(7, A[6]!, { dateOfBirth: DOB, guardianPhone: u.phone }), // no name
      entry(8, A[7]!, { dateOfBirth: DOB, guardianPhone: noDobCand.phone }), // candidate has no date of birth
    ]);
    expect(job.summary).toMatchObject({ validRows: 8, rowsWithWarnings: 1 });
    expect((await rowsOf(id)).map((r) => r.warnings.length)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('warns about rows of the same file that match each other: once per row, against the first row, deterministically', async () => {
    const u = uniq();
    const other = uniq();
    const A = await Promise.all(Array.from({ length: 6 }, () => account()));
    const rows = [
      rowFor(A[0]!, { name: u.name }), // 1: anchor
      rowFor(A[1]!, { name: `  ${u.name.toUpperCase()} ` }), // 2: matches 1
      rowFor(A[2]!, { name: u.name }), // 3: matches 1 (not 2)
      rowFor(A[3]!, { name: u.name }), // 4: other date of birth
      rowFor(A[4]!, { name: other.name }), // 5: other name
      rowFor(A[5]!, { name: u.name }), // 6: missing phone
    ];
    const m = [
      entry(1, A[0]!, { dateOfBirth: DOB, guardianPhone: u.phone }),
      entry(2, A[1]!, { dateOfBirth: DOB, guardianPhone: `+${u.phone}` }),
      entry(3, A[2]!, { dateOfBirth: DOB, guardianPhone: u.phone.replace(/(\d{3})/, '$1 ') }),
      entry(4, A[3]!, { dateOfBirth: '2005-03-05', guardianPhone: u.phone }),
      entry(5, A[4]!, { dateOfBirth: DOB, guardianPhone: u.phone }),
      entry(6, A[5]!, { dateOfBirth: DOB }),
    ];
    const id = await newJob(rows);
    const job = await validate(id, m);
    expect(job.status).toBe('VALIDATED');
    const out = (await rowsOf(id)).map((r) => r.warnings);
    const inFile = {
      code: 'POSSIBLE_DUPLICATE_IN_FILE',
      message:
        'An earlier row of this file has the same name, date of birth and guardian phone number.',
      relatedRow: 1,
    };
    expect(out).toEqual([[], [inFile], [inFile], [], [], []]);
    expect(job.summary).toMatchObject({ rowsWithWarnings: 2, warningCount: 2 });
    // repeating the validation, in any entry order, changes nothing
    const hash = (await jobRow(id)).validation_hash;
    await validate(id, [...m].reverse());
    expect((await jobRow(id)).validation_hash).toBe(hash);
    expect((await rowsOf(id)).map((r) => r.warnings)).toEqual(out);
    // the acknowledgement is required, and the pair carries no value
    const v = (await getJob(id)).version;
    expect(code(await commit(id, v, { ...REASON, matching: m }))).toBe(
      'IMPORT_WARNINGS_UNACKNOWLEDGED',
    );
    const done = await commit(id, v, { ...REASON, acknowledgeWarnings: true, matching: m });
    expect(done.statusCode, done.body).toBe(200);
    for (const acc of A) expect(await studentOf(acc)).toBe(1);
    expect(JSON.stringify(out)).not.toContain(DOB);
  });

  it('reordering the file reorders the anchor, and an existing duplicate plus a file duplicate are both reported', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const [a, b] = [await account(), await account()];
    const id = await newJob([rowFor(b, { name: u.name }), rowFor(a, { name: u.name })]);
    await validate(id, [
      entry(1, b, { dateOfBirth: DOB, guardianPhone: u.phone }),
      entry(2, a, { dateOfBirth: DOB, guardianPhone: u.phone }),
    ]);
    const rows = await rowsOf(id);
    expect(rows[0]!.warnings.map((w) => w.code)).toEqual(['POSSIBLE_DUPLICATE_STUDENT']);
    expect(rows[1]!.warnings.map((w) => w.code)).toEqual([
      'POSSIBLE_DUPLICATE_IN_FILE',
      'POSSIBLE_DUPLICATE_STUDENT',
    ]);
    expect(rows[1]!.warnings[0]!.relatedRow).toBe(1);
  });

  it('rejects an invalid or future date of birth as a row error that never echoes the value', async () => {
    const accounts = await Promise.all(Array.from({ length: 5 }, () => account()));
    const bad = ['2005-02-30', '2005-3-4', '04/03/2005', '2999-01-01', '1899-12-31'];
    const id = await newJob(accounts.map((a) => rowFor(a)));
    const r = await validateRaw(id, {
      matching: accounts.map((a, i) => entry(i + 1, a, { dateOfBirth: bad[i]! })),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<{ data: Job }>().data.status).toBe('DRAFT');
    for (const [i, row] of (await rowsOf(id)).entries()) {
      expect(row.status).toBe('INVALID');
      expect(row.errors).toEqual([
        {
          code: 'INVALID_DATE',
          field: 'dateOfBirth',
          message: 'Must be a real calendar date in the past, YYYY-MM-DD.',
        },
      ]);
      expect(JSON.stringify(row)).not.toContain(bad[i]!);
    }
  });

  it('keeps exact admission-number conflicts hard errors and rolls the whole commit back when a row fails', async () => {
    const u = uniq();
    const cand = await candidate({ name: u.name, phone: u.phone });
    const [a, b, c] = [await account(), await account(), await account()];
    const hard = await newJob([rowFor(a, { admissionNumber: cand.admissionNumber, name: u.name })]);
    expect(
      (await validate(hard, [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })])).status,
    ).toBe('DRAFT');
    expect((await rowsOf(hard))[0]!.errors.map((e) => e.code)).toContain('ADMISSION_NUMBER_EXISTS');
    // admission numbers stay case-sensitive
    const ci = await newJob([rowFor(c, { admissionNumber: cand.admissionNumber.toLowerCase() })]);
    expect((await validate(ci)).status).toBe('VALIDATED');

    const second = rowFor(b);
    const dupAcct = await account();
    const id = await newJob([rowFor(dupAcct, { name: u.name }), second]);
    const m = [entry(1, dupAcct, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const v = await validate(id, m);
    const taker = await account();
    await adminQuery(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status) VALUES ($1, $2, $3, $4, '2024-07-01', 'ACTIVE')`,
      [uuidv7(), T.orgId, taker.id, second.admissionNumber],
    );
    const before = (
      await adminQuery(`SELECT 1 FROM app.students WHERE organization_id = $1`, [T.orgId])
    ).length;
    const r = await commit(id, v.version, { ...REASON, acknowledgeWarnings: true, matching: m });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe('IMPORT_COMMIT_CONFLICT');
    expect(
      (await adminQuery(`SELECT 1 FROM app.students WHERE organization_id = $1`, [T.orgId])).length,
    ).toBe(before);
    expect((await getJob(id)).status).toBe('FAILED');
    expect(await everythingStored()).not.toContain(u.phone);
  });

  it('two concurrent commits of one job create the records once: the same key replays, overlapping jobs conflict', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const [a, b] = [await account(), await account()];
    const make = async () => {
      const id = await newJob([rowFor(a, { name: u.name }), rowFor(b)]);
      const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
      return { id, m, version: (await validate(id, m)).version };
    };
    const one = await make();
    const key = newKey();
    const body = { ...REASON, acknowledgeWarnings: true, matching: one.m };
    const same = await Promise.all([
      commit(one.id, one.version, body, key),
      commit(one.id, one.version, body, key),
    ]);
    // the loser waits on the job lock, then finds the stored answer and its equal HMAC binding: a replay
    expect(same.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(same.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(1);
    expect(await studentOf(a)).toBe(1);
    expect(await studentOf(b)).toBe(1);
    // overlapping jobs for the same accounts: exactly one wins, the loser creates nothing
    const [c, d] = [await account(), await account()];
    const jobs = await Promise.all(
      [0, 1].map(async () => {
        const id = await newJob([rowFor(c), rowFor(d)]);
        return { id, version: (await validate(id)).version };
      }),
    );
    const race = await Promise.all(jobs.map((j) => commit(j.id, j.version, REASON)));
    expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await studentOf(c)).toBe(1);
    expect(await studentOf(d)).toBe(1);
  });

  it('F1: malformed or mistyped commit-time matching data is a 400 that leaves a validated job, records, idempotency and audit unchanged', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const { version } = await validate(id, m);
    const state = async () =>
      JSON.stringify(
        await adminQuery(
          `SELECT row_no, status, normalized, errors, warnings, match_presence FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no`,
          [id],
        ),
      ) +
      JSON.stringify(await jobRow(id)) +
      JSON.stringify(
        await adminQuery(
          `SELECT action FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY action`,
          [T.orgId, id],
        ),
      );
    const before = await state();
    const bad: [string, Record<string, unknown>][] = [
      ['non-padded date', { dateOfBirth: '2005-3-4' }],
      ['impossible date', { dateOfBirth: '2005-02-30' }],
      ['future date', { dateOfBirth: '2999-01-01' }],
      ['other format', { dateOfBirth: '04/03/2005' }],
      ['full-width digits', { dateOfBirth: '２００５-03-04' }],
      ['number date', { dateOfBirth: 20050304 }],
      ['boolean date', { dateOfBirth: true }],
      ['null date', { dateOfBirth: null }],
      ['over-long phone', { guardianPhone: '1'.repeat(31) }],
      ['number phone', { guardianPhone: 919876543210 }],
      ['string row number', { rowNo: '1' }],
      ['number e-mail', { email: 5 }],
    ];
    for (const [label, over] of bad) {
      const key = newKey();
      const r = await commit(
        id,
        version,
        { ...REASON, acknowledgeWarnings: true, matching: [{ ...m[0]!, ...over }] },
        key,
      );
      expect(r.statusCode, label + r.body).toBe(400);
      expect(code(r), label).toBe('VALIDATION_ERROR');
      // no echo of a value (a short value like '1' would also match the request id, so only distinctive ones are checked)
      for (const v of Object.values(over)) {
        if (String(v).length >= 6) expect(r.body, label).not.toContain(String(v));
      }
      // no claim of the key survives
      const claims = await adminQuery(
        `SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2`,
        [T.orgId, key],
      );
      expect(claims, label).toHaveLength(0);
    }
    expect(await state()).toBe(before);
    expect((await getJob(id)).status).toBe('VALIDATED');
    expect(await studentOf(a)).toBe(0);

    // the validate route reads the same JSON the same way: wrong types are a 400 there too...
    for (const over of [{ dateOfBirth: 20050304 }, { rowNo: '1' }, { guardianPhone: 5 }]) {
      const r = await validateRaw(id, { matching: [{ ...m[0]!, ...over }] });
      expect(r.statusCode, JSON.stringify(over)).toBe(400);
    }
    expect(await state()).toBe(before);
    // ...while a malformed TEXT date stays row-level feedback in the preview, as before
    const fb = await validate(id, [{ ...m[0]!, dateOfBirth: '2005-3-4' }]);
    expect(fb.status).toBe('DRAFT');
    expect((await rowsOf(id))[0]!.errors.map((e) => e.code)).toEqual(['INVALID_DATE']);
    // and the job remains fully usable
    const again = await validate(id, m);
    const ok = await commit(id, again.version, {
      ...REASON,
      acknowledgeWarnings: true,
      matching: m,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await studentOf(a)).toBe(1);
  });

  it('L1: acknowledgeWarnings must be a JSON boolean; coercible look-alikes are a 400 and cannot acknowledge a warning', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    const m = [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })];
    const { version, summary } = await validate(id, m);
    expect(summary.rowsWithWarnings).toBe(1);
    const state = async () =>
      JSON.stringify(
        await adminQuery(
          `SELECT row_no, status, normalized, errors, warnings, match_presence FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no`,
          [id],
        ),
      ) +
      JSON.stringify(await jobRow(id)) +
      JSON.stringify(
        await adminQuery(
          `SELECT action FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY action`,
          [T.orgId, id],
        ),
      );
    const before = await state();
    for (const value of ['true', 'false', 1, 0, null, 'yes', [], {}]) {
      const key = newKey();
      const r = await commit(
        id,
        version,
        { ...REASON, acknowledgeWarnings: value, matching: m },
        key,
      );
      expect(r.statusCode, JSON.stringify(value) + r.body).toBe(400);
      expect(code(r), JSON.stringify(value)).toBe('VALIDATION_ERROR');
      const claims = await adminQuery(
        `SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2`,
        [T.orgId, key],
      );
      expect(claims, JSON.stringify(value)).toHaveLength(0);
    }
    expect(await state()).toBe(before);
    // false and omission keep the established meaning: not acknowledged, so the warning blocks the commit
    for (const ack of [{ acknowledgeWarnings: false }, {}]) {
      const r = await commit(id, version, { ...REASON, ...ack, matching: m });
      expect(r.statusCode, JSON.stringify(ack)).toBe(409);
      expect(code(r)).toBe('IMPORT_WARNINGS_UNACKNOWLEDGED');
    }
    expect(await state()).toBe(before);
    expect(await studentOf(a)).toBe(0);
    // only a real JSON true acknowledges
    const ok = await commit(id, version, { ...REASON, acknowledgeWarnings: true, matching: m });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await studentOf(a)).toBe(1);
  });

  it('F4: a phone without digits is absent for presence, exactly as for the MAC and the matcher', async () => {
    const [a, b, c] = [await account(), await account(), await account()];
    const id = await newJob([rowFor(a), rowFor(b), rowFor(c)]);
    const presence = async () =>
      (
        await adminQuery<{ match_presence: number }>(
          'SELECT match_presence FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no',
          [id],
        )
      ).map((p) => p.match_presence);
    const validated = [
      entry(1, a, { dateOfBirth: DOB, guardianPhone: '---' }), // punctuation-only phone: absent
      entry(2, b, { guardianPhone: ' ( ) - ' }), // only cell is digit-free: the row has no matching data
      entry(3, c, { dateOfBirth: DOB, guardianPhone: ' +91 98765-43210 ' }), // ordinary formatting, surrounding space
    ];
    const { version } = await validate(id, validated);
    expect(await presence()).toEqual([1, 0, 3]);

    // equivalent data in another spelling passes the presence check and commits
    const equivalent = [
      entry(1, a, { dateOfBirth: DOB }),
      entry(3, c, { dateOfBirth: DOB, guardianPhone: '919876543210' }),
    ];
    // a REAL presence change is refused before anything happens
    for (const changed of [
      [entry(1, a, { dateOfBirth: DOB, guardianPhone: '5551234' }), equivalent[1]!],
      [equivalent[0]!, entry(3, c, { dateOfBirth: DOB })],
      [...equivalent, entry(2, b, { guardianPhone: '5551234' })],
    ]) {
      const r = await commit(id, version, { ...REASON, matching: changed });
      expect(r.statusCode, JSON.stringify(changed) + r.body).toBe(409);
      expect(code(r)).toBe('IMPORT_MATCHING_MISMATCH');
    }
    const key = newKey();
    const ok = await commit(id, version, { ...REASON, matching: equivalent }, key);
    expect(ok.statusCode, ok.body).toBe(200);

    // the same key with the original punctuation spelling: same canonical data, so the established replay
    const replay = await commit(id, version, { ...REASON, matching: validated }, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // the same key with changed matching data still never succeeds
    for (const changed of [
      [entry(1, a, { dateOfBirth: DOB, guardianPhone: '5551234' }), equivalent[1]!],
      [equivalent[0]!, entry(3, c, { dateOfBirth: DOB })],
      [equivalent[0]!, entry(3, c, { dateOfBirth: DOB, guardianPhone: '919876543211' })],
    ]) {
      const r = await commit(id, version, { ...REASON, matching: changed }, key);
      expect(r.statusCode, JSON.stringify(changed)).toBe(422);
      expect(code(r)).toBe('IDEMPOTENCY_KEY_REUSED');
    }
  });

  it('fails closed without the HMAC key, and rotation verifies with the stored key ID', async () => {
    const u = uniq();
    const [a, b, c] = [await account(), await account(), await account()];
    const make = async (acc: Account, cells?: Cells) => {
      const id = await newJob([rowFor(acc, { name: u.name })]);
      const m = cells ? [entry(1, acc, cells)] : undefined;
      return { id, m, version: (await validate(id, m)).version };
    };
    const cells = { dateOfBirth: DOB, guardianPhone: u.phone };

    // no ring: a commit with matching data is refused before anything happens (no downgrade to presence or a digest)
    const j1 = await make(a, cells);
    const before = await jobRow(j1.id);
    const refused = await commit(
      j1.id,
      j1.version,
      { ...REASON, matching: j1.m },
      undefined,
      noKeyApp,
    );
    expect(refused.statusCode, refused.body).toBe(503);
    expect(code(refused)).toBe('IMPORT_MATCHING_UNAVAILABLE');
    for (const secret of [DOB, u.phone, K1]) expect(refused.body).not.toContain(secret);
    expect(await studentOf(a)).toBe(0);
    expect(await jobRow(j1.id)).toEqual(before);
    // ...while a commit without matching data needs no key
    const j0 = await make(c);
    expect((await commit(j0.id, j0.version, REASON, undefined, noKeyApp)).statusCode).toBe(200);
    expect((await jobRow(j0.id)).mac_bytes).toBeNull();

    // commit under k1, then retry the same key across the rotation
    const key = newKey();
    const body = { ...REASON, matching: j1.m };
    expect((await commit(j1.id, j1.version, body, key)).statusCode).toBe(200);
    expect((await jobRow(j1.id)).key_id).toBe('k1');
    const replay = await commit(j1.id, j1.version, body, key, rotatedApp); // k2 active, k1 retiring
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const changed = { ...REASON, matching: [entry(1, a, { ...cells, dateOfBirth: '2005-03-05' })] };
    expect(code(await commit(j1.id, j1.version, changed, key, rotatedApp))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // k1 removed too early, or no ring at all: the binding cannot be checked, so no replay and no guess (503)
    for (const via of [retiredApp, noKeyApp]) {
      const r = await commit(j1.id, j1.version, body, key, via);
      expect(r.statusCode, r.body).toBe(503);
      expect(code(r)).toBe('IMPORT_MATCHING_UNAVAILABLE');
      expect(r.headers['idempotent-replayed']).toBeUndefined();
    }
    // a retry WITHOUT matching data against a bound commit is decidable without any key: a conflict
    expect(code(await commit(j1.id, j1.version, REASON, key, noKeyApp))).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    // new bindings use the new active key
    const j2 = await make(b, cells);
    expect(
      (await commit(j2.id, j2.version, { ...REASON, matching: j2.m }, undefined, rotatedApp))
        .statusCode,
    ).toBe(200);
    expect(await jobRow(j2.id)).toMatchObject({ key_id: 'k2', mac_bytes: 32 });
    expect(await studentOf(a)).toBe(1);
    expect(await studentOf(b)).toBe(1);
  });

  it('does not match across tenants, and only organization-scoped import holders can run it', async () => {
    const u = uniq();
    await candidate({ name: u.name, phone: u.phone, tenant: OTHER });
    const a = await account();
    const id = await newJob([rowFor(a, { name: u.name })]);
    expect(
      (await validate(id, [entry(1, a, { dateOfBirth: DOB, guardianPhone: u.phone })])).summary
        .rowsWithWarnings,
    ).toBe(0);
    expect((await http('POST', 'registrarOrg', root, { rows: [rowFor(a)] })).statusCode).toBe(201);
    for (const who of ['registrarCampus', 'hod', 'faculty'] as Who[]) {
      expect((await http('POST', who, root, { rows: [rowFor(a)] })).statusCode, who).toBe(403);
    }
    // another administrator cannot validate someone else's job, with or without matching data
    const r = await validateRaw(
      id,
      { matching: [entry(1, a, { dateOfBirth: DOB })] },
      'registrarOrg',
    );
    expect(r.statusCode).toBe(404);
  });
});
