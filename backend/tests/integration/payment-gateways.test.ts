import { randomBytes, createHmac } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
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

const s = {} as Record<'admin' | 'student1' | 'otherAdmin', Session>;

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

describe('Payment Gateways & Online Fee Payments Integration Test', () => {
  let yearId = '';
  let termId = '';
  let student1Id = '';
  let categoryId = '';
  let structureId = '';
  let dueId = '';
  let attemptRef = '';
  let receiptId = '';

  const rzpSecret = 'rzp_test_sec_key_xyz987';
  const rzpWebhookSec = 'rzp_wh_sec_key_abc123';
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Mock global fetch for gateway external HTTP APIs
    globalThis.fetch = vi.fn().mockImplementation(async (fetchUrl: string | URL | Request) => {
      const u = typeof fetchUrl === 'string' ? fetchUrl : fetchUrl.toString();
      if (u.includes('/payments?count=1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [] }),
          text: async () => JSON.stringify({ items: [] }),
        } as unknown as Response;
      }
      if (u.includes('/orders')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `order_rzp_${RUN}_123`,
            amount: 1000000,
            currency: 'INR',
            status: 'created',
          }),
          text: async () => JSON.stringify({ id: `order_rzp_${RUN}_123`, amount: 1000000 }),
        } as unknown as Response;
      }
      if (u.includes('/refund')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `rfnd_rzp_${RUN}_999`,
            status: 'processed',
            amount: 1000000,
          }),
          text: async () => JSON.stringify({ id: `rfnd_rzp_${RUN}_999`, status: 'processed' }),
        } as unknown as Response;
      }
      if (u.includes('/payments/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: `pay_mock_${RUN}_123`,
            order_id: `order_rzp_${RUN}_123`,
            status: 'captured',
            amount: 1000000,
            currency: 'INR',
            method: 'upi',
          }),
          text: async () => JSON.stringify({ id: `pay_mock_${RUN}_123`, status: 'captured' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      } as unknown as Response;
    });

    await app.ready();
    HASH = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    T = await createIsolatedTenant(HASH);
    OTHER = await createIsolatedTenant(HASH);

    student1Id = T.students.one;

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
    s.otherAdmin = await login(OTHER.emails.admin);

    await elevateSession(s.admin.cookie);

    // Create Category and Structure
    const catRes = await call('POST', s.admin, '/finance/categories', {
      code: code('TUIT'),
      name: 'Tuition Fee Category',
      description: 'Standard tuition fee',
    });
    expect(catRes.statusCode).toBe(201);
    categoryId = catRes.json<{ data: { id: string } }>().data.id;

    const structRes = await call('POST', s.admin, '/finance/structures', {
      campus_id: T.campusId,
      academic_year_id: yearId,
      code: code('ENG'),
      name: 'B.Tech Tuition',
      currency: 'INR',
      due_date: '2026-08-31',
      components: [{ fee_category_id: categoryId, amount: 2000000 }],
    });
    expect(structRes.statusCode).toBe(201);
    structureId = structRes.json<{ data: { id: string } }>().data.id;

    // Generate Due for student1
    const duesRes = await call('POST', s.admin, '/finance/dues/generate', {
      fee_structure_id: structureId,
      student_ids: [student1Id],
    });
    expect(duesRes.statusCode).toBe(201);

    const listDues = await call('GET', s.admin, '/finance/dues');
    expect(listDues.statusCode).toBe(200);
    const duesList = listDues.json<{ data: Array<{ id: string; student_id: string }> }>().data;
    const myDue = duesList.find((d) => d.student_id === student1Id);
    expect(myDue).toBeDefined();
    dueId = myDue!.id;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
    await db.close();
  });

  it('1. saves encrypted gateway credentials and masks secrets in listing', async () => {
    const saveRes = await call('POST', s.admin, '/finance/gateway/config', {
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      is_active: true,
      merchant_key: 'rzp_test_merchant_12345678',
      secret_key: rzpSecret,
      webhook_secret: rzpWebhookSec,
      settings: {},
    });
    expect(saveRes.statusCode).toBe(201);
    const saved = saveRes.json<{ data: { provider: string; merchant_key_masked: string } }>().data;
    expect(saved.provider).toBe('RAZORPAY');
    expect(saved.merchant_key_masked).toContain('••••••••');
    expect(saved.merchant_key_masked).not.toContain(rzpSecret);

    // Verify list endpoint returns masked key
    const listRes = await call('GET', s.admin, '/finance/gateway/config');
    expect(listRes.statusCode).toBe(200);
    const configs = listRes.json<{
      data: Array<{ provider: string; merchant_key_masked: string }>;
    }>().data;
    expect(configs.length).toBeGreaterThanOrEqual(1);
    expect(configs[0]!.merchant_key_masked).toContain('••••••••');

    // Tenant isolation: otherAdmin cannot see T's gateway config
    const otherRes = await call('GET', s.otherAdmin, '/finance/gateway/config');
    expect(otherRes.statusCode).toBe(200);
    const otherConfigs = otherRes.json<{ data: Array<unknown> }>().data;
    expect(otherConfigs).toHaveLength(0);
  });

  it('2. executes mock gateway health check via /finance/gateway/test', async () => {
    const testRes = await call('POST', s.admin, '/finance/gateway/test', {
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      merchant_key: 'rzp_test_merchant_12345678',
      secret_key: rzpSecret,
      webhook_secret: rzpWebhookSec,
      settings: {},
    });
    if (
      testRes.statusCode !== 200 ||
      !testRes.json<{ data: { healthy: boolean } }>().data?.healthy
    ) {
      console.log('TEST RES FAILED:', testRes.statusCode, testRes.body);
    }
    expect(testRes.statusCode).toBe(200);
    const health = testRes.json<{ data: { healthy: boolean; message: string } }>().data;
    expect(health.healthy).toBe(true);
    expect(health.message).toContain('Razorpay');
  });

  it('3. allows student to initiate online payment attempt for due', async () => {
    const initRes = await call('POST', s.student1, '/finance/payments/initiate', {
      student_id: student1Id,
      student_due_id: dueId,
      amount: 1000000, // 10,000 INR
      campus_id: T.campusId,
      description: 'Partial term payment',
    });

    if (initRes.statusCode !== 201) {
      console.log('INIT ERROR:', initRes.statusCode, initRes.body);
    }
    expect(initRes.statusCode).toBe(201);
    const body = initRes.json<{
      data: {
        attempt_reference: string;
        order_reference: string;
        provider: string;
        checkout_payload: Record<string, unknown>;
      };
    }>().data;

    expect(body.attempt_reference).toBeDefined();
    expect(body.order_reference).toBeDefined();
    expect(body.provider).toBe('RAZORPAY');
    expect(body.checkout_payload).toBeDefined();
    attemptRef = body.attempt_reference;

    // Verify payment attempt record in database
    const rows = await adminQuery<{ status: string; amount: string }>(
      `SELECT status, amount FROM app.payment_attempts WHERE attempt_reference = $1`,
      [attemptRef],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('INITIATED');
    expect(rows[0]!.amount).toBe('1000000');
  });

  it('4. verifies payment with valid signature, issues fee receipt, and reduces due balance', async () => {
    const paymentId = `pay_mock_${RUN}_123`;
    const orderRows = await adminQuery<{ order_reference: string }>(
      `SELECT order_reference FROM app.payment_attempts WHERE attempt_reference = $1`,
      [attemptRef],
    );
    const orderRef = orderRows[0]!.order_reference;

    // Calculate valid HMAC-SHA256 signature using secretKey
    const validSignature = createHmac('sha256', rzpSecret)
      .update(`${orderRef}|${paymentId}`)
      .digest('hex');

    const verifyRes = await call('POST', s.student1, '/finance/payments/verify', {
      attempt_reference: attemptRef,
      gateway_payment_ref: paymentId,
      gateway_signature: validSignature,
    });

    if (verifyRes.statusCode !== 200) {
      console.log('VERIFY ERROR:', verifyRes.statusCode, verifyRes.body);
    }
    expect(verifyRes.statusCode).toBe(200);
    const verifyData = verifyRes.json<{
      data: {
        success: boolean;
        receipt_id: string;
        receipt_number: string;
        status: string;
      };
    }>().data;

    expect(verifyData.success).toBe(true);
    expect(verifyData.status).toBe('SUCCESS');
    expect(verifyData.receipt_number).toMatch(/^REC-/);
    receiptId = verifyData.receipt_id;

    // Verify payment attempt status updated to SUCCESS
    const attemptCheck = await adminQuery<{ status: string; gateway_payment_ref: string }>(
      `SELECT status, gateway_payment_ref FROM app.payment_attempts WHERE attempt_reference = $1`,
      [attemptRef],
    );
    expect(attemptCheck[0]!.status).toBe('SUCCESS');
    expect(attemptCheck[0]!.gateway_payment_ref).toBe(paymentId);

    // Verify due balance decreased by 10,000 INR (from 20,000 to 10,000)
    const dueCheck = await adminQuery<{
      balance_amount: string;
      paid_amount: string;
      status: string;
    }>(`SELECT balance_amount, paid_amount, status FROM app.student_dues WHERE id = $1`, [dueId]);
    expect(dueCheck[0]!.paid_amount).toBe('1000000');
    expect(dueCheck[0]!.balance_amount).toBe('1000000');
    expect(dueCheck[0]!.status).toBe('PARTIAL');
  });

  it('5. enforces idempotency on re-verification without duplicate balance deduction', async () => {
    const verifyAgain = await call('POST', s.student1, '/finance/payments/verify', {
      attempt_reference: attemptRef,
      gateway_payment_ref: `pay_mock_${RUN}_123`,
    });

    expect(verifyAgain.statusCode).toBe(200);
    const data = verifyAgain.json<{ data: { success: boolean; receipt_id: string } }>().data;
    expect(data.success).toBe(true);
    expect(data.receipt_id).toBe(receiptId);

    // Verify due balance was NOT deducted again (still 10,000 INR)
    const dueCheck = await adminQuery<{ balance_amount: string; paid_amount: string }>(
      `SELECT balance_amount, paid_amount FROM app.student_dues WHERE id = $1`,
      [dueId],
    );
    expect(dueCheck[0]!.paid_amount).toBe('1000000');
    expect(dueCheck[0]!.balance_amount).toBe('1000000');
  });

  it('6. processes webhook asynchronously with signature validation', async () => {
    const webhookAttemptRef = `att_wh_${RUN}_999`;
    // Insert a pending attempt
    const gwConfigId = (
      await adminQuery<{ id: string }>(
        `SELECT id FROM app.payment_gateway_configs WHERE organization_id = $1 LIMIT 1`,
        [T.orgId],
      )
    )[0]!.id;

    await insertIn(T.orgId, 'payment_attempts', {
      campus_id: T.campusId,
      student_id: student1Id,
      student_due_id: dueId,
      gateway_config_id: gwConfigId,
      attempt_reference: webhookAttemptRef,
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      amount: 500000,
      currency: 'INR',
      order_reference: `order_wh_${RUN}`,
      status: 'PENDING',
      initiated_by_user_id: T.users.admin,
    });

    const rawBody = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: `pay_wh_${RUN}`,
            order_id: `order_wh_${RUN}`,
            amount: 500000,
            notes: {
              attempt_reference: webhookAttemptRef,
            },
          },
        },
      },
    });

    const validSig = createHmac('sha256', rzpWebhookSec).update(rawBody).digest('hex');

    const whRes = await app.inject({
      method: 'POST',
      url: `/api/v1/finance/payments/webhook/RAZORPAY`,
      payload: rawBody,
      cookies: { session_token: s.admin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': s.admin.csrf,
        'content-type': 'application/json',
        'x-razorpay-signature': validSig,
      },
    });

    expect(whRes.statusCode).toBe(200);
    const whResult = whRes.json<{ data: { processed: boolean; status: string } }>().data;
    expect(whResult.processed).toBe(true);
    expect(whResult.status).toBe('SUCCESS');

    // Verify database state
    const rows = await adminQuery<{ status: string }>(
      `SELECT status FROM app.payment_attempts WHERE attempt_reference = $1`,
      [webhookAttemptRef],
    );
    expect(rows[0]!.status).toBe('SUCCESS');
  });

  it('7. initiates online refund on receipt and tracks refund status', async () => {
    // Admin initiates refund on receiptId
    const refundRes = await call('POST', s.admin, `/finance/receipts/${receiptId}/refund`, {
      amount: 1000000,
      reason: 'Course withdrawal and fee concession adjustment',
    });

    expect(refundRes.statusCode).toBe(200);
    const refundData = refundRes.json<{
      data: {
        success: boolean;
        gateway_refund_ref: string;
        status: string;
      };
    }>().data;

    expect(refundData.success).toBe(true);
    expect(refundData.status).toBe('SUCCESS');
    expect(refundData.gateway_refund_ref).toBeDefined();

    // Verify refund record in database
    const refundRecords = await adminQuery<{ status: string; amount: string; reason: string }>(
      `SELECT status, amount, reason FROM app.payment_refunds WHERE receipt_id = $1`,
      [receiptId],
    );
    expect(refundRecords).toHaveLength(1);
    expect(refundRecords[0]!.status).toBe('SUCCESS');
    expect(refundRecords[0]!.amount).toBe('1000000');
  });

  it('8. generates reconciliation report cross-referencing online attempts vs ledger entries', async () => {
    const reconRes = await call('GET', s.admin, '/finance/reports/reconciliation');
    expect(reconRes.statusCode).toBe(200);
    const report = reconRes.json<{
      data: {
        total_online_attempts: number;
        total_successful_online_count: number;
        total_successful_online_amount: number;
        mismatches: Array<unknown>;
      };
    }>().data;

    expect(report.total_online_attempts).toBeGreaterThanOrEqual(1);
    expect(report.total_successful_online_count).toBeGreaterThanOrEqual(1);
    expect(report.total_successful_online_amount).toBeGreaterThanOrEqual(1000000);
  });
});
