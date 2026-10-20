import { Writable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { registerHardening } from '../../src/shared/http/hardening.js';
import { loadConfig } from '../../src/config/env.js';
import {
  createDirectoryLimiter,
  registerStudentDirectoryRoutes,
} from '../../src/modules/students/student-directory.routes.js';
import type { Database } from '../../src/shared/database/index.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { loggerOptions, type AppLoggerOptions } from '../../src/shared/logging/logger-options.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createCursorCodec } from '../../src/shared/pagination/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';

// Route-level tests without a database or a session: the plugin is mounted on a bare Fastify whose onRequest hook
// supplies an issued trusted context (the real auth hook and its permission gate are covered by the integration test and
// by tests/security). `db.withTenant` runs the handler's callback against a scripted transaction.

const URL_PATH = '/api/v1/students/directory';
const ctx: TrustedContext = issueTrustedContext({
  tenantId: uuidv7(),
  userId: uuidv7(),
  actorKind: 'STAFF',
});
const ROWS = ['B001', 'B002', 'B003'].map((n) => ({
  id: uuidv7(),
  admission_number: n,
  display_name: `Route Student ${n}`,
  status: 'ACTIVE',
}));

function fakeDb(audits: unknown[][] = []): Database {
  const tx = {
    query: (sql: string, params: unknown[] = []) => {
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('role_permissions')) {
        return rows([{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }]);
      }
      if (sql.includes('INSERT INTO app.audit_events')) {
        audits.push(params);
        return rows([]);
      }
      if (sql.includes('FROM app.students')) {
        const after = params[2] as string | null;
        const limit = params[6] as number;
        return rows(
          ROWS.filter((r) => after === null || r.admission_number > after).slice(0, limit),
        );
      }
      return rows([]);
    },
  };
  return {
    withTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as Database;
}

const key = randomBytes(32).toString('base64url');
const codec = createCursorCodec({
  activeKeyId: 'k1',
  keys: new Map([['k1', { reveal: () => key }]]),
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function mount(
  o: { limiter?: FixedWindowLimiter; db?: Database; logger?: AppLoggerOptions | false } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: o.logger ?? false,
    genReqId: () => randomUUID(), // as buildApp: the audit event validates the request id
    ajv: { customOptions: { removeAdditional: false } },
  });
  registerHardening(app, { production: false });
  app.addHook('onRequest', (req, _reply, done) => {
    (req as unknown as { tenantContext: TrustedContext }).tenantContext = ctx;
    done();
  });
  await app.register(registerStudentDirectoryRoutes, {
    prefix: '/api/v1/students',
    db: o.db ?? fakeDb(),
    codec,
    activeKeyId: 'k1',
    limiter: o.limiter ?? createDirectoryLimiter(),
  });
  apps.push(app);
  return app;
}
const get = (app: FastifyInstance, query = '') =>
  app.inject({ method: 'GET', url: `${URL_PATH}${query}` });

describe('GET /api/v1/students/directory: contract', () => {
  it('returns the five-field entries, a null cursor on the last page and nothing else', async () => {
    const app = await mount();
    const r = await get(app);
    expect(r.statusCode).toBe(200);
    const body = r.json<{ success: boolean; data: Record<string, unknown>[]; page: unknown }>();
    expect(Object.keys(body).sort()).toEqual(['data', 'page', 'success']);
    expect(body.page).toEqual({ nextCursor: null });
    expect(body.data).toHaveLength(3);
    for (const e of body.data) {
      expect(Object.keys(e).sort()).toEqual(
        ['admissionNumber', 'displayName', 'hasActiveEnrolment', 'id', 'status'].sort(),
      );
    }
  });

  it('pages through with the returned cursor and never repeats a row', async () => {
    const app = await mount();
    const seen: string[] = [];
    let q = '?limit=2';
    for (let i = 0; i < 5; i++) {
      const body = (await get(app, q)).json<{
        data: { admissionNumber: string }[];
        page: { nextCursor: string | null };
      }>();
      seen.push(...body.data.map((d) => d.admissionNumber));
      if (body.page.nextCursor === null) break;
      q = `?limit=2&cursor=${encodeURIComponent(body.page.nextCursor)}`;
    }
    expect(seen).toEqual(['B001', 'B002', 'B003']);
  });

  it('rejects unknown parameters, bad status and out-of-range limits with 400 (no tenant, campus, department, name or offset)', async () => {
    const app = await mount();
    for (const q of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?status=ENROLLED',
      '?name=ada',
      '?offset=1',
      '?campusId=x',
      '?departmentId=x',
      '?organizationId=x',
      '?total=true',
    ]) {
      const r = await get(app, q);
      expect(r.statusCode, q).toBe(400);
    }
  });

  it('every invalid cursor is the same 400 INVALID_CURSOR, including empty and oversized ones', async () => {
    const app = await mount();
    const answers = new Set<string>();
    for (const c of ['', 'junk', 'x'.repeat(3000), 'A'.repeat(100)]) {
      const r = await get(app, `?cursor=${encodeURIComponent(c)}`);
      expect(r.statusCode).toBe(400);
      answers.add(
        JSON.stringify(r.json<{ error: { code: string; message: string } }>().error.code),
      );
    }
    expect([...answers]).toEqual(['"INVALID_CURSOR"']);
  });
});

