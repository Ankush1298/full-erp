import { z } from 'zod';
import type { ApiClient } from './client';

export const ParentChildSchema = z.object({
  studentId: z.string(),
  admissionNumber: z.string(),
  displayName: z.string(),
  status: z.string(),
  campusName: z.string().nullable(),
  programName: z.string().nullable(),
  cohortName: z.string().nullable(),
  relation: z.string(),
  isPrimary: z.boolean(),
  canViewAcademics: z.boolean(),
  canReceiveNotifications: z.boolean(),
});
export type ParentChild = z.infer<typeof ParentChildSchema>;

export const ChildSummarySchema = z.object({
  child: ParentChildSchema,
  attendance: z.object({
    rate: z.number(),
    conducted: z.number(),
    present: z.number(),
    absent: z.number(),
  }),
  academics: z.object({
    coursesCount: z.number(),
    todaySchedule: z.array(
      z.object({
        period: z.string(),
        time: z.string(),
        courseName: z.string(),
        facultyName: z.string().optional(),
        room: z.string().optional(),
      }),
    ),
  }),
  examinations: z.object({
    latestPublished: z.array(
      z.object({
        examName: z.string(),
        courseName: z.string(),
        marksObtained: z.number(),
        maxMarks: z.number(),
        grade: z.string(),
        publishedDate: z.string(),
      }),
    ),
  }),
  fees: z.object({
    totalOutstanding: z.number(),
    currency: z.string(),
    nextDue: z
      .object({
        amount: z.number(),
        dueDate: z.string(),
        title: z.string(),
      })
      .optional(),
  }),
});
export type ChildSummary = z.infer<typeof ChildSummarySchema>;

export const AttendanceRecordItemSchema = z.object({
  date: z.string(),
  period: z.string(),
  courseName: z.string(),
  status: z.string(),
  remarks: z.string().optional(),
});
export type AttendanceRecordItem = z.infer<typeof AttendanceRecordItemSchema>;

export const ChildAttendanceSchema = z.object({
  attendanceRate: z.number(),
  totalSessions: z.number(),
  presentCount: z.number(),
  absentCount: z.number(),
  lateCount: z.number(),
  records: z.array(AttendanceRecordItemSchema),
});
export type ChildAttendance = z.infer<typeof ChildAttendanceSchema>;

export const AcademicCourseItemSchema = z.object({
  courseCode: z.string(),
  courseName: z.string(),
  facultyName: z.string().optional(),
});
export type AcademicCourseItem = z.infer<typeof AcademicCourseItemSchema>;

export const TimetableSlotItemSchema = z.object({
  dayOfWeek: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  courseName: z.string(),
  room: z.string().optional(),
});
export type TimetableSlotItem = z.infer<typeof TimetableSlotItemSchema>;

export const ChildAcademicsSchema = z.object({
  courses: z.array(AcademicCourseItemSchema),
  timetable: z.array(TimetableSlotItemSchema),
  homeworkService: z.object({
    status: z.literal('NOT_CONFIGURED'),
    message: z.string(),
  }),
});
export type ChildAcademics = z.infer<typeof ChildAcademicsSchema>;

export const PublishedExamResultSchema = z.object({
  scheduleId: z.string(),
  examName: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  marksObtained: z.number(),
  maxMarks: z.number(),
  grade: z.string(),
  publishedDate: z.string(),
});
export type PublishedExamResult = z.infer<typeof PublishedExamResultSchema>;

export const UpcomingExamItemSchema = z.object({
  examName: z.string(),
  courseName: z.string(),
  date: z.string(),
  time: z.string(),
});
export type UpcomingExamItem = z.infer<typeof UpcomingExamItemSchema>;

export const ChildExaminationsSchema = z.object({
  publishedResults: z.array(PublishedExamResultSchema),
  upcomingExams: z.array(UpcomingExamItemSchema),
});
export type ChildExaminations = z.infer<typeof ChildExaminationsSchema>;

export const DueItemSchema = z.object({
  id: z.string(),
  dueNumber: z.string(),
  title: z.string(),
  dueDate: z.string(),
  netAmount: z.number(),
  paidAmount: z.number(),
  balanceAmount: z.number(),
  status: z.string(),
});
export type DueItem = z.infer<typeof DueItemSchema>;

export const ReceiptItemSchema = z.object({
  receiptNumber: z.string(),
  receiptDate: z.string(),
  amount: z.number(),
  paymentMode: z.string(),
  status: z.string(),
});
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;

export const ChildFeesSchema = z.object({
  summary: z.object({
    totalBilled: z.number(),
    totalPaid: z.number(),
    totalOutstanding: z.number(),
    currency: z.string(),
  }),
  dues: z.array(DueItemSchema),
  receipts: z.array(ReceiptItemSchema),
});
export type ChildFees = z.infer<typeof ChildFeesSchema>;

export async function fetchParentChildren(c: ApiClient): Promise<ParentChild[]> {
  const res = await c.get('/v1/parent/children', {
    schema: z.object({
      success: z.boolean(),
      data: z.array(ParentChildSchema),
    }),
  });
  return res.data;
}

export async function fetchChildSummary(c: ApiClient, childId: string): Promise<ChildSummary> {
  const res = await c.get(`/v1/parent/children/${encodeURIComponent(childId)}/summary`, {
    schema: z.object({
      success: z.boolean(),
      data: ChildSummarySchema,
    }),
  });
  return res.data;
}

export async function fetchChildAttendance(
  c: ApiClient,
  childId: string,
): Promise<ChildAttendance> {
  const res = await c.get(`/v1/parent/children/${encodeURIComponent(childId)}/attendance`, {
    schema: z.object({
      success: z.boolean(),
      data: ChildAttendanceSchema,
    }),
  });
  return res.data;
}

export async function fetchChildAcademics(c: ApiClient, childId: string): Promise<ChildAcademics> {
  const res = await c.get(`/v1/parent/children/${encodeURIComponent(childId)}/academics`, {
    schema: z.object({
      success: z.boolean(),
      data: ChildAcademicsSchema,
    }),
  });
  return res.data;
}

export async function fetchChildExaminations(
  c: ApiClient,
  childId: string,
): Promise<ChildExaminations> {
  const res = await c.get(`/v1/parent/children/${encodeURIComponent(childId)}/examinations`, {
    schema: z.object({
      success: z.boolean(),
      data: ChildExaminationsSchema,
    }),
  });
  return res.data;
}

export async function fetchChildFees(c: ApiClient, childId: string): Promise<ChildFees> {
  const res = await c.get(`/v1/parent/children/${encodeURIComponent(childId)}/fees`, {
    schema: z.object({
      success: z.boolean(),
      data: ChildFeesSchema,
    }),
  });
  return res.data;
}
