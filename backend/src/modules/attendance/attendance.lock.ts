import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';

/**
 * AD-5 (doc 43 §0): locking an academic term locks its SUBMITTED attendance sessions. Called by the term service BEFORE the
 * term row moves to LOCKED (the 0040 guard refuses any session change once the term is LOCKED), in the same transaction, so
 * either both happen or neither. Sessions that never took attendance stay as they are; they cannot take any once the term is
 * LOCKED. Returns the number of sessions locked; one tier-3 audit event records it. There is no unlock (AD-6).
 */
export async function lockTermSessions(
  tx: TenantTx,
  ctx: TrustedContext,
  term: { id: string; campusId: string },
  meta: AuditRequestMeta,
  reason: string,
): Promise<number> {
  const res = await tx.query<{ id: string }>(
    `UPDATE app.class_sessions cs
        SET attendance_state = 'LOCKED', locked_at = now(), lock_reason = $3
       FROM app.course_offerings o
      WHERE cs.organization_id = $1 AND o.organization_id = cs.organization_id AND o.id = cs.course_offering_id
        AND o.term_id = $2 AND cs.attendance_state = 'SUBMITTED'
      RETURNING cs.id`,
    [ctx.tenantId, term.id, `Academic term locked: ${reason}`.slice(0, 500)],
  );
  await recordAudit(
    tx,
    ctx,
    {
      action: 'attendance.term.sessions_lock',
      resourceType: 'term',
      resourceId: term.id,
      campusId: term.campusId,
      riskTier: 3,
      reasonText: reason,
      metadata: { lockedSessionCount: res.rows.length },
    },
    meta,
  );
  return res.rows.length;
}
