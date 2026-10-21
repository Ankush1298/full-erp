import { describe, expect, it, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  AiGateway,
  ConfirmationTokenService,
  DeterministicAiProvider,
  DisabledAiProvider,
  GetMyDocumentsTool,
  GetMyNotificationsTool,
  SubmitServiceRequestTool,
  validateToolDefinition,
  type AiChatRequest,
  type AiTool,
} from '../../src/modules/ai/index.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { Database } from '../../src/shared/database/index.js';
import type { TenantTx } from '../../src/shared/database/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import * as auditModule from '../../src/shared/audit/index.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';

describe('AI Gateway Skeleton (Unit)', () => {
  const orgId = '01939a00-0000-7000-8000-000000000001';
  const studentOneId = '01939a00-0000-7000-8000-000000000002';
  const studentTwoId = '01939a00-0000-7000-8000-000000000003';

  const studentOneCtx = issueTrustedContext({
    tenantId: orgId,
    userId: studentOneId,
    actorKind: 'STUDENT',
  });

  const studentTwoCtx = issueTrustedContext({
    tenantId: orgId,
    userId: studentTwoId,
    actorKind: 'STUDENT',
  });

  const createMockDb = (mockTx?: Partial<TenantTx>): Database =>
    ({
      withTenant: vi.fn(async (_ctx, fn: (tx: TenantTx) => Promise<unknown>) => {
        const tx = (mockTx ?? { query: vi.fn().mockResolvedValue({ rows: [] }) }) as TenantTx;
        return fn(tx);
      }),
    }) as unknown as Database;

  describe('Static Tool Schema Guardrails (S-9)', () => {
    it('accepts compliant tools with strict additionalProperties: false and allowlisted tokens', () => {
      const compliantTool: AiTool = {
        name: 'get_my_status',
        description: 'Read own status',
        readOnly: true,
        parameters: Type.Object(
          {
            ref_no: Type.String(),
            confirm_token: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
        execute: () => Promise.resolve({ ok: true }),
      };

      expect(() => validateToolDefinition(compliantTool)).not.toThrow();
    });

    it('rejects tools that omit additionalProperties: false', () => {
      const nonStrictTool: AiTool = {
        name: 'loose_tool',
        description: 'Non-strict tool',
        readOnly: true,
        parameters: Type.Object({
          query: Type.String(),
        }),
        execute: () => Promise.resolve({ ok: true }),
      };

      expect(() => validateToolDefinition(nonStrictTool)).toThrow(
        /must define additionalProperties: false/,
      );
    });

    it('rejects tools with prohibited identity, tenant, or role properties', () => {
      const prohibitedProps = [
        'user_id',
        'student_id',
        'tenant_id',
        'organization_id',
        'org_id',
        'role',
        'permission',
        'scope',
        'employee_id',
        'email',
        'phone',
      ];

      for (const prop of prohibitedProps) {
        const badTool: AiTool = {
          name: `bad_tool_${prop}`,
          description: 'Tool with prohibited prop',
          readOnly: true,
          parameters: Type.Object(
            {
              [prop]: Type.String(),
            },
            { additionalProperties: false },
          ),
          execute: () => Promise.resolve({ ok: true }),
        };

        expect(() => validateToolDefinition(badTool)).toThrow(
          /defines prohibited property.*Identity, tenant, or role parameters are banned by S-9/,
        );
      }
    });

    it('rejects tools that attempt to list or search people', () => {
      const prohibitedNames = [
        'search_students',
        'list_users',
        'get_all_employees',
        'find_people',
        'search_accounts',
      ];

      for (const name of prohibitedNames) {
        const badTool: AiTool = {
          name,
          description: 'Lists people',
          readOnly: true,
          parameters: Type.Object({}, { additionalProperties: false }),
          execute: () => Promise.resolve({ ok: true }),
        };

        expect(() => validateToolDefinition(badTool)).toThrow(
          /tools that list or search people are prohibited/,
        );
      }
    });

    it('seeded Phase 1 tools pass all static S-9 schema validations', () => {
      expect(() => validateToolDefinition(GetMyNotificationsTool)).not.toThrow();
      expect(() => validateToolDefinition(GetMyDocumentsTool)).not.toThrow();
      expect(() => validateToolDefinition(SubmitServiceRequestTool)).not.toThrow();
    });
  });

  describe('Two-Phase Confirmation Tokens (ADR-013 & S-9)', () => {
    const confirmationService = new ConfirmationTokenService({
      secretKey: 'test-secret-key-123',
      ttlMs: 60_000,
    });

    it('generates a valid confirmation token bound to tenant, user, tool, and payload hash', () => {
      const payload = { ref_no: 'REF-2026-001' };
      const { confirmToken, expiresAt } = confirmationService.createToken(
        studentOneCtx,
        'submit_service_request',
        payload,
      );

      expect(confirmToken).toBeDefined();
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

      // Consuming with matching context and payload succeeds
      expect(() =>
        confirmationService.verifyAndConsumeToken(
          studentOneCtx,
          'submit_service_request',
          payload,
          confirmToken,
        ),
      ).not.toThrow();
    });

    it('rejects token reuse (single-use enforcement)', () => {
      const payload = { ref_no: 'REF-2026-002' };
      const { confirmToken } = confirmationService.createToken(
        studentOneCtx,
        'submit_service_request',
        payload,
      );

      // First use succeeds
      confirmationService.verifyAndConsumeToken(
        studentOneCtx,
        'submit_service_request',
        payload,
        confirmToken,
      );

      // Second use is rejected with 409
      expect(() =>
        confirmationService.verifyAndConsumeToken(
          studentOneCtx,
          'submit_service_request',
          payload,
          confirmToken,
        ),
      ).toThrow(
        new AppError(
          409,
          'CONFIRMATION_TOKEN_REUSED',
          'Confirmation token has already been consumed.',
        ),
      );
    });

    it('rejects token when user A token is used by user B (cross-user isolation)', () => {
      const payload = { ref_no: 'REF-2026-003' };
      const { confirmToken } = confirmationService.createToken(
        studentOneCtx,
        'submit_service_request',
        payload,
      );

      expect(() =>
        confirmationService.verifyAndConsumeToken(
          studentTwoCtx,
          'submit_service_request',
          payload,
          confirmToken,
        ),
      ).toThrow(
        new AppError(
          403,
          'CONFIRMATION_TOKEN_UNAUTHORIZED',
          'Confirmation token was not issued to the authenticated caller.',
        ),
      );
    });

    it('rejects token when action payload is tampered with', () => {
      const originalPayload = { ref_no: 'REF-ORIGINAL' };
      const { confirmToken } = confirmationService.createToken(
        studentOneCtx,
        'submit_service_request',
        originalPayload,
      );

      const tamperedPayload = { ref_no: 'REF-TAMPERED' };
      expect(() =>
        confirmationService.verifyAndConsumeToken(
          studentOneCtx,
          'submit_service_request',
          tamperedPayload,
          confirmToken,
        ),
      ).toThrow(
        new AppError(
          400,
          'CONFIRMATION_TOKEN_PAYLOAD_TAMPERED',
          'Confirmation token payload hash does not match current action arguments.',
        ),
      );
    });

    it('rejects expired confirmation token', () => {
      let currentTime = 1_000_000;
      const expiringService = new ConfirmationTokenService({
        secretKey: 'test-secret',
        ttlMs: 10_000,
        now: () => currentTime,
      });

      const payload = { ref_no: 'REF-EXPIRED' };
      const { confirmToken } = expiringService.createToken(
        studentOneCtx,
        'submit_service_request',
        payload,
      );

      // Advance time beyond TTL
      currentTime += 20_000;

      expect(() =>
        expiringService.verifyAndConsumeToken(
          studentOneCtx,
          'submit_service_request',
          payload,
          confirmToken,
        ),
      ).toThrow(new AppError(400, 'CONFIRMATION_TOKEN_EXPIRED', 'Confirmation token has expired.'));
    });
  });

  describe('AI Gateway Execution & Bounds', () => {
    it('fails closed with 503 when provider is disabled or unavailable', async () => {
      const mockDb = createMockDb();
      const authAssertSpy = vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

      const gateway = new AiGateway({
        db: mockDb,
        provider: new DisabledAiProvider(),
      });

      const request: AiChatRequest = {
        messages: [{ role: 'user', content: 'Hello assistant' }],
      };

      await expect(gateway.chat(studentOneCtx, request)).rejects.toThrow(
        new AppError(503, 'AI_PROVIDER_UNAVAILABLE', 'AI provider is disabled or unavailable.'),
      );
      expect(authAssertSpy).toHaveBeenCalled();
    });

    it('handles provider timeout safely with 504 AI_GATEWAY_TIMEOUT', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

      // Provider with 200ms delay, gateway timeout set to 50ms
      const slowProvider = new DeterministicAiProvider({ delayMs: 200 });
      const gateway = new AiGateway({
        db: mockDb,
        provider: slowProvider,
        timeoutMs: 50,
      });

      const request: AiChatRequest = {
        messages: [{ role: 'user', content: 'Trigger timeout' }],
      };

      await expect(gateway.chat(studentOneCtx, request)).rejects.toThrow(
        new AppError(504, 'AI_GATEWAY_TIMEOUT', 'AI request timed out.'),
      );
    });

    it('rejects malformed provider response with 502 AI_MALFORMED_RESPONSE', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

      const malformedProvider = new DeterministicAiProvider({
        handler: () =>
          // Missing message/usage fields
          ({}) as unknown as ReturnType<DeterministicAiProvider['chat']>,
      });

      const gateway = new AiGateway({
        db: mockDb,
        provider: malformedProvider,
      });

      const request: AiChatRequest = {
        messages: [{ role: 'user', content: 'Test malformed' }],
      };

      await expect(gateway.chat(studentOneCtx, request)).rejects.toThrow(
        new AppError(502, 'AI_MALFORMED_RESPONSE', 'Malformed response from AI provider.'),
      );
    });

    it('enforces maximum tool calls limit per turn', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

      // Provider proposing 6 tool calls (limit is 5)
      const excessiveProvider = new DeterministicAiProvider({
        cannedResponses: [
          {
            message: { role: 'assistant', content: 'Calling many tools' },
            finishReason: 'tool_calls',
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            toolCalls: Array.from({ length: 6 }, (_, i) => ({
              id: `call_${i}`,
              type: 'function',
              function: { name: 'get_my_notifications', arguments: '{}' },
            })),
          },
        ],
      });

      const gateway = new AiGateway({
        db: mockDb,
        provider: excessiveProvider,
      });

      const request: AiChatRequest = {
        messages: [{ role: 'user', content: 'Too many tools' }],
      };

      await expect(gateway.chat(studentOneCtx, request)).rejects.toThrow(
        new AppError(
          502,
          'AI_TOO_MANY_TOOL_CALLS',
          'Model proposed 6 tool calls, exceeding the maximum limit of 5.',
        ),
      );
    });

    it('enforces rate limiting and quota exhaustion for users and tenants', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
      vi.spyOn(auditModule, 'recordAudit').mockResolvedValue('audit-1');

      const userLimiter = new FixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 10 });
      const tenantLimiter = new FixedWindowLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10 });

      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
        userRateLimiter: userLimiter,
        tenantRateLimiter: tenantLimiter,
      });

      const request: AiChatRequest = {
        messages: [{ role: 'user', content: 'Rate test' }],
      };

      // Request 1 and 2 succeed
      await gateway.chat(studentOneCtx, request);
      await gateway.chat(studentOneCtx, request);

      // Request 3 hits user limit (limit = 2)
      await expect(gateway.chat(studentOneCtx, request)).rejects.toThrow(
        /User rate limit exceeded for AI gateway/,
      );
    });

    it('rejects invalid request schemas (exceeded message count, invalid role)', async () => {
      const mockDb = createMockDb();
      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
      });

      // Invalid role
      const invalidRoleRequest = {
        messages: [{ role: 'superadmin', content: 'Invalid' }],
      } as unknown as AiChatRequest;

      await expect(gateway.chat(studentOneCtx, invalidRoleRequest)).rejects.toThrow(
        new AppError(400, 'INVALID_REQUEST', 'AI chat request failed schema validation.'),
      );

      // Empty messages array
      const emptyRequest = {
        messages: [],
      } as unknown as AiChatRequest;

      await expect(gateway.chat(studentOneCtx, emptyRequest)).rejects.toThrow(
        new AppError(400, 'INVALID_REQUEST', 'AI chat request failed schema validation.'),
      );
    });

    it('executes chat completion and records audit with token metrics (no raw prompts in audit)', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
      const auditSpy = vi.spyOn(auditModule, 'recordAudit').mockResolvedValue('audit-ai-1');

      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
      });

      const secretText = 'user-confidential-prompt-data-not-to-be-logged';
      const request: AiChatRequest = {
        messages: [{ role: 'user', content: secretText }],
      };

      const response = await gateway.chat(studentOneCtx, request);
      expect(response.message.role).toBe('assistant');
      expect(response.finishReason).toBe('stop');
      expect(response.usage.totalTokens).toBeGreaterThan(0);

      // Verify audit was recorded
      expect(auditSpy).toHaveBeenCalledTimes(1);
      const auditCall = auditSpy.mock.calls[0]!;
      expect(auditCall[1]).toEqual(studentOneCtx);
      const auditEvent = auditCall[2];
      expect(auditEvent.action).toBe('ai.chat.complete');
      expect(auditEvent.resourceType).toBe('ai_conversation');
      expect(auditEvent.riskTier).toBe(1);
      const meta = auditEvent.metadata as Record<string, unknown>;
      expect(typeof meta.promptUnits).toBe('number');
      expect(typeof meta.completionUnits).toBe('number');
      expect(typeof meta.totalUnits).toBe('number');

      // Verify raw prompt was NOT passed to audit metadata
      expect(JSON.stringify(meta)).not.toContain(secretText);
    });
  });

  describe('Tool Execution Security (S-9 Dynamic)', () => {
    it('rejects tool call with adversarial parameters (extra keys, prohibited identity)', async () => {
      const mockDb = createMockDb();
      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
      });

      // Adversarial attempt trying to supply student_id or user_id
      const result = await gateway.executeTool(studentOneCtx, 'get_my_notifications', {
        unread_only: true,
        student_id: studentTwoId, // Adversarial injected parameter
      });

      expect(result.isError).toBe(true);
      const resObj = result.result as { error?: string };
      expect(resObj.error).toContain('strict matching parameters without prohibited identity keys');
    });

    it('rejects execution of unregistered tools', async () => {
      const mockDb = createMockDb();
      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
      });

      const result = await gateway.executeTool(studentOneCtx, 'unknown_malicious_tool', {});
      expect(result.isError).toBe(true);
      expect(result.result).toEqual({
        error: 'Tool "unknown_malicious_tool" is not registered.',
      });
    });

    it('prepareAction validates arguments and issues single-use confirmation token', async () => {
      const mockDb = createMockDb();
      vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

      const gateway = new AiGateway({
        db: mockDb,
        provider: new DeterministicAiProvider(),
      });

      const prepared = await gateway.prepareAction(studentOneCtx, 'submit_service_request', {
        ref_no: 'REQ-123',
      });

      expect(prepared.toolName).toBe('submit_service_request');
      expect(prepared.confirmToken).toBeDefined();

      // Submit execution with the issued confirmation token succeeds
      const result = await gateway.executeTool(studentOneCtx, 'submit_service_request', {
        ref_no: 'REQ-123',
        confirm_token: prepared.confirmToken,
      });

      expect(result.isError).toBe(false);
      expect(result.result).toEqual(
        expect.objectContaining({
          status: 'SUBMITTED',
          ref_no: 'REQ-123',
        }),
      );
    });
  });
});
