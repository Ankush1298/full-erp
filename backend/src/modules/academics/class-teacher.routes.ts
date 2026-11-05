import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { CreateResponseSchema, IdParamSchema, type IdParam } from './academic.schemas.js';
import { DataResponse, ListResponse } from './calendar.schemas.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  ClassTeacherRecordSchema,
  CreateClassTeacherBodySchema,
  EndClassTeacherBodySchema,
  type CreateClassTeacherBody,
  type EndClassTeacherBody,
} from './class-teacher.schemas.js';
import { ClassTeacherService } from './class-teacher.service.js';

/**
 * Class teachers of a section under /api/v1/academics (doc 32). Reads use academic.program.read (rows are staff-only at
 * the database); writes academic.faculty.assign. PATCH (end) requires If-Match (428 missing, 400 malformed, 409 stale).
 */
export function registerClassTeacherRoutes(app: FastifyInstance, db: Database): void {
  const READ = { permission: 'academic.program.read' } as const;
  const ASSIGN = { permission: 'academic.faculty.assign' } as const;

  app.get<{ Params: IdParam }>(
    '/sections/:id/class-teachers',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: ListResponse(ClassTeacherRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        ClassTeacherService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: CreateClassTeacherBody }>(
    '/sections/:id/class-teachers',
    {
      config: ASSIGN,
      schema: {
        params: IdParamSchema,
        body: CreateClassTeacherBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        ClassTeacherService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: EndClassTeacherBody }>(
    '/class-teachers/:id',
    {
      config: ASSIGN,
      schema: {
        params: IdParamSchema,
        body: EndClassTeacherBodySchema,
        response: { 200: DataResponse(ClassTeacherRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        ClassTeacherService.end(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
