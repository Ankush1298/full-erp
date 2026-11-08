import { z } from 'zod';

export const FeeCategoryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9_]{2,30}$/, 'Fee category code must be 2-30 uppercase letters, numbers, or underscores.');

export const CreateFeeCategorySchema = z.object({
  code: FeeCategoryCodeSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
});

export const FeeCategoryDtoSchema = z.object({
  id: z.string().uuid(),
  code: FeeCategoryCodeSchema,
  name: z.string(),
  description: z.string().nullable(),
  is_active: z.boolean(),
  version: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const FeeComponentInputSchema = z.object({
  fee_category_id: z.string().uuid(),
  amount: z.number().int().positive('Fee component amount must be a positive integer in minor units.'),
  description: z.string().trim().max(500).optional(),
});

export const CreateFeeStructureSchema = z.object({
  campus_id: z.string().uuid(),
  academic_year_id: z.string().uuid(),
  term_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_-]{2,40}$/, 'Fee structure code must be 2-40 alphanumeric/hyphen/underscore characters.'),
  name: z.string().trim().min(1).max(150),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, 'Currency must be 3-letter ISO code.').default('INR'),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must be YYYY-MM-DD.'),
  components: z.array(FeeComponentInputSchema).min(1, 'At least one fee component is required.'),
});

export const FeeStructureDtoSchema = z.object({
  id: z.string().uuid(),
  campus_id: z.string().uuid(),
  academic_year_id: z.string().uuid(),
  term_id: z.string().uuid().nullable(),
  program_id: z.string().uuid().nullable(),
  code: z.string(),
  name: z.string(),
  currency: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
  due_date: z.string(),
  total_amount: z.number().int().positive(),
  created_by_user_id: z.string().uuid(),
  version: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  components: z.array(
    z.object({
      id: z.string().uuid(),
      fee_category_id: z.string().uuid(),
      category_code: z.string(),
      category_name: z.string(),
      amount: z.number().int().positive(),
      description: z.string().nullable(),
    }),
  ),
});

export const ConcessionInputSchema = z.object({
  student_id: z.string().uuid(),
  discount_amount: z.number().int().nonnegative('Discount amount must be non-negative.'),
  reason: z.string().trim().min(3).max(500),
});

export const GenerateStudentDuesSchema = z.object({
  fee_structure_id: z.string().uuid(),
  student_ids: z.array(z.string().uuid()).optional(),
  concessions: z.array(ConcessionInputSchema).optional(),
});

export const DueStatusSchema = z.enum(['PENDING', 'PARTIAL', 'PAID', 'CANCELLED', 'WAIVED']);

