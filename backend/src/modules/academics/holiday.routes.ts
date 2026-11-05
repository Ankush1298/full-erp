import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { CreateResponseSchema, IdParamSchema, type IdParam } from './academic.schemas.js';
import { DataResponse, ListResponse } from './calendar.schemas.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  CreateHolidayBodySchema,
  HolidayRecordSchema,
  HolidayService,
  ListHolidaysQuerySchema,
  UpdateHolidayBodySchema,
  type CreateHolidayBody,
  type ListHolidaysQuery,
  type UpdateHolidayBody,
} from './holiday.service.js';

/** Holidays under /api/v1/academics (doc 33 §4): read academic.program.read, write academic.term.manage (If-Match on PATCH). */
export function registerHolidayRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Querystring: ListHolidaysQuery }>(
    '/holidays',
    {
      config: { permission: 'academic.program.read' },
      schema: {
        querystring: ListHolidaysQuerySchema,
        response: { 200: ListResponse(HolidayRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => HolidayService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateHolidayBody }>(
    '/holidays',
    {
      config: { permission: 'academic.term.manage' },
      schema: { body: CreateHolidayBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) => HolidayService.create(tx, ctx, req.body, meta));
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateHolidayBody }>(
    '/holidays/:id',
    {
      config: { permission: 'academic.term.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateHolidayBodySchema,
        response: { 200: DataResponse(HolidayRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        HolidayService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
