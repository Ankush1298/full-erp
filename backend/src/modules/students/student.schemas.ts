import { Type, type Static, type TSchema } from '@sinclair/typebox';

// Self-contained primitives (the module does not reach into other modules' schemas).
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

/**
 * admission_number is varchar(50)-bounded in the table. Administrator-supplied in Phase 2; same conservative charset as
 * EMPLOYEE_CODE_PATTERN (loosening later is safe, tightening is not). No trimming: whitespace is rejected.
 * Uniqueness stays case-sensitive (UNIQUE (organization_id, admission_number)).
 */
export const ADMISSION_NUMBER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$';
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

export const STUDENT_STATUSES = [
  'ADMITTED',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'DISCONTINUED',
  'GRADUATED',
  'TRANSFERRED_OUT',
] as const;

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
export const StudentStatusSchema = Type.Union(STUDENT_STATUSES.map((s) => Type.Literal(s)));
export type StudentStatus = Static<typeof StudentStatusSchema>;

const DateSchema = Type.String({ pattern: DATE_PATTERN, description: 'Calendar date, YYYY-MM-DD' });
/** A2 (doc 02 §4.1): every mutation carries a mandatory reason, stored on the audit event. */
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const StudentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentIdParam = Static<typeof StudentIdParamSchema>;

/**
 * Status is server-managed on create (always ADMITTED). No organization / tenant field is accepted
 * (additionalProperties: false); the tenant comes only from the session.
 */
export const CreateStudentBodySchema = Type.Object(
  {
    userId: UuidV7Schema,
    admissionNumber: Type.String({
      minLength: 1,
      maxLength: 50,
      pattern: ADMISSION_NUMBER_PATTERN,
    }),
    admissionDate: DateSchema,
    reason: ReasonSchema,
    /**
     * MATCHING-ONLY inputs of the possible-duplicate check (doc 26 §3.5). All optional; when any is missing or unusable the
     * check cannot match. None is stored by the create (not the date of birth, not the guardian phone) and none appears in
     * the response, the audit event or any log.
     */
    // name and guardianPhone are UNTYPED here on purpose: the HTTP layer's type coercion would accept `12345` as "12345".
    // `StudentService.create` (optionalText) accepts a JSON string only, 1-200 / 1-30 characters after trimming, else 400 -
    // the same contract as the import's matching cells, which also refuse non-text values.
    name: Type.Optional(Type.Unknown()),
    dateOfBirth: Type.Optional(DateSchema),
    guardianPhone: Type.Optional(Type.Unknown()),
    /** The fingerprint returned by a previous 409 POSSIBLE_DUPLICATE_STUDENT: acknowledges exactly that warning. */
    duplicateAcknowledgement: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  },
  { additionalProperties: false },
);
export type CreateStudentBody = Static<typeof CreateStudentBodySchema>;

/**
 * admissionDate and statusChangedAt are nullable ONLY because rows written before migration 0017 may still carry NULL
 * until the 0019 contract migration runs; every row created through this API has both.
 */
export const StudentRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    userId: UuidV7Schema,
    admissionNumber: Type.String(),
    admissionDate: Type.Union([Type.String(), Type.Null()]),
    status: StudentStatusSchema,
    statusChangedAt: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type StudentRecordDto = Static<typeof StudentRecordSchema>;

export const CreateStudentResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const GetStudentResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentRecordSchema },
  { additionalProperties: false },
);

/**
 * Program enrolment (Phase 3a). The caller supplies ONLY the program, cohort, start date and reason: campus, department,
 * organization, entry type and previous-enrolment are server-derived or fixed, so any such field is a 400
 * (additionalProperties: false). The service re-validates every value (trimming, calendar dates, the 5-500 reason).
 */
export const OpenStudentProgramBodySchema = Type.Object(
  { programId: UuidV7Schema, cohortId: UuidV7Schema, startDate: DateSchema, reason: ReasonSchema },
  { additionalProperties: false },
);
export type OpenStudentProgramBody = Static<typeof OpenStudentProgramBodySchema>;

