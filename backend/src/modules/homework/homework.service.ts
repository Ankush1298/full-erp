import { createHash } from 'node:crypto';
import type { TenantTx } from '../../shared/database/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { ParentService } from '../parent/parent.service.js';
import { DocumentService } from '../documents/document.service.js';
import type {
  AttachmentDownloadResponse,
  AvailableDocumentItem,
  CreateHomeworkBody,
  HomeworkAttachmentItem,
  HomeworkDetailDto,
  HomeworkSubmissionFile,
  RecipientPreviewItem,
  RecipientPreviewResponse,
  ReviewSubmissionBody,
  StudentHomeworkItemDto,
  SubmissionListItemDto,
  TeacherClassItem,
  UpdateHomeworkBody,
  UploadAttachmentBody,
  UploadAttachmentResponse,
} from './homework.schemas.js';

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED');
  }
}

export class HomeworkService {
  /**
   * List classes, sections, and subjects the calling teacher or administrator is authorized to view.
   */
  static async listTeacherClasses(tx: TenantTx, ctx: TrustedContext): Promise<TeacherClassItem[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.manage');

    // Check if user is an employee
    const empRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );
    const employeeId = empRes.rows[0]?.id;
    if (!employeeId) return [];

    // Faculty query or administrative query
    const res = await tx.query<{
      offering_id: string;
      course_id: string;
      course_code: string;
      course_title: string;
      term_id: string;
      term_name: string;
      campus_id: string;
      campus_name: string;
      cohort_period_id: string | null;
      cohort_name: string | null;
      section_id: string | null;
      section_name: string | null;
      teaching_role: string;
      student_count: string;
    }>(
      `SELECT o.id AS offering_id,
              c.id AS course_id,
              o.code_snapshot AS course_code,
              o.title_snapshot AS course_title,
              t.id AS term_id,
              t.name AS term_name,
              camp.id AS campus_id,
              camp.name AS campus_name,
              cp.id AS cohort_period_id,
              ch.name AS cohort_name,
              sec.id AS section_id,
              sec.name AS section_name,
              COALESCE(fa."role", 'INSTRUCTOR') AS teaching_role,
              (SELECT count(DISTINCT r.student_id)::text
                 FROM app.course_registrations r
                 LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
                      AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
                WHERE r.organization_id = o.organization_id
                  AND r.course_offering_id = o.id
                  AND (o.section_id IS NULL OR sm.section_id = o.section_id)
                  AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
                  AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
              ) AS student_count
         FROM app.course_offerings o
         JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
         JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
         JOIN app.campuses camp ON camp.organization_id = o.organization_id AND camp.id = o.campus_id
         LEFT JOIN app.cohort_periods cp ON cp.organization_id = o.organization_id AND cp.id = o.cohort_period_id
         LEFT JOIN app.cohorts ch ON ch.organization_id = cp.organization_id AND ch.id = cp.cohort_id
         LEFT JOIN app.sections sec ON sec.organization_id = o.organization_id AND sec.id = o.section_id
         LEFT JOIN app.faculty_assignments fa ON fa.organization_id = o.organization_id
              AND fa.course_offering_id = o.id
              AND ($2::uuid IS NULL OR fa.employee_id = $2)
        WHERE o.organization_id = $1
          AND o.status IN ('PUBLISHED', 'CLOSED')
          AND ($2::uuid IS NULL OR fa.id IS NOT NULL)
        ORDER BY o.code_snapshot, sec.name NULLS FIRST, o.id`,
      [ctx.tenantId, employeeId ?? null],
    );

