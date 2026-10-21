import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../../shared/database/index.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from '../academics/common.js';
import { StudentIdParamSchema, type StudentIdParam, UuidV7Schema } from './student.schemas.js';
import { TermEnrollmentService } from './term-enrollment.service.js';
import {
  CreateTermEnrollmentBodySchema,
  CreateTermEnrollmentResponseSchema,
  GetTermEnrollmentResponseSchema,
  ListTermEnrollmentsResponseSchema,
  PlaceSectionBodySchema,
  UpdateTermEnrollmentBodySchema,
  type CreateTermEnrollmentBody,
  type PlaceSectionBody,
  type UpdateTermEnrollmentBody,
} from './term-enrollment.schemas.js';

const EnrollmentParamsSchema = Type.Object(
  { id: UuidV7Schema, eid: UuidV7Schema },
  { additionalProperties: false },
);
interface EnrollmentParams {
  id: string;
  eid: string;
}

/**
 * Term-enrolment routes, mounted under /api/v1/students by registerStudentRoutes. The path's student must own the
 * enrolment (else 404). Creation requires Idempotency-Key (passed RAW: the service owns 428/400); PATCH and the section
 * placement require If-Match where they change a versioned row (428 missing, 400 malformed, 409 stale).
 */
export function registerTermEnrollmentRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: StudentIdParam }>(
    '/:id/term-enrollments',
    {
      config: { permission: 'enrollment.term.read' },
      schema: {
        params: StudentIdParamSchema,
        response: { 200: ListTermEnrollmentsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        TermEnrollmentService.listForStudent(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: StudentIdParam; Body: CreateTermEnrollmentBody }>(
    '/:id/term-enrollments',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: StudentIdParamSchema,
        body: CreateTermEnrollmentBodySchema,
        response: { 201: CreateTermEnrollmentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        TermEnrollmentService.create(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.get<{ Params: EnrollmentParams }>(
    '/:id/term-enrollments/:eid',
    {
      config: { permission: 'enrollment.term.read' },
      schema: {
        params: EnrollmentParamsSchema,
        response: { 200: GetTermEnrollmentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id: owner, eid } = req.params;
      const data = await db.withTenant(ctx, (tx) =>
        TermEnrollmentService.getById(tx, ctx, eid, owner),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.patch<{ Params: EnrollmentParams; Body: UpdateTermEnrollmentBody }>(
    '/:id/term-enrollments/:eid',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: EnrollmentParamsSchema,
        body: UpdateTermEnrollmentBodySchema,
        response: { 200: GetTermEnrollmentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const { id: owner, eid } = req.params;
      const options = { expected, studentId: owner, meta: extractAuditMeta(req) };
      const data = await db.withTenant(ctx, (tx) =>
        TermEnrollmentService.update(tx, ctx, eid, req.body, options),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // Places or moves the student in a section. Not If-Match guarded: the membership history (closed row + new row, both
  // under the enrolment lock) is the audit trail, and a retry after success meets "already in this section" (409).
  app.post<{ Params: EnrollmentParams; Body: PlaceSectionBody }>(
    '/:id/term-enrollments/:eid/section',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: EnrollmentParamsSchema,
        body: PlaceSectionBodySchema,
        response: { 200: GetTermEnrollmentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id: owner, eid } = req.params;
      const options = { studentId: owner, meta: extractAuditMeta(req) };
      const data = await db.withTenant(ctx, (tx) =>
        TermEnrollmentService.placeSection(tx, ctx, eid, req.body, options),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
