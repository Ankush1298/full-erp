import { Type, type Static } from '@sinclair/typebox';
import { CreateStudentResponseSchema, DATE_PATTERN, UuidV7Schema } from './student.schemas.js';

/**
 * Student identifiers (docs/architecture/v3/02 §4.4 and §6.1; migration 0035): the identifiers a student holds BESIDES the
 * admission number, which lives on the student record and is not representable here (the id_type list excludes it).
 *
 * Every body is closed (`additionalProperties: false`): no tenant, student, version or audit field can be supplied. The
 * service re-validates every value.
 */

/** doc 02 §4.4. A closed list: adding a type is a forward migration (the CHECK in 0035) plus this tuple. */
export const IDENTIFIER_TYPES = [
  'UNIVERSITY_PRN',
  'APAAR',
  'LIBRARY_CARD',
  'HOSTEL_ID',
  'OTHER',
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/** varchar(100) in doc 02 §4.4. */
export const IDENTIFIER_VALUE_MAX = 100;
export const IDENTIFIER_ISSUER_MAX = 200;
/**
 * At most this many identifiers per student. An engineering bound (the documents state none) that keeps the unpaginated
 * list small; enforced by the service under the student row lock.
 */
export const MAX_IDENTIFIERS_PER_STUDENT = 100;

const IdTypeSchema = Type.Union(IDENTIFIER_TYPES.map((t) => Type.Literal(t)));
const ValueSchema = Type.String({ minLength: 1, maxLength: IDENTIFIER_VALUE_MAX });
const IssuerSchema = Type.String({ minLength: 1, maxLength: IDENTIFIER_ISSUER_MAX });
const DateSchema = Type.String({ pattern: DATE_PATTERN, description: 'Calendar date, YYYY-MM-DD' });
// `const: null`, not `type: 'null'`: Fastify's AJV coerces types, and `type: 'null'` would turn "" into null and silently
// clear a field. `const` has no type to coerce, so "" is a 400. (Same reasoning as UpdateEmployeeBodySchema.)
const Nullable = <T extends ReturnType<typeof Type.String>>(inner: T) =>
  Type.Union([Type.Unsafe<null>({ const: null }), inner]);

export const StudentIdentifierParamsSchema = Type.Object(
  { id: UuidV7Schema, iid: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentIdentifierParams = Static<typeof StudentIdentifierParamsSchema>;

export const AddStudentIdentifierBodySchema = Type.Object(
  {
    idType: IdTypeSchema,
    value: ValueSchema,
    issuer: Type.Optional(IssuerSchema),
    validFrom: Type.Optional(DateSchema),
    validTo: Type.Optional(DateSchema),
  },
  { additionalProperties: false },
);
export type AddStudentIdentifierBody = Static<typeof AddStudentIdentifierBodySchema>;

/** Only the issuer and the validity window change; `null` clears one. At least one field is required. */
export const UpdateStudentIdentifierBodySchema = Type.Object(
  {
    issuer: Type.Optional(Nullable(IssuerSchema)),
    validFrom: Type.Optional(Nullable(DateSchema)),
    validTo: Type.Optional(Nullable(DateSchema)),
  },
  { additionalProperties: false, minProperties: 1 },
);
export type UpdateStudentIdentifierBody = Static<typeof UpdateStudentIdentifierBodySchema>;

/** Never: organization, other students, the admission number. */
export const StudentIdentifierSchema = Type.Object(
  {
    id: UuidV7Schema,
    studentId: UuidV7Schema,
    idType: IdTypeSchema,
    value: Type.String(),
    issuer: Type.Union([Type.String(), Type.Null()]),
    validFrom: Type.Union([Type.String({ pattern: DATE_PATTERN }), Type.Null()]),
    validTo: Type.Union([Type.String({ pattern: DATE_PATTERN }), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type StudentIdentifierDto = Static<typeof StudentIdentifierSchema>;

export const ListStudentIdentifiersResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(StudentIdentifierSchema) },
  { additionalProperties: false },
);
export const GetStudentIdentifierResponseSchema = Type.Object(
  { success: Type.Literal(true), data: StudentIdentifierSchema },
  { additionalProperties: false },
);
/** `{ success, data: { id } }`: the idempotency store keeps THIS body, so the identifier value is not copied into it. */
export const AddStudentIdentifierResponseSchema = CreateStudentResponseSchema;
