import { Type, type Static } from '@sinclair/typebox';
import { IdParamSchema, UuidV7Schema } from '../academics/academic.schemas.js';
import { DateSchema } from '../academics/calendar.schemas.js';

/** Attendance Slice 1 (migration 0040, docs/architecture/v3/41-m4-attendance-slice1.md). Rules live in the database guards. */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: 'date-time' });
const literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

export const SESSION_KINDS = ['REGULAR', 'EXTRA', 'MAKEUP'] as const;
export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
export const MAX_ROSTER = 1000;
/**
 * Closed reason list of doc 02 §4.7 for a correction a person makes. SYSTEM_RECOMPUTE belongs to system jobs and is not
 * accepted from a request.
 */
export const CORRECTION_REASONS = [
  'FACULTY_ERROR',
  'STUDENT_DISPUTE',
  'MEDICAL',
  'DUTY_LEAVE',
  'OTHER',
] as const;

export { IdParamSchema };

export const CreateSessionBodySchema = Type.Object(
  {
    courseOfferingId: UuidV7Schema,
    sessionDate: DateSchema,
    startsAt: Instant,
    endsAt: Instant,
    kind: Type.Optional(literals(SESSION_KINDS)),
    timetableSlotId: Type.Optional(UuidV7Schema),
    topic: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  strict,
);
export type CreateSessionBody = Static<typeof CreateSessionBodySchema>;

export const SubmitAttendanceBodySchema = Type.Object(
  {
    records: Type.Array(
      Type.Object(
        {
          studentId: UuidV7Schema,
          status: literals(ATTENDANCE_STATUSES),
          remarks: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        },
        strict,
      ),
      { minItems: 1, maxItems: MAX_ROSTER },
    ),
  },
  strict,
);
export type SubmitAttendanceBody = Static<typeof SubmitAttendanceBodySchema>;

export const SessionDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    courseOfferingId: UuidV7Schema,
    campusId: UuidV7Schema,
    timetableSlotId: Type.Union([UuidV7Schema, Type.Null()]),
    conductedByEmployeeId: UuidV7Schema,
    sessionDate: DateSchema,
    startsAt: Instant,
    endsAt: Instant,
    kind: literals(SESSION_KINDS),
    topic: Type.Union([Type.String(), Type.Null()]),
    status: literals(['SCHEDULED', 'CONDUCTED', 'CANCELLED'] as const),
    attendanceState: literals(['NOT_STARTED', 'OPEN', 'SUBMITTED', 'LOCKED'] as const),
    attendanceSubmittedAt: Type.Union([Instant, Type.Null()]),
    version: Type.Integer(),
    /** IANA time zone of the session's campus; `startsAt`/`endsAt` are UTC instants displayed in it (doc 49 ATT-1). */
    campusTimezone: Type.String(),
    /** The campus-local calendar date at the time of the read. */
    campusToday: DateSchema,
    /** Approved faculty correction window in calendar days (AD-2, or the campus/organisation policy row). */
    correctionWindowDays: Type.Integer(),
    /**
     * Read-only display fact: is the session still inside the faculty correction window by the campus calendar (doc 49 ATT-2)?
     * The server re-decides on every correction, request and approval; this flag never grants anything.
     */
    insideCorrectionWindow: Type.Boolean(),
    courseCode: Type.Optional(Type.String()),
    courseTitle: Type.Optional(Type.String()),
    counts: Type.Optional(
      Type.Object(
        {
          present: Type.Integer(),
          absent: Type.Integer(),
          late: Type.Integer(),
          excused: Type.Integer(),
          total: Type.Integer(),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type SessionDto = Static<typeof SessionDtoSchema>;

export const ListSessionsQuerySchema = Type.Object(
  {
    courseOfferingId: Type.Optional(UuidV7Schema),
    sessionDate: Type.Optional(DateSchema),
    from: Type.Optional(DateSchema),
    to: Type.Optional(DateSchema),
    status: Type.Optional(literals(['SCHEDULED', 'CONDUCTED', 'CANCELLED'] as const)),
    attendanceState: Type.Optional(
      literals(['NOT_STARTED', 'OPEN', 'SUBMITTED', 'LOCKED'] as const),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  strict,
);
export type ListSessionsQuery = Static<typeof ListSessionsQuerySchema>;

export const SessionRosterItemSchema = Type.Object(
  {
    studentId: UuidV7Schema,
    admissionNumber: Type.String(),
    displayName: Type.String(),
    rollNumber: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export type SessionRosterItem = Static<typeof SessionRosterItemSchema>;

export const MyOfferingItemDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    codeSnapshot: Type.String(),
    titleSnapshot: Type.String(),
    groupLabel: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    termId: UuidV7Schema,
    termName: Type.String(),
    teachingRole: Type.String(),
    validFrom: DateSchema,
    validTo: Type.Union([DateSchema, Type.Null()]),
    campusId: UuidV7Schema,
    campusTimezone: Type.String(),
    campusToday: DateSchema,
  },
  strict,
);
export type MyOfferingItemDto = Static<typeof MyOfferingItemDtoSchema>;

export const RecordDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    classSessionId: UuidV7Schema,
    studentId: UuidV7Schema,
    status: literals(ATTENDANCE_STATUSES),
    source: Type.String(),
    markedByUserId: UuidV7Schema,
    markedAt: Instant,
    revisionNo: Type.Integer(),
    remarks: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export type RecordDto = Static<typeof RecordDtoSchema>;

export const RevisionDtoSchema = Type.Object(
  {
    revisionNo: Type.Integer(),
    statusBefore: Type.Union([literals(ATTENDANCE_STATUSES), Type.Null()]),
    statusAfter: literals(ATTENDANCE_STATUSES),
    source: Type.String(),
    changedByUserId: UuidV7Schema,
    changedAt: Instant,
    reasonCode: Type.String(),
    reasonText: Type.Union([Type.String(), Type.Null()]),
  },
  strict,
);
export type RevisionDto = Static<typeof RevisionDtoSchema>;

export const SubmitResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        sessionId: UuidV7Schema,
        recordCount: Type.Integer(),
        counts: Type.Object(
          {
            PRESENT: Type.Integer(),
            ABSENT: Type.Integer(),
            LATE: Type.Integer(),
            EXCUSED: Type.Integer(),
          },
          strict,
        ),
      },
      strict,
    ),
  },
  strict,
);

export const CorrectRecordBodySchema = Type.Object(
  {
    status: literals(ATTENDANCE_STATUSES),
    /** The revision the caller was looking at; a different current revision is a 409 (no silent overwrite). */
    expectedRevisionNo: Type.Integer({ minimum: 1 }),
    reasonCode: literals(CORRECTION_REASONS),
    /** Required for OTHER; optional otherwise (doc 02 makes reason_text optional). */
    reasonText: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })),
  },
  strict,
);
export type CorrectRecordBody = Static<typeof CorrectRecordBodySchema>;

