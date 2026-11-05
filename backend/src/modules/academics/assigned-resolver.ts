import { registerAssignedResolver } from '../../shared/authorization/engine.js';

/**
 * X-12 (doc 09): the real ASSIGNED resolver for `student.profile.read` (FACULTY, doc 10 row 23). A teacher may read a
 * student's profile only while BOTH hold, by the campus-local calendar of the offering's campus (the same "today" as
 * every effective-dated row here):
 *  - the teacher's own employee row (`employees.user_id` = the session's user, never a request value) is ACTIVE and has
 *    a faculty assignment on the offering that has started and has not ended (an open assignment ends with its term);
 *  - the student holds a course registration on that offering that has started and has not ended (an open one ends
 *    with the term), in status REGISTERED or since closed on a later day; PENDING_APPROVAL and REJECTED never count;
 *  - the offering is PUBLISHED or CLOSED (a DRAFT or CANCELLED offering teaches nobody).
 * Ended, future-dated and revoked assignments, a revoked FACULTY role (no grant reaches here), other campuses' offerings
 * and other tenants (organization_id = the session's tenant on every row; RLS as well) all deny with the same 404.
 * Doc 33 §2.
 */
export const FACULTY_STUDENT_SQL = `
  SELECT 1
    FROM app.employees emp
    JOIN app.faculty_assignments fa
      ON fa.organization_id = emp.organization_id AND fa.employee_id = emp.id
    JOIN app.course_offerings o
      ON o.organization_id = fa.organization_id AND o.id = fa.course_offering_id
    JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
    JOIN app.campuses c ON c.organization_id = t.organization_id AND c.id = t.campus_id
    JOIN app.course_registrations r
      ON r.organization_id = o.organization_id AND r.course_offering_id = o.id
   CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE c.timezone)::date AS today) d
   WHERE emp.organization_id = $1 AND emp.user_id = $2 AND emp.status = 'ACTIVE'
     AND r.student_id = $3
     AND o.status IN ('PUBLISHED', 'CLOSED')
     AND fa.valid_from <= d.today AND COALESCE(fa.valid_to, t.end_date) >= d.today
     AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED')
     AND r.valid_from <= d.today AND COALESCE(r.valid_to, t.end_date) >= d.today
   LIMIT 1`;

export function registerFacultyStudentResolver(): void {
  registerAssignedResolver('student.profile.read', async (tx, ctx, resource) => {
    if (resource.student_id === undefined) return false;
    if (resource.organization_id !== undefined && resource.organization_id !== ctx.tenantId) {
      return false;
    }
    const r = await tx.query(FACULTY_STUDENT_SQL, [ctx.tenantId, ctx.userId, resource.student_id]);
    return (r.rowCount ?? 0) > 0;
  });
}
