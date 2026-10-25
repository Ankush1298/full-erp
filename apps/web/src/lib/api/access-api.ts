import { z } from 'zod';
import type { ApiClient } from './client';
import { SuccessSchema } from './schemas';

/**
 * Role administration (Milestone 2, B2), against the real backend routes under /api/v1:
 *   GET   /users, GET /users/:id/role-assignments, GET /roles            (user.account.read: no step-up)
 *   POST  /users/:id/role-assignments, POST /role-assignments/:id/revoke,
 *   PATCH /role-assignments/:id (If-Match = assignment version)         (CRITICAL: STEP_UP_REQUIRED without a fresh PASSWORD_MFA)
 * The mutations never retry by themselves: the page runs them through `runWithStepUp`.
 */
const SCOPE_TYPES = ['ORGANIZATION', 'CAMPUS', 'DEPARTMENT'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const AccessUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  version: z.number(),
  createdAt: z.string(),
});
export type AccessUser = z.infer<typeof AccessUserSchema>;

const ListUsersResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(AccessUserSchema),
  page: z.object({ nextAfterId: z.string().nullable() }),
});

export const AccessRoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  allowedScopeTypes: z.array(z.enum(SCOPE_TYPES)),
  permissionCount: z.number(),
  criticalPermissionCount: z.number(),
  grantable: z.boolean(),
});
export type AccessRole = z.infer<typeof AccessRoleSchema>;
const ListRolesResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(AccessRoleSchema),
});

export const AssignmentSchema = z.object({
  id: z.string(),
  roleId: z.string(),
  roleCode: z.string(),
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: z.string().nullable(),
  scopeName: z.string().nullable(),
  state: z.enum(['EFFECTIVE', 'EXPIRED', 'PENDING', 'REVOKED']),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
const ListAssignmentsResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(AssignmentSchema),
});

const GrantResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ id: z.string() }),
});
const ExpiryResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ id: z.string(), validUntil: z.string().nullable(), version: z.number() }),
});

export const USERS_PAGE_SIZE = 50;

export async function fetchAccessUsers(
  client: ApiClient,
  afterId?: string,
): Promise<{ users: AccessUser[]; nextAfterId: string | null }> {
  const query = `?limit=${USERS_PAGE_SIZE}${afterId ? `&afterId=${encodeURIComponent(afterId)}` : ''}`;
  const res = await client.get(`/users${query}`, { schema: ListUsersResponseSchema });
  return { users: res.data, nextAfterId: res.page.nextAfterId };
}

export async function fetchAccessRoles(client: ApiClient): Promise<AccessRole[]> {
  return (await client.get('/roles', { schema: ListRolesResponseSchema })).data;
}

export async function fetchAssignments(client: ApiClient, userId: string): Promise<Assignment[]> {
  const path = `/users/${encodeURIComponent(userId)}/role-assignments`;
  return (await client.get(path, { schema: ListAssignmentsResponseSchema })).data;
}

export interface GrantInput {
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string;
  reason: string;
  /** ISO 8601 with an offset, in the future; omitted = no expiry. */
  validUntil?: string;
}
export async function grantRole(
  client: ApiClient,
  userId: string,
  input: GrantInput,
): Promise<string> {
  const res = await client.post(`/users/${encodeURIComponent(userId)}/role-assignments`, {
    body: input,
    schema: GrantResponseSchema,
  });
  return res.data.id;
}

export async function revokeAssignment(
  client: ApiClient,
  assignmentId: string,
  reason: string,
): Promise<void> {
  await client.post(`/role-assignments/${encodeURIComponent(assignmentId)}/revoke`, {
    body: { reason },
    schema: SuccessSchema,
  });
}

/** `validUntil: null` clears the expiry. `version` is the assignment version the administrator is looking at (If-Match). */
export async function changeExpiry(
  client: ApiClient,
  assignment: Pick<Assignment, 'id' | 'version'>,
  input: { validUntil: string | null; reason: string },
): Promise<void> {
  await client.patch(`/role-assignments/${encodeURIComponent(assignment.id)}`, {
    body: input,
    headers: { 'If-Match': `"${assignment.version}"` },
    schema: ExpiryResponseSchema,
  });
}
