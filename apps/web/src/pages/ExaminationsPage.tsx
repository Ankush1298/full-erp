import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError } from '../lib/api/errors';
import {
  approveCandidateList,
  createExamination,
  createSchedule,
  fetchCandidateList,
  fetchClassRegister,
  fetchEligibilityPolicy,
  fetchExaminations,
  fetchScheduleRoster,
  fetchSchedules,
  fetchStudentResults,
  generateCandidates,
  overrideCandidate,
  publishExamResults,
  saveEligibilityPolicy,
  saveExamMarks,
  type CandidateItem,
  type CandidateListResponse,
  type ClassRegisterResponse,
  type EligibilityPolicyDto,
  type EvaluationStatus,
  type ExamScheduleDto,
  type ExamType,
  type ExaminationDto,
  type MarkStatus,
  type OverrideStatus,
  type ScheduleRosterResponse,
  type ScheduleStatus,
  type StudentResultItem,
} from '../lib/api/examinations-api';
import { fetchTerms, type Term } from '../lib/api/academics-api';
import { fetchCampuses, type CampusItem } from '../lib/api/organisation-api';

type Tab = 'setup' | 'candidates' | 'marks' | 'publish' | 'register' | 'results';

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
  padding: 'var(--space-4, 1rem)',
};

const modalCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-surface, #ffffff)',
  borderRadius: 'var(--radius-card, 0.5rem)',
  padding: 'var(--space-6, 1.5rem)',
  maxWidth: '38rem',
  width: '100%',
  boxShadow: 'var(--shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1))',
  maxHeight: '90vh',
  overflowY: 'auto',
};