export const CancelSessionBodySchema = Type.Object(
  { reason: Type.String({ minLength: 5, maxLength: 500 }) },
  strict,
);
export type CancelSessionBody = Static<typeof CancelSessionBodySchema>;

// ---- student-self read (Slice 3) ----------------------------------------------------------------------------------------
export const MY_RECORDS_MAX_LIMIT = 200;

export const MyRecordsQuerySchema = Type.Object(
  {
    courseOfferingId: Type.Optional(UuidV7Schema),
    /** Campus-local session dates, inclusive. */
    from: Type.Optional(DateSchema),
    to: Type.Optional(DateSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MY_RECORDS_MAX_LIMIT })),
  },
  strict,
);
export type MyRecordsQuery = Static<typeof MyRecordsQuerySchema>;

export const MyOfferingQuerySchema = Type.Object(
  { courseOfferingId: Type.Optional(UuidV7Schema) },
  strict,
);
export type MyOfferingQuery = Static<typeof MyOfferingQuerySchema>;

/** One of the signed-in student's own attendance records. No remarks, source, marker or revision data: those are staff data. */
export const MyRecordDtoSchema = Type.Object(
  {
    classSessionId: UuidV7Schema,
    courseOfferingId: UuidV7Schema,
    courseCode: Type.String(),
    courseTitle: Type.String(),
    sessionDate: DateSchema,
    startsAt: Instant,
    kind: literals(SESSION_KINDS),
    status: literals(ATTENDANCE_STATUSES),
  },
  strict,
);
export type MyRecordDto = Static<typeof MyRecordDtoSchema>;

