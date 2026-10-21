import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { EmployeeService } from './employee.service.js';
import { PostingService } from './posting.service.js';
import {
  CreateEmployeeBodySchema,
  type CreateEmployeeBody,
  CreateEmployeeResponseSchema,
  EmployeeIdParamSchema,
  type EmployeeIdParam,
  GetEmployeeResponseSchema,
  ListEmployeesQuerySchema,
  type ListEmployeesQuery,
  ListEmployeesResponseSchema,
  UpdateEmployeeBodySchema,
  type UpdateEmployeeBody,
  UpdateEmployeeResponseSchema,
} from './employee.schemas.js';
import {
  ClosePostingBodySchema,
  type ClosePostingBody,
  CreatePostingBodySchema,
  type CreatePostingBody,
  CreatePostingResponseSchema,
  GetPostingResponseSchema,
  ListPostingsResponseSchema,
  PostingIdParamSchema,
  type PostingIdParam,
  UpdatePostingBodySchema,
  type UpdatePostingBody,
} from './posting.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

/** doc 11 §5.4: GET/POST /employees, GET/PATCH /employees/{id}. Mounted under /api/v1/faculty (doc 04 §14.2). */
export const registerPeopleRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database dependency is required to register people routes.');

  app.get<{ Querystring: ListEmployeesQuery }>(
    '/employees',
    {
      config: { permission: 'employee.profile.read' },
      schema: {
        querystring: ListEmployeesQuerySchema,
        response: { 200: ListEmployeesResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => EmployeeService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Body: CreateEmployeeBody }>(
    '/employees',
    {
      config: { permission: 'employee.record.create' },
      schema: { body: CreateEmployeeBodySchema, response: { 201: CreateEmployeeResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const id = await opts.db.withTenant(ctx, (tx) =>
        EmployeeService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  app.get<{ Params: EmployeeIdParam }>(
    '/employees/:id',
    {
      config: { permission: 'employee.profile.read' },
      schema: { params: EmployeeIdParamSchema, response: { 200: GetEmployeeResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        EmployeeService.getById(tx, ctx, req.params.id),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  // Mutations require If-Match (doc 08 §4.1 lists employees): missing 428, malformed 400, stale 409.
  app.patch<{ Params: EmployeeIdParam; Body: UpdateEmployeeBody }>(
    '/employees/:id',
    {
      config: { permission: 'employee.record.update' },
      schema: {
        params: EmployeeIdParamSchema,
        body: UpdateEmployeeBodySchema,
        response: { 200: UpdateEmployeeResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const meta = extractAuditMeta(req);
      const data = await opts.db.withTenant(ctx, (tx) =>
        EmployeeService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  // --- Employee Postings (Milestone 2 Batch 1) ---

  // GET /employees/:id/postings
  app.get<{ Params: EmployeeIdParam }>(
    '/employees/:id/postings',
    {
      config: { permission: 'employee.profile.read' },
      schema: {
        params: EmployeeIdParamSchema,
        response: { 200: ListPostingsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const data = await opts.db.withTenant(ctx, (tx) =>
        PostingService.listByEmployee(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // POST /employees/:id/postings
  app.post<{ Params: EmployeeIdParam; Body: CreatePostingBody }>(
    '/employees/:id/postings',
    {
      config: { permission: 'employee.record.update' },
      schema: {
        params: EmployeeIdParamSchema,
        body: CreatePostingBodySchema,
        response: { 201: CreatePostingResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      const id = await opts.db.withTenant(ctx, (tx) =>
        PostingService.create(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // GET /postings/:id
  app.get<{ Params: PostingIdParam }>(
    '/postings/:id',
    {
      config: { permission: 'employee.profile.read' },
      schema: {
        params: PostingIdParamSchema,
        response: { 200: GetPostingResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const data = await opts.db.withTenant(ctx, (tx) =>
        PostingService.getById(tx, ctx, req.params.id),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  // PATCH /postings/:id
  app.patch<{ Params: PostingIdParam; Body: UpdatePostingBody }>(
    '/postings/:id',
    {
      config: { permission: 'employee.record.update' },
      schema: {
        params: PostingIdParamSchema,
        body: UpdatePostingBodySchema,
        response: { 200: GetPostingResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const meta = extractAuditMeta(req);

      const data = await opts.db.withTenant(ctx, (tx) =>
        PostingService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  // POST /postings/:id/close
  app.post<{ Params: PostingIdParam; Body: ClosePostingBody }>(
    '/postings/:id/close',
    {
      config: { permission: 'employee.record.update' },
      schema: {
        params: PostingIdParamSchema,
        body: ClosePostingBodySchema,
        response: { 200: GetPostingResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const meta = extractAuditMeta(req);

      const data = await opts.db.withTenant(ctx, (tx) =>
        PostingService.close(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );
};
