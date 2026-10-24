import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { ImportService, MAX_IMPORT_ROWS } from '../../src/modules/imports/index.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// The import framework (migration 0035) over HTTP against the shared disposable integration database. Everything commits,
// so it runs in PRIVATE tenants; counts are taken inside the private tenant only.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 12 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let kseq = 0;
const newKey = (): string => `k${RUN}${(kseq++).toString(36).padStart(12, '0')}`;
let nseq = 0;
const adm = (): string => `IM${RUN}${(nseq++).toString(36).toUpperCase()}`;

type Who =
  | 'admin'
  | 'registrarOrg'
  | 'registrarCampus'
  | 'campusAdmin'
  | 'hod'
  | 'faculty'
  | 'studentOne'
  | 'otherAdmin';
const LOGINS: Who[] = [
  'admin',
  'registrarOrg',
  'registrarCampus',
  'campusAdmin',
  'hod',
  'faculty',
  'studentOne',
  'otherAdmin',
];
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

interface Account {
  id: string;
  email: string;
}
async function account(
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DEACTIVATED' = 'ACTIVE',
  role?: { code: string; scope: 'DEPARTMENT'; id: string },
  tenant: IsolatedTenant = T,
): Promise<Account> {
  const id = uuidv7();
  const email = `im-${RUN}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, $4, $1)`,
    [id, tenant.orgId, email, status === 'INVITED' ? 'INVITED' : status],
  );
  if (role) {
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'DEPARTMENT', $5::uuid, NULL, $5::uuid
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [uuidv7(), tenant.orgId, id, role.code, role.id],
    );
  }
  return { id, email };
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  await app.ready();
  for (const w of LOGINS) {
    sessions[w] = await login(w === 'otherAdmin' ? OTHER.emails.admin : T.emails[w]);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  await T.cleanup();
  await OTHER.cleanup();
});

