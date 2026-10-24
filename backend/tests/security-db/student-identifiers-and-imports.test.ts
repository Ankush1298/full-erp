import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, ids, runAs, runStepsAs, type RawCtx } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0035 at the database layer: tenant isolation, forced row security, the owner-only policy of import jobs, the
// tenant-safe composite keys, least-privilege grants, CHECKs and guards. Every statement runs through runAs / runStepsAs
// (one transaction, always rolled back); the rows they look at are committed once, in PRIVATE tenants.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const HASH = 'a'.repeat(64);
const I = { one: uuidv7(), two: uuidv7(), foreign: uuidv7() };
const J = {
  admin: uuidv7(), // DRAFT job of T's administrator
  registrar: uuidv7(), // DRAFT job of T's registrar
  foreign: uuidv7(), // DRAFT job of OTHER's administrator
  done: uuidv7(), // COMMITTED job of T's administrator
  failed: uuidv7(), // FAILED job of T's administrator
};
const R = {
  admin: uuidv7(),
  registrar: uuidv7(),
  foreign: uuidv7(),
  done: uuidv7(),
  failed: uuidv7(),
};

const staff = (t: IsolatedTenant, user: string): RawCtx => ({
  tenant: t.orgId,
  user,
  kind: 'STAFF',
});
const adminT = (): RawCtx => staff(T, T.users.admin);
const registrarT = (): RawCtx => staff(T, T.users.registrarOrg);
const adminOther = (): RawCtx => staff(OTHER, OTHER.users.admin);
const studentOneT = (): RawCtx => ({ tenant: T.orgId, user: T.users.studentOne, kind: 'STUDENT' });
const studentTwoT = (): RawCtx => ({ tenant: T.orgId, user: T.users.studentTwo, kind: 'STUDENT' });

