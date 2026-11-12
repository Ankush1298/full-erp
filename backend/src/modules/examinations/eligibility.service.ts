import { resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { conflict, ensureTrusted, invalid } from '../academics/common.js';
import type {
  ApproveCandidateListInput,
  CandidateEvidenceSummary,
  CandidateItem,
  CandidateListResponse,
  EligibilityPolicyDto,
  EvaluationStatus,
  GenerateCandidatesInput,
  ListPoliciesQuery,
  OverrideCandidateInput,
  OverrideStatus,
  PolicyPreviewImpactInput,
  PolicyPreviewImpactResponse,
  SaveEligibilityPolicyInput,
} from './eligibility.schemas.js';
import { ExamService } from './exam.service.js';

const lower = (s: string): string => s.toLowerCase();

export class EligibilityService {
  private static async getExtendedRules(
    tx: TenantTx,
    ctx: TrustedContext,
    policyId: string,
  ): Promise<Record<string, unknown>> {
    const key = `exam_policy_ext:${lower(policyId)}`;
    const res = await tx.query<{ value: Record<string, unknown> }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, key],
    );
    return res.rows[0]?.value ?? {};
  }

  private static async saveExtendedRules(
    tx: TenantTx,
    ctx: TrustedContext,
    policyId: string,
    rules: Record<string, unknown>,
  ): Promise<void> {
    const key = `exam_policy_ext:${lower(policyId)}`;
    await tx.query(
      `INSERT INTO app.organization_settings (organization_id, key, value, updated_by)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (organization_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [ctx.tenantId, key, JSON.stringify(rules), ctx.userId],
    );
  }

  private static async enrichPolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    policy: EligibilityPolicyDto,
  ): Promise<EligibilityPolicyDto> {
    if (!policy.id || policy.id === 'default') {
      return {
        ...policy,
        scope: 'INSTITUTION',
        status: 'ACTIVE',
        description: 'Institution-wide default baseline examination policy',
        attendance_rules: {
          calculation_period: 'FULL_TERM',
          excused_treatment: 'EXEMPT',
          late_treatment: 'PRESENT',
          cancelled_sessions_excluded: true,
          prorate_late_enrolment: true,
          min_sessions: 0,
          allow_exemption: true,
          exemption_approver_role: 'PRINCIPAL',
        },
        fee_rules: {
          max_balance_tolerance: 0,
          allow_concession_exemption: true,
          deadline_days_prior: 0,
          require_payment_verification: true,
        },
        academic_rules: {
          required_enrolment_status: 'REGISTERED',
          min_enrolment_days: 0,
          allow_academic_exception: true,
          supplementary_eligible: true,
        },
        assessment_rules: {
          components: [],
          allow_grace_marks: false,
          max_grace_marks: 0,
        },
        grading_rules: {
          grading_system: 'PERCENTAGE',
          grade_scale: [
            {
              grade: 'A+',
              min_percentage: 90,
              max_percentage: 100,
              grade_point: 10.0,
              description: 'Outstanding',
              is_passing: true,
            },
            {
              grade: 'A',
              min_percentage: 80,
              max_percentage: 89.99,
              grade_point: 9.0,
              description: 'Excellent',
              is_passing: true,
            },
            {
              grade: 'B+',
              min_percentage: 70,
              max_percentage: 79.99,
              grade_point: 8.0,
              description: 'Very Good',
              is_passing: true,
            },
            {
              grade: 'B',
              min_percentage: 60,
              max_percentage: 69.99,
              grade_point: 7.0,
              description: 'Good',
              is_passing: true,
            },
            {
              grade: 'C',
              min_percentage: 50,
              max_percentage: 59.99,
              grade_point: 6.0,
              description: 'Above Average',
              is_passing: true,
            },
            {
              grade: 'D',
              min_percentage: 40,
              max_percentage: 49.99,
              grade_point: 5.0,
              description: 'Pass',
              is_passing: true,
            },
            {
              grade: 'F',
              min_percentage: 0,
              max_percentage: 39.99,
              grade_point: 0.0,
              description: 'Fail',
              is_passing: false,
            },
          ],
        },
        approval_rules: {
          governance_mode: 'PRINCIPAL_FINAL_AUTHORITY',
          require_coordinator_review: true,
          require_principal_approval: true,
          allow_individual_override: true,
          results_workflow: 'DIRECT_PUBLISH',
          delegated_roles: [
            'COLLEGE_ADMIN',
            'CAMPUS_ADMIN',
            'REGISTRAR',
            'DEPARTMENT_ADMIN',
            'HOD',
          ],
          effective_date: '2026-11-12',
        },
      };
    }

    const ext = await this.getExtendedRules(tx, ctx, policy.id);
    const scope = policy.exam_schedule_id
      ? 'SCHEDULE'
      : policy.examination_id
      ? 'EXAMINATION'
      : policy.campus_id
      ? 'CAMPUS'
      : 'INSTITUTION';

    return {
      ...policy,
      scope: (ext.scope as any) ?? scope,
      status: (ext.status as any) ?? 'ACTIVE',
      description: (ext.description as any) ?? null,
      attendance_rules: (ext.attendance_rules as any) ?? {
        calculation_period: 'FULL_TERM',
        excused_treatment: 'EXEMPT',
        late_treatment: 'PRESENT',
        cancelled_sessions_excluded: true,
        prorate_late_enrolment: true,
        min_sessions: 0,
        allow_exemption: true,
        exemption_approver_role: 'PRINCIPAL',
      },
      fee_rules: (ext.fee_rules as any) ?? {
        max_balance_tolerance: 0,
        allow_concession_exemption: true,
        deadline_days_prior: 0,
        require_payment_verification: true,
      },
      academic_rules: (ext.academic_rules as any) ?? {
        required_enrolment_status: 'REGISTERED',
        min_enrolment_days: 0,
        allow_academic_exception: true,
        supplementary_eligible: true,
      },
      assessment_rules: (ext.assessment_rules as any) ?? {
        components: [],
        allow_grace_marks: false,
        max_grace_marks: 0,
      },
      grading_rules: (ext.grading_rules as any) ?? {
        grading_system: 'PERCENTAGE',
        grade_scale: [
          {
            grade: 'A+',
            min_percentage: 90,
            max_percentage: 100,
            grade_point: 10.0,
            description: 'Outstanding',
            is_passing: true,
          },
          {
            grade: 'A',
            min_percentage: 80,
            max_percentage: 89.99,
            grade_point: 9.0,
            description: 'Excellent',
            is_passing: true,
          },
          {
            grade: 'B+',
            min_percentage: 70,
            max_percentage: 79.99,
            grade_point: 8.0,
            description: 'Very Good',
            is_passing: true,
          },
          {
            grade: 'B',
            min_percentage: 60,
            max_percentage: 69.99,
            grade_point: 7.0,
            description: 'Good',
            is_passing: true,
          },
          {
            grade: 'C',
            min_percentage: 50,
            max_percentage: 59.99,
            grade_point: 6.0,
            description: 'Above Average',
            is_passing: true,
          },
          {
            grade: 'D',
            min_percentage: 40,
            max_percentage: 49.99,
            grade_point: 5.0,
            description: 'Pass',
            is_passing: true,
          },
          {
            grade: 'F',
            min_percentage: 0,
            max_percentage: 39.99,
            grade_point: 0.0,
            description: 'Fail',
            is_passing: false,
          },
        ],
      },
      approval_rules: ext.approval_rules
        ? {
            governance_mode:
              (ext.approval_rules as any).governance_mode ??
              ((ext.approval_rules as any).results_workflow === 'DIRECT_PUBLISH'
                ? 'PRINCIPAL_FINAL_AUTHORITY'
                : 'INDEPENDENT_REVIEW'),
            require_coordinator_review: (ext.approval_rules as any).require_coordinator_review ?? true,
            require_principal_approval: (ext.approval_rules as any).require_principal_approval ?? true,
            allow_individual_override: (ext.approval_rules as any).allow_individual_override ?? true,
            results_workflow: (ext.approval_rules as any).results_workflow ?? 'DRAFT_REVIEW_PUBLISH',
            delegated_roles: (ext.approval_rules as any).delegated_roles ?? [
              'COLLEGE_ADMIN',
              'CAMPUS_ADMIN',
              'REGISTRAR',
              'DEPARTMENT_ADMIN',
              'HOD',
            ],
            effective_date: (ext.approval_rules as any).effective_date,
            notes: (ext.approval_rules as any).notes,
          }
        : {
            governance_mode: 'PRINCIPAL_FINAL_AUTHORITY',
            require_coordinator_review: true,
            require_principal_approval: true,
            allow_individual_override: true,
            results_workflow: 'DIRECT_PUBLISH',
            delegated_roles: [
              'COLLEGE_ADMIN',
              'CAMPUS_ADMIN',
              'REGISTRAR',
              'DEPARTMENT_ADMIN',
              'HOD',
            ],
            effective_date: '2026-11-12',
          },
    };
  }

  /** Get or resolve the effective policy for an exam schedule (with scope precedence) */
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
      return this.enrichPolicy(tx, ctx, schedPolicyRes.rows[0]);
    }

    // 2. Try exam-level policy
    let examId = examinationId;
    let campusId: string | undefined;
    if (!examId) {
      const s = await ExamService.getSchedule(tx, ctx, scheduleId);
      examId = s.examination_id;
      campusId = s.campus_id;
    } else {
      const e = await ExamService.getExamination(tx, ctx, examId);
      campusId = e.campus_id;
    }

    if (examId) {
      const examPolicyRes = await tx.query<EligibilityPolicyDto>(
        `SELECT * FROM app.exam_eligibility_policies
          WHERE organization_id = $1 AND examination_id = $2 AND exam_schedule_id IS NULL
          LIMIT 1`,
        [ctx.tenantId, lower(examId)],
      );
      if (examPolicyRes.rows[0]) {
        return this.enrichPolicy(tx, ctx, examPolicyRes.rows[0]);
      }
    }

    // 3. Try campus-level policy
    if (campusId) {
      const campusPolicyRes = await tx.query<EligibilityPolicyDto>(
        `SELECT * FROM app.exam_eligibility_policies
          WHERE organization_id = $1 AND campus_id = $2 AND examination_id IS NULL AND exam_schedule_id IS NULL
          ORDER BY updated_at DESC
          LIMIT 1`,
        [ctx.tenantId, lower(campusId)],
      );
      if (campusPolicyRes.rows[0]) {
        return this.enrichPolicy(tx, ctx, campusPolicyRes.rows[0]);
      }
    }

    // 4. Try institution-level active policy
    const instPolicyRes = await tx.query<EligibilityPolicyDto>(
      `SELECT * FROM app.exam_eligibility_policies
        WHERE organization_id = $1 AND campus_id IS NULL AND examination_id IS NULL AND exam_schedule_id IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [ctx.tenantId],
    );
    if (instPolicyRes.rows[0]) {
      return this.enrichPolicy(tx, ctx, instPolicyRes.rows[0]);
    }

    // 5. Fallback default virtual policy
    return this.enrichPolicy(tx, ctx, {
      id: 'default',
      organization_id: ctx.tenantId,
      name: 'Default Institution Eligibility Policy',
      min_attendance_percentage: 75.0,
      check_attendance: true,
      check_fees: false,
      attendance_cutoff_days_prior: 0,
      allow_late_enrolment_review: true,
      version: 1,
    });
  }

  /** List all policies and templates for the institution */
  static async listPolicies(
    tx: TenantTx,
    ctx: TrustedContext,
    query: ListPoliciesQuery = {},
  ): Promise<EligibilityPolicyDto[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const conditions: string[] = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(lower(query.campus_id));
      conditions.push(`campus_id = $${params.length}`);
    }
    if (query.examination_id) {
      params.push(lower(query.examination_id));
      conditions.push(`examination_id = $${params.length}`);
    }
    if (query.scope === 'INSTITUTION') {
      conditions.push('campus_id IS NULL AND examination_id IS NULL AND exam_schedule_id IS NULL');
    } else if (query.scope === 'CAMPUS') {
      conditions.push(
        'campus_id IS NOT NULL AND examination_id IS NULL AND exam_schedule_id IS NULL',
      );
    } else if (query.scope === 'EXAMINATION') {
      conditions.push('examination_id IS NOT NULL AND exam_schedule_id IS NULL');
    } else if (query.scope === 'SCHEDULE') {
      conditions.push('exam_schedule_id IS NOT NULL');
    }

    const res = await tx.query<EligibilityPolicyDto>(
      `SELECT * FROM app.exam_eligibility_policies
        WHERE ${conditions.join(' AND ')}
        ORDER BY updated_at DESC`,
      params,
    );

    const enriched = await Promise.all(res.rows.map((p) => this.enrichPolicy(tx, ctx, p)));

    if (query.status) {
      return enriched.filter((p) => p.status === query.status);
    }
    return enriched;
  }

  /** Get policy by ID */
  static async getPolicyById(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const res = await tx.query<EligibilityPolicyDto>(
      `SELECT * FROM app.exam_eligibility_policies
        WHERE organization_id = $1 AND id = $2
        LIMIT 1`,
      [ctx.tenantId, lower(id)],
    );
    const policy = res.rows[0];
    if (!policy) throw resourceNotFound();
    return this.enrichPolicy(tx, ctx, policy);
  }

  /** Save or update an eligibility policy */
  static async savePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    target: { scheduleId?: string; examinationId?: string; campusId?: string; policyId?: string },
    input: SaveEligibilityPolicyInput,
    meta?: AuditRequestMeta,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const scheduleId = target.scheduleId
      ? lower(target.scheduleId)
      : input.exam_schedule_id
      ? lower(input.exam_schedule_id)
      : null;
    let examinationId = target.examinationId
      ? lower(target.examinationId)
      : input.examination_id
      ? lower(input.examination_id)
      : null;
    let campusId: string | null = target.campusId
      ? lower(target.campusId)
      : input.campus_id
      ? lower(input.campus_id)
      : null;

    if (scheduleId) {
      const schedule = await ExamService.getSchedule(tx, ctx, scheduleId);
      examinationId = lower(schedule.examination_id);
      campusId = lower(schedule.campus_id);
    } else if (examinationId) {
      const exam = await ExamService.getExamination(tx, ctx, examinationId);
      campusId = lower(exam.campus_id);
    }

    const policyId = target.policyId ? lower(target.policyId) : uuidv7();

    let savedPolicy: EligibilityPolicyDto;

    // Check if updating existing policy by ID
    const existingById = target.policyId
      ? await tx.query<EligibilityPolicyDto>(
          `SELECT * FROM app.exam_eligibility_policies WHERE organization_id = $1 AND id = $2`,
          [ctx.tenantId, policyId],
        )
      : null;

    if (existingById && existingById.rows[0]) {
      const updateRes = await tx.query<EligibilityPolicyDto>(
        `UPDATE app.exam_eligibility_policies
            SET name = $3,
                min_attendance_percentage = $4,
                check_attendance = $5,
                check_fees = $6,
                attendance_cutoff_days_prior = $7,
                allow_late_enrolment_review = $8,
                version = version + 1,
                updated_at = now()
          WHERE organization_id = $1 AND id = $2
          RETURNING *`,
        [
          ctx.tenantId,
          policyId,
          input.name,
          input.min_attendance_percentage,
          input.check_attendance,
          input.check_fees,
          input.attendance_cutoff_days_prior,
          input.allow_late_enrolment_review,
        ],
      );
      savedPolicy = updateRes.rows[0]!;
    } else if (scheduleId) {
      // Schedule-level policy upsert
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
      const res = await tx.query<EligibilityPolicyDto>(sql, [
        policyId,
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
      savedPolicy = res.rows[0]!;
    } else if (examinationId) {
      // Examination-level policy upsert
      const sql = `
        INSERT INTO app.exam_eligibility_policies (
          id, organization_id, campus_id, examination_id, exam_schedule_id,
          name, min_attendance_percentage, check_attendance, check_fees,
          attendance_cutoff_days_prior, allow_late_enrolment_review,
          version, created_by_user_id
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, 1, $11)
        ON CONFLICT (organization_id, examination_id) WHERE examination_id IS NOT NULL AND exam_schedule_id IS NULL
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
      const res = await tx.query<EligibilityPolicyDto>(sql, [
        policyId,
        ctx.tenantId,
        campusId,
        examinationId,
        input.name,
        input.min_attendance_percentage,
        input.check_attendance,
        input.check_fees,
        input.attendance_cutoff_days_prior,
        input.allow_late_enrolment_review,
        ctx.userId,
      ]);
      savedPolicy = res.rows[0]!;
    } else {
      // Campus or Institution template
      const sql = `
        INSERT INTO app.exam_eligibility_policies (
          id, organization_id, campus_id, examination_id, exam_schedule_id,
          name, min_attendance_percentage, check_attendance, check_fees,
          attendance_cutoff_days_prior, allow_late_enrolment_review,
          version, created_by_user_id
        ) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, $7, $8, $9, 1, $10)
        RETURNING *
      `;
      const res = await tx.query<EligibilityPolicyDto>(sql, [
        policyId,
        ctx.tenantId,
        campusId,
        input.name,
        input.min_attendance_percentage,
        input.check_attendance,
        input.check_fees,
        input.attendance_cutoff_days_prior,
        input.allow_late_enrolment_review,
        ctx.userId,
      ]);
      savedPolicy = res.rows[0]!;
    }

    // Persist extended rules
    const extendedData = {
      scope: input.scope,
      status: input.status ?? 'ACTIVE',
      description: input.description ?? null,
      attendance_rules: input.attendance_rules,
      fee_rules: input.fee_rules,
      academic_rules: input.academic_rules,
      assessment_rules: input.assessment_rules,
      grading_rules: input.grading_rules,
      approval_rules: input.approval_rules,
    };
    await this.saveExtendedRules(tx, ctx, savedPolicy.id, extendedData);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.eligibility_policy.save',
        resourceType: 'exam_eligibility_policy',
        resourceId: savedPolicy.id,
        ...(campusId ? { campusId } : {}),
        riskTier: 1,
        changes: {
          min_attendance_percentage: { old: null, new: input.min_attendance_percentage },
          check_attendance: { old: null, new: input.check_attendance },
          check_fees: { old: null, new: input.check_fees },
        },
      },
      meta ?? {},
    );

    return this.enrichPolicy(tx, ctx, savedPolicy);
  }

  /** Duplicate a policy template */
  static async duplicatePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    meta?: AuditRequestMeta,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const existing = await this.getPolicyById(tx, ctx, id);
    const newId = uuidv7();
    const newName = `${existing.name} (Copy)`;

    const res = await tx.query<EligibilityPolicyDto>(
      `INSERT INTO app.exam_eligibility_policies (
        id, organization_id, campus_id, examination_id, exam_schedule_id,
        name, min_attendance_percentage, check_attendance, check_fees,
        attendance_cutoff_days_prior, allow_late_enrolment_review,
        version, created_by_user_id
      ) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, 1, $11)
      RETURNING *`,
      [
        newId,
        ctx.tenantId,
        existing.campus_id,
        existing.examination_id,
        newName,
        existing.min_attendance_percentage,
        existing.check_attendance,
        existing.check_fees,
        existing.attendance_cutoff_days_prior,
        existing.allow_late_enrolment_review,
        ctx.userId,
      ],
    );
    const created = res.rows[0];
    if (!created) throw invalid('Failed to duplicate policy.');

    const extRules = {
      scope: existing.scope,
      status: 'DRAFT',
      description: existing.description,
      attendance_rules: existing.attendance_rules,
      fee_rules: existing.fee_rules,
      academic_rules: existing.academic_rules,
      assessment_rules: existing.assessment_rules,
      grading_rules: existing.grading_rules,
      approval_rules: existing.approval_rules,
    };
    await this.saveExtendedRules(tx, ctx, newId, extRules);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.eligibility_policy.duplicate',
        resourceType: 'exam_eligibility_policy',
        resourceId: newId,
        riskTier: 1,
        changes: { sourceId: id, name: newName },
      },
      meta ?? {},
    );

    return this.enrichPolicy(tx, ctx, created);
  }

  /** Activate a policy */
  static async activatePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    meta?: AuditRequestMeta,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const policy = await this.getPolicyById(tx, ctx, id);
    const ext = await this.getExtendedRules(tx, ctx, id);
    ext.status = 'ACTIVE';
    await this.saveExtendedRules(tx, ctx, id, ext);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.eligibility_policy.activate',
        resourceType: 'exam_eligibility_policy',
        resourceId: id,
        riskTier: 1,
      },
      meta ?? {},
    );

    return this.enrichPolicy(tx, ctx, policy);
  }

  /** Archive a policy */
  static async archivePolicy(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    meta?: AuditRequestMeta,
  ): Promise<EligibilityPolicyDto> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const policy = await this.getPolicyById(tx, ctx, id);
    const ext = await this.getExtendedRules(tx, ctx, id);
    ext.status = 'ARCHIVED';
    await this.saveExtendedRules(tx, ctx, id, ext);

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.eligibility_policy.archive',
        resourceType: 'exam_eligibility_policy',
        resourceId: id,
        riskTier: 1,
      },
      meta ?? {},
    );

    return this.enrichPolicy(tx, ctx, policy);
  }

  /** Preview policy impact on a schedule without modifying database */
  static async previewPolicyImpact(
    tx: TenantTx,
    ctx: TrustedContext,
    input: PolicyPreviewImpactInput,
  ): Promise<PolicyPreviewImpactResponse> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'exam.manage');

    const schedule = await ExamService.getSchedule(tx, ctx, input.schedule_id);

    let policy: EligibilityPolicyDto;
    if (input.policy) {
      policy = {
        id: 'preview',
        name: input.policy.name,
        min_attendance_percentage: input.policy.min_attendance_percentage,
        check_attendance: input.policy.check_attendance,
        check_fees: input.policy.check_fees,
        attendance_cutoff_days_prior: input.policy.attendance_cutoff_days_prior,
        allow_late_enrolment_review: input.policy.allow_late_enrolment_review,
        attendance_rules: input.policy.attendance_rules,
        fee_rules: input.policy.fee_rules,
        academic_rules: input.policy.academic_rules,
        assessment_rules: input.policy.assessment_rules,
        grading_rules: input.policy.grading_rules,
        approval_rules: input.policy.approval_rules,
        version: 1,
      };
    } else if (input.policy_id) {
      policy = await this.getPolicyById(tx, ctx, input.policy_id);
    } else {
      policy = await this.getOrResolvePolicy(tx, ctx, input.schedule_id, schedule.examination_id);
    }

    const examDate = new Date(schedule.exam_date);
    const priorDays = policy.attendance_cutoff_days_prior || 0;
    examDate.setUTCDate(examDate.getUTCDate() - priorDays);
    const cutoffDate = examDate.toISOString().split('T')[0] ?? schedule.exam_date;

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

    const feeMap = new Map<string, { total_balance: bigint }>();
    if (policy.check_fees && rosterRes.rows.length > 0) {
      const studentIds = rosterRes.rows.map((r) => r.student_id);
      const duesRes = await tx.query<{
        student_id: string;
        total_balance: string;
      }>(
        `SELECT student_id,
                coalesce(sum(balance_remaining), 0)::text AS total_balance
           FROM app.student_dues
          WHERE organization_id = $1
            AND student_id = ANY($2)
            AND status <> 'CANCELLED'
          GROUP BY student_id`,
        [ctx.tenantId, studentIds],
      );
      for (const row of duesRes.rows) {
        feeMap.set(row.student_id, { total_balance: BigInt(row.total_balance) });
      }
    }

    let simulatedEligible = 0;
    let simulatedNotEligible = 0;
    let simulatedNeedsReview = 0;
    const sampleResults: CandidateItem[] = [];

    const excusedMode = policy.attendance_rules?.excused_treatment ?? 'EXEMPT';
    const lateMode = policy.attendance_rules?.late_treatment ?? 'PRESENT';
    const minSessions = policy.attendance_rules?.min_sessions ?? 0;
    const feeTolerance = policy.fee_rules?.max_balance_tolerance ?? 0;

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

      let attendedSessions = attStats.present;
      if (lateMode === 'HALF_DAY') {
        attendedSessions += 0.5 * attStats.late;
      } else if (lateMode === 'PRESENT') {
        attendedSessions += attStats.late;
      }

      if (excusedMode === 'PRESENT') {
        attendedSessions += attStats.excused;
      }

      let denomSessions = totalSessions;
      if (excusedMode === 'EXEMPT') {
        denomSessions = Math.max(1, totalSessions - attStats.excused);
      }

      const attendancePercentage =
        denomSessions > 0 ? Math.round((attendedSessions / denomSessions) * 10000) / 100 : 0;
      const minPercentage = Number(policy.min_attendance_percentage);

      if (policy.check_attendance) {
        if (totalSessions === 0) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push('No conducted class sessions recorded prior to cutoff date');
        } else if (minSessions > 0 && totalSessions < minSessions) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push(`Insufficient sessions held (${totalSessions} < required ${minSessions})`);
        } else if (attendancePercentage >= minPercentage) {
          reasons.push(`Attendance criteria met: ${attendancePercentage}% >= ${minPercentage}%`);
        } else {
          evalStatus = 'NOT_ELIGIBLE';
          reasons.push(
            `Attendance below required threshold: ${attendancePercentage}% < ${minPercentage}%`,
          );
        }

        if (policy.allow_late_enrolment_review && student.enrolled_at && firstSessionDate) {
          const enrollDateStr = student.enrolled_at.split('T')[0];
          if (enrollDateStr && enrollDateStr > firstSessionDate) {
            evalStatus = 'NEEDS_REVIEW';
            reasons.push(
              `Mid-period enrolment on ${enrollDateStr} after first session (${firstSessionDate})`,
            );
          }
        }
      }

      if (policy.check_fees) {
        const feeSummary = feeMap.get(student.student_id);
        const bal = feeSummary ? Number(feeSummary.total_balance) / 100 : 0;
        if (!feeSummary) {
          if (evalStatus === 'ELIGIBLE') evalStatus = 'NEEDS_REVIEW';
          reasons.push('No fee assessment record found');
        } else if (bal > feeTolerance) {
          if (evalStatus === 'ELIGIBLE') evalStatus = 'NEEDS_REVIEW';
          reasons.push(
            `Outstanding fee balance of ₹${bal.toFixed(2)} exceeds permitted tolerance of ₹${feeTolerance}`,
          );
        } else {
          reasons.push(
            `Fee clearance verified (balance ₹${bal.toFixed(2)} within tolerance ₹${feeTolerance})`,
          );
        }
      }

      if (evalStatus === 'ELIGIBLE') simulatedEligible++;
      else if (evalStatus === 'NOT_ELIGIBLE') simulatedNotEligible++;
      else simulatedNeedsReview++;

      sampleResults.push({
        candidate_id: `sim-${student.student_id}`,
        student_id: student.student_id,
        admission_number: student.admission_number,
        student_name: student.student_name,
        roll_number: student.roll_number,
        evaluation_status: evalStatus,
        override_status: 'NONE',
        final_status: evalStatus === 'ELIGIBLE' ? 'ELIGIBLE' : 'NOT_ELIGIBLE',
        reasons,
        evidence_summary: {
          total_sessions: totalSessions,
          attended_sessions: Math.round(attendedSessions),
          absent_sessions: attStats.absent,
          excused_sessions: attStats.excused,
          attendance_percentage: attendancePercentage,
          required_percentage: minPercentage,
          cutoff_date: cutoffDate,
          reasons,
        },
      });
    }

    return {
      schedule_id: input.schedule_id,
      total_enrolled: rosterRes.rows.length,
      simulated_eligible: simulatedEligible,
      simulated_not_eligible: simulatedNotEligible,
      simulated_needs_review: simulatedNeedsReview,
      sample_results: sampleResults,
    };
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

    const excusedTreatment = policy.attendance_rules?.excused_treatment ?? 'EXEMPT';
    const lateTreatment = policy.attendance_rules?.late_treatment ?? 'PRESENT';
    const minSessionsReq = policy.attendance_rules?.min_sessions ?? 0;
    const feeToleranceAmount = policy.fee_rules?.max_balance_tolerance ?? 0;

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

      let attendedSessions = attStats.present;
      if (lateTreatment === 'HALF_DAY') {
        attendedSessions += 0.5 * attStats.late;
      } else if (lateTreatment === 'PRESENT') {
        attendedSessions += attStats.late;
      }

      if (excusedTreatment === 'PRESENT') {
        attendedSessions += attStats.excused;
      }

      let effectiveTotal = totalSessions;
      if (excusedTreatment === 'EXEMPT') {
        effectiveTotal = Math.max(1, totalSessions - attStats.excused);
      }

      const attendancePercentage =
        effectiveTotal > 0 ? Math.round((attendedSessions / effectiveTotal) * 10000) / 100 : 0;
      const minPercentage = Number(policy.min_attendance_percentage);

      // Check Attendance
      if (policy.check_attendance) {
        if (totalSessions === 0) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push('No conducted class sessions recorded prior to cutoff date');
        } else if (minSessionsReq > 0 && totalSessions < minSessionsReq) {
          evalStatus = 'NEEDS_REVIEW';
          reasons.push(
            `Insufficient recorded sessions (${totalSessions} recorded < required ${minSessionsReq})`,
          );
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
        } else if (Number(feeSummary.total_balance) / 100 > feeToleranceAmount) {
          feeStatus = 'OUTSTANDING';
          outstandingBalance = Number(feeSummary.total_balance);
          if (evalStatus === 'ELIGIBLE') {
            evalStatus = 'NEEDS_REVIEW';
          }
          reasons.push(
            `Outstanding fee balance of ${(Number(feeSummary.total_balance) / 100).toFixed(2)} exceeds permitted tolerance of ₹${feeToleranceAmount}`,
          );
        } else {
          feeStatus = 'CLEARED';
          outstandingBalance = Number(feeSummary.total_balance);
          reasons.push(
            feeToleranceAmount > 0
              ? `Fee clearance verified (balance ${(Number(feeSummary.total_balance) / 100).toFixed(2)} within tolerance ₹${feeToleranceAmount})`
              : 'Fee clearance verified: no outstanding dues',
          );
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
        attended_sessions: Math.round(attendedSessions),
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
      rosterRes.rows.length,
      eligibleCount,
      notEligibleCount,
      needsReviewCount,
      JSON.stringify(policy),
      ctx.userId,
    ]);

    const createdList = listRes.rows[0]!;

    // Insert Candidate Items
    if (candidateItems.length > 0) {
      for (const c of candidateItems) {
        await tx.query(
          `INSERT INTO app.exam_candidates (
            id, organization_id, candidate_list_id, student_id,
            evaluation_status, override_status, final_status,
            reasons, evidence_summary
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            c.candidate_id,
            ctx.tenantId,
            candidateListId,
            c.student_id,
            c.evaluation_status,
            c.override_status,
            c.final_status,
            c.reasons,
            JSON.stringify(c.evidence_summary),
          ],
        );
      }
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'exam.candidates.generate',
        resourceType: 'exam_candidate_list',
        resourceId: candidateListId,
        riskTier: 2,
        changes: {
          scheduleId,
          snapshotVersion,
          totalCandidates: rosterRes.rows.length,
          eligibleCount,
          notEligibleCount,
          needsReviewCount,
        },
      },
      meta ?? {},
    );

    return {
      list: {
        id: createdList.id,
        exam_schedule_id: createdList.exam_schedule_id,
        policy_id: createdList.policy_id,
        policy_version: createdList.policy_version,
        snapshot_version: createdList.snapshot_version,
        status: createdList.status,
        evidence_cutoff_date: createdList.evidence_cutoff_date,
        total_candidates: createdList.total_candidates,
        eligible_count: createdList.eligible_count,
        not_eligible_count: createdList.not_eligible_count,
        needs_review_count: createdList.needs_review_count,
        policy_snapshot: createdList.policy_snapshot,
        generated_at: createdList.generated_at,
        approved_at: createdList.approved_at,
        approved_by_user_id: createdList.approved_by_user_id,
      },
      candidates: candidateItems,
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
