import { z } from 'zod';
import type { ApiClient } from './client';

export const TeacherClassItemSchema = z.object({
  courseOfferingId: z.string(),
  courseId: z.string(),
  courseCode: z.string(),
  courseTitle: z.string(),
  termId: z.string(),
  termName: z.string(),
  campusId: z.string(),
  campusName: z.string(),
  cohortPeriodId: z.string().nullable().optional(),
  cohortName: z.string().nullable().optional(),
  sectionId: z.string().nullable().optional(),
  sectionName: z.string().nullable().optional(),
  teachingRole: z.string(),
  studentCount: z.number(),
});
export type TeacherClassItem = z.infer<typeof TeacherClassItemSchema>;

export const RecipientPreviewItemSchema = z.object({
  studentId: z.string(),
  admissionNumber: z.string(),
  displayName: z.string(),
  rollNumber: z.string().nullable().optional(),
  sectionName: z.string().nullable().optional(),
});
export type RecipientPreviewItem = z.infer<typeof RecipientPreviewItemSchema>;

export const RecipientPreviewResponseSchema = z.object({
  totalCount: z.number(),
  courseTitle: z.string(),
  sectionName: z.string().nullable().optional(),
  students: z.array(RecipientPreviewItemSchema),
});
export type RecipientPreviewResponse = z.infer<typeof RecipientPreviewResponseSchema>;

export const HomeworkAttachmentSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  mimeType: z.string(),
});
export type HomeworkAttachment = z.infer<typeof HomeworkAttachmentSchema>;

export const HomeworkSubmissionFileSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  mimeType: z.string(),
});
export type HomeworkSubmissionFile = z.infer<typeof HomeworkSubmissionFileSchema>;

export const HomeworkDetailDtoSchema = z.object({
  id: z.string(),
  courseOfferingId: z.string(),
  courseCode: z.string(),
  courseTitle: z.string(),
  sectionId: z.string().nullable().optional(),
  sectionName: z.string().nullable().optional(),
  teacherName: z.string(),
  teacherEmployeeId: z.string(),
  title: z.string(),
  instructions: z.string(),
  submissionType: z.enum(['OFFLINE', 'ONLINE']),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED']),
  dueDate: z.string().nullable().optional(),
  dueTime: z.string().nullable().optional(),
  maxMarks: z.number().nullable().optional(),
  allowResubmission: z.boolean(),
  publishedAt: z.string().nullable().optional(),
  closedAt: z.string().nullable().optional(),
  totalRecipients: z.number(),
  submittedCount: z.number(),
  pendingCount: z.number(),
  reviewedCount: z.number(),
  lateCount: z.number(),
  attachments: z.array(HomeworkAttachmentSchema),
  createdAt: z.string(),
});
export type HomeworkDetailDto = z.infer<typeof HomeworkDetailDtoSchema>;

export const SubmissionListItemSchema = z.object({
  id: z.string().nullable().optional(),
  studentId: z.string(),
  admissionNumber: z.string(),
  studentName: z.string(),
  rollNumber: z.string().nullable().optional(),
  status: z.string(),
  submissionText: z.string().nullable().optional(),
  submittedAt: z.string().nullable().optional(),
  evaluatedAt: z.string().nullable().optional(),
  marksObtained: z.number().nullable().optional(),
  grade: z.string().nullable().optional(),
  feedback: z.string().nullable().optional(),
  resubmissionAllowed: z.boolean(),
  resubmissionCount: z.number(),
  files: z.array(HomeworkSubmissionFileSchema),
});
export type SubmissionListItem = z.infer<typeof SubmissionListItemSchema>;

export const StudentHomeworkItemSchema = z.object({
  id: z.string(),
  courseOfferingId: z.string(),
  courseCode: z.string(),
  courseTitle: z.string(),
  sectionName: z.string().nullable().optional(),
  teacherName: z.string(),
  title: z.string(),
  instructions: z.string(),
  submissionType: z.enum(['OFFLINE', 'ONLINE']),
  dueDate: z.string().nullable().optional(),
  dueTime: z.string().nullable().optional(),
  maxMarks: z.number().nullable().optional(),
  status: z.string(),
  submissionStatus: z.string(),
  submittedAt: z.string().nullable().optional(),
  evaluatedAt: z.string().nullable().optional(),
  marksObtained: z.number().nullable().optional(),
  grade: z.string().nullable().optional(),
  feedback: z.string().nullable().optional(),
  resubmissionAllowed: z.boolean(),
  attachments: z.array(HomeworkAttachmentSchema),
  mySubmissionFiles: z.array(HomeworkSubmissionFileSchema),
  mySubmissionText: z.string().nullable().optional(),
});
export type StudentHomeworkItem = z.infer<typeof StudentHomeworkItemSchema>;

