import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { invalid, parseReason } from '../people/validation.js';
import { STUDENT_STATUSES, type StudentRecordDto } from './student.schemas.js';
import { STUDENT_COLUMNS, toStudentRecordDto, type StudentRow } from './student.service.js';
import {
  closeActiveEnrolmentForStatusChange,
  lockActiveEnrolment,
} from './student-program.service.js';
import {
  ENROLMENT_CLOSE_OUTCOME,
  assertTransitionAllowed,
  isStudentStatus,
} from './student-status.js';

export const STATUS_CHANGE_PERMISSION = 'student.status.change';

export interface ChangeStudentStatusInput {
  status: unknown;
  reason: unknown;
}

/**
 * Student status transitions (Phase 3b, docs/architecture/v3/21-students.md §6b). The ONLY writer of
 * `app.students.status` after creation (a static test pins that), and the only caller of the enrolment closure for a
 * status change.
 *
 * ORDER (each step can only reveal what the one before it allowed):
 *   request shape (400, incl. an If-Match that is not an exact version) -> staff actor (403) -> `student.status.change`
 *   held (403) -> student row `FOR NO KEY UPDATE` (missing/other tenant: 404) -> the student's ACTIVE enrolment
 *   `FOR NO KEY UPDATE` (same lock order as `open`; `close` locks only the enrolment, so no cycle) -> scope proof (404)
 *   -> version (409 CONFLICT) -> transition table (409 STUDENT_STATUS_TRANSITION_INVALID / _UNAVAILABLE) -> enrolment
 *   closure when the target requires it (409 STUDENT_STATUS_ENROLMENT_NOT_CLOSABLE) -> guarded student UPDATE
 *   (`id`, `version` and the status read under the lock; 0 rows -> 409) -> tier-2 audit LAST.
 *
 * SCOPE (decision D6): the permission is GRANTED. An ORGANIZATION-scoped grant covers every student of the tenant. A
 * campus- or department-scoped grant is proven only from the persisted ACTIVE enrolment's frozen campus/department read
 * here; a student with no ACTIVE enrolment carries no campus/department, so only an ORGANIZATION grant reaches it. Nothing
 * is inferred from a missing relationship, and no caller-supplied scope exists.
 *
 * ENROLMENT (D7/D8): the permission alone authorizes the closure it implies; the end date is the campus-local today and a
 * closure that cannot legally happen refuses the WHOLE transaction. Everything below shares the caller's transaction, so a
 * failed status update, enrolment close or audit write leaves no row and no success audit record.
 *
 * CRITICAL permission: the reason is mandatory and the change is audited at tier 2. That is accountability, NOT step-up
 * authentication and NOT an independent approval; neither exists in this code base (decision D10).
 */
export class StudentStatusService {
  static async change(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: ChangeStudentStatusInput,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<StudentRecordDto> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    if (!input || typeof input !== 'object') throw invalid('Status change payload is required.');
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    const id = studentId.toLowerCase();
    if (!isStudentStatus(input.status)) {
      throw invalid(`status must be one of ${STUDENT_STATUSES.join(', ')}.`);
    }
    const target = input.status;
    const reason = parseReason(input.reason);
    const exp = options.expected;
    if (exp.type !== 'version') {
      throw invalid('If-Match must carry the exact version of the student.');
    }

    // Staff only, before any statement (refuses STUDENT and any unknown actor kind with 403).
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, STATUS_CHANGE_PERMISSION);

    const current = await tx.query<StudentRow>(
      `SELECT ${STUDENT_COLUMNS} FROM app.students
        WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, id],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();

    const enrolment = await lockActiveEnrolment(tx, ctx.tenantId, id);
    // The scope is what the database holds: the ACTIVE enrolment's frozen campus/department, or nothing at all.
    await AuthorizationEngine.assert(tx, ctx, STATUS_CHANGE_PERMISSION, {
      organization_id: ctx.tenantId,
      ...(enrolment
        ? { campus_id: enrolment.campus_id, department_id: enrolment.department_id }
        : {}),
    });

    // Only now may the caller learn anything about the stored version or state.
    if (exp.version !== row.version) {
      throw new AppError(409, 'CONFLICT', 'Student version mismatch.');
    }
    assertTransitionAllowed(row.status, target);

    const outcome = ENROLMENT_CLOSE_OUTCOME[target];
    let closedEnrolmentId: string | null = null;
    if (outcome !== undefined && enrolment) {
      const closed = await closeActiveEnrolmentForStatusChange(
        tx,
        ctx,
        enrolment,
        outcome,
        reason,
        options.meta ?? {},
      );
      closedEnrolmentId = closed.id;
    }

    const updated = await tx.query<StudentRow>(
      `UPDATE app.students SET status = $3
        WHERE organization_id = $1 AND id = $2 AND version = $4 AND status = $5
        RETURNING ${STUDENT_COLUMNS}`,
      [ctx.tenantId, id, target, row.version, row.status],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'Student was changed concurrently. Retry.');

    await recordAudit(
      tx,
      ctx,
      {
        action: 'student.status.change',
        resourceType: 'student',
        resourceId: id,
        subjectStudentId: id,
        ...(enrolment
          ? { campusId: enrolment.campus_id, departmentId: enrolment.department_id }
          : {}),
        riskTier: 2,
        reasonText: reason,
        changes: { status: { old: row.status, new: target } },
        ...(closedEnrolmentId ? { metadata: { closedStudentProgramId: closedEnrolmentId } } : {}),
      },
      options.meta ?? {},
    );
    return toStudentRecordDto(saved);
  }
}
