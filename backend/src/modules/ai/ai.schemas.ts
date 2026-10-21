import { Type, type Static } from '@sinclair/typebox';

export const AI_MAX_MESSAGES = 50;
export const AI_MAX_CONTENT_CHARS = 16_384;
export const AI_MAX_TOKENS_LIMIT = 4_096;
export const AI_DEFAULT_MAX_TOKENS = 1_024;
export const AI_MAX_TOOL_CALLS_PER_TURN = 5;

export const AiRoleSchema = Type.Union([
  Type.Literal('system'),
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('tool'),
]);
export type AiRole = Static<typeof AiRoleSchema>;

export const AiToolCallFunctionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    arguments: Type.String({ maxLength: 16_384 }),
  },
  { additionalProperties: false },
);

export const AiToolCallSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    type: Type.Literal('function'),
    function: AiToolCallFunctionSchema,
  },
  { additionalProperties: false },
);
export type AiToolCall = Static<typeof AiToolCallSchema>;

export const AiMessageSchema = Type.Object(
  {
    role: AiRoleSchema,
    content: Type.String({ maxLength: AI_MAX_CONTENT_CHARS }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    toolCalls: Type.Optional(
      Type.Array(AiToolCallSchema, { maxItems: AI_MAX_TOOL_CALLS_PER_TURN }),
    ),
  },
  { additionalProperties: false },
);
export type AiMessage = Static<typeof AiMessageSchema>;

export const AiChatRequestSchema = Type.Object(
  {
    messages: Type.Array(AiMessageSchema, { minItems: 1, maxItems: AI_MAX_MESSAGES }),
    tools: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 20 }),
    ),
    maxTokens: Type.Optional(
      Type.Integer({ minimum: 1, maximum: AI_MAX_TOKENS_LIMIT, default: AI_DEFAULT_MAX_TOKENS }),
    ),
    temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2, default: 0.7 })),
  },
  { additionalProperties: false },
);
export type AiChatRequest = Static<typeof AiChatRequestSchema>;

export const AiUsageSchema = Type.Object(
  {
    promptTokens: Type.Integer({ minimum: 0 }),
    completionTokens: Type.Integer({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type AiUsage = Static<typeof AiUsageSchema>;

export const AiFinishReasonSchema = Type.Union([
  Type.Literal('stop'),
  Type.Literal('length'),
  Type.Literal('tool_calls'),
  Type.Literal('error'),
]);
export type AiFinishReason = Static<typeof AiFinishReasonSchema>;

export const AiChatResponseSchema = Type.Object(
  {
    message: AiMessageSchema,
    finishReason: AiFinishReasonSchema,
    usage: AiUsageSchema,
    toolCalls: Type.Optional(Type.Array(AiToolCallSchema)),
  },
  { additionalProperties: false },
);
export type AiChatResponse = Static<typeof AiChatResponseSchema>;

export const ToolExecutionResultSchema = Type.Object(
  {
    toolCallId: Type.String(),
    toolName: Type.String(),
    result: Type.Unknown(),
    isError: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ToolExecutionResult = Static<typeof ToolExecutionResultSchema>;

export const PrepareActionRequestSchema = Type.Object(
  {
    toolName: Type.String({ minLength: 1, maxLength: 64 }),
    args: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type PrepareActionRequest = Static<typeof PrepareActionRequestSchema>;

export const PrepareActionResponseSchema = Type.Object(
  {
    toolName: Type.String(),
    summary: Type.String(),
    confirmToken: Type.String(),
    expiresAt: Type.String(),
  },
  { additionalProperties: false },
);
export type PrepareActionResponse = Static<typeof PrepareActionResponseSchema>;

export const ConfirmActionRequestSchema = Type.Object(
  {
    confirmToken: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ConfirmActionRequest = Static<typeof ConfirmActionRequestSchema>;
