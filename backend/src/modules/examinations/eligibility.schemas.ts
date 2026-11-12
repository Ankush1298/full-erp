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

export const PolicyScopeSchema = z.enum(['INSTITUTION', 'CAMPUS', 'EXAMINATION', 'SCHEDULE']);
export type PolicyScope = z.infer<typeof PolicyScopeSchema>;

export const PolicyStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const ExcusedAbsenceTreatmentSchema = z.enum(['EXEMPT', 'PRESENT', 'ABSENT']);
export type ExcusedAbsenceTreatment = z.infer<typeof ExcusedAbsenceTreatmentSchema>;

export const LateArrivalTreatmentSchema = z.enum(['PRESENT', 'HALF_DAY', 'ABSENT']);
export type LateArrivalTreatment = z.infer<typeof LateArrivalTreatmentSchema>;

export const GradingSystemTypeSchema = z.enum([
  'PERCENTAGE',
  'LETTER_GRADE',
  'GRADE_POINT',
  'MARKS_ONLY',
]);
export type GradingSystemType = z.infer<typeof GradingSystemTypeSchema>;

export const GradeBoundarySchema = z.object({
  grade: z.string().min(1).max(20),
  min_percentage: z.coerce.number().min(0).max(100),
  max_percentage: z.coerce.number().min(0).max(100),
  grade_point: z.coerce.number().min(0).max(10).optional(),
  description: z.string().max(100).optional(),
  is_passing: z.boolean().default(true),
});
export type GradeBoundary = z.infer<typeof GradeBoundarySchema>;

export const AssessmentComponentSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  component_type: z.enum(['THEORY', 'PRACTICAL', 'INTERNAL', 'VIVA', 'ASSIGNMENT', 'PROJECT']),
  max_marks: z.coerce.number().positive().max(10000),
  pass_marks: z.coerce.number().min(0).max(10000),
  weight_percentage: z.coerce.number().min(0).max(100),
});
export type AssessmentComponent = z.infer<typeof AssessmentComponentSchema>;

export const AttendanceRulesSchema = z.object({
  calculation_period: z.enum(['FULL_TERM', 'SEMESTER', 'CUSTOM']).default('FULL_TERM'),
  excused_treatment: ExcusedAbsenceTreatmentSchema.default('EXEMPT'),
  late_treatment: LateArrivalTreatmentSchema.default('PRESENT'),
  cancelled_sessions_excluded: z.boolean().default(true),
  prorate_late_enrolment: z.boolean().default(true),
  min_sessions: z.coerce.number().min(0).default(0),
  allow_exemption: z.boolean().default(true),
  exemption_approver_role: z.string().default('PRINCIPAL'),
});
export type AttendanceRules = z.infer<typeof AttendanceRulesSchema>;

export const FeeRulesSchema = z.object({
  max_balance_tolerance: z.coerce.number().min(0).default(0),
  allow_concession_exemption: z.boolean().default(true),
  deadline_days_prior: z.coerce.number().min(0).default(0),
  require_payment_verification: z.boolean().default(true),
});
export type FeeRules = z.infer<typeof FeeRulesSchema>;

export const AcademicRulesSchema = z.object({
  required_enrolment_status: z.enum(['ACTIVE', 'REGISTERED', 'ANY']).default('REGISTERED'),
  min_enrolment_days: z.coerce.number().min(0).default(0),
  allow_academic_exception: z.boolean().default(true),
  supplementary_eligible: z.boolean().default(true),
});
export type AcademicRules = z.infer<typeof AcademicRulesSchema>;

export const AssessmentRulesSchema = z.object({
  exam_type: z.string().optional(),
  components: z.array(AssessmentComponentSchema).default([]),
  allow_grace_marks: z.boolean().default(false),
  max_grace_marks: z.coerce.number().min(0).max(20).default(0),
  grace_marks_min_aggregate: z.coerce.number().min(0).max(100).optional(),
});
export type AssessmentRules = z.infer<typeof AssessmentRulesSchema>;

export const GradingRulesSchema = z.object({
  grading_system: GradingSystemTypeSchema.default('PERCENTAGE'),
  grade_scale: z.array(GradeBoundarySchema).default([
    {
      grade: 'A+',
      min_percentage: 90,
      max_percentage: 100,
      grade_point: 10.0,
      description: 'Outstanding',
      is_passing: true,
    },
    {
      grade: 'A',
      min_percentage: 80,
      max_percentage: 89.99,
      grade_point: 9.0,
      description: 'Excellent',
      is_passing: true,
    },
    {
      grade: 'B+',
      min_percentage: 70,
      max_percentage: 79.99,
      grade_point: 8.0,
      description: 'Very Good',
      is_passing: true,
    },
    {
      grade: 'B',
      min_percentage: 60,
      max_percentage: 69.99,
      grade_point: 7.0,
      description: 'Good',
      is_passing: true,
    },
    {
      grade: 'C',
      min_percentage: 50,
      max_percentage: 59.99,
      grade_point: 6.0,
      description: 'Above Average',
      is_passing: true,
    },
    {
      grade: 'D',
      min_percentage: 40,
      max_percentage: 49.99,
      grade_point: 5.0,
      description: 'Pass',
      is_passing: true,
    },
    {
      grade: 'F',
      min_percentage: 0,
      max_percentage: 39.99,
      grade_point: 0.0,
      description: 'Fail',
      is_passing: false,
    },
  ]),
});
export type GradingRules = z.infer<typeof GradingRulesSchema>;

