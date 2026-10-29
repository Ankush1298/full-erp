import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError } from '../lib/api/errors';
import {
  DIRECTORY_REJECTED_MESSAGE,
  directoryFailure,
  studentReadMessage,
} from '../lib/api/messages';
import {
  ADMISSION_NUMBER_RE,
  fetchStudentDirectory,
  lookupStudent,
  STUDENT_STATUSES,
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
                <Badge>{statusLabel(s.status)}</Badge>
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
        <div>
          <Alert tone="error">{state.message}</Alert>
          <Button type="button" variant="secondary" onClick={() => loadFirst(status)}>
            Retry
          </Button>
        </div>
      ) : null}
      {state.kind === 'ready' && rows.length === 0 ? (
        <p className="field-hint">No students to show.</p>
      ) : null}
      {state.kind === 'ready' && rows.length > 0 ? (
        <StudentTable label="Student directory" rows={rows} />
      ) : null}
      {state.kind === 'ready' && moreError ? (
        <div>
          <Alert tone="error">{moreError}</Alert>
          <Button type="button" variant="secondary" onClick={() => loadFirst(status)}>
            Start again
          </Button>
        </div>
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

export function StudentsPage() {
  usePageTitle('Students');
  const { identity } = useAuth();
  const canList = Boolean(identity && can(identity, 'student.directory.list'));
  const canSearch = Boolean(identity && can(identity, 'student.directory.search'));

  return (
    <>
      <h1>Students</h1>
      <p className="lead">Student records you are allowed to see. This view is read-only.</p>
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
