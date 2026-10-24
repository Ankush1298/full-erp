import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import type { ImportType } from './import.common.js';
import { ImportService } from './import.service.js';
import type { MatchingBinder } from './import.binding.js';
import {
  CommitImportBodySchema,
  type CommitImportBody,
  CommitImportResponseSchema,
  CreateImportBodySchema,
  type CreateImportBody,
  CreateImportResponseSchema,
  GetImportResponseSchema,
  ImportJobParamsSchema,
  type ImportJobParams,
  ListImportRowsQuerySchema,
  type ListImportRowsQuery,
  ListImportRowsResponseSchema,
} from './import.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  if (req.tenantContext?.sessionId) meta.sessionId = req.tenantContext.sessionId;
  return meta;
}

interface ImportRouteOptions {
  db: Database;
  /** The one record kind served under this prefix. A job of another kind is a 404 here. */
  type: ImportType;
  /** HMAC binder of the IMPORT_MATCHING_KEYS ring; absent = commits carrying matching data are refused (503). */
  binder?: MatchingBinder | undefined;
}

/**
 * The import workflow for ONE record kind (doc 04 Part 16: "import framework (validate -> preview -> commit)"), mounted
 * under /api/v1/students/imports and /api/v1/faculty/imports (doc 04 §14: `/students` has the import resource):
 *   POST /                  create a DRAFT job from rows (Idempotency-Key)
 *   POST /:id/validate      evaluate and store row errors, warnings and the proposed changes (no domain write); optional
 *                           body `{ matching }` resupplies the matching-only cells, which are never stored
 *   GET  /:id               the job
 *   GET  /:id/rows          the preview, paginated by row number
 *   GET  /:id/error-report  errors and warnings as CSV
 *   POST /:id/commit        apply a VALIDATED job (If-Match = job version, Idempotency-Key)
 * Every route needs `import.job.manage` (403 when held in no scope); the service additionally requires the create
 * permission of the record kind and organization scope, and proves ownership of the job.
 */
export const registerImportRoutes: FastifyPluginAsync<ImportRouteOptions> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database dependency is required to register import routes.');
  const { db, type, binder } = opts;

  app.post<{ Body: CreateImportBody }>(
    '/',
    {
      config: { permission: 'import.job.manage' },
      schema: { body: CreateImportBodySchema, response: { 201: CreateImportResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await db.withTenant(ctx, (tx) =>
        ImportService.create(tx, ctx, type, req.body, {
          idempotencyKey: req.headers['idempotency-key'],
          meta: extractAuditMeta(req),
        }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: ImportJobParams; Body: unknown }>(
    '/:id/validate',
    {
      config: { permission: 'import.job.manage' },
      schema: { params: ImportJobParamsSchema, response: { 200: GetImportResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await db.withTenant(ctx, (tx) =>
        ImportService.validate(tx, ctx, type, req.params.id, req.body),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: ImportJobParams }>(
    '/:id',
    {
      config: { permission: 'import.job.manage' },
      schema: { params: ImportJobParamsSchema, response: { 200: GetImportResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await db.withTenant(ctx, (tx) =>
        ImportService.get(tx, ctx, type, req.params.id),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: ImportJobParams; Querystring: ListImportRowsQuery }>(
    '/:id/rows',
    {
      config: { permission: 'import.job.manage' },
      schema: {
        params: ImportJobParamsSchema,
        querystring: ListImportRowsQuerySchema,
        response: { 200: ListImportRowsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const out = await db.withTenant(ctx, (tx) =>
        ImportService.rows(tx, ctx, type, req.params.id, req.query),
      );
      return reply
        .status(200)
        .send({ success: true, data: out.data, page: { nextAfterRowNo: out.nextAfterRowNo } });
    },
  );

  app.get<{ Params: ImportJobParams }>(
    '/:id/error-report',
    {
      config: { permission: 'import.job.manage' },
      schema: { params: ImportJobParamsSchema },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const csv = await db.withTenant(ctx, (tx) =>
        ImportService.errorReport(tx, ctx, type, req.params.id),
      );
      return reply
        .status(200)
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="import-${req.params.id}-errors.csv"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(csv);
    },
  );

  // If-Match is mandatory (428 missing, 400 malformed/weak) and must carry the exact job version of the preview.
  app.post<{ Params: ImportJobParams; Body: CommitImportBody }>(
    '/:id/commit',
    {
      config: { permission: 'import.job.manage' },
      schema: {
        params: ImportJobParamsSchema,
        body: CommitImportBodySchema,
        response: { 200: CommitImportResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const outcome = await db.withTenant(ctx, (tx) =>
        ImportService.commit(tx, ctx, type, req.params.id, req.body, {
          expected,
          idempotencyKey: req.headers['idempotency-key'],
          meta: extractAuditMeta(req),
          ...(binder ? { binder } : {}),
        }),
      );
      // A stale preview is answered only after its refreshed outcome has been committed.
      if (outcome.kind === 'refused') throw outcome.error;
      if (outcome.result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(outcome.result.status).send(outcome.result.body);
    },
  );
};

/** Mounts the student-record import at /api/v1/students/imports. */
export const registerStudentImportRoutes: FastifyPluginAsync<{
  db: Database;
  binder?: MatchingBinder | undefined;
}> = async (app, opts) => {
  await app.register(registerImportRoutes, {
    db: opts.db,
    type: 'STUDENT_RECORDS',
    binder: opts.binder,
  });
};

/** Mounts the employee-record ("faculty") import at /api/v1/faculty/imports. */
export const registerEmployeeImportRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  await app.register(registerImportRoutes, { db: opts.db, type: 'EMPLOYEE_RECORDS' });
};
