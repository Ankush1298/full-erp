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
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Milestone 2 acceptance rehearsal (B6), against the disposable PostgreSQL harness only. One private tenant goes through the
// integrated chain at the size of the M2 "Done" criterion (doc 04 Part 16): 120 people are invited and accept (fake
// in-memory mailer, no e-mail leaves the process), 100 are imported as students and 20 as faculty through the import
// framework, the students are placed in two departments, an imported faculty member is made HOD of one department, and
// the directory, profiles, suspension and tenant isolation are checked over HTTP. Org-structure rows (department,
// period type, program, cohort) are fixtures inserted as the harness superuser, as in the other integration files.
// Every assertion is about rows this file created.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const NEW_PASSWORD = /* secret-scan:allow */ 'Acceptance-Passw0rd-2026';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const STUDENTS = 100;
const FACULTY = 20;
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const mailer = new InMemoryInvitationMailer();
const big = () => new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 1_000 });
const KEY = randomBytes(32).toString('base64url'); // generated per run; no key is committed
const app = buildApp({
  config: loadConfig({
    DATABASE_URL: url,
    APP_ORIGINS: APP_ORIGIN,
    CURSOR_KEYS: `k1:${KEY}`,
    CURSOR_ACTIVE_KEY_ID: 'k1',
    STUDENT_DIRECTORY_LIST_ENABLED: 'true',
  }),
  db,
  logger: false,
  invitationMailer: mailer,
  inviteLimiter: big(),
  acceptInviteLimiter: big(),
  directoryLimiter: big(),
});

interface Session {
  cookie: string;
  csrf: string;
}
let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let slug = '';
let admin!: Session;
let foreignAdmin!: Session;
let kseq = 0;
const key = (): string => `k${RUN}${(kseq++).toString(36).padStart(12, '0')}`;
const emailOf = (kind: 's' | 'f', i: number): string =>
  `acc-${kind}${i}.${RUN.toLowerCase()}@acceptance.test`;
const admissionOf = (i: number): string => `ACC${RUN}${String(i).padStart(3, '0')}`;

let deptB = '';
let PERIOD = '';
const places = {} as Record<'A' | 'B', { dept: string; program: string; cohort: string }>;
/** student id by admission number, for the 100 imported students */
const studentIds = new Map<string, string>();
/** user id by e-mail, for all 120 accepted invitations */
const userIds = new Map<string, string>();

async function login(address: string, pw = PASSWORD): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: address, password: pw, ...(slug ? { tenant: slug } : {}) },
  });
  expect(r.statusCode, address).toBe(200);
  return {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}
function call(
  method: 'GET' | 'POST' | 'PATCH',
  s: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: s ? { session_token: s.cookie } : {},
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN }),
      ...(s && method !== 'GET' ? { 'x-csrf-token': s.csrf } : {}),
      ...headers,
    },
  });
}
const errCode = (r: { json: <X>() => X }): string =>
  r.json<{ error: { code: string } }>().error.code;

async function mkPlace(dept: string): Promise<{ dept: string; program: string; cohort: string }> {
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Acceptance program', $5, 'UG', 8)`,
    [program, T.orgId, dept, PERIOD, `P${RUN}${dept.slice(-4)}`.slice(0, 20)],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2026, 'Acceptance cohort')`,
    [cohort, T.orgId, program],
  );
  return { dept, program, cohort };
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  slug = (
    await adminQuery<{ slug: string }>('SELECT slug FROM app.organizations WHERE id = $1', [
      T.orgId,
    ])
  )[0]!.slug;
  admin = await login(T.emails.admin);
  await elevateSession(admin.cookie); // CRITICAL routes (grant, suspend) need a fresh PASSWORD_MFA step-up
  const otherSlug = slug;
  slug = '';
  foreignAdmin = await login(OTHER.emails.admin);
  slug = otherSlug;

  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  deptB = uuidv7();
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Acceptance dept B', $4)`,
    [deptB, T.orgId, T.campusId, `B${RUN}`],
  );
  places.A = await mkPlace(T.departmentId);
  places.B = await mkPlace(deptB);
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'student_program_events',
      'student_programs',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

