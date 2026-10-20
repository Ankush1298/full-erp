import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import type { CursorCodec } from '../../shared/pagination/index.js';
import { FixedWindowLimiter } from '../../shared/http/fixed-window-limiter.js';
import { StudentDirectoryListService } from './student-directory-list.service.js';
import {
  StudentDirectoryListQuerySchema,
  type StudentDirectoryListQuery,
  StudentDirectoryListResponseSchema,
} from './student.schemas.js';

/**
 * Rate limit for GET /api/v1/students/directory: 30 requests per user per 60 seconds.
 * Rationale: an interactive client pages a few times a minute. At the maximum page size (100) the ceiling is about
 * 3,000 rows a minute per account, which makes a bulk walk of a large tenant slow, noisy in the audit log (one event
 * per page) and cheap to spot, without hindering normal use. The number is a judgement, not a measurement: revisit it
 * with real usage. SINGLE INSTANCE ONLY (see FixedWindowLimiter): it is not coordinated across backend instances.
 */
export const DIRECTORY_RATE_LIMIT = 30;
export const DIRECTORY_RATE_WINDOW_MS = 60_000;
export const DIRECTORY_RATE_MAX_KEYS = 10_000;

export function createDirectoryLimiter(now?: () => number): FixedWindowLimiter {
  return new FixedWindowLimiter({
    limit: DIRECTORY_RATE_LIMIT,
    windowMs: DIRECTORY_RATE_WINDOW_MS,
    maxKeys: DIRECTORY_RATE_MAX_KEYS,
    ...(now ? { now } : {}),
  });
}

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

export interface StudentDirectoryRoutesOptions {
  db: Database;
  codec: CursorCodec;
  /** Key ID the codec issues new cursors with; recorded in the audit event, never a secret. */
  activeKeyId: string;
  limiter: FixedWindowLimiter;
}

/**
 * GET /api/v1/students/directory (docs/architecture/v3/21-students.md §0c). Registered by buildApp ONLY when valid cursor
 * configuration exists AND STUDENT_DIRECTORY_LIST_ENABLED=true; otherwise this plugin is never loaded. The path is then not
 * a 404 but is read by GET /students/:id as a malformed id (401 unauthenticated, 400 otherwise).
 * The permission gate (student.directory.list) runs in the shared preHandler before this handler, so the limiter below
 * counts callers who passed it. That gate already ran a grants query, so a request refused with 429 still cost one
 * database round trip; the limiter bounds the handler (data query and audit write), not all database work.
 */
export const registerStudentDirectoryRoutes: FastifyPluginAsync<
  StudentDirectoryRoutesOptions
> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db)
    throw new Error('Database dependency is required to register the student directory.');
  if (!opts.codec) throw new Error('A cursor codec is required to register the student directory.');

  app.get<{ Querystring: StudentDirectoryListQuery }>(
    '/directory',
    {
      config: { permission: 'student.directory.list' },
      schema: {
        querystring: StudentDirectoryListQuerySchema,
        response: { 200: StudentDirectoryListResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const wait = opts.limiter.take(`${ctx.tenantId}:${ctx.userId}`);
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests. Try again later.');
      }
      const meta = extractAuditMeta(req);
      const page = await opts.db.withTenant(ctx, (tx) =>
        StudentDirectoryListService.list(tx, ctx, req.query, {
          codec: opts.codec,
          activeKeyId: opts.activeKeyId,
          meta,
          log: req.log,
        }),
      );
      return reply
        .status(200)
        .send({ success: true, data: page.items, page: { nextCursor: page.nextCursor } });
    },
  );
};
