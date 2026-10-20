import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { StudentIdParamSchema, type StudentIdParam } from './student.schemas.js';
import { StudentGuardianService } from './student-guardian.service.js';
import {
  AddStudentGuardianBodySchema,
  type AddStudentGuardianBody,
  AddStudentGuardianResponseSchema,
  GetStudentGuardianResponseSchema,
  ListStudentGuardiansResponseSchema,
  RemoveStudentGuardianBodySchema,
  type RemoveStudentGuardianBody,
  RemoveStudentGuardianResponseSchema,
  StudentGuardianParamsSchema,
  type StudentGuardianParams,
  UpdateStudentGuardianBodySchema,
  type UpdateStudentGuardianBody,
} from './student-guardian.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

/**
 * doc 11 §5.4 line 162: GET/POST /students/{id}/guardians, PATCH/DELETE /students/{id}/guardians/{gid}, permissions
 * `student.guardian.read` / `student.guardian.manage`. Mounted at /api/v1/students next to the student routes. Guardian
 * data is served ONLY from here: no student, directory or enrolment response carries it.
 *
 * The route permission is the coarse gate (403 when held in no scope); the service proves the scope per student. POST
 * needs `Idempotency-Key` (428/400, passed raw: the service owns the answer). PATCH and DELETE need `If-Match` carrying the
 * exact version of the guardian (428 missing, 400 malformed/weak), and a mandatory `reason` in the body (A2, doc 02 §4.1;
 * DELETE therefore has a JSON body).
 */
export const registerStudentGuardianRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  if (!opts.db) {
    throw new Error('Database dependency is required to register student guardian routes.');
  }

  app.get<{ Params: StudentIdParam }>(
    '/:id/guardians',
    {
      config: { permission: 'student.guardian.read' },
      schema: {
        params: StudentIdParamSchema,
        response: { 200: ListStudentGuardiansResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentGuardianService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: StudentIdParam; Body: AddStudentGuardianBody }>(
    '/:id/guardians',
    {
      config: { permission: 'student.guardian.manage' },
      schema: {
        params: StudentIdParamSchema,
        body: AddStudentGuardianBodySchema,
        response: { 201: AddStudentGuardianResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await opts.db.withTenant(ctx, (tx) =>
        StudentGuardianService.add(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.patch<{ Params: StudentGuardianParams; Body: UpdateStudentGuardianBody }>(
    '/:id/guardians/:gid',
    {
      config: { permission: 'student.guardian.manage' },
      schema: {
        params: StudentGuardianParamsSchema,
        body: UpdateStudentGuardianBodySchema,
        response: { 200: GetStudentGuardianResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const options = { expected, meta: extractAuditMeta(req) };
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentGuardianService.update(tx, ctx, req.params.id, req.params.gid, req.body, options),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.delete<{ Params: StudentGuardianParams; Body: RemoveStudentGuardianBody }>(
    '/:id/guardians/:gid',
    {
      config: { permission: 'student.guardian.manage' },
      schema: {
        params: StudentGuardianParamsSchema,
        body: RemoveStudentGuardianBodySchema,
        response: { 200: RemoveStudentGuardianResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const options = { expected, meta: extractAuditMeta(req) };
      await opts.db.withTenant(ctx, (tx) =>
        StudentGuardianService.remove(tx, ctx, req.params.id, req.params.gid, req.body, options),
      );
      return reply.status(200).send({ success: true });
    },
  );
};
