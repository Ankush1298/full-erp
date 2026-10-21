import { z } from 'zod';
import type { ApiClient } from './client';

/** Typed access to the Milestone 3 academic structure and enrolment endpoints (/academics, /students/:id/term-enrollments). */

const List = <T extends z.ZodType>(item: T) =>
  z.object({ success: z.boolean(), data: z.array(item) });
const One = <T extends z.ZodType>(item: T) => z.object({ success: z.boolean(), data: item });
const Created = z.object({ success: z.boolean(), data: z.object({ id: z.string() }) });

export const AcademicYearSchema = z.object({
  id: z.string(),
  label: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['PLANNED', 'ACTIVE', 'CLOSED']),
  version: z.number(),
});
export type AcademicYear = z.infer<typeof AcademicYearSchema>;

export const TermSchema = z.object({
  id: z.string(),
  campusId: z.string(),
  academicYearId: z.string(),
  code: z.string(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['PLANNED', 'ACTIVE', 'CLOSED', 'LOCKED']),
  version: z.number(),
});
export type Term = z.infer<typeof TermSchema>;

export const CourseSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  credits: z.number(),
  courseType: z.string(),
  tracksAttendance: z.boolean(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  owningDepartmentId: z.string().nullable(),
  version: z.number(),
});
export type Course = z.infer<typeof CourseSchema>;

export const CohortPeriodSchema = z.object({
  id: z.string(),
  cohortId: z.string(),
  termId: z.string(),
  periodNo: z.number(),
  isExtension: z.boolean(),
  status: z.enum(['ACTIVE', 'CLOSED']),
  version: z.number(),
});
export type CohortPeriod = z.infer<typeof CohortPeriodSchema>;

export const SectionSchema = z.object({
  id: z.string(),
  cohortPeriodId: z.string(),
  name: z.string(),
  capacity: z.number().nullable(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  memberCount: z.number(),
  version: z.number(),
});
export type Section = z.infer<typeof SectionSchema>;

export const RosterEntrySchema = z.object({
  termEnrollmentId: z.string(),
  studentId: z.string(),
  validFrom: z.string(),
  rollNumber: z.string().nullable(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const TermEnrollmentSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  cohortPeriodId: z.string(),
  termId: z.string(),
  periodNo: z.number(),
  status: z.string(),
  enrollmentType: z.string(),
  rollNumber: z.string().nullable(),
  currentSection: z
    .object({ sectionId: z.string(), name: z.string(), validFrom: z.string() })
    .nullable(),
  version: z.number(),
});
export type TermEnrollment = z.infer<typeof TermEnrollmentSchema>;

const ifMatch = (version: number): Record<string, string> => ({ 'If-Match': `"${version}"` });

// ---- reads ----------------------------------------------------------------------------------------------------
export const fetchAcademicYears = (c: ApiClient) =>
  c.get('/academics/academic-years', { schema: List(AcademicYearSchema) }).then((r) => r.data);
export const fetchTerms = (c: ApiClient) =>
  c.get('/academics/terms', { schema: List(TermSchema) }).then((r) => r.data);
export const fetchCourses = (c: ApiClient) =>
  c.get('/academics/courses', { schema: List(CourseSchema) }).then((r) => r.data);
export const fetchCohortPeriods = (c: ApiClient) =>
  c.get('/academics/cohort-periods', { schema: List(CohortPeriodSchema) }).then((r) => r.data);
export const fetchSections = (c: ApiClient) =>
  c.get('/academics/sections', { schema: List(SectionSchema) }).then((r) => r.data);
export const fetchRoster = (c: ApiClient, sectionId: string) =>
  c
    .get(`/academics/sections/${encodeURIComponent(sectionId)}/members`, {
      schema: List(RosterEntrySchema),
    })
    .then((r) => r.data);
export const fetchStudentEnrollments = (c: ApiClient, studentId: string) =>
  c
    .get(`/students/${encodeURIComponent(studentId)}/term-enrollments`, {
      schema: List(TermEnrollmentSchema),
    })
    .then((r) => r.data);

// ---- writes ---------------------------------------------------------------------------------------------------
export const createAcademicYear = (
  c: ApiClient,
  body: { label: string; startDate: string; endDate: string },
) => c.post('/academics/academic-years', { schema: Created, body });

export const setAcademicYearStatus = (c: ApiClient, y: AcademicYear, status: 'ACTIVE' | 'CLOSED') =>
  c.patch(`/academics/academic-years/${encodeURIComponent(y.id)}`, {
    schema: One(AcademicYearSchema),
    body: { status },
    headers: ifMatch(y.version),
  });

export const createTerm = (
  c: ApiClient,
  body: {
    campusId: string;
    academicYearId: string;
    code: string;
    name: string;
    startDate: string;
    endDate: string;
  },
) => c.post('/academics/terms', { schema: Created, body });

export const setTermStatus = (c: ApiClient, t: Term, status: 'ACTIVE' | 'CLOSED') =>
  c.patch(`/academics/terms/${encodeURIComponent(t.id)}`, {
    schema: One(TermSchema),
    body: { status },
    headers: ifMatch(t.version),
  });

export const createCourse = (
  c: ApiClient,
  body: { code: string; title: string; credits: number; courseType: string },
) => c.post('/academics/courses', { schema: Created, body });

export const createSection = (
  c: ApiClient,
  body: { cohortPeriodId: string; name: string; capacity?: number },
) => c.post('/academics/sections', { schema: Created, body });

export const createTermEnrollment = (
  c: ApiClient,
  studentId: string,
  body: { cohortPeriodId: string; rollNumber?: string; reason: string },
  idempotencyKey: string,
) =>
  c.post(`/students/${encodeURIComponent(studentId)}/term-enrollments`, {
    schema: Created,
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });

export const placeInSection = (
  c: ApiClient,
  studentId: string,
  enrollmentId: string,
  body: { sectionId: string; validFrom: string; reason: string },
) =>
  c.post(
    `/students/${encodeURIComponent(studentId)}/term-enrollments/${encodeURIComponent(enrollmentId)}/section`,
    { schema: One(TermEnrollmentSchema), body },
  );
