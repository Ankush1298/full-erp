import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../../src/modules/notifications/notification.service.js';
import { InMemoryEmailProvider } from '../../src/modules/notifications/providers/channel-provider.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { TenantTx } from '../../src/shared/database/tenant-tx.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import * as outboxModule from '../../src/shared/outbox/index.js';

describe('NotificationService (unit)', () => {
  const orgId = '01939a00-0000-7000-8000-000000000001';
  const userId = '01939a00-0000-7000-8000-000000000002';
  const notificationId = '01939a00-0000-7000-8000-000000000003';

  const userCtx = issueTrustedContext({
    tenantId: orgId,
    userId,
    actorKind: 'STUDENT',
  });

  it('dispatches notification to in-app inbox and email provider', async () => {
    const emailProvider = new InMemoryEmailProvider();
    const service = new NotificationService(emailProvider);
    const outboxSpy = vi.spyOn(outboxModule, 'recordOutboxEvent').mockResolvedValue('outbox-1');

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM app.users')) {
        return Promise.resolve({ rows: [{ id: userId, email: 'student@campus.test' }] });
      }
      if (sql.includes('SELECT category, channel, enabled FROM app.notification_preferences')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO app.notifications')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO app.notification_deliveries')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const res = await service.dispatch(mockTx, userCtx, {
      recipientUserId: userId,
      category: 'ACADEMIC',
      title: 'Assignment Graded',
      body: 'Your math assignment has been evaluated.',
      channels: ['IN_APP', 'EMAIL'],
    });

    expect(res.notificationId).toBeDefined();
    expect(res.deliveries).toHaveLength(2);
    expect(res.deliveries.find((d) => d.channel === 'IN_APP')?.status).toBe('DELIVERED');
    expect(res.deliveries.find((d) => d.channel === 'EMAIL')?.status).toBe('SENT');
    expect(emailProvider.sentMessages).toHaveLength(1);
    expect(emailProvider.sentMessages[0]?.destination).toBe('student@campus.test');
    expect(outboxSpy).toHaveBeenCalledWith(
      mockTx,
      userCtx,
      expect.objectContaining({ eventType: 'notification.dispatched' }),
    );
  });

  it('suppresses delivery when user has disabled preference for non-mandatory category', async () => {
    const emailProvider = new InMemoryEmailProvider();
    const service = new NotificationService(emailProvider);

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('app.users')) {
        return Promise.resolve({ rows: [{ id: userId, email: 'student@campus.test' }] });
      }
      if (sql.includes('app.notification_preferences')) {
        return Promise.resolve({
          rows: [{ category: 'ANNOUNCEMENT', channel: 'EMAIL', enabled: false }],
        });
      }
      if (sql.includes('INSERT INTO app.notification_deliveries')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const res = await service.dispatch(mockTx, userCtx, {
      recipientUserId: userId,
      category: 'ANNOUNCEMENT',
      title: 'Campus Festival',
      body: 'Join the annual festival this Friday.',
      channels: ['EMAIL'],
    });

    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]?.status).toBe('SUPPRESSED');
    expect(emailProvider.sentMessages).toHaveLength(0);
  });

  it('never suppresses mandatory SECURITY notifications even if disabled in preferences', async () => {
    const emailProvider = new InMemoryEmailProvider();
    const service = new NotificationService(emailProvider);

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, email FROM app.users')) {
        return Promise.resolve({ rows: [{ id: userId, email: 'student@campus.test' }] });
      }
      if (sql.includes('SELECT category, channel, enabled FROM app.notification_preferences')) {
        // Even if somehow there's an enabled=false row for SECURITY
        return Promise.resolve({
          rows: [{ category: 'SECURITY', channel: 'EMAIL', enabled: false }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const res = await service.dispatch(mockTx, userCtx, {
      recipientUserId: userId,
      category: 'SECURITY',
      title: 'New Login Detected',
      body: 'A new login from IP 10.0.0.1 was recorded.',
      channels: ['EMAIL'],
    });

    expect(res.deliveries).toHaveLength(1);
    expect(res.deliveries[0]?.status).toBe('SENT');
    expect(emailProvider.sentMessages).toHaveLength(1);
  });

  it('rejects disabling mandatory category (SECURITY) in updatePreferences', async () => {
    vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
    const service = new NotificationService();
    const mockTx = { query: vi.fn() } as unknown as TenantTx;

    await expect(
      service.updatePreferences(mockTx, userCtx, {
        preferences: [{ category: 'SECURITY', channel: 'EMAIL', enabled: false }],
      }),
    ).rejects.toThrow(
      new AppError(
        400,
        'MANDATORY_NOTIFICATION_CATEGORY',
        'Cannot disable notifications for mandatory category: SECURITY.',
      ),
    );
  });

  it('marks a notification as read and is idempotent if already read', async () => {
    vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
    const service = new NotificationService();

    let readAtDate: Date | null = null;
    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM app.notifications')) {
        return Promise.resolve({
          rows: [
            {
              id: notificationId,
              organization_id: orgId,
              recipient_user_id: userId,
              category: 'ACADEMIC',
              title: 'Grade posted',
              body: 'Grade for Course 101 posted.',
              action_url: null,
              entity_type: null,
              entity_id: null,
              read_at: readAtDate,
              created_at: new Date('2026-10-21T00:00:00Z'),
              updated_at: new Date('2026-10-21T00:00:00Z'),
            },
          ],
        });
      }
      if (sql.includes('UPDATE app.notifications')) {
        readAtDate = new Date('2026-10-21T01:00:00Z');
        return Promise.resolve({
          rows: [
            {
              id: notificationId,
              organization_id: orgId,
              recipient_user_id: userId,
              category: 'ACADEMIC',
              title: 'Grade posted',
              body: 'Grade for Course 101 posted.',
              action_url: null,
              entity_type: null,
              entity_id: null,
              read_at: readAtDate,
              created_at: new Date('2026-10-21T00:00:00Z'),
              updated_at: new Date('2026-10-21T01:00:00Z'),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const notif = await service.markAsRead(mockTx, userCtx, notificationId);
    expect(notif.readAt).toBe('2026-10-21T01:00:00.000Z');

    // Second call when already read returns existing without running UPDATE
    const secondCall = await service.markAsRead(mockTx, userCtx, notificationId);
    expect(secondCall.readAt).toBe('2026-10-21T01:00:00.000Z');
  });
});
