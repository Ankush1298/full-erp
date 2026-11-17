import { Type, type Static } from '@sinclair/typebox';
import { UuidV7Schema } from '../students/student.schemas.js';

export const PromotionModeSchema = Type.Union([
  Type.Literal('MANUAL'),
  Type.Literal('PRINCIPAL_APPROVAL'),
  Type.Literal('AUTOMATIC'),
]);
export type PromotionMode = Static<typeof PromotionModeSchema>;

export const PromotionOutcomeSchema = Type.Union([
  Type.Literal('PROMOTED'),
  Type.Literal('RETAINED'),
  Type.Literal('PENDING_REVIEW'),
  Type.Literal('GRADUATED'),
]);
export type PromotionOutcome = Static<typeof PromotionOutcomeSchema>;

export const BatchStatusSchema = Type.Union([
  Type.Literal('PREVIEW'),
  Type.Literal('PENDING_APPROVAL'),
  Type.Literal('APPROVED'),
  Type.Literal('EXECUTED'),
]);
export type BatchStatus = Static<typeof BatchStatusSchema>;

export const GraceMarksPolicySchema = Type.Object(
  {
    enabled: Type.Boolean(),
    maxGraceMarksTotal: Type.Integer({ minimum: 0, maximum: 50 }),
    maxGraceMarksPerSubject: Type.Integer({ minimum: 0, maximum: 20 }),
  },
  { additionalProperties: false },
);
export type GraceMarksPolicy = Static<typeof GraceMarksPolicySchema>;

export const AttendanceRequirementSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    minimumAttendancePercentage: Type.Number({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false },
);
export type AttendanceRequirement = Static<typeof AttendanceRequirementSchema>;

