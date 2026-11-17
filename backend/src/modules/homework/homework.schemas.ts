import { Type, type Static } from '@sinclair/typebox';

export const SubmissionTypeSchema = Type.Union([Type.Literal('OFFLINE'), Type.Literal('ONLINE')]);
export type SubmissionType = Static<typeof SubmissionTypeSchema>;

export const HomeworkStatusSchema = Type.Union([
  Type.Literal('DRAFT'),
  Type.Literal('PUBLISHED'),
  Type.Literal('CLOSED'),
  Type.Literal('ARCHIVED'),
]);
export type HomeworkStatus = Static<typeof HomeworkStatusSchema>;

export const HomeworkAttachmentItemSchema = Type.Object({
  id: Type.String(),
  fileId: Type.String(),
  fileName: Type.String(),
  fileSizeBytes: Type.Number(),
  mimeType: Type.String(),
});
export type HomeworkAttachmentItem = Static<typeof HomeworkAttachmentItemSchema>;

export const HomeworkSubmissionFileSchema = Type.Object({
  id: Type.String(),
  fileId: Type.String(),
  fileName: Type.String(),
  fileSizeBytes: Type.Number(),
  mimeType: Type.String(),
});
export type HomeworkSubmissionFile = Static<typeof HomeworkSubmissionFileSchema>;

export const TeacherClassItemSchema = Type.Object({
  courseOfferingId: Type.String(),
  courseId: Type.String(),
  courseCode: Type.String(),
  courseTitle: Type.String(),
  termId: Type.String(),
  termName: Type.String(),
  campusId: Type.String(),
  campusName: Type.String(),
  cohortPeriodId: Type.Union([Type.String(), Type.Null()]),
  cohortName: Type.Union([Type.String(), Type.Null()]),
  sectionId: Type.Union([Type.String(), Type.Null()]),
  sectionName: Type.Union([Type.String(), Type.Null()]),
  teachingRole: Type.String(),
  studentCount: Type.Number(),
});
export type TeacherClassItem = Static<typeof TeacherClassItemSchema>;

export const RecipientPreviewItemSchema = Type.Object({
  studentId: Type.String(),
  admissionNumber: Type.String(),
  displayName: Type.String(),
  rollNumber: Type.Union([Type.String(), Type.Null()]),
  sectionName: Type.Union([Type.String(), Type.Null()]),
});
export type RecipientPreviewItem = Static<typeof RecipientPreviewItemSchema>;

export const RecipientPreviewResponseSchema = Type.Object({
  totalCount: Type.Number(),
  courseTitle: Type.String(),
  sectionName: Type.Union([Type.String(), Type.Null()]),
  students: Type.Array(RecipientPreviewItemSchema),
});
export type RecipientPreviewResponse = Static<typeof RecipientPreviewResponseSchema>;

export const AttachmentInputSchema = Type.Object({
  fileId: Type.String(),
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  fileSizeBytes: Type.Number({ minimum: 0 }),
  mimeType: Type.String(),
});

export const CreateHomeworkBodySchema = Type.Object({
  courseOfferingId: Type.String(),
  sectionId: Type.Optional(Type.String()),
  title: Type.String({ minLength: 1, maxLength: 255 }),
  instructions: Type.String({ minLength: 1 }),
  submissionType: SubmissionTypeSchema,
  dueDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  dueTime: Type.Optional(Type.String({ pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' })),
  maxMarks: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
  allowResubmission: Type.Optional(Type.Boolean()),
  publishNow: Type.Optional(Type.Boolean()),
  attachments: Type.Optional(Type.Array(AttachmentInputSchema)),
});
export type CreateHomeworkBody = Static<typeof CreateHomeworkBodySchema>;

export const UpdateHomeworkBodySchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  instructions: Type.Optional(Type.String({ minLength: 1 })),
  submissionType: Type.Optional(SubmissionTypeSchema),
  dueDate: Type.Optional(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
  dueTime: Type.Optional(Type.String({ pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' })),
  maxMarks: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
  allowResubmission: Type.Optional(Type.Boolean()),
});
export type UpdateHomeworkBody = Static<typeof UpdateHomeworkBodySchema>;

export const HomeworkDetailDtoSchema = Type.Object({
  id: Type.String(),
  courseOfferingId: Type.String(),
  courseCode: Type.String(),
  courseTitle: Type.String(),
  sectionId: Type.Union([Type.String(), Type.Null()]),
  sectionName: Type.Union([Type.String(), Type.Null()]),
  teacherName: Type.String(),
  teacherEmployeeId: Type.String(),
  title: Type.String(),
  instructions: Type.String(),
  submissionType: SubmissionTypeSchema,
  status: HomeworkStatusSchema,
  dueDate: Type.Union([Type.String(), Type.Null()]),
  dueTime: Type.Union([Type.String(), Type.Null()]),
  maxMarks: Type.Union([Type.Number(), Type.Null()]),
  allowResubmission: Type.Boolean(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  closedAt: Type.Union([Type.String(), Type.Null()]),
  totalRecipients: Type.Number(),
  submittedCount: Type.Number(),
  pendingCount: Type.Number(),
  reviewedCount: Type.Number(),
  lateCount: Type.Number(),
  attachments: Type.Array(HomeworkAttachmentItemSchema),
  createdAt: Type.String(),
});
export type HomeworkDetailDto = Static<typeof HomeworkDetailDtoSchema>;

export const SubmissionListItemDtoSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Null()]),
  studentId: Type.String(),
  admissionNumber: Type.String(),
  studentName: Type.String(),
  rollNumber: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  submissionText: Type.Union([Type.String(), Type.Null()]),
  submittedAt: Type.Union([Type.String(), Type.Null()]),
  evaluatedAt: Type.Union([Type.String(), Type.Null()]),
  marksObtained: Type.Union([Type.Number(), Type.Null()]),
  grade: Type.Union([Type.String(), Type.Null()]),
  feedback: Type.Union([Type.String(), Type.Null()]),
  resubmissionAllowed: Type.Boolean(),
  resubmissionCount: Type.Number(),
  files: Type.Array(HomeworkSubmissionFileSchema),
});
export type SubmissionListItemDto = Static<typeof SubmissionListItemDtoSchema>;

export const ReviewSubmissionBodySchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal('REVIEWED'),
      Type.Literal('RESUBMISSION_REQUESTED'),
      Type.Literal('COMPLETED'),
    ]),
  ),
  marksObtained: Type.Optional(Type.Number({ minimum: 0, maximum: 1000 })),
  grade: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
  feedback: Type.Optional(Type.String()),
  resubmissionAllowed: Type.Optional(Type.Boolean()),
});
export type ReviewSubmissionBody = Static<typeof ReviewSubmissionBodySchema>;

