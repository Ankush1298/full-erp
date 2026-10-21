import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { Database, type TenantTx } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { EmployeeService } from '../../src/modules/people/employee.service.js';
import { PostingService } from '../../src/modules/people/posting.service.js';
import { adminQuery } from '../support/db-harness.js';
import { ORG_A, STAFF_A } from '../support/fixtures.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Milestone 2 Batch 1 acceptance remediation: employee scope resolution (doc 06 §3: the scope of an Employee is its
// ACTIVE PRIMARY posting), posting interval semantics (doc 02 §4.4) and atomic separation. Service level, on a private
// tenant: nothing here touches tenant A, and every assertion looks only at rows this file created.

const RUN = randomBytes(3).toString('hex').toUpperCase();
let counter = 0;
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 4 });
const db = new Database(pool);

let T!: IsolatedTenant;
let admin!: TrustedContext;
let campusAdmin!: TrustedContext;
let hod!: TrustedContext;
let faculty!: TrustedContext;
let otherTenantAdmin!: TrustedContext;
let D1!: string; // T.departmentId, campus C1; the HOD's department
let D2!: string; // second department of C1
let D3!: string; // department of the second campus C2
let C2!: string;

const as = <R>(ctx: TrustedContext, work: (tx: TenantTx) => Promise<R>) => db.withTenant(ctx, work);

async function codeOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 500;
  }
}

async function newUser(): Promise<string> {
  const id = uuidv7();
  const email = `scope-${RUN.toLowerCase()}-${id.slice(-12)}@isolated.test`;
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

async function newEmployee(userId?: string): Promise<{ id: string; userId: string; code: string }> {
  const uid = userId ?? (await newUser());
  const code = `S${RUN}-${++counter}`;
  const id = await as<string>(admin, (tx) =>
    EmployeeService.create(tx, admin, {
      userId: uid,
      employeeCode: code,
      employeeType: 'FACULTY',
      joiningDate: '2024-01-01',
      reason: 'Onboarding for scope tests',
    }),
  );
  return { id, userId: uid, code };
}

const post = (
  employeeId: string,
  departmentId: string,
  validFrom: string,
  extra: { isPrimary?: boolean; validTo?: string } = {},
) =>
  as<string>(admin, (tx) =>
    PostingService.create(tx, admin, employeeId, {
      departmentId,
      validFrom,
      reason: 'Posting for scope tests',
      ...extra,
    }),
  );

const separate = (employeeId: string, leavingDate: string | null, status = 'SEPARATED') =>
  as(admin, async (tx) => {
    const cur = await EmployeeService.getById(tx, admin, employeeId);
    return EmployeeService.update(
      tx,
      admin,
      employeeId,
      { status, leavingDate, reason: 'Approved separation' } as never,
      { expected: { type: 'version', version: cur.version } },
    );
  });

const getEmp = (ctx: TrustedContext, employeeId: string) =>
  as(ctx, (tx) => EmployeeService.getById(tx, ctx, employeeId));
const listIds = async (ctx: TrustedContext): Promise<string[]> =>
  (await as<{ id: string }[]>(ctx, (tx) => EmployeeService.list(tx, ctx, {}))).map((e) => e.id);
const postingRows = (employeeId: string) =>
  adminQuery<{ id: string; valid_from: string; valid_to: string | null; version: number }>(
    `SELECT id, valid_from::text, valid_to::text, version FROM app.employee_postings
      WHERE employee_id = $1 ORDER BY valid_from, id`,
    [employeeId],
  );

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  const mk = (userId: string) =>
    issueTrustedContext({ tenantId: T.orgId, userId, actorKind: 'STAFF' });
  admin = mk(T.users.admin);
  campusAdmin = mk(T.users.campusAdmin);
  hod = mk(T.users.hod);
  faculty = mk(T.users.faculty);
  otherTenantAdmin = issueTrustedContext({
    tenantId: ORG_A,
    userId: STAFF_A,
    actorKind: 'STAFF',
  });
  D1 = T.departmentId;
  D2 = uuidv7();
  D3 = uuidv7();
  C2 = uuidv7();
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Second', 'D2')`,
    [D2, T.orgId, T.campusId],
  );
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Campus two', 'C2', 'Asia/Kolkata')`,
    [C2, T.orgId],
  );
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Third', 'D3')`,
    [D3, T.orgId, C2],
  );
});

afterAll(async () => {
  await T.cleanup();
  await pool.end().catch(() => undefined);
});