export const PromotionPolicySchema = Type.Object(
  {
    mode: PromotionModeSchema,
    minimumAggregatePercentage: Type.Number({ minimum: 0, maximum: 100 }),
    minimumSubjectPercentage: Type.Number({ minimum: 0, maximum: 100 }),
    maxFailingSubjectsForSupplementary: Type.Integer({ minimum: 0, maximum: 10 }),
    graceMarksPolicy: GraceMarksPolicySchema,
    attendanceRequirement: AttendanceRequirementSchema,
    streamSelectionPeriodNo: Type.Integer({ minimum: 1, maximum: 50 }),
    terminalPeriodNo: Type.Integer({ minimum: 1, maximum: 50 }),
    notifyGuardians: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type PromotionPolicy = Static<typeof PromotionPolicySchema>;

export const UpdatePromotionPolicyBodySchema = Type.Partial(PromotionPolicySchema, {
  additionalProperties: false,
});
export type UpdatePromotionPolicyBody = Static<typeof UpdatePromotionPolicyBodySchema>;

export const StreamPreferenceSchema = Type.Object(
  {
    studentId: UuidV7Schema,
    targetCohortPeriodId: UuidV7Schema,
    targetSectionId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type StreamPreference = Static<typeof StreamPreferenceSchema>;

export const RolloverPreviewBodySchema = Type.Object(
  {
    sourceTermId: UuidV7Schema,
    targetTermId: UuidV7Schema,
    cohortPeriodIds: Type.Optional(Type.Array(UuidV7Schema)),
    streamPreferences: Type.Optional(Type.Array(StreamPreferenceSchema)),
  },
  { additionalProperties: false },
);
export type RolloverPreviewBody = Static<typeof RolloverPreviewBodySchema>;

export const RolloverEvaluationDetailsSchema = Type.Object(
  {
    aggregatePercentage: Type.Union([Type.Number(), Type.Null()]),
    totalMarksObtained: Type.Union([Type.Number(), Type.Null()]),
    totalMaxMarks: Type.Union([Type.Number(), Type.Null()]),
    failingSubjectCount: Type.Integer(),
    hasUnpublishedExams: Type.Boolean(),
    hasMissingMarks: Type.Boolean(),
    hasWithheldMarks: Type.Boolean(),
    appliedGraceMarks: Type.Integer(),
    attendancePercentage: Type.Union([Type.Number(), Type.Null()]),
    notes: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type RolloverEvaluationDetails = Static<typeof RolloverEvaluationDetailsSchema>;

export const RolloverStudentEvaluationSchema = Type.Object(
  {
    studentId: UuidV7Schema,
    enrollmentId: UuidV7Schema,
    fullName: Type.String(),
    admissionNumber: Type.String(),
    currentCohortPeriodId: UuidV7Schema,
    currentPeriodNo: Type.Integer(),
    currentSectionId: Type.Union([UuidV7Schema, Type.Null()]),
    currentSectionName: Type.Union([Type.String(), Type.Null()]),
    targetCohortPeriodId: Type.Union([UuidV7Schema, Type.Null()]),
    targetPeriodNo: Type.Union([Type.Integer(), Type.Null()]),
    targetSectionId: Type.Union([UuidV7Schema, Type.Null()]),
    targetSectionName: Type.Union([Type.String(), Type.Null()]),
    recommendedOutcome: PromotionOutcomeSchema,
    finalOutcome: PromotionOutcomeSchema,
    overrideReason: Type.Union([Type.String(), Type.Null()]),
    overrideBy: Type.Union([UuidV7Schema, Type.Null()]),
    evaluationDetails: RolloverEvaluationDetailsSchema,
  },
  { additionalProperties: false },
);
export type RolloverStudentEvaluation = Static<typeof RolloverStudentEvaluationSchema>;

export const RolloverTermSummarySchema = Type.Object(
  {
    id: UuidV7Schema,
    name: Type.String(),
    code: Type.String(),
    startDate: Type.String(),
    endDate: Type.String(),
    academicYearId: UuidV7Schema,
    academicYearLabel: Type.String(),
  },
  { additionalProperties: false },
);
export type RolloverTermSummary = Static<typeof RolloverTermSummarySchema>;

export const RolloverCountsSchema = Type.Object(
  {
    totalStudents: Type.Integer(),
    promoted: Type.Integer(),
    retained: Type.Integer(),
    pendingReview: Type.Integer(),
    graduated: Type.Integer(),
  },
  { additionalProperties: false },
);
export type RolloverCounts = Static<typeof RolloverCountsSchema>;

export const RolloverBatchDtoSchema = Type.Object(
  {
    batchId: UuidV7Schema,
    status: BatchStatusSchema,
    sourceTerm: RolloverTermSummarySchema,
    targetTerm: RolloverTermSummarySchema,
    policy: PromotionPolicySchema,
    summary: RolloverCountsSchema,
    students: Type.Array(RolloverStudentEvaluationSchema),
    createdAt: Type.String(),
    createdBy: UuidV7Schema,
    approvedAt: Type.Union([Type.String(), Type.Null()]),
    approvedBy: Type.Union([UuidV7Schema, Type.Null()]),
    executedAt: Type.Union([Type.String(), Type.Null()]),
    executedBy: Type.Union([UuidV7Schema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type RolloverBatchDto = Static<typeof RolloverBatchDtoSchema>;

export const RolloverBatchSummaryDtoSchema = Type.Object(
  {
    batchId: UuidV7Schema,
    status: BatchStatusSchema,
    sourceTermId: UuidV7Schema,
    sourceTermName: Type.String(),
    targetTermId: UuidV7Schema,
    targetTermName: Type.String(),
    summary: RolloverCountsSchema,
    createdAt: Type.String(),
    createdBy: UuidV7Schema,
    executedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type RolloverBatchSummaryDto = Static<typeof RolloverBatchSummaryDtoSchema>;

export const RolloverExceptionItemSchema = Type.Object(
  {
    studentId: UuidV7Schema,
    outcome: PromotionOutcomeSchema,
    reason: Type.String({ minLength: 5, maxLength: 500 }),
    targetCohortPeriodId: Type.Optional(UuidV7Schema),
    targetSectionId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type RolloverExceptionItem = Static<typeof RolloverExceptionItemSchema>;

export const RolloverExceptionsBodySchema = Type.Object(
  {
    exceptions: Type.Array(RolloverExceptionItemSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type RolloverExceptionsBody = Static<typeof RolloverExceptionsBodySchema>;

export const RolloverExecuteBodySchema = Type.Object(
  {
    batchId: UuidV7Schema,
    notifyGuardians: Type.Optional(Type.Boolean()),
    confirmPendingReviewHandling: Type.Optional(
      Type.Union([Type.Literal('SKIP'), Type.Literal('FAIL')]),
    ),
  },
  { additionalProperties: false },
);
export type RolloverExecuteBody = Static<typeof RolloverExecuteBodySchema>;

export const RolloverExecuteResultSchema = Type.Object(
  {
    batchId: UuidV7Schema,
    executedAt: Type.String(),
    promotedCount: Type.Integer(),
    retainedCount: Type.Integer(),
    graduatedCount: Type.Integer(),
    skippedCount: Type.Integer(),
  },
  { additionalProperties: false },
);
export type RolloverExecuteResult = Static<typeof RolloverExecuteResultSchema>;
