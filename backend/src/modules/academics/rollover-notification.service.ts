import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { NotificationService } from '../notifications/notification.service.js';

export class RolloverNotificationService {
  static async notifyPromotion(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    guardianUserId: string,
    newClass: string,
    academicYear: string,
  ): Promise<void> {
    const notif = new NotificationService();

    // Notify Student
    await notif.dispatch(tx, ctx, {
      recipientUserId: studentId,
      category: 'ACADEMIC',
      title: 'Academic Promotion Confirmed',
      body: `Congratulations! You have been promoted to ${newClass} for the academic year ${academicYear}. The new fee schedule is available in the portal.`,
      actionUrl: '/fees/payment',
    });

    // Notify Guardian
    await notif.dispatch(tx, ctx, {
      recipientUserId: guardianUserId,
      category: 'ACADEMIC',
      title: `Student Promotion - ${academicYear}`,
      body: `Your ward has been promoted to ${newClass} for the upcoming academic year. Please review the fee schedule in the Parent Portal.`,
      actionUrl: '/fees/payment',
    });
  }
}
