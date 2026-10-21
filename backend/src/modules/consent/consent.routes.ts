import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { ConsentService } from './consent.service.js';
import {
  ConsentIdParamSchema,
  type ConsentIdParam,
  ConsentResponseSchema,
  ListConsentsQuerySchema,
  type ListConsentsQuery,
  ListConsentsResponseSchema,
  RecordConsentBodySchema,
  type RecordConsentBody,
  UserIdParamSchema,
  type UserIdParam,
} from './consent.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  if (req.tenantContext?.sessionId) meta.sessionId = req.tenantContext.sessionId;
  return meta;
}

interface ConsentRouteDeps {
  db: Database;
}

export const registerConsentRoutes: FastifyPluginAsync<ConsentRouteDeps> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database is required for consent routes.');
  const service = new ConsentService();

  // GET /me/consents
  app.get<{ Querystring: ListConsentsQuery }>(
    '/me/consents',
    {
      config: { permission: 'consent.read' },
      schema: {
        querystring: ListConsentsQuerySchema,
        response: { 200: ListConsentsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const query = req.query;
      const target = ctx.userId;
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.listConsents(tx, ctx, target, query),
      );
      return reply.send(result);
    },
  );

  // POST /me/consents
  app.post<{ Body: RecordConsentBody }>(
    '/me/consents',
    {
      config: { permission: 'consent.record' },
      schema: {
        body: RecordConsentBodySchema,
        response: { 201: ConsentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const body = req.body;
      const target = ctx.userId;
      const meta = extractAuditMeta(req);
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.recordConsent(tx, ctx, target, body, meta),
      );
      return reply.status(201).send(result);
    },
  );

  // POST /me/consents/:id/withdraw
  app.post<{ Params: ConsentIdParam }>(
    '/me/consents/:id/withdraw',
    {
      config: { permission: 'consent.withdraw' },
      schema: {
        params: ConsentIdParamSchema,
        response: { 200: ConsentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const consentId = req.params.id;
      const meta = extractAuditMeta(req);
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.withdrawConsent(tx, ctx, consentId, meta),
      );
      return reply.send(result);
    },
  );

  // GET /users/:id/consents
  app.get<{ Params: UserIdParam; Querystring: ListConsentsQuery }>(
    '/users/:id/consents',
    {
      config: { permission: 'consent.read' },
      schema: {
        params: UserIdParamSchema,
        querystring: ListConsentsQuerySchema,
        response: { 200: ListConsentsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const query = req.query;
      const target = req.params.id;
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.listConsents(tx, ctx, target, query),
      );
      return reply.send(result);
    },
  );

  // POST /users/:id/consents
  app.post<{ Params: UserIdParam; Body: RecordConsentBody }>(
    '/users/:id/consents',
    {
      config: { permission: 'consent.record' },
      schema: {
        params: UserIdParamSchema,
        body: RecordConsentBodySchema,
        response: { 201: ConsentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const body = req.body;
      const target = req.params.id;
      const meta = extractAuditMeta(req);
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.recordConsent(tx, ctx, target, body, meta),
      );
      return reply.status(201).send(result);
    },
  );
};
