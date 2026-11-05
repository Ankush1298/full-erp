import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import viteConfig from '../vite.config';
import { fetchTerms } from '../src/lib/api/academics-api';
import { fetchMe, login } from '../src/lib/api/auth-api';
import { fetchMyConsents } from '../src/lib/api/consents-api';
import { fetchMfaStatus } from '../src/lib/api/mfa-api';
import { fetchStudent } from '../src/lib/api/students-api';
import { fetchUsers } from '../src/lib/api/user-api';
import { ApiClient, isApiPath } from '../src/lib/api/client';
import { ApiError } from '../src/lib/api/errors';

// The web-to-backend path contract (docs/deployment/frontend.md "Web-to-backend path contract"):
// `/api/v1/...` is forwarded unchanged, `/api/auth/...` and `/api/me/mfa...` lose `/api`, nothing else is proxied.
// One expectation table drives the client, the Vite dev proxy and the production nginx example.

const ID = '01939a00-0000-7000-8000-00000000a501';
/** browser path -> backend path (`null` = not proxied: served by the web app) */
const CONTRACT: Array<[string, string | null]> = [
  ['/api/v1/academics/terms', '/api/v1/academics/terms'],
  ['/api/v1/users?limit=50', '/api/v1/users?limit=50'],
  [`/api/v1/students/${ID}`, `/api/v1/students/${ID}`],
  [`/api/v1/students/${ID}/term-enrollments`, `/api/v1/students/${ID}/term-enrollments`],
  ['/api/v1/me/consents', '/api/v1/me/consents'],
  ['/api/auth/login', '/auth/login'],
  ['/api/auth/me', '/auth/me'],
  ['/api/me/mfa', '/me/mfa'],
  ['/api/me/mfa/totp/enroll', '/me/mfa/totp/enroll'],
  // a path that lost its /v1 reaches the backend unchanged and is a 404 there (never index.html, never re-routed)
  ['/api/academics/terms', '/api/academics/terms'],
  // pages and assets stay with the web app
  ['/academics', null],
  [`/students/${ID}`, null],
  ['/login', null],
  ['/assets/index-3f2a.js', null],
  ['/', null],
];
const API_PREFIXES = ['/api/v1/', '/auth/', '/me/mfa'];

