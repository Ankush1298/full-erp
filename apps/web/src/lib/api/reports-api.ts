import { z } from 'zod';
import type { ApiClient } from './client';

export const EnrolmentRosterStudentSchema = z.object({
  student_id: z.string(),
  student_name: z.string(),
  admission_number: z.string(),
  campus_id: z.string(),
  campus_name: z.string(),
  program_id: z.string().nullable().optional(),
  program_name: z.string().nullable().optional(),
  cohort_id: z.string().nullable().optional(),
  cohort_name: z.string().nullable().optional(),
  term_id: z.string().nullable().optional(),
  term_name: z.string().nullable().optional(),
  roll_number: z.string().nullable().optional(),
  enrolment_status: z.string(),
  enrolled_date: z.string().nullable().optional(),
  guardian_count: z.number(),
  primary_guardian_name: z.string().nullable().optional(),
  primary_guardian_phone: z.string().nullable().optional(),
});
export type EnrolmentRosterStudent = z.infer<typeof EnrolmentRosterStudentSchema>;

export const EnrolmentRosterDataSchema = z.object({
  institution_type: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  summary: z.object({
    total_students: z.number(),
    active_students: z.number(),
    campuses_count: z.number(),
  }),
  students: z.array(EnrolmentRosterStudentSchema),
  csv: z.string().optional(),
});
export type EnrolmentRosterData = z.infer<typeof EnrolmentRosterDataSchema>;

export const AttendanceSessionReportSchema = z.object({
  session_id: z.string(),
  campus_id: z.string(),
  campus_name: z.string(),
  course_name: z.string(),
  course_code: z.string(),
  teacher_name: z.string(),
  session_date: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  attendance_state: z.string(),
  present_count: z.number(),
  absent_count: z.number(),
  late_count: z.number(),
  excused_count: z.number(),
  total_marked: z.number(),
  attendance_percentage: z.number(),
});
export type AttendanceSessionReport = z.infer<typeof AttendanceSessionReportSchema>;

export const AttendanceSummaryDataSchema = z.object({
  date: z.string(),
  institution_type: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  summary: z.object({
    total_sessions_scheduled: z.number(),
    total_sessions_conducted: z.number(),
    missing_registers_count: z.number(),
    total_attendance_records: z.number(),
    present_count: z.number(),
    absent_count: z.number(),
    late_count: z.number(),
    excused_count: z.number(),
    attendance_rate: z.number(),
  }),
  sessions: z.array(AttendanceSessionReportSchema),
  csv: z.string().optional(),
});
export type AttendanceSummaryData = z.infer<typeof AttendanceSummaryDataSchema>;

export const ExamScheduleReportSchema = z.object({
  schedule_id: z.string(),
  examination_id: z.string(),
  examination_name: z.string(),
  exam_type: z.string(),
  campus_id: z.string(),
  campus_name: z.string(),
  term_name: z.string(),
  course_name: z.string(),
  course_code: z.string(),
  exam_date: z.string(),
  max_marks: z.number(),
  pass_marks: z.number(),
  appeared_count: z.number(),
  passed_count: z.number(),
  failed_count: z.number(),
  pass_percentage: z.number(),
  highest_marks: z.number(),
  lowest_marks: z.number(),
  average_marks: z.number(),
  published_at: z.string(),
});
export type ExamScheduleReport = z.infer<typeof ExamScheduleReportSchema>;

export const ExamMarksSummaryDataSchema = z.object({
  institution_type: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  summary: z.object({
    total_published_exams: z.number(),
    total_candidates_appeared: z.number(),
    total_passed: z.number(),
    total_failed: z.number(),
    overall_pass_percentage: z.number(),
    average_score: z.number(),
  }),
  schedules: z.array(ExamScheduleReportSchema),
  csv: z.string().optional(),
});
export type ExamMarksSummaryData = z.infer<typeof ExamMarksSummaryDataSchema>;

export const FeeDefaulterRowSchema = z.object({
  student_id: z.string(),
  student_name: z.string(),
  admission_number: z.string(),
  campus_id: z.string(),
  campus_name: z.string(),
  due_number: z.string(),
  fee_structure_name: z.string(),
  due_date: z.string(),
  net_amount: z.number(),
  paid_amount: z.number(),
  balance_amount: z.number(),
  due_status: z.string(),
  has_unverified_receipt: z.boolean(),
});
export type FeeDefaulterRow = z.infer<typeof FeeDefaulterRowSchema>;

