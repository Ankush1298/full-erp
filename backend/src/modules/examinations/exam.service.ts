import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { conflict, ensureTrusted, invalid, mapDbError } from '../academics/common.js';
import type {
  CreateExaminationInput,
  CreateScheduleInput,
  ListExaminationsQuery,
  ListSchedulesQuery,
  SaveMarksInput,
} from './exam.schemas.js';

const lower = (s: string): string => s.toLowerCase();

export interface ExaminationRow {
  id: string;
  organization_id: string;
  campus_id: string;
  term_id: string;
  name: string;
  exam_type: string;
  status: string;
  starts_on: string;
  ends_on: string;
  description: string | null;
  campus_name?: string;
  term_name?: string;
}

export interface ExamScheduleRow {
  id: string;
  organization_id: string;
  examination_id: string;
  course_offering_id: string;
  exam_date: string;
  start_time: string | null;
  end_time: string | null;
  max_marks: number | string;
  pass_marks: number | string;
  status: string;
  campus_id: string;
  term_id: string;
  marks_submitted_at?: string | null;
  marks_submitted_by_user_id?: string | null;
  published_at?: string | null;
  published_by_user_id?: string | null;
  exam_name?: string;
  exam_type?: string;
  course_code?: string;
  course_title?: string;
  section_name?: string | null;
}

export class ExamService {
  /** Create an examination (Admin / Coordinator with exam.manage) */
  static async createExamination(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateExaminationInput,
    meta?: AuditRequestMeta,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    // Verify campus belongs to organization
    const campusRes = await tx.query(
      `SELECT id FROM app.campuses WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(input.campus_id)],
    );
    if (!campusRes.rows[0]) {
      throw invalid('Invalid campus ID or campus not found.');
    }

    // Verify term belongs to organization
    const termRes = await tx.query(
      `SELECT id FROM app.terms WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(input.term_id)],
    );
    if (!termRes.rows[0]) {
      throw invalid('Invalid term ID or term not found.');
    }

    const id = uuidv7();
    const sql = `
      INSERT INTO app.examinations (
        id, organization_id, campus_id, term_id, name, exam_type, status, starts_on, ends_on, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'SCHEDULED', $7, $8, $9)
      RETURNING *
    `;

