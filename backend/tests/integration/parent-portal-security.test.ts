import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

const PASSWORD = /* secret-scan:allow */ 'ParentSecurePass123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let HASH = '';

interface Session {
  cookie: string;
  csrf: string;
}

const s = {} as Record<
  'parentA' | 'parentB' | 'parentMulti' | 'revokedParent',
  Session
>;

let student1Id: string;
let student2Id: string;

async function login(email: string): Promise<Session> {
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

describe('Parent Portal Authentication, Child Linking & Security Isolation', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);

    student1Id = T.students.one;
    student2Id = T.students.two;

    const parentAUserId = uuidv7();
    const parentBUserId = uuidv7();
    const parentMultiUserId = uuidv7();
    const revokedParentUserId = uuidv7();
    const suspendedParentUserId = uuidv7();

    const parentAEmail = `parenta.${RUN}@anesa.test`.toLowerCase();
    const parentBEmail = `parentb.${RUN}@anesa.test`.toLowerCase();
    const parentMultiEmail = `parentmulti.${RUN}@anesa.test`.toLowerCase();
    const revokedEmail = `parentrevoked.${RUN}@anesa.test`.toLowerCase();
    const suspendedEmail = `parentsuspended.${RUN}@anesa.test`.toLowerCase();

    // 1. Create identities and users in platform & app
    const users = [
      { id: parentAUserId, email: parentAEmail, name: 'Parent Alice', status: 'ACTIVE' },
      { id: parentBUserId, email: parentBEmail, name: 'Parent Bob', status: 'ACTIVE' },
      { id: parentMultiUserId, email: parentMultiEmail, name: 'Parent Multi', status: 'ACTIVE' },
      { id: revokedParentUserId, email: revokedEmail, name: 'Parent Revoked', status: 'ACTIVE' },
      { id: suspendedParentUserId, email: suspendedEmail, name: 'Parent Suspended', status: 'SUSPENDED' },
    ];

    for (const u of users) {
      await adminQuery(
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, $4)`,
        [u.id, u.email, HASH, u.status],
      );
      await adminQuery(
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
         VALUES ($1, $2, $3, $4, $5, $1)`,
        [u.id, T.orgId, u.email, u.name, u.status],
      );
    }

    // 2. Create app.guardians and link to app.users
    const guardianAId = uuidv7();
    const guardianBId = uuidv7();
    const guardianMultiId = uuidv7();
    const guardianRevokedId = uuidv7();
    const guardianSuspendedId = uuidv7();

    await adminQuery(
      `INSERT INTO app.guardians (id, organization_id, user_id, full_name, phone, email) VALUES
         ($1, $6, $7, 'Parent Alice', '+919876543210', $12),
         ($2, $6, $8, 'Parent Bob', '+919876543211', $13),
         ($3, $6, $9, 'Parent Multi', '+919876543212', $14),
         ($4, $6, $10, 'Parent Revoked', '+919876543213', $15),
         ($5, $6, $11, 'Parent Suspended', '+919876543214', $16)`,
      [
        guardianAId,
        guardianBId,
        guardianMultiId,
        guardianRevokedId,
        guardianSuspendedId,
        T.orgId,
        parentAUserId,
        parentBUserId,
        parentMultiUserId,
        revokedParentUserId,
        suspendedParentUserId,
        parentAEmail,
        parentBEmail,
        parentMultiEmail,
        revokedEmail,
        suspendedEmail,
      ],
    );

    // 3. Link Guardians to Students (app.student_guardians)
    // Parent A -> Student 1 (active)
    await adminQuery(
      `INSERT INTO app.student_guardians
         (id, organization_id, student_id, guardian_id, relation, is_primary, can_view_academics, can_receive_notifications, valid_from)
       VALUES
         ($1, $2, $3, $4, 'Mother', true, true, true, CURRENT_DATE)`,
      [uuidv7(), T.orgId, student1Id, guardianAId],
    );

    // Parent B -> Student 2 (active)
    await adminQuery(
      `INSERT INTO app.student_guardians
         (id, organization_id, student_id, guardian_id, relation, is_primary, can_view_academics, can_receive_notifications, valid_from)
       VALUES
         ($1, $2, $3, $4, 'Father', true, true, true, CURRENT_DATE)`,
      [uuidv7(), T.orgId, student2Id, guardianBId],
    );

    // Parent Multi -> Student 1 AND Student 2 (multi-child)
    await adminQuery(
      `INSERT INTO app.student_guardians
         (id, organization_id, student_id, guardian_id, relation, is_primary, can_view_academics, can_receive_notifications, valid_from)
       VALUES
         ($1, $3, $4, $6, 'Guardian', false, true, true, CURRENT_DATE),
         ($2, $3, $5, $6, 'Guardian', false, true, true, CURRENT_DATE)`,
      [uuidv7(), uuidv7(), T.orgId, student1Id, student2Id, guardianMultiId],
    );

    // Revoked Parent -> Student 1 with valid_to in PAST
    await adminQuery(
      `INSERT INTO app.student_guardians
         (id, organization_id, student_id, guardian_id, relation, is_primary, can_view_academics, can_receive_notifications, valid_from, valid_to)
       VALUES
         ($1, $2, $3, $4, 'Former Guardian', false, true, true, '2020-01-01', '2021-01-01')`,
      [uuidv7(), T.orgId, student1Id, guardianRevokedId],
    );

    // 4. Seed fee structures and dues for Student 1 and Student 2
    const feeCatId = uuidv7();
    const feeStructId = uuidv7();
    const yearId = uuidv7();

    await adminQuery(
      `INSERT INTO app.academic_years (id, organization_id, label, start_date, end_date)
       VALUES ($1, $2, '2026-2027', '2026-06-01', '2027-05-31')`,
      [yearId, T.orgId],
    );
    const cleanRun = RUN.replace(/[^A-Z0-9]/g, 'X');
    await adminQuery(
      `INSERT INTO app.fee_categories (id, organization_id, name, code)
       VALUES ($1, $2, 'Tuition', $3)`,
      [feeCatId, T.orgId, `TUI_${cleanRun}`.slice(0, 30)],
    );
    await adminQuery(
      `INSERT INTO app.fee_structures (id, organization_id, campus_id, academic_year_id, name, code, due_date, created_by_user_id)
       VALUES ($1, $2, $3, $4, 'Term 1 Tuition', $5, CURRENT_DATE + 30, $6)`,
      [feeStructId, T.orgId, T.campusId, yearId, `STR_${cleanRun}`.slice(0, 30), T.users.admin],
    );

    await adminQuery(
      `INSERT INTO app.student_dues
         (id, organization_id, campus_id, student_id, fee_structure_id, academic_year_id, due_number, gross_amount, net_amount, balance_amount, status, due_date, generated_by_user_id)
       VALUES
         ($1, $3, $4, $5, $6, $7, 'DUE-A-001', 2500000, 2500000, 2500000, 'PENDING', CURRENT_DATE + 30, $8),
         ($2, $3, $4, $9, $6, $7, 'DUE-B-001', 3000000, 3000000, 3000000, 'PENDING', CURRENT_DATE + 30, $8)`,
      [
        uuidv7(),
        uuidv7(),
        T.orgId,
        T.campusId,
        student1Id,
        feeStructId,
        yearId,
        T.users.admin,
        student2Id,
      ],
    );

    // 5. Logins
    s.parentA = await login(parentAEmail);
    s.parentB = await login(parentBEmail);
    s.parentMulti = await login(parentMultiEmail);
    s.revokedParent = await login(revokedEmail);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('Parent A lists their own verified linked child (Student 1) only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/parent/children',
      headers: {
        cookie: `session_token=${s.parentA.cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: Array<{ studentId: string }> }>();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.studentId).toBe(student1Id);
  });

  it('Parent Multi with 2 children receives both in child switcher list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/parent/children',
      headers: {
        cookie: `session_token=${s.parentMulti.cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: Array<{ studentId: string }> }>();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    const ids = body.data.map((c) => c.studentId).sort();
    expect(ids).toEqual([student1Id, student2Id].sort());
  });

  it('Parent A requesting verified Child 1 summary succeeds (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student1Id}/summary`,
      headers: {
        cookie: `session_token=${s.parentA.cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: { child: { studentId: string }; fees: { totalOutstanding: number } } }>();
    expect(body.success).toBe(true);
    expect(body.data.child.studentId).toBe(student1Id);
    expect(body.data.fees.totalOutstanding).toBe(2500000);
  });

  it('SECURITY: Parent A requesting unlinked Child 2 receives 403 FORBIDDEN (No Cross-Child Leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student2Id}/summary`,
      headers: {
        cookie: `session_token=${s.parentA.cookie}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Access denied');
  });

  it('SECURITY: Revoked Guardian with expired valid_to receives 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student1Id}/summary`,
      headers: {
        cookie: `session_token=${s.revokedParent.cookie}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('SECURITY: Parent A cannot access Student 2 fees (Unrelated Fee Records Stay Private)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student2Id}/fees`,
      headers: {
        cookie: `session_token=${s.parentA.cookie}`,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Parent A views verified Child 1 fees with exact dues ledger', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children/${student1Id}/fees`,
      headers: {
        cookie: `session_token=${s.parentA.cookie}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; data: { summary: { totalOutstanding: number }; dues: Array<{ dueNumber: string }> } }>();
    expect(body.data.summary.totalOutstanding).toBe(2500000);
    expect(body.data.dues).toHaveLength(1);
    expect(body.data.dues[0]!.dueNumber).toBe('DUE-A-001');
  });

  it('Unauthenticated requests to parent portal routes receive 401 UNAUTHORIZED', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/parent/children`,
    });
    expect(res.statusCode).toBe(401);
  });
});