describe('acceptance: onboarding 120 people by invitation (fake mailer)', () => {
  it('invites 100 students and 20 faculty; each accepts once with the delivered token; nothing else is sent', async () => {
    const addresses = [
      ...Array.from({ length: STUDENTS }, (_, i) => emailOf('s', i)),
      ...Array.from({ length: FACULTY }, (_, i) => emailOf('f', i)),
    ];
    for (const address of addresses) {
      const r = await call(
        'POST',
        admin,
        '/api/v1/users/invite',
        {
          email: address,
          displayName: `Acceptance ${address.split('.')[0]}`,
          reason: 'B6 onboarding',
        },
        { 'idempotency-key': key() },
      );
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json<{ data: { delivery: string } }>().data.delivery).toBe('SENT');
    }
    const sent = mailer.sent.filter((m) => addresses.includes(m.to));
    expect(sent).toHaveLength(addresses.length);
    // The token never appears in the serialised mail.
    expect(JSON.stringify(sent)).not.toMatch(/[A-Za-z0-9_-]{43}/);

    for (const m of sent) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/accept-invite',
        payload: { token: m.revealToken(), password: NEW_PASSWORD },
        headers: { origin: APP_ORIGIN },
      });
      expect(r.statusCode, m.to).toBe(200);
    }
    // Single use: replaying the first token is the generic 400.
    const first = sent[0]!;
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/accept-invite',
      payload: { token: first.revealToken(), password: NEW_PASSWORD },
      headers: { origin: APP_ORIGIN },
    });
    expect(replay.statusCode).toBe(400);
    expect(errCode(replay)).toBe('INVALID_INVITATION');

    const rows = await adminQuery<{ id: string; email: string; status: string }>(
      'SELECT id, email, status FROM app.users WHERE organization_id = $1 AND email = ANY($2::text[])',
      [T.orgId, addresses],
    );
    expect(rows).toHaveLength(addresses.length);
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    for (const r of rows) userIds.set(r.email, r.id);
    // Acceptance grants no role.
    const roles = await adminQuery(
      'SELECT 1 FROM app.role_assignments WHERE organization_id = $1 AND user_id = ANY($2::uuid[])',
      [T.orgId, rows.map((r) => r.id)],
    );
    expect(roles).toEqual([]);
  }, 600_000);
});

describe('acceptance: importing 100 students and 20 faculty (validate, preview, commit)', () => {
  async function runImport(mount: 'students' | 'faculty', rows: Record<string, string>[]) {
    const root = `/api/v1/${mount}/imports`;
    const created = await call('POST', admin, root, { rows }, { 'idempotency-key': key() });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ data: { id: string } }>().data.id;
    const v = await call('POST', admin, `${root}/${id}/validate`);
    expect(v.statusCode, v.body).toBe(200);
    const job = v.json<{ data: { status: string; rowCount: number; version: number } }>().data;
    expect(job).toMatchObject({ status: 'VALIDATED', rowCount: rows.length });
    const c = await call(
      'POST',
      admin,
      `${root}/${id}/commit`,
      { reason: 'B6 acceptance import' },
      { 'idempotency-key': key(), 'if-match': `"${job.version}"` },
    );
    expect(c.statusCode, c.body).toBe(200);
    return id;
  }

  it('commits exactly 100 student records', async () => {
    await runImport(
      'students',
      Array.from({ length: STUDENTS }, (_, i) => ({
        email: emailOf('s', i),
        admissionNumber: admissionOf(i),
        admissionDate: '2026-07-01',
      })),
    );
    const rows = await adminQuery<{ id: string; admission_number: string }>(
      `SELECT id, admission_number FROM app.students WHERE organization_id = $1 AND admission_number LIKE $2`,
      [T.orgId, `ACC${RUN}%`],
    );
    expect(rows).toHaveLength(STUDENTS);
    for (const r of rows) studentIds.set(r.admission_number, r.id);
  }, 300_000);

  it('commits exactly 20 faculty employee records', async () => {
    await runImport(
      'faculty',
      Array.from({ length: FACULTY }, (_, i) => ({
        email: emailOf('f', i),
        employeeCode: `F${RUN}${i}`,
        employeeType: 'FACULTY',
        joiningDate: '2026-06-01',
      })),
    );
    const rows = await adminQuery(
      `SELECT 1 FROM app.employees WHERE organization_id = $1 AND employee_code LIKE $2`,
      [T.orgId, `F${RUN}%`],
    );
    expect(rows).toHaveLength(FACULTY);
    // A student account cannot also become an employee (person-identity invariant).
    const dup = await call(
      'POST',
      admin,
      '/api/v1/faculty/imports',
      {
        rows: [
          {
            email: emailOf('s', 0),
            employeeCode: `X${RUN}`,
            employeeType: 'FACULTY',
            joiningDate: '2026-06-01',
          },
        ],
      },
      { 'idempotency-key': key() },
    );
    expect(dup.statusCode).toBe(201);
    const id = dup.json<{ data: { id: string } }>().data.id;
    const v = await call('POST', admin, `/api/v1/faculty/imports/${id}/validate`);
    expect(v.json<{ data: { status: string } }>().data.status).not.toBe('VALIDATED');
  }, 300_000);
});

