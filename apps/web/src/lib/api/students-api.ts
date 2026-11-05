import { z } from 'zod';
import type { ApiClient } from './client';

/**
 * Typed access to the existing student read endpoints (docs/architecture/v3/21-students.md §0, §0b, §0c; doc 26 §2).
 * Read-only: nothing here creates, updates or removes a student record or identifier. Every scope and tenant rule is the
 * backend's; the client sends no tenant, campus or department and trusts nothing it could invent.
 */

export const STUDENT_STATUSES = [
  'ADMITTED',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'DISCONTINUED',
  'GRADUATED',
  'TRANSFERRED_OUT',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/** Same rule as the backend's ADMISSION_NUMBER_PATTERN; checked here only to avoid a pointless 400. */
export const ADMISSION_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

/** The reviewed five-field selection DTO shared by the lookup and the directory. */
export const StudentDirectoryEntrySchema = z.object({
  id: z.string(),
  admissionNumber: z.string(),
  displayName: z.string(),
  status: z.enum(STUDENT_STATUSES),
  hasActiveEnrolment: z.boolean(),
});
export type StudentDirectoryEntry = z.infer<typeof StudentDirectoryEntrySchema>;

/** GET /students/:id. organizationId, userId and version are parsed but never displayed. */
export const StudentRecordSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  admissionNumber: z.string(),
  admissionDate: z.string().nullable(),
  status: z.enum(STUDENT_STATUSES),
  statusChangedAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudentRecord = z.infer<typeof StudentRecordSchema>;

export const StudentIdentifierSchema = z.object({
  id: z.string(),
  studentId: z.string(),
  idType: z.enum(['UNIVERSITY_PRN', 'APAAR', 'LIBRARY_CARD', 'HOSTEL_ID', 'OTHER']),
  value: z.string(),
  issuer: z.string().nullable(),
  validFrom: z.string().nullable(),
  validTo: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StudentIdentifier = z.infer<typeof StudentIdentifierSchema>;

const DirectoryPageSchema = z.object({
  success: z.literal(true),
  data: z.array(StudentDirectoryEntrySchema),
  page: z.object({ nextCursor: z.string().nullable() }),
});
const LookupSchema = z.object({ success: z.literal(true), data: StudentDirectoryEntrySchema });
const RecordSchema = z.object({ success: z.literal(true), data: StudentRecordSchema });
const IdentifiersSchema = z.object({
  success: z.literal(true),
  data: z.array(StudentIdentifierSchema),
});

/** The backend default page size (DIRECTORY_DEFAULT_LIMIT). */
export const DIRECTORY_PAGE_SIZE = 25;

/**
 * GET /students/directory (permission student.directory.list). Exists only when the server has valid cursor keys AND
 * STUDENT_DIRECTORY_LIST_ENABLED=true; otherwise the path is read as a malformed student id and answers 400. The cursor is
 * opaque and bound by the server to this user and status filter: it is kept in memory only and never stored or put in
 * the page URL.
 */
export async function fetchStudentDirectory(
  client: ApiClient,
  query: { status?: StudentStatus | undefined; cursor?: string | undefined },
): Promise<{ entries: StudentDirectoryEntry[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(DIRECTORY_PAGE_SIZE) });
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  const res = await client.get(`/v1/students/directory?${params.toString()}`, {
    schema: DirectoryPageSchema,
  });
  return { entries: res.data, nextCursor: res.page.nextCursor };
}

/** GET /students?admissionNumber= (permission student.directory.search): exact match, at most one student, else 404. */
export async function lookupStudent(
  client: ApiClient,
  admissionNumber: string,
): Promise<StudentDirectoryEntry> {
  const params = new URLSearchParams({ admissionNumber });
  const res = await client.get(`/v1/students?${params.toString()}`, { schema: LookupSchema });
  return res.data;
}

/** GET /students/:id (permission student.profile.read). Missing, other-tenant and out-of-scope records are one 404. */
export async function fetchStudent(client: ApiClient, id: string): Promise<StudentRecord> {
  const res = await client.get(`/v1/students/${encodeURIComponent(id)}`, { schema: RecordSchema });
  return res.data;
}

/** GET /students/:id/identifiers (permission student.profile.read_sensitive). */
export async function fetchStudentIdentifiers(
  client: ApiClient,
  id: string,
): Promise<StudentIdentifier[]> {
  const res = await client.get(`/v1/students/${encodeURIComponent(id)}/identifiers`, {
    schema: IdentifiersSchema,
  });
  return res.data;
}

// ---- GET /v1/students/:id/timeline (doc 34): read-only timeline and as-of-date position.
export const TIMELINE_EVENT_TYPES = [
  'ADMISSION',
  'STUDENT_STATUS_CHANGED',
  'PROGRAMME_STARTED',
  'PROGRAMME_ENDED',
  'TERM_ENROLLED',
  'REPEAT_ENROLLED',
  'SECTION_PLACED',
  'SECTION_TRANSFERRED',
  'COURSE_REGISTERED',
  'COURSE_REREGISTERED',
  'COURSE_DROPPED',
  'COURSE_WITHDRAWN',
  'COURSE_COMPLETED',
  'COURSE_REJECTED',
  'PROMOTED',
  'DETAINED',
  'TERM_COMPLETED',
  'TERM_WITHDRAWN',
  'TERM_ON_LEAVE',
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
export const TimelineEventSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  eventType: z.enum(TIMELINE_EVENT_TYPES),
  eventDate: z.string().nullable(),
  temporal: z.enum(['CURRENT', 'HISTORICAL', 'UNDATED']),
  description: z.string(),
  programme: Ref.nullable(),
  cohortName: z.string().nullable(),
  term: Ref.nullable(),
  periodNo: z.number().int().nullable(),
  periodLabel: z.string().nullable(),
  section: z.object({ id: z.string(), name: z.string() }).nullable(),
  course: z
    .object({ offeringId: z.string(), code: z.string(), title: z.string(), credits: z.string() })
    .nullable(),
  status: z.string().nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

const PositionTermSchema = z.object({
  termEnrollmentId: z.string(),
  term: Ref.extend({ startDate: z.string(), endDate: z.string() }),
  periodNo: z.number().int(),
  periodLabel: z.string(),
  enrollmentType: z.string(),
  recordedStatus: z.string(),
  rollNumber: z.string().nullable(),
  section: z
    .object({
      id: z.string(),
      name: z.string(),
      validFrom: z.string(),
      validTo: z.string().nullable(),
    })
    .nullable(),
  registrations: z.array(
    z.object({
      registrationId: z.string(),
      offeringId: z.string(),
      code: z.string(),
      title: z.string(),
      credits: z.string(),
      registrationKind: z.string(),
      source: z.string(),
      validFrom: z.string(),
      validTo: z.string().nullable(),
      recordedStatus: z.string(),
      statusOnDate: z.enum(['REGISTERED', 'PENDING_APPROVAL']),
    }),
  ),
});
export type TimelinePositionTerm = z.infer<typeof PositionTermSchema>;

export const StudentTimelineSchema = z.object({
  studentId: z.string(),
  asOfDate: z.string(),
  today: z.string(),
  timezone: z.string(),
  position: z.object({
    admitted: z.boolean().nullable(),
    studentStatus: z.enum(STUDENT_STATUSES).nullable(),
    programme: z
      .object({
        studentProgramId: z.string(),
        id: z.string(),
        name: z.string(),
        code: z.string(),
        cohortId: z.string(),
        cohortName: z.string(),
        entryType: z.string(),
        startDate: z.string(),
        endDate: z.string().nullable(),
      })
      .nullable(),
    terms: z.array(PositionTermSchema),
  }),
  events: z.array(TimelineEventSchema),
  undatedOutcomes: z.array(TimelineEventSchema),
  futureEventsExcluded: z.number().int(),
  limitations: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type StudentTimeline = z.infer<typeof StudentTimelineSchema>;

const TimelineResponseSchema = z.object({ success: z.literal(true), data: StudentTimelineSchema });

/** GET /v1/students/:id/timeline (student.profile.read; same 404 as the profile). `asOf` omitted = today. */
export async function fetchStudentTimeline(
  client: ApiClient,
  studentId: string,
  asOf?: string,
): Promise<StudentTimeline> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  const res = await client.get(`/v1/students/${encodeURIComponent(studentId)}/timeline${query}`, {
    schema: TimelineResponseSchema,
  });
  return res.data;
}
