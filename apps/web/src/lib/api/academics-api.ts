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
// Milestone 3 Batch 2 (doc 31): read-only offerings grid and weekly timetable.
export const OfferingSchema = z.object({
  id: z.string(),
  termId: z.string(),
  courseId: z.string(),
  cohortPeriodId: z.string().nullable(),
  sectionId: z.string().nullable(),
  offeringKind: z.string(),
  registrationPolicy: z.string().default('AUTO_FROM_SECTION'),
  groupLabel: z.string().nullable(),
  codeSnapshot: z.string(),
  titleSnapshot: z.string(),
  creditsSnapshot: z.string(),
  capacity: z.number().nullish(),
  electiveGroupId: z.string().nullish(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED']),
  version: z.number(),
});
export type Offering = z.infer<typeof OfferingSchema>;

export const SlotSchema = z.object({
  id: z.string(),
  roomId: z.string().nullable(),
  facultyAssignmentId: z.string().nullable(),
  weekday: z.number().int().min(1).max(7),
  startTime: z.string(),
  endTime: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  version: z.number().default(1),
});
export type Slot = z.infer<typeof SlotSchema>;

export const FacultyAssignmentSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  teachingRole: z.enum(['PRIMARY', 'CO_INSTRUCTOR', 'LAB_INSTRUCTOR', 'SUBSTITUTE']),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  version: z.number().default(1),
});
export type FacultyAssignment = z.infer<typeof FacultyAssignmentSchema>;

export const fetchAcademicYears = (c: ApiClient) =>
  c.get('/v1/academics/academic-years', { schema: List(AcademicYearSchema) }).then((r) => r.data);
export const fetchTerms = (c: ApiClient) =>
  c.get('/v1/academics/terms', { schema: List(TermSchema) }).then((r) => r.data);
export const fetchCourses = (c: ApiClient) =>
  c.get('/v1/academics/courses', { schema: List(CourseSchema) }).then((r) => r.data);
export const fetchCohortPeriods = (c: ApiClient) =>
  c.get('/v1/academics/cohort-periods', { schema: List(CohortPeriodSchema) }).then((r) => r.data);
export const fetchSections = (c: ApiClient) =>
  c.get('/v1/academics/sections', { schema: List(SectionSchema) }).then((r) => r.data);
export const fetchRoster = (c: ApiClient, sectionId: string) =>
  c
    .get(`/v1/academics/sections/${encodeURIComponent(sectionId)}/members`, {
      schema: List(RosterEntrySchema),
    })
    .then((r) => r.data);
export const fetchStudentEnrollments = (c: ApiClient, studentId: string) =>
  c
    .get(`/v1/students/${encodeURIComponent(studentId)}/term-enrollments`, {
      schema: List(TermEnrollmentSchema),
    })
    .then((r) => r.data);

// ---- writes ---------------------------------------------------------------------------------------------------
export const createAcademicYear = (
  c: ApiClient,
  body: { label: string; startDate: string; endDate: string },
) => c.post('/v1/academics/academic-years', { schema: Created, body });

