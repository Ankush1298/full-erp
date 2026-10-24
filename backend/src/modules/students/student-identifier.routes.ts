import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { StudentIdParamSchema, type StudentIdParam } from './student.schemas.js';
import { StudentIdentifierService } from './student-identifier.service.js';
import {
  AddStudentIdentifierBodySchema,
  type AddStudentIdentifierBody,
  AddStudentIdentifierResponseSchema,
  GetStudentIdentifierResponseSchema,
  ListStudentIdentifiersResponseSchema,
  StudentIdentifierParamsSchema,
  type StudentIdentifierParams,
  UpdateStudentIdentifierBodySchema,
  type UpdateStudentIdentifierBody,
} from './student-identifier.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  if (req.tenantContext?.sessionId) meta.sessionId = req.tenantContext.sessionId;
  return meta;
}

/**
 * GET/POST /students/{id}/identifiers and PATCH /students/{id}/identifiers/{iid} (docs/architecture/v3/02 §4.4; doc 10
 * rows 24 and 27). Mounted at /api/v1/students next to the student routes. There is no DELETE: an identifier is end-dated,
 * never removed. The route permission is the coarse gate (403 when held in no scope); the service proves the scope per
 * student. POST needs `Idempotency-Key` (428/400, passed raw: the service owns the answer). PATCH needs `If-Match` with
 * the exact version (428 missing, 400 malformed/weak).
 */
export const registerStudentIdentifierRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  if (!opts.db) {
    throw new Error('Database dependency is required to register student identifier routes.');
  }

  app.get<{ Params: StudentIdParam }>(
    '/:id/identifiers',
    {
      config: { permission: 'student.profile.read_sensitive' },
      schema: {
        params: StudentIdParamSchema,
        response: { 200: ListStudentIdentifiersResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentIdentifierService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: StudentIdParam; Body: AddStudentIdentifierBody }>(
    '/:id/identifiers',
    {
      config: { permission: 'student.record.update' },
      schema: {
        params: StudentIdParamSchema,
        body: AddStudentIdentifierBodySchema,
        response: { 201: AddStudentIdentifierResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await opts.db.withTenant(ctx, (tx) =>
        StudentIdentifierService.add(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.patch<{ Params: StudentIdentifierParams; Body: UpdateStudentIdentifierBody }>(
    '/:id/identifiers/:iid',
    {
      config: { permission: 'student.record.update' },
      schema: {
        params: StudentIdentifierParamsSchema,
        body: UpdateStudentIdentifierBodySchema,
        response: { 200: GetStudentIdentifierResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const options = { expected, meta: extractAuditMeta(req) };
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentIdentifierService.update(tx, ctx, req.params.id, req.params.iid, req.body, options),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );
};
