import { Type, type Static } from '@sinclair/typebox';
import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { assertOrgWide, ensureTrusted } from './common.js';
import { TermService, type UpdateOptions } from './calendar.service.js';
import { ReasonSchema } from './calendar.schemas.js';
import {
  IssueSchema,
  TERM_SQL,
  TermReadinessSchema,
  readiness,
  type Issue,
  type TermRow,
} from './term-readiness.js';

/**
 * The guided academic setup wizard (Task 8, doc 35). Progress is DERIVED: every step's state is counted from the
 * tenant's records each time it is read, so "saving" a step is creating its records through the existing APIs, resuming
 * is reading this again, and a revisited or retried step can never create a second copy of anything (the wizard itself
 * writes nothing). The one write is activation, which re-checks readiness on the server and then goes through the
 * existing TermService.update, so every term-lifecycle rule (transitions, If-Match, audit) still applies.
 */

const strict = { additionalProperties: false } as const;
const StepSchema = Type.Object(
  {
    key: Type.String(),
    required: Type.Boolean(),
    status: Type.Union([
      Type.Literal('COMPLETE'),
      Type.Literal('ATTENTION'),
      Type.Literal('INCOMPLETE'),
    ]),
    counts: Type.Record(Type.String(), Type.Integer()),
    issues: Type.Array(IssueSchema),
  },
  strict,
);
type Step = Static<typeof StepSchema>;

const CampusSchema = Type.Object(
  {
    id: Type.String(),
    code: Type.String(),
    name: Type.String(),
    status: Type.String(),
    departments: Type.Integer(),
    openTerms: Type.Integer(),
    openSections: Type.Integer(),
    postedEmployees: Type.Integer(),
    rooms: Type.Integer(),
    campusHolidays: Type.Integer(),
  },
  strict,
);

export const WizardResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        organizationName: Type.String(),
        terminologyCustomised: Type.Boolean(),
        requiredSteps: Type.Integer(),
        requiredComplete: Type.Integer(),
        steps: Type.Array(StepSchema),
        campuses: Type.Array(CampusSchema),
        terms: Type.Array(TermReadinessSchema),
      },
      strict,
    ),
  },
  strict,
);
export type WizardData = Static<typeof WizardResponseSchema>['data'];

export const ActivationBodySchema = Type.Object({ reason: Type.Optional(ReasonSchema) }, strict);
export type ActivationBody = Static<typeof ActivationBodySchema>;

