import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Card } from '../components/ui/Card';
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

export function ReportsPage() {
  const { client, identity } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('roster');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : 'Failed to load report data');
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
        await downloadReportCsv(client, 'fee-summary?view=defaulters', 'fee-collections-and-dues.csv');
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
        }
      />

      {error && (
        <Alert tone="error">
          <div className="flex justify-between items-center">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="underline text-xs ml-4"
              aria-label="Dismiss error"
            >
              Dismiss
            </button>
          </div>
        </Alert>
      )}

      {/* Tabs navigation */}
      <div className="border-b border-[var(--color-border-subtle)] flex space-x-6">
        <button
          type="button"
          onClick={() => setActiveTab('roster')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'roster'
              ? 'border-[var(--color-accent)] text-[var(--color-fg-default)]'
              : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
          }`}
        >
          Student Enrolment Roster
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('attendance')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'attendance'
              ? 'border-[var(--color-accent)] text-[var(--color-fg-default)]'
              : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
          }`}
        >
          Daily Attendance Summary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('exams')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'exams'
              ? 'border-[var(--color-accent)] text-[var(--color-fg-default)]'
              : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
          }`}
        >
          Examination Results Summary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('fees')}
          className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'fees'
              ? 'border-[var(--color-accent)] text-[var(--color-fg-default)]'
              : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
          }`}
        >
          Fee Collections & Dues
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex flex-col items-center justify-center min-h-[300px]">
          <Spinner />
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">Generating administrative report...</p>
        </div>
      ) : (
        <>
          {/* TAB 1: ENROLMENT ROSTER */}
          {activeTab === 'roster' && rosterData && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                  label="Total Enrolled Students"
                  value={rosterData.summary.total_students}
                  helper="All students registered in institution"
                  tone="purple"
                />
                <StatCard
                  label="Active Academic Students"
                  value={rosterData.summary.active_students}
                  helper="In good standing with active programs"
                  tone="emerald"
                />
                <StatCard
                  label="Campuses Covered"
                  value={rosterData.summary.campuses_count}
                  helper="Operational campus locations"
                  tone="amber"
                />
              </div>

              <Card title="Active Student Enrolment Register">
                <div className="p-4 border-b border-[var(--color-border-subtle)] flex justify-between items-center">
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    Showing {rosterData.students.length} students
                  </span>
                </div>
                {rosterData.students.length === 0 ? (
                  <EmptyState
                    title="No Enrolled Students"
                    description="No student records match the active criteria."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[var(--color-bg-subtle)] border-b border-[var(--color-border-subtle)] text-[var(--color-fg-muted)]">
                        <tr>
                          <th scope="col" className="p-3">Admission No</th>
                          <th scope="col" className="p-3">Student Name</th>
                          <th scope="col" className="p-3">Campus</th>
                          <th scope="col" className="p-3">{labels.program || 'Program'}</th>
                          <th scope="col" className="p-3">{labels.cohort || 'Cohort'}</th>
                          <th scope="col" className="p-3">Primary Guardian</th>
                          <th scope="col" className="p-3">Guardian Contact</th>
                          <th scope="col" className="p-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-subtle)]">
                        {rosterData.students.map((s) => (
                          <tr key={s.student_id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                            <td className="p-3 font-mono font-medium text-[var(--color-fg-default)]">
                              {s.admission_number}
                            </td>
                            <td className="p-3 font-medium text-[var(--color-fg-default)]">
                              {s.student_name}
                            </td>
                            <td className="p-3 text-[var(--color-fg-muted)]">{s.campus_name}</td>
                            <td className="p-3 text-[var(--color-fg-default)]">{s.program_name ?? '—'}</td>
                            <td className="p-3 text-[var(--color-fg-muted)]">{s.cohort_name ?? '—'}</td>
                            <td className="p-3 text-[var(--color-fg-default)]">
                              {s.primary_guardian_name ?? 'Not Listed'}
                            </td>
                            <td className="p-3 text-[var(--color-fg-muted)] font-mono text-xs">
                              {s.primary_guardian_phone ?? '—'}
                            </td>
                            <td className="p-3">
                              <StatusBadge
                                status={s.enrolment_status === 'ACTIVE' ? 'confirmed' : 'pending'}
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
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[var(--color-bg-subtle)] p-4 rounded-lg">
                <div className="flex items-center space-x-3">
                  <TextField
                    label="Report Date"
                    type="date"
                    value={attendanceDate}
                    onChange={(e) => setAttendanceDate(e.target.value)}
                  />
                </div>
                <div className="text-sm text-[var(--color-fg-muted)]">
                  Attendance Compliance Rate:{' '}
                  <span className="font-semibold text-[var(--color-fg-default)]">
                    {attendanceData.summary.attendance_rate}%
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Conducted Sessions"
                  value={attendanceData.summary.total_sessions_conducted}
                  helper="With submitted attendance"
                  tone="emerald"
                />
                <StatCard
                  label="Missing Registers"
                  value={attendanceData.summary.missing_registers_count}
                  helper="Scheduled but not marked"
                  tone="coral"
                />
                <StatCard
                  label="Present Marks"
                  value={attendanceData.summary.present_count}
                  helper="Students present in class"
                  tone="purple"
                />
                <StatCard
                  label="Absent Marks"
                  value={attendanceData.summary.absent_count}
                  helper="Absences recorded on date"
                  tone="amber"
                />
              </div>

              <Card title={`Class Sessions on ${attendanceData.date}`}>
                <div className="p-4 border-b border-[var(--color-border-subtle)] flex justify-between items-center">
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    {attendanceData.sessions.length} sessions scheduled
                  </span>
                </div>
                {attendanceData.sessions.length === 0 ? (
                  <EmptyState
                    title="No Sessions Scheduled"
                    description="No class timetable sessions exist for the selected date."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[var(--color-bg-subtle)] border-b border-[var(--color-border-subtle)] text-[var(--color-fg-muted)]">
                        <tr>
                          <th scope="col" className="p-3">Course / Subject</th>
                          <th scope="col" className="p-3">Campus</th>
                          <th scope="col" className="p-3">Faculty</th>
                          <th scope="col" className="p-3">Status</th>
                          <th scope="col" className="p-3 text-right">Present</th>
                          <th scope="col" className="p-3 text-right">Absent</th>
                          <th scope="col" className="p-3 text-right">Late</th>
                          <th scope="col" className="p-3 text-right">Attendance %</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-subtle)]">
                        {attendanceData.sessions.map((s) => (
                          <tr key={s.session_id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                            <td className="p-3">
                              <div className="font-medium text-[var(--color-fg-default)]">{s.course_name}</div>
                              <div className="text-xs font-mono text-[var(--color-fg-muted)]">{s.course_code}</div>
                            </td>
                            <td className="p-3 text-[var(--color-fg-muted)]">{s.campus_name}</td>
                            <td className="p-3 text-[var(--color-fg-default)]">{s.teacher_name}</td>
                            <td className="p-3">
                              <StatusBadge
                                status={s.attendance_state === 'SUBMITTED' ? 'confirmed' : 'pending'}
                                label={s.attendance_state === 'SUBMITTED' ? 'Conducted' : 'Missing Register'}
                              />
                            </td>
                            <td className="p-3 text-right font-medium text-emerald-600">{s.present_count}</td>
                            <td className="p-3 text-right font-medium text-rose-600">{s.absent_count}</td>
                            <td className="p-3 text-right text-[var(--color-fg-muted)]">{s.late_count}</td>
                            <td className="p-3 text-right font-semibold text-[var(--color-fg-default)]">
                              {s.total_marked > 0 ? `${s.attendance_percentage}%` : '—'}
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Published Schedules"
                  value={examData.summary.total_published_exams}
                  helper="Verified & released outcomes"
                  tone="purple"
                />
                <StatCard
                  label="Candidates Appeared"
                  value={examData.summary.total_candidates_appeared}
                  helper="Total students assessed"
                  tone="amber"
                />
                <StatCard
                  label="Overall Pass Rate"
                  value={`${examData.summary.overall_pass_percentage}%`}
                  helper={`${examData.summary.total_passed} passed, ${examData.summary.total_failed} failed`}
                  tone="emerald"
                />
                <StatCard
                  label="Average Score"
                  value={examData.summary.average_score}
                  helper="Mean marks across assessments"
                  tone="coral"
                />
              </div>

              <Card title="Published Examination Performance Breakdown">
                <div className="p-4 border-b border-[var(--color-border-subtle)] flex justify-between items-center">
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    Strictly excludes unpublished draft marks
                  </span>
                </div>
                {examData.schedules.length === 0 ? (
                  <EmptyState
                    title="No Published Results"
                    description="No examination results have been published for administrative reporting yet."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[var(--color-bg-subtle)] border-b border-[var(--color-border-subtle)] text-[var(--color-fg-muted)]">
                        <tr>
                          <th scope="col" className="p-3">Examination</th>
                          <th scope="col" className="p-3">Subject / Course</th>
                          <th scope="col" className="p-3">Date</th>
                          <th scope="col" className="p-3 text-right">Max Marks</th>
                          <th scope="col" className="p-3 text-right">Appeared</th>
                          <th scope="col" className="p-3 text-right">Passed</th>
                          <th scope="col" className="p-3 text-right">Pass %</th>
                          <th scope="col" className="p-3 text-right">Average</th>
                          <th scope="col" className="p-3 text-right">Highest</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-subtle)]">
                        {examData.schedules.map((s) => (
                          <tr key={s.schedule_id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                            <td className="p-3">
                              <div className="font-medium text-[var(--color-fg-default)]">{s.examination_name}</div>
                              <div className="text-xs text-[var(--color-fg-muted)]">{s.exam_type}</div>
                            </td>
                            <td className="p-3">
                              <div className="font-medium text-[var(--color-fg-default)]">{s.course_name}</div>
                              <div className="text-xs font-mono text-[var(--color-fg-muted)]">{s.course_code}</div>
                            </td>
                            <td className="p-3 text-[var(--color-fg-muted)] font-mono text-xs">{s.exam_date}</td>
                            <td className="p-3 text-right text-[var(--color-fg-muted)]">{s.max_marks}</td>
                            <td className="p-3 text-right font-medium text-[var(--color-fg-default)]">
                              {s.appeared_count}
                            </td>
                            <td className="p-3 text-right font-medium text-emerald-600">{s.passed_count}</td>
                            <td className="p-3 text-right font-semibold text-[var(--color-fg-default)]">
                              {s.pass_percentage}%
                            </td>
                            <td className="p-3 text-right font-medium text-[var(--color-fg-default)]">
                              {s.average_marks}
                            </td>
                            <td className="p-3 text-right font-medium text-indigo-600">{s.highest_marks}</td>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Confirmed Collections"
                  value={formatCurrency(feeData.summary.confirmed_collections)}
                  helper={`${feeData.summary.confirmed_receipt_count} reconciled receipts`}
                  tone="emerald"
                />
                <StatCard
                  label="In Clearing (Unverified)"
                  value={formatCurrency(feeData.summary.unverified_collections)}
                  helper={`${feeData.summary.unverified_receipt_count} in-flight cheques/transfers`}
                  tone="amber"
                />
                <StatCard
                  label="Total Outstanding Dues"
                  value={formatCurrency(feeData.summary.total_outstanding_dues)}
                  helper={`${feeData.summary.defaulters_count} student accounts with balance`}
                  tone="coral"
                />
                <StatCard
                  label="Collection Efficiency"
                  value={`${feeData.summary.collection_efficiency_percentage}%`}
                  helper="Settlement against net billed dues"
                  tone="purple"
                />
              </div>

              <Card title="Outstanding Dues & Defaulter Register">
                <div className="p-4 border-b border-[var(--color-border-subtle)] flex justify-between items-center">
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    Unverified cheques in clearing are distinguished from settled balances
                  </p>
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    {feeData.defaulters.length} accounts pending
                  </span>
                </div>
                {feeData.defaulters.length === 0 ? (
                  <EmptyState
                    title="No Outstanding Dues"
                    description="All assessed student fee dues have been fully settled."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-[var(--color-bg-subtle)] border-b border-[var(--color-border-subtle)] text-[var(--color-fg-muted)]">
                        <tr>
                          <th scope="col" className="p-3">Admission No</th>
                          <th scope="col" className="p-3">Student Name</th>
                          <th scope="col" className="p-3">Due Number</th>
                          <th scope="col" className="p-3">Due Date</th>
                          <th scope="col" className="p-3 text-right">Net Billed</th>
                          <th scope="col" className="p-3 text-right">Confirmed Paid</th>
                          <th scope="col" className="p-3 text-right">Balance Due</th>
                          <th scope="col" className="p-3">In-Flight Clearing</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border-subtle)]">
                        {feeData.defaulters.map((d) => (
                          <tr key={d.due_number} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                            <td className="p-3 font-mono font-medium text-[var(--color-fg-default)]">
                              {d.admission_number}
                            </td>
                            <td className="p-3 font-medium text-[var(--color-fg-default)]">{d.student_name}</td>
                            <td className="p-3 font-mono text-xs text-[var(--color-fg-muted)]">{d.due_number}</td>
                            <td className="p-3 text-xs text-[var(--color-fg-muted)]">{d.due_date}</td>
                            <td className="p-3 text-right text-[var(--color-fg-muted)]">
                              {formatCurrency(d.net_amount)}
                            </td>
                            <td className="p-3 text-right text-emerald-600 font-medium">
                              {formatCurrency(d.paid_amount)}
                            </td>
                            <td className="p-3 text-right text-rose-600 font-bold">
                              {formatCurrency(d.balance_amount)}
                            </td>
                            <td className="p-3">
                              {d.has_unverified_receipt ? (
                                <StatusBadge status="pending" label="Cheque in Clearing" />
                              ) : (
                                <span className="text-xs text-[var(--color-fg-muted)]">No In-Flight Ref</span>
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
    </div>
  );
}
