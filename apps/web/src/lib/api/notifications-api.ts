import { z } from 'zod';
import type { ApiClient } from './client';

export const NotificationItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        category: raw.category,
        title: raw.title,
        body: raw.body,
        action_url: raw.action_url !== undefined ? raw.action_url : (raw.actionUrl ?? null),
        read_at: raw.read_at !== undefined ? raw.read_at : (raw.readAt ?? null),
        created_at: raw.created_at !== undefined ? raw.created_at : raw.createdAt,
      };
    }
    return val;
  },
  z.object({
    id: z.string(),
    category: z.string(),
    title: z.string(),
    body: z.string(),
    action_url: z.string().nullable().optional(),
    read_at: z.string().nullable().optional(),
    created_at: z.string(),
  }),
);

export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export const ListNotificationsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) {
      return {
        data: val,
        pagination: {
          limit: val.length,
          has_more: false,
          next_cursor: null,
        },
      };
    }
    return val;
  },
  z.object({
    data: z.array(NotificationItemSchema),
    pagination: z
      .object({
        limit: z.number().optional().default(0),
        has_more: z.boolean().optional().default(false),
        next_cursor: z.string().nullable().optional(),
      })
      .optional()
      .default({ limit: 0, has_more: false, next_cursor: null }),
  }),
);

export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const NotificationDtoSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        organization_id: raw.organization_id ?? raw.organizationId,
        recipient_user_id: raw.recipient_user_id ?? raw.recipientUserId,
        category: raw.category,
        title: raw.title,
        body: raw.body,
        action_url: raw.action_url !== undefined ? raw.action_url : (raw.actionUrl ?? null),
        read_at: raw.read_at !== undefined ? raw.read_at : (raw.readAt ?? null),
        version: raw.version,
        created_at: raw.created_at ?? raw.createdAt,
      };
    }
    return val;
  },
  z.object({
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
  }),
);

export const MarkAllReadResponseSchema = z.object({
  count: z.number(),
});

export const NotificationPreferencesSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) {
      return { preferences: val };
    }
    return val;
  },
  z.object({
    preferences: z.array(
      z.object({
        category: z.string(),
        channel: z.string(),
        enabled: z.boolean(),
      }),
    ),
  }),
);

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export function fetchNotifications(
  client: ApiClient,
  unreadOnly = false,
  limit = 20,
): Promise<ListNotificationsResponse> {
  const query = new URLSearchParams();
  if (unreadOnly) {
    query.set('unreadOnly', 'true');
  }
  query.set('limit', String(limit));
  const queryString = query.toString() ? `?${query.toString()}` : '';

  return client.get(`/v1/notifications${queryString}`, {
    schema: ListNotificationsResponseSchema,
  });
}

export function markNotificationRead(
  client: ApiClient,
  notificationId: string,
): Promise<z.infer<typeof NotificationDtoSchema>> {
  return client.post(`/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
    schema: NotificationDtoSchema,
  });
}

export function markAllNotificationsRead(
  client: ApiClient,
): Promise<z.infer<typeof MarkAllReadResponseSchema>> {
  return client.post('/v1/notifications/read-all', {
    schema: MarkAllReadResponseSchema,
  });
}

export function fetchNotificationPreferences(client: ApiClient): Promise<NotificationPreferences> {
  return client.get('/v1/notifications/preferences', {
    schema: NotificationPreferencesSchema,
  });
}