async function mkJob(
  t: IsolatedTenant,
  createdBy: string,
  id: string,
  rowId: string,
  type = 'STUDENT_RECORDS',
): Promise<void> {
  await adminQuery(
    `INSERT INTO app.import_jobs (id, organization_id, type, created_by, row_count) VALUES ($1, $2, $3, $4, 1)`,
    [id, t.orgId, type, createdBy],
  );
  await adminQuery(
    `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw) VALUES ($1, $2, $3, 1, '{"email":"x@y.test"}')`,
    [rowId, t.orgId, id],
  );
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  const ident = (id: string, org: string, student: string, type: string, value: string) =>
    adminQuery(
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, $4, $5)`,
      [id, org, student, type, value],
    );
  await ident(I.one, T.orgId, T.students.one, 'UNIVERSITY_PRN', 'PRN-ONE');
  await ident(I.two, T.orgId, T.students.two, 'APAAR', 'APAAR-TWO');
  await ident(I.foreign, OTHER.orgId, OTHER.students.one, 'UNIVERSITY_PRN', 'PRN-FOREIGN');

  await mkJob(T, T.users.admin, J.admin, R.admin);
  await mkJob(T, T.users.registrarOrg, J.registrar, R.registrar);
  await mkJob(OTHER, OTHER.users.admin, J.foreign, R.foreign);
  await mkJob(T, T.users.admin, J.done, R.done);
  await mkJob(T, T.users.admin, J.failed, R.failed);
  // a finished job: VALIDATED, its row COMMITTED while the job is still open, then COMMITTED
  await adminQuery(
    `UPDATE app.import_jobs SET status = 'VALIDATED', validation_hash = $2 WHERE id = $1`,
    [J.done, HASH],
  );
  await adminQuery(
    `UPDATE app.import_job_rows SET status = 'COMMITTED', student_id = $2 WHERE id = $1`,
    [R.done, T.students.one],
  );
  await adminQuery(
    `UPDATE app.import_jobs SET status = 'COMMITTED', committed_at = now() WHERE id = $1`,
    [J.done],
  );
  await adminQuery(`UPDATE app.import_jobs SET status = 'FAILED' WHERE id = $1`, [J.failed]);
}, 120_000);

afterAll(async () => {
  await T.cleanup();
  await OTHER.cleanup();
});

describe('0035: permissions and shape', () => {
  it('registers student.record.update and import.job.manage as SENSITIVE', async () => {
    const rows = await adminQuery<{ code: string; sensitivity: string }>(
      `SELECT code, sensitivity FROM platform.permissions WHERE code IN ('student.record.update', 'import.job.manage') ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'import.job.manage', sensitivity: 'SENSITIVE' },
      { code: 'student.record.update', sensitivity: 'SENSITIVE' },
    ]);
  });

  it('all three tables: row security enabled AND forced; the runtime role has no DELETE or TRUNCATE', async () => {
    for (const table of ['student_identifiers', 'import_jobs', 'import_job_rows']) {
      const [f] = await adminQuery<{ s: boolean; f: boolean }>(
        `SELECT relrowsecurity s, relforcerowsecurity f FROM pg_class WHERE oid = $1::regclass`,
        [`app.${table}`],
      );
      expect(f, table).toEqual({ s: true, f: true });
      const [p] = await adminQuery<{ sel: boolean; ins: boolean; del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('app_runtime', $1, 'SELECT') sel, has_table_privilege('app_runtime', $1, 'INSERT') ins,
                has_table_privilege('app_runtime', $1, 'DELETE') del, has_table_privilege('app_runtime', $1, 'TRUNCATE') trunc`,
        [`app.${table}`],
      );
      expect(p, table).toEqual({ sel: true, ins: true, del: false, trunc: false });
    }
  });

  it('the runtime role can update only the reviewed columns', async () => {
    const cols = async (table: string): Promise<string[]> =>
      (
        await adminQuery<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'app' AND table_name = $1
              AND has_column_privilege('app_runtime', format('app.%I', $1::text), column_name, 'UPDATE')
            ORDER BY 1`,
          [table],
        )
      ).map((c) => c.column_name);
    expect(await cols('student_identifiers')).toEqual(['issuer', 'valid_from', 'valid_to']);
    expect(await cols('import_jobs')).toEqual([
      'committed_at',
      'match_binding',
      'match_binding_key_label',
      'status',
      'summary',
      'validation_hash',
    ]);
    expect(await cols('import_job_rows')).toEqual([
      'employee_id',
      'errors',
      'match_presence',
      'normalized',
      'status',
      'student_id',
      'warnings',
    ]);
  });

  it('every reference to a tenant-owned table is a TENANT-prefixed composite key, and the identifier key is unique per organization', async () => {
    const defs = await adminQuery<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname IN ('student_identifiers_student_fk', 'student_identifiers_type_value_uq', 'import_jobs_creator_fk',
                          'import_job_rows_job_fk', 'import_job_rows_student_fk', 'import_job_rows_employee_fk')
        ORDER BY conname`,
    );
    const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(byName.student_identifiers_student_fk).toContain(
      'FOREIGN KEY (organization_id, student_id) REFERENCES app.students(organization_id, id)',
    );
    expect(byName.student_identifiers_type_value_uq).toBe(
      'UNIQUE (organization_id, id_type, value)',
    );
    expect(byName.import_jobs_creator_fk).toContain(
      'FOREIGN KEY (organization_id, created_by) REFERENCES app.users(organization_id, id)',
    );
    expect(byName.import_job_rows_job_fk).toContain(
      'FOREIGN KEY (organization_id, job_id) REFERENCES app.import_jobs(organization_id, id)',
    );
    expect(byName.import_job_rows_student_fk).toContain(
      'FOREIGN KEY (organization_id, student_id) REFERENCES app.students(organization_id, id)',
    );
    expect(byName.import_job_rows_employee_fk).toContain(
      'FOREIGN KEY (organization_id, employee_id) REFERENCES app.employees(organization_id, id)',
    );
  });
});

describe('student_identifiers: isolation and access', () => {
  it('each tenant sees only its own identifiers; without a tenant context nothing is visible', async () => {
    expect(ids(await runAs(adminT(), 'SELECT id FROM app.student_identifiers'))).toEqual(
      [I.one, I.two].sort(),
    );
    expect(ids(await runAs(adminOther(), 'SELECT id FROM app.student_identifiers'))).toEqual([
      I.foreign,
    ]);
    const none = await runAs(
      { tenant: null, user: null, kind: null },
      'SELECT id FROM app.student_identifiers',
    );
    expect(none.error !== undefined || none.rowCount === 0).toBe(true);
  });

  it('a STUDENT sees only the identifiers of their own record, and cannot write', async () => {
    expect(ids(await runAs(studentOneT(), 'SELECT id FROM app.student_identifiers'))).toEqual([
      I.one,
    ]);
    expect(ids(await runAs(studentTwoT(), 'SELECT id FROM app.student_identifiers'))).toEqual([
      I.two,
    ]);
    const ins = await runAs(
      studentOneT(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'OTHER', 'S1')`,
      [uuidv7(), T.orgId, T.students.one],
    );
    expect(ins.error?.code).toBe('42501');
    const upd = await runAs(
      studentOneT(),
      `UPDATE app.student_identifiers SET issuer = 'me' WHERE id = $1`,
      [I.one],
    );
    expect(upd.error?.code === '42501' || upd.rowCount === 0).toBe(true);
  });

  it('staff cannot write into, or point at, another tenant', async () => {
    const insertOther = await runAs(
      adminT(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'OTHER', 'X')`,
      [uuidv7(), OTHER.orgId, OTHER.students.one],
    );
    expect(insertOther.error?.code).toBe('42501'); // row security
    const pointOther = await runAs(
      adminT(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'OTHER', 'Y')`,
      [uuidv7(), T.orgId, OTHER.students.one],
    );
    expect(pointOther.error?.code).toBe('23503'); // the composite key: the student is not in THIS tenant
    const changeOther = await runAs(
      adminT(),
      `UPDATE app.student_identifiers SET issuer = 'x' WHERE id = $1`,
      [I.foreign],
    );
    expect(changeOther.rowCount).toBe(0);
  });
});

