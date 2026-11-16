import { z } from 'zod';
import type { ApiClient } from './client';

export const ExamTypeSchema = z.enum([
  'UNIT_TEST',
  'MID_TERM',
  'FINAL',
  'INTERNAL',
  'SUPPLEMENTARY',
  'OTHER',
]);
export type ExamType = z.infer<typeof ExamTypeSchema>;

export const ExamStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);
export type ExamStatus = z.infer<typeof ExamStatusSchema>;

export const ScheduleStatusSchema = z.enum([
  'SCHEDULED',
  'DRAFT_MARKS',
  'SUBMITTED',
  'PUBLISHED',
  'CANCELLED',
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const MarkStatusSchema = z.enum([
  'ENTERED',
  'ABSENT',
  'EXEMPT',
  'WITHHELD',
  'DRAFT',
  'SUBMITTED',
]).or(z.string());
export type MarkStatus = z.infer<typeof MarkStatusSchema>;

export const ExaminationDtoSchema = z.object({
  id: z.string(),
  organization_id: z.string().optional(),
  campus_id: z.string(),
  term_id: z.string(),
  name: z.string(),
  exam_type: ExamTypeSchema,
  status: ExamStatusSchema,
  starts_on: z.string(),
  ends_on: z.string(),
  campus_name: z.string().optional(),
  term_name: z.string().optional(),
  created_at: z.string().optional(),
});
export type ExaminationDto = z.infer<typeof ExaminationDtoSchema>;

export const ExamScheduleDtoSchema = z.object({
  id: z.string(),
  examination_id: z.string(),
  course_offering_id: z.string(),
  exam_date: z.string(),
  start_time: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  max_marks: z.coerce.number(),
  pass_marks: z.coerce.number(),
  status: ScheduleStatusSchema,
  marks_submitted_at: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  exam_name: z.string().optional(),
  exam_type: ExamTypeSchema.optional(),
  course_code: z.string().optional(),
  course_title: z.string().optional(),
  section_name: z.string().nullable().optional(),
});
export type ExamScheduleDto = z.infer<typeof ExamScheduleDtoSchema>;

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

export const StudentRosterItemSchema = z.object({
  student_id: z.string(),
  admission_number: z.string(),
  student_name: z.string(),
  roll_number: z.string().nullable().optional(),
  mark_id: z.string().nullable().optional(),
  marks_obtained: z.coerce.number().nullable().optional(),
  mark_status: MarkStatusSchema.nullable().optional(),
  is_passing: z.boolean().nullable().optional(),
  remarks: z.string().nullable().optional(),
  evaluation_status: EvaluationStatusSchema.nullable().optional(),
  override_status: OverrideStatusSchema.nullable().optional(),
  final_status: z.enum(['ELIGIBLE', 'NOT_ELIGIBLE']).nullable().optional(),
  eligibility_reasons: z.array(z.string()).nullable().optional(),
});
export type StudentRosterItem = z.infer<typeof StudentRosterItemSchema>;

export const ScheduleRosterResponseSchema = z.object({
  schedule: ExamScheduleDtoSchema,
  candidate_list: z
    .object({
      id: z.string(),
      status: z.string(),
      snapshot_version: z.number(),
    })
    .nullable()
    .optional(),
  students: z.array(StudentRosterItemSchema),
});
export type ScheduleRosterResponse = z.infer<typeof ScheduleRosterResponseSchema>;

export const ClassRegisterStatisticsSchema = z.object({
  total_students: z.coerce.number(),
  appeared: z.coerce.number(),
  absent: z.coerce.number(),
  exempt: z.coerce.number(),
  withheld: z.coerce.number(),
  passed: z.coerce.number(),
  failed: z.coerce.number(),
  average_marks: z.coerce.number(),
  pass_percentage: z.coerce.number(),
});
export type ClassRegisterStatistics = z.infer<typeof ClassRegisterStatisticsSchema>;

export const ClassRegisterResponseSchema = z.object({
  schedule: ExamScheduleDtoSchema,
  marks: z.array(
    z.object({
      id: z.string().optional(),
      student_id: z.string(),
      admission_number: z.string(),
      student_name: z.string(),
      roll_number: z.string().nullable().optional(),
      marks_obtained: z.coerce.number().nullable().optional(),
      status: z.string(),
      is_passing: z.boolean().nullable().optional(),
      remarks: z.string().nullable().optional(),
      marked_at: z.string().optional(),
    }),
  ),
  statistics: ClassRegisterStatisticsSchema,
});
export type ClassRegisterResponse = z.infer<typeof ClassRegisterResponseSchema>;

export const StudentResultItemSchema = z.object({
  mark_id: z.string(),
  marks_obtained: z.coerce.number().nullable(),
  is_passing: z.boolean(),
  mark_status: z.string(),
  remarks: z.string().nullable().optional(),
  schedule_id: z.string(),
  exam_date: z.string(),
  max_marks: z.coerce.number(),
  pass_marks: z.coerce.number(),
  published_at: z.string().nullable().optional(),
  examination_id: z.string(),
  exam_name: z.string(),
  exam_type: z.string(),
  course_code: z.string(),
  course_title: z.string(),
});
export type StudentResultItem = z.infer<typeof StudentResultItemSchema>;

const List = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: z.array(schema) });
const One = <T extends z.ZodTypeAny>(schema: T) => z.object({ data: schema });

