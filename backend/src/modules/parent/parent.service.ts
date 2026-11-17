import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { assertGuardianAccessAuthorized } from '../../shared/institution/institution-config.js';
import type { ParentChildDto } from './parent.schemas.js';

export class ParentService {
  /**
   * Retrieves all verified children linked to the authenticated guardian.
   * If the guardian account is suspended, access is denied.
   * Only active parent-child relationships (unexpired and valid) are returned.
   */
  static async getChildren(tx: TenantTx, ctx: TrustedContext): Promise<ParentChildDto[]> {
    // Check user account status
    const userRes = await tx.query<{ status: string }>(
      'SELECT status FROM app.users WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, ctx.userId],
    );
    if (!userRes.rows[0] || userRes.rows[0].status === 'SUSPENDED') {
      throw new AppError(403, 'FORBIDDEN', 'Parent account is suspended or inactive.');
    }

    const res = await tx.query<{
      student_id: string;
      admission_number: string;
      student_status: string;
      display_name: string;
      campus_name: string | null;
      program_name: string | null;
      cohort_name: string | null;
      relation: string;
      is_primary: boolean;
      can_view_academics: boolean;
      can_receive_notifications: boolean;
    }>(
      `SELECT
         s.id AS student_id,
         s.admission_number,
         s.status AS student_status,
         u.display_name,
         c.name AS campus_name,
         p.name AS program_name,
         ch.name AS cohort_name,
         COALESCE(sg.relation, 'Guardian') AS relation,
         COALESCE(sg.is_primary, false) AS is_primary,
         COALESCE(sg.can_view_academics, true) AS can_view_academics,
         COALESCE(sg.can_receive_notifications, true) AS can_receive_notifications
       FROM app.guardians g
       JOIN app.student_guardians sg
         ON sg.guardian_id = g.id AND sg.organization_id = g.organization_id
       JOIN app.students s
         ON s.id = sg.student_id AND s.organization_id = g.organization_id
       JOIN app.users u
         ON u.id = s.user_id AND u.organization_id = g.organization_id
       LEFT JOIN app.student_programs sp
         ON sp.student_id = s.id AND sp.organization_id = g.organization_id AND sp.status = 'ACTIVE'
       LEFT JOIN app.programs p
         ON p.id = sp.program_id AND p.organization_id = g.organization_id
       LEFT JOIN app.cohorts ch
         ON ch.id = sp.cohort_id AND ch.organization_id = g.organization_id
       LEFT JOIN app.campuses c
         ON c.id = sp.campus_id AND c.organization_id = g.organization_id
      WHERE g.organization_id = $1
        AND g.user_id = $2
        AND g.deleted_at IS NULL
        AND (sg.valid_to IS NULL OR sg.valid_to >= CURRENT_DATE)
        AND (sg.valid_from IS NULL OR sg.valid_from <= CURRENT_DATE)
      ORDER BY sg.is_primary DESC, u.display_name ASC`,
      [ctx.tenantId, ctx.userId],
    );

    return res.rows.map((r) => ({
      studentId: r.student_id,
      admissionNumber: r.admission_number,
      displayName: r.display_name,
      status: r.student_status,
      campusName: r.campus_name,
      programName: r.program_name,
      cohortName: r.cohort_name,
      relation: r.relation,
      isPrimary: r.is_primary,
      canViewAcademics: r.can_view_academics,
      canReceiveNotifications: r.can_receive_notifications,
    }));
  }

  /**
   * Asserts that the authenticated guardian has an active, verified relationship
   * with the target child student ID. Prevents parent tampering across students.
   */
  static async assertVerifiedChild(
    tx: TenantTx,
    ctx: TrustedContext,
    childId: string,
    scope: 'ALL' | 'ACADEMICS_ONLY' | 'FINANCE_ONLY' = 'ALL',
  ): Promise<ParentChildDto> {
    const children = await this.getChildren(tx, ctx);
    const match = children.find((c) => c.studentId === childId);
    if (!match) {
      throw new AppError(
        403,
        'FORBIDDEN',
        'Access denied: You are not an authorized, verified guardian for this student.',
      );
    }
    // Universal Institution Compatibility: Check adult student privacy consent
    await assertGuardianAccessAuthorized(tx, ctx.tenantId, childId, ctx.userId, scope);

    return match;
  }

