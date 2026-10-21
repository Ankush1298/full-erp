import { Type, type Static } from '@sinclair/typebox';

export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'WEB_PUSH', 'SMS', 'WHATSAPP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = [
  'SECURITY',
  'ACADEMIC',
  'ADMINISTRATIVE',
  'ANNOUNCEMENT',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const MANDATORY_CATEGORIES = ['SECURITY'] as const;

export const NotificationChannelSchema = Type.Union(
  NOTIFICATION_CHANNELS.map((c) => Type.Literal(c)),
);
export const NotificationCategorySchema = Type.Union(
  NOTIFICATION_CATEGORIES.map((c) => Type.Literal(c)),
);

export const NotificationDtoSchema = Type.Object(
  {
    id: UuidV7Schema,
    recipientUserId: UuidV7Schema,
    category: Type.String(),
    title: Type.String(),
    body: Type.String(),
    actionUrl: Type.Union([Type.String(), Type.Null()]),
    entityType: Type.Union([Type.String(), Type.Null()]),
    entityId: Type.Union([UuidV7Schema, Type.Null()]),
    readAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
  },
  { additionalProperties: false },
);
export type NotificationDto = Static<typeof NotificationDtoSchema>;

export const ListNotificationsResponseSchema = Type.Array(NotificationDtoSchema);
export type ListNotificationsResponse = Static<typeof ListNotificationsResponseSchema>;

export const ListNotificationsQuerySchema = Type.Object(
  {
    unreadOnly: Type.Optional(Type.Boolean()),
    category: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export type ListNotificationsQuery = Static<typeof ListNotificationsQuerySchema>;

export const NotificationIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type NotificationIdParam = Static<typeof NotificationIdParamSchema>;

export const NotificationPreferenceDtoSchema = Type.Object(
  {
    category: Type.String(),
    channel: NotificationChannelSchema,
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type NotificationPreferenceDto = Static<typeof NotificationPreferenceDtoSchema>;

export const ListNotificationPreferencesResponseSchema = Type.Array(
  NotificationPreferenceDtoSchema,
);
export type ListNotificationPreferencesResponse = Static<
  typeof ListNotificationPreferencesResponseSchema
>;

export const UpdateNotificationPreferencesBodySchema = Type.Object(
  {
    preferences: Type.Array(
      Type.Object({
        category: NotificationCategorySchema,
        channel: NotificationChannelSchema,
        enabled: Type.Boolean(),
      }),
      { minItems: 1, maxItems: 50 },
    ),
  },
  { additionalProperties: false },
);
export type UpdateNotificationPreferencesBody = Static<
  typeof UpdateNotificationPreferencesBodySchema
>;

export const MarkAllReadResponseSchema = Type.Object(
  { count: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
export type MarkAllReadResponse = Static<typeof MarkAllReadResponseSchema>;

export const DispatchNotificationInputSchema = Type.Object(
  {
    recipientUserId: UuidV7Schema,
    category: NotificationCategorySchema,
    title: Type.String({ minLength: 1, maxLength: 255 }),
    body: Type.String({ minLength: 1, maxLength: 65536 }),
    channels: Type.Optional(Type.Array(NotificationChannelSchema)),
    actionUrl: Type.Optional(Type.String()),
    entityType: Type.Optional(Type.String({ maxLength: 60 })),
    entityId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type DispatchNotificationInput = Static<typeof DispatchNotificationInputSchema>;

export const DispatchNotificationResponseSchema = Type.Object(
  {
    notificationId: Type.Union([UuidV7Schema, Type.Null()]),
    deliveries: Type.Array(
      Type.Object({
        id: UuidV7Schema,
        channel: NotificationChannelSchema,
        status: Type.String(),
        error: Type.Optional(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);
export type DispatchNotificationResponse = Static<typeof DispatchNotificationResponseSchema>;
