import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AiGateway, DeterministicAiProvider } from '../../src/modules/ai/index.js';

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

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  await T?.cleanup().catch(() => undefined);
});

describe('AI Gateway Skeleton (Integration, ADR-013 & S-9)', () => {
  it('decorates Fastify instance with aiGateway on application bootstrap', () => {
    expect(app.aiGateway).toBeDefined();
    expect(app.aiGateway).toBeInstanceOf(AiGateway);
  });

  it('Tool isolation: Student A cannot read Student B notifications via AI Gateway (S-9 item 3)', async () => {
    const studentOneCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });
    const studentTwoCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentTwo,
      actorKind: 'STUDENT',
    });

    // Seed notification for Student One
    const notifOneId = uuidv7();
    await adminQuery(
      `INSERT INTO app.notifications
         (id, organization_id, recipient_user_id, category, title, body, action_url, version)
       VALUES ($1, $2, $3, 'ANNOUNCEMENT', 'Notice for Student One', 'Body One', null, 1)`,
      [notifOneId, T.orgId, T.users.studentOne],
    );

    // Seed notification for Student Two
    const notifTwoId = uuidv7();
    await adminQuery(
      `INSERT INTO app.notifications
         (id, organization_id, recipient_user_id, category, title, body, action_url, version)
       VALUES ($1, $2, $3, 'ANNOUNCEMENT', 'Notice for Student Two', 'Body Two', null, 1)`,
      [notifTwoId, T.orgId, T.users.studentTwo],
    );

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    // Student One executes get_my_notifications
    const resOne = await gateway.executeTool(studentOneCtx, 'get_my_notifications', {});
    expect(resOne.isError).toBe(false);
    const rowsOne = resOne.result as Array<{ id: string; title: string }>;
    expect(rowsOne.some((r) => r.id === notifOneId)).toBe(true);
    expect(rowsOne.some((r) => r.id === notifTwoId)).toBe(false);

    // Student Two executes get_my_notifications
    const resTwo = await gateway.executeTool(studentTwoCtx, 'get_my_notifications', {});
    expect(resTwo.isError).toBe(false);
    const rowsTwo = resTwo.result as Array<{ id: string; title: string }>;
    expect(rowsTwo.some((r) => r.id === notifTwoId)).toBe(true);
    expect(rowsTwo.some((r) => r.id === notifOneId)).toBe(false);
  });

  it('Adversarial schema injection: model/attacker attempting to supply recipient_user_id is rejected by schema', async () => {
    const studentOneCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    const adversarialRes = await gateway.executeTool(studentOneCtx, 'get_my_notifications', {
      recipient_user_id: T.users.studentTwo,
    });

    expect(adversarialRes.isError).toBe(true);
    const resObj = adversarialRes.result as { error?: string };
    expect(resObj.error).toContain('strict matching parameters without prohibited identity keys');
  });

  it('Document tool isolation: Student A cannot see Student B documents via AI Gateway (S-9)', async () => {
    const studentOneCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });
    const studentTwoCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentTwo,
      actorKind: 'STUDENT',
    });

    // Seed document for Student One
    const docOneId = uuidv7();
    const storageKey = `${T.orgId}/SENSITIVE/2026/${docOneId}`;
    await adminQuery(
      `INSERT INTO app.files
         (id, organization_id, storage_class, storage_key, original_name, declared_mime, detected_mime, size_bytes, sha256, status, classification, scan_result, uploaded_by, version)
       VALUES ($1, $2, 'SENSITIVE', $3, 'passport-one.pdf', 'application/pdf', 'application/pdf', 1024, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'AVAILABLE', 'CONFIDENTIAL', 'CLEAN', $4, 1)`,
      [docOneId, T.orgId, storageKey, T.users.studentOne],
    );

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    // Student One sees own document
    const resOne = await gateway.executeTool(studentOneCtx, 'get_my_documents', {});
    expect(resOne.isError).toBe(false);
    const docsOne = resOne.result as Array<{ id: string; fileName: string }>;
    expect(docsOne.some((d) => d.id === docOneId)).toBe(true);

    // Student Two sees NO documents
    const resTwo = await gateway.executeTool(studentTwoCtx, 'get_my_documents', {});
    expect(resTwo.isError).toBe(false);
    const docsTwo = resTwo.result as Array<{ id: string }>;
    expect(docsTwo.some((d) => d.id === docOneId)).toBe(false);
  });

  it('Authorization: caller without assistant.use permission is rejected with 404 RESOURCE_NOT_FOUND', async () => {
    // HOD role does not hold assistant.use in role matrix (only STUDENT and FACULTY do in M1)
    const hodCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.hod,
      actorKind: 'STAFF',
    });

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    await expect(
      gateway.chat(hodCtx, {
        messages: [{ role: 'user', content: 'Hello as HOD' }],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('Chat flow with real database: enforces rate limiting, executes chat, and records audit row in app.audit_events', async () => {
    const studentOneCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    const chatResponse = await gateway.chat(studentOneCtx, {
      messages: [{ role: 'user', content: 'What courses am I enrolled in?' }],
      maxTokens: 500,
    });

    expect(chatResponse.message.role).toBe('assistant');
    expect(chatResponse.finishReason).toBe('stop');
    expect(chatResponse.usage.totalTokens).toBeGreaterThan(0);

    // Verify audit event persisted in PostgreSQL app.audit_events
    const audits = await adminQuery<{
      action: string;
      actor_user_id: string;
      risk_tier: number;
    }>(
      `SELECT action, actor_user_id, risk_tier FROM app.audit_events
        WHERE organization_id = $1 AND actor_user_id = $2 AND action = 'ai.chat.complete'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T.orgId, T.users.studentOne],
    );

    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe('ai.chat.complete');
    expect(audits[0]!.risk_tier).toBe(1);
    expect(audits[0]!.actor_user_id).toBe(T.users.studentOne);
  });

  it('Two-phase write: prepareAction generates token; cross-user consumption fails; valid consumption audits', async () => {
    const studentOneCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });
    const studentTwoCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentTwo,
      actorKind: 'STUDENT',
    });

    const gateway = new AiGateway({
      db,
      provider: new DeterministicAiProvider(),
    });

    // 1. Prepare action for Student One
    const prepared = await gateway.prepareAction(studentOneCtx, 'submit_service_request', {
      ref_no: 'SR-2026-001',
    });
    expect(prepared.confirmToken).toBeDefined();

    // 2. Student Two attempts to execute with Student One's token -> fails (403)
    const crossUserExec = await gateway.executeTool(studentTwoCtx, 'submit_service_request', {
      ref_no: 'SR-2026-001',
      confirm_token: prepared.confirmToken,
    });
    expect(crossUserExec.isError).toBe(true);
    expect(crossUserExec.result).toEqual(
      expect.objectContaining({
        error: 'Confirmation token was not issued to the authenticated caller.',
      }),
    );

    // 3. Student One executes with valid token -> succeeds
    const validExec = await gateway.executeTool(studentOneCtx, 'submit_service_request', {
      ref_no: 'SR-2026-001',
      confirm_token: prepared.confirmToken,
    });
    expect(validExec.isError).toBe(false);
    expect(validExec.result).toEqual(
      expect.objectContaining({
        status: 'SUBMITTED',
        ref_no: 'SR-2026-001',
      }),
    );

    // 4. Reusing consumed token fails (409)
    const reuseExec = await gateway.executeTool(studentOneCtx, 'submit_service_request', {
      ref_no: 'SR-2026-001',
      confirm_token: prepared.confirmToken,
    });
    expect(reuseExec.isError).toBe(true);
    expect(reuseExec.result).toEqual(
      expect.objectContaining({
        error: 'Confirmation token has already been consumed.',
      }),
    );

    // 5. Verify audit event for tool execution
    const toolAudits = await adminQuery<{
      action: string;
      actor_user_id: string;
      risk_tier: number;
    }>(
      `SELECT action, actor_user_id, risk_tier FROM app.audit_events
        WHERE organization_id = $1 AND actor_user_id = $2 AND action = 'ai.tool.execute'
        ORDER BY occurred_at DESC LIMIT 1`,
      [T.orgId, T.users.studentOne],
    );

    expect(toolAudits.length).toBe(1);
    expect(toolAudits[0]!.action).toBe('ai.tool.execute');
    expect(toolAudits[0]!.risk_tier).toBe(2); // Write tool is riskTier 2
  });
});
