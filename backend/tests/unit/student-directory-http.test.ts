import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { hashToken } from '../../src/modules/auth/auth.repository.js';
import { CURSOR_ISSUE_FAILED_EVENT } from '../../src/modules/students/student-directory-list.service.js';
import type { Database } from '../../src/shared/database/index.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { loggerOptions, type AppLoggerOptions } from '../../src/shared/logging/logger-options.js';

// Database-free: the REAL buildApp, auth hook, permission gate, validation, directory handler, service, cursor codec,
// audit writer and error handler run over a scripted stand-in for the database. The stand-in answers only the statements
// those pieces issue and REJECTS every other statement (recorded in `unexpected`). It never connects to PostgreSQL.

const base = { DATABASE_URL: 'postgresql://app:change_me@127.0.0.1:5432/db' };
const KEY = randomBytes(32).toString('base64url');
const config = loadConfig({
  ...base,
  CURSOR_KEYS: `k1:${KEY}`,
  CURSOR_ACTIVE_KEY_ID: 'k1',
  STUDENT_DIRECTORY_LIST_ENABLED: 'true',
});
const PATH = '/api/v1/students/directory';
const tenantId = uuidv7();

interface Person {
  token: string;
  identityId: string;
  userId: string;
  perms: readonly string[];
}
const person = (perms: readonly string[]): Person => ({
  token: `tok-${randomBytes(8).toString('hex')}`, // secret-scan:allow (fabricated test session token, not a real credential)
  identityId: uuidv7(),
  userId: uuidv7(),
  perms,
});
const LIST = ['student.directory.list'];

interface Stand {
  db: Database;
  unexpected: string[];
  audits: unknown[][];
  directoryQueries: unknown[][];
  grantQueries: number;
}
function scripted(people: Person[], studentRows: unknown[]): Stand {
  const byHash = new Map(people.map((p) => [hashToken(p.token), p]));
  const s: Stand = {
    db: undefined as never,
    unexpected: [],
    audits: [],
    directoryQueries: [],
    grantQueries: 0,
  };
  const tx = {
    query: (sql: string, params: unknown[] = []) => {
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('platform.auth_sessions')) {
        const p = byHash.get(params[0] as string);
        return rows(
          p
            ? [
                {
                  id: uuidv7(),
                  identity_id: p.identityId,
                  tenant_id: tenantId,
                  token_hash: params[0],
                  expires_at: new Date(Date.now() + 3_600_000),
                  revoked_at: null,
                  // a staff session that has completed its second factor (MFA-required roles, 23-mfa.md §6)
                  mfa_verified_at: new Date(Date.now() - 60_000),
                },
              ]
            : [],
        );
      }
      if (sql.includes('platform.identities')) return rows([{ status: 'ACTIVE' }]);
      if (sql.includes('get_identity_memberships')) {
        const p = people.find((x) => x.identityId === params[0]);
        return rows(
          p
            ? [
                {
                  organization_id: tenantId,
                  user_id: p.userId,
                  status: 'ACTIVE',
                  org_slug: 's',
                  org_name: 'n',
                },
              ]
            : [],
        );
      }
      if (sql.includes('FROM app.students WHERE user_id')) return rows([]); // staff
      if (sql.includes('role_permissions')) {
        s.grantQueries += 1;
        const p = people.find((x) => x.userId === params[1]);
        return rows(
          p?.perms.includes(params[2] as string)
            ? [{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }]
            : [],
        );
      }
      if (sql.includes('INSERT INTO app.audit_events')) {
        s.audits.push(params);
        return rows([]);
      }
      if (sql.includes('FROM app.students s')) {
        s.directoryQueries.push(params);
        const limit = params[6] as number;
        return rows(studentRows.slice(0, limit));
      }
      s.unexpected.push(sql);
      return Promise.reject(new Error('unexpected statement'));
    },
  };
  s.db = {
    withSystem: (fn: (t: unknown) => unknown) => fn(tx),
    withTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
    health: () => Promise.resolve({ ok: true as const, serverVersion: '16' }),
  } as unknown as Database;
  return s;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const get = (app: FastifyInstance, p: Person | null, query = '') =>
  app.inject({
    method: 'GET',
    url: `${PATH}${query}`,
    ...(p ? { cookies: { session_token: p.token } } : {}),
  });

