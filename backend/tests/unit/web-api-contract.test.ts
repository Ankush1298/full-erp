import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';

// Every path the web client calls must be a route of the real backend once the documented proxy contract
// (docs/deployment/frontend.md) is applied: client `/v1/...` -> browser `/api/v1/...` -> backend `/api/v1/...`
// (unchanged); client `/auth/...` and `/me/mfa...` -> backend `/auth/...`, `/me/mfa...`. No database: an unknown
// route answers 404 even without a session, a known one answers 401 (or 400) first, so "not 404" proves the route.

const WEB_API = resolve(import.meta.dirname, '../../../apps/web/src/lib/api');
const ID = '01939a00-0000-7000-8000-00000000ffff';
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;

const db = {
  withSystem: () => Promise.reject(new Error('no database in this test')),
  withTenant: () => Promise.reject(new Error('no database in this test')),
  health: () => Promise.resolve({ ok: true }),
} as never;
const key = () => randomBytes(32).toString('base64url');
const app = buildApp({
  config: loadConfig({
    DATABASE_URL: 'postgresql://app@127.0.0.1:1/unused', // never connected
    CURSOR_KEYS: `c1:${key()}`,
    CURSOR_ACTIVE_KEY_ID: 'c1',
    STUDENT_DIRECTORY_LIST_ENABLED: 'true', // the directory route exists only when enabled
  }),
  db,
  storage: {} as never, // registers the document routes; never called (every request stops at 401)
  logger: false,
});
beforeAll(() => app.ready());
afterAll(() => app.close());

/** Every path literal in the web API modules, interpolations replaced by a sample value (query strings dropped). */
function clientPaths(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(WEB_API).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(resolve(WEB_API, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/[`'](\/[a-z][^`']*)[`']/g)) {
      const path = m[1]!
        .replace(/(?<=\/)\$\{[^}]*kind[^}]*\}/g, 'students')
        .replace(/(?<=\/)\$\{[^}]*\}/g, ID)
        .replace(/\$\{[^}]*\}/g, '') // a suffix such as `${queryString}`
        .split('?')[0]!;
      out.add(path);
    }
  }
  return [...out].sort();
}
const toBackend = (clientPath: string): string =>
  clientPath.startsWith('/v1/') ? `/api${clientPath}` : clientPath;
async function exists(url: string): Promise<boolean> {
  for (const method of METHODS) {
    const r = await app.inject({ method, url });
    if (r.statusCode !== 404) return true;
  }
  return false;
}

describe('web client paths against the real backend routes', () => {
  const paths = clientPaths();

  it('collects the client paths (sanity)', () => {
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toEqual(
      expect.arrayContaining(['/v1/academics/terms', '/v1/users', '/auth/login', '/me/mfa']),
    );
  });

  it.each(paths)('%s is a backend route', async (p) => {
    expect(await exists(toBackend(p)), `${toBackend(p)}`).toBe(true);
  });

  it.each([
    '/academics/terms', // the pre-fix wire path after the proxy removed /api
    '/api/academics/terms',
    '/api/api/v1/academics/terms',
    '/users',
    `/students/${ID}`,
    '/api/v1/auth/me', // auth is unversioned
    '/api/v1/me/mfa',
    '/me/consents', // consents are versioned
  ])('%s is not a backend route', async (url) => {
    expect(await exists(url)).toBe(false);
  });

  it('unauthenticated requests keep the 401 envelope on both route families', async () => {
    for (const url of [
      '/api/v1/academics/terms',
      '/api/v1/users',
      `/api/v1/students/${ID}`,
      '/auth/me',
      '/me/mfa',
    ]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
      expect(r.json<{ error: { code: string } }>().error.code, url).toBe('UNAUTHORIZED');
    }
  });
});
