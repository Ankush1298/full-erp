import { z } from 'zod';

export const PaymentGatewayProviderSchema = z.enum(['RAZORPAY', 'CASHFREE', 'PHONEPE']);
export const GatewayModeSchema = z.enum(['SANDBOX', 'LIVE']);

export const SaveGatewayConfigSchema = z.object({
  campus_id: z.string().uuid().optional(),
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema.default('SANDBOX'),
  is_active: z.boolean().default(false),
  merchant_key: z.string().trim().min(1, 'Merchant / Client ID is required').max(128),
  secret_key: z.string().trim().min(1, 'Secret Key is required').max(256),
  webhook_secret: z.string().trim().max(256).optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export const TestGatewayConnectionSchema = z.object({
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema.default('SANDBOX'),
  merchant_key: z.string().trim().min(1).max(128),
  secret_key: z.string().trim().min(1).max(256),
  webhook_secret: z.string().trim().max(256).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const InitiateOnlinePaymentSchema = z.object({
  campus_id: z.string().uuid().optional(),
  student_id: z.string().uuid(),
  student_due_id: z.string().uuid().optional(),
  due_ids: z.array(z.string().uuid()).optional(),
  amount: z
    .number()
    .int()
    .positive('Payment amount must be a positive integer in minor units (paise)')
    .optional(),
  description: z.string().trim().max(200).optional(),
  return_url: z.string().url().optional(),
  notify_url: z.string().url().optional(),
});

export const VerifyOnlinePaymentSchema = z.object({
  attempt_reference: z.string().trim().min(3).max(64),
  order_reference: z.string().trim().optional(),
  gateway_payment_ref: z.string().trim().optional(),
  gateway_signature: z.string().trim().optional(),
  raw_payload: z.record(z.string(), z.unknown()).optional(),
});

export const InitiateRefundSchema = z.object({
  receipt_id: z.string().uuid(),
  amount: z.number().int().positive('Refund amount must be positive minor units'),
  reason: z.string().trim().min(3, 'Reason must be at least 3 characters').max(500),
});

export const PaymentAttemptStatusSchema = z.enum([
  'INITIATED',
  'PENDING',
  'SUCCESS',
  'FAILED',
  'USER_DROPPED',
  'EXPIRED',
]);

export const ListPaymentAttemptsQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  student_id: z.string().uuid().optional(),
  status: PaymentAttemptStatusSchema.optional(),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const ReconciliationQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  provider: PaymentGatewayProviderSchema.optional(),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type SaveGatewayConfigInput = z.infer<typeof SaveGatewayConfigSchema>;
export type TestGatewayConnectionInput = z.infer<typeof TestGatewayConnectionSchema>;
export type InitiateOnlinePaymentInput = z.infer<typeof InitiateOnlinePaymentSchema>;
export type VerifyOnlinePaymentInput = z.infer<typeof VerifyOnlinePaymentSchema>;
export type InitiateRefundInput = z.infer<typeof InitiateRefundSchema>;
export type ListPaymentAttemptsQuery = z.infer<typeof ListPaymentAttemptsQuerySchema>;
export type ReconciliationQuery = z.infer<typeof ReconciliationQuerySchema>;
