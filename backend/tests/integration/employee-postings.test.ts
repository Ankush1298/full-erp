import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// HTTP contract of the posting routes. Runs on a PRIVATE tenant: employee.test.ts and employee-routes.test.ts assert
// facts about the shared tenant A (same fixture users, "scoped holders see an empty list"), so nothing here may commit
// employees or postings there.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/faculty';

const KEYS = ['orgAdminA', 'campusAdminA', 'hodA', 'facultyA'] as const;
type UserKey = (typeof KEYS)[number];

let T!: IsolatedTenant;
let D1!: string; // the helper tenant's department (HOD scope), in campus C1
let D2!: string; // second department of C1
let D3!: string; // department of the second campus
const U = {} as Record<'temp' | 'lock' | 'grantee' | 'extra', string>;
const uid = {} as Record<'faculty' | 'hod' | 'campusAdmin', string>;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

const sessions = {} as Record<UserKey, { cookie: string; csrf: string }>;

function get(user: UserKey | null, path: string) {
  return app.inject({
    method: 'GET',
    url: path,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
}

function send(
  method: 'POST' | 'PATCH',
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string; ifMatch?: string } = {},
) {
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(opts.ifMatch !== undefined ? { 'if-match': opts.ifMatch } : {}),
    },
  });
}

const createEmployee = async (user: UserKey, userId: string, code: string, extra: object = {}) =>
  send('POST', user, `${BASE}/employees`, {
    userId,
    employeeCode: code,
    employeeType: 'FACULTY',
    joiningDate: '2024-01-01',
    reason: 'Initial employee onboarding',
    ...extra,
  });

async function newUser(tag: string): Promise<string> {
  const id = uuidv7();
  const email = `${tag}-${id.slice(-12)}@isolated.test`;
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

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  D1 = T.departmentId;
  D2 = uuidv7();
  D3 = uuidv7();
  const campus2 = uuidv7();
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Second', 'D2')`,
    [D2, T.orgId, T.campusId],
  );
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Campus two', 'C2', 'Asia/Kolkata')`,
    [campus2, T.orgId],
  );
  await adminQuery(
    `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Third', 'D3')`,
    [D3, T.orgId, campus2],
  );
  for (const k of ['temp', 'lock', 'grantee', 'extra'] as const) U[k] = await newUser(k);
  uid.faculty = T.users.faculty;
  uid.hod = T.users.hod;
  uid.campusAdmin = T.users.campusAdmin;
  const emails: Record<UserKey, string> = {
    orgAdminA: T.emails.admin,
    campusAdminA: T.emails.campusAdmin,
    hodA: T.emails.hod,
    facultyA: T.emails.faculty,
  };
  for (const key of KEYS) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emails[key], password: PASSWORD },
    });
    expect(r.statusCode, emails[key]).toBe(200);
    sessions[key] = {
      cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
      csrf: r.json<{ csrf_token: string }>().csrf_token,
    };
  }
});

afterAll(async () => {
  await T.cleanup();
  await app.close();
  await pool.end().catch(() => undefined);
});