export const setAcademicYearStatus = (c: ApiClient, y: AcademicYear, status: 'ACTIVE' | 'CLOSED') =>
  c.patch(`/v1/academics/academic-years/${encodeURIComponent(y.id)}`, {
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
) => c.post('/v1/academics/terms', { schema: Created, body });

export const setTermStatus = (c: ApiClient, t: Term, status: 'ACTIVE' | 'CLOSED') =>
  c.patch(`/v1/academics/terms/${encodeURIComponent(t.id)}`, {
    schema: One(TermSchema),
    body: { status },
    headers: ifMatch(t.version),
  });

export const createCourse = (
  c: ApiClient,
  body: { code: string; title: string; credits: number; courseType: string },
) => c.post('/v1/academics/courses', { schema: Created, body });

export const createSection = (
  c: ApiClient,
  body: { cohortPeriodId: string; name: string; capacity?: number },
) => c.post('/v1/academics/sections', { schema: Created, body });

export const createTermEnrollment = (
  c: ApiClient,
  studentId: string,
  body: { cohortPeriodId: string; rollNumber?: string; reason: string },
  idempotencyKey: string,
) =>
  c.post(`/v1/students/${encodeURIComponent(studentId)}/term-enrollments`, {
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
    `/v1/students/${encodeURIComponent(studentId)}/term-enrollments/${encodeURIComponent(enrollmentId)}/section`,
    { schema: One(TermEnrollmentSchema), body },
  );

export const fetchOfferings = (c: ApiClient, termId: string) =>
  c
    .get(`/v1/academics/course-offerings?termId=${encodeURIComponent(termId)}`, {
      schema: List(OfferingSchema),
    })
    .then((r) => r.data);
export const fetchSlots = (c: ApiClient, offeringId: string) =>
  c
    .get(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/timetable-slots`, {
      schema: List(SlotSchema),
    })
    .then((r) => r.data);
export const fetchFacultyAssignments = (c: ApiClient, offeringId: string) =>
  c
    .get(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/faculty-assignments`, {
      schema: List(FacultyAssignmentSchema),
    })
    .then((r) => r.data);

export const createOffering = (
  c: ApiClient,
  body: {
    termId: string;
    courseId: string;
    offeringKind: Offering['offeringKind'];
    registrationPolicy: 'AUTO_FROM_SECTION' | 'MANUAL' | 'ELECTIVE_CHOICE' | 'ADMIN_ASSIGNED';
    cohortPeriodId?: string;
    sectionId?: string;
    groupLabel?: string;
    capacity?: number;
    electiveGroupId?: string;
  },
) => c.post('/v1/academics/course-offerings', { schema: Created, body });

export const updateOffering = (
  c: ApiClient,
  o: Offering,
  body: {
    status?: 'PUBLISHED' | 'CLOSED' | 'CANCELLED';
    capacity?: number | null;
    reason?: string;
  },
) =>
  c.patch(`/v1/academics/course-offerings/${encodeURIComponent(o.id)}`, {
    schema: One(OfferingSchema),
    body,
    headers: ifMatch(o.version),
  });

export const createFacultyAssignment = (
  c: ApiClient,
  offeringId: string,
  body: {
    employeeId: string;
    teachingRole: FacultyAssignment['teachingRole'];
    validFrom: string;
    validTo?: string;
    reason: string;
  },
) =>
  c.post(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/faculty-assignments`, {
    schema: Created,
    body,
  });

export const endFacultyAssignment = (
  c: ApiClient,
  a: FacultyAssignment,
  body: { validTo: string; reason: string },
) =>
  c.patch(`/v1/academics/faculty-assignments/${encodeURIComponent(a.id)}`, {
    schema: One(FacultyAssignmentSchema),
    body,
    headers: ifMatch(a.version),
  });

export const createSlot = (
  c: ApiClient,
  offeringId: string,
  body: {
    weekday: number;
    startTime: string;
    endTime: string;
    effectiveFrom: string;
    effectiveTo?: string;
    roomId?: string;
    facultyAssignmentId?: string;
  },
) =>
  c.post(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/timetable-slots`, {
    schema: Created,
    body,
  });

export const endSlot = (c: ApiClient, s: Slot, body: { effectiveTo: string }) =>
  c.patch(`/v1/academics/timetable-slots/${encodeURIComponent(s.id)}`, {
    schema: One(SlotSchema),
    body,
    headers: ifMatch(s.version),
  });

export const FromSectionResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ created: z.number(), alreadyRegistered: z.number() }),
});
export type FromSectionResult = z.infer<typeof FromSectionResponseSchema>['data'];

export const registerFromSection = (
  c: ApiClient,
  offeringId: string,
  body: { validFrom: string; reason: string },
) =>
  c
    .post(
      `/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/registrations/from-section`,
      {
        schema: FromSectionResponseSchema,
        body,
      },
    )
    .then((r) => r.data);

// ---- class teachers and progression (doc 32) -------------------------------------------------------------------
export const ClassTeacherSchema = z.object({
  id: z.string(),
  sectionId: z.string(),
  employeeId: z.string(),
  classTeacherRole: z.enum(['PRIMARY', 'ASSISTANT']),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  version: z.number(),
});
export type ClassTeacher = z.infer<typeof ClassTeacherSchema>;

export const fetchClassTeachers = (c: ApiClient, sectionId: string) =>
  c
    .get(`/v1/academics/sections/${encodeURIComponent(sectionId)}/class-teachers`, {
      schema: List(ClassTeacherSchema),
    })
    .then((r) => r.data);

