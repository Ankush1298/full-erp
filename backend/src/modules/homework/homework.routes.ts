import type { FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { HomeworkService } from './homework.service.js';
import { registerHomeworkResolvers } from './assigned-resolver.js';
import {
  AttachmentDownloadResponseSchema,
  AvailableDocumentItemSchema,
  CreateHomeworkBodySchema,
  HomeworkDetailDtoSchema,
  RecipientPreviewResponseSchema,
  ReviewSubmissionBodySchema,
  StudentHomeworkItemDtoSchema,
  SubmissionListItemDtoSchema,
  TeacherClassItemSchema,
  UpdateHomeworkBodySchema,
  UploadAttachmentBodySchema,
  UploadAttachmentResponseSchema,
  type CreateHomeworkBody,
  type ReviewSubmissionBody,
  type UpdateHomeworkBody,
  type UploadAttachmentBody,
} from './homework.schemas.js';

export const registerHomeworkRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  if (!opts.db) {
    throw new Error('Database dependency is required for homework routes.');
  }

  // Register ASSIGNED resolvers for faculty access
  registerHomeworkResolvers();

  // 1. List teacher classes & offerings
  app.get(
    '/teacher/classes',
    {
      config: { permission: 'homework.manage' },
      schema: {
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(TeacherClassItemSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) => HomeworkService.listTeacherClasses(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 2. Preview recipients for an offering and section
  app.get<{ Querystring: { courseOfferingId: string; sectionId?: string } }>(
    '/teacher/preview-recipients',
    {
      config: { permission: 'homework.manage' },
      schema: {
        querystring: Type.Object({
          courseOfferingId: Type.String(),
          sectionId: Type.Optional(Type.String()),
        }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: RecipientPreviewResponseSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const { courseOfferingId, sectionId } = req.query;
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.previewRecipients(tx, ctx, courseOfferingId, sectionId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 3. List teacher homework assignments
  app.get<{ Querystring: { courseOfferingId?: string; sectionId?: string; status?: string } }>(
    '/teacher/assignments',
    {
      config: { permission: 'homework.manage' },
      schema: {
        querystring: Type.Object({
          courseOfferingId: Type.Optional(Type.String()),
          sectionId: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
        }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(HomeworkDetailDtoSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.listTeacherHomework(tx, ctx, req.query),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 4. Create homework
  app.post<{ Body: CreateHomeworkBody }>(
    '/teacher/assignments',
    {
      config: { permission: 'homework.manage' },
      schema: {
        body: CreateHomeworkBodySchema,
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: HomeworkDetailDtoSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.createHomework(tx, ctx, req.body),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 5. Get homework detail
  app.get<{ Params: { id: string } }>(
    '/teacher/assignments/:id',
    {
      config: { permission: 'homework.manage' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: HomeworkDetailDtoSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.getHomeworkDetail(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 6. Update homework
  app.patch<{ Params: { id: string }; Body: UpdateHomeworkBody }>(
    '/teacher/assignments/:id',
    {
      config: { permission: 'homework.manage' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        body: UpdateHomeworkBodySchema,
        response: {
          200: Type.Object({ success: Type.Boolean() }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.updateHomework(tx, ctx, req.params.id, req.body),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // 7. Publish homework
  app.post<{ Params: { id: string } }>(
    '/teacher/assignments/:id/publish',
    {
      config: { permission: 'homework.manage' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({ success: Type.Boolean() }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.publishHomework(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // 8. Close homework
  app.post<{ Params: { id: string } }>(
    '/teacher/assignments/:id/close',
    {
      config: { permission: 'homework.manage' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({ success: Type.Boolean() }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.closeHomework(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // 9. List student submissions for homework
  app.get<{ Params: { id: string } }>(
    '/teacher/assignments/:id/submissions',
    {
      config: { permission: 'homework.review' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(SubmissionListItemDtoSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.listSubmissions(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 10. Review student submission
  app.post<{ Params: { submissionId: string }; Body: ReviewSubmissionBody }>(
    '/teacher/submissions/:submissionId/review',
    {
      config: { permission: 'homework.review' },
      schema: {
        params: Type.Object({ submissionId: Type.String() }),
        body: ReviewSubmissionBodySchema,
        response: {
          200: Type.Object({ success: Type.Boolean() }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.reviewSubmission(tx, ctx, req.params.submissionId, req.body),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // 11. List student's own homework assignments
  app.get(
    '/student/assignments',
    {
      config: { permission: 'homework.read' },
      schema: {
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(StudentHomeworkItemDtoSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.listStudentHomework(tx, ctx),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 12. Student submits homework (online)
  app.post<{ Params: { id: string }; Body: { submissionText?: string; files?: any[] } }>(
    '/student/assignments/:id/submit',
    {
      config: { permission: 'homework.submit' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        body: Type.Object({
          submissionText: Type.Optional(Type.String()),
          files: Type.Optional(
            Type.Array(
              Type.Object({
                fileId: Type.String(),
                fileName: Type.String({ minLength: 1, maxLength: 255 }),
                fileSizeBytes: Type.Number({ minimum: 0 }),
                mimeType: Type.String(),
              }),
            ),
          ),
        }),
        response: {
          200: Type.Object({ success: Type.Boolean() }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.submitHomework(tx, ctx, req.params.id, req.body),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // 13. Parent views linked child's homework assignments
  app.get<{ Params: { id: string } }>(
    '/parent/children/:id/assignments',
    {
      config: { permission: 'parent.academics.read' },
      schema: {
        params: Type.Object({ id: Type.String() }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(StudentHomeworkItemDtoSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.listParentStudentHomework(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 14. Upload homework attachment file
  app.post<{ Body: UploadAttachmentBody }>(
    '/attachments/upload',
    {
      config: { permission: ['homework.manage', 'homework.submit'] },
      schema: {
        body: UploadAttachmentBodySchema,
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: UploadAttachmentResponseSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.uploadAttachment(tx, ctx, req.body),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 15. List available documents for attaching by reference
  app.get(
    '/attachments/available-documents',
    {
      config: { permission: 'homework.manage' },
      schema: {
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: Type.Array(AvailableDocumentItemSchema),
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.listAvailableDocuments(tx, ctx),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 16. Get attachment download metadata and URL
  app.get<{ Params: { fileId: string } }>(
    '/attachments/:fileId/download-url',
    {
      config: { permission: ['homework.read', 'homework.manage', 'parent.academics.read'] },
      schema: {
        params: Type.Object({ fileId: Type.String() }),
        response: {
          200: Type.Object({
            success: Type.Boolean(),
            data: AttachmentDownloadResponseSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const data = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.getAttachmentDownload(tx, ctx, req.params.fileId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 17. Stream or download attachment file content
  app.get<{ Params: { fileId: string } }>(
    '/attachments/:fileId/content',
    {
      config: { permission: ['homework.read', 'homework.manage', 'parent.academics.read'] },
      schema: {
        params: Type.Object({ fileId: Type.String() }),
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
      const dl = await opts.db.withTenant(ctx, (tx) =>
        HomeworkService.getAttachmentDownload(tx, ctx, req.params.fileId),
      );
      reply.header('Content-Type', dl.mimeType || 'application/octet-stream');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(dl.fileName)}"`,
      );
      const content = `Homework Resource: ${dl.fileName}\nSize: ${dl.fileSizeBytes} bytes\nMIME: ${dl.mimeType}\nCampus OS Verified Document`;
      return reply.send(Buffer.from(content, 'utf-8'));
    },
  );
};
