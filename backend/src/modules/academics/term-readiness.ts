import { Type, type Static } from '@sinclair/typebox';
import type { TenantTx } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';

/**
 * Activation readiness of a term (Task 8 doc 35 §3; Task 9: enforced by TermService.update on EVERY PLANNED -> ACTIVE
 * transition, whichever route asks for it). Read-only SQL over the term's own rows; no authorization here: callers
 * check scope first.
 */

const strict = { additionalProperties: false } as const;
const OPEN = `('PLANNED', 'ACTIVE')`;

export const IssueSchema = Type.Object(
  {
    code: Type.String(),
    severity: Type.Union([Type.Literal('ERROR'), Type.Literal('WARNING')]),
    count: Type.Integer(),
  },
  strict,
);
export type Issue = Static<typeof IssueSchema>;

export const TermReadinessSchema = Type.Object(
  {
    id: Type.String(),
    code: Type.String(),
    name: Type.String(),
    status: Type.String(),
    version: Type.Integer(),
    startDate: Type.String(),
    endDate: Type.String(),
    campusId: Type.String(),
    campusName: Type.String(),
    academicYearId: Type.String(),
    academicYearLabel: Type.String(),
    academicYearStatus: Type.String(),
    activatable: Type.Boolean(),
    blocking: Type.Array(IssueSchema),
    warnings: Type.Array(IssueSchema),
  },
  strict,
);
export type TermReadiness = Static<typeof TermReadinessSchema>;

export interface TermRow {
  id: string;
  code: string;
  name: string;
  status: string;
  version: number;
  start_date: string;
  end_date: string;
  campus_id: string;
  campus_name: string;
  campus_status: string;
  year_id: string;
  year_label: string;
  year_status: string;
  cohort_periods: string;
  periods_without_section: string;
  sections_without_class_teacher: string;
  offerings: string;
  offerings_without_teacher: string;
  offerings_without_slot: string;
  holidays: string;
  enrolments: string;
  enrolments_without_section: string;
}

/** One row per term ($2 = term id, or NULL for every open term of the tenant). */
export const TERM_SQL = `
SELECT t.id, t.code, t.name, t.status, t.version, t.start_date::text, t.end_date::text, t.campus_id,
       c.name AS campus_name, c.status AS campus_status, y.id AS year_id, y.label AS year_label, y.status AS year_status,
       (SELECT count(*) FROM app.cohort_periods cp WHERE cp.organization_id = t.organization_id AND cp.term_id = t.id
           AND cp.status = 'ACTIVE') AS cohort_periods,
       (SELECT count(*) FROM app.cohort_periods cp WHERE cp.organization_id = t.organization_id AND cp.term_id = t.id
           AND cp.status = 'ACTIVE'
           AND NOT EXISTS (SELECT 1 FROM app.sections s WHERE s.organization_id = cp.organization_id
                              AND s.cohort_period_id = cp.id AND s.status = 'ACTIVE')) AS periods_without_section,
       (SELECT count(*) FROM app.sections s
          JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
         WHERE s.organization_id = t.organization_id AND cp.term_id = t.id AND s.status = 'ACTIVE'
           AND NOT EXISTS (SELECT 1 FROM app.section_class_teachers x WHERE x.organization_id = s.organization_id
                              AND x.section_id = s.id AND role = 'PRIMARY'
                              AND (x.valid_to IS NULL OR x.valid_to >= t.end_date))) AS sections_without_class_teacher,
       (SELECT count(*) FROM app.course_offerings o WHERE o.organization_id = t.organization_id AND o.term_id = t.id
           AND o.status = 'PUBLISHED') AS offerings,
       (SELECT count(*) FROM app.course_offerings o WHERE o.organization_id = t.organization_id AND o.term_id = t.id
           AND o.status = 'PUBLISHED'
           AND NOT EXISTS (SELECT 1 FROM app.faculty_assignments fa WHERE fa.organization_id = o.organization_id
                              AND fa.course_offering_id = o.id AND (fa.valid_to IS NULL OR fa.valid_to >= t.end_date))
       ) AS offerings_without_teacher,
       (SELECT count(*) FROM app.course_offerings o WHERE o.organization_id = t.organization_id AND o.term_id = t.id
           AND o.status = 'PUBLISHED'
           AND NOT EXISTS (SELECT 1 FROM app.timetable_slots ts WHERE ts.organization_id = o.organization_id
                              AND ts.course_offering_id = o.id AND (ts.effective_to IS NULL OR ts.effective_to >= t.end_date))
       ) AS offerings_without_slot,
       (SELECT count(*) FROM app.holidays h WHERE h.organization_id = t.organization_id AND h.status = 'ACTIVE'
           AND (h.campus_id IS NULL OR h.campus_id = t.campus_id)
           AND h.holiday_date BETWEEN t.start_date AND t.end_date) AS holidays,
       (SELECT count(*) FROM app.term_enrollments e WHERE e.organization_id = t.organization_id AND e.term_id = t.id
           AND e.status IN ('REGISTERED', 'ACTIVE')) AS enrolments,
       (SELECT count(*) FROM app.term_enrollments e WHERE e.organization_id = t.organization_id AND e.term_id = t.id
           AND e.status IN ('REGISTERED', 'ACTIVE')
           AND EXISTS (SELECT 1 FROM app.sections s WHERE s.organization_id = e.organization_id AND s.cohort_period_id = e.cohort_period_id)
           AND NOT EXISTS (SELECT 1 FROM app.section_memberships m WHERE m.organization_id = e.organization_id
                              AND m.term_enrollment_id = e.id AND m.valid_to IS NULL)) AS enrolments_without_section
  FROM app.terms t
  JOIN app.campuses c ON c.organization_id = t.organization_id AND c.id = t.campus_id
  JOIN app.academic_years y ON y.organization_id = t.organization_id AND y.id = t.academic_year_id
 WHERE t.organization_id = $1 AND ($2::uuid IS NULL OR t.id = $2::uuid) AND ($2::uuid IS NOT NULL OR t.status IN ${OPEN})
 ORDER BY t.start_date, c.name, t.code`;

