import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError } from '../lib/api/errors';
import { attendanceErrorMessage } from '../lib/attendance-errors';
import {
  calendarDaysBetween,
  formatLocalTime,
  localToInstant,
  todayInZone,
} from '../lib/campus-time';
import {
  ATTENDANCE_STATUSES,
  CORRECTION_REASONS,
  cancelSession,
  correctRecord,
  createSession,
  decideCorrectionRequest,
  fetchCampusClocks,
  fetchCorrectionRequests,
  fetchMyOfferings,
  fetchRecordRevisions,
  fetchSession,
  fetchSessionRecords,
  fetchSessionRoster,
  fetchSessions,
  lockSession,
  requestCorrection,
  submitAttendance,
  type AttendanceStatus,
  type CampusClock,
  type CorrectionReason,
  type CorrectionRequestDto,
  type MyOfferingItem,
  type RecordDto,
  type RevisionDto,
  type SessionDto,
  type SessionKind,
  type SessionRosterItem,
} from '../lib/api/attendance-api';

function randomIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `k-${crypto.randomUUID()}`;
  }
  return `k-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function formatDate(isoDate: string): string {
  return isoDate;
}

/** Time of day on the CAMPUS wall clock (doc 49 ATT-1). Without a campus zone (an older server) the device zone is used. */
function formatTime(isoInstant: string, timeZone?: string): string {
  try {
    if (timeZone) return formatLocalTime(isoInstant, timeZone);
    const d = new Date(isoInstant);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoInstant;
  }
}

/**
 * Is the session inside the faculty correction window? The server's own answer (`insideCorrectionWindow`, campus calendar and
 * policy) is used whenever it is present. Only for an older server without it, the campus date (or, failing that, UTC) is
 * used for a best-effort display; the server decides every correction either way (doc 49 ATT-2).
 */
function sessionInsideWindow(s: SessionDto): boolean {
  if (s.insideCorrectionWindow !== undefined) return s.insideCorrectionWindow;
  const today =
    s.campusToday ?? (s.campusTimezone ? todayInZone(s.campusTimezone) : todayInZone('UTC'));
  return calendarDaysBetween(s.sessionDate, today) <= (s.correctionWindowDays ?? 3);
}

export function AttendancePage() {
  usePageTitle('Attendance');
  const { identity, client } = useAuth();

  const canMark = identity ? can(identity, 'attendance.session.mark') : false;
  const canRead = identity ? can(identity, 'attendance.record.read') : false;
  const canApprove = identity ? can(identity, 'attendance.correction.approve') : false;
  const canLock = identity ? can(identity, 'attendance.session.lock') : false;

  type Tab = 'marking' | 'approvals' | 'registers';
  const [tab, setTab] = useState<Tab>('marking');

  // Teacher marking state
  const [offerings, setOfferings] = useState<MyOfferingItem[]>([]);
  const [selectedOfferingId, setSelectedOfferingId] = useState<string>('');
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [loadingOfferings, setLoadingOfferings] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Active session for marking or inspecting
  const [activeSession, setActiveSession] = useState<SessionDto | null>(null);
  const [roster, setRoster] = useState<SessionRosterItem[]>([]);
  const [marks, setMarks] = useState<Record<string, { status: AttendanceStatus; remarks: string }>>(
    {},
  );
  const [records, setRecords] = useState<RecordDto[]>([]);
  const [loadingSessionDetails, setLoadingSessionDetails] = useState(false);
  const [submittingAttendance, setSubmittingAttendance] = useState(false);

  // Create session modal
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionDate, setNewSessionDate] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [newSessionStartTime, setNewSessionStartTime] = useState('09:00');
  const [newSessionEndTime, setNewSessionEndTime] = useState('10:00');
  const [newSessionKind, setNewSessionKind] = useState<SessionKind>('REGULAR');
  const [newSessionTopic, setNewSessionTopic] = useState('');
  const [creatingSession, setCreatingSession] = useState(false);

  // Revisions modal
  const [selectedRecordRevisions, setSelectedRecordRevisions] = useState<{
    recordId: string;
    studentName: string;
    revisions: RevisionDto[];
  } | null>(null);
  const [loadingRevisions, setLoadingRevisions] = useState(false);

  // Correction modal
  const [correctionTarget, setCorrectionTarget] = useState<{
    record: RecordDto;
    studentName: string;
    sessionDate: string;
    isInsideWindow: boolean;
  } | null>(null);
  const [proposedStatus, setProposedStatus] = useState<AttendanceStatus>('PRESENT');
  const [correctionReasonCode, setCorrectionReasonCode] =
    useState<CorrectionReason>('FACULTY_ERROR');
  const [correctionReasonText, setCorrectionReasonText] = useState('');
  const [submittingCorrection, setSubmittingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);

  // Approvals state
  const [pendingRequests, setPendingRequests] = useState<CorrectionRequestDto[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rejectingRequest, setRejectingRequest] = useState<CorrectionRequestDto | null>(null);
  const [rejectNote, setRejectNote] = useState('');

  // Daily registers state
  // Defaults come from the campus clock the server reports, never from the browser's or UTC's date (doc 49 ATT-1).
  const [registerDate, setRegisterDate] = useState('');
  const [campusClocks, setCampusClocks] = useState<CampusClock[]>([]);
  const [registerCampusId, setRegisterCampusId] = useState('');
  const [clocksSettled, setClocksSettled] = useState(false);
  const [registerSessions, setRegisterSessions] = useState<SessionDto[]>([]);
  const [loadingRegisters, setLoadingRegisters] = useState(false);

  // Cancel & Lock modals
  const [cancellingSession, setCancellingSession] = useState<SessionDto | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [submittingCancel, setSubmittingCancel] = useState(false);
  const [lockingSessionTarget, setLockingSessionTarget] = useState<SessionDto | null>(null);
  const [lockReason, setLockReason] = useState('');
  const [submittingLock, setSubmittingLock] = useState(false);

  // Initial load: Offerings
  useEffect(() => {
    let active = true;
    if (canMark) {
      setLoadingOfferings(true);
      fetchMyOfferings(client)
        .then((items) => {
          if (!active) return;
          setOfferings(items);
          if (items.length > 0) {
            setSelectedOfferingId((prev) => prev || items[0]!.id);
          }
        })
        .catch((err) => {
          if (!active) return;
          setPageError(isApiError(err) ? err.message : 'Failed to load assigned offerings.');
        })
        .finally(() => {
          if (active) setLoadingOfferings(false);
        });
    }
    return () => {
      active = false;
    };
  }, [client, canMark]);

  // Load sessions when offering changes
  useEffect(() => {
    let active = true;
    if (selectedOfferingId && canRead) {
      setLoadingSessions(true);
      fetchSessions(client, { courseOfferingId: selectedOfferingId })
        .then((data) => {
          if (active) setSessions(data);
        })
        .catch((err) => {
          if (active) setPageError(isApiError(err) ? err.message : 'Failed to load sessions.');
        })
        .finally(() => {
          if (active) setLoadingSessions(false);
        });
    }
    return () => {
      active = false;
    };
  }, [client, selectedOfferingId, canRead]);

  // Load approvals when tab active
  useEffect(() => {
    let active = true;
    if (tab === 'approvals' && canApprove) {
      setLoadingApprovals(true);
      fetchCorrectionRequests(client, 'PENDING')
        .then((data) => {
          if (active) setPendingRequests(data);
        })
        .catch((err) => {
          if (active) {
            setPageError(
              attendanceErrorMessage(err, 'Failed to load pending correction requests.'),
            );
          }
        })
        .finally(() => {
          if (active) setLoadingApprovals(false);
        });
    }
    return () => {
      active = false;
    };
  }, [client, tab, canApprove]);

  // Campus clocks for the register's default date (institutional readers; assigned faculty use their offerings' clock).
  useEffect(() => {
    let active = true;
    if (canRead) {
      fetchCampusClocks(client)
        .then((items) => {
          if (!active) return;
          setCampusClocks(items);
          setRegisterCampusId((prev) => prev || items[0]?.id || '');
        })
        .catch(() => {
          if (active) setCampusClocks([]);
        })
        .finally(() => {
          if (active) setClocksSettled(true);
        });
    } else {
      setClocksSettled(true);
    }
    return () => {
      active = false;
    };
  }, [client, canRead]);

  /** Today on the campus the register is showing: its server clock, else the first offering's, else the device date. */
  const registerToday = (): string => {
    const clock = campusClocks.find((c) => c.id === registerCampusId) ?? campusClocks[0];
    if (clock) return clock.today;
    const off = offerings.find((o) => o.campusToday);
    if (off?.campusToday) return off.campusToday;
    return new Date().toLocaleDateString('en-CA');
  };
  useEffect(() => {
    // Wait until the campus clocks have been asked for, so the default is the campus date and not a device guess.
    if (registerDate === '' && clocksSettled && !loadingOfferings) {
      setRegisterDate(registerToday());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusClocks, offerings, registerDate, clocksSettled, loadingOfferings]);

  // Load daily registers when tab active
  useEffect(() => {
    let active = true;
    if (tab === 'registers' && canRead && registerDate !== '') {
      setLoadingRegisters(true);
      fetchSessions(client, { sessionDate: registerDate })
        .then((data) => {
          if (active) setRegisterSessions(data);
        })
        .catch((err) => {
          if (active)
            setPageError(isApiError(err) ? err.message : 'Failed to load daily register.');
        })
        .finally(() => {
          if (active) setLoadingRegisters(false);
        });
    }
    return () => {
      active = false;
    };
  }, [client, tab, registerDate, canRead]);

  // Open session details: Roster if NOT_STARTED or Records if SUBMITTED
  async function openSession(session: SessionDto) {
    setActiveSession(session);
    setLoadingSessionDetails(true);
    setPageError(null);
    setNotice(null);
    try {
      if (session.attendanceState === 'NOT_STARTED' || session.attendanceState === 'OPEN') {
        const studentRoster = await fetchSessionRoster(client, session.id);
        setRoster(studentRoster);
        // Default mark: PRESENT for quick flow
        const initial: Record<string, { status: AttendanceStatus; remarks: string }> = {};
        for (const s of studentRoster) {
          initial[s.studentId] = { status: 'PRESENT', remarks: '' };
        }
        setMarks(initial);
      } else {
        const [recs, studentRoster] = await Promise.all([
          fetchSessionRecords(client, session.id),
          fetchSessionRoster(client, session.id).catch(() => []),
        ]);
        setRecords(recs);
        setRoster(studentRoster);
      }
    } catch (err) {
      setPageError(isApiError(err) ? err.message : 'Failed to load session details.');
    } finally {
      setLoadingSessionDetails(false);
    }
  }

  // Handle Mark All
  function handleMarkAll(status: AttendanceStatus) {
    setMarks((prev) => {
      const next = { ...prev };
      for (const s of roster) {
        next[s.studentId] = { status, remarks: next[s.studentId]?.remarks ?? '' };
      }
      return next;
    });
  }

  // Handle Submit Attendance
  async function handleSubmitAttendance() {
    if (!activeSession) return;
    setSubmittingAttendance(true);
    setPageError(null);
    try {
      const recordPayload = roster.map((s) => ({
        studentId: s.studentId,
        status: marks[s.studentId]?.status ?? 'PRESENT',
        remarks: marks[s.studentId]?.remarks?.trim() || undefined,
      }));

      const key = randomIdempotencyKey();
      await submitAttendance(client, activeSession.id, { records: recordPayload }, key);

      setNotice('Attendance submitted successfully.');
      // Refresh session data
      const updated = await fetchSession(client, activeSession.id);
      setActiveSession(updated);
      const recs = await fetchSessionRecords(client, activeSession.id);
      setRecords(recs);

      // Refresh session in list
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      setPageError(attendanceErrorMessage(err, 'Failed to submit attendance.'));
    } finally {
      setSubmittingAttendance(false);
    }
  }

  // Open the scheduling form with the CAMPUS-local date as the default (never the UTC date).
  function openCreateModal() {
    const off = offerings.find((o) => o.id === selectedOfferingId);
    setCreateError(null);
    setNewSessionDate(
      off?.campusToday ??
        (off?.campusTimezone
          ? todayInZone(off.campusTimezone)
          : new Date().toLocaleDateString('en-CA')),
    );
    setShowCreateModal(true);
  }

  // Handle Create Session
  async function handleCreateSession(e: FormEvent) {
    e.preventDefault();
    if (!selectedOfferingId) return;
    setCreateError(null);
    const zone = offerings.find((o) => o.id === selectedOfferingId)?.campusTimezone;
    if (!zone) {
      setCreateError(
        'The campus time zone is not available, so the session time cannot be set. Reload the page.',
      );
      return;
    }
    // Entered times are CAMPUS wall-clock times (doc 49 ATT-1); the API stores UTC instants.
    const start = localToInstant(newSessionDate, newSessionStartTime, zone);
    const end = localToInstant(newSessionDate, newSessionEndTime, zone);
    const bad = [start, end].find((r) => !r.ok);
    if (bad && !bad.ok) {
      setCreateError(
        bad.reason === 'NONEXISTENT'
          ? 'That time does not exist on the campus clock on this date (clocks move forward). Choose a different time.'
          : bad.reason === 'AMBIGUOUS'
            ? 'That time occurs twice on the campus clock on this date (clocks move back). Choose a different time.'
            : 'Enter a valid date and time.',
      );
      return;
    }
    if (!start.ok || !end.ok) return;
    if (newSessionEndTime <= newSessionStartTime) {
      setCreateError(
        'The end time must be after the start time on the same day. A class cannot cross midnight; schedule two sessions instead.',
      );
      return;
    }
    setCreatingSession(true);
    setPageError(null);
    try {
      const startsAt = start.iso;
      const endsAt = end.iso;

      const key = randomIdempotencyKey();
      const created = await createSession(
        client,
        {
          courseOfferingId: selectedOfferingId,
          sessionDate: newSessionDate,
          startsAt,
          endsAt,
          kind: newSessionKind,
          topic: newSessionTopic.trim() || undefined,
        },
        key,
      );

      setShowCreateModal(false);
      setNotice('Class session created.');

      // Reload sessions
      const updatedSessions = await fetchSessions(client, { courseOfferingId: selectedOfferingId });
      setSessions(updatedSessions);

      const found = updatedSessions.find((s) => s.id === created.id);
      if (found) {
        await openSession(found);
      }
    } catch (err) {
      setCreateError(attendanceErrorMessage(err, 'Failed to create session.'));
    } finally {
      setCreatingSession(false);
    }
  }

  // View Record Revisions History
  async function openRevisions(rec: RecordDto, studentName: string) {
    setLoadingRevisions(true);
    try {
      const revs = await fetchRecordRevisions(client, rec.id);
      setSelectedRecordRevisions({ recordId: rec.id, studentName, revisions: revs });
    } catch (err) {
      setPageError(isApiError(err) ? err.message : 'Failed to load revisions.');
    } finally {
      setLoadingRevisions(false);
    }
  }

  // Open Correction Dialog
  function openCorrection(rec: RecordDto, studentName: string) {
    if (!activeSession) return;
    const inside = sessionInsideWindow(activeSession);
    setCorrectionTarget({
      record: rec,
      studentName,
      sessionDate: activeSession.sessionDate,
      isInsideWindow: inside,
    });
    setProposedStatus(rec.status === 'PRESENT' ? 'ABSENT' : 'PRESENT');
    setCorrectionReasonCode('FACULTY_ERROR');
    setCorrectionReasonText('');
    setCorrectionError(null);
  }

  // Submit Correction or Correction Request
  async function handleCorrectionSubmit(e: FormEvent) {
    e.preventDefault();
    if (!correctionTarget || !activeSession) return;
    setSubmittingCorrection(true);
    setCorrectionError(null);
    try {
      const key = randomIdempotencyKey();
      if (correctionTarget.isInsideWindow) {
        // Direct correction
        await correctRecord(
          client,
          correctionTarget.record.id,
          {
            status: proposedStatus,
            expectedRevisionNo: correctionTarget.record.revisionNo,
            reasonCode: correctionReasonCode,
            reasonText:
              correctionReasonCode === 'OTHER' || correctionReasonText
                ? correctionReasonText.trim()
                : undefined,
          },
          key,
        );
        setNotice(`Attendance record for ${correctionTarget.studentName} corrected directly.`);
      } else {
        // Request correction outside window
        await requestCorrection(
          client,
          correctionTarget.record.id,
          {
            status: proposedStatus,
            expectedRevisionNo: correctionTarget.record.revisionNo,
            reasonCode: correctionReasonCode,
            reasonText:
              correctionReasonCode === 'OTHER' || correctionReasonText
                ? correctionReasonText.trim()
                : undefined,
          },
          key,
        );
        setNotice(
          `Correction request submitted for independent approval (outside 3-day policy window).`,
        );
      }
      setCorrectionTarget(null);
      // Reload session records
      const updatedRecs = await fetchSessionRecords(client, activeSession.id);
      setRecords(updatedRecs);
    } catch (err) {
      setCorrectionError(
        attendanceErrorMessage(err, 'Failed to process correction. Please try again.'),
      );
    } finally {
      setSubmittingCorrection(false);
    }
  }

  // Handle Decision (Approve / Reject)
  async function handleDecision(
    req: CorrectionRequestDto,
    decision: 'approve' | 'reject',
    note?: string,
  ) {
    setDecidingId(req.id);
    setPageError(null);
    try {
      const key = randomIdempotencyKey();
      await decideCorrectionRequest(client, req.id, decision, { note }, key);
      setNotice(`Correction request ${decision === 'approve' ? 'approved' : 'rejected'}.`);
      setRejectingRequest(null);
      setRejectNote('');
      // Reload requests
      const data = await fetchCorrectionRequests(client, 'PENDING');
      setPendingRequests(data);
    } catch (err) {
      if (isApiError(err) && err.status === 403 && err.code === 'FORBIDDEN') {
        setPageError(
          'You cannot decide your own request, or you do not have permission to decide requests.',
        );
      } else {
        setPageError(attendanceErrorMessage(err, `Failed to ${decision} request.`));
      }
    } finally {
      setDecidingId(null);
    }
  }

  // Handle Cancel Session
  async function handleCancelSession(e: FormEvent) {
    e.preventDefault();
    if (!cancellingSession) return;
    setSubmittingCancel(true);
    setPageError(null);
    try {
      const key = randomIdempotencyKey();
      const cancelled = await cancelSession(
        client,
        cancellingSession.id,
        { reason: cancelReason },
        key,
      );
      setCancellingSession(null);
      setCancelReason('');
      setNotice('Session cancelled.');
      if (activeSession?.id === cancelled.id) {
        setActiveSession(cancelled);
      }
      setSessions((prev) => prev.map((s) => (s.id === cancelled.id ? cancelled : s)));
    } catch (err) {
      setPageError(attendanceErrorMessage(err, 'Failed to cancel session.'));
    } finally {
      setSubmittingCancel(false);
    }
  }

  // Handle Lock Session
  async function handleLockSession(e: FormEvent) {
    e.preventDefault();
    if (!lockingSessionTarget) return;
    setSubmittingLock(true);
    setPageError(null);
    try {
      const key = randomIdempotencyKey();
      const locked = await lockSession(
        client,
        lockingSessionTarget.id,
        { reason: lockReason },
        key,
      );
      setLockingSessionTarget(null);
      setLockReason('');
      setNotice('Session locked against further modifications.');
      if (activeSession?.id === locked.id) {
        setActiveSession(locked);
      }
      setSessions((prev) => prev.map((s) => (s.id === locked.id ? locked : s)));
      if (tab === 'registers') {
        setRegisterSessions((prev) => prev.map((s) => (s.id === locked.id ? locked : s)));
      }
    } catch (err) {
      setPageError(attendanceErrorMessage(err, 'Failed to lock session.'));
    } finally {
      setSubmittingLock(false);
    }
  }

  // Calculate live summary stats for marking
  const totalCount = roster.length;
  const presentCount = Object.values(marks).filter((m) => m.status === 'PRESENT').length;
  const absentCount = Object.values(marks).filter((m) => m.status === 'ABSENT').length;
  const lateCount = Object.values(marks).filter((m) => m.status === 'LATE').length;
  const excusedCount = Object.values(marks).filter((m) => m.status === 'EXCUSED').length;

  return (
    <div className="attendance-page" style={{ padding: 'var(--space-4) 0' }}>
      <PageHeader
        title="Attendance"
        subtitle="Record class attendance, manage correction requests, and inspect institutional attendance registers."
      />

      {pageError && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert tone="error">{pageError}</Alert>
        </div>
      )}
      {notice && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      {/* Navigation Tabs */}
      <div
        role="tablist"
        aria-label="Attendance navigation"
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          borderBottom: '1px solid var(--color-border)',
          marginBottom: 'var(--space-5)',
        }}
      >
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'marking'}
          onClick={() => {
            setTab('marking');
            setActiveSession(null);
          }}
          className={`tab-btn ${tab === 'marking' ? 'tab-btn-active' : ''}`}
          style={{
            padding: 'var(--space-3) var(--space-4)',
            background: 'none',
            border: 'none',
            borderBottom:
              tab === 'marking' ? '2px solid var(--color-primary)' : '2px solid transparent',
            fontWeight: tab === 'marking' ? 600 : 400,
            color: tab === 'marking' ? 'var(--color-primary)' : 'var(--color-muted)',
            cursor: 'pointer',
          }}
        >
          Teacher Marking &amp; Classes
        </button>

        {canApprove && (
          <button
            role="tab"
            type="button"
            aria-selected={tab === 'approvals'}
            onClick={() => {
              setTab('approvals');
              setActiveSession(null);
            }}
            className={`tab-btn ${tab === 'approvals' ? 'tab-btn-active' : ''}`}
            style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'none',
              border: 'none',
              borderBottom:
                tab === 'approvals' ? '2px solid var(--color-primary)' : '2px solid transparent',
              fontWeight: tab === 'approvals' ? 600 : 400,
              color: tab === 'approvals' ? 'var(--color-primary)' : 'var(--color-muted)',
              cursor: 'pointer',
            }}
          >
            Approvals Inbox{' '}
            {pendingRequests.length > 0 && (
              <span
                style={{
                  background: 'var(--color-danger)',
                  color: '#fff',
                  borderRadius: 'var(--radius-pill)',
                  padding: '2px 8px',
                  fontSize: '0.75rem',
                  marginLeft: 'var(--space-1)',
                }}
              >
                {pendingRequests.length}
              </span>
            )}
          </button>
        )}

        {canRead && (
          <button
            role="tab"
            type="button"
            aria-selected={tab === 'registers'}
            onClick={() => {
              setTab('registers');
              setActiveSession(null);
            }}
            className={`tab-btn ${tab === 'registers' ? 'tab-btn-active' : ''}`}
            style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'none',
              border: 'none',
              borderBottom:
                tab === 'registers' ? '2px solid var(--color-primary)' : '2px solid transparent',
              fontWeight: tab === 'registers' ? 600 : 400,
              color: tab === 'registers' ? 'var(--color-primary)' : 'var(--color-muted)',
              cursor: 'pointer',
            }}
          >
            School Registers &amp; Daily Log
          </button>
        )}
      </div>

      {/* TAB 1: TEACHER MARKING & SESSIONS */}
      {tab === 'marking' && (
        <div>
          {!activeSession ? (
            <div>
              {/* Offering selector */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-4)',
                  marginBottom: 'var(--space-4)',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                  <label htmlFor="offering-select" style={{ fontWeight: 500, fontSize: '0.9rem' }}>
                    Select Course / Class:
                  </label>
                  {loadingOfferings ? (
                    <Spinner label="Loading offerings" />
                  ) : offerings.length > 0 ? (
                    <select
                      id="offering-select"
                      value={selectedOfferingId}
                      onChange={(e) => setSelectedOfferingId(e.target.value)}
                      style={{
                        padding: 'var(--space-2) var(--space-3)',
                        borderRadius: 'var(--radius)',
                        border: '1px solid var(--color-border)',
                        backgroundColor: 'var(--color-surface)',
                      }}
                    >
                      {offerings.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.codeSnapshot} — {o.titleSnapshot}{' '}
                          {o.groupLabel ? `(${o.groupLabel})` : ''} ({o.termName})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span style={{ color: 'var(--color-muted)' }}>
                      No assigned offerings found for this account.
                    </span>
                  )}
                </div>

                {canMark && selectedOfferingId && (
                  <Button variant="primary" onClick={openCreateModal}>
                    + Schedule New Session
                  </Button>
                )}
              </div>

              {/* Sessions Table */}
              <Card title="Class Sessions">
                {loadingSessions ? (
                  <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
                    <Spinner label="Loading class sessions" />
                  </div>
                ) : sessions.length === 0 ? (
                  <div
                    style={{
                      padding: 'var(--space-5)',
                      textAlign: 'center',
                      color: 'var(--color-muted)',
                    }}
                  >
                    No sessions scheduled or conducted for this offering yet.
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table" aria-label="Class sessions list">
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col">Time</th>
                          <th scope="col">Kind</th>
                          <th scope="col">Topic</th>
                          <th scope="col">Status</th>
                          <th scope="col">Attendance</th>
                          <th scope="col">Attendance Counts</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessions.map((s) => (
                          <tr key={s.id}>
                            <td>{formatDate(s.sessionDate)}</td>
                            <td>
                              {formatTime(s.startsAt, s.campusTimezone)} –{' '}
                              {formatTime(s.endsAt, s.campusTimezone)}
                            </td>
                            <td>
                              <Badge>{s.kind}</Badge>
                            </td>
                            <td>
                              {s.topic || <span style={{ color: 'var(--color-muted)' }}>—</span>}
                            </td>
                            <td>
                              <StatusBadge status={s.status} />
                            </td>
                            <td>
                              <span
                                style={{
                                  display: 'inline-block',
                                  padding: '2px 8px',
                                  borderRadius: 'var(--radius-pill)',
                                  fontSize: '0.8rem',
                                  fontWeight: 500,
                                  backgroundColor:
                                    s.attendanceState === 'SUBMITTED'
                                      ? 'var(--color-emerald-soft)'
                                      : s.attendanceState === 'LOCKED'
                                        ? 'var(--color-primary-soft)'
                                        : 'var(--color-amber-soft)',
                                  color:
                                    s.attendanceState === 'SUBMITTED'
                                      ? 'var(--color-emerald-ink)'
                                      : s.attendanceState === 'LOCKED'
                                        ? 'var(--color-primary-ink)'
                                        : 'var(--color-amber-ink)',
                                }}
                              >
                                {s.attendanceState}
                              </span>
                            </td>
                            <td>
                              {s.counts ? (
                                <span style={{ fontSize: '0.85rem' }}>
                                  P: {s.counts.present} / A: {s.counts.absent} / Total:{' '}
                                  {s.counts.total}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--color-muted)' }}>—</span>
                              )}
                            </td>
                            <td>
                              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                                {s.attendanceState === 'NOT_STARTED' ||
                                s.attendanceState === 'OPEN' ? (
                                  <Button variant="primary" onClick={() => void openSession(s)}>
                                    Mark
                                  </Button>
                                ) : (
                                  <Button variant="secondary" onClick={() => void openSession(s)}>
                                    View Register
                                  </Button>
                                )}
                                {s.status === 'SCHEDULED' &&
                                  s.attendanceState === 'NOT_STARTED' && (
                                    <Button variant="ghost" onClick={() => setCancellingSession(s)}>
                                      Cancel
                                    </Button>
                                  )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          ) : (
            /* ACTIVE SESSION VIEW (Marking Sheet or Submitted Register) */
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  marginBottom: 'var(--space-4)',
                }}
              >
                <Button variant="ghost" onClick={() => setActiveSession(null)}>
                  &larr; Back to Sessions
                </Button>
                <div style={{ flex: 1 }}>
                  <h2 style={{ margin: 0, fontSize: '1.25rem' }}>
                    {activeSession.courseCode ? `${activeSession.courseCode} — ` : ''}
                    {formatDate(activeSession.sessionDate)} (
                    {formatTime(activeSession.startsAt, activeSession.campusTimezone)} –{' '}
                    {formatTime(activeSession.endsAt, activeSession.campusTimezone)}{' '}
                    {activeSession.campusTimezone ?? ''})
                  </h2>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                    Kind: {activeSession.kind} | State:{' '}
                    <strong style={{ color: 'var(--color-text)' }}>
                      {activeSession.attendanceState}
                    </strong>
                    {activeSession.attendanceState === 'LOCKED' &&
                      ' (Locked per institutional policy)'}
                  </span>
                </div>
              </div>

              {loadingSessionDetails ? (
                <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
                  <Spinner label="Loading session records" />
                </div>
              ) : activeSession.attendanceState === 'NOT_STARTED' ||
                activeSession.attendanceState === 'OPEN' ? (
                /* MARKING SHEET */
                <Card title="Interactive Attendance Marking Sheet">
                  {/* Summary Bar */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 'var(--space-4)',
                      padding: 'var(--space-3) var(--space-4)',
                      backgroundColor: 'var(--color-bg)',
                      borderRadius: 'var(--radius)',
                      marginBottom: 'var(--space-4)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>Total: {totalCount}</span>
                      <span style={{ color: 'var(--color-emerald-ink)', fontWeight: 500 }}>
                        Present: {presentCount}
                      </span>
                      <span style={{ color: 'var(--color-danger)', fontWeight: 500 }}>
                        Absent: {absentCount}
                      </span>
                      <span style={{ color: 'var(--color-amber-ink)', fontWeight: 500 }}>
                        Late: {lateCount}
                      </span>
                      <span style={{ color: 'var(--color-purple-ink)', fontWeight: 500 }}>
                        Excused: {excusedCount}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      <Button variant="secondary" onClick={() => handleMarkAll('PRESENT')}>
                        Mark All Present
                      </Button>
                      <Button variant="ghost" onClick={() => handleMarkAll('ABSENT')}>
                        Mark All Absent
                      </Button>
                    </div>
                  </div>

                  {/* Marking Table */}
                  <div style={{ overflowX: 'auto', marginBottom: 'var(--space-5)' }}>
                    <table className="data-table" aria-label="Student attendance marking sheet">
                      <thead>
                        <tr>
                          <th scope="col" style={{ width: '8%' }}>
                            Roll No
                          </th>
                          <th scope="col" style={{ width: '15%' }}>
                            Admission No
                          </th>
                          <th scope="col" style={{ width: '25%' }}>
                            Student Name
                          </th>
                          <th scope="col" style={{ width: '30%' }}>
                            Status
                          </th>
                          <th scope="col" style={{ width: '22%' }}>
                            Remarks
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster.map((s) => {
                          const currentMark = marks[s.studentId]?.status ?? 'PRESENT';
                          const currentRemarks = marks[s.studentId]?.remarks ?? '';
                          return (
                            <tr key={s.studentId}>
                              <td>{s.rollNumber || '—'}</td>
                              <td>{s.admissionNumber}</td>
                              <td style={{ fontWeight: 500 }}>{s.displayName}</td>
                              <td>
                                <div
                                  role="radiogroup"
                                  aria-label={`Attendance for ${s.displayName}`}
                                  style={{
                                    display: 'inline-flex',
                                    gap: '2px',
                                    background: 'var(--color-border)',
                                    padding: '2px',
                                    borderRadius: 'var(--radius)',
                                  }}
                                >
                                  {ATTENDANCE_STATUSES.map((status) => {
                                    const selected = currentMark === status;
                                    let activeBg = 'var(--color-surface)';
                                    let activeColor = 'var(--color-text)';
                                    if (selected) {
                                      if (status === 'PRESENT') {
                                        activeBg = 'var(--color-emerald)';
                                        activeColor = '#fff';
                                      } else if (status === 'ABSENT') {
                                        activeBg = 'var(--color-danger)';
                                        activeColor = '#fff';
                                      } else if (status === 'LATE') {
                                        activeBg = 'var(--color-amber)';
                                        activeColor = '#fff';
                                      } else if (status === 'EXCUSED') {
                                        activeBg = 'var(--color-purple)';
                                        activeColor = '#fff';
                                      }
                                    }
                                    return (
                                      <button
                                        key={status}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        onClick={() =>
                                          setMarks((prev) => ({
                                            ...prev,
                                            [s.studentId]: {
                                              status,
                                              remarks: prev[s.studentId]?.remarks ?? '',
                                            },
                                          }))
                                        }
                                        style={{
                                          border: 'none',
                                          padding: '4px 8px',
                                          fontSize: '0.75rem',
                                          fontWeight: selected ? 600 : 400,
                                          borderRadius: 'var(--radius-sm)',
                                          cursor: 'pointer',
                                          background: activeBg,
                                          color: activeColor,
                                        }}
                                      >
                                        {status}
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                              <td>
                                <input
                                  type="text"
                                  placeholder="Optional remarks..."
                                  value={currentRemarks}
                                  onChange={(e) =>
                                    setMarks((prev) => ({
                                      ...prev,
                                      [s.studentId]: {
                                        status: prev[s.studentId]?.status ?? 'PRESENT',
                                        remarks: e.target.value,
                                      },
                                    }))
                                  }
                                  style={{
                                    width: '100%',
                                    padding: '4px 8px',
                                    fontSize: '0.85rem',
                                    border: '1px solid var(--color-border)',
                                    borderRadius: 'var(--radius)',
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Submission Footer */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      borderTop: '1px solid var(--color-border)',
                      paddingTop: 'var(--space-4)',
                    }}
                  >
                    <div style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                      Submitting creates revision 1 records for all registered students. Changes
                      after submission are tracked via revision audit.
                    </div>
                    <Button
                      variant="primary"
                      pending={submittingAttendance}
                      onClick={() => void handleSubmitAttendance()}
                    >
                      Submit Attendance ({presentCount}/{totalCount} Present)
                    </Button>
                  </div>
                </Card>
              ) : (
                /* SUBMITTED REGISTER VIEW */
                <Card title="Submitted Attendance Register">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 'var(--space-4)',
                      flexWrap: 'wrap',
                      gap: 'var(--space-3)',
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                        Submitted at:{' '}
                        {activeSession.attendanceSubmittedAt
                          ? formatTime(
                              activeSession.attendanceSubmittedAt,
                              activeSession.campusTimezone,
                            )
                          : '—'}
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                      {canLock && activeSession.attendanceState === 'SUBMITTED' && (
                        <Button
                          variant="secondary"
                          onClick={() => setLockingSessionTarget(activeSession)}
                        >
                          Lock Session
                        </Button>
                      )}
                    </div>
                  </div>

                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table" aria-label="Submitted attendance records">
                      <thead>
                        <tr>
                          <th scope="col">Roll No</th>
                          <th scope="col">Admission No</th>
                          <th scope="col">Student Name</th>
                          <th scope="col">Status</th>
                          <th scope="col">Rev</th>
                          <th scope="col">Source</th>
                          <th scope="col">Remarks</th>
                          <th scope="col">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r) => {
                          const studentInfo = roster.find((st) => st.studentId === r.studentId);
                          const studentName = studentInfo?.displayName ?? 'Student';
                          return (
                            <tr key={r.id}>
                              <td>{studentInfo?.rollNumber || '—'}</td>
                              <td>{studentInfo?.admissionNumber || '—'}</td>
                              <td style={{ fontWeight: 500 }}>{studentName}</td>
                              <td>
                                <span
                                  style={{
                                    display: 'inline-block',
                                    padding: '2px 8px',
                                    borderRadius: 'var(--radius-pill)',
                                    fontSize: '0.8rem',
                                    fontWeight: 600,
                                    backgroundColor:
                                      r.status === 'PRESENT'
                                        ? 'var(--color-emerald-soft)'
                                        : r.status === 'ABSENT'
                                          ? 'var(--color-coral-soft)'
                                          : r.status === 'LATE'
                                            ? 'var(--color-amber-soft)'
                                            : 'var(--color-purple-soft)',
                                    color:
                                      r.status === 'PRESENT'
                                        ? 'var(--color-emerald-ink)'
                                        : r.status === 'ABSENT'
                                          ? 'var(--color-coral-ink)'
                                          : r.status === 'LATE'
                                            ? 'var(--color-amber-ink)'
                                            : 'var(--color-purple-ink)',
                                  }}
                                >
                                  {r.status}
                                </span>
                              </td>
                              <td>r{r.revisionNo}</td>
                              <td>
                                <Badge>{r.source}</Badge>
                              </td>
                              <td>{r.remarks || '—'}</td>
                              <td>
                                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                                  <Button
                                    variant="ghost"
                                    onClick={() => void openRevisions(r, studentName)}
                                  >
                                    History
                                  </Button>
                                  {activeSession.attendanceState !== 'LOCKED' && (
                                    <Button
                                      variant="secondary"
                                      onClick={() => openCorrection(r, studentName)}
                                    >
                                      Correct
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: APPROVALS INBOX */}
      {tab === 'approvals' && (
        <Card title="Attendance Correction Approvals Inbox">
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <p style={{ margin: 0, color: 'var(--color-muted)', fontSize: '0.85rem' }}>
              Per Policy AD-4: corrections requested outside the 3-day window require independent
              institutional approval. Requesters cannot self-approve.
            </p>
          </div>

          {loadingApprovals ? (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
              <Spinner label="Loading pending approvals" />
            </div>
          ) : pendingRequests.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-5)',
                textAlign: 'center',
                color: 'var(--color-muted)',
              }}
            >
              No pending attendance correction requests.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" aria-label="Pending correction requests">
                <thead>
                  <tr>
                    <th scope="col">Requested At</th>
                    <th scope="col">Student ID</th>
                    <th scope="col">Change</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Note</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingRequests.map((req) => {
                    const isSelf = req.requestedByUserId === identity?.userId;
                    return (
                      <tr key={req.id}>
                        <td>{formatDate(req.requestedAt.slice(0, 10))}</td>
                        <td>{req.studentId.slice(0, 8)}...</td>
                        <td>
                          <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                            {req.statusBefore}
                          </span>
                          {' → '}
                          <span style={{ color: 'var(--color-emerald-ink)', fontWeight: 600 }}>
                            {req.requestedStatus}
                          </span>
                        </td>
                        <td>
                          <Badge>{req.reasonCode}</Badge>
                        </td>
                        <td>{req.reasonText || '—'}</td>
                        <td>
                          <Badge>{req.status}</Badge>
                        </td>
                        <td>
                          <div
                            style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                          >
                            <Button
                              variant="primary"
                              disabled={isSelf || decidingId === req.id}
                              pending={decidingId === req.id}
                              onClick={() => void handleDecision(req, 'approve')}
                              title={
                                isSelf ? 'Self-approval forbidden (AD-4)' : 'Approve correction'
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={decidingId === req.id}
                              onClick={() => {
                                setRejectingRequest(req);
                                setRejectNote('');
                              }}
                            >
                              Reject
                            </Button>
                            {isSelf && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--color-muted)' }}>
                                (Self-request)
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* TAB 3: SCHOOL REGISTERS & DAILY LOG */}
      {tab === 'registers' && (
        <Card title="Daily School Attendance Register">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 'var(--space-4)',
              flexWrap: 'wrap',
              gap: 'var(--space-3)',
            }}
          >
            <div>
              <p style={{ margin: 0, color: 'var(--color-muted)', fontSize: '0.85rem' }}>
                Aggregate session logs and student counts across classes for the selected date.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              {campusClocks.length > 1 && (
                <>
                  <label htmlFor="register-campus" style={{ fontWeight: 500, fontSize: '0.85rem' }}>
                    Campus:
                  </label>
                  <select
                    id="register-campus"
                    value={registerCampusId}
                    onChange={(e) => {
                      setRegisterCampusId(e.target.value);
                      const c = campusClocks.find((x) => x.id === e.target.value);
                      if (c) setRegisterDate(c.today);
                    }}
                  >
                    {campusClocks.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.timezone})
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label htmlFor="register-date" style={{ fontWeight: 500, fontSize: '0.85rem' }}>
                Date:
              </label>
              <input
                id="register-date"
                type="date"
                value={registerDate}
                onChange={(e) => setRegisterDate(e.target.value)}
                style={{
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--color-border)',
                }}
              />
              <Button variant="secondary" onClick={() => setRegisterDate(registerToday())}>
                Today
              </Button>
            </div>
          </div>

          {loadingRegisters ? (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
              <Spinner label="Loading daily register" />
            </div>
          ) : registerSessions.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-5)',
                textAlign: 'center',
                color: 'var(--color-muted)',
              }}
            >
              No class sessions recorded on {registerDate}.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" aria-label="Daily school attendance register table">
                <thead>
                  <tr>
                    <th scope="col">Course Code</th>
                    <th scope="col">Time</th>
                    <th scope="col">Topic</th>
                    <th scope="col">State</th>
                    <th scope="col">Present</th>
                    <th scope="col">Absent</th>
                    <th scope="col">Late</th>
                    <th scope="col">Excused</th>
                    <th scope="col">Total</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {registerSessions.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 600 }}>
                        {s.courseCode || s.courseOfferingId.slice(0, 8)}
                      </td>
                      <td>
                        {formatTime(s.startsAt, s.campusTimezone)} –{' '}
                        {formatTime(s.endsAt, s.campusTimezone)}
                      </td>
                      <td>{s.topic || '—'}</td>
                      <td>
                        <StatusBadge status={s.attendanceState} />
                      </td>
                      <td style={{ color: 'var(--color-emerald-ink)', fontWeight: 600 }}>
                        {s.counts?.present ?? 0}
                      </td>
                      <td style={{ color: 'var(--color-danger)', fontWeight: 600 }}>
                        {s.counts?.absent ?? 0}
                      </td>
                      <td style={{ color: 'var(--color-amber-ink)' }}>{s.counts?.late ?? 0}</td>
                      <td style={{ color: 'var(--color-purple-ink)' }}>{s.counts?.excused ?? 0}</td>
                      <td style={{ fontWeight: 600 }}>{s.counts?.total ?? 0}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setSelectedOfferingId(s.courseOfferingId);
                              setTab('marking');
                              void openSession(s);
                            }}
                          >
                            View
                          </Button>
                          {canLock && s.attendanceState === 'SUBMITTED' && (
                            <Button variant="ghost" onClick={() => setLockingSessionTarget(s)}>
                              Lock
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* CREATE SESSION MODAL */}
      {showCreateModal && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-session-title"
          >
            <h3 id="create-session-title" style={{ marginTop: 0 }}>
              Schedule Class Session
            </h3>
            <form onSubmit={(e) => void handleCreateSession(e)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                {createError ? <Alert tone="error">{createError}</Alert> : null}
                <p className="muted" style={{ margin: 0 }}>
                  Date and times are on the campus clock
                  {offerings.find((o) => o.id === selectedOfferingId)?.campusTimezone
                    ? ` (${offerings.find((o) => o.id === selectedOfferingId)?.campusTimezone})`
                    : ''}
                  .
                </p>
                <TextField
                  label="Session Date"
                  type="date"
                  value={newSessionDate}
                  onChange={(e) => setNewSessionDate(e.target.value)}
                  required
                />
                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <TextField
                    label="Start Time"
                    type="time"
                    value={newSessionStartTime}
                    onChange={(e) => setNewSessionStartTime(e.target.value)}
                    required
                  />
                  <TextField
                    label="End Time"
                    type="time"
                    value={newSessionEndTime}
                    onChange={(e) => setNewSessionEndTime(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="create-session-kind"
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      marginBottom: 'var(--space-1)',
                    }}
                  >
                    Session Kind
                  </label>
                  <select
                    id="create-session-kind"
                    value={newSessionKind}
                    onChange={(e) => setNewSessionKind(e.target.value as SessionKind)}
                    style={{
                      width: '100%',
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    <option value="REGULAR">REGULAR</option>
                    <option value="EXTRA">EXTRA</option>
                    <option value="MAKEUP">MAKEUP</option>
                  </select>
                </div>
                <TextField
                  label="Topic / Notes (Optional)"
                  placeholder="e.g. Chapter 4: Binary Trees"
                  value={newSessionTopic}
                  onChange={(e) => setNewSessionTopic(e.target.value)}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-5)',
                }}
              >
                <Button variant="ghost" onClick={() => setShowCreateModal(false)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" pending={creatingSession}>
                  Create Session
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CORRECTION MODAL */}
      {correctionTarget && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="correction-title"
          >
            <h3 id="correction-title" style={{ marginTop: 0 }}>
              {correctionTarget.isInsideWindow
                ? 'Correct Attendance Record'
                : 'Request Attendance Correction'}
            </h3>

            <div
              style={{
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius)',
                backgroundColor: correctionTarget.isInsideWindow
                  ? 'var(--color-primary-soft)'
                  : 'var(--color-amber-soft)',
                color: correctionTarget.isInsideWindow
                  ? 'var(--color-primary-ink)'
                  : 'var(--color-amber-ink)',
                fontSize: '0.85rem',
                marginBottom: 'var(--space-4)',
              }}
            >
              {correctionTarget.isInsideWindow ? (
                <span>
                  <strong>Within 3-Day Window:</strong> Direct correction is authorized for regular
                  assigned faculty and department administrators.
                </span>
              ) : (
                <span>
                  <strong>Outside 3-Day Window:</strong> Per policy AD-4, changes after 3 calendar
                  days require independent approval from an HOD or campus administrator.
                </span>
              )}
            </div>

            {correctionError && (
              <div style={{ marginBottom: 'var(--space-3)' }}>
                <Alert tone="error">{correctionError}</Alert>
              </div>
            )}

            <form onSubmit={(e) => void handleCorrectionSubmit(e)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                    Student:{' '}
                  </span>
                  <strong>{correctionTarget.studentName}</strong>
                </div>
                <div>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                    Current Status:{' '}
                  </span>
                  <Badge>{correctionTarget.record.status}</Badge> (Rev{' '}
                  {correctionTarget.record.revisionNo})
                </div>

                <div>
                  <label
                    htmlFor="correction-status"
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      marginBottom: 'var(--space-1)',
                    }}
                  >
                    Corrected / Proposed Status
                  </label>
                  <select
                    id="correction-status"
                    value={proposedStatus}
                    onChange={(e) => setProposedStatus(e.target.value as AttendanceStatus)}
                    style={{
                      width: '100%',
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    {ATTENDANCE_STATUSES.map((st) => (
                      <option key={st} value={st}>
                        {st}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="correction-reason-code"
                    style={{
                      display: 'block',
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      marginBottom: 'var(--space-1)',
                    }}
                  >
                    Reason Code
                  </label>
                  <select
                    id="correction-reason-code"
                    value={correctionReasonCode}
                    onChange={(e) => setCorrectionReasonCode(e.target.value as CorrectionReason)}
                    style={{
                      width: '100%',
                      padding: 'var(--space-2)',
                      borderRadius: 'var(--radius)',
                      border: '1px solid var(--color-border)',
                    }}
                  >
                    {CORRECTION_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <TextField
                  label={`Reason Explanation ${correctionReasonCode === 'OTHER' ? '(Required)' : '(Optional)'}`}
                  placeholder="Describe justification (min 5 characters)..."
                  value={correctionReasonText}
                  onChange={(e) => setCorrectionReasonText(e.target.value)}
                  required={correctionReasonCode === 'OTHER'}
                />
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-5)',
                }}
              >
                <Button variant="ghost" onClick={() => setCorrectionTarget(null)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" pending={submittingCorrection}>
                  {correctionTarget.isInsideWindow ? 'Apply Correction' : 'Submit Request'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* REVISIONS HISTORY MODAL */}
      {selectedRecordRevisions && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
          >
            <h3 id="history-title" style={{ marginTop: 0 }}>
              Attendance Revision History — {selectedRecordRevisions.studentName}
            </h3>

            {loadingRevisions ? (
              <div style={{ padding: 'var(--space-4)', textAlign: 'center' }}>
                <Spinner label="Loading revisions" />
              </div>
            ) : selectedRecordRevisions.revisions.length === 0 ? (
              <p style={{ color: 'var(--color-muted)' }}>No revisions recorded.</p>
            ) : (
              <div style={{ overflowX: 'auto', marginBottom: 'var(--space-4)' }}>
                <table className="data-table" aria-label="Record revision history table">
                  <thead>
                    <tr>
                      <th scope="col">Rev</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                      <th scope="col">Changed At</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Explanation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRecordRevisions.revisions.map((rev) => (
                      <tr key={rev.revisionNo}>
                        <td>r{rev.revisionNo}</td>
                        <td>{rev.statusBefore || '— (Initial)'}</td>
                        <td style={{ fontWeight: 600 }}>{rev.statusAfter}</td>
                        <td>{formatDate(rev.changedAt.slice(0, 10))}</td>
                        <td>
                          <Badge>{rev.reasonCode}</Badge>
                        </td>
                        <td>{rev.reasonText || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" onClick={() => setSelectedRecordRevisions(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* REJECT NOTE MODAL */}
      {rejectingRequest && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-title"
          >
            <h3 id="reject-title" style={{ marginTop: 0 }}>
              Reject Correction Request
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
              A decision note explaining the rejection is mandatory (minimum 5 characters).
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleDecision(rejectingRequest, 'reject', rejectNote);
              }}
            >
              <TextField
                label="Rejection Note"
                placeholder="e.g. Attendance registers confirm absence on cited date."
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                required
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-4)',
                }}
              >
                <Button variant="ghost" onClick={() => setRejectingRequest(null)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={rejectNote.trim().length < 5}>
                  Confirm Rejection
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CANCEL SESSION MODAL */}
      {cancellingSession && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-title"
          >
            <h3 id="cancel-title" style={{ marginTop: 0 }}>
              Cancel Scheduled Session
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
              Cancelling is allowed for unscheduled/unconducted sessions only. Requires mandatory
              explanation.
            </p>
            <form onSubmit={(e) => void handleCancelSession(e)}>
              <TextField
                label="Cancellation Reason"
                placeholder="e.g. Faculty medical leave / reschedule"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                required
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-4)',
                }}
              >
                <Button variant="ghost" onClick={() => setCancellingSession(null)}>
                  Keep Session
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  pending={submittingCancel}
                  disabled={cancelReason.trim().length < 5}
                >
                  Confirm Cancellation
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LOCK SESSION MODAL */}
      {lockingSessionTarget && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lock-title"
          >
            <h3 id="lock-title" style={{ marginTop: 0 }}>
              Lock Class Session
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
              Locking is irreversible. Locked sessions cannot be directly corrected. Step-up
              assurance and mandatory reason required.
            </p>
            <form onSubmit={(e) => void handleLockSession(e)}>
              <TextField
                label="Locking Justification"
                placeholder="e.g. End of term audit closure"
                value={lockReason}
                onChange={(e) => setLockReason(e.target.value)}
                required
              />
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-4)',
                }}
              >
                <Button variant="ghost" onClick={() => setLockingSessionTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  pending={submittingLock}
                  disabled={lockReason.trim().length < 5}
                >
                  Lock Session
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(34, 26, 54, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 'var(--space-4)',
};

const modalCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-surface)',
  borderRadius: 'var(--radius-card)',
  padding: 'var(--space-6)',
  maxWidth: '36rem',
  width: '100%',
  boxShadow: 'var(--shadow-md)',
  maxHeight: '90vh',
  overflowY: 'auto',
};