export function ExaminationsPage() {
  usePageTitle('Examinations & Results');
  const { client, identity } = useAuth();

  const isStudent = identity?.actorKind === 'STUDENT';
  const canManage = identity ? can(identity, 'exam.manage') : false;
  const canEnterMarks = identity ? can(identity, 'exam.marks.enter') : false;
  const canPublish = identity ? can(identity, 'result.publish') : false;
  const canReadResults = identity ? can(identity, 'result.read') : false;

  // Active tab with sensible default derived from caller capabilities
  const defaultTab: Tab = useMemo(() => {
    if (isStudent) return 'results';
    if (canEnterMarks) return 'marks';
    if (canManage) return 'setup';
    if (canPublish) return 'publish';
    return 'register';
  }, [isStudent, canEnterMarks, canManage, canPublish]);

  const [userSelectedTab, setTab] = useState<Tab | null>(null);
  const tab = userSelectedTab ?? defaultTab;

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Common lists
  const [examinations, setExaminations] = useState<ExaminationDto[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [schedules, setSchedules] = useState<ExamScheduleDto[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string>('');

  // Setup tab state
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [newExamName, setNewExamName] = useState('');
  const [newExamType, setNewExamType] = useState<ExamType>('MID_TERM');
  const [newCampusId, setNewCampusId] = useState('');
  const [newTermId, setNewTermId] = useState('');
  const [newStartsOn, setNewStartsOn] = useState('');
  const [newEndsOn, setNewEndsOn] = useState('');

  // New Schedule state
  const [newOfferingId, setNewOfferingId] = useState('');
  const [newExamDate, setNewExamDate] = useState('');
  const [newStartTime, setNewStartTime] = useState('10:00');
  const [newEndTime, setNewEndTime] = useState('12:00');
  const [newMaxMarks, setNewMaxMarks] = useState('100');
  const [newPassMarks, setNewPassMarks] = useState('40');

  // Eligibility & Candidates state
  const [candidateListData, setCandidateListData] = useState<CandidateListResponse | null>(null);
  const [policyData, setPolicyData] = useState<EligibilityPolicyDto | null>(null);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidateFilter, setCandidateFilter] = useState<'ALL' | EvaluationStatus>('ALL');

  // Policy modal state
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [policyName, setPolicyName] = useState('Default Eligibility Policy');
  const [minAttendance, setMinAttendance] = useState('75');
  const [checkAttendance, setCheckAttendance] = useState(true);
  const [checkFees, setCheckFees] = useState(false);
  const [attendanceCutoffDays, setAttendanceCutoffDays] = useState('0');
  const [allowLateEnrolmentReview, setAllowLateEnrolmentReview] = useState(true);
  const [savingPolicy, setSavingPolicy] = useState(false);

  // Candidate generation & approval state
  const [generatingCandidates, setGeneratingCandidates] = useState(false);
  const [cutoffDateInput, setCutoffDateInput] = useState('');
  const [approvingList, setApprovingList] = useState(false);

  // Evidence modal state
  const [selectedEvidenceCandidate, setSelectedEvidenceCandidate] = useState<CandidateItem | null>(null);

  // Override modal state
  const [selectedOverrideCandidate, setSelectedOverrideCandidate] = useState<CandidateItem | null>(null);
  const [overrideStatusChoice, setOverrideStatusChoice] = useState<OverrideStatus>('EXEMPTED');
  const [overrideReasonInput, setOverrideReasonInput] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);

  // Marks Entry state
  const [rosterData, setRosterData] = useState<ScheduleRosterResponse | null>(null);
  const [marksEntries, setMarksEntries] = useState<
    Record<
      string,
      {
        status: MarkStatus;
        marks_obtained: string;
        remarks: string;
      }
    >
  >({});
  const [submittingMarks, setSubmittingMarks] = useState(false);

  // Review & Publish state
  const [publishingId, setPublishingId] = useState<string | null>(null);

  // Class Register state
  const [registerData, setRegisterData] = useState<ClassRegisterResponse | null>(null);

  // Student Results state
  const [studentResults, setStudentResults] = useState<StudentResultItem[]>([]);

  // Load initial examinations
  useEffect(() => {
    if (!client) return;
    let active = true;

    async function load() {
      try {
        if (!isStudent && (canManage || canEnterMarks || canPublish || canReadResults)) {
          const list = await fetchExaminations(client);
          if (!active) return;
          setExaminations(list);
          if (list[0] && !selectedExamId) {
            setSelectedExamId(list[0].id);
          }
        }
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load examinations.');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [client, isStudent, canManage, canEnterMarks, canPublish, canReadResults, selectedExamId]);

  // Load campuses and terms for Setup
  useEffect(() => {
    if (!client || !canManage) return;
    let active = true;

    async function loadStructure() {
      try {
        const [cList, tList] = await Promise.all([fetchCampuses(client), fetchTerms(client)]);
        if (!active) return;
        setCampuses(cList);
        setTerms(tList);
        if (cList[0] && !newCampusId) setNewCampusId(cList[0].id);
        if (tList[0] && !newTermId) setNewTermId(tList[0].id);
      } catch {
        // Ignored in non-admin contexts
      }
    }

    void loadStructure();
    return () => {
      active = false;
    };
  }, [client, canManage, newCampusId, newTermId]);

  // Load schedules when selected exam changes
  useEffect(() => {
    if (!client || !selectedExamId) return;
    let active = true;

    async function loadSchedules() {
      try {
        const list = await fetchSchedules(client, selectedExamId);
        if (!active) return;
        setSchedules(list);
        if (list[0]) {
          setSelectedScheduleId(list[0].id);
        } else {
          setSelectedScheduleId('');
          setRosterData(null);
          setRegisterData(null);
          setCandidateListData(null);
        }
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load schedules.');
      }
    }

    void loadSchedules();
    return () => {
      active = false;
    };
  }, [client, selectedExamId]);

  // Load candidate list and policy when tab === 'candidates'
  useEffect(() => {
    if (!client || !selectedScheduleId || tab !== 'candidates') return;
    let active = true;

    async function loadCandidatesAndPolicy() {
      setLoadingCandidates(true);
      setError(null);
      try {
        const [cList, pol] = await Promise.all([
          fetchCandidateList(client, selectedScheduleId),
          fetchEligibilityPolicy(client, selectedScheduleId),
        ]);
        if (!active) return;
        setCandidateListData(cList);
        setPolicyData(pol);
        if (pol) {
          setPolicyName(pol.name);
          setMinAttendance(String(pol.min_attendance_percentage));
          setCheckAttendance(pol.check_attendance);
          setCheckFees(pol.check_fees);
          setAttendanceCutoffDays(String(pol.attendance_cutoff_days_prior));
          setAllowLateEnrolmentReview(pol.allow_late_enrolment_review);
        }
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load candidates or policy.');
      } finally {
        if (active) setLoadingCandidates(false);
      }
    }

    void loadCandidatesAndPolicy();
    return () => {
      active = false;
    };
  }, [client, selectedScheduleId, tab]);

  // Load roster when selected schedule changes in Marks Entry tab
  useEffect(() => {
    if (!client || !selectedScheduleId || tab !== 'marks') return;
    let active = true;

    async function loadRoster() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchScheduleRoster(client, selectedScheduleId);
        if (!active) return;
        setRosterData(data);

        // Prepopulate form entries
        const initialMap: typeof marksEntries = {};
        for (const st of data.students) {
          initialMap[st.student_id] = {
            status: st.mark_status ?? 'ENTERED',
            marks_obtained: st.marks_obtained !== null && st.marks_obtained !== undefined ? String(st.marks_obtained) : '',
            remarks: st.remarks ?? '',
          };
        }
        setMarksEntries(initialMap);
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load student roster for this schedule.');
        setRosterData(null);
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadRoster();
    return () => {
      active = false;
    };
  }, [client, selectedScheduleId, tab]);

  // Load class register when schedule changes in Register tab
  useEffect(() => {
    if (!client || !selectedScheduleId || tab !== 'register') return;
    let active = true;

    async function loadRegister() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchClassRegister(client, selectedScheduleId);
        if (!active) return;
        setRegisterData(data);
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load class register.');
        setRegisterData(null);
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadRegister();
    return () => {
      active = false;
    };
  }, [client, selectedScheduleId, tab]);

  // Load student results in Results tab
  useEffect(() => {
    if (!client || tab !== 'results') return;
    let active = true;

    async function loadResults() {
      setLoading(true);
      setError(null);
      try {
        const studentId = identity?.userId;
        if (studentId) {
          const list = await fetchStudentResults(client, studentId);
          if (!active) return;
          setStudentResults(list);
        }
      } catch (err) {
        if (!active) return;
        setError(isApiError(err) ? err.message : 'Failed to load examination results.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadResults();
    return () => {
      active = false;
    };
  }, [client, identity, tab]);

  // Create examination handler
  async function handleCreateExamination(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setError(null);
    setSuccess(null);
    try {
      const created = await createExamination(client, {
        name: newExamName,
        exam_type: newExamType,
        campus_id: newCampusId,
        term_id: newTermId,
        starts_on: newStartsOn,
        ends_on: newEndsOn,
      });
      setSuccess(`Examination "${created.name}" created successfully.`);
      setExaminations((prev) => [created, ...prev]);
      setSelectedExamId(created.id);
      setNewExamName('');
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to create examination.');
    }
  }

  // Create schedule handler
  async function handleCreateSchedule(e: FormEvent) {
    e.preventDefault();
    if (!client || !selectedExamId) return;
    setError(null);
    setSuccess(null);
    try {
      const created = await createSchedule(client, selectedExamId, {
        course_offering_id: newOfferingId,
        exam_date: newExamDate,
        start_time: newStartTime || null,
        end_time: newEndTime || null,
        max_marks: Number(newMaxMarks),
        pass_marks: Number(newPassMarks),
      });
      setSuccess('Examination paper scheduled successfully.');
      setSchedules((prev) => [...prev, created]);
      setSelectedScheduleId(created.id);
      setNewOfferingId('');
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to schedule examination paper.');
    }
  }

  // Save policy handler
  async function handleSavePolicy(e: FormEvent) {
    e.preventDefault();
    if (!client || !selectedScheduleId) return;
    setError(null);
    setSuccess(null);
    setSavingPolicy(true);
    try {
      const updated = await saveEligibilityPolicy(client, selectedScheduleId, {
        name: policyName.trim() || 'Eligibility Policy',
        min_attendance_percentage: Number(minAttendance),
        check_attendance: checkAttendance,
        check_fees: checkFees,
        attendance_cutoff_days_prior: Number(attendanceCutoffDays),
        allow_late_enrolment_review: allowLateEnrolmentReview,
      });
      setPolicyData(updated);
      setShowPolicyModal(false);
      setSuccess('Eligibility policy updated successfully.');
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to save eligibility policy.');
    } finally {
      setSavingPolicy(false);
    }
  }

  // Generate candidate list handler
  async function handleGenerateCandidates() {
    if (!client || !selectedScheduleId) return;
    setError(null);
    setSuccess(null);
    setGeneratingCandidates(true);
    try {
      const res = await generateCandidates(
        client,
        selectedScheduleId,
        cutoffDateInput ? { cutoff_date: cutoffDateInput } : undefined,
      );
      setCandidateListData(res);
      setSuccess(`Candidate list generated with ${res.list.total_candidates} candidates evaluated.`);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to generate candidate list.');
    } finally {
      setGeneratingCandidates(false);
    }
  }

  // Approve or freeze candidate list handler
  async function handleApproveOrFreeze(freeze: boolean) {
    if (!client || !selectedScheduleId || !candidateListData?.list) return;
    setError(null);
    setSuccess(null);
    setApprovingList(true);
    try {
      const res = await approveCandidateList(client, selectedScheduleId, candidateListData.list.id, {
        freeze,
      });
      setCandidateListData((prev) =>
        prev ? { ...prev, list: { ...prev.list, status: res.status } } : null,
      );
      setSuccess(
        freeze
          ? 'Candidate list frozen successfully. No further overrides can be applied.'
          : 'Candidate list approved. Marks entry is now enabled for eligible candidates.',
      );
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to approve candidate list.');
    } finally {
      setApprovingList(false);
    }
  }

  // Apply candidate override handler
  async function handleSaveOverride(e: FormEvent) {
    e.preventDefault();
    if (!client || !selectedScheduleId || !selectedOverrideCandidate) return;
    if (!overrideReasonInput.trim() || overrideReasonInput.trim().length < 3) {
      setError('A descriptive override reason of at least 3 characters is mandatory.');
      return;
    }
    setError(null);
    setSuccess(null);
    setSavingOverride(true);
    try {
      const updated = await overrideCandidate(
        client,
        selectedScheduleId,
        selectedOverrideCandidate.candidate_id,
        {
          override_status: overrideStatusChoice,
          override_reason: overrideReasonInput.trim(),
        },
      );
      // Refresh candidate list to reflect updated counts and final status
      const refreshed = await fetchCandidateList(client, selectedScheduleId);
      setCandidateListData(refreshed);
      setSelectedOverrideCandidate(null);
      setOverrideReasonInput('');
      setSuccess(`Override applied for ${updated.student_name}.`);
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to apply candidate override.');
    } finally {
      setSavingOverride(false);
    }
  }

  // Save marks handler
  async function handleSaveMarks(action: 'DRAFT' | 'SUBMIT') {
    if (!client || !selectedScheduleId || !rosterData) return;
    setError(null);
    setSuccess(null);
    setSubmittingMarks(true);

    try {
      const maxMarks = rosterData.schedule.max_marks;
      const entries = rosterData.students.map((st) => {
        const item = marksEntries[st.student_id] ?? {
          status: 'ENTERED',
          marks_obtained: '',
          remarks: '',
        };
        const numMarks = item.marks_obtained !== '' ? Number(item.marks_obtained) : null;

        if (item.status === 'ENTERED') {
          if (numMarks === null || Number.isNaN(numMarks)) {
            throw new Error(`Marks obtained is required for student ${st.student_name}.`);
          }
          if (numMarks < 0 || numMarks > maxMarks) {
            throw new Error(`Marks for ${st.student_name} must be between 0 and ${maxMarks}.`);
          }
        }

        return {
          student_id: st.student_id,
          status: item.status,
          marks_obtained: item.status === 'ENTERED' ? numMarks : null,
          remarks: item.remarks || null,
        };
      });

      const res = await saveExamMarks(client, selectedScheduleId, {
        action,
        entries,
      });

      setSuccess(
        action === 'SUBMIT'
          ? 'Marks submitted successfully. Paper is ready for administrative review.'
          : 'Draft marks saved successfully.',
      );

      // Refresh schedule
      setSchedules((prev) =>
        prev.map((s) => (s.id === selectedScheduleId ? { ...s, status: res.status as ScheduleStatus } : s)),
      );
      if (rosterData) {
        setRosterData({
          ...rosterData,
          schedule: { ...rosterData.schedule, status: res.status as ScheduleStatus },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : isApiError(err) ? err.message : 'Failed to save marks.');
    } finally {
      setSubmittingMarks(false);
    }
  }

  // Publish results handler
  async function handlePublishResults(schedId: string) {
    if (!client) return;
    if (!confirm('Are you sure you want to publish the examination results? Published results are visible to students and cannot be modified.')) {
      return;
    }
    setError(null);
    setSuccess(null);
    setPublishingId(schedId);

    try {
      await publishExamResults(client, schedId);
      setSuccess('Results published successfully.');
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedId ? { ...s, status: 'PUBLISHED' } : s)),
      );
    } catch (err) {
      setError(isApiError(err) ? err.message : 'Failed to publish results. Step-up MFA verification may be required.');
    } finally {
      setPublishingId(null);
    }
  }

  // Filtered candidate list
  const filteredCandidates = useMemo(() => {
    if (!candidateListData?.candidates) return [];
    if (candidateFilter === 'ALL') return candidateListData.candidates;
    return candidateListData.candidates.filter((c) => c.evaluation_status === candidateFilter);
  }, [candidateListData, candidateFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Examinations, Marks & Results"
        subtitle="Configure examination schedules, evaluate candidate eligibility rules, record student evaluations, and publish verified academic records."
      />

      {!isStudent && (
        <div className="stat-grid" style={{ marginBottom: 'var(--space-4)' }}>
          <StatCard
            label="Examinations"
            value={examinations.length}
            tone="purple"
            helper="Configured assessment terms"
          />
          <StatCard
            label="Active Schedules"
            value={schedules.length}
            tone="emerald"
            helper="Scheduled course components"
          />
          <StatCard
            label="Evaluated Candidates"
            value={candidateListData?.list.total_candidates ?? 0}
            tone="amber"
            helper="Eligibility criteria assessed"
          />
          <StatCard
            label="Eligible for Exam"
            value={candidateListData?.list.eligible_count ?? 0}
            tone="coral"
            helper="Cleared for marks entry"
          />
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}

      {/* Navigation Tabs */}
      <div className="border-b border-border">
        <nav className="flex space-x-4" aria-label="Examination sections">
          {canManage && (
            <button
              type="button"
              onClick={() => setTab('setup')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'setup'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              Examination Setup
            </button>
          )}
          {(canManage || canEnterMarks) && (
            <button
              type="button"
              onClick={() => setTab('candidates')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'candidates'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              Eligibility & Candidates
            </button>
          )}
          {canEnterMarks && (
            <button
              type="button"
              onClick={() => setTab('marks')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'marks'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              Marks Entry
            </button>
          )}
          {canPublish && (
            <button
              type="button"
              onClick={() => setTab('publish')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'publish'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              Review & Publish
            </button>
          )}
          {canReadResults && !isStudent && (
            <button
              type="button"
              onClick={() => setTab('register')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'register'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              Marks Register
            </button>
          )}
          {(isStudent || canReadResults) && (
            <button
              type="button"
              onClick={() => setTab('results')}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === 'results'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              {isStudent ? 'My Results' : 'Student Results'}
            </button>
          )}
        </nav>
      </div>

      {/* Filter / Selector Bar (for non-student staff views) */}
      {!isStudent && tab !== 'results' && (
        <div className="card p-4 bg-surface-muted/30">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="exam-select" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
                Select Examination
              </label>
              <select
                id="exam-select"
                value={selectedExamId}
                onChange={(e) => setSelectedExamId(e.target.value)}
                className="w-full h-10 px-3 text-sm rounded-md border border-input bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {examinations.length === 0 && <option value="">No examinations created</option>}
                {examinations.map((ex) => (
                  <option key={ex.id} value={ex.id}>
                    {ex.name} ({ex.exam_type}) — {ex.starts_on} to {ex.ends_on}
                  </option>
                ))}
              </select>
            </div>

            {(tab === 'candidates' || tab === 'marks' || tab === 'register') && (
              <div>
                <label htmlFor="schedule-select" className="block text-xs font-semibold uppercase tracking-wider text-muted mb-1">
                  Select Scheduled Paper
                </label>
                <select
                  id="schedule-select"
                  value={selectedScheduleId}
                  onChange={(e) => setSelectedScheduleId(e.target.value)}
                  className="w-full h-10 px-3 text-sm rounded-md border border-input bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {schedules.length === 0 && <option value="">No papers scheduled</option>}
                  {schedules.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.course_code ? `${sc.course_code}: ` : ''}{sc.course_title || 'Paper'} — {sc.exam_date} ({sc.status})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 1. SETUP TAB                                                  */}
      {/* ------------------------------------------------------------- */}
      {tab === 'setup' && canManage && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card title="Create New Examination">
            <form onSubmit={(e) => { void handleCreateExamination(e); }} className="space-y-4">
              <TextField
                label="Examination Name"
                placeholder="e.g. Autumn Mid-Term 2026"
                value={newExamName}
                onChange={(e) => setNewExamName(e.target.value)}
                required
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="exam-type-select" className="block text-xs font-medium text-muted mb-1">
                    Exam Type
                  </label>
                  <select
                    id="exam-type-select"
                    value={newExamType}
                    onChange={(e) => setNewExamType(e.target.value as ExamType)}
                    className="w-full h-9 px-2 text-sm rounded border border-input bg-surface"
                  >
                    <option value="UNIT_TEST">Unit Test</option>
                    <option value="MID_TERM">Mid-Term</option>
                    <option value="FINAL">Final Examination</option>
                    <option value="INTERNAL">Internal Assessment</option>
                    <option value="SUPPLEMENTARY">Supplementary</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="exam-campus-select" className="block text-xs font-medium text-muted mb-1">
                    Campus
                  </label>
                  <select
                    id="exam-campus-select"
                    value={newCampusId}
                    onChange={(e) => setNewCampusId(e.target.value)}
                    className="w-full h-9 px-2 text-sm rounded border border-input bg-surface"
                    required
                  >
                    {campuses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="exam-term-select" className="block text-xs font-medium text-muted mb-1">
                    Academic Term
                  </label>
                  <select
                    id="exam-term-select"
                    value={newTermId}
                    onChange={(e) => setNewTermId(e.target.value)}
                    className="w-full h-9 px-2 text-sm rounded border border-input bg-surface"
                    required
                  >
                    {terms.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <TextField
                    type="date"
                    label="Starts On"
                    value={newStartsOn}
                    onChange={(e) => setNewStartsOn(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <TextField
                  type="date"
                  label="Ends On"
                  value={newEndsOn}
                  onChange={(e) => setNewEndsOn(e.target.value)}
                  required
                />
              </div>

              <Button type="submit" variant="primary" className="w-full">
                Create Examination
              </Button>
            </form>
          </Card>

          <Card title="Schedule Paper for Selected Exam">
            {selectedExamId ? (
              <form onSubmit={(e) => { void handleCreateSchedule(e); }} className="space-y-4">
                <TextField
                  label="Course Offering ID"
                  placeholder="UUID of course offering"
                  value={newOfferingId}
                  onChange={(e) => setNewOfferingId(e.target.value)}
                  required
                />

                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    type="date"
                    label="Exam Date"
                    value={newExamDate}
                    onChange={(e) => setNewExamDate(e.target.value)}
                    required
                  />
                  <TextField
                    type="time"
                    label="Start Time"
                    value={newStartTime}
                    onChange={(e) => setNewStartTime(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <TextField
                    type="time"
                    label="End Time"
                    value={newEndTime}
                    onChange={(e) => setNewEndTime(e.target.value)}
                  />
                  <TextField
                    type="number"
                    label="Maximum Marks"
                    value={newMaxMarks}
                    onChange={(e) => setNewMaxMarks(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <TextField
                    type="number"
                    label="Passing Marks"
                    value={newPassMarks}
                    onChange={(e) => setNewPassMarks(e.target.value)}
                    required
                  />
                </div>

                <Button type="submit" variant="primary" className="w-full">
                  Schedule Paper
                </Button>
              </form>
            ) : (
              <p className="text-sm text-muted">Create or select an examination first.</p>
            )}
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. ELIGIBILITY & CANDIDATE LISTS TAB (SLICE 2)                */}
      {/* ------------------------------------------------------------- */}
      {tab === 'candidates' && (canManage || canEnterMarks) && (
        <div className="space-y-5">
          {loadingCandidates && <Spinner />}

          {!loadingCandidates && !selectedScheduleId && (
            <div className="card p-8 text-center text-muted">
              Select an examination and scheduled paper above to manage candidate eligibility and view candidate lists.
            </div>
          )}

          {!loadingCandidates && selectedScheduleId && (
            <div className="space-y-4">
              {/* Header card with actions */}
              <div className="card p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">
                      Candidate Eligibility & Automatic Verification
                    </h2>
                    <p className="text-xs text-muted">
                      Evaluates active term enrolments and real attendance records against policy criteria. Overrides require mandatory justification.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canManage && (
                      <Button
                        variant="secondary"
                        onClick={() => setShowPolicyModal(true)}
                      >
                        Configure Policy
                      </Button>
                    )}
                    {canManage && candidateListData?.list && candidateListData.list.status === 'DRAFT' && (
                      <Button
                        variant="primary"
                        disabled={approvingList}
                        onClick={() => { void handleApproveOrFreeze(false); }}
                      >
                        {approvingList ? 'Approving...' : 'Approve Candidate List'}
                      </Button>
                    )}
                    {canManage && candidateListData?.list && candidateListData.list.status === 'APPROVED' && (
                      <Button
                        variant="secondary"
                        disabled={approvingList}
                        onClick={() => { void handleApproveOrFreeze(true); }}
                      >
                        {approvingList ? 'Freezing...' : 'Freeze Candidate List'}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Policy parameters overview */}
                <div className="flex flex-wrap items-center gap-4 text-xs text-muted bg-surface-muted/30 p-3 rounded-md">
                  <div>
                    <span className="font-semibold text-foreground">Policy: </span>
                    {policyData?.name ?? 'Default Eligibility Policy'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Attendance Threshold: </span>
                    {policyData ? `${policyData.min_attendance_percentage}%` : '75%'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Attendance Check: </span>
                    {policyData?.check_attendance ? 'Enabled' : 'Disabled'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Fee Clearance: </span>
                    {policyData?.check_fees ? 'Required (Pending Finance)' : 'Disabled'}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Late Enrolment Review: </span>
                    {policyData?.allow_late_enrolment_review ? 'Enabled' : 'Disabled'}
                  </div>
                </div>

                {/* Staleness recalculation alert */}
                {candidateListData?.recalculation_available && (
                  <Alert tone="info">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <span>
                        Attendance marks or course registrations have been updated since this list was generated. Candidate evaluation may be stale.
                      </span>
                      {canManage && candidateListData.list.status !== 'FROZEN' && (
                        <Button
                          variant="secondary"
                          disabled={generatingCandidates}
                          onClick={() => { void handleGenerateCandidates(); }}
                        >
                          Re-evaluate Candidates
                        </Button>
                      )}
                    </div>
                  </Alert>
                )}

                {/* Generate bar */}
                {canManage && (!candidateListData || candidateListData.list.status !== 'FROZEN') && (
                  <div className="flex flex-wrap items-center gap-3 pt-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor="cutoff-date-input" className="text-xs font-medium text-muted">
                        Evidence Cutoff Date (optional):
                      </label>
                      <input
                        id="cutoff-date-input"
                        type="date"
                        value={cutoffDateInput}
                        onChange={(e) => setCutoffDateInput(e.target.value)}
                        className="h-8 px-2 text-xs rounded border border-input bg-surface"
                      />
                    </div>
                    <Button
                      variant="primary"
                      disabled={generatingCandidates}
                      onClick={() => { void handleGenerateCandidates(); }}
                    >
                      {generatingCandidates
                        ? 'Evaluating Candidates...'
                        : candidateListData
                        ? 'Re-generate Candidates'
                        : 'Generate Candidate List'}
                    </Button>
                  </div>
                )}
              </div>

              {/* Candidate List Metrics Summary */}
              {candidateListData?.list && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">Total Candidates</p>
                    <p className="text-xl font-bold text-foreground">{candidateListData.list.total_candidates}</p>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">Eligible</p>
                    <p className="text-xl font-bold text-green-700">{candidateListData.list.eligible_count}</p>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">Not Eligible</p>
                    <p className="text-xl font-bold text-red-700">{candidateListData.list.not_eligible_count}</p>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">Needs Review</p>
                    <p className="text-xl font-bold text-amber-700">{candidateListData.list.needs_review_count}</p>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">List Status</p>
                    <div className="mt-1">
                      <Badge>{candidateListData.list.status}</Badge>
                    </div>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-muted uppercase font-semibold">Snapshot Version</p>
                    <p className="text-xl font-bold text-brand-700">v{candidateListData.list.snapshot_version}</p>
                  </div>
                </div>
              )}

              {/* Filter Pills and Table */}
              {candidateListData ? (
                <Card title="Candidate List Roster">
                  {/* Status Filters */}
                  <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Candidate list filters">
                    <button
                      type="button"
                      onClick={() => setCandidateFilter('ALL')}
                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                        candidateFilter === 'ALL'
                          ? 'bg-brand-600 text-white'
                          : 'bg-surface-muted/60 text-muted hover:text-foreground'
                      }`}
                    >
                      All ({candidateListData.list.total_candidates})
                    </button>
                    <button
                      type="button"
                      onClick={() => setCandidateFilter('ELIGIBLE')}
                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                        candidateFilter === 'ELIGIBLE'
                          ? 'bg-green-600 text-white'
                          : 'bg-surface-muted/60 text-muted hover:text-foreground'
                      }`}
                    >
                      Eligible ({candidateListData.list.eligible_count})
                    </button>
                    <button
                      type="button"
                      onClick={() => setCandidateFilter('NOT_ELIGIBLE')}
                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                        candidateFilter === 'NOT_ELIGIBLE'
                          ? 'bg-red-600 text-white'
                          : 'bg-surface-muted/60 text-muted hover:text-foreground'
                      }`}
                    >
                      Not Eligible ({candidateListData.list.not_eligible_count})
                    </button>
                    <button
                      type="button"
                      onClick={() => setCandidateFilter('NEEDS_REVIEW')}
                      className={`px-3 py-1 text-xs rounded-full font-medium transition-colors ${
                        candidateFilter === 'NEEDS_REVIEW'
                          ? 'bg-amber-600 text-white'
                          : 'bg-surface-muted/60 text-muted hover:text-foreground'
                      }`}
                    >
                      Needs Review ({candidateListData.list.needs_review_count})
                    </button>
                  </div>

                  {filteredCandidates.length === 0 ? (
                    <p className="text-sm text-muted py-6 text-center">
                      No candidates match the selected filter.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm" role="table" aria-label="Candidate List Table">
                        <thead className="bg-surface-muted/50 text-xs font-semibold uppercase text-muted">
                          <tr>
                            <th scope="col" className="px-3 py-2">Admission No</th>
                            <th scope="col" className="px-3 py-2">Student Name</th>
                            <th scope="col" className="px-3 py-2">Roll No</th>
                            <th scope="col" className="px-3 py-2">Attendance %</th>
                            <th scope="col" className="px-3 py-2">Evaluation</th>
                            <th scope="col" className="px-3 py-2">Override</th>
                            <th scope="col" className="px-3 py-2">Final Status</th>
                            <th scope="col" className="px-3 py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {filteredCandidates.map((c) => (
                            <tr key={c.candidate_id} className="hover:bg-surface-muted/20">
                              <td className="px-3 py-2 font-mono text-xs">{c.admission_number}</td>
                              <td className="px-3 py-2 font-medium">{c.student_name}</td>
                              <td className="px-3 py-2 text-muted">{c.roll_number ?? '—'}</td>
                              <td className="px-3 py-2">
                                <span className="font-semibold">
                                  {c.evidence_summary?.attendance_percentage !== undefined && c.evidence_summary?.attendance_percentage !== null
                                    ? `${c.evidence_summary.attendance_percentage}%`
                                    : '—'}
                                </span>
                                {c.evidence_summary && (
                                  <span className="text-[11px] text-muted block">
                                    {c.evidence_summary.attended_sessions}/{c.evidence_summary.total_sessions} sessions
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <Badge>{c.evaluation_status}</Badge>
                              </td>
                              <td className="px-3 py-2">
                                {c.override_status === 'NONE' ? (
                                  <span className="text-xs text-muted">None</span>
                                ) : (
                                  <span className="text-xs font-medium text-brand-700">
                                    {c.override_status}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                {c.final_status === 'ELIGIBLE' ? (
                                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded bg-green-100 text-green-800">
                                    ELIGIBLE
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded bg-red-100 text-red-800">
                                    NOT ELIGIBLE
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedEvidenceCandidate(c)}
                                    className="text-xs text-brand-700 hover:text-brand-900 underline font-medium"
                                  >
                                    Evidence
                                  </button>
                                  {canManage && candidateListData.list.status !== 'FROZEN' && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedOverrideCandidate(c);
                                        setOverrideStatusChoice(c.override_status !== 'NONE' ? c.override_status : 'EXEMPTED');
                                        setOverrideReasonInput(c.override_reason ?? '');
                                      }}
                                      className="text-xs text-brand-700 hover:text-brand-900 underline font-medium ml-2"
                                    >
                                      Override
                                    </button>
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
              ) : (
                <div className="card p-8 text-center text-muted">
                  No candidate list has been generated yet for this examination paper.
                  Click &quot;Generate Candidate List&quot; above to automatically identify eligible students.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. MARKS ENTRY TAB                                            */}
      {/* ------------------------------------------------------------- */}
      {tab === 'marks' && canEnterMarks && (
        <div className="space-y-4">
          {loading && <Spinner />}

          {!loading && !selectedScheduleId && (
            <div className="card p-8 text-center text-muted">
              Select an examination and scheduled paper above to record student marks.
            </div>
          )}

          {!loading && rosterData && (
            <div className="card p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-border pb-3">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {rosterData.schedule.course_code ? `${rosterData.schedule.course_code} - ` : ''}
                    {rosterData.schedule.course_title || 'Course Paper'}
                  </h2>
                  <p className="text-xs text-muted">
                    Exam Date: {rosterData.schedule.exam_date} | Max Marks: {rosterData.schedule.max_marks} | Passing Marks: {rosterData.schedule.pass_marks}
                  </p>
                </div>
                <div className="mt-2 sm:mt-0 flex items-center gap-2">
                  <Badge>{rosterData.schedule.status}</Badge>
                </div>
              </div>

              {/* Candidate List status indicator */}
              {rosterData.candidate_list ? (
                <div className="p-3 bg-brand-50 border border-brand-200 rounded-md text-xs text-brand-900 flex items-center justify-between">
                  <span>
                    Candidate List Status: <strong>{rosterData.candidate_list.status}</strong> (Snapshot v{rosterData.candidate_list.snapshot_version}).
                    {rosterData.candidate_list.status === 'APPROVED' || rosterData.candidate_list.status === 'FROZEN'
                      ? ' Marks entry is restricted to verified eligible candidates.'
                      : ' Candidate list is in draft; finalize approval before submission.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTab('candidates')}
                    className="text-xs text-brand-700 underline font-medium hover:text-brand-900"
                  >
                    View Candidate List
                  </button>
                </div>
              ) : null}

              {rosterData.schedule.status === 'PUBLISHED' ? (
                <Alert tone="info">
                  Results for this examination schedule are published. Marks cannot be modified.
                </Alert>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm" role="table" aria-label="Student Marks Entry Table">
                      <thead className="bg-surface-muted/50 text-xs font-semibold uppercase text-muted">
                        <tr>
                          <th scope="col" className="px-3 py-2">Admission No</th>
                          <th scope="col" className="px-3 py-2">Student Name</th>
                          <th scope="col" className="px-3 py-2">Roll No</th>
                          <th scope="col" className="px-3 py-2">Status</th>
                          <th scope="col" className="px-3 py-2">Marks Obtained</th>
                          <th scope="col" className="px-3 py-2">Remarks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {rosterData.students.map((st) => {
                          const entry = marksEntries[st.student_id] ?? {
                            status: 'ENTERED',
                            marks_obtained: '',
                            remarks: '',
                          };
                          const isEntered = entry.status === 'ENTERED';
                          const isCandidateIneligible =
                            (rosterData.candidate_list?.status === 'APPROVED' ||
                              rosterData.candidate_list?.status === 'FROZEN') &&
                            st.final_status === 'NOT_ELIGIBLE';

                          return (
                            <tr key={st.student_id} className={`hover:bg-surface-muted/20 ${isCandidateIneligible ? 'opacity-60 bg-red-50/20' : ''}`}>
                              <td className="px-3 py-2 font-mono text-xs">{st.admission_number}</td>
                              <td className="px-3 py-2 font-medium">
                                {st.student_name}
                                {st.final_status === 'ELIGIBLE' && (
                                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded bg-green-100 text-green-800">
                                    Eligible
                                  </span>
                                )}
                                {st.final_status === 'NOT_ELIGIBLE' && (
                                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded bg-red-100 text-red-800">
                                    Ineligible
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 text-muted">{st.roll_number ?? '—'}</td>
                              <td className="px-3 py-2">
                                <select
                                  aria-label={`Status for ${st.student_name}`}
                                  value={entry.status}
                                  disabled={isCandidateIneligible}
                                  onChange={(e) =>
                                    setMarksEntries((prev) => ({
                                      ...prev,
                                      [st.student_id]: {
                                        ...entry,
                                        status: e.target.value as MarkStatus,
                                      },
                                    }))
                                  }
                                  className="h-8 px-2 text-xs rounded border border-input bg-surface disabled:opacity-50"
                                >
                                  <option value="ENTERED">Entered</option>
                                  <option value="ABSENT">Absent</option>
                                  <option value="EXEMPT">Exempt</option>
                                  <option value="WITHHELD">Withheld</option>
                                </select>
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="number"
                                  min="0"
                                  max={rosterData.schedule.max_marks}
                                  step="0.5"
                                  aria-label={`Marks for ${st.student_name}`}
                                  disabled={!isEntered || isCandidateIneligible}
                                  placeholder={isCandidateIneligible ? 'Ineligible' : isEntered ? '0 - 100' : 'N/A'}
                                  value={isEntered && !isCandidateIneligible ? entry.marks_obtained : ''}
                                  onChange={(e) =>
                                    setMarksEntries((prev) => ({
                                      ...prev,
                                      [st.student_id]: {
                                        ...entry,
                                        marks_obtained: e.target.value,
                                      },
                                    }))
                                  }
                                  className="h-8 w-24 px-2 text-xs rounded border border-input bg-surface disabled:opacity-50"
                                />
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  type="text"
                                  aria-label={`Remarks for ${st.student_name}`}
                                  placeholder={isCandidateIneligible ? 'Candidate ineligible on approved candidate list' : 'Optional remarks'}
                                  disabled={isCandidateIneligible}
                                  value={entry.remarks}
                                  onChange={(e) =>
                                    setMarksEntries((prev) => ({
                                      ...prev,
                                      [st.student_id]: {
                                        ...entry,
                                        remarks: e.target.value,
                                      },
                                    }))
                                  }
                                  className="h-8 w-full max-w-xs px-2 text-xs rounded border border-input bg-surface disabled:opacity-50"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
                    <Button
                      variant="secondary"
                      disabled={submittingMarks}
                      onClick={() => { void handleSaveMarks('DRAFT'); }}
                    >
                      Save Draft
                    </Button>
                    <Button
                      variant="primary"
                      disabled={submittingMarks}
                      onClick={() => { void handleSaveMarks('SUBMIT'); }}
                    >
                      Submit Marks
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 4. REVIEW & PUBLISH TAB (MAKER-CHECKER ADMIN)                  */}
      {/* ------------------------------------------------------------- */}
      {tab === 'publish' && canPublish && (
        <Card title="Examination Papers Awaiting Review & Publication">
          <p className="text-xs text-muted mb-4">
            Only authorized academic administrators (HOD, Registrar, Campus Admin) can publish results. Teachers record marks, but cannot self-publish.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" role="table" aria-label="Review and Publish Table">
              <thead className="bg-surface-muted/50 text-xs font-semibold uppercase text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Course Paper</th>
                  <th scope="col" className="px-3 py-2">Exam Date</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2">Marks Submitted At</th>
                  <th scope="col" className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {schedules.map((sc) => (
                  <tr key={sc.id} className="hover:bg-surface-muted/20">
                    <td className="px-3 py-2 font-medium">
                      {sc.course_code ? `${sc.course_code}: ` : ''}{sc.course_title || 'Paper'}
                    </td>
                    <td className="px-3 py-2 text-muted">{sc.exam_date}</td>
                    <td className="px-3 py-2">
                      <Badge>{sc.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted">
                      {sc.marks_submitted_at ? new Date(sc.marks_submitted_at).toLocaleDateString() : 'Pending Submission'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {sc.status === 'PUBLISHED' ? (
                        <span className="text-xs font-medium text-green-700">Published</span>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={publishingId === sc.id || (sc.status !== 'SUBMITTED' && sc.status !== 'DRAFT_MARKS')}
                          onClick={() => { void handlePublishResults(sc.id); }}
                        >
                          {publishingId === sc.id ? 'Publishing...' : 'Publish Results'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 5. MARKS REGISTER TAB (CLASS REGISTER & SUMMARY STATISTICS)    */}
      {/* ------------------------------------------------------------- */}
      {tab === 'register' && canReadResults && !isStudent && (
        <div className="space-y-4">
          {loading && <Spinner />}

          {!loading && !registerData && (
            <div className="card p-8 text-center text-muted">
              Select an examination and scheduled paper to view the marks register and class statistics.
            </div>
          )}

          {!loading && registerData && (
            <div className="space-y-4">
              {/* Statistics Summary Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Total</p>
                  <p className="text-xl font-bold text-foreground">{registerData.statistics.total_students}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Appeared</p>
                  <p className="text-xl font-bold text-foreground">{registerData.statistics.appeared}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Absent</p>
                  <p className="text-xl font-bold text-red-600">{registerData.statistics.absent}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Exempt</p>
                  <p className="text-xl font-bold text-foreground">{registerData.statistics.exempt}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Passed</p>
                  <p className="text-xl font-bold text-green-700">{registerData.statistics.passed}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Failed</p>
                  <p className="text-xl font-bold text-red-700">{registerData.statistics.failed}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Avg Marks</p>
                  <p className="text-xl font-bold text-foreground">{registerData.statistics.average_marks}</p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-muted uppercase font-semibold">Pass %</p>
                  <p className="text-xl font-bold text-brand-700">{registerData.statistics.pass_percentage}%</p>
                </div>
              </div>

              {/* Marks Register Sheet */}
              <Card title="Class Marks Sheet">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" role="table" aria-label="Class Register Table">
                    <thead className="bg-surface-muted/50 text-xs font-semibold uppercase text-muted">
                      <tr>
                        <th scope="col" className="px-3 py-2">Admission No</th>
                        <th scope="col" className="px-3 py-2">Student Name</th>
                        <th scope="col" className="px-3 py-2">Roll No</th>
                        <th scope="col" className="px-3 py-2">Status</th>
                        <th scope="col" className="px-3 py-2">Marks Obtained</th>
                        <th scope="col" className="px-3 py-2">Result</th>
                        <th scope="col" className="px-3 py-2">Remarks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {registerData.marks.map((m) => (
                        <tr key={m.student_id} className="hover:bg-surface-muted/20">
                          <td className="px-3 py-2 font-mono text-xs">{m.admission_number}</td>
                          <td className="px-3 py-2 font-medium">{m.student_name}</td>
                          <td className="px-3 py-2 text-muted">{m.roll_number ?? '—'}</td>
                          <td className="px-3 py-2">
                            <Badge>{m.status}</Badge>
                          </td>
                          <td className="px-3 py-2 font-semibold">
                            {m.marks_obtained !== null && m.marks_obtained !== undefined ? m.marks_obtained : '—'}
                          </td>
                          <td className="px-3 py-2">
                            {m.is_passing === true && <Badge>Passed</Badge>}
                            {m.is_passing === false && <Badge>Failed</Badge>}
                            {m.is_passing === null && <span className="text-muted text-xs">—</span>}
                          </td>
                          <td className="px-3 py-2 text-muted text-xs">{m.remarks ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 6. STUDENT RESULTS TAB (STUDENT SELF VIEW)                    */}
      {/* ------------------------------------------------------------- */}
      {tab === 'results' && (
        <Card title={isStudent ? 'My Published Examination Results' : 'Student Examination Results'}>
          {loading && <Spinner />}

          {!loading && studentResults.length === 0 && (
            <p className="text-sm text-muted py-6 text-center">
              No published examination results are available at this time.
            </p>
          )}

          {!loading && studentResults.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {studentResults.map((res) => (
                <div key={res.mark_id} className="card p-4 border border-border bg-surface">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                        {res.course_code}
                      </span>
                      <h3 className="text-base font-bold text-foreground">{res.course_title}</h3>
                      <p className="text-xs text-muted mt-0.5">{res.exam_name} ({res.exam_type})</p>
                    </div>
                    <Badge>{res.is_passing ? 'Passed' : 'Failed'}</Badge>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted">Marks Obtained</p>
                      <p className="text-xl font-extrabold text-foreground">
                        {res.marks_obtained !== null ? res.marks_obtained : '—'}
                        <span className="text-xs font-normal text-muted"> / {res.max_marks}</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted">Pass Marks</p>
                      <p className="text-sm font-medium text-muted">{res.pass_marks}</p>
                    </div>
                  </div>

                  {res.remarks && (
                    <p className="mt-3 text-xs text-muted bg-surface-muted/30 p-2 rounded">
                      Note: {res.remarks}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------------- */}
      {/* MODALS                                                        */}
      {/* ------------------------------------------------------------- */}

      {/* 1. Policy Configuration Modal */}
      {showPolicyModal && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="policy-dialog-title"
          >
            <h3 id="policy-dialog-title" className="text-lg font-bold mb-1 text-foreground">
              Configure Eligibility Policy
            </h3>
            <p className="text-xs text-muted mb-4">
              Define the automated rules for generating candidate lists for this examination schedule.
            </p>

            <form onSubmit={(e) => { void handleSavePolicy(e); }} className="space-y-4">
              <TextField
                label="Policy Name"
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
                required
              />

              <div className="grid grid-cols-2 gap-3">
                <TextField
                  type="number"
                  label="Min Attendance %"
                  value={minAttendance}
                  onChange={(e) => setMinAttendance(e.target.value)}
                  min="0"
                  max="100"
                  required
                />
                <TextField
                  type="number"
                  label="Cutoff Days Prior"
                  value={attendanceCutoffDays}
                  onChange={(e) => setAttendanceCutoffDays(e.target.value)}
                  min="0"
                  max="365"
                  required
                />
              </div>

              <div className="space-y-2 pt-1 border-t border-border">
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={checkAttendance}
                    onChange={(e) => setCheckAttendance(e.target.checked)}
                    className="h-4 w-4 rounded border-input text-brand-600 focus:ring-brand-500"
                  />
                  <span>Enforce minimum attendance requirement</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={allowLateEnrolmentReview}
                    onChange={(e) => setAllowLateEnrolmentReview(e.target.checked)}
                    className="h-4 w-4 rounded border-input text-brand-600 focus:ring-brand-500"
                  />
                  <span>Flag late or mid-term enrolments for review (NEEDS_REVIEW)</span>
                </label>

                <label className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={checkFees}
                    onChange={(e) => setCheckFees(e.target.checked)}
                    className="h-4 w-4 rounded border-input text-brand-600 focus:ring-brand-500"
                  />
                  <span>Check fee clearance (Future finance module condition)</span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-border">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={savingPolicy}
                  onClick={() => setShowPolicyModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={savingPolicy}
                >
                  {savingPolicy ? 'Saving...' : 'Save Policy'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Evidence Breakdown Modal */}
      {selectedEvidenceCandidate && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-dialog-title"
          >
            <h3 id="evidence-dialog-title" className="text-lg font-bold mb-1 text-foreground">
              Candidate Evidence — {selectedEvidenceCandidate.student_name}
            </h3>
            <p className="text-xs text-muted mb-4 font-mono">
              Admission No: {selectedEvidenceCandidate.admission_number}
            </p>

            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-surface-muted/30 p-3 rounded-md">
                <div>
                  <span className="text-[11px] uppercase font-semibold text-muted block">Sessions Held</span>
                  <span className="text-base font-bold text-foreground">
                    {selectedEvidenceCandidate.evidence_summary?.total_sessions ?? '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] uppercase font-semibold text-muted block">Attended</span>
                  <span className="text-base font-bold text-green-700">
                    {selectedEvidenceCandidate.evidence_summary?.attended_sessions ?? '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] uppercase font-semibold text-muted block">Absent</span>
                  <span className="text-base font-bold text-red-700">
                    {selectedEvidenceCandidate.evidence_summary?.absent_sessions ?? '—'}
                  </span>
                </div>
                <div>
                  <span className="text-[11px] uppercase font-semibold text-muted block">Excused</span>
                  <span className="text-base font-bold text-foreground">
                    {selectedEvidenceCandidate.evidence_summary?.excused_sessions ?? '—'}
                  </span>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase text-muted mb-2">Evaluation Details & Reasons</h4>
                {selectedEvidenceCandidate.reasons.length === 0 ? (
                  <p className="text-xs text-muted">No specific notes recorded.</p>
                ) : (
                  <ul className="space-y-1 text-xs text-foreground bg-surface-muted/20 p-3 rounded-md">
                    {selectedEvidenceCandidate.reasons.map((r, i) => (
                      <li key={i} className="flex items-center gap-1.5 font-mono">
                        <span className="text-brand-600 font-bold">•</span> {r}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {selectedEvidenceCandidate.override_status !== 'NONE' && (
                <div className="p-3 bg-brand-50 border border-brand-200 rounded-md text-xs">
                  <span className="font-semibold text-brand-900 block mb-1">
                    Administrative Override: {selectedEvidenceCandidate.override_status}
                  </span>
                  <p className="text-brand-800">
                    Justification: {selectedEvidenceCandidate.override_reason}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end pt-3 border-t border-border">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setSelectedEvidenceCandidate(null)}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 3. Candidate Override Modal */}
      {selectedOverrideCandidate && (
        <div className="modal-backdrop" style={modalOverlayStyle}>
          <div
            className="modal-card"
            style={modalCardStyle}
            role="dialog"
            aria-modal="true"
            aria-labelledby="override-dialog-title"
          >
            <h3 id="override-dialog-title" className="text-lg font-bold mb-1 text-foreground">
              Override Candidate Eligibility — {selectedOverrideCandidate.student_name}
            </h3>
            <p className="text-xs text-muted mb-4 font-mono">
              Admission: {selectedOverrideCandidate.admission_number} | Evaluated Status: {selectedOverrideCandidate.evaluation_status}
            </p>

            <form onSubmit={(e) => { void handleSaveOverride(e); }} className="space-y-4">
              <div>
                <label htmlFor="override-choice-select" className="block text-xs font-medium text-muted mb-1">
                  Override Decision
                </label>
                <select
                  id="override-choice-select"
                  value={overrideStatusChoice}
                  onChange={(e) => setOverrideStatusChoice(e.target.value as OverrideStatus)}
                  className="w-full h-9 px-2 text-sm rounded border border-input bg-surface"
                >
                  <option value="NONE">NONE (Revert to Evaluated Status)</option>
                  <option value="EXEMPTED">EXEMPTED (Administrative Waiver / Medical / Sports)</option>
                  <option value="CONDITIONAL_APPROVAL">CONDITIONAL APPROVAL (Provisional Admit)</option>
                  <option value="DISQUALIFIED">DISQUALIFIED (Disciplinary / Barred)</option>
                </select>
              </div>

              <div>
                <label htmlFor="override-reason-input" className="block text-xs font-medium text-muted mb-1">
                  Override Justification / Reason (Mandatory)
                </label>
                <textarea
                  id="override-reason-input"
                  rows={3}
                  value={overrideReasonInput}
                  onChange={(e) => setOverrideReasonInput(e.target.value)}
                  placeholder="e.g. Approved medical leave sanctioned by Dean of Academic Affairs (Ref #412)"
                  required
                  className="w-full px-3 py-2 text-sm rounded-md border border-input bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={savingOverride}
                  onClick={() => setSelectedOverrideCandidate(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={savingOverride}
                >
                  {savingOverride ? 'Applying...' : 'Apply Override'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