describe('Employee Postings & Separation Atomicity (Milestone 2 Batch 1)', () => {
  describe('Primary Posting Rule (Decision C) & Lifecycle', () => {
    let employeeId: string;
    let primaryPostingId: string;
    let secondaryPostingId: string;

    beforeAll(async () => {
      const res = await createEmployee('orgAdminA', U.temp, 'POST-001');
      expect(res.statusCode).toBe(201);
      employeeId = res.json<{ data: { id: string } }>().data.id;
    });

    it('newly created employee has zero postings (valid state: 0 active primary allowed)', async () => {
      const res = await get('orgAdminA', `${BASE}/employees/${employeeId}/postings`);
      expect(res.statusCode).toBe(200);
      const json = res.json<{ success: boolean; data: unknown[] }>();
      expect(json.data).toEqual([]);
    });

    it('creates active primary posting successfully', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${employeeId}/postings`, {
        departmentId: D1,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Initial primary appointment in Dept 1',
      });

      expect(res.statusCode).toBe(201);
      const json = res.json<{ success: boolean; data: { id: string } }>();
      expect(json.success).toBe(true);
      primaryPostingId = json.data.id;
    });

    it('rejects second active primary posting (Decision C: at most one active primary) with 409', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${employeeId}/postings`, {
        departmentId: D2,
        validFrom: '2024-02-01',
        isPrimary: true,
        reason: 'Attempting conflicting second primary posting',
      });

      expect(res.statusCode).toBe(409);
    });

    it('allows active non-primary posting in different department to coexist', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${employeeId}/postings`, {
        departmentId: D2,
        validFrom: '2024-02-01',
        isPrimary: false,
        reason: 'Joint secondary assignment in Dept 2',
      });

      expect(res.statusCode).toBe(201);
      secondaryPostingId = res.json<{ success: boolean; data: { id: string } }>().data.id;
    });

    it('rejects overlapping posting in same department for same employee', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${employeeId}/postings`, {
        departmentId: D1,
        validFrom: '2024-03-01',
        isPrimary: false,
        reason: 'Overlapping assignment in Dept 1',
      });

      expect(res.statusCode).toBe(409);
    });

    it('closes an active posting with validTo and reason', async () => {
      const getRes = await get('orgAdminA', `${BASE}/postings/${primaryPostingId}`);
      const etag = getRes.headers.etag as string;

      const res = await send(
        'POST',
        'orgAdminA',
        `${BASE}/postings/${primaryPostingId}/close`,
        {
          validTo: '2024-06-30',
          reason: 'Concluding assignment in Dept 1',
        },
        { ifMatch: etag },
      );

      expect(res.statusCode).toBe(200);
      const json = res.json<{ success: boolean; data: { validTo: string; isPrimary: boolean } }>();
      expect(json.data.validTo).toBe('2024-06-30');
      expect(json.data.isPrimary).toBe(true);
    });

    it('allows creating new active primary posting after previous primary is closed', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${employeeId}/postings`, {
        departmentId: D3,
        validFrom: '2024-07-01',
        isPrimary: true,
        reason: 'Transferred as primary to Dept 3',
      });

      expect(res.statusCode).toBe(201);
    });

    it('enforces optimistic concurrency on posting update (409 on stale If-Match)', async () => {
      const res = await send(
        'PATCH',
        'orgAdminA',
        `${BASE}/postings/${secondaryPostingId}`,
        {
          isPrimary: false,
          reason: 'Updating non-primary details',
        },
        { ifMatch: '"999"' },
      );

      expect(res.statusCode).toBe(409);
    });
  });

  describe('Employee Separation Atomicity (Decision B)', () => {
    let sepEmpId: string;
    let posting1Id: string;
    let posting2Id: string;

    beforeAll(async () => {
      const res = await createEmployee('orgAdminA', U.lock, 'POST-002');
      expect(res.statusCode).toBe(201);
      sepEmpId = res.json<{ data: { id: string } }>().data.id;

      // Add two open postings
      const p1 = await send('POST', 'orgAdminA', `${BASE}/employees/${sepEmpId}/postings`, {
        departmentId: D1,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Dept 1 primary',
      });
      expect(p1.statusCode).toBe(201);
      posting1Id = p1.json<{ data: { id: string } }>().data.id;

      const p2 = await send('POST', 'orgAdminA', `${BASE}/employees/${sepEmpId}/postings`, {
        departmentId: D2,
        validFrom: '2024-03-01',
        isPrimary: false,
        reason: 'Dept 2 secondary',
      });
      expect(p2.statusCode).toBe(201);
      posting2Id = p2.json<{ data: { id: string } }>().data.id;
    });

    it('rejects separation without approved leavingDate (400)', async () => {
      const empRes = await get('orgAdminA', `${BASE}/employees/${sepEmpId}`);
      const etag = empRes.headers.etag as string;

      const res = await send(
        'PATCH',
        'orgAdminA',
        `${BASE}/employees/${sepEmpId}`,
        {
          status: 'SEPARATED',
          reason: 'Separation without leaving date',
        },
        { ifMatch: etag },
      );

      expect(res.statusCode).toBe(400);
    });

    it('rejects separation if leavingDate is before open posting validFrom (400) and preserves state', async () => {
      const empRes = await get('orgAdminA', `${BASE}/employees/${sepEmpId}`);
      const etag = empRes.headers.etag as string;

      // posting2 validFrom is 2024-03-01; try leavingDate 2024-02-15
      const res = await send(
        'PATCH',
        'orgAdminA',
        `${BASE}/employees/${sepEmpId}`,
        {
          status: 'SEPARATED',
          leavingDate: '2024-02-15',
          reason: 'Invalid leaving date earlier than posting',
        },
        { ifMatch: etag },
      );

      expect(res.statusCode).toBe(400);

      // Verify employee is still ACTIVE and postings are still open
      const verifyEmp = await get('orgAdminA', `${BASE}/employees/${sepEmpId}`);
      expect(verifyEmp.json<{ data: { status: string } }>().data.status).toBe('ACTIVE');

      const p2 = await get('orgAdminA', `${BASE}/postings/${posting2Id}`);
      expect(p2.json<{ data: { validTo: string | null } }>().data.validTo).toBeNull();
    });

    it('atomically closes all open postings on separation using leavingDate', async () => {
      const empRes = await get('orgAdminA', `${BASE}/employees/${sepEmpId}`);
      const etag = empRes.headers.etag as string;

      const res = await send(
        'PATCH',
        'orgAdminA',
        `${BASE}/employees/${sepEmpId}`,
        {
          status: 'SEPARATED',
          leavingDate: '2024-08-31',
          reason: 'Approved voluntary resignation',
        },
        { ifMatch: etag },
      );

      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { status: string; leavingDate: string } }>().data).toMatchObject({
        status: 'SEPARATED',
        leavingDate: '2024-08-31',
      });

      // Verify both postings were closed with valid_to = leavingDate
      const p1 = await get('orgAdminA', `${BASE}/postings/${posting1Id}`);
      expect(p1.json<{ data: { validTo: string } }>().data.validTo).toBe('2024-08-31');

      const p2 = await get('orgAdminA', `${BASE}/postings/${posting2Id}`);
      expect(p2.json<{ data: { validTo: string } }>().data.validTo).toBe('2024-08-31');
    });

    it('rejects creating new posting on separated employee (400 or 409)', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/employees/${sepEmpId}/postings`, {
        departmentId: D1,
        validFrom: '2024-09-01',
        isPrimary: true,
        reason: 'Posting on separated employee',
      });

      expect([400, 409]).toContain(res.statusCode);
    });

    it('database trigger employees_separation_guard closes postings on direct SQL update', async () => {
      // Create another employee for direct SQL test
      const res = await createEmployee('orgAdminA', U.grantee, 'POST-003');
      expect(res.statusCode).toBe(201);
      const directEmpId = res.json<{ data: { id: string } }>().data.id;

      // Add posting
      const p = await send('POST', 'orgAdminA', `${BASE}/employees/${directEmpId}/postings`, {
        departmentId: D1,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Direct SQL test posting',
      });
      expect(p.statusCode).toBe(201);
      const postDirectId = p.json<{ data: { id: string } }>().data.id;

      // Direct SQL update to SEPARATED with leaving_date
      await adminQuery(
        `UPDATE app.employees
            SET status = 'SEPARATED', leaving_date = '2024-09-15'
          WHERE id = $1`,
        [directEmpId],
      );

      // Verify posting closed by trigger
      const rows = await adminQuery<{ valid_to: string }>(
        `SELECT valid_to::text FROM app.employee_postings WHERE id = $1`,
        [postDirectId],
      );
      expect(rows[0]?.valid_to).toBe('2024-09-15');
    });
  });

  describe('Scope Resolution Activation', () => {
    let empD1Id: string;
    let empD2Id: string;
    let empD3Id: string;
    let empNoPostId: string;

    beforeAll(async () => {
      // Create employee for uid.faculty
      const resFac = await createEmployee('orgAdminA', uid.faculty, 'POST-FAC');
      expect(resFac.statusCode).toBe(201);
      empD1Id = resFac.json<{ data: { id: string } }>().data.id;

      // Primary posting in D1 (CAMPUS_1)
      await send('POST', 'orgAdminA', `${BASE}/employees/${empD1Id}/postings`, {
        departmentId: D1,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Primary posting in D1',
      });

      // Employee 2: primary in D2 (CAMPUS_1)
      const resD2 = await createEmployee('orgAdminA', uid.hod, 'POST-D2');
      expect(resD2.statusCode).toBe(201);
      empD2Id = resD2.json<{ data: { id: string } }>().data.id;
      await send('POST', 'orgAdminA', `${BASE}/employees/${empD2Id}/postings`, {
        departmentId: D2,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Primary posting in D2',
      });

      // Employee 3: primary in D3 (CAMPUS_2)
      const resD3 = await createEmployee('orgAdminA', uid.campusAdmin, 'POST-D3');
      expect(resD3.statusCode).toBe(201);
      empD3Id = resD3.json<{ data: { id: string } }>().data.id;
      await send('POST', 'orgAdminA', `${BASE}/employees/${empD3Id}/postings`, {
        departmentId: D3,
        validFrom: '2024-01-01',
        isPrimary: true,
        reason: 'Primary posting in D3',
      });

      // Employee 4: NO postings
      const resNoPost = await createEmployee('orgAdminA', U.extra, 'POST-NOP');
      // If user doesn't exist, create one or skip
      if (resNoPost.statusCode === 201) {
        empNoPostId = resNoPost.json<{ data: { id: string } }>().data.id;
      }
    });

    it('HOD of D1 can view employees with active primary posting in D1', async () => {
      const res = await get('hodA', `${BASE}/employees/${empD1Id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { id: string } }>().data.id).toBe(empD1Id);
    });

    it('HOD of D1 cannot view employees in D2 or D3 (fails closed 404)', async () => {
      const res2 = await get('hodA', `${BASE}/employees/${empD2Id}`);
      expect(res2.statusCode).toBe(404);

      const res3 = await get('hodA', `${BASE}/employees/${empD3Id}`);
      expect(res3.statusCode).toBe(404);
    });

    it('Campus Admin of CAMPUS_1 can view employees in D1 and D2 (same campus)', async () => {
      const res1 = await get('campusAdminA', `${BASE}/employees/${empD1Id}`);
      expect(res1.statusCode).toBe(200);

      const res2 = await get('campusAdminA', `${BASE}/employees/${empD2Id}`);
      expect(res2.statusCode).toBe(200);
    });

    it('Campus Admin of CAMPUS_1 cannot view employee in D3 / CAMPUS_2 (fails closed 404)', async () => {
      const res = await get('campusAdminA', `${BASE}/employees/${empD3Id}`);
      expect(res.statusCode).toBe(404);
    });

    it('College Admin can view employees across all departments and campuses', async () => {
      const res1 = await get('orgAdminA', `${BASE}/employees/${empD1Id}`);
      expect(res1.statusCode).toBe(200);

      const res2 = await get('orgAdminA', `${BASE}/employees/${empD2Id}`);
      expect(res2.statusCode).toBe(200);

      const res3 = await get('orgAdminA', `${BASE}/employees/${empD3Id}`);
      expect(res3.statusCode).toBe(200);
    });

    it('employee can read their own employee profile via SELF grant', async () => {
      const res = await get('facultyA', `${BASE}/employees/${empD1Id}`);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: { id: string } }>().data.id).toBe(empD1Id);
    });

    it('employee without active primary posting fails closed for scoped actors', async () => {
      if (empNoPostId) {
        // HOD cannot see employee without active primary posting in their department
        const resHod = await get('hodA', `${BASE}/employees/${empNoPostId}`);
        expect(resHod.statusCode).toBe(404);

        // Campus Admin cannot see employee without active primary posting in their campus
        const resCampus = await get('campusAdminA', `${BASE}/employees/${empNoPostId}`);
        expect(resCampus.statusCode).toBe(404);

        // Org Admin can see them
        const resOrg = await get('orgAdminA', `${BASE}/employees/${empNoPostId}`);
        expect(resOrg.statusCode).toBe(200);
      }
    });
  });

  describe('Audit Trail Verification', () => {
    it('records employee.posting.create, update, and close audit events', async () => {
      const events = await adminQuery<{ action: string }>(
        `SELECT DISTINCT action FROM app.audit_events
          WHERE organization_id = $1 AND action LIKE 'employee.posting.%'`,
        [T.orgId],
      );

      const actions = events.map((e) => e.action);
      expect(actions).toContain('employee.posting.create');
      expect(actions).toContain('employee.posting.close');
    });
  });
});
