import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import {
  NotificationService,
  InMemoryEmailProvider,
} from '../../src/modules/notifications/index.js';
import type {
  NotificationDto,
  NotificationPreferenceDto,
  MarkAllReadResponse,
} from '../../src/modules/notifications/notification.schemas.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 6 });
const db = new Database(pool);
const emailProvider = new InMemoryEmailProvider();
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  notificationEmailProvider: emailProvider,
  logger: false,
});

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;

async function login(email: string): Promise<{ cookie: string; csrf: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  return {
    cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
});

afterAll(async () => {
  await app.close();
  await pool.end().catch(() => undefined);
  await T?.cleanup().catch(() => undefined);
  await OTHER?.cleanup().catch(() => undefined);
});

describe('Notification Delivery HTTP API & Service (doc 03 §13.2, doc 10 rows 42-44)', () => {
  it('GET /api/v1/notifications: student starts with empty notifications', async () => {
    const student = await login(T.emails.studentOne);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { session_token: student.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<NotificationDto[]>()).toEqual([]);
  });

  it('Transactional dispatch: delivers in-app and email with outbox event', async () => {
    const service = new NotificationService(emailProvider);
    const ctx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });

    const result = await db.withTenant(ctx, (tx) =>
      service.dispatch(tx, ctx, {
        recipientUserId: T.users.studentOne,
        category: 'ANNOUNCEMENT',
        title: 'Welcome Notice',
        body: 'Welcome to the semester!',
        channels: ['IN_APP', 'EMAIL'],
      }),
    );

    expect(result.notificationId).toBeDefined();
    expect(result.deliveries.length).toBe(2);
    expect(result.deliveries.find((d) => d.channel === 'IN_APP')?.status).toBe('DELIVERED');
    expect(result.deliveries.find((d) => d.channel === 'EMAIL')?.status).toBe('SENT');

    // Verify outbox event exists
    const outboxRows = await adminQuery<{ event_type: string }>(
      `SELECT event_type FROM app.outbox_events WHERE organization_id = $1 AND aggregate_id = $2`,
      [T.orgId, result.notificationId!],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]?.event_type).toBe('notification.dispatched');

    // StudentOne sees it via GET /api/v1/notifications
    const student = await login(T.emails.studentOne);
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { session_token: student.cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const items = listRes.json<NotificationDto[]>();
    expect(items.length).toBe(1);
    expect(items[0]?.title).toBe('Welcome Notice');
    expect(items[0]?.readAt).toBeNull();

    // Mark as read: POST /api/v1/notifications/:id/read
    const readRes = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${result.notificationId}/read`,
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
    });
    expect(readRes.statusCode).toBe(200);
    expect(readRes.json<NotificationDto>().readAt).not.toBeNull();
  });

  it('POST /api/v1/notifications/read-all: marks all unread notifications as read', async () => {
    const service = new NotificationService(emailProvider);
    const ctx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });

    // Create 2 new notifications
    await db.withTenant(ctx, async (tx) => {
      await service.dispatch(tx, ctx, {
        recipientUserId: T.users.studentOne,
        category: 'ACADEMIC',
        title: 'Assignment 1',
        body: 'Due tomorrow',
        channels: ['IN_APP'],
      });
      await service.dispatch(tx, ctx, {
        recipientUserId: T.users.studentOne,
        category: 'ACADEMIC',
        title: 'Assignment 2',
        body: 'Due next week',
        channels: ['IN_APP'],
      });
    });

    const student = await login(T.emails.studentOne);
    const readAllRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
    });
    expect(readAllRes.statusCode).toBe(200);
    expect(readAllRes.json<MarkAllReadResponse>().count).toBe(2);

    // Filter unread => should return 0
    const unreadRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unreadOnly=true',
      cookies: { session_token: student.cookie },
    });
    expect(unreadRes.statusCode).toBe(200);
    expect(unreadRes.json<NotificationDto[]>().length).toBe(0);
  });

  it('Preferences: mandatory category SECURITY cannot be disabled (400)', async () => {
    const student = await login(T.emails.studentOne);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
      payload: {
        preferences: [
          {
            category: 'SECURITY',
            channel: 'EMAIL',
            enabled: false,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe(
      'MANDATORY_NOTIFICATION_CATEGORY',
    );
  });

  it('Preferences: non-mandatory category can be disabled and suppresses dispatch', async () => {
    const student = await login(T.emails.studentOne);

    // Disable ACADEMIC email
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/notifications/preferences',
      headers: { 'x-csrf-token': student.csrf },
      cookies: { session_token: student.cookie },
      payload: {
        preferences: [
          {
            category: 'ACADEMIC',
            channel: 'EMAIL',
            enabled: false,
          },
        ],
      },
    });
    expect(putRes.statusCode).toBe(200);

    // GET /api/v1/notifications/preferences confirms change
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/preferences',
      cookies: { session_token: student.cookie },
    });
    expect(getRes.statusCode).toBe(200);
    const prefs = getRes.json<NotificationPreferenceDto[]>();
    const academicPref = prefs.find((p) => p.category === 'ACADEMIC' && p.channel === 'EMAIL');
    expect(academicPref?.enabled).toBe(false);

    // Dispatch ACADEMIC notification: in-app should succeed, email should be suppressed
    const service = new NotificationService(emailProvider);
    const ctx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });

    const result = await db.withTenant(ctx, (tx) =>
      service.dispatch(tx, ctx, {
        recipientUserId: T.users.studentOne,
        category: 'ACADEMIC',
        title: 'Quiz Alert',
        body: 'Quiz alert text',
        channels: ['IN_APP', 'EMAIL'],
      }),
    );

    const emailDel = result.deliveries.find((d) => d.channel === 'EMAIL');
    expect(emailDel?.status).toBe('SUPPRESSED');
  });

  it('RLS isolation: studentTwo cannot see studentOne notifications', async () => {
    const studentTwo = await login(T.emails.studentTwo);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { session_token: studentTwo.cookie },
    });
    expect(res.statusCode).toBe(200);
    // StudentTwo should have 0 notifications (all previous ones were sent to studentOne)
    expect(res.json<NotificationDto[]>().length).toBe(0);
  });
});
