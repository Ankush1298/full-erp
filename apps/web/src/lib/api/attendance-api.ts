import { z } from 'zod';
import type { ApiClient } from './client';

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CORRECTION_REASONS = [
  'FACULTY_ERROR',
  'STUDENT_DISPUTE',
  'MEDICAL',
  'DUTY_LEAVE',
  'OTHER',
] as const;
export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

export const SESSION_KINDS = ['REGULAR', 'EXTRA', 'MAKEUP'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SessionCountsSchema = z.object({
  present: z.number(),
  absent: z.number(),
  late: z.number(),
  excused: z.number(),
  total: z.number(),
});
export type SessionCounts = z.infer<typeof SessionCountsSchema>;

export const SessionDtoSchema = z.object({
  id: z.string(),
  courseOfferingId: z.string(),
  campusId: z.string(),
  timetableSlotId: z.string().nullable(),
  conductedByEmployeeId: z.string(),
  sessionDate: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  kind: z.enum(SESSION_KINDS),
  topic: z.string().nullable(),
  status: z.enum(['SCHEDULED', 'CONDUCTED', 'CANCELLED']),
  attendanceState: z.enum(['NOT_STARTED', 'OPEN', 'SUBMITTED', 'LOCKED']),
  attendanceSubmittedAt: z.string().nullable(),
  version: z.number(),
  courseCode: z.string().optional(),
  courseTitle: z.string().optional(),
  counts: SessionCountsSchema.optional(),
  // Doc 49 ATT-1/ATT-2: the campus clock and the server's own view of the correction window (display facts only; the server
  // re-decides every change). Optional so an older server still parses.
  campusTimezone: z.string().optional(),
  campusToday: z.string().optional(),
  correctionWindowDays: z.number().optional(),
  insideCorrectionWindow: z.boolean().optional(),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

export const RecordDtoSchema = z.object({
  id: z.string(),
  classSessionId: z.string(),
  studentId: z.string(),
  status: z.enum(ATTENDANCE_STATUSES),
  source: z.string(),
  markedByUserId: z.string(),
  markedAt: z.string(),
  revisionNo: z.number(),
  remarks: z.string().nullable(),
});
export type RecordDto = z.infer<typeof RecordDtoSchema>;

export const RevisionDtoSchema = z.object({
  revisionNo: z.number(),
  statusBefore: z.enum(ATTENDANCE_STATUSES).nullable(),
  statusAfter: z.enum(ATTENDANCE_STATUSES),
  source: z.string(),
  changedByUserId: z.string(),
  changedAt: z.string(),
  reasonCode: z.string(),
  reasonText: z.string().nullable(),
});
export type RevisionDto = z.infer<typeof RevisionDtoSchema>;

export const CorrectionRequestDtoSchema = z.object({
  id: z.string(),
  attendanceRecordId: z.string(),
  classSessionId: z.string(),
  studentId: z.string(),
  statusBefore: z.enum(ATTENDANCE_STATUSES),
  requestedStatus: z.enum(ATTENDANCE_STATUSES),
  expectedRevisionNo: z.number(),
  reasonCode: z.string(),
  reasonText: z.string().nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  requestedByUserId: z.string(),
  requestedAt: z.string(),
  decidedByUserId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  appliedRevisionNo: z.number().nullable(),
});
export type CorrectionRequestDto = z.infer<typeof CorrectionRequestDtoSchema>;

export const SessionRosterItemSchema = z.object({
  studentId: z.string(),
  admissionNumber: z.string(),
  displayName: z.string(),
  rollNumber: z.string().nullable(),
});
export type SessionRosterItem = z.infer<typeof SessionRosterItemSchema>;

export const MyOfferingItemSchema = z.object({
  id: z.string(),
  codeSnapshot: z.string(),
  titleSnapshot: z.string(),
  groupLabel: z.string().nullable(),
  status: z.string(),
  termId: z.string(),
  termName: z.string(),
  teachingRole: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  campusId: z.string().optional(),
  campusTimezone: z.string().optional(),
  campusToday: z.string().optional(),
});
export type MyOfferingItem = z.infer<typeof MyOfferingItemSchema>;

const List = <T extends z.ZodType>(item: T) =>
  z.object({ success: z.boolean(), data: z.array(item) });
const One = <T extends z.ZodType>(item: T) => z.object({ success: z.boolean(), data: item });

export const SubmitResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    recordCount: z.number(),
    counts: z.object({
      PRESENT: z.number(),
      ABSENT: z.number(),
      LATE: z.number(),
      EXCUSED: z.number(),
    }),
  }),
});
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

// API methods

export const CampusClockSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  today: z.string(),
});
export type CampusClock = z.infer<typeof CampusClockSchema>;

/** Campuses the caller can read attendance for through an institutional grant, with each campus's clock. */
export async function fetchCampusClocks(c: ApiClient): Promise<CampusClock[]> {
  const res = await c.get('/v1/attendance/campuses', { schema: List(CampusClockSchema) });
  return res.data;
}

export async function fetchMyOfferings(c: ApiClient): Promise<MyOfferingItem[]> {
  const res = await c.get('/v1/attendance/my-offerings', {
    schema: List(MyOfferingItemSchema),
  });
  return res.data;
}