/** "Open" = PLANNED or ACTIVE, as in the setup checklist. */
const OPEN = `('PLANNED', 'ACTIVE')`;
/** Counts over the whole tenant ($1); each is one subquery so the result is one row. */
const ORG_COUNTS: Record<string, string> = {
  periodTypes: `SELECT count(*) FROM app.period_types WHERE organization_id = $1`,
  campuses: `SELECT count(*) FROM app.campuses WHERE organization_id = $1 AND status = 'ACTIVE'`,
  departments: `SELECT count(*) FROM app.departments WHERE organization_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
  campusesWithoutDepartment: `SELECT count(*) FROM app.campuses c WHERE c.organization_id = $1 AND c.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM app.departments d WHERE d.organization_id = c.organization_id AND d.campus_id = c.id
                         AND d.status = 'ACTIVE' AND d.deleted_at IS NULL)`,
  academicYears: `SELECT count(*) FROM app.academic_years WHERE organization_id = $1 AND status IN ${OPEN}`,
  terms: `SELECT count(*) FROM app.terms WHERE organization_id = $1 AND status IN ${OPEN}`,
  activeTerms: `SELECT count(*) FROM app.terms WHERE organization_id = $1 AND status = 'ACTIVE'`,
  campusesWithoutTerm: `SELECT count(*) FROM app.campuses c WHERE c.organization_id = $1 AND c.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM app.terms t WHERE t.organization_id = c.organization_id AND t.campus_id = c.id
                         AND t.status IN ${OPEN})`,
  programmes: `SELECT count(*) FROM app.programs WHERE organization_id = $1 AND status = 'ACTIVE'`,
  cohorts: `SELECT count(*) FROM app.cohorts WHERE organization_id = $1 AND status = 'ACTIVE'`,
  cohortPeriods: `SELECT count(*) FROM app.cohort_periods cp JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
      WHERE cp.organization_id = $1 AND cp.status = 'ACTIVE' AND t.status IN ${OPEN}`,
  programmesWithoutPeriod: `SELECT count(*) FROM app.programs p WHERE p.organization_id = $1 AND p.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM app.cohorts c
                        JOIN app.cohort_periods cp ON cp.organization_id = c.organization_id AND cp.cohort_id = c.id
                        JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
                       WHERE c.organization_id = p.organization_id AND c.program_id = p.id
                         AND cp.status = 'ACTIVE' AND t.status IN ${OPEN})`,
  sections: `SELECT count(*) FROM app.sections s
      JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
      JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
     WHERE s.organization_id = $1 AND s.status = 'ACTIVE' AND t.status IN ${OPEN}`,
  periodsWithoutSection: `SELECT count(*) FROM app.cohort_periods cp JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
     WHERE cp.organization_id = $1 AND cp.status = 'ACTIVE' AND t.status IN ${OPEN}
       AND NOT EXISTS (SELECT 1 FROM app.sections s WHERE s.organization_id = cp.organization_id
                          AND s.cohort_period_id = cp.id AND s.status = 'ACTIVE')`,
  sectionsWithoutCapacity: `SELECT count(*) FROM app.sections s
      JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
      JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
     WHERE s.organization_id = $1 AND s.status = 'ACTIVE' AND t.status IN ${OPEN} AND s.capacity IS NULL`,
  courses: `SELECT count(*) FROM app.courses WHERE organization_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`,
  programmesWithoutCurriculum: `SELECT count(*) FROM app.programs p WHERE p.organization_id = $1 AND p.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM app.curriculum_courses cc WHERE cc.organization_id = p.organization_id AND cc.program_id = p.id)`,
  employees: `SELECT count(*) FROM app.employees WHERE organization_id = $1 AND status = 'ACTIVE'`,
  // ponytail: "today" is the database's current_date, not each campus's calendar day; off by at most one day near midnight.
  employeesWithoutPosting: `SELECT count(*) FROM app.employees e WHERE e.organization_id = $1 AND e.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM app.employee_postings ep WHERE ep.organization_id = e.organization_id
                         AND ep.employee_id = e.id AND ep.is_primary AND ep.valid_from <= current_date
                         AND (ep.valid_to IS NULL OR ep.valid_to >= current_date))`,
  offerings: `SELECT count(*) FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
      WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ${OPEN}`,
  offeringsWithoutTeacher: `SELECT count(*) FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
      WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ${OPEN}
        AND NOT EXISTS (SELECT 1 FROM app.faculty_assignments fa WHERE fa.organization_id = o.organization_id
                           AND fa.course_offering_id = o.id AND (fa.valid_to IS NULL OR fa.valid_to >= t.end_date))`,
  sectionsWithoutClassTeacher: `SELECT count(*) FROM app.sections s
      JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
      JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
     WHERE s.organization_id = $1 AND s.status = 'ACTIVE' AND t.status IN ${OPEN}
       AND NOT EXISTS (SELECT 1 FROM app.section_class_teachers x WHERE x.organization_id = s.organization_id
                          AND x.section_id = s.id AND role = 'PRIMARY' AND (x.valid_to IS NULL OR x.valid_to >= t.end_date))`,
  rooms: `SELECT count(*) FROM app.rooms WHERE organization_id = $1`,
  offeringsWithoutSlot: `SELECT count(*) FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
      WHERE o.organization_id = $1 AND o.status = 'PUBLISHED' AND t.status IN ${OPEN}
        AND NOT EXISTS (SELECT 1 FROM app.timetable_slots ts WHERE ts.organization_id = o.organization_id
                           AND ts.course_offering_id = o.id AND (ts.effective_to IS NULL OR ts.effective_to >= t.end_date))`,
  termsWithoutHoliday: `SELECT count(*) FROM app.terms t WHERE t.organization_id = $1 AND t.status IN ${OPEN}
      AND NOT EXISTS (SELECT 1 FROM app.holidays h WHERE h.organization_id = t.organization_id AND h.status = 'ACTIVE'
                         AND (h.campus_id IS NULL OR h.campus_id = t.campus_id)
                         AND h.holiday_date BETWEEN t.start_date AND t.end_date)`,
  students: `SELECT count(*) FROM app.students WHERE organization_id = $1 AND status = 'ACTIVE'`,
  enrolments: `SELECT count(*) FROM app.term_enrollments e JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
      WHERE e.organization_id = $1 AND e.status IN ('REGISTERED', 'ACTIVE') AND t.status IN ${OPEN}`,
  enrolmentsWithoutSection: `SELECT count(*) FROM app.term_enrollments e JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
      WHERE e.organization_id = $1 AND e.status IN ('REGISTERED', 'ACTIVE') AND t.status IN ${OPEN}
        AND EXISTS (SELECT 1 FROM app.sections s WHERE s.organization_id = e.organization_id AND s.cohort_period_id = e.cohort_period_id)
        AND NOT EXISTS (SELECT 1 FROM app.section_memberships m WHERE m.organization_id = e.organization_id
                           AND m.term_enrollment_id = e.id AND m.valid_to IS NULL)`,
  registrations: `SELECT count(*) FROM app.course_registrations r
      JOIN app.term_enrollments e ON e.organization_id = r.organization_id AND e.id = r.term_enrollment_id
      JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
     WHERE r.organization_id = $1 AND r.valid_to IS NULL AND t.status IN ${OPEN}`,
};

type Rule = [
  code: string,
  severity: Issue['severity'],
  count: (c: Record<string, number>) => number,
];
/** Each step: which counts it shows and which conditions are an ERROR (blocks the step) or a WARNING (recommendation). */
const STEPS: ReadonlyArray<{ key: string; required: boolean; counts: string[]; rules: Rule[] }> = [
  { key: 'institution', required: true, counts: [], rules: [] },
  {
    key: 'campuses',
    required: true,
    counts: ['campuses', 'departments'],
    rules: [
      ['NO_ACTIVE_CAMPUS', 'ERROR', (c) => (c.campuses === 0 ? 1 : 0)],
      ['NO_ACTIVE_DEPARTMENT', 'ERROR', (c) => (c.departments === 0 ? 1 : 0)],
      ['CAMPUS_WITHOUT_DEPARTMENT', 'WARNING', (c) => c.campusesWithoutDepartment!],
    ],
  },
  {
    key: 'calendar',
    required: true,
    counts: ['academicYears', 'terms'],
    rules: [
      ['NO_OPEN_ACADEMIC_YEAR', 'ERROR', (c) => (c.academicYears === 0 ? 1 : 0)],
      ['NO_OPEN_TERM', 'ERROR', (c) => (c.terms === 0 ? 1 : 0)],
      ['CAMPUS_WITHOUT_OPEN_TERM', 'WARNING', (c) => c.campusesWithoutTerm!],
    ],
  },
  {
    key: 'programmes',
    required: true,
    counts: ['periodTypes', 'programmes', 'cohorts', 'cohortPeriods'],
    rules: [
      ['NO_PERIOD_TYPE', 'ERROR', (c) => (c.periodTypes === 0 ? 1 : 0)],
      ['NO_ACTIVE_PROGRAMME', 'ERROR', (c) => (c.programmes === 0 ? 1 : 0)],
      ['NO_ACTIVE_COHORT', 'ERROR', (c) => (c.cohorts === 0 ? 1 : 0)],
      ['NO_OPEN_COHORT_PERIOD', 'ERROR', (c) => (c.cohortPeriods === 0 ? 1 : 0)],
      ['PROGRAMME_WITHOUT_OPEN_PERIOD', 'WARNING', (c) => c.programmesWithoutPeriod!],
    ],
  },
  {
    key: 'sections',
    required: true,
    counts: ['sections'],
    rules: [
      ['NO_OPEN_SECTION', 'ERROR', (c) => (c.sections === 0 ? 1 : 0)],
      ['PERIOD_WITHOUT_SECTION', 'WARNING', (c) => c.periodsWithoutSection!],
      ['SECTION_WITHOUT_CAPACITY', 'WARNING', (c) => c.sectionsWithoutCapacity!],
    ],
  },
  {
    key: 'curriculum',
    required: true,
    counts: ['courses'],
    rules: [
      ['NO_ACTIVE_COURSE', 'ERROR', (c) => (c.courses === 0 ? 1 : 0)],
      ['PROGRAMME_WITHOUT_CURRICULUM', 'WARNING', (c) => c.programmesWithoutCurriculum!],
    ],
  },
  {
    key: 'staff',
    required: true,
    counts: ['employees'],
    rules: [['NO_ACTIVE_EMPLOYEE', 'ERROR', (c) => (c.employees === 0 ? 1 : 0)]],
  },
  {
    key: 'assignments',
    required: true,
    counts: ['offerings'],
    rules: [
      ['NO_PUBLISHED_OFFERING', 'ERROR', (c) => (c.offerings === 0 ? 1 : 0)],
      ['OFFERING_WITHOUT_TEACHER', 'ERROR', (c) => c.offeringsWithoutTeacher!],
      ['EMPLOYEE_WITHOUT_POSTING', 'WARNING', (c) => c.employeesWithoutPosting!],
    ],
  },
  {
    key: 'classTeachers',
    required: false,
    counts: ['sections'],
    rules: [['SECTION_WITHOUT_CLASS_TEACHER', 'WARNING', (c) => c.sectionsWithoutClassTeacher!]],
  },
  {
    key: 'timetable',
    required: false,
    counts: ['rooms'],
    rules: [
      ['NO_ROOM', 'WARNING', (c) => (c.rooms === 0 ? 1 : 0)],
      ['OFFERING_WITHOUT_SLOT', 'WARNING', (c) => c.offeringsWithoutSlot!],
    ],
  },
  {
    key: 'holidays',
    required: false,
    counts: [],
    rules: [['TERM_WITHOUT_HOLIDAY', 'WARNING', (c) => c.termsWithoutHoliday!]],
  },
  {
    key: 'enrolment',
    required: false,
    counts: ['students', 'enrolments', 'registrations'],
    rules: [
      ['NO_ACTIVE_STUDENT', 'WARNING', (c) => (c.students === 0 ? 1 : 0)],
      ['NO_OPEN_ENROLMENT', 'WARNING', (c) => (c.enrolments === 0 ? 1 : 0)],
      ['ENROLMENT_WITHOUT_SECTION', 'WARNING', (c) => c.enrolmentsWithoutSection!],
      ['NO_LIVE_REGISTRATION', 'WARNING', (c) => (c.registrations === 0 ? 1 : 0)],
    ],
  },
  {
    key: 'review',
    required: true,
    counts: ['activeTerms'],
    rules: [['NO_ACTIVE_TERM', 'ERROR', (c) => (c.activeTerms === 0 ? 1 : 0)]],
  },
];

export class SetupWizardService {
  /**
   * The whole wizard, organization-wide: like the setup checklist it counts every campus, so only an ORGANIZATION-scoped
   * `academic.term.manage` holder may read it (403 otherwise). Read-only: no row, version or audit event is written.
   */
  static async overview(tx: TenantTx, ctx: TrustedContext): Promise<WizardData> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await assertOrgWide(tx, ctx, 'academic.term.manage');

    const keys = Object.keys(ORG_COUNTS);
    const row = (
      await tx.query<Record<string, string>>(
        `SELECT ${keys.map((k) => `(${ORG_COUNTS[k]}) AS "${k}"`).join(',\n')}`,
        [ctx.tenantId],
      )
    ).rows[0]!;
    const c = Object.fromEntries(keys.map((k) => [k, Number(row[k])]));

    const steps: Step[] = STEPS.map((s) => {
      const issues: Issue[] = s.rules
        .map(([code, severity, f]) => ({ code, severity, count: f(c) }))
        .filter((i) => i.count > 0);
      const status: Step['status'] = issues.some((i) => i.severity === 'ERROR')
        ? 'INCOMPLETE'
        : issues.length > 0
          ? 'ATTENTION'
          : 'COMPLETE';
      return {
        key: s.key,
        required: s.required,
        status,
        counts: Object.fromEntries(s.counts.map((k) => [k, c[k]!])),
        issues,
      };
    });

    const org = await tx.query<{ name: string; customised: boolean }>(
      `SELECT o.name, EXISTS (SELECT 1 FROM app.organization_settings s
                                WHERE s.organization_id = o.id AND s.key = 'terminology') AS customised
         FROM app.organizations o WHERE o.id = $1`,
      [ctx.tenantId],
    );
    const campuses = await tx.query<{
      id: string;
      code: string;
      name: string;
      status: string;
      departments: string;
      open_terms: string;
      open_sections: string;
      posted: string;
      rooms: string;
      holidays: string;
    }>(
      `SELECT c.id, c.code, c.name, c.status,
              (SELECT count(*) FROM app.departments d WHERE d.organization_id = c.organization_id AND d.campus_id = c.id
                  AND d.status = 'ACTIVE' AND d.deleted_at IS NULL) AS departments,
              (SELECT count(*) FROM app.terms t WHERE t.organization_id = c.organization_id AND t.campus_id = c.id
                  AND t.status IN ${OPEN}) AS open_terms,
              (SELECT count(*) FROM app.sections s
                 JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
                 JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
                WHERE s.organization_id = c.organization_id AND t.campus_id = c.id AND s.status = 'ACTIVE'
                  AND t.status IN ${OPEN}) AS open_sections,
              (SELECT count(DISTINCT ep.employee_id) FROM app.employee_postings ep
                 JOIN app.departments d ON d.organization_id = ep.organization_id AND d.id = ep.department_id
                WHERE ep.organization_id = c.organization_id AND d.campus_id = c.id AND ep.is_primary
                  AND ep.valid_from <= current_date AND (ep.valid_to IS NULL OR ep.valid_to >= current_date)) AS posted,
              (SELECT count(*) FROM app.rooms r WHERE r.organization_id = c.organization_id AND r.campus_id = c.id) AS rooms,
              (SELECT count(*) FROM app.holidays h WHERE h.organization_id = c.organization_id AND h.campus_id = c.id
                  AND h.status = 'ACTIVE') AS holidays
         FROM app.campuses c WHERE c.organization_id = $1 ORDER BY c.name`,
      [ctx.tenantId],
    );
    const terms = await tx.query<TermRow>(TERM_SQL, [ctx.tenantId, null]);
    const required = steps.filter((s) => s.required);
    return {
      organizationName: org.rows[0]?.name ?? '',
      terminologyCustomised: org.rows[0]?.customised ?? false,
      requiredSteps: required.length,
      requiredComplete: required.filter((s) => s.status !== 'INCOMPLETE').length,
      steps,
      campuses: campuses.rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status,
        departments: Number(r.departments),
        openTerms: Number(r.open_terms),
        openSections: Number(r.open_sections),
        postedEmployees: Number(r.posted),
        rooms: Number(r.rooms),
        campusHolidays: Number(r.holidays),
      })),
      terms: terms.rows.map(readiness),
    };
  }

  /**
   * Explicit activation (PLANNED -> ACTIVE). Since Task 9 the readiness rules live in TermService.update itself, so this
   * route and PATCH /terms/:id refuse an incomplete term identically (409 SETUP_INCOMPLETE); scope (403/404), If-Match,
   * transitions, lock rules and audit are TermService.update's. A retry of an already ACTIVE term with its current
   * version is answered with the unchanged term (no version bump, no audit).
   */
  static async activateTerm(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    body: ActivationBody,
    options: UpdateOptions,
  ) {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    return TermService.update(
      tx,
      ctx,
      id,
      { status: 'ACTIVE', ...(body.reason !== undefined ? { reason: body.reason } : {}) },
      options,
    );
  }
}