export const StudentProgramParamsSchema = Type.Object(
  { id: UuidV7Schema, pid: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentProgramParams = Static<typeof StudentProgramParamsSchema>;

export const CloseStudentProgramBodySchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal('COMPLETED'),
      Type.Literal('TRANSFERRED_OUT'),
      Type.Literal('DISCONTINUED'),
    ]),
    endDate: DateSchema,
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type CloseStudentProgramBody = Static<typeof CloseStudentProgramBodySchema>;

export const StudentProgramRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    studentId: UuidV7Schema,
    programId: UuidV7Schema,
    cohortId: UuidV7Schema,
    campusId: UuidV7Schema,
    departmentId: UuidV7Schema,
    startDate: Type.String(),
    endDate: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    entryType: Type.String(),
    exitReason: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export const OpenStudentProgramResponseSchema = CreateStudentResponseSchema;
export const CloseStudentProgramResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentProgramRecordSchema },
  { additionalProperties: false },
);

/**
 * Student lookup by exact admission number (docs/architecture/v3/21-students.md §0b). No other parameter exists: no
 * name search, no listing, no limit/offset/cursor, no tenant or scope field (additionalProperties: false).
 */
export const StudentLookupQuerySchema = Type.Object(
  {
    admissionNumber: Type.String({
      minLength: 1,
      maxLength: 50,
      pattern: ADMISSION_NUMBER_PATTERN,
    }),
  },
  { additionalProperties: false },
);
export type StudentLookupQuery = Static<typeof StudentLookupQuerySchema>;

/**
 * The reviewed selection DTO: exactly these five fields. Never the admission date, account id, e-mail, guardians,
 * placement (campus, department, program, cohort), enrolment history, exit reasons or event reasons.
 */
export const StudentDirectoryEntrySchema = Type.Object(
  {
    id: UuidV7Schema,
    admissionNumber: Type.String(),
    displayName: Type.String(),
    status: StudentStatusSchema,
    hasActiveEnrolment: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type StudentDirectoryEntry = Static<typeof StudentDirectoryEntrySchema>;
export const StudentLookupResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentDirectoryEntrySchema },
  { additionalProperties: false },
);

/**
 * Paginated staff directory (docs/architecture/v3/21-students.md §0c). Only `status`, `limit` and `cursor` exist: no name
 * search, no total, no tenant, campus or department field (additionalProperties: false). `cursor` is opaque and
 * deliberately has NO length or pattern rule here: the codec rejects an empty, over-long, malformed, tampered, expired or
 * mismatched cursor with the one uniform 400 INVALID_CURSOR, so a schema rule would add a second, distinguishable answer.
 */
export const DIRECTORY_DEFAULT_LIMIT = 25;
export const DIRECTORY_MAX_LIMIT = 100;
export const StudentDirectoryListQuerySchema = Type.Object(
  {
    status: Type.Optional(StudentStatusSchema),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: DIRECTORY_MAX_LIMIT, default: DIRECTORY_DEFAULT_LIMIT }),
    ),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type StudentDirectoryListQuery = Static<typeof StudentDirectoryListQuerySchema>;

