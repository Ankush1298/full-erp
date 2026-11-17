import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { PromotionService } from './promotion.service.js';
import {
  PromotionPolicySchema,
  UpdatePromotionPolicyBodySchema,
  RolloverPreviewBodySchema,
  RolloverBatchDtoSchema,
  RolloverBatchSummaryDtoSchema,
  RolloverExceptionsBodySchema,
  RolloverExecuteBodySchema,
  RolloverExecuteResultSchema,
  type UpdatePromotionPolicyBody,
  type RolloverPreviewBody,
  type RolloverExceptionsBody,
  type RolloverExecuteBody,
} from './promotion.schemas.js';
import { UuidV7Schema } from '../students/student.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

export function registerPromotionRoutes(app: FastifyInstance, db: Database): void {
  // GET /promotion-policy
  app.get(
    '/promotion-policy',
    {
      config: { permission: 'enrollment.term.read' },
      schema: {
        response: {
          200: Type.Object({ success: Type.Literal(true), data: PromotionPolicySchema }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await db.withTenant(ctx, (tx) => PromotionService.getPolicy(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // PUT /promotion-policy
  app.put<{ Body: UpdatePromotionPolicyBody }>(
    '/promotion-policy',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        body: UpdatePromotionPolicyBodySchema,
        response: {
          200: Type.Object({ success: Type.Literal(true), data: PromotionPolicySchema }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        PromotionService.savePolicy(tx, ctx, req.body, meta),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // POST /rollover/preview
  app.post<{ Body: RolloverPreviewBody }>(
    '/rollover/preview',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        body: RolloverPreviewBodySchema,
        response: {
          200: Type.Object({ success: Type.Literal(true), data: RolloverBatchDtoSchema }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        PromotionService.generatePreview(tx, ctx, req.body, meta),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // PATCH /rollover/preview/:batchId/exceptions
  app.patch<{ Params: { batchId: string }; Body: RolloverExceptionsBody }>(
    '/rollover/preview/:batchId/exceptions',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        params: Type.Object({ batchId: UuidV7Schema }),
        body: RolloverExceptionsBodySchema,
        response: {
          200: Type.Object({ success: Type.Literal(true), data: RolloverBatchDtoSchema }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        PromotionService.updateExceptions(tx, ctx, req.params.batchId, req.body, meta),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // POST /rollover/execute
  app.post<{ Body: RolloverExecuteBody }>(
    '/rollover/execute',
    {
      config: { permission: 'enrollment.term.manage' },
      schema: {
        body: RolloverExecuteBodySchema,
        response: {
          200: Type.Object({ success: Type.Literal(true), data: RolloverExecuteResultSchema }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        PromotionService.executeRollover(tx, ctx, req.body, meta),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // GET /rollover/batches
  app.get(
    '/rollover/batches',
    {
      config: { permission: 'enrollment.term.read' },
      schema: {
        response: {
          200: Type.Object({
            success: Type.Literal(true),
            data: Type.Array(RolloverBatchSummaryDtoSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await db.withTenant(ctx, (tx) => PromotionService.listBatches(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // GET /rollover/batches/:batchId
  app.get<{ Params: { batchId: string } }>(
    '/rollover/batches/:batchId',
    {
      config: { permission: 'enrollment.term.read' },
      schema: {
        params: Type.Object({ batchId: UuidV7Schema }),
        response: {
          200: Type.Object({
            success: Type.Literal(true),
            data: Type.Union([RolloverBatchDtoSchema, Type.Null()]),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await db.withTenant(ctx, (tx) =>
        PromotionService.getBatch(tx, ctx, req.params.batchId),
      );
      if (!data) throw new AppError(404, 'NOT_FOUND', 'Rollover batch not found.');
      return reply.status(200).send({ success: true, data });
    },
  );
}
