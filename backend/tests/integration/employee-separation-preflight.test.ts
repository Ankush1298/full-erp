import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Owner Decision 5: the read-only legacy-separated-row preflight of docs/runbooks/employee-separation-preflight.md.
// The SQL is extracted from the runbook and executed here, on the disposable harness only, against rows planted by a
// superuser session with session_replication_role = replica (the guard makes that state unreachable otherwise).

const RUN = randomBytes(3).toString('hex').toUpperCase();
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 2 });
const db = new Database(pool);
let T!: IsolatedTenant;
let admin!: TrustedContext;
let legacy!: { id: string; code: string };
let dated!: string;
let active!: string;

const runbook = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../docs/runbooks/employee-separation-preflight.md',
  ),
  'utf8',
);
const preflightSql = (): string => {
  const section = runbook.slice(runbook.indexOf('## 3. Read-only preflight'));
  const m = /```sql\n([\s\S]*?)```/.exec(section);
  if (!m) throw new Error('the preflight SQL block is missing from the runbook');
  return m[1]!;
};

async function newUser(): Promise<string> {
  const id = uuidv7();
  const email = `pre-${RUN.toLowerCase()}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [id, T.orgId, email],
  );
  return id;
}

/** Superuser session with triggers bypassed: the only way to reproduce a pre-0034 row. */
async function plant(status: string, leaving: string | null, code: string): Promise<string> {
  const id = uuidv7();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('SET session_replication_role = replica');
    await c.query(
      `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date, status, leaving_date)
       VALUES ($1, $2, $3, $4, 'STAFF', '2020-01-01', $5, $6::date)`,
      [id, T.orgId, await newUser(), code, status, leaving],
    );
  } finally {
    await c.end();
  }
  return id;
}

async function runPreflight(url: string = inject('dbAdminUrl')): Promise<{
  summary: { organization_id: string; separated_without_leaving_date: string }[];
  detail: Record<string, unknown>[];
  visible: number;
  seesAll: boolean;
}> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const results = (await c.query(preflightSql())) as unknown as pg.QueryResult[];
    // BEGIN READ ONLY, (a), (b), (c), ROLLBACK
    return {
      summary: results[1]!.rows as never,
      detail: results[2]!.rows as Record<string, unknown>[],
      visible: Number(
        (results[3]!.rows[0] as { employees_visible_to_this_role: string })
          .employees_visible_to_this_role,
      ),
      seesAll: (results[3]!.rows[0] as { sees_all_tenant_rows: boolean }).sees_all_tenant_rows,
    };
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  admin = issueTrustedContext({ tenantId: T.orgId, userId: T.users.admin, actorKind: 'STAFF' });
  legacy = { code: `PRE${RUN}-1`, id: '' };
  legacy.id = await plant('SEPARATED', null, legacy.code);
  dated = await plant('SEPARATED', '2023-05-31', `PRE${RUN}-2`);
  active = await plant('ACTIVE', null, `PRE${RUN}-3`);
});

afterAll(async () => {
  await T.cleanup();
  await pool.end().catch(() => undefined);
});

describe('legacy separated-employee preflight (runbook employee-separation-preflight.md)', () => {
  it('the guard really makes the legacy state unreachable for normal writers (so the plan is needed)', async () => {
    await expect(
      adminQuery(
        `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date, status)
         VALUES ($1, $2, $3, $4, 'STAFF', '2020-01-01', 'SEPARATED')`,
        [uuidv7(), T.orgId, await newUser(), `PRE${RUN}-X`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('reports exactly the SEPARATED rows without a date, per organisation, and nothing else', async () => {
    const r = await runPreflight();
    expect(r.seesAll).toBe(true); // statement (c): this role bypasses RLS, so an empty result would be meaningful
    expect(r.visible).toBeGreaterThan(0);
    const mine = r.summary.find((s) => s.organization_id === T.orgId);
    expect(Number(mine?.separated_without_leaving_date)).toBe(1);
    const rows = r.detail.filter((d) => d.organization_id === T.orgId);
    expect(rows.map((d) => d.employee_id)).toEqual([legacy.id]);
    expect(rows.map((d) => d.employee_id)).not.toContain(dated);
    expect(rows.map((d) => d.employee_id)).not.toContain(active);
    // every row of the summary is backed by detail rows of the same organisation
    for (const s of r.summary) {
      expect(r.detail.filter((d) => d.organization_id === s.organization_id).length).toBe(
        Number(s.separated_without_leaving_date),
      );
    }
  });

  it('exposes no personal data: only record ids, code, type and dates', async () => {
    const r = await runPreflight();
    const row = r.detail.find((d) => d.employee_id === legacy.id)!;
    expect(Object.keys(row).sort()).toEqual([
      'employee_code',
      'employee_id',
      'employee_type',
      'joining_date',
      'organization_id',
    ]);
  });

  it('is read-only: no write statement in the block, and a write inside it would be refused', async () => {
    const sql = preflightSql();
    expect(sql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|SET)\b/i,
    );
    expect(sql).toMatch(/BEGIN READ ONLY;/);
    expect(sql.trim().endsWith('ROLLBACK;')).toBe(true);
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await expect(
        c.query(`UPDATE app.employees SET employee_type = 'ADMIN' WHERE id = $1`, [legacy.id]),
      ).rejects.toMatchObject({ code: '25006' }); // read_only_sql_transaction
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    const [row] = await adminQuery<{ employee_type: string }>(
      'SELECT employee_type FROM app.employees WHERE id = $1',
      [legacy.id],
    );
    expect(row!.employee_type).toBe('STAFF');
  });

  it('run as a role subject to RLS the preflight is empty by construction, and statement (c) says so (no false assurance)', async () => {
    // the planted legacy row exists, yet the application role (no tenant context) sees nothing of it
    const r = await runPreflight(inject('dbRuntimeUrl'));
    expect(r.seesAll).toBe(false); // the result is void
    expect(r.visible).toBe(0);
    expect(r.summary).toEqual([]);
    expect(r.detail).toEqual([]);
    // while the same statements as the superuser find it
    const ok = await runPreflight();
    expect(ok.seesAll).toBe(true);
    expect(ok.detail.map((d) => d.employee_id)).toContain(legacy.id);
    // the runbook states the rule that makes an empty result count only when (c) is true
    expect(runbook).toMatch(/sees_all_tenant_rows` is `false`/);
  });

  it('proposed workflow: an approved date supplied through the audited service clears the row; nothing else changes', async () => {
    // before: the row cannot be edited in any other way
    await expect(
      db.withTenant(admin, async (tx) => {
        const cur = await EmployeeService.getById(tx, admin, legacy.id);
        return EmployeeService.update(
          tx,
          admin,
          legacy.id,
          { employeeType: 'ADMIN', reason: 'Edit without a date' },
          { expected: { type: 'version', version: cur.version } },
        );
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await db.withTenant(admin, async (tx) => {
      const cur = await EmployeeService.getById(tx, admin, legacy.id);
      return EmployeeService.update(
        tx,
        admin,
        legacy.id,
        { leavingDate: '2021-06-30', reason: 'CHG-TEST: separation order SO-1 approved by owner' },
        { expected: { type: 'version', version: cur.version } },
      );
    });

    const r = await runPreflight();
    expect(r.detail.filter((d) => d.organization_id === T.orgId)).toEqual([]);
    const [row] = await adminQuery<{ status: string; leaving_date: string }>(
      'SELECT status, leaving_date::text FROM app.employees WHERE id = $1',
      [legacy.id],
    );
    expect(row).toMatchObject({ status: 'SEPARATED', leaving_date: '2021-06-30' });
    const audits = await adminQuery<{ reason_text: string; changes: Record<string, unknown> }>(
      `SELECT reason_text, changes FROM app.audit_events
        WHERE organization_id = $1 AND action = 'employee.update' AND resource_id = $2`,
      [T.orgId, legacy.id],
    );
    expect(audits.length).toBe(1);
    expect(audits[0]!.reason_text).toContain('CHG-TEST');
    expect(audits[0]!.changes).toMatchObject({ leavingDate: { old: null, new: '2021-06-30' } });
  });
});
