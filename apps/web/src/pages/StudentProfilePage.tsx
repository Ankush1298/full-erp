import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import type { ApiClient } from '../lib/api/client';
import { isApiError } from '../lib/api/errors';
import { studentReadMessage } from '../lib/api/messages';
import { fetchStudentEnrollments, fetchTerms, type TermEnrollment } from '../lib/api/academics-api';
import {
  fetchStudent,
  fetchStudentIdentifiers,
  type StudentIdentifier,
  type StudentRecord,
} from '../lib/api/students-api';
import { ForbiddenPage } from './StatePages';
import { statusLabel } from './StudentsPage';

type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; message: string };

/** One read-only section: loads once, shows its own loading / error / retry state. */
function useSection<T>(load: () => Promise<T>, subject: string) {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const run = useCallback(() => {
    let live = true;
    setState({ kind: 'loading' });
    load()
      .then((data) => {
        if (live) setState({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) setState({ kind: 'error', message: studentReadMessage(err, subject) });
      });
    return () => {
      live = false;
    };
  }, [load, subject]);
  useEffect(run, [run]);
  return { state, retry: run };
}

function SectionState<T>({
  state,
  retry,
  label,
  children,
}: {
  state: Load<T>;
  retry: () => void;
  label: string;
  children: (data: T) => React.ReactNode;
}) {
  if (state.kind === 'loading') return <Spinner label={`Loading ${label}…`} />;
  if (state.kind === 'error')
    return (
      <div>
        <Alert tone="error">{state.message}</Alert>
        <Button type="button" variant="secondary" onClick={retry}>
          Retry {label}
        </Button>
      </div>
    );
  return <>{children(state.data)}</>;
}

const ID_TYPE_LABELS: Record<StudentIdentifier['idType'], string> = {
  UNIVERSITY_PRN: 'University PRN',
  APAAR: 'APAAR ID',
  LIBRARY_CARD: 'Library card',
  HOSTEL_ID: 'Hostel ID',
  OTHER: 'Other',
};

function validity(i: StudentIdentifier): string {
  if (!i.validFrom && !i.validTo) return 'Not specified';
  return `${i.validFrom ?? '…'} to ${i.validTo ?? 'open'}`;
}

function IdentifiersCard({ client, studentId }: { client: ApiClient; studentId: string }) {
  const { state, retry } = useSection(
    useCallback(() => fetchStudentIdentifiers(client, studentId), [client, studentId]),
    'Identifiers',
  );
  return (
    <Card title="Identifiers">
      <SectionState state={state} retry={retry} label="identifiers">
        {(rows) =>
          rows.length === 0 ? (
            <p className="field-hint">No identifiers are recorded for this student.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" aria-label="Identifiers">
                <thead>
                  <tr>
                    <th scope="col">Type</th>
                    <th scope="col">Value</th>
                    <th scope="col">Issuer</th>
                    <th scope="col">Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i) => (
                    <tr key={i.id}>
                      <td>{ID_TYPE_LABELS[i.idType]}</td>
                      <td>{i.value}</td>
                      <td>{i.issuer ?? 'Not specified'}</td>
                      <td>{validity(i)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </SectionState>
    </Card>
  );
}

/**
 * Term names come from GET /academics/terms only when the account holds academic.program.read; that list is scoped by the
 * server, so a term it does not return is shown as unavailable. A failure here is its own section state with its own retry:
 * the enrolments stay visible.
 */
function EnrolmentTable({
  client,
  rows,
  canReadTerms,
}: {
  client: ApiClient;
  rows: TermEnrollment[];
  canReadTerms: boolean;
}) {
  const terms = useSection(
    useCallback(
      () =>
        canReadTerms
          ? fetchTerms(client).then(
              (ts) => new Map(ts.map((t) => [t.id, `${t.name} (${t.code})`] as const)),
            )
          : Promise.resolve(new Map<string, string>()),
      [client, canReadTerms],
    ),
    'Term details',
  );
  const names = terms.state.kind === 'ready' ? terms.state.data : new Map<string, string>();
  // Without the permission nothing is fetched, so the cell never claims to be loading.
  const missing =
    canReadTerms && terms.state.kind === 'loading' ? 'Loading…' : 'Term details unavailable';
  return (
    <>
      {terms.state.kind === 'error' ? (
        <div>
          <Alert tone="error">{terms.state.message}</Alert>
          <Button type="button" variant="secondary" onClick={terms.retry}>
            Retry term details
          </Button>
        </div>
      ) : null}
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" aria-label="Term enrolments">
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Period</th>
              <th scope="col">Status</th>
              <th scope="col">Type</th>
              <th scope="col">Roll number</th>
              <th scope="col">Section</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{names.get(e.termId) ?? missing}</td>
                <td>{e.periodNo}</td>
                <td>{statusLabel(e.status)}</td>
                <td>{statusLabel(e.enrollmentType)}</td>
                <td>{e.rollNumber ?? 'Not assigned'}</td>
                <td>
                  {e.currentSection
                    ? `${e.currentSection.name} (from ${e.currentSection.validFrom})`
                    : 'Not placed'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Term enrolments (GET /students/:id/term-enrollments); the server returns only enrolments inside the caller's scope. */
function EnrolmentsCard({
  client,
  studentId,
  canReadTerms,
}: {
  client: ApiClient;
  studentId: string;
  canReadTerms: boolean;
}) {
  const { state, retry } = useSection(
    useCallback(() => fetchStudentEnrollments(client, studentId), [client, studentId]),
    'Term enrolments',
  );
  return (
    <Card title="Term enrolments">
      <SectionState state={state} retry={retry} label="term enrolments">
        {(rows) =>
          rows.length === 0 ? (
            <p className="field-hint">No term enrolments are recorded for this student.</p>
          ) : (
            <EnrolmentTable client={client} rows={rows} canReadTerms={canReadTerms} />
          )
        }
      </SectionState>
    </Card>
  );
}

type RecordState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: StudentRecord }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

/** Read-only student profile. Shows only what the authorised endpoints return; no editing, no guardians. */
export function StudentProfilePage() {
  const { id = '' } = useParams();
  const { client, identity } = useAuth();
  const [record, setRecord] = useState<RecordState>({ kind: 'loading' });
  usePageTitle(
    record.kind === 'ready' ? `Student ${record.data.admissionNumber}` : 'Student profile',
  );

  const load = useCallback(() => {
    let live = true;
    setRecord({ kind: 'loading' });
    fetchStudent(client, id)
      .then((data) => {
        if (live) setRecord({ kind: 'ready', data });
      })
      .catch((err: unknown) => {
        if (!live) return;
        // A malformed id (400) is treated like a missing record: nothing about other records is revealed.
        if (isApiError(err) && (err.kind === 'not_found' || err.kind === 'validation'))
          setRecord({ kind: 'not_found' });
        else if (isApiError(err) && err.kind === 'forbidden') setRecord({ kind: 'forbidden' });
        else setRecord({ kind: 'error', message: studentReadMessage(err, 'The student record') });
      });
    return () => {
      live = false;
    };
  }, [client, id]);
  useEffect(load, [load]);

  if (record.kind === 'forbidden') return <ForbiddenPage />;

  const back = (
    <p>
      <Link to="/students">Back to students</Link>
    </p>
  );

  if (record.kind === 'loading') return <Spinner label="Loading student…" />;
  if (record.kind === 'not_found')
    return (
      <>
        <h1>Student not found</h1>
        <p>No student was found, or the record is outside your access.</p>
        {back}
      </>
    );
  if (record.kind === 'error')
    return (
      <>
        <h1>Student profile</h1>
        <Alert tone="error">{record.message}</Alert>
        <Button type="button" variant="secondary" onClick={load}>
          Retry
        </Button>
        {back}
      </>
    );

  const s = record.data;
  const canIdentifiers = Boolean(identity && can(identity, 'student.profile.read_sensitive'));
  const canEnrolments = Boolean(identity && can(identity, 'enrollment.term.read'));
  const canReadTerms = Boolean(identity && can(identity, 'academic.program.read'));

  return (
    <>
      {back}
      <h1>Student {s.admissionNumber}</h1>
      <Card title="Record">
        <dl className="defs">
          <dt>Admission number</dt>
          <dd>{s.admissionNumber}</dd>
          <dt>Status</dt>
          <dd>
            <Badge>{statusLabel(s.status)}</Badge>
          </dd>
          <dt>Status since</dt>
          <dd>{s.statusChangedAt ? s.statusChangedAt.slice(0, 10) : 'Not recorded'}</dd>
          <dt>Admission date</dt>
          <dd>{s.admissionDate ?? 'Not recorded'}</dd>
        </dl>
      </Card>
      {canIdentifiers ? <IdentifiersCard client={client} studentId={s.id} /> : null}
      {canEnrolments ? (
        <EnrolmentsCard client={client} studentId={s.id} canReadTerms={canReadTerms} />
      ) : null}
      {!canIdentifiers || !canEnrolments ? (
        <p className="field-hint">
          Some sections are not shown because your account does not include access to them.
        </p>
      ) : null}
    </>
  );
}