export const FeeSummaryDataSchema = z.object({
  currency: z.string(),
  summary: z.object({
    confirmed_collections: z.number(),
    unverified_collections: z.number(),
    total_outstanding_dues: z.number(),
    total_gross_billed: z.number(),
    total_concessions: z.number(),
    total_net_billed: z.number(),
    confirmed_receipt_count: z.number(),
    unverified_receipt_count: z.number(),
    defaulters_count: z.number(),
    collection_efficiency_percentage: z.number(),
  }),
  collections_by_method: z.record(z.string(), z.number()),
  collections_by_status: z.object({
    CONFIRMED: z.number(),
    PENDING_VERIFICATION: z.number(),
    RECORDED: z.number(),
  }),
  defaulters: z.array(FeeDefaulterRowSchema),
  csv: z.string().optional(),
});
export type FeeSummaryData = z.infer<typeof FeeSummaryDataSchema>;

export async function fetchEnrolmentRoster(
  c: ApiClient,
  query?: {
    campus_id?: string;
    term_id?: string;
    program_id?: string;
    cohort_id?: string;
    status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
  },
): Promise<EnrolmentRosterData> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.term_id) params.set('term_id', query.term_id);
  if (query?.program_id) params.set('program_id', query.program_id);
  if (query?.cohort_id) params.set('cohort_id', query.cohort_id);
  if (query?.status) params.set('status', query.status);

  const q = params.toString() ? `?${params.toString()}` : '';
  const res = await c.get(`/v1/reports/enrolment-roster${q}`, {
    schema: z.object({ data: EnrolmentRosterDataSchema }),
  });
  return res.data;
}

export async function fetchAttendanceSummary(
  c: ApiClient,
  query?: {
    campus_id?: string;
    date?: string;
    course_offering_id?: string;
  },
): Promise<AttendanceSummaryData> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.date) params.set('date', query.date);
  if (query?.course_offering_id) params.set('course_offering_id', query.course_offering_id);

  const q = params.toString() ? `?${params.toString()}` : '';
  const res = await c.get(`/v1/reports/attendance-summary${q}`, {
    schema: z.object({ data: AttendanceSummaryDataSchema }),
  });
  return res.data;
}

export async function fetchExamMarksSummary(
  c: ApiClient,
  query?: {
    campus_id?: string;
    examination_id?: string;
    term_id?: string;
  },
): Promise<ExamMarksSummaryData> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.examination_id) params.set('examination_id', query.examination_id);
  if (query?.term_id) params.set('term_id', query.term_id);

  const q = params.toString() ? `?${params.toString()}` : '';
  const res = await c.get(`/v1/reports/exam-performance${q}`, {
    schema: z.object({ data: ExamMarksSummaryDataSchema }),
  });
  return res.data;
}

export async function fetchFeeSummary(
  c: ApiClient,
  query?: {
    campus_id?: string;
    academic_year_id?: string;
    from_date?: string;
    to_date?: string;
  },
): Promise<FeeSummaryData> {
  const params = new URLSearchParams();
  if (query?.campus_id) params.set('campus_id', query.campus_id);
  if (query?.academic_year_id) params.set('academic_year_id', query.academic_year_id);
  if (query?.from_date) params.set('from_date', query.from_date);
  if (query?.to_date) params.set('to_date', query.to_date);

  const q = params.toString() ? `?${params.toString()}` : '';
  const res = await c.get(`/v1/reports/fee-summary${q}`, {
    schema: z.object({ data: FeeSummaryDataSchema }),
  });
  return res.data;
}

export async function downloadReportCsv(
  c: ApiClient,
  reportPath: string,
  filename: string,
): Promise<void> {
  const separator = reportPath.includes('?') ? '&' : '?';
  const prefix = String.fromCharCode(47) + 'v1/reports/';
  const path = `${prefix}${reportPath}${separator}format=csv`;
  const blob = await c.getBlob(path);
  const downloadUrl = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(downloadUrl);
}
