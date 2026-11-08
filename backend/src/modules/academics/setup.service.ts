import { Type, type Static } from '@sinclair/typebox';
import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  INSTITUTION_TYPE_KEY,
  TERMINOLOGY_DEFAULTS,
  TERMINOLOGY_SLOTS,
  isInstitutionType,
  roleLabelsFor,
  type InstitutionType,
} from '../../shared/settings/index.js';
import { CohortService, ProgramService } from './academic.service.js';
import { assertOrgWide, ensureTrusted } from './common.js';

/**
 * Terminology labels and the academic setup checklist (Part 16 Milestone 3; doc 33 §6-§7). Neither writes anything.
 */

type Slot = (typeof TERMINOLOGY_SLOTS)[number];
export { TERMINOLOGY_DEFAULTS };

const strict = { additionalProperties: false } as const;
export const TerminologyResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        labels: Type.Object(
          Object.fromEntries(TERMINOLOGY_SLOTS.map((k) => [k, Type.String()])) as Record<
            Slot,
            ReturnType<typeof Type.String>
          >,
          strict,
        ),
        customised: Type.Array(Type.String()),
        // Task 8 (doc 35 §4): every period type of the tenant with the period label its programmes show.
        periodTypes: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              code: Type.String(),
              periodTypeLabel: Type.String(),
              label: Type.String(),
              customised: Type.Boolean(),
            },
            strict,
          ),
        ),
        // Cohort id -> period label, only for cohorts the caller may list whose period type has its own label.
        byCohort: Type.Record(Type.String(), Type.String()),
        // Doc 44: the chosen institution type (null until onboarding sets it) and the role names shown for it. Display only.
        institutionType: Type.Union([
          Type.Literal('SCHOOL'),
          Type.Literal('COLLEGE'),
          Type.Literal('UNIVERSITY'),
          Type.Null(),
        ]),
        roleLabels: Type.Record(Type.String(), Type.String()),
      },
      strict,
    ),
  },
  strict,
);

const ItemSchema = Type.Object(
  { key: Type.String(), done: Type.Boolean(), count: Type.Integer(), detail: Type.String() },
  strict,
);
export type ChecklistItem = Static<typeof ItemSchema>;
export const ChecklistResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ complete: Type.Boolean(), items: Type.Array(ItemSchema) }, strict),
  },
  strict,
);

/**
 * Every item is a COUNT over the tenant's rows, so "done" is always what the database says, never a flag someone ticked.
 * `need` = what counts as done: `positive` (at least one row) or `zero` (no row may remain, e.g. unstaffed offerings).
 * An "open term" is a PLANNED or ACTIVE term.
 */
const ITEMS: ReadonlyArray<{
  key: string;
  need: 'positive' | 'zero';
  detail: string;
  sql: string;
}> = [
  {
    key: 'campuses',
    need: 'positive',
    detail: 'ACTIVE campuses',
    sql: `SELECT count(*) FROM app.campuses WHERE organization_id = $1 AND status = 'ACTIVE'`,
  },
  {
    key: 'departments',
    need: 'positive',
    detail: 'ACTIVE departments',
    sql: `SELECT count(*) FROM app.departments WHERE organization_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
  },
  {
    key: 'programs',
    need: 'positive',
    detail: 'ACTIVE programmes',
    sql: `SELECT count(*) FROM app.programs WHERE organization_id = $1 AND status = 'ACTIVE'`,
  },
  {
    key: 'academicYears',
    need: 'positive',
    detail: 'PLANNED or ACTIVE academic years',
    sql: `SELECT count(*) FROM app.academic_years WHERE organization_id = $1 AND status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'terms',
    need: 'positive',
    detail: 'open terms',
    sql: `SELECT count(*) FROM app.terms WHERE organization_id = $1 AND status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'cohortPeriods',
    need: 'positive',
    detail: 'ACTIVE cohort periods in open terms',
    sql: `SELECT count(*) FROM app.cohort_periods cp JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
           WHERE cp.organization_id = $1 AND cp.status = 'ACTIVE' AND t.status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'sections',
    need: 'positive',
    detail: 'ACTIVE sections of those cohort periods',
    sql: `SELECT count(*) FROM app.sections s
            JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
            JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
           WHERE s.organization_id = $1 AND s.status = 'ACTIVE' AND t.status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'courses',
    need: 'positive',
    detail: 'ACTIVE courses',
    sql: `SELECT count(*) FROM app.courses WHERE organization_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
  },
  {
    key: 'publishedOfferings',
    need: 'positive',
    detail: 'PUBLISHED offerings in open terms',
    sql: `SELECT count(*) FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
           WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'offeringsWithoutTeacher',
    need: 'zero',
    detail: 'PUBLISHED offerings in open terms with no teacher assignment running to the term end',
    sql: `SELECT count(*) FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
           WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ('PLANNED', 'ACTIVE')
             AND NOT EXISTS (SELECT 1 FROM app.faculty_assignments fa
                              WHERE fa.organization_id = o.organization_id AND fa.course_offering_id = o.id
                                AND (fa.valid_to IS NULL OR fa.valid_to >= t.end_date))`,
  },
  {
    key: 'termEnrollments',
    need: 'positive',
    detail: 'REGISTERED or ACTIVE term enrolments in open terms',
    sql: `SELECT count(*) FROM app.term_enrollments e JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
           WHERE e.organization_id = $1 AND e.status IN ('REGISTERED', 'ACTIVE') AND t.status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'enrollmentsWithoutSection',
    need: 'zero',
    detail:
      'those enrolments with no open section placement, where their cohort period has sections',
    sql: `SELECT count(*) FROM app.term_enrollments e JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
           WHERE e.organization_id = $1 AND e.status IN ('REGISTERED', 'ACTIVE') AND t.status IN ('PLANNED', 'ACTIVE')
             AND EXISTS (SELECT 1 FROM app.sections s WHERE s.organization_id = e.organization_id AND s.cohort_period_id = e.cohort_period_id)
             AND NOT EXISTS (SELECT 1 FROM app.section_memberships m
                              WHERE m.organization_id = e.organization_id AND m.term_enrollment_id = e.id AND m.valid_to IS NULL)`,
  },
  {
    key: 'courseRegistrations',
    need: 'positive',
    detail: 'live course registrations in open terms',
    sql: `SELECT count(*) FROM app.course_registrations r
            JOIN app.term_enrollments e ON e.organization_id = r.organization_id AND e.id = r.term_enrollment_id
            JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
           WHERE r.organization_id = $1 AND r.valid_to IS NULL AND t.status IN ('PLANNED', 'ACTIVE')`,
  },
  {
    key: 'openTermsWithoutHolidays',
    need: 'zero',
    detail: 'open terms with no ACTIVE holiday (campus or organization-wide) inside their dates',
    sql: `SELECT count(*) FROM app.terms t
           WHERE t.organization_id = $1 AND t.status IN ('PLANNED', 'ACTIVE')
             AND NOT EXISTS (SELECT 1 FROM app.holidays h
                              WHERE h.organization_id = t.organization_id AND h.status = 'ACTIVE'
                                AND (h.campus_id IS NULL OR h.campus_id = t.campus_id)
                                AND h.holiday_date BETWEEN t.start_date AND t.end_date)`,
  },
];