export interface CreateHomeworkInput {
  courseOfferingId: string;
  sectionId?: string | undefined;
  title: string;
  instructions: string;
  submissionType: 'OFFLINE' | 'ONLINE';
  dueDate?: string | undefined;
  dueTime?: string | undefined;
  maxMarks?: number | undefined;
  allowResubmission?: boolean | undefined;
  publishNow?: boolean | undefined;
  attachments?:
    | {
        fileId: string;
        fileName: string;
        fileSizeBytes: number;
        mimeType: string;
      }[]
    | undefined;
}

export interface UpdateHomeworkInput {
  title?: string | undefined;
  instructions?: string | undefined;
  submissionType?: ('OFFLINE' | 'ONLINE') | undefined;
  dueDate?: string | undefined;
  dueTime?: string | undefined;
  maxMarks?: number | undefined;
  allowResubmission?: boolean | undefined;
}

export interface ReviewSubmissionInput {
  status?: ('REVIEWED' | 'RESUBMISSION_REQUESTED' | 'COMPLETED') | undefined;
  marksObtained?: number | undefined;
  grade?: string | undefined;
  feedback?: string | undefined;
  resubmissionAllowed?: boolean | undefined;
}

export interface SubmitHomeworkInput {
  submissionText?: string | undefined;
  files?:
    | {
        fileId: string;
        fileName: string;
        fileSizeBytes: number;
        mimeType: string;
      }[]
    | undefined;
}

// ─── API Client Functions ───────────────────────────────────────────────────

export async function fetchTeacherClasses(c: ApiClient): Promise<TeacherClassItem[]> {
  const res = await c.get('/v1/homework/teacher/classes', {
    schema: z.object({
      success: z.boolean(),
      data: z.array(TeacherClassItemSchema),
    }),
  });
  return res.data;
}

export async function previewRecipients(
  c: ApiClient,
  courseOfferingId: string,
  sectionId?: string,
): Promise<RecipientPreviewResponse> {
  const qs = new URLSearchParams({ courseOfferingId });
  if (sectionId) qs.set('sectionId', sectionId);
  const res = await c.get(`/v1/homework/teacher/preview-recipients?${qs.toString()}`, {
    schema: z.object({
      success: z.boolean(),
      data: RecipientPreviewResponseSchema,
    }),
  });
  return res.data;
}

export async function fetchTeacherHomework(
  c: ApiClient,
  filter?: { courseOfferingId?: string; sectionId?: string; status?: string },
): Promise<HomeworkDetailDto[]> {
  const qs = new URLSearchParams();
  if (filter?.courseOfferingId) qs.set('courseOfferingId', filter.courseOfferingId);
  if (filter?.sectionId) qs.set('sectionId', filter.sectionId);
  if (filter?.status) qs.set('status', filter.status);
  const qStr = qs.toString() ? `?${qs.toString()}` : '';

  const res = await c.get(`/v1/homework/teacher/assignments${qStr}`, {
    schema: z.object({
      success: z.boolean(),
      data: z.array(HomeworkDetailDtoSchema),
    }),
  });
  return res.data;
}

export async function createHomework(
  c: ApiClient,
  input: CreateHomeworkInput,
): Promise<HomeworkDetailDto> {
  const res = await c.post('/v1/homework/teacher/assignments', {
    body: input,
    schema: z.object({
      success: z.boolean(),
      data: HomeworkDetailDtoSchema,
    }),
  });
  return res.data;
}

export async function updateHomework(
  c: ApiClient,
  homeworkId: string,
  input: UpdateHomeworkInput,
): Promise<void> {
  await c.patch(`/v1/homework/teacher/assignments/${encodeURIComponent(homeworkId)}`, {
    body: input,
    schema: z.object({
      success: z.boolean(),
    }),
  });
}

