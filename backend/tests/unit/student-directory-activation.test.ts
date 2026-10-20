import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import type { Database } from '../../src/shared/database/index.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

// Database-free tests of the REAL buildApp registration and the REAL auth hook. The "database" is a scripted stand-in that
// answers only the session/membership/grant statements the hook issues; any other statement fails the test, so a request
// that reached a service would be noticed. Nothing here connects to PostgreSQL.

const PATH = '/api/v1/students/directory';
const base = { DATABASE_URL: 'postgresql://app:change_me@127.0.0.1:5432/db' };
const keys = () => ({
  CURSOR_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
  CURSOR_ACTIVE_KEY_ID: 'k1',
});

const tenantId = uuidv7();
const userId = uuidv7();

function scriptedDb(held: readonly string[]): { db: Database; unexpected: string[] } {
  const unexpected: string[] = [];
  const tx = {
    query: (sql: string, params: unknown[] = []) => {
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('platform.auth_sessions')) {
        return rows([
          {
            id: uuidv7(),
            identity_id: uuidv7(),
            tenant_id: tenantId,
            token_hash: 'x',
            expires_at: new Date(Date.now() + 3_600_000),
            revoked_at: null,
            // a staff session that has completed its second factor (MFA-required roles, 23-mfa.md §6)
            mfa_verified_at: new Date(Date.now() - 60_000),
          },
        ]);
      }
      if (sql.includes('platform.identities')) return rows([{ status: 'ACTIVE' }]);
      if (sql.includes('get_identity_memberships')) {
        return rows([
          {
            organization_id: tenantId,
            user_id: userId,
            status: 'ACTIVE',
            org_slug: 's',
            org_name: 'n',
          },
        ]);
      }
      if (sql.includes('FROM app.students WHERE user_id')) return rows([]); // staff, not a student
      if (sql.includes('role_permissions')) {
        return rows(
          held.includes(params[2] as string)
            ? [{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }]
            : [],
        );
      }
      unexpected.push(sql);
      return Promise.reject(new Error('unexpected statement'));
    },
  };
  const db = {
    withSystem: (fn: (t: unknown) => unknown) => fn(tx),
    withTenant: (_c: unknown, fn: (t: unknown) => unknown) => fn(tx),
    health: () => Promise.resolve({ ok: true as const, serverVersion: '16' }),
  } as unknown as Database;
  return { db, unexpected };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function mount(env: Record<string, string>, held: readonly string[] = []) {
  const s = scriptedDb(held);
  const app = buildApp({ config: loadConfig({ ...base, ...env }), db: s.db, logger: false });
  await app.ready();
  apps.push(app);
  return { app, ...s };
}
const authed = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, cookies: { session_token: 'any-token' } });
const has = (app: FastifyInstance) => app.hasRoute({ method: 'GET', url: PATH });

describe('activation: cursor keys alone never register the directory route', () => {
  it('keys configured, STUDENT_DIRECTORY_LIST_ENABLED absent: the route is not registered', async () => {
    const { app } = await mount({ ...keys() });
    expect(has(app)).toBe(false);
  });

  it('keys configured, flag explicitly "false": the route is not registered', async () => {
    const { app } = await mount({ ...keys(), STUDENT_DIRECTORY_LIST_ENABLED: 'false' });
    expect(has(app)).toBe(false);
  });

  it('flag defaults to false in the loaded configuration, with or without keys', () => {
    expect(loadConfig(base).studentDirectoryListEnabled).toBe(false);
    expect(loadConfig({ ...base, ...keys() }).studentDirectoryListEnabled).toBe(false);
  });

  it('keys and flag both present: the route is registered', async () => {
    const { app } = await mount({ ...keys(), STUDENT_DIRECTORY_LIST_ENABLED: 'true' });
    expect(has(app)).toBe(true);
  });
});

