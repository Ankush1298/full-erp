import { registerAssignedResolver } from '../../shared/authorization/engine.js';

/**
 * Assigned resolver for `exam.marks.enter` and `result.read` (FACULTY role, doc 47 Slice 1).
 * The caller supplies the course_offering_id (and optionally exam_date) from a verified schedule/offering.
 * The resolver requires, within this tenant:
 *  - the actor's employee row (`employees.user_id` = actor's user_id) is ACTIVE;
 *  - the actor holds an active `faculty_assignments` on that course offering;
 *  - the offering is PUBLISHED or CLOSED.
 */
export const FACULTY_OFFERING_EXAM_SQL = `
  SELECT 1
    FROM app.employees emp
    JOIN app.faculty_assignments fa
      ON fa.organization_id = emp.organization_id AND fa.employee_id = emp.id
    JOIN app.course_offerings o
      ON o.organization_id = fa.organization_id AND o.id = fa.course_offering_id
    JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
   WHERE emp.organization_id = $1 AND emp.user_id = $2 AND emp.status = 'ACTIVE'
     AND fa.course_offering_id = $3
     AND o.status IN ('PUBLISHED', 'CLOSED')
     AND ($4::date IS NULL OR (fa.valid_from <= $4::date AND COALESCE(fa.valid_to, t.end_date) >= $4::date))
   LIMIT 1`;

export const EXAM_ASSIGNED_PERMISSIONS = [
  'exam.marks.enter',
  'result.read',
] as const;

export function registerExamResolvers(): void {
  for (const permission of EXAM_ASSIGNED_PERMISSIONS) {
    registerAssignedResolver(permission, async (tx, ctx, resource) => {
      if (resource.course_offering_id === undefined) return false;
      if (resource.organization_id !== undefined && resource.organization_id !== ctx.tenantId)
        return false;
      const r = await tx.query(FACULTY_OFFERING_EXAM_SQL, [
        ctx.tenantId,
        ctx.userId,
        resource.course_offering_id,
        resource.exam_date ?? null,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
  }
}

