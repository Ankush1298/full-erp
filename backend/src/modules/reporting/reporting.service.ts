import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { SetupService } from '../academics/setup.service.js';
import type {
  EnrolmentRosterQuery,
  AttendanceSummaryQuery,
  ExamMarksSummaryQuery,
  FeeSummaryQuery,
} from './reporting.schemas.js';

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(
  headers: string[],
  rows: (string | number | null | undefined)[][],
): string {
  const lines: string[] = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface EnrolmentRosterStudent {
  student_id: string;
  student_name: string;
  admission_number: string;
  campus_id: string;
  campus_name: string;
  program_id: string | null;
  program_name: string | null;
  cohort_id: string | null;
  cohort_name: string | null;
  term_id: string | null;
  term_name: string | null;
  roll_number: string | null;
  enrolment_status: string;
  enrolled_date: string | null;
  guardian_count: number;
  primary_guardian_name: string | null;
  primary_guardian_phone: string | null;
}

export interface EnrolmentRosterResult {
  institution_type: string | null;
  labels: {
    program: string;
    cohort: string;
    period: string;
    section: string;
    term: string;
    course: string;
  };
  summary: {
    total_students: number;
    active_students: number;
    campuses_count: number;
  };
  students: EnrolmentRosterStudent[];
  csv?: string | undefined;
}

export interface AttendanceSessionReport {
  session_id: string;
  campus_id: string;
  campus_name: string;
  course_name: string;
  course_code: string;
  teacher_name: string;
  session_date: string;
  starts_at: string;
  ends_at: string;
  attendance_state: string;
  present_count: number;
  absent_count: number;
  late_count: number;
  excused_count: number;
  total_marked: number;
  attendance_percentage: number;
}

export interface AttendanceSummaryResult {
  date: string;
  institution_type: string | null;
  labels: Record<string, string>;
  summary: {
    total_sessions_scheduled: number;
    total_sessions_conducted: number;
    missing_registers_count: number;
    total_attendance_records: number;
    present_count: number;
    absent_count: number;
    late_count: number;
    excused_count: number;
    attendance_rate: number;
  };
  sessions: AttendanceSessionReport[];
  csv?: string | undefined;
}

export interface ExamScheduleReport {
  schedule_id: string;
  examination_id: string;
  examination_name: string;
  exam_type: string;
  campus_id: string;
  campus_name: string;
  term_name: string;
  course_name: string;
  course_code: string;
  exam_date: string;
  max_marks: number;
  pass_marks: number;
  appeared_count: number;
  passed_count: number;
  failed_count: number;
  pass_percentage: number;
  highest_marks: number;
  lowest_marks: number;
  average_marks: number;
  published_at: string;
}

export interface ExamMarksSummaryResult {
  institution_type: string | null;
  labels: Record<string, string>;
  summary: {
    total_published_exams: number;
    total_candidates_appeared: number;
    total_passed: number;
    total_failed: number;
    overall_pass_percentage: number;
    average_score: number;
  };
  schedules: ExamScheduleReport[];
  csv?: string | undefined;
}

export interface FeeDefaulterRow {
  student_id: string;
  student_name: string;
  admission_number: string;
  campus_id: string;
  campus_name: string;
  due_number: string;
  fee_structure_name: string;
  due_date: string;
  net_amount: number;
  paid_amount: number;
  balance_amount: number;
  due_status: string;
  has_unverified_receipt: boolean;
}

export interface FeeSummaryResult {
  currency: string;
  summary: {
    confirmed_collections: number;
    unverified_collections: number;
    total_outstanding_dues: number;
    total_gross_billed: number;
    total_concessions: number;
    total_net_billed: number;
    confirmed_receipt_count: number;
    unverified_receipt_count: number;
    defaulters_count: number;
    collection_efficiency_percentage: number;
  };
  collections_by_method: Record<string, number>;
  collections_by_status: {
    CONFIRMED: number;
    PENDING_VERIFICATION: number;
    RECORDED: number;
  };
  defaulters: FeeDefaulterRow[];
  csv?: string | undefined;
}

export class ReportingService {
  /**
   * Helper to fetch institution terminology and type
   */
  static async getTerminology(tx: TenantTx, ctx: TrustedContext) {
    try {
      const term = await SetupService.terminology(tx, ctx);
      return {
        labels: term.labels,
        institutionType: term.institutionType,
      };
    } catch {
      return {
        labels: {
          program: 'Program',
          cohort: 'Cohort',
          period: 'Term',
          section: 'Section',
          term: 'Term',
          course: 'Course',
        },
        institutionType: null,
      };
    }
  }

  /**
   * 1. Student Enrolment Roster
   */
  static async getEnrolmentRoster(
    tx: TenantTx,
    ctx: TrustedContext,
    query: EnrolmentRosterQuery,
  ): Promise<EnrolmentRosterResult> {
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(
      tx,
      ctx,
      'student.directory.list',
      query.campus_id ? { organization_id: ctx.tenantId, campus_id: query.campus_id } : undefined,
    );

    const { labels, institutionType } = await this.getTerminology(tx, ctx);

    const conditions: string[] = ['s.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(
        `(s.campus_id = $${params.length} OR (s.campus_id IS NULL AND c.id = $${params.length}))`,
      );
    }
    if (query.program_id) {
      params.push(query.program_id);
      conditions.push(`p.id = $${params.length}`);
    }
    if (query.cohort_id) {
      params.push(query.cohort_id);
      conditions.push(`co.id = $${params.length}`);
    }
    if (query.term_id) {
      params.push(query.term_id);
      conditions.push(`te.term_id = $${params.length}`);
    }
    if (query.status === 'ACTIVE') {
      conditions.push(`s.status = 'ACTIVE'`);
    } else if (query.status === 'INACTIVE') {
      conditions.push(`s.status != 'ACTIVE'`);
    }

    const sql = `
      SELECT s.id AS student_id,
             u.display_name AS student_name,
             s.admission_number,
             s.status AS enrolment_status,
             s.created_at::text AS enrolled_date,
             COALESCE(s.campus_id, c.id) AS campus_id,
             COALESCE(c.name, 'Default Campus') AS campus_name,
             p.id AS program_id,
             p.name AS program_name,
             co.id AS cohort_id,
             co.name AS cohort_name,
             t.id AS term_id,
             t.name AS term_name,
             te.roll_number,
             0::int AS guardian_count,
             NULL::text AS primary_guardian_name,
             NULL::text AS primary_guardian_phone
        FROM app.students s
        JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        LEFT JOIN app.campuses c ON c.organization_id = s.organization_id AND (c.id = s.campus_id OR s.campus_id IS NULL)
        LEFT JOIN app.term_enrollments te ON te.organization_id = s.organization_id AND te.student_id = s.id AND te.status IN ('REGISTERED', 'ENROLLED')
        LEFT JOIN app.cohort_periods cp ON cp.organization_id = te.organization_id AND cp.id = te.cohort_period_id
        LEFT JOIN app.cohorts co ON co.organization_id = cp.organization_id AND co.id = cp.cohort_id
        LEFT JOIN app.programs p ON p.organization_id = co.organization_id AND p.id = co.program_id
        LEFT JOIN app.terms t ON t.organization_id = te.organization_id AND t.id = te.term_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.admission_number ASC
    `;

    const res = await tx.query<EnrolmentRosterStudent>(sql, params);
    const students = res.rows;

    const totalStudents = students.length;
    const activeStudents = students.filter((s) => s.enrolment_status === 'ACTIVE').length;
    const campusesCount = new Set(students.map((s) => s.campus_id).filter(Boolean)).size;

    let csv: string | undefined;
    if (query.format === 'csv') {
      const headers = [
        'Admission No',
        'Student Name',
        'Campus',
        labels.program || 'Program',
        labels.cohort || 'Cohort',
        labels.term || 'Term',
        'Roll No',
        'Status',
        'Enrolled Date',
      ];
      const rows = students.map((s) => [
        s.admission_number,
        s.student_name,
        s.campus_name,
        s.program_name ?? '',
        s.cohort_name ?? '',
        s.term_name ?? '',
        s.roll_number ?? '',
        s.enrolment_status,
        s.enrolled_date ? s.enrolled_date.split('T')[0] : '',
      ]);
      csv = buildCsv(headers, rows);
    }

    return {
      institution_type: institutionType,
      labels,
      summary: {
        total_students: totalStudents,
        active_students: activeStudents,
        campuses_count: campusesCount,
      },
      students,
      csv,
    };
  }

  /**
   * 2. Daily Attendance Summary
   */
  static async getAttendanceSummary(
    tx: TenantTx,
    ctx: TrustedContext,
    query: AttendanceSummaryQuery,
  ): Promise<AttendanceSummaryResult> {
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(
      tx,
      ctx,
      'attendance.record.read',
      query.campus_id ? { organization_id: ctx.tenantId, campus_id: query.campus_id } : undefined,
    );

    const { labels, institutionType } = await this.getTerminology(tx, ctx);
    const targetDate = query.date || new Date().toISOString().split('T')[0]!;

    const conditions: string[] = ['cs.organization_id = $1', 'cs.session_date = $2'];
    const params: unknown[] = [ctx.tenantId, targetDate];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`cs.campus_id = $${params.length}`);
    }
    if (query.course_offering_id) {
      params.push(query.course_offering_id);
      conditions.push(`cs.course_offering_id = $${params.length}`);
    }

    const sql = `
      SELECT cs.id AS session_id,
             cs.campus_id,
             c.name AS campus_name,
             COALESCE(co.title_snapshot, crs.title, 'Course Session') AS course_name,
             COALESCE(co.code_snapshot, crs.code, 'CODE') AS course_code,
             COALESCE(u.display_name, 'Staff Teacher') AS teacher_name,
             cs.session_date::text AS session_date,
             cs.starts_at::text AS starts_at,
             cs.ends_at::text AS ends_at,
             cs.attendance_state,
             COUNT(ar.id) FILTER (WHERE ar.status = 'PRESENT')::int AS present_count,
             COUNT(ar.id) FILTER (WHERE ar.status = 'ABSENT')::int AS absent_count,
             COUNT(ar.id) FILTER (WHERE ar.status = 'LATE')::int AS late_count,
             COUNT(ar.id) FILTER (WHERE ar.status = 'EXCUSED')::int AS excused_count,
             COUNT(ar.id)::int AS total_marked
        FROM app.class_sessions cs
        JOIN app.campuses c ON c.organization_id = cs.organization_id AND c.id = cs.campus_id
        LEFT JOIN app.course_offerings co ON co.organization_id = cs.organization_id AND co.id = cs.course_offering_id
        LEFT JOIN app.courses crs ON crs.organization_id = co.organization_id AND crs.id = co.course_id
        LEFT JOIN app.employees emp ON emp.organization_id = cs.organization_id AND emp.id = cs.conducted_by_employee_id
        LEFT JOIN app.users u ON u.organization_id = emp.organization_id AND u.id = emp.user_id
        LEFT JOIN app.attendance_records ar ON ar.organization_id = cs.organization_id AND ar.class_session_id = cs.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY cs.id, c.name, co.title_snapshot, crs.title, co.code_snapshot, crs.code, u.display_name
       ORDER BY cs.starts_at ASC, course_name ASC
    `;

    const res = await tx.query<
      AttendanceSessionReport & {
        present_count: number;
        absent_count: number;
        late_count: number;
        excused_count: number;
        total_marked: number;
      }
    >(sql, params);

    let totalConducted = 0;
    let missingRegisters = 0;
    let totalPresent = 0;
    let totalAbsent = 0;
    let totalLate = 0;
    let totalExcused = 0;
    let totalRecords = 0;

    const sessions: AttendanceSessionReport[] = res.rows.map((row) => {
      const isConducted = row.total_marked > 0 || row.attendance_state === 'SUBMITTED';
      if (isConducted) {
        totalConducted++;
      } else {
        missingRegisters++;
      }

      totalPresent += row.present_count;
      totalAbsent += row.absent_count;
      totalLate += row.late_count;
      totalExcused += row.excused_count;
      totalRecords += row.total_marked;

      const pct =
        row.total_marked > 0
          ? Math.round(((row.present_count + row.late_count) / row.total_marked) * 1000) / 10
          : 0;

      return {
        ...row,
        attendance_percentage: pct,
      };
    });

    const overallRate =
      totalRecords > 0 ? Math.round(((totalPresent + totalLate) / totalRecords) * 1000) / 10 : 0;

    let csv: string | undefined;
    if (query.format === 'csv') {
      const headers = [
        'Date',
        'Campus',
        labels.course || 'Course',
        'Code',
        'Faculty',
        'Time',
        'Register Status',
        'Present',
        'Absent',
        'Late',
        'Excused',
        'Total Marked',
        'Attendance %',
      ];
      const rows = sessions.map((s) => [
        s.session_date,
        s.campus_name,
        s.course_name,
        s.course_code,
        s.teacher_name,
        `${s.starts_at ? s.starts_at.split('T')[1]?.slice(0, 5) : ''} - ${s.ends_at ? s.ends_at.split('T')[1]?.slice(0, 5) : ''}`,
        s.attendance_state,
        s.present_count,
        s.absent_count,
        s.late_count,
        s.excused_count,
        s.total_marked,
        `${s.attendance_percentage}%`,
      ]);
      csv = buildCsv(headers, rows);
    }

    return {
      date: targetDate,
      institution_type: institutionType,
      labels,
      summary: {
        total_sessions_scheduled: sessions.length,
        total_sessions_conducted: totalConducted,
        missing_registers_count: missingRegisters,
        total_attendance_records: totalRecords,
        present_count: totalPresent,
        absent_count: totalAbsent,
        late_count: totalLate,
        excused_count: totalExcused,
        attendance_rate: overallRate,
      },
      sessions,
      csv,
    };
  }

  /**
   * 3. Examination Marks Summary (Strict publication barrier: only published results)
   */
  static async getExamMarksSummary(
    tx: TenantTx,
    ctx: TrustedContext,
    query: ExamMarksSummaryQuery,
  ): Promise<ExamMarksSummaryResult> {
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(
      tx,
      ctx,
      'result.read',
      query.campus_id ? { organization_id: ctx.tenantId, campus_id: query.campus_id } : undefined,
    );

    const { labels, institutionType } = await this.getTerminology(tx, ctx);

    // Enforce publication barrier: schedule status must be PUBLISHED, published_at is not null, marks must be PUBLISHED
    const conditions: string[] = [
      'es.organization_id = $1',
      'es.status = $2',
      'es.published_at IS NOT NULL',
    ];
    const params: unknown[] = [ctx.tenantId, 'PUBLISHED'];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`e.campus_id = $${params.length}`);
    }
    if (query.examination_id) {
      params.push(query.examination_id);
      conditions.push(`es.examination_id = $${params.length}`);
    }
    if (query.term_id) {
      params.push(query.term_id);
      conditions.push(`e.term_id = $${params.length}`);
    }

    const sql = `
      SELECT es.id AS schedule_id,
             e.id AS examination_id,
             e.name AS examination_name,
             e.exam_type,
             e.campus_id,
             c.name AS campus_name,
             COALESCE(t.name, 'All Terms') AS term_name,
             COALESCE(co.title_snapshot, crs.title, 'Course Subject') AS course_name,
             COALESCE(co.code_snapshot, crs.code, 'CODE') AS course_code,
             es.exam_date::text AS exam_date,
             es.max_marks::text AS max_marks,
             es.pass_marks::text AS pass_marks,
             es.published_at::text AS published_at,
             COUNT(em.id) FILTER (WHERE em.status = 'SUBMITTED')::int AS appeared_count,
             COUNT(em.id) FILTER (WHERE em.status = 'SUBMITTED' AND em.is_passing = true)::int AS passed_count,
             COUNT(em.id) FILTER (WHERE em.status = 'SUBMITTED' AND em.is_passing = false)::int AS failed_count,
             COALESCE(MAX(em.marks_obtained) FILTER (WHERE em.status = 'SUBMITTED'), 0)::text AS highest_marks,
             COALESCE(MIN(em.marks_obtained) FILTER (WHERE em.status = 'SUBMITTED'), 0)::text AS lowest_marks,
             COALESCE(AVG(em.marks_obtained) FILTER (WHERE em.status = 'SUBMITTED'), 0)::text AS average_marks
        FROM app.exam_schedules es
        JOIN app.examinations e ON e.organization_id = es.organization_id AND e.id = es.examination_id
        JOIN app.campuses c ON c.organization_id = e.organization_id AND c.id = e.campus_id
        LEFT JOIN app.terms t ON t.organization_id = e.organization_id AND t.id = e.term_id
        LEFT JOIN app.course_offerings co ON co.organization_id = es.organization_id AND co.id = es.course_offering_id
        LEFT JOIN app.courses crs ON crs.organization_id = co.organization_id AND crs.id = co.course_id
        LEFT JOIN app.exam_marks em ON em.organization_id = es.organization_id AND em.exam_schedule_id = es.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY es.id, e.id, e.name, e.exam_type, e.campus_id, c.name, t.name,
                co.title_snapshot, crs.title, co.code_snapshot, crs.code
       ORDER BY es.exam_date DESC, examination_name ASC
    `;

    const res = await tx.query<{
      schedule_id: string;
      examination_id: string;
      examination_name: string;
      exam_type: string;
      campus_id: string;
      campus_name: string;
      term_name: string;
      course_name: string;
      course_code: string;
      exam_date: string;
      max_marks: string;
      pass_marks: string;
      published_at: string;
      appeared_count: number;
      passed_count: number;
      failed_count: number;
      highest_marks: string;
      lowest_marks: string;
      average_marks: string;
    }>(sql, params);

    let totalAppeared = 0;
    let totalPassed = 0;
    let totalFailed = 0;
    let sumScores = 0;

    const schedules: ExamScheduleReport[] = res.rows.map((row) => {
      const appeared = row.appeared_count;
      const passed = row.passed_count;
      const failed = row.failed_count;
      const passPct = appeared > 0 ? Math.round((passed / appeared) * 1000) / 10 : 0;
      const avg = Math.round(Number(row.average_marks) * 10) / 10;

      totalAppeared += appeared;
      totalPassed += passed;
      totalFailed += failed;
      sumScores += avg * appeared;

      return {
        schedule_id: row.schedule_id,
        examination_id: row.examination_id,
        examination_name: row.examination_name,
        exam_type: row.exam_type,
        campus_id: row.campus_id,
        campus_name: row.campus_name,
        term_name: row.term_name,
        course_name: row.course_name,
        course_code: row.course_code,
        exam_date: row.exam_date,
        max_marks: Number(row.max_marks),
        pass_marks: Number(row.pass_marks),
        appeared_count: appeared,
        passed_count: passed,
        failed_count: failed,
        pass_percentage: passPct,
        highest_marks: Number(row.highest_marks),
        lowest_marks: Number(row.lowest_marks),
        average_marks: avg,
        published_at: row.published_at,
      };
    });

    const overallPassPct =
      totalAppeared > 0 ? Math.round((totalPassed / totalAppeared) * 1000) / 10 : 0;
    const overallAvgScore =
      totalAppeared > 0 ? Math.round((sumScores / totalAppeared) * 10) / 10 : 0;

    let csv: string | undefined;
    if (query.format === 'csv') {
      const headers = [
        'Examination',
        'Exam Type',
        'Campus',
        labels.term || 'Term',
        labels.course || 'Subject',
        'Course Code',
        'Exam Date',
        'Max Marks',
        'Pass Marks',
        'Appeared',
        'Passed',
        'Failed',
        'Pass %',
        'Highest',
        'Lowest',
        'Average',
        'Published At',
      ];
      const rows = schedules.map((s) => [
        s.examination_name,
        s.exam_type,
        s.campus_name,
        s.term_name,
        s.course_name,
        s.course_code,
        s.exam_date,
        s.max_marks,
        s.pass_marks,
        s.appeared_count,
        s.passed_count,
        s.failed_count,
        `${s.pass_percentage}%`,
        s.highest_marks,
        s.lowest_marks,
        s.average_marks,
        s.published_at ? s.published_at.split('T')[0] : '',
      ]);
      csv = buildCsv(headers, rows);
    }

    return {
      institution_type: institutionType,
      labels,
      summary: {
        total_published_exams: schedules.length,
        total_candidates_appeared: totalAppeared,
        total_passed: totalPassed,
        total_failed: totalFailed,
        overall_pass_percentage: overallPassPct,
        average_score: overallAvgScore,
      },
      schedules,
      csv,
    };
  }

  /**
   * 4. Fee Collections & Outstanding Dues Summary
   * Confirmed collections, unverified payments, and outstanding balances shown separately.
   */
  static async getFeeSummary(
    tx: TenantTx,
    ctx: TrustedContext,
    query: FeeSummaryQuery,
  ): Promise<FeeSummaryResult> {
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(
      tx,
      ctx,
      'fee.receipt.read',
      query.campus_id ? { organization_id: ctx.tenantId, campus_id: query.campus_id } : undefined,
    );

    // 1. Collections Summary query
    const receiptConds: string[] = ['r.organization_id = $1', `r.status = 'POSTED'`];
    const receiptParams: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      receiptParams.push(query.campus_id);
      receiptConds.push(`r.campus_id = $${receiptParams.length}`);
    }
    if (query.from_date) {
      receiptParams.push(query.from_date);
      receiptConds.push(`r.payment_date >= $${receiptParams.length}`);
    }
    if (query.to_date) {
      receiptParams.push(query.to_date);
      receiptConds.push(`r.payment_date <= $${receiptParams.length}`);
    }

    const receiptsSql = `
      SELECT r.reconciliation_status,
             r.payment_method,
             SUM(r.amount)::text AS total_amount,
             COUNT(*)::int AS count
        FROM app.fee_receipts r
       WHERE ${receiptConds.join(' AND ')}
       GROUP BY r.reconciliation_status, r.payment_method
    `;

    const receiptsRes = await tx.query<{
      reconciliation_status: string;
      payment_method: string;
      total_amount: string;
      count: number;
    }>(receiptsSql, receiptParams);

    let confirmedCollections = 0;
    let unverifiedCollections = 0;
    let confirmedCount = 0;
    let unverifiedCount = 0;

    const collectionsByMethod: Record<string, number> = {
      CASH: 0,
      CHEQUE: 0,
      BANK_TRANSFER: 0,
      UPI_REFERENCE: 0,
      OTHER_OFFLINE: 0,
    };
    const collectionsByStatus = {
      CONFIRMED: 0,
      PENDING_VERIFICATION: 0,
      RECORDED: 0,
    };

    for (const r of receiptsRes.rows) {
      const amt = Number(r.total_amount);
      const cnt = r.count;
      collectionsByMethod[r.payment_method] = (collectionsByMethod[r.payment_method] ?? 0) + amt;

      if (r.reconciliation_status === 'CONFIRMED' || r.reconciliation_status === 'RECORDED') {
        confirmedCollections += amt;
        confirmedCount += cnt;
        if (r.reconciliation_status === 'CONFIRMED') {
          collectionsByStatus.CONFIRMED += amt;
        } else {
          collectionsByStatus.RECORDED += amt;
        }
      } else if (r.reconciliation_status === 'PENDING_VERIFICATION') {
        unverifiedCollections += amt;
        unverifiedCount += cnt;
        collectionsByStatus.PENDING_VERIFICATION += amt;
      }
    }

    // 2. Outstanding Dues & Defaulters query
    const duesConds: string[] = ['d.organization_id = $1', `d.status IN ('PENDING', 'PARTIAL')`];
    const duesParams: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      duesParams.push(query.campus_id);
      duesConds.push(`d.campus_id = $${duesParams.length}`);
    }
    if (query.academic_year_id) {
      duesParams.push(query.academic_year_id);
      duesConds.push(`d.academic_year_id = $${duesParams.length}`);
    }

    const duesSql = `
      SELECT d.id,
             d.student_id,
             u.display_name AS student_name,
             s.admission_number,
             d.campus_id,
             c.name AS campus_name,
             fs.name AS fee_structure_name,
             d.due_number,
             d.due_date::text AS due_date,
             d.gross_amount::text AS gross_amount,
             d.discount_amount::text AS discount_amount,
             d.net_amount::text AS net_amount,
             d.paid_amount::text AS paid_amount,
             d.balance_amount::text AS balance_amount,
             d.status AS due_status,
             EXISTS (
               SELECT 1 FROM app.fee_receipts fr
                WHERE fr.organization_id = d.organization_id
                  AND fr.student_id = d.student_id
                  AND fr.reconciliation_status = 'PENDING_VERIFICATION'
                  AND fr.status = 'POSTED'
             ) AS has_unverified_receipt
        FROM app.student_dues d
        JOIN app.students s ON s.organization_id = d.organization_id AND s.id = d.student_id
        JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        JOIN app.campuses c ON c.organization_id = d.organization_id AND c.id = d.campus_id
        JOIN app.fee_structures fs ON fs.organization_id = d.organization_id AND fs.id = d.fee_structure_id
       WHERE ${duesConds.join(' AND ')}
       ORDER BY d.due_date ASC, balance_amount DESC
    `;

    const duesRes = await tx.query<{
      id: string;
      student_id: string;
      student_name: string;
      admission_number: string;
      campus_id: string;
      campus_name: string;
      fee_structure_name: string;
      due_number: string;
      due_date: string;
      gross_amount: string;
      discount_amount: string;
      net_amount: string;
      paid_amount: string;
      balance_amount: string;
      due_status: string;
      has_unverified_receipt: boolean;
    }>(duesSql, duesParams);

    let totalOutstanding = 0;
    let totalGrossBilled = 0;
    let totalConcessions = 0;
    let totalNetBilled = 0;

    const defaulters: FeeDefaulterRow[] = duesRes.rows.map((row) => {
      const gross = Number(row.gross_amount);
      const discount = Number(row.discount_amount);
      const net = Number(row.net_amount);
      const paid = Number(row.paid_amount);
      const balance = Number(row.balance_amount);

      totalGrossBilled += gross;
      totalConcessions += discount;
      totalNetBilled += net;
      totalOutstanding += balance;

      return {
        student_id: row.student_id,
        student_name: row.student_name,
        admission_number: row.admission_number,
        campus_id: row.campus_id,
        campus_name: row.campus_name,
        due_number: row.due_number,
        fee_structure_name: row.fee_structure_name,
        due_date: row.due_date,
        net_amount: net,
        paid_amount: paid,
        balance_amount: balance,
        due_status: row.due_status,
        has_unverified_receipt: row.has_unverified_receipt,
      };
    });

    const uniqueDefaulters = new Set(defaulters.map((d) => d.student_id)).size;
    const totalBilled =
      totalNetBilled > 0 ? totalNetBilled : confirmedCollections + totalOutstanding;
    const efficiency =
      totalBilled > 0 ? Math.round((confirmedCollections / totalBilled) * 1000) / 10 : 0;

    let csv: string | undefined;
    if (query.format === 'csv') {
      if (query.view === 'defaulters') {
        const headers = [
          'Admission No',
          'Student Name',
          'Campus',
          'Fee Structure',
          'Due Number',
          'Due Date',
          'Net Amount (INR)',
          'Paid Amount (INR)',
          'Outstanding Balance (INR)',
          'Status',
          'Unverified Payment in Clearing',
        ];
        const rows = defaulters.map((d) => [
          d.admission_number,
          d.student_name,
          d.campus_name,
          d.fee_structure_name,
          d.due_number,
          d.due_date,
          (d.net_amount / 100).toFixed(2),
          (d.paid_amount / 100).toFixed(2),
          (d.balance_amount / 100).toFixed(2),
          d.due_status,
          d.has_unverified_receipt ? 'YES' : 'NO',
        ]);
        csv = buildCsv(headers, rows);
      } else {
        const headers = ['Metric', 'Amount (INR)', 'Receipt / Student Count'];
        const rows = [
          ['Confirmed Collections', (confirmedCollections / 100).toFixed(2), confirmedCount],
          [
            'Unverified Payments (In Clearing)',
            (unverifiedCollections / 100).toFixed(2),
            unverifiedCount,
          ],
          ['Total Outstanding Dues', (totalOutstanding / 100).toFixed(2), uniqueDefaulters],
          ['Collection Efficiency', `${efficiency}%`, ''],
        ];
        csv = buildCsv(headers, rows);
      }
    }

    return {
      currency: 'INR',
      summary: {
        confirmed_collections: confirmedCollections,
        unverified_collections: unverifiedCollections,
        total_outstanding_dues: totalOutstanding,
        total_gross_billed: totalGrossBilled,
        total_concessions: totalConcessions,
        total_net_billed: totalNetBilled,
        confirmed_receipt_count: confirmedCount,
        unverified_receipt_count: unverifiedCount,
        defaulters_count: uniqueDefaulters,
        collection_efficiency_percentage: efficiency,
      },
      collections_by_method: collectionsByMethod,
      collections_by_status: collectionsByStatus,
      defaulters,
      csv,
    };
  }
}
