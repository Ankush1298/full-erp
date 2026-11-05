import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, runAs, type RawCtx } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0038 at the database layer (doc 32): app.section_class_teachers is tenant-isolated (forced RLS), staff-only
// for reads and writes, least-privilege (no DELETE, only valid_to updatable), and its guard binds every writer, the
// superuser included. runAs statements run as app_runtime in a transaction that is always rolled back.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
interface World {
  section: string;
  section2: string;
  employee: string;
  unposted: string;
  row: string;
}
const W = {} as Record<'t' | 'o', World>;

const staff = (t: IsolatedTenant): RawCtx => ({
  tenant: t.orgId,
  user: t.users.admin,
  kind: 'STAFF',
});
const student = (): RawCtx => ({ tenant: T.orgId, user: T.users.studentOne, kind: 'STUDENT' });

async function employee(t: IsolatedTenant, tag: string, posted: boolean): Promise<string> {
  const [user, id] = [uuidv7(), uuidv7()];
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1,$2,'x','ACTIVE')`,
    [user, `ct-${user}@isolated.test`],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1,$2,$3,'T','ACTIVE',$1)`,
    [user, t.orgId, `ct-${user}@isolated.test`],
  );
  await adminQuery(
    `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date)
     VALUES ($1,$2,$3,$4,'FACULTY','2025-01-01')`,
    [id, t.orgId, user, `CT${tag}`],
  );
  if (posted) {
    await adminQuery(
      `INSERT INTO app.employee_postings (id, organization_id, employee_id, department_id, valid_from, is_primary)
       VALUES ($1,$2,$3,$4,'2025-01-01',true)`,
      [uuidv7(), t.orgId, id, t.departmentId],
    );
  }
  return id;
}

async function world(t: IsolatedTenant, tag: string): Promise<World> {
  const [year, pt, prog, cohort, term, cp, section, section2, row] = Array.from({ length: 9 }, () =>
    uuidv7(),
  ) as [string, string, string, string, string, string, string, string, string];
  const q = adminQuery;
  await q(
    `INSERT INTO app.academic_years (id, organization_id, label, start_date, end_date) VALUES ($1,$2,$3,'2026-06-01','2027-05-31')`,
    [year, t.orgId, `Y${tag}`],
  );
  await q(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1,$2,'GRADE','Grade','Grades')`,
    [pt, t.orgId],
  );
  await q(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1,$2,$3,$4,'School',$5,'K12',12)`,
    [prog, t.orgId, t.departmentId, pt, `P${tag}`],
  );
  await q(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1,$2,$3,2021,'C')`,
    [cohort, t.orgId, prog],
  );
  await q(
    `INSERT INTO app.terms (id, organization_id, campus_id, academic_year_id, code, name, start_date, end_date)
     VALUES ($1,$2,$3,$4,'ANNUAL','Session','2026-06-01','2027-03-31')`,
    [term, t.orgId, t.campusId, year],
  );
  await q(
    `INSERT INTO app.cohort_periods (id, organization_id, cohort_id, term_id, period_no) VALUES ($1,$2,$3,$4,6)`,
    [cp, t.orgId, cohort, term],
  );
  await q(
    `INSERT INTO app.sections (id, organization_id, cohort_period_id, name) VALUES ($1,$2,$3,'6-A'), ($4,$2,$3,'6-B')`,
    [section, t.orgId, cp, section2],
  );
  const emp = await employee(t, `${tag}a`, true);
  const unposted = await employee(t, `${tag}b`, false);
  await q(
    `INSERT INTO app.section_class_teachers (id, organization_id, section_id, employee_id, role, valid_from)
     VALUES ($1,$2,$3,$4,'PRIMARY','2026-06-01')`,
    [row, t.orgId, section, emp],
  );
  return { section, section2, employee: emp, unposted, row };
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  W.t = await world(T, `T${T.orgId.slice(-6)}`);
  W.o = await world(OTHER, `O${OTHER.orgId.slice(-6)}`);
}, 120_000);

afterAll(async () => {
  await T.cleanup(); // removes class teachers, postings and employees
  await OTHER.cleanup();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const tbl of [
      'sections',
      'cohort_periods',
      'terms',
      'academic_years',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${tbl} WHERE organization_id = ANY($1::uuid[])`, [
        [T.orgId, OTHER.orgId],
      ]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
});

const insertAs = (ctx: RawCtx, org: string, section: string, emp: string, role = 'ASSISTANT') =>
  runAs(
    ctx,
    `INSERT INTO app.section_class_teachers (id, organization_id, section_id, employee_id, role, valid_from)
     VALUES ($1,$2,$3,$4,$5,'2026-06-01')`,
    [uuidv7(), org, section, emp, role],
  );

