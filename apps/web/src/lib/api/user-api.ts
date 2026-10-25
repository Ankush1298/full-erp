import { z } from 'zod';
import type { ApiClient } from './client';

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(USER_STATUSES),
  version: z.number(),
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

const ListUsersResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(UserSchema),
  page: z.object({ nextAfterId: z.string().nullable() }),
});

const GetUserResponseSchema = z.object({
  success: z.literal(true),
  data: UserSchema,
});

export const InviteDeliverySchema = z.enum(['SENT', 'FAILED', 'NOT_ATTEMPTED']);
export type InviteDelivery = z.infer<typeof InviteDeliverySchema>;

export const InviteUserResultSchema = z.object({
  userId: z.string(),
  invitationId: z.string(),
  expiresAt: z.string(),
  delivery: InviteDeliverySchema,
});
export type InviteUserResult = z.infer<typeof InviteUserResultSchema>;

const InviteUserResponseSchema = z.object({
  success: z.literal(true),
  data: InviteUserResultSchema,
});

export const USERS_PAGE_SIZE = 50;

export interface ListUsersFilter {
  status?: UserStatus | undefined;
  limit?: number | undefined;
  afterId?: string | undefined;
}

export async function fetchUsers(
  client: ApiClient,
  filter?: ListUsersFilter,
): Promise<{ users: User[]; nextAfterId: string | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(filter?.limit ?? USERS_PAGE_SIZE));
  if (filter?.status) params.set('status', filter.status);
  if (filter?.afterId) params.set('afterId', filter.afterId);
  const res = await client.get(`/users?${params.toString()}`, { schema: ListUsersResponseSchema });
  return { users: res.data, nextAfterId: res.page.nextAfterId };
}

export async function fetchUser(client: ApiClient, userId: string): Promise<User> {
  const res = await client.get(`/users/${encodeURIComponent(userId)}`, {
    schema: GetUserResponseSchema,
  });
  return res.data;
}

export interface InviteUserInput {
  email: string;
  displayName: string;
  reason: string;
}

export async function inviteUser(
  client: ApiClient,
  input: InviteUserInput,
): Promise<InviteUserResult> {
  const res = await client.post('/users/invite', {
    body: input,
    schema: InviteUserResponseSchema,
  });
  return res.data;
}

export interface UserStatusChangeInput {
  reason: string;
}

export async function suspendUser(
  client: ApiClient,
  user: Pick<User, 'id' | 'version'>,
  input: UserStatusChangeInput,
): Promise<User> {
  const res = await client.post(`/users/${encodeURIComponent(user.id)}/suspend`, {
    body: input,
    headers: { 'If-Match': `"${user.version}"` },
    schema: GetUserResponseSchema,
  });
  return res.data;
}

export async function reactivateUser(
  client: ApiClient,
  user: Pick<User, 'id' | 'version'>,
  input: UserStatusChangeInput,
): Promise<User> {
  const res = await client.post(`/users/${encodeURIComponent(user.id)}/reactivate`, {
    body: input,
    headers: { 'If-Match': `"${user.version}"` },
    schema: GetUserResponseSchema,
  });
  return res.data;
}
