import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { CreateResponseSchema, type IdParam } from '../academics/academic.schemas.js';
import { DataResponse, ListResponse } from '../academics/calendar.schemas.js';
import { extractAuditMeta, requireContext } from '../academics/common.js';
import { AttendanceService } from './attendance.service.js';
import {
  CancelSessionBodySchema,
  CorrectionRequestDtoSchema,
  DecideRequestBodySchema,
  ListCorrectionRequestsQuerySchema,
  ListSessionsQuerySchema,
  LockSessionBodySchema,
  CampusClockDtoSchema,
  MyOfferingItemDtoSchema,
  MyOfferingQuerySchema,
  MyRecordsQuerySchema,
  MyRecordsResponseSchema,
  MySummaryDtoSchema,
  CorrectRecordBodySchema,
  CreateSessionBodySchema,
  IdParamSchema,
  RecordDtoSchema,
  RevisionDtoSchema,
  SessionDtoSchema,
  SessionRosterItemSchema,
  SubmitAttendanceBodySchema,
  SubmitResponseSchema,
  type CancelSessionBody,
  type DecideRequestBody,
  type ListCorrectionRequestsQuery,
  type ListSessionsQuery,
  type LockSessionBody,
  type CorrectRecordBody,
  type CreateSessionBody,
  type MyOfferingQuery,
  type MyRecordsQuery,
  type SubmitAttendanceBody,
} from './attendance.schemas.js';
import { registerAttendanceResolvers } from './assigned-resolver.js';

/**
 * /api/v1/attendance (doc 41). Writes need an Idempotency-Key (428 missing, 400 malformed, 422 reused with another body).
 * Mark and faculty cancel: attendance.session.mark (FACULTY ASSIGNED); administrative cancel: attendance.session.cancel. Corrections and correction requests: attendance.record.correct; decisions: attendance.correction.approve; lock: attendance.session.lock (CRITICAL). Reads: attendance.record.read (staff by scope; a STUDENT only their own rows under /me).
 */