export async function publishHomework(c: ApiClient, homeworkId: string): Promise<void> {
  await c.post(`/v1/homework/teacher/assignments/${encodeURIComponent(homeworkId)}/publish`, {
    schema: z.object({
      success: z.boolean(),
    }),
  });
}

export async function closeHomework(c: ApiClient, homeworkId: string): Promise<void> {
  await c.post(`/v1/homework/teacher/assignments/${encodeURIComponent(homeworkId)}/close`, {
    schema: z.object({
      success: z.boolean(),
    }),
  });
}

export async function fetchHomeworkSubmissions(
  c: ApiClient,
  homeworkId: string,
): Promise<SubmissionListItem[]> {
  const res = await c.get(
    `/v1/homework/teacher/assignments/${encodeURIComponent(homeworkId)}/submissions`,
    {
      schema: z.object({
        success: z.boolean(),
        data: z.array(SubmissionListItemSchema),
      }),
    },
  );
  return res.data;
}

export async function reviewSubmission(
  c: ApiClient,
  submissionId: string,
  input: ReviewSubmissionInput,
): Promise<void> {
  await c.post(
    `/v1/homework/teacher/submissions/${encodeURIComponent(submissionId)}/review`,
    {
      body: input,
      schema: z.object({
        success: z.boolean(),
      }),
    },
  );
}

export async function fetchStudentHomework(c: ApiClient): Promise<StudentHomeworkItem[]> {
  const res = await c.get('/v1/homework/student/assignments', {
    schema: z.object({
      success: z.boolean(),
      data: z.array(StudentHomeworkItemSchema),
    }),
  });
  return res.data;
}

export async function submitHomework(
  c: ApiClient,
  homeworkId: string,
  input: SubmitHomeworkInput,
): Promise<void> {
  await c.post(
    `/v1/homework/student/assignments/${encodeURIComponent(homeworkId)}/submit`,
    {
      body: input,
      schema: z.object({
        success: z.boolean(),
      }),
    },
  );
}

export async function fetchParentStudentHomework(
  c: ApiClient,
  studentId: string,
): Promise<StudentHomeworkItem[]> {
  const res = await c.get(
    `/v1/homework/parent/children/${encodeURIComponent(studentId)}/assignments`,
    {
      schema: z.object({
        success: z.boolean(),
        data: z.array(StudentHomeworkItemSchema),
      }),
    },
  );
  return res.data;
}

export const UploadAttachmentResponseSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  mimeType: z.string(),
});
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponseSchema>;

export const AvailableDocumentItemSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  mimeType: z.string(),
  createdAt: z.string(),
});
export type AvailableDocumentItem = z.infer<typeof AvailableDocumentItemSchema>;

export const AttachmentDownloadResponseSchema = z.object({
  fileId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  fileSizeBytes: z.number(),
  downloadUrl: z.string(),
  contentBase64: z.string().optional(),
});
export type AttachmentDownloadResponse = z.infer<typeof AttachmentDownloadResponseSchema>;

export async function uploadHomeworkAttachment(
  c: ApiClient,
  input: {
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    contentBase64?: string;
  },
): Promise<UploadAttachmentResponse> {
  const res = await c.post('/v1/homework/attachments/upload', {
    body: input,
    schema: z.object({
      success: z.boolean(),
      data: UploadAttachmentResponseSchema,
    }),
  });
  return res.data;
}

export async function fetchAvailableDocuments(c: ApiClient): Promise<AvailableDocumentItem[]> {
  const res = await c.get('/v1/homework/attachments/available-documents', {
    schema: z.object({
      success: z.boolean(),
      data: z.array(AvailableDocumentItemSchema),
    }),
  });
  return res.data;
}

export async function fetchAttachmentDownloadUrl(
  c: ApiClient,
  fileId: string,
): Promise<AttachmentDownloadResponse> {
  const res = await c.get(`/v1/homework/attachments/${encodeURIComponent(fileId)}/download-url`, {
    schema: z.object({
      success: z.boolean(),
      data: AttachmentDownloadResponseSchema,
    }),
  });
  return res.data;
}
