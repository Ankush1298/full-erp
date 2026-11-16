import { registerAssignedResolver } from '../../shared/authorization/engine.js';

/**
 * ASSIGNED resolver for `homework.manage`, `homework.review` and `homework.read` for FACULTY.
 * A faculty actor must hold an active faculty assignment for the target course offering.
 */
export const FACULTY_HOMEWORK_OFFERING_SQL = `
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
     AND fa.valid_from <= CURRENT_DATE AND COALESCE(fa.valid_to, t.end_date) >= CURRENT_DATE
   LIMIT 1`;

export const HOMEWORK_ASSIGNED_PERMISSIONS = [
  'homework.manage',
  'homework.review',
  'homework.read',
] as const;

export function registerHomeworkResolvers(): void {
  for (const permission of HOMEWORK_ASSIGNED_PERMISSIONS) {
    registerAssignedResolver(permission, async (tx, ctx, resource) => {
      if (!resource.course_offering_id) return false;
      if (resource.organization_id !== undefined && resource.organization_id !== ctx.tenantId) {
        return false;
      }
      const r = await tx.query(FACULTY_HOMEWORK_OFFERING_SQL, [
        ctx.tenantId,
        ctx.userId,
        resource.course_offering_id,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
  }
}
