import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { NotificationService } from '../notifications/notification.service.js';

/**
 * AD-8 (doc 43 §0): in-app notifications to authorised staff only; no guardian, student, SMS or email message. A message
 * names the course and date and says what happened to the REQUEST or SESSION; it never carries a student, a status, a
 * reason text or a mark. Notices are written in the same transaction as the change (all or nothing); the SQL guard forbids savepoints, so there is no partial-failure mode.
 */
const service = new NotificationService();

export interface AttendanceNotice {
  title: string;
  body: string;
  entityType: string;
  entityId: string;
}

export async function notifyStaff(
  tx: TenantTx,
  ctx: TrustedContext,
  recipients: Iterable<string>,
  notice: AttendanceNotice,
): Promise<void> {
  const wanted = [...new Set(recipients)].filter((id) => id !== ctx.userId); // nobody is notified of their own action
  if (wanted.length === 0) return;
  // Only ACTIVE staff accounts of this tenant (a STUDENT account never receives an attendance notice).
  const active = await tx.query<{ id: string }>(
    `SELECT u.id FROM app.users u
      WHERE u.organization_id = $1 AND u.id = ANY($2::uuid[]) AND u.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM app.students s WHERE s.organization_id = u.organization_id AND s.user_id = u.id)`,
    [ctx.tenantId, wanted],
  );
  for (const { id } of active.rows) {
    await service.dispatch(tx, ctx, {
      recipientUserId: id,
      category: 'ACADEMIC',
      channels: ['IN_APP'],
      ...notice,
    });
  }
}

/** Users who may decide correction requests for this campus/department right now (same grants the engine reads). */
export function approverIds(
  tx: TenantTx,
  ctx: TrustedContext,
  campusId: string,
  departmentId: string,
): Promise<string[]> {
  return AuthorizationEngine.usersGrantedOver(tx, ctx, 'attendance.correction.approve', {
    campusId,
    departmentId,
  });
}

/** The user account of the employee who conducted a session. */
export async function conductorUserId(
  tx: TenantTx,
  ctx: TrustedContext,
  employeeId: string,
): Promise<string[]> {
  const r = await tx.query<{ user_id: string | null }>(
    `SELECT e.user_id FROM app.employees e WHERE e.organization_id = $1 AND e.id = $2 AND e.status = 'ACTIVE'`,
    [ctx.tenantId, employeeId],
  );
  const id = r.rows[0]?.user_id;
  return id ? [id] : [];
}
