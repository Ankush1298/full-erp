import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { isApiError, isModuleNotEntitled, isInstitutionSuspended } from '../lib/api/errors';
import {
  FeatureUnavailableState,
  InstitutionSuspendedState,
} from '../components/ui/FeatureUnavailableState';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Card } from '../components/ui/Card';
import { SegmentedNav, type SegmentedNavItem } from '../components/ui/SegmentedNav';
import {
  fetchEnrolmentRoster,
  fetchAttendanceSummary,
  fetchExamMarksSummary,
  fetchFeeSummary,
  downloadReportCsv,
  type EnrolmentRosterData,
  type AttendanceSummaryData,
  type ExamMarksSummaryData,
  type FeeSummaryData,
} from '../lib/api/reports-api';

type Tab = 'roster' | 'attendance' | 'exams' | 'fees';

function formatCurrency(minorUnits: number): string {
  const major = minorUnits / 100;
  return major.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });
}

const REPORT_TABS: Array<SegmentedNavItem<Tab>> = [
  { id: 'roster', label: 'Student Enrolment Roster' },
  { id: 'attendance', label: 'Daily Attendance Summary' },
  { id: 'exams', label: 'Examination Results Summary' },
  { id: 'fees', label: 'Fee Collections & Dues' },
];

export function ReportsPage() {
  const { client, identity } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('roster');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNotEntitled, setIsNotEntitled] = useState(false);
  const [isSuspended, setIsSuspended] = useState(false);

  // Filters
  const [attendanceDate, setAttendanceDate] = useState<string>(
    new Date().toISOString().split('T')[0]!,
  );

  // Data states
  const [rosterData, setRosterData] = useState<EnrolmentRosterData | null>(null);
  const [attendanceData, setAttendanceData] = useState<AttendanceSummaryData | null>(null);
  const [examData, setExamData] = useState<ExamMarksSummaryData | null>(null);
  const [feeData, setFeeData] = useState<FeeSummaryData | null>(null);

  const loadReportData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'roster') {
        const res = await fetchEnrolmentRoster(client);
        setRosterData(res);
      } else if (activeTab === 'attendance') {
        const res = await fetchAttendanceSummary(client, { date: attendanceDate });
        setAttendanceData(res);
      } else if (activeTab === 'exams') {
        const res = await fetchExamMarksSummary(client);
        setExamData(res);
      } else if (activeTab === 'fees') {
        const res = await fetchFeeSummary(client);
        setFeeData(res);
      }
    } catch (err) {
      if (isModuleNotEntitled(err)) {
        setIsNotEntitled(true);
        setError(null);
      } else if (isInstitutionSuspended(err)) {
        setIsSuspended(true);
        setError(null);
      } else {
        setError(
          isApiError(err)
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load report data',
        );
      }
    } finally {
      setLoading(false);
    }
  }, [activeTab, attendanceDate, client]);

  useEffect(() => {
    void loadReportData();
  }, [loadReportData]);

  const handleExportCsv = async () => {
    try {
      if (activeTab === 'roster') {
        await downloadReportCsv(client, 'enrolment-roster', 'student-enrolment-roster.csv');
      } else if (activeTab === 'attendance') {
        await downloadReportCsv(
          client,
          `attendance-summary?date=${attendanceDate}`,
          `attendance-summary-${attendanceDate}.csv`,
        );
      } else if (activeTab === 'exams') {
        await downloadReportCsv(client, 'exam-performance', 'examination-marks-summary.csv');
      } else if (activeTab === 'fees') {
        await downloadReportCsv(
          client,
          'fee-summary?view=defaulters',
          'fee-collections-and-dues.csv',
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV export failed');
    }
  };

  const labels = rosterData?.labels ||
    attendanceData?.labels ||
    examData?.labels || {
      program: 'Program',
      cohort: 'Cohort',
      period: 'Term',
      section: 'Section',
      term: 'Term',
      course: 'Course',
    };

  return (
    <div className="reports-page p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Executive & Administrative Reports"
        subtitle={`Real-time institutional performance analytics, enrolment rosters, daily registers, examination outcomes, and fee reconciliation for ${identity?.displayName ?? 'authorized administrators'}.`}
        actions={
          !isNotEntitled && !isSuspended ? (
            <Button variant="secondary" onClick={() => void handleExportCsv()} disabled={loading}>
              <svg
                className="w-4 h-4 mr-2 inline"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export CSV
            </Button>
          ) : undefined
        }
      />

      {isNotEntitled ? (
        <FeatureUnavailableState
          moduleKey="reports"
          moduleName="Institutional Analytics & Reports"
        />
      ) : isSuspended ? (
        <InstitutionSuspendedState />
      ) : (
        <>
          {error && (
            <Alert tone="error">
              <div className="flex justify-between items-center w-full">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="btn btn-secondary btn-xs ml-4"
                  aria-label="Dismiss error"
                >
                  Dismiss
                </button>
              </div>
            </Alert>
          )}

          {/* Segmented Control Navigation */}
          <SegmentedNav<Tab>
            items={REPORT_TABS}
            activeId={activeTab}
            onChange={setActiveTab}
            ariaLabel="Executive report sections"
          />

          {loading ? (
            <div className="p-12 flex flex-col items-center justify-center min-h-[260px]">
              <Spinner />
              <p className="mt-4 text-sm text-[var(--color-muted)] font-medium">
                Generating administrative report...
              </p>
            </div>
          ) : (
            <>
              {/* TAB 1: ENROLMENT ROSTER */}
              {activeTab === 'roster' && rosterData && (
                <div className="space-y-6">
                  <div className="anesa-stat-grid anesa-stat-grid--3">
                    <StatCard
                      compact
                      label="Total Enrolled Students"
                      value={rosterData.summary.total_students}
                      helper="All registered in institution"
                      tone="purple"
                    />
                    <StatCard
                      compact
                      label="Active Academic Students"
                      value={rosterData.summary.active_students}
                      helper="In good standing with active programs"
                      tone="emerald"
                    />
                    <StatCard
                      compact
                      label="Campuses Covered"
                      value={rosterData.summary.campuses_count}
                      helper="Operational campus locations"
                      tone="amber"
                    />
                  </div>

                  <Card title="Active Student Enrolment Register">
                    <div className="p-4 border-b border-[var(--color-border)] flex justify-between items-center">
                      <span className="text-xs text-[var(--color-muted)] font-medium">
                        Showing {rosterData.students.length} students
                      </span>
                    </div>
                    {rosterData.students.length === 0 ? (
                      <EmptyState
                        title="No Enrolled Students"
                        description="No student records match the active criteria."
                      />
                    ) : (
                      <div className="anesa-table-wrapper">
                        <table className="anesa-table">
                          <thead>
                            <tr>
                              <th scope="col">Admission No</th>
                              <th scope="col">Student Name</th>
                              <th scope="col">Campus</th>
                              <th scope="col">{labels.program || 'Program'}</th>
                              <th scope="col">{labels.cohort || 'Cohort'}</th>
                              <th scope="col">Primary Guardian</th>
                              <th scope="col">Guardian Contact</th>
                              <th scope="col">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rosterData.students.map((s) => (
                              <tr key={s.student_id}>
                                <td className="font-mono font-medium">{s.admission_number}</td>
                                <td className="font-medium">{s.student_name}</td>
                                <td className="text-[var(--color-muted)]">{s.campus_name}</td>
                                <td>{s.program_name ?? '—'}</td>
                                <td className="text-[var(--color-muted)]">
                                  {s.cohort_name ?? '—'}
                                </td>
                                <td>{s.primary_guardian_name ?? 'Not Listed'}</td>
                                <td className="font-mono text-xs text-[var(--color-muted)]">
                                  {s.primary_guardian_phone ?? '—'}
                                </td>
                                <td>
                                  <StatusBadge
                                    status={
                                      s.enrolment_status === 'ACTIVE' ? 'confirmed' : 'pending'
                                    }
                                    label={s.enrolment_status}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              )}

              {/* TAB 2: DAILY ATTENDANCE SUMMARY */}
              {activeTab === 'attendance' && attendanceData && (
                <div className="space-y-6">
                  <div className="anesa-filter-bar">
                    <div className="flex items-center gap-3">
                      <TextField
                        label="Report Date"
                        type="date"
                        value={attendanceDate}
                        onChange={(e) => setAttendanceDate(e.target.value)}
                      />
                    </div>
                    <div className="text-sm text-[var(--color-muted)]">
                      Attendance Compliance Rate:{' '}
                      <span className="font-semibold text-[var(--color-text)]">
                        {attendanceData.summary.attendance_rate}%
                      </span>
                    </div>
                  </div>

                  <div className="anesa-stat-grid anesa-stat-grid--4">
                    <StatCard
                      compact
                      label="Conducted Sessions"
                      value={attendanceData.summary.total_sessions_conducted}
                      helper="With submitted attendance"
                      tone="emerald"
                    />
                    <StatCard
                      compact
                      label="Missing Registers"
                      value={attendanceData.summary.missing_registers_count}
                      helper="Scheduled but not marked"
                      tone="coral"
                    />
                    <StatCard
                      compact
                      label="Present Marks"
                      value={attendanceData.summary.present_count}
                      helper="Students present in class"
                      tone="purple"
                    />
                    <StatCard
                      compact
                      label="Absent Marks"
                      value={attendanceData.summary.absent_count}
                      helper="Absences recorded on date"
                      tone="amber"
                    />
                  </div>

                  <Card title={`Class Sessions on ${attendanceData.date}`}>
                    <div className="p-4 border-b border-[var(--color-border)] flex justify-between items-center">
                      <span className="text-xs text-[var(--color-muted)] font-medium">
                        {attendanceData.sessions.length} sessions scheduled
                      </span>
                    </div>
                    {attendanceData.sessions.length === 0 ? (
                      <EmptyState
                        title="No Sessions Scheduled"
                        description="No class timetable sessions exist for the selected date."
                      />
                    ) : (
                      <div className="anesa-table-wrapper">
                        <table className="anesa-table">
                          <thead>
                            <tr>
                              <th scope="col">Course / Subject</th>
                              <th scope="col">Campus</th>
                              <th scope="col">Faculty</th>
                              <th scope="col">Status</th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Present
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Absent
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Attendance %
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {attendanceData.sessions.map((s) => (
                              <tr key={s.session_id}>
                                <td>
                                  <div className="font-medium">{s.course_name}</div>
                                  <div className="text-xs font-mono text-[var(--color-muted)]">
                                    {s.course_code}
                                  </div>
                                </td>
                                <td className="text-[var(--color-muted)]">{s.campus_name}</td>
                                <td>{s.teacher_name}</td>
                                <td>
                                  <StatusBadge
                                    status={
                                      s.attendance_state === 'SUBMITTED' ? 'confirmed' : 'pending'
                                    }
                                    label={s.attendance_state}
                                  />
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="text-[var(--color-muted)]"
                                >
                                  {s.present_count}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="font-semibold text-rose-600"
                                >
                                  {s.absent_count}
                                </td>
                                <td style={{ textAlign: 'right' }} className="font-medium">
                                  {s.attendance_percentage !== undefined
                                    ? `${s.attendance_percentage}%`
                                    : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              )}

              {/* TAB 3: EXAMINATION MARKS SUMMARY */}
              {activeTab === 'exams' && examData && (
                <div className="space-y-6">
                  <div className="anesa-stat-grid anesa-stat-grid--4">
                    <StatCard
                      compact
                      label="Published Schedules"
                      value={examData.summary.total_published_exams}
                      helper="Verified & released outcomes"
                      tone="purple"
                    />
                    <StatCard
                      compact
                      label="Candidates Appeared"
                      value={examData.summary.total_candidates_appeared}
                      helper="Total students assessed"
                      tone="amber"
                    />
                    <StatCard
                      compact
                      label="Overall Pass Rate"
                      value={`${examData.summary.overall_pass_percentage}%`}
                      helper={`${examData.summary.total_passed} passed, ${examData.summary.total_failed} failed`}
                      tone="emerald"
                    />
                    <StatCard
                      compact
                      label="Average Score"
                      value={examData.summary.average_score}
                      helper="Mean marks across assessments"
                      tone="coral"
                    />
                  </div>

                  <Card title="Published Examination Performance Breakdown">
                    <div className="p-4 border-b border-[var(--color-border)] flex justify-between items-center">
                      <span className="text-xs text-[var(--color-muted)] font-medium">
                        Strictly excludes unpublished draft marks
                      </span>
                    </div>
                    {examData.schedules.length === 0 ? (
                      <EmptyState
                        title="No Published Results"
                        description="No examination results have been published for administrative reporting yet."
                      />
                    ) : (
                      <div className="anesa-table-wrapper">
                        <table className="anesa-table">
                          <thead>
                            <tr>
                              <th scope="col">Examination</th>
                              <th scope="col">Subject / Course</th>
                              <th scope="col">Date</th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Max Marks
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Appeared
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Passed
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Pass %
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Average
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Highest
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {examData.schedules.map((s) => (
                              <tr key={s.schedule_id}>
                                <td>
                                  <div className="font-medium">{s.examination_name}</div>
                                  <div className="text-xs text-[var(--color-muted)]">
                                    {s.exam_type}
                                  </div>
                                </td>
                                <td>
                                  <div className="font-medium">{s.course_name}</div>
                                  <div className="text-xs font-mono text-[var(--color-muted)]">
                                    {s.course_code}
                                  </div>
                                </td>
                                <td className="font-mono text-xs text-[var(--color-muted)]">
                                  {s.exam_date}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="text-[var(--color-muted)]"
                                >
                                  {s.max_marks}
                                </td>
                                <td style={{ textAlign: 'right' }} className="font-medium">
                                  {s.appeared_count}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="font-medium text-emerald-600"
                                >
                                  {s.passed_count}
                                </td>
                                <td style={{ textAlign: 'right' }} className="font-semibold">
                                  {s.pass_percentage}%
                                </td>
                                <td style={{ textAlign: 'right' }} className="font-medium">
                                  {s.average_marks}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="font-medium text-[var(--color-primary)]"
                                >
                                  {s.highest_marks}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              )}

              {/* TAB 4: FEE COLLECTIONS & OUTSTANDING DUES */}
              {activeTab === 'fees' && feeData && (
                <div className="space-y-6">
                  <div className="anesa-stat-grid anesa-stat-grid--4">
                    <StatCard
                      compact
                      label="Confirmed Collections"
                      value={formatCurrency(feeData.summary.confirmed_collections)}
                      helper={`${feeData.summary.confirmed_receipt_count} reconciled receipts`}
                      tone="emerald"
                    />
                    <StatCard
                      compact
                      label="In Clearing (Unverified)"
                      value={formatCurrency(feeData.summary.unverified_collections)}
                      helper={`${feeData.summary.unverified_receipt_count} in-flight cheques/transfers`}
                      tone="amber"
                    />
                    <StatCard
                      compact
                      label="Total Outstanding Dues"
                      value={formatCurrency(feeData.summary.total_outstanding_dues)}
                      helper={`${feeData.summary.defaulters_count} student accounts with balance`}
                      tone="coral"
                    />
                    <StatCard
                      compact
                      label="Collection Efficiency"
                      value={`${feeData.summary.collection_efficiency_percentage}%`}
                      helper="Settlement against net billed dues"
                      tone="purple"
                    />
                  </div>

                  <Card title="Outstanding Dues & Defaulter Register">
                    <div className="p-4 border-b border-[var(--color-border)] flex justify-between items-center">
                      <p className="text-xs text-[var(--color-muted)] font-medium">
                        Unverified cheques in clearing are distinguished from settled balances
                      </p>
                      <span className="text-xs text-[var(--color-muted)] font-medium">
                        {feeData.defaulters.length} accounts pending
                      </span>
                    </div>
                    {feeData.defaulters.length === 0 ? (
                      <EmptyState
                        title="No Outstanding Dues"
                        description="All assessed student fee dues have been fully settled."
                      />
                    ) : (
                      <div className="anesa-table-wrapper">
                        <table className="anesa-table">
                          <thead>
                            <tr>
                              <th scope="col">Admission No</th>
                              <th scope="col">Student Name</th>
                              <th scope="col">Due Number</th>
                              <th scope="col">Due Date</th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Net Billed
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Confirmed Paid
                              </th>
                              <th scope="col" style={{ textAlign: 'right' }}>
                                Balance Due
                              </th>
                              <th scope="col">In-Flight Clearing</th>
                            </tr>
                          </thead>
                          <tbody>
                            {feeData.defaulters.map((d) => (
                              <tr key={d.due_number}>
                                <td className="font-mono font-medium">{d.admission_number}</td>
                                <td className="font-medium">{d.student_name}</td>
                                <td className="font-mono text-xs text-[var(--color-muted)]">
                                  {d.due_number}
                                </td>
                                <td className="text-xs text-[var(--color-muted)]">{d.due_date}</td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="text-[var(--color-muted)]"
                                >
                                  {formatCurrency(d.net_amount)}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="text-emerald-600 font-medium"
                                >
                                  {formatCurrency(d.paid_amount)}
                                </td>
                                <td
                                  style={{ textAlign: 'right' }}
                                  className="text-rose-600 font-bold"
                                >
                                  {formatCurrency(d.balance_amount)}
                                </td>
                                <td>
                                  {d.has_unverified_receipt ? (
                                    <StatusBadge status="pending" label="Cheque in Clearing" />
                                  ) : (
                                    <span className="text-xs text-[var(--color-muted)]">
                                      No In-Flight Ref
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
