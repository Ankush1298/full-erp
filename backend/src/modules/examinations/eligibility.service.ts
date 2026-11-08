import { resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { conflict, ensureTrusted, invalid, mapDbError } from '../academics/common.js';
import type {
  ApproveCandidateListInput,
  CandidateEvidenceSummary,
  CandidateItem,
  CandidateListResponse,
  EligibilityPolicyDto,
  EvaluationStatus,
  GenerateCandidatesInput,
  OverrideCandidateInput,
  OverrideStatus,
  SaveEligibilityPolicyInput,
} from './eligibility.schemas.js';
import { ExamService } from './exam.service.js';

const lower = (s: string): string => s.toLowerCase();

export class EligibilityService {
  /** Get or resolve the effective policy for an exam schedule */
  static async getOrResolvePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    examinationId?: string,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);

    // 1. Try schedule-level policy
    const schedPolicyRes = await tx.query<EligibilityPolicyDto>(
      `SELECT * FROM app.exam_eligibility_policies
        WHERE organization_id = $1 AND exam_schedule_id = $2
        LIMIT 1`,
      [ctx.tenantId, lower(scheduleId)],
    );
    if (schedPolicyRes.rows[0]) {
      return schedPolicyRes.rows[0];
    }

    // 2. Try exam-level policy
    let examId = examinationId;
    if (!examId) {
      const s = await ExamService.getSchedule(tx, ctx, scheduleId);
      examId = s.examination_id;
    }

    if (examId) {
      const examPolicyRes = await tx.query<EligibilityPolicyDto>(
        `SELECT * FROM app.exam_eligibility_policies
          WHERE organization_id = $1 AND examination_id = $2 AND exam_schedule_id IS NULL
          LIMIT 1`,
        [ctx.tenantId, lower(examId)],
      );
      if (examPolicyRes.rows[0]) {
        return examPolicyRes.rows[0];
      }
    }

    // 3. Fallback default virtual policy
    return {
      id: 'default',
      organization_id: ctx.tenantId,
      name: 'Default Institution Eligibility Policy',
      min_attendance_percentage: 75.0,
      check_attendance: true,
      check_fees: false,
      attendance_cutoff_days_prior: 0,
      allow_late_enrolment_review: true,
      version: 1,
    };
  }

  /** Save or update an eligibility policy for a schedule or examination */
  static async savePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    target: { scheduleId?: string; examinationId?: string },
    input: SaveEligibilityPolicyInput,
    meta?: AuditRequestMeta,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const scheduleId = target.scheduleId ? lower(target.scheduleId) : null;
    let examinationId = target.examinationId ? lower(target.examinationId) : null;
    let campusId: string;

    if (scheduleId) {
      const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);
      examinationId = lower(schedule.examination_id);
      campusId = lower(schedule.campus_id);
    } else if (examinationId) {
      const exam = await ExamService.getExamination(tx, ctx, examinationId);
      campusId = lower(exam.campus_id);
    } else {
      throw invalid(
        'Either scheduleId or examinationId must be specified to save an eligibility policy.',
      );
    }

    const id = uuidv7();
    const sql = `
      INSERT INTO app.exam_eligibility_policies (
        id, organization_id, campus_id, examination_id, exam_schedule_id,
        name, min_attendance_percentage, check_attendance, check_fees,
        attendance_cutoff_days_prior, allow_late_enrolment_review,
        version, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12)
      ON CONFLICT (organization_id, exam_schedule_id) WHERE exam_schedule_id IS NOT NULL
      DO UPDATE SET
        name = EXCLUDED.name,
        min_attendance_percentage = EXCLUDED.min_attendance_percentage,
        check_attendance = EXCLUDED.check_attendance,
        check_fees = EXCLUDED.check_fees,
        attendance_cutoff_days_prior = EXCLUDED.attendance_cutoff_days_prior,
        allow_late_enrolment_review = EXCLUDED.allow_late_enrolment_review,
        version = app.exam_eligibility_policies.version + 1,
        updated_at = now()
      RETURNING *
    `;

    try {
      const res = await tx.query<EligibilityPolicyDto>(sql, [
        id,
        ctx.tenantId,
        campusId,
        examinationId,
        scheduleId,
        input.name,
        input.min_attendance_percentage,
        input.check_attendance,
        input.check_fees,
        input.attendance_cutoff_days_prior,
        input.allow_late_enrolment_review,
        ctx.userId,
      ]);

      const policy = res.rows[0];
      if (!policy) throw invalid('Failed to save eligibility policy.');

      await recordAudit(
        tx,
        ctx,
        {
          action: 'exam.eligibility_policy.save',
          resourceType: 'exam_eligibility_policy',
          resourceId: policy.id,
          campusId: campusId ?? undefined,
          riskTier: 1,
          changes: {
            min_attendance_percentage: { old: null, new: input.min_attendance_percentage },
            check_attendance: { old: null, new: input.check_attendance },
            check_fees: { old: null, new: input.check_fees },
          },
        },
        meta ?? {},
      );

      return policy;
    } catch (err) {
      return mapDbError(err, 'Failed to save eligibility policy.');
    }
  }

  /** Automatically generate candidates for an exam schedule */
  static async generateCandidateList(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    input: GenerateCandidatesInput,
    meta?: AuditRequestMeta,
  ): Promise<CandidateListResponse> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);

    // Resolve or save policy
    let policy: EligibilityPolicyDto;
    if (input.override_policy) {
      policy = await this.savePolicy(tx, ctx, { scheduleId }, input.override_policy, meta);
    } else {
      policy = await this.getOrResolvePolicy(tx, ctx, scheduleId, schedule.examination_id);
    }

    // Determine evidence cutoff date
    let cutoffDate = input.cutoff_date;
    if (!cutoffDate) {
      const examDate = new Date(schedule.exam_date);
      const priorDays = policy.attendance_cutoff_days_prior || 0;
      examDate.setUTCDate(examDate.getUTCDate() - priorDays);
      cutoffDate = examDate.toISOString().split('T')[0] ?? schedule.exam_date;
    }

    // Check existing candidate lists for snapshot versioning
    const existingListRes = await tx.query<{
      id: string;
      status: string;
      snapshot_version: number;
    }>(
      `SELECT id, status, snapshot_version
         FROM app.exam_candidate_lists
        WHERE organization_id = $1 AND exam_schedule_id = $2
        ORDER BY snapshot_version DESC
        LIMIT 1`,
      [ctx.tenantId, lower(scheduleId)],
    );

    const latestList = existingListRes.rows[0];
    const candidateListId = uuidv7();
    const snapshotVersion = latestList ? latestList.snapshot_version + 1 : 1;

    // Fetch enrolled students
    const rosterRes = await tx.query<{
      student_id: string;
      admission_number: string;
      student_name: string;
      roll_number: string | null;
      enrolled_at: string | null;
    }>(
      `SELECT 
         s.id AS student_id,
         s.admission_number,
         u.display_name AS student_name,
         e.roll_number,
         cr.valid_from::text AS enrolled_at
       FROM app.course_registrations cr
       JOIN app.students s ON s.organization_id = cr.organization_id AND s.id = cr.student_id
       JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
       LEFT JOIN app.term_enrollments e ON e.organization_id = cr.organization_id AND e.id = cr.term_enrollment_id
      WHERE cr.organization_id = $1
        AND cr.course_offering_id = $2
        AND cr.status IN ('REGISTERED', 'COMPLETED')
        AND cr.valid_to IS NULL
      ORDER BY s.admission_number ASC`,
      [ctx.tenantId, schedule.course_offering_id],
    );

    // Fetch held class sessions up to cutoff date
    const sessionsRes = await tx.query<{
      id: string;
      session_date: string;
    }>(
      `SELECT id, session_date
         FROM app.class_sessions
        WHERE organization_id = $1
          AND course_offering_id = $2
          AND (status = 'CONDUCTED' OR attendance_state IN ('SUBMITTED', 'LOCKED'))
          AND session_date <= $3
        ORDER BY session_date ASC`,
      [ctx.tenantId, schedule.course_offering_id, cutoffDate],
    );

    const heldSessions = sessionsRes.rows;
    const totalSessions = heldSessions.length;
    const firstSessionDate =
      heldSessions.length > 0 && heldSessions[0] ? heldSessions[0].session_date : null;

    // Fetch attendance records for this offering up to cutoff date
    const attendanceMap = new Map<
      string,
      { present: number; late: number; excused: number; absent: number; total: number }
    >();
    if (totalSessions > 0) {
      const attRes = await tx.query<{
        student_id: string;
        present: string;
        late: string;
        excused: string;
        absent: string;
        total: string;
      }>(
        `SELECT ar.student_id,
                count(*) FILTER (WHERE ar.status = 'PRESENT') AS present,
                count(*) FILTER (WHERE ar.status = 'LATE') AS late,
                count(*) FILTER (WHERE ar.status = 'EXCUSED') AS excused,
                count(*) FILTER (WHERE ar.status = 'ABSENT') AS absent,
                count(*) AS total
           FROM app.attendance_records ar
           JOIN app.class_sessions cs ON cs.organization_id = ar.organization_id AND cs.id = ar.class_session_id
          WHERE ar.organization_id = $1
            AND ar.course_offering_id = $2
            AND (cs.status = 'CONDUCTED' OR cs.attendance_state IN ('SUBMITTED', 'LOCKED'))
            AND cs.session_date <= $3
          GROUP BY ar.student_id`,
        [ctx.tenantId, schedule.course_offering_id, cutoffDate],
      );

      for (const row of attRes.rows) {
        attendanceMap.set(row.student_id, {
          present: Number(row.present),
          late: Number(row.late),
          excused: Number(row.excused),
          absent: Number(row.absent),
          total: Number(row.total),
        });
      }
    }

    // Query fee dues and pending receipts if check_fees is enabled
    const feeMap = new Map<
      string,
      { dues_count: number; total_balance: bigint; total_net_due: bigint; total_paid: bigint }
    >();
    const pendingReceiptsMap = new Map<string, number>();

    if (policy.check_fees && rosterRes.rows.length > 0) {
      const studentIds = rosterRes.rows.map((r) => r.student_id);

      const duesRes = await tx.query<{
        student_id: string;
        dues_count: string;
        total_balance: string;
        total_net_due: string;
        total_paid: string;
      }>(
        `SELECT student_id,
                count(*) AS dues_count,
                coalesce(sum(balance_remaining), 0)::text AS total_balance,
                coalesce(sum(amount_due - amount_concession), 0)::text AS total_net_due,
                coalesce(sum(amount_paid), 0)::text AS total_paid
           FROM app.student_dues
          WHERE organization_id = $1
            AND student_id = ANY($2)
            AND status <> 'CANCELLED'
          GROUP BY student_id`,
        [ctx.tenantId, studentIds],
      );

      for (const row of duesRes.rows) {
        feeMap.set(row.student_id, {
          dues_count: Number(row.dues_count),
          total_balance: BigInt(row.total_balance),
          total_net_due: BigInt(row.total_net_due),
          total_paid: BigInt(row.total_paid),
        });
      }

      const pendingRes = await tx.query<{
        student_id: string;
        pending_count: string;
      }>(
        `SELECT student_id,
                count(*) AS pending_count
           FROM app.fee_receipts
          WHERE organization_id = $1
            AND student_id = ANY($2)
            AND reconciliation_status = 'PENDING_VERIFICATION'
            AND status = 'POSTED'
          GROUP BY student_id`,
        [ctx.tenantId, studentIds],
      );

      for (const row of pendingRes.rows) {
        pendingReceiptsMap.set(row.student_id, Number(row.pending_count));
      }
    }

    let eligibleCount = 0;
    let notEligibleCount = 0;
    let needsReviewCount = 0;
    const candidateItems: CandidateItem[] = [];

    // Evaluate each student
    for (const student of rosterRes.rows) {
      let evalStatus: EvaluationStatus = 'ELIGIBLE';
      const reasons: string[] = [];
      const attStats = attendanceMap.get(student.student_id) || {
        present: 0,
        late: 0,
        excused: 0,
        absent: 0,
        total: 0,
      };

      const attendedSessions = attStats.present + attStats.late;
      const attendancePercentage =
        totalSessions > 0 ? Math.round((attendedSessions / totalSessions) * 10000) / 100 : 0;
      const minPercentage = Number(policy.min_attendance_percentage);

      // Check Attendance
      if (policy.check_attendance) {
        if (totalSessions === 0) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push('No conducted class sessions recorded prior to cutoff date');
        } else if (attStats.total < totalSessions) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push(
            `Attendance records incomplete (${attStats.total}/${totalSessions} sessions recorded)`,
          );
        } else if (attendancePercentage >= minPercentage) {
          reasons.push(`Attendance criteria met: ${attendancePercentage}% >= ${minPercentage}%`);
        } else {
          evalStatus = 'NOT_ELIGIBLE';
          reasons.push(
            `Attendance below required threshold: ${attendancePercentage}% < ${minPercentage}%`,
          );
        }

        // Check late enrolment review
        if (policy.allow_late_enrolment_review && student.enrolled_at && firstSessionDate) {
          const enrollDateStr = student.enrolled_at.split('T')[0];
          if (enrollDateStr && enrollDateStr > firstSessionDate) {
            evalStatus = 'NEEDS_REVIEW';
            reasons.push(
              `Mid-period enrolment on ${enrollDateStr} after first session (${firstSessionDate})`,
            );
          }
        }
      } else {
        reasons.push('Attendance check waived by policy');
      }

      // Check Fees
      let feeStatus: 'CLEARED' | 'OUTSTANDING' | 'NEEDS_REVIEW' | 'NO_RECORD' | undefined =
        undefined;
      let outstandingBalance = 0;

      if (policy.check_fees) {
        const feeSummary = feeMap.get(student.student_id);
        const pendingCount = pendingReceiptsMap.get(student.student_id) || 0;

        if (!feeSummary || feeSummary.dues_count === 0) {
          feeStatus = 'NO_RECORD';
          if (evalStatus === 'ELIGIBLE') {
            evalStatus = 'NEEDS_REVIEW';
          }
          reasons.push('No fee assessment record found for student');
        } else if (pendingCount > 0) {
          feeStatus = 'NEEDS_REVIEW';
          outstandingBalance = Number(feeSummary.total_balance);
          if (evalStatus === 'ELIGIBLE') {
            evalStatus = 'NEEDS_REVIEW';
          }
          reasons.push(
            'Fee clearance pending: unverified payment reference awaiting reconciliation',
          );
        } else if (feeSummary.total_balance > 0n) {
          feeStatus = 'OUTSTANDING';
          outstandingBalance = Number(feeSummary.total_balance);
          if (evalStatus === 'ELIGIBLE') {
            evalStatus = 'NEEDS_REVIEW';
          }
          reasons.push(
            `Outstanding fee balance of ${(Number(feeSummary.total_balance) / 100).toFixed(2)} requires administrative review`,
          );
        } else {
          feeStatus = 'CLEARED';
          outstandingBalance = 0;
          reasons.push('Fee clearance verified: no outstanding dues');
        }
      } else {
        reasons.push('Fee check waived by policy');
      }

      const finalStatus = evalStatus === 'ELIGIBLE' ? 'ELIGIBLE' : 'NOT_ELIGIBLE';

      if (evalStatus === 'ELIGIBLE') {
        eligibleCount++;
      } else if (evalStatus === 'NOT_ELIGIBLE') {
        notEligibleCount++;
      } else {
        needsReviewCount++;
      }

      const evidenceSummary: CandidateEvidenceSummary = {
        total_sessions: totalSessions,
        attended_sessions: attendedSessions,
        absent_sessions: attStats.absent,
        excused_sessions: attStats.excused,
        attendance_percentage: attendancePercentage,
        required_percentage: minPercentage,
        enrolled_date: student.enrolled_at ? student.enrolled_at.split('T')[0] : null,
        cutoff_date: cutoffDate,
        reasons,
        fee_status: feeStatus,
        outstanding_balance: outstandingBalance,
      };

      const candidateId = uuidv7();

      candidateItems.push({
        candidate_id: candidateId,
        student_id: student.student_id,
        admission_number: student.admission_number,
        student_name: student.student_name,
        roll_number: student.roll_number,
        evaluation_status: evalStatus,
        override_status: 'NONE',
        final_status: finalStatus,
        reasons,
        evidence_summary: evidenceSummary,
        override_reason: null,
        overridden_by_user_id: null,
        overridden_at: null,
      });
    }

    // Insert Candidate List Snapshot
    const policyId = policy.id !== 'default' ? policy.id : null;
    const listSql = `
      INSERT INTO app.exam_candidate_lists (
        id, organization_id, exam_schedule_id, policy_id, policy_version,
        snapshot_version, status, evidence_cutoff_date, total_candidates,
        eligible_count, not_eligible_count, needs_review_count,
        policy_snapshot, generated_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `;

    const listRes = await tx.query<{
      id: string;
      exam_schedule_id: string;
      policy_id: string | null;
      policy_version: number;
      snapshot_version: number;
      status: 'DRAFT' | 'APPROVED' | 'FROZEN';
      evidence_cutoff_date: string;
      total_candidates: number;
      eligible_count: number;
      not_eligible_count: number;
      needs_review_count: number;
      policy_snapshot: Record<string, unknown>;
      generated_at: string;
      approved_at: string | null;
      approved_by_user_id: string | null;
    }>(listSql, [
      candidateListId,
      ctx.tenantId,
      lower(scheduleId),
      policyId,
      policy.version,
      snapshotVersion,
      cutoffDate,
      candidateItems.length,
      eligibleCount,
      notEligibleCount,
      needsReviewCount,
      JSON.stringify(policy),
      ctx.userId,
    ]);

    // Insert Candidate Rows
    for (const item of candidateItems) {
      await tx.query(
        `INSERT INTO app.exam_candidates (
           id, organization_id, candidate_list_id, student_id,
           evaluation_status, override_status, final_status,
           reasons, evidence_summary
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          item.candidate_id,
          ctx.tenantId,
          candidateListId,
          item.student_id,
          item.evaluation_status,
          item.override_status,
          item.final_status,
          item.reasons,
          JSON.stringify(item.evidence_summary),
        ],
      );
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.candidates.generate',
        resourceType: 'exam_candidate_list',
        resourceId: candidateListId,
        campusId: schedule.campus_id,
        riskTier: 1,
        changes: {
          total_candidates: { old: null, new: candidateItems.length },
          eligible_count: { old: null, new: eligibleCount },
          needs_review_count: { old: null, new: needsReviewCount },
        },
      },
      meta ?? {},
    );

    const list = listRes.rows[0];
    if (!list) throw invalid('Failed to generate candidate list snapshot.');

    return {
      list,
      policy,
      candidates: candidateItems,
      recalculation_available: false,
    };
  }

  /** Get candidate list and candidate items for a schedule */
  static async getCandidateList(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
  ): Promise<CandidateListResponse | null> {
    ensureTrusted(ctx);

    const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);

    const listRes = await tx.query<{
      id: string;
      exam_schedule_id: string;
      policy_id: string | null;
      policy_version: number;
      snapshot_version: number;
      status: 'DRAFT' | 'APPROVED' | 'FROZEN';
      evidence_cutoff_date: string;
      total_candidates: number;
      eligible_count: number;
      not_eligible_count: number;
      needs_review_count: number;
      policy_snapshot: Record<string, unknown>;
      generated_at: string;
      approved_at: string | null;
      approved_by_user_id: string | null;
    }>(
      `SELECT * FROM app.exam_candidate_lists
        WHERE organization_id = $1 AND exam_schedule_id = $2
        ORDER BY snapshot_version DESC
        LIMIT 1`,
      [ctx.tenantId, lower(scheduleId)],
    );

    const list = listRes.rows[0];
    if (!list) return null;

    const candidatesRes = await tx.query<{
      candidate_id: string;
      student_id: string;
      admission_number: string;
      student_name: string;
      roll_number: string | null;
      evaluation_status: EvaluationStatus;
      override_status: OverrideStatus;
      final_status: 'ELIGIBLE' | 'NOT_ELIGIBLE';
      reasons: string[];
      evidence_summary: CandidateEvidenceSummary;
      override_reason: string | null;
      overridden_by_user_id: string | null;
      overridden_at: string | null;
    }>(
      `SELECT 
         c.id AS candidate_id,
         c.student_id,
         s.admission_number,
         u.display_name AS student_name,
         e.roll_number,
         c.evaluation_status,
         c.override_status,
         c.final_status,
         c.reasons,
         c.evidence_summary,
         c.override_reason,
         c.overridden_by_user_id,
         c.overridden_at
       FROM app.exam_candidates c
       JOIN app.students s ON s.organization_id = c.organization_id AND s.id = c.student_id
       JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
       LEFT JOIN app.course_registrations cr ON cr.organization_id = c.organization_id
                                            AND cr.student_id = c.student_id
                                            AND cr.course_offering_id = $3
                                            AND cr.status IN ('REGISTERED', 'COMPLETED')
                                            AND cr.valid_to IS NULL
       LEFT JOIN app.term_enrollments e ON e.organization_id = cr.organization_id AND e.id = cr.term_enrollment_id
      WHERE c.organization_id = $1 AND c.candidate_list_id = $2
      ORDER BY s.admission_number ASC`,
      [ctx.tenantId, list.id, schedule.course_offering_id],
    );

    // Check if recalculation is available (evidence staleness)
    // If sessions, attendance records, student dues, or fee receipts were added/modified after generated_at
    const stalenessRes = await tx.query<{ is_stale: boolean }>(
      `SELECT (EXISTS (
         SELECT 1 FROM app.class_sessions cs
          WHERE cs.organization_id = $1
            AND cs.course_offering_id = $2
            AND (cs.status = 'CONDUCTED' OR cs.attendance_state IN ('SUBMITTED', 'LOCKED'))
            AND cs.session_date <= $3
            AND (cs.updated_at > $4 OR cs.created_at > $4)
       ) OR EXISTS (
         SELECT 1 FROM app.attendance_records ar
          JOIN app.class_sessions cs ON cs.organization_id = ar.organization_id AND cs.id = ar.class_session_id
          WHERE ar.organization_id = $1
            AND ar.course_offering_id = $2
            AND cs.session_date <= $3
            AND (ar.updated_at > $4 OR ar.created_at > $4)
       ) OR EXISTS (
         SELECT 1 FROM app.student_dues sd
          JOIN app.course_registrations cr ON cr.organization_id = sd.organization_id AND cr.student_id = sd.student_id
          WHERE sd.organization_id = $1
            AND cr.course_offering_id = $2
            AND (sd.updated_at > $4 OR sd.created_at > $4)
       ) OR EXISTS (
         SELECT 1 FROM app.fee_receipts fr
          JOIN app.course_registrations cr ON cr.organization_id = fr.organization_id AND cr.student_id = fr.student_id
          WHERE fr.organization_id = $1
            AND cr.course_offering_id = $2
            AND (fr.updated_at > $4 OR fr.created_at > $4)
       )) AS is_stale`,
      [ctx.tenantId, schedule.course_offering_id, list.evidence_cutoff_date, list.generated_at],
    );

    const policy = list.policy_id
      ? await this.getOrResolvePolicy(tx, ctx, scheduleId, schedule.examination_id)
      : null;

    return {
      list,
      policy,
      candidates: candidatesRes.rows,
      recalculation_available: Boolean(stalenessRes.rows[0]?.is_stale),
    };
  }

  /** Apply an administrative override or exemption to a candidate */
  static async overrideCandidate(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    candidateId: string,
    input: OverrideCandidateInput,
    meta?: AuditRequestMeta,
  ): Promise<CandidateItem> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);

    // Verify candidate and list exist
    const candRes = await tx.query<{
      candidate_id: string;
      candidate_list_id: string;
      list_status: string;
      override_status: string;
      evaluation_status: EvaluationStatus;
    }>(
      `SELECT c.id AS candidate_id, c.candidate_list_id, cl.status AS list_status, c.override_status, c.evaluation_status
         FROM app.exam_candidates c
         JOIN app.exam_candidate_lists cl ON cl.organization_id = c.organization_id AND cl.id = c.candidate_list_id
        WHERE c.organization_id = $1 AND c.id = $2 AND cl.exam_schedule_id = $3`,
      [ctx.tenantId, lower(candidateId), lower(scheduleId)],
    );

    const existing = candRes.rows[0];
    if (!existing) throw resourceNotFound();

    if (existing.list_status === 'FROZEN') {
      throw conflict('Cannot modify candidates on a frozen candidate list.');
    }

    // Update candidate (Trigger trg_exam_candidates_guard updates final_status)
    await tx.query(
      `UPDATE app.exam_candidates
          SET override_status = $1,
              override_reason = $2,
              overridden_by_user_id = $3,
              overridden_at = now()
        WHERE organization_id = $4 AND id = $5
        RETURNING *`,
      [input.override_status, input.override_reason, ctx.userId, ctx.tenantId, lower(candidateId)],
    );

    // Recalculate summary counts on candidate list
    const countsRes = await tx.query<{
      eligible: string;
      not_eligible: string;
      needs_review: string;
    }>(
      `SELECT 
         count(*) FILTER (WHERE final_status = 'ELIGIBLE') AS eligible,
         count(*) FILTER (WHERE final_status = 'NOT_ELIGIBLE') AS not_eligible,
         count(*) FILTER (WHERE evaluation_status = 'NEEDS_REVIEW' AND override_status = 'NONE') AS needs_review
        FROM app.exam_candidates
       WHERE organization_id = $1 AND candidate_list_id = $2`,
      [ctx.tenantId, existing.candidate_list_id],
    );

    const counts = countsRes.rows[0] ?? { eligible: '0', not_eligible: '0', needs_review: '0' };
    await tx.query(
      `UPDATE app.exam_candidate_lists
          SET eligible_count = $1,
              not_eligible_count = $2,
              needs_review_count = $3,
              updated_at = now()
        WHERE organization_id = $4 AND id = $5`,
      [
        Number(counts.eligible),
        Number(counts.not_eligible),
        Number(counts.needs_review),
        ctx.tenantId,
        existing.candidate_list_id,
      ],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.candidate.override',
        resourceType: 'exam_candidate',
        resourceId: candidateId,
        campusId: schedule.campus_id,
        riskTier: 1,
        changes: {
          override_status: { old: existing.override_status, new: input.override_status },
          override_reason: { old: null, new: input.override_reason },
        },
      },
      meta ?? {},
    );

    const fullCandidate = await this.getCandidateList(tx, ctx, scheduleId);
    const item = fullCandidate?.candidates.find((c) => c.candidate_id === candidateId);
    if (!item) throw resourceNotFound();
    return item;
  }

  /** Approve or Freeze a candidate list */
  static async approveCandidateList(
    tx: TenantTx,
    ctx: TrustedContext,
    scheduleId: string,
    listId: string,
    input: ApproveCandidateListInput,
    meta?: AuditRequestMeta,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);

    const listRes = await tx.query<{
      id: string;
      status: string;
      total_candidates: number;
      eligible_count: number;
    }>(
      `SELECT id, status, total_candidates, eligible_count
         FROM app.exam_candidate_lists
        WHERE organization_id = $1 AND id = $2 AND exam_schedule_id = $3`,
      [ctx.tenantId, lower(listId), lower(scheduleId)],
    );

    const list = listRes.rows[0];
    if (!list) throw resourceNotFound();

    if (list.status === 'FROZEN') {
      throw conflict('Candidate list is already frozen.');
    }

    const newStatus = input.freeze ? 'FROZEN' : 'APPROVED';

    const updateRes = await tx.query(
      `UPDATE app.exam_candidate_lists
          SET status = $1,
              approved_at = now(),
              approved_by_user_id = $2,
              version = version + 1,
              updated_at = now()
        WHERE organization_id = $3 AND id = $4
        RETURNING *`,
      [newStatus, ctx.userId, ctx.tenantId, lower(listId)],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: input.freeze ? 'exam.candidates.freeze' : 'exam.candidates.approve',
        resourceType: 'exam_candidate_list',
        resourceId: listId,
        campusId: schedule.campus_id,
        riskTier: 2,
        changes: {
          status: { old: list.status, new: newStatus },
        },
      },
      meta ?? {},
    );

    return updateRes.rows[0];
  }
}
