import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { requireContext } from '../academics/common.js';
import {
  EnrolmentRosterQuerySchema,
  AttendanceSummaryQuerySchema,
  ExamMarksSummaryQuerySchema,
  FeeSummaryQuerySchema,
} from './reporting.schemas.js';
import { ReportingService } from './reporting.service.js';

export const registerReportingRoutes: FastifyPluginAsync<{
  db: Database;
}> = async (app, opts) => {
  await Promise.resolve();
  const db = opts.db;

  // 1. Student Enrolment Roster
  app.get(
    '/api/v1/reports/enrolment-roster',
    { config: { permission: 'student.directory.list' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = EnrolmentRosterQuerySchema.parse(req.query);
      const result = await db.withTenant(ctx, (tx) =>
        ReportingService.getEnrolmentRoster(tx, ctx, query),
      );

      if (query.format === 'csv' && result.csv) {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="enrolment-roster.csv"')
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(result.csv);
      }

      return reply.send({ success: true, data: result });
    },
  );

  // 2. Daily Attendance Summary
  app.get(
    '/api/v1/reports/attendance-summary',
    { config: { permission: 'attendance.record.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = AttendanceSummaryQuerySchema.parse(req.query);
      const result = await db.withTenant(ctx, (tx) =>
        ReportingService.getAttendanceSummary(tx, ctx, query),
      );

      if (query.format === 'csv' && result.csv) {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="attendance-summary-${result.date}.csv"`)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(result.csv);
      }

      return reply.send({ success: true, data: result });
    },
  );

  // 3. Examination Marks Summary (Strict publication barrier)
  app.get(
    '/api/v1/reports/exam-performance',
    { config: { permission: 'result.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ExamMarksSummaryQuerySchema.parse(req.query);
      const result = await db.withTenant(ctx, (tx) =>
        ReportingService.getExamMarksSummary(tx, ctx, query),
      );

      if (query.format === 'csv' && result.csv) {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="exam-performance-summary.csv"')
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(result.csv);
      }

      return reply.send({ success: true, data: result });
    },
  );

  // 4. Fee Collections & Outstanding Dues Summary
  app.get(
    '/api/v1/reports/fee-summary',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = FeeSummaryQuerySchema.parse(req.query);
      const result = await db.withTenant(ctx, (tx) =>
        ReportingService.getFeeSummary(tx, ctx, query),
      );

      if (query.format === 'csv' && result.csv) {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="fee-summary-${query.view}.csv"`)
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(result.csv);
      }

      return reply.send({ success: true, data: result });
    },
  );
};

