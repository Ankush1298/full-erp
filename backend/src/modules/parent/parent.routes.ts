import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { ParentService } from './parent.service.js';
import {
  ChildParamSchema,
  type ChildParam,
  GetParentChildrenResponseSchema,
  GetChildSummaryResponseSchema,
  GetChildAttendanceResponseSchema,
  GetChildAcademicsResponseSchema,
  GetChildExaminationsResponseSchema,
  GetChildFeesResponseSchema,
} from './parent.schemas.js';

export const registerParentRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) {
    throw new Error('Database dependency is required for parent routes.');
  }

  // 1. List verified linked children
  app.get(
    '/children',
    {
      config: { permission: 'parent.portal.access' },
      schema: {
        response: { 200: GetParentChildrenResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => ParentService.getChildren(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 2. Child summary overview
  app.get<{ Params: ChildParam }>(
    '/children/:childId/summary',
    {
      config: { permission: 'parent.portal.access' },
      schema: {
        params: ChildParamSchema,
        response: { 200: GetChildSummaryResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        ParentService.getChildSummary(tx, ctx, req.params.childId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 3. Child attendance
  app.get<{ Params: ChildParam }>(
    '/children/:childId/attendance',
    {
      config: { permission: 'parent.attendance.read' },
      schema: {
        params: ChildParamSchema,
        response: { 200: GetChildAttendanceResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        ParentService.getChildAttendance(tx, ctx, req.params.childId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 4. Child academics
  app.get<{ Params: ChildParam }>(
    '/children/:childId/academics',
    {
      config: { permission: 'parent.academics.read' },
      schema: {
        params: ChildParamSchema,
        response: { 200: GetChildAcademicsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        ParentService.getChildAcademics(tx, ctx, req.params.childId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 5. Child examinations (strictly published results)
  app.get<{ Params: ChildParam }>(
    '/children/:childId/examinations',
    {
      config: { permission: 'parent.exam.read' },
      schema: {
        params: ChildParamSchema,
        response: { 200: GetChildExaminationsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        ParentService.getChildExaminations(tx, ctx, req.params.childId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 6. Child fees and payments
  app.get<{ Params: ChildParam }>(
    '/children/:childId/fees',
    {
      config: { permission: 'parent.fee.read' },
      schema: {
        params: ChildParamSchema,
        response: { 200: GetChildFeesResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        ParentService.getChildFees(tx, ctx, req.params.childId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
};