describe('employee scope resolution (doc 06 §3: active primary posting)', () => {
  let inD1: string;
  let inD2: string;
  let inD3: string;
  let noPosting: string;
  let secondaryOnly: string;
  let closedOnly: string;
  let futureOnly: string;
  let own: string; // the FACULTY account's own employee record, primary in D2

  beforeAll(async () => {
    inD1 = (await newEmployee()).id;
    await post(inD1, D1, '2024-01-01', { isPrimary: true });
    inD2 = (await newEmployee()).id;
    await post(inD2, D2, '2024-01-01', { isPrimary: true });
    inD3 = (await newEmployee()).id;
    await post(inD3, D3, '2024-01-01', { isPrimary: true });
    noPosting = (await newEmployee()).id;
    secondaryOnly = (await newEmployee()).id;
    await post(secondaryOnly, D1, '2024-01-01', { isPrimary: false });
    closedOnly = (await newEmployee()).id;
    await post(closedOnly, D1, '2024-01-01', { isPrimary: true, validTo: '2024-06-30' });
    futureOnly = (await newEmployee()).id;
    await post(futureOnly, D1, '2199-01-01', { isPrimary: true });
    own = (await newEmployee(T.users.faculty)).id;
    await post(own, D2, '2024-01-01', { isPrimary: true });
  });

  it('derives department and campus from the active primary posting only', async () => {
    expect(await codeOf(getEmp(hod, inD1))).toBe(200);
    expect(await codeOf(getEmp(hod, inD2))).toBe(404);
    expect(await codeOf(getEmp(hod, inD3))).toBe(404);
    expect(await codeOf(getEmp(campusAdmin, inD1))).toBe(200);
    expect(await codeOf(getEmp(campusAdmin, inD2))).toBe(200);
    expect(await codeOf(getEmp(campusAdmin, inD3))).toBe(404);
    for (const id of [inD1, inD2, inD3, noPosting]) {
      expect(await codeOf(getEmp(admin, id))).toBe(200);
    }
  });

  it('fails closed without an active primary posting (none, non-primary, closed, not yet effective)', async () => {
    for (const id of [noPosting, secondaryOnly, closedOnly, futureOnly]) {
      expect(await codeOf(getEmp(hod, id)), `hod ${id}`).toBe(404);
      expect(await codeOf(getEmp(campusAdmin, id)), `campus admin ${id}`).toBe(404);
      expect(await codeOf(getEmp(admin, id)), `org admin ${id}`).toBe(200);
      expect(await listIds(hod)).not.toContain(id);
      expect(await listIds(campusAdmin)).not.toContain(id);
      expect(await listIds(admin)).toContain(id);
    }
  });

  it('a caller-supplied department or campus cannot override the persisted scope', async () => {
    const assertAs = (ctx: TrustedContext, resource: Record<string, string>) =>
      as(ctx, (tx) =>
        AuthorizationEngine.assert(tx, ctx, 'employee.profile.read', {
          organization_id: T.orgId,
          ...resource,
        }),
      );
    // employee is in D2: a claimed D1 must not admit the D1 head of department
    expect(await codeOf(assertAs(hod, { employee_id: inD2, department_id: D1 }))).toBe(404);
    // employee is in C2: a claimed C1 must not admit the C1 campus admin
    expect(await codeOf(assertAs(campusAdmin, { employee_id: inD3, campus_id: T.campusId }))).toBe(
      404,
    );
    // both claimed, employee has no active primary posting at all
    expect(
      await codeOf(
        assertAs(hod, { employee_id: noPosting, department_id: D1, campus_id: T.campusId }),
      ),
    ).toBe(404);
    expect(
      await codeOf(
        assertAs(campusAdmin, {
          employee_id: closedOnly,
          department_id: D1,
          campus_id: T.campusId,
        }),
      ),
    ).toBe(404);
    // the persisted scope still admits the right holder, with or without a (matching or wrong) claim
    expect(await codeOf(assertAs(hod, { employee_id: inD1 }))).toBe(200);
    expect(await codeOf(assertAs(hod, { employee_id: inD1, department_id: D3 }))).toBe(200);
  });

  it('SELF is limited to the caller’s own employee record', async () => {
    expect(await codeOf(getEmp(faculty, own))).toBe(200);
    for (const id of [inD1, inD2, inD3, noPosting]) {
      expect(await codeOf(getEmp(faculty, id)), `faculty reads ${id}`).toBe(404);
    }
    expect(await listIds(faculty)).toEqual([own]);
    expect(await codeOf(as(faculty, (tx) => PostingService.listByEmployee(tx, faculty, own)))).toBe(
      200,
    );
    expect(
      await codeOf(as(faculty, (tx) => PostingService.listByEmployee(tx, faculty, inD2))),
    ).toBe(404);
    // a SELF read grant never carries write access, even on the own record
    expect(
      await codeOf(
        as(faculty, (tx) =>
          PostingService.create(tx, faculty, own, {
            departmentId: D2,
            validFrom: '2031-01-01',
            reason: 'Self service attempt',
          }),
        ),
      ),
    ).not.toBe(200);
  });

  it('pairing the authenticated user’s user_id with a different employee_id denies access', async () => {
    // Regression test: for employee resources, SELF authorization is strictly based on the authenticated actor's
    // employee ownership. Supplying the caller's own user_id alongside a different employee_id must NOT grant access.
    const assertAs = (ctx: TrustedContext, resource: Record<string, string>) =>
      as(ctx, (tx) =>
        AuthorizationEngine.assert(tx, ctx, 'employee.profile.read', {
          organization_id: T.orgId,
          ...resource,
        }),
      );

    // faculty owns `own`. inD1 is another employee's record.
    // Supplying faculty's user_id paired with inD1 must be denied (404).
    expect(
      await codeOf(
        assertAs(faculty, {
          employee_id: inD1,
          user_id: faculty.userId,
        }),
      ),
    ).toBe(404);

    // Conversely, faculty's own employee record succeeds whether user_id is supplied or not
    expect(
      await codeOf(
        assertAs(faculty, {
          employee_id: own,
          user_id: faculty.userId,
        }),
      ),
    ).toBe(200);
    expect(
      await codeOf(
        assertAs(faculty, {
          employee_id: own,
        }),
      ),
    ).toBe(200);

    // And if someone supplies a mismatched user_id with the own employee_id, own employee ownership still governs SELF
    expect(
      await codeOf(
        assertAs(faculty, {
          employee_id: own,
          user_id: T.users.admin,
        }),
      ),
    ).toBe(200);
  });

  it('list visibility equals point visibility for every scoped role', async () => {
    const all = [inD1, inD2, inD3, noPosting, secondaryOnly, closedOnly, futureOnly, own];
    for (const ctx of [hod, campusAdmin, faculty, admin]) {
      const visible = new Set(await listIds(ctx));
      for (const id of all) {
        expect(visible.has(id), `${ctx.userId} ${id}`).toBe(
          (await codeOf(getEmp(ctx, id))) === 200,
        );
      }
    }
  });

  it('HOD, campus admin and department-scoped holders cannot write outside their boundary', async () => {
    // HOD holds no employee.record.update at all
    expect(
      await codeOf(
        as(hod, (tx) =>
          PostingService.create(tx, hod, inD1, {
            departmentId: D1,
            validFrom: '2032-01-01',
            reason: 'HOD attempt',
          }),
        ),
      ),
    ).not.toBe(200);
    // campus admin: cannot post into another campus' department …
    expect(
      await codeOf(
        as(campusAdmin, (tx) =>
          PostingService.create(tx, campusAdmin, inD1, {
            departmentId: D3,
            validFrom: '2033-01-01',
            reason: 'Cross campus attempt',
          }),
        ),
      ),
    ).toBe(404);
    // … nor touch an employee that currently belongs to another campus …
    expect(
      await codeOf(
        as(campusAdmin, (tx) =>
          PostingService.create(tx, campusAdmin, inD3, {
            departmentId: D1,
            validFrom: '2033-01-01',
            reason: 'Poaching attempt',
          }),
        ),
      ),
    ).toBe(404);
    // … nor create the first posting of an employee that has no scope yet (fails closed; organisation admins onboard)
    expect(
      await codeOf(
        as(campusAdmin, (tx) =>
          PostingService.create(tx, campusAdmin, noPosting, {
            departmentId: D1,
            validFrom: '2033-01-01',
            reason: 'First posting attempt',
          }),
        ),
      ),
    ).toBe(404);
    // … and cannot update an out-of-campus employee record either
    expect(
      await codeOf(
        as(campusAdmin, async (tx) => {
          const cur = await EmployeeService.getById(tx, admin, inD3);
          return EmployeeService.update(
            tx,
            campusAdmin,
            inD3,
            { employeeType: 'STAFF', reason: 'Out of campus update' },
            { expected: { type: 'version', version: cur.version } },
          );
        }),
      ),
    ).toBe(404);
  });

  it('another tenant’s administrator reaches nothing (no IDOR, no cross-tenant path)', async () => {
    expect(await codeOf(getEmp(otherTenantAdmin, inD1))).toBe(404);
    expect(
      await codeOf(
        as(otherTenantAdmin, (tx) => PostingService.listByEmployee(tx, otherTenantAdmin, inD1)),
      ),
    ).toBe(404);
    const [p] = await postingRows(inD1);
    expect(
      await codeOf(
        as(otherTenantAdmin, (tx) => PostingService.getById(tx, otherTenantAdmin, p!.id)),
      ),
    ).toBe(404);
    expect(await listIds(otherTenantAdmin)).not.toContain(inD1);
    // the engine itself, with a foreign tenant claim on the resource
    expect(
      await codeOf(
        as(admin, (tx) =>
          AuthorizationEngine.assert(tx, admin, 'employee.profile.read', {
            organization_id: ORG_A,
            employee_id: inD1,
          }),
        ),
      ),
    ).toBe(404);
  });
});

