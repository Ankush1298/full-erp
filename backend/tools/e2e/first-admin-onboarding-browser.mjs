/* global Buffer, WebSocket, setTimeout, fetch, URL */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
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
  const tmpDir = mkdtempSync(join(tmpdir(), 'anesa-onboard-'));
  const chromeDir = join(tmpDir, 'chrome');

  let server;
  let app;
  let platformApp;
  let db;
  let adminPool;
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
    const { buildPlatformServer } = await import(
      `${REPO}/backend/tools/platform/platform-server.ts`
    );

    server = await startThrowawayPostgres();
    const dbName = `onboard_smoke_${randomBytes(4).toString('hex')}`;
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
    platformApp = buildPlatformServer({
      db: platformDb,
      appOrigin: webOrigin,
      invitationMailer: mailer,
    });
    await platformApp.listen({ host: '127.0.0.1', port: platformPort });

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
          const r = await fetch(`${webOrigin}/platform/login`);
          return r.ok;
        } catch {
          return false;
        }
      },
      15000,
      'Vite dev server',
    );

    console.log('3. Launching headless Chrome...');
    const cdpPort = await freePort();
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        `--user-data-dir=${chromeDir}`,
        `--remote-debugging-port=${cdpPort}`,
        '--window-size=1280,900',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const targets = await waitFor(
      async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${cdpPort}/json`);
          const arr = await r.json();
          return arr.find((t) => t.type === 'page');
        } catch {
          return null;
        }
      },
      10000,
      'Chrome CDP target',
    );

    cdp = new CdpClient(targets.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Step B: Provision a new school from Institutions Directory & follow next-step banner
    console.log(
      '4. Navigating to /platform/institutions & provisioning Synthetic Onboarding Academy...',
    );
    await cdp.send('Page.navigate', { url: `${webOrigin}/platform/institutions` });
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('+ Provision New Tenant')`),
      10000,
      'Institutions Directory page',
    );
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('+ Provision New Tenant'));
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('#inst-name'))`),
      5000,
      'Provision New Tenant modal',
    );
    await cdp.eval(`(() => {
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setVal(document.querySelector('#inst-name'), 'Synthetic Onboarding Academy');
      setVal(document.querySelector('#inst-slug'), 'synth-onboard');
      setVal(document.querySelector('#admin-email'), 'principal@syntheticonboard.test');
      const submitBtn = [...document.querySelectorAll('button[type="submit"]')].find((b) => b.textContent.includes('Provision Institution'));
      submitBtn.click();
    })()`);

    await waitFor(
      () =>
        cdp.eval(`document.body.innerText.includes('Synthetic Onboarding Academy provisioned.')`),
      10000,
      'Provisioned next-step banner',
    );
    await cdp.eval(`(() => {
      const link = [...document.querySelectorAll('a')].find((a) => a.textContent.includes('Manage Administrator Onboarding'));
      link.click();
    })()`);

    // Step C: Inspect First Administrator Onboarding section & Send Invitation
    console.log('6. Sending first-admin invitation & testing revocation...');
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('First Administrator Onboarding') && document.body.innerText.includes('principal@syntheticonboard.test')`,
        ),
      10000,
      'First Administrator Onboarding section',
    );
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send Invitation');
      btn.click();
    })()`);
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('One-Time Activation Link') && document.body.innerText.includes('Revoke Invitation')`,
        ),
      10000,
      'Sent invitation link displayed',
    );
    const revokedAcceptUrl = await cdp.eval(`(() => {
      const codes = [...document.querySelectorAll('code')];
      const el = codes.find((c) => c.textContent.includes('/accept-invite?token='));
      return el ? el.textContent.trim() : null;
    })()`);
    if (!revokedAcceptUrl) throw new Error('Expected acceptUrl in UI after Send Invitation');
    if (mailer.sent.length !== 1)
      throw new Error(`Expected 1 sent email, got ${mailer.sent.length}`);

    // Revoke the invitation
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Revoke Invitation');
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('REVOKED')`),
      10000,
      'REVOKED status in UI',
    );

    // Reissue a fresh invitation
    console.log('7. Reissuing fresh invitation...');
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reissue Invitation');
      btn.click();
    })()`);
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('One-Time Activation Link') && document.body.innerText.includes('PENDING')`,
        ),
      10000,
      'Reissued PENDING invitation',
    );
    const detailUrl = await cdp.eval(`window.location.href`);
    const orgIdMatch = detailUrl.match(/\/platform\/institutions\/([^/?#]+)/);
    const orgId = orgIdMatch ? orgIdMatch[1] : null;
    if (!orgId) throw new Error(`Could not extract orgId from ${detailUrl}`);

    // Verify unauthenticated platform operator requests are rejected with 401
    console.log('7b. Verifying platform operator authorization (401 without token)...');
    for (const ep of [
      'first-admin/invite',
      'first-admin/invite/revoke',
      'first-admin/mfa-ticket',
    ]) {
      const unauthRes = await fetch(
        `http://127.0.0.1:${platformPort}/api/v1/platform/institutions/${orgId}/${ep}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (unauthRes.status !== 401) {
        throw new Error(`Expected 401 for unauthenticated POST ${ep}, got ${unauthRes.status}`);
      }
    }

    const freshAcceptUrl = await cdp.eval(`(() => {
      const codes = [...document.querySelectorAll('code')];
      const el = codes.find((c) => c.textContent.includes('/accept-invite?token='));
      return el ? el.textContent.trim() : null;
    })()`);
    if (!freshAcceptUrl || freshAcceptUrl === revokedAcceptUrl) {
      throw new Error('Expected a new acceptUrl after reissue');
    }

    // Verify expired invitation rejection in browser, then reissue a fresh non-expired invitation
    console.log('7c. Verifying expired invitation rejection in browser...');
    await adminPool.query(
      `UPDATE app.invite_tokens SET expires_at = created_at + interval '1 millisecond' WHERE organization_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [orgId],
    );
    await new Promise((r) => setTimeout(r, 50));
    await cdp.send('Page.navigate', { url: freshAcceptUrl });
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('input[type="password"]'))`),
      10000,
      'Accept invite page for expired token',
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
          `document.body.innerText.toLowerCase().includes('expired') || document.body.innerText.toLowerCase().includes('invalid')`,
        ),
      10000,
      'Expired invite error message',
    );

    // Return to Platform detail and reissue a valid invitation
    await cdp.send('Page.navigate', { url: detailUrl });
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('EXPIRED') && document.body.innerText.includes('Reissue Invitation')`,
        ),
      10000,
      'EXPIRED status & Reissue Invitation button',
    );
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reissue Invitation');
      btn.click();
    })()`);
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('One-Time Activation Link') && document.body.innerText.includes('PENDING')`,
        ),
      10000,
      'Reissued valid PENDING invitation after expiry',
    );
    const validAcceptUrl = await cdp.eval(`(() => {
      const codes = [...document.querySelectorAll('code')];
      const el = codes.find((c) => c.textContent.includes('/accept-invite?token='));
      return el ? el.textContent.trim() : null;
    })()`);
    if (!validAcceptUrl || validAcceptUrl === freshAcceptUrl) {
      throw new Error('Expected a fresh valid acceptUrl after expired token reissue');
    }

    // Verify revoked invitation is rejected at /accept-invite
    console.log('8. Verifying revoked invitation rejection in browser...');
    await cdp.send('Page.navigate', { url: revokedAcceptUrl });
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('input[type="password"]'))`),
      10000,
      'Accept invite page for revoked token',
    );
    await cdp.eval(`(() => {
      const setVal = (el, val) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const inputs = document.querySelectorAll('input[type="password"]');
      setVal(inputs[0], ${JSON.stringify(principalPassphrase)});
      if (inputs[1]) setVal(inputs[1], ${JSON.stringify(principalPassphrase)});
      document.querySelector('button[type="submit"]').click();
    })()`);
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.toLowerCase().includes('revoked') || document.body.innerText.toLowerCase().includes('invalid') || document.body.innerText.toLowerCase().includes('expired')`,
        ),
      10000,
      'Revoked invite error message',
    );

    // Accept fresh invitation
    console.log('9. Accepting valid invitation in browser...');
    await cdp.send('Page.navigate', { url: validAcceptUrl });
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('input[type="password"]'))`),
      10000,
      'Accept invite page for valid token',
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
      'Account activation completion',
    );

    // Verify reused invitation is rejected
    await cdp.send('Page.navigate', { url: validAcceptUrl });
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('input[type="password"]'))`),
      10000,
      'Accept invite page for reused token',
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
          `document.body.innerText.toLowerCase().includes('used') || document.body.innerText.toLowerCase().includes('invalid') || document.body.innerText.toLowerCase().includes('expired')`,
        ),
      10000,
      'Reused invite error message',
    );

    // Return to Platform Institution Detail & issue MFA bootstrap ticket
    console.log('10. Issuing MFA bootstrap ticket from Platform UI...');
    await cdp.send('Page.navigate', { url: detailUrl });
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('Activated') && document.body.innerText.includes('Issue MFA Bootstrap Ticket')`,
        ),
      10000,
      'Activated status and MFA Bootstrap button',
    );
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Issue MFA Bootstrap Ticket');
      btn.click();
    })()`);
    await waitFor(
      () => cdp.eval(`document.body.innerText.includes('One-Time MFA Bootstrap Ticket')`),
      10000,
      'MFA bootstrap ticket displayed in UI',
    );
    const ticket = await cdp.eval(`(() => {
      const callout = [...document.querySelectorAll('.info-callout')].find((el) =>
        el.textContent.includes('One-Time MFA Bootstrap Ticket'),
      );
      return callout?.querySelector('code')?.textContent?.trim() || null;
    })()`);
    console.log(
      '   Issued ticket:',
      ticket ? `${ticket.slice(0, 4)}... (len=${ticket.length})` : 'null',
    );
    if (!ticket) throw new Error('Expected MFA bootstrap ticket in UI');

    // Step D: Log in as Principal & complete TOTP enrollment using ticket
    console.log('11. Logging in as principal & enrolling TOTP with bootstrap ticket...');
    const setInputValue = async (selector, value) => {
      await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    };

    await cdp.send('Page.navigate', { url: `${webOrigin}/login` });
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('[role="dialog"] input[name="email"]'))`),
      10000,
      'Tenant login dialog',
    );
    await setInputValue('[role="dialog"] input[name="email"]', 'principal@syntheticonboard.test');
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
      () => cdp.eval(`Boolean(document.querySelector('input[name="ticket"]'))`),
      5000,
      'MFA ticket input',
    );
    await setInputValue('input[name="ticket"]', ticket);
    await cdp.eval(
      `Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Begin Setup')).click()`,
    );

    await waitFor(
      () =>
        cdp.eval(
          `Boolean(document.querySelector('[role="dialog"] input[autocomplete="current-password"]')) || document.body.innerText.includes('6-Digit Verification Code')`,
        ),
      10000,
      'Step-up or setup key',
    );
    const needsStepUp = await cdp.eval(
      `Boolean(document.querySelector('[role="dialog"] input[autocomplete="current-password"]')) && !document.body.innerText.includes('6-Digit Verification Code')`,
    );
    if (needsStepUp) {
      await setInputValue(
        '[role="dialog"] input[autocomplete="current-password"]',
        principalPassphrase,
      );
      await cdp.eval(
        `(() => { const b = Array.from(document.querySelectorAll('[role="dialog"] button[type="submit"]')).pop(); if (b) b.click(); })()`,
      );
      try {
        await waitFor(
          () => cdp.eval(`document.body.innerText.includes('6-Digit Verification Code')`),
          10000,
          'Setup key after step-up',
        );
      } catch (e) {
        const txt = await cdp.eval(`document.body.innerText`);
        console.error('Dialog text on timeout:', txt);
        throw e;
      }
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
          `!document.querySelector('[role="dialog"]') && Boolean(document.querySelector('a[href="/documents"]'))`,
        ),
      10000,
      'Principal authenticated shell',
    );

    // Step E: Verify Platform UI reflects Activated + ACCEPTED + MFA Enrolled
    console.log(
      '12. Verifying Platform UI shows Activated + MFA Enrolled & checking token hygiene...',
    );
    await cdp.send('Page.navigate', { url: detailUrl });
    await waitFor(
      () =>
        cdp.eval(
          `document.body.innerText.includes('Activated') && document.body.innerText.includes('ACCEPTED') && document.body.innerText.includes('MFA Enrolled')`,
        ),
      10000,
      'Platform UI final onboarding state',
    );

    const validTok = new URL(validAcceptUrl).searchParams.get('token');
    const storageDump = await cdp.eval(`JSON.stringify({ ls: localStorage, ss: sessionStorage })`);
    if (
      (validTok && storageDump.includes(validTok)) ||
      storageDump.includes(ticket) ||
      storageDump.includes(secret)
    ) {
      throw new Error('Secret hygiene failure: raw token/ticket/secret found in browser storage');
    }

    const auditDumpRes = await adminPool.query(
      `SELECT metadata::text AS meta FROM app.audit_events WHERE organization_id = $1`,
      [orgId],
    );
    const auditBlob = auditDumpRes.rows.map((r) => r.meta).join('\n');
    if ((validTok && auditBlob.includes(validTok)) || auditBlob.includes(ticket)) {
      throw new Error('Secret hygiene failure: raw token or MFA ticket persisted in audit_events');
    }

    console.log(
      'PASS: Complete First Administrator Onboarding browser workflow verified end-to-end (expired/revoked/reused rejected, 401 auth enforced, step-up MFA & token hygiene verified)!',
    );
  } finally {
    if (cdp) cdp.close();
    if (chrome) chrome.kill('SIGKILL');
    if (vite) vite.kill('SIGKILL');
    if (platformApp)
      await Promise.race([platformApp.close(), new Promise((r) => setTimeout(r, 2000))]).catch(
        () => {},
      );
    if (app)
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
    if (db)
      await Promise.race([db.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
    if (adminPool)
      await Promise.race([adminPool.end(), new Promise((r) => setTimeout(r, 2000))]).catch(
        () => {},
      );
    if (server)
      await Promise.race([server.stop(), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('BROWSER TEST FAILED:', err);
    process.exit(1);
  });