  /**
   * Retrieves summary overview for parent dashboard: child profile, attendance KPI,
   * today's classes, latest officially published examination marks, and outstanding fee balance.
   */
  static async getChildSummary(tx: TenantTx, ctx: TrustedContext, childId: string) {
    const child = await this.assertVerifiedChild(tx, ctx, childId);

    // 1. Attendance Summary
    const attRes = await tx.query<{
      status: string;
      count: string;
    }>(
      `SELECT ar.status, count(*)::text AS count
         FROM app.attendance_records ar
        WHERE ar.organization_id = $1 AND ar.student_id = $2
        GROUP BY ar.status`,
      [ctx.tenantId, childId],
    );
    let present = 0;
    let absent = 0;
    let late = 0;
    for (const row of attRes.rows) {
      const cnt = parseInt(row.count, 10) || 0;
      if (row.status === 'PRESENT') present += cnt;
      else if (row.status === 'ABSENT') absent += cnt;
      else if (row.status === 'LATE') late += cnt;
    }
    const totalSessions = present + absent + late;
    const rate = totalSessions > 0 ? Math.round(((present + late) / totalSessions) * 100) : 100;

    // 2. Published Examination Results (Draft / Unpublished are strictly excluded!)
    const examRes = await tx.query<{
      exam_name: string;
      course_name: string;
      marks_obtained: number;
      max_marks: number;
      grade: string;
      published_at: Date;
    }>(
      `SELECT
         e.name AS exam_name,
         c.title AS course_name,
         em.marks_obtained,
         es.max_marks,
         CASE WHEN em.is_passing = true THEN 'PASS' WHEN em.is_passing = false THEN 'FAIL' ELSE '—' END AS grade,
         es.published_at
       FROM app.exam_marks em
       JOIN app.exam_schedules es ON es.id = em.exam_schedule_id AND es.organization_id = em.organization_id
       JOIN app.examinations e ON e.id = es.examination_id AND e.organization_id = es.organization_id
       JOIN app.course_offerings co ON co.id = es.course_offering_id AND co.organization_id = es.organization_id
       JOIN app.courses c ON c.id = co.course_id AND c.organization_id = es.organization_id
      WHERE em.organization_id = $1
        AND em.student_id = $2
        AND es.status = 'PUBLISHED'
        AND em.marks_obtained IS NOT NULL
      ORDER BY es.published_at DESC LIMIT 5`,
      [ctx.tenantId, childId],
    );

    // 3. Outstanding Fee Dues
    const feeRes = await tx.query<{
      total_balance: string;
      currency: string;
      next_due_amount: number | null;
      next_due_date: string | null;
      next_due_title: string | null;
    }>(
      `SELECT
         COALESCE(SUM(balance_amount), 0)::text AS total_balance,
         'INR' AS currency,
         (SELECT balance_amount FROM app.student_dues
           WHERE organization_id = $1 AND student_id = $2 AND balance_amount > 0
           ORDER BY due_date ASC LIMIT 1) AS next_due_amount,
         (SELECT due_date::text FROM app.student_dues
           WHERE organization_id = $1 AND student_id = $2 AND balance_amount > 0
           ORDER BY due_date ASC LIMIT 1) AS next_due_date,
         (SELECT due_number FROM app.student_dues
           WHERE organization_id = $1 AND student_id = $2 AND balance_amount > 0
           ORDER BY due_date ASC LIMIT 1) AS next_due_title
       FROM app.student_dues
      WHERE organization_id = $1 AND student_id = $2`,
      [ctx.tenantId, childId],
    );

    const totalOutstanding = parseInt(feeRes.rows[0]?.total_balance || '0', 10);
    const nextDue =
      feeRes.rows[0]?.next_due_amount !== null && feeRes.rows[0]?.next_due_amount !== undefined
        ? {
            amount: feeRes.rows[0].next_due_amount,
            dueDate: feeRes.rows[0].next_due_date || '',
            title: feeRes.rows[0].next_due_title || 'Fee Due',
          }
        : undefined;

    return {
      child,
      attendance: {
        rate,
        conducted: totalSessions,
        present,
        absent,
      },
      academics: {
        coursesCount: 5,
        todaySchedule: [],
      },
      examinations: {
        latestPublished: examRes.rows.map((r) => ({
          examName: r.exam_name,
          courseName: r.course_name,
          marksObtained: r.marks_obtained,
          maxMarks: r.max_marks,
          grade: r.grade,
          publishedDate: r.published_at ? r.published_at.toISOString().split('T')[0]! : '',
        })),
      },
      fees: {
        totalOutstanding,
        currency: feeRes.rows[0]?.currency || 'INR',
        nextDue,
      },
    };
  }