export const registerAttendanceRoutes: FastifyPluginAsync<{
  db: Database;
  correctionsEnabled?: boolean;
}> = async (app, opts) => {
  await Promise.resolve();
  const db = opts.db;
  registerAttendanceResolvers();
  // Fail-closed switch (doc 41 §9, §12): applies to every route that can change a submitted value or decide a change.
  const contained = (): void => {
    if (!opts.correctionsEnabled) {
      throw new AppError(
        403,
        'ATTENDANCE_CORRECTIONS_DISABLED',
        'Attendance corrections are not enabled.',
      );
    }
  };

  app.post<{ Body: CreateSessionBody }>(
    '/sessions',
    {
      config: { permission: 'attendance.session.mark' },
      schema: { body: CreateSessionBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.createSession(tx, ctx, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: IdParam; Body: SubmitAttendanceBody }>(
    '/sessions/:id/attendance',
    {
      config: { permission: 'attendance.session.mark' },
      schema: {
        params: IdParamSchema,
        body: SubmitAttendanceBodySchema,
        response: { 201: SubmitResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.submitAttendance(tx, ctx, req.params.id, req.body, {
          idempotencyKey,
          meta,
        }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: IdParam; Body: CancelSessionBody }>(
    '/sessions/:id/cancel',
    {
      // Faculty path (attendance.session.mark) or the separate administrative permission (attendance.session.cancel); the
      // service decides which applies (doc 41 §12).
      config: { permission: ['attendance.session.mark', 'attendance.session.cancel'] },
      schema: {
        params: IdParamSchema,
        body: CancelSessionBodySchema,
        response: { 200: DataResponse(SessionDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.cancelSession(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: IdParam; Body: CorrectRecordBody }>(
    '/records/:id/corrections',
    {
      config: { permission: 'attendance.record.correct' },
      schema: {
        params: IdParamSchema,
        body: CorrectRecordBodySchema,
        response: { 200: DataResponse(RecordDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      contained(); // doc 41 §9: closed for everyone, before any lookup, unless the deployment enables corrections
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.correctRecord(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  app.post<{ Params: IdParam; Body: CorrectRecordBody }>(
    '/records/:id/correction-requests',
    {
      config: { permission: 'attendance.record.correct' },
      schema: {
        params: IdParamSchema,
        body: CorrectRecordBodySchema,
        response: { 201: DataResponse(CorrectionRequestDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      contained();
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.requestCorrection(tx, ctx, req.params.id, req.body, {
          idempotencyKey,
          meta,
        }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  for (const decision of ['approve', 'reject'] as const) {
    app.post<{ Params: IdParam; Body: DecideRequestBody }>(
      `/correction-requests/:id/${decision}`,
      {
        config: { permission: 'attendance.correction.approve' },
        schema: {
          params: IdParamSchema,
          body: DecideRequestBodySchema,
          response: { 200: DataResponse(CorrectionRequestDtoSchema) },
        },
      },
      async (req, reply) => {
        const ctx = requireContext(req);
        contained();
        const meta = extractAuditMeta(req);
        const idempotencyKey = req.headers['idempotency-key'];
        const result = await db.withTenant(ctx, (tx) =>
          AttendanceService.decideRequest(
            tx,
            ctx,
            req.params.id,
            decision === 'approve' ? 'APPROVE' : 'REJECT',
            req.body,
            { idempotencyKey, meta },
          ),
        );
        if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
        return reply.status(result.status).send(result.body);
      },
    );
  }

  app.get<{ Querystring: ListCorrectionRequestsQuery }>(
    '/correction-requests',
    {
      config: { permission: 'attendance.correction.approve' },
      schema: {
        querystring: ListCorrectionRequestsQuerySchema,
        response: { 200: ListResponse(CorrectionRequestDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      contained();
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.listCorrectionRequests(tx, ctx, req.query),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: IdParam; Body: LockSessionBody }>(
    '/sessions/:id/lock',
    {
      config: { permission: 'attendance.session.lock' },
      schema: {
        params: IdParamSchema,
        body: LockSessionBodySchema,
        response: { 200: DataResponse(SessionDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.lockSession(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  // Student-self read (Slice 3): the signed-in student's own attendance. Registered before the `:id` routes; the paths do
  // not overlap. Authorization is attendance.record.read in SELF mode, checked in the service.
  app.get<{ Querystring: MyRecordsQuery }>(
    '/me/records',
    {
      config: { permission: 'attendance.record.read' },
      schema: { querystring: MyRecordsQuerySchema, response: { 200: MyRecordsResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const result = await db.withTenant(ctx, (tx) =>
        AttendanceService.listMyRecords(tx, ctx, req.query),
      );
      return reply.status(200).send({ success: true, ...result });
    },
  );

  app.get<{ Querystring: MyOfferingQuery }>(
    '/me/summary',
    {
      config: { permission: 'attendance.record.read' },
      schema: {
        querystring: MyOfferingQuerySchema,
        response: { 200: DataResponse(MySummaryDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.mySummary(tx, ctx, req.query),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get(
    '/campuses',
    {
      config: { permission: 'attendance.record.read' },
      schema: { response: { 200: ListResponse(CampusClockDtoSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.listReadableCampuses(tx, ctx),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get(
    '/my-offerings',
    {
      config: { permission: 'attendance.session.mark' },
      schema: { response: { 200: ListResponse(MyOfferingItemDtoSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => AttendanceService.listMyOfferings(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Querystring: ListSessionsQuery }>(
    '/sessions',
    {
      config: { permission: 'attendance.record.read' },
      schema: {
        querystring: ListSessionsQuerySchema,
        response: { 200: ListResponse(SessionDtoSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.listSessions(tx, ctx, req.query),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: IdParam }>(
    '/sessions/:id/roster',
    {
      config: { permission: 'attendance.record.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(SessionRosterItemSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.getSessionRoster(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: IdParam }>(
    '/sessions/:id',
    {
      config: { permission: 'attendance.record.read' },
      schema: { params: IdParamSchema, response: { 200: DataResponse(SessionDtoSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.getSession(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: IdParam }>(
    '/sessions/:id/records',
    {
      config: { permission: 'attendance.record.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(RecordDtoSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.listRecords(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: IdParam }>(
    '/records/:id/revisions',
    {
      config: { permission: 'attendance.record.read' },
      schema: { params: IdParamSchema, response: { 200: ListResponse(RevisionDtoSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AttendanceService.listRevisions(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
};
