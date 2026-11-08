import { Fragment, useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import type { ApiClient } from '../lib/api/client';
import { isApiError } from '../lib/api/errors';
import { studentReadMessage } from '../lib/api/messages';
import {
  DEFAULT_TERMINOLOGY,
  fetchStudentEnrollments,
  fetchTerminology,
  fetchTerms,
  type TermEnrollment,
  type Terminology,
} from '../lib/api/academics-api';
import {
  fetchStudent,
  fetchStudentIdentifiers,
  fetchStudentTimeline,
  type StudentIdentifier,
  type StudentRecord,
  type StudentTimeline,
  type TimelineEvent,
  type TimelineEventType,
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
      <ErrorState
        message={state.message}
        onRetry={retry}
        retryLabel={`Retry ${label}`}
        compact
      />
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
            <EmptyState
              title="No identifiers"
              description="No identifiers are recorded for this student."
              compact
            />
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
        <ErrorState
          message={terms.state.message}
          onRetry={terms.retry}
          retryLabel="Retry term details"
          compact
        />
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
                <td>
                  <StatusBadge status={e.status} label={statusLabel(e.status)} />
                </td>
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
            <EmptyState
              title="No term enrolments"
              description="No term enrolments are recorded for this student."
              compact
            />
          ) : (
            <EnrolmentTable client={client} rows={rows} canReadTerms={canReadTerms} />
          )
        }
      </SectionState>
    </Card>
  );
}

const EVENT_LABELS: Record<TimelineEventType, string> = {
  ADMISSION: 'Admission',
  STUDENT_STATUS_CHANGED: 'Status change',
  PROGRAMME_STARTED: 'Joined programme',
  PROGRAMME_ENDED: 'Left programme',
  TERM_ENROLLED: 'Term enrolment',
  REPEAT_ENROLLED: 'Repeat enrolment',
  SECTION_PLACED: 'Section placement',
  SECTION_TRANSFERRED: 'Section transfer',
  COURSE_REGISTERED: 'Course registration',
  COURSE_REREGISTERED: 'Course re-registration',
  COURSE_DROPPED: 'Course dropped',
  COURSE_WITHDRAWN: 'Course withdrawn',
  COURSE_COMPLETED: 'Course completed',
  COURSE_REJECTED: 'Registration rejected',
  PROMOTED: 'Promoted',
  DETAINED: 'Detained',
  TERM_COMPLETED: 'Term completed',
  TERM_WITHDRAWN: 'Withdrawn from term',
  TERM_ON_LEAVE: 'On leave',
};
const TEMPORAL_LABELS: Record<TimelineEvent['temporal'], string> = {
  CURRENT: 'In effect',
  HISTORICAL: 'Historical',
  UNDATED: 'Date not recorded',
};
const period = (label: string | null, no: number | null) =>
  no === null ? '—' : `${label ?? 'Period'} ${no}`;

