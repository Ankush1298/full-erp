import { z } from 'zod';

export const ExamTypeSchema = z.enum([
  'UNIT_TEST',
  'MID_TERM',
  'FINAL',
  'INTERNAL',
  'SUPPLEMENTARY',
  'OTHER',
]);

export const ExamStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

export const ScheduleStatusSchema = z.enum([
  'SCHEDULED',
  'DRAFT_MARKS',
  'SUBMITTED',
  'PUBLISHED',
  'CANCELLED',
]);

export const MarkStatusSchema = z.enum([
  'ENTERED',
  'ABSENT',
  'EXEMPT',
  'WITHHELD',
]);

export const CreateExaminationSchema = z
  .object({
    campus_id: z.string().uuid(),
    term_id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    exam_type: ExamTypeSchema,
    starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
    ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  })
  .refine((data) => data.ends_on >= data.starts_on, {
    message: 'ends_on must be greater than or equal to starts_on',
    path: ['ends_on'],
  });

export const UpdateExaminationSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    exam_type: ExamTypeSchema.optional(),
    status: ExamStatusSchema.optional(),
    starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
    ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD').optional(),
  })
  .refine(
    (data) => {
      if (data.starts_on && data.ends_on) {
        return data.ends_on >= data.starts_on;
      }
      return true;
    },
    {
      message: 'ends_on must be greater than or equal to starts_on',
      path: ['ends_on'],
    },
  );

export const CreateScheduleSchema = z
  .object({
    course_offering_id: z.string().uuid(),
    exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).optional().nullable(),
    end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).optional().nullable(),
    max_marks: z.coerce.number().positive().max(10000),
    pass_marks: z.coerce.number().min(0).max(10000),
  })
  .refine((data) => data.pass_marks <= data.max_marks, {
    message: 'pass_marks cannot exceed max_marks',
    path: ['pass_marks'],
  });

export const StudentMarkEntrySchema = z
  .object({
    student_id: z.string().uuid(),
    status: MarkStatusSchema.default('ENTERED'),
    marks_obtained: z.coerce.number().min(0).max(10000).optional().nullable(),
    remarks: z.string().max(500).optional().nullable(),
  })
  .refine(
    (entry) => {
      if (entry.status === 'ENTERED') {
        return entry.marks_obtained !== null && entry.marks_obtained !== undefined;
      }
      return true;
    },
    {
      message: 'marks_obtained is required when status is ENTERED',
      path: ['marks_obtained'],
    },
  );

export const SaveMarksSchema = z.object({
  action: z.enum(['DRAFT', 'SUBMIT']).default('DRAFT'),
  entries: z.array(StudentMarkEntrySchema).min(1),
});

export const ListExaminationsQuerySchema = z.object({
  campus_id: z.string().uuid().optional(),
  term_id: z.string().uuid().optional(),
  status: ExamStatusSchema.optional(),
});

export const ListSchedulesQuerySchema = z.object({
  examination_id: z.string().uuid().optional(),
  course_offering_id: z.string().uuid().optional(),
  status: ScheduleStatusSchema.optional(),
});

export type CreateExaminationInput = z.infer<typeof CreateExaminationSchema>;
export type UpdateExaminationInput = z.infer<typeof UpdateExaminationSchema>;
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;
export type StudentMarkEntry = z.infer<typeof StudentMarkEntrySchema>;
export type SaveMarksInput = z.infer<typeof SaveMarksSchema>;
export type ListExaminationsQuery = z.infer<typeof ListExaminationsQuerySchema>;
export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuerySchema>;

