import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { NotificationService } from '../notifications/notification.service.js';
import type {
  PromotionPolicy,
  UpdatePromotionPolicyBody,
  RolloverPreviewBody,
  RolloverBatchDto,
  RolloverBatchSummaryDto,
  RolloverStudentEvaluation,
  RolloverExceptionsBody,
  RolloverExecuteBody,
  RolloverExecuteResult,
  PromotionOutcome,
} from './promotion.schemas.js';

const SETTINGS_KEY_POLICY = 'academic.promotion_policy';
const SETTINGS_PREFIX_BATCH = 'academic.rollover_batch:';
const SETTINGS_KEY_BATCHES_INDEX = 'academic.rollover_batches';

const DEFAULT_POLICY: PromotionPolicy = {
  mode: 'PRINCIPAL_APPROVAL',
  minimumAggregatePercentage: 33.0,
  minimumSubjectPercentage: 33.0,
  maxFailingSubjectsForSupplementary: 2,
  graceMarksPolicy: {
    enabled: true,
    maxGraceMarksTotal: 5,
    maxGraceMarksPerSubject: 3,
  },
  attendanceRequirement: {
    enabled: false,
    minimumAttendancePercentage: 75.0,
  },
  streamSelectionPeriodNo: 10,
  terminalPeriodNo: 12,
  notifyGuardians: true,
};

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

function conflict(msg: string): AppError {
  return new AppError(409, 'CONFLICT', msg);
}

function notFound(msg: string): AppError {
  return new AppError(404, 'NOT_FOUND', msg);
}

export class PromotionService {
  /**
   * Retrieves the configured promotion policy for the current institution, falling back to defaults.
   */
  static async getPolicy(tx: TenantTx, ctx: TrustedContext): Promise<PromotionPolicy> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.read');