export const assignClassTeacher = (
  c: ApiClient,
  sectionId: string,
  body: {
    employeeId: string;
    classTeacherRole: 'PRIMARY' | 'ASSISTANT';
    validFrom: string;
    reason: string;
  },
) =>
  c.post(`/v1/academics/sections/${encodeURIComponent(sectionId)}/class-teachers`, {
    schema: Created,
    body,
  });

export const endClassTeacher = (
  c: ApiClient,
  t: ClassTeacher,
  body: { validTo: string; reason: string },
) =>
  c.patch(`/v1/academics/class-teachers/${encodeURIComponent(t.id)}`, {
    schema: One(ClassTeacherSchema),
    body,
    headers: ifMatch(t.version),
  });

/** PROMOTE: next period of the same cohort; REPEAT: the same period with a later cohort. One reason, one key. */
export const progressEnrollment = (
  c: ApiClient,
  studentId: string,
  enrollmentId: string,
  body: { decision: 'PROMOTE' | 'REPEAT'; cohortPeriodId: string; reason: string },
  idempotencyKey: string,
) =>
  c.post(
    `/v1/students/${encodeURIComponent(studentId)}/term-enrollments/${encodeURIComponent(enrollmentId)}/progression`,
    { schema: Created, body, headers: { 'Idempotency-Key': idempotencyKey } },
  );

