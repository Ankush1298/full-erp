import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import type { StorageDriver } from '../../shared/storage/index.js';
import { DocumentService } from './document.service.js';
import {
  CompleteUploadResponseSchema,
  DocumentIdParamSchema,
  type DocumentIdParam,
  DownloadUrlResponseSchema,
  InitiateUploadBodySchema,
  type InitiateUploadBody,
  InitiateUploadResponseSchema,
  LinkDocumentBodySchema,
  type LinkDocumentBody,
  LinkDocumentResponseSchema,
  StudentIdParamSchema,
  type StudentIdParam,
  UploadIdParamSchema,
  type UploadIdParam,
} from './document.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  if (req.tenantContext?.sessionId) meta.sessionId = req.tenantContext.sessionId;
  return meta;
}

interface DocumentRouteDeps {
  db: Database;
  storage: StorageDriver;
}

/**
 * doc 11 §5.4: POST /documents/uploads, POST /documents/uploads/{id}/complete, GET /documents/{id}/download-url.
 * Mounted at /api/v1/documents. GET /documents/{id} and DELETE /documents/{id} are later phases.
 */
export const registerDocumentRoutes: FastifyPluginAsync<DocumentRouteDeps> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db || !opts.storage)
    throw new Error('Database and storage are required for document routes.');
  const service = new DocumentService(opts.storage);

  // Idempotency-Key is passed RAW: the service owns 428 (missing) / 400 (malformed).
  app.post<{ Body: InitiateUploadBody }>(
    '/uploads',
    {
      config: { permission: 'document.upload' },
      schema: {
        body: InitiateUploadBodySchema,
        response: { 201: InitiateUploadResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const result = await opts.db.withTenant(ctx, (tx) =>
        service.initiateUpload(tx, ctx, req.body, {
          idempotencyKey: req.headers['idempotency-key'],
          meta: extractAuditMeta(req),
        }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: UploadIdParam }>(
    '/uploads/:id/complete',
    {
      config: { permission: 'document.upload' },
      schema: { params: UploadIdParamSchema, response: { 200: CompleteUploadResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        service.completeUpload(tx, ctx, req.params.id, { meta: extractAuditMeta(req) }),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: DocumentIdParam }>(
    '/:id/download-url',
    {
      config: { permission: 'document.read' },
      schema: { params: DocumentIdParamSchema, response: { 200: DownloadUrlResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        service.downloadUrl(tx, ctx, req.params.id, { meta: extractAuditMeta(req) }),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
};

/**
 * doc 11 §5.4: POST /students/{id}/documents (link a clean file to a student). Mounted at /api/v1/students; a separate
 * plugin so the student prefix owns this path while the documents prefix owns the upload lifecycle.
 */
export const registerStudentDocumentRoutes: FastifyPluginAsync<DocumentRouteDeps> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  if (!opts.db || !opts.storage)
    throw new Error('Database and storage are required for document routes.');
  const service = new DocumentService(opts.storage);

  app.post<{ Params: StudentIdParam; Body: LinkDocumentBody }>(
    '/:id/documents',
    {
      config: { permission: 'document.upload' },
      schema: {
        params: StudentIdParamSchema,
        body: LinkDocumentBodySchema,
        response: { 201: LinkDocumentResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        service.linkToStudent(tx, ctx, req.params.id, req.body, { meta: extractAuditMeta(req) }),
      );
      return reply.status(201).send({ success: true, data });
    },
  );
};
