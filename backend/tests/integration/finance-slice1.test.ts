import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { activateTermFixture } from '../support/term-fixture.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
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
let OTHER!: IsolatedTenant;
let HASH = '';

interface Session {
  cookie: string;
  csrf: string;
}

const s = {} as Record<'admin' | 'student1' | 'student2' | 'otherAdmin', Session>;

let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

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

const call = (
  method: 'GET' | 'POST' | 'PATCH',
  who: Session | null,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload !== undefined ? { payload } : {}),
    cookies: who ? { session_token: who.cookie } : {},
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN }),
      ...(who && method !== 'GET' ? { 'x-csrf-token': who.csrf } : {}),
      ...headers,
    },
  });

async function insertIn(org: string, table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const rest = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = ['id', 'organization_id', ...rest.map(([k]) => k)];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [id, org, ...rest.map(([, v]) => v)],
  );
  return id;
}

describe('Finance Module: Fees, Dues, Offline Receipts & Reconciliation — Slice 1', () => {
  let yearId = '';
  let termId = '';
  let student1Id = '';
  let student2Id = '';
  let categoryId = '';
  let categoryLabId = '';
  let structureId = '';
  let due1Id = '';
  let due2Id = '';
  let receipt1Id = '';

  beforeAll(async () => {
    await app.ready();
    HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    T = await createIsolatedTenant(HASH);
    OTHER = await createIsolatedTenant(HASH);

    student1Id = T.students.one;
    student2Id = T.students.two;

    // Set up academic year and term
    yearId = await insertIn(T.orgId, 'academic_years', {
      label: `AY-${RUN}`,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    await adminQuery(`UPDATE app.academic_years SET status = 'ACTIVE' WHERE id = $1`, [yearId]);

    termId = await insertIn(T.orgId, 'terms', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: code('T1'),
      name: 'Term 1',
      start_date: '2026-06-01',
      end_date: '2026-12-31',
    });
    await activateTermFixture(termId);

    // Login sessions
    s.admin = await login(T.emails.admin);
    s.student1 = await login(T.emails.studentOne);
    s.student2 = await login(T.emails.studentTwo);
    s.otherAdmin = await login(OTHER.emails.admin);
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('1. creates and lists fee categories', async () => {
    const createRes = await call('POST', s.admin, '/finance/categories', {
      code: code('TUIT'),
      name: 'Tuition Fee Category',
      description: 'Standard institutional tuition fees',
    });
    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{ data: { id: string; code: string; name: string } }>();
    expect(body.data.id).toBeDefined();
    categoryId = body.data.id;

    const createLabRes = await call('POST', s.admin, '/finance/categories', {
      code: code('LAB'),
      name: 'Laboratory Fee Category',
      description: 'Standard institutional lab fees',
    });
    expect(createLabRes.statusCode).toBe(201);
    categoryLabId = createLabRes.json<{ data: { id: string } }>().data.id;

    const listRes = await call('GET', s.admin, '/finance/categories');
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ data: Array<{ id: string; code: string }> }>();
    expect(list.data.some((c) => c.id === categoryId)).toBe(true);
    expect(list.data.some((c) => c.id === categoryLabId)).toBe(true);
  });

  it('2. creates fee structure with components and integer minor-unit arithmetic', async () => {
    const structCode = code('STR');
    const createRes = await call('POST', s.admin, '/finance/structures', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      term_id: termId,
      code: structCode,
      name: 'Term 1 Standard Fee Structure',
      currency: 'INR',
      due_date: '2026-12-31',
      components: [
        {
          fee_category_id: categoryId,
          amount: 500000, // 5,000.00 in minor units
          description: 'Tuition Component',
        },
        {
          fee_category_id: categoryLabId,
          amount: 100000, // 1,000.00 in minor units
          description: 'Laboratory Component',
        },
      ],
    });

    expect(createRes.statusCode).toBe(201);
    const body = createRes.json<{
      data: { id: string; total_amount: number; status: string; components: Array<{ amount: number }> };
    }>();
    expect(body.data.id).toBeDefined();
    expect(body.data.total_amount).toBe(600000); // 500000 + 100000
    expect(body.data.status).toBe('ACTIVE');
    expect(body.data.components).toHaveLength(2);
    structureId = body.data.id;
  });

  it('3. generates student dues with deterministic concessions and duplicate prevention', async () => {
    // Generate for Student 1 with concession (50,000 minor units = 500.00) and Student 2 without concession
    const dueRes = await call('POST', s.admin, '/finance/dues/generate', {
      fee_structure_id: structureId,
      student_ids: [student1Id, student2Id],
      concessions: [
        {
          student_id: student1Id,
          discount_amount: 50000,
          reason: 'Merit scholarship award',
        },
      ],
    });
    expect(dueRes.statusCode).toBe(201);
    const body = dueRes.json<{
      data: {
        fee_structure_id: string;
        generated_count: number;
        skipped_count: number;
        dues: Array<{ id: string; student_id: string; gross_amount: number; discount_amount: number; balance_amount: number }>;
      };
    }>();
    expect(body.data.dues).toHaveLength(2);

    const due1 = body.data.dues.find((d) => d.student_id === student1Id)!;
    expect(due1.gross_amount).toBe(600000);
    expect(due1.discount_amount).toBe(50000);
    expect(due1.balance_amount).toBe(550000);
    due1Id = due1.id;

    const due2 = body.data.dues.find((d) => d.student_id === student2Id)!;
    expect(due2.gross_amount).toBe(600000);
    expect(due2.discount_amount).toBe(0);
    expect(due2.balance_amount).toBe(600000);
    due2Id = due2.id;
    expect(due2Id).toBeTruthy();

    // Attempting to generate duplicate dues for Student 1 on same structure is prevented / idempotent
    const dupRes = await call('POST', s.admin, '/finance/dues/generate', {
      fee_structure_id: structureId,
      student_ids: [student1Id],
    });
    expect(dupRes.statusCode).toBe(201);
    const dupBody = dupRes.json<{ data: { fee_structure_id: string; skipped_count: number } }>();
    expect(dupBody.data.skipped_count).toBe(1);
  });

  it('4. records offline payment with auto-allocation and unique receipt generation', async () => {
    const idempotencyKey = uuidv7();
    // Student 1 pays 300,000 minor units (3,000.00) via CASH
    const payRes = await call('POST', s.admin, '/finance/receipts', {
      campus_id: T.campusId,
      student_id: student1Id,
      amount: 300000,
      payment_method: 'CASH',
      payment_date: '2026-11-08',
      reconciliation_status: 'CONFIRMED',
      idempotency_key: idempotencyKey,
      remarks: 'Direct cash deposit at administrative counter',
    });

    expect(payRes.statusCode).toBe(201);
    const payBody = payRes.json<{
      data: {
        id: string;
        receipt_number: string;
        amount: number;
        payment_method: string;
        reconciliation_status: string;
        status: string;
        allocations: Array<{ student_due_id: string; allocated_amount: number }>;
      };
    }>();

    expect(payBody.data.receipt_number).toMatch(/^REC-\d{4}-\d{5}$/);
    expect(payBody.data.amount).toBe(300000);
    expect(payBody.data.payment_method).toBe('CASH');
    expect(payBody.data.reconciliation_status).toBe('CONFIRMED');
    expect(payBody.data.status).toBe('POSTED');
    expect(payBody.data.allocations).toHaveLength(1);
    expect(payBody.data.allocations[0]?.student_due_id).toBe(due1Id);
    expect(payBody.data.allocations[0]?.allocated_amount).toBe(300000);
    receipt1Id = payBody.data.id;

    // Verify student 1's due balance was decremented
    const dueCheck = await call('GET', s.admin, `/finance/dues?student_id=${student1Id}`);
    expect(dueCheck.statusCode).toBe(200);
    const dueList = dueCheck.json<{ data: Array<{ id: string; paid_amount: number; balance_amount: number; status: string }> }>();
    const d1 = dueList.data.find((d) => d.id === due1Id);
    expect(d1?.paid_amount).toBe(300000);
    expect(d1?.balance_amount).toBe(250000); // 550,000 - 300,000
    expect(d1?.status).toBe('PARTIAL');

    // Idempotent retry with same idempotency key returns exact same receipt
    const retryRes = await call('POST', s.admin, '/finance/receipts', {
      campus_id: T.campusId,
      student_id: student1Id,
      amount: 300000,
      payment_method: 'CASH',
      payment_date: '2026-11-08',
      reconciliation_status: 'CONFIRMED',
      idempotency_key: idempotencyKey,
    });
    expect(retryRes.statusCode).toBe(201);
    expect(retryRes.json<{ data: { id: string } }>().data.id).toBe(receipt1Id);
  });

  it('5. records offline payment with bank transfer and PENDING_VERIFICATION status', async () => {
    // Student 2 pays full 600,000 via BANK_TRANSFER
    const payRes2 = await call('POST', s.admin, '/finance/receipts', {
      campus_id: T.campusId,
      student_id: student2Id,
      amount: 600000,
      payment_method: 'BANK_TRANSFER',
      reconciliation_status: 'PENDING_VERIFICATION',
      reference_number: 'UTR-HDFC-99887766',
      payment_date: '2026-11-08',
    });

    expect(payRes2.statusCode).toBe(201);
    const body = payRes2.json<{
      data: {
        reconciliation_status: string;
        payment_method: string;
        reference_number: string;
      };
    }>();
    expect(body.data.payment_method).toBe('BANK_TRANSFER');
    expect(body.data.reconciliation_status).toBe('PENDING_VERIFICATION');
    expect(body.data.reference_number).toBe('UTR-HDFC-99887766');

    // Due balance becomes 0, status PAID
    const duesRes = await call('GET', s.admin, `/finance/dues?student_id=${student2Id}`);
    const d2 = duesRes.json<{ data: Array<{ id: string; balance_amount: number; status: string }> }>().data[0];
    expect(d2?.balance_amount).toBe(0);
    expect(d2?.status).toBe('PAID');
  });

  it('6. student can access own dues and ledger, but cannot access peers', async () => {
    // Student 1 accesses own dues
    const ownDues = await call('GET', s.student1, '/finance/dues');
    expect(ownDues.statusCode).toBe(200);
    const ownList = ownDues.json<{ data: Array<{ id: string; student_id: string }> }>();
    expect(ownList.data.every((d) => d.student_id === student1Id)).toBe(true);

    // Student 1 accesses own ledger
    const ownLedger = await call('GET', s.student1, `/finance/students/${student1Id}/ledger`);
    expect(ownLedger.statusCode).toBe(200);
    const ledger = ownLedger.json<{
      data: {
        total_gross: number;
        total_discount: number;
        total_net: number;
        total_paid: number;
        total_balance: number;
        dues: unknown[];
        receipts: unknown[];
      };
    }>();
    expect(ledger.data.total_gross).toBe(600000);
    expect(ledger.data.total_discount).toBe(50000);
    expect(ledger.data.total_net).toBe(550000);
    expect(ledger.data.total_paid).toBe(300000);
    expect(ledger.data.total_balance).toBe(250000);
    expect(ledger.data.dues).toHaveLength(1);
    expect(ledger.data.receipts).toHaveLength(1);

    // Student 1 attempting to view Student 2 ledger is blocked (403 Forbidden)
    const peerLedger = await call('GET', s.student1, `/finance/students/${student2Id}/ledger`);
    expect(peerLedger.statusCode).toBe(403);

    // Student 1 attempting to record receipt is blocked (403 Forbidden)
    const unauthorizedPay = await call('POST', s.student1, '/finance/receipts', {
      campus_id: T.campusId,
      student_id: student1Id,
      amount: 10000,
      payment_method: 'CASH',
      payment_date: '2026-11-08',
    });
    expect(unauthorizedPay.statusCode).toBe(403);
  });

  it('7. reverses receipt with step-up verification, mandatory reason, and due balance rollback', async () => {
    // Without step-up elevation, CRITICAL route fails with 403 STEP_UP_REQUIRED
    const failStepUp = await call('POST', s.admin, `/finance/receipts/${receipt1Id}/reverse`, {
      reason: 'Entered duplicate entry by mistake',
    });
    expect(failStepUp.statusCode).toBe(403);
    expect(failStepUp.json<{ error: { code: string } }>().error.code).toBe('STEP_UP_REQUIRED');

    // Elevate admin session to PASSWORD_MFA
    await elevateSession(s.admin.cookie);

    // Now execute reversal with reason
    const revRes = await call('POST', s.admin, `/finance/receipts/${receipt1Id}/reverse`, {
      reason: 'Cash returned: data entry mistake by cashier',
    });
    expect(revRes.statusCode).toBe(200);
    const revBody = revRes.json<{
      data: {
        id: string;
        status: string;
        reversal_reason: string;
        reversed_at: string;
      };
    }>();

    expect(revBody.data.status).toBe('REVERSED');
    expect(revBody.data.reversal_reason).toBe('Cash returned: data entry mistake by cashier');
    expect(revBody.data.reversed_at).toBeDefined();

    // Verify Student 1's due balance was restored to 550,000 and status returned to PENDING
    const dueCheck = await call('GET', s.admin, `/finance/dues?student_id=${student1Id}`);
    const d1 = dueCheck.json<{ data: Array<{ id: string; paid_amount: number; balance_amount: number; status: string }> }>().data[0];
    expect(d1?.paid_amount).toBe(0);
    expect(d1?.balance_amount).toBe(550000);
    expect(d1?.status).toBe('PENDING');

    // DB immutability guard test: attempting to DELETE a receipt fails via trigger
    await expect(
      adminQuery(`DELETE FROM app.fee_receipts WHERE id = $1`, [receipt1Id]),
    ).rejects.toThrow();
  });

  it('8. aggregates collection summary by campus, date range, and payment method', async () => {
    const summaryRes = await call('GET', s.admin, `/finance/reports/collection-summary?campus_id=${T.campusId}`);
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json<{
      data: {
        total_collected: number;
        receipt_count: number;
        reversed_count: number;
        by_payment_method: Record<string, number>;
      };
    }>();

    expect(summary.data.receipt_count).toBe(1);
    expect(summary.data.reversed_count).toBe(1);
    expect(summary.data.total_collected).toBe(600000); // Only bank transfer remains active (posted)
    expect(summary.data.by_payment_method['BANK_TRANSFER']).toBe(600000);
  });

  it('9. strictly enforces tenant isolation on all finance resources', async () => {
    // Other tenant admin cannot see categories or structures
    const otherCats = await call('GET', s.otherAdmin, '/finance/categories');
    expect(otherCats.statusCode).toBe(200);
    expect(otherCats.json<{ data: Array<{ id: string }> }>().data).toHaveLength(0);

    const otherStructs = await call('GET', s.otherAdmin, '/finance/structures');
    expect(otherStructs.statusCode).toBe(200);
    expect(otherStructs.json<{ data: Array<{ id: string }> }>().data).toHaveLength(0);

    // Other tenant admin cannot see student 1 dues or receipts
    const otherDues = await call('GET', s.otherAdmin, `/finance/dues?student_id=${student1Id}`);
    expect(otherDues.statusCode).toBe(200);
    expect(otherDues.json<{ data: unknown[] }>().data).toHaveLength(0);
  });
});