export async function fetchSessions(
  c: ApiClient,
  query: {
    courseOfferingId?: string;
    sessionDate?: string;
    from?: string;
    to?: string;
    status?: string;
    attendanceState?: string;
    limit?: number;
  } = {},
): Promise<SessionDto[]> {
  const params = new URLSearchParams();
  if (query.courseOfferingId) params.set('courseOfferingId', query.courseOfferingId);
  if (query.sessionDate) params.set('sessionDate', query.sessionDate);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.status) params.set('status', query.status);
  if (query.attendanceState) params.set('attendanceState', query.attendanceState);
  if (query.limit) params.set('limit', String(query.limit));

  const qs = params.toString();
  const url = qs ? `/v1/attendance/sessions?${qs}` : '/v1/attendance/sessions';
  const res = await c.get(url, { schema: List(SessionDtoSchema) });
  return res.data;
}

export async function fetchSession(c: ApiClient, id: string): Promise<SessionDto> {
  const res = await c.get(`/v1/attendance/sessions/${encodeURIComponent(id)}`, {
    schema: One(SessionDtoSchema),
  });
  return res.data;
}

export async function fetchSessionRoster(
  c: ApiClient,
  sessionId: string,
): Promise<SessionRosterItem[]> {
  const res = await c.get(`/v1/attendance/sessions/${encodeURIComponent(sessionId)}/roster`, {
    schema: List(SessionRosterItemSchema),
  });
  return res.data;
}

export async function fetchSessionRecords(c: ApiClient, sessionId: string): Promise<RecordDto[]> {
  const res = await c.get(`/v1/attendance/sessions/${encodeURIComponent(sessionId)}/records`, {
    schema: List(RecordDtoSchema),
  });
  return res.data;
}

export async function fetchRecordRevisions(c: ApiClient, recordId: string): Promise<RevisionDto[]> {
  const res = await c.get(`/v1/attendance/records/${encodeURIComponent(recordId)}/revisions`, {
    schema: List(RevisionDtoSchema),
  });
  return res.data;
}

export async function createSession(
  c: ApiClient,
  body: {
    courseOfferingId: string;
    sessionDate: string;
    startsAt: string;
    endsAt: string;
    kind?: SessionKind | undefined;
    topic?: string | undefined;
    timetableSlotId?: string | undefined;
  },
  idempotencyKey: string,
): Promise<{ id: string }> {
  const res = await c.post('/v1/attendance/sessions', {
    schema: One(z.object({ id: z.string() })),
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return res.data;
}

export async function submitAttendance(
  c: ApiClient,
  sessionId: string,
  body: {
    records: { studentId: string; status: AttendanceStatus; remarks?: string | undefined }[];
  },
  idempotencyKey: string,
): Promise<SubmitResponse['data']> {
  const res = await c.post(`/v1/attendance/sessions/${encodeURIComponent(sessionId)}/attendance`, {
    schema: SubmitResponseSchema,
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return res.data;
}

export async function cancelSession(
  c: ApiClient,
  sessionId: string,
  body: { reason: string },
  idempotencyKey: string,
): Promise<SessionDto> {
  const res = await c.post(`/v1/attendance/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    schema: One(SessionDtoSchema),
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return res.data;
}

export async function correctRecord(
  c: ApiClient,
  recordId: string,
  body: {
    status: AttendanceStatus;
    expectedRevisionNo: number;
    reasonCode: CorrectionReason;
    reasonText?: string | undefined;
  },
  idempotencyKey: string,
): Promise<RecordDto> {
  const res = await c.post(`/v1/attendance/records/${encodeURIComponent(recordId)}/corrections`, {
    schema: One(RecordDtoSchema),
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return res.data;
}

export async function requestCorrection(
  c: ApiClient,
  recordId: string,
  body: {
    status: AttendanceStatus;
    expectedRevisionNo: number;
    reasonCode: CorrectionReason;
    reasonText?: string | undefined;
  },
  idempotencyKey: string,
): Promise<CorrectionRequestDto> {
  const res = await c.post(
    `/v1/attendance/records/${encodeURIComponent(recordId)}/correction-requests`,
    {
      schema: One(CorrectionRequestDtoSchema),
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  );
  return res.data;
}

export async function fetchCorrectionRequests(
  c: ApiClient,
  status?: 'PENDING' | 'APPROVED' | 'REJECTED',
): Promise<CorrectionRequestDto[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await c.get(`/v1/attendance/correction-requests${qs}`, {
    schema: List(CorrectionRequestDtoSchema),
  });
  return res.data;
}

export async function decideCorrectionRequest(
  c: ApiClient,
  requestId: string,
  decision: 'approve' | 'reject',
  body: { note?: string | undefined },
  idempotencyKey: string,
): Promise<CorrectionRequestDto> {
  const res = await c.post(
    decision === 'approve'
      ? `/v1/attendance/correction-requests/${encodeURIComponent(requestId)}/approve`
      : `/v1/attendance/correction-requests/${encodeURIComponent(requestId)}/reject`,
    {
      schema: One(CorrectionRequestDtoSchema),
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  );
  return res.data;
}

export async function lockSession(
  c: ApiClient,
  sessionId: string,
  body: { reason: string },
  idempotencyKey: string,
): Promise<SessionDto> {
  const res = await c.post(`/v1/attendance/sessions/${encodeURIComponent(sessionId)}/lock`, {
    schema: One(SessionDtoSchema),
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
  return res.data;
}
