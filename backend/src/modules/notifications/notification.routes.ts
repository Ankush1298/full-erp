import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { NotificationService } from './notification.service.js';
import type { NotificationChannelProvider } from './providers/channel-provider.js';
import {
  ListNotificationPreferencesResponseSchema,
  ListNotificationsQuerySchema,
  type ListNotificationsQuery,
  ListNotificationsResponseSchema,
  MarkAllReadResponseSchema,
  NotificationDtoSchema,
  NotificationIdParamSchema,
  type NotificationIdParam,
  UpdateNotificationPreferencesBodySchema,
  type UpdateNotificationPreferencesBody,
} from './notification.schemas.js';

interface NotificationRouteDeps {
  db: Database;
  emailProvider?: NotificationChannelProvider | undefined;
}

export const registerNotificationRoutes: FastifyPluginAsync<NotificationRouteDeps> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database is required for notification routes.');
  const service = new NotificationService(opts.emailProvider);

  // GET /notifications
  app.get<{ Querystring: ListNotificationsQuery }>(
    '/',
    {
      config: { permission: 'notification.read' },
      schema: {
        querystring: ListNotificationsQuerySchema,
        response: { 200: ListNotificationsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.listNotifications(tx, ctx, req.query),
      );
      return reply.send(result);
    },
  );

  // POST /notifications/:id/read
  app.post<{ Params: NotificationIdParam }>(
    '/:id/read',
    {
      config: { permission: 'notification.read' },
      schema: {
        params: NotificationIdParamSchema,
        response: { 200: NotificationDtoSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.markAsRead(tx, ctx, req.params.id),
      );
      return reply.send(result);
    },
  );

  // POST /notifications/read-all
  app.post(
    '/read-all',
    {
      config: { permission: 'notification.read' },
      schema: {
        response: { 200: MarkAllReadResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) => service.markAllAsRead(tx, ctx));
      return reply.send(result);
    },
  );

  // GET /notifications/preferences
  app.get(
    '/preferences',
    {
      config: { permission: 'notification.preference.manage' },
      schema: {
        response: { 200: ListNotificationPreferencesResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) => service.getPreferences(tx, ctx));
      return reply.send(result);
    },
  );

  // PUT /notifications/preferences
  app.put<{ Body: UpdateNotificationPreferencesBody }>(
    '/preferences',
    {
      config: { permission: 'notification.preference.manage' },
      schema: {
        body: UpdateNotificationPreferencesBodySchema,
        response: { 200: ListNotificationPreferencesResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.updatePreferences(tx, ctx, req.body),
      );
      return reply.send(result);
    },
  );
};