export const MyRecordsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(MyRecordDtoSchema),
    /** True when more records match than `limit`; narrow with `to` (the oldest date returned) to continue. */
    hasMore: Type.Boolean(),
  },
  strict,
);

const Counts = {
  held: Type.Integer(),
  present: Type.Integer(),
  late: Type.Integer(),
  excused: Type.Integer(),
  absent: Type.Integer(),
};
export const MySummaryDtoSchema = Type.Object(
  {
    offerings: Type.Array(
      Type.Object(
        {
          courseOfferingId: UuidV7Schema,
          courseCode: Type.String(),
          courseTitle: Type.String(),
          ...Counts,
        },
        strict,
      ),
    ),
    totals: Type.Object(Counts, strict),
  },
  strict,
);
export type MySummaryDto = Static<typeof MySummaryDtoSchema>;

// ---- Slice 4: approval, lock (migration 0042, doc 41 §12) ----------------------------------------------------------------
export const LockSessionBodySchema = Type.Object(
  { reason: Type.String({ minLength: 5, maxLength: 500 }) },
  strict,
);
export type LockSessionBody = Static<typeof LockSessionBodySchema>;

/** The note is optional when approving and required when rejecting (checked in the service). */
export const DecideRequestBodySchema = Type.Object(
  { note: Type.Optional(Type.String({ minLength: 5, maxLength: 500 })) },
  strict,
);
export type DecideRequestBody = Static<typeof DecideRequestBodySchema>;

export const CorrectionRequestDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    attendanceRecordId: UuidV7Schema,
    classSessionId: UuidV7Schema,
    studentId: UuidV7Schema,
    statusBefore: literals(ATTENDANCE_STATUSES),
    requestedStatus: literals(ATTENDANCE_STATUSES),
    expectedRevisionNo: Type.Integer(),
    reasonCode: Type.String(),
    reasonText: Type.Union([Type.String(), Type.Null()]),
    status: literals(['PENDING', 'APPROVED', 'REJECTED'] as const),
    requestedByUserId: UuidV7Schema,
    requestedAt: Instant,
    decidedByUserId: Type.Union([UuidV7Schema, Type.Null()]),
    decidedAt: Type.Union([Instant, Type.Null()]),
    decisionNote: Type.Union([Type.String(), Type.Null()]),
    appliedRevisionNo: Type.Union([Type.Integer(), Type.Null()]),
  },
  strict,
);
export type CorrectionRequestDto = Static<typeof CorrectionRequestDtoSchema>;

export const ListCorrectionRequestsQuerySchema = Type.Object(
  { status: Type.Optional(literals(['PENDING', 'APPROVED', 'REJECTED'] as const)) },
  strict,
);
export type ListCorrectionRequestsQuery = Static<typeof ListCorrectionRequestsQuerySchema>;

/** A campus the caller may read attendance for, with its clock (doc 49 ATT-1: defaults and display use the campus calendar). */
export const CampusClockDtoSchema = Type.Object(
  { id: UuidV7Schema, name: Type.String(), timezone: Type.String(), today: DateSchema },
  strict,
);
export type CampusClockDto = Static<typeof CampusClockDtoSchema>;