export const SubmitHomeworkBodySchema = Type.Object({
  submissionText: Type.Optional(Type.String()),
  files: Type.Optional(Type.Array(AttachmentInputSchema)),
});
export type SubmitHomeworkBody = Static<typeof SubmitHomeworkBodySchema>;

export const StudentHomeworkItemDtoSchema = Type.Object({
  id: Type.String(),
  courseOfferingId: Type.String(),
  courseCode: Type.String(),
  courseTitle: Type.String(),
  sectionName: Type.Union([Type.String(), Type.Null()]),
  teacherName: Type.String(),
  title: Type.String(),
  instructions: Type.String(),
  submissionType: SubmissionTypeSchema,
  dueDate: Type.Union([Type.String(), Type.Null()]),
  dueTime: Type.Union([Type.String(), Type.Null()]),
  maxMarks: Type.Union([Type.Number(), Type.Null()]),
  status: Type.String(),
  submissionStatus: Type.String(),
  submittedAt: Type.Union([Type.String(), Type.Null()]),
  evaluatedAt: Type.Union([Type.String(), Type.Null()]),
  marksObtained: Type.Union([Type.Number(), Type.Null()]),
  grade: Type.Union([Type.String(), Type.Null()]),
  feedback: Type.Union([Type.String(), Type.Null()]),
  resubmissionAllowed: Type.Boolean(),
  attachments: Type.Array(HomeworkAttachmentItemSchema),
  mySubmissionFiles: Type.Array(HomeworkSubmissionFileSchema),
  mySubmissionText: Type.Union([Type.String(), Type.Null()]),
});
export type StudentHomeworkItemDto = Static<typeof StudentHomeworkItemDtoSchema>;

export const UploadAttachmentBodySchema = Type.Object({
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  fileSizeBytes: Type.Number({ minimum: 1, maximum: 26214400 }),
  mimeType: Type.String({ minLength: 3, maxLength: 127 }),
  contentBase64: Type.Optional(Type.String()),
});
export type UploadAttachmentBody = Static<typeof UploadAttachmentBodySchema>;

export const UploadAttachmentResponseSchema = Type.Object({
  id: Type.String(),
  fileId: Type.String(),
  fileName: Type.String(),
  fileSizeBytes: Type.Number(),
  mimeType: Type.String(),
});
export type UploadAttachmentResponse = Static<typeof UploadAttachmentResponseSchema>;

export const AttachmentDownloadResponseSchema = Type.Object({
  fileId: Type.String(),
  fileName: Type.String(),
  mimeType: Type.String(),
  fileSizeBytes: Type.Number(),
  downloadUrl: Type.String(),
  contentBase64: Type.Optional(Type.String()),
});
export type AttachmentDownloadResponse = Static<typeof AttachmentDownloadResponseSchema>;

export const AvailableDocumentItemSchema = Type.Object({
  id: Type.String(),
  fileName: Type.String(),
  fileSizeBytes: Type.Number(),
  mimeType: Type.String(),
  createdAt: Type.String(),
});
export type AvailableDocumentItem = Static<typeof AvailableDocumentItemSchema>;
