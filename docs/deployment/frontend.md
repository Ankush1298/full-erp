# Deploying the web client

`apps/web` builds to static files (`pnpm --filter @campusos/web build` -> `apps/web/dist`). Serve them from the
**same origin** as the API. Never expose the backend on a different origin for browsers (that would break the
cookie and CSRF design).

## Web-to-backend path contract

The browser only ever calls paths under the API base path `/api` (`VITE_API_BASE_PATH`); every proxy applies:

| Browser path | Backend path | Rule |
| --- | --- | --- |
| `/api/v1/...` | `/api/v1/...` | the versioned API, forwarded **unchanged** |
| `/api/auth/...` | `/auth/...` | unversioned session routes (login, logout, `/auth/me`, step-up, MFA challenge, accept-invite): `/api` removed |
| `/api/me/mfa...` | `/me/mfa...` | unversioned MFA self-service routes: `/api` removed |
| any other `/api/...` | unchanged | reaches no backend route: `404` (never the web app's `index.html`) |
| everything else | not proxied | the web app's pages and assets |

Note `/api/v1/me/consents` is versioned (only `/me/mfa` is not). The client refuses any other path before sending
(`isApiPath` in `apps/web/src/lib/api/client.ts`); `apps/web/tests/api-routing.test.ts` checks the client, the Vite
proxy and the nginx example below against this table, and `backend/tests/unit/web-api-contract.test.ts` checks that
every path the web client calls is a route of the real backend.

## Local development
```bash
pnpm dev                 # backend on http://127.0.0.1:4000 (needs the dev database, see README)
pnpm dev:web             # web on http://127.0.0.1:5173 ; /api is proxied to the backend (contract above)
```
The Vite proxy keeps the browser's `Host` (changeOrigin off), so the backend's development CSRF fallback
(Origin must equal the request's own origin) works with **no** `APP_ORIGINS`. Override the backend address with
`DEV_API_ORIGIN` (dev server only; never in the bundle).

## Production proxy requirements (example: nginx)
```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
location /api/auth/ { proxy_pass http://backend:4000/auth/; }
location /api/me/mfa { proxy_pass http://backend:4000/me/mfa; }
location /api/      { proxy_pass http://backend:4000; }
location /          { root /srv/anesa; try_files $uri /index.html; }
# index.html: Cache-Control: no-store ; /assets/*: Cache-Control: public, max-age=31536000, immutable
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy no-referrer always;
add_header X-Robots-Tag "noindex, nofollow, noarchive" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" always;
```
nginx picks the longest matching prefix, so the order of the `location` blocks does not matter. A `proxy_pass` with a
URI part (`/auth/`, `/me/mfa`) replaces the matched prefix (removing `/api`); the bare `http://backend:4000` passes
the request path unchanged. The two `proxy_set_header` lines sit at `server` level so every `location` inherits them
(a `location` that declares its own `proxy_set_header` would inherit none of them). Set `X-Forwarded-For` to the real client address **overwriting** any incoming value, and set backend
`TRUST_PROXY=true` only behind such a proxy (the login rate limiter keys on it). Backend `APP_ORIGINS` must list
the public https origin of this site. The CSP above is compatible with the production build (no inline script,
no external hosts); it is not applied to the Vite dev server.
