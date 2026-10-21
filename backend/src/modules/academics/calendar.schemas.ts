import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { UuidV7Schema } from './academic.schemas.js';

/** Request/response contracts of the Milestone 3 academic calendar, courses, curriculum and sections. */

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
export const DateSchema = Type.String({ pattern: DATE_PATTERN });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
const strict = { additionalProperties: false } as const;

export const ACADEMIC_YEAR_STATUSES = ['PLANNED', 'ACTIVE', 'CLOSED'] as const;
export const TERM_STATUSES = ['PLANNED', 'ACTIVE', 'CLOSED', 'LOCKED'] as const;
export const COURSE_TYPES = [
  'THEORY',
  'PRACTICAL',
  'THEORY_PRACTICAL',
  'PROJECT',
  'INTERNSHIP',
  'SEMINAR',
  'AUDIT',
  'OTHER',
] as const;
export const CURRICULUM_CATEGORIES = [
  'CORE',
  'ELECTIVE',
  'OPTIONAL',
  'LAB',
  'PROJECT',
  'INTERNSHIP',
] as const;

const literalUnion = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((v) => Type.Literal(v))));

export function DataResponse<T extends TSchema>(data: T) {
  return Type.Object({ success: Type.Literal(true), data }, strict);
}
export function ListResponse<T extends TSchema>(item: T) {
  return Type.Object({ success: Type.Literal(true), data: Type.Array(item) }, strict);
}

// ---- academic years ----------------------------------------------------------------------------
export const CreateAcademicYearBodySchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 20 }),
    startDate: DateSchema,
    endDate: DateSchema,
  },
  strict,
);
export type CreateAcademicYearBody = Static<typeof CreateAcademicYearBodySchema>;

export const UpdateAcademicYearBodySchema = Type.Object(
  {
    startDate: Type.Optional(DateSchema),
    endDate: Type.Optional(DateSchema),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('CLOSED')])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateAcademicYearBody = Static<typeof UpdateAcademicYearBodySchema>;

export const AcademicYearRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    label: Type.String(),
    startDate: Type.String(),
    endDate: Type.String(),
    status: literalUnion(ACADEMIC_YEAR_STATUSES),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type AcademicYearDto = Static<typeof AcademicYearRecordSchema>;
export const ListAcademicYearsQuerySchema = Type.Object(
  { status: Type.Optional(literalUnion(ACADEMIC_YEAR_STATUSES)) },
  strict,
);
export type ListAcademicYearsQuery = Static<typeof ListAcademicYearsQuerySchema>;

// ---- terms -------------------------------------------------------------------------------------
export const CreateTermBodySchema = Type.Object(
  {
    campusId: UuidV7Schema,
    academicYearId: UuidV7Schema,
    code: Type.String({ minLength: 1, maxLength: 30 }),
    name: Type.String({ minLength: 1, maxLength: 255 }),
    startDate: DateSchema,
    endDate: DateSchema,
  },
  strict,
);
export type CreateTermBody = Static<typeof CreateTermBodySchema>;

export const UpdateTermBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    startDate: Type.Optional(DateSchema),
    endDate: Type.Optional(DateSchema),
    status: Type.Optional(
      Type.Union([Type.Literal('ACTIVE'), Type.Literal('CLOSED'), Type.Literal('LOCKED')]),
    ),
    /** Mandatory (5-500 characters) when status moves to LOCKED (A2); optional otherwise. */
    reason: Type.Optional(ReasonSchema),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateTermBody = Static<typeof UpdateTermBodySchema>;

export const TermRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    campusId: UuidV7Schema,
    academicYearId: UuidV7Schema,
    code: Type.String(),
    name: Type.String(),
    startDate: Type.String(),
    endDate: Type.String(),
    status: literalUnion(TERM_STATUSES),
    lockedAt: Type.Union([Type.String(), Type.Null()]),
    lockedBy: Type.Union([UuidV7Schema, Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type TermDto = Static<typeof TermRecordSchema>;
export const ListTermsQuerySchema = Type.Object(
  {
    campusId: Type.Optional(UuidV7Schema),
    academicYearId: Type.Optional(UuidV7Schema),
    status: Type.Optional(literalUnion(TERM_STATUSES)),
  },
  strict,
);
export type ListTermsQuery = Static<typeof ListTermsQuerySchema>;

// ---- cohort periods ----------------------------------------------------------------------------
export const CreateCohortPeriodBodySchema = Type.Object(
  {
    cohortId: UuidV7Schema,
    termId: UuidV7Schema,
    periodNo: Type.Integer({ minimum: 1, maximum: 200 }),
    isExtension: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type CreateCohortPeriodBody = Static<typeof CreateCohortPeriodBodySchema>;
export const UpdateCohortPeriodBodySchema = Type.Object({ status: Type.Literal('CLOSED') }, strict);
export type UpdateCohortPeriodBody = Static<typeof UpdateCohortPeriodBodySchema>;
export const CohortPeriodRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    cohortId: UuidV7Schema,
    termId: UuidV7Schema,
    periodNo: Type.Integer(),
    isExtension: Type.Boolean(),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('CLOSED')]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type CohortPeriodDto = Static<typeof CohortPeriodRecordSchema>;
export const ListCohortPeriodsQuerySchema = Type.Object(
  {
    cohortId: Type.Optional(UuidV7Schema),
    termId: Type.Optional(UuidV7Schema),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('CLOSED')])),
  },
  strict,
);
export type ListCohortPeriodsQuery = Static<typeof ListCohortPeriodsQuerySchema>;

