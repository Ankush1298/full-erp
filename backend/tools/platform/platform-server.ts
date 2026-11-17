import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import pg from 'pg';
import { registerPlatformRoutes } from './platform.routes.js';
import type { PlatformDb } from './platform.service.js';

export function createPlatformDb(
  connectionString: string,
): PlatformDb & { close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: false,
  });

  return {
    async withSystem<T>(
      work: (tx: {
        query: <R = Record<string, unknown>>(
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: R[]; rowCount: number | null }>;
      }) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[]; rowCount: number | null }> {
      const res = await pool.query(sql, params ?? []);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export function buildPlatformServer(opts: { db: PlatformDb }) {
  const app = Fastify({
    logger: false,
  });

  app.register(cookie);

  app.register(registerPlatformRoutes, {
    prefix: '/api/v1/platform',
    db: opts.db,
  });

  return app;
}

async function start() {
  const port = parseInt(process.env['PLATFORM_PORT'] || '4001', 10);
  const host = process.env['PLATFORM_HOST'] || '127.0.0.1';

  const connectionString =
    process.env['PLATFORM_DATABASE_URL'] || process.env['DATABASE_ADMIN_URL'];
  if (!connectionString) {
    throw new Error(
      'PLATFORM_DATABASE_URL or DATABASE_ADMIN_URL environment variable is required.',
    );
  }

  const db = createPlatformDb(connectionString);
  const server = buildPlatformServer({ db });

  await server.listen({ host, port });
  console.log(`[Anesa Platform Owner Server] listening at http://${host}:${port}`);

  const shutdown = async () => {
    await server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  start().catch((err) => {
    console.error('Failed to start platform server:', err);
    process.exit(1);
  });
}