    const res = await tx.query<{ value: Partial<PromotionPolicy> }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, SETTINGS_KEY_POLICY],
    );

    if (!res.rows[0]?.value) {
      return { ...DEFAULT_POLICY };
    }

    const val = res.rows[0].value;
    return {
      mode: val.mode ?? DEFAULT_POLICY.mode,
      minimumAggregatePercentage:
        val.minimumAggregatePercentage ?? DEFAULT_POLICY.minimumAggregatePercentage,
      minimumSubjectPercentage:
        val.minimumSubjectPercentage ?? DEFAULT_POLICY.minimumSubjectPercentage,
      maxFailingSubjectsForSupplementary:
        val.maxFailingSubjectsForSupplementary ??
        DEFAULT_POLICY.maxFailingSubjectsForSupplementary,
      graceMarksPolicy: {
        enabled: val.graceMarksPolicy?.enabled ?? DEFAULT_POLICY.graceMarksPolicy.enabled,
        maxGraceMarksTotal:
          val.graceMarksPolicy?.maxGraceMarksTotal ??
          DEFAULT_POLICY.graceMarksPolicy.maxGraceMarksTotal,
        maxGraceMarksPerSubject:
          val.graceMarksPolicy?.maxGraceMarksPerSubject ??
          DEFAULT_POLICY.graceMarksPolicy.maxGraceMarksPerSubject,
      },
      attendanceRequirement: {
        enabled:
          val.attendanceRequirement?.enabled ?? DEFAULT_POLICY.attendanceRequirement.enabled,
        minimumAttendancePercentage:
          val.attendanceRequirement?.minimumAttendancePercentage ??
          DEFAULT_POLICY.attendanceRequirement.minimumAttendancePercentage,
      },
      streamSelectionPeriodNo:
        val.streamSelectionPeriodNo ?? DEFAULT_POLICY.streamSelectionPeriodNo,
      terminalPeriodNo: val.terminalPeriodNo ?? DEFAULT_POLICY.terminalPeriodNo,
      notifyGuardians: val.notifyGuardians ?? DEFAULT_POLICY.notifyGuardians,
    };
  }

  /**
   * Saves / updates the institution promotion policy.
   */
  static async savePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    input: UpdatePromotionPolicyBody,
    meta?: AuditRequestMeta,
  ): Promise<PromotionPolicy> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.manage');

    const current = await this.getPolicy(tx, ctx);
    const updated: PromotionPolicy = {
      mode: input.mode ?? current.mode,
      minimumAggregatePercentage:
        input.minimumAggregatePercentage ?? current.minimumAggregatePercentage,
      minimumSubjectPercentage:
        input.minimumSubjectPercentage ?? current.minimumSubjectPercentage,
      maxFailingSubjectsForSupplementary:
        input.maxFailingSubjectsForSupplementary ??
        current.maxFailingSubjectsForSupplementary,
      graceMarksPolicy: {
        enabled: input.graceMarksPolicy?.enabled ?? current.graceMarksPolicy.enabled,
        maxGraceMarksTotal:
          input.graceMarksPolicy?.maxGraceMarksTotal ??
          current.graceMarksPolicy.maxGraceMarksTotal,
        maxGraceMarksPerSubject:
          input.graceMarksPolicy?.maxGraceMarksPerSubject ??
          current.graceMarksPolicy.maxGraceMarksPerSubject,
      },
      attendanceRequirement: {
        enabled:
          input.attendanceRequirement?.enabled ?? current.attendanceRequirement.enabled,
        minimumAttendancePercentage:
          input.attendanceRequirement?.minimumAttendancePercentage ??
          current.attendanceRequirement.minimumAttendancePercentage,
      },
      streamSelectionPeriodNo:
        input.streamSelectionPeriodNo ?? current.streamSelectionPeriodNo,
      terminalPeriodNo: input.terminalPeriodNo ?? current.terminalPeriodNo,
      notifyGuardians: input.notifyGuardians ?? current.notifyGuardians,
    };

    await tx.query(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [ctx.tenantId, SETTINGS_KEY_POLICY, JSON.stringify(updated), ctx.userId],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.promotion_policy.update',
        resourceType: 'organization_settings',
        resourceId: uuidv7(),
        riskTier: 2,
        reasonText: 'Updated institution academic promotion and session rollover policy',
        changes: { old: current, new: updated },
      },
      meta,
    );

    return updated;
  }

  /**
   * Generates a comprehensive promotion & rollover preview for a target session.
   * Calculates exam marks, checks safety gates, and categorizes students into 4 buckets:
   * PROMOTED, RETAINED, PENDING_REVIEW, GRADUATED.
   */
  static async generatePreview(
    tx: TenantTx,
    ctx: TrustedContext,
    input: RolloverPreviewBody,
    meta?: AuditRequestMeta,
  ): Promise<RolloverBatchDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.manage');

    const { sourceTermId, targetTermId, cohortPeriodIds, streamPreferences } = input;

    // 1. Verify source and target terms
    interface TermRow {
      id: string;
      code: string;
      name: string;
      start_date: string;
      end_date: string;
      academic_year_id: string;
      academic_year_label: string;
      status: string;
    }
    const termsRes = await tx.query<TermRow>(
      `SELECT t.id, t.code, t.name, t.start_date::text AS start_date, t.end_date::text AS end_date,
              t.academic_year_id, ay.label AS academic_year_label, t.status
         FROM app.terms t
         JOIN app.academic_years ay ON ay.organization_id = t.organization_id AND ay.id = t.academic_year_id
        WHERE t.organization_id = $1 AND t.id IN ($2, $3)`,
      [ctx.tenantId, sourceTermId, targetTermId],
    );

    const sourceTermRow = termsRes.rows.find((r) => r.id === sourceTermId);
    const targetTermRow = termsRes.rows.find((r) => r.id === targetTermId);

    if (!sourceTermRow) throw notFound('Source academic term not found.');
    if (!targetTermRow) throw notFound('Target academic term not found.');

    if (targetTermRow.status !== 'PLANNED' && targetTermRow.status !== 'ACTIVE') {
      throw conflict(`Target term must be in PLANNED or ACTIVE status; got ${targetTermRow.status}.`);
    }

    if (targetTermRow.start_date <= sourceTermRow.start_date) {
      throw conflict('The target academic session must start after the source academic session.');
    }

    // 2. Load policy
    const policy = await this.getPolicy(tx, ctx);

    // 3. Query active student term enrollments in source term
    interface EnrollmentStudentRow {
      enrollment_id: string;
      student_id: string;
      cohort_period_id: string;
      period_no: number;
      student_program_id: string;
      roll_number: string | null;
      admission_number: string;
      full_name: string;
      cohort_id: string;
      program_id: string;
      duration_periods: number;
      current_section_id: string | null;
      current_section_name: string | null;
    }

    const studentsRes = await tx.query<EnrollmentStudentRow>(
      `SELECT te.id AS enrollment_id,
              te.student_id,
              te.cohort_period_id,
              te.period_no,
              te.student_program_id,
              te.roll_number,
              s.admission_number,
              u.display_name AS full_name,
              cp.cohort_id,
              p.id AS program_id,
              p.duration_periods,
              sm.section_id AS current_section_id,
              sec.name AS current_section_name
         FROM app.term_enrollments te
         JOIN app.students s ON s.organization_id = te.organization_id AND s.id = te.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN app.cohort_periods cp ON cp.organization_id = te.organization_id AND cp.id = te.cohort_period_id
         JOIN app.cohorts c ON c.organization_id = cp.organization_id AND c.id = cp.cohort_id
         JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
         LEFT JOIN app.section_memberships sm
           ON sm.organization_id = te.organization_id
          AND sm.term_enrollment_id = te.id
          AND sm.valid_to IS NULL
         LEFT JOIN app.sections sec
           ON sec.organization_id = sm.organization_id
          AND sec.id = sm.section_id
        WHERE te.organization_id = $1
          AND te.term_id = $2
          AND te.status IN ('REGISTERED', 'ACTIVE')
          AND ($3::uuid[] IS NULL OR te.cohort_period_id = ANY($3::uuid[]))
        ORDER BY te.period_no ASC, s.admission_number ASC`,
      [ctx.tenantId, sourceTermId, cohortPeriodIds ?? null],
    );

    const sourceStudents = studentsRes.rows;

    // 4. Query target cohort periods and sections in target term
    interface TargetCohortPeriodRow {
      cohort_period_id: string;
      cohort_id: string;
      period_no: number;
      program_id: string;
      section_id: string | null;
      section_name: string | null;
    }

    const targetCpsRes = await tx.query<TargetCohortPeriodRow>(
      `SELECT cp.id AS cohort_period_id,
              cp.cohort_id,
              cp.period_no,
              co.program_id,
              s.id AS section_id,
              s.name AS section_name
         FROM app.cohort_periods cp
         JOIN app.cohorts co ON co.organization_id = cp.organization_id AND co.id = cp.cohort_id
         LEFT JOIN app.sections s
           ON s.organization_id = cp.organization_id
          AND s.cohort_period_id = cp.id
          AND s.status = 'ACTIVE'
        WHERE cp.organization_id = $1
          AND cp.term_id = $2
          AND cp.status = 'ACTIVE'`,
      [ctx.tenantId, targetTermId],
    );

    // Group target cohort periods by (cohort_id, period_no) and also by (program_id, period_no)
    const targetCps = targetCpsRes.rows;

    // 5. Query examination schedules and marks for the source term
    interface ExamScheduleRow {
      schedule_id: string;
      schedule_status: string;
      max_marks: number;
      pass_marks: number;
      course_id: string;
      course_code: string;
      course_title: string;
      cohort_period_id: string | null;
    }

    const schedulesRes = await tx.query<ExamScheduleRow>(
      `SELECT es.id AS schedule_id,
              es.status AS schedule_status,
              es.max_marks::numeric::float8 AS max_marks,
              es.pass_marks::numeric::float8 AS pass_marks,
              c.id AS course_id,
              c.code AS course_code,
              c.title AS course_title,
              co.cohort_period_id
         FROM app.exam_schedules es
         JOIN app.examinations e ON e.organization_id = es.organization_id AND e.id = es.examination_id
         JOIN app.course_offerings co ON co.organization_id = es.organization_id AND co.id = es.course_offering_id
         JOIN app.courses c ON c.organization_id = co.organization_id AND c.id = co.course_id
        WHERE es.organization_id = $1
          AND (e.term_id = $2 OR co.term_id = $2)`,
      [ctx.tenantId, sourceTermId],
    );
    const schedules = schedulesRes.rows;
    const scheduleIds = schedules.map((s) => s.schedule_id);

    interface ExamMarkRow {
      exam_schedule_id: string;
      student_id: string;
      marks_obtained: number | null;
      status: string;
      is_passing: boolean | null;
    }

    let marks: ExamMarkRow[] = [];
    if (scheduleIds.length > 0) {
      const marksRes = await tx.query<ExamMarkRow>(
        `SELECT em.exam_schedule_id,
                em.student_id,
                em.marks_obtained::numeric::float8 AS marks_obtained,
                em.status,
                em.is_passing
           FROM app.exam_marks em
          WHERE em.organization_id = $1
            AND em.exam_schedule_id = ANY($2::uuid[])`,
        [ctx.tenantId, scheduleIds],
      );
      marks = marksRes.rows;
    }

    // Map stream preferences if provided
    const streamMap = new Map<string, { targetCohortPeriodId: string; targetSectionId?: string }>();
    if (streamPreferences) {
      for (const pref of streamPreferences) {
        if (pref.targetSectionId !== undefined) {
          streamMap.set(pref.studentId, {
            targetCohortPeriodId: pref.targetCohortPeriodId,
            targetSectionId: pref.targetSectionId,
          });
        } else {
          streamMap.set(pref.studentId, {
            targetCohortPeriodId: pref.targetCohortPeriodId,
          });
        }
      }
    }

    // 6. Evaluate each student
    const studentEvaluations: RolloverStudentEvaluation[] = [];

    for (const student of sourceStudents) {
      const studentMarks = marks.filter((m) => m.student_id === student.student_id);
      const notes: string[] = [];

      let hasUnpublishedExams = false;
      let hasMissingMarks = false;
      let hasWithheldMarks = false;

      // Filter schedules that apply to this student's cohort period
      const studentSchedules = schedules.filter(
        (sch) =>
          sch.cohort_period_id === null || sch.cohort_period_id === student.cohort_period_id,
      );

      // Check if student has marks for schedules
      let totalMarksObtained = 0;
      let totalMaxMarks = 0;
      let failingSubjects = 0;
      let appliedGraceMarks = 0;

      // If schedules exist for this student:
      if (studentSchedules.length > 0) {
        // Inspect schedules
        for (const sch of studentSchedules) {
          if (sch.schedule_status !== 'PUBLISHED' && sch.schedule_status !== 'CANCELLED') {
            hasUnpublishedExams = true;
            notes.push(`Exam schedule ${sch.course_code} is ${sch.schedule_status} (not published).`);
          }

          const mark = studentMarks.find((m) => m.exam_schedule_id === sch.schedule_id);
          if (!mark && sch.schedule_status === 'PUBLISHED') {
            hasMissingMarks = true;
            notes.push(`Missing marks for course ${sch.course_code}.`);
          } else if (mark) {
            if (mark.status === 'WITHHELD') {
              hasWithheldMarks = true;
              notes.push(`Marks withheld for course ${sch.course_code}.`);
            } else if (mark.status === 'DRAFT') {
              hasMissingMarks = true;
              notes.push(`Marks in draft for course ${sch.course_code}.`);
            } else if (mark.status === 'EXEMPT') {
              notes.push(`Exempt from course ${sch.course_code}.`);
            } else if (mark.status === 'ABSENT') {
              totalMaxMarks += sch.max_marks;
              failingSubjects++;
              notes.push(`Absent for course ${sch.course_code}.`);
            } else if (mark.status === 'SUBMITTED' && mark.marks_obtained !== null) {
              totalMaxMarks += sch.max_marks;
              let subjectMarks = mark.marks_obtained;
              const subjectPercentage = (subjectMarks / sch.max_marks) * 100;
              const isSubjectPassing =
                subjectPercentage >= policy.minimumSubjectPercentage &&
                subjectMarks >= sch.pass_marks;

              if (!isSubjectPassing) {
                // Check if grace marks can be applied
                const neededMarks = Math.max(
                  sch.pass_marks - subjectMarks,
                  (policy.minimumSubjectPercentage / 100) * sch.max_marks - subjectMarks,
                );
                if (
                  policy.graceMarksPolicy.enabled &&
                  neededMarks <= policy.graceMarksPolicy.maxGraceMarksPerSubject &&
                  appliedGraceMarks + neededMarks <= policy.graceMarksPolicy.maxGraceMarksTotal
                ) {
                  appliedGraceMarks += neededMarks;
                  subjectMarks += neededMarks;
                  notes.push(
                    `Applied ${neededMarks.toFixed(1)} grace marks for ${sch.course_code}.`,
                  );
                } else {
                  failingSubjects++;
                  notes.push(
                    `Failed ${sch.course_code} (${subjectPercentage.toFixed(1)}% vs req ${policy.minimumSubjectPercentage}%).`,
                  );
                }
              }
              totalMarksObtained += subjectMarks;
            }
          }
        }
      }

      // Aggregate percentage
      let aggregatePercentage: number | null = null;
      if (totalMaxMarks > 0) {
        aggregatePercentage = parseFloat(
          ((totalMarksObtained / totalMaxMarks) * 100).toFixed(2),
        );
      }

      // Safety Gates Check
      let recommendedOutcome: PromotionOutcome;
      if (hasUnpublishedExams || hasMissingMarks || hasWithheldMarks) {
        recommendedOutcome = 'PENDING_REVIEW';
        if (hasUnpublishedExams) notes.unshift('Safety Gate: Unpublished examinations pending.');
        if (hasMissingMarks) notes.unshift('Safety Gate: Missing or draft marks found.');
        if (hasWithheldMarks) notes.unshift('Safety Gate: Results withheld.');
      } else if (totalMaxMarks === 0) {
        // No formal exams in term; continuous progression
        if (student.period_no >= policy.terminalPeriodNo) {
          recommendedOutcome = 'GRADUATED';
          notes.push('Class 12 terminal program completion.');
        } else {
          recommendedOutcome = 'PROMOTED';
          notes.push('Continuous assessment progression.');
        }
      } else {
        const isAggregatePassing =
          aggregatePercentage !== null &&
          aggregatePercentage >= policy.minimumAggregatePercentage;

        if (failingSubjects === 0 && isAggregatePassing) {
          if (student.period_no >= policy.terminalPeriodNo) {
            recommendedOutcome = 'GRADUATED';
            notes.push(`Terminal Class ${student.period_no} graduated successfully.`);
          } else {
            recommendedOutcome = 'PROMOTED';
            notes.push(`Promoted with ${aggregatePercentage}% aggregate.`);
          }
        } else if (
          failingSubjects > 0 &&
          failingSubjects <= policy.maxFailingSubjectsForSupplementary
        ) {
          recommendedOutcome = 'PENDING_REVIEW';
          notes.push(
            `Eligible for supplementary examination in ${failingSubjects} subject(s).`,
          );
        } else {
          recommendedOutcome = 'RETAINED';
          notes.push(
            `Retained: Failed ${failingSubjects} subject(s) or aggregate ${aggregatePercentage}% below ${policy.minimumAggregatePercentage}%.`,
          );
        }
      }

      // Target Placement Resolution
      let targetCohortPeriodId: string | null = null;
      let targetPeriodNo: number | null = null;
      let targetSectionId: string | null = null;
      let targetSectionName: string | null = null;

      if (recommendedOutcome === 'PROMOTED') {
        const nextPeriodNo = student.period_no + 1;
        targetPeriodNo = nextPeriodNo;

        // Check if stream selection routing is needed
        if (student.period_no === policy.streamSelectionPeriodNo) {
          const streamPref = streamMap.get(student.student_id);
          if (streamPref) {
            targetCohortPeriodId = streamPref.targetCohortPeriodId;
            targetSectionId = streamPref.targetSectionId ?? null;
            notes.push('Stream preference applied.');
          } else {
            notes.push('Class 10 stream selection required.');
          }
        }

        // Default to same cohort next period if not already set by stream
        if (!targetCohortPeriodId) {
          const matchCp = targetCps.find(
            (cp) => cp.cohort_id === student.cohort_id && cp.period_no === nextPeriodNo,
          );
          if (matchCp) {
            targetCohortPeriodId = matchCp.cohort_period_id;
            // Match section name if exists in target cohort period
            if (student.current_section_name) {
              const matchSec = targetCps.find(
                (cp) =>
                  cp.cohort_period_id === matchCp.cohort_period_id &&
                  cp.section_name === student.current_section_name,
              );
              if (matchSec?.section_id) {
                targetSectionId = matchSec.section_id;
                targetSectionName = matchSec.section_name;
              }
            }
          }
        }
      } else if (recommendedOutcome === 'RETAINED') {
        // Repeating keeps the same period_no in a later/junior cohort of the same program
        targetPeriodNo = student.period_no;
        const matchCp = targetCps.find(
          (cp) => cp.program_id === student.program_id && cp.period_no === student.period_no,
        );
        if (matchCp) {
          targetCohortPeriodId = matchCp.cohort_period_id;
          if (student.current_section_name) {
            const matchSec = targetCps.find(
              (cp) =>
                cp.cohort_period_id === matchCp.cohort_period_id &&
                cp.section_name === student.current_section_name,
            );
            if (matchSec?.section_id) {
              targetSectionId = matchSec.section_id;
              targetSectionName = matchSec.section_name;
            }
          }
        }
      }

      studentEvaluations.push({
        studentId: student.student_id,
        enrollmentId: student.enrollment_id,
        fullName: student.full_name,
        admissionNumber: student.admission_number,
        currentCohortPeriodId: student.cohort_period_id,
        currentPeriodNo: student.period_no,
        currentSectionId: student.current_section_id,
        currentSectionName: student.current_section_name,
        targetCohortPeriodId,
        targetPeriodNo,
        targetSectionId,
        targetSectionName,
        recommendedOutcome,
        finalOutcome: recommendedOutcome,
        overrideReason: null,
        overrideBy: null,
        evaluationDetails: {
          aggregatePercentage,
          totalMarksObtained,
          totalMaxMarks,
          failingSubjectCount: failingSubjects,
          hasUnpublishedExams,
          hasMissingMarks,
          hasWithheldMarks,
          appliedGraceMarks,
          attendancePercentage: null,
          notes,
        },
      });
    }

    // 7. Aggregate counts
    const summary = {
      totalStudents: studentEvaluations.length,
      promoted: studentEvaluations.filter((s) => s.finalOutcome === 'PROMOTED').length,
      retained: studentEvaluations.filter((s) => s.finalOutcome === 'RETAINED').length,
      pendingReview: studentEvaluations.filter((s) => s.finalOutcome === 'PENDING_REVIEW').length,
      graduated: studentEvaluations.filter((s) => s.finalOutcome === 'GRADUATED').length,
    };

    // Determine initial batch status
    let initialStatus: RolloverBatchDto['status'] = 'PREVIEW';
    if (policy.mode === 'PRINCIPAL_APPROVAL') {
      initialStatus = 'PENDING_APPROVAL';
    } else if (policy.mode === 'AUTOMATIC') {
      initialStatus = summary.pendingReview === 0 ? 'APPROVED' : 'PENDING_APPROVAL';
    }

    const batchId = uuidv7();
    const nowIso = new Date().toISOString();

    const batchDto: RolloverBatchDto = {
      batchId,
      status: initialStatus,
      sourceTerm: {
        id: sourceTermRow.id,
        name: sourceTermRow.name,
        code: sourceTermRow.code,
        startDate: sourceTermRow.start_date,
        endDate: sourceTermRow.end_date,
        academicYearId: sourceTermRow.academic_year_id,
        academicYearLabel: sourceTermRow.academic_year_label,
      },
      targetTerm: {
        id: targetTermRow.id,
        name: targetTermRow.name,
        code: targetTermRow.code,
        startDate: targetTermRow.start_date,
        endDate: targetTermRow.end_date,
        academicYearId: targetTermRow.academic_year_id,
        academicYearLabel: targetTermRow.academic_year_label,
      },
      policy,
      summary,
      students: studentEvaluations,
      createdAt: nowIso,
      createdBy: ctx.userId,
      approvedAt: initialStatus === 'APPROVED' ? nowIso : null,
      approvedBy: initialStatus === 'APPROVED' ? ctx.userId : null,
      executedAt: null,
      executedBy: null,
    };

    // 8. Persist batch
    await this.persistBatch(tx, ctx, batchDto);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.session.rollover_preview',
        resourceType: 'rollover_batch',
        resourceId: batchId,
        riskTier: 1,
        reasonText: `Generated session rollover preview from ${sourceTermRow.code} to ${targetTermRow.code}`,
        changes: { summary },
      },
      meta,
    );

    return batchDto;
  }

  /**
   * Updates student exceptions/overrides for an unexecuted batch.
   */
  static async updateExceptions(
    tx: TenantTx,
    ctx: TrustedContext,
    batchId: string,
    input: RolloverExceptionsBody,
    meta?: AuditRequestMeta,
  ): Promise<RolloverBatchDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.manage');

    const batch = await this.getBatch(tx, ctx, batchId);
    if (!batch) throw notFound('Rollover batch not found.');

    if (batch.status === 'EXECUTED') {
      throw conflict('Cannot modify exceptions on an already executed rollover batch.');
    }

    const { exceptions } = input;
    const studentMap = new Map<string, RolloverStudentEvaluation>();
    for (const student of batch.students) {
      studentMap.set(student.studentId, student);
    }

    for (const exc of exceptions) {
      const student = studentMap.get(exc.studentId);
      if (!student) {
        throw notFound(`Student ${exc.studentId} not found in this rollover batch.`);
      }

      student.finalOutcome = exc.outcome;
      student.overrideReason = exc.reason;
      student.overrideBy = ctx.userId;

      if (exc.targetCohortPeriodId !== undefined) {
        student.targetCohortPeriodId = exc.targetCohortPeriodId;
      }
      if (exc.targetSectionId !== undefined) {
        student.targetSectionId = exc.targetSectionId;
      }
    }

    // Recompute summary
    batch.summary = {
      totalStudents: batch.students.length,
      promoted: batch.students.filter((s) => s.finalOutcome === 'PROMOTED').length,
      retained: batch.students.filter((s) => s.finalOutcome === 'RETAINED').length,
      pendingReview: batch.students.filter((s) => s.finalOutcome === 'PENDING_REVIEW').length,
      graduated: batch.students.filter((s) => s.finalOutcome === 'GRADUATED').length,
    };

    // If Principal / admin updated exceptions, set status to APPROVED
    batch.status = 'APPROVED';
    batch.approvedAt = new Date().toISOString();
    batch.approvedBy = ctx.userId;

    await this.persistBatch(tx, ctx, batch);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.session.rollover_exceptions',
        resourceType: 'rollover_batch',
        resourceId: batchId,
        riskTier: 2,
        reasonText: `Updated ${exceptions.length} exception(s) for rollover batch ${batchId}`,
        changes: { exceptionsCount: exceptions.length, newSummary: batch.summary },
      },
      meta,
    );

    return batch;
  }

  /**
   * Executes the approved rollover batch idempotently.
   */
  private static async applyBatch(
    tx: TenantTx,
    ctx: TrustedContext,
    batch: RolloverBatchDto,
    meta?: AuditRequestMeta,
    input: RolloverExecuteBody = { batchId: batch.batchId },
  ): Promise<RolloverExecuteResult> {
    // 1. Lock all participating students deterministically
    const studentIds = batch.students.map((s) => s.studentId).sort();
    if (studentIds.length > 0) {
      await tx.query(
        `SELECT 1 FROM app.students
          WHERE organization_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id FOR NO KEY UPDATE`,
        [ctx.tenantId, studentIds],
      );
    }

    let promotedCount = 0;
    let retainedCount = 0;
    let graduatedCount = 0;
    let skippedCount = 0;

    const targetStartDate = batch.targetTerm.startDate;
    const sourceEndDate = batch.sourceTerm.endDate;

    // 2. Execute transitions
    for (const student of batch.students) {
      if (student.finalOutcome === 'PENDING_REVIEW') {
        skippedCount++;
        continue;
      }

      if (student.finalOutcome === 'PROMOTED') {
        if (!student.targetCohortPeriodId) {
          skippedCount++;
          continue;
        }

        // a. Close old term enrollment
        const upd = await tx.query(
          `UPDATE app.term_enrollments
              SET status = 'PROMOTED'
            WHERE organization_id = $1
              AND id = $2
              AND status IN ('ACTIVE', 'REGISTERED')`,
          [ctx.tenantId, student.enrollmentId],
        );

        if (upd.rowCount === 1) {
          // b. Close open section memberships
          await tx.query(
            `UPDATE app.section_memberships
                SET valid_to = GREATEST(valid_from, $3::date)
              WHERE organization_id = $1
                AND term_enrollment_id = $2
                AND valid_to IS NULL`,
            [ctx.tenantId, student.enrollmentId, sourceEndDate],
          );

          // c. Insert target term enrollment
          const newEnrollmentId = uuidv7();
          await tx.query(
            `INSERT INTO app.term_enrollments
               (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no,
                enrollment_type, roll_number, status)
             SELECT $1::uuid, $2::uuid, te.student_id, te.student_program_id, $4::uuid, $5::uuid, $6::smallint,
                    'REGULAR', te.roll_number, 'REGISTERED'
               FROM app.term_enrollments te
              WHERE te.organization_id = $2::uuid AND te.id = $3::uuid`,
            [
              newEnrollmentId,
              ctx.tenantId,
              student.enrollmentId,
              student.targetCohortPeriodId,
              batch.targetTerm.id,
              student.targetPeriodNo ?? student.currentPeriodNo + 1,
            ],
          );

          // d. Place in target section if designated
          if (student.targetSectionId) {
            await tx.query(
              `INSERT INTO app.section_memberships
                 (id, organization_id, term_enrollment_id, student_id, cohort_period_id, section_id,
                  valid_from, change_reason, changed_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'Session rollover promotion', $8)`,
              [
                uuidv7(),
                ctx.tenantId,
                newEnrollmentId,
                student.studentId,
                student.targetCohortPeriodId,
                student.targetSectionId,
                targetStartDate,
                ctx.userId,
              ],
            );
          }

          promotedCount++;
        }
      } else if (student.finalOutcome === 'RETAINED') {
        // a. Close old term enrollment
        const upd = await tx.query(
          `UPDATE app.term_enrollments
              SET status = 'COMPLETED'
            WHERE organization_id = $1
              AND id = $2
              AND status IN ('ACTIVE', 'REGISTERED', 'DETAINED')`,
          [ctx.tenantId, student.enrollmentId],
        );

        if (upd.rowCount === 1) {
          // b. Close open section memberships
          await tx.query(
            `UPDATE app.section_memberships
                SET valid_to = GREATEST(valid_from, $3::date)
              WHERE organization_id = $1
                AND term_enrollment_id = $2
                AND valid_to IS NULL`,
            [ctx.tenantId, student.enrollmentId, sourceEndDate],
          );

          // c. Insert repeat term enrollment if target cohort period exists
          if (student.targetCohortPeriodId) {
            const newEnrollmentId = uuidv7();
            await tx.query(
              `INSERT INTO app.term_enrollments
                 (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no,
                  enrollment_type, roll_number, status)
               SELECT $1::uuid, $2::uuid, te.student_id, te.student_program_id, $4::uuid, $5::uuid, $6::smallint,
                      'REPEAT', te.roll_number, 'REGISTERED'
                 FROM app.term_enrollments te
                WHERE te.organization_id = $2::uuid AND te.id = $3::uuid`,
              [
                newEnrollmentId,
                ctx.tenantId,
                student.enrollmentId,
                student.targetCohortPeriodId,
                batch.targetTerm.id,
                student.targetPeriodNo ?? student.currentPeriodNo,
              ],
            );

            if (student.targetSectionId) {
              await tx.query(
                `INSERT INTO app.section_memberships
                   (id, organization_id, term_enrollment_id, student_id, cohort_period_id, section_id,
                    valid_from, change_reason, changed_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'Session rollover repeat retention', $8)`,
                [
                  uuidv7(),
                  ctx.tenantId,
                  newEnrollmentId,
                  student.studentId,
                  student.targetCohortPeriodId,
                  student.targetSectionId,
                  targetStartDate,
                  ctx.userId,
                ],
              );
            }
          }

          retainedCount++;
        }
      } else if (student.finalOutcome === 'GRADUATED') {
        // a. Close old term enrollment
        const upd = await tx.query(
          `UPDATE app.term_enrollments
              SET status = 'COMPLETED'
            WHERE organization_id = $1
              AND id = $2
              AND status IN ('ACTIVE', 'REGISTERED')`,
          [ctx.tenantId, student.enrollmentId],
        );

        if (upd.rowCount === 1) {
          // b. Close open section memberships
          await tx.query(
            `UPDATE app.section_memberships
                SET valid_to = GREATEST(valid_from, $3::date)
              WHERE organization_id = $1
                AND term_enrollment_id = $2
                AND valid_to IS NULL`,
            [ctx.tenantId, student.enrollmentId, sourceEndDate],
          );

          // c. Complete student program
          await tx.query(
            `UPDATE app.student_programs
                SET status = 'COMPLETED', end_date = $3::date, exit_reason = 'Graduated'
              WHERE organization_id = $1
                AND student_id = $2
                AND status = 'ACTIVE'`,
            [ctx.tenantId, student.studentId, sourceEndDate],
          );

          graduatedCount++;
        }
      }
    }

    // 3. Mark batch executed
    const executedAt = new Date().toISOString();
    batch.status = 'EXECUTED';
    batch.executedAt = executedAt;
    batch.executedBy = ctx.userId;

    await this.persistBatch(tx, ctx, batch);

    // 4. Notifications if enabled
    if (batch.policy.notifyGuardians && (input.notifyGuardians ?? true)) {
      try {
        await this.dispatchRolloverNotifications(tx, ctx, batch);
      } catch {
        // Do not abort rollover if notification dispatch encounters non-fatal network/provider issues
      }
    }

    // 5. Audit event
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.session.rollover',
        resourceType: 'rollover_batch',
        resourceId: batch.batchId,
        riskTier: 3,
        reasonText: `Executed academic session rollover from ${batch.sourceTerm.code} to ${batch.targetTerm.code}`,
        changes: {
          promotedCount,
          retainedCount,
          graduatedCount,
          skippedCount,
        },
      },
      meta,
    );

    return {
      batchId: batch.batchId,
      executedAt,
      promotedCount,
      retainedCount,
      graduatedCount,
      skippedCount,
    };
  }

  /**
   * Executes the approved rollover batch idempotently.
   */
  static async executeRollover(
    tx: TenantTx,
    ctx: TrustedContext,
    input: RolloverExecuteBody,
    meta?: AuditRequestMeta,
  ): Promise<RolloverExecuteResult> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.manage');

    const { batchId } = input;
    const batch = await this.getBatch(tx, ctx, batchId);
    if (!batch) throw notFound('Rollover batch not found.');

    if (batch.status === 'EXECUTED') {
      return {
        batchId: batch.batchId,
        executedAt: batch.executedAt ?? new Date().toISOString(),
        promotedCount: batch.summary.promoted,
        retainedCount: batch.summary.retained,
        graduatedCount: batch.summary.graduated,
        skippedCount: batch.summary.pendingReview,
      };
    }

    // 2. Execution Logic
    const result = await this.applyBatch(tx, ctx, batch, meta);

    return result;
  }

  /**
   * Lists past and active rollover batches.
   */
  static async listBatches(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<RolloverBatchSummaryDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.read');

    const res = await tx.query<{ value: RolloverBatchSummaryDto[] }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, SETTINGS_KEY_BATCHES_INDEX],
    );

    return res.rows[0]?.value ?? [];
  }

  /**
   * Retrieves single batch details.
   */
  static async getBatch(
    tx: TenantTx,
    ctx: TrustedContext,
    batchId: string,
  ): Promise<RolloverBatchDto | null> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.read');

    const key = `${SETTINGS_PREFIX_BATCH}${batchId}`;
    const res = await tx.query<{ value: RolloverBatchDto }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, key],
    );

    return res.rows[0]?.value ?? null;
  }

  private static async persistBatch(
    tx: TenantTx,
    ctx: TrustedContext,
    batch: RolloverBatchDto,
  ): Promise<void> {
    const key = `${SETTINGS_PREFIX_BATCH}${batch.batchId}`;

    await tx.query(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [ctx.tenantId, key, JSON.stringify(batch), ctx.userId],
    );

    // Update index
    const indexRes = await tx.query<{ value: RolloverBatchSummaryDto[] }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, SETTINGS_KEY_BATCHES_INDEX],
    );

    const summaries: RolloverBatchSummaryDto[] = indexRes.rows[0]?.value ?? [];
    const summaryItem: RolloverBatchSummaryDto = {
      batchId: batch.batchId,
      status: batch.status,
      sourceTermId: batch.sourceTerm.id,
      sourceTermName: batch.sourceTerm.name,
      targetTermId: batch.targetTerm.id,
      targetTermName: batch.targetTerm.name,
      summary: batch.summary,
      createdAt: batch.createdAt,
      createdBy: batch.createdBy,
      executedAt: batch.executedAt,
    };

    const existingIdx = summaries.findIndex((s) => s.batchId === batch.batchId);
    if (existingIdx >= 0) {
      summaries[existingIdx] = summaryItem;
    } else {
      summaries.unshift(summaryItem);
    }

    await tx.query(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [ctx.tenantId, SETTINGS_KEY_BATCHES_INDEX, JSON.stringify(summaries), ctx.userId],
    );
  }

  private static async dispatchRolloverNotifications(
    tx: TenantTx,
    ctx: TrustedContext,
    batch: RolloverBatchDto,
  ): Promise<void> {
    // Send in-app notifications to parents/students about successful promotion / session transition
    for (const student of batch.students) {
      if (student.finalOutcome === 'PROMOTED' || student.finalOutcome === 'GRADUATED') {
        const title =
          student.finalOutcome === 'GRADUATED'
            ? 'Congratulations on Academic Graduation!'
            : 'Annual Academic Promotion Confirmed';
        const body =
          student.finalOutcome === 'GRADUATED'
            ? `${student.fullName} has successfully graduated and completed the academic program.`
            : `${student.fullName} has been promoted to Class/Period ${student.targetPeriodNo ?? student.currentPeriodNo + 1} for ${batch.targetTerm.name}.`;

        // Find student user id
        const userRes = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM app.students WHERE organization_id = $1 AND id = $2`,
          [ctx.tenantId, student.studentId],
        );
        const recipientUserId = userRes.rows[0]?.user_id;

        if (recipientUserId) {
          await new NotificationService().dispatch(tx, ctx, {
            recipientUserId,
            category: 'ACADEMIC',
            title,
            body,
            channels: ['IN_APP'],
          });
        }
      }
    }
  }
}