describe('student_identifiers: integrity', () => {
  it('only the five documented types are accepted; the admission number is not an identifier type', async () => {
    for (const bad of [
      'ADMISSION_NUMBER',
      'REGISTRATION_NUMBER',
      'INSTITUTIONAL_EMAIL',
      'prn',
      '',
    ]) {
      const r = await adminQuery(
        `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, $4, 'v')`,
        [uuidv7(), T.orgId, T.students.one, bad],
      ).catch((e: { code?: string }) => e);
      expect((r as { code?: string }).code, bad).toBe('23514');
    }
  });

  it('(organization, id_type, value) is unique across students; the same value elsewhere is fine', async () => {
    const dup = await runAs(
      adminT(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'UNIVERSITY_PRN', 'PRN-ONE')`,
      [uuidv7(), T.orgId, T.students.two],
    );
    expect(dup.error?.code).toBe('23505');
    const otherType = await runAs(
      adminT(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'LIBRARY_CARD', 'PRN-ONE')`,
      [uuidv7(), T.orgId, T.students.two],
    );
    expect(otherType.error).toBeUndefined();
    const otherTenant = await runAs(
      adminOther(),
      `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value) VALUES ($1, $2, $3, 'UNIVERSITY_PRN', 'PRN-ONE')`,
      [uuidv7(), OTHER.orgId, OTHER.students.one],
    );
    expect(otherTenant.error).toBeUndefined();
  });

  it('value shape and validity window are checked by the database', async () => {
    const ins = (value: string, extra = '', cols = '') =>
      runAs(
        adminT(),
        `INSERT INTO app.student_identifiers (id, organization_id, student_id, id_type, value${cols}) VALUES ($1, $2, $3, 'OTHER', $4${extra})`,
        [uuidv7(), T.orgId, T.students.one, value],
      );
    expect((await ins('')).error?.code).toBe('23514');
    expect((await ins(' padded ')).error?.code).toBe('23514');
    expect((await ins('x'.repeat(101))).error?.code).toBe('23514');
    expect(
      (await ins('ok1', ", DATE '2025-01-01', DATE '2024-01-01'", ', valid_from, valid_to')).error
        ?.code,
    ).toBe('23514');
    expect((await ins('ok2', ", DATE '1800-01-01'", ', valid_from')).error?.code).toBe('23514');
    expect(
      (await ins('ok3', ", DATE '2024-01-01', DATE '2024-01-01'", ', valid_from, valid_to')).error,
    ).toBeUndefined();
  });

  it('the identity is immutable: the runtime role cannot update it, and a trigger stops every other writer', async () => {
    for (const set of ["value = 'NEW'", "id_type = 'APAAR'", `student_id = '${T.students.two}'`]) {
      const r = await runAs(adminT(), `UPDATE app.student_identifiers SET ${set} WHERE id = $1`, [
        I.one,
      ]);
      expect(r.error?.code, set).toBe('42501');
      const root = await adminQuery(`UPDATE app.student_identifiers SET ${set} WHERE id = $1`, [
        I.one,
      ]).catch((e: { code?: string }) => e);
      expect((root as { code?: string }).code, set).toBe('23001');
    }
    const ok = await runStepsAs(adminT(), [
      [`UPDATE app.student_identifiers SET issuer = 'Issuer' WHERE id = $1`, [I.one]],
      ['SELECT issuer, version FROM app.student_identifiers WHERE id = $1', [I.one]],
    ]);
    expect(ok.rows[0]).toEqual({ issuer: 'Issuer', version: 2 });
  });

  it('nothing deletes an identifier', async () => {
    const r = await runAs(adminT(), 'DELETE FROM app.student_identifiers WHERE id = $1', [I.one]);
    expect(r.error?.code).toBe('42501');
  });
});

