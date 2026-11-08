import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError } from '../lib/api/errors';
import { fetchCampuses, type CampusItem } from '../lib/api/organisation-api';
import { fetchTerminologyDetail, type TerminologyDetail } from '../lib/api/academics-api';
import {
  DIRECTORY_REJECTED_MESSAGE,
  directoryFailure,
  studentReadMessage,
} from '../lib/api/messages';
import {
  ADMISSION_NUMBER_RE,
  createStudent,
  fetchStudentDirectory,
  lookupStudent,
  STUDENT_STATUSES,
  type CreateStudentPayload,
  type StudentDirectoryEntry,
  type StudentStatus,
} from '../lib/api/students-api';

export function statusLabel(status: string): string {
  const words = status.toLowerCase().replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function StudentTable({ label, rows }: { label: string; rows: StudentDirectoryEntry[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Admission number</th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Profile</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.admissionNumber}</td>
              <td>{s.displayName}</td>
              <td>
                <StatusBadge status={s.status} label={statusLabel(s.status)} />
              </td>
              <td>
                <Link
                  to={`/students/${encodeURIComponent(s.id)}`}
                  aria-label={`Open profile of ${s.admissionNumber}`}
                >
                  Open profile
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type DirectoryState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

/**
 * Paginated staff directory (GET /students/directory). Only the server decides who is listed (placed students inside the
 * caller's student.directory.list scopes). One page is held at a time plus whatever "Load more" appended; the cursor lives
 * in component state only.
 */
function DirectoryCard() {
  const { client } = useAuth();
  const selectId = useId();
  const [status, setStatus] = useState<'ALL' | StudentStatus>('ALL');
  const [rows, setRows] = useState<StudentDirectoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<DirectoryState>({ kind: 'loading' });
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Ignores answers to superseded requests (filter changed while a page was in flight).
  const seq = useRef(0);

  const loadFirst = useCallback(
    (filter: 'ALL' | StudentStatus) => {
      const mine = ++seq.current;
      setState({ kind: 'loading' });
      setRows([]);
      setNextCursor(null);
      setMoreError(null);
      // A superseded "Load more" never clears its own flag (its answer is ignored), so reset it here.
      setLoadingMore(false);
      fetchStudentDirectory(client, { status: filter === 'ALL' ? undefined : filter })
        .then((page) => {
          if (mine !== seq.current) return;
          setRows(page.entries);
          setNextCursor(page.nextCursor);
          setState({ kind: 'ready' });
        })
        .catch((err: unknown) => {
          if (mine !== seq.current) return;
          setState({
            kind: 'error',
            message:
              directoryFailure(err) === 'rejected'
                ? DIRECTORY_REJECTED_MESSAGE
                : studentReadMessage(err, 'The student directory'),
          });
        });
    },
    [client],
  );

  useEffect(() => {
    loadFirst(status);
  }, [loadFirst, status]);

  const loadMore = () => {
    if (!nextCursor) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(null);
    fetchStudentDirectory(client, {
      status: status === 'ALL' ? undefined : status,
      cursor: nextCursor,
    })
      .then((page) => {
        if (mine !== seq.current) return;
        setRows((prev) => [...prev, ...page.entries]);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setMoreError(
          directoryFailure(err) === 'cursor'
            ? 'The list position has expired. Start again from the first page.'
            : directoryFailure(err) === 'rejected'
              ? DIRECTORY_REJECTED_MESSAGE
              : studentReadMessage(err, 'The next page'),
        );
      })
      .finally(() => {
        if (mine === seq.current) setLoadingMore(false);
      });
  };

  return (
    <Card title="Student directory">
      <p className="field-hint">
        Lists students with an active programme enrolment inside your access, ordered by admission
        number.
      </p>
      <div className="field" style={{ maxWidth: '16rem' }}>
        <label htmlFor={selectId}>Filter by status</label>
        <select
          id={selectId}
          value={status}
          onChange={(e) => setStatus(e.target.value as 'ALL' | StudentStatus)}
        >
          <option value="ALL">All statuses</option>
          {STUDENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {state.kind === 'loading' ? <Spinner label="Loading students…" /> : null}
      {state.kind === 'error' ? (
        <ErrorState
          title="Student directory error"
          message={state.message}
          onRetry={() => loadFirst(status)}
          retryLabel="Retry"
        />
      ) : null}
      {state.kind === 'ready' && rows.length === 0 ? (
        <EmptyState
          title="No students found"
          description="No students to show."
          compact
        />
      ) : null}
      {state.kind === 'ready' && rows.length > 0 ? (
        <StudentTable label="Student directory" rows={rows} />
      ) : null}
      {state.kind === 'ready' && moreError ? (
        <ErrorState
          title="Next page error"
          message={moreError}
          onRetry={() => loadFirst(status)}
          retryLabel="Start again"
        />
      ) : null}
      {state.kind === 'ready' && nextCursor && !moreError ? (
        <Button type="button" variant="secondary" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more students'}
        </Button>
      ) : null}
    </Card>
  );
}

/** Exact admission-number lookup (GET /students?admissionNumber=): at most one result, no name search. */
function SearchCard() {
  const { client } = useAuth();
  const [value, setValue] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<StudentDirectoryEntry | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!ADMISSION_NUMBER_RE.test(q)) {
      setFieldError('Enter an admission number: letters, digits, "-" or "_", up to 50 characters.');
      return;
    }
    setFieldError(null);
    setPending(true);
    setResult(null);
    setMessage(null);
    lookupStudent(client, q)
      .then(setResult)
      .catch((err: unknown) => {
        if (isApiError(err) && err.kind === 'not_found') {
          setMessage({ tone: 'info', text: studentReadMessage(err, 'The student') });
        } else {
          setMessage({ tone: 'error', text: studentReadMessage(err, 'The student') });
        }
      })
      .finally(() => setPending(false));
  };

  return (
    <Card title="Find by admission number">
      <form onSubmit={submit} noValidate>
        <TextField
          label="Admission number"
          name="admissionNumber"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={fieldError ?? undefined}
          hint="Exact match only, case-sensitive."
        />
        <Button type="submit" disabled={pending}>
          {pending ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {result ? <StudentTable label="Search result" rows={[result]} /> : null}
    </Card>
  );
}

function AdmissionsCard({
  institutionType,
  onStudentCreated,
}: {
  institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY' | null;
  onStudentCreated?: () => void;
}) {
  const { client } = useAuth();
  const campusSelectId = useId();
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [userId, setUserId] = useState('');
  const [admissionNumber, setAdmissionNumber] = useState('');
  const [admissionDate, setAdmissionDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [campusId, setCampusId] = useState('');
  const [reason, setReason] = useState('Admission registration');
  // Matching probes
  const [name, setName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');

  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);

  useEffect(() => {
    fetchCampuses(client)
      .then((list) => {
        setCampuses(list);
        if (list.length === 1 && list[0]) {
          setCampusId(list[0].id);
        }
      })
      .catch(() => {
        // If campus list fails or user lacks org.structure.read, continue with manual or org-level
      });
  }, [client]);

  const isSchool = institutionType === 'SCHOOL';
  const isUniversity = institutionType === 'UNIVERSITY';

  const cardTitle = isSchool ? 'New admission' : isUniversity ? 'Register student' : 'Admit student';
  const personLabel = isSchool ? 'pupil' : 'student';
  const submitLabel = isSchool ? 'Confirm admission' : 'Register student';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessId(null);

    if (!userId.trim()) {
      setError('User account ID is required.');
      return;
    }
    if (!ADMISSION_NUMBER_RE.test(admissionNumber.trim())) {
      setError('Admission number must be 1 to 50 letters, digits, "-" or "_".');
      return;
    }
    if (!admissionDate.trim()) {
      setError('Admission date is required.');
      return;
    }

    setPending(true);
    try {
      const payload: CreateStudentPayload = {
        userId: userId.trim(),
        admissionNumber: admissionNumber.trim(),
        admissionDate: admissionDate.trim(),
        reason: reason.trim() || 'Admission registration',
        ...(campusId ? { campusId } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(dateOfBirth.trim() ? { dateOfBirth: dateOfBirth.trim() } : {}),
        ...(guardianPhone.trim() ? { guardianPhone: guardianPhone.trim() } : {}),
        ...(acknowledged && duplicateWarning ? { duplicateAcknowledgement: duplicateWarning } : {}),
      };

      const res = await createStudent(client, payload);
      setSuccessId(res.id);
      setDuplicateWarning(null);
      setAcknowledged(false);
      setUserId('');
      setAdmissionNumber('');
      onStudentCreated?.();
    } catch (err: unknown) {
      if (isApiError(err)) {
        if (err.status === 409) {
          setError(
            `A conflict or duplicate ${personLabel} record was detected (${err.code ?? 'CONFLICT'}). Please verify applicant identity.`,
          );
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : `Failed to register ${personLabel}.`);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title={cardTitle}>
      <p className="field-hint">
        {isSchool
          ? 'Admit a pupil to this school or campus. Enrolment into classes and login issuance remain separate steps.'
          : isUniversity
            ? 'Register an admitted student under your authorized campus. Academic enrolment and logins remain separate steps.'
            : 'Register an admitted student for the selected campus. Programme enrolment and logins remain separate steps.'}
      </p>
      <form onSubmit={(e) => { void handleSubmit(e); }} noValidate>
        <TextField
          label="User account ID (UUID)"
          name="userId"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          hint="The active user account for this person."
          required
        />
        <TextField
          label="Admission number"
          name="admissionNumber"
          value={admissionNumber}
          onChange={(e) => setAdmissionNumber(e.target.value)}
          hint='1 to 50 letters, digits, "-" or "_". Unique across the institution.'
          required
        />
        <TextField
          label="Admission date"
          name="admissionDate"
          type="date"
          value={admissionDate}
          onChange={(e) => setAdmissionDate(e.target.value)}
          required
        />
        {campuses.length > 0 ? (
          <div className="field" style={{ maxWidth: '24rem' }}>
            <label htmlFor={campusSelectId}>
              {isSchool ? 'School / Campus' : isUniversity ? 'University Campus / College' : 'Campus'}
            </label>
            <select
              id={campusSelectId}
              value={campusId}
              onChange={(e) => setCampusId(e.target.value)}
            >
              <option value="">Institution-wide (default)</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <TextField
          label="Reason for admission"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Audit trail reason (1 to 500 characters)."
          required
        />

        <details style={{ marginTop: '1rem', marginBottom: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
            Duplicate detection probes (optional)
          </summary>
          <p className="field-hint" style={{ marginTop: '0.5rem' }}>
            Used strictly for duplicate detection and never persisted on the student record.
          </p>
          <TextField
            label="Full name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <TextField
            label="Date of birth"
            name="dateOfBirth"
            type="date"
            value={dateOfBirth}
            onChange={(e) => setDateOfBirth(e.target.value)}
          />
          <TextField
            label="Guardian phone"
            name="guardianPhone"
            value={guardianPhone}
            onChange={(e) => setGuardianPhone(e.target.value)}
          />
        </details>

        {duplicateWarning ? (
          <div style={{ marginBottom: '1rem' }}>
            <Alert tone="info">
              Potential duplicate {personLabel} identified. Check the box below if you have verified
              that this is a distinct applicant and wish to acknowledge the warning.
            </Alert>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>I confirm that I have reviewed the duplicate alert and authorize admission.</span>
            </label>
          </div>
        ) : null}

        {error ? <Alert tone="error">{error}</Alert> : null}
        {successId ? (
          <Alert tone="success">
            {isSchool ? 'Pupil' : 'Student'} successfully admitted (ID: {successId}).{' '}
            <Link to={`/students/${encodeURIComponent(successId)}`}>Open profile</Link>
          </Alert>
        ) : null}

        <Button type="submit" disabled={pending || (Boolean(duplicateWarning) && !acknowledged)}>
          {pending ? 'Submitting…' : submitLabel}
        </Button>
      </form>
    </Card>
  );
}

export function StudentsPage() {
  const { identity, client } = useAuth();
  const [terminology, setTerminology] = useState<TerminologyDetail | null>(null);

  useEffect(() => {
    fetchTerminologyDetail(client)
      .then(setTerminology)
      .catch(() => {});
  }, [client]);

  const instType = terminology?.institutionType ?? null;
  const isSchool = instType === 'SCHOOL';
  const pageTitle = isSchool ? 'Pupils & Admissions' : 'Students & Admissions';
  usePageTitle(pageTitle);

  const canCreate = Boolean(identity && can(identity, 'student.record.create'));
  const canList = Boolean(identity && can(identity, 'student.directory.list'));
  const canSearch = Boolean(identity && can(identity, 'student.directory.search'));

  const leadText = isSchool
    ? 'Manage school admissions and pupil records for your assigned school or campus.'
    : instType === 'UNIVERSITY'
      ? 'Manage university admissions and student records within your authorized campus.'
      : 'Manage college admissions and student records across campuses.';

  return (
    <>
      <PageHeader
        title={pageTitle}
        subtitle={leadText}
        badge={
          instType ? (
            <StatusBadge
              status={instType}
              tone="info"
              label={instType.charAt(0) + instType.slice(1).toLowerCase()}
            />
          ) : undefined
        }
      />
      {canList || canCreate ? (
        <div className="stat-grid" style={{ marginBottom: 'var(--space-4)' }}>
          <StatCard
            label="Institution Model"
            value={instType ? instType.charAt(0) + instType.slice(1).toLowerCase() : 'Standard'}
            tone="purple"
            helper="Configured operational model"
          />
          <StatCard
            label="Admissions Rights"
            value={canCreate ? 'Authorized' : 'Read Only'}
            tone={canCreate ? 'emerald' : 'amber'}
            helper={canCreate ? 'Can register new records' : 'Directory viewing access'}
          />
        </div>
      ) : null}
      {canCreate ? <AdmissionsCard institutionType={instType} /> : null}
      {canSearch ? <SearchCard /> : null}
      {canList ? <DirectoryCard /> : null}
      {!canList && !canSearch ? (
        <Alert tone="info">
          Your account can open individual student profiles but cannot list or search students.
        </Alert>
      ) : null}
    </>
  );
}
