import { Type, type Static } from '@sinclair/typebox';
import { UuidV7Schema } from './academic.schemas.js';
import { DateSchema } from './calendar.schemas.js';

/**
 * Class (homeroom) teachers of a section (migration 0038, docs/architecture/v3/32-class-teachers-and-progression.md).
 * A class teacher is responsible for a section; it is not a teaching assignment and never names a timetable teacher.
 * API field `classTeacherRole`, database column `role` (as `teachingRole` for faculty assignments).
 */

const strict = { additionalProperties: false } as const;
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
export const CLASS_TEACHER_ROLES = ['PRIMARY', 'ASSISTANT'] as const;
const RoleSchema = Type.Unsafe<(typeof CLASS_TEACHER_ROLES)[number]>(
  Type.Union(CLASS_TEACHER_ROLES.map((v) => Type.Literal(v))),
);

/** A2: every change carries a reason, stored on the audit event. */
export const CreateClassTeacherBodySchema = Type.Object(
  {
    employeeId: UuidV7Schema,
    classTeacherRole: RoleSchema,
    validFrom: DateSchema,
    validTo: Type.Optional(DateSchema),
    reason: ReasonSchema,
  },
  strict,
);
export type CreateClassTeacherBody = Static<typeof CreateClassTeacherBodySchema>;

/** Ends an open assignment; a new class teacher is a new row (history is kept). */
export const EndClassTeacherBodySchema = Type.Object(
  { validTo: DateSchema, reason: ReasonSchema },
  strict,
);
export type EndClassTeacherBody = Static<typeof EndClassTeacherBodySchema>;

export const ClassTeacherRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    sectionId: UuidV7Schema,
    employeeId: UuidV7Schema,
    classTeacherRole: RoleSchema,
    validFrom: Type.String(),
    validTo: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type ClassTeacherDto = Static<typeof ClassTeacherRecordSchema>;