export async function fetchExaminations(
  c: ApiClient,
  params?: { campus_id?: string; term_id?: string; status?: ExamStatus },
): Promise<ExaminationDto[]> {
  const query = new URLSearchParams();
  if (params?.campus_id) query.set('campus_id', params.campus_id);
  if (params?.term_id) query.set('term_id', params.term_id);
  if (params?.status) query.set('status', params.status);
  const qs = query.toString() ? `?${query.toString()}` : '';

  const res = await c.get(`/v1/examinations${qs}`, {
    schema: List(ExaminationDtoSchema),
  });
  return res.data;
}

export async function createExamination(
  c: ApiClient,
  body: {
    campus_id: string;
    term_id: string;
    name: string;
    exam_type: ExamType;
    starts_on: string;
    ends_on: string;
  },
): Promise<ExaminationDto> {
  const res = await c.post('/v1/examinations', {
    schema: One(ExaminationDtoSchema),
    body,
  });
  return res.data;
}

export async function fetchSchedules(
  c: ApiClient,
  examinationId: string,
  params?: { course_offering_id?: string; status?: ScheduleStatus },
): Promise<ExamScheduleDto[]> {
  const query = new URLSearchParams();
  if (params?.course_offering_id) query.set('course_offering_id', params.course_offering_id);
  if (params?.status) query.set('status', params.status);
  const qs = query.toString() ? `?${query.toString()}` : '';

  const res = await c.get(`/v1/examinations/${encodeURIComponent(examinationId)}/schedules${qs}`, {
    schema: List(ExamScheduleDtoSchema),
  });
  return res.data;
}

export async function createSchedule(
  c: ApiClient,
  examinationId: string,
  body: {
    course_offering_id: string;
    exam_date: string;
    start_time?: string | null;
    end_time?: string | null;
    max_marks: number;
    pass_marks: number;
  },
): Promise<ExamScheduleDto> {
  const res = await c.post(`/v1/examinations/${encodeURIComponent(examinationId)}/schedules`, {
    schema: One(ExamScheduleDtoSchema),
    body,
  });
  return res.data;
}

export async function fetchScheduleRoster(
  c: ApiClient,
  scheduleId: string,
): Promise<ScheduleRosterResponse> {
  const res = await c.get(`/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/roster`, {
    schema: One(ScheduleRosterResponseSchema),
  });
  return res.data;
}

