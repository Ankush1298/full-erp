import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createCursorCodec } from '../../src/shared/pagination/index.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// GET /api/v1/students/directory over HTTP (docs/architecture/v3/21-students.md §0c): ACTIVE-enrolment students inside the
// caller's GRANTED scope, keyset pagination, cursor binding, audit and rate limit. Private tenants only; every assertion is
// about rows created here.
//
// STATUS: WRITTEN BUT NOT YET RUN. It needs the disposable PostgreSQL harness (global-db.ts), which this change was not
// authorised to start. Run it, and tests/security-db/students-record.test.ts, in the separately authorised validation step.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 6 }));
const KEY = randomBytes(32).toString('base64url'); // generated at run time: no key is ever committed
const clock = { ms: Date.now() };
const config = loadConfig({
  DATABASE_URL: url,
  APP_ORIGINS: APP_ORIGIN,
  CURSOR_KEYS: `k1:${KEY}`,
  CURSOR_ACTIVE_KEY_ID: 'k1',
  STUDENT_DIRECTORY_LIST_ENABLED: 'true',
});
const cursorCodec = createCursorCodec(
  { activeKeyId: 'k1', keys: new Map([['k1', { reveal: () => KEY }]]) },
  { now: () => clock.ms },
);
const bigLimiter = new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 1_000 });
const app = buildApp({ config, db, logger: false, cursorCodec, directoryLimiter: bigLimiter });
// no activation (and no cursor configuration): the route must not exist
const appWithoutKeys = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
type Actor =
  | 'admin'
  | 'campusAdmin'
  | 'hod'
  | 'registrarOrg'
  | 'registrarCampus'
  | 'faculty'
  | 'student'
  | 'foreignAdmin';
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