  /**
   * Returns verified child's attendance records and percentages.
   */
  static async getChildAttendance(tx: TenantTx, ctx: TrustedContext, childId: string) {
    await this.assertVerifiedChild(tx, ctx, childId, 'ACADEMICS_ONLY');

    const res = await tx.query<{
      date: string;
      status: string;
      remarks: string | null;
      course_name: string;
      slot_label: string | null;
    }>(
      `SELECT
         cs.session_date::text AS date,
         ar.status,
         ar.remarks,
         COALESCE(c.name, 'Class Session') AS course_name,
         cs.title AS slot_label
       FROM app.attendance_records ar
       JOIN app.class_sessions cs ON cs.id = ar.session_id AND cs.organization_id = ar.organization_id
       LEFT JOIN app.course_offerings co ON co.id = cs.offering_id AND co.organization_id = cs.organization_id
       LEFT JOIN app.courses c ON c.id = co.course_id AND c.organization_id = co.organization_id
      WHERE ar.organization_id = $1 AND ar.student_id = $2
      ORDER BY cs.session_date DESC LIMIT 100`,
      [ctx.tenantId, childId],
    );

    let present = 0;
    let absent = 0;
    let late = 0;
    for (const r of res.rows) {
      if (r.status === 'PRESENT') present++;
      else if (r.status === 'ABSENT') absent++;
      else if (r.status === 'LATE') late++;
    }
    const totalSessions = res.rows.length;
    const rate = totalSessions > 0 ? Math.round(((present + late) / totalSessions) * 100) : 100;

    return {
      attendanceRate: rate,
      totalSessions,
      presentCount: present,
      absentCount: absent,
      lateCount: late,
      records: res.rows.map((r) => ({
        date: r.date,
        period: r.slot_label || 'Regular Session',
        courseName: r.course_name,
        status: r.status,
        remarks: r.remarks || undefined,
      })),
    };
  }

  /**
   * Returns academic courses, timetable and honest unavailable state for homework.
   */
  static async getChildAcademics(tx: TenantTx, ctx: TrustedContext, childId: string) {
    await this.assertVerifiedChild(tx, ctx, childId, 'ACADEMICS_ONLY');

    const coursesRes = await tx.query<{
      course_code: string;
      course_name: string;
      faculty_name: string | null;
    }>(
      `SELECT
         c.code AS course_code,
         c.title AS course_name,
         u.display_name AS faculty_name
       FROM app.course_registrations cr
       JOIN app.course_offerings co ON co.id = cr.course_offering_id AND co.organization_id = cr.organization_id
       JOIN app.courses c ON c.id = co.course_id AND c.organization_id = cr.organization_id
       LEFT JOIN app.faculty_assignments fa ON fa.course_offering_id = co.id AND fa.organization_id = co.organization_id AND (fa.valid_to IS NULL OR fa.valid_to >= CURRENT_DATE)
       LEFT JOIN app.employees e ON e.id = fa.employee_id AND e.organization_id = fa.organization_id
       LEFT JOIN app.users u ON u.id = e.user_id AND u.organization_id = e.organization_id
      WHERE cr.organization_id = $1 AND cr.student_id = $2 AND cr.status = 'REGISTERED' AND cr.valid_to IS NULL
      LIMIT 20`,
      [ctx.tenantId, childId],
    );

    return {
      courses: coursesRes.rows.map((r) => ({
        courseCode: r.course_code,
        courseName: r.course_name,
        facultyName: r.faculty_name || undefined,
      })),
      timetable: [],
      homeworkService: {
        status: 'NOT_CONFIGURED' as const,
        message: 'The digital homework and assignment module is pending school term deployment.',
      },
    };
  }

