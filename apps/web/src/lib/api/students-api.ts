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
  const res = await client.get(`/students/directory?${params.toString()}`, {
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
  const res = await client.get(`/students?${params.toString()}`, { schema: LookupSchema });
  return res.data;
}

/** GET /students/:id (permission student.profile.read). Missing, other-tenant and out-of-scope records are one 404. */
export async function fetchStudent(client: ApiClient, id: string): Promise<StudentRecord> {
  const res = await client.get(`/students/${encodeURIComponent(id)}`, { schema: RecordSchema });
  return res.data;
}

/** GET /students/:id/identifiers (permission student.profile.read_sensitive). */
export async function fetchStudentIdentifiers(
  client: ApiClient,
  id: string,
): Promise<StudentIdentifier[]> {
  const res = await client.get(`/students/${encodeURIComponent(id)}/identifiers`, {
    schema: IdentifiersSchema,
  });
  return res.data;
}