export async function saveExamMarks(
  c: ApiClient,
  scheduleId: string,
  body: {
    action: 'DRAFT' | 'SUBMIT';
    entries: Array<{
      student_id: string;
      status: MarkStatus;
      marks_obtained?: number | null;
      remarks?: string | null;
    }>;
  },
): Promise<{ success: boolean; status: string; entries_updated: number }> {
  const res = await c.post(`/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/marks`, {
    schema: One(
      z.object({
        success: z.boolean(),
        status: z.string(),
        entries_updated: z.number(),
      }),
    ),
    body,
  });
  return res.data;
}

export async function publishExamResults(
  c: ApiClient,
  scheduleId: string,
): Promise<{ success: boolean; status: string; published_at: string }> {
  const res = await c.post(`/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/publish`, {
    schema: One(
      z.object({
        success: z.boolean(),
        status: z.string(),
        published_at: z.string(),
      }),
    ),
    body: {},
  });
  return res.data;
}

export interface CorrectExamMarkInput {
  student_id: string;
  status?: MarkStatus;
  marks_obtained?: number | null;
  reason: string;
  evidence_url?: string | null;
  evidence_exception?: boolean;
  is_amendment?: boolean;
  remarks?: string | null;
}

export async function correctExamMark(
  c: ApiClient,
  scheduleId: string,
  input: CorrectExamMarkInput,
): Promise<{ success: boolean; student_id: string; marks_obtained: number | null; status: string; is_amendment?: boolean; corrected_at: string }> {
  const res = await c.post(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/marks/correct`,
    {
      schema: One(
        z.object({
          success: z.boolean(),
          student_id: z.string(),
          marks_obtained: z.number().nullable().optional(),
          status: z.string(),
          is_amendment: z.boolean().optional(),
          corrected_at: z.string(),
        }),
      ),
      body: input,
    },
  );
  return res.data as {
    success: boolean;
    student_id: string;
    marks_obtained: number | null;
    status: string;
    is_amendment?: boolean;
    corrected_at: string;
  };
}

export async function amendPublishedExamResult(
  c: ApiClient,
  scheduleId: string,
  input: CorrectExamMarkInput,
): Promise<{ success: boolean; student_id: string; marks_obtained: number | null; status: string; is_amendment: boolean; corrected_at: string }> {
  const res = await c.post(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/marks/amend`,
    {
      schema: One(
        z.object({
          success: z.boolean(),
          student_id: z.string(),
          marks_obtained: z.number().nullable().optional(),
          status: z.string(),
          is_amendment: z.boolean().optional(),
          corrected_at: z.string(),
        }),
      ),
      body: { ...input, is_amendment: true },
    },
  );
  return res.data as {
    success: boolean;
    student_id: string;
    marks_obtained: number | null;
    status: string;
    is_amendment: boolean;
    corrected_at: string;
  };
}

export async function fetchClassRegister(
  c: ApiClient,
  scheduleId: string,
): Promise<ClassRegisterResponse> {
  const res = await c.get(`/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/register`, {
    schema: One(ClassRegisterResponseSchema),
  });
  return res.data;
}

export async function fetchStudentResults(
  c: ApiClient,
  studentId: string,
  termId?: string,
): Promise<StudentResultItem[]> {
  const qs = termId ? `?term_id=${encodeURIComponent(termId)}` : '';
  const res = await c.get(
    `/v1/examinations/students/${encodeURIComponent(studentId)}/results${qs}`,
    {
      schema: List(StudentResultItemSchema),
    },
  );
  return res.data;
}

// ---------------------------------------------------------------------------------------------
// Slice 2: Candidate Eligibility & List Management
// ---------------------------------------------------------------------------------------------

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
  grade_scale: z.array(GradeBoundarySchema).default([]),
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

export const CandidateEvidenceSummarySchema = z.object({
  total_sessions: z.coerce.number().optional().default(0),
  attended_sessions: z.coerce.number().optional().default(0),
  absent_sessions: z.coerce.number().optional().default(0),
  excused_sessions: z.coerce.number().optional().default(0),
  attendance_percentage: z.coerce.number().optional().default(0),
  required_percentage: z.coerce.number().optional().default(0),
  enrolled_date: z.string().nullable().optional(),
  cutoff_date: z.string().nullable().optional(),
  reasons: z.array(z.string()).optional().default([]),
});
export type CandidateEvidenceSummary = z.infer<typeof CandidateEvidenceSummarySchema>;

