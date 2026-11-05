import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { CreateResponseSchema, IdParamSchema, type IdParam } from './academic.schemas.js';
import { DataResponse, ListResponse } from './calendar.schemas.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  CreateElectiveGroupBodySchema,
  CreateRegistrationBodySchema,
  ElectiveGroupRecordSchema,
  FromSectionBodySchema,
  FromSectionResponseSchema,
  RegistrationRecordSchema,
  UpdateElectiveGroupBodySchema,
  UpdateRegistrationBodySchema,
  type CreateElectiveGroupBody,
  type CreateRegistrationBody,
  type FromSectionBody,
  type UpdateElectiveGroupBody,
  type UpdateRegistrationBody,
} from './registration.schemas.js';
import { CourseRegistrationService, ElectiveGroupService } from './registration.service.js';

/**
 * Elective groups and course registrations under /api/v1/academics (doc 33). Groups: read academic.program.read, write
 * academic.offering.manage. Registrations: read enrollment.term.read, write enrollment.term.manage. PATCH requires
 * If-Match (428 missing, 400 malformed, 409 stale).
 */
export function registerRegistrationRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: IdParam }>(
    '/cohort-periods/:id/elective-groups',
    {
      config: { permission: 'academic.program.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(ElectiveGroupRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        ElectiveGroupService.list(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: CreateElectiveGroupBody }>(
    '/cohort-periods/:id/elective-groups',
    {
      config: { permission: 'academic.offering.manage' },
      schema: {
        params: IdParamSchema,
        body: CreateElectiveGroupBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        ElectiveGroupService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateElectiveGroupBody }>(
    '/elective-groups/:id',
    {
      config: { permission: 'academic.offering.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateElectiveGroupBodySchema,
        response: { 200: DataResponse(ElectiveGroupRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        ElectiveGroupService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: IdParam }>(
    '/course-offerings/:id/registrations',
    {
      config: { permission: 'enrollment.term.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(RegistrationRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        CourseRegistrationService.listForOffering(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: CreateRegistrationBody }>(
    '/course-offerings/:id/registrations',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: IdParamSchema,
        body: CreateRegistrationBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        CourseRegistrationService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.post<{ Params: IdParam; Body: FromSectionBody }>(
    '/course-offerings/:id/registrations/from-section',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: IdParamSchema,
        body: FromSectionBodySchema,
        response: { 200: FromSectionResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        CourseRegistrationService.fromSection(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.get<{ Params: IdParam }>(
    '/term-enrollments/:id/course-registrations',
    {
      config: { permission: 'enrollment.term.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(RegistrationRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        CourseRegistrationService.listForEnrollment(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateRegistrationBody }>(
    '/course-registrations/:id',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateRegistrationBodySchema,
        response: { 200: DataResponse(RegistrationRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        CourseRegistrationService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
