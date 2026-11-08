import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { hotp, totpStep } from '../../src/modules/auth/mfa/totp.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { InMemoryInvitationMailer } from '../../src/shared/email/invitation-mailer.js';
import { FixedWindowLimiter } from '../../src/shared/http/fixed-window-limiter.js';
import { createBootstrappedDatabase } from './bootstrap-lock.js';
import { freePort, startThrowawayPostgres } from './embedded-postgres.js';
import { rolePasswords, urlFor } from './role-passwords.js';
import { contractVersions, migrate } from '../../tools/db/migrate.js';
import {
  issueFirstAdminInvitation,
  issueFirstAdminMfaTicket,
} from '../../tools/platform/first-admin.js';
import { createTenant } from '../../tools/platform/platform-cli.js';

/**
 * Disposable stack for browser rehearsals (doc 47 A2): a throw-away PostgreSQL in a temp directory (random port and
 * passwords, deleted on stop), migrated by the real runner, with the real API listening on 127.0.0.1. Nothing here connects
 * to, reads or writes any persistent database, `.env` file or development server. The "operator" functions are the same
 * services the platform CLI uses; they run on the throw-away superuser connection exactly as an operator would locally.
 * Secrets stay in memory: this module never logs a token, ticket, password or key.
 */
export interface RehearsalStack {
  apiOrigin: string;
  /** Operator actions (the platform CLI services). Each returns a secret ONCE; callers must not print it. */
  operator: {
    createSchool(
      name: string,
      slug: string,
      adminEmail: string,
    ): Promise<{ id: string; adminUserId: string }>;
    inviteAdmin(
      slug: string,
      opts?: { hours?: number },
    ): Promise<{ token: string; invitationId: string }>;
    mfaTicket(slug: string): Promise<{ ticket: string }>;
  };
  /**
   * Stands in for e-mail delivery (G4: no production mailer). Returns and forgets the newest invitation token sent to an
   * address, in memory only. A real deployment cannot do this: the token would travel by e-mail.
   */
  takeInvitationToken(email: string): string | undefined;
  /** Read-only/administrative SQL on the throw-away database for assertions and for aging fixtures. */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<T[]>;
  /** A TOTP code for a base32 setup key, in memory only. */
  totp(secretBase32: string, offsetSteps?: number): string;
  stop(): Promise<void>;
}

function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
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

export async function startRehearsalStack(options: { webOrigin: string }): Promise<RehearsalStack> {
  const server = await startThrowawayPostgres();
  const dbName = `rehearsal_${randomBytes(4).toString('hex')}`;
  const pw = rolePasswords();
  const adminUrl = await createBootstrappedDatabase(server.adminUrl, dbName, pw);
  await migrate({
    connectionString: urlFor(server.adminUrl, 'app_migrator', pw.migrator, dbName),
    allowContract: contractVersions(),
  });
  const runtimeUrl = urlFor(server.adminUrl, 'app_runtime', pw.runtime, dbName);
  const db = new Database(createPool({ connectionString: runtimeUrl, ssl: false, max: 8 }));
  const mailer = new InMemoryInvitationMailer();
  const big = () => new FixedWindowLimiter({ limit: 100_000, windowMs: 60_000, maxKeys: 10_000 });
  const app = buildApp({
    config: loadConfig({
      DATABASE_URL: runtimeUrl,
      APP_ORIGINS: options.webOrigin,
      MFA_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64url')}`,
      MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
    }),
    db,
    logger: false,
    invitationMailer: mailer,
    stepUpLimiter: big(),
    mfaLimiter: big(),
    acceptInviteLimiter: big(),
    inviteLimiter: big(),
  });
  const apiPort = await freePort();
  await app.listen({ host: '127.0.0.1', port: apiPort });

  const op = new pg.Client({ connectionString: adminUrl });
  await op.connect();
  return {
    apiOrigin: `http://127.0.0.1:${apiPort}`,
    operator: {
      createSchool: async (name, slug, adminEmail) => {
        const t = await createTenant(op, { name, slug, adminEmail });
        return { id: t.id, adminUserId: t.adminUserId! };
      },
      inviteAdmin: async (slug, opts) => {
        const r = await issueFirstAdminInvitation(op, {
          tenant: slug,
          ...(opts?.hours ? { ttlHours: opts.hours } : {}),
          reason: 'Browser rehearsal (synthetic)',
        });
        return { token: r.token, invitationId: r.invitationId };
      },
      mfaTicket: async (slug) => ({
        ticket: (
          await issueFirstAdminMfaTicket(op, {
            tenant: slug,
            reason: 'Browser rehearsal (synthetic)',
          })
        ).ticket,
      }),
    },
    takeInvitationToken: (email) => {
      const i = mailer.sent.map((m) => m.to).lastIndexOf(email);
      if (i < 0) return undefined;
      const [mail] = mailer.sent.splice(i, 1);
      return mail?.revealToken();
    },
    sql: async (text, values = []) => (await op.query(text, values)).rows as never,
    totp: (secretBase32, offsetSteps = 0) =>
      hotp(base32Decode(secretBase32), totpStep(Date.now()) + offsetSteps),
    stop: async () => {
      await app.close().catch(() => undefined);
      await db.close().catch(() => undefined);
      await op.end().catch(() => undefined);
      await server.stop().catch(() => undefined);
    },
  };
}
