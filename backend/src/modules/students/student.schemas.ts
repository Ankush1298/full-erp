import { Type, type Static } from '@sinclair/typebox';

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