describe('acceptance: placement, HOD visibility and tenant isolation', () => {
  let hod!: Session;
  const inA = (i: number) => i < STUDENTS / 2;

  it('places 50 students in department A and 50 in department B through the program API', async () => {
    for (let i = 0; i < STUDENTS; i++) {
      const p = inA(i) ? places.A : places.B;
      const r = await call(
        'POST',
        admin,
        `/api/v1/students/${studentIds.get(admissionOf(i))}/programs`,
        {
          programId: p.program,
          cohortId: p.cohort,
          startDate: '2026-08-01',
          reason: 'B6 placement',
        },
        { 'idempotency-key': key() },
      );
      expect(r.statusCode, r.body).toBe(201);
    }
  }, 300_000);

  it('an imported faculty member is granted HOD of department A through the role API', async () => {
    const roleId = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'HOD'`,
        [T.orgId],
      )
    )[0]!.id;
    const target = userIds.get(emailOf('f', 0))!;
    const r = await call('POST', admin, `/api/v1/users/${target}/role-assignments`, {
      roleId,
      scopeType: 'DEPARTMENT',
      scopeId: T.departmentId,
      reason: 'B6 head of department',
    });
    expect(r.statusCode, r.body).toBe(201);
    // A student account can never receive a staff role.
    const refused = await call(
      'POST',
      admin,
      `/api/v1/users/${userIds.get(emailOf('s', 0))}/role-assignments`,
      { roleId, scopeType: 'DEPARTMENT', scopeId: T.departmentId, reason: 'Must be refused' },
    );
    expect(refused.statusCode).toBe(409);
    hod = await login(emailOf('f', 0), NEW_PASSWORD);
  });

  async function walk(s: Session): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ limit: '25', ...(cursor ? { cursor } : {}) });
      const r = await call('GET', s, `/api/v1/students/directory?${q.toString()}`);
      expect(r.statusCode, r.body).toBe(200);
      const p = r.json<{
        data: { admissionNumber: string }[];
        page: { nextCursor: string | null };
      }>();
      out.push(...p.data.map((d) => d.admissionNumber).filter((n) => n.startsWith(`ACC${RUN}`)));
      cursor = p.page.nextCursor;
      if (!cursor) return out;
    }
    throw new Error('directory walk did not terminate');
  }

  it('the organization administrator pages through all 100 students, without duplicates', async () => {
    const seen = await walk(admin);
    expect(seen).toHaveLength(STUDENTS);
    expect(new Set(seen).size).toBe(STUDENTS);
  });

  it('the HOD sees exactly the 50 students of department A, none of department B', async () => {
    const seen = await walk(hod);
    const expected = Array.from({ length: STUDENTS / 2 }, (_, i) => admissionOf(i));
    expect([...seen].sort()).toEqual(expected.sort());
  });

  it('another tenant sees none of these students, and cannot open their profiles', async () => {
    expect(await walk(foreignAdmin)).toEqual([]);
    const r = await call('GET', foreignAdmin, `/api/v1/students/${studentIds.get(admissionOf(0))}`);
    expect(r.statusCode).toBe(404);
    const look = await call(
      'GET',
      foreignAdmin,
      `/api/v1/students?admissionNumber=${admissionOf(0)}`,
    );
    expect(look.statusCode).toBe(404);
  });

  it('profiles: the organization administrator reads any; nonexistent, malformed and foreign ids are safe', async () => {
    const ok = await call('GET', admin, `/api/v1/students/${studentIds.get(admissionOf(99))}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ data: { admissionNumber: string } }>().data.admissionNumber).toBe(
      admissionOf(99),
    );
    expect((await call('GET', admin, `/api/v1/students/${uuidv7()}`)).statusCode).toBe(404);
    expect((await call('GET', admin, '/api/v1/students/not-a-student-id')).statusCode).toBe(400);
    expect((await call('GET', admin, `/api/v1/students/${OTHER.students.one}`)).statusCode).toBe(
      404,
    );
  });

  it('the HOD opens every one of its 50 department-A profiles and none of the 50 department-B profiles', async () => {
    const codes = { A: [] as number[], B: [] as number[] };
    for (let i = 0; i < STUDENTS; i++) {
      const r = await call('GET', hod, `/api/v1/students/${studentIds.get(admissionOf(i))}`);
      codes[inA(i) ? 'A' : 'B'].push(r.statusCode);
    }
    expect(codes.A).toEqual(Array<number>(STUDENTS / 2).fill(200));
    expect(codes.B).toEqual(Array<number>(STUDENTS / 2).fill(404));
  }, 120_000);

  it('the HOD cannot tell an out-of-department student from a nonexistent or other-tenant one', async () => {
    const seen = async (id: string) => {
      const r = await call('GET', hod, `/api/v1/students/${id}`);
      const body = r.json<{ error?: { requestId?: string } }>();
      delete body.error?.requestId;
      return { status: r.statusCode, body };
    };
    const outOfDept = await seen(studentIds.get(admissionOf(99))!);
    expect(outOfDept.status).toBe(404);
    expect(await seen(uuidv7())).toEqual(outOfDept);
    expect(await seen(OTHER.students.one)).toEqual(outOfDept);
  });

  it('the HOD gets no identifiers (no student.profile.read_sensitive), even in its own department', async () => {
    const r = await call(
      'GET',
      hod,
      `/api/v1/students/${studentIds.get(admissionOf(0))}/identifiers`,
    );
    expect(r.statusCode).toBe(403);
  });

  it('the campus administrator reads both departments (same campus); this fixture has no second campus', async () => {
    // The campus boundary itself is proven in tests/integration/student-profile-scope.test.ts.
    const campusAdmin = await login(T.emails.campusAdmin);
    for (const i of [0, 99]) {
      const r = await call(
        'GET',
        campusAdmin,
        `/api/v1/students/${studentIds.get(admissionOf(i))}`,
      );
      expect(r.statusCode).toBe(200);
    }
  });

  it('LIMITED: the HOD reaches the term-enrolment read for its department; no enrolments exist here, so this does not prove enrolment scoping', async () => {
    const a = await call(
      'GET',
      hod,
      `/api/v1/students/${studentIds.get(admissionOf(0))}/term-enrollments`,
    );
    const b = await call(
      'GET',
      hod,
      `/api/v1/students/${studentIds.get(admissionOf(99))}/term-enrollments`,
    );
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json<{ data: unknown[] }>().data).toEqual([]);
    // Nothing of department B is revealed either way.
    if (b.statusCode === 200) expect(b.json<{ data: unknown[] }>().data).toEqual([]);
    else expect(b.statusCode).toBe(404);
  });

  it('students and faculty without directory permissions are refused', async () => {
    const student = await login(emailOf('s', 1), NEW_PASSWORD);
    expect((await call('GET', student, '/api/v1/students/directory')).statusCode).toBe(403);
    const faculty = await login(emailOf('f', 1), NEW_PASSWORD);
    expect((await call('GET', faculty, '/api/v1/students/directory')).statusCode).toBe(403);
    expect((await call('GET', null, '/api/v1/students/directory')).statusCode).toBe(401);
  });

  it('suspending the HOD revokes its session at once; reactivation restores sign-in; the last administrator is protected', async () => {
    const target = userIds.get(emailOf('f', 0))!;
    const version = async () =>
      (
        await adminQuery<{ version: number }>('SELECT version FROM app.users WHERE id = $1', [
          target,
        ])
      )[0]!.version;
    const s = await call(
      'POST',
      admin,
      `/api/v1/users/${target}/suspend`,
      { reason: 'B6 suspension check' },
      { 'if-match': `"${await version()}"` },
    );
    expect(s.statusCode, s.body).toBe(200);
    expect((await call('GET', hod, '/api/v1/students/directory')).statusCode).toBe(401);
    const r = await call(
      'POST',
      admin,
      `/api/v1/users/${target}/reactivate`,
      { reason: 'B6 reactivation check' },
      { 'if-match': `"${await version()}"` },
    );
    expect(r.statusCode, r.body).toBe(200);
    hod = await login(emailOf('f', 0), NEW_PASSWORD);
    expect((await call('GET', hod, '/api/v1/students/directory')).statusCode).toBe(200);

    // The only administrator cannot suspend itself.
    const self = (
      await adminQuery<{ version: number }>('SELECT version FROM app.users WHERE id = $1', [
        T.users.admin,
      ])
    )[0]!.version;
    const own = await call(
      'POST',
      admin,
      `/api/v1/users/${T.users.admin}/suspend`,
      { reason: 'Must be refused' },
      { 'if-match': `"${self}"` },
    );
    expect(own.statusCode).toBe(403);
  });
});