describe('GET /api/v1/students/directory: a next cursor that cannot be issued (real handler, no database)', () => {
  const REJECTED = 'ZED 7QX'; // a space: valid for the database column, refused by the cursor codec
  const entry = (n: string) => ({
    id: uuidv7(),
    admission_number: n,
    display_name: 'Visible Name',
    status: 'ACTIVE',
  });

  async function run() {
    const admin = person(LIST);
    const stand = scripted([admin], [entry(REJECTED), entry('ZED8')]);
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const logger = { ...loggerOptions('trace'), stream } as AppLoggerOptions;
    const app = buildApp({ config, db: stand.db, logger });
    await app.ready();
    apps.push(app);
    // limit 1 reads 2 rows: the page's LAST row is the rejected value and a second row proves another page exists
    const res = await get(app, admin, '?limit=1');
    return { res, stand, logs: lines.join(''), lines, admin };
  }

  it('answers the fixed 500 envelope: no page, no audit write, no unexpected statement', async () => {
    const { res, stand } = await run();
    expect(res.statusCode).toBe(500);
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>();
    expect(body.error.code).toBe('DIRECTORY_CURSOR_UNAVAILABLE');
    expect(body.error.message).toBe('The next page cannot be addressed. Contact an administrator.');
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(stand.directoryQueries).toHaveLength(1); // the read ran; nothing after it did
    expect(stand.audits).toHaveLength(0);
    expect(stand.unexpected).toEqual([]);
  });

  it('neither the response nor the captured logs contain the rejected value, a cursor, ids, key material or the exception text', async () => {
    const { res, logs, admin } = await run();
    for (const secret of [
      REJECTED,
      'ZED',
      '7QX',
      'Visible Name',
      KEY,
      tenantId,
      admin.userId,
      admin.identityId,
      admin.token,
      'lastAdmissionNumber', // the codec's own exception text
      'Invalid cursor input',
    ]) {
      expect(res.body, secret).not.toContain(secret);
      expect(logs, secret).not.toContain(secret);
    }
  });

  it('logs one structured, identifier-free warning with fixed fields only', async () => {
    const { lines } = await run();
    const events = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o.event !== undefined);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.event).toBe(CURSOR_ISSUE_FAILED_EVENT);
    expect(e).toMatchObject({
      level: 40, // warn
      event: 'student_directory_cursor_issue_failed',
      route: 'student.directory.list',
      category: 'cursor_encode_rejected',
    });
    // only pino's own envelope (level, time, pid, hostname, reqId, msg) beside the three fixed fields
    const extra = Object.keys(e).filter(
      (k) =>
        ![
          'level',
          'time',
          'pid',
          'hostname',
          'reqId',
          'msg',
          'event',
          'route',
          'category',
        ].includes(k),
    );
    expect(extra).toEqual([]);
    expect(e.err).toBeUndefined();
  });
});

describe('GET /api/v1/students/directory: the limiter behind the real authentication hook and permission gate', () => {
  const clock = { ms: 50_000_000 };
  const setup = () => {
    const limiter = new FixedWindowLimiter({
      limit: 2,
      windowMs: 60_000,
      maxKeys: 10,
      now: () => clock.ms,
    });
    const u1 = person(LIST);
    const u2 = person(LIST);
    const noPerm = person(['student.profile.read']); // authenticated, may not list
    const stand = scripted([u1, u2, noPerm], []);
    const app = buildApp({ config, db: stand.db, logger: false, directoryLimiter: limiter });
    apps.push(app);
    return { app, limiter, u1, u2, noPerm, stand };
  };

  it('counts authenticated, authorised, valid requests only; the request over the limit is 429 with Retry-After', async () => {
    const { app, limiter, u1, stand } = setup();
    await app.ready();
    expect((await get(app, u1)).statusCode).toBe(200);
    expect(limiter.size).toBe(1);
    expect((await get(app, u1)).statusCode).toBe(200);
    const over = await get(app, u1);
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBe('60');
    expect(over.json()).toMatchObject({ error: { code: 'TOO_MANY_REQUESTS' } });
    expect(stand.directoryQueries).toHaveLength(2); // the refused request never reached the data query
    expect(stand.audits).toHaveLength(2); // nor the audit write
    clock.ms += 60_000;
    expect((await get(app, u1)).statusCode).toBe(200); // a new window
    expect(stand.unexpected).toEqual([]);
  });

  it('the gate still runs a grants query for a request the limiter then refuses (documented cost)', async () => {
    const { app, u1, stand } = setup();
    await app.ready();
    await get(app, u1);
    await get(app, u1);
    const before = stand.grantQueries;
    expect((await get(app, u1)).statusCode).toBe(429);
    expect(stand.grantQueries).toBeGreaterThan(before);
  });

  it('unauthenticated, unknown-session and unauthorised requests never create or consume a limiter entry, and cannot spend another user budget', async () => {
    const { app, limiter, u1, u2, noPerm, stand } = setup();
    await app.ready();
    for (let i = 0; i < 6; i++) {
      expect((await get(app, null)).statusCode).toBe(401);
      expect((await get(app, { ...u1, token: 'not-a-session' })).statusCode).toBe(401); // secret-scan:allow (fabricated test session token, not a real credential)
      expect((await get(app, noPerm)).statusCode).toBe(403);
    }
    expect(limiter.size).toBe(0);
    expect(stand.directoryQueries).toHaveLength(0);
    // the authorised users' budgets are untouched: both get their full 2 requests
    for (const u of [u1, u2]) {
      expect((await get(app, u)).statusCode).toBe(200);
      expect((await get(app, u)).statusCode).toBe(200);
      expect((await get(app, u)).statusCode).toBe(429);
    }
    expect(limiter.size).toBe(2);
    expect(stand.unexpected).toEqual([]);
  });

  it('requests rejected by schema validation (before the gate) are not counted; a bad cursor is', async () => {
    const { app, limiter, u1 } = setup();
    await app.ready();
    for (const q of ['?limit=0', '?limit=101', '?name=x', '?status=NOPE']) {
      expect((await get(app, u1, q)).statusCode, q).toBe(400);
    }
    expect(limiter.size).toBe(0);
    const bad = await get(app, u1, '?cursor=junk');
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('INVALID_CURSOR');
    expect(limiter.size).toBe(1);
    expect((await get(app, u1)).statusCode).toBe(200);
    expect((await get(app, u1)).statusCode).toBe(429); // the bad cursor consumed one of the two
  });
});
