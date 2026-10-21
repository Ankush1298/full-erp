import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { recordOutboxEvent } from '../../shared/outbox/index.js';
import type {
  DispatchNotificationInput,
  DispatchNotificationResponse,
  ListNotificationsQuery,
  NotificationChannel,
  NotificationDto,
  NotificationPreferenceDto,
  UpdateNotificationPreferencesBody,
} from './notification.schemas.js';
import {
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
} from './notification.schemas.js';
import {
  type NotificationChannelProvider,
  DisabledEmailProvider,
} from './providers/channel-provider.js';

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface NotificationRow {
  id: string;
  organization_id: string;
  recipient_user_id: string;
  category: string;
  title: string;
  body: string;
  action_url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PreferenceRow {
  id: string;
  organization_id: string;
  user_id: string;
  category: string;
  channel: NotificationChannel;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toNotificationDto(row: NotificationRow): NotificationDto {
  return {
    id: row.id,
    recipientUserId: row.recipient_user_id,
    category: row.category,
    title: row.title,
    body: row.body,
    actionUrl: row.action_url ?? null,
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export class NotificationService {
  private readonly emailProvider: NotificationChannelProvider;

  constructor(emailProvider?: NotificationChannelProvider) {
    this.emailProvider = emailProvider ?? new DisabledEmailProvider();
  }

  /**
   * Dispatches a notification across specified channels (doc 03 §13.2).
   * Checks recipient preferences, records in-app inbox and per-channel delivery rows,
   * safe log redaction, and atomic outbox domain event.
   */
  public async dispatch(
    tx: TenantTx,
    ctx: TrustedContext,
    input: DispatchNotificationInput,
  ): Promise<DispatchNotificationResponse> {
    ensureTrusted(ctx);

    if (!isUuidV7(input.recipientUserId)) {
      throw new AppError(400, 'INVALID_RECIPIENT_ID', 'recipientUserId must be a valid UUIDv7.');
    }

    // Verify recipient exists in this tenant and fetch email
    const { rows: users } = await tx.query<{ id: string; email: string | null }>(
      `SELECT id, email FROM app.users WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, input.recipientUserId],
    );
    const recipientUser = users[0];
    if (!recipientUser) {
      throw resourceNotFound();
    }

    const requestedChannels: NotificationChannel[] =
      input.channels && input.channels.length > 0 ? input.channels : ['IN_APP', 'EMAIL'];

    // Load recipient preferences for this tenant
    const { rows: prefRows } = await tx.query<PreferenceRow>(
      `SELECT category, channel, enabled
         FROM app.notification_preferences
        WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, input.recipientUserId],
    );
    const prefMap = new Map<string, boolean>();
    for (const p of prefRows) {
      prefMap.set(`${p.category}:${p.channel}`, p.enabled);
    }

    let inAppNotificationId: string | null = null;
    const deliveries: {
      id: string;
      channel: NotificationChannel;
      status: string;
      error?: string;
    }[] = [];

    for (const channel of requestedChannels) {
      const isMandatory = MANDATORY_CATEGORIES.includes(
        input.category as (typeof MANDATORY_CATEGORIES)[number],
      );
      const isExplicitlyDisabled = prefMap.get(`${input.category}:${channel}`) === false;

      if (!isMandatory && isExplicitlyDisabled) {
        // Channel delivery suppressed by user preference
        const deliveryId = uuidv7();
        await tx.query(
          `INSERT INTO app.notification_deliveries (
             id, organization_id, channel, recipient_user_id, destination, status,
             provider, suppression_reason
           ) VALUES ($1, $2, $3, $4, $5, 'SUPPRESSED', 'preferences', 'USER_PREFERENCE_DISABLED')`,
          [deliveryId, ctx.tenantId, channel, input.recipientUserId, 'user-preference'],
        );
        deliveries.push({ id: deliveryId, channel, status: 'SUPPRESSED' });
        continue;
      }

      if (channel === 'IN_APP') {
        inAppNotificationId = uuidv7();
        await tx.query(
          `INSERT INTO app.notifications (
             id, organization_id, recipient_user_id, category, title, body, action_url, entity_type, entity_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            inAppNotificationId,
            ctx.tenantId,
            input.recipientUserId,
            input.category,
            input.title,
            input.body,
            input.actionUrl ?? null,
            input.entityType ?? null,
            input.entityId ?? null,
          ],
        );

        const deliveryId = uuidv7();
        await tx.query(
          `INSERT INTO app.notification_deliveries (
             id, organization_id, notification_id, channel, recipient_user_id,
             destination, status, provider, sent_at
           ) VALUES ($1, $2, $3, 'IN_APP', $4, 'in-app-inbox', 'DELIVERED', 'in-app', now())`,
          [deliveryId, ctx.tenantId, inAppNotificationId, input.recipientUserId],
        );

        deliveries.push({ id: deliveryId, channel: 'IN_APP', status: 'DELIVERED' });
      } else if (channel === 'EMAIL') {
        const deliveryId = uuidv7();
        if (!recipientUser.email) {
          await tx.query(
            `INSERT INTO app.notification_deliveries (
               id, organization_id, channel, recipient_user_id, destination, status,
               provider, error_code
             ) VALUES ($1, $2, 'EMAIL', $3, 'none', 'FAILED', $4, 'NO_EMAIL_ADDRESS')`,
            [deliveryId, ctx.tenantId, input.recipientUserId, this.emailProvider.providerName],
          );
          deliveries.push({
            id: deliveryId,
            channel: 'EMAIL',
            status: 'FAILED',
            error: 'NO_EMAIL_ADDRESS',
          });
        } else {
          const sendResult = await this.emailProvider.send({
            recipientUserId: input.recipientUserId,
            destination: recipientUser.email,
            category: input.category,
            body: input.body,
            ...(input.title !== undefined ? { subject: input.title } : {}),
          });

          await tx.query(
            `INSERT INTO app.notification_deliveries (
               id, organization_id, channel, recipient_user_id, destination, status,
               provider, provider_message_ref, error_code, sent_at
             ) VALUES ($1, $2, 'EMAIL', $3, $4, $5, $6, $7, $8, $9)`,
            [
              deliveryId,
              ctx.tenantId,
              input.recipientUserId,
              recipientUser.email,
              sendResult.success ? 'SENT' : 'FAILED',
              this.emailProvider.providerName,
              sendResult.providerMessageId ?? null,
              sendResult.errorCode ?? null,
              sendResult.success ? new Date() : null,
            ],
          );

          deliveries.push({
            id: deliveryId,
            channel: 'EMAIL',
            status: sendResult.success ? 'SENT' : 'FAILED',
            ...(sendResult.errorMessage !== undefined ? { error: sendResult.errorMessage } : {}),
          });
        }
      } else {
        // WEB_PUSH, SMS, WHATSAPP are future provider channels
        const deliveryId = uuidv7();
        await tx.query(
          `INSERT INTO app.notification_deliveries (
             id, organization_id, channel, recipient_user_id, destination, status,
             provider, suppression_reason
           ) VALUES ($1, $2, $3, $4, 'unconfigured', 'SUPPRESSED', 'platform', 'UNSUPPORTED_CHANNEL')`,
          [deliveryId, ctx.tenantId, channel, input.recipientUserId],
        );
        deliveries.push({ id: deliveryId, channel, status: 'SUPPRESSED' });
      }
    }

    // Atomic outbox event relay
    await recordOutboxEvent(tx, ctx, {
      eventType: 'notification.dispatched',
      aggregateType: 'notification',
      aggregateId: inAppNotificationId ?? deliveries[0]?.id ?? uuidv7(),
      payload: {
        recipientUserId: input.recipientUserId,
        category: input.category,
        deliveryCount: deliveries.length,
      },
    });

    return {
      notificationId: inAppNotificationId,
      deliveries,
    };
  }

  /**
   * Lists in-app notifications for the authenticated user (doc 03 §13.2).
   */
  public async listNotifications(
    tx: TenantTx,
    ctx: TrustedContext,
    query: ListNotificationsQuery,
  ): Promise<NotificationDto[]> {
    ensureTrusted(ctx);

    await AuthorizationEngine.assert(tx, ctx, 'notification.read', {
      organization_id: ctx.tenantId,
      user_id: ctx.userId,
    });

    const conditions: string[] = ['organization_id = $1', 'recipient_user_id = $2'];
    const params: unknown[] = [ctx.tenantId, ctx.userId];

    if (query.unreadOnly) {
      conditions.push('read_at IS NULL');
    }

    if (query.category) {
      params.push(query.category);
      conditions.push(`category = $${params.length}`);
    }

    const limit = query.limit ?? 50;
    params.push(limit);

    const { rows } = await tx.query<NotificationRow>(
      `SELECT * FROM app.notifications
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );

    return rows.map(toNotificationDto);
  }

  /**
   * Marks a single in-app notification as read.
   */
  public async markAsRead(tx: TenantTx, ctx: TrustedContext, id: string): Promise<NotificationDto> {
    ensureTrusted(ctx);

    if (!isUuidV7(id)) {
      throw new AppError(400, 'INVALID_NOTIFICATION_ID', 'Notification id must be a valid UUIDv7.');
    }

    await AuthorizationEngine.assert(tx, ctx, 'notification.read', {
      organization_id: ctx.tenantId,
      user_id: ctx.userId,
    });

    const { rows } = await tx.query<NotificationRow>(
      `SELECT * FROM app.notifications
        WHERE organization_id = $1 AND id = $2 AND recipient_user_id = $3`,
      [ctx.tenantId, id, ctx.userId],
    );

    const notif = rows[0];
    if (!notif) {
      throw resourceNotFound();
    }
    if (notif.read_at) {
      return toNotificationDto(notif);
    }

    const { rows: updatedRows } = await tx.query<NotificationRow>(
      `UPDATE app.notifications
          SET read_at = now(), updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND recipient_user_id = $3
        RETURNING *`,
      [ctx.tenantId, id, ctx.userId],
    );

    const updated = updatedRows[0];
    if (!updated) {
      throw resourceNotFound();
    }
    return toNotificationDto(updated);
  }

  /**
   * Marks all unread in-app notifications as read for current user.
   */
  public async markAllAsRead(tx: TenantTx, ctx: TrustedContext): Promise<{ count: number }> {
    ensureTrusted(ctx);

    await AuthorizationEngine.assert(tx, ctx, 'notification.read', {
      organization_id: ctx.tenantId,
      user_id: ctx.userId,
    });

    const { rows } = await tx.query<{ count: string }>(
      `WITH upd AS (
         UPDATE app.notifications
            SET read_at = now(), updated_at = now()
          WHERE organization_id = $1 AND recipient_user_id = $2 AND read_at IS NULL
          RETURNING id
       )
       SELECT count(*)::text AS count FROM upd`,
      [ctx.tenantId, ctx.userId],
    );

    return { count: Number(rows[0]?.count ?? '0') };
  }

  /**
   * Retrieves recipient preferences for current user.
   */
  public async getPreferences(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<NotificationPreferenceDto[]> {
    ensureTrusted(ctx);

    await AuthorizationEngine.assert(tx, ctx, 'notification.preference.manage', {
      organization_id: ctx.tenantId,
      user_id: ctx.userId,
    });

    const { rows } = await tx.query<PreferenceRow>(
      `SELECT category, channel, enabled
         FROM app.notification_preferences
        WHERE organization_id = $1 AND user_id = $2
        ORDER BY category, channel`,
      [ctx.tenantId, ctx.userId],
    );

    const map = new Map<string, boolean>();
    for (const r of rows) {
      map.set(`${r.category}:${r.channel}`, r.enabled);
    }

    const result: NotificationPreferenceDto[] = [];
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        const key = `${category}:${channel}`;
        result.push({
          category,
          channel,
          enabled: map.has(key) ? (map.get(key) as boolean) : true,
        });
      }
    }

    return result;
  }

  /**
   * Updates notification preferences for current user.
   * Rejects disabling mandatory categories (e.g. SECURITY).
   */
  public async updatePreferences(
    tx: TenantTx,
    ctx: TrustedContext,
    body: UpdateNotificationPreferencesBody,
  ): Promise<NotificationPreferenceDto[]> {
    ensureTrusted(ctx);

    await AuthorizationEngine.assert(tx, ctx, 'notification.preference.manage', {
      organization_id: ctx.tenantId,
      user_id: ctx.userId,
    });

    for (const p of body.preferences) {
      if (
        MANDATORY_CATEGORIES.includes(p.category as (typeof MANDATORY_CATEGORIES)[number]) &&
        !p.enabled
      ) {
        throw new AppError(
          400,
          'MANDATORY_NOTIFICATION_CATEGORY',
          `Cannot disable notifications for mandatory category: ${p.category}.`,
        );
      }

      const id = uuidv7();
      await tx.query(
        `INSERT INTO app.notification_preferences (
           id, organization_id, user_id, category, channel, enabled
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, user_id, category, channel)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [id, ctx.tenantId, ctx.userId, p.category, p.channel, p.enabled],
      );
    }

    return this.getPreferences(tx, ctx);
  }
}
