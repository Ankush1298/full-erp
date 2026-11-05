import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { IdParamSchema, type IdParam } from './academic.schemas.js';
import { CreateResponseSchema } from './academic.schemas.js';
import { ListResponse } from './calendar.schemas.js';
import { extractAuditMeta, requireContext } from './common.js';
import { FacultyAssignmentService } from './offering.service.js';
import {
  EmployeeAssignmentRecordSchema,
  EmployeeAssignmentsQuerySchema,
  FacultyAssignBodySchema,
  type EmployeeAssignmentsQuery,
  type FacultyAssignBody,
} from './offering.schemas.js';

/**
 * `/api/v1/faculty/employees/:id/assignments` (canonical `04` Part 16: `/faculty` "assignment view", "assign offerings",
 * "workload view"; M3 APIs "`/faculty` (assignments)"). Both routes delegate to FacultyAssignmentService, the service
 * behind `/academics/course-offerings/:id/faculty-assignments`, which stays unchanged: one assignment model, one set of
 * rules (posting, ACTIVE employee, one PRIMARY, conflicts), one audit action. Ending stays PATCH
 * /academics/faculty-assignments/:id.
 */
export const registerFacultyAssignmentRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  const db = opts.db;
  app.get<{ Params: IdParam; Querystring: EmployeeAssignmentsQuery }>(
    '/employees/:id/assignments',
    {
      config: { permission: 'employee.profile.read' },
      schema: {
        params: IdParamSchema,
        querystring: EmployeeAssignmentsQuerySchema,
        response: { 200: ListResponse(EmployeeAssignmentRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        FacultyAssignmentService.listForEmployee(tx, ctx, req.params.id, req.query),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: FacultyAssignBody }>(
    '/employees/:id/assignments',
    {
      config: { permission: 'academic.faculty.assign' },
      schema: {
        params: IdParamSchema,
        body: FacultyAssignBodySchema,
        response: { 201: CreateResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const { courseOfferingId, ...rest } = req.body;
      const id = await db.withTenant(ctx, (tx) =>
        FacultyAssignmentService.create(
          tx,
          ctx,
          courseOfferingId,
          { ...rest, employeeId: req.params.id },
          meta,
        ),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
};