    try {
      const res = await tx.query(sql, [
        id,
        ctx.tenantId,
        lower(input.campus_id),
        lower(input.term_id),
        input.name,
        input.exam_type,
        input.starts_on,
        input.ends_on,
        ctx.userId,
      ]);

      await recordAudit(
        tx,
        ctx,
        {
          action: 'exam.examination.create',
          resourceType: 'examination',
          resourceId: id,
          campusId: input.campus_id,
          riskTier: 1,
          changes: {
            name: { old: null, new: input.name },
            exam_type: { old: null, new: input.exam_type },
          },
        },
        meta ?? {},
      );

      return res.rows[0];
    } catch (err) {
      return mapDbError(err, 'Failed to create examination.');
    }
  }

  /** List examinations */
  static async listExaminations(tx: TenantTx, ctx: TrustedContext, query: ListExaminationsQuery) {
    ensureTrusted(ctx);

    const conditions: string[] = ['e.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(lower(query.campus_id));
      conditions.push(`e.campus_id = $${params.length}`);
    }
    if (query.term_id) {
      params.push(lower(query.term_id));
      conditions.push(`e.term_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`e.status = $${params.length}`);
    }

    const sql = `
      SELECT e.*, c.name AS campus_name, t.name AS term_name
        FROM app.examinations e
        JOIN app.campuses c ON c.organization_id = e.organization_id AND c.id = e.campus_id
        JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.starts_on DESC, e.created_at DESC
    `;

    const res = await tx.query(sql, params);
    return res.rows;
  }

  /** Get an examination by ID */
  static async getExamination(
    tx: TenantTx,
    ctx: TrustedContext,
    examinationId: string,
  ): Promise<ExaminationRow> {
    ensureTrusted(ctx);
    if (!isUuidV7(examinationId)) throw invalid('Invalid examination ID.');

    const sql = `
      SELECT e.*, c.name AS campus_name, t.name AS term_name
        FROM app.examinations e
        JOIN app.campuses c ON c.organization_id = e.organization_id AND c.id = e.campus_id
        JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
       WHERE e.organization_id = $1 AND e.id = $2
       LIMIT 1
    `;
    const res = await tx.query<ExaminationRow>(sql, [ctx.tenantId, lower(examinationId)]);
    if (!res.rows[0]) throw resourceNotFound();
    return res.rows[0];
  }

  /** Create an examination schedule paper */
  static async createSchedule(
    tx: TenantTx,
    ctx: TrustedContext,
    examinationId: string,
    input: CreateScheduleInput,
    meta?: AuditRequestMeta,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const exam = await this.getExamination(tx, ctx, examinationId);

    // Verify course offering exists and is within same org, campus and term
    const offRes = await tx.query<{
      id: string;
      term_id: string;
      campus_id: string;
      course_id: string;
    }>(
      `SELECT o.id, o.term_id, t.campus_id, o.course_id
         FROM app.course_offerings o
         JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
        WHERE o.organization_id = $1 AND o.id = $2`,
      [ctx.tenantId, lower(input.course_offering_id)],
    );

    const offering = offRes.rows[0];
    if (!offering) {
      throw invalid('Course offering not found in this organization.');
    }

    if (offering.term_id !== exam.term_id) {
      throw invalid('Course offering term does not match examination term.');
    }
    if (offering.campus_id !== exam.campus_id) {
      throw invalid('Course offering campus does not match examination campus.');
    }

    const id = uuidv7();
    const sql = `
      INSERT INTO app.exam_schedules (
        id, organization_id, examination_id, course_offering_id,
        exam_date, start_time, end_time, max_marks, pass_marks, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SCHEDULED')
      RETURNING *
    `;

    try {
      const res = await tx.query(sql, [
        id,
        ctx.tenantId,
        lower(examinationId),
        lower(input.course_offering_id),
        input.exam_date,
        input.start_time ?? null,
        input.end_time ?? null,
        input.max_marks,
        input.pass_marks,
      ]);

      await recordAudit(
        tx,
        ctx,
        {
          action: 'exam.schedule.create',
          resourceType: 'exam_schedule',
          resourceId: id,
          campusId: exam.campus_id,
          riskTier: 1,
          changes: {
            examination_id: { old: null, new: examinationId },
            course_offering_id: { old: null, new: input.course_offering_id },
            exam_date: { old: null, new: input.exam_date },
            max_marks: { old: null, new: input.max_marks },
            pass_marks: { old: null, new: input.pass_marks },
          },
        },
        meta ?? {},
      );

      return res.rows[0];
    } catch (err) {
      return mapDbError(
        err,
        'Failed to create exam schedule or schedule already exists for this course offering.',
      );
    }
  }

  /** List schedules for an examination */
  static async listSchedules(tx: TenantTx, ctx: TrustedContext, query: ListSchedulesQuery) {
    ensureTrusted(ctx);

    const conditions: string[] = ['s.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.examination_id) {
      params.push(lower(query.examination_id));
      conditions.push(`s.examination_id = $${params.length}`);
    }
    if (query.course_offering_id) {
      params.push(lower(query.course_offering_id));
      conditions.push(`s.course_offering_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`s.status = $${params.length}`);
    }

    const sql = `
      SELECT s.*,
             e.name AS exam_name,
             e.exam_type,
             c.code AS course_code,
             c.title AS course_title,
             sec.name AS section_name
        FROM app.exam_schedules s
        JOIN app.examinations e ON e.organization_id = s.organization_id AND e.id = s.examination_id
        JOIN app.course_offerings o ON o.organization_id = s.organization_id AND o.id = s.course_offering_id
        JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
        LEFT JOIN app.sections sec ON sec.organization_id = o.organization_id AND sec.id = o.section_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.exam_date ASC, s.start_time ASC, c.code ASC
    `;

    const res = await tx.query(sql, params);
    return res.rows;
  }

  /** Get schedule by ID */
  static async getSchedule(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
  ): Promise<ExamScheduleRow> {
    ensureTrusted(ctx);
    if (!isUuidV7(scheduleId)) throw invalid('Invalid schedule ID.');

    const sql = `
      SELECT s.*,
             e.name AS exam_name,
             e.exam_type,
             e.campus_id,
             e.term_id,
             c.code AS course_code,
             c.title AS course_title,
             sec.name AS section_name
        FROM app.exam_schedules s
        JOIN app.examinations e ON e.organization_id = s.organization_id AND e.id = s.examination_id
        JOIN app.course_offerings o ON o.organization_id = s.organization_id AND o.id = s.course_offering_id
        JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
        LEFT JOIN app.sections sec ON sec.organization_id = o.organization_id AND sec.id = o.section_id
       WHERE s.organization_id = $1 AND s.id = $2
       LIMIT 1
    `;
    const res = await tx.query<ExamScheduleRow>(sql, [ctx.tenantId, lower(scheduleId)]);
    if (!res.rows[0]) throw resourceNotFound();
    return res.rows[0];
  }

  /** Get schedule student roster with existing marks */
  static async getScheduleRoster(tx: TenantTx, ctx: TrustedContext, scheduleId: string) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);

    const schedule = await this.getSchedule(tx, ctx, scheduleId);

    // Permission check: faculty needs ASSIGNED scope on this offering, or staff has granted exam.marks.enter/result.read
    await AuthorizationEngine.assert(tx, ctx, 'exam.marks.enter', {
      organization_id: ctx.tenantId,
      campus_id: schedule.campus_id,
      course_offering_id: schedule.course_offering_id,
      exam_date: schedule.exam_date,
    });

    const sql = `
      SELECT 
        s.id AS student_id,
        s.admission_number,
        u.display_name AS student_name,
        e.roll_number,
        m.id AS mark_id,
        m.marks_obtained,
        COALESCE(m.status, 'DRAFT') AS mark_status,
        m.is_passing,
        m.remarks,
        c.evaluation_status,
        c.override_status,
        c.final_status,
        c.reasons AS eligibility_reasons
      FROM app.course_registrations cr
      JOIN app.students s ON s.organization_id = cr.organization_id AND s.id = cr.student_id
      JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
      LEFT JOIN app.term_enrollments e ON e.organization_id = cr.organization_id AND e.id = cr.term_enrollment_id
      LEFT JOIN app.exam_marks m ON m.organization_id = cr.organization_id 
                                AND m.exam_schedule_id = $2 
                                AND m.student_id = s.id
      LEFT JOIN LATERAL (
        SELECT cand.evaluation_status, cand.override_status, cand.final_status, cand.reasons
          FROM app.exam_candidate_lists cl
          JOIN app.exam_candidates cand ON cand.organization_id = cl.organization_id AND cand.candidate_list_id = cl.id
         WHERE cl.organization_id = cr.organization_id
           AND cl.exam_schedule_id = $2
           AND cand.student_id = s.id
         ORDER BY cl.snapshot_version DESC
         LIMIT 1
      ) c ON true
     WHERE cr.organization_id = $1
       AND cr.course_offering_id = $3
       AND cr.status IN ('REGISTERED', 'COMPLETED')
       AND cr.valid_to IS NULL
     ORDER BY s.admission_number ASC
    `;

    const res = await tx.query(sql, [ctx.tenantId, lower(scheduleId), schedule.course_offering_id]);

    const candidateListRes = await tx.query<{
      id: string;
      status: string;
      snapshot_version: number;
    }>(
      `SELECT id, status, snapshot_version FROM app.exam_candidate_lists
        WHERE organization_id = $1 AND exam_schedule_id = $2
        ORDER BY snapshot_version DESC
        LIMIT 1`,
      [ctx.tenantId, lower(scheduleId)],
    );

    return {
      schedule,
      candidate_list: candidateListRes.rows[0] ?? null,
      students: res.rows,
    };
  }

  /** Save marks (draft or final submit) */
  static async saveMarks(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    input: SaveMarksInput,
    meta?: AuditRequestMeta,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);

    const schedule = await this.getSchedule(tx, ctx, scheduleId);

    if (schedule.status === 'PUBLISHED') {
      throw conflict('Cannot modify marks for a published examination schedule.');
    }
    if (schedule.status === 'CANCELLED') {
      throw conflict('Cannot modify marks for a cancelled examination schedule.');
    }

    // Permission check: teacher assigned or staff with exam.marks.enter
    await AuthorizationEngine.assert(tx, ctx, 'exam.marks.enter', {
      organization_id: ctx.tenantId,
      campus_id: schedule.campus_id,
      course_offering_id: schedule.course_offering_id,
      exam_date: schedule.exam_date,
    });

    // Check candidate eligibility if an approved/frozen candidate list exists
    const approvedListRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.exam_candidate_lists
        WHERE organization_id = $1 AND exam_schedule_id = $2 AND status IN ('APPROVED', 'FROZEN')
        LIMIT 1`,
      [ctx.tenantId, lower(scheduleId)],
    );

    if (approvedListRes.rows[0]) {
      const eligibleCandRes = await tx.query<{ student_id: string }>(
        `SELECT c.student_id
           FROM app.exam_candidates c
          WHERE c.organization_id = $1
            AND c.candidate_list_id = $2
            AND c.final_status = 'ELIGIBLE'`,
        [ctx.tenantId, approvedListRes.rows[0].id],
      );
      const eligibleStudentIds = new Set(eligibleCandRes.rows.map((r) => r.student_id));

      for (const entry of input.entries) {
        if (!eligibleStudentIds.has(lower(entry.student_id))) {
          throw new AppError(
            422,
            'STUDENT_NOT_ELIGIBLE',
            `Student ${entry.student_id} is not an approved eligible candidate for this examination schedule.`,
          );
        }
      }
    }

    const maxMarks = Number(schedule.max_marks);
    const passMarks = Number(schedule.pass_marks);

    // Validate entries
    for (const entry of input.entries) {
      if (entry.status === 'ENTERED') {
        const val = Number(entry.marks_obtained);
        if (Number.isNaN(val) || val < 0 || val > maxMarks) {
          throw invalid(
            `Marks obtained (${val}) cannot exceed maximum marks (${maxMarks}) or be negative.`,
          );
        }
      }
    }

    const markStatus = input.action === 'SUBMIT' ? 'SUBMITTED' : 'DRAFT';
    const scheduleNewStatus = input.action === 'SUBMIT' ? 'SUBMITTED' : 'DRAFT_MARKS';

    // Upsert marks
    for (const entry of input.entries) {
      const studentId = lower(entry.student_id);
      const isAbsentOrExempt =
        entry.status === 'ABSENT' || entry.status === 'EXEMPT' || entry.status === 'WITHHELD';
      const marksVal = isAbsentOrExempt ? null : entry.marks_obtained;
      const isPassing =
        marksVal !== null && marksVal !== undefined ? Number(marksVal) >= passMarks : false;

      const upsertSql = `
        INSERT INTO app.exam_marks (
          id, organization_id, exam_schedule_id, student_id,
          marks_obtained, status, is_passing, remarks,
          marked_by_user_id, marked_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, now()
        )
        ON CONFLICT (organization_id, exam_schedule_id, student_id)
        DO UPDATE SET
          marks_obtained = EXCLUDED.marks_obtained,
          status = EXCLUDED.status,
          is_passing = EXCLUDED.is_passing,
          remarks = EXCLUDED.remarks,
          marked_by_user_id = EXCLUDED.marked_by_user_id,
          marked_at = EXCLUDED.marked_at
      `;

      await tx.query(upsertSql, [
        uuidv7(),
        ctx.tenantId,
        lower(scheduleId),
        studentId,
        marksVal,
        entry.status === 'ENTERED' ? markStatus : entry.status,
        isPassing,
        entry.remarks ?? null,
        ctx.userId,
      ]);
    }

    // Update schedule status
    if (input.action === 'SUBMIT') {
      await tx.query(
        `UPDATE app.exam_schedules
            SET status = 'SUBMITTED', marks_submitted_at = now(), marks_submitted_by_user_id = $1
          WHERE organization_id = $2 AND id = $3`,
        [ctx.userId, ctx.tenantId, lower(scheduleId)],
      );
    } else {
      await tx.query(
        `UPDATE app.exam_schedules
            SET status = 'DRAFT_MARKS'
          WHERE organization_id = $1 AND id = $2 AND status = 'SCHEDULED'`,
        [ctx.tenantId, lower(scheduleId)],
      );
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: input.action === 'SUBMIT' ? 'exam.marks.submit' : 'exam.marks.draft',
        resourceType: 'exam_schedule',
        resourceId: scheduleId,
        campusId: schedule.campus_id,
        riskTier: 1,
        changes: {
          schedule_status: { old: schedule.status, new: scheduleNewStatus },
          entries_count: { old: null, new: input.entries.length },
        },
      },
      meta ?? {},
    );

    return {
      success: true,
      status: scheduleNewStatus,
      entries_updated: input.entries.length,
    };
  }

  /** Publish results (Admin action with result.publish) */
  static async publishResults(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    meta?: AuditRequestMeta,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    // CRITICAL permission - teachers do not have this
    await AuthorizationEngine.assert(tx, ctx, 'result.publish');

    const schedule = await this.getSchedule(tx, ctx, scheduleId);

    if (schedule.status === 'PUBLISHED') {
      throw conflict('Results for this examination schedule are already published.');
    }
    if (schedule.status === 'CANCELLED') {
      throw conflict('Cannot publish results for a cancelled examination schedule.');
    }

    // Check that marks exist
    const countRes = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.exam_marks WHERE organization_id = $1 AND exam_schedule_id = $2`,
      [ctx.tenantId, lower(scheduleId)],
    );
    if (parseInt(countRes.rows[0]?.count ?? '0', 10) === 0) {
      throw conflict('Cannot publish examination results with no entered marks.');
    }

    // Update schedule to PUBLISHED
    await tx.query(
      `UPDATE app.exam_schedules
          SET status = 'PUBLISHED', published_at = now(), published_by_user_id = $1
        WHERE organization_id = $2 AND id = $3`,
      [ctx.userId, ctx.tenantId, lower(scheduleId)],
    );

    // Ensure all draft marks transition to SUBMITTED
    await tx.query(
      `UPDATE app.exam_marks
          SET status = 'SUBMITTED'
        WHERE organization_id = $1 AND exam_schedule_id = $2 AND status = 'DRAFT'`,
      [ctx.tenantId, lower(scheduleId)],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.results.publish',
        resourceType: 'exam_schedule',
        resourceId: scheduleId,
        campusId: schedule.campus_id,
        riskTier: 2, // CRITICAL
        changes: {
          status: { old: schedule.status, new: 'PUBLISHED' },
          published_by: { old: null, new: ctx.userId },
        },
      },
      meta ?? {},
    );

    return {
      success: true,
      status: 'PUBLISHED',
      published_at: new Date().toISOString(),
    };
  }

  /** Class-wise marks register and aggregate statistics */
  static async getClassRegister(tx: TenantTx, ctx: TrustedContext, scheduleId: string) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);

    const schedule = await this.getSchedule(tx, ctx, scheduleId);

    // Permission check: result.read
    await AuthorizationEngine.assert(tx, ctx, 'result.read', {
      organization_id: ctx.tenantId,
      campus_id: schedule.campus_id,
      course_offering_id: schedule.course_offering_id,
      exam_date: schedule.exam_date,
    });

    const marksRes = await tx.query(
      `SELECT 
         m.id,
         m.student_id,
         s.admission_number,
         u.display_name AS student_name,
         te.roll_number,
         m.marks_obtained,
         m.status,
         m.is_passing,
         m.remarks,
         m.marked_at
       FROM app.exam_marks m
       JOIN app.students s ON s.organization_id = m.organization_id AND s.id = m.student_id
       JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
       LEFT JOIN app.course_registrations cr ON cr.organization_id = m.organization_id 
                                            AND cr.student_id = m.student_id 
                                            AND cr.course_offering_id = $2
                                            AND cr.valid_to IS NULL
       LEFT JOIN app.term_enrollments te ON te.organization_id = cr.organization_id AND te.id = cr.term_enrollment_id
      WHERE m.organization_id = $1 AND m.exam_schedule_id = $3
      ORDER BY s.admission_number ASC`,
      [ctx.tenantId, schedule.course_offering_id, lower(scheduleId)],
    );

    const rows = marksRes.rows;
    const totalEnrolled = rows.length;
    let appeared = 0;
    let absent = 0;
    let exempt = 0;
    let withheld = 0;
    let passed = 0;
    let failed = 0;
    let totalMarks = 0;

    for (const r of rows) {
      if (r.status === 'ENTERED' || r.status === 'SUBMITTED') {
        appeared += 1;
        const val = Number(r.marks_obtained);
        if (!Number.isNaN(val)) totalMarks += val;
        if (r.is_passing) passed += 1;
        else failed += 1;
      } else if (r.status === 'ABSENT') {
        absent += 1;
      } else if (r.status === 'EXEMPT') {
        exempt += 1;
      } else if (r.status === 'WITHHELD') {
        withheld += 1;
      }
    }

    const averageMarks = appeared > 0 ? Math.round((totalMarks / appeared) * 100) / 100 : 0;
    const passPercentage = appeared > 0 ? Math.round((passed / appeared) * 10000) / 100 : 0;

    return {
      schedule,
      marks: rows,
      statistics: {
        total_students: totalEnrolled,
        appeared,
        absent,
        exempt,
        withheld,
        passed,
        failed,
        average_marks: averageMarks,
        pass_percentage: passPercentage,
      },
    };
  }

  /** Individual student result view (Students read SELF only; staff read via result.read) */
  static async getStudentResults(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    termId?: string,
  ) {
    ensureTrusted(ctx);
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');

    let isStaff = false;
    try {
      AuthorizationEngine.assertStaffActor(ctx);
      isStaff = true;
    } catch {
      AuthorizationEngine.assertStudentActor(ctx);
    }

    if (!isStaff) {
      const studentMatch = await tx.query(
        `SELECT id FROM app.students WHERE organization_id = $1 AND id = $2 AND user_id = $3`,
        [ctx.tenantId, lower(studentId), ctx.userId],
      );
      if (!studentMatch.rows[0]) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Students may only access their own examination results.',
        );
      }
    } else {
      await AuthorizationEngine.assert(tx, ctx, 'result.read');
    }

    // Students only ever see PUBLISHED results!
    const conditions = ['m.organization_id = $1', 'm.student_id = $2', "s.status = 'PUBLISHED'"];
    const params: unknown[] = [ctx.tenantId, lower(studentId)];

    if (termId) {
      params.push(lower(termId));
      conditions.push(`e.term_id = $${params.length}`);
    }

    const sql = `
      SELECT 
        m.id AS mark_id,
        m.marks_obtained,
        m.is_passing,
        m.status AS mark_status,
        m.remarks,
        s.id AS schedule_id,
        s.exam_date,
        s.max_marks,
        s.pass_marks,
        s.published_at,
        e.id AS examination_id,
        e.name AS exam_name,
        e.exam_type,
        c.code AS course_code,
        c.title AS course_title
      FROM app.exam_marks m
      JOIN app.exam_schedules s ON s.organization_id = m.organization_id AND s.id = m.exam_schedule_id
      JOIN app.examinations e ON e.organization_id = s.organization_id AND e.id = s.examination_id
      JOIN app.course_offerings o ON o.organization_id = s.organization_id AND o.id = s.course_offering_id
      JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.exam_date DESC, c.code ASC
    `;

    const res = await tx.query(sql, params);
    return res.rows;
  }
}
