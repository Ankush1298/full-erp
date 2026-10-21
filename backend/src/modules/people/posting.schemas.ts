import { Type, type Static } from '@sinclair/typebox';
import { DATE_PATTERN, UUID_V7_PATTERN } from './employee.schemas.js';

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
const DateSchema = Type.String({ pattern: DATE_PATTERN, description: 'Calendar date, YYYY-MM-DD' });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const PostingIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type PostingIdParam = Static<typeof PostingIdParamSchema>;

export const EmployeePostingSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    employeeId: UuidV7Schema,
    departmentId: UuidV7Schema,
    designationId: Type.Union([UuidV7Schema, Type.Null()]),
    validFrom: DateSchema,
    validTo: Type.Union([DateSchema, Type.Null()]),
    isPrimary: Type.Boolean(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type EmployeePostingDto = Static<typeof EmployeePostingSchema>;

export const CreatePostingBodySchema = Type.Object(
  {
    departmentId: UuidV7Schema,
    designationId: Type.Optional(UuidV7Schema),
    validFrom: DateSchema,
    validTo: Type.Optional(DateSchema),
    isPrimary: Type.Optional(Type.Boolean()),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type CreatePostingBody = Static<typeof CreatePostingBodySchema>;

export const UpdatePostingBodySchema = Type.Object(
  {
    designationId: Type.Optional(Type.Union([Type.Unsafe<null>({ const: null }), UuidV7Schema])),
    validTo: Type.Optional(DateSchema),
    isPrimary: Type.Optional(Type.Boolean()),
    reason: ReasonSchema,
  },
  { additionalProperties: false, minProperties: 2 },
);
export type UpdatePostingBody = Static<typeof UpdatePostingBodySchema>;

export const ClosePostingBodySchema = Type.Object(
  {
    validTo: DateSchema,
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type ClosePostingBody = Static<typeof ClosePostingBodySchema>;

export const CreatePostingResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const GetPostingResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: EmployeePostingSchema,
  },
  { additionalProperties: false },
);
export type GetPostingResponse = Static<typeof GetPostingResponseSchema>;

export const ListPostingsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(EmployeePostingSchema),
  },
  { additionalProperties: false },
);
export type ListPostingsResponse = Static<typeof ListPostingsResponseSchema>;