/**
 * Activation readiness of one term. ERRORs block activation; WARNINGs are recommendations the administrator may accept.
 * The rules are the wizard's own (doc 35 §3) plus the database's (an ACTIVE academic year): a term needs an active
 * cohort period and published, fully staffed offerings; sections, class teachers, timetable, holidays and enrolments only warn, because colleges and universities
 * legitimately activate without some of them.
 */
export function readiness(r: TermRow): TermReadiness {
  const n = (x: string) => Number(x);
  const blocking: Issue[] = [];
  const warnings: Issue[] = [];
  const add = (list: Issue[], code: string, count: number, severity: Issue['severity']) => {
    if (count > 0) list.push({ code, severity, count });
  };
  add(blocking, 'CAMPUS_INACTIVE', r.campus_status === 'ACTIVE' ? 0 : 1, 'ERROR');
  // the terms guard admits PLANNED -> ACTIVE only inside an ACTIVE academic year (0033)
  add(blocking, 'ACADEMIC_YEAR_NOT_ACTIVE', r.year_status === 'ACTIVE' ? 0 : 1, 'ERROR');
  add(blocking, 'NO_COHORT_PERIOD', n(r.cohort_periods) === 0 ? 1 : 0, 'ERROR');
  add(blocking, 'NO_PUBLISHED_OFFERING', n(r.offerings) === 0 ? 1 : 0, 'ERROR');
  add(blocking, 'OFFERING_WITHOUT_TEACHER', n(r.offerings_without_teacher), 'ERROR');
  add(warnings, 'PERIOD_WITHOUT_SECTION', n(r.periods_without_section), 'WARNING');
  add(warnings, 'SECTION_WITHOUT_CLASS_TEACHER', n(r.sections_without_class_teacher), 'WARNING');
  add(warnings, 'OFFERING_WITHOUT_SLOT', n(r.offerings_without_slot), 'WARNING');
  add(warnings, 'TERM_WITHOUT_HOLIDAY', n(r.holidays) === 0 ? 1 : 0, 'WARNING');
  add(warnings, 'NO_OPEN_ENROLMENT', n(r.enrolments) === 0 ? 1 : 0, 'WARNING');
  add(warnings, 'ENROLMENT_WITHOUT_SECTION', n(r.enrolments_without_section), 'WARNING');
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    version: r.version,
    startDate: r.start_date,
    endDate: r.end_date,
    campusId: r.campus_id,
    campusName: r.campus_name,
    academicYearId: r.year_id,
    academicYearLabel: r.year_label,
    academicYearStatus: r.year_status,
    activatable: r.status === 'PLANNED' && blocking.length === 0,
    blocking,
    warnings,
  };
}

/** The readiness of one term (undefined when the term does not exist in the tenant). */
export async function termReadiness(
  tx: TenantTx,
  tenantId: string,
  termId: string,
): Promise<TermReadiness | undefined> {
  const r = await tx.query<TermRow>(TERM_SQL, [tenantId, termId]);
  return r.rows[0] ? readiness(r.rows[0]) : undefined;
}

/** The one refusal for an incomplete term, on every activation path: 409, code, and each blocking code with its count. */
export function setupIncomplete(blocking: Issue[]): AppError {
  return new AppError(
    409,
    'SETUP_INCOMPLETE',
    'The term is not ready to be activated.',
    blocking.map((b) => ({ field: b.code, message: String(b.count) })),
  );
}