describe('client path contract', () => {
  it.each([
    '/v1/academics/terms',
    '/v1/users',
    `/v1/students/${ID}`,
    '/v1/me/consents',
    '/auth/login',
    '/auth/me',
    '/me/mfa',
    '/me/mfa/totp',
  ])('accepts %s', (p) => expect(isApiPath(p)).toBe(true));

  it.each([
    '/academics/terms', // lost /v1
    '/users',
    `/students/${ID}`,
    '/me/consents', // versioned on the backend
    '/api/v1/academics/terms', // would become /api/api/v1
    '/v1/auth/login', // unversioned on the backend
    '/v1/me/mfa',
    '/v1//users',
    '/me/mfax',
    '/v1',
    'v1/users',
    '',
  ])('refuses %s', (p) => expect(isApiPath(p)).toBe(false));

  it('real API functions send exactly the contract paths under the base path, never /api/api', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response('{}', { status: 404 }));
    });
    const client = new ApiClient({ basePath: '/api', fetchImpl });
    const calls: Array<() => Promise<unknown>> = [
      () => fetchTerms(client),
      () => fetchUsers(client, {}),
      () => fetchStudent(client, ID),
      () => fetchMyConsents(client),
      () => fetchMe(client),
      () => login(client, { email: 'a@b.test', password: 'x' }),
      () => fetchMfaStatus(client),
    ];
    for (const call of calls) await call().catch(() => undefined);
    expect(urls.map((u) => u.split('?')[0])).toEqual([
      '/api/v1/academics/terms',
      '/api/v1/users',
      `/api/v1/students/${ID}`,
      '/api/v1/me/consents',
      '/api/auth/me',
      '/api/auth/login',
      '/api/me/mfa',
    ]);
    for (const u of urls) expect(u.startsWith('/api/api')).toBe(false);
  });

  it('a path outside the contract is refused before any request; auth and error responses are unchanged', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'x', requestId: 'r' } }),
          {
            status: 401,
          },
        ),
      ),
    );
    const client = new ApiClient({ basePath: '/api', fetchImpl });
    const onUnauthorized = vi.fn();
    client.setUnauthorizedHandler(onUnauthorized);
    await expect(fetchTerms(client)).rejects.toSatisfy(
      (e) => e instanceof ApiError && e.kind === 'unauthenticated',
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(() => client.url('/academics/terms')).toThrow(/contract/);
    fetchImpl.mockClear();
    await expect(
      client.get('/academics/terms', { schema: {} as never }),
    ).rejects.not.toBeInstanceOf(ApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('every path literal in the API modules follows the contract (none can lose /v1)', () => {
    const dir = resolve(__dirname, '../src/lib/api');
    const heads: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const code = readFileSync(resolve(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/[`'](\/[a-z][^`'$?]*)/g)) heads.push(`${f}: ${m[1]}`);
    }
    expect(heads.length).toBeGreaterThan(60);
    expect(heads.filter((h) => !/: \/(?:v1\/|auth\/|me\/mfa)/.test(h))).toEqual([]);
  });
});

describe('development proxy (apps/web/vite.config.ts)', () => {
  // Vite 8 semantics (createProxyContextMatcher / viteProxyMiddleware): a key starting with "^" is a RegExp,
  // any other key a prefix; the FIRST matching key in declaration order wins; `rewrite` maps the forwarded path.
  const proxy = viteConfig.server?.proxy as Record<
    string,
    { target: string; rewrite?: (p: string) => string }
  >;
  const route = (url: string): string | null => {
    for (const [key, opts] of Object.entries(proxy)) {
      const hit = key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key);
      if (hit) return opts.rewrite ? opts.rewrite(url) : url;
    }
    return null;
  };

  it.each(CONTRACT)('%s -> %s', (from, to) => expect(route(from)).toBe(to));

  it('targets the backend and keeps the browser Host (CSRF origin check)', () => {
    for (const opts of Object.values(proxy)) {
      expect(opts.target).toBe('http://127.0.0.1:4000');
      expect(opts).not.toHaveProperty('changeOrigin', true);
    }
  });
});

describe('production proxy (nginx example in docs/deployment/frontend.md)', () => {
  // Modelled, not executed (no nginx binary in this environment): prefix `location`s, the LONGEST match wins;
  // `proxy_pass` with a URI part replaces the matched prefix, without one the original path is passed unchanged.
  const doc = readFileSync(resolve(__dirname, '../../../docs/deployment/frontend.md'), 'utf8');
  const block = /```nginx\n([\s\S]*?)```/.exec(doc)![1]!;
  const locations = [...block.matchAll(/^location\s+(\S+)\s*\{([^}]*)\}/gm)].map((m) => ({
    prefix: m[1]!,
    body: m[2]!,
    pass: /proxy_pass\s+http:\/\/[^/;\s]+(\/[^;\s]*)?;/.exec(m[2]!),
  }));
  const route = (url: string): string | null => {
    const loc = locations
      .filter((l) => url.startsWith(l.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!loc?.pass) return null;
    const uri = loc.pass[1];
    return uri === undefined ? url : uri + url.slice(loc.prefix.length);
  };

  it('has the four locations of the contract and server-level forwarding headers', () => {
    expect(locations.map((l) => l.prefix).sort()).toEqual([
      '/',
      '/api/',
      '/api/auth/',
      '/api/me/mfa',
    ]);
    expect(block).toMatch(/^proxy_set_header Host \$host;$/m);
    expect(block).toMatch(/^proxy_set_header X-Forwarded-For \$remote_addr;$/m);
    // a location with its own proxy_set_header would inherit neither of the server-level ones
    expect(locations.filter((l) => l.body.includes('proxy_set_header'))).toEqual([]);
  });

  it.each(CONTRACT)('%s -> %s', (from, to) => expect(route(from)).toBe(to));

  it('never produces /api/api and never drops /v1', () => {
    for (const [from] of CONTRACT) {
      const to = route(from);
      if (to === null) continue;
      expect(to.startsWith('/api/api')).toBe(false);
      if (from.startsWith('/api/v1/')) expect(to.startsWith('/api/v1/')).toBe(true);
      expect(API_PREFIXES.some((p) => to.startsWith(p)) || to === from).toBe(true);
    }
  });
});