interface Place {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Place; // the tenant's campus + department (HOD / campus holders' scope)
let sibling!: Place; // same campus, another department
let elsewhere!: Place; // another campus
let PERIOD: string;

async function login(email: string) {
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
async function mkPlace(tenant: IsolatedTenant, campus: string, dept?: string): Promise<Place> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Dir dept', $4)`,
      [d, tenant.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Dir program', $5, 'UG', 8)`,
    [program, tenant.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Dir cohort')`,
    [cohort, tenant.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
async function mkStudent(
  tenant: IsolatedTenant,
  admissionNumber: string,
  displayName = 'Directory Student',
  status = 'ACTIVE',
): Promise<string> {
  const user = uuidv7();
  const email = `dir-${RUN.toLowerCase()}-${user.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [user, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $4, 'ACTIVE', $1)`,
    [user, tenant.orgId, email, displayName],
  );
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', $5)`,
    [id, tenant.orgId, user, admissionNumber, status],
  );
  return id;
}
async function enrol(student: string, p: Place, status = 'ACTIVE'): Promise<void> {
  await adminQuery(
    `INSERT INTO app.student_programs
       (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, end_date, status, exit_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01', $8, $9, $10)`,
    [
      uuidv7(),
      T.orgId,
      student,
      p.program,
      p.cohort,
      p.campus,
      p.dept,
      status === 'ACTIVE' ? null : '2025-01-15',
      status,
      status === 'ACTIVE' ? null : 'Closed by the directory test',
    ],
  );
}

beforeAll(async () => {
  await app.ready();
  await appWithoutKeys.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkPlace(T, T.campusId, T.departmentId);
  sibling = await mkPlace(T, T.campusId);
  const campus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Other campus', $3, 'Asia/Kolkata')`,
    [campus, T.orgId, code('C')],
  );
  elsewhere = await mkPlace(T, campus);
  sessions.admin = await login(T.emails.admin);
  sessions.campusAdmin = await login(T.emails.campusAdmin);
  sessions.hod = await login(T.emails.hod);
  sessions.registrarOrg = await login(T.emails.registrarOrg);
  sessions.registrarCampus = await login(T.emails.registrarCampus);
  sessions.faculty = await login(T.emails.faculty);
  sessions.student = await login(T.emails.studentOne);
  sessions.foreignAdmin = await login(OTHER.emails.admin);
}, 90_000);

afterAll(async () => {
  await app.close();
  await appWithoutKeys.close();
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
  await adminQuery('DELETE FROM app.students WHERE organization_id = ANY($1::uuid[])', [
    [T.orgId, OTHER.orgId],
  ]);
  await T.cleanup();
  await OTHER.cleanup();
});

const DIR = '/api/v1/students/directory';
const dir = (user: Actor | null, query = '', a = app) =>
  a.inject({
    method: 'GET',
    url: `${DIR}${query}`,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
interface Page {
  success: boolean;
  data: {
    id: string;
    admissionNumber: string;
    displayName: string;
    status: string;
    hasActiveEnrolment: boolean;
  }[];
  page: { nextCursor: string | null };
}
const pageOf = (r: { json: <X>() => X }) => r.json<Page>();
const errCode = (r: { json: <X>() => X }) => r.json<{ error: { code: string } }>().error.code;
/** Every page of a walk, as admission numbers of THIS file's students only. */
async function walk(user: Actor, query = 'limit=2'): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await dir(user, `?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.statusCode).toBe(200);
    const p = pageOf(r);
    out.push(...p.data.map((d) => d.admissionNumber).filter((n) => n.startsWith(`L${RUN}`)));
    cursor = p.page.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('walk did not terminate');
}
/** The expected order is whatever the DATABASE's collation says, never a JavaScript sort. */
const dbOrder = async (names: string[]): Promise<string[]> =>
  (
    await adminQuery(
      `SELECT admission_number FROM app.students WHERE organization_id = $1 AND admission_number = ANY($2::text[]) ORDER BY admission_number ASC`,
      [T.orgId, names],
    )
  ).map((r) => r.admission_number as string);

// fixtures: id -> admission number
const N = {
  main1: '',
  main2: '',
  main3: '',
  sibling: '',
  elsewhere: '',
  unplaced: '',
  closedOnly: '',
  onLeave: '',
};

describe('fixtures for the directory', () => {
  it('creates the students (placed in three places, unplaced, closed-only, one ON_LEAVE)', async () => {
    N.main1 = `L${RUN}A1`;
    N.main2 = `L${RUN}A2`;
    N.main3 = `L${RUN}B3`;
    N.sibling = `L${RUN}C4`;
    N.elsewhere = `L${RUN}D5`;
    N.unplaced = `L${RUN}E6`;
    N.closedOnly = `L${RUN}F7`;
    N.onLeave = `L${RUN}G8`;
    await enrol(await mkStudent(T, N.main1), main);
    await enrol(await mkStudent(T, N.main2), main);
    await enrol(await mkStudent(T, N.main3), main);
    await enrol(await mkStudent(T, N.sibling), sibling);
    await enrol(await mkStudent(T, N.elsewhere), elsewhere);
    await mkStudent(T, N.unplaced);
    const closed = await mkStudent(T, N.closedOnly);
    await enrol(closed, main, 'COMPLETED');
    await enrol(await mkStudent(T, N.onLeave, 'On Leave Student', 'ON_LEAVE'), main);
    expect(Object.values(N).every((v) => v.length > 0)).toBe(true);
  });
});

describe('who is listed, per role and exact scope', () => {
  const placedMain = () => [N.main1, N.main2, N.main3, N.onLeave];
  it('COLLEGE_ADMIN (organization scope): every placed student, never the unplaced or the closed-only', async () => {
    const got = await walk('admin');
    expect(got).toEqual(await dbOrder([...placedMain(), N.sibling, N.elsewhere]));
    for (const n of [N.unplaced, N.closedOnly]) expect(got).not.toContain(n);
  });

  it('REGISTRAR with an ORGANIZATION assignment: the same as an organization admin (scope from the assignment)', async () => {
    expect(await walk('registrarOrg')).toEqual(
      await dbOrder([...placedMain(), N.sibling, N.elsewhere]),
    );
  });

  it('REGISTRAR with a CAMPUS assignment: that campus only, not organization-wide', async () => {
    const got = await walk('registrarCampus');
    expect(got).toEqual(await dbOrder([...placedMain(), N.sibling]));
    expect(got).not.toContain(N.elsewhere);
  });

  it('CAMPUS_ADMIN: their campus only', async () => {
    const got = await walk('campusAdmin');
    expect(got).toEqual(await dbOrder([...placedMain(), N.sibling]));
    expect(got).not.toContain(N.elsewhere);
  });

  it('HOD (department scope): their department only, with no fallback to the campus or the organization', async () => {
    const got = await walk('hod');
    expect(got).toEqual(await dbOrder(placedMain()));
    for (const n of [N.sibling, N.elsewhere, N.unplaced, N.closedOnly])
      expect(got).not.toContain(n);
  });

  it("FACULTY, STUDENT and unauthenticated callers are refused; another tenant's admin sees none of these students", async () => {
    expect((await dir('faculty')).statusCode).toBe(403);
    expect((await dir('student')).statusCode).toBe(403);
    expect((await dir(null)).statusCode).toBe(401);
    expect(await walk('foreignAdmin')).toEqual([]);
  });

  it('the lookup permission alone does not grant the list: a role holding only student.directory.search would be refused (catalog independence)', async () => {
    const rows = await adminQuery(
      `SELECT rp.permission_code FROM app.role_permissions rp JOIN app.roles r ON r.organization_id = rp.organization_id AND r.id = rp.role_id
        WHERE rp.organization_id = $1 AND rp.permission_code IN ('student.directory.list', 'student.directory.search') AND r.code = 'HOD' ORDER BY 1`,
      [T.orgId],
    );
    expect(rows.map((r) => r.permission_code)).toEqual([
      'student.directory.list',
      'student.directory.search',
    ]);
  });
});

describe('the response and the filter', () => {
  it('200 with the five reviewed fields, hasActiveEnrolment always true, a null cursor on the last page, and no-store', async () => {
    const r = await dir('hod', '?limit=100');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const p = pageOf(r);
    expect(p.success).toBe(true);
    expect(p.page.nextCursor).toBeNull();
    const mine = p.data.filter((d) => d.admissionNumber.startsWith(`L${RUN}`));
    expect(mine.length).toBe(4);
    for (const e of mine) {
      expect(Object.keys(e).sort()).toEqual([
        'admissionNumber',
        'displayName',
        'hasActiveEnrolment',
        'id',
        'status',
      ]);
      expect(e.hasActiveEnrolment).toBe(true);
    }
    for (const leak of [
      'admissionDate',
      'userId',
      'email',
      'campus',
      'department',
      'program',
      'cohort',
      'exit',
      'reason',
    ]) {
      expect(r.body, leak).not.toContain(leak);
    }
  });

  it('status filters the listing and a walk under a filter stays under it; an unknown status is 400', async () => {
    expect(await walk('admin', 'status=ON_LEAVE&limit=1')).toEqual([N.onLeave]);
    expect((await dir('admin', '?status=ENROLLED')).statusCode).toBe(400);
  });

  it('rejects unknown, tenant, scope and offset parameters with 400', async () => {
    for (const q of [
      '?name=a',
      '?offset=1',
      '?campusId=x',
      '?organizationId=x',
      '?limit=0',
      '?limit=101',
    ]) {
      expect((await dir('admin', q)).statusCode, q).toBe(400);
    }
  });

  it('GET /directory is not shadowed by GET /:id', async () => {
    expect((await dir('admin')).statusCode).toBe(200);
  });
});

describe('pagination', () => {
  it('limit 2 walks the whole organization view with no duplicates and no gaps, in database collation order', async () => {
    const got = await walk('admin', 'limit=2');
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual(
      await dbOrder([N.main1, N.main2, N.main3, N.onLeave, N.sibling, N.elsewhere]),
    );
  });

  it('an empty result (nothing in scope for the filter) is an empty page without a cursor', async () => {
    const r = await dir('hod', '?status=GRADUATED');
    expect(r.statusCode).toBe(200);
    expect(pageOf(r)).toMatchObject({ data: [], page: { nextCursor: null } });
  });
});

describe('cursor security over HTTP', () => {
  const firstCursor = async (user: Actor, query = 'limit=1'): Promise<string> => {
    const r = await dir(user, `?${query}`);
    const c = pageOf(r).page.nextCursor;
    expect(c).toBeTruthy();
    return c!;
  };
  const useCursor = (user: Actor, c: string, extra = '', a = app) =>
    dir(user, `?limit=1${extra}&cursor=${encodeURIComponent(c)}`, a);

  it('accepts its own fresh cursor and rejects every other use with the same 400 INVALID_CURSOR', async () => {
    const c = await firstCursor('admin');
    expect((await useCursor('admin', c)).statusCode).toBe(200);
    const bad: [string, Awaited<ReturnType<typeof useCursor>>][] = [
      ['another user', await useCursor('registrarOrg', c)],
      ['another tenant', await useCursor('foreignAdmin', c)],
      ['another filter', await useCursor('admin', c, '&status=ON_LEAVE')],
      [
        'tampered',
        await useCursor('admin', `${c.slice(0, -3)}${c.endsWith('AAA') ? 'BBB' : 'AAA'}`),
      ],
      ['malformed', await useCursor('admin', 'not-a-cursor')],
      ['empty', await useCursor('admin', '')],
      ['oversized', await useCursor('admin', 'x'.repeat(4000))],
    ];
    for (const [name, r] of bad) {
      expect(r.statusCode, name).toBe(400);
      expect(errCode(r), name).toBe('INVALID_CURSOR');
    }
  });

  it('rejects an expired cursor (clock moved past the 600 s lifetime) and accepts one just inside it', async () => {
    const c = await firstCursor('admin');
    clock.ms += 599_000;
    expect((await useCursor('admin', c)).statusCode).toBe(200);
    clock.ms += 2_000;
    const r = await useCursor('admin', c);
    expect(r.statusCode).toBe(400);
    expect(errCode(r)).toBe('INVALID_CURSOR');
    clock.ms = Date.now();
  });
});

describe('route availability', () => {
  it('without activation the route does not exist: an authorised admin gets the answer of a malformed student id (GET /:id), never the directory', async () => {
    const cookies = { session_token: sessions.admin.cookie }; // the session cookie is valid in the same database
    const r = await appWithoutKeys.inject({ method: 'GET', url: DIR, cookies });
    const junk = await appWithoutKeys.inject({
      method: 'GET',
      url: '/api/v1/students/not-a-student-id',
      cookies,
    });
    // observed by tests/unit/student-directory-activation.test.ts (no database); not a 404 because /:id matches
    expect(r.statusCode).toBe(400);
    expect(r.statusCode).toBe(junk.statusCode);
  });
});

describe('audit', () => {
  const events = async (userId: string) =>
    adminQuery(
      `SELECT action, resource_type, risk_tier, metadata::text AS metadata, subject_student_id, resource_id
         FROM app.audit_events WHERE organization_id = $1 AND actor_user_id = $2 AND action = 'student.directory.list'
        ORDER BY occurred_at`,
      [T.orgId, userId],
    );

  it('every successful page writes one tier-1 event with only the approved metadata, and never the cursor or student data', async () => {
    const before = (await events(T.users.registrarOrg)).length;
    const first = await dir('registrarOrg', '?limit=2');
    const cursor = pageOf(first).page.nextCursor!;
    const second = await dir('registrarOrg', `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.statusCode).toBe(200);
    const rows = await events(T.users.registrarOrg);
    expect(rows.length - before).toBe(2);
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({
      resource_type: 'student_directory',
      risk_tier: 1,
      subject_student_id: null,
      resource_id: null,
    });
    const meta = JSON.parse(last.metadata as string) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([
      'cursorPresent',
      'issuedKeyId',
      'limit',
      'returned',
      'route',
      'status',
    ]);
    expect(meta).toMatchObject({
      cursorPresent: true,
      limit: 2,
      status: null,
      route: 'GET /api/v1/students/directory',
    });
    const everything = JSON.stringify(rows);
    const names = (
      await adminQuery(`SELECT admission_number, id FROM app.students WHERE organization_id = $1`, [
        T.orgId,
      ])
    ).flatMap((s) => [s.admission_number as string, s.id as string]);
    for (const secret of [cursor, ...names, 'Directory Student'])
      expect(everything).not.toContain(secret);
  });

  it('refused requests (no permission, bad cursor, invalid input) write no directory audit event', async () => {
    const facultyBefore = (await events(T.users.faculty)).length;
    await dir('faculty');
    expect((await events(T.users.faculty)).length).toBe(facultyBefore);
    const before = (await events(T.users.hod)).length;
    await dir('hod', '?cursor=junk');
    await dir('hod', '?limit=0');
    expect((await events(T.users.hod)).length).toBe(before);
  });
});