export const CandidateItemSchema = z.object({
  candidate_id: z.string(),
  student_id: z.string(),
  admission_number: z.string(),
  student_name: z.string(),
  roll_number: z.string().nullable().optional(),
  evaluation_status: EvaluationStatusSchema.nullable().optional(),
  override_status: OverrideStatusSchema.nullable().optional(),
  final_status: z.enum(['ELIGIBLE', 'NOT_ELIGIBLE']).nullable().optional(),
  reasons: z.array(z.string()).optional().default([]),
  evidence_summary: CandidateEvidenceSummarySchema.nullable().optional(),
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
    policy_version: z.number().optional().default(1),
    snapshot_version: z.number(),
    status: CandidateListStatusSchema,
    evidence_cutoff_date: z.string(),
    total_candidates: z.number(),
    eligible_count: z.number(),
    not_eligible_count: z.number(),
    needs_review_count: z.number(),
    policy_snapshot: z.record(z.string(), z.unknown()).optional().default({}),
    generated_at: z.string(),
    approved_at: z.string().nullable().optional(),
    approved_by_user_id: z.string().nullable().optional(),
  }),
  policy: EligibilityPolicyDtoSchema.nullable().optional(),
  candidates: z.array(CandidateItemSchema),
  recalculation_available: z.boolean(),
});
export type CandidateListResponse = z.infer<typeof CandidateListResponseSchema>;

export async function fetchEligibilityPolicy(
  c: ApiClient,
  scheduleId: string,
): Promise<EligibilityPolicyDto> {
  const res = await c.get(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/eligibility-policy`,
    {
      schema: One(EligibilityPolicyDtoSchema),
    },
  );
  return res.data;
}

export async function saveEligibilityPolicy(
  c: ApiClient,
  scheduleId: string,
  body: {
    name: string;
    min_attendance_percentage: number;
    check_attendance: boolean;
    check_fees: boolean;
    attendance_cutoff_days_prior: number;
    allow_late_enrolment_review: boolean;
  },
): Promise<EligibilityPolicyDto> {
  const res = await c.put(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/eligibility-policy`,
    {
      schema: One(EligibilityPolicyDtoSchema),
      body,
    },
  );
  return res.data;
}

export async function generateCandidates(
  c: ApiClient,
  scheduleId: string,
  body?: { cutoff_date?: string },
): Promise<CandidateListResponse> {
  const res = await c.post(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/candidates/generate`,
    {
      schema: One(CandidateListResponseSchema),
      body: body ?? {},
    },
  );
  return res.data;
}

export async function fetchCandidateList(
  c: ApiClient,
  scheduleId: string,
): Promise<CandidateListResponse | null> {
  const res = await c.get(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/candidates`,
    {
      schema: z.object({ data: CandidateListResponseSchema.nullable() }),
    },
  );
  return res.data;
}