export const StudentDueDtoSchema = z.object({
  id: z.string().uuid(),
  campus_id: z.string().uuid(),
  student_id: z.string().uuid(),
  student_name: z.string().optional(),
  admission_number: z.string().optional(),
  fee_structure_id: z.string().uuid(),
  fee_structure_name: z.string().optional(),
  academic_year_id: z.string().uuid(),
  term_id: z.string().uuid().nullable(),
  due_number: z.string(),
  gross_amount: z.number().int().nonnegative(),
  discount_amount: z.number().int().nonnegative(),
  net_amount: z.number().int().nonnegative(),
  paid_amount: z.number().int().nonnegative(),
  balance_amount: z.number().int().nonnegative(),
  status: DueStatusSchema,
  due_date: z.string(),
  concession_reason: z.string().nullable(),
  version: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const PaymentMethodSchema = z.enum([
  'CASH',
  'CHEQUE',
  'BANK_TRANSFER',
  'UPI_REFERENCE',
  'OTHER_OFFLINE',
]);

export const ReconciliationStatusSchema = z.enum([
  'RECORDED',
  'PENDING_VERIFICATION',
  'CONFIRMED',
]);

export const AllocationInputSchema = z.object({
  student_due_id: z.string().uuid(),
  amount: z.number().int().positive('Allocated amount must be positive.'),
});

export const RecordOfflineReceiptSchema = z.object({
  campus_id: z.string().uuid(),
  student_id: z.string().uuid(),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Payment date must be YYYY-MM-DD.'),
  payment_method: PaymentMethodSchema,
  amount: z.number().int().positive('Payment amount must be positive minor units.'),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default('INR'),
  reference_number: z.string().trim().max(100).optional(),
  reconciliation_status: ReconciliationStatusSchema.default('RECORDED'),
  allocations: z.array(AllocationInputSchema).optional(),
  remarks: z.string().trim().max(500).optional(),
  idempotency_key: z.string().trim().max(128).optional(),
});

export const ReverseReceiptSchema = z.object({
  reason: z.string().trim().min(5, 'Reversal reason must be at least 5 characters.').max(500),
});

export const ReceiptStatusSchema = z.enum(['POSTED', 'REVERSED']);

export const FeeReceiptDtoSchema = z.object({
  id: z.string().uuid(),
  campus_id: z.string().uuid(),
  student_id: z.string().uuid(),
  student_name: z.string().optional(),
  admission_number: z.string().optional(),
  receipt_number: z.string(),
  payment_date: z.string(),
  payment_method: PaymentMethodSchema,
  amount: z.number().int().positive(),
  currency: z.string(),
  reference_number: z.string().nullable(),
  reconciliation_status: ReconciliationStatusSchema,
  status: ReceiptStatusSchema,
  received_by_user_id: z.string().uuid(),
  received_by_name: z.string().optional(),
  remarks: z.string().nullable(),
  reversal_reason: z.string().nullable(),
  reversed_at: z.string().datetime().nullable(),
  reversed_by_user_id: z.string().uuid().nullable(),
  version: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  allocations: z.array(
    z.object({
      id: z.string().uuid(),
      student_due_id: z.string().uuid(),
      due_number: z.string().optional(),
      allocated_amount: z.number().int().positive(),
    }),
  ),
});

export const StudentFeeLedgerDtoSchema = z.object({
  student_id: z.string().uuid(),
  student_name: z.string(),
  admission_number: z.string(),
  campus_name: z.string(),
  total_gross: z.number().int().nonnegative(),
  total_discount: z.number().int().nonnegative(),
  total_net: z.number().int().nonnegative(),
  total_paid: z.number().int().nonnegative(),
  total_balance: z.number().int().nonnegative(),
  currency: z.string(),
  dues: z.array(StudentDueDtoSchema),
  receipts: z.array(FeeReceiptDtoSchema),
});

export const CollectionSummaryQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const ListFeeStructuresQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  academic_year_id: z.string().uuid().optional(),
  term_id: z.string().uuid().optional(),
});

export const ListStudentDuesQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  academic_year_id: z.string().uuid().optional(),
  term_id: z.string().uuid().optional(),
  student_id: z.string().uuid().optional(),
  status: DueStatusSchema.optional(),
});

export const ListFeeReceiptsQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  student_id: z.string().uuid().optional(),
  payment_method: PaymentMethodSchema.optional(),
  status: ReceiptStatusSchema.optional(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const CollectionSummaryDtoSchema = z.object({
  total_collected: z.number().int().nonnegative(),
  currency: z.string(),
  receipt_count: z.number().int().nonnegative(),
  reversed_count: z.number().int().nonnegative(),
  by_payment_method: z.record(PaymentMethodSchema, z.number().int().nonnegative()),
  by_reconciliation_status: z.record(ReconciliationStatusSchema, z.number().int().nonnegative()),
});

export type CreateFeeCategoryInput = z.infer<typeof CreateFeeCategorySchema>;
export type CreateFeeStructureInput = z.infer<typeof CreateFeeStructureSchema>;
export type GenerateStudentDuesInput = z.infer<typeof GenerateStudentDuesSchema>;
export type RecordOfflineReceiptInput = z.infer<typeof RecordOfflineReceiptSchema>;
export type ReverseReceiptInput = z.infer<typeof ReverseReceiptSchema>;
export type CollectionSummaryQuery = z.infer<typeof CollectionSummaryQuerySchema>;
export type ListFeeStructuresQuery = z.infer<typeof ListFeeStructuresQuerySchema>;
export type ListStudentDuesQuery = z.infer<typeof ListStudentDuesQuerySchema>;
export type ListFeeReceiptsQuery = z.infer<typeof ListFeeReceiptsQuerySchema>;