describe('activation: the flag without valid cursor configuration', () => {
  it('configuration load refuses the flag without keys, naming the variable and never a value', () => {
    let err: unknown;
    try {
      loadConfig({ ...base, STUDENT_DIRECTORY_LIST_ENABLED: 'true' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).problems.join('\n')).toMatch(
      /STUDENT_DIRECTORY_LIST_ENABLED: requires valid CURSOR_KEYS and CURSOR_ACTIVE_KEY_ID/,
    );
  });

  it('configuration load refuses the flag with invalid keys (no route can start that way)', () => {
    expect(() =>
      loadConfig({
        ...base,
        STUDENT_DIRECTORY_LIST_ENABLED: 'true',
        CURSOR_KEYS: 'k1:short',
        CURSOR_ACTIVE_KEY_ID: 'k1',
      }),
    ).toThrow(ConfigError);
  });

  it('rejects any value other than "true"/"false"', () => {
    expect(() => loadConfig({ ...base, ...keys(), STUDENT_DIRECTORY_LIST_ENABLED: '1' })).toThrow(
      ConfigError,
    );
  });

  it('buildApp does not trust a hand-built configuration: flag true but no cursor configuration registers nothing', async () => {
    const config = { ...loadConfig(base), studentDirectoryListEnabled: true };
    expect(config.cursor).toBeUndefined();
    const app = buildApp({ config, db: scriptedDb([]).db, logger: false });
    await app.ready();
    apps.push(app);
    expect(has(app)).toBe(false);
  });
});

describe('what an unregistered /api/v1/students/directory answers (real app, real auth hook, no database)', () => {
  // GET /api/v1/students/:id exists, so the path is NOT an unknown route: "directory" is read as a student id. It is
  // therefore not a 404. Unauthenticated callers get 401 from the auth hook; authenticated callers get the same 400 as any
  // other malformed student id, before any permission or database work. This is not distinguishable from /students/junk.
  it('unauthenticated: 401', async () => {
    const { app } = await mount({ ...keys() });
    const r = await app.inject({ method: 'GET', url: PATH });
    expect(r.statusCode).toBe(401);
  });

  it('authenticated, with or without any student permission: the same 400 as a malformed student id, and no data statement runs', async () => {
    for (const held of [[], ['student.profile.read', 'student.directory.list']]) {
      const { app, unexpected } = await mount({ ...keys() }, held);
      const dir = await authed(app, PATH);
      const junk = await authed(app, '/api/v1/students/not-a-student-id');
      expect(dir.statusCode).toBe(400);
      expect(dir.statusCode).toBe(junk.statusCode);
      const code = (r: typeof dir) => r.json<{ error: { code: string } }>().error.code;
      expect(code(dir)).toBe(code(junk));
      expect(unexpected).toEqual([]);
    }
  });

  it('when activated, the same request reaches the permission gate instead: 403 without student.directory.list', async () => {
    const { app } = await mount({ ...keys(), STUDENT_DIRECTORY_LIST_ENABLED: 'true' }, [
      'student.profile.read',
    ]);
    expect((await authed(app, PATH)).statusCode).toBe(403);
  });
});

describe('configuration errors never echo supplied values or key material', () => {
  // Observed format (Zod 4 enum issue): `Invalid option: expected one of "true"|"false"`, i.e. the allowed values, never the
  // input. The cursor-key messages name the variable, entry number and rule. These tests pin that for every rejection path.
  const validKey = randomBytes(32).toString('base64url');
  const cases: [string, Record<string, string>, string[]][] = [
    [
      'an invalid flag value',
      { STUDENT_DIRECTORY_LIST_ENABLED: 'LEAK-flag-7f3a' },
      ['LEAK-flag-7f3a'],
    ],
    [
      'an invalid flag value next to valid keys',
      { ...keys(), STUDENT_DIRECTORY_LIST_ENABLED: 'LEAK-flag-9c1d' },
      ['LEAK-flag-9c1d'],
    ],
    [
      'a too-short key',
      {
        CURSOR_KEYS: 'kid:LEAKKEYshort',
        CURSOR_ACTIVE_KEY_ID: 'kid',
        STUDENT_DIRECTORY_LIST_ENABLED: 'true',
      },
      ['LEAKKEYshort'],
    ],
    [
      'a 43-character key with a non-base64url character',
      { CURSOR_KEYS: `kid:${'LEAK+KEY'.padEnd(43, 'A')}`, CURSOR_ACTIVE_KEY_ID: 'kid' },
      ['LEAK+KEY'],
    ],
    [
      'a repeated key (valid material twice)',
      { CURSOR_KEYS: `a:${validKey},b:${validKey}`, CURSOR_ACTIVE_KEY_ID: 'a' },
      [validKey],
    ],
    [
      'an active key ID that is not configured',
      { CURSOR_KEYS: `a:${validKey}`, CURSOR_ACTIVE_KEY_ID: 'LEAKactiveId' },
      [validKey, 'LEAKactiveId'],
    ],
    [
      'a malformed entry carrying key material',
      { CURSOR_KEYS: validKey, CURSOR_ACTIVE_KEY_ID: 'a' },
      [validKey],
    ],
    [
      'only the keys, valid',
      { CURSOR_KEYS: `a:${validKey}`, STUDENT_DIRECTORY_LIST_ENABLED: 'true' },
      [validKey],
    ],
  ];
  for (const [name, env, secrets] of cases) {
    it(`${name}: refused, and no supplied value appears in the message or the problem list`, () => {
      let err: unknown;
      try {
        loadConfig({ ...base, ...env });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      const text = [
        (err as ConfigError).message,
        String(err),
        JSON.stringify((err as ConfigError).problems),
        (err as ConfigError).stack ?? '',
      ].join('\n');
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).toMatch(/STUDENT_DIRECTORY_LIST_ENABLED|CURSOR_/);
    });
  }
});
