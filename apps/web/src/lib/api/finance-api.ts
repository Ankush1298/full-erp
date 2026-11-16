import { z } from 'zod';
import type { ApiClient } from './client';

export const PaymentMethodSchema = z.enum([
  'CASH',
  'CHEQUE',
  'BANK_TRANSFER',
  'UPI_REFERENCE',
  'OTHER_OFFLINE',
  'ONLINE_RAZORPAY',
  'ONLINE_CASHFREE',
  'ONLINE_PHONEPE',
  'ONLINE_GATEWAY',
]);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const ReconciliationStatusSchema = z.enum(['RECORDED', 'PENDING_VERIFICATION', 'CONFIRMED']);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const DueStatusSchema = z.enum(['PENDING', 'PARTIAL', 'PAID', 'CANCELLED', 'WAIVED']);
export type DueStatus = z.infer<typeof DueStatusSchema>;

export const FeeCategoryDtoSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  is_active: z.boolean().optional().default(true),
  version: z.number().optional().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type FeeCategoryDto = z.infer<typeof FeeCategoryDtoSchema>;

export const FeeStructureComponentDtoSchema = z.object({
  id: z.string(),
  fee_category_id: z.string(),
  category_code: z.string().optional(),
  category_name: z.string().optional(),
  amount: z.number(),
  description: z.string().nullable().optional(),
});
export type FeeStructureComponentDto = z.infer<typeof FeeStructureComponentDtoSchema>;

export const FeeStructureDtoSchema = z.object({
  id: z.string(),
  campus_id: z.string(),
  academic_year_id: z.string(),
  term_id: z.string().nullable().optional(),
  program_id: z.string().nullable().optional(),
  code: z.string(),
  name: z.string(),
  currency: z.string().default('INR'),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  due_date: z.string(),
  total_amount: z.number(),
  created_by_user_id: z.string().optional(),
  version: z.number().optional().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  components: z.array(FeeStructureComponentDtoSchema).default([]),
});
export type FeeStructureDto = z.infer<typeof FeeStructureDtoSchema>;

