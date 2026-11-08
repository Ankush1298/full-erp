import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { extractAuditMeta, requireContext } from '../academics/common.js';
import { ExamService } from './exam.service.js';
import { EligibilityService } from './eligibility.service.js';
import {
  CreateExaminationSchema,
  CreateScheduleSchema,
  ListExaminationsQuerySchema,
  ListSchedulesQuerySchema,
  SaveMarksSchema,
} from './exam.schemas.js';
import {
  ApproveCandidateListInputSchema,
  GenerateCandidatesInputSchema,
  OverrideCandidateInputSchema,
  SaveEligibilityPolicyInputSchema,
} from './eligibility.schemas.js';
import { registerExamResolvers } from './assigned-resolver.js';

export const registerExamRoutes: FastifyPluginAsync<{
  db: Database;
}> = async (app, opts) => {
  await Promise.resolve();
  const db = opts.db;
  registerExamResolvers();

  // Create examination
  app.post(
    '/api/v1/examinations',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = CreateExaminationSchema.parse(req.body);
      const meta = extractAuditMeta(req);
      const created = await db.withTenant(ctx, (tx) =>
        ExamService.createExamination(tx, ctx, body, meta),
      );
      reply.status(201).send({ data: created });
    },
  );

  // List examinations
  app.get(
    '/api/v1/examinations',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListExaminationsQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) => ExamService.listExaminations(tx, ctx, query));
      reply.send({ data: items });
    },
  );

  // Get examination by ID
  app.get<{ Params: { id: string } }>(
    '/api/v1/examinations/:id',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const item = await db.withTenant(ctx, (tx) =>
        ExamService.getExamination(tx, ctx, req.params.id),
      );
      reply.send({ data: item });
    },
  );

  // Create schedule paper for an examination
  app.post<{ Params: { id: string } }>(
    '/api/v1/examinations/:id/schedules',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = CreateScheduleSchema.parse(req.body);
      const meta = extractAuditMeta(req);
      const created = await db.withTenant(ctx, (tx) =>
        ExamService.createSchedule(tx, ctx, req.params.id, body, meta),
      );
      reply.status(201).send({ data: created });
    },
  );

  // List schedules for an examination
  app.get<{ Params: { id: string } }>(
    '/api/v1/examinations/:id/schedules',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListSchedulesQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) =>
        ExamService.listSchedules(tx, ctx, {
          ...query,
          examination_id: req.params.id,
        }),
      );
      reply.send({ data: items });
    },
  );

  // Get schedule details
  app.get<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const item = await db.withTenant(ctx, (tx) =>
        ExamService.getSchedule(tx, ctx, req.params.scheduleId),
      );
      reply.send({ data: item });
    },
  );

  // Get roster with existing marks for a schedule
  app.get<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/roster',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        ExamService.getScheduleRoster(tx, ctx, req.params.scheduleId),
      );
      reply.send({ data });
    },
  );

  // Save draft marks or submit marks for a schedule
  app.post<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/marks',
    { config: { permission: 'exam.marks.enter' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = SaveMarksSchema.parse(req.body);
      const meta = extractAuditMeta(req);
      const res = await db.withTenant(ctx, (tx) =>
        ExamService.saveMarks(tx, ctx, req.params.scheduleId, body, meta),
      );
      reply.send({ data: res });
    },
  );

  // Publish results for a schedule (Admin maker-checker)
  app.post<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/publish',
    { config: { permission: 'result.publish' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const res = await db.withTenant(ctx, (tx) =>
        ExamService.publishResults(tx, ctx, req.params.scheduleId, meta),
      );
      reply.send({ data: res });
    },
  );

  // Class register with summary statistics
  app.get<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/register',
    { config: { permission: 'result.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        ExamService.getClassRegister(tx, ctx, req.params.scheduleId),
      );
      reply.send({ data });
    },
  );

  // Individual student result view (Student SELF or Staff)
  app.get<{ Params: { id: string }; Querystring: { term_id?: string } }>(
    '/api/v1/examinations/students/:id/results',
    { config: { permission: 'result.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const results = await db.withTenant(ctx, (tx) =>
        ExamService.getStudentResults(tx, ctx, req.params.id, req.query.term_id),
      );
      reply.send({ data: results });
    },
  );

  // ---------------------------------------------------------------------------------------------
  // Slice 2: Examination Eligibility & Candidate Lists
  // ---------------------------------------------------------------------------------------------

  // Get eligibility policy for a schedule
  app.get<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/eligibility-policy',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const policy = await db.withTenant(ctx, (tx) =>
        EligibilityService.getOrResolvePolicy(tx, ctx, req.params.scheduleId),
      );
      reply.send({ data: policy });
    },
  );

  // Set eligibility policy for a schedule
  app.put<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/eligibility-policy',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = SaveEligibilityPolicyInputSchema.parse(req.body);
      const meta = extractAuditMeta(req);
      const policy = await db.withTenant(ctx, (tx) =>
        EligibilityService.savePolicy(tx, ctx, { scheduleId: req.params.scheduleId }, body, meta),
      );
      reply.send({ data: policy });
    },
  );

  // Generate or recalculate candidate list for a schedule
  app.post<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/candidates/generate',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = GenerateCandidatesInputSchema.parse(req.body ?? {});
      const meta = extractAuditMeta(req);
      const result = await db.withTenant(ctx, (tx) =>
        EligibilityService.generateCandidateList(tx, ctx, req.params.scheduleId, body, meta),
      );
      reply.status(201).send({ data: result });
    },
  );

  // Get candidate list and candidate items for a schedule
  app.get<{ Params: { scheduleId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/candidates',
    { config: { permission: ['exam.manage', 'exam.marks.enter', 'result.read'] } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const result = await db.withTenant(ctx, (tx) =>
        EligibilityService.getCandidateList(tx, ctx, req.params.scheduleId),
      );
      reply.send({ data: result });
    },
  );

  // Administrative override or exemption for a candidate
  app.patch<{ Params: { scheduleId: string; candidateId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/candidates/:candidateId/override',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = OverrideCandidateInputSchema.parse(req.body);
      const meta = extractAuditMeta(req);
      const updated = await db.withTenant(ctx, (tx) =>
        EligibilityService.overrideCandidate(
          tx,
          ctx,
          req.params.scheduleId,
          req.params.candidateId,
          body,
          meta,
        ),
      );
      reply.send({ data: updated });
    },
  );

  // Approve or Freeze candidate list
  app.post<{ Params: { scheduleId: string; listId: string } }>(
    '/api/v1/examinations/schedules/:scheduleId/candidates/:listId/approve',
    { config: { permission: 'exam.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = ApproveCandidateListInputSchema.parse(req.body ?? {});
      const meta = extractAuditMeta(req);
      const approved = await db.withTenant(ctx, (tx) =>
        EligibilityService.approveCandidateList(
          tx,
          ctx,
          req.params.scheduleId,
          req.params.listId,
          body,
          meta,
        ),
      );
      reply.send({ data: approved });
    },
  );
};