// ---- sections ----------------------------------------------------------------------------------
export const CreateSectionBodySchema = Type.Object(
  {
    cohortPeriodId: UuidV7Schema,
    name: Type.String({ minLength: 1, maxLength: 50 }),
    capacity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  },
  strict,
);
export type CreateSectionBody = Static<typeof CreateSectionBodySchema>;
export const UpdateSectionBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    capacity: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1, maximum: 10000 }), Type.Null()]),
    ),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateSectionBody = Static<typeof UpdateSectionBodySchema>;
export const SectionRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    cohortPeriodId: UuidV7Schema,
    name: Type.String(),
    capacity: Type.Union([Type.Integer(), Type.Null()]),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
    memberCount: Type.Integer(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type SectionDto = Static<typeof SectionRecordSchema>;
export const ListSectionsQuerySchema = Type.Object(
  { cohortPeriodId: Type.Optional(UuidV7Schema) },
  strict,
);
export type ListSectionsQuery = Static<typeof ListSectionsQuerySchema>;

// ---- courses -----------------------------------------------------------------------------------
export const CreateCourseBodySchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 30 }),
    title: Type.String({ minLength: 1, maxLength: 255 }),
    credits: Type.Number({ minimum: 0, maximum: 99.9 }),
    courseType: literalUnion(COURSE_TYPES),
    tracksAttendance: Type.Optional(Type.Boolean()),
    owningDepartmentId: Type.Optional(UuidV7Schema),
  },
  strict,
);
export type CreateCourseBody = Static<typeof CreateCourseBodySchema>;
export const UpdateCourseBodySchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    credits: Type.Optional(Type.Number({ minimum: 0, maximum: 99.9 })),
    courseType: Type.Optional(literalUnion(COURSE_TYPES)),
    tracksAttendance: Type.Optional(Type.Boolean()),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateCourseBody = Static<typeof UpdateCourseBodySchema>;
export const CourseRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    owningDepartmentId: Type.Union([UuidV7Schema, Type.Null()]),
    code: Type.String(),
    title: Type.String(),
    credits: Type.Number(),
    courseType: literalUnion(COURSE_TYPES),
    tracksAttendance: Type.Boolean(),
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type CourseDto = Static<typeof CourseRecordSchema>;
export const ListCoursesQuerySchema = Type.Object(
  {
    departmentId: Type.Optional(UuidV7Schema),
    status: Type.Optional(Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')])),
  },
  strict,
);
export type ListCoursesQuery = Static<typeof ListCoursesQuerySchema>;

// ---- curriculum --------------------------------------------------------------------------------
export const CreateCurriculumCourseBodySchema = Type.Object(
  {
    programId: UuidV7Schema,
    courseId: UuidV7Schema,
    regulation: Type.String({ minLength: 1, maxLength: 30 }),
    periodNo: Type.Integer({ minimum: 1, maximum: 200 }),
    category: literalUnion(CURRICULUM_CATEGORIES),
    electiveGroupCode: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  },
  strict,
);
export type CreateCurriculumCourseBody = Static<typeof CreateCurriculumCourseBodySchema>;
export const UpdateCurriculumCourseBodySchema = Type.Object(
  {
    category: Type.Optional(literalUnion(CURRICULUM_CATEGORIES)),
    electiveGroupCode: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 30 }), Type.Null()]),
    ),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateCurriculumCourseBody = Static<typeof UpdateCurriculumCourseBodySchema>;
export const CurriculumCourseRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    programId: UuidV7Schema,
    courseId: UuidV7Schema,
    regulation: Type.String(),
    periodNo: Type.Integer(),
    category: literalUnion(CURRICULUM_CATEGORIES),
    electiveGroupCode: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type CurriculumCourseDto = Static<typeof CurriculumCourseRecordSchema>;
export const ListCurriculumQuerySchema = Type.Object(
  {
    programId: UuidV7Schema,
    regulation: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
    periodNo: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  strict,
);
export type ListCurriculumQuery = Static<typeof ListCurriculumQuerySchema>;

export const OkResponseSchema = Type.Object({ success: Type.Literal(true) }, strict);
