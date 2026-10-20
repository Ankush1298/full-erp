import { Type, type Static } from '@sinclair/typebox';
import { SCOPE_TYPES } from '../../shared/authorization/catalog.js';

const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export const USERS_DEFAULT_LIMIT = 50;
export const USERS_MAX_LIMIT = 100;

export const UserIdParamSchema = Type.Object({ id: UuidV7Schema }, { additionalProperties: false });
export type UserIdParam = Static<typeof UserIdParamSchema>;

/** Minimal fields only: no password, identity id, last login, role or student data. */
export const UserDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    email: Type.String(),
    displayName: Type.String(),
    status: Type.Union(USER_STATUSES.map((s) => Type.Literal(s))),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type UserDto = Static<typeof UserDtoSchema>;

/**
 * Keyset pagination on the user id (UUIDv7, creation order). The position is NOT signed: it only narrows the caller's own,
 * already authorized listing, so forging it reveals nothing; it is not the shared authenticated cursor (documented deviation).
 */
export const ListUsersQuerySchema = Type.Object(
  {
    status: Type.Optional(Type.Union(USER_STATUSES.map((s) => Type.Literal(s)))),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: USERS_MAX_LIMIT })),
    afterId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type ListUsersQuery = Static<typeof ListUsersQuerySchema>;
export const ListUsersResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(UserDtoSchema),
    page: Type.Object(
      { nextAfterId: Type.Union([UuidV7Schema, Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** No tenant, role, scope, status or token field exists: an invitation names a person, nothing else. */
export const InviteUserBodySchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    displayName: Type.String({ minLength: 1, maxLength: 200 }),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type InviteUserBody = Static<typeof InviteUserBodySchema>;
export const InviteUserResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        userId: UuidV7Schema,
        invitationId: UuidV7Schema,
        expiresAt: Type.String(),
        /** SENT, FAILED (the mailer rejected it: re-invite), NOT_ATTEMPTED (an idempotent replay: nothing was sent again). */
        delivery: Type.Union([
          Type.Literal('SENT'),
          Type.Literal('FAILED'),
          Type.Literal('NOT_ATTEMPTED'),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const UserStatusChangeBodySchema = Type.Object(
  { reason: ReasonSchema },
  { additionalProperties: false },
);
export type UserStatusChangeBody = Static<typeof UserStatusChangeBodySchema>;
export const GetUserResponseSchema = Type.Object(
  { success: Type.Literal(true), data: UserDtoSchema },
  { additionalProperties: false },
);

/** Role grant (existing RoleAssignmentService decides everything that matters; the body only names the target). */
export const GrantRoleBodySchema = Type.Object(
  {
    roleId: UuidV7Schema,
    scopeType: Type.Union(SCOPE_TYPES.map((s) => Type.Literal(s))),
    scopeId: Type.Optional(UuidV7Schema),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type GrantRoleBody = Static<typeof GrantRoleBodySchema>;
export const GrantRoleResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export const RevokeRoleBodySchema = Type.Object(
  { reason: ReasonSchema },
  { additionalProperties: false },
);
export type RevokeRoleBody = Static<typeof RevokeRoleBodySchema>;
export const RoleAssignmentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type RoleAssignmentIdParam = Static<typeof RoleAssignmentIdParamSchema>;
export const OkResponseSchema = Type.Object(
  { success: Type.Literal(true) },
  { additionalProperties: false },
);

export const IssueMfaTicketResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        ticketId: UuidV7Schema,
        ticket: Type.String(),
        expiresAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type IssueMfaTicketResponse = Static<typeof IssueMfaTicketResponseSchema>;
