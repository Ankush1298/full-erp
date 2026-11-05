import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { CreateResponseSchema, IdParamSchema, type IdParam } from './academic.schemas.js';
import { DataResponse, ListResponse } from './calendar.schemas.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  AssignmentRecordSchema,
  CreateAssignmentBodySchema,
  CreateOfferingBodySchema,
  CreateSlotBodySchema,
  EndAssignmentBodySchema,
  EndSlotBodySchema,
  ListOfferingsQuerySchema,
  OfferingRecordSchema,
  SlotRecordSchema,
  UpdateOfferingBodySchema,
  type CreateAssignmentBody,
  type CreateOfferingBody,
  type CreateSlotBody,
  type EndAssignmentBody,
  type EndSlotBody,
  type ListOfferingsQuery,
  type UpdateOfferingBody,
} from './offering.schemas.js';
import {
  FacultyAssignmentService,
  OfferingService,
  TimetableSlotService,
} from './offering.service.js';

/**
 * Milestone 3 Batch 2 routes under /api/v1/academics (doc 31): course offerings, their faculty assignments and timetable
 * slots. Reads use academic.program.read; writes academic.offering.manage (offerings, slots) or academic.faculty.assign
 * (assignments). Every PATCH requires If-Match (428 missing, 400 malformed, 409 stale).
 */
export function registerOfferingRoutes(app: FastifyInstance, db: Database): void {
  const READ = { permission: 'academic.program.read' } as const;
  const MANAGE = { permission: 'academic.offering.manage' } as const;
  const ASSIGN = { permission: 'academic.faculty.assign' } as const;

  // ---- course offerings ---------------------------------------------------------------------------
  app.get<{ Querystring: ListOfferingsQuery }>(
    '/course-offerings',
    {
      config: READ,
      schema: {
        querystring: ListOfferingsQuerySchema,
        response: { 200: ListResponse(OfferingRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => OfferingService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateOfferingBody }>(
    '/course-offerings',
    {
      config: MANAGE,
      schema: { body: CreateOfferingBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) => OfferingService.create(tx, ctx, req.body, meta));
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.get<{ Params: IdParam }>(
    '/course-offerings/:id',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: DataResponse(OfferingRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        OfferingService.getById(tx, ctx, req.params.id),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateOfferingBody }>(
    '/course-offerings/:id',
    {
      config: MANAGE,
      schema: {
        params: IdParamSchema,
        body: UpdateOfferingBodySchema,
        response: { 200: DataResponse(OfferingRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        OfferingService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- faculty assignments ------------------------------------------------------------------------
  app.get<{ Params: IdParam }>(
    '/course-offerings/:id/faculty-assignments',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: ListResponse(AssignmentRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        FacultyAssignmentService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: CreateAssignmentBody }>(
    '/course-offerings/:id/faculty-assignments',
    {
      config: ASSIGN,
      schema: {
        params: IdParamSchema,
        body: CreateAssignmentBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        FacultyAssignmentService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: EndAssignmentBody }>(
    '/faculty-assignments/:id',
    {
      config: ASSIGN,
      schema: {
        params: IdParamSchema,
        body: EndAssignmentBodySchema,
        response: { 200: DataResponse(AssignmentRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        FacultyAssignmentService.end(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- timetable slots ----------------------------------------------------------------------------
  app.get<{ Params: IdParam }>(
    '/course-offerings/:id/timetable-slots',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: ListResponse(SlotRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        TimetableSlotService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: CreateSlotBody }>(
    '/course-offerings/:id/timetable-slots',
    {
      config: MANAGE,
      schema: {
        params: IdParamSchema,
        body: CreateSlotBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        TimetableSlotService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: EndSlotBody }>(
    '/timetable-slots/:id',
    {
      config: MANAGE,
      schema: {
        params: IdParamSchema,
        body: EndSlotBodySchema,
        response: { 200: DataResponse(SlotRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        TimetableSlotService.end(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
