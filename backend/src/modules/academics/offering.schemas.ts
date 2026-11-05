import { Type, type Static } from '@sinclair/typebox';
import { UuidV7Schema } from './academic.schemas.js';
import { DateSchema } from './calendar.schemas.js';

/**
 * Request/response contracts of Milestone 3 Batch 2: course offerings, faculty assignments and timetable slots
 * (docs/architecture/v3/31-course-offerings-and-scheduling-m3b2.md). No tenant, campus or department field is accepted
 * anywhere (additionalProperties: false); the offering's campus and department are derived by the server.
 */

const strict = { additionalProperties: false } as const;
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
const literals = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));
const TIME_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$';

export const OFFERING_KINDS = [
  'CORE',
  'ELECTIVE',
  'OPEN_ELECTIVE',
  'OPTIONAL',
  'LAB_GROUP',
  'PROJECT',
  'INTERNSHIP',
] as const;
export const REGISTRATION_POLICIES = [
  'AUTO_FROM_SECTION',
  'MANUAL',
  'ELECTIVE_CHOICE',
  'ADMIN_ASSIGNED',
] as const;
export const OFFERING_STATUSES = ['DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED'] as const;
export const TEACHING_ROLES = ['PRIMARY', 'CO_INSTRUCTOR', 'LAB_INSTRUCTOR', 'SUBSTITUTE'] as const;

// ---- course offerings --------------------------------------------------------------------------
export const CreateOfferingBodySchema = Type.Object(
  {
    termId: UuidV7Schema,
    courseId: UuidV7Schema,
    cohortPeriodId: Type.Optional(UuidV7Schema),
    sectionId: Type.Optional(UuidV7Schema),
    offeringKind: literals(OFFERING_KINDS),
    groupLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    registrationPolicy: literals(REGISTRATION_POLICIES),
    capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
    /** An elective basket of the offering's cohort period (migration 0039); fixed at creation. */
    electiveGroupId: Type.Optional(UuidV7Schema),
  },
  strict,
);
export type CreateOfferingBody = Static<typeof CreateOfferingBodySchema>;

/** Status moves and capacity only; identity is fixed at creation. CANCELLED needs a reason. */
export const UpdateOfferingBodySchema = Type.Object(
  {
    status: Type.Optional(
      Type.Union([Type.Literal('PUBLISHED'), Type.Literal('CLOSED'), Type.Literal('CANCELLED')]),
    ),
    capacity: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 10000 }), Type.Null()]),
    ),
    reason: Type.Optional(ReasonSchema),
  },
  strict,
);
export type UpdateOfferingBody = Static<typeof UpdateOfferingBodySchema>;

export const ListOfferingsQuerySchema = Type.Object(
  {
    termId: Type.Optional(UuidV7Schema),
    sectionId: Type.Optional(UuidV7Schema),
    cohortPeriodId: Type.Optional(UuidV7Schema),
    status: Type.Optional(literals(OFFERING_STATUSES)),
  },
  strict,
);
export type ListOfferingsQuery = Static<typeof ListOfferingsQuerySchema>;

export const OfferingRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    campusId: UuidV7Schema,
    departmentId: UuidV7Schema,
    termId: UuidV7Schema,
    courseId: UuidV7Schema,
    cohortPeriodId: Type.Union([UuidV7Schema, Type.Null()]),
    sectionId: Type.Union([UuidV7Schema, Type.Null()]),
    electiveGroupId: Type.Union([UuidV7Schema, Type.Null()]),
    offeringKind: literals(OFFERING_KINDS),
    groupLabel: Type.Union([Type.String(), Type.Null()]),
    codeSnapshot: Type.String(),
    titleSnapshot: Type.String(),
    creditsSnapshot: Type.String({ description: 'Decimal as text, e.g. "4.0"' }),
    tracksAttendance: Type.Boolean(),
    registrationPolicy: literals(REGISTRATION_POLICIES),
    capacity: Type.Union([Type.Integer(), Type.Null()]),
    status: literals(OFFERING_STATUSES),
    publishedAt: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type OfferingDto = Static<typeof OfferingRecordSchema>;