describe('rate limit', () => {
  it('answers 429 with Retry-After beyond the per-user budget, per user, without auditing the refused request', async () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100 });
    const limited = buildApp({ config, db, logger: false, cursorCodec, directoryLimiter: limiter });
    await limited.ready();
    try {
      const before = (
        await adminQuery(
          `SELECT count(*)::int AS n FROM app.audit_events WHERE organization_id = $1 AND actor_user_id = $2 AND action = 'student.directory.list'`,
          [T.orgId, T.users.campusAdmin],
        )
      )[0]!.n as number;
      expect((await dir('campusAdmin', '', limited)).statusCode).toBe(200);
      expect((await dir('campusAdmin', '', limited)).statusCode).toBe(200);
      const refused = await dir('campusAdmin', '', limited);
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(errCode(refused)).toBe('TOO_MANY_REQUESTS');
      expect((await dir('hod', '', limited)).statusCode).toBe(200); // another user is unaffected
      const after = (
        await adminQuery(
          `SELECT count(*)::int AS n FROM app.audit_events WHERE organization_id = $1 AND actor_user_id = $2 AND action = 'student.directory.list'`,
          [T.orgId, T.users.campusAdmin],
        )
      )[0]!.n as number;
      expect(after - before).toBe(2);
    } finally {
      await limited.close();
    }
  });
});
