import { Type, type Static } from '@sinclair/typebox';
import { UuidV7Schema } from './academic.schemas.js';
import { DateSchema } from './calendar.schemas.js';

/**
 * Elective groups and course registrations (migration 0039, docs/architecture/v3/33-electives-registrations-holidays-m3b3.md).
 * Every rule (window, min/max, capacity, audience, same term, live uniqueness) is enforced by the database guard; these
 * contracts only shape the request.
 */

const strict = { additionalProperties: false } as const;
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
const literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));
const Instant = Type.String({ format: 'date-time' });

export const ELECTIVE_GROUP_STATUSES = ['PLANNED', 'OPEN', 'CLOSED'] as const;
export const REGISTRATION_STATUSES = [
  'PENDING_APPROVAL',
  'REGISTERED',
  'REJECTED',
  'DROPPED',
  'WITHDRAWN',
  'COMPLETED',
] as const;
/** doc 02 §4.6 `source`. AUTO_SECTION is written only by the from-section action. ('ADMIN' is the column value.) */
const WritableSourceSchema = Type.Union([
  Type.Literal('MANUAL'),
  Type.Literal('ELECTIVE_CHOICE'),
  Type.Literal('ADMIN'),
]);
const SourceSchema = Type.Union([Type.Literal('AUTO_SECTION'), ...WritableSourceSchema.anyOf]);
export const WRITABLE_SOURCES: readonly string[] = WritableSourceSchema.anyOf.map((x) => x.const);
export const REGISTRATION_KINDS = [
  'REGULAR',
  'BACKLOG',
  'IMPROVEMENT',
  'AUDIT',
  'EXEMPTED',
] as const;

// ---- elective groups -------------------------------------------------------------------------
export const CreateElectiveGroupBodySchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 30 }),
    name: Type.String({ minLength: 1, maxLength: 255 }),
    minSelect: Type.Integer({ minimum: 0, maximum: 50 }),
    maxSelect: Type.Integer({ minimum: 1, maximum: 50 }),
    opensAt: Type.Optional(Instant),
    closesAt: Type.Optional(Instant),
    reason: ReasonSchema,
  },
  strict,
);
export type CreateElectiveGroupBody = Static<typeof CreateElectiveGroupBodySchema>;

export const UpdateElectiveGroupBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    minSelect: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
    maxSelect: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    opensAt: Type.Optional(Type.Union([Instant, Type.Null()])),
    closesAt: Type.Optional(Type.Union([Instant, Type.Null()])),
    status: Type.Optional(Type.Union([Type.Literal('OPEN'), Type.Literal('CLOSED')])),
    reason: ReasonSchema,
  },
  { ...strict, minProperties: 2 },
);
export type UpdateElectiveGroupBody = Static<typeof UpdateElectiveGroupBodySchema>;

export const ElectiveGroupRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    cohortPeriodId: UuidV7Schema,
    code: Type.String(),
    name: Type.String(),
    minSelect: Type.Integer(),
    maxSelect: Type.Integer(),
    opensAt: Type.Union([Type.String(), Type.Null()]),
    closesAt: Type.Union([Type.String(), Type.Null()]),
    status: literals(ELECTIVE_GROUP_STATUSES),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type ElectiveGroupDto = Static<typeof ElectiveGroupRecordSchema>;

// ---- course registrations --------------------------------------------------------------------
export const CreateRegistrationBodySchema = Type.Object(
  {
    termEnrollmentId: UuidV7Schema,
    validFrom: DateSchema,
    source: WritableSourceSchema,
    registrationKind: Type.Optional(literals(REGISTRATION_KINDS)),
    /** PENDING_APPROVAL is accepted; nothing approves automatically (doc 07 §3.2 "optional admin approval"). */
    pendingApproval: Type.Optional(Type.Boolean()),
    reason: ReasonSchema,
  },
  strict,
);
export type CreateRegistrationBody = Static<typeof CreateRegistrationBodySchema>;

/** Registers the offering's section members open on `validFrom` (AUTO_FROM_SECTION offerings only). Re-runnable. */
export const FromSectionBodySchema = Type.Object(
  { validFrom: DateSchema, reason: ReasonSchema },
  strict,
);
export type FromSectionBody = Static<typeof FromSectionBodySchema>;

/** Approve / reject a pending row, or close a live one (drop, withdraw, complete) on `validTo`. */
export const UpdateRegistrationBodySchema = Type.Object(
  {
    status: literals(['REGISTERED', 'REJECTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED'] as const),
    validTo: Type.Optional(DateSchema),
    reason: ReasonSchema,
  },
  strict,
);
export type UpdateRegistrationBody = Static<typeof UpdateRegistrationBodySchema>;

export const RegistrationRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    termEnrollmentId: UuidV7Schema,
    studentId: UuidV7Schema,
    courseOfferingId: UuidV7Schema,
    electiveGroupId: Type.Union([UuidV7Schema, Type.Null()]),
    status: literals(REGISTRATION_STATUSES),
    validFrom: Type.String(),
    validTo: Type.Union([Type.String(), Type.Null()]),
    source: SourceSchema,
    registrationKind: literals(REGISTRATION_KINDS),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type RegistrationDto = Static<typeof RegistrationRecordSchema>;

export const FromSectionResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ created: Type.Integer(), alreadyRegistered: Type.Integer() }, strict),
  },
  strict,
);
