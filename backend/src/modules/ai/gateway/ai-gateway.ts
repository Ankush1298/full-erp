import { Value } from '@sinclair/typebox/value';
import { AppError } from '../../../shared/errors/http-errors.js';
import type { Database } from '../../../shared/database/index.js';
import type { TrustedContext } from '../../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../../shared/authorization/engine.js';
import { recordAudit } from '../../../shared/audit/index.js';
import { FixedWindowLimiter } from '../../../shared/http/fixed-window-limiter.js';
import {
  AI_MAX_TOOL_CALLS_PER_TURN,
  AiChatRequestSchema,
  type AiChatRequest,
  type AiChatResponse,
  type AiToolCall,
  type PrepareActionResponse,
  type ToolExecutionResult,
} from '../ai.schemas.js';
import type { AiProviderAdapter } from '../provider/ai-provider.js';
import { ConfirmationTokenService } from '../confirmation/confirmation-token.service.js';
import { type AiToolRegistry, createDefaultToolRegistry } from '../registry/tool-registry.js';

export interface AiGatewayOptions {
  db: Database;
  provider: AiProviderAdapter;
  toolRegistry?: AiToolRegistry;
  confirmationService?: ConfirmationTokenService;
  userRateLimiter?: FixedWindowLimiter;
  tenantRateLimiter?: FixedWindowLimiter;
  timeoutMs?: number;
}

export class AiGateway {
  private readonly db: Database;
  private readonly provider: AiProviderAdapter;
  private readonly tools: AiToolRegistry;
  private readonly confirmationService: ConfirmationTokenService;
  private readonly userRateLimiter: FixedWindowLimiter;
  private readonly tenantRateLimiter: FixedWindowLimiter;
  private readonly timeoutMs: number;

  constructor(options: AiGatewayOptions) {
    this.db = options.db;
    this.provider = options.provider;
    this.tools = options.toolRegistry ?? createDefaultToolRegistry();
    this.confirmationService = options.confirmationService ?? new ConfirmationTokenService();
    this.timeoutMs = options.timeoutMs ?? 10_000;

    // Rate limiters: 30 requests/min per user, 120 requests/min per tenant
    this.userRateLimiter =
      options.userRateLimiter ??
      new FixedWindowLimiter({ limit: 30, windowMs: 60_000, maxKeys: 10_000 });
    this.tenantRateLimiter =
      options.tenantRateLimiter ??
      new FixedWindowLimiter({ limit: 120, windowMs: 60_000, maxKeys: 1_000 });
  }

  get registry(): AiToolRegistry {
    return this.tools;
  }

  get confirmation(): ConfirmationTokenService {
    return this.confirmationService;
  }

  /**
   * Prepares a write action for the two-phase confirmation flow (ADR-013).
   * Validates tool existence, schema conformance, and generates a signed confirmation token.
   */
  async prepareAction(
    ctx: TrustedContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<PrepareActionResponse> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new AppError(404, 'TOOL_NOT_FOUND', `Tool "${toolName}" is not registered.`);
    }

    if (tool.readOnly) {
      throw new AppError(
        400,
        'TOOL_READ_ONLY',
        `Tool "${toolName}" is read-only and does not require two-phase confirmation.`,
      );
    }

    // Assert permission for the action
    if (tool.requiredPermission) {
      await this.db.withTenant(ctx, async (tx) => {
        await AuthorizationEngine.assert(tx, ctx, tool.requiredPermission!, {
          organization_id: ctx.tenantId,
          user_id: ctx.userId,
        });
      });
    }

    // Validate parameters (excluding confirm_token which is generated here)
    const { confirm_token: _unusedConfirmToken, ...argsToValidate } = args;
    void _unusedConfirmToken;
    const cleanArgs = { ...argsToValidate, confirm_token: 'dummy-token-for-validation' };
    if (!Value.Check(tool.parameters, cleanArgs)) {
      throw new AppError(
        400,
        'INVALID_TOOL_ARGUMENTS',
        `Invalid arguments for tool "${toolName}".`,
      );
    }

    const { confirmToken, expiresAt } = this.confirmationService.createToken(
      ctx,
      toolName,
      argsToValidate,
    );