export const StudentDueDtoSchema = z.object({
  id: z.string(),
  campus_id: z.string(),
  student_id: z.string(),
  student_name: z.string().optional(),
  admission_number: z.string().optional(),
  fee_structure_id: z.string(),
  fee_structure_name: z.string().optional(),
  academic_year_id: z.string(),
  term_id: z.string().nullable().optional(),
  due_number: z.string(),
  gross_amount: z.number(),
  discount_amount: z.number(),
  net_amount: z.number(),
  paid_amount: z.number(),
  balance_amount: z.number(),
  status: DueStatusSchema,
  due_date: z.string(),
  concession_reason: z.string().nullable().optional(),
  version: z.number().optional().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type StudentDueDto = z.infer<typeof StudentDueDtoSchema>;

export const FeeReceiptAllocationDtoSchema = z.object({
  id: z.string(),
  student_due_id: z.string(),
  due_number: z.string().optional(),
  allocated_amount: z.number(),
});
export type FeeReceiptAllocationDto = z.infer<typeof FeeReceiptAllocationDtoSchema>;

export const FeeReceiptDtoSchema = z.object({
  id: z.string(),
  campus_id: z.string(),
  student_id: z.string(),
  student_name: z.string().optional(),
  admission_number: z.string().optional(),
  receipt_number: z.string(),
  payment_date: z.string(),
  payment_method: PaymentMethodSchema,
  amount: z.number(),
  currency: z.string().default('INR'),
  reference_number: z.string().nullable().optional(),
  reconciliation_status: ReconciliationStatusSchema,
  status: z.enum(['POSTED', 'REVERSED']),
  received_by_user_id: z.string().optional(),
  received_by_name: z.string().optional(),
  remarks: z.string().nullable().optional(),
  reversal_reason: z.string().nullable().optional(),
  reversed_at: z.string().nullable().optional(),
  reversed_by_user_id: z.string().nullable().optional(),
  version: z.number().optional().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  allocations: z.array(FeeReceiptAllocationDtoSchema).default([]),
});
export type FeeReceiptDto = z.infer<typeof FeeReceiptDtoSchema>;

export const StudentLedgerDtoSchema = z.object({
  student_id: z.string(),
  student_name: z.string(),
  admission_number: z.string(),
  campus_name: z.string().optional().default(''),
  total_gross: z.number(),
  total_discount: z.number(),
  total_net: z.number(),
  total_paid: z.number(),
  total_balance: z.number(),
  currency: z.string().default('INR'),
  dues: z.array(StudentDueDtoSchema),
  receipts: z.array(FeeReceiptDtoSchema),
});
export type StudentLedgerDto = z.infer<typeof StudentLedgerDtoSchema>;

export const CollectionSummaryDtoSchema = z.object({
  total_collected: z.number(),
  currency: z.string().default('INR'),
  receipt_count: z.number(),
  reversed_count: z.number(),
  by_payment_method: z.record(z.string(), z.number()),
  by_reconciliation_status: z.record(z.string(), z.number()),
});
export type CollectionSummaryDto = z.infer<typeof CollectionSummaryDtoSchema>;

// Input Types
export interface CreateFeeCategoryInput {
  code: string;
  name: string;
  description?: string | undefined;
}

export interface CreateFeeStructureInput {
  campus_id: string;
  academic_year_id: string;
  term_id?: string | undefined;
  program_id?: string | undefined;
  code: string;
  name: string;
  currency?: string | undefined;
  due_date: string;
  components: Array<{
    fee_category_id: string;
    amount: number;
    description?: string | undefined;
  }>;
}

export interface GenerateStudentDuesInput {
  fee_structure_id: string;
  student_ids?: string[] | undefined;
  concessions?:
    | Array<{
        student_id: string;
        discount_amount: number;
        reason: string;
      }>
    | undefined;
}

export interface RecordOfflineReceiptInput {
  campus_id: string;
  student_id: string;
  payment_date: string;
  payment_method: PaymentMethod;
  amount: number;
  currency?: string | undefined;
  reference_number?: string | undefined;
  reconciliation_status?: ReconciliationStatus | undefined;
  allocations?:
    | Array<{
        student_due_id: string;
        amount: number;
      }>
    | undefined;
  remarks?: string | undefined;
  idempotency_key?: string | undefined;
}

export interface ReverseReceiptInput {
  reason: string;
}

// API Functions
export async function fetchFeeCategories(c: ApiClient): Promise<FeeCategoryDto[]> {
  const res = await c.get('/v1/finance/categories', {
    schema: z.object({ data: z.array(FeeCategoryDtoSchema) }),
  });
  return res.data;
}

export async function createFeeCategory(
  c: ApiClient,
  body: CreateFeeCategoryInput,
): Promise<FeeCategoryDto> {
  const res = await c.post('/v1/finance/categories', {
    schema: z.object({ data: FeeCategoryDtoSchema }),
    body,
  });
  return res.data;
}

export async function fetchFeeStructures(
  c: ApiClient,
  query?: { campus_id?: string; academic_year_id?: string; term_id?: string },
): Promise<FeeStructureDto[]> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.academic_year_id) params.set('academic_year_id', query.academic_year_id);
  if (query?.term_id) params.set('term_id', query.term_id);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/structures${q}`, {
    schema: z.object({ data: z.array(FeeStructureDtoSchema) }),
  });
  return res.data;
}

export async function createFeeStructure(
  c: ApiClient,
  body: CreateFeeStructureInput,
): Promise<FeeStructureDto> {
  const res = await c.post('/v1/finance/structures', {
    schema: z.object({ data: FeeStructureDtoSchema }),
    body,
  });
  return res.data;
}

export async function generateStudentDues(
  c: ApiClient,
  body: GenerateStudentDuesInput,
): Promise<{
  fee_structure_id: string;
  generated_count: number;
  skipped_count: number;
  dues: StudentDueDto[];
}> {
  const res = await c.post('/v1/finance/dues/generate', {
    schema: z.object({
      data: z.object({
        fee_structure_id: z.string(),
        generated_count: z.number(),
        skipped_count: z.number(),
        dues: z.array(StudentDueDtoSchema),
      }),
    }),
    body,
  });
  return res.data;
}

export async function fetchStudentDues(
  c: ApiClient,
  query?: {
    campus_id?: string;
    academic_year_id?: string;
    term_id?: string;
    student_id?: string;
    status?: string;
  },
): Promise<StudentDueDto[]> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.academic_year_id) params.set('academic_year_id', query.academic_year_id);
  if (query?.term_id) params.set('term_id', query.term_id);
  if (query?.student_id) params.set('student_id', query.student_id);
  if (query?.status) params.set('status', query.status);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/dues${q}`, {
    schema: z.object({ data: z.array(StudentDueDtoSchema) }),
  });
  return res.data;
}

export async function fetchStudentLedger(
  c: ApiClient,
  studentId: string,
): Promise<StudentLedgerDto> {
  const res = await c.get(`/v1/finance/students/${encodeURIComponent(studentId)}/ledger`, {
    schema: z.object({ data: StudentLedgerDtoSchema }),
  });
  return res.data;
}

export async function recordOfflineReceipt(
  c: ApiClient,
  body: RecordOfflineReceiptInput,
): Promise<FeeReceiptDto> {
  const res = await c.post('/v1/finance/receipts', {
    schema: z.object({ data: FeeReceiptDtoSchema }),
    body,
  });
  return res.data;
}