describe('import jobs and rows: owner-only access inside a tenant, isolation across tenants', () => {
  it('a user sees only the jobs they created; another user of the tenant and another tenant see none of them', async () => {
    expect(ids(await runAs(adminT(), 'SELECT id FROM app.import_jobs'))).toEqual(
      [J.admin, J.done, J.failed].sort(),
    );
    expect(ids(await runAs(registrarT(), 'SELECT id FROM app.import_jobs'))).toEqual([J.registrar]);
    expect(ids(await runAs(adminOther(), 'SELECT id FROM app.import_jobs'))).toEqual([J.foreign]);
    expect(ids(await runAs(adminT(), 'SELECT id FROM app.import_job_rows'))).toEqual(
      [R.admin, R.done, R.failed].sort(),
    );
    expect(ids(await runAs(registrarT(), 'SELECT id FROM app.import_job_rows'))).toEqual([
      R.registrar,
    ]);
    expect(ids(await runAs(adminOther(), 'SELECT id FROM app.import_job_rows'))).toEqual([
      R.foreign,
    ]);
  });

  it('a STUDENT actor, an actor kind other than STAFF and a missing context see nothing', async () => {
    expect((await runAs(studentOneT(), 'SELECT id FROM app.import_jobs')).rowCount).toBe(0);
    expect((await runAs(studentOneT(), 'SELECT id FROM app.import_job_rows')).rowCount).toBe(0);
    const ai = await runAs(
      { tenant: T.orgId, user: T.users.admin, kind: 'AI' },
      'SELECT id FROM app.import_jobs',
    );
    expect(ai.error !== undefined || ai.rowCount === 0).toBe(true);
    const none = await runAs(
      { tenant: null, user: null, kind: null },
      'SELECT id FROM app.import_jobs',
    );
    expect(none.error !== undefined || none.rowCount === 0).toBe(true);
  });

  it('nobody can create a job for someone else, change someone else’s job, or add rows to it', async () => {
    const forge = await runAs(
      adminT(),
      `INSERT INTO app.import_jobs (id, organization_id, type, created_by, row_count) VALUES ($1, $2, 'STUDENT_RECORDS', $3, 1)`,
      [uuidv7(), T.orgId, T.users.registrarOrg],
    );
    expect(forge.error?.code).toBe('42501');
    const crossTenant = await runAs(
      adminT(),
      `INSERT INTO app.import_jobs (id, organization_id, type, created_by, row_count) VALUES ($1, $2, 'STUDENT_RECORDS', $3, 1)`,
      [uuidv7(), OTHER.orgId, T.users.admin],
    );
    expect(crossTenant.error?.code).toBe('42501');
    expect(
      (
        await runAs(adminT(), `UPDATE app.import_jobs SET summary = '{"x":1}' WHERE id = $1`, [
          J.registrar,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await runAs(registrarT(), `UPDATE app.import_jobs SET summary = '{"x":1}' WHERE id = $1`, [
          J.admin,
        ])
      ).rowCount,
    ).toBe(0);
    const addRow = await runAs(
      registrarT(),
      `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw) VALUES ($1, $2, $3, 2, '{}')`,
      [uuidv7(), T.orgId, J.admin],
    );
    // refused either by the row guard (the job is invisible to this user, so it is not a DRAFT they can see) or by row security
    expect(['23001', '42501']).toContain(addRow.error?.code);
    expect(
      (
        await runAs(
          registrarT(),
          `UPDATE app.import_job_rows SET status = 'INVALID', errors = '[{}]' WHERE id = $1`,
          [R.admin],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('a row and a record it points to must belong to the row’s own tenant', async () => {
    const foreignJob = await adminQuery(
      `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw) VALUES ($1, $2, $3, 9, '{}')`,
      [uuidv7(), T.orgId, J.foreign],
    ).catch((e: { code?: string }) => e);
    // the row guard cannot see a job of another tenant; were it bypassed, the composite key would refuse it
    expect(['23001', '23503']).toContain((foreignJob as { code?: string }).code);
    const foreignStudent = await adminQuery(
      `UPDATE app.import_job_rows SET status = 'COMMITTED', student_id = $2 WHERE id = $1`,
      [R.admin, OTHER.students.one],
    ).catch((e: { code?: string }) => e);
    expect((foreignStudent as { code?: string }).code).toBe('23503');
  });

  it('a job’s creator must be a user of the job’s tenant', async () => {
    const r = await adminQuery(
      `INSERT INTO app.import_jobs (id, organization_id, type, created_by, row_count) VALUES ($1, $2, 'STUDENT_RECORDS', $3, 1)`,
      [uuidv7(), T.orgId, OTHER.users.admin],
    ).catch((e: { code?: string }) => e);
    expect((r as { code?: string }).code).toBe('23503');
  });
});

describe('import jobs and rows: lifecycle guards', () => {
  const upd = (set: string, id: string) =>
    runAs(adminT(), `UPDATE app.import_jobs SET ${set} WHERE id = $1`, [id]);

  it('statuses move DRAFT -> VALIDATED -> COMMITTED only; finished jobs are immutable', async () => {
    expect(
      (
        await upd(
          `status = 'COMMITTED', committed_at = now(), validation_hash = '${HASH}'`,
          J.admin,
        )
      ).error?.code,
    ).toBe('23001');
    expect(
      (await upd(`status = 'VALIDATED', validation_hash = '${HASH}'`, J.admin)).error,
    ).toBeUndefined();
    expect((await upd(`status = 'FAILED'`, J.admin)).error).toBeUndefined();
    for (const id of [J.done, J.failed]) {
      for (const set of [
        `summary = '{"x":1}'`,
        `status = 'DRAFT'`,
        `status = 'VALIDATED', validation_hash = '${HASH}'`,
      ]) {
        expect((await upd(set, id)).error?.code, `${id} ${set}`).toBe('23001');
      }
    }
    // a validated job can go back to DRAFT (re-validation found errors)
    const back = await runStepsAs(adminT(), [
      [
        `UPDATE app.import_jobs SET status = 'VALIDATED', validation_hash = '${HASH}' WHERE id = $1`,
        [J.admin],
      ],
      [`UPDATE app.import_jobs SET status = 'DRAFT' WHERE id = $1`, [J.admin]],
    ]);
    expect(back.error).toBeUndefined();
  });

  it('the checks tie the status to its evidence', async () => {
    expect((await upd(`status = 'VALIDATED'`, J.admin)).error?.code).toBe('23514'); // no hash
    expect((await upd(`validation_hash = 'short'`, J.admin)).error?.code).toBe('23514');
    const committedNoDate = await runStepsAs(adminT(), [
      [
        `UPDATE app.import_jobs SET status = 'VALIDATED', validation_hash = '${HASH}' WHERE id = $1`,
        [J.admin],
      ],
      [`UPDATE app.import_jobs SET status = 'COMMITTED' WHERE id = $1`, [J.admin]],
    ]);
    expect(committedNoDate.error?.code).toBe('23514'); // COMMITTED needs committed_at
    for (const [cols, vals] of [
      ['type, created_by, row_count', "'STUDENT_RECORDS', $2, 0"],
      ['type, created_by, row_count', "'STUDENT_RECORDS', $2, 1001"],
      ['type, created_by, row_count', "'NOPE', $2, 1"],
      ['type, created_by, row_count, status', "'STUDENT_RECORDS', $2, 1, 'DONE'"],
      ['type, created_by, row_count, summary', "'STUDENT_RECORDS', $2, 1, '[]'"],
    ] as const) {
      const r = await runAs(
        adminT(),
        `INSERT INTO app.import_jobs (id, organization_id, ${cols}) VALUES ($1, '${T.orgId}', ${vals})`,
        [uuidv7(), T.users.admin],
      );
      expect(r.error?.code, vals).toBe('23514');
    }
  });

  it('the identity of a job is immutable: no privilege for the runtime role, a trigger for every other writer', async () => {
    for (const set of [
      "type = 'EMPLOYEE_RECORDS'",
      `created_by = '${T.users.registrarOrg}'`,
      'row_count = 5',
    ]) {
      expect((await upd(set, J.admin)).error?.code, set).toBe('42501');
      const root = await adminQuery(`UPDATE app.import_jobs SET ${set} WHERE id = $1`, [
        J.admin,
      ]).catch((e: { code?: string }) => e);
      expect((root as { code?: string }).code, set).toBe('23001');
    }
  });

  it('rows of a COMMITTED or FAILED job cannot be added, changed or re-pointed, even by a superuser', async () => {
    for (const [job, row] of [
      [J.done, R.done],
      [J.failed, R.failed],
    ] as const) {
      const add = await adminQuery(
        `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw) VALUES ($1, $2, $3, 5, '{}')`,
        [uuidv7(), T.orgId, job],
      ).catch((e: { code?: string }) => e);
      expect((add as { code?: string }).code, `add ${job}`).toBe('23001');
      for (const set of [
        "status = 'INVALID', errors = '[{}]'",
        "warnings = '[{}]'",
        "normalized = '{}'",
      ]) {
        const asRuntime = await runAs(
          adminT(),
          `UPDATE app.import_job_rows SET ${set} WHERE id = $1`,
          [row],
        );
        expect(asRuntime.error?.code, `${job} ${set}`).toBe('23001');
        const asRoot = await adminQuery(`UPDATE app.import_job_rows SET ${set} WHERE id = $1`, [
          row,
        ]).catch((e: { code?: string }) => e);
        expect((asRoot as { code?: string }).code, `${job} ${set}`).toBe('23001');
      }
    }
    // rows can only be added while the job is a DRAFT
    const validated = await runStepsAs(adminT(), [
      [
        `UPDATE app.import_jobs SET status = 'VALIDATED', validation_hash = '${HASH}' WHERE id = $1`,
        [J.admin],
      ],
      [
        `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw) VALUES ($1, $2, $3, 7, '{}')`,
        [uuidv7(), T.orgId, J.admin],
      ],
    ]);
    expect(validated.error?.code).toBe('23001');
  });

  it('the raw submitted values and the row identity are immutable', async () => {
    expect(
      (await runAs(adminT(), `UPDATE app.import_job_rows SET raw = '{}' WHERE id = $1`, [R.admin]))
        .error?.code,
    ).toBe('42501');
    for (const set of ['raw = \'{"a":"b"}\'', 'row_no = 2']) {
      const root = await adminQuery(`UPDATE app.import_job_rows SET ${set} WHERE id = $1`, [
        R.admin,
      ]).catch((e: { code?: string }) => e);
      expect((root as { code?: string }).code, set).toBe('23001');
    }
  });

  it('a row is COMMITTED exactly when it points to one created record', async () => {
    const row = (set: string) =>
      runAs(adminT(), `UPDATE app.import_job_rows SET ${set} WHERE id = $1`, [R.admin]);
    expect((await row(`status = 'COMMITTED'`)).error?.code).toBe('23514');
    expect((await row(`student_id = '${T.students.one}'`)).error?.code).toBe('23514'); // pointing without being committed
    const both = await adminQuery(
      `SELECT id FROM app.employees WHERE organization_id = $1 LIMIT 1`,
      [T.orgId],
    );
    if (both[0]) {
      expect(
        (
          await row(
            `status = 'COMMITTED', student_id = '${T.students.one}', employee_id = '${both[0].id as string}'`,
          )
        ).error?.code,
      ).toBe('23514');
    }
    expect((await row(`status = 'INVALID'`)).error?.code).toBe('23514'); // INVALID needs at least one error
    expect((await row(`errors = '{}'::jsonb`)).error?.code).toBe('23514');
    expect(
      (await row(`status = 'COMMITTED', student_id = '${T.students.one}'`)).error,
    ).toBeUndefined();
  });

  it('nothing deletes a job or a row', async () => {
    expect(
      (await runAs(adminT(), 'DELETE FROM app.import_jobs WHERE id = $1', [J.admin])).error?.code,
    ).toBe('42501');
    expect(
      (await runAs(adminT(), 'DELETE FROM app.import_job_rows WHERE id = $1', [R.admin])).error
        ?.code,
    ).toBe('42501');
  });
});

// Migration 0036: users.date_of_birth (owner decision 2026-10-22) and import_job_rows.match_presence.
describe('migration 0036: date of birth and the sensitive import cells', () => {
  it('adds one nullable date column to users, and none to students', async () => {
    const cols = await adminQuery<{
      table_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND column_name IN ('date_of_birth', 'dob')`,
    );
    expect(cols).toEqual([
      { table_name: 'users', data_type: 'date', is_nullable: 'YES', column_default: null },
    ]);
    // no backfill and no inference: a user created without one has none
    const nulls = await adminQuery(
      `SELECT 1 FROM app.users WHERE organization_id = $1 AND date_of_birth IS NOT NULL`,
      [T.orgId],
    );
    expect(nulls).toHaveLength(0);
  });

  it('the runtime role can read the column but has no privilege to write it, and the range is checked', async () => {
    expect(
      (
        await runAs(adminT(), 'SELECT date_of_birth FROM app.users WHERE id = $1', [
          T.users.studentOne,
        ])
      ).rowCount,
    ).toBe(1);
    const upd = await runAs(
      adminT(),
      `UPDATE app.users SET date_of_birth = '2005-03-04' WHERE id = $1`,
      [T.users.studentOne],
    );
    expect(upd.error?.code).toBe('42501');
    const ins = await runAs(
      adminT(),
      `INSERT INTO app.users (id, organization_id, email, display_name, date_of_birth)
       VALUES ($1, $2, 'dob-ins@isolated.test', 'x', '2005-03-04')`,
      [uuidv7(), T.orgId],
    );
    // INSERT on app.users is table-wide since 0003, so a row CAN be created with a date of birth by the runtime role (no
    // code does); 0036 deliberately does not narrow that grant. What it refuses is any later UPDATE.
    expect(ins.error).toBeUndefined();
    for (const bad of ['1899-12-31', '2201-01-01']) {
      const r = await adminQuery(`UPDATE app.users SET date_of_birth = $2 WHERE id = $1`, [
        T.users.studentTwo,
        bad,
      ]).catch((e: { code?: string }) => e);
      expect((r as { code?: string }).code, bad).toBe('23514');
    }
  });

  it('a date of birth is visible only inside its tenant, and a student sees only their own account row', async () => {
    await adminQuery(`UPDATE app.users SET date_of_birth = '2005-03-04' WHERE id = $1`, [
      T.users.studentOne,
    ]);
    try {
      expect(
        (
          await runAs(adminOther(), 'SELECT date_of_birth FROM app.users WHERE id = $1', [
            T.users.studentOne,
          ])
        ).rowCount,
      ).toBe(0);
      const own = await runAs(studentOneT(), 'SELECT id, date_of_birth FROM app.users');
      expect(own.rowCount).toBe(1);
      expect(
        (await runAs(studentTwoT(), 'SELECT id FROM app.users WHERE id = $1', [T.users.studentOne]))
          .rowCount,
      ).toBe(0);
    } finally {
      await adminQuery(`UPDATE app.users SET date_of_birth = NULL WHERE id = $1`, [
        T.users.studentOne,
      ]);
    }
  });

  it('no column of the import tables can hold a date of birth or a phone number', async () => {
    const cols = await adminQuery<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name IN ('import_jobs', 'import_job_rows') ORDER BY 1, 2`,
    );
    // the cells themselves (match_input) do not exist; the 0036 additions are two bits of presence and the keyed MAC
    expect(cols.map((c) => c.column_name)).not.toContain('match_input');
    expect(cols.filter((c) => c.column_name.startsWith('match_'))).toEqual([
      { table_name: 'import_job_rows', column_name: 'match_presence', data_type: 'smallint' },
      { table_name: 'import_jobs', column_name: 'match_binding', data_type: 'bytea' },
      { table_name: 'import_jobs', column_name: 'match_binding_key_label', data_type: 'text' },
    ]);
  });

  it('match_presence is two bits, owner-writable while the job is open, and frozen with the job', async () => {
    const set = (v: number, row: string) =>
      runAs(adminT(), `UPDATE app.import_job_rows SET match_presence = ${v} WHERE id = $1`, [row]);
    expect((await set(3, R.admin)).rowCount).toBe(1);
    expect((await set(4, R.admin)).error?.code).toBe('23514');
    expect((await set(-1, R.admin)).error?.code).toBe('23514');
    // someone else's job: invisible, so nothing is updated
    expect(
      (
        await runAs(
          registrarT(),
          `UPDATE app.import_job_rows SET match_presence = 1 WHERE id = $1`,
          [R.admin],
        )
      ).rowCount,
    ).toBe(0);
    // a finished job's rows are frozen
    expect((await set(1, R.done)).error?.code).toBe('23001');
  });

  it('match_binding is a 32-byte MAC with a key id, only on a COMMITTED job, and frozen with the job', async () => {
    const mac = `'\\x${'ab'.repeat(32)}'::bytea`;
    const bind = (job: string, value: string, keyId: string | null, as = adminT()) =>
      runAs(
        as,
        `UPDATE app.import_jobs SET match_binding = ${value}, match_binding_key_label = $2 WHERE id = $1`,
        [job, keyId],
      );
    // an open job cannot carry one
    expect((await bind(J.admin, mac, 'k1')).error?.code).toBe('23514');
    // a superuser cannot attach one to an uncommitted job, a wrong length, a bad key id, or one half of the pair
    for (const [value, keyId] of [
      [mac, 'k1'],
      [`'\\x${'ab'.repeat(16)}'::bytea`, 'k1'],
      [mac, 'bad id'],
      [mac, null],
      ['NULL', 'k1'],
    ] as const) {
      const r = await adminQuery(
        `UPDATE app.import_jobs SET match_binding = ${value}, match_binding_key_label = $2 WHERE id = $1`,
        [J.registrar, keyId],
      ).catch((e: { code?: string }) => e);
      expect((r as { code?: string }).code, `${value} ${keyId}`).toBe('23514');
    }
    // a finished job is immutable for every writer
    expect((await bind(J.done, 'NULL', null)).error?.code).toBe('23001');
  });
});
