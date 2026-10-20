import { Type, type Static } from '@sinclair/typebox';
import { CreateStudentResponseSchema, DATE_PATTERN, UuidV7Schema } from './student.schemas.js';

/**
 * Student guardians (docs/architecture/v3/02 §4.4, 06 §6, ADR-020; migration 0027).
 *
 * Every body is closed (`additionalProperties: false`): no tenant, student, guardian, user, date or "is minor" field can
 * be supplied; the tenant comes from the session, the student and guardian from the path, the dates from the server.
 * The service re-validates every value (trimming, control characters, the 5-500 reason).
 */

/**
 * No approved relationship vocabulary exists in the repository (migration 0002 left `relation` free text, 1-50
 * characters), so only the SHAPE is validated: a letter first, then letters, spaces, dots, apostrophes and hyphens.
 * Stored as supplied (trimmed). Replacing this with a closed set is an owner decision (see the 0027 header).
 */
export const GUARDIAN_RELATION_PATTERN = "^[A-Za-z][A-Za-z .'-]{0,49}$";
/** An optional "+", then 5 to 30 characters in total: digits, with spaces, dots, hyphens or brackets between them. */
export const GUARDIAN_PHONE_PATTERN = '^\\+?[0-9][0-9 ().-]{3,27}[0-9]$';
export const GUARDIAN_NAME_MAX = 200;
export const GUARDIAN_EMAIL_MAX = 320;
/**
 * At most this many ACTIVE guardians per student. An engineering bound, not a legal rule: it keeps the list response
 * small and unpaginated. Enforced by the service under the student row lock.
 */
export const MAX_ACTIVE_GUARDIANS = 10;

const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
const NameSchema = Type.String({ minLength: 1, maxLength: GUARDIAN_NAME_MAX });
const PhoneSchema = Type.String({ minLength: 5, maxLength: 30, pattern: GUARDIAN_PHONE_PATTERN });
const EmailSchema = Type.String({ minLength: 3, maxLength: GUARDIAN_EMAIL_MAX });
const RelationSchema = Type.String({
  minLength: 1,
  maxLength: 50,
  pattern: GUARDIAN_RELATION_PATTERN,
});

export const StudentGuardianParamsSchema = Type.Object(
  { id: UuidV7Schema, gid: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentGuardianParams = Static<typeof StudentGuardianParamsSchema>;

/**
 * All three flags default to FALSE when omitted (ADR-020: safe by default). They record what the guardian MAY be shown or
 * asked; effective access is computed elsewhere from the tenant policy and the student's age (doc 06 §6), never here.
 */
export const AddStudentGuardianBodySchema = Type.Object(
  {
    fullName: NameSchema,
    phone: PhoneSchema,
    email: Type.Optional(EmailSchema),
    relation: RelationSchema,
    isPrimary: Type.Optional(Type.Boolean()),
    canViewAcademics: Type.Optional(Type.Boolean()),
    canReceiveNotifications: Type.Optional(Type.Boolean()),
    canGiveConsent: Type.Optional(Type.Boolean()),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type AddStudentGuardianBody = Static<typeof AddStudentGuardianBodySchema>;

/** At least one field besides `reason` is required; the schema cannot say so, the service does (400). `email: null` clears it. */
export const UpdateStudentGuardianBodySchema = Type.Object(
  {
    fullName: Type.Optional(NameSchema),
    phone: Type.Optional(PhoneSchema),
    email: Type.Optional(Type.Union([EmailSchema, Type.Null()])),
    relation: Type.Optional(RelationSchema),
    isPrimary: Type.Optional(Type.Boolean()),
    canViewAcademics: Type.Optional(Type.Boolean()),
    canReceiveNotifications: Type.Optional(Type.Boolean()),
    canGiveConsent: Type.Optional(Type.Boolean()),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type UpdateStudentGuardianBody = Static<typeof UpdateStudentGuardianBodySchema>;

export const RemoveStudentGuardianBodySchema = Type.Object(
  { reason: ReasonSchema },
  { additionalProperties: false },
);
export type RemoveStudentGuardianBody = Static<typeof RemoveStudentGuardianBodySchema>;

/**
 * The reviewed DTO. `id` is the GUARDIAN id (the `{gid}` of the path). `version` is the LINK's version: it is the ETag
 * of the guardian resource and bumps on every change to the guardian or the link. Never: organization, user, link id,
 * ended links, deleted guardians, other students of the same guardian.
 */
export const StudentGuardianSchema = Type.Object(
  {
    id: UuidV7Schema,
    studentId: UuidV7Schema,
    fullName: Type.String(),
    phone: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
    relation: Type.String(),
    isPrimary: Type.Boolean(),
    canViewAcademics: Type.Boolean(),
    canReceiveNotifications: Type.Boolean(),
    canGiveConsent: Type.Boolean(),
    validFrom: Type.String({ pattern: DATE_PATTERN }),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type StudentGuardianDto = Static<typeof StudentGuardianSchema>;

export const ListStudentGuardiansResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(StudentGuardianSchema) },
  { additionalProperties: false },
);
export const GetStudentGuardianResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentGuardianSchema },
  { additionalProperties: false },
);
/** `{ success, data: { id } }`: the idempotency store keeps THIS body, so no contact data is copied into it. */
export const AddStudentGuardianResponseSchema = CreateStudentResponseSchema;
export const RemoveStudentGuardianResponseSchema = Type.Object(
  { success: Type.Literal(true) },
  { additionalProperties: false },
);
