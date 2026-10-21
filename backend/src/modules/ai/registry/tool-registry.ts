import { Type, type TSchema } from '@sinclair/typebox';
import { AppError } from '../../../shared/errors/http-errors.js';
import type { TenantTx } from '../../../shared/database/index.js';
import type { TrustedContext } from '../../../shared/tenancy/trusted-context.js';
import type { ConfirmationTokenService } from '../confirmation/confirmation-token.service.js';

export const ALLOWLISTED_REFERENCE_TOKENS = new Set([
  'ref_no',
  'ticket_no',
  'course_ref',
  'confirm_token',
]);

export const PROHIBITED_PARAM_PATTERN =
  /(^|_)(id|ids|email|phone|tenant|org|organization|role|permission|scope|user|student|employee)(_|$)/i;

export const PROHIBITED_TOOL_NAMES_PATTERN =
  /(list|search|get_all|find)_(people|students|users|employees|accounts)/i;

export interface AiTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly readOnly: boolean;
  readonly requiresConfirmation?: boolean;
  readonly requiredPermission?: string;
  execute(
    tx: TenantTx,
    ctx: TrustedContext,
    args: Record<string, unknown>,
    confirmationService?: ConfirmationTokenService,
  ): Promise<unknown>;
}

/**
 * Validates tool schemas against static S-9 security requirements at registration time.
 */
export function validateToolDefinition(tool: AiTool): void {
  if (PROHIBITED_TOOL_NAMES_PATTERN.test(tool.name)) {
    throw new AppError(
      500,
      'TOOL_SCHEMA_VIOLATION',
      `Tool "${tool.name}" violates S-9 policy: tools that list or search people are prohibited.`,
    );
  }

  const schema = tool.parameters as Record<string, unknown>;
  if (schema.additionalProperties !== false) {
    throw new AppError(
      500,
      'TOOL_SCHEMA_VIOLATION',
      `Tool "${tool.name}" must define additionalProperties: false (strict schema required).`,
    );
  }

  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  for (const propName of Object.keys(properties)) {
    if (ALLOWLISTED_REFERENCE_TOKENS.has(propName)) {
      continue;
    }
    if (PROHIBITED_PARAM_PATTERN.test(propName)) {
      throw new AppError(
        500,
        'TOOL_SCHEMA_VIOLATION',
        `Tool "${tool.name}" defines prohibited property "${propName}". Identity, tenant, or role parameters are banned by S-9.`,
      );
    }
  }
}

export class AiToolRegistry {
  private readonly tools = new Map<string, AiTool>();