// ---- helpers ------------------------------------------------------------------------------------------------------
type Mount = 'students' | 'faculty';
const root = (m: Mount): string => `/api/v1/${m}/imports`;
function http(
  method: 'GET' | 'POST',
  who: Who | null,
  path: string,
  payload?: InjectOptions['payload'],
  o: { key?: string | null; ifMatch?: string; csrf?: string | null } = {},
) {
  const s = who ? sessions[who] : undefined;
  const csrf = o.csrf !== undefined ? o.csrf : s?.csrf;
  const key = o.key === undefined && method === 'POST' ? newKey() : o.key;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: s ? { session_token: s.cookie } : {},
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN }),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
      ...(o.ifMatch !== undefined ? { 'if-match': o.ifMatch } : {}),
    },
  });
}
type Row = Record<string, string>;
interface Job {
  id: string;
  type: string;
  status: string;
  rowCount: number;
  summary: Record<string, number>;
  version: number;
  committedAt: string | null;
}
interface RowDto {
  rowNo: number;
  status: string;
  raw: Row;
  normalized: Record<string, unknown> | null;
  errors: { code: string; field?: string; relatedRow?: number; message: string }[];
  warnings: { code: string; field?: string }[];
  recordId: string | null;
}
async function create(who: Who | null, m: Mount, rows: Row[], key?: string | null) {
  return http('POST', who, root(m), { rows }, key === undefined ? {} : { key });
}
async function newJob(m: Mount, rows: Row[], who: Who = 'admin'): Promise<string> {
  const r = await create(who, m, rows);
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ data: { id: string } }>().data.id;
}
async function validate(m: Mount, id: string, who: Who = 'admin'): Promise<Job> {
  const r = await http('POST', who, `${root(m)}/${id}/validate`, undefined, { key: null });
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ data: Job }>().data;
}
async function getJob(m: Mount, id: string, who: Who = 'admin'): Promise<Job> {
  const r = await http('GET', who, `${root(m)}/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ data: Job }>().data;
}
async function rowsOf(m: Mount, id: string, q = '', who: Who = 'admin') {
  const r = await http('GET', who, `${root(m)}/${id}/rows${q}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json<{ data: RowDto[]; page: { nextAfterRowNo: number | null } }>();
}
function commit(
  m: Mount,
  id: string,
  version: number,
  body: object = { reason: 'Import approved by the registrar' },
  o: { who?: Who | null; key?: string | null; ifMatch?: string } = {},
) {
  return http('POST', o.who === undefined ? 'admin' : o.who, `${root(m)}/${id}/commit`, body, {
    ...(o.key !== undefined ? { key: o.key } : {}),
    ifMatch: o.ifMatch ?? `"${version}"`,
  });
}
const studentRow = (a: Account, over: Row = {}): Row => ({
  email: a.email,
  admissionNumber: adm(),
  admissionDate: '2024-07-01',
  ...over,
});
const employeeRow = (a: Account, over: Row = {}): Row => ({
  email: a.email,
  employeeCode: `E${RUN}${(nseq++).toString(36)}`.toUpperCase(),
  employeeType: 'FACULTY',
  joiningDate: '2024-06-01',
  ...over,
});
async function fresh(n: number): Promise<Account[]> {
  return Promise.all(Array.from({ length: n }, () => account()));
}
async function snap(): Promise<Record<string, string>> {
  const rows = await adminQuery<Record<string, string>>(
    `SELECT (SELECT count(*) FROM app.students WHERE organization_id = $1)::text AS students,
            (SELECT count(*) FROM app.employees WHERE organization_id = $1)::text AS employees,
            (SELECT count(*) FROM app.users WHERE organization_id = $1)::text AS users,
            (SELECT count(*) FROM app.role_assignments WHERE organization_id = $1)::text AS role_assignments,
            (SELECT count(*) FROM app.student_programs WHERE organization_id = $1)::text AS programs,
            (SELECT count(*) FROM app.guardians WHERE organization_id = $1)::text AS guardians,
            (SELECT count(*) FROM app.audit_events WHERE organization_id = $1)::text AS audit,
            (SELECT count(*) FROM app.idempotency_keys WHERE organization_id = $1)::text AS idem`,
    [T.orgId],
  );
  return rows[0]!;
}
const codes = (r: RowDto): string[] =>
  r.errors.map((e) => `${e.code}${e.field ? `@${e.field}` : ''}`);

describe('creating a job', () => {
  it('stores a DRAFT job and its rows verbatim, audited, owned by the caller', async () => {
    const [a] = await fresh(1);
    const rows = [
      studentRow(a!),
      { email: ' Messy@Example.test ', admissionNumber: '', admissionDate: 'x', extra: 'y' },
    ];
    const r = await create('admin', 'students', rows);
    expect(r.statusCode, r.body).toBe(201);
    const { id, version } = r.json<{ data: { id: string; version: number } }>().data;
    expect(version).toBe(1);
    const job = await adminQuery<{
      status: string;
      type: string;
      created_by: string;
      row_count: number;
    }>('SELECT status, type, created_by, row_count FROM app.import_jobs WHERE id = $1', [id]);
    expect(job[0]).toMatchObject({
      status: 'DRAFT',
      type: 'STUDENT_RECORDS',
      created_by: T.users.admin,
      row_count: 2,
    });
    const stored = await adminQuery<{
      row_no: number;
      raw: Row;
      status: string;
      normalized: unknown;
    }>(
      'SELECT row_no, raw, status, normalized FROM app.import_job_rows WHERE job_id = $1 ORDER BY row_no',
      [id],
    );
    expect(stored.map((s) => s.raw)).toEqual(rows); // exactly as submitted: nothing trimmed, nothing normalised
    expect(stored.every((s) => s.status === 'PENDING' && s.normalized === null)).toBe(true);
    const audit = await adminQuery<{ action: string; risk_tier: number }>(
      `SELECT action, risk_tier FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [T.orgId, id],
    );
    expect(audit).toEqual([{ action: 'import_job.create', risk_tier: 1 }]);
    // nothing was validated or created yet
    expect((await getJob('students', id)).summary).toEqual({});
  });

  it('is idempotent: the same key and rows replay one job; other rows are 422; the key is required', async () => {
    const [a] = await fresh(1);
    const rows = [studentRow(a!)];
    const key = newKey();
    const first = await create('admin', 'students', rows, key);
    const second = await create('admin', 'students', rows, key);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const id = first.json<{ data: { id: string } }>().data.id;
    const n = await adminQuery(
      `SELECT 1 FROM app.import_jobs WHERE organization_id = $1 AND id = $2`,
      [T.orgId, id],
    );
    expect(n).toHaveLength(1);
    expect((await create('admin', 'students', [studentRow(a!)], key)).statusCode).toBe(422);
    expect((await create('admin', 'students', rows, null)).statusCode).toBe(428);
    expect((await create('admin', 'students', rows, 'short')).statusCode).toBe(400);
  });

  it('refuses out-of-bounds or hostile payloads with 400 and stores nothing', async () => {
    const before = await adminQuery(`SELECT 1 FROM app.import_jobs WHERE organization_id = $1`, [
      T.orgId,
    ]);
    const ok = { email: 'a@b.test' };
    const bad: Record<string, unknown>[] = [
      {},
      { rows: [] },
      { rows: 'x' },
      { rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ok) },
      { rows: [ok], organizationId: T.orgId },
      { rows: [ok], status: 'VALIDATED' },
      { rows: [[ok]] },
      { rows: ['text'] },
      { rows: [{ email: { nested: true } }] },
      { rows: [{ email: 'x'.repeat(201) }] },
      { rows: [{ [''.padEnd(41, 'c')]: 'x' }] },
      { rows: [{ '': 'x' }] },
      { rows: [Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`c${i}`, 'x']))] },
      { rows: [{ email: 'a\u0000b' }] },
      { rows: [{ email: 'a\nb' }] },
      { rows: [{ 'bad\u0007name': 'x' }] },
      { rows: [{ email: 'a\uD800b' }] },
    ];
    for (const body of bad) {
      const r = await http('POST', 'admin', root('students'), body);
      expect(r.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const exactly = await create(
      'admin',
      'students',
      Array.from({ length: MAX_IMPORT_ROWS }, () => ({ email: 'a@b.test' })),
    );
    expect(exactly.statusCode).toBe(201);
    const after = await adminQuery(`SELECT 1 FROM app.import_jobs WHERE organization_id = $1`, [
      T.orgId,
    ]);
    expect(after.length).toBe(before.length + 1);
  });

  it('refuses a column called __proto__ at the HTTP boundary, and non-text cells in the service', async () => {
    const r = await http(
      'POST',
      'admin',
      root('students'),
      JSON.parse('{"rows":[{"__proto__":"x","email":"p@q.test"}]}') as object,
    );
    expect(r.statusCode, r.body).toBe(400); // the JSON parser rejects it before any handler runs
    // the HTTP layer coerces scalars to text; the service itself accepts text only
    const ctx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });
    for (const rows of [[{ email: 5 }], [{ email: null }], [{ email: ['a'] }]]) {
      const err = await db
        .withTenant(ctx, (tx) =>
          ImportService.create(tx, ctx, 'STUDENT_RECORDS', { rows }, { idempotencyKey: newKey() }),
        )
        .catch((e: unknown) => e);
      expect(err, JSON.stringify(rows)).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
  });
});

describe('who may use the framework', () => {
  const rows = (): Row[] => [{ email: 'a@b.test' }];
  it('401 without a session, 403 without a CSRF token, 403 without import.job.manage', async () => {
    expect((await create(null, 'students', rows())).statusCode).toBe(401);
    expect(
      (await http('POST', 'admin', root('students'), { rows: rows() }, { csrf: null })).statusCode,
    ).toBe(403);
    for (const who of ['campusAdmin', 'hod', 'faculty', 'studentOne'] as const) {
      expect((await create(who, 'students', rows())).statusCode, who).toBe(403);
      expect((await create(who, 'faculty', rows())).statusCode, who).toBe(403);
    }
  });

  it('organization scope is required: a campus-scoped REGISTRAR holds the permission but is refused', async () => {
    expect((await create('registrarCampus', 'students', rows())).statusCode).toBe(403);
  });

  it('the record kind needs its own create permission: the registrar imports students, not employees', async () => {
    expect((await create('registrarOrg', 'students', rows())).statusCode).toBe(201);
    expect((await create('registrarOrg', 'faculty', rows())).statusCode).toBe(403);
    expect((await create('admin', 'faculty', rows())).statusCode).toBe(201);
  });
});

describe('validation: stable row errors and warnings, no domain writes', () => {
  it('reports every documented problem with a stable code and field, and flags the second occurrence in a file', async () => {
    const [ok, future, susp, dupMail, dupNo] = await Promise.all([
      account(),
      account(),
      account('SUSPENDED'),
      account(),
      account(),
    ]);
    const withEmployee = await account();
    await adminQuery(
      `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
       VALUES ($1, $2, $3, $4, 'STAFF', DATE '2024-01-01')`,
      [uuidv7(), T.orgId, withEmployee.id, `EX${RUN}${nseq++}`],
    );
    const staff = await account('ACTIVE', { code: 'HOD', scope: 'DEPARTMENT', id: T.departmentId });
    const takenNo = (
      await adminQuery<{ admission_number: string }>(
        'SELECT admission_number FROM app.students WHERE id = $1',
        [T.students.one],
      )
    )[0]!.admission_number;
    const sharedNo = adm();
    const rows: Row[] = [
      /* 1 */ studentRow(ok, { admissionNumber: sharedNo }),
      /* 2 */ studentRow(future, { admissionDate: '2199-01-01' }),
      /* 3 */ studentRow({ id: '', email: `nobody-${RUN}@isolated.test` }),
      /* 4 */ studentRow(susp),
      /* 5 */ studentRow({ id: '', email: T.emails.studentOne }),
      /* 6 */ studentRow(withEmployee),
      /* 7 */ studentRow(staff),
      /* 8 */ studentRow(dupMail, { admissionNumber: takenNo }),
      /* 9 */ studentRow(ok), // same e-mail as row 1
      /* 10 */ studentRow(dupNo, { admissionNumber: sharedNo }), // same admission number as row 1
      /* 11 */ studentRow(ok, { email: 'nope' }),
      /* 12 */ studentRow(ok, { admissionNumber: '' }),
      /* 13 */ studentRow(ok, { admissionDate: '2024-02-30' }),
      /* 14 */ studentRow(ok, { admissionNumber: 'bad number!' }),
      /* 15 */ { ...studentRow(ok), foo: 'bar' },
      /* 16 */ { email: ok.email },
    ];
    const id = await newJob('students', rows);
    const job = await validate('students', id);
    expect(job.status).toBe('DRAFT');
    const got = (await rowsOf('students', id)).data;
    expect(got).toHaveLength(16);
    const by = (n: number): RowDto => got[n - 1]!;
    expect(by(1).status).toBe('VALID');
    expect(by(2).status).toBe('VALID');
    expect(by(2).warnings.map((w) => `${w.code}@${w.field}`)).toEqual([
      'FUTURE_DATE@admissionDate',
    ]);
    expect(codes(by(3))).toEqual(['ACCOUNT_NOT_FOUND@email']);
    expect(codes(by(4))).toEqual(['ACCOUNT_NOT_ACTIVE@email']);
    expect(codes(by(5))).toEqual(['ACCOUNT_HAS_STUDENT_RECORD@email']);
    expect(codes(by(6))).toEqual(['ACCOUNT_HAS_EMPLOYEE_RECORD@email']);
    expect(codes(by(7))).toEqual(['ACCOUNT_HAS_STAFF_ROLE@email']);
    expect(codes(by(8))).toEqual(['ADMISSION_NUMBER_EXISTS@admissionNumber']);
    expect(codes(by(9))).toEqual(['DUPLICATE_IN_FILE@email']);
    expect(by(9).errors[0]!.relatedRow).toBe(1);
    expect(codes(by(10))).toEqual(['DUPLICATE_IN_FILE@admissionNumber']);
    expect(by(10).errors[0]!.relatedRow).toBe(1);
    expect(codes(by(11))).toEqual(['INVALID_EMAIL@email']);
    expect(codes(by(12))).toEqual(['REQUIRED@admissionNumber']);
    expect(codes(by(13))).toEqual(['INVALID_DATE@admissionDate']);
    expect(codes(by(14))).toEqual(['INVALID_ADMISSION_NUMBER@admissionNumber']);
    expect(codes(by(15))).toEqual(['UNKNOWN_COLUMN@foo']);
    expect(codes(by(16))).toEqual(['REQUIRED@admissionDate', 'REQUIRED@admissionNumber']);
    expect(job.summary).toMatchObject({ validRows: 2, invalidRows: 14, rowsWithWarnings: 1 });
    // an invalid row carries no preview of a change that cannot happen when its shape is wrong
    expect(by(11).normalized).toBeNull();
    // none of the messages echoes a submitted value
    expect(JSON.stringify(got.map((g) => [g.errors, g.warnings]))).not.toContain(ok.email);
  });

  it('is repeatable and byte-stable, and writes nothing outside the import tables', async () => {
    const accounts = await fresh(3);
    const id = await newJob('students', [
      studentRow(accounts[0]!),
      studentRow(accounts[1]!, { admissionDate: '2199-12-31' }),
      studentRow(accounts[2]!, { admissionNumber: '' }),
    ]);
    const before = await snap();
    const first = await validate('students', id);
    const rows1 = JSON.stringify((await rowsOf('students', id)).data);
    const hash1 = (
      await adminQuery<{ h: string }>(
        'SELECT validation_hash AS h FROM app.import_jobs WHERE id = $1',
        [id],
      )
    )[0]!.h;
    const second = await validate('students', id);
    const rows2 = JSON.stringify((await rowsOf('students', id)).data);
    const hash2 = (
      await adminQuery<{ h: string }>(
        'SELECT validation_hash AS h FROM app.import_jobs WHERE id = $1',
        [id],
      )
    )[0]!.h;
    expect(rows2).toBe(rows1);
    expect(hash2).toBe(hash1);
    expect(second.summary).toEqual(first.summary);
    expect(await snap()).toEqual(before);
  });

  it('follows the database: fixing the cause and validating again turns the job VALIDATED', async () => {
    const missing = `later-${RUN}-${nseq++}@isolated.test`;
    const id = await newJob('students', [
      { email: missing, admissionNumber: adm(), admissionDate: '2024-07-01' },
    ]);
    expect((await validate('students', id)).status).toBe('DRAFT');
    const email = missing;
    const uid = uuidv7();
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'h', 'ACTIVE')`,
      [uid, email],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
      [uid, T.orgId, email],
    );
    const job = await validate('students', id);
    expect(job.status).toBe('VALIDATED');
    expect((await rowsOf('students', id)).data[0]!.errors).toEqual([]);
  });

  it('an e-mail is matched case-insensitively and previewed in its normalised form', async () => {
    const [a] = await fresh(1);
    const id = await newJob('students', [
      {
        email: `  ${a!.email.toUpperCase()}  `,
        admissionNumber: ` ${adm()} `,
        admissionDate: '2024-07-01',
      },
    ]);
    expect((await validate('students', id)).status).toBe('VALIDATED');
    const [row] = (await rowsOf('students', id)).data;
    expect(row!.normalized).toMatchObject({
      action: 'CREATE_STUDENT_RECORD',
      email: a!.email,
      userId: a!.id,
      initialStatus: 'ADMITTED',
    });
  });

  it('only accounts of the caller’s own tenant resolve', async () => {
    const foreign = await account('ACTIVE', undefined, OTHER);
    const id = await newJob('students', [studentRow(foreign)]);
    await validate('students', id);
    expect(codes((await rowsOf('students', id)).data[0]!)).toEqual(['ACCOUNT_NOT_FOUND@email']);
  });

  it('is available only for DRAFT and VALIDATED jobs', async () => {
    const [a] = await fresh(1);
    const id = await newJob('students', [studentRow(a!)]);
    const job = await validate('students', id);
    expect((await commit('students', id, job.version)).statusCode).toBe(200);
    const again = await http('POST', 'admin', `${root('students')}/${id}/validate`, undefined, {
      key: null,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('IMPORT_JOB_COMMITTED');
  });
});

describe('preview and error report', () => {
  it('pages the rows by row number, filters by status and shows the exact proposed change', async () => {
    const accounts = await fresh(5);
    const rows = accounts.map((a, i) =>
      i === 3 ? studentRow(a, { admissionDate: 'bad' }) : studentRow(a),
    );
    const id = await newJob('students', rows);
    await validate('students', id);
    const p1 = await rowsOf('students', id, '?limit=2');
    expect(p1.data.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(p1.page.nextAfterRowNo).toBe(2);
    const p2 = await rowsOf('students', id, '?limit=2&afterRowNo=2');
    expect(p2.data.map((r) => r.rowNo)).toEqual([3, 4]);
    const p3 = await rowsOf('students', id, '?limit=2&afterRowNo=4');
    expect(p3.data.map((r) => r.rowNo)).toEqual([5]);
    expect(p3.page.nextAfterRowNo).toBeNull();
    expect((await rowsOf('students', id, '?status=INVALID')).data.map((r) => r.rowNo)).toEqual([4]);
    expect((await rowsOf('students', id, '?status=VALID')).data).toHaveLength(4);
    expect(p1.data[0]).toMatchObject({
      status: 'VALID',
      raw: rows[0],
      normalized: {
        action: 'CREATE_STUDENT_RECORD',
        userId: accounts[0]!.id,
        admissionNumber: rows[0]!.admissionNumber,
        admissionDate: '2024-07-01',
        initialStatus: 'ADMITTED',
      },
      recordId: null,
    });
    for (const q of ['?limit=0', '?limit=101', '?afterRowNo=-1', '?status=NOPE', '?extra=1']) {
      expect((await http('GET', 'admin', `${root('students')}/${id}/rows${q}`)).statusCode, q).toBe(
        400,
      );
    }
  });

  it('serves the error report as a CSV download that carries no submitted data and neutralises formulas', async () => {
    const [a] = await fresh(1);
    const evil = '=HYPERLINK("http://x.test","y")';
    const id = await newJob('students', [
      studentRow(a!, { admissionDate: '2199-01-01' }),
      { email: 'nope', [evil]: 'z', admissionNumber: adm(), admissionDate: '2024-01-01' },
    ]);
    await validate('students', id);
    const r = await http('GET', 'admin', `${root('students')}/${id}/error-report`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain(
      `attachment; filename="import-${id}-errors.csv"`,
    );
    expect(r.headers['cache-control']).toBe('no-store');
    const lines = r.body.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('row,severity,code,field,message,related_row');
    expect(lines).toContain(
      '1,WARNING,FUTURE_DATE,admissionDate,The admission date is in the future.,',
    );
    expect(lines.some((l) => l.startsWith('2,ERROR,INVALID_EMAIL,email,'))).toBe(true);
    // the client-chosen column name is the only echoed text, and it cannot be read as a formula
    expect(r.body).toContain(`"'=HYPERLINK(""http://x.test"",""y"")"`);
    expect(r.body).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(r.body).not.toContain(a!.email);
  });
});

describe('commit', () => {
  it('creates exactly the previewed records, atomically audited, and nothing else', async () => {
    const accounts = await fresh(3);
    const rows = accounts.map((a, i) => studentRow(a, { admissionDate: `2024-0${i + 1}-15` }));
    const id = await newJob('students', rows);
    const job = await validate('students', id);
    expect(job.status).toBe('VALIDATED');
    const before = await snap();
    const key = newKey();
    const r = await commit(
      'students',
      id,
      job.version,
      { reason: 'Admissions batch approved' },
      { key },
    );
    expect(r.statusCode, r.body).toBe(200);
    const data = r.json<{ data: { status: string; createdRows: number; version: number } }>().data;
    expect(data).toMatchObject({ status: 'COMMITTED', createdRows: 3 });
    const after = await snap();
    expect({ ...after, students: undefined, audit: undefined, idem: undefined }).toEqual({
      ...before,
      students: undefined,
      audit: undefined,
      idem: undefined,
    });
    expect(Number(after.students) - Number(before.students)).toBe(3);
    const made = await adminQuery<{
      user_id: string;
      admission_number: string;
      admission_date: string;
      status: string;
    }>(
      `SELECT user_id, admission_number, admission_date::text AS admission_date, status FROM app.students
        WHERE organization_id = $1 AND user_id = ANY($2::uuid[]) ORDER BY admission_date`,
      [T.orgId, accounts.map((a) => a.id)],
    );
    expect(made).toEqual(
      accounts.map((a, i) => ({
        user_id: a.id,
        admission_number: rows[i]!.admissionNumber,
        admission_date: rows[i]!.admissionDate,
        status: 'ADMITTED',
      })),
    );
    const audit = await adminQuery<{ action: string; reason_text: string; risk_tier: number }>(
      `SELECT action, reason_text, risk_tier FROM app.audit_events
        WHERE organization_id = $1 AND action IN ('student.record.create', 'import_job.commit')
          AND occurred_at >= (SELECT created_at FROM app.import_jobs WHERE id = $2)
          AND (resource_id = $2 OR subject_student_id IN (SELECT student_id FROM app.import_job_rows WHERE job_id = $2))
        ORDER BY action`,
      [T.orgId, id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      'import_job.commit',
      'student.record.create',
      'student.record.create',
      'student.record.create',
    ]);
    expect(
      audit.every((a) => a.reason_text === 'Admissions batch approved' && a.risk_tier === 2),
    ).toBe(true);
    const done = await getJob('students', id);
    expect(done).toMatchObject({
      status: 'COMMITTED',
      summary: { createdRows: 3 },
      version: data.version,
    });
    expect(done.committedAt).not.toBeNull();
    const links = (await rowsOf('students', id)).data;
    expect(links.every((l) => l.status === 'COMMITTED' && l.recordId !== null)).toBe(true);
    // a retry with the same key replays the answer and creates nothing
    const retry = await commit(
      'students',
      id,
      job.version,
      { reason: 'Admissions batch approved' },
      { key },
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(r.json());
    expect((await snap()).students).toBe(after.students);
    // another key is refused: the job is finished
    const other = await commit('students', id, job.version, {
      reason: 'Admissions batch approved',
    });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ error: { code: string } }>().error.code).toBe('IMPORT_JOB_COMMITTED');
    expect((await snap()).students).toBe(after.students);
  });

  it('refuses a malformed, stale or premature request without writing', async () => {
    const [a, b] = await fresh(2);
    const draft = await newJob('students', [studentRow(a!)]);
    // never validated
    expect(
      (await commit('students', draft, 1)).json<{ error: { code: string } }>().error.code,
    ).toBe('IMPORT_JOB_STATE');
    const id = await newJob('students', [studentRow(b!)]);
    const job = await validate('students', id);
    const before = await snap();
    const body = { reason: 'Import approved by the registrar' };
    expect((await http('POST', 'admin', `${root('students')}/${id}/commit`, body)).statusCode).toBe(
      428,
    ); // no If-Match
    for (const bad of ['W/"2"', '*', '"0"', 'abc']) {
      expect((await commit('students', id, 0, body, { ifMatch: bad })).statusCode, bad).toBe(400);
    }
    expect((await commit('students', id, job.version + 5, body)).statusCode).toBe(409); // stale
    expect((await commit('students', id, job.version, body, { key: null })).statusCode).toBe(428); // no key
    expect((await commit('students', id, job.version, { reason: 'no' })).statusCode).toBe(400);
    expect(
      (await commit('students', id, job.version, { reason: 'long enough', extra: 1 })).statusCode,
    ).toBe(400);
    expect(
      (
        await commit('students', id, job.version, {
          reason: 'long enough',
          acknowledgeWarnings: 'yes',
        })
      ).statusCode,
    ).toBe(400);
    // only idempotency claims of the rejected-then-valid probes may differ; no record or audit event does
    expect({ ...(await snap()), idem: '' }).toEqual({ ...before, idem: '' });
    expect((await getJob('students', id)).status).toBe('VALIDATED');
  });

  it('needs the warnings to be acknowledged', async () => {
    const [a] = await fresh(1);
    const id = await newJob('students', [studentRow(a!, { admissionDate: '2199-05-05' })]);
    const job = await validate('students', id);
    expect(job.status).toBe('VALIDATED');
    expect(job.summary.rowsWithWarnings).toBe(1);
    const refused = await commit('students', id, job.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      'IMPORT_WARNINGS_UNACKNOWLEDGED',
    );
    expect((await getJob('students', id)).status).toBe('VALIDATED');
    expect(
      (
        await commit('students', id, job.version, {
          reason: 'Reviewed the warnings',
          acknowledgeWarnings: true,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rolls everything back when a record cannot be written, and the same key then succeeds', async () => {
    const accounts = await fresh(3);
    const rows = accounts.map((a) => studentRow(a));
    const blocked = rows[2]!.admissionNumber!;
    const id = await newJob('students', rows);
    const job = await validate('students', id);
    const fn = `test_block_${RUN}_${nseq++}`;
    await adminQuery(
      `CREATE FUNCTION app.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.admission_number = '${blocked}' THEN
           RAISE EXCEPTION 'injected' USING ERRCODE = 'unique_violation';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await adminQuery(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON app.students FOR EACH ROW EXECUTE FUNCTION app.${fn}()`,
    );
    const key = newKey();
    const before = await snap();
    try {
      const r = await commit('students', id, job.version, undefined, { key });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('IMPORT_COMMIT_CONFLICT');
      // rows 1 and 2 were written before row 3 failed: all of it is gone, including audit events and the key
      expect(await snap()).toEqual(before);
      const j = await getJob('students', id);
      expect(j).toMatchObject({ status: 'VALIDATED', version: job.version });
      expect(
        (await rowsOf('students', id)).data.every(
          (x) => x.status === 'VALID' && x.recordId === null,
        ),
      ).toBe(true);
    } finally {
      await adminQuery(`DROP TRIGGER ${fn} ON app.students`);
      await adminQuery(`DROP FUNCTION app.${fn}()`);
    }
    const retry = await commit('students', id, job.version, undefined, { key });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(Number((await snap()).students) - Number(before.students)).toBe(3);
  });

  it('revalidates: a new conflict closes the job (FAILED), creates nothing and says why', async () => {
    const accounts = await fresh(2);
    const rows = accounts.map((a) => studentRow(a));
    const id = await newJob('students', rows);
    const job = await validate('students', id);
    // someone else takes the second admission number after the preview
    const other = await account();
    await adminQuery(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
       VALUES ($1, $2, $3, $4, DATE '2024-07-01', 'ACTIVE')`,
      [uuidv7(), T.orgId, other.id, rows[1]!.admissionNumber],
    );
    const before = await snap();
    const r = await commit('students', id, job.version);
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('IMPORT_COMMIT_CONFLICT');
    const after = await snap();
    expect(after.students).toBe(before.students);
    const j = await getJob('students', id);
    expect(j.status).toBe('FAILED');
    const refreshed = (await rowsOf('students', id)).data;
    expect(refreshed.map((x) => x.status)).toEqual(['VALID', 'INVALID']);
    expect(codes(refreshed[1]!)).toEqual(['ADMISSION_NUMBER_EXISTS@admissionNumber']);
    // FAILED is terminal: no validation, no commit, rows frozen
    expect(
      (await http('POST', 'admin', `${root('students')}/${id}/validate`, undefined, { key: null }))
        .statusCode,
    ).toBe(409);
    expect((await commit('students', id, j.version)).statusCode).toBe(409);
    const frozen = await adminQuery(
      `UPDATE app.import_job_rows SET status = 'VALID' WHERE job_id = $1 AND row_no = 2`,
      [id],
    ).catch((e: unknown) => e);
    expect(frozen).toBeInstanceOf(Error); // the guard refuses even the superuser
    const report = await http('GET', 'admin', `${root('students')}/${id}/error-report`);
    expect(report.body).toContain('2,ERROR,ADMISSION_NUMBER_EXISTS,admissionNumber,');
  });

  it('applies only the previewed outcome: a changed preview is refreshed, not committed', async () => {
    const invited = await account('INVITED');
    const id = await newJob('faculty', [employeeRow(invited)]);
    const job = await validate('faculty', id);
    expect(job.status).toBe('VALIDATED');
    expect((await rowsOf('faculty', id)).data[0]!.warnings.map((w) => w.code)).toEqual([
      'ACCOUNT_NOT_ACTIVATED',
    ]);
    await adminQuery(`UPDATE app.users SET status = 'ACTIVE' WHERE id = $1`, [invited.id]);
    const before = await snap();
    const r = await commit('faculty', id, job.version, {
      reason: 'Reviewed and approved',
      acknowledgeWarnings: true,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('IMPORT_PREVIEW_CHANGED');
    expect((await snap()).employees).toBe(before.employees);
    const j = await getJob('faculty', id);
    expect(j.status).toBe('VALIDATED');
    expect(j.version).toBeGreaterThan(job.version);
    expect((await rowsOf('faculty', id)).data[0]!.warnings).toEqual([]);
    // the old version no longer works; the refreshed one does
    expect((await commit('faculty', id, job.version)).statusCode).toBe(409);
    expect((await commit('faculty', id, j.version)).statusCode).toBe(200);
  });
});

describe('concurrency', () => {
  it('two commits of one job: exactly one applies it', async () => {
    const accounts = await fresh(4);
    const id = await newJob(
      'students',
      accounts.map((a) => studentRow(a)),
    );
    const job = await validate('students', id);
    const before = await snap();
    const [a, b] = await Promise.all([
      commit('students', id, job.version),
      commit('students', id, job.version),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(Number((await snap()).students) - Number(before.students)).toBe(4);
  });

  it('a retry racing the original with the same key gets the same answer and creates once', async () => {
    const accounts = await fresh(3);
    const id = await newJob(
      'students',
      accounts.map((a) => studentRow(a)),
    );
    const job = await validate('students', id);
    const before = await snap();
    const key = newKey();
    const [a, b] = await Promise.all([
      commit('students', id, job.version, undefined, { key }),
      commit('students', id, job.version, undefined, { key }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json()).toEqual(b.json());
    expect(Number((await snap()).students) - Number(before.students)).toBe(3);
  });

  it('two jobs that want the same admission number: one wins, the other creates nothing at all', async () => {
    const [a1, a2, b1, b2] = await fresh(4);
    const shared = adm();
    const idA = await newJob('students', [
      studentRow(a1!, { admissionNumber: shared }),
      studentRow(a2!),
    ]);
    const idB = await newJob('students', [
      studentRow(b1!, { admissionNumber: shared }),
      studentRow(b2!),
    ]);
    const jobA = await validate('students', idA);
    const jobB = await validate('students', idB);
    expect([jobA.status, jobB.status]).toEqual(['VALIDATED', 'VALIDATED']);
    const [ra, rb] = await Promise.all([
      commit('students', idA, jobA.version),
      commit('students', idB, jobB.version),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const owners = await adminQuery<{ user_id: string }>(
      `SELECT user_id FROM app.students WHERE organization_id = $1 AND admission_number = $2`,
      [T.orgId, shared],
    );
    expect(owners).toHaveLength(1);
    const winnerIsA = ra.statusCode === 200;
    const loserAccounts = winnerIsA ? [b1!.id, b2!.id] : [a1!.id, a2!.id];
    const loserRows = await adminQuery(
      `SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = ANY($2::uuid[])`,
      [T.orgId, loserAccounts],
    );
    expect(loserRows).toHaveLength(0); // all-or-nothing: the loser's other row was not created either
    expect(['IMPORT_COMMIT_CONFLICT']).toContain(
      (winnerIsA ? rb : ra).json<{ error: { code: string } }>().error.code,
    );
  });

  it('two jobs naming the same account: one student record, the other job is refused whole', async () => {
    const [shared, x, y] = await fresh(3);
    const idA = await newJob('students', [studentRow(shared!), studentRow(x!)]);
    const idB = await newJob('students', [studentRow(shared!), studentRow(y!)]);
    const jobA = await validate('students', idA);
    const jobB = await validate('students', idB);
    const [ra, rb] = await Promise.all([
      commit('students', idA, jobA.version),
      commit('students', idB, jobB.version),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 409]);
    const n = await adminQuery(
      `SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [T.orgId, shared!.id],
    );
    expect(n).toHaveLength(1);
    const loserOnly = ra.statusCode === 200 ? y! : x!;
    expect(
      await adminQuery(`SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2`, [
        T.orgId,
        loserOnly.id,
      ]),
    ).toHaveLength(0);
  });
});

describe('ownership and tenant isolation', () => {
  it('another user of the same tenant cannot see, validate, preview, download or commit a job', async () => {
    const [a] = await fresh(1);
    const id = await newJob('students', [studentRow(a!)]);
    const job = await validate('students', id);
    const missing = await http('GET', 'admin', `${root('students')}/${uuidv7()}`);
    expect(missing.statusCode).toBe(404);
    const probes = [
      http('GET', 'registrarOrg', `${root('students')}/${id}`),
      http('POST', 'registrarOrg', `${root('students')}/${id}/validate`, undefined, { key: null }),
      http('GET', 'registrarOrg', `${root('students')}/${id}/rows`),
      http('GET', 'registrarOrg', `${root('students')}/${id}/error-report`),
      commit('students', id, job.version, undefined, { who: 'registrarOrg' }),
      // another tenant's administrator, with the same permissions
      http('GET', 'otherAdmin', `${root('students')}/${id}`),
      http('POST', 'otherAdmin', `${root('students')}/${id}/validate`, undefined, { key: null }),
      http('GET', 'otherAdmin', `${root('students')}/${id}/rows`),
      http('GET', 'otherAdmin', `${root('students')}/${id}/error-report`),
      commit('students', id, job.version, undefined, { who: 'otherAdmin' }),
    ];
    for (const r of await Promise.all(probes)) {
      expect(r.statusCode).toBe(404);
      // not found and not yours are one answer (the request id is the only difference)
      const { code, message } = r.json<{ error: { code: string; message: string } }>().error;
      expect({ code, message }).toEqual({
        code: missing.json<{ error: { code: string } }>().error.code,
        message: missing.json<{ error: { message: string } }>().error.message,
      });
    }
    expect((await getJob('students', id)).status).toBe('VALIDATED'); // untouched
  });

  it('a job belongs to one record kind: the other mount answers 404', async () => {
    const [a] = await fresh(1);
    const id = await newJob('students', [studentRow(a!)]);
    expect((await http('GET', 'admin', `${root('faculty')}/${id}`)).statusCode).toBe(404);
    expect(
      (await http('POST', 'admin', `${root('faculty')}/${id}/validate`, undefined, { key: null }))
        .statusCode,
    ).toBe(404);
  });

  it('idempotency keys are per user and tenant: the same key elsewhere creates a separate job', async () => {
    const key = newKey();
    const [a] = await fresh(1);
    const mine = await create('admin', 'students', [studentRow(a!)], key);
    const theirs = await create(
      'otherAdmin',
      'students',
      [studentRow(await account('ACTIVE', undefined, OTHER))],
      key,
    );
    expect([mine.statusCode, theirs.statusCode]).toEqual([201, 201]);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
    expect(mine.json<{ data: { id: string } }>().data.id).not.toBe(
      theirs.json<{ data: { id: string } }>().data.id,
    );
  });
});

describe('the employee ("faculty") import', () => {
  it('validates, previews and commits employee records without touching accounts, roles or postings', async () => {
    const [ok, invited, deactivated, hasStudent, dup, taken] = await Promise.all([
      account(),
      account('INVITED'),
      account('DEACTIVATED'),
      account(),
      account(),
      account(),
    ]);
    await adminQuery(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
       VALUES ($1, $2, $3, $4, DATE '2024-07-01', 'ACTIVE')`,
      [uuidv7(), T.orgId, hasStudent.id, adm()],
    );
    const takenCode = `TAKEN${RUN}`.toUpperCase();
    await adminQuery(
      `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
       VALUES ($1, $2, $3, $4, 'STAFF', DATE '2024-01-01')`,
      [uuidv7(), T.orgId, taken.id, takenCode],
    );
    const sharedCode = `SH${RUN}`.toUpperCase();
    const rows: Row[] = [
      /* 1 */ employeeRow(ok, { employeeCode: sharedCode, employeeType: 'VISITING' }),
      /* 2 */ employeeRow(invited, { joiningDate: '2199-01-01' }),
      /* 3 */ employeeRow(deactivated),
      /* 4 */ employeeRow(hasStudent),
      /* 5 */ employeeRow(dup, { employeeCode: sharedCode }),
      /* 6 */ employeeRow(await account(), { employeeCode: takenCode }),
      /* 7 */ employeeRow(ok), // the same account as row 1
      /* 8 */ employeeRow(await account(), { employeeType: 'ROOT' }),
      /* 9 */ employeeRow(await account(), { employeeCode: 'bad code' }),
      /* 10 */ employeeRow({ id: '', email: `nobody-${RUN}@isolated.test` }),
      /* 11 */ { email: ok.email },
    ];
    const id = await newJob('faculty', rows);
    const job = await validate('faculty', id);
    expect(job.status).toBe('DRAFT');
    const got = (await rowsOf('faculty', id)).data;
    const by = (n: number): RowDto => got[n - 1]!;
    expect(by(1).status).toBe('VALID');
    expect(by(2).status).toBe('VALID');
    expect(by(2).warnings.map((w) => w.code)).toEqual(['ACCOUNT_NOT_ACTIVATED', 'FUTURE_DATE']);
    expect(codes(by(3))).toEqual(['ACCOUNT_DEACTIVATED@email']);
    expect(codes(by(4))).toEqual(['ACCOUNT_HAS_STUDENT_RECORD@email']);
    expect(codes(by(5))).toEqual(['DUPLICATE_IN_FILE@employeeCode']);
    expect(codes(by(6))).toEqual(['EMPLOYEE_CODE_EXISTS@employeeCode']);
    expect(codes(by(7))).toEqual(['DUPLICATE_IN_FILE@email']);
    expect(codes(by(8))).toEqual(['INVALID_EMPLOYEE_TYPE@employeeType']);
    expect(codes(by(9))).toEqual(['INVALID_EMPLOYEE_CODE@employeeCode']);
    expect(codes(by(10))).toEqual(['ACCOUNT_NOT_FOUND@email']);
    expect(codes(by(11))).toEqual([
      'REQUIRED@employeeCode',
      'REQUIRED@employeeType',
      'REQUIRED@joiningDate',
    ]);
    // the clean job: only the good rows, with the warning acknowledged
    const good = [
      employeeRow(await account(), { employeeType: 'STAFF' }),
      employeeRow(await account('INVITED')),
    ];
    const id2 = await newJob('faculty', good);
    const job2 = await validate('faculty', id2);
    expect(job2.status).toBe('VALIDATED');
    expect(job2.summary.rowsWithWarnings).toBe(1);
    const before = await snap();
    expect((await commit('faculty', id2, job2.version)).statusCode).toBe(409); // warnings
    const r = await commit('faculty', id2, job2.version, {
      reason: 'Staff onboarding batch',
      acknowledgeWarnings: true,
    });
    expect(r.statusCode, r.body).toBe(200);
    const after = await snap();
    expect(Number(after.employees) - Number(before.employees)).toBe(2);
    expect({ ...after, employees: '', audit: '', idem: '' }).toEqual({
      ...before,
      employees: '',
      audit: '',
      idem: '',
    });
    const made = await adminQuery<{
      employee_code: string;
      employee_type: string;
      status: string;
      joining_date: string;
    }>(
      `SELECT employee_code, employee_type, status, joining_date::text AS joining_date FROM app.employees
        WHERE organization_id = $1 AND employee_code = ANY($2::text[]) ORDER BY employee_code`,
      [T.orgId, good.map((g) => g.employeeCode)],
    );
    expect(made.map((m) => [m.employee_code, m.employee_type, m.status]).sort()).toEqual(
      good.map((g) => [g.employeeCode, g.employeeType, 'ACTIVE']).sort(),
    );
    const postings = await adminQuery(
      `SELECT 1 FROM app.employee_postings WHERE organization_id = $1`,
      [T.orgId],
    );
    expect(postings).toHaveLength(0);
  });
});
