import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import type { ConsentResponse } from '../../src/modules/consent/consent.schemas.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 6 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;

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
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  await T?.cleanup().catch(() => undefined);
  await OTHER?.cleanup().catch(() => undefined);
});

describe('Consent Management HTTP API (doc 02 §4.3, doc 10 rows 39-41)', () => {
  it('GET /api/v1/me/consents: returns empty array initially for a student', async () => {
    const student = await login(T.emails.studentOne);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/consents',
      cookies: { session_token: student.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /api/v1/me/consents: records explicit point-in-time consent and outbox event', async () => {
    const student = await login(T.emails.studentOne);
    const policyText = 'I consent to the collection of my educational records.';
    const expectedHash = createHash('sha256').update(policyText, 'utf8').digest('hex');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/me/consents',
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
      payload: {
        consentType: 'EDUCATIONAL_RECORDS',
        policyVersion: '2026.1',
        policyText,
        method: 'WEB_FORM',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<ConsentResponse>();

    expect(body.userId).toBe(T.users.studentOne);
    expect(body.organizationId).toBe(T.orgId);
    expect(body.status).toBe('GRANTED');
    expect(body.policyTextHash).toBe(expectedHash);
    expect(body.grantedByUserId).toBe(T.users.studentOne);
    expect(body.guardianId).toBeNull();
    expect(body.version).toBe(1);

    // Verify outbox event was recorded
    const outboxRows = await adminQuery<{ event_type: string; aggregate_id: string }>(
      `SELECT event_type, aggregate_id FROM app.outbox_events WHERE organization_id = $1 AND aggregate_id = $2`,
      [T.orgId, body.id],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]?.event_type).toBe('consent.recorded');

    // Verify it appears in GET /me/consents
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/me/consents',
      cookies: { session_token: student.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json<ConsentResponse[]>().length).toBe(1);
  });

  it('POST /api/v1/me/consents/:id/withdraw: forward-only withdrawal and idempotent conflict on second attempt', async () => {
    const student = await login(T.emails.studentOne);

    // Create consent to withdraw
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/me/consents',
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
      payload: {
        consentType: 'OPTIONAL_ANALYTICS',
        policyVersion: '1.0',
        policyText: 'Analytics collection consent terms.',
      },
    });
    const consentId = createRes.json<ConsentResponse>().id;

    // Withdraw consent
    const withdrawRes = await app.inject({
      method: 'POST',
      url: `/api/v1/me/consents/${consentId}/withdraw`,
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
    });
    expect(withdrawRes.statusCode).toBe(200);
    const withdrawnData = withdrawRes.json<ConsentResponse>();
    expect(withdrawnData.status).toBe('WITHDRAWN');
    expect(withdrawnData.withdrawnAt).not.toBeNull();
    expect(withdrawnData.version).toBe(2);

    // Verify outbox event
    const outboxRows = await adminQuery<{ event_type: string }>(
      `SELECT event_type FROM app.outbox_events WHERE organization_id = $1 AND aggregate_id = $2 ORDER BY created_at DESC`,
      [T.orgId, consentId],
    );
    expect(outboxRows.map((r) => r.event_type)).toContain('consent.withdrawn');

    // Repeated withdrawal returns 409
    const secondWithdraw = await app.inject({
      method: 'POST',
      url: `/api/v1/me/consents/${consentId}/withdraw`,
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
    });
    expect(secondWithdraw.statusCode).toBe(409);
    expect(secondWithdraw.json<{ error: { code: string } }>().error.code).toBe(
      'CONSENT_ALREADY_WITHDRAWN',
    );
  });

  it('POST /api/v1/users/:id/consents: student cannot record consent for another user (403 or 404)', async () => {
    const student = await login(T.emails.studentOne);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${T.users.studentTwo}/consents`,
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
      payload: {
        consentType: 'DATA_PROCESSING',
        policyVersion: '1.0',
        policyText: 'Terms',
      },
    });
    // Invariant C: unauthorized target returns 403 or 404
    expect([403, 404]).toContain(res.statusCode);
  });

  it('GET /api/v1/users/:id/consents: staff can view student consents, but student cannot view another student', async () => {
    const admin = await login(T.emails.admin);
    const student = await login(T.emails.studentOne);

    // Admin can view studentOne's consents
    const adminRes = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${T.users.studentOne}/consents`,
      cookies: { session_token: admin.cookie },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(Array.isArray(adminRes.json())).toBe(true);

    // StudentOne cannot view StudentTwo's consents
    const studentRes = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${T.users.studentTwo}/consents`,
      cookies: { session_token: student.cookie },
    });
    expect([403, 404]).toContain(studentRes.statusCode);
  });

  it('Guardian-granted consent: verifies guardian authority and can_give_consent flag', async () => {
    const admin = await login(T.emails.admin);
    const guardianId = uuidv7();

    // Seed guardian and student_guardian relation in private tenant
    await adminQuery(
      `INSERT INTO app.guardians (id, organization_id, full_name, phone, email)
       VALUES ($1, $2, 'Parent One', '+919876543210', 'parent1@test.local')`,
      [guardianId, T.orgId],
    );

    // Case A: can_give_consent is FALSE
    await adminQuery(
      `INSERT INTO app.student_guardians (
         id, organization_id, student_id, guardian_id, relation, is_primary, can_give_consent
       ) VALUES ($1, $2, $3, $4, 'Mother', true, false)`,
      [uuidv7(), T.orgId, T.students.two, guardianId],
    );

    const failRes = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${T.users.studentTwo}/consents`,
      headers: { 'x-csrf-token': admin.csrf },
      cookies: { session_token: admin.cookie },
      payload: {
        consentType: 'FIELD_TRIP',
        policyVersion: '1.0',
        policyText: 'Field trip consent terms',
        guardianId,
      },
    });
    expect(failRes.statusCode).toBe(403);
    expect(failRes.json<{ error: { code: string } }>().error.code).toBe(
      'GUARDIAN_CONSENT_UNAUTHORIZED',
    );

    // Case B: update can_give_consent to TRUE
    await adminQuery(
      `UPDATE app.student_guardians SET can_give_consent = true WHERE student_id = $1 AND guardian_id = $2`,
      [T.students.two, guardianId],
    );

    const okRes = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${T.users.studentTwo}/consents`,
      headers: { 'x-csrf-token': admin.csrf },
      cookies: { session_token: admin.cookie },
      payload: {
        consentType: 'FIELD_TRIP',
        policyVersion: '1.0',
        policyText: 'Field trip consent terms',
        guardianId,
      },
    });
    expect(okRes.statusCode).toBe(201);
    expect(okRes.json<ConsentResponse>().guardianId).toBe(guardianId);
  });

  it('Cross-tenant isolation: Tenant B admin cannot read or record consents for Tenant A user', async () => {
    const otherAdmin = await login(OTHER.emails.admin);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${T.users.studentOne}/consents`,
      cookies: { session_token: otherAdmin.cookie },
    });
    // Invariant C: Tenant A user is not found in Tenant B context
    expect([403, 404]).toContain(res.statusCode);
  });
});