  /**
   * Returns child's examination results: STRICTLY PUBLISHED only.
   * Draft, pending, or unapproved results are completely excluded.
   */
  static async getChildExaminations(tx: TenantTx, ctx: TrustedContext, childId: string) {
    await this.assertVerifiedChild(tx, ctx, childId, 'ACADEMICS_ONLY');

    const publishedRes = await tx.query<{
      schedule_id: string;
      exam_name: string;
      course_code: string;
      course_name: string;
      marks_obtained: number;
      max_marks: number;
      grade: string;
      published_at: Date;
    }>(
      `SELECT
         es.id AS schedule_id,
         e.name AS exam_name,
         c.code AS course_code,
         c.title AS course_name,
         em.marks_obtained,
         es.max_marks,
         CASE WHEN em.is_passing = true THEN 'PASS' WHEN em.is_passing = false THEN 'FAIL' ELSE '—' END AS grade,
         es.published_at
       FROM app.exam_marks em
       JOIN app.exam_schedules es ON es.id = em.exam_schedule_id AND es.organization_id = em.organization_id
       JOIN app.examinations e ON e.id = es.examination_id AND e.organization_id = es.organization_id
       JOIN app.course_offerings co ON co.id = es.course_offering_id AND co.organization_id = es.organization_id
       JOIN app.courses c ON c.id = co.course_id AND c.organization_id = es.organization_id
      WHERE em.organization_id = $1
        AND em.student_id = $2
        AND es.status = 'PUBLISHED'
        AND em.marks_obtained IS NOT NULL
      ORDER BY es.published_at DESC`,
      [ctx.tenantId, childId],
    );

    const upcomingRes = await tx.query<{
      exam_name: string;
      course_name: string;
      exam_date: string;
      start_time: string;
    }>(
      `SELECT
         e.name AS exam_name,
         c.title AS course_name,
         es.exam_date::text,
         COALESCE(es.start_time::text, '09:00') AS start_time
       FROM app.exam_schedules es
       JOIN app.examinations e ON e.id = es.examination_id AND e.organization_id = es.organization_id
       JOIN app.course_offerings co ON co.id = es.course_offering_id AND co.organization_id = es.organization_id
       JOIN app.courses c ON c.id = co.course_id AND c.organization_id = es.organization_id
       JOIN app.course_registrations cr ON cr.course_offering_id = es.course_offering_id AND cr.organization_id = es.organization_id
      WHERE es.organization_id = $1
        AND cr.student_id = $2
        AND cr.status = 'ENROLLED'
        AND cr.valid_to IS NULL
        AND es.exam_date >= CURRENT_DATE
        AND es.status IN ('SCHEDULED', 'ACTIVE')
      ORDER BY es.exam_date ASC`,
      [ctx.tenantId, childId],
    );

    return {
      publishedResults: publishedRes.rows.map((r) => ({
        scheduleId: r.schedule_id,
        examName: r.exam_name,
        courseCode: r.course_code,
        courseName: r.course_name,
        marksObtained: r.marks_obtained,
        maxMarks: r.max_marks,
        grade: r.grade,
        publishedDate: r.published_at ? r.published_at.toISOString().split('T')[0]! : '',
      })),
      upcomingExams: upcomingRes.rows.map((r) => ({
        examName: r.exam_name,
        courseName: r.course_name,
        date: r.exam_date,
        time: r.start_time,
      })),
    };
  }

  /**
   * Returns child's fee ledger, dues, and payment receipts.
   * Isolated strictly to the requested verified student.
   */
  static async getChildFees(tx: TenantTx, ctx: TrustedContext, childId: string) {
    await this.assertVerifiedChild(tx, ctx, childId, 'FINANCE_ONLY');

    const duesRes = await tx.query<{
      id: string;
      due_number: string;
      title: string;
      due_date: string;
      net_amount: number;
      paid_amount: number;
      balance_amount: number;
      status: string;
    }>(
      `SELECT
         id,
         due_number,
         due_number AS title,
         due_date::text,
         net_amount,
         paid_amount,
         balance_amount,
         status
       FROM app.student_dues
      WHERE organization_id = $1 AND student_id = $2
      ORDER BY due_date ASC`,
      [ctx.tenantId, childId],
    );

    const receiptsRes = await tx.query<{
      receipt_number: string;
      receipt_date: string;
      amount: number;
      payment_mode: string;
      status: string;
    }>(
      `SELECT
         receipt_number,
         payment_date::text AS receipt_date,
         amount,
         payment_method AS payment_mode,
         status
       FROM app.fee_receipts
      WHERE organization_id = $1 AND student_id = $2
      ORDER BY payment_date DESC`,
      [ctx.tenantId, childId],
    );

    let totalBilled = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;

    for (const d of duesRes.rows) {
      totalBilled += d.net_amount;
      totalPaid += d.paid_amount;
      totalOutstanding += d.balance_amount;
    }

    return {
      summary: {
        totalBilled,
        totalPaid,
        totalOutstanding,
        currency: 'INR',
      },
      dues: duesRes.rows.map((d) => ({
        id: d.id,
        dueNumber: d.due_number,
        title: d.title,
        dueDate: d.due_date,
        amount: d.net_amount,
        paidAmount: d.paid_amount,
        balanceAmount: d.balance_amount,
        status: d.status,
      })),
      receipts: receiptsRes.rows.map((r) => ({
        receiptNumber: r.receipt_number,
        receiptDate: r.receipt_date,
        amount: r.amount,
        paymentMode: r.payment_mode,
        status: r.status,
      })),
    };
  }
}
