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
    /**
     * Optional end of the assignment (ISO 8601 with offset). Deliberately UNTYPED here: the HTTP layer's type coercion would
     * turn a number into text; `parseValidUntil` in the service is the single, strict validator.
     */
    validUntil: Type.Optional(Type.Unknown()),
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

// ---- role administration reads and expiry change (Milestone 2, B2) -------------------------------------------------------

const ScopeTypeSchema = Type.Union(SCOPE_TYPES.map((t) => Type.Literal(t)));

/** A role of THIS tenant. `grantable` is the CALLER's role-level grant rule only; scope containment is decided at grant time. */
export const RoleDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    code: Type.String(),
    name: Type.String(),
    allowedScopeTypes: Type.Array(ScopeTypeSchema),
    permissionCount: Type.Integer({ minimum: 0 }),
    criticalPermissionCount: Type.Integer({ minimum: 0 }),
    grantable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type RoleDto = Static<typeof RoleDtoSchema>;
export const ListRolesResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(RoleDtoSchema) },
  { additionalProperties: false },
);

export const ASSIGNMENT_STATES = ['EFFECTIVE', 'EXPIRED', 'PENDING', 'REVOKED'] as const;
export const RoleAssignmentDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    roleId: UuidV7Schema,
    roleCode: Type.String(),
    scopeType: ScopeTypeSchema,
    scopeId: Type.Union([UuidV7Schema, Type.Null()]),
    scopeName: Type.Union([Type.String(), Type.Null()]),
    state: Type.Union(ASSIGNMENT_STATES.map((s) => Type.Literal(s))),
    validFrom: Type.String(),
    validUntil: Type.Union([Type.String(), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type RoleAssignmentDto = Static<typeof RoleAssignmentDtoSchema>;
export const ListRoleAssignmentsResponseSchema = Type.Object(
  { success: Type.Literal(true), data: Type.Array(RoleAssignmentDtoSchema) },
  { additionalProperties: false },
);

/** `validUntil` is required (null clears the expiry) and untyped for the same coercion reason as in the grant body. */
export const UpdateAssignmentExpiryBodySchema = Type.Object(
  { validUntil: Type.Unknown(), reason: ReasonSchema },
  { additionalProperties: false },
);
export type UpdateAssignmentExpiryBody = Static<typeof UpdateAssignmentExpiryBodySchema>;
export const UpdateAssignmentExpiryResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        id: UuidV7Schema,
        validUntil: Type.Union([Type.String(), Type.Null()]),
        version: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
