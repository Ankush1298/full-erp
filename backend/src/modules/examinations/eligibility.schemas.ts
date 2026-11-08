import { z } from 'zod';

export const EvaluationStatusSchema = z.enum(['ELIGIBLE', 'NOT_ELIGIBLE', 'NEEDS_REVIEW']);
export type EvaluationStatus = z.infer<typeof EvaluationStatusSchema>;

export const OverrideStatusSchema = z.enum([
  'NONE',
  'EXEMPTED',
  'CONDITIONAL_APPROVAL',
  'DISQUALIFIED',
]);
export type OverrideStatus = z.infer<typeof OverrideStatusSchema>;

export const CandidateListStatusSchema = z.enum(['DRAFT', 'APPROVED', 'FROZEN']);
export type CandidateListStatus = z.infer<typeof CandidateListStatusSchema>;

export const EligibilityPolicyDtoSchema = z.object({
  id: z.string(),
  organization_id: z.string().optional(),
  campus_id: z.string().nullable().optional(),
  examination_id: z.string().nullable().optional(),
  exam_schedule_id: z.string().nullable().optional(),
  name: z.string(),
  min_attendance_percentage: z.coerce.number(),
  check_attendance: z.boolean(),
  check_fees: z.boolean(),
  attendance_cutoff_days_prior: z.coerce.number(),
  allow_late_enrolment_review: z.boolean(),
  version: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type EligibilityPolicyDto = z.infer<typeof EligibilityPolicyDtoSchema>;

export const SaveEligibilityPolicyInputSchema = z.object({
  name: z.string().min(1).max(120).default('Default Eligibility Policy'),
  min_attendance_percentage: z.coerce.number().min(0).max(100).default(75.0),
  check_attendance: z.boolean().default(true),
  check_fees: z.boolean().default(false),
  attendance_cutoff_days_prior: z.coerce.number().min(0).default(0),
  allow_late_enrolment_review: z.boolean().default(true),
});
export type SaveEligibilityPolicyInput = z.infer<typeof SaveEligibilityPolicyInputSchema>;

export const GenerateCandidatesInputSchema = z.object({
  cutoff_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .optional(),
  override_policy: SaveEligibilityPolicyInputSchema.optional(),
});
export type GenerateCandidatesInput = z.infer<typeof GenerateCandidatesInputSchema>;

export const OverrideCandidateInputSchema = z.object({
  override_status: OverrideStatusSchema,
  override_reason: z.string().min(3, 'Override reason must be at least 3 characters long'),
});
export type OverrideCandidateInput = z.infer<typeof OverrideCandidateInputSchema>;

export const ApproveCandidateListInputSchema = z.object({
  freeze: z.boolean().optional().default(false),
});
export type ApproveCandidateListInput = z.infer<typeof ApproveCandidateListInputSchema>;

export const CandidateEvidenceSummarySchema = z.object({
  total_sessions: z.number(),
  attended_sessions: z.number(),
  absent_sessions: z.number(),
  excused_sessions: z.number(),
  attendance_percentage: z.number(),
  required_percentage: z.number(),
  enrolled_date: z.string().nullable().optional(),
  cutoff_date: z.string(),
  reasons: z.array(z.string()),
  fee_status: z.enum(['CLEARED', 'OUTSTANDING', 'NEEDS_REVIEW', 'NO_RECORD']).optional(),
  outstanding_balance: z.number().optional(),
});
export type CandidateEvidenceSummary = z.infer<typeof CandidateEvidenceSummarySchema>;

export const CandidateItemSchema = z.object({
  candidate_id: z.string(),
  student_id: z.string(),
  admission_number: z.string(),
  student_name: z.string(),
  roll_number: z.string().nullable().optional(),
  evaluation_status: EvaluationStatusSchema,
  override_status: OverrideStatusSchema,
  final_status: z.enum(['ELIGIBLE', 'NOT_ELIGIBLE']),
  reasons: z.array(z.string()),
  evidence_summary: CandidateEvidenceSummarySchema,
  override_reason: z.string().nullable().optional(),
  overridden_by_user_id: z.string().nullable().optional(),
  overridden_at: z.string().nullable().optional(),
});
export type CandidateItem = z.infer<typeof CandidateItemSchema>;

export const CandidateListResponseSchema = z.object({
  list: z.object({
    id: z.string(),
    exam_schedule_id: z.string(),
    policy_id: z.string().nullable().optional(),
    policy_version: z.number(),
    snapshot_version: z.number(),
    status: CandidateListStatusSchema,
    evidence_cutoff_date: z.string(),
    total_candidates: z.number(),
    eligible_count: z.number(),
    not_eligible_count: z.number(),
    needs_review_count: z.number(),
    policy_snapshot: z.record(z.string(), z.unknown()),
    generated_at: z.string(),
    approved_at: z.string().nullable().optional(),
    approved_by_user_id: z.string().nullable().optional(),
  }),
  policy: EligibilityPolicyDtoSchema.nullable().optional(),
  candidates: z.array(CandidateItemSchema),
  recalculation_available: z.boolean(),
});
export type CandidateListResponse = z.infer<typeof CandidateListResponseSchema>;
