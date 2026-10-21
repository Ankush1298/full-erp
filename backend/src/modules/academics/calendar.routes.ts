import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../../shared/database/index.js';
import { IdParamSchema, type IdParam, CreateResponseSchema } from './academic.schemas.js';
import {
  AcademicYearService,
  CohortPeriodService,
  SectionService,
  TermService,
} from './calendar.service.js';
import { CourseService, CurriculumService } from './curriculum.service.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  AcademicYearRecordSchema,
  CohortPeriodRecordSchema,
  CourseRecordSchema,
  CreateAcademicYearBodySchema,
  CreateCohortPeriodBodySchema,
  CreateCourseBodySchema,
  CreateCurriculumCourseBodySchema,
  CreateSectionBodySchema,
  CreateTermBodySchema,
  CurriculumCourseRecordSchema,
  DataResponse,
  ListAcademicYearsQuerySchema,
  ListCohortPeriodsQuerySchema,
  ListCoursesQuerySchema,
  ListCurriculumQuerySchema,
  ListResponse,
  ListSectionsQuerySchema,
  ListTermsQuerySchema,
  OkResponseSchema,
  SectionRecordSchema,
  TermRecordSchema,
  UpdateAcademicYearBodySchema,
  UpdateCohortPeriodBodySchema,
  UpdateCourseBodySchema,
  UpdateCurriculumCourseBodySchema,
  UpdateSectionBodySchema,
  UpdateTermBodySchema,
  type CreateAcademicYearBody,
  type CreateCohortPeriodBody,
  type CreateCourseBody,
  type CreateCurriculumCourseBody,
  type CreateSectionBody,
  type CreateTermBody,
  type ListAcademicYearsQuery,
  type ListCohortPeriodsQuery,
  type ListCoursesQuery,
  type ListCurriculumQuery,
  type ListSectionsQuery,
  type ListTermsQuery,
  type UpdateAcademicYearBody,
  type UpdateCohortPeriodBody,
  type UpdateCourseBody,
  type UpdateCurriculumCourseBody,
  type UpdateSectionBody,
  type UpdateTermBody,
} from './calendar.schemas.js';

const RosterSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(
      Type.Object(
        {
          termEnrollmentId: Type.String(),
          studentId: Type.String(),
          validFrom: Type.String(),
          rollNumber: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * Milestone 3 Batch 1 routes, mounted under /api/v1/academics by registerAcademicsRoutes. Every route has exactly one
 * catalogued permission (checked at boot). Reads use `academic.program.read`; writes use the dedicated manage permissions.
 * Every PATCH/DELETE requires If-Match (428 missing, 400 malformed or weak, 409 stale) and answers with the new ETag.
 */
export function registerCalendarRoutes(app: FastifyInstance, db: Database): void {
  const READ = { permission: 'academic.program.read' } as const;

  // ---- academic years -------------------------------------------------------------------------
  app.get<{ Querystring: ListAcademicYearsQuery }>(
    '/academic-years',
    {
      config: READ,
      schema: {
        querystring: ListAcademicYearsQuerySchema,
        response: { 200: ListResponse(AcademicYearRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => AcademicYearService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateAcademicYearBody }>(
    '/academic-years',
    {
      config: { permission: 'academic.term.manage' },
      schema: { body: CreateAcademicYearBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        AcademicYearService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.get<{ Params: IdParam }>(
    '/academic-years/:id',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: DataResponse(AcademicYearRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) =>
        AcademicYearService.getById(tx, ctx, req.params.id),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateAcademicYearBody }>(
    '/academic-years/:id',
    {
      config: { permission: 'academic.term.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateAcademicYearBodySchema,
        response: { 200: DataResponse(AcademicYearRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        AcademicYearService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- terms ----------------------------------------------------------------------------------
  app.get<{ Querystring: ListTermsQuery }>(
    '/terms',
    {
      config: READ,
      schema: {
        querystring: ListTermsQuerySchema,
        response: { 200: ListResponse(TermRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => TermService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateTermBody }>(
    '/terms',
    {
      config: { permission: 'academic.term.manage' },
      schema: { body: CreateTermBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) => TermService.create(tx, ctx, req.body, meta));
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.get<{ Params: IdParam }>(
    '/terms/:id',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: DataResponse(TermRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => TermService.getById(tx, ctx, req.params.id));
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateTermBody }>(
    '/terms/:id',
    {
      config: { permission: 'academic.term.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateTermBodySchema,
        response: { 200: DataResponse(TermRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        TermService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- cohort periods -------------------------------------------------------------------------
  app.get<{ Querystring: ListCohortPeriodsQuery }>(
    '/cohort-periods',
    {
      config: READ,
      schema: {
        querystring: ListCohortPeriodsQuerySchema,
        response: { 200: ListResponse(CohortPeriodRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => CohortPeriodService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateCohortPeriodBody }>(
    '/cohort-periods',
    {
      config: { permission: 'academic.cohort.manage' },
      schema: { body: CreateCohortPeriodBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        CohortPeriodService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateCohortPeriodBody }>(
    '/cohort-periods/:id',
    {
      config: { permission: 'academic.cohort.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateCohortPeriodBodySchema,
        response: { 200: DataResponse(CohortPeriodRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        CohortPeriodService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- sections -------------------------------------------------------------------------------
  app.get<{ Querystring: ListSectionsQuery }>(
    '/sections',
    {
      config: READ,
      schema: {
        querystring: ListSectionsQuerySchema,
        response: { 200: ListResponse(SectionRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SectionService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateSectionBody }>(
    '/sections',
    {
      config: { permission: 'academic.section.manage' },
      schema: { body: CreateSectionBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) => SectionService.create(tx, ctx, req.body, meta));
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.get<{ Params: IdParam }>(
    '/sections/:id',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: DataResponse(SectionRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SectionService.getById(tx, ctx, req.params.id));
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateSectionBody }>(
    '/sections/:id',
    {
      config: { permission: 'academic.section.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateSectionBodySchema,
        response: { 200: DataResponse(SectionRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        SectionService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.get<{ Params: IdParam }>(
    '/sections/:id/members',
    {
      config: { permission: 'enrollment.term.read' },
      schema: { params: IdParamSchema, response: { 200: RosterSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SectionService.roster(tx, ctx, req.params.id));
      return reply.status(200).send({ success: true, data });
    },
  );

  // ---- courses --------------------------------------------------------------------------------
  app.get<{ Querystring: ListCoursesQuery }>(
    '/courses',
    {
      config: READ,
      schema: {
        querystring: ListCoursesQuerySchema,
        response: { 200: ListResponse(CourseRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => CourseService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateCourseBody }>(
    '/courses',
    {
      config: { permission: 'academic.course.manage' },
      schema: { body: CreateCourseBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) => CourseService.create(tx, ctx, req.body, meta));
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.get<{ Params: IdParam }>(
    '/courses/:id',
    {
      config: READ,
      schema: { params: IdParamSchema, response: { 200: DataResponse(CourseRecordSchema) } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => CourseService.getById(tx, ctx, req.params.id));
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateCourseBody }>(
    '/courses/:id',
    {
      config: { permission: 'academic.course.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateCourseBodySchema,
        response: { 200: DataResponse(CourseRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        CourseService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.delete<{ Params: IdParam }>(
    '/courses/:id',
    {
      config: { permission: 'academic.course.manage' },
      schema: { params: IdParamSchema, response: { 200: OkResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      await db.withTenant(ctx, (tx) =>
        CourseService.remove(tx, ctx, req.params.id, { expected, meta }),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // ---- curriculum -----------------------------------------------------------------------------
  app.get<{ Querystring: ListCurriculumQuery }>(
    '/curriculum-courses',
    {
      config: READ,
      schema: {
        querystring: ListCurriculumQuerySchema,
        response: { 200: ListResponse(CurriculumCourseRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => CurriculumService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Body: CreateCurriculumCourseBody }>(
    '/curriculum-courses',
    {
      config: { permission: 'academic.course.manage' },
      schema: { body: CreateCurriculumCourseBodySchema, response: { 201: CreateResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const meta = extractAuditMeta(req);
      const id = await db.withTenant(ctx, (tx) =>
        CurriculumService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );
  app.patch<{ Params: IdParam; Body: UpdateCurriculumCourseBody }>(
    '/curriculum-courses/:id',
    {
      config: { permission: 'academic.course.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateCurriculumCourseBodySchema,
        response: { 200: DataResponse(CurriculumCourseRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        CurriculumService.update(tx, ctx, req.params.id, req.body, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
  app.delete<{ Params: IdParam }>(
    '/curriculum-courses/:id',
    {
      config: { permission: 'academic.course.manage' },
      schema: { params: IdParamSchema, response: { 200: OkResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      await db.withTenant(ctx, (tx) =>
        CurriculumService.remove(tx, ctx, req.params.id, { expected, meta }),
      );
      return reply.status(200).send({ success: true });
    },
  );
}
