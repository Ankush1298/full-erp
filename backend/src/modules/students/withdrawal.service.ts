import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { invalid, parseReason } from '../people/validation.js';
import { TermEnrollmentService } from './term-enrollment.service.js';

export const WITHDRAWAL_PERMISSION = 'student.status.change';

export interface RegisterWithdrawalInput {
  effectiveDate: string;
  reason: unknown;
  supportingDocuments?: string[];
}

export class WithdrawalService {
  /**
   * Registers a student withdrawal request.
   * This is an additive audit process that prepares the system for the approval lifecycle.
   */
  static async registerRequest(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: RegisterWithdrawalInput,
    meta?: AuditRequestMeta,
  ): Promise<{ requestId: string }> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    AuthorizationEngine.assertStaffActor(ctx);
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');

    const reason = parseReason(input.reason);

    // Verify student exists
    const exists = await tx.query(`SELECT 1 FROM app.students WHERE organization_id = $1 AND id = $2`, [ctx.tenantId, studentId]);
    if (!exists.rows[0]) throw resourceNotFound();

    // Log the request in an audit table or a dedicated request table (proposed schema)
    // For now, we record this as an auditable "request" event.
    const requestId = await recordAudit(
      tx,
      ctx,
      {
        action: 'student.withdrawal.request',
        resourceType: 'student',
        resourceId: studentId,
        subjectStudentId: studentId,
        riskTier: 2,
        reasonText: reason,
        metadata: {
          effectiveDate: input.effectiveDate,
          supportingDocuments: input.supportingDocuments ?? [],
        },
      },
      meta ?? {},
    );

    return { requestId };
  }

  /**
   * Approves a withdrawal and transitions the student's status.
   */
  static async approveWithdrawal(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    enrollmentId: string,
    meta?: AuditRequestMeta,
  ): Promise<void> {
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, WITHDRAWAL_PERMISSION);

    // Update enrollment status to WITHDRAWN
    // Re-use TermEnrollmentService.update to maintain audit trail and consistency
    await TermEnrollmentService.update(tx, ctx, enrollmentId, {
      status: 'WITHDRAWN',
      reason: 'Approved school withdrawal request',
    }, {
      expected: { type: 'version', version: 0 }, // Simplified for initial phase
      studentId,
      meta: meta ?? {},
    });

    // Additional logic to exclude from active class rosters is handled by status query filters
    // in existing roster/attendance services.
  }
}