/** Events as a table; the column headings use the institution's labels (display only). */
function EventsTable({
  rows,
  labels,
  caption,
}: {
  rows: TimelineEvent[];
  labels: Terminology;
  caption: string;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" aria-label={caption}>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Event</th>
            <th scope="col">{labels.program}</th>
            <th scope="col">
              {labels.term} / {labels.period}
            </th>
            <th scope="col">{labels.section}</th>
            <th scope="col">{labels.course}</th>
            <th scope="col">Details</th>
            <th scope="col">Current or historical</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{e.eventDate ?? 'Not recorded'}</td>
              <td>{EVENT_LABELS[e.eventType]}</td>
              <td>
                {e.programme
                  ? `${e.programme.name}${e.cohortName ? ` (${e.cohortName})` : ''}`
                  : '—'}
              </td>
              <td>{e.term ? `${e.term.name}, ${period(e.periodLabel, e.periodNo)}` : '—'}</td>
              <td>{e.section?.name ?? '—'}</td>
              <td>
                {e.course
                  ? `${e.course.code} ${e.course.title}${e.status ? ` (${statusLabel(e.status)})` : ''}`
                  : '—'}
              </td>
              <td>{e.description}</td>
              <td>
                <Badge>{TEMPORAL_LABELS[e.temporal]}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionView({ t, labels }: { t: StudentTimeline; labels: Terminology }) {
  const p = t.position;
  const status =
    p.admitted === false
      ? 'Not yet admitted'
      : p.studentStatus
        ? statusLabel(p.studentStatus)
        : 'Unknown on this date';
  return (
    <dl className="defs">
      <dt>Student status</dt>
      <dd>{status}</dd>
      <dt>{labels.program}</dt>
      <dd>
        {p.programme
          ? `${p.programme.name} (${p.programme.code}), ${labels.cohort} ${p.programme.cohortName}, since ${p.programme.startDate}`
          : `Not in a ${labels.program.toLowerCase()} on this date`}
      </dd>
      {p.terms.length === 0 ? (
        <>
          <dt>{labels.term}</dt>
          <dd>{`Not enrolled in a ${labels.term.toLowerCase()} on this date`}</dd>
        </>
      ) : (
        p.terms.map((e) => (
          <Fragment key={e.termEnrollmentId}>
            <dt>{labels.term}</dt>
            <dd>
              {e.term.name} ({e.term.startDate} to {e.term.endDate}):{' '}
              {period(e.periodLabel, e.periodNo)}
              {e.enrollmentType === 'REPEAT' ? ', repeat' : ''}
              {e.rollNumber ? `, roll ${e.rollNumber}` : ''}. Recorded status today:{' '}
              {statusLabel(e.recordedStatus)}
            </dd>
            <dt>{labels.section}</dt>
            <dd>
              {e.section
                ? `${e.section.name} (from ${e.section.validFrom})`
                : 'Not placed on this date'}
            </dd>
            <dt>{labels.course}s</dt>
            <dd>
              {e.registrations.length === 0 ? (
                'None in effect on this date'
              ) : (
                <ul>
                  {e.registrations.map((r) => (
                    <li key={r.registrationId}>
                      {r.code} {r.title}:{' '}
                      {r.statusOnDate === 'PENDING_APPROVAL' ? 'pending approval' : 'registered'}{' '}
                      (from {r.validFrom}
                      {r.validTo ? ` to ${r.validTo}` : ''})
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </Fragment>
        ))
      )}
    </dl>
  );
}

/**
 * Academic timeline and as-of-date position (GET /v1/students/:id/timeline, doc 34). Read-only. Rows outside the
 * reader's scope are never returned by the server; labels come from the institution's terminology (display only),
 * the period label (Grade / Year / Semester) from each programme's own period type.
 */
function TimelineCard({
  client,
  studentId,
  canReadTerms,
}: {
  client: ApiClient;
  studentId: string;
  canReadTerms: boolean;
}) {
  const [labels, setLabels] = useState<Terminology>(DEFAULT_TERMINOLOGY);
  useEffect(() => {
    if (!canReadTerms) return;
    let live = true;
    fetchTerminology(client)
      .then((t) => {
        if (live) setLabels(t);
      })
      .catch(() => undefined); // the server's fallbacks stay in place
    return () => {
      live = false;
    };
  }, [client, canReadTerms]);

  const [asOf, setAsOf] = useState(''); // '' = today on the campus calendar
  const [draft, setDraft] = useState('');
  const inputId = useId();
  const { state, retry } = useSection(
    useCallback(
      () => fetchStudentTimeline(client, studentId, asOf || undefined),
      [client, studentId, asOf],
    ),
    'The academic timeline',
  );
  const today = state.kind === 'ready' ? state.data.today : undefined;

  return (
    <Card title="Academic timeline">
      <form
        aria-label="Show the position on a date"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          setAsOf(draft === today ? '' : draft);
        }}
      >
        <div className="field" style={{ maxWidth: '16rem' }}>
          <label htmlFor={inputId}>Position as of</label>
          <input
            id={inputId}
            type="date"
            value={draft}
            max={today}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!draft}>
          Show
        </Button>{' '}
        {asOf ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setAsOf('');
              setDraft('');
            }}
          >
            Back to today
          </Button>
        ) : null}
      </form>
      <SectionState state={state} retry={retry} label="academic timeline">
        {(t) => (
          <>
            <h3>
              Position on {t.asOfDate}{' '}
              <Badge>{t.asOfDate === t.today ? 'Today' : 'Historical view'}</Badge>
            </h3>
            <PositionView t={t} labels={labels} />
            {t.limitations.length > 0 ? (
              <Alert tone="info">
                <strong>Incomplete history.</strong>
                <ul>
                  {t.limitations.map((l) => (
                    <li key={l.code}>{l.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <h3>Events up to {t.asOfDate}</h3>
            {t.events.length === 0 ? (
              <p className="field-hint">No events on or before this date.</p>
            ) : (
              <EventsTable rows={t.events} labels={labels} caption="Academic timeline" />
            )}
            {t.futureEventsExcluded > 0 ? (
              <p className="field-hint">
                {`${t.futureEventsExcluded} later ${t.futureEventsExcluded === 1 ? 'event is' : 'events are'} not shown.`}
              </p>
            ) : null}
            {t.undatedOutcomes.length > 0 ? (
              <>
                <h3>Recorded outcomes without a date</h3>
                <EventsTable
                  rows={t.undatedOutcomes}
                  labels={labels}
                  caption="Recorded outcomes without a date"
                />
              </>
            ) : null}
          </>
        )}
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
        <PageHeader
          title="Student profile"
          breadcrumbs={<Link to="/students">Back to students</Link>}
        />
        <ErrorState
          title="Student record error"
          message={record.message}
          onRetry={load}
          retryLabel="Retry"
        />
      </>
    );

  const s = record.data;
  const canIdentifiers = Boolean(identity && can(identity, 'student.profile.read_sensitive'));
  const canEnrolments = Boolean(identity && can(identity, 'enrollment.term.read'));
  const canReadTerms = Boolean(identity && can(identity, 'academic.program.read'));

  return (
    <>
      <PageHeader
        title={`Student ${s.admissionNumber}`}
        breadcrumbs={<Link to="/students">Back to students</Link>}
        badge={<StatusBadge status={s.status} label={statusLabel(s.status)} />}
      />
      <Card title="Record">
        <dl className="defs">
          <dt>Admission number</dt>
          <dd>{s.admissionNumber}</dd>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={s.status} label={statusLabel(s.status)} />
          </dd>
          <dt>Status since</dt>
          <dd>{s.statusChangedAt ? s.statusChangedAt.slice(0, 10) : 'Not recorded'}</dd>
          <dt>Admission date</dt>
          <dd>{s.admissionDate ?? 'Not recorded'}</dd>
        </dl>
      </Card>
      <TimelineCard client={client} studentId={s.id} canReadTerms={canReadTerms} />
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