describe('posting interval semantics (doc 02 §4.4: no overlap per employee and department)', () => {
  it('adjacent days in one department are allowed; a shared day is an overlap', async () => {
    const e = (await newEmployee()).id;
    await post(e, D1, '2024-01-01', { validTo: '2024-06-30' });
    await expect(post(e, D1, '2024-06-30')).rejects.toMatchObject({ statusCode: 409 });
    await expect(post(e, D1, '2024-03-01', { validTo: '2024-03-31' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await post(e, D1, '2024-07-01', { validTo: '2024-12-31' }); // the next day: allowed
    await expect(post(e, D1, '2023-01-01', { validTo: '2024-01-01' })).rejects.toMatchObject({
      statusCode: 409,
    }); // ends on the first day of an existing posting
    await post(e, D1, '2023-01-01', { validTo: '2023-12-31' }); // ends the day before: allowed
  });

  it('overlapping periods in different departments are allowed (the rule is per department)', async () => {
    const e = (await newEmployee()).id;
    await post(e, D1, '2024-01-01', { validTo: '2024-12-31' });
    await post(e, D2, '2024-06-01', { validTo: '2025-06-30' });
    await post(e, D3, '2024-01-01'); // open ended, overlapping both
    expect((await postingRows(e)).length).toBe(3);
  });

  it('the database enforces the same rule for writers that bypass the service', async () => {
    const e = (await newEmployee()).id;
    const insert = (dept: string, from: string, to: string | null) =>
      adminQuery(
        `INSERT INTO app.employee_postings (id, organization_id, employee_id, department_id, valid_from, valid_to)
         VALUES ($1, $2, $3, $4, $5::date, $6::date)`,
        [uuidv7(), T.orgId, e, dept, from, to],
      );
    await insert(D1, '2024-01-01', '2024-06-30');
    await expect(insert(D1, '2024-06-30', null)).rejects.toMatchObject({
      code: '23P01',
      constraint: 'employee_postings_no_overlap',
    });
    await insert(D1, '2024-07-01', null); // adjacent
    await insert(D2, '2024-01-01', null); // other department
  });
});

describe('separation (Decision B): approved date, atomic closure, nothing partial', () => {
  it('requires the approved leaving date and closes every open posting with exactly that date', async () => {
    const e = (await newEmployee()).id;
    const open1 = await post(e, D1, '2024-01-01', { isPrimary: true });
    const open2 = await post(e, D2, '2024-03-01');
    const closedEarlier = await post(e, D3, '2023-01-01', { validTo: '2023-12-31' });
    const [before] = (await postingRows(e)).filter((r) => r.id === closedEarlier);

    expect(await codeOf(separate(e, null))).toBe(400);
    expect((await postingRows(e)).every((r) => r.id === closedEarlier || r.valid_to === null)).toBe(
      true,
    );

    await separate(e, '2024-08-31');
    const rows = await postingRows(e);
    expect(rows.find((r) => r.id === open1)!.valid_to).toBe('2024-08-31');
    expect(rows.find((r) => r.id === open2)!.valid_to).toBe('2024-08-31');
    // historical closed postings are untouched (same end date, same version)
    expect(rows.find((r) => r.id === closedEarlier)).toEqual(before);

    const audits = await adminQuery<{ resource_id: string; changes: Record<string, unknown> }>(
      `SELECT resource_id, changes FROM app.audit_events
        WHERE organization_id = $1 AND action = 'employee.posting.close' AND resource_id = ANY($2::uuid[])`,
      [T.orgId, [open1, open2, closedEarlier]],
    );
    expect(audits.map((a) => a.resource_id).sort()).toEqual([open1, open2].sort());
    for (const a of audits) expect(a.changes).toMatchObject({ closedBySeparation: true });
  });

  it('refuses a leaving date before an open posting starts and changes nothing', async () => {
    const e = (await newEmployee()).id;
    const p = await post(e, D1, '2024-03-01', { isPrimary: true });
    expect(await codeOf(separate(e, '2024-02-15'))).toBe(400);
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBeNull();
    expect(
      (await as<{ status: string }>(admin, (tx) => EmployeeService.getById(tx, admin, e))).status,
    ).toBe('ACTIVE');
    // the same-day boundary is allowed: a posting may start on the leaving date
    await separate(e, '2024-03-01');
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBe('2024-03-01');
  });

  it('the database backstop applies the same rules to writers that bypass the service', async () => {
    const e = (await newEmployee()).id;
    const p = await post(e, D1, '2024-03-01', { isPrimary: true });
    await expect(
      adminQuery(`UPDATE app.employees SET status = 'SEPARATED' WHERE id = $1`, [e]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employees_separated_leaving_date_ck' });
    await expect(
      adminQuery(
        `UPDATE app.employees SET status = 'SEPARATED', leaving_date = '2024-02-01' WHERE id = $1`,
        [e],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employee_postings_separation_date_ck' });
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBeNull();
    await adminQuery(
      `UPDATE app.employees SET status = 'SEPARATED', leaving_date = '2024-09-15' WHERE id = $1`,
      [e],
    );
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBe('2024-09-15');
    // nothing can be opened afterwards
    await expect(
      adminQuery(
        `INSERT INTO app.employee_postings (id, organization_id, employee_id, department_id, valid_from)
         VALUES ($1, $2, $3, $4, '2024-10-01')`,
        [uuidv7(), T.orgId, e, D1],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await codeOf(post(e, D1, '2024-10-01'))).toBe(409);
  });

  it('rolls back the posting closures, the status change and their audit events together', async () => {
    const e = await newEmployee();
    const p1 = await post(e.id, D1, '2024-01-01', { isPrimary: true });
    const p2 = await post(e.id, D2, '2024-02-01');
    const [empBefore] = await adminQuery<{ version: number }>(
      'SELECT version FROM app.employees WHERE id = $1',
      [e.id],
    );
    const auditCount = async () =>
      Number(
        (
          await adminQuery<{ n: string }>(
            `SELECT count(*) AS n FROM app.audit_events
              WHERE organization_id = $1 AND (resource_id = ANY($2::uuid[]) OR (resource_type = 'employee' AND resource_id = $3))
                AND action IN ('employee.posting.close', 'employee.update')`,
            [T.orgId, [p1, p2], e.id],
          )
        )[0]!.n,
      );
    const auditsBefore = await auditCount();

    // (a) a failure raised by the final employee UPDATE, i.e. after both postings were closed and audited in the transaction
    const fn = `app.zz_inject_fail_${RUN.toLowerCase()}`;
    await adminQuery(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
    );
    await adminQuery(
      `CREATE TRIGGER zz_inject_${RUN.toLowerCase()} BEFORE UPDATE ON app.employees
         FOR EACH ROW WHEN (NEW.employee_code = '${e.code}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(separate(e.id, '2024-08-31')).rejects.toThrow(/injected failure/);
    } finally {
      await adminQuery(`DROP TRIGGER zz_inject_${RUN.toLowerCase()} ON app.employees`);
      await adminQuery(`DROP FUNCTION ${fn}()`);
    }

    // (b) a failure after the whole service call returned: the caller's transaction owns everything
    await expect(
      as(admin, async (tx) => {
        const cur = await EmployeeService.getById(tx, admin, e.id);
        await EmployeeService.update(
          tx,
          admin,
          e.id,
          { status: 'SEPARATED', leavingDate: '2024-08-31', reason: 'Approved separation' },
          { expected: { type: 'version', version: cur.version } },
        );
        throw new Error('late failure');
      }),
    ).rejects.toThrow(/late failure/);

    const rows = await postingRows(e.id);
    expect(rows.map((r) => r.valid_to)).toEqual([null, null]);
    expect(rows.every((r) => r.version === 1)).toBe(true);
    const [empAfter] = await adminQuery<{
      status: string;
      leaving_date: string | null;
      version: number;
    }>('SELECT status, leaving_date::text, version FROM app.employees WHERE id = $1', [e.id]);
    expect(empAfter).toMatchObject({
      status: 'ACTIVE',
      leaving_date: null,
      version: empBefore!.version,
    });
    expect(await auditCount()).toBe(auditsBefore);
  });

  it('can close postings of a deactivated department (closing is never blocked)', async () => {
    const e = (await newEmployee()).id;
    const dept = uuidv7();
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Closing', $4)`,
      [dept, T.orgId, T.campusId, `X${RUN}`.slice(0, 20)],
    );
    const p = await post(e, dept, '2024-01-01', { isPrimary: true });
    await adminQuery(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [dept]);

    // an explicit close …
    const other = (await newEmployee()).id;
    const q = await post(other, D1, '2024-01-01', { isPrimary: true });
    await as(admin, async (tx) => {
      const cur = await PostingService.getById(tx, admin, q);
      return PostingService.close(
        tx,
        admin,
        q,
        { validTo: '2024-05-31', reason: 'Closing a posting' },
        { expected: { type: 'version', version: cur.version } },
      );
    });
    // … and separation both work although the department is inactive
    await separate(e, '2024-08-31');
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBe('2024-08-31');
  });

  it('preserves the existing status rules: leave is a round trip, reinstatement never reopens postings', async () => {
    const e = (await newEmployee()).id;
    const p = await post(e, D1, '2024-01-01', { isPrimary: true });
    await as(admin, async (tx) => {
      const cur = await EmployeeService.getById(tx, admin, e);
      await EmployeeService.update(
        tx,
        admin,
        e,
        { status: 'ON_LEAVE', reason: 'Approved leave' },
        { expected: { type: 'version', version: cur.version } },
      );
    });
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBeNull(); // leave closes nothing
    await separate(e, '2024-08-31');
    await separate(e, null, 'ACTIVE'); // not terminal (FU-EMP-2: no transition is forbidden)
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBe('2024-08-31'); // stays closed
    expect(await codeOf(getEmp(hod, e))).toBe(404); // and gives no scope
  });
});

describe('separation invariant: every write path (final acceptance review)', () => {
  it('no path can create a SEPARATED employee without an approved leaving date', async () => {
    const insert = (userId: string, leaving: string | null, run: 'runtime' | 'admin') => {
      const sql = `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date, status, leaving_date)
                   VALUES ($1, $2, $3, $4, 'STAFF', '2024-01-01', 'SEPARATED', $5::date)`;
      const params = [uuidv7(), T.orgId, userId, `S${RUN}-I${++counter}`, leaving];
      return run === 'admin' ? adminQuery(sql, params) : as(admin, (tx) => tx.query(sql, params));
    };
    // the application role (table-wide INSERT) and a privileged writer are both refused …
    for (const run of ['runtime', 'admin'] as const) {
      await expect(insert(await newUser(), null, run)).rejects.toMatchObject({
        code: '23514',
        constraint: 'employees_separated_leaving_date_ck',
      });
    }
    // … while a dated SEPARATED row is allowed, and the service never sets a status on create at all
    await insert(await newUser(), '2024-05-01', 'admin');
    const id = (await newEmployee()).id;
    expect(
      (await as<{ status: string }>(admin, (tx) => EmployeeService.getById(tx, admin, id))).status,
    ).toBe('ACTIVE');
  });

  it('the leaving date of a separated employee cannot move before closed posting history', async () => {
    const e = (await newEmployee()).id;
    const open = await post(e, D1, '2024-01-01', { isPrimary: true });
    const earlier = await post(e, D2, '2023-01-01', { validTo: '2023-12-31' });
    await separate(e, '2024-08-31');
    const before = await postingRows(e);

    // earlier than the close date of a posting: refused by the service and by the trigger, history untouched
    expect(await codeOf(separate(e, '2024-06-30'))).toBe(400);
    await expect(
      adminQuery(`UPDATE app.employees SET leaving_date = '2024-06-30' WHERE id = $1`, [e]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'employees_separated_leaving_date_history_ck',
    });
    // earlier than a posting's start is refused too
    await expect(
      adminQuery(`UPDATE app.employees SET leaving_date = '2023-06-30' WHERE id = $1`, [e]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await postingRows(e)).toEqual(before);
    expect((await postingRows(e)).find((r) => r.id === earlier)!.valid_to).toBe('2023-12-31');

    // the same date is a no-op and a later date is allowed; neither rewrites a posting
    expect(await codeOf(separate(e, '2024-08-31'))).toBe(200);
    expect(await codeOf(separate(e, '2024-12-31'))).toBe(200);
    expect(await postingRows(e)).toEqual(before);
    expect((await postingRows(e)).find((r) => r.id === open)!.valid_to).toBe('2024-08-31');
  });

  it('documented behaviour: a planned leaving date on an ACTIVE employee blocks nothing until separation', async () => {
    const e = (await newEmployee()).id;
    await as(admin, async (tx) => {
      const cur = await EmployeeService.getById(tx, admin, e);
      await EmployeeService.update(
        tx,
        admin,
        e,
        { leavingDate: '2024-06-30', reason: 'Notice period recorded' },
        { expected: { type: 'version', version: cur.version } },
      );
    });
    const p = await post(e, D1, '2024-09-01', { isPrimary: true }); // starts after the planned date: allowed (owner decision pending)
    expect(await codeOf(separate(e, '2024-06-30'))).toBe(400); // but separation on that date is refused
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).toBeNull();
  });
});

describe('active primary posting: campus-local effective date and fail-closed edges', () => {
  // Kiritimati (UTC+14) and Pago Pago (UTC-11) are never both on the UTC date, so at least one of them
  // makes "campus-local today" differ from "UTC today" at any moment this test runs.
  const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'] as const;

  async function localDay(zone: string, plusDays: number): Promise<string> {
    const r = await adminQuery<{ d: string }>(
      `SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d`,
      [zone, plusDays],
    );
    return r[0]!.d;
  }

  async function campusAdminFor(campus: string): Promise<TrustedContext> {
    const user = await newUser();
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, 'CAMPUS', $4::uuid, $4::uuid, NULL
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = 'CAMPUS_ADMIN'`,
      [uuidv7(), T.orgId, user, campus],
    );
    return issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STAFF' });
  }

  it.each(ZONES)(
    '%s: a posting is active from its campus-local start date, not the UTC date',
    async (zone) => {
      const campus = uuidv7();
      const dept = uuidv7();
      await adminQuery(
        `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, $3, $4, $5)`,
        [campus, T.orgId, `TZ ${zone}`, `Z${++counter}${RUN}`.slice(0, 20), zone],
      );
      await adminQuery(
        `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'TZ dept', 'TZ')`,
        [dept, T.orgId, campus],
      );
      const viewer = await campusAdminFor(campus);
      const today = (await newEmployee()).id;
      const tomorrow = (await newEmployee()).id;
      await post(today, dept, await localDay(zone, 0), { isPrimary: true });
      await post(tomorrow, dept, await localDay(zone, 1), { isPrimary: true });

      expect(await codeOf(getEmp(viewer, today))).toBe(200);
      expect(await codeOf(getEmp(viewer, tomorrow))).toBe(404);
      const visible = await listIds(viewer);
      expect(visible).toContain(today);
      expect(visible).not.toContain(tomorrow);
    },
  );

  it('a department whose campus row is missing or has no usable timezone resolves to no scope (fails closed)', async () => {
    // campuses.timezone is NOT NULL and departments reference campuses with a composite foreign key, so neither state
    // can be written; the inner join on campuses is what makes the predicate fail closed if it ever were.
    await expect(
      adminQuery(`UPDATE app.campuses SET timezone = NULL WHERE id = $1`, [T.campusId]),
    ).rejects.toMatchObject({ code: '23502' });
    await expect(
      adminQuery(
        `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Orphan', 'OR')`,
        [uuidv7(), T.orgId, uuidv7()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('lock order: employee, then postings (no deadlock between a posting update and a separation)', () => {
  it('a posting close racing a separation of the same employee never deadlocks', async () => {
    const e = (await newEmployee()).id;
    const p = await post(e, D1, '2024-01-01', { isPrimary: true });
    const app = `it-posting-lock-${RUN}`;
    const waiterPool = createPool({
      connectionString: inject('dbRuntimeUrl'),
      ssl: false,
      max: 2,
      applicationName: app,
    });
    const waiterDb = new Database(waiterPool);
    const blocked = async (): Promise<number> =>
      Number(
        (
          await adminQuery<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
              WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'`,
            [app],
          )
        )[0]!.n,
      );
    const waitBlocked = async (n: number): Promise<void> => {
      for (let i = 0; i < 400; i++) {
        if ((await blocked()) >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`fewer than ${n} backends blocked on a lock`);
    };

    // a third session holds the employee row so both contenders queue behind it: separation first, close second
    const holder = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM app.employees WHERE id = $1 FOR UPDATE', [e]);

      const separation = waiterDb.withTenant(admin, async (tx) => {
        const cur = await EmployeeService.getById(tx, admin, e);
        return EmployeeService.update(
          tx,
          admin,
          e,
          { status: 'SEPARATED', leavingDate: '2024-08-31', reason: 'Approved separation' },
          { expected: { type: 'version', version: cur.version } },
        );
      });
      const sep = separation.then(
        () => 200,
        (err: { code?: string; statusCode?: number }) => err.code ?? err.statusCode ?? 500,
      );
      await waitBlocked(1);
      const close = waiterDb.withTenant(admin, (tx) =>
        PostingService.close(
          tx,
          admin,
          p,
          { validTo: '2024-07-31', reason: 'Closing a posting' },
          { expected: { type: 'version', version: 1 } },
        ),
      );
      const closing = close.then(
        () => 200,
        (err: { code?: string; statusCode?: number }) => err.code ?? err.statusCode ?? 500,
      );
      await waitBlocked(2);
      await holder.query('COMMIT'); // release: the separation holds the queue head, the close follows

      const [s, c] = await Promise.all([sep, closing]);
      expect(s).toBe(200);
      expect(c).not.toBe('40P01'); // old order: posting first, employee second => deadlock victim
      expect([200, 'CONFLICT']).toContain(c); // the close either won or found the posting already closed
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
      await waiterPool.end().catch(() => undefined);
    }
    expect((await postingRows(e)).find((r) => r.id === p)!.valid_to).not.toBeNull();
  });
});

describe('least privilege: the runtime role cannot rewrite closed postings or reach them as a student', () => {
  const runtime = (sql: string, params: unknown[] = [], ctx: TrustedContext = admin) =>
    as(ctx, (tx) => tx.query(sql, params));

  it('closed postings are immutable, identity columns are not grantable, nothing can be deleted', async () => {
    const e = (await newEmployee()).id;
    const closed = await post(e, D1, '2024-01-01', { isPrimary: true, validTo: '2024-03-31' });
    const open = await post(e, D2, '2024-01-01');
    const before = await postingRows(e);

    for (const set of [
      'is_primary = true',
      'valid_to = NULL',
      `valid_to = '2024-04-30'`,
      'designation_id = NULL',
    ]) {
      await expect(
        runtime(`UPDATE app.employee_postings SET ${set} WHERE id = $1`, [closed]),
      ).rejects.toMatchObject({ code: '23001' }); // restrict_violation from employee_postings_guard
    }
    // an open posting cannot be re-pointed or re-dated (no column privilege), and nothing can be deleted
    for (const set of [
      `department_id = '${D3}'`,
      `valid_from = '2023-01-01'`,
      `employee_id = '${uuidv7()}'`,
    ]) {
      await expect(
        runtime(`UPDATE app.employee_postings SET ${set} WHERE id = $1`, [open]),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      runtime('DELETE FROM app.employee_postings WHERE id = $1', [closed]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    expect(await postingRows(e)).toEqual(before);
  });

  it('a student session sees no postings and can write none (restrictive staff-only policies)', async () => {
    const e = (await newEmployee()).id;
    await post(e, D1, '2024-01-01', { isPrimary: true });
    const student = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });
    const seen = await runtime(
      'SELECT id FROM app.employee_postings WHERE employee_id = $1',
      [e],
      student,
    );
    expect(seen.rows).toEqual([]);
    await expect(
      runtime(
        `INSERT INTO app.employee_postings (id, organization_id, employee_id, department_id, valid_from)
         VALUES ($1, $2, $3, $4, '2030-01-01')`,
        [uuidv7(), T.orgId, e, D1],
        student,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtime(`UPDATE app.rooms SET name = 'x' WHERE organization_id = $1`, [T.orgId], student),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});

async function holderOf(
  role: string,
  scopeType: 'CAMPUS' | 'DEPARTMENT',
  scopeId: string,
): Promise<TrustedContext> {
  const user = await newUser();
  await adminQuery(
    `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
     SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
            CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
       FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
    [uuidv7(), T.orgId, user, role, scopeType, scopeId],
  );
  return issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STAFF' });
}

describe('owner Decision 4: only an open, started primary posting grants current scope', () => {
  it('a bounded primary posting that covers today grants nothing, for point reads and lists alike', async () => {
    const e = (await newEmployee()).id;
    // started long ago, ends in the far future: today is inside the interval, but valid_to is set
    await post(e, D1, '2024-01-01', { isPrimary: true, validTo: '2199-12-31' });
    const campusViewer = await holderOf('CAMPUS_ADMIN', 'CAMPUS', T.campusId);
    for (const ctx of [hod, campusViewer]) {
      expect(await codeOf(getEmp(ctx, e))).toBe(404);
      expect(await listIds(ctx)).not.toContain(e);
    }
    expect(await codeOf(getEmp(admin, e))).toBe(200);
    expect(await listIds(admin)).toContain(e);
  });

  it('zero open primary postings are allowed, a second open primary is refused by the database', async () => {
    const e = (await newEmployee()).id;
    expect((await postingRows(e)).length).toBe(0); // zero is a valid state
    await post(e, D1, '2024-01-01', { isPrimary: true });
    await expect(
      adminQuery(
        `INSERT INTO app.employee_postings (id, organization_id, employee_id, department_id, valid_from, is_primary)
         VALUES ($1, $2, $3, $4, '2024-02-01', true)`,
        [uuidv7(), T.orgId, e, D2],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'employee_postings_one_primary_uq' });
  });

  it('point checks and list filtering agree for every kind of posting, for every scoped role', async () => {
    const campusViewer = await holderOf('CAMPUS_ADMIN', 'CAMPUS', T.campusId);
    const deptAdmin = await holderOf('DEPARTMENT_ADMIN', 'DEPARTMENT', D1);
    const cases: string[] = [];
    const mk = async (f: (id: string) => Promise<unknown>): Promise<void> => {
      const id = (await newEmployee()).id;
      await f(id);
      cases.push(id);
    };
    await mk((id) => post(id, D1, '2024-01-01', { isPrimary: true })); // open, started
    await mk((id) => post(id, D1, '2199-01-01', { isPrimary: true })); // open, future
    await mk((id) => post(id, D1, '2024-01-01', { isPrimary: true, validTo: '2199-12-31' })); // bounded
    await mk((id) => post(id, D1, '2024-01-01', { isPrimary: true, validTo: '2024-02-01' })); // ended
    await mk((id) => post(id, D1, '2024-01-01')); // secondary only
    await mk((id) => post(id, D2, '2024-01-01', { isPrimary: true })); // other department, same campus
    await mk(() => Promise.resolve()); // no posting
    for (const ctx of [hod, deptAdmin, campusViewer, faculty, admin]) {
      const visible = new Set(await listIds(ctx));
      for (const id of cases) {
        expect(visible.has(id), `${ctx.userId} ${id}`).toBe(
          (await codeOf(getEmp(ctx, id))) === 200,
        );
      }
    }
  });
});

describe('owner Decision 6: secondary postings and unscoped onboarding never escalate', () => {
  it('a department that only holds a secondary posting gains no access to the employee or the posting', async () => {
    const e = (await newEmployee()).id;
    await post(e, D2, '2024-01-01', { isPrimary: true }); // primary: D2
    const secondary = await post(e, D1, '2024-01-01'); // secondary: D1
    const deptAdminD1 = await holderOf('DEPARTMENT_ADMIN', 'DEPARTMENT', D1);
    for (const ctx of [hod, deptAdminD1]) {
      expect(await codeOf(getEmp(ctx, e))).toBe(404);
      expect(await listIds(ctx)).not.toContain(e);
      expect(await codeOf(as(ctx, (tx) => PostingService.listByEmployee(tx, ctx, e)))).toBe(404);
      expect(await codeOf(as(ctx, (tx) => PostingService.getById(tx, ctx, secondary)))).toBe(404);
    }
    // and cannot manage it either, although the posting sits in their department
    expect(
      await codeOf(
        as(deptAdminD1, (tx) =>
          PostingService.close(
            tx,
            deptAdminD1,
            secondary,
            { validTo: '2024-06-30', reason: 'Closing as department admin' },
            { expected: { type: 'version', version: 1 } },
          ),
        ),
      ),
    ).toBe(404);
    expect((await postingRows(e)).find((r) => r.id === secondary)!.valid_to).toBeNull();
    // the department that holds the PRIMARY posting does see the employee
    const deptAdminD2 = await holderOf('DEPARTMENT_ADMIN', 'DEPARTMENT', D2);
    expect(await codeOf(getEmp(deptAdminD2, e))).toBe(200);
  });

  it('department admins cannot onboard: no first posting, no pulling an employee into their department', async () => {
    const deptAdminD1 = await holderOf('DEPARTMENT_ADMIN', 'DEPARTMENT', D1);
    const unposted = (await newEmployee()).id;
    const elsewhere = (await newEmployee()).id;
    await post(elsewhere, D2, '2024-01-01', { isPrimary: true });
    for (const target of [unposted, elsewhere]) {
      expect(
        await codeOf(
          as(deptAdminD1, (tx) =>
            PostingService.create(tx, deptAdminD1, target, {
              departmentId: D1,
              validFrom: '2024-03-01',
              isPrimary: true,
              reason: 'Department admin onboarding attempt',
            }),
          ),
        ),
      ).toBe(404);
    }
    expect((await postingRows(unposted)).length).toBe(0);
    expect((await postingRows(elsewhere)).length).toBe(1);
    // an organisation admin onboards, and then the department admin sees and may manage within the department
    await post(unposted, D1, '2024-03-01', { isPrimary: true });
    expect(await codeOf(getEmp(deptAdminD1, unposted))).toBe(200);
    // explicit target checks stay: not into another department, even for an employee in scope
    expect(
      await codeOf(
        as(deptAdminD1, (tx) =>
          PostingService.create(tx, deptAdminD1, unposted, {
            departmentId: D2,
            validFrom: '2024-04-01',
            reason: 'Cross department attempt',
          }),
        ),
      ),
    ).toBe(404);
  });
});

describe('audit failures roll back the whole separation (final acceptance)', () => {
  it('a failing posting-close audit insert leaves status, postings and every audit row untouched', async () => {
    const e = await newEmployee();
    const p1 = await post(e.id, D1, '2024-01-01', { isPrimary: true });
    const p2 = await post(e.id, D2, '2024-02-01');
    const fn = `app.zz_audit_fail_${RUN.toLowerCase()}`;
    const trg = `zz_audit_fail_${RUN.toLowerCase()}`;
    await adminQuery(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure'; END $$`,
    );
    // fails the SECOND posting-close audit event, i.e. after the first closure and its audit were already written
    await adminQuery(
      `CREATE TRIGGER ${trg} BEFORE INSERT ON app.audit_events FOR EACH ROW
         WHEN (NEW.resource_id = '${p2}'::uuid AND NEW.action = 'employee.posting.close') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(separate(e.id, '2024-08-31')).rejects.toThrow(
        /audit record could not be written/,
      );
    } finally {
      await adminQuery(`DROP TRIGGER ${trg} ON app.audit_events`);
      await adminQuery(`DROP FUNCTION ${fn}()`);
    }
    expect((await postingRows(e.id)).map((r) => r.valid_to)).toEqual([null, null]);
    const [emp] = await adminQuery<{ status: string; leaving_date: string | null }>(
      'SELECT status, leaving_date::text FROM app.employees WHERE id = $1',
      [e.id],
    );
    expect(emp).toMatchObject({ status: 'ACTIVE', leaving_date: null });
    const audits = await adminQuery<{ n: string }>(
      `SELECT count(*) AS n FROM app.audit_events
        WHERE organization_id = $1 AND action IN ('employee.posting.close', 'employee.update')
          AND (resource_id = ANY($2::uuid[]) OR resource_id = $3)`,
      [T.orgId, [p1, p2], e.id],
    );
    expect(Number(audits[0]!.n)).toBe(0);
    // and the same call succeeds once the failure is gone, with one audit event per posting
    await separate(e.id, '2024-08-31');
    expect((await postingRows(e.id)).map((r) => r.valid_to)).toEqual(['2024-08-31', '2024-08-31']);
  });
});