export class SetupService {
  /** Labels for the UI: the stored `terminology` value over the display fallbacks. Readable by every structure reader. */
  static async terminology(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<{
    labels: Record<Slot, string>;
    customised: string[];
    periodTypes: Array<{
      id: string;
      code: string;
      periodTypeLabel: string;
      label: string;
      customised: boolean;
    }>;
    byCohort: Record<string, string>;
    institutionType: InstitutionType | null;
    roleLabels: Record<string, string>;
  }> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');
    // organization_settings is readable inside the tenant (RLS) but the settings API needs org.settings.read; only this
    // one display key is read here.
    const r = await tx.query<{
      value: Partial<Record<Slot, string>> & { periodTypes?: Record<string, string> };
    }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'terminology'`,
      [ctx.tenantId],
    );
    const stored = r.rows[0]?.value ?? {};
    const labels = { ...TERMINOLOGY_DEFAULTS };
    const customised: string[] = [];
    for (const k of TERMINOLOGY_SLOTS) {
      const v = stored[k];
      if (typeof v === 'string' && v.length > 0) {
        labels[k] = v;
        customised.push(k);
      }
    }
    // Period types are tenant-wide reference data (GET /academics/period-types has no narrower scope).
    const own = stored.periodTypes ?? {};
    const pts = await tx.query<{ id: string; code: string; label: string }>(
      `SELECT id, code, label FROM app.period_types WHERE organization_id = $1 ORDER BY code`,
      [ctx.tenantId],
    );
    const periodTypes = pts.rows.map((p) => ({
      id: p.id,
      code: p.code,
      periodTypeLabel: p.label,
      label: own[p.code] ?? labels.period,
      customised: own[p.code] !== undefined,
    }));
    // The cohort map reuses the cohort and programme list services, so it shows exactly the cohorts the caller could
    // list anyway (department scope included) and nothing when no period type has its own label.
    const byCohort: Record<string, string> = {};
    const labelByType = new Map(
      periodTypes.filter((p) => p.customised).map((p) => [p.id, p.label]),
    );
    if (labelByType.size > 0) {
      const programType = new Map(
        (await ProgramService.list(tx, ctx)).map((p) => [p.id, p.periodTypeId]),
      );
      for (const c of await CohortService.list(tx, ctx)) {
        const l = labelByType.get(programType.get(c.programId) ?? '');
        if (l !== undefined) byCohort[c.id] = l;
      }
    }
    const t = await tx.query<{ value: unknown }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = $2`,
      [ctx.tenantId, INSTITUTION_TYPE_KEY],
    );
    const storedType = t.rows[0]?.value;
    const institutionType = isInstitutionType(storedType) ? storedType : null;
    return {
      labels,
      customised,
      periodTypes,
      byCohort,
      institutionType,
      roleLabels: roleLabelsFor(institutionType),
    };
  }

  /**
   * The setup checklist, organization-wide, so only an ORGANIZATION-scoped `academic.term.manage` holder may read it
   * (counts over every campus would otherwise leak to a campus-scoped admin). Not held ⇒ 403.
   */
  static async checklist(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<{ complete: boolean; items: ChecklistItem[] }> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await assertOrgWide(tx, ctx, 'academic.term.manage');
    const items: ChecklistItem[] = [];
    for (const it of ITEMS) {
      const r = await tx.query<{ count: string }>(it.sql, [ctx.tenantId]);
      const count = Number(r.rows[0]?.count ?? 0);
      items.push({
        key: it.key,
        done: it.need === 'positive' ? count > 0 : count === 0,
        count,
        detail: it.detail,
      });
    }
    return { complete: items.every((i) => i.done), items };
  }
}
