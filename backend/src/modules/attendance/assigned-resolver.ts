import { registerAssignedResolver } from '../../shared/authorization/engine.js';

/**
 * X-12 (doc 09): the real ASSIGNED resolver for `attendance.session.mark`, `attendance.record.read` and `attendance.record.correct` (FACULTY, doc 03).
 * The caller proves the offering and the campus-local date from a server-read row (a session, or an offering plus the
 * requested session date); the resolver then requires, in this tenant only:
 *  - the actor's own employee row (`employees.user_id` = the session's user, never a request value) is ACTIVE and holds a
 *    faculty assignment on THAT offering that covers the date (an open assignment ends with its term);
 *  - the offering is PUBLISHED or CLOSED.
 * A missing offering or date, an assignment that has ended or not started, another offering, another tenant: deny, which
 * the engine reports as the same 404 as a missing resource. ASSIGNED never widens to the tenant.
 */
export const FACULTY_OFFERING_ON_DATE_SQL = `
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
     AND fa.valid_from <= $4::date AND COALESCE(fa.valid_to, t.end_date) >= $4::date
     AND ($5::text[] IS NULL OR fa."role" = ANY($5::text[]))
   LIMIT 1`;

/** AD-1 (doc 43 §0): correction is for regular assigned faculty only; substitutes and lab instructors can mark, not correct. */
export const CORRECTING_ASSIGNMENT_ROLES = ['PRIMARY', 'CO_INSTRUCTOR'];

export const ATTENDANCE_PERMISSIONS = [
  'attendance.session.mark',
  'attendance.record.read',
  'attendance.record.correct',
] as const;

export function registerAttendanceResolvers(): void {
  for (const permission of ATTENDANCE_PERMISSIONS) {
    registerAssignedResolver(permission, async (tx, ctx, resource) => {
      if (resource.course_offering_id === undefined || resource.session_date === undefined)
        return false;
      if (resource.organization_id !== undefined && resource.organization_id !== ctx.tenantId)
        return false;
      const r = await tx.query(FACULTY_OFFERING_ON_DATE_SQL, [
        ctx.tenantId,
        ctx.userId,
        resource.course_offering_id,
        resource.session_date,
        permission === 'attendance.record.correct' ? CORRECTING_ASSIGNMENT_ROLES : null,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
  }
}