// ---- faculty assignments -----------------------------------------------------------------------
/** A2 (doc 02 §4.6): every assignment change carries a reason, stored on the audit event. */
export const CreateAssignmentBodySchema = Type.Object(
  {
    employeeId: UuidV7Schema,
    teachingRole: literals(TEACHING_ROLES),
    validFrom: DateSchema,
    validTo: Type.Optional(DateSchema),
    reason: ReasonSchema,
  },
  strict,
);
export type CreateAssignmentBody = Static<typeof CreateAssignmentBodySchema>;

/** Ends an open assignment; nothing else changes (a new teacher is a new assignment, doc 02 §5.3). */
export const EndAssignmentBodySchema = Type.Object(
  { validTo: DateSchema, reason: ReasonSchema },
  strict,
);
export type EndAssignmentBody = Static<typeof EndAssignmentBodySchema>;

export const AssignmentRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    courseOfferingId: UuidV7Schema,
    employeeId: UuidV7Schema,
    teachingRole: literals(TEACHING_ROLES),
    validFrom: Type.String(),
    validTo: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type AssignmentDto = Static<typeof AssignmentRecordSchema>;

/**
 * `/faculty` assignment view (canonical `04` Part 16 API table: `/faculty` "assignment view", "assign offerings",
 * "workload view"; Task 9): an employee's assignments with the offering they teach. Same assignment rows and services as
 * `/academics/course-offerings/:id/faculty-assignments`; no second assignment model.
 */
export const EmployeeAssignmentRecordSchema = Type.Object(
  {
    ...AssignmentRecordSchema.properties,
    termId: UuidV7Schema,
    offeringCode: Type.String(),
    offeringTitle: Type.String(),
    offeringStatus: Type.String(),
  },
  strict,
);
export type EmployeeAssignmentDto = Static<typeof EmployeeAssignmentRecordSchema>;
export const EmployeeAssignmentsQuerySchema = Type.Object(
  { termId: Type.Optional(UuidV7Schema) },
  strict,
);
export type EmployeeAssignmentsQuery = Static<typeof EmployeeAssignmentsQuerySchema>;
/** POST /faculty/employees/:id/assignments: the course-offering body with the offering named and the employee in the path. */
export const FacultyAssignBodySchema = Type.Object(
  {
    courseOfferingId: UuidV7Schema,
    teachingRole: literals(TEACHING_ROLES),
    validFrom: DateSchema,
    validTo: Type.Optional(DateSchema),
    reason: ReasonSchema,
  },
  strict,
);
export type FacultyAssignBody = Static<typeof FacultyAssignBodySchema>;

// ---- timetable slots ---------------------------------------------------------------------------
export const CreateSlotBodySchema = Type.Object(
  {
    weekday: Type.Integer({ minimum: 1, maximum: 7, description: 'ISO weekday, 1 = Monday' }),
    startTime: Type.String({ pattern: TIME_PATTERN }),
    endTime: Type.String({ pattern: TIME_PATTERN }),
    effectiveFrom: DateSchema,
    effectiveTo: Type.Optional(DateSchema),
    roomId: Type.Optional(UuidV7Schema),
    facultyAssignmentId: Type.Optional(UuidV7Schema),
  },
  strict,
);
export type CreateSlotBody = Static<typeof CreateSlotBodySchema>;

export const EndSlotBodySchema = Type.Object({ effectiveTo: DateSchema }, strict);
export type EndSlotBody = Static<typeof EndSlotBodySchema>;

export const SlotRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    courseOfferingId: UuidV7Schema,
    roomId: Type.Union([UuidV7Schema, Type.Null()]),
    facultyAssignmentId: Type.Union([UuidV7Schema, Type.Null()]),
    weekday: Type.Integer(),
    startTime: Type.String(),
    endTime: Type.String(),
    effectiveFrom: Type.String(),
    effectiveTo: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type SlotDto = Static<typeof SlotRecordSchema>;
