import { useEffect, useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { usePageTitle } from '../components/usePageTitle';
import { SegmentedNav } from '../components/ui/SegmentedNav';
import { StatCard } from '../components/ui/StatCard';
import { Badge } from '../components/ui/Badge';
import {
  fetchParentChildren,
  fetchChildSummary,
  fetchChildAttendance,
  fetchChildAcademics,
  fetchChildExaminations,
  fetchChildFees,
  type ParentChild,
  type ChildSummary,
  type ChildAttendance,
  type ChildAcademics,
  type ChildExaminations,
  type ChildFees,
} from '../lib/api/parent-api';
import { fetchParentStudentHomework, type StudentHomeworkItem } from '../lib/api/homework-api';

type TabKey =
  'overview' | 'attendance' | 'academics' | 'homework' | 'examinations' | 'fees' | 'profile';

const TABS: { id: TabKey; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'academics', label: 'Academics' },
  { id: 'homework', label: 'Homework' },
  { id: 'examinations', label: 'Examinations' },
  { id: 'fees', label: 'Fees & Payments' },
  { id: 'profile', label: 'Family Profile' },
];

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount / 100);
}

export function ParentPortalPage() {
  usePageTitle('Parent Portal');
  const { client, identity } = useAuth();

  const [children, setChildren] = useState<ParentChild[]>([]);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  const [loading, setLoading] = useState<boolean>(true);
  const [tabLoading, setTabLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Tab data caches
  const [summary, setSummary] = useState<ChildSummary | null>(null);
  const [attendance, setAttendance] = useState<ChildAttendance | null>(null);
  const [academics, setAcademics] = useState<ChildAcademics | null>(null);
  const [examinations, setExaminations] = useState<ChildExaminations | null>(null);
  const [fees, setFees] = useState<ChildFees | null>(null);
  const [childHomework, setChildHomework] = useState<StudentHomeworkItem[]>([]);

  // Attendance filter
  const [attendanceFilter, setAttendanceFilter] = useState<'ALL' | 'PRESENT' | 'ABSENT' | 'LATE'>(
    'ALL',
  );

  // Payment modal state
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [paymentSuccess, setPaymentSuccess] = useState<boolean>(false);
  const [paymentProcessing, setPaymentProcessing] = useState<boolean>(false);

  // 1. Initial load: fetch verified children
  useEffect(() => {
    let mounted = true;
    async function loadInitial() {
      setLoading(true);
      setError(null);
      try {
        const list = await fetchParentChildren(client);
        if (!mounted) return;
        setChildren(list);
        if (list.length > 0) {
          setSelectedChildId(list[0]!.studentId);
        }
      } catch (err: unknown) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Unable to load linked student records.');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      mounted = false;
    };
  }, [client]);

  // 2. Load active tab data when child or tab changes
  useEffect(() => {
    if (!selectedChildId) return;

    let mounted = true;
    async function loadTabData() {
      setTabLoading(true);
      try {
        if (activeTab === 'overview') {
          const res = await fetchChildSummary(client, selectedChildId!);
          if (mounted) setSummary(res);
        } else if (activeTab === 'attendance') {
          const res = await fetchChildAttendance(client, selectedChildId!);
          if (mounted) setAttendance(res);
        } else if (activeTab === 'academics') {
          const res = await fetchChildAcademics(client, selectedChildId!);
          if (mounted) setAcademics(res);
          try {
            const hwRes = await fetchParentStudentHomework(client, selectedChildId!);
            if (mounted) setChildHomework(hwRes);
          } catch {
            // Optional/best-effort
          }
        } else if (activeTab === 'homework') {
          const hwRes = await fetchParentStudentHomework(client, selectedChildId!);
          if (mounted) setChildHomework(hwRes);
        } else if (activeTab === 'examinations') {
          const res = await fetchChildExaminations(client, selectedChildId!);
          if (mounted) setExaminations(res);
        } else if (activeTab === 'fees') {
          const res = await fetchChildFees(client, selectedChildId!);
          if (mounted) setFees(res);
        }
      } catch (err: unknown) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Unable to load section data.');
        }
      } finally {
        if (mounted) setTabLoading(false);
      }
    }
    void loadTabData();
    return () => {
      mounted = false;
    };
  }, [client, selectedChildId, activeTab]);

  const activeChild = children.find((c) => c.studentId === selectedChildId);

  // Handler for simulated sandbox fee payment
  const handleSimulatePayment = () => {
    setPaymentProcessing(true);
    setTimeout(() => {
      setPaymentProcessing(false);
      setPaymentSuccess(true);
      setTimeout(() => {
        setPaymentSuccess(false);
        setShowPaymentModal(false);
      }, 2500);
    }, 1200);
  };

  if (loading) {
    return (
      <div className="anesa-card" style={{ padding: '3rem', textAlign: 'center' }}>
        <p style={{ color: 'var(--color-fg-muted)' }}>Loading student records...</p>
      </div>
    );
  }

  if (error && children.length === 0) {
    return (
      <div className="anesa-card" style={{ padding: '2.5rem', textAlign: 'center' }}>
        <h2
          style={{
            fontSize: '1.25rem',
            color: 'var(--color-danger, #d73a49)',
            marginBottom: '0.75rem',
          }}
        >
          Parent Portal Access Notice
        </h2>
        <p style={{ color: 'var(--color-fg-muted)', maxWidth: '480px', margin: '0 auto 1.5rem' }}>
          {error}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Retry Connection
        </button>
      </div>
    );
  }

  if (children.length === 0) {
    return (
      <div className="anesa-card" style={{ padding: '3rem', textAlign: 'center' }}>
        <div
          style={{
            width: '64px',
            height: '64px',
            margin: '0 auto 1.5rem',
            borderRadius: '50%',
            backgroundColor: '#F3EEFB',
            color: 'var(--brand-primary, #504175)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.75rem',
          }}
        >
          👨‍👩‍👧
        </div>
        <h2
          style={{
            fontSize: '1.25rem',
            fontWeight: 600,
            marginBottom: '0.5rem',
            color: 'var(--brand-primary, #504175)',
          }}
        >
          Guardian Account Active
        </h2>
        <p style={{ color: 'var(--color-fg-muted)', maxWidth: '520px', margin: '0 auto 1.5rem' }}>
          Your parent/guardian account has been verified, but is not currently linked to an active
          enrolled student. Please contact the school admissions or administrative office to link
          your student profile.
        </p>
        <div style={{ display: 'inline-flex', gap: '0.75rem' }}>
          <a href="/help" className="btn btn-outline">
            Contact School Office
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="parent-portal"
      style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
    >
      {/* Header Banner & Child Switcher */}
      <div
        className="anesa-card"
        style={{
          background: 'linear-gradient(135deg, #504175 0%, #3B2E58 100%)',
          color: '#ffffff',
          padding: '1.75rem 2rem',
          borderRadius: '12px',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '0.25rem',
              }}
            >
              <span
                style={{
                  fontSize: '0.8125rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  opacity: 0.85,
                }}
              >
                Anesa Campus OS • Family Portal
              </span>
            </div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 700,
                margin: '0 0 0.5rem 0',
                color: '#ffffff',
              }}
            >
              {activeChild?.displayName ?? 'Student Portal'}
            </h1>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                flexWrap: 'wrap',
                fontSize: '0.875rem',
                opacity: 0.9,
              }}
            >
              <span>Admission #{activeChild?.admissionNumber}</span>
              {activeChild?.programName && <span>• {activeChild.programName}</span>}
              {activeChild?.cohortName && <span>• {activeChild.cohortName}</span>}
              {activeChild?.campusName && <span>• {activeChild.campusName}</span>}
            </div>
          </div>

          {/* Child Switcher for Multi-Child Parents */}
          {children.length > 1 && (
            <div style={{ minWidth: '220px' }}>
              <label
                htmlFor="child-select"
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '0.25rem',
                  opacity: 0.85,
                }}
              >
                Select Student ({children.length} Linked)
              </label>
              <select
                id="child-select"
                value={selectedChildId ?? ''}
                onChange={(e) => setSelectedChildId(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  backgroundColor: 'rgba(255, 255, 255, 0.15)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.3)',
                  fontWeight: 500,
                  fontSize: '0.875rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                {children.map((c) => (
                  <option
                    key={c.studentId}
                    value={c.studentId}
                    style={{ color: '#1f2937', backgroundColor: '#ffffff' }}
                  >
                    {c.displayName} ({c.relation})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Standard Segmented Navigation in Deep Royal Purple */}
      <SegmentedNav
        items={TABS}
        activeId={activeTab}
        onChange={(id) => setActiveTab(id)}
        ariaLabel="Parent Portal Navigation"
      />

      {tabLoading && (
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}>
          Updating student information...
        </div>
      )}

      {/* 1. OVERVIEW TAB */}
      {!tabLoading && activeTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Key KPI Stats */}
          <div className="anesa-stat-grid anesa-stat-grid--4">
            <StatCard
              label="Attendance Rate"
              value={`${summary?.attendance.rate ?? 0}%`}
              tone={(summary?.attendance.rate ?? 0) >= 80 ? 'positive' : 'warning'}
              detail={`${summary?.attendance.present ?? 0} present of ${summary?.attendance.conducted ?? 0} sessions`}
              compact
            />
            <StatCard
              label="Outstanding Dues"
              value={formatCurrency(summary?.fees.totalOutstanding ?? 0)}
              tone={(summary?.fees.totalOutstanding ?? 0) === 0 ? 'positive' : 'warning'}
              detail={
                summary?.fees.nextDue
                  ? `Next due: ${summary.fees.nextDue.dueDate}`
                  : 'All dues clear'
              }
              compact
            />
            <StatCard
              label="Active Courses"
              value={summary?.academics.coursesCount ?? 0}
              tone="neutral"
              detail="Current enrolled term"
              compact
            />
            <StatCard
              label="Latest Exam Grade"
              value={summary?.examinations.latestPublished[0]?.grade ?? '—'}
              tone="brand"
              detail={summary?.examinations.latestPublished[0]?.examName ?? 'Pending publication'}
              compact
            />
          </div>

          {/* Quick Action & Notice Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: '1.5rem',
            }}
          >
            {/* Quick Fee Notice */}
            <div className="anesa-card">
              <div className="anesa-card-header">
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Fee Status</h2>
                {(summary?.fees.totalOutstanding ?? 0) > 0 ? (
                  <Badge tone="warning">Payment Due</Badge>
                ) : (
                  <Badge tone="positive">Paid in Full</Badge>
                )}
              </div>
              <div className="anesa-card-body">
                {(summary?.fees.totalOutstanding ?? 0) > 0 ? (
                  <div>
                    <p
                      style={{
                        margin: '0 0 1rem 0',
                        color: 'var(--color-fg-muted)',
                        fontSize: '0.875rem',
                      }}
                    >
                      You have an outstanding balance of{' '}
                      <strong>{formatCurrency(summary?.fees.totalOutstanding ?? 0)}</strong>.
                      {summary?.fees.nextDue && ` Due by ${summary.fees.nextDue.dueDate}.`}
                    </p>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setShowPaymentModal(true)}
                    >
                      Pay Online (Sandbox)
                    </button>
                  </div>
                ) : (
                  <p style={{ margin: 0, color: 'var(--color-fg-muted)', fontSize: '0.875rem' }}>
                    All school fees for this term are up to date. Thank you!
                  </p>
                )}
              </div>
            </div>

            {/* Latest Official Examination Results */}
            <div className="anesa-card">
              <div className="anesa-card-header">
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Latest Official Marks
                </h2>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-fg-muted)' }}>
                  Published only
                </span>
              </div>
              <div className="anesa-card-body" style={{ padding: 0 }}>
                {summary && summary.examinations.latestPublished.length > 0 ? (
                  <div className="anesa-table-wrapper">
                    <table className="anesa-table">
                      <thead>
                        <tr>
                          <th>Subject</th>
                          <th>Exam</th>
                          <th style={{ textAlign: 'right' }}>Score</th>
                          <th style={{ textAlign: 'right' }}>Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.examinations.latestPublished.map((ex, idx) => (
                          <tr key={idx}>
                            <td style={{ fontWeight: 500 }}>{ex.courseName}</td>
                            <td style={{ color: 'var(--color-fg-muted)' }}>{ex.examName}</td>
                            <td style={{ textAlign: 'right' }}>
                              {ex.marksObtained}/{ex.maxMarks}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <Badge
                                tone={
                                  ex.grade === 'PASS' ||
                                  ex.grade.startsWith('A') ||
                                  ex.grade.startsWith('B')
                                    ? 'positive'
                                    : 'neutral'
                                }
                              >
                                {ex.grade}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '1.5rem',
                      textAlign: 'center',
                      color: 'var(--color-fg-muted)',
                      fontSize: '0.875rem',
                    }}
                  >
                    No officially published examination results for this session yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. ATTENDANCE TAB */}
      {!tabLoading && activeTab === 'attendance' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="anesa-stat-grid anesa-stat-grid--4">
            <StatCard
              label="Overall Attendance"
              value={`${attendance?.attendanceRate ?? 0}%`}
              tone={(attendance?.attendanceRate ?? 0) >= 80 ? 'positive' : 'warning'}
              detail="Required minimum: 75%"
              compact
            />
            <StatCard
              label="Conducted Sessions"
              value={attendance?.totalSessions ?? 0}
              tone="neutral"
              detail="Total tracked classes"
              compact
            />
            <StatCard
              label="Present"
              value={attendance?.presentCount ?? 0}
              tone="positive"
              detail="Recorded on-time"
              compact
            />
            <StatCard
              label="Absent"
              value={attendance?.absentCount ?? 0}
              tone={(attendance?.absentCount ?? 0) > 5 ? 'danger' : 'neutral'}
              detail="Missed sessions"
              compact
            />
          </div>

          <div className="anesa-card">
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Daily Session Log</h2>
              <div className="anesa-filter-group" style={{ display: 'flex', gap: '0.5rem' }}>
                {(['ALL', 'PRESENT', 'ABSENT', 'LATE'] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={`btn btn-xs ${attendanceFilter === filter ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setAttendanceFilter(filter)}
                  >
                    {filter === 'ALL' ? 'All' : filter.charAt(0) + filter.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {attendance && attendance.records.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Period / Session</th>
                        <th>Subject</th>
                        <th>Status</th>
                        <th>Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attendance.records
                        .filter((r) => attendanceFilter === 'ALL' || r.status === attendanceFilter)
                        .map((r, idx) => (
                          <tr key={idx}>
                            <td style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{r.date}</td>
                            <td>{r.period}</td>
                            <td>{r.courseName}</td>
                            <td>
                              <Badge
                                tone={
                                  r.status === 'PRESENT'
                                    ? 'positive'
                                    : r.status === 'ABSENT'
                                      ? 'danger'
                                      : 'warning'
                                }
                              >
                                {r.status}
                              </Badge>
                            </td>
                            <td style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}>
                              {r.remarks || '—'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  No attendance session records recorded for this student yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 3. ACADEMICS TAB */}
      {!tabLoading && activeTab === 'academics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Homework Transparency Notice */}
          <div
            style={{
              padding: '1rem 1.25rem',
              borderRadius: '8px',
              backgroundColor: '#EFF6FF',
              border: '1px solid #BFDBFE',
              color: '#1E40AF',
              fontSize: '0.875rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
            }}
          >
            <span>ℹ️</span>
            <div>
              <strong>Term Schedule Update:</strong>{' '}
              {academics?.homeworkService.message ||
                'The digital homework and assignment module is pending school term deployment.'}
            </div>
          </div>

          {/* Enrolled Courses */}
          <div className="anesa-card">
            <div className="anesa-card-header">
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                Enrolled Subjects & Faculty
              </h2>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                {academics?.courses.length ?? 0} Courses
              </span>
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {academics && academics.courses.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th style={{ width: '120px' }}>Course Code</th>
                        <th>Subject Title</th>
                        <th>Assigned Faculty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {academics.courses.map((c, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600, color: 'var(--brand-primary, #504175)' }}>
                            {c.courseCode}
                          </td>
                          <td style={{ fontWeight: 500 }}>{c.courseName}</td>
                          <td style={{ color: 'var(--color-fg-muted)' }}>
                            {c.facultyName || 'Faculty Assigned'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  No active courses registered for this term yet.
                </div>
              )}
            </div>
          </div>

          {/* Child Homework & Assignments Preview */}
          <div className="anesa-card">
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Active Homework & Assignments
                </h2>
                <span style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                  {childHomework.length} Tasks Recorded
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('homework')}
                className="anesa-btn anesa-btn--secondary"
                style={{ padding: '0.25rem 0.75rem', fontSize: '0.8125rem' }}
              >
                Open Full Homework Hub →
              </button>
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {childHomework.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Assignment</th>
                        <th>Due Date</th>
                        <th>Submission</th>
                        <th>Grade / Feedback</th>
                      </tr>
                    </thead>
                    <tbody>
                      {childHomework.map((hw) => (
                        <tr key={hw.id}>
                          <td style={{ fontWeight: 600, color: 'var(--brand-primary, #504175)' }}>
                            {hw.courseTitle}
                          </td>
                          <td style={{ fontWeight: 500 }}>{hw.title}</td>
                          <td>{hw.dueDate || '—'}</td>
                          <td>
                            <Badge
                              tone={
                                hw.submissionStatus === 'SUBMITTED'
                                  ? 'info'
                                  : hw.submissionStatus === 'REVIEWED'
                                    ? 'positive'
                                    : hw.submissionStatus === 'OVERDUE'
                                      ? 'danger'
                                      : 'warning'
                              }
                            >
                              {hw.submissionStatus}
                            </Badge>
                          </td>
                          <td>
                            {hw.marksObtained !== null && hw.marksObtained !== undefined ? (
                              <span style={{ fontWeight: 600, color: 'var(--color-emerald-ink)' }}>
                                {hw.marksObtained} {hw.grade ? `(${hw.grade})` : ''}
                              </span>
                            ) : (
                              <span
                                style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}
                              >
                                {hw.feedback || '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  No homework assignments pending for this student.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 4. HOMEWORK TAB */}
      {!tabLoading && activeTab === 'homework' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="anesa-stat-grid anesa-stat-grid--4">
            <StatCard
              label="Assigned Tasks"
              value={childHomework.length}
              tone="purple"
              helper="Current term assignments"
            />
            <StatCard
              label="Submitted"
              value={
                childHomework.filter(
                  (h) => h.submissionStatus === 'SUBMITTED' || h.submissionStatus === 'REVIEWED',
                ).length
              }
              tone="emerald"
              helper="Work turned in"
            />
            <StatCard
              label="Pending"
              value={childHomework.filter((h) => h.submissionStatus === 'PENDING').length}
              tone="amber"
              helper="To be completed"
            />
            <StatCard
              label="Evaluated"
              value={
                childHomework.filter((h) => h.evaluatedAt !== null || h.marksObtained !== null)
                  .length
              }
              tone="coral"
              helper="With grades/feedback"
            />
          </div>

          <div className="anesa-card">
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Curriculum Homework & Assignments
                </h2>
                <p
                  style={{
                    margin: '0.25rem 0 0 0',
                    fontSize: '0.8125rem',
                    color: 'var(--color-fg-muted)',
                  }}
                >
                  View assigned tasks, submission status, grades, and teacher feedback for your
                  child.
                </p>
              </div>
              <Badge tone="purple">{childHomework.length} Assignments</Badge>
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {childHomework.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Subject & Teacher</th>
                        <th>Assignment Title</th>
                        <th>Due Date</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Score / Grade</th>
                        <th>Teacher Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {childHomework.map((hw) => (
                        <tr key={hw.id}>
                          <td>
                            <div
                              style={{ fontWeight: 600, color: 'var(--brand-primary, #504175)' }}
                            >
                              {hw.courseTitle}
                            </div>
                            <div style={{ fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                              {hw.teacherName} {hw.sectionName ? `• ${hw.sectionName}` : ''}
                            </div>
                          </td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{hw.title}</div>
                            {hw.instructions && (
                              <div
                                style={{
                                  fontSize: '0.8125rem',
                                  color: 'var(--color-fg-muted)',
                                  maxWidth: '260px',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {hw.instructions}
                              </div>
                            )}
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {hw.dueDate || '—'} {hw.dueTime ? `(${hw.dueTime})` : ''}
                          </td>
                          <td>
                            <Badge tone={hw.submissionType === 'ONLINE' ? 'info' : 'neutral'}>
                              {hw.submissionType}
                            </Badge>
                          </td>
                          <td>
                            <Badge
                              tone={
                                hw.submissionStatus === 'SUBMITTED'
                                  ? 'info'
                                  : hw.submissionStatus === 'REVIEWED'
                                    ? 'positive'
                                    : hw.submissionStatus === 'OVERDUE'
                                      ? 'danger'
                                      : 'warning'
                              }
                            >
                              {hw.submissionStatus}
                            </Badge>
                          </td>
                          <td>
                            {hw.marksObtained !== null && hw.marksObtained !== undefined ? (
                              <span style={{ fontWeight: 600, color: 'var(--color-emerald-ink)' }}>
                                {hw.marksObtained} {hw.maxMarks ? `/ ${hw.maxMarks}` : ''}{' '}
                                {hw.grade ? `(${hw.grade})` : ''}
                              </span>
                            ) : (
                              <span
                                style={{ color: 'var(--color-fg-muted)', fontSize: '0.8125rem' }}
                              >
                                {hw.submissionStatus === 'SUBMITTED' ? 'Under Evaluation' : '—'}
                              </span>
                            )}
                          </td>
                          <td
                            style={{
                              fontSize: '0.8125rem',
                              color: 'var(--color-fg-muted)',
                              maxWidth: '200px',
                            }}
                          >
                            {hw.feedback || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  No homework assignments recorded for this student yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 5. EXAMINATIONS TAB */}
      {!tabLoading && activeTab === 'examinations' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Strictly Published Results */}
          <div className="anesa-card">
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Official Published Results
                </h2>
                <p
                  style={{
                    margin: '0.25rem 0 0 0',
                    fontSize: '0.8125rem',
                    color: 'var(--color-fg-muted)',
                  }}
                >
                  Only verified results published by the examination authority appear here.
                </p>
              </div>
              <Badge tone="brand">Official</Badge>
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {examinations && examinations.publishedResults.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Subject Code</th>
                        <th>Subject Title</th>
                        <th>Examination</th>
                        <th style={{ textAlign: 'right' }}>Marks</th>
                        <th style={{ textAlign: 'right' }}>Max</th>
                        <th style={{ textAlign: 'right' }}>Grade</th>
                        <th>Published Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {examinations.publishedResults.map((r, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600 }}>{r.courseCode}</td>
                          <td style={{ fontWeight: 500 }}>{r.courseName}</td>
                          <td style={{ color: 'var(--color-fg-muted)' }}>{r.examName}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.marksObtained}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-fg-muted)' }}>
                            {r.maxMarks}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <Badge
                              tone={
                                r.grade === 'PASS' ||
                                r.grade.startsWith('A') ||
                                r.grade.startsWith('B')
                                  ? 'positive'
                                  : 'neutral'
                              }
                            >
                              {r.grade}
                            </Badge>
                          </td>
                          <td style={{ color: 'var(--color-fg-muted)', whiteSpace: 'nowrap' }}>
                            {r.publishedDate}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  <p style={{ margin: '0 0 0.5rem 0', fontWeight: 500 }}>
                    No published results yet
                  </p>
                  <p style={{ margin: 0, fontSize: '0.875rem' }}>
                    Results for ongoing or past examination sessions will be visible as soon as they
                    are approved and published.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Upcoming Examinations */}
          {examinations && examinations.upcomingExams.length > 0 && (
            <div className="anesa-card">
              <div className="anesa-card-header">
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Scheduled Examinations
                </h2>
              </div>
              <div className="anesa-card-body" style={{ padding: 0 }}>
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Examination</th>
                        <th>Subject</th>
                        <th>Date</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {examinations.upcomingExams.map((u, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 500 }}>{u.examName}</td>
                          <td>{u.courseName}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{u.date}</td>
                          <td style={{ whiteSpace: 'nowrap', color: 'var(--color-fg-muted)' }}>
                            {u.time}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 5. FEES & PAYMENTS TAB */}
      {!tabLoading && activeTab === 'fees' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Fee Summary Cards */}
          <div className="anesa-stat-grid anesa-stat-grid--3">
            <StatCard
              label="Total Billed"
              value={formatCurrency(fees?.summary.totalBilled ?? 0)}
              tone="neutral"
              detail="Total academic dues"
              compact
            />
            <StatCard
              label="Total Paid"
              value={formatCurrency(fees?.summary.totalPaid ?? 0)}
              tone="positive"
              detail="Confirmed payments"
              compact
            />
            <StatCard
              label="Total Outstanding"
              value={formatCurrency(fees?.summary.totalOutstanding ?? 0)}
              tone={(fees?.summary.totalOutstanding ?? 0) === 0 ? 'positive' : 'warning'}
              detail={
                (fees?.summary.totalOutstanding ?? 0) === 0
                  ? 'Account settled'
                  : 'Immediate balance due'
              }
              compact
            />
          </div>

          {/* Dues Ledger */}
          <div className="anesa-card">
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Fee Dues Ledger</h2>
                <p
                  style={{
                    margin: '0.25rem 0 0 0',
                    fontSize: '0.8125rem',
                    color: 'var(--color-fg-muted)',
                  }}
                >
                  Breakdown of tuition, institutional and academic fees.
                </p>
              </div>
              {(fees?.summary.totalOutstanding ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setShowPaymentModal(true)}
                >
                  Pay Outstanding Balance
                </button>
              )}
            </div>
            <div className="anesa-card-body" style={{ padding: 0 }}>
              {fees && fees.dues.length > 0 ? (
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Due #</th>
                        <th>Description</th>
                        <th>Due Date</th>
                        <th style={{ textAlign: 'right' }}>Net Fee</th>
                        <th style={{ textAlign: 'right' }}>Paid</th>
                        <th style={{ textAlign: 'right' }}>Balance</th>
                        <th style={{ textAlign: 'center' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fees.dues.map((d) => (
                        <tr key={d.id}>
                          <td style={{ fontWeight: 600, color: 'var(--brand-primary, #504175)' }}>
                            {d.dueNumber}
                          </td>
                          <td style={{ fontWeight: 500 }}>{d.title}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{d.dueDate}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(d.netAmount)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-fg-muted)' }}>
                            {formatCurrency(d.paidAmount)}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>
                            {formatCurrency(d.balanceAmount)}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <Badge
                              tone={
                                d.status === 'PAID'
                                  ? 'positive'
                                  : d.status === 'PARTIAL'
                                    ? 'warning'
                                    : 'danger'
                              }
                            >
                              {d.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-fg-muted)' }}
                >
                  No fee dues recorded for this account.
                </div>
              )}
            </div>
          </div>

          {/* Payment Receipts */}
          {fees && fees.receipts.length > 0 && (
            <div className="anesa-card">
              <div className="anesa-card-header">
                <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                  Official Payment Receipts
                </h2>
              </div>
              <div className="anesa-card-body" style={{ padding: 0 }}>
                <div className="anesa-table-wrapper">
                  <table className="anesa-table">
                    <thead>
                      <tr>
                        <th>Receipt #</th>
                        <th>Payment Date</th>
                        <th>Payment Method</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th style={{ textAlign: 'center' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fees.receipts.map((r, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600 }}>{r.receiptNumber}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.receiptDate}</td>
                          <td>{r.paymentMode.replace(/_/g, ' ')}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>
                            {formatCurrency(r.amount)}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <Badge tone="positive">{r.status}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 6. FAMILY PROFILE TAB */}
      {!tabLoading && activeTab === 'profile' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1.5rem',
          }}
        >
          {/* Guardian Profile Card */}
          <div className="anesa-card">
            <div className="anesa-card-header">
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Guardian Account</h2>
              <Badge tone="positive">Verified</Badge>
            </div>
            <div
              className="anesa-card-body"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                fontSize: '0.875rem',
              }}
            >
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Guardian Name
                </span>
                <strong>{identity?.displayName || 'Registered Guardian'}</strong>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Relationship
                </span>
                <span>{activeChild?.relation || 'Guardian'}</span>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Primary Contact Status
                </span>
                <span>{activeChild?.isPrimary ? 'Primary Guardian' : 'Secondary Guardian'}</span>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Academic Access
                </span>
                <span>{activeChild?.canViewAcademics ? 'Authorized' : 'Restricted'}</span>
              </div>
            </div>
          </div>

          {/* Student Record Card */}
          <div className="anesa-card">
            <div className="anesa-card-header">
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
                Enrolled Student Profile
              </h2>
              <Badge tone="brand">{activeChild?.status || 'ACTIVE'}</Badge>
            </div>
            <div
              className="anesa-card-body"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
                fontSize: '0.875rem',
              }}
            >
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Full Student Name
                </span>
                <strong>{activeChild?.displayName}</strong>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Admission Number
                </span>
                <span>{activeChild?.admissionNumber}</span>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Campus
                </span>
                <span>{activeChild?.campusName || 'Main Campus'}</span>
              </div>
              <div>
                <span
                  style={{ color: 'var(--color-fg-muted)', display: 'block', fontSize: '0.75rem' }}
                >
                  Program & Cohort
                </span>
                <span>
                  {activeChild?.programName || 'Standard Program'} •{' '}
                  {activeChild?.cohortName || 'Active Cohort'}
                </span>
              </div>
            </div>
          </div>

          {/* Help & Support Notice */}
          <div className="anesa-card" style={{ gridColumn: '1 / -1' }}>
            <div
              className="anesa-card-body"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1rem',
              }}
            >
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '0.9375rem', fontWeight: 600 }}>
                  Need to update your official contact details?
                </h4>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-fg-muted)' }}>
                  To ensure child safety and statutory record compliance, updates to phone numbers,
                  emergency contacts, or guardianship require verification through the
                  administrative office.
                </p>
              </div>
              <a href="/help" className="btn btn-outline btn-sm">
                Contact Administration
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Simulated Sandbox Payment Modal */}
      {showPaymentModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            className="anesa-card"
            style={{
              width: '100%',
              maxWidth: '460px',
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              overflow: 'hidden',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
            }}
          >
            <div
              className="anesa-card-header"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
            >
              <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
                {paymentSuccess ? 'Payment Successful' : 'Secure Fee Payment'}
              </h2>
              {!paymentProcessing && (
                <button
                  type="button"
                  onClick={() => setShowPaymentModal(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '1.25rem',
                    cursor: 'pointer',
                    color: 'var(--color-fg-muted)',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            <div className="anesa-card-body">
              {paymentSuccess ? (
                <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
                  <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✅</div>
                  <h4 style={{ margin: '0 0 0.5rem 0', color: 'var(--color-success, #2da44e)' }}>
                    Payment Simulation Confirmed
                  </h4>
                  <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-fg-muted)' }}>
                    Test transaction logged. No real financial account was charged.
                  </p>
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      backgroundColor: '#F3EEFB',
                      color: 'var(--brand-primary, #504175)',
                      marginBottom: '1.25rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span>Total Amount Payable:</span>
                    <strong style={{ fontSize: '1.25rem' }}>
                      {formatCurrency(
                        fees?.summary.totalOutstanding ?? summary?.fees.totalOutstanding ?? 0,
                      )}
                    </strong>
                  </div>

                  <p
                    style={{
                      fontSize: '0.8125rem',
                      color: 'var(--color-fg-muted)',
                      marginBottom: '1.25rem',
                    }}
                  >
                    Select simulated payment gateway:
                  </p>

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.75rem',
                      marginBottom: '1.5rem',
                    }}
                  >
                    <label
                      htmlFor="payment-method-upi"
                      aria-label="UPI / QR Code"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.75rem',
                        border: '1px solid #E5E7EB',
                        borderRadius: '6px',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        id="payment-method-upi"
                        type="radio"
                        name="payment-method"
                        defaultChecked
                      />
                      <div>
                        <strong>UPI / QR Code</strong>
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.75rem',
                            color: 'var(--color-fg-muted)',
                          }}
                        >
                          Google Pay, PhonePe, Paytm
                        </span>
                      </div>
                    </label>
                    <label
                      htmlFor="payment-method-card"
                      aria-label="Net Banking / Debit Card"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.75rem',
                        border: '1px solid #E5E7EB',
                        borderRadius: '6px',
                        cursor: 'pointer',
                      }}
                    >
                      <input id="payment-method-card" type="radio" name="payment-method" />
                      <div>
                        <strong>Net Banking / Debit Card</strong>
                        <span
                          style={{
                            display: 'block',
                            fontSize: '0.75rem',
                            color: 'var(--color-fg-muted)',
                          }}
                        >
                          All Major Indian Scheduled Banks
                        </span>
                      </div>
                    </label>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setShowPaymentModal(false)}
                      disabled={paymentProcessing}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSimulatePayment}
                      disabled={paymentProcessing}
                    >
                      {paymentProcessing ? 'Processing...' : 'Simulate Payment'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
