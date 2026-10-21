import { Type, type Static } from '@sinclair/typebox';
import { UuidV7Schema, DATE_PATTERN } from './student.schemas.js';

/** Contracts of the term-enrolment and section-placement API (Milestone 3, Batch 1). */

export const TERM_ENROLLMENT_STATUSES = [
  'REGISTERED',
  'ACTIVE',
  'WITHDRAWN',
  'DETAINED',
  'PROMOTED',
  'COMPLETED',
  'ON_LEAVE',
] as const;
export const ENROLLMENT_TYPES = ['REGULAR', 'REPEAT', 'BACKLOG', 'SUMMER'] as const;
/** Statuses an update may move an enrolment INTO (REGISTERED is only the creation state). */
export const TARGET_STATUSES = [
  'ACTIVE',
  'WITHDRAWN',
  'DETAINED',
  'PROMOTED',
  'COMPLETED',
  'ON_LEAVE',
] as const;
/** Final states: nothing leaves them, and entering one closes the open section membership. */
export const TERMINAL_STATUSES = ['WITHDRAWN', 'PROMOTED', 'COMPLETED'] as const;
export const ROLL_NUMBER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$';

const strict = { additionalProperties: false } as const;
const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));
const DateSchema = Type.String({ pattern: DATE_PATTERN });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const TermEnrollmentIdParamSchema = Type.Object({ id: UuidV7Schema }, strict);
export type TermEnrollmentIdParam = Static<typeof TermEnrollmentIdParamSchema>;

export const CreateTermEnrollmentBodySchema = Type.Object(
  {
    cohortPeriodId: UuidV7Schema,
    enrollmentType: Type.Optional(literalUnion(ENROLLMENT_TYPES)),
    rollNumber: Type.Optional(
      Type.String({ minLength: 1, maxLength: 30, pattern: ROLL_NUMBER_PATTERN }),
    ),
    reason: ReasonSchema,
  },
  strict,
);
export type CreateTermEnrollmentBody = Static<typeof CreateTermEnrollmentBodySchema>;

export const UpdateTermEnrollmentBodySchema = Type.Object(
  {
    status: Type.Optional(literalUnion(TARGET_STATUSES)),
    rollNumber: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: 30, pattern: ROLL_NUMBER_PATTERN }),
        Type.Null(),
      ]),
    ),
    reason: ReasonSchema,
  },
  { ...strict, minProperties: 2 },
);
export type UpdateTermEnrollmentBody = Static<typeof UpdateTermEnrollmentBodySchema>;

export const PlaceSectionBodySchema = Type.Object(
  {
    sectionId: UuidV7Schema,
    validFrom: DateSchema,
    reason: Type.String({ minLength: 5, maxLength: 100 }),
  },
  strict,
);
export type PlaceSectionBody = Static<typeof PlaceSectionBodySchema>;

export const TermEnrollmentRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    studentId: UuidV7Schema,
    studentProgramId: UuidV7Schema,
    cohortPeriodId: UuidV7Schema,
    termId: UuidV7Schema,
    periodNo: Type.Integer(),
    status: literalUnion(TERM_ENROLLMENT_STATUSES),
    enrollmentType: literalUnion(ENROLLMENT_TYPES),
    rollNumber: Type.Union([Type.String(), Type.Null()]),
    registeredAt: Type.String(),
    currentSection: Type.Union([
      Type.Object(
        { sectionId: UuidV7Schema, name: Type.String(), validFrom: Type.String() },
        strict,
      ),
      Type.Null(),
    ]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type TermEnrollmentDto = Static<typeof TermEnrollmentRecordSchema>;

export const GetTermEnrollmentResponseSchema = Type.Object(
  { success: Type.Literal(true), data: TermEnrollmentRecordSchema },
  strict,
);
export const ListTermEnrollmentsResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(TermEnrollmentRecordSchema) },
  strict,
);
export const CreateTermEnrollmentResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Object({ id: UuidV7Schema }, strict) },
  strict,
);