  register(tool: AiTool): void {
    validateToolDefinition(tool);
    if (this.tools.has(tool.name)) {
      throw new AppError(500, 'TOOL_ALREADY_EXISTS', `Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AiTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listTools(): readonly AiTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}

// =================================================================================================
// Standard Phase 1 / Milestone 1 Real Tools (S-9: registry + gateway with two real tools)
// =================================================================================================

/**
 * Tool 1: get_my_notifications (Doc 03 §10.2 Row 22)
 * Read-only retrieval of the caller's own in-app notifications.
 */
export const GetMyNotificationsTool: AiTool = {
  name: 'get_my_notifications',
  description: 'Retrieve recent in-app notifications for the authenticated user.',
  readOnly: true,
  requiredPermission: 'assistant.use',
  parameters: Type.Object(
    {
      unread_only: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  async execute(
    tx: TenantTx,
    ctx: TrustedContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const unreadOnly = Boolean(args.unread_only);
    const sql = unreadOnly
      ? `SELECT id, category, title, body, action_url, created_at, read_at
           FROM app.notifications
          WHERE organization_id = $1 AND recipient_user_id = $2 AND read_at IS NULL
          ORDER BY created_at DESC LIMIT 10`
      : `SELECT id, category, title, body, action_url, created_at, read_at
           FROM app.notifications
          WHERE organization_id = $1 AND recipient_user_id = $2
          ORDER BY created_at DESC LIMIT 10`;

    const result = await tx.query<{
      id: string;
      category: string;
      title: string;
      body: string;
      action_url: string | null;
      created_at: Date;
      read_at: Date | null;
    }>(sql, [ctx.tenantId, ctx.userId]);

    return result.rows.map((row) => ({
      id: row.id,
      category: row.category,
      title: row.title,
      body: row.body,
      actionUrl: row.action_url,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at?.toISOString() ?? null,
    }));
  },
};

/**
 * Tool 2: get_my_documents (Doc 03 §10.2 Row 23)
 * Read-only retrieval of document metadata owned by the caller.
 */
export const GetMyDocumentsTool: AiTool = {
  name: 'get_my_documents',
  description: 'Retrieve document records and metadata owned by the authenticated user.',
  readOnly: true,
  requiredPermission: 'assistant.use',
  parameters: Type.Object(
    {
      mime_type: Type.Optional(Type.String({ maxLength: 100 })),
    },
    { additionalProperties: false },
  ),
  async execute(
    tx: TenantTx,
    ctx: TrustedContext,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const mimeType = args.mime_type as string | undefined;
    const sql = mimeType
      ? `SELECT id, original_name, size_bytes, COALESCE(detected_mime, declared_mime) AS mime_type, classification, status, created_at
           FROM app.files
          WHERE organization_id = $1 AND uploaded_by = $2 AND (detected_mime = $3 OR declared_mime = $3)
          ORDER BY created_at DESC LIMIT 10`
      : `SELECT id, original_name, size_bytes, COALESCE(detected_mime, declared_mime) AS mime_type, classification, status, created_at
           FROM app.files
          WHERE organization_id = $1 AND uploaded_by = $2
          ORDER BY created_at DESC LIMIT 10`;

    const params = mimeType ? [ctx.tenantId, ctx.userId, mimeType] : [ctx.tenantId, ctx.userId];

    const result = await tx.query<{
      id: string;
      original_name: string;
      size_bytes: string | number | null;
      mime_type: string | null;
      classification: string;
      status: string;
      created_at: Date;
    }>(sql, params);

    return result.rows.map((row) => ({
      id: row.id,
      fileName: row.original_name,
      fileSizeBytes: row.size_bytes ? Number(row.size_bytes) : null,
      mimeType: row.mime_type,
      classification: row.classification,
      scanStatus: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  },
};

/**
 * Tool 3: submit_service_request (Doc 03 §10.2 Row 12)
 * Demonstrates two-phase write execution requiring a valid confirmation token.
 */
export const SubmitServiceRequestTool: AiTool = {
  name: 'submit_service_request',
  description: 'Submit a verified request after explicit UI confirmation.',
  readOnly: false,
  requiresConfirmation: true,
  requiredPermission: 'assistant.use',
  parameters: Type.Object(
    {
      ref_no: Type.String({ minLength: 1, maxLength: 64 }),
      confirm_token: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  execute(
    _tx: TenantTx,
    ctx: TrustedContext,
    args: Record<string, unknown>,
    confirmationService?: ConfirmationTokenService,
  ): Promise<unknown> {
    const confirmToken = args.confirm_token as string;
    const refNo = args.ref_no as string;

    if (!confirmationService) {
      throw new AppError(
        500,
        'CONFIRMATION_SERVICE_UNAVAILABLE',
        'Confirmation service is required.',
      );
    }

    // Verify token against payload without confirm_token
    const payloadToVerify = { ref_no: refNo };
    confirmationService.verifyAndConsumeToken(
      ctx,
      'submit_service_request',
      payloadToVerify,
      confirmToken,
    );

    return Promise.resolve({
      status: 'SUBMITTED',
      ref_no: refNo,
      submittedAt: new Date().toISOString(),
    });
  },
};

/**
 * Creates a default tool registry seeded with the standard Phase 1 tools.
 */
export function createDefaultToolRegistry(): AiToolRegistry {
  const registry = new AiToolRegistry();
  registry.register(GetMyNotificationsTool);
  registry.register(GetMyDocumentsTool);
  registry.register(SubmitServiceRequestTool);
  return registry;
}
