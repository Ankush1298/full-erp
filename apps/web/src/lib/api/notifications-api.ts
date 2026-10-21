import { z } from 'zod';
import type { ApiClient } from './client';

export const NotificationItemSchema = z.object({
  id: z.string(),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  action_url: z.string().nullable().optional(),
  read_at: z.string().nullable().optional(),
  created_at: z.string(),
});

export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const ListNotificationsResponseSchema = z.object({
  data: z.array(NotificationItemSchema),
  pagination: z.object({
    limit: z.number(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().optional(),
  }),
});

export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const NotificationDtoSchema = z.object({
  id: z.string(),
  organization_id: z.string().optional(),
  recipient_user_id: z.string().optional(),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  action_url: z.string().nullable().optional(),
  read_at: z.string().nullable().optional(),
  version: z.number().optional(),
  created_at: z.string().optional(),
});

export const MarkAllReadResponseSchema = z.object({
  count: z.number(),
});

export const NotificationPreferencesSchema = z.object({
  preferences: z.array(
    z.object({
      category: z.string(),
      channel: z.string(),
      enabled: z.boolean(),
    }),
  ),
});

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export function fetchNotifications(
  client: ApiClient,
  unreadOnly = false,
  limit = 20,
): Promise<ListNotificationsResponse> {
  const query = new URLSearchParams();
  if (unreadOnly) query.set('unread_only', 'true');
  query.set('limit', String(limit));
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return client.get(`/notifications${queryString}`, {
    schema: ListNotificationsResponseSchema,
  });
}

export function markNotificationRead(
  client: ApiClient,
  notificationId: string,
): Promise<z.infer<typeof NotificationDtoSchema>> {
  return client.post(`/notifications/${encodeURIComponent(notificationId)}/read`, {
    schema: NotificationDtoSchema,
  });
}

export function markAllNotificationsRead(
  client: ApiClient,
): Promise<z.infer<typeof MarkAllReadResponseSchema>> {
  return client.post('/notifications/read-all', {
    schema: MarkAllReadResponseSchema,
  });
}

export function fetchNotificationPreferences(client: ApiClient): Promise<NotificationPreferences> {
  return client.get('/notifications/preferences', {
    schema: NotificationPreferencesSchema,
  });
}