export async function overrideCandidate(
  c: ApiClient,
  scheduleId: string,
  candidateId: string,
  body: {
    override_status: OverrideStatus;
    override_reason: string;
  },
): Promise<CandidateItem> {
  const res = await c.patch(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/candidates/${encodeURIComponent(candidateId)}/override`,
    {
      schema: One(CandidateItemSchema),
      body,
    },
  );
  return res.data;
}

export async function approveCandidateList(
  c: ApiClient,
  scheduleId: string,
  listId: string,
  body?: { freeze?: boolean },
): Promise<{ id: string; status: CandidateListStatus }> {
  const res = await c.post(
    `/v1/examinations/schedules/${encodeURIComponent(scheduleId)}/candidates/${encodeURIComponent(listId)}/approve`,
    {
      schema: One(
        z.object({
          id: z.string(),
          status: CandidateListStatusSchema,
        }),
      ),
      body: body ?? {},
    },
  );
  return res.data;
}

export async function fetchExamPolicies(
  c: ApiClient,
  params?: {
    scope?: PolicyScope;
    status?: PolicyStatus;
    campus_id?: string;
    examination_id?: string;
  },
): Promise<EligibilityPolicyDto[]> {
  const query = new URLSearchParams();
  if (params?.scope) query.set('scope', params.scope);
  if (params?.status) query.set('status', params.status);
  if (params?.campus_id) query.set('campus_id', params.campus_id);
  if (params?.examination_id) query.set('examination_id', params.examination_id);
  const qs = query.toString() ? `?${query.toString()}` : '';

  const res = await c.get(`/v1/examinations/policies${qs}`, {
    schema: List(EligibilityPolicyDtoSchema),
  });
  return res.data;
}

export async function fetchExamPolicyById(
  c: ApiClient,
  policyId: string,
): Promise<EligibilityPolicyDto> {
  const res = await c.get(`/v1/examinations/policies/${encodeURIComponent(policyId)}`, {
    schema: One(EligibilityPolicyDtoSchema),
  });
  return res.data;
}

export async function createExamPolicy(
  c: ApiClient,
  body: SaveEligibilityPolicyInput,
): Promise<EligibilityPolicyDto> {
  const res = await c.post('/v1/examinations/policies', {
    schema: One(EligibilityPolicyDtoSchema),
    body,
  });
  return res.data;
}

export async function updateExamPolicy(
  c: ApiClient,
  policyId: string,
  body: SaveEligibilityPolicyInput,
): Promise<EligibilityPolicyDto> {
  const res = await c.put(`/v1/examinations/policies/${encodeURIComponent(policyId)}`, {
    schema: One(EligibilityPolicyDtoSchema),
    body,
  });
  return res.data;
}

export async function duplicateExamPolicy(
  c: ApiClient,
  policyId: string,
  body?: { name?: string },
): Promise<EligibilityPolicyDto> {
  const res = await c.post(
    `/v1/examinations/policies/${encodeURIComponent(policyId)}/duplicate`,
    {
      schema: One(EligibilityPolicyDtoSchema),
      body: body ?? {},
    },
  );
  return res.data;
}

export async function activateExamPolicy(
  c: ApiClient,
  policyId: string,
): Promise<EligibilityPolicyDto> {
  const res = await c.post(
    `/v1/examinations/policies/${encodeURIComponent(policyId)}/activate`,
    {
      schema: One(EligibilityPolicyDtoSchema),
      body: {},
    },
  );
  return res.data;
}

export async function archiveExamPolicy(
  c: ApiClient,
  policyId: string,
): Promise<EligibilityPolicyDto> {
  const res = await c.post(
    `/v1/examinations/policies/${encodeURIComponent(policyId)}/archive`,
    {
      schema: One(EligibilityPolicyDtoSchema),
      body: {},
    },
  );
  return res.data;
}

export async function previewExamPolicyImpact(
  c: ApiClient,
  body: {
    schedule_id: string;
    policy?: SaveEligibilityPolicyInput;
    policy_id?: string;
  },
): Promise<PolicyPreviewImpactResponse> {
  const res = await c.post('/v1/examinations/policies/preview-impact', {
    schema: One(PolicyPreviewImpactResponseSchema),
    body,
  });
  return res.data;
}

export async function fetchExamLevelEligibilityPolicy(
  c: ApiClient,
  examinationId: string,
): Promise<EligibilityPolicyDto> {
  const res = await c.get(
    `/v1/examinations/${encodeURIComponent(examinationId)}/eligibility-policy`,
    {
      schema: One(EligibilityPolicyDtoSchema),
    },
  );
  return res.data;
}

export async function saveExamLevelEligibilityPolicy(
  c: ApiClient,
  examinationId: string,
  body: SaveEligibilityPolicyInput,
): Promise<EligibilityPolicyDto> {
  const res = await c.put(
    `/v1/examinations/${encodeURIComponent(examinationId)}/eligibility-policy`,
    {
      schema: One(EligibilityPolicyDtoSchema),
      body,
    },
  );
  return res.data;
}