// ---- Milestone 3 Batch 3 (doc 33): electives, registrations, holidays, terminology, setup checklist -------------
export const ElectiveGroupSchema = z.object({
  id: z.string(),
  cohortPeriodId: z.string(),
  code: z.string(),
  name: z.string(),
  minSelect: z.number(),
  maxSelect: z.number(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  status: z.enum(['PLANNED', 'OPEN', 'CLOSED']),
  version: z.number(),
});
export type ElectiveGroup = z.infer<typeof ElectiveGroupSchema>;

export const RegistrationSchema = z.object({
  id: z.string(),
  termEnrollmentId: z.string(),
  studentId: z.string(),
  courseOfferingId: z.string(),
  electiveGroupId: z.string().nullable(),
  status: z.enum([
    'PENDING_APPROVAL',
    'REGISTERED',
    'REJECTED',
    'DROPPED',
    'WITHDRAWN',
    'COMPLETED',
  ]),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  source: z.string(),
  registrationKind: z.string(),
  version: z.number(),
});
export type Registration = z.infer<typeof RegistrationSchema>;
/** A registration that still counts against capacity and max_select: live ⇔ open (doc 33 §3). */
export const isLive = (r: Registration) => r.validTo === null;

export const fetchElectiveGroups = (c: ApiClient, cohortPeriodId: string) =>
  c
    .get(`/v1/academics/cohort-periods/${encodeURIComponent(cohortPeriodId)}/elective-groups`, {
      schema: List(ElectiveGroupSchema),
    })
    .then((r) => r.data);

export const createElectiveGroup = (
  c: ApiClient,
  cohortPeriodId: string,
  body: {
    code: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    opensAt?: string;
    closesAt?: string;
    reason: string;
  },
) =>
  c.post(`/v1/academics/cohort-periods/${encodeURIComponent(cohortPeriodId)}/elective-groups`, {
    schema: Created,
    body,
  });

export const updateElectiveGroup = (
  c: ApiClient,
  g: ElectiveGroup,
  body: {
    name?: string;
    minSelect?: number;
    maxSelect?: number;
    opensAt?: string | null;
    closesAt?: string | null;
    status?: 'OPEN' | 'CLOSED';
    reason: string;
  },
) =>
  c.patch(`/v1/academics/elective-groups/${encodeURIComponent(g.id)}`, {
    schema: One(ElectiveGroupSchema),
    body,
    headers: ifMatch(g.version),
  });

export const fetchOfferingRegistrations = (c: ApiClient, offeringId: string) =>
  c
    .get(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/registrations`, {
      schema: List(RegistrationSchema),
    })
    .then((r) => r.data);
export const fetchEnrollmentRegistrations = (c: ApiClient, termEnrollmentId: string) =>
  c
    .get(
      `/v1/academics/term-enrollments/${encodeURIComponent(termEnrollmentId)}/course-registrations`,
      {
        schema: List(RegistrationSchema),
      },
    )
    .then((r) => r.data);

export const createRegistration = (
  c: ApiClient,
  offeringId: string,
  body: {
    termEnrollmentId: string;
    validFrom: string;
    source: 'MANUAL' | 'ELECTIVE_CHOICE' | 'ADMIN';
    pendingApproval?: boolean;
    reason: string;
  },
) =>
  c.post(`/v1/academics/course-offerings/${encodeURIComponent(offeringId)}/registrations`, {
    schema: Created,
    body,
  });

export const updateRegistration = (
  c: ApiClient,
  r: Registration,
  body: {
    status: 'REGISTERED' | 'REJECTED' | 'DROPPED' | 'WITHDRAWN' | 'COMPLETED';
    validTo?: string;
    reason: string;
  },
) =>
  c.patch(`/v1/academics/course-registrations/${encodeURIComponent(r.id)}`, {
    schema: One(RegistrationSchema),
    body,
    headers: ifMatch(r.version),
  });

export const HolidaySchema = z.object({
  id: z.string(),
  campusId: z.string().nullable(),
  holidayDate: z.string(),
  name: z.string(),
  kind: z.enum(['HOLIDAY', 'NON_TEACHING_DAY', 'EVENT']),
  status: z.enum(['ACTIVE', 'CANCELLED']),
  version: z.number(),
});
export type Holiday = z.infer<typeof HolidaySchema>;

/** Without campusId: organization-wide rows plus campus rows in the caller's scope; with it: that campus's calendar. */
export const fetchHolidays = (
  c: ApiClient,
  q: { campusId?: string; from?: string; to?: string },
) => {
  const p = new URLSearchParams({ includeCancelled: 'true' });
  if (q.campusId) p.set('campusId', q.campusId);
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  return c
    .get(`/v1/academics/holidays?${p.toString()}`, { schema: List(HolidaySchema) })
    .then((r) => r.data);
};

export const createHoliday = (
  c: ApiClient,
  body: {
    campusId?: string;
    holidayDate: string;
    name: string;
    kind: Holiday['kind'];
    reason: string;
  },
) => c.post('/v1/academics/holidays', { schema: Created, body });

export const updateHoliday = (
  c: ApiClient,
  h: Holiday,
  body: { name?: string; status?: 'CANCELLED'; reason: string },
) =>
  c.patch(`/v1/academics/holidays/${encodeURIComponent(h.id)}`, {
    schema: One(HolidaySchema),
    body,
    headers: ifMatch(h.version),
  });

export const TERMINOLOGY_SLOTS = [
  'program',
  'cohort',
  'period',
  'section',
  'term',
  'course',
] as const;
export type Terminology = Record<(typeof TERMINOLOGY_SLOTS)[number], string>;
/** The server's own fallbacks (doc 33 §6), used while the labels load or when they cannot be read. */
export const DEFAULT_TERMINOLOGY: Terminology = {
  program: 'Programme',
  cohort: 'Batch',
  period: 'Semester',
  section: 'Section',
  term: 'Term',
  course: 'Course',
};
const TerminologySchema = z.object({
  success: z.boolean(),
  data: z.object({
    labels: z.object({
      program: z.string().min(1),
      cohort: z.string().min(1),
      period: z.string().min(1),
      section: z.string().min(1),
      term: z.string().min(1),
      course: z.string().min(1),
    }),
    customised: z.array(z.string()),
    // Task 8 (doc 35 §4): absent from older servers, hence the defaults.
    periodTypes: z
      .array(
        z.object({
          id: z.string(),
          code: z.string(),
          periodTypeLabel: z.string(),
          label: z.string(),
          customised: z.boolean(),
        }),
      )
      .default([]),
    byCohort: z.record(z.string(), z.string()).default({}),
  }),
});
export type TerminologyDetail = z.infer<typeof TerminologySchema>['data'];
export const fetchTerminologyDetail = (c: ApiClient) =>
  c.get('/v1/academics/terminology', { schema: TerminologySchema }).then((r) => r.data);
export const fetchTerminology = (c: ApiClient) => fetchTerminologyDetail(c).then((d) => d.labels);

// ---- setup wizard (Task 8, doc 35): existing create endpoints the wizard's forms call --------------------------
export const ProgramSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  periodTypeId: z.string(),
  name: z.string(),
  code: z.string(),
  durationPeriods: z.number(),
  status: z.string(),
});
export type Program = z.infer<typeof ProgramSchema>;
export const CohortSchema = z.object({
  id: z.string(),
  programId: z.string(),
  name: z.string(),
  admissionYear: z.number(),
  status: z.string(),
});
export type Cohort = z.infer<typeof CohortSchema>;
export const fetchPrograms = (c: ApiClient) =>
  c.get('/v1/academics/programs', { schema: List(ProgramSchema) }).then((r) => r.data);
export const fetchCohorts = (c: ApiClient) =>
  c.get('/v1/academics/cohorts', { schema: List(CohortSchema) }).then((r) => r.data);
export const createPeriodType = (
  c: ApiClient,
  body: { code: string; label: string; labelPlural: string },
) => c.post('/v1/academics/period-types', { schema: Created, body });
export const createProgram = (
  c: ApiClient,
  body: {
    departmentId: string;
    periodTypeId: string;
    name: string;
    code: string;
    degreeLevel: string;
    durationPeriods: number;
    periodsPerYear?: number;
  },
) => c.post('/v1/academics/programs', { schema: Created, body });
export const createCohort = (
  c: ApiClient,
  body: { programId: string; admissionYear: number; name: string },
) => c.post('/v1/academics/cohorts', { schema: Created, body });
export const createCohortPeriod = (
  c: ApiClient,
  body: { cohortId: string; termId: string; periodNo: number },
) => c.post('/v1/academics/cohort-periods', { schema: Created, body });
export const createCurriculumCourse = (
  c: ApiClient,
  body: {
    programId: string;
    courseId: string;
    regulation: string;
    periodNo: number;
    category: string;
  },
) => c.post('/v1/academics/curriculum-courses', { schema: Created, body });

// ---- setup wizard (Task 8, doc 35) ------------------------------------------------------------------------------
const IssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['ERROR', 'WARNING']),
  count: z.number(),
});
export type WizardIssue = z.infer<typeof IssueSchema>;
const WizardSchema = z.object({
  organizationName: z.string(),
  terminologyCustomised: z.boolean(),
  requiredSteps: z.number(),
  requiredComplete: z.number(),
  steps: z.array(
    z.object({
      key: z.string(),
      required: z.boolean(),
      status: z.enum(['COMPLETE', 'ATTENTION', 'INCOMPLETE']),
      counts: z.record(z.string(), z.number()),
      issues: z.array(IssueSchema),
    }),
  ),
  campuses: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      status: z.string(),
      departments: z.number(),
      openTerms: z.number(),
      openSections: z.number(),
      postedEmployees: z.number(),
      rooms: z.number(),
      campusHolidays: z.number(),
    }),
  ),
  terms: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      status: z.string(),
      version: z.number(),
      startDate: z.string(),
      endDate: z.string(),
      campusId: z.string(),
      campusName: z.string(),
      academicYearId: z.string(),
      academicYearLabel: z.string(),
      academicYearStatus: z.string(),
      activatable: z.boolean(),
      blocking: z.array(IssueSchema),
      warnings: z.array(IssueSchema),
    }),
  ),
});
export type Wizard = z.infer<typeof WizardSchema>;
export type WizardStep = Wizard['steps'][number];
export type WizardTerm = Wizard['terms'][number];
export const fetchSetupWizard = (c: ApiClient) =>
  c.get('/v1/academics/setup-wizard', { schema: One(WizardSchema) }).then((r) => r.data);
/** PLANNED -> ACTIVE after the server re-checks readiness (409 SETUP_INCOMPLETE while anything blocks). */
export const activateTerm = (c: ApiClient, t: { id: string; version: number }, reason?: string) =>
  c.post(`/v1/academics/terms/${encodeURIComponent(t.id)}/activation`, {
    schema: One(TermSchema),
    body: reason ? { reason } : {},
    headers: ifMatch(t.version),
  });

export const ChecklistItemSchema = z.object({
  key: z.string(),
  done: z.boolean(),
  count: z.number(),
  detail: z.string(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export const fetchSetupChecklist = (c: ApiClient) =>
  c
    .get('/v1/academics/setup-checklist', {
      schema: One(z.object({ complete: z.boolean(), items: z.array(ChecklistItemSchema) })),
    })
    .then((r) => r.data);
