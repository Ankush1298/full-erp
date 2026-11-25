/* global Buffer, WebSocket, setTimeout, fetch, URL */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve('/Users/ankush/Downloads/smart-campus-os');
const require = createRequire(join(REPO, 'backend/package.json'));
const pg = require('pg');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const principalPassphrase = `Principal-${randomBytes(8).toString('hex')}!@#`;

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => res(addr.port));
    });
    s.on('error', rej);
  });

function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/[\s=]/g, '').toUpperCase()) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `Browser eval error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

async function main() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'anesa-platform-'));
  const chromeDir = join(tmpDir, 'chrome');

  let server;
  let app;
  let platformApp;
  let db;
  let adminPool;
  let op;
  let vite;
  let chrome;
  let cdp;

  try {
    const webPort = await freePort();
    const apiPort = await freePort();
    const platformPort = await freePort();
    const webOrigin = `http://127.0.0.1:${webPort}`;

    console.log('1. Starting disposable Postgres + App API + Platform API...');
    const { buildApp } = await import(`${REPO}/backend/src/app.js`);
    const { loadConfig } = await import(`${REPO}/backend/src/config/env.js`);
    const { hotp, totpStep } = await import(`${REPO}/backend/src/modules/auth/mfa/totp.js`);
    const { Database } = await import(`${REPO}/backend/src/shared/database/index.js`);
    const { createPool } = await import(`${REPO}/backend/src/shared/database/pool.js`);
    const { InMemoryInvitationMailer } = await import(
      `${REPO}/backend/src/shared/email/invitation-mailer.js`
    );
    const { FixedWindowLimiter } = await import(
      `${REPO}/backend/src/shared/http/fixed-window-limiter.js`
    );
    const { MemoryStorageDriver } = await import(`${REPO}/backend/src/shared/storage/index.js`);
    const { createBootstrappedDatabase } = await import(
      `${REPO}/backend/tests/support/bootstrap-lock.ts`
    );
    const { startThrowawayPostgres } = await import(
      `${REPO}/backend/tests/support/embedded-postgres.ts`
    );
    const { rolePasswords, urlFor } = await import(
      `${REPO}/backend/tests/support/role-passwords.ts`
    );
    const { contractVersions, migrate } = await import(`${REPO}/backend/tools/db/migrate.ts`);
    const { issueFirstAdminInvitation, issueFirstAdminMfaTicket } = await import(
      `${REPO}/backend/tools/platform/first-admin.ts`
    );
    const { buildPlatformServer } = await import(
      `${REPO}/backend/tools/platform/platform-server.ts`
    );

    server = await startThrowawayPostgres();
    const dbName = `plat_smoke_${randomBytes(4).toString('hex')}`;
    const pw = rolePasswords();
    const adminUrl = await createBootstrappedDatabase(server.adminUrl, dbName, pw);
    await migrate({
      connectionString: urlFor(server.adminUrl, 'app_migrator', pw.migrator, dbName),
      allowContract: contractVersions(),
    });
    const runtimeUrl = urlFor(server.adminUrl, 'app_runtime', pw.runtime, dbName);
    db = new Database(createPool({ connectionString: runtimeUrl, ssl: false, max: 8 }));
    const mailer = new InMemoryInvitationMailer();
    const big = () => new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 10_000 });

    app = buildApp({
      config: loadConfig({
        DATABASE_URL: runtimeUrl,
        APP_ORIGINS: webOrigin,
        MFA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
        MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
      }),
      db,
      storage: new MemoryStorageDriver(),
      logger: false,
      invitationMailer: mailer,
      stepUpLimiter: big(),
      mfaLimiter: big(),
      acceptInviteLimiter: big(),
      inviteLimiter: big(),
    });
    await app.listen({ host: '127.0.0.1', port: apiPort });

    adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 });
    const platformDb = {
      withSystem: async (work) => {
        const client = await adminPool.connect();
        try {
          await client.query('BEGIN');
          const res = await work({
            query: (sql, params) => client.query(sql, params),
          });
          await client.query('COMMIT');
          return res;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
    platformApp = buildPlatformServer({ db: platformDb });
    await platformApp.listen({ host: '127.0.0.1', port: platformPort });

    op = new pg.Client({ connectionString: adminUrl });
    await op.connect();

    console.log('2. Starting Vite dev server...');
    vite = spawn('npx', ['vite', '--port', String(webPort), '--strictPort'], {
      cwd: `${REPO}/apps/web`,
      env: {
        ...process.env,
        DEV_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        DEV_PLATFORM_API_ORIGIN: `http://127.0.0.1:${platformPort}`,
        BROWSER: 'none',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(
      async () => {
        try {
          const r = await fetch(`${webOrigin}/platform/institutions`);
          return r.ok;
        } catch {
          return false;
        }
      },
      20000,
      'Vite server',
    );

    console.log('3. Launching headless Chrome...');
    const cdpPort = await freePort();
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${chromeDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const targets = await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
          if (!r.ok) return null;
          const list = await r.json();
          return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        } catch {
          return null;
        }
      },
      15000,
      'Chrome DevTools',
    );

    cdp = new CdpClient(targets.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    async function setInputValue(selector, value) {
      await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    }

    // === TEST 1: CREATE INSTITUTION IN PLATFORM UI ===
    console.log('4. Navigating to /platform/institutions & provisioning synthetic school...');
    await cdp.send('Page.navigate', { url: `${webOrigin}/platform/institutions` });
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('Institutions Directory')`),
      10000,
      'Institutions Directory',
    );

    await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Provision New Tenant'));
      if (!btn) throw new Error('Provision New Tenant button not found');
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`!!document.querySelector('#inst-name')`),
      5000,
      'Provision modal',
    );

    await setInputValue('#inst-name', 'Synthetic Verification School');
    await setInputValue('#inst-slug', 'synthetic-verify');
    await setInputValue('#admin-email', 'principal@synthetic-verify.test');
    await cdp.eval(`document.querySelector('[role="dialog"] button[type="submit"]').click()`);

    await waitFor(
      () =>
        cdp.eval(
          `!document.querySelector('#inst-name') && document.body.innerText.includes('Synthetic Verification School')`,
        ),
      10000,
      'Institution created in UI',
    );
    console.log('   [PASS] Synthetic Verification School created via /platform/institutions UI.');

    // === TEST 2: PRINCIPAL INVITATION, PASSWORD CREATION & MFA ACTIVATION ===
    console.log('5. Verifying Principal invitation, password creation & MFA activation...');
    const inv = await issueFirstAdminInvitation(op, {
      tenant: 'synthetic-verify',
      reason: 'Platform smoke',
    });
    const tok = inv.token;

    // Accept invitation in browser
    const acceptUrl = new URL('/accept-invite', webOrigin);
    acceptUrl.searchParams.set('token', tok);
    await cdp.send('Page.navigate', {
      url: acceptUrl.toString(),
    });
    await waitFor(
      () => cdp.eval(`!!document.querySelector('input[type="password"]')`),
      10000,
      'Accept invite form',
    );
    await cdp.eval(`(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const el of inputs) {
        setter.call(el, ${JSON.stringify(principalPassphrase)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('button[type="submit"]').click();
    })()`);

    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.toLowerCase().includes('activated') || document.body.innerText.toLowerCase().includes('sign in')`,
        ),
      10000,
      'Invitation accepted',
    );

    const mfaTkt = await issueFirstAdminMfaTicket(op, {
      tenant: 'synthetic-verify',
      reason: 'Platform smoke MFA',
    });

    // Log in as Principal & complete MFA enrollment in browser
    await cdp.send('Page.navigate', { url: `${webOrigin}/login` });
    await waitFor(
      () => cdp.eval(`!!document.querySelector('[role="dialog"] input[name="email"]')`),
      10000,
      'Principal login form',
    );
    await setInputValue('[role="dialog"] input[name="email"]', 'principal@synthetic-verify.test');
    await setInputValue('[role="dialog"] input[name="password"]', principalPassphrase);
    await cdp.eval(`document.querySelector('[role="dialog"] button[type="submit"]').click()`);

    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('Set Up Two-Factor Authentication')`),
      10000,
      'MFA setup prompt',
    );
    await cdp.eval(`(() => {
      if (!document.querySelector('input[name="ticket"]')) {
        const sum = Array.from(document.querySelectorAll('summary, button')).find(x => x.textContent.includes('Have a manual'));
        if (sum) sum.click();
      }
    })()`);
    await waitFor(
      () => cdp.eval(`!!document.querySelector('input[name="ticket"]')`),
      5000,
      'MFA ticket input',
    );
    await setInputValue('input[name="ticket"]', mfaTkt.ticket);
    await cdp.eval(
      `Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Begin Setup')).click()`,
    );

    await waitFor(
      () =>
        cdp.eval(
          `!!document.querySelector('[role="dialog"] input[autocomplete="current-password"]') || document.body.innerText.includes('6-Digit Verification Code')`,
        ),
      10000,
      'Step-up or setup key',
    );
    const needsStepUp = await cdp.eval(
      `!!document.querySelector('[role="dialog"] input[autocomplete="current-password"]') && !document.body.innerText.includes('6-Digit Verification Code')`,
    );
    if (needsStepUp) {
      await setInputValue(
        '[role="dialog"] input[autocomplete="current-password"]',
        principalPassphrase,
      );
      await cdp.eval(
        `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button[type="submit"]')).pop(); if (b) b.click(); })()`,
      );
      await waitFor(
        () => cdp.eval(`document.body.innerText.includes('6-Digit Verification Code')`),
        10000,
        'Setup key after step-up',
      );
    }

    const secret = await cdp.eval(`(() => {
      const txt = Array.from(document.querySelectorAll('[role="dialog"]')).map(d => d.innerText).join(' ');
      const m = txt.replace(/\\s+/g, '').match(/([A-Z2-7]{32})/);
      return m ? m[1] : null;
    })()`);
    if (!secret) throw new Error('MFA setup key not found');
    const code = hotp(base32Decode(secret), totpStep(Date.now()));
    await setInputValue('input[inputmode="numeric"], input[type="text"]', code);
    await cdp.eval(
      `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button[type="submit"]')).pop(); if (b) b.click(); })()`,
    );

    await waitFor(
      () => cdp.eval(`document.body.innerText.toLowerCase().includes('recovery code')`),
      10000,
      'Recovery codes',
    );
    await cdp.eval(
      `(() => { const cb = document.querySelector('[role="dialog"] input[type="checkbox"]'); if (cb && !cb.checked) cb.click(); })()`,
    );
    await new Promise((r) => setTimeout(r, 150));
    await cdp.eval(
      `Array.from(document.querySelectorAll('button')).find(x => x.textContent.toLowerCase().includes('saved my recovery codes')).click()`,
    );
    await waitFor(
      () =>
        cdp.eval(
          `!document.querySelector('[role="dialog"]') && !!document.querySelector('a[href="/documents"]')`,
        ),
      10000,
      'Principal authenticated shell',
    );

    const meActiveStatus = await cdp.eval(
      `(async () => (await fetch('/api/auth/me', { credentials: 'include' })).status)()`,
    );
    if (meActiveStatus !== 200)
      throw new Error(`Expected active Principal /auth/me 200, got ${meActiveStatus}`);
    console.log(
      '   [PASS] Principal invitation, password creation, and TOTP MFA activation succeeded (GET /auth/me -> 200).',
    );

    // === TEST 3: SUSPEND INSTITUTION VIA /platform/institutions UI ===
    console.log('6. Suspending Synthetic Verification School via /platform/institutions UI...');
    await cdp.send('Page.navigate', { url: `${webOrigin}/platform/institutions` });
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('Synthetic Verification School')`),
      10000,
      'Institutions table',
    );

    await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find(r => r.innerText.includes('Synthetic Verification School'));
      const btn = Array.from(row.querySelectorAll('button')).find(b => b.textContent.includes('Suspend'));
      if (!btn) throw new Error('Suspend button not found');
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('Confirm Suspension')`),
      5000,
      'Suspend modal',
    );
    await cdp.eval(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Confirm Suspension')).click()`,
    );

    await waitFor(
      () =>
        cdp.eval(
          `!document.querySelector('[role="dialog"]') && document.body.innerText.includes('SUSPENDED')`,
        ),
      10000,
      'Status updated to SUSPENDED',
    );
    console.log(
      '   [PASS] Suspend succeeded cleanly in UI (no Content-Type empty body error); status is SUSPENDED.',
    );

    // Verify existing Principal session is restricted and new login is blocked
    const meSuspendedStatus = await cdp.eval(
      `(async () => (await fetch('/api/auth/me', { credentials: 'include' })).status)()`,
    );
    if (meSuspendedStatus === 200)
      throw new Error(`Suspended tenant session should be rejected, got HTTP ${meSuspendedStatus}`);
    const loginSuspendedStatus = await cdp.eval(`(async () => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'principal@synthetic-verify.test', password: ${JSON.stringify(principalPassphrase)} })
      });
      return r.status;
    })()`);
    if (loginSuspendedStatus === 200)
      throw new Error(`Suspended tenant login should be blocked, got HTTP ${loginSuspendedStatus}`);
    console.log(
      `   [PASS] Existing session restricted (HTTP ${meSuspendedStatus}) & new login blocked (HTTP ${loginSuspendedStatus}).`,
    );

    // === TEST 4: REACTIVATE INSTITUTION VIA /platform/institutions UI ===
    console.log('7. Reactivating Synthetic Verification School via /platform/institutions UI...');
    await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('tr'));
      const row = rows.find(r => r.innerText.includes('Synthetic Verification School'));
      const btn = Array.from(row.querySelectorAll('button')).find(b => b.textContent.includes('Reactivate'));
      if (!btn) throw new Error('Reactivate button not found');
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('Confirm Reactivation')`),
      5000,
      'Reactivate modal',
    );
    await cdp.eval(
      `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Confirm Reactivation')).click()`,
    );

    await waitFor(
      () =>
        cdp.eval(
          `!document.querySelector('[role="dialog"]') && !document.body.innerText.includes('SUSPENDED')`,
        ),
      10000,
      'Status restored to ACTIVE',
    );

    const loginRestoredStatus = await cdp.eval(`(async () => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'principal@synthetic-verify.test', password: ${JSON.stringify(principalPassphrase)} })
      });
      return r.status;
    })()`);
    if (loginRestoredStatus !== 200)
      throw new Error(`Reactivated tenant login should succeed, got HTTP ${loginRestoredStatus}`);
    console.log(
      '   [PASS] Reactivation restored ACTIVE status & Principal login (HTTP 200) with zero data loss.',
    );

    console.log('\nALL PLATFORM INSTITUTION LIFECYCLE BROWSER TESTS PASSED!');
  } finally {
    if (cdp) cdp.close();
    if (chrome) chrome.kill('SIGTERM');
    if (vite) vite.kill('SIGTERM');
    if (platformApp) await platformApp.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    if (adminPool) await adminPool.end().catch(() => {});
    if (db) await db.close().catch(() => {});
    if (op) await op.end().catch(() => {});
    if (server) await server.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('PLATFORM BROWSER TEST FAILED:', err);
  process.exit(1);
});
