import { z } from 'zod';

export const EnrolmentRosterQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  academic_year_id: z.string().uuid().optional(),
  term_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
  cohort_id: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ALL']).default('ACTIVE'),
  format: z.enum(['json', 'csv']).default('json'),
});
export type EnrolmentRosterQuery = z.infer<typeof EnrolmentRosterQuerySchema>;

export const AttendanceSummaryQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .optional(),
  course_offering_id: z.string().uuid().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type AttendanceSummaryQuery = z.infer<typeof AttendanceSummaryQuerySchema>;

export const ExamMarksSummaryQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  examination_id: z.string().uuid().optional(),
  term_id: z.string().uuid().optional(),
  academic_year_id: z.string().uuid().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export type ExamMarksSummaryQuery = z.infer<typeof ExamMarksSummaryQuerySchema>;

export const FeeSummaryQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  academic_year_id: z.string().uuid().optional(),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  format: z.enum(['json', 'csv']).default('json'),
  view: z.enum(['summary', 'defaulters', 'collections']).default('summary'),
});
export type FeeSummaryQuery = z.infer<typeof FeeSummaryQuerySchema>;