describe('GET /api/v1/students/directory: rate limit', () => {
  it('answers 429 with Retry-After once the user exceeds the window budget and recovers after the window', async () => {
    const clock = { ms: 10_000_000 };
    const limiter = new FixedWindowLimiter({
      limit: 3,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => clock.ms,
    });
    const app = await mount({ limiter });
    for (let i = 0; i < 3; i++) expect((await get(app)).statusCode).toBe(200);
    const refused = await get(app);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');
    expect(refused.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } });
    clock.ms += 60_000;
    expect((await get(app)).statusCode).toBe(200);
  });

  it('a refused request never reaches the data query or the audit log (the shared permission gate query is outside this plugin)', async () => {
    const audits: unknown[][] = [];
    const clock = { ms: 20_000_000 };
    const limiter = new FixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => clock.ms,
    });
    const app = await mount({ limiter, db: fakeDb(audits) });
    expect((await get(app)).statusCode).toBe(200);
    expect(audits).toHaveLength(1);
    expect((await get(app)).statusCode).toBe(429);
    expect((await get(app)).statusCode).toBe(429);
    expect(audits).toHaveLength(1);
  });
});

describe('GET /api/v1/students/directory: logs and audit carry no cursor or student data', () => {
  it('request logs contain neither the cursor query string nor any student identifier, name or admission number', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = { ...loggerOptions('trace'), stream } as AppLoggerOptions;
    const audits: unknown[][] = [];
    const app = await mount({ logger, db: fakeDb(audits) });
    const first = (await get(app, '?limit=1')).json<{ page: { nextCursor: string } }>();
    const cursor = first.page.nextCursor;
    expect(cursor).toBeTruthy();
    const second = await get(app, `?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(second.statusCode).toBe(200);
    await get(app, '?cursor=tampered-value-123');
    const logs = lines.join('');
    expect(logs).toContain('/api/v1/students/directory');
    for (const secret of [
      cursor,
      'tampered-value-123',
      'cursor=',
      ...ROWS.flatMap((r) => [r.id, r.display_name, r.admission_number]),
    ]) {
      expect(logs).not.toContain(secret);
    }
    const auditText = JSON.stringify(audits);
    for (const secret of [
      cursor,
      ...ROWS.flatMap((r) => [r.id, r.display_name, r.admission_number]),
    ]) {
      expect(auditText).not.toContain(secret);
    }
  });
});

describe('route registration is conditional on cursor configuration', () => {
  const dbStub = {
    health: () => Promise.resolve({ ok: true as const, serverVersion: '16' }),
  } as unknown as Database;
  const base = { DATABASE_URL: 'postgresql://app:change_me@127.0.0.1:5432/db' };
  const has = (app: FastifyInstance) => app.hasRoute({ method: 'GET', url: URL_PATH });

  it('no activation: the route does not exist (activation cases: student-directory-activation.test.ts), the lookup and profile routes still do', async () => {
    const app = buildApp({ config: loadConfig(base), db: dbStub, logger: false });
    await app.ready();
    expect(has(app)).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/students/' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/students/:id' })).toBe(true);
    await app.close();
  });

  it('valid cursor configuration AND explicit activation register it, and an unauthenticated call is refused by the auth hook, not served', async () => {
    const config = loadConfig({
      ...base,
      STUDENT_DIRECTORY_LIST_ENABLED: 'true',
      CURSOR_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
      CURSOR_ACTIVE_KEY_ID: 'k1',
    });
    const app = buildApp({ config, db: dbStub, logger: false });
    await app.ready();
    expect(has(app)).toBe(true);
    const r = await app.inject({ method: 'GET', url: URL_PATH });
    expect(r.statusCode).toBe(401);
    await app.close();
  });

  it('invalid cursor configuration fails at config load, so no app (and no route) can start with it', () => {
    expect(() =>
      loadConfig({ ...base, CURSOR_KEYS: 'k1:short', CURSOR_ACTIVE_KEY_ID: 'k1' }),
    ).toThrow();
    expect(() => loadConfig({ ...base, CURSOR_ACTIVE_KEY_ID: 'k1' })).toThrow();
  });
});