    return {
      toolName,
      summary: `Prepared action "${toolName}" with supplied arguments. Confirm within 5 minutes.`,
      confirmToken,
      expiresAt,
    };
  }

  /**
   * Executes a registered tool securely inside a tenant database transaction.
   * Enforces tool-level permissions, strict argument validation, and audit recording.
   */
  async executeTool(
    ctx: TrustedContext,
    toolName: string,
    rawArgs: Record<string, unknown> | string,
    toolCallId = 'direct_call',
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        toolCallId,
        toolName,
        result: { error: `Tool "${toolName}" is not registered.` },
        isError: true,
      };
    }

    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs =
        typeof rawArgs === 'string' ? (JSON.parse(rawArgs) as Record<string, unknown>) : rawArgs;
    } catch {
      return {
        toolCallId,
        toolName,
        result: { error: 'Failed to parse tool arguments as JSON.' },
        isError: true,
      };
    }

    // Validate parameters against the strict schema
    if (!Value.Check(tool.parameters, parsedArgs)) {
      return {
        toolCallId,
        toolName,
        result: {
          error: `Arguments rejected: tool "${toolName}" expects strict matching parameters without prohibited identity keys.`,
        },
        isError: true,
      };
    }

    try {
      const result = await this.db.withTenant(ctx, async (tx) => {
        if (tool.requiredPermission) {
          await AuthorizationEngine.assert(tx, ctx, tool.requiredPermission, {
            organization_id: ctx.tenantId,
            user_id: ctx.userId,
          });
        }

        const out = await tool.execute(tx, ctx, parsedArgs, this.confirmationService);

        // Audit the tool execution inside the transaction
        await recordAudit(tx, ctx, {
          action: 'ai.tool.execute',
          resourceType: 'ai_tool',
          riskTier: tool.readOnly ? 1 : 2,
          metadata: {
            toolName: tool.name,
            readOnly: tool.readOnly,
          },
        });

        return out;
      });

      return {
        toolCallId,
        toolName,
        result,
        isError: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed.';
      return {
        toolCallId,
        toolName,
        result: { error: message },
        isError: true,
      };
    }
  }

  /**
   * Main entrypoint for chat completion through the gateway skeleton.
   * Performs validation, rate-limiting, authorization, provider dispatch, and tool execution.
   */
  async chat(ctx: TrustedContext, request: AiChatRequest): Promise<AiChatResponse> {
    // 1. Schema Validation
    if (!Value.Check(AiChatRequestSchema, request)) {
      throw new AppError(400, 'INVALID_REQUEST', 'AI chat request failed schema validation.');
    }

    // 2. Rate Limiting (User + Tenant)
    const userWait = this.userRateLimiter.take(`${ctx.tenantId}:${ctx.userId}`);
    if (userWait > 0) {
      throw new AppError(
        429,
        'TOO_MANY_REQUESTS',
        `User rate limit exceeded for AI gateway. Please retry after ${userWait} seconds.`,
      );
    }

    const tenantWait = this.tenantRateLimiter.take(ctx.tenantId);
    if (tenantWait > 0) {
      throw new AppError(
        429,
        'TENANT_QUOTA_EXCEEDED',
        `Tenant rate limit exceeded for AI gateway. Please retry after ${tenantWait} seconds.`,
      );
    }

    // 3. Authorization Assertion
    await this.db.withTenant(ctx, async (tx) => {
      await AuthorizationEngine.assert(tx, ctx, 'assistant.use', {
        organization_id: ctx.tenantId,
        user_id: ctx.userId,
      });
    });

    // 4. Provider Availability Check
    const available = await this.provider.isAvailable();
    if (!available) {
      throw new AppError(503, 'AI_PROVIDER_UNAVAILABLE', 'AI provider is disabled or unavailable.');
    }

    // 5. Build bounded tool definitions
    const allowedTools = request.tools
      ? request.tools
          .map((name) => this.tools.get(name))
          .filter((t): t is NonNullable<typeof t> => t !== undefined)
      : this.tools.listTools();

    const providerTools = allowedTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    // 6. Timeout & Execution
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let providerResponse;
    const startTime = Date.now();
    try {
      providerResponse = await this.provider.chat(
        {
          messages: request.messages,
          tools: providerTools,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
        },
        { signal: controller.signal },
      );
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AppError(504, 'AI_GATEWAY_TIMEOUT', 'AI request timed out.');
      }
      if (err instanceof AppError) throw err;
      throw new AppError(502, 'AI_PROVIDER_ERROR', 'AI provider encountered an error.');
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - startTime;

    // 7. Validate Provider Output
    const respMsg = providerResponse?.message as Record<string, unknown> | undefined;
    if (
      !providerResponse ||
      !respMsg ||
      typeof respMsg['role'] !== 'string' ||
      !providerResponse.usage
    ) {
      throw new AppError(502, 'AI_MALFORMED_RESPONSE', 'Malformed response from AI provider.');
    }

    // 8. Execute Tool Calls if proposed
    const proposedToolCalls = providerResponse.toolCalls ?? [];
    if (proposedToolCalls.length > 0) {
      if (proposedToolCalls.length > AI_MAX_TOOL_CALLS_PER_TURN) {
        throw new AppError(
          502,
          'AI_TOO_MANY_TOOL_CALLS',
          `Model proposed ${proposedToolCalls.length} tool calls, exceeding the maximum limit of ${AI_MAX_TOOL_CALLS_PER_TURN}.`,
        );
      }
    }

    // 9. Record Gateway Audit
    await this.db.withTenant(ctx, async (tx) => {
      await recordAudit(tx, ctx, {
        action: 'ai.chat.complete',
        resourceType: 'ai_conversation',
        riskTier: 1,
        metadata: {
          promptUnits: providerResponse.usage.promptTokens,
          completionUnits: providerResponse.usage.completionTokens,
          totalUnits: providerResponse.usage.totalTokens,
          durationMs,
          finishReason: providerResponse.finishReason,
          toolCallsCount: proposedToolCalls.length,
        },
      });
    });

    const result: AiChatResponse = {
      message: providerResponse.message,
      finishReason: providerResponse.finishReason,
      usage: providerResponse.usage,
    };
    if (proposedToolCalls.length > 0) {
      result.toolCalls = proposedToolCalls as AiToolCall[];
    }
    return result;
  }
}