export const StudentDirectoryListResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(StudentDirectoryEntrySchema),
    page: Type.Object(
      { nextCursor: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/**
 * POST /api/v1/students/:id/status (docs/architecture/v3/21-students.md §6b). The body carries the target status and the
 * mandatory reason only: no tenant, student, version or date field (the version comes from If-Match, the closure date is
 * the campus-local today). The reason bounds repeat the service's `parseReason` (5-500 after trimming).
 */
export const ChangeStudentStatusBodySchema = Type.Object(
  {
    status: StudentStatusSchema,
    reason: Type.String({ minLength: 5, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export type ChangeStudentStatusBody = Static<typeof ChangeStudentStatusBodySchema>;

// ---- Student academic timeline (doc 34). Read-only, derived from the authoritative rows; see student-timeline.service.ts.
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
  // undated outcomes of a term enrolment (no date is recorded for them)
  'PROMOTED',
  'DETAINED',
  'TERM_COMPLETED',
  'TERM_WITHDRAWN',
  'TERM_ON_LEAVE',
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const TimelineQuerySchema = Type.Object(
  { asOf: Type.Optional(Type.String({ pattern: DATE_PATTERN })) },
  { additionalProperties: false },
);
export type TimelineQuery = Static<typeof TimelineQuerySchema>;

const closed = { additionalProperties: false } as const;
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const DateStr = Type.String({ pattern: DATE_PATTERN });

export const TimelineEventSchema = Type.Object(
  {
    id: Type.String(),
    sourceId: UuidV7Schema,
    eventType: Type.Union(TIMELINE_EVENT_TYPES.map((t) => Type.Literal(t))),
    eventDate: Nullable(DateStr),
    temporal: Type.Union([
      Type.Literal('CURRENT'),
      Type.Literal('HISTORICAL'),
      Type.Literal('UNDATED'),
    ]),
    description: Type.String(),
    programme: Nullable(
      Type.Object({ id: UuidV7Schema, name: Type.String(), code: Type.String() }, closed),
    ),
    cohortName: Nullable(Type.String()),
    term: Nullable(
      Type.Object({ id: UuidV7Schema, code: Type.String(), name: Type.String() }, closed),
    ),
    periodNo: Nullable(Type.Integer()),
    periodLabel: Nullable(Type.String()),
    section: Nullable(Type.Object({ id: UuidV7Schema, name: Type.String() }, closed)),
    course: Nullable(
      Type.Object(
        {
          offeringId: UuidV7Schema,
          code: Type.String(),
          title: Type.String(),
          credits: Type.String(),
        },
        closed,
      ),
    ),
    status: Nullable(Type.String()),
  },
  closed,
);
export type TimelineEventDto = Static<typeof TimelineEventSchema>;

const PositionRegistrationSchema = Type.Object(
  {
    registrationId: UuidV7Schema,
    offeringId: UuidV7Schema,
    code: Type.String(),
    title: Type.String(),
    credits: Type.String(),
    registrationKind: Type.String(),
    source: Type.String(),
    validFrom: DateStr,
    validTo: Nullable(DateStr),
    recordedStatus: Type.String(),
    statusOnDate: Type.Union([Type.Literal('REGISTERED'), Type.Literal('PENDING_APPROVAL')]),
  },
  closed,
);

export const TimelinePositionTermSchema = Type.Object(
  {
    termEnrollmentId: UuidV7Schema,
    term: Type.Object(
      {
        id: UuidV7Schema,
        code: Type.String(),
        name: Type.String(),
        startDate: DateStr,
        endDate: DateStr,
      },
      closed,
    ),
    periodNo: Type.Integer(),
    periodLabel: Type.String(),
    enrollmentType: Type.String(),
    recordedStatus: Type.String(),
    rollNumber: Nullable(Type.String()),
    section: Nullable(
      Type.Object(
        { id: UuidV7Schema, name: Type.String(), validFrom: DateStr, validTo: Nullable(DateStr) },
        closed,
      ),
    ),
    registrations: Type.Array(PositionRegistrationSchema),
  },
  closed,
);
export type TimelinePositionTermDto = Static<typeof TimelinePositionTermSchema>;

export const TimelineLimitationSchema = Type.Object(
  { code: Type.String(), message: Type.String() },
  closed,
);
export type TimelineLimitationDto = Static<typeof TimelineLimitationSchema>;

export const StudentTimelineSchema = Type.Object(
  {
    studentId: UuidV7Schema,
    asOfDate: DateStr,
    today: DateStr,
    timezone: Type.String(),
    position: Type.Object(
      {
        admitted: Nullable(Type.Boolean()),
        studentStatus: Nullable(StudentStatusSchema),
        programme: Nullable(
          Type.Object(
            {
              studentProgramId: UuidV7Schema,
              id: UuidV7Schema,
              name: Type.String(),
              code: Type.String(),
              cohortId: UuidV7Schema,
              cohortName: Type.String(),
              entryType: Type.String(),
              startDate: DateStr,
              endDate: Nullable(DateStr),
            },
            closed,
          ),
        ),
        terms: Type.Array(TimelinePositionTermSchema),
      },
      closed,
    ),
    events: Type.Array(TimelineEventSchema),
    undatedOutcomes: Type.Array(TimelineEventSchema),
    futureEventsExcluded: Type.Integer({ minimum: 0 }),
    limitations: Type.Array(TimelineLimitationSchema),
  },
  closed,
);
export type StudentTimelineDto = Static<typeof StudentTimelineSchema>;

export const StudentTimelineResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentTimelineSchema },
  closed,
);