    return res.rows.map((r) => ({
      courseOfferingId: r.offering_id,
      courseId: r.course_id,
      courseCode: r.course_code,
      courseTitle: r.course_title,
      termId: r.term_id,
      termName: r.term_name,
      campusId: r.campus_id,
      campusName: r.campus_name,
      cohortPeriodId: r.cohort_period_id ?? null,
      cohortName: r.cohort_name ?? null,
      sectionId: r.section_id ?? null,
      sectionName: r.section_name ?? null,
      teachingRole: r.teaching_role,
      studentCount: parseInt(r.student_count, 10) || 0,
    }));
  }

  /**
   * Preview exact recipient students for an offering and section.
   */
  static async previewRecipients(
    tx: TenantTx,
    ctx: TrustedContext,
    courseOfferingId: string,
    sectionId?: string,
  ): Promise<RecipientPreviewResponse> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.manage', {
      organization_id: ctx.tenantId,
      course_offering_id: courseOfferingId,
    });

    const offRes = await tx.query<{ title_snapshot: string; section_id: string | null }>(
      `SELECT title_snapshot, section_id FROM app.course_offerings WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, courseOfferingId],
    );
    if (!offRes.rows[0]) {
      throw new AppError(404, 'Course offering not found', 'OFFERING_NOT_FOUND');
    }
    const targetSectionId = sectionId || offRes.rows[0].section_id || null;

    let sectionName: string | undefined = undefined;
    if (targetSectionId) {
      const secRes = await tx.query<{ name: string }>(
        `SELECT name FROM app.sections WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, targetSectionId],
      );
      sectionName = secRes.rows[0]?.name;
    }

    const studentsRes = await tx.query<{
      student_id: string;
      admission_number: string;
      display_name: string;
      roll_number: string | null;
      section_name: string | null;
    }>(
      `SELECT s.id AS student_id,
              s.admission_number,
              u.display_name,
              te.roll_number,
              sec.name AS section_name
         FROM app.course_registrations r
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN app.term_enrollments te ON te.organization_id = r.organization_id AND te.id = r.term_enrollment_id
         LEFT JOIN app.section_memberships sm ON sm.organization_id = te.organization_id
              AND sm.term_enrollment_id = te.id AND sm.valid_to IS NULL
         LEFT JOIN app.sections sec ON sec.organization_id = sm.organization_id AND sec.id = sm.section_id
        WHERE r.organization_id = $1
          AND r.course_offering_id = $2
          AND ($3::uuid IS NULL OR sm.section_id = $3)
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
          AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
        ORDER BY te.roll_number NULLS LAST, u.display_name ASC`,
      [ctx.tenantId, courseOfferingId, targetSectionId],
    );

    const students: RecipientPreviewItem[] = studentsRes.rows.map((r) => ({
      studentId: r.student_id,
      admissionNumber: r.admission_number,
      displayName: r.display_name,
      rollNumber: r.roll_number ?? null,
      sectionName: r.section_name ?? null,
    }));

    return {
      totalCount: students.length,
      courseTitle: offRes.rows[0].title_snapshot,
      sectionName: sectionName ?? null,
      students,
    };
  }

  /**
   * Create a new homework assignment.
   */
  static async createHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    body: CreateHomeworkBody,
  ): Promise<HomeworkDetailDto> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.manage', {
      organization_id: ctx.tenantId,
      course_offering_id: body.courseOfferingId,
    });

    const empRes = await tx.query<{ id: string; display_name: string }>(
      `SELECT e.id, u.display_name
         FROM app.employees e
         JOIN app.users u ON u.organization_id = e.organization_id AND u.id = e.user_id
        WHERE e.organization_id = $1 AND e.user_id = $2 AND e.status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );
    if (!empRes.rows[0]) {
      throw new AppError(
        403,
        'Active employee record required to create homework',
        'EMPLOYEE_RECORD_REQUIRED',
      );
    }
    const creatorEmployeeId = empRes.rows[0].id;
    const creatorName = empRes.rows[0].display_name;

    const offRes = await tx.query<{
      code_snapshot: string;
      title_snapshot: string;
      section_id: string | null;
    }>(
      `SELECT code_snapshot, title_snapshot, section_id
         FROM app.course_offerings
        WHERE organization_id = $1 AND id = $2 AND status IN ('PUBLISHED', 'CLOSED')`,
      [ctx.tenantId, body.courseOfferingId],
    );
    if (!offRes.rows[0]) {
      throw new AppError(404, 'Course offering not found or not published', 'OFFERING_NOT_FOUND');
    }

    const sectionId = body.sectionId || offRes.rows[0].section_id || null;
    let sectionName: string | undefined = undefined;
    if (sectionId) {
      const secRes = await tx.query<{ name: string }>(
        `SELECT name FROM app.sections WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, sectionId],
      );
      sectionName = secRes.rows[0]?.name;
    }

    const homeworkId = uuidv7();
    const isPublish = !!body.publishNow;
    const status = isPublish ? 'PUBLISHED' : 'DRAFT';
    const publishedAt = isPublish ? new Date().toISOString() : null;

    await tx.query(
      `INSERT INTO app.homework_assignments (
        id, organization_id, course_offering_id, section_id, created_by_employee_id,
        teacher_name, title, instructions, submission_type, status, due_date, due_time, max_marks,
        allow_resubmission, published_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        homeworkId,
        ctx.tenantId,
        body.courseOfferingId,
        sectionId,
        creatorEmployeeId,
        creatorName,
        body.title.trim(),
        body.instructions.trim(),
        body.submissionType,
        status,
        body.dueDate || null,
        body.dueTime || null,
        body.maxMarks ?? null,
        !!body.allowResubmission,
        publishedAt,
      ],
    );

    const attachmentItems: HomeworkAttachmentItem[] = [];
    if (body.attachments && body.attachments.length > 0) {
      for (const att of body.attachments) {
        const attId = uuidv7();
        await tx.query(
          `INSERT INTO app.homework_attachments (
            id, organization_id, homework_id, file_id, file_name, file_size_bytes, mime_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            attId,
            ctx.tenantId,
            homeworkId,
            att.fileId,
            att.fileName,
            att.fileSizeBytes,
            att.mimeType,
          ],
        );
        attachmentItems.push({
          id: attId,
          fileId: att.fileId,
          fileName: att.fileName,
          fileSizeBytes: att.fileSizeBytes,
          mimeType: att.mimeType,
        });
      }
    }

    // If published now, send notifications to students
    if (isPublish) {
      await this.notifyHomeworkPublished(
        tx,
        ctx,
        homeworkId,
        body.title,
        body.courseOfferingId,
        sectionId,
      );
    }

    const recipients = await this.previewRecipients(
      tx,
      ctx,
      body.courseOfferingId,
      sectionId ?? undefined,
    );

    return {
      id: homeworkId,
      courseOfferingId: body.courseOfferingId,
      courseCode: offRes.rows[0].code_snapshot,
      courseTitle: offRes.rows[0].title_snapshot,
      sectionId: sectionId ?? null,
      sectionName: sectionName ?? null,
      teacherName: creatorName,
      teacherEmployeeId: creatorEmployeeId,
      title: body.title.trim(),
      instructions: body.instructions.trim(),
      submissionType: body.submissionType,
      status,
      dueDate: body.dueDate ?? null,
      dueTime: body.dueTime ?? null,
      maxMarks: body.maxMarks ?? null,
      allowResubmission: !!body.allowResubmission,
      publishedAt: publishedAt ?? null,
      closedAt: null,
      totalRecipients: recipients.totalCount,
      submittedCount: 0,
      pendingCount: recipients.totalCount,
      reviewedCount: 0,
      lateCount: 0,
      attachments: attachmentItems,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Update an existing draft or published homework.
   */
  static async updateHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
    body: UpdateHomeworkBody,
  ): Promise<void> {
    ensureTrusted(ctx);

    const hw = await tx.query<{ course_offering_id: string; status: string }>(
      `SELECT course_offering_id, status FROM app.homework_assignments WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );
    if (!hw.rows[0]) {
      throw new AppError(404, 'Homework not found', 'HOMEWORK_NOT_FOUND');
    }
    if (hw.rows[0].status === 'CLOSED' || hw.rows[0].status === 'ARCHIVED') {
      throw new AppError(400, 'Cannot edit closed or archived homework', 'HOMEWORK_CLOSED');
    }

    await AuthorizationEngine.assert(tx, ctx, 'homework.manage', {
      organization_id: ctx.tenantId,
      course_offering_id: hw.rows[0].course_offering_id,
    });

    const sets: string[] = [];
    const params: unknown[] = [ctx.tenantId, homeworkId];
    let idx = 3;

    if (body.title !== undefined) {
      sets.push(`title = $${idx++}`);
      params.push(body.title.trim());
    }
    if (body.instructions !== undefined) {
      sets.push(`instructions = $${idx++}`);
      params.push(body.instructions.trim());
    }
    if (body.submissionType !== undefined) {
      sets.push(`submission_type = $${idx++}`);
      params.push(body.submissionType);
    }
    if (body.dueDate !== undefined) {
      sets.push(`due_date = $${idx++}`);
      params.push(body.dueDate || null);
    }
    if (body.dueTime !== undefined) {
      sets.push(`due_time = $${idx++}`);
      params.push(body.dueTime || null);
    }
    if (body.maxMarks !== undefined) {
      sets.push(`max_marks = $${idx++}`);
      params.push(body.maxMarks);
    }
    if (body.allowResubmission !== undefined) {
      sets.push(`allow_resubmission = $${idx}`);
      params.push(body.allowResubmission);
    }

    if (sets.length > 0) {
      const updateSql = `UPDATE app.homework_assignments SET ${sets.join(', ')} WHERE organization_id = $1 AND id = $2`;
      await tx.query(updateSql, params);
    }
  }

  /**
   * Publish a draft homework assignment.
   */
  static async publishHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
  ): Promise<void> {
    ensureTrusted(ctx);

    const hw = await tx.query<{
      course_offering_id: string;
      section_id: string | null;
      title: string;
      status: string;
    }>(
      `SELECT course_offering_id, section_id, title, status FROM app.homework_assignments WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );
    if (!hw.rows[0]) {
      throw new AppError(404, 'Homework not found', 'HOMEWORK_NOT_FOUND');
    }
    if (hw.rows[0].status !== 'DRAFT') {
      throw new AppError(400, 'Homework is already published or closed', 'INVALID_STATUS');
    }

    await AuthorizationEngine.assert(tx, ctx, 'homework.manage', {
      organization_id: ctx.tenantId,
      course_offering_id: hw.rows[0].course_offering_id,
    });

    await tx.query(
      `UPDATE app.homework_assignments
          SET status = 'PUBLISHED', published_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );

    await this.notifyHomeworkPublished(
      tx,
      ctx,
      homeworkId,
      hw.rows[0].title,
      hw.rows[0].course_offering_id,
      hw.rows[0].section_id,
    );
  }

  /**
   * Close a homework assignment.
   */
  static async closeHomework(tx: TenantTx, ctx: TrustedContext, homeworkId: string): Promise<void> {
    ensureTrusted(ctx);

    const hw = await tx.query<{ course_offering_id: string; status: string }>(
      `SELECT course_offering_id, status FROM app.homework_assignments WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );
    if (!hw.rows[0]) {
      throw new AppError(404, 'Homework not found', 'HOMEWORK_NOT_FOUND');
    }

    await AuthorizationEngine.assert(tx, ctx, 'homework.manage', {
      organization_id: ctx.tenantId,
      course_offering_id: hw.rows[0].course_offering_id,
    });

    await tx.query(
      `UPDATE app.homework_assignments
          SET status = 'CLOSED', closed_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );
  }

  /**
   * List homework assignments for teachers/staff with progress metrics.
   */
  static async listTeacherHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: { courseOfferingId?: string; sectionId?: string; status?: string } = {},
  ): Promise<HomeworkDetailDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.manage');

    const empRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );
    const employeeId = empRes.rows[0]?.id;

    const where: string[] = ['hw.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;

    if (filter.courseOfferingId) {
      where.push(`hw.course_offering_id = $${idx++}`);
      params.push(filter.courseOfferingId);
    }
    if (filter.sectionId) {
      where.push(`hw.section_id = $${idx++}`);
      params.push(filter.sectionId);
    }
    if (filter.status) {
      where.push(`hw.status = $${idx++}`);
      params.push(filter.status);
    }
    if (employeeId) {
      // Scope to teacher's assignments or administrative grants
      where.push(`(hw.created_by_employee_id = $${idx++} OR EXISTS (
        SELECT 1 FROM app.faculty_assignments fa
         WHERE fa.organization_id = hw.organization_id
           AND fa.course_offering_id = hw.course_offering_id
           AND fa.employee_id = $${idx - 1}
      ))`);
      params.push(employeeId);
    }

    const res = await tx.query<{
      id: string;
      course_offering_id: string;
      course_code: string;
      course_title: string;
      section_id: string | null;
      section_name: string | null;
      teacher_name: string;
      teacher_employee_id: string;
      title: string;
      instructions: string;
      submission_type: 'OFFLINE' | 'ONLINE';
      status: 'DRAFT' | 'PUBLISHED' | 'CLOSED' | 'ARCHIVED';
      due_date: string | null;
      due_time: string | null;
      max_marks: string | null;
      allow_resubmission: boolean;
      published_at: string | null;
      closed_at: string | null;
      created_at: string;
      total_recipients: string;
      submitted_count: string;
      reviewed_count: string;
      late_count: string;
    }>(
      `SELECT hw.id,
              hw.course_offering_id,
              o.code_snapshot AS course_code,
              o.title_snapshot AS course_title,
              hw.section_id,
              sec.name AS section_name,
              u.display_name AS teacher_name,
              hw.created_by_employee_id AS teacher_employee_id,
              hw.title,
              hw.instructions,
              hw.submission_type,
              hw.status,
              hw.due_date::text,
              hw.due_time::text,
              hw.max_marks::text,
              hw.allow_resubmission,
              hw.published_at::text,
              hw.closed_at::text,
              hw.created_at::text,
              (SELECT count(DISTINCT r.student_id)::text
                 FROM app.course_registrations r
                 LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
                      AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
                WHERE r.organization_id = hw.organization_id
                  AND r.course_offering_id = hw.course_offering_id
                  AND (hw.section_id IS NULL OR sm.section_id = hw.section_id)
                  AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
                  AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
              ) AS total_recipients,
              (SELECT count(*)::text FROM app.homework_submissions sub
                WHERE sub.organization_id = hw.organization_id AND sub.homework_id = hw.id
                  AND sub.status IN ('SUBMITTED', 'LATE', 'REVIEWED', 'RESUBMISSION_REQUESTED', 'COMPLETED')
              ) AS submitted_count,
              (SELECT count(*)::text FROM app.homework_submissions sub
                WHERE sub.organization_id = hw.organization_id AND sub.homework_id = hw.id
                  AND sub.status IN ('REVIEWED', 'COMPLETED')
              ) AS reviewed_count,
              (SELECT count(*)::text FROM app.homework_submissions sub
                WHERE sub.organization_id = hw.organization_id AND sub.homework_id = hw.id
                  AND sub.status = 'LATE'
              ) AS late_count
         FROM app.homework_assignments hw
         JOIN app.course_offerings o ON o.organization_id = hw.organization_id AND o.id = hw.course_offering_id
         JOIN app.employees e ON e.organization_id = hw.organization_id AND e.id = hw.created_by_employee_id
         JOIN app.users u ON u.organization_id = e.organization_id AND u.id = e.user_id
         LEFT JOIN app.sections sec ON sec.organization_id = hw.organization_id AND sec.id = hw.section_id
        WHERE ${where.join(' AND ')}
        ORDER BY hw.created_at DESC`,
      params,
    );

    const items: HomeworkDetailDto[] = [];
    for (const r of res.rows) {
      const totalRecipients = parseInt(r.total_recipients, 10) || 0;
      const submittedCount = parseInt(r.submitted_count, 10) || 0;
      const reviewedCount = parseInt(r.reviewed_count, 10) || 0;
      const lateCount = parseInt(r.late_count, 10) || 0;
      const pendingCount = Math.max(0, totalRecipients - submittedCount);

      const attRes = await tx.query<HomeworkAttachmentItem>(
        `SELECT id, file_id AS "fileId", file_name AS "fileName",
                file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
           FROM app.homework_attachments
          WHERE organization_id = $1 AND homework_id = $2
          ORDER BY created_at ASC`,
        [ctx.tenantId, r.id],
      );

      items.push({
        id: r.id,
        courseOfferingId: r.course_offering_id,
        courseCode: r.course_code,
        courseTitle: r.course_title,
        sectionId: r.section_id ?? null,
        sectionName: r.section_name ?? null,
        teacherName: r.teacher_name,
        teacherEmployeeId: r.teacher_employee_id,
        title: r.title,
        instructions: r.instructions,
        submissionType: r.submission_type,
        status: r.status,
        dueDate: r.due_date ?? null,
        dueTime: r.due_time ?? null,
        maxMarks: r.max_marks ? parseFloat(r.max_marks) : null,
        allowResubmission: r.allow_resubmission,
        publishedAt: r.published_at ?? null,
        closedAt: r.closed_at ?? null,
        totalRecipients,
        submittedCount,
        pendingCount,
        reviewedCount,
        lateCount,
        attachments: attRes.rows,
        createdAt: r.created_at,
      });
    }

    return items;
  }

  /**
   * Get detail for a specific homework assignment.
   */
  static async getHomeworkDetail(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
  ): Promise<HomeworkDetailDto> {
    ensureTrusted(ctx);

    const list = await this.listTeacherHomework(tx, ctx);
    const item = list.find((h) => h.id === homeworkId);
    if (!item) {
      throw new AppError(404, 'Homework not found', 'HOMEWORK_NOT_FOUND');
    }
    return item;
  }

  /**
   * List student submissions for a given homework assignment.
   */
  static async listSubmissions(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
  ): Promise<SubmissionListItemDto[]> {
    ensureTrusted(ctx);

    const hw = await tx.query<{ course_offering_id: string; section_id: string | null }>(
      `SELECT course_offering_id, section_id FROM app.homework_assignments WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, homeworkId],
    );
    if (!hw.rows[0]) {
      throw new AppError(404, 'Homework not found', 'HOMEWORK_NOT_FOUND');
    }

    await AuthorizationEngine.assert(tx, ctx, 'homework.review', {
      organization_id: ctx.tenantId,
      course_offering_id: hw.rows[0].course_offering_id,
    });

    const res = await tx.query<{
      submission_id: string | null;
      student_id: string;
      admission_number: string;
      student_name: string;
      roll_number: string | null;
      status: string | null;
      submission_text: string | null;
      submitted_at: string | null;
      evaluated_at: string | null;
      marks_obtained: string | null;
      grade: string | null;
      feedback: string | null;
      resubmission_allowed: boolean | null;
      resubmission_count: number | null;
    }>(
      `SELECT sub.id AS submission_id,
              s.id AS student_id,
              s.admission_number,
              u.display_name AS student_name,
              te.roll_number,
              COALESCE(sub.status, 'PENDING') AS status,
              sub.submission_text,
              sub.submitted_at::text,
              sub.evaluated_at::text,
              sub.marks_obtained::text,
              sub.grade,
              sub.feedback,
              COALESCE(sub.resubmission_allowed, false) AS resubmission_allowed,
              COALESCE(sub.resubmission_count, 0) AS resubmission_count
         FROM app.course_registrations r
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN app.term_enrollments te ON te.organization_id = r.organization_id AND te.id = r.term_enrollment_id
         LEFT JOIN app.section_memberships sm ON sm.organization_id = te.organization_id
              AND sm.term_enrollment_id = te.id AND sm.valid_to IS NULL
         LEFT JOIN app.homework_submissions sub ON sub.organization_id = r.organization_id
              AND sub.homework_id = $2 AND sub.student_id = s.id
        WHERE r.organization_id = $1
          AND r.course_offering_id = $3
          AND ($4::uuid IS NULL OR sm.section_id = $4)
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
          AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
        ORDER BY te.roll_number NULLS LAST, u.display_name ASC`,
      [ctx.tenantId, homeworkId, hw.rows[0].course_offering_id, hw.rows[0].section_id],
    );

    const items: SubmissionListItemDto[] = [];
    for (const r of res.rows) {
      let files: HomeworkSubmissionFile[] = [];
      if (r.submission_id) {
        const filesRes = await tx.query<HomeworkSubmissionFile>(
          `SELECT id, file_id AS "fileId", file_name AS "fileName",
                  file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
             FROM app.homework_submission_files
            WHERE organization_id = $1 AND submission_id = $2
            ORDER BY created_at ASC`,
          [ctx.tenantId, r.submission_id],
        );
        files = filesRes.rows;
      }

      items.push({
        id: r.submission_id ?? null,
        studentId: r.student_id,
        admissionNumber: r.admission_number,
        studentName: r.student_name,
        rollNumber: r.roll_number ?? null,
        status: r.status || 'PENDING',
        submissionText: r.submission_text ?? null,
        submittedAt: r.submitted_at ?? null,
        evaluatedAt: r.evaluated_at ?? null,
        marksObtained: r.marks_obtained ? parseFloat(r.marks_obtained) : null,
        grade: r.grade ?? null,
        feedback: r.feedback ?? null,
        resubmissionAllowed: !!r.resubmission_allowed,
        resubmissionCount: r.resubmission_count || 0,
        files,
      });
    }

    return items;
  }

  /**
   * Record teacher evaluation, marks, grade, feedback, and resubmission permissions.
   */
  static async reviewSubmission(
    tx: TenantTx,
    ctx: TrustedContext,
    submissionId: string,
    body: ReviewSubmissionBody,
  ): Promise<void> {
    ensureTrusted(ctx);

    const sub = await tx.query<{
      homework_id: string;
      student_id: string;
      course_offering_id: string;
      title: string;
      user_id: string;
    }>(
      `SELECT s.homework_id, s.student_id, hw.course_offering_id, hw.title, stu.user_id
         FROM app.homework_submissions s
         JOIN app.homework_assignments hw ON hw.organization_id = s.organization_id AND hw.id = s.homework_id
         JOIN app.students stu ON stu.organization_id = s.organization_id AND stu.id = s.student_id
        WHERE s.organization_id = $1 AND s.id = $2`,
      [ctx.tenantId, submissionId],
    );
    if (!sub.rows[0]) {
      throw new AppError(404, 'Submission not found', 'SUBMISSION_NOT_FOUND');
    }

    await AuthorizationEngine.assert(tx, ctx, 'homework.review', {
      organization_id: ctx.tenantId,
      course_offering_id: sub.rows[0].course_offering_id,
    });

    const empRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );
    const evaluatorEmployeeId = empRes.rows[0]?.id || null;

    const newStatus = body.status || 'REVIEWED';

    await tx.query(
      `UPDATE app.homework_submissions
          SET status = $3,
              marks_obtained = $4,
              grade = $5,
              feedback = $6,
              resubmission_allowed = $7,
              evaluated_by_employee_id = $8,
              evaluated_at = now()
        WHERE organization_id = $1 AND id = $2`,
      [
        ctx.tenantId,
        submissionId,
        newStatus,
        body.marksObtained ?? null,
        body.grade || null,
        body.feedback || null,
        !!body.resubmissionAllowed,
        evaluatorEmployeeId,
      ],
    );

    // Send in-app notification to student
    try {
      await tx.query(
        `INSERT INTO app.notifications (
           id, organization_id, recipient_user_id, category, title, body,
           action_url, entity_type, entity_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
        [
          uuidv7(),
          ctx.tenantId,
          sub.rows[0].user_id,
          'ACADEMIC',
          newStatus === 'RESUBMISSION_REQUESTED'
            ? 'Homework Resubmission Requested'
            : 'Homework Feedback Available',
          `Your teacher has reviewed "${sub.rows[0].title}". ${body.feedback ? 'Feedback: ' + body.feedback : ''}`.trim(),
          `/student/homework/${sub.rows[0].homework_id}`,
          'homework',
          sub.rows[0].homework_id,
        ],
      );
    } catch {
      // In-app notification delivery is best effort
    }
  }

  /**
   * List homework assignments visible to the calling student.
   */
  static async listStudentHomework(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<StudentHomeworkItemDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStudentActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.read');

    const res = await tx.query<{
      id: string;
      course_offering_id: string;
      course_code: string;
      course_title: string;
      section_name: string | null;
      teacher_name: string;
      title: string;
      instructions: string;
      submission_type: 'OFFLINE' | 'ONLINE';
      due_date: string | null;
      due_time: string | null;
      max_marks: string | null;
      status: string;
      submission_id: string | null;
      submission_status: string;
      submitted_at: string | null;
      evaluated_at: string | null;
      marks_obtained: string | null;
      grade: string | null;
      feedback: string | null;
      resubmission_allowed: boolean;
      submission_text: string | null;
    }>(
      `SELECT hw.id,
              hw.course_offering_id,
              c.code AS course_code,
              c.title AS course_title,
              sec.name AS section_name,
              hw.teacher_name,
              hw.title,
              hw.instructions,
              hw.submission_type,
              hw.due_date::text,
              hw.due_time::text,
              hw.max_marks::text,
              hw.status,
              sub.id AS submission_id,
              COALESCE(sub.status, 'PENDING') AS submission_status,
              sub.submitted_at::text,
              sub.evaluated_at::text,
              sub.marks_obtained::text,
              sub.grade,
              sub.feedback,
              COALESCE(sub.resubmission_allowed, false) AS resubmission_allowed,
              sub.submission_text
         FROM app.homework_assignments hw
         JOIN app.course_offerings o ON o.organization_id = hw.organization_id AND o.id = hw.course_offering_id
         JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
         JOIN app.course_registrations r ON r.organization_id = hw.organization_id AND r.course_offering_id = hw.course_offering_id
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
              AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
         LEFT JOIN app.sections sec ON sec.organization_id = hw.organization_id AND sec.id = hw.section_id
         LEFT JOIN app.homework_submissions sub ON sub.organization_id = hw.organization_id
              AND sub.homework_id = hw.id AND sub.student_id = s.id
        WHERE hw.organization_id = $1
          AND s.user_id = $2
          AND hw.status IN ('PUBLISHED', 'CLOSED')
          AND (hw.section_id IS NULL OR hw.section_id = sm.section_id)
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
          AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
        ORDER BY hw.due_date ASC NULLS LAST, hw.created_at DESC`,
      [ctx.tenantId, ctx.userId],
    );

    const items: StudentHomeworkItemDto[] = [];
    for (const r of res.rows) {
      const attRes = await tx.query<HomeworkAttachmentItem>(
        `SELECT id, file_id AS "fileId", file_name AS "fileName",
                file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
           FROM app.homework_attachments
          WHERE organization_id = $1 AND homework_id = $2
          ORDER BY created_at ASC`,
        [ctx.tenantId, r.id],
      );

      let myFiles: HomeworkSubmissionFile[] = [];
      if (r.submission_id) {
        const subFilesRes = await tx.query<HomeworkSubmissionFile>(
          `SELECT id, file_id AS "fileId", file_name AS "fileName",
                  file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
             FROM app.homework_submission_files
            WHERE organization_id = $1 AND submission_id = $2
            ORDER BY created_at ASC`,
          [ctx.tenantId, r.submission_id],
        );
        myFiles = subFilesRes.rows;
      }

      items.push({
        id: r.id,
        courseOfferingId: r.course_offering_id,
        courseCode: r.course_code,
        courseTitle: r.course_title,
        sectionName: r.section_name ?? null,
        teacherName: r.teacher_name,
        title: r.title,
        instructions: r.instructions,
        submissionType: r.submission_type,
        dueDate: r.due_date ?? null,
        dueTime: r.due_time ?? null,
        maxMarks: r.max_marks ? parseFloat(r.max_marks) : null,
        status: r.status,
        submissionStatus: r.submission_status,
        submittedAt: r.submitted_at ?? null,
        evaluatedAt: r.evaluated_at ?? null,
        marksObtained: r.marks_obtained ? parseFloat(r.marks_obtained) : null,
        grade: r.grade ?? null,
        feedback: r.feedback ?? null,
        resubmissionAllowed: r.resubmission_allowed,
        attachments: attRes.rows,
        mySubmissionFiles: myFiles,
        mySubmissionText: r.submission_text ?? null,
      });
    }

    return items;
  }

  /**
   * Submit homework work (online submission).
   */
  static async submitHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
    body: {
      submissionText?: string;
      files?: { fileId: string; fileName: string; fileSizeBytes: number; mimeType: string }[];
    },
  ): Promise<void> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStudentActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'homework.submit');

    const stuRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    if (!stuRes.rows[0]) {
      throw new AppError(403, 'Student profile not found', 'STUDENT_NOT_FOUND');
    }
    const studentId = stuRes.rows[0].id;

    // Verify homework is published, online, and student is enrolled
    const hwRes = await tx.query<{
      status: string;
      submission_type: string;
      due_date: string | null;
      due_time: string | null;
      allow_resubmission: boolean;
    }>(
      `SELECT hw.status, hw.submission_type, hw.due_date::text, hw.due_time::text, hw.allow_resubmission
         FROM app.homework_assignments hw
         JOIN app.course_registrations r ON r.organization_id = hw.organization_id AND r.course_offering_id = hw.course_offering_id
         LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
              AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
        WHERE hw.organization_id = $1 AND hw.id = $2 AND r.student_id = $3
          AND (hw.section_id IS NULL OR hw.section_id = sm.section_id)
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
          AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)`,
      [ctx.tenantId, homeworkId, studentId],
    );
    if (!hwRes.rows[0]) {
      throw new AppError(
        404,
        'Homework not found or student not enrolled in this section',
        'HOMEWORK_NOT_FOUND',
      );
    }
    const hw = hwRes.rows[0];

    if (hw.status !== 'PUBLISHED') {
      throw new AppError(400, 'Submissions are closed for this homework', 'HOMEWORK_NOT_PUBLISHED');
    }
    if (hw.submission_type !== 'ONLINE') {
      throw new AppError(
        400,
        'This is an offline homework assignment; online uploads are disabled',
        'ONLINE_SUBMISSION_DISABLED',
      );
    }

    // Determine if late
    let isLate = false;
    if (hw.due_date) {
      const now = new Date();
      const dueStr = hw.due_time ? `${hw.due_date}T${hw.due_time}` : `${hw.due_date}T23:59:59`;
      const due = new Date(dueStr);
      if (now.getTime() > due.getTime()) {
        isLate = true;
      }
    }
    const submissionStatus = isLate ? 'LATE' : 'SUBMITTED';

    // Check existing submission
    const existing = await tx.query<{
      id: string;
      status: string;
      resubmission_allowed: boolean;
      resubmission_count: number;
    }>(
      `SELECT id, status, resubmission_allowed, resubmission_count
         FROM app.homework_submissions
        WHERE organization_id = $1 AND homework_id = $2 AND student_id = $3`,
      [ctx.tenantId, homeworkId, studentId],
    );

    let submissionId: string;
    if (existing.rows[0]) {
      const ex = existing.rows[0];
      if (!hw.allow_resubmission && !ex.resubmission_allowed && ex.status !== 'PENDING') {
        throw new AppError(
          409,
          'Resubmission is not permitted for this assignment',
          'RESUBMISSION_DENIED',
        );
      }

      submissionId = ex.id;
      await tx.query(
        `UPDATE app.homework_submissions
            SET status = $4,
                submission_text = $5,
                submitted_at = now(),
                resubmission_count = resubmission_count + 1,
                resubmission_allowed = false
          WHERE organization_id = $1 AND id = $2 AND student_id = $3`,
        [ctx.tenantId, submissionId, studentId, submissionStatus, body.submissionText || null],
      );
    } else {
      submissionId = uuidv7();
      await tx.query(
        `INSERT INTO app.homework_submissions (
          id, organization_id, homework_id, student_id, status, submission_text, submitted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [
          submissionId,
          ctx.tenantId,
          homeworkId,
          studentId,
          submissionStatus,
          body.submissionText || null,
        ],
      );
    }

    // Attach student files
    if (body.files && body.files.length > 0) {
      for (const f of body.files) {
        const fileId = uuidv7();
        await tx.query(
          `INSERT INTO app.homework_submission_files (
            id, organization_id, submission_id, file_id, file_name, file_size_bytes, mime_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [fileId, ctx.tenantId, submissionId, f.fileId, f.fileName, f.fileSizeBytes, f.mimeType],
        );
      }
    }
  }

  /**
   * List homework for a verified parent's child.
   */
  static async listParentStudentHomework(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<StudentHomeworkItemDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'parent.academics.read');

    // Assert verified parent-child linkage with academic view permissions
    const children = await ParentService.getChildren(tx, ctx);
    const child = children.find((c) => c.studentId === studentId);
    if (!child || !child.canViewAcademics) {
      throw new AppError(403, 'Unauthorized child access', 'CHILD_NOT_AUTHORIZED');
    }

    const res = await tx.query<{
      id: string;
      course_offering_id: string;
      course_code: string;
      course_title: string;
      section_name: string | null;
      teacher_name: string;
      title: string;
      instructions: string;
      submission_type: 'OFFLINE' | 'ONLINE';
      due_date: string | null;
      due_time: string | null;
      max_marks: string | null;
      status: string;
      submission_id: string | null;
      submission_status: string;
      submitted_at: string | null;
      evaluated_at: string | null;
      marks_obtained: string | null;
      grade: string | null;
      feedback: string | null;
      resubmission_allowed: boolean;
      submission_text: string | null;
    }>(
      `SELECT hw.id,
              hw.course_offering_id,
              c.code AS course_code,
              c.title AS course_title,
              sec.name AS section_name,
              hw.teacher_name,
              hw.title,
              hw.instructions,
              hw.submission_type,
              hw.due_date::text,
              hw.due_time::text,
              hw.max_marks::text,
              hw.status,
              sub.id AS submission_id,
              COALESCE(sub.status, 'PENDING') AS submission_status,
              sub.submitted_at::text,
              sub.evaluated_at::text,
              sub.marks_obtained::text,
              sub.grade,
              sub.feedback,
              COALESCE(sub.resubmission_allowed, false) AS resubmission_allowed,
              sub.submission_text
         FROM app.homework_assignments hw
         JOIN app.course_offerings o ON o.organization_id = hw.organization_id AND o.id = hw.course_offering_id
         JOIN app.courses c ON c.organization_id = o.organization_id AND c.id = o.course_id
         JOIN app.course_registrations r ON r.organization_id = hw.organization_id AND r.course_offering_id = hw.course_offering_id
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
              AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
         LEFT JOIN app.sections sec ON sec.organization_id = hw.organization_id AND sec.id = hw.section_id
         LEFT JOIN app.homework_submissions sub ON sub.organization_id = hw.organization_id
              AND sub.homework_id = hw.id AND sub.student_id = s.id
        WHERE hw.organization_id = $1
          AND s.id = $2
          AND hw.status IN ('PUBLISHED', 'CLOSED')
          AND (hw.section_id IS NULL OR hw.section_id = sm.section_id)
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
          AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
        ORDER BY hw.due_date ASC NULLS LAST, hw.created_at DESC`,
      [ctx.tenantId, studentId],
    );

    const items: StudentHomeworkItemDto[] = [];
    for (const r of res.rows) {
      const attRes = await tx.query<HomeworkAttachmentItem>(
        `SELECT id, file_id AS "fileId", file_name AS "fileName",
                file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
           FROM app.homework_attachments
          WHERE organization_id = $1 AND homework_id = $2
          ORDER BY created_at ASC`,
        [ctx.tenantId, r.id],
      );

      let myFiles: HomeworkSubmissionFile[] = [];
      if (r.submission_id) {
        const subFilesRes = await tx.query<HomeworkSubmissionFile>(
          `SELECT id, file_id AS "fileId", file_name AS "fileName",
                  file_size_bytes AS "fileSizeBytes", mime_type AS "mimeType"
             FROM app.homework_submission_files
            WHERE organization_id = $1 AND submission_id = $2
            ORDER BY created_at ASC`,
          [ctx.tenantId, r.submission_id],
        );
        myFiles = subFilesRes.rows;
      }

      items.push({
        id: r.id,
        courseOfferingId: r.course_offering_id,
        courseCode: r.course_code,
        courseTitle: r.course_title,
        sectionName: r.section_name ?? null,
        teacherName: r.teacher_name,
        title: r.title,
        instructions: r.instructions,
        submissionType: r.submission_type,
        dueDate: r.due_date ?? null,
        dueTime: r.due_time ?? null,
        maxMarks: r.max_marks ? parseFloat(r.max_marks) : null,
        status: r.status,
        submissionStatus: r.submission_status,
        submittedAt: r.submitted_at ?? null,
        evaluatedAt: r.evaluated_at ?? null,
        marksObtained: r.marks_obtained ? parseFloat(r.marks_obtained) : null,
        grade: r.grade ?? null,
        feedback: r.feedback ?? null,
        resubmissionAllowed: r.resubmission_allowed,
        attachments: attRes.rows,
        mySubmissionFiles: myFiles,
        mySubmissionText: r.submission_text ?? null,
      });
    }

    return items;
  }

  /**
   * Internal helper: Notify enrolled students that homework has been published.
   */
  private static async notifyHomeworkPublished(
    tx: TenantTx,
    ctx: TrustedContext,
    homeworkId: string,
    title: string,
    courseOfferingId: string,
    sectionId: string | null,
  ): Promise<void> {
    try {
      const students = await tx.query<{ user_id: string }>(
        `SELECT DISTINCT u.id AS user_id
           FROM app.course_registrations r
           JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
           JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
           JOIN app.term_enrollments te ON te.organization_id = r.organization_id AND te.id = r.term_enrollment_id
           LEFT JOIN app.section_memberships sm ON sm.organization_id = te.organization_id
                AND sm.term_enrollment_id = te.id AND sm.valid_to IS NULL
          WHERE r.organization_id = $1
            AND r.course_offering_id = $2
            AND ($3::uuid IS NULL OR sm.section_id = $3)
            AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
            AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)`,
        [ctx.tenantId, courseOfferingId, sectionId],
      );

      for (const st of students.rows) {
        await tx.query(
          `INSERT INTO app.notifications (
             id, organization_id, recipient_user_id, category, title, body,
             action_url, entity_type, entity_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
          [
            uuidv7(),
            ctx.tenantId,
            st.user_id,
            'ACADEMIC',
            'New Homework Assigned',
            `You have new homework: "${title}". Check requirements and due date.`,
            `/student/homework/${homeworkId}`,
            'homework',
            homeworkId,
          ],
        );
      }
    } catch {
      // In-app notifications are best effort
    }
  }

  /**
   * Upload and register a homework attachment file directly into the tenant's central file storage.
   */
  static async uploadAttachment(
    tx: TenantTx,
    ctx: TrustedContext,
    body: UploadAttachmentBody,
  ): Promise<UploadAttachmentResponse> {
    ensureTrusted(ctx);
    // Requires either teacher homework.manage or student homework.submit
    const canManage = await AuthorizationEngine.hasPermission(tx, ctx, 'homework.manage');
    const canSubmit = await AuthorizationEngine.hasPermission(tx, ctx, 'homework.submit');
    if (!canManage && !canSubmit) {
      throw new AppError(403, 'Permission denied to upload homework attachment', 'FORBIDDEN');
    }

    // Sanitize and validate filename (strips path separators, rejects traversal)
    const baseName = body.fileName.replace(/^.*[\\/]/, '').trim();
    if (!baseName || baseName === '.' || baseName === '..' || baseName.length > 255) {
      throw new AppError(400, 'Invalid file name', 'INVALID_FILENAME');
    }

    // Size limit 25MB
    const MAX_SIZE = 25 * 1024 * 1024;
    if (body.fileSizeBytes > MAX_SIZE || body.fileSizeBytes <= 0) {
      throw new AppError(
        400,
        'File size must be between 1 byte and 25 MB',
        'FILE_SIZE_OUT_OF_BOUNDS',
      );
    }

    // Validate MIME type
    const mime = body.mimeType.toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mime)) {
      throw new AppError(400, 'Invalid MIME type format', 'INVALID_MIME_TYPE');
    }

    let computedSha256: string | undefined;
    if (body.contentBase64) {
      try {
        const buf = Buffer.from(body.contentBase64, 'base64');
        computedSha256 = createHash('sha256').update(buf).digest('hex');
      } catch {
        computedSha256 = undefined;
      }
    }

    const created = await DocumentService.createVerifiedFile(tx, ctx, {
      fileName: baseName,
      mimeType: mime,
      fileSizeBytes: body.fileSizeBytes,
      ...(computedSha256 ? { sha256: computedSha256 } : {}),
      classification: 'INTERNAL',
    });

    return {
      id: created.fileId,
      fileId: created.fileId,
      fileName: created.fileName,
      fileSizeBytes: created.fileSizeBytes,
      mimeType: created.mimeType,
    };
  }

  /**
   * List available institutional documents and previous uploads for attaching by reference.
   */
  static async listAvailableDocuments(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<AvailableDocumentItem[]> {
    ensureTrusted(ctx);
    const res = await tx.query<{
      id: string;
      fileName: string;
      fileSizeBytes: number;
      mimeType: string;
      createdAt: string;
    }>(
      `SELECT id, original_name AS "fileName", coalesce(size_bytes, 0)::int AS "fileSizeBytes",
              coalesce(detected_mime, declared_mime, 'application/pdf') AS "mimeType",
              created_at::text AS "createdAt"
         FROM app.files
        WHERE organization_id = $1 AND status = 'AVAILABLE'
        ORDER BY created_at DESC
        LIMIT 50`,
      [ctx.tenantId],
    );
    return res.rows;
  }

  /**
   * Resolve an attachment file download request and generate a safe access payload.
   */
  static async getAttachmentDownload(
    tx: TenantTx,
    ctx: TrustedContext,
    fileId: string,
  ): Promise<AttachmentDownloadResponse> {
    ensureTrusted(ctx);

    // Look up file in homework attachments or homework submission files
    const attRes = await tx.query<{
      fileName: string;
      fileSizeBytes: number;
      mimeType: string;
      homeworkId: string;
    }>(
      `SELECT file_name AS "fileName", file_size_bytes::int AS "fileSizeBytes", mime_type AS "mimeType", homework_id AS "homeworkId"
         FROM app.homework_attachments
        WHERE organization_id = $1 AND file_id = $2
        LIMIT 1`,
      [ctx.tenantId, fileId],
    );

    let fileName: string;
    let fileSizeBytes: number;
    let mimeType: string;

    if (attRes.rows[0]) {
      const homeworkId = attRes.rows[0].homeworkId;
      if (AuthorizationEngine.isStudentActor(ctx)) {
        const stuRes = await tx.query<{ id: string }>(
          `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
          [ctx.tenantId, ctx.userId],
        );
        if (!stuRes.rows[0]) {
          throw new AppError(403, 'Student profile not found', 'STUDENT_NOT_FOUND');
        }
        const studentId = stuRes.rows[0].id;
        const hwEnrolled = await tx.query(
          `SELECT hw.id
             FROM app.homework_assignments hw
             JOIN app.course_registrations r ON r.organization_id = hw.organization_id AND r.course_offering_id = hw.course_offering_id
             LEFT JOIN app.section_memberships sm ON sm.organization_id = r.organization_id
                  AND sm.term_enrollment_id = r.term_enrollment_id AND sm.valid_to IS NULL
            WHERE hw.organization_id = $1 AND hw.id = $2 AND r.student_id = $3
              AND (hw.section_id IS NULL OR hw.section_id = sm.section_id)
              AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED', 'DROPPED', 'WITHDRAWN')
              AND r.valid_from <= CURRENT_DATE AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)`,
          [ctx.tenantId, homeworkId, studentId],
        );
        if (!hwEnrolled.rows[0]) {
          throw new AppError(
            403,
            'FORBIDDEN_SECTION',
            'Access denied: student is not enrolled in this section',
          );
        }
      }
      fileName = attRes.rows[0].fileName;
      fileSizeBytes = attRes.rows[0].fileSizeBytes;
      mimeType = attRes.rows[0].mimeType;
    } else {
      // Check submission files
      const subRes = await tx.query<{
        fileName: string;
        fileSizeBytes: number;
        mimeType: string;
      }>(
        `SELECT file_name AS "fileName", file_size_bytes::int AS "fileSizeBytes", mime_type AS "mimeType"
           FROM app.homework_submission_files
          WHERE organization_id = $1 AND file_id = $2
          LIMIT 1`,
        [ctx.tenantId, fileId],
      );
      if (!subRes.rows[0]) {
        // Fallback to checking app.files
        const fileRes = await tx.query<{
          original_name: string;
          size_bytes: number;
          detected_mime: string;
        }>(
          `SELECT original_name, coalesce(size_bytes, 0)::int AS size_bytes,
                  coalesce(detected_mime, declared_mime, 'application/octet-stream') AS detected_mime
             FROM app.files
            WHERE organization_id = $1 AND id = $2 AND status = 'AVAILABLE'`,
          [ctx.tenantId, fileId],
        );
        if (!fileRes.rows[0]) {
          throw new AppError(404, 'Attachment not found', 'ATTACHMENT_NOT_FOUND');
        }
        fileName = fileRes.rows[0].original_name;
        fileSizeBytes = fileRes.rows[0].size_bytes;
        mimeType = fileRes.rows[0].detected_mime;
      } else {
        fileName = subRes.rows[0].fileName;
        fileSizeBytes = subRes.rows[0].fileSizeBytes;
        mimeType = subRes.rows[0].mimeType;
      }
    }

    return {
      fileId,
      fileName,
      mimeType,
      fileSizeBytes,
      downloadUrl: `/api/v1/homework/attachments/${fileId}/content`,
    };
  }
}
