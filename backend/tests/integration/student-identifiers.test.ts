import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { MAX_IDENTIFIERS_PER_STUDENT } from '../../src/modules/students/index.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Student identifiers (migration 0035) over HTTP against the shared disposable integration database. Everything commits, so
// it runs in PRIVATE tenants; assertions look at rows these tests created (by id) or at this private tenant only.

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
let PERIOD: string;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);
let kseq = 0;
const newKey = (): string => `k${RUN}${(kseq++).toString(36).padStart(12, '0')}`;
let vseq = 0;
/** A value no other test uses. */
const val = (p = 'V'): string => `${p}-${RUN}-${vseq++}`;

type Actor =
  'admin' | 'campusAdmin' | 'registrarCampus' | 'hod' | 'faculty' | 'studentOne' | 'studentTwo';
const ACTORS: Actor[] = [
  'admin',
  'campusAdmin',
  'registrarCampus',
  'hod',
  'faculty',
  'studentOne',
  'studentTwo',
];
const sessions = {} as Record<Actor | 'otherAdmin', { cookie: string; csrf: string }>;

interface Structure {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Structure; // the tenant's campus and department: the campus admin's scope
let remote!: Structure; // ANOTHER campus: outside the campus admin's scope
let inCampusStudent!: string; // enrolled in `main`
let outOfCampusStudent!: string; // enrolled in `remote`
let unplacedStudent!: string; // no enrolment: only ORGANIZATION grants reach it

async function mkStructure(campus: string, dept: string): Promise<Structure> {
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Test program', $5, 'UG', 8)`,
    [program, T.orgId, dept, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Test cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept, program, cohort };
}
async function mkStudent(s?: Structure): Promise<{ id: string; userId: string }> {
  const userId = uuidv7();
  const email = `si-${RUN}-${userId.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [userId, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [userId, T.orgId, email],
  );
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, DATE '2024-07-01', 'ACTIVE')`,
    [id, T.orgId, userId, `SI${RUN}${seq++}`],
  );
  if (s) {
    await adminQuery(
      `INSERT INTO app.student_programs
         (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, DATE '2024-08-01', 'ACTIVE')`,
      [uuidv7(), T.orgId, id, s.program, s.cohort, s.campus, s.dept],
    );
  }
  return { id, userId };
}

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
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkStructure(T.campusId, T.departmentId);
  const campus2 = uuidv7();
  const dept2 = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Remote', $3, 'Asia/Kolkata')`,
    [campus2, T.orgId, code('C')],
  );
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Remote dept', $4)`,
    [dept2, T.orgId, campus2, code('D')],
  );
  remote = await mkStructure(campus2, dept2);
  inCampusStudent = (await mkStudent(main)).id;
  outOfCampusStudent = (await mkStudent(remote)).id;
  unplacedStudent = (await mkStudent()).id;
  await app.ready();
  for (const a of ACTORS) sessions[a] = await login(T.emails[a]);
  sessions.otherAdmin = await login(OTHER.emails.admin);
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    for (const t of ['student_programs', 'cohorts', 'programs', 'period_types']) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
  } finally {
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

// ---- helpers ------------------------------------------------------------------------------------------------------
type Who = Actor | 'otherAdmin' | null;
function req(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  who: Who,
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
const base = (student: string): string => `/api/v1/students/${student}/identifiers`;
const addId = (who: Who, student: string, body: object, key?: string | null) =>
  req('POST', who, base(student), body, key === undefined ? {} : { key });
interface Dto {
  id: string;
  studentId: string;
  idType: string;
  value: string;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}
const listOf = async (who: Who, student: string): Promise<Dto[]> =>
  (await req('GET', who, base(student))).json<{ data: Dto[] }>().data;
async function createOne(student: string, body: Record<string, unknown> = {}): Promise<Dto> {
  const r = await addId('admin', student, { idType: 'UNIVERSITY_PRN', value: val('PRN'), ...body });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json<{ data: { id: string } }>().data.id;
  const found = (await listOf('admin', student)).find((d) => d.id === id);
  expect(found).toBeDefined();
  return found!;
}
const auditOf = (id: string) =>
  adminQuery<{ action: string; risk_tier: number; subject_student_id: string; changes: unknown }>(
    `SELECT action, risk_tier, subject_student_id, changes FROM app.audit_events
      WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at`,
    [T.orgId, id],
  );

describe('adding and reading identifiers', () => {
  it('adds an identifier and lists it; the admission number is a separate fact that never changes', async () => {
    const before = await adminQuery<{ admission_number: string }>(
      'SELECT admission_number FROM app.students WHERE id = $1',
      [inCampusStudent],
    );
    const v = val('PRN');
    const r = await addId('admin', inCampusStudent, {
      idType: 'UNIVERSITY_PRN',
      value: `  ${v}  `,
      issuer: ' University of Test ',
      validFrom: '2024-08-01',
      validTo: '2028-07-31',
    });
    expect(r.statusCode, r.body).toBe(201);
    const list = await listOf('admin', inCampusStudent);
    const row = list.find((d) => d.id === r.json<{ data: { id: string } }>().data.id)!;
    expect(row).toMatchObject({
      studentId: inCampusStudent,
      idType: 'UNIVERSITY_PRN',
      value: v, // trimmed
      issuer: 'University of Test',
      validFrom: '2024-08-01',
      validTo: '2028-07-31',
      version: 1,
    });
    expect(Object.keys(row).sort()).toEqual(
      [
        'createdAt',
        'id',
        'idType',
        'issuer',
        'studentId',
        'updatedAt',
        'validFrom',
        'validTo',
        'value',
        'version',
      ].sort(),
    );
    const after = await adminQuery<{ admission_number: string }>(
      'SELECT admission_number FROM app.students WHERE id = $1',
      [inCampusStudent],
    );
    expect(after).toEqual(before);
    // the identifier endpoints neither return nor accept the admission number
    const bad = await addId('admin', inCampusStudent, {
      idType: 'UNIVERSITY_PRN',
      value: val(),
      admissionNumber: 'X1',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('only the five documented identifier types exist; the admission and registration numbers are not among them', async () => {
    for (const idType of [
      'ADMISSION_NUMBER',
      'REGISTRATION_NUMBER',
      'INSTITUTIONAL_EMAIL',
      'prn',
      '',
    ]) {
      const r = await addId('admin', inCampusStudent, { idType, value: val() });
      expect(r.statusCode, idType).toBe(400);
    }
    for (const idType of ['UNIVERSITY_PRN', 'APAAR', 'LIBRARY_CARD', 'HOSTEL_ID', 'OTHER']) {
      const r = await addId('admin', inCampusStudent, { idType, value: val(idType) });
      expect(r.statusCode, idType).toBe(201);
    }
  });

  it('rejects malformed values, dates and unknown or trusted fields with 400, and stores nothing', async () => {
    const countBefore = (await listOf('admin', unplacedStudent)).length;
    const bodies: Record<string, unknown>[] = [
      { idType: 'APAAR' },
      { idType: 'APAAR', value: '' },
      { idType: 'APAAR', value: '   ' },
      { idType: 'APAAR', value: 'x'.repeat(101) },
      { idType: 'APAAR', value: 'a\u0000b' },
      { idType: 'APAAR', value: 'a\tb' },
      { idType: 'APAAR', value: val(), issuer: '' },
      { idType: 'APAAR', value: val(), issuer: 'x'.repeat(201) },
      { idType: 'APAAR', value: val(), validFrom: '2024-02-30' },
      { idType: 'APAAR', value: val(), validFrom: '2024-8-1' },
      { idType: 'APAAR', value: val(), validFrom: '2025-01-01', validTo: '2024-01-01' },
      { idType: 'APAAR', value: val(), validTo: '1800-01-01' },
      { idType: 'APAAR', value: val(), organizationId: T.orgId },
      { idType: 'APAAR', value: val(), studentId: outOfCampusStudent },
      { idType: 'APAAR', value: val(), version: 5 },
      { idType: 'APAAR', value: val(), id: uuidv7() },
    ];
    for (const body of bodies) {
      const r = await addId('admin', unplacedStudent, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await listOf('admin', unplacedStudent)).toHaveLength(countBefore);
  });

  it('a malformed student id is 400; an unknown or other-tenant student is the same 404', async () => {
    expect((await req('GET', 'admin', '/api/v1/students/not-a-uuid/identifiers')).statusCode).toBe(
      400,
    );
    const unknown = await req('GET', 'admin', base(uuidv7()));
    const crossTenant = await req('GET', 'otherAdmin', base(inCampusStudent));
    expect(unknown.statusCode).toBe(404);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({
      error: { code: unknown.json<{ error: { code: string } }>().error.code },
    });
    expect(
      (await addId('otherAdmin', inCampusStudent, { idType: 'APAAR', value: val() })).statusCode,
    ).toBe(404);
  });
});

describe('uniqueness (organization, id_type, value) is exact and tenant-scoped', () => {
  it('the same type and value cannot be held twice, by the same student or another; a different type or value can', async () => {
    const v = val('PRN');
    expect(
      (await addId('admin', inCampusStudent, { idType: 'UNIVERSITY_PRN', value: v })).statusCode,
    ).toBe(201);
    for (const student of [inCampusStudent, outOfCampusStudent, unplacedStudent]) {
      const dup = await addId('admin', student, { idType: 'UNIVERSITY_PRN', value: ` ${v} ` });
      expect(dup.statusCode, student).toBe(409);
      expect(dup.json<{ error: { code: string; message: string } }>().error.code).toBe(
        'STUDENT_IDENTIFIER_EXISTS',
      );
      // the answer never says which student holds the value
      expect(dup.body).not.toContain(inCampusStudent);
    }
    expect(
      (await addId('admin', outOfCampusStudent, { idType: 'LIBRARY_CARD', value: v })).statusCode,
    ).toBe(201);
    expect(
      (await addId('admin', outOfCampusStudent, { idType: 'UNIVERSITY_PRN', value: `${v}-2` }))
        .statusCode,
    ).toBe(201);
    // exact: a different case is a different value (the documents define no normalisation)
    expect(
      (
        await addId('admin', outOfCampusStudent, {
          idType: 'UNIVERSITY_PRN',
          value: v.toLowerCase(),
        })
      ).statusCode,
    ).toBe(201);
  });

  it('the same value in ANOTHER tenant is not a conflict', async () => {
    const v = val('SHARED');
    expect((await addId('admin', inCampusStudent, { idType: 'APAAR', value: v })).statusCode).toBe(
      201,
    );
    const [s] = Object.values(OTHER.students);
    const r = await addId('otherAdmin', s!, { idType: 'APAAR', value: v });
    expect(r.statusCode, r.body).toBe(201);
  });

  it('two concurrent adds of the same value: exactly one succeeds, the other is a clean 409', async () => {
    const v = val('RACE');
    const [a, b] = await Promise.all([
      addId('admin', inCampusStudent, { idType: 'HOSTEL_ID', value: v }),
      addId('admin', outOfCampusStudent, { idType: 'HOSTEL_ID', value: v }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const rows = await adminQuery(
      `SELECT 1 FROM app.student_identifiers WHERE organization_id = $1 AND id_type = 'HOSTEL_ID' AND value = $2`,
      [T.orgId, v],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('a retry with the same key replays the stored answer and creates one row; another body is 422; the header is required', async () => {
    const key = newKey();
    const body = { idType: 'LIBRARY_CARD', value: val('LC') };
    const first = await addId('admin', inCampusStudent, body, key);
    const second = await addId('admin', inCampusStudent, body, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    const rows = await adminQuery(
      `SELECT 1 FROM app.student_identifiers WHERE organization_id = $1 AND value = $2`,
      [T.orgId, body.value],
    );
    expect(rows).toHaveLength(1);
    expect(
      (await addId('admin', inCampusStudent, { ...body, value: val('LC') }, key)).statusCode,
    ).toBe(422);
    expect((await addId('admin', inCampusStudent, body, null)).statusCode).toBe(428);
    expect((await addId('admin', inCampusStudent, body, 'short')).statusCode).toBe(400);
  });

  it('a failed request is not cached: the same key succeeds once the cause is gone', async () => {
    const key = newKey();
    const v = val('RETRY');
    expect(
      (await addId('admin', outOfCampusStudent, { idType: 'OTHER', value: v })).statusCode,
    ).toBe(201);
    expect(
      (await addId('admin', inCampusStudent, { idType: 'OTHER', value: v }, key)).statusCode,
    ).toBe(409);
    await adminQuery(
      `DELETE FROM app.student_identifiers WHERE organization_id = $1 AND value = $2`,
      [T.orgId, v],
    );
    expect(
      (await addId('admin', inCampusStudent, { idType: 'OTHER', value: v }, key)).statusCode,
    ).toBe(201);
  });
});

describe('authorization and tenant boundaries', () => {
  it('only holders of student.record.update add; read needs student.profile.read_sensitive', async () => {
    const body = (): object => ({ idType: 'OTHER', value: val() });
    expect((await addId(null, inCampusStudent, body())).statusCode).toBe(401);
    for (const who of ['hod', 'faculty', 'studentOne', 'studentTwo'] as const) {
      expect((await addId(who, inCampusStudent, body())).statusCode, who).toBe(403);
    }
    // read: HOD and FACULTY hold neither the sensitive read nor anything else for identifiers
    for (const who of ['hod', 'faculty'] as const) {
      expect((await req('GET', who, base(inCampusStudent))).statusCode, who).toBe(403);
    }
    expect((await req('GET', null, base(inCampusStudent))).statusCode).toBe(401);
  });

  it('a state-changing request needs a CSRF token', async () => {
    const r = await req(
      'POST',
      'admin',
      base(inCampusStudent),
      { idType: 'OTHER', value: val() },
      { csrf: null },
    );
    expect(r.statusCode).toBe(403);
  });

  it('a campus-scoped holder reaches students of its campus only; everything else is the same 404 as a missing student', async () => {
    for (const who of ['campusAdmin', 'registrarCampus'] as const) {
      const ok = await addId(who, inCampusStudent, { idType: 'OTHER', value: val() });
      expect(ok.statusCode, `${who} in scope`).toBe(201);
      const missing = await addId(who, uuidv7(), { idType: 'OTHER', value: val() });
      for (const student of [outOfCampusStudent, unplacedStudent]) {
        const denied = await addId(who, student, { idType: 'OTHER', value: val() });
        expect(denied.statusCode, `${who} ${student}`).toBe(404);
        expect(denied.json()).toEqual({
          error: expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }) as unknown,
        });
        expect(denied.json<{ error: { message: string } }>().error.message).toBe(
          missing.json<{ error: { message: string } }>().error.message,
        );
      }
      expect((await req('GET', who, base(inCampusStudent))).statusCode, who).toBe(200);
      expect((await req('GET', who, base(outOfCampusStudent))).statusCode, who).toBe(404);
    }
  });

  it('a student reads only its own identifiers and never writes', async () => {
    const own = await createOne(T.students.one);
    const mine = await req('GET', 'studentOne', base(T.students.one));
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ data: Dto[] }>().data.map((d) => d.id)).toContain(own.id);
    expect((await req('GET', 'studentOne', base(T.students.two))).statusCode).toBe(404);
    expect((await req('GET', 'studentOne', base(inCampusStudent))).statusCode).toBe(404);
    expect(
      (
        await req(
          'PATCH',
          'studentOne',
          `${base(T.students.one)}/${own.id}`,
          { issuer: 'Me' },
          { ifMatch: `"${own.version}"` },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('another tenant can neither read nor change an identifier', async () => {
    const row = await createOne(inCampusStudent);
    const path = `${base(inCampusStudent)}/${row.id}`;
    expect(
      (await req('PATCH', 'otherAdmin', path, { issuer: 'X' }, { ifMatch: `"${row.version}"` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await listOf('admin', inCampusStudent)).find((d) => d.id === row.id)?.issuer,
    ).toBeNull();
  });
});

describe('changing an identifier', () => {
  it('changes only the issuer and validity window, with If-Match, a new version, an ETag and an audit event', async () => {
    const row = await createOne(inCampusStudent, { issuer: 'Old issuer' });
    const path = `${base(inCampusStudent)}/${row.id}`;
    const r = await req(
      'PATCH',
      'admin',
      path,
      { issuer: 'New issuer', validTo: '2030-01-01' },
      { ifMatch: `"${row.version}"` },
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers.etag).toBe('"2"');
    expect(r.json<{ data: Dto }>().data).toMatchObject({
      issuer: 'New issuer',
      validTo: '2030-01-01',
      version: 2,
      value: row.value,
    });
    const audit = await auditOf(row.id);
    expect(audit.map((a) => a.action)).toEqual([
      'student_identifier.add',
      'student_identifier.update',
    ]);
    expect(audit.every((a) => a.risk_tier === 1 && a.subject_student_id === inCampusStudent)).toBe(
      true,
    );
    // the value never reaches the audit log
    expect(JSON.stringify(audit)).not.toContain(row.value);
    // null clears a field
    const cleared = await req('PATCH', 'admin', path, { issuer: null }, { ifMatch: '"2"' });
    expect(cleared.json<{ data: Dto }>().data).toMatchObject({ issuer: null, version: 3 });
  });

  it('requires an exact If-Match: 428 missing, 400 weak or malformed, 409 stale', async () => {
    const row = await createOne(inCampusStudent);
    const path = `${base(inCampusStudent)}/${row.id}`;
    expect((await req('PATCH', 'admin', path, { issuer: 'A' })).statusCode).toBe(428);
    for (const bad of [`W/"1"`, '*', '"0"', '"abc"', '"1", "2"']) {
      expect(
        (await req('PATCH', 'admin', path, { issuer: 'A' }, { ifMatch: bad })).statusCode,
        bad,
      ).toBe(400);
    }
    expect(
      (await req('PATCH', 'admin', path, { issuer: 'A' }, { ifMatch: '"7"' })).statusCode,
    ).toBe(409);
    expect(
      (await req('PATCH', 'admin', path, { issuer: 'A' }, { ifMatch: '"1"' })).statusCode,
    ).toBe(200);
    expect(
      (await req('PATCH', 'admin', path, { issuer: 'B' }, { ifMatch: '"1"' })).statusCode,
    ).toBe(409); // stale now
  });

  it('the identity (type, value, student) cannot be sent, and an empty or no-op change writes nothing', async () => {
    const row = await createOne(inCampusStudent, { issuer: 'Same' });
    const path = `${base(inCampusStudent)}/${row.id}`;
    for (const body of [
      { value: 'X' },
      { idType: 'APAAR' },
      { studentId: outOfCampusStudent },
      { issuer: 'A', value: 'X' },
      {},
    ]) {
      expect(
        (await req('PATCH', 'admin', path, body, { ifMatch: '"1"' })).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    const noop = await req('PATCH', 'admin', path, { issuer: 'Same' }, { ifMatch: '"1"' });
    expect(noop.statusCode).toBe(200);
    expect(noop.json<{ data: Dto }>().data.version).toBe(1);
    expect((await auditOf(row.id)).map((a) => a.action)).toEqual(['student_identifier.add']);
  });

  it('validates the validity window against the stored values, and the identifier must belong to the path student', async () => {
    const row = await createOne(inCampusStudent, { validFrom: '2024-06-01' });
    const path = `${base(inCampusStudent)}/${row.id}`;
    expect(
      (await req('PATCH', 'admin', path, { validTo: '2024-01-01' }, { ifMatch: '"1"' })).statusCode,
    ).toBe(400);
    expect(
      (await req('PATCH', 'admin', path, { validTo: '2024-12-31' }, { ifMatch: '"1"' })).statusCode,
    ).toBe(200);
    expect(
      (
        await req(
          'PATCH',
          'admin',
          `${base(outOfCampusStudent)}/${row.id}`,
          { issuer: 'X' },
          { ifMatch: '"2"' },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await req(
          'PATCH',
          'admin',
          `${base(inCampusStudent)}/${uuidv7()}`,
          { issuer: 'X' },
          { ifMatch: '"1"' },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('two concurrent changes with the same version: exactly one wins', async () => {
    const row = await createOne(inCampusStudent);
    const path = `${base(inCampusStudent)}/${row.id}`;
    const [a, b] = await Promise.all([
      req('PATCH', 'admin', path, { issuer: 'A' }, { ifMatch: '"1"' }),
      req('PATCH', 'admin', path, { issuer: 'B' }, { ifMatch: '"1"' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('there is no way to delete an identifier', async () => {
    const row = await createOne(inCampusStudent);
    const r = await req('DELETE', 'admin', `${base(inCampusStudent)}/${row.id}`, undefined, {
      key: null,
    });
    expect([404, 405]).toContain(r.statusCode);
    expect((await listOf('admin', inCampusStudent)).some((d) => d.id === row.id)).toBe(true);
  });
});

describe('bounds', () => {
  it('a student holds at most MAX_IDENTIFIERS_PER_STUDENT identifiers', async () => {
    const s = (await mkStudent()).id;
    await adminQuery(
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value)
       SELECT app.uuid_v7(), $1::uuid, $2::uuid, 'OTHER', 'bulk-' || $3 || '-' || g
         FROM generate_series(1, $4::int) AS g`,
      [T.orgId, s, RUN, MAX_IDENTIFIERS_PER_STUDENT],
    ).catch(async () => {
      // app.uuid_v7() is not callable by the harness role in every setup: fall back to ids generated here
      for (let i = 0; i < MAX_IDENTIFIERS_PER_STUDENT; i++) {
        await adminQuery(
          `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'OTHER', $4)`,
          [uuidv7(), T.orgId, s, `bulk-${RUN}-${i}`],
        );
      }
    });
    const r = await addId('admin', s, { idType: 'OTHER', value: val() });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe(
      'STUDENT_IDENTIFIER_LIMIT_REACHED',
    );
  });
});