describe('tenant isolation and actor kinds', () => {
  it("another tenant's staff sees none of the rows; own staff does", async () => {
    const sql = 'SELECT id FROM app.section_class_teachers WHERE id = $1';
    expect((await runAs(staff(OTHER), sql, [W.t.row])).rowCount).toBe(0);
    expect((await runAs(staff(T), sql, [W.t.row])).rowCount).toBe(1);
  });

  it("a row cannot be written into another tenant, nor name another tenant's employee or section", async () => {
    expect((await insertAs(staff(OTHER), T.orgId, W.t.section2, W.t.employee)).error?.code).toBe(
      '42501',
    );
    expect(
      (await insertAs(staff(OTHER), OTHER.orgId, W.o.section2, W.t.employee)).error?.code,
    ).toBe('23503');
    expect(
      (await insertAs(staff(OTHER), OTHER.orgId, W.t.section2, W.o.employee)).error?.code,
    ).toBe('23503');
  });

  it('a student reads no class-teacher row and writes none', async () => {
    expect((await runAs(student(), 'SELECT id FROM app.section_class_teachers')).rowCount).toBe(0);
    expect((await insertAs(student(), T.orgId, W.t.section2, W.t.employee)).error?.code).toBe(
      '42501',
    );
  });
});

describe('least privilege: no DELETE, identity columns not updatable by the runtime', () => {
  it.each([
    'DELETE FROM app.section_class_teachers WHERE id = $1',
    'UPDATE app.section_class_teachers SET employee_id = employee_id WHERE id = $1',
    'UPDATE app.section_class_teachers SET section_id = section_id WHERE id = $1',
    "UPDATE app.section_class_teachers SET role = 'ASSISTANT' WHERE id = $1",
    "UPDATE app.section_class_teachers SET valid_from = '2026-07-01' WHERE id = $1",
  ])('%s → 42501', async (sql) => {
    expect((await runAs(staff(T), sql, [W.t.row])).error?.code).toBe('42501');
  });

  it('ending (valid_to) is the only allowed change, inside the term', async () => {
    const ok = await runAs(
      staff(T),
      `UPDATE app.section_class_teachers SET valid_to = '2026-09-30' WHERE id = $1`,
      [W.t.row],
    );
    expect(ok.error).toBeUndefined();
    const late = await runAs(
      staff(T),
      `UPDATE app.section_class_teachers SET valid_to = '2027-06-30' WHERE id = $1`,
      [W.t.row],
    );
    expect(late.error?.code).toBe('23514');
  });
});

describe('runbook post-checks (m3-class-teachers-progression-rollout.md §4)', () => {
  it('the replaced enrolment guard and the grants are what the runbook expects', async () => {
    const [g] = await adminQuery<{ new_guard: boolean }>(
      `SELECT position('term_enrollments_same_program_ck' IN pg_get_functiondef('app.term_enrollments_guard()'::regprocedure)) > 0
              AS new_guard`,
    );
    expect(g?.new_guard).toBe(true);
    const table = await adminQuery<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_runtime' AND table_name = 'section_class_teachers' ORDER BY 1`,
    );
    expect(table.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const cols = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'app_runtime' AND table_name = 'section_class_teachers' AND privilege_type = 'UPDATE'`,
    );
    expect(cols.map((r) => r.column_name)).toEqual(['valid_to']);
  });
});

describe('the guard binds privileged writers too', () => {
  const superFails = async (sql: string, p: unknown[]): Promise<string | undefined> => {
    try {
      await adminQuery(sql, p);
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };
  const superInsert = (section: string, emp: string, role: string, from = '2026-06-01') =>
    superFails(
      `INSERT INTO app.section_class_teachers (id, organization_id, section_id, employee_id, role, valid_from)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv7(), T.orgId, section, emp, role, from],
    );

  it('identity is immutable and an ended row is terminal', async () => {
    expect(
      await superFails(`UPDATE app.section_class_teachers SET role = 'ASSISTANT' WHERE id = $1`, [
        W.t.row,
      ]),
    ).toBe('23001');
    expect(
      await superFails(`UPDATE app.section_class_teachers SET valid_to = NULL WHERE id = $1`, [
        W.t.row,
      ]),
    ).toBeUndefined(); // NULL -> NULL is no change
  });

  it('a second PRIMARY on the section, the same PRIMARY on another section, an unposted employee: refused', async () => {
    const other = await employee(T, `x${uuidv7().slice(-6)}`, true);
    expect(await superInsert(W.t.section, other, 'PRIMARY')).toBe('23P01');
    expect(await superInsert(W.t.section2, W.t.employee, 'PRIMARY')).toBe('23P01');
    expect(await superInsert(W.t.section2, W.t.unposted, 'PRIMARY')).toBe('23514');
    expect(await superInsert(W.t.section2, other, 'PRIMARY', '2027-04-01')).toBe('23514'); // outside the term
  });
});