export async function fetchFeeReceipts(
  c: ApiClient,
  query?: {
    campus_id?: string;
    student_id?: string;
    payment_method?: string;
    status?: string;
    from_date?: string;
    to_date?: string;
  },
): Promise<FeeReceiptDto[]> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.student_id) params.set('student_id', query.student_id);
  if (query?.payment_method) params.set('payment_method', query.payment_method);
  if (query?.status) params.set('status', query.status);
  if (query?.from_date) params.set('from_date', query.from_date);
  if (query?.to_date) params.set('to_date', query.to_date);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/receipts${q}`, {
    schema: z.object({ data: z.array(FeeReceiptDtoSchema) }),
  });
  return res.data;
}

export async function fetchReceiptDetails(c: ApiClient, id: string): Promise<FeeReceiptDto> {
  const res = await c.get(`/v1/finance/receipts/${encodeURIComponent(id)}`, {
    schema: z.object({ data: FeeReceiptDtoSchema }),
  });
  return res.data;
}

export async function reverseReceipt(
  c: ApiClient,
  id: string,
  body: ReverseReceiptInput,
): Promise<FeeReceiptDto> {
  const res = await c.post(`/v1/finance/receipts/${encodeURIComponent(id)}/reverse`, {
    schema: z.object({ data: FeeReceiptDtoSchema }),
    body,
  });
  return res.data;
}

export async function fetchCollectionSummary(
  c: ApiClient,
  query?: { campus_id?: string; from_date?: string; to_date?: string },
): Promise<CollectionSummaryDto> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.from_date) params.set('from_date', query.from_date);
  if (query?.to_date) params.set('to_date', query.to_date);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/reports/collection-summary${q}`, {
    schema: z.object({ data: CollectionSummaryDtoSchema }),
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// Payment Gateway Configuration & Online Payments
// ---------------------------------------------------------------------------

export const PaymentGatewayProviderSchema = z.enum(['RAZORPAY', 'CASHFREE', 'PHONEPE']);
export type PaymentGatewayProvider = z.infer<typeof PaymentGatewayProviderSchema>;

export const GatewayModeSchema = z.enum(['SANDBOX', 'LIVE']);
export type GatewayMode = z.infer<typeof GatewayModeSchema>;

export const GatewayConfigDtoSchema = z.object({
  id: z.string(),
  campus_id: z.string().nullable().optional(),
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema,
  is_active: z.boolean(),
  merchant_key_masked: z.string(),
  has_secret_key: z.boolean(),
  has_webhook_secret: z.boolean(),
  settings: z.record(z.string(), z.unknown()).default({}),
  version: z.number().default(1),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type GatewayConfigDto = z.infer<typeof GatewayConfigDtoSchema>;

export const SaveGatewayConfigInputSchema = z.object({
  campus_id: z.string().optional(),
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema.default('SANDBOX'),
  is_active: z.boolean().default(false),
  merchant_key: z.string().min(1),
  secret_key: z.string().min(1),
  webhook_secret: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type SaveGatewayConfigInput = z.infer<typeof SaveGatewayConfigInputSchema>;

export const TestGatewayConnectionInputSchema = z.object({
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema.default('SANDBOX'),
  merchant_key: z.string().min(1),
  secret_key: z.string().min(1),
  webhook_secret: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type TestGatewayConnectionInput = z.infer<typeof TestGatewayConnectionInputSchema>;

export const PaymentAttemptDtoSchema = z.object({
  id: z.string(),
  campus_id: z.string(),
  student_id: z.string(),
  student_name: z.string().optional(),
  admission_number: z.string().optional(),
  student_due_id: z.string().nullable().optional(),
  gateway_config_id: z.string(),
  provider: PaymentGatewayProviderSchema,
  mode: GatewayModeSchema,
  attempt_reference: z.string(),
  order_reference: z.string().nullable().optional(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'USER_DROPPED', 'EXPIRED']),
  gateway_payment_ref: z.string().nullable().optional(),
  failure_reason: z.string().nullable().optional(),
  receipt_id: z.string().nullable().optional(),
  metadata_json: z.record(z.string(), z.unknown()).default({}),
  initiated_by_user_id: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type PaymentAttemptDto = z.infer<typeof PaymentAttemptDtoSchema>;

export const InitiatePaymentResultSchema = z.object({
  attempt_id: z.string(),
  attempt_reference: z.string(),
  order_reference: z.string(),
  provider: PaymentGatewayProviderSchema,
  amount: z.number(),
  currency: z.string(),
  checkout_payload: z.record(z.string(), z.unknown()),
  redirect_url: z.string().optional(),
});
export type InitiatePaymentResult = z.infer<typeof InitiatePaymentResultSchema>;

export const VerifyPaymentResultSchema = z.object({
  success: z.boolean(),
  status: z.string(),
  receipt_id: z.string().optional(),
  receipt_number: z.string().optional(),
  attempt_reference: z.string(),
  amount: z.number(),
  failure_reason: z.string().optional(),
});
export type VerifyPaymentResult = z.infer<typeof VerifyPaymentResultSchema>;

export const ReconciliationReportDtoSchema = z.object({
  total_online_attempts: z.number(),
  total_successful_online_amount: z.number(),
  total_successful_online_count: z.number(),
  total_failed_online_count: z.number(),
  total_offline_receipt_amount: z.number(),
  total_offline_receipt_count: z.number(),
  mismatches: z.array(
    z.object({
      attempt_reference: z.string(),
      order_reference: z.string().nullable(),
      provider: z.string(),
      attempt_status: z.string(),
      attempt_amount: z.number(),
      receipt_id: z.string().nullable(),
      issue: z.string(),
    }),
  ),
});
export type ReconciliationReportDto = z.infer<typeof ReconciliationReportDtoSchema>;

export async function fetchGatewayConfigs(c: ApiClient): Promise<GatewayConfigDto[]> {
  const res = await c.get('/v1/finance/gateway/config', {
    schema: z.object({ data: z.array(GatewayConfigDtoSchema) }),
  });
  return res.data;
}

export async function saveGatewayConfig(
  c: ApiClient,
  input: SaveGatewayConfigInput,
): Promise<GatewayConfigDto> {
  const res = await c.post('/v1/finance/gateway/config', {
    schema: z.object({ data: GatewayConfigDtoSchema }),
    body: input,
  });
  return res.data;
}

export async function testGatewayConnection(
  c: ApiClient,
  input: TestGatewayConnectionInput,
): Promise<{ healthy: boolean; message: string; details?: Record<string, unknown> | undefined }> {
  const res = await c.post('/v1/finance/gateway/test', {
    schema: z.object({
      data: z.object({
        healthy: z.boolean(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
    body: input,
  });
  return res.data;
}

export async function initiateOnlinePayment(
  c: ApiClient,
  input: {
    student_id: string;
    student_due_id?: string;
    due_ids?: string[];
    amount?: number;
    campus_id?: string;
    description?: string;
    return_url?: string;
  },
): Promise<InitiatePaymentResult> {
  const res = await c.post('/v1/finance/payments/initiate', {
    schema: z.object({ data: InitiatePaymentResultSchema }),
    body: input,
  });
  return res.data;
}

export async function verifyOnlinePayment(
  c: ApiClient,
  input: {
    attempt_reference: string;
    order_reference?: string;
    gateway_payment_ref?: string;
    gateway_signature?: string;
    raw_payload?: Record<string, unknown>;
  },
): Promise<VerifyPaymentResult> {
  const res = await c.post('/v1/finance/payments/verify', {
    schema: z.object({ data: VerifyPaymentResultSchema }),
    body: input,
  });
  return res.data;
}

export async function fetchPaymentAttempts(
  c: ApiClient,
  query?: {
    campus_id?: string;
    student_id?: string;
    status?: string;
    from_date?: string;
    to_date?: string;
  },
): Promise<PaymentAttemptDto[]> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.student_id) params.set('student_id', query.student_id);
  if (query?.status) params.set('status', query.status);
  if (query?.from_date) params.set('from_date', query.from_date);
  if (query?.to_date) params.set('to_date', query.to_date);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/payments/attempts${q}`, {
    schema: z.object({ data: z.array(PaymentAttemptDtoSchema) }),
  });
  return res.data;
}

export async function refundPayment(
  c: ApiClient,
  receiptId: string,
  body: { amount: number; reason: string },
): Promise<{ refund_id: string; gateway_refund_ref: string; status: string; amount: number }> {
  const res = await c.post(`/v1/finance/receipts/${encodeURIComponent(receiptId)}/refund`, {
    schema: z.object({
      data: z.object({
        refund_id: z.string(),
        gateway_refund_ref: z.string(),
        status: z.string(),
        amount: z.number(),
      }),
    }),
    body,
  });
  return res.data;
}

export async function fetchReconciliationReport(
  c: ApiClient,
  query?: { campus_id?: string; provider?: string; from_date?: string; to_date?: string },
): Promise<ReconciliationReportDto> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.provider) params.set('provider', query.provider);
  if (query?.from_date) params.set('from_date', query.from_date);
  if (query?.to_date) params.set('to_date', query.to_date);
  const q = params.toString() ? `?${params.toString()}` : '';

  const res = await c.get(`/v1/finance/reports/reconciliation${q}`, {
    schema: z.object({ data: ReconciliationReportDtoSchema }),
  });
  return res.data;
}