export const ResultsApprovalGovernanceModeSchema = z.enum([
  'PRINCIPAL_FINAL_AUTHORITY',
  'INDEPENDENT_REVIEW',
  'DELEGATED_APPROVAL',
]);
export type ResultsApprovalGovernanceMode = z.infer<typeof ResultsApprovalGovernanceModeSchema>;

export const ApprovalRulesSchema = z.object({
  governance_mode: ResultsApprovalGovernanceModeSchema.default('PRINCIPAL_FINAL_AUTHORITY'),
  require_coordinator_review: z.boolean().default(true),
  require_principal_approval: z.boolean().default(true),
  allow_individual_override: z.boolean().default(true),
  results_workflow: z
    .enum(['DRAFT_REVIEW_PUBLISH', 'DIRECT_PUBLISH'])
    .default('DRAFT_REVIEW_PUBLISH'),
  delegated_roles: z.array(z.string()).default([
    'COLLEGE_ADMIN',
    'CAMPUS_ADMIN',
    'REGISTRAR',
    'DEPARTMENT_ADMIN',
    'HOD',
  ]),
  effective_date: z.string().optional(),
  notes: z.string().max(500).optional(),
});
export type ApprovalRules = z.infer<typeof ApprovalRulesSchema>;

export const EligibilityPolicyDtoSchema = z.object({
  id: z.string(),
  organization_id: z.string().optional(),
  campus_id: z.string().nullable().optional(),
  examination_id: z.string().nullable().optional(),
  exam_schedule_id: z.string().nullable().optional(),
  name: z.string(),
  scope: PolicyScopeSchema.optional(),
  status: PolicyStatusSchema.optional(),
  description: z.string().nullable().optional(),
  min_attendance_percentage: z.coerce.number(),
  check_attendance: z.boolean(),
  check_fees: z.boolean(),
  attendance_cutoff_days_prior: z.coerce.number(),
  allow_late_enrolment_review: z.boolean(),
  attendance_rules: AttendanceRulesSchema.optional(),
  fee_rules: FeeRulesSchema.optional(),
  academic_rules: AcademicRulesSchema.optional(),
  assessment_rules: AssessmentRulesSchema.optional(),
  grading_rules: GradingRulesSchema.optional(),
  approval_rules: ApprovalRulesSchema.optional(),
  version: z.number(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type EligibilityPolicyDto = z.infer<typeof EligibilityPolicyDtoSchema>;

export const SaveEligibilityPolicyInputSchema = z.object({
  name: z.string().min(1).max(120).default('Default Eligibility Policy'),
  scope: PolicyScopeSchema.optional(),
  status: PolicyStatusSchema.optional(),
  description: z.string().max(500).optional(),
  campus_id: z.string().uuid().nullable().optional(),
  examination_id: z.string().uuid().nullable().optional(),
  exam_schedule_id: z.string().uuid().nullable().optional(),
  min_attendance_percentage: z.coerce.number().min(0).max(100).default(75.0),
  check_attendance: z.boolean().default(true),
  check_fees: z.boolean().default(false),
  attendance_cutoff_days_prior: z.coerce.number().min(0).default(0),
  allow_late_enrolment_review: z.boolean().default(true),
  attendance_rules: AttendanceRulesSchema.optional(),
  fee_rules: FeeRulesSchema.optional(),
  academic_rules: AcademicRulesSchema.optional(),
  assessment_rules: AssessmentRulesSchema.optional(),
  grading_rules: GradingRulesSchema.optional(),
  approval_rules: ApprovalRulesSchema.optional(),
});
export type SaveEligibilityPolicyInput = z.infer<typeof SaveEligibilityPolicyInputSchema>;

export const ListPoliciesQuerySchema = z.object({
  scope: PolicyScopeSchema.optional(),
  status: PolicyStatusSchema.optional(),
  campus_id: z.string().uuid().optional(),
  examination_id: z.string().uuid().optional(),
});
export type ListPoliciesQuery = z.infer<typeof ListPoliciesQuerySchema>;

export const PolicyPreviewImpactInputSchema = z.object({
  schedule_id: z.string().uuid(),
  policy: SaveEligibilityPolicyInputSchema.optional(),
  policy_id: z.string().uuid().optional(),
});
export type PolicyPreviewImpactInput = z.infer<typeof PolicyPreviewImpactInputSchema>;

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

export const PolicyPreviewImpactResponseSchema = z.object({
  schedule_id: z.string(),
  total_enrolled: z.number(),
  simulated_eligible: z.number(),
  simulated_not_eligible: z.number(),
  simulated_needs_review: z.number(),
  sample_results: z.array(CandidateItemSchema),
});
export type PolicyPreviewImpactResponse = z.infer<typeof PolicyPreviewImpactResponseSchema>;

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
  recalculation_available: z.boolean().optional(),
});
export type CandidateListResponse = z.infer<typeof CandidateListResponseSchema>;
