import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import {
  DEFAULT_TERMINOLOGY,
  assignClassTeacher,
  createAcademicYear,
  createCourse,
  createElectiveGroup,
  createFacultyAssignment,
  createHoliday,
  createOffering,
  createRegistration,
  createSection,
  createSlot,
  createTerm,
  createTermEnrollment,
  endClassTeacher,
  endFacultyAssignment,
  endSlot,
  fetchAcademicYears,
  fetchClassTeachers,
  fetchCohortPeriods,
  fetchCourses,
  fetchElectiveGroups,
  fetchEnrollmentRegistrations,
  fetchFacultyAssignments,
  fetchHolidays,
  fetchOfferingRegistrations,
  fetchOfferings,
  fetchRoster,
  fetchSections,
  fetchSetupChecklist,
  fetchSlots,
  fetchStudentEnrollments,
  fetchTerminologyDetail,
  fetchTerms,
  isLive,
  placeInSection,
  progressEnrollment,
  registerFromSection,
  setAcademicYearStatus,
  setTermStatus,
  updateElectiveGroup,
  updateHoliday,
  updateOffering,
  updateRegistration,
  type AcademicYear,
  type ChecklistItem,
  type ClassTeacher,
  type CohortPeriod,
  type Course,
  type ElectiveGroup,
  type FacultyAssignment,
  type Holiday,
  type Offering,
  type Registration,
  type RosterEntry,
  type Section,
  type Slot,
  type Term,
  type TermEnrollment,
  type Terminology,
} from '../lib/api/academics-api';
import { fetchCampuses, fetchRooms, type CampusItem } from '../lib/api/organisation-api';
import type { ApiClient } from '../lib/api/client';
import { isApiError } from '../lib/api/errors';
import { academicsErrorMessage } from '../lib/api/messages';
import {
  LabelsContext,
  PeriodLabelsContext,
  lower,
  plural,
  useLabels,
  usePeriodLabel,
} from '../lib/terminology';
import { SetupWizardTab } from './AcademicSetupWizard';

type Tab =
  | 'calendar'
  | 'courses'
  | 'sections'
  | 'offerings'
  | 'enrolment'
  | 'electives'
  | 'holidays'
  | 'wizard'
  | 'setup';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fixed wording for a refusal the page can explain from what it already shows (a full offering, a closed window, a
 * locked term). The server's text is never shown and stays authoritative: these only name the likely cause.
 */
interface Hints {
  conflict?: string;
  forbidden?: string;
}
function hinted(err: unknown, hints?: Hints): string {
  if (hints?.conflict && isApiError(err) && err.status === 409) return hints.conflict;
  if (hints?.forbidden && isApiError(err) && err.kind === 'forbidden') return hints.forbidden;
  return academicsErrorMessage(err);
}

/** Runs a mutation with a pending flag, a success notice and a fixed-wording error. */
function useAction(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<unknown>, success: string, hints?: Hints): Promise<boolean> => {
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(success);
        onDone();
        return true;
      } catch (err) {
        setError(hinted(err, hints));
        return false;
      } finally {
        setPending(false);
      }
    },
    [onDone],
  );
  return { pending, error, notice, run };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}
    </>
  );
}

/** Loads a list with loading / error / retry states. */
function useList<T>(load: () => Promise<T[]>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    load()
      .then((r) => setItems(r))
      .catch((err: unknown) => setError(academicsErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [load]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { items, loading, error, reload };
}

function ListState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyText,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyText: string;
  onRetry: () => void;
}) {
  if (loading) return <Spinner label="Loading…" />;
  if (error) {
    return (
      <Alert tone="error">
        {error}{' '}
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      </Alert>
    );
  }
  if (empty) {
    return (
      <Card title={emptyTitle}>
        <p className="muted">{emptyText}</p>
      </Card>
    );
  }
  return null;
}

const PAGE_SIZE = 20;
/** Client-side pages over a list the server returns whole. */
function usePaged<T>(items: T[]) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  return { rows: items.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE), page: at, pages, setPage };
}
function Pager({
  label,
  page,
  pages,
  setPage,
}: {
  label: string;
  page: number;
  pages: number;
  setPage: (n: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label={label}
      style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
    >
      <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
        Previous page
      </Button>
      <span aria-live="polite">
        Page {page + 1} of {pages}
      </span>
      <Button variant="secondary" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
        Next page
      </Button>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function CalendarTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
  const L = useLabels();
  const years = useList<AcademicYear>(useCallback(() => fetchAcademicYears(client), [client]));
  const terms = useList<Term>(useCallback(() => fetchTerms(client), [client]));
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  useEffect(() => {
    if (canManage)
      fetchCampuses(client)
        .then(setCampuses)
        .catch(() => setCampuses([]));
  }, [client, canManage]);
  const refresh = useCallback(() => {
    years.reload();
    terms.reload();
  }, [years, terms]);
  const action = useAction(refresh);

  const [label, setLabel] = useState('');
  const [yStart, setYStart] = useState('');
  const [yEnd, setYEnd] = useState('');
  const [yErr, setYErr] = useState<string | null>(null);
  const submitYear = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !DATE.test(yStart) || !DATE.test(yEnd) || yEnd <= yStart) {
      setYErr('Enter a label and a start date before the end date (YYYY-MM-DD).');
      return;
    }
    setYErr(null);
    if (
      await action.run(
        () => createAcademicYear(client, { label: label.trim(), startDate: yStart, endDate: yEnd }),
        'Academic year created.',
      )
    ) {
      setLabel('');
      setYStart('');
      setYEnd('');
    }
  };

  const [tYear, setTYear] = useState('');
  const [tCampus, setTCampus] = useState('');
  const [tCode, setTCode] = useState('');
  const [tName, setTName] = useState('');
  const [tStart, setTStart] = useState('');
  const [tEnd, setTEnd] = useState('');
  const [tErr, setTErr] = useState<string | null>(null);
  const submitTerm = async (e: FormEvent) => {
    e.preventDefault();
    if (
      !tYear ||
      !tCampus ||
      !tCode.trim() ||
      !tName.trim() ||
      !DATE.test(tStart) ||
      !DATE.test(tEnd) ||
      tEnd <= tStart
    ) {
      setTErr('Choose a year and campus, enter a code and name, and valid dates (YYYY-MM-DD).');
      return;
    }
    setTErr(null);
    if (
      await action.run(
        () =>
          createTerm(client, {
            campusId: tCampus,
            academicYearId: tYear,
            code: tCode.trim(),
            name: tName.trim(),
            startDate: tStart,
            endDate: tEnd,
          }),
        'Term created.',
      )
    ) {
      setTCode('');
      setTName('');
    }
  };

  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>Academic years</h2>
      <ListState
        loading={years.loading}
        error={years.error}
        empty={years.items.length === 0}
        emptyTitle="No academic years"
        emptyText="No academic years have been created yet."
        onRetry={years.reload}
      />
      {years.items.length > 0 && (
        <div className="grid">
          {years.items.map((y) => (
            <Card key={y.id} title={y.label}>
              <Badge>{y.status}</Badge>
              <p className="muted">
                {y.startDate} to {y.endDate}
              </p>
              {canManage && y.status === 'PLANNED' && (
                <Button
                  pending={action.pending}
                  onClick={() =>
                    void action.run(
                      () => setAcademicYearStatus(client, y, 'ACTIVE'),
                      `${y.label} is now active.`,
                    )
                  }
                >
                  Activate {y.label}
                </Button>
              )}
              {canManage && y.status === 'ACTIVE' && (
                <Button
                  variant="secondary"
                  pending={action.pending}
                  onClick={() =>
                    void action.run(
                      () => setAcademicYearStatus(client, y, 'CLOSED'),
                      `${y.label} is now closed.`,
                    )
                  }
                >
                  Close {y.label}
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
      {canManage && (
        <form onSubmit={(e) => void submitYear(e)} noValidate aria-label="Create academic year">
          <h3>New academic year</h3>
          {yErr && <Alert tone="error">{yErr}</Alert>}
          <TextField
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={20}
          />
          <TextField
            label="Start date"
            placeholder="YYYY-MM-DD"
            value={yStart}
            onChange={(e) => setYStart(e.target.value)}
          />
          <TextField
            label="End date"
            placeholder="YYYY-MM-DD"
            value={yEnd}
            onChange={(e) => setYEnd(e.target.value)}
          />
          <Button type="submit" pending={action.pending}>
            Create academic year
          </Button>
        </form>
      )}

      <h2>{plural(L.term)}</h2>
      <ListState
        loading={terms.loading}
        error={terms.error}
        empty={terms.items.length === 0}
        emptyTitle="No terms"
        emptyText="No terms have been created yet."
        onRetry={terms.reload}
      />
      {terms.items.length > 0 && (
        <div className="grid">
          {terms.items.map((t) => (
            <Card key={t.id} title={`${t.code} - ${t.name}`}>
              <Badge>{t.status}</Badge>
              <p className="muted">
                {t.startDate} to {t.endDate}
              </p>
              {canManage && t.status === 'PLANNED' && (
                <Button
                  pending={action.pending}
                  onClick={() =>
                    void action.run(
                      () => setTermStatus(client, t, 'ACTIVE'),
                      `Term ${t.code} is now active.`,
                    )
                  }
                >
                  Activate term {t.code}
                </Button>
              )}
              {canManage && t.status === 'ACTIVE' && (
                <Button
                  variant="secondary"
                  pending={action.pending}
                  onClick={() =>
                    void action.run(
                      () => setTermStatus(client, t, 'CLOSED'),
                      `Term ${t.code} is now closed.`,
                    )
                  }
                >
                  Close term {t.code}
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
      {canManage && (
        <form onSubmit={(e) => void submitTerm(e)} noValidate aria-label="Create term">
          <h3>New {lower(L.term)}</h3>
          {tErr && <Alert tone="error">{tErr}</Alert>}
          <div className="field">
            <label htmlFor="term-year">Academic year</label>
            <select id="term-year" value={tYear} onChange={(e) => setTYear(e.target.value)}>
              <option value="">Select…</option>
              {years.items
                .filter((y) => y.status !== 'CLOSED')
                .map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.label}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="term-campus">Campus</label>
            <select id="term-campus" value={tCampus} onChange={(e) => setTCampus(e.target.value)}>
              <option value="">Select…</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Term code"
            value={tCode}
            onChange={(e) => setTCode(e.target.value)}
            maxLength={30}
          />
          <TextField
            label="Term name"
            value={tName}
            onChange={(e) => setTName(e.target.value)}
            maxLength={255}
          />
          <TextField
            label="Term start date"
            placeholder="YYYY-MM-DD"
            value={tStart}
            onChange={(e) => setTStart(e.target.value)}
          />
          <TextField
            label="Term end date"
            placeholder="YYYY-MM-DD"
            value={tEnd}
            onChange={(e) => setTEnd(e.target.value)}
          />
          <Button type="submit" pending={action.pending}>
            Create term
          </Button>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function CoursesTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
  const L = useLabels();
  const courses = useList<Course>(useCallback(() => fetchCourses(client), [client]));
  const action = useAction(courses.reload);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [credits, setCredits] = useState('3');
  const [type, setType] = useState('THEORY');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(credits);
    if (
      !code.trim() ||
      !title.trim() ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > 99.9 ||
      Math.abs(n * 10 - Math.round(n * 10)) > 1e-9
    ) {
      setErr(
        'Enter a code, a title and credits between 0 and 99.9 with at most one decimal place.',
      );
      return;
    }
    setErr(null);
    if (
      await action.run(
        () =>
          createCourse(client, {
            code: code.trim(),
            title: title.trim(),
            credits: n,
            courseType: type,
          }),
        'Course created.',
      )
    ) {
      setCode('');
      setTitle('');
    }
  };
  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>{plural(L.course)}</h2>
      <ListState
        loading={courses.loading}
        error={courses.error}
        empty={courses.items.length === 0}
        emptyTitle="No courses"
        emptyText="No courses are in the catalogue yet."
        onRetry={courses.reload}
      />
      {courses.items.length > 0 && (
        <div className="grid">
          {courses.items.map((c) => (
            <Card key={c.id} title={`${c.code} - ${c.title}`}>
              <Badge>{c.status}</Badge>
              <dl className="defs">
                <dt>Credits</dt>
                <dd>{c.credits}</dd>
                <dt>Type</dt>
                <dd>{c.courseType}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
      {canManage && (
        <form onSubmit={(e) => void submit(e)} noValidate aria-label="Create course">
          <h3>New {lower(L.course)}</h3>
          {err && <Alert tone="error">{err}</Alert>}
          <TextField
            label="Course code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={30}
          />
          <TextField
            label="Course title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={255}
          />
          <TextField
            label="Credits"
            value={credits}
            onChange={(e) => setCredits(e.target.value)}
            inputMode="decimal"
          />
          <div className="field">
            <label htmlFor="course-type">Course type</label>
            <select id="course-type" value={type} onChange={(e) => setType(e.target.value)}>
              {[
                'THEORY',
                'PRACTICAL',
                'THEORY_PRACTICAL',
                'PROJECT',
                'INTERNSHIP',
                'SEMINAR',
                'AUDIT',
                'OTHER',
              ].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" pending={action.pending}>
            Create course
          </Button>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function SectionsTab({
  client,
  canManage,
  canRoster,
  canAssign,
}: {
  client: ApiClient;
  canManage: boolean;
  canRoster: boolean;
  canAssign: boolean;
}) {
  const L = useLabels();
  const periodLabel = usePeriodLabel();
  const periods = useList<CohortPeriod>(useCallback(() => fetchCohortPeriods(client), [client]));
  const sections = useList<Section>(useCallback(() => fetchSections(client), [client]));
  const action = useAction(sections.reload);
  const [period, setPeriod] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [roster, setRoster] = useState<{ section: Section; entries: RosterEntry[] } | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [teachersOf, setTeachersOf] = useState<Section | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cap = capacity.trim() === '' ? undefined : Number(capacity);
    if (
      !period ||
      !name.trim() ||
      (cap !== undefined && (!Number.isInteger(cap) || cap < 1 || cap > 10000))
    ) {
      setErr('Choose a cohort period, enter a name and an optional whole-number capacity.');
      return;
    }
    setErr(null);
    if (
      await action.run(
        () =>
          createSection(client, {
            cohortPeriodId: period,
            name: name.trim(),
            ...(cap !== undefined ? { capacity: cap } : {}),
          }),
        'Section created.',
      )
    ) {
      setName('');
      setCapacity('');
    }
  };
  const showRoster = (section: Section) => {
    setRosterError(null);
    fetchRoster(client, section.id)
      .then((entries) => setRoster({ section, entries }))
      .catch((e: unknown) => setRosterError(academicsErrorMessage(e)));
  };

  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>{plural(L.section)}</h2>
      <ListState
        loading={sections.loading}
        error={sections.error}
        empty={sections.items.length === 0}
        emptyTitle="No sections"
        emptyText="No sections have been created yet."
        onRetry={sections.reload}
      />
      {sections.items.length > 0 && (
        <div className="grid">
          {sections.items.map((s) => (
            <Card key={s.id} title={`${L.section} ${s.name}`}>
              <Badge>{s.status}</Badge>
              <p className="muted">
                {s.memberCount} student{s.memberCount === 1 ? '' : 's'}
                {s.capacity !== null ? ` of ${s.capacity}` : ''}
              </p>
              {canRoster && (
                <Button variant="secondary" onClick={() => showRoster(s)}>
                  View roster for {s.name}
                </Button>
              )}
              {(canRoster || canAssign) && (
                <Button variant="secondary" onClick={() => setTeachersOf(s)}>
                  Class teachers of {s.name}
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
      {rosterError && <Alert tone="error">{rosterError}</Alert>}
      {roster && (
        <Card title={`Roster: section ${roster.section.name}`}>
          {roster.entries.length === 0 ? (
            <p className="muted">No students are placed in this section.</p>
          ) : (
            <ul>
              {roster.entries.map((r) => (
                <li key={r.termEnrollmentId}>
                  {r.rollNumber ?? 'No roll number'} - student {r.studentId} (from {r.validFrom})
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {teachersOf && (
        <ClassTeachersPanel
          key={teachersOf.id}
          client={client}
          section={teachersOf}
          canAssign={canAssign}
        />
      )}
      {canManage && (
        <form onSubmit={(e) => void submit(e)} noValidate aria-label="Create section">
          <h3>New {lower(L.section)}</h3>
          {err && <Alert tone="error">{err}</Alert>}
          <div className="field">
            <label htmlFor="section-period">Cohort period</label>
            <select id="section-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">Select…</option>
              {periods.items
                .filter((p) => p.status === 'ACTIVE')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {periodLabel(p.cohortId)} {p.periodNo} ({p.id.slice(-6)})
                  </option>
                ))}
            </select>
          </div>
          <TextField
            label="Section name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={50}
          />
          <TextField
            label="Capacity (optional)"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            inputMode="numeric"
          />
          <Button type="submit" pending={action.pending}>
            Create section
          </Button>
        </form>
      )}
    </>
  );
}

/**
 * Class (homeroom) teachers of one section (doc 32): responsibility for the section, not a subject assignment. History is
 * listed (ended rows keep their dates); a change ends the current row and adds the successor. Teachers are shown by
 * employee-id suffix: no employee-name read model exists for this screen.
 */
function ClassTeachersPanel({
  client,
  section,
  canAssign,
}: {
  client: ApiClient;
  section: Section;
  canAssign: boolean;
}) {
  const rows = useList<ClassTeacher>(
    useCallback(() => fetchClassTeachers(client, section.id), [client, section.id]),
  );
  const action = useAction(rows.reload);
  const [form, setForm] = useState({ employee: '', role: 'PRIMARY', from: '', why: '' });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [end, setEnd] = useState({ id: '', to: '', why: '' });
  const [endErr, setEndErr] = useState<string | null>(null);

  const assign = async (e: FormEvent) => {
    e.preventDefault();
    if (!UUID.test(form.employee.trim()) || !DATE.test(form.from) || form.why.trim().length < 5) {
      setFormErr(
        'Enter the employee ID (a UUID), a start date (YYYY-MM-DD) and a reason of at least 5 characters.',
      );
      return;
    }
    setFormErr(null);
    await action.run(
      () =>
        assignClassTeacher(client, section.id, {
          employeeId: form.employee.trim(),
          classTeacherRole: form.role === 'ASSISTANT' ? 'ASSISTANT' : 'PRIMARY',
          validFrom: form.from,
          reason: form.why.trim(),
        }),
      'Class teacher assigned.',
    );
  };
  const finish = async (e: FormEvent) => {
    e.preventDefault();
    const row = rows.items.find((r) => r.id === end.id);
    if (!row || !DATE.test(end.to) || end.why.trim().length < 5) {
      setEndErr(
        'Choose a current class teacher, an end date (YYYY-MM-DD) and a reason of at least 5 characters.',
      );
      return;
    }
    setEndErr(null);
    await action.run(
      () => endClassTeacher(client, row, { validTo: end.to, reason: end.why.trim() }),
      'Class teacher assignment ended.',
    );
  };
  const current = rows.items.filter((r) => r.validTo === null);

  return (
    <Card title={`Class teachers: section ${section.name}`}>
      <Feedback error={action.error} notice={action.notice} />
      <ListState
        loading={rows.loading}
        error={rows.error}
        empty={rows.items.length === 0}
        emptyTitle="No class teacher"
        emptyText="No class teacher has been assigned to this section."
        onRetry={rows.reload}
      />
      {rows.items.length > 0 && (
        <ul>
          {rows.items.map((r) => (
            <li key={r.id}>
              {r.classTeacherRole === 'PRIMARY' ? 'Class teacher' : 'Assistant class teacher'} -
              employee …{r.employeeId.slice(-6)} from {r.validFrom}
              {r.validTo ? ` to ${r.validTo}` : ' (current)'}
            </li>
          ))}
        </ul>
      )}
      {canAssign && (
        <form onSubmit={(e) => void assign(e)} noValidate aria-label="Assign a class teacher">
          <h3>Assign a class teacher</h3>
          {formErr && <Alert tone="error">{formErr}</Alert>}
          <TextField
            label="Employee ID"
            value={form.employee}
            onChange={(e) => setForm({ ...form, employee: e.target.value })}
          />
          <div className="field">
            <label htmlFor="ct-role">Role</label>
            <select
              id="ct-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="PRIMARY">Class teacher</option>
              <option value="ASSISTANT">Assistant class teacher</option>
            </select>
          </div>
          <TextField
            label="From (YYYY-MM-DD)"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
          />
          <TextField
            label="Reason for the assignment"
            value={form.why}
            onChange={(e) => setForm({ ...form, why: e.target.value })}
            maxLength={500}
          />
          <Button type="submit" pending={action.pending}>
            Assign class teacher
          </Button>
        </form>
      )}
      {canAssign && current.length > 0 && (
        <form
          onSubmit={(e) => void finish(e)}
          noValidate
          aria-label="End a class teacher assignment"
        >
          <h3>End an assignment</h3>
          {endErr && <Alert tone="error">{endErr}</Alert>}
          <div className="field">
            <label htmlFor="ct-end">Current class teacher</label>
            <select
              id="ct-end"
              value={end.id}
              onChange={(e) => setEnd({ ...end, id: e.target.value })}
            >
              <option value="">Select…</option>
              {current.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.classTeacherRole === 'PRIMARY' ? 'Class teacher' : 'Assistant'} …
                  {r.employeeId.slice(-6)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Last day (YYYY-MM-DD)"
            value={end.to}
            onChange={(e) => setEnd({ ...end, to: e.target.value })}
          />
          <TextField
            label="Reason for ending"
            value={end.why}
            onChange={(e) => setEnd({ ...end, why: e.target.value })}
            maxLength={500}
          />
          <Button type="submit" pending={action.pending}>
            End assignment
          </Button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
function EnrolmentTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
  const L = useLabels();
  const periodLabel = usePeriodLabel();
  const periods = useList<CohortPeriod>(useCallback(() => fetchCohortPeriods(client), [client]));
  const cohortOf = (cohortPeriodId: string) =>
    periods.items.find((p) => p.id === cohortPeriodId)?.cohortId;
  const sections = useList<Section>(useCallback(() => fetchSections(client), [client]));
  const [studentId, setStudentId] = useState('');
  const [loaded, setLoaded] = useState<string | null>(null);
  const [rows, setRows] = useState<TermEnrollment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [idErr, setIdErr] = useState<string | null>(null);

  const reload = useCallback(
    (id: string) => {
      setLoading(true);
      setLoadError(null);
      fetchStudentEnrollments(client, id)
        .then((r) => {
          setRows(r);
          setLoaded(id);
        })
        .catch((e: unknown) => {
          setRows([]);
          setLoaded(null);
          setLoadError(academicsErrorMessage(e));
        })
        .finally(() => setLoading(false));
    },
    [client],
  );
  const action = useAction(() => {
    if (loaded) reload(loaded);
    sections.reload();
  });

  const load = (e: FormEvent) => {
    e.preventDefault();
    if (!UUID.test(studentId.trim())) {
      setIdErr('Enter the student ID (a UUID).');
      return;
    }
    setIdErr(null);
    reload(studentId.trim());
  };

  const [cp, setCp] = useState('');
  const [roll, setRoll] = useState('');
  const [reason, setReason] = useState('');
  const [enrolErr, setEnrolErr] = useState<string | null>(null);
  const enrol = async (e: FormEvent) => {
    e.preventDefault();
    if (!loaded || !cp || reason.trim().length < 5) {
      setEnrolErr(
        'Load a student, choose a cohort period and give a reason of at least 5 characters.',
      );
      return;
    }
    setEnrolErr(null);
    // One Idempotency-Key per submission: a double click or a retry replays instead of creating a second enrolment.
    const key = crypto.randomUUID();
    if (
      await action.run(
        () =>
          createTermEnrollment(
            client,
            loaded,
            {
              cohortPeriodId: cp,
              ...(roll.trim() ? { rollNumber: roll.trim() } : {}),
              reason: reason.trim(),
            },
            key,
          ),
        'Student enrolled for the term.',
      )
    ) {
      setRoll('');
      setReason('');
    }
  };

  const [place, setPlace] = useState<{
    enrollment: string;
    section: string;
    from: string;
    why: string;
  }>({
    enrollment: '',
    section: '',
    from: '',
    why: '',
  });
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [move, setMove] = useState({ enrollment: '', decision: 'PROMOTE', period: '', why: '' });
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const submitMove = async (e: FormEvent) => {
    e.preventDefault();
    if (!loaded || !move.enrollment || !move.period || move.why.trim().length < 5) {
      setMoveErr(
        'Choose an enrolment, a decision, the cohort period to move to and a reason of at least 5 characters.',
      );
      return;
    }
    setMoveErr(null);
    // One Idempotency-Key per submission, as for enrolment.
    await action.run(
      () =>
        progressEnrollment(
          client,
          loaded,
          move.enrollment,
          {
            decision: move.decision === 'REPEAT' ? 'REPEAT' : 'PROMOTE',
            cohortPeriodId: move.period,
            reason: move.why.trim(),
          },
          crypto.randomUUID(),
        ),
      move.decision === 'REPEAT' ? 'Repetition recorded.' : 'Promotion recorded.',
    );
  };
  const submitPlace = async (e: FormEvent) => {
    e.preventDefault();
    if (
      !loaded ||
      !place.enrollment ||
      !place.section ||
      !DATE.test(place.from) ||
      place.why.trim().length < 5
    ) {
      setPlaceErr(
        'Choose an enrolment and a section, a valid date (YYYY-MM-DD) and a reason of at least 5 characters.',
      );
      return;
    }
    setPlaceErr(null);
    await action.run(
      () =>
        placeInSection(client, loaded, place.enrollment, {
          sectionId: place.section,
          validFrom: place.from,
          reason: place.why.trim(),
        }),
      'Student placed in the section.',
    );
  };

  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>Term enrolment</h2>
      <form onSubmit={load} noValidate aria-label="Find student enrolments">
        {idErr && <Alert tone="error">{idErr}</Alert>}
        <TextField
          label="Student ID"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
        />
        <Button type="submit" pending={loading}>
          Load enrolments
        </Button>
      </form>
      {loadError && <Alert tone="error">{loadError}</Alert>}
      {loaded && !loading && rows.length === 0 && (
        <Card title="No enrolments">
          <p className="muted">This student has no term enrolments yet.</p>
        </Card>
      )}
      {rows.length > 0 && (
        <div className="grid">
          {rows.map((r) => (
            <Card key={r.id} title={`${periodLabel(cohortOf(r.cohortPeriodId))} ${r.periodNo}`}>
              <Badge>{r.status}</Badge>
              <dl className="defs">
                <dt>Roll number</dt>
                <dd>{r.rollNumber ?? 'Not set'}</dd>
                <dt>{L.section}</dt>
                <dd>
                  {r.currentSection
                    ? `${r.currentSection.name} (from ${r.currentSection.validFrom})`
                    : 'Not placed'}
                </dd>
              </dl>
            </Card>
          ))}
        </div>
      )}
      {canManage && loaded && (
        <>
          <form onSubmit={(e) => void enrol(e)} noValidate aria-label="Enrol for a term">
            <h3>Enrol for a term</h3>
            {enrolErr && <Alert tone="error">{enrolErr}</Alert>}
            <div className="field">
              <label htmlFor="enrol-period">Cohort period to enrol in</label>
              <select id="enrol-period" value={cp} onChange={(e) => setCp(e.target.value)}>
                <option value="">Select…</option>
                {periods.items
                  .filter((p) => p.status === 'ACTIVE')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {periodLabel(p.cohortId)} {p.periodNo} ({p.id.slice(-6)})
                    </option>
                  ))}
              </select>
            </div>
            <TextField
              label="Roll number (optional)"
              value={roll}
              onChange={(e) => setRoll(e.target.value)}
              maxLength={30}
            />
            <TextField
              label="Reason for enrolment"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
            <Button type="submit" pending={action.pending}>
              Enrol student
            </Button>
          </form>
          {rows.some((r) => r.status === 'REGISTERED' || r.status === 'ACTIVE') && (
            <form onSubmit={(e) => void submitPlace(e)} noValidate aria-label="Place in a section">
              <h3>Place in a section</h3>
              {placeErr && <Alert tone="error">{placeErr}</Alert>}
              <div className="field">
                <label htmlFor="place-enrollment">Enrolment</label>
                <select
                  id="place-enrollment"
                  value={place.enrollment}
                  onChange={(e) => setPlace({ ...place, enrollment: e.target.value })}
                >
                  <option value="">Select…</option>
                  {rows
                    .filter((r) => r.status === 'REGISTERED' || r.status === 'ACTIVE')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {periodLabel(cohortOf(r.cohortPeriodId))} {r.periodNo} ({r.status})
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="place-section">Section</label>
                <select
                  id="place-section"
                  value={place.section}
                  onChange={(e) => setPlace({ ...place, section: e.target.value })}
                >
                  <option value="">Select…</option>
                  {sections.items
                    .filter(
                      (s) =>
                        s.status === 'ACTIVE' &&
                        rows.some(
                          (r) => r.id === place.enrollment && r.cohortPeriodId === s.cohortPeriodId,
                        ),
                    )
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </div>
              <TextField
                label="Effective from"
                placeholder="YYYY-MM-DD"
                value={place.from}
                onChange={(e) => setPlace({ ...place, from: e.target.value })}
              />
              <TextField
                label="Reason for placement"
                value={place.why}
                onChange={(e) => setPlace({ ...place, why: e.target.value })}
                maxLength={100}
              />
              <Button type="submit" pending={action.pending}>
                Place student
              </Button>
            </form>
          )}
          {rows.some((r) => r.status === 'ACTIVE' || r.status === 'DETAINED') && (
            <form onSubmit={(e) => void submitMove(e)} noValidate aria-label="Promote or repeat">
              <h3>Promote or repeat</h3>
              <p className="muted">
                Promotion moves the student to the next period of the same cohort. Repeating keeps
                the period and moves the student to a later cohort of the same programme. The
                current enrolment is closed and kept in the history.
              </p>
              {moveErr && <Alert tone="error">{moveErr}</Alert>}
              <div className="field">
                <label htmlFor="move-enrollment">Current enrolment</label>
                <select
                  id="move-enrollment"
                  value={move.enrollment}
                  onChange={(e) => setMove({ ...move, enrollment: e.target.value })}
                >
                  <option value="">Select…</option>
                  {rows
                    .filter((r) => r.status === 'ACTIVE' || r.status === 'DETAINED')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {periodLabel(cohortOf(r.cohortPeriodId))} {r.periodNo} ({r.status})
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="move-decision">Decision</label>
                <select
                  id="move-decision"
                  value={move.decision}
                  onChange={(e) => setMove({ ...move, decision: e.target.value })}
                >
                  <option value="PROMOTE">Promote</option>
                  <option value="REPEAT">Repeat the period</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="move-period">Cohort period to move to</label>
                <select
                  id="move-period"
                  value={move.period}
                  onChange={(e) => setMove({ ...move, period: e.target.value })}
                >
                  <option value="">Select…</option>
                  {periods.items
                    .filter((p) => p.status === 'ACTIVE')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {periodLabel(p.cohortId)} {p.periodNo} ({p.id.slice(-6)})
                      </option>
                    ))}
                </select>
              </div>
              <TextField
                label="Reason for the decision"
                value={move.why}
                onChange={(e) => setMove({ ...move, why: e.target.value })}
                maxLength={500}
              />
              <Button type="submit" pending={action.pending}>
                Record decision
              </Button>
            </form>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TEACHING_ROLE: Record<FacultyAssignment['teachingRole'], string> = {
  PRIMARY: 'Primary teacher',
  CO_INSTRUCTOR: 'Co-instructor',
  LAB_INSTRUCTOR: 'Lab instructor',
  SUBSTITUTE: 'Substitute',
};

const OFFERING_KINDS: Array<Offering['offeringKind']> = [
  'CORE',
  'ELECTIVE',
  'OPEN_ELECTIVE',
  'OPTIONAL',
  'LAB_GROUP',
  'PROJECT',
  'INTERNSHIP',
];

const REGISTRATION_POLICIES = [
  'AUTO_FROM_SECTION',
  'MANUAL',
  'ELECTIVE_CHOICE',
  'ADMIN_ASSIGNED',
] as const;

function OfferingsTab({
  client,
  showTeachers,
  canRooms,
  canManage,
  canAssign,
  canRegister,
  canRoster,
}: {
  client: ApiClient;
  showTeachers: boolean;
  canRooms: boolean;
  canManage: boolean;
  canAssign: boolean;
  canRegister: boolean;
  canRoster: boolean;
}) {
  const L = useLabels();
  const periodLabel = usePeriodLabel();
  const terms = useList<Term>(useCallback(() => fetchTerms(client), [client]));
  const courses = useList<Course>(useCallback(() => fetchCourses(client), [client]));
  const cohortPeriods = useList<CohortPeriod>(
    useCallback(() => fetchCohortPeriods(client), [client]),
  );
  const sections = useList<Section>(useCallback(() => fetchSections(client), [client]));
  const [termId, setTermId] = useState('');
  const term = terms.items.find((t) => t.id === termId);
  const isTermLocked = term ? term.status === 'LOCKED' || term.status === 'CLOSED' : false;

  const offerings = useList<Offering>(
    useCallback(
      () => (termId ? fetchOfferings(client, termId) : Promise.resolve([])),
      [client, termId],
    ),
  );

  const termPeriods = cohortPeriods.items.filter((cp) => cp.termId === termId);
  const [rooms, setRooms] = useState<Record<string, string>>({});
  useEffect(() => {
    setRooms({});
    if (!canRooms || !term) return;
    fetchRooms(client, term.campusId)
      .then((list) => setRooms(Object.fromEntries(list.map((r) => [r.id, r.code]))))
      .catch(() => setRooms({}));
  }, [client, canRooms, term]);

  const [open, setOpen] = useState<Offering | null>(null);
  const [detail, setDetail] = useState<{
    slots: Slot[];
    teachers: FacultyAssignment[];
    registrations: Registration[];
    loading: boolean;
    error: string | null;
  }>({ slots: [], teachers: [], registrations: [], loading: false, error: null });

  const show = useCallback(
    (o: Offering) => {
      setOpen(o);
      setDetail({ slots: [], teachers: [], registrations: [], loading: true, error: null });
      Promise.all([
        fetchSlots(client, o.id),
        showTeachers || canAssign ? fetchFacultyAssignments(client, o.id) : Promise.resolve([]),
        canRoster || canRegister ? fetchOfferingRegistrations(client, o.id) : Promise.resolve([]),
      ])
        .then(([slots, teachers, registrations]) =>
          setDetail({ slots, teachers, registrations, loading: false, error: null }),
        )
        .catch((err: unknown) =>
          setDetail({
            slots: [],
            teachers: [],
            registrations: [],
            loading: false,
            error: academicsErrorMessage(err),
          }),
        );
    },
    [client, showTeachers, canAssign, canRoster, canRegister],
  );

  useEffect(() => {
    setOpen((current) =>
      current ? (offerings.items.find((o) => o.id === current.id) ?? current) : null,
    );
  }, [offerings.items]);

  useEffect(() => setOpen(null), [termId]);

  const sectionName = (id: string | null) =>
    id ? (sections.items.find((x) => x.id === id)?.name ?? 'Section') : 'All students';

  // ---- offering creation state ----
  const blankOffering = {
    courseId: '',
    offeringKind: 'CORE' as Offering['offeringKind'],
    registrationPolicy: 'AUTO_FROM_SECTION' as
      'AUTO_FROM_SECTION' | 'MANUAL' | 'ELECTIVE_CHOICE' | 'ADMIN_ASSIGNED',
    cohortPeriodId: '',
    sectionId: '',
    electiveGroupId: '',
    groupLabel: '',
    capacity: '',
  };
  const [offeringForm, setOfferingForm] = useState(blankOffering);
  const [offeringFormErr, setOfferingFormErr] = useState<string | null>(null);
  const offeringAction = useAction(offerings.reload);

  const [createElectiveGroups, setCreateElectiveGroups] = useState<ElectiveGroup[]>([]);
  useEffect(() => {
    if (!offeringForm.cohortPeriodId) {
      setCreateElectiveGroups([]);
      return;
    }
    fetchElectiveGroups(client, offeringForm.cohortPeriodId)
      .then(setCreateElectiveGroups)
      .catch(() => setCreateElectiveGroups([]));
  }, [client, offeringForm.cohortPeriodId]);

  const handleCreateOffering = async (e: FormEvent) => {
    e.preventDefault();
    if (!termId) return;
    if (!offeringForm.courseId) {
      setOfferingFormErr(`Choose a ${lower(L.course)}.`);
      return;
    }
    const capNum = offeringForm.capacity.trim() ? Number(offeringForm.capacity) : undefined;
    if (capNum !== undefined && (!Number.isInteger(capNum) || capNum < 1 || capNum > 10000)) {
      setOfferingFormErr('Capacity must be a whole number between 1 and 10000.');
      return;
    }
    setOfferingFormErr(null);
    const ok = await offeringAction.run(
      () =>
        createOffering(client, {
          termId,
          courseId: offeringForm.courseId,
          offeringKind: offeringForm.offeringKind,
          registrationPolicy: offeringForm.registrationPolicy,
          ...(offeringForm.cohortPeriodId ? { cohortPeriodId: offeringForm.cohortPeriodId } : {}),
          ...(offeringForm.sectionId ? { sectionId: offeringForm.sectionId } : {}),
          ...(offeringForm.electiveGroupId
            ? { electiveGroupId: offeringForm.electiveGroupId }
            : {}),
          ...(offeringForm.groupLabel.trim() ? { groupLabel: offeringForm.groupLabel.trim() } : {}),
          ...(capNum !== undefined ? { capacity: capNum } : {}),
        }),
      'Course offering created in draft state.',
      {
        conflict: `The offering was refused: check course, section, and ${lower(L.term)} status (a locked ${lower(L.term)} cannot receive new offerings).`,
      },
    );
    if (ok) {
      setOfferingForm(blankOffering);
    }
  };

  // ---- offering detail actions (publish, close, cancel, capacity) ----
  const detailAction = useAction(() => {
    offerings.reload();
    if (open) show(open);
  });
  // CLOSED and CANCELLED are final and the server requires a reason for both (offering.service.ts, doc 31 §3).
  const [cancelReason, setCancelReason] = useState('');
  const [endMode, setEndMode] = useState<'CLOSED' | 'CANCELLED' | null>(null);
  const [capEdit, setCapEdit] = useState('');
  useEffect(() => {
    setCapEdit(
      open?.capacity !== null && open?.capacity !== undefined ? String(open.capacity) : '',
    );
    setCancelReason('');
    setEndMode(null);
  }, [open?.id, open?.capacity]);

  const handlePublishOffering = async () => {
    if (!open) return;
    await detailAction.run(
      () => updateOffering(client, open, { status: 'PUBLISHED' }),
      'Offering published.',
      { conflict: `Could not publish: check ${lower(L.term)} lock status or stale version.` },
    );
  };

  const handleEndOffering = async (e: FormEvent) => {
    e.preventDefault();
    if (!open || !endMode) return;
    if (cancelReason.trim().length < 5) return;
    const closing = endMode === 'CLOSED';
    const ok = await detailAction.run(
      () => updateOffering(client, open, { status: endMode, reason: cancelReason.trim() }),
      closing ? 'Offering closed.' : 'Offering cancelled.',
      {
        conflict: `Could not ${closing ? 'close' : 'cancel'}: check ${lower(L.term)} lock status or stale version.`,
      },
    );
    if (ok) {
      setCancelReason('');
      setEndMode(null);
    }
  };

  const handleUpdateCapacity = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    const trimmed = capEdit.trim();
    const newCap = trimmed ? Number(trimmed) : null;
    if (newCap !== null && (!Number.isInteger(newCap) || newCap < 1 || newCap > 10000)) {
      return;
    }
    await detailAction.run(
      () => updateOffering(client, open, { capacity: newCap }),
      'Offering capacity updated.',
      {
        conflict: `Could not update capacity: check ${lower(L.term)} lock status or stale version.`,
      },
    );
  };

  // ---- timetable slot state & actions ----
  const blankSlot = {
    weekday: '1',
    startTime: '09:00',
    endTime: '10:00',
    roomId: '',
    facultyAssignmentId: '',
    effectiveFrom: '',
    effectiveTo: '',
  };
  const [slotForm, setSlotForm] = useState(blankSlot);
  const [slotFormErr, setSlotFormErr] = useState<string | null>(null);
  const slotAction = useAction(() => {
    if (open) show(open);
  });
  const [endingSlotId, setEndingSlotId] = useState<string | null>(null);
  const [slotEndDate, setSlotEndDate] = useState(todayIso());

  const handleAddSlot = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    const weekday = Number(slotForm.weekday);
    const start = slotForm.startTime.trim();
    const end = slotForm.endTime.trim();
    const from = slotForm.effectiveFrom.trim() || (term?.startDate ?? todayIso());
    const to = slotForm.effectiveTo.trim();

    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(start) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) ||
      start >= end
    ) {
      setSlotFormErr('Start time must be strictly before end time (HH:MM).');
      return;
    }
    if (!DATE.test(from) || (to && !DATE.test(to)) || (to && to <= from)) {
      setSlotFormErr(
        'Effective dates must be valid (YYYY-MM-DD) and end date must follow start date.',
      );
      return;
    }
    setSlotFormErr(null);
    const ok = await slotAction.run(
      () =>
        createSlot(client, open.id, {
          weekday,
          startTime: start,
          endTime: end,
          effectiveFrom: from,
          ...(to ? { effectiveTo: to } : {}),
          ...(slotForm.roomId ? { roomId: slotForm.roomId } : {}),
          ...(slotForm.facultyAssignmentId
            ? { facultyAssignmentId: slotForm.facultyAssignmentId }
            : {}),
        }),
      'Timetable slot added.',
      {
        conflict:
          'Timetable slot conflict: the room, section audience, or assigned teacher is already booked during this time window, or the term is locked.',
      },
    );
    if (ok) {
      setSlotForm(blankSlot);
    }
  };

  const handleEndSlot = async (slot: Slot) => {
    if (!slotEndDate || !DATE.test(slotEndDate)) return;
    const ok = await slotAction.run(
      () => endSlot(client, slot, { effectiveTo: slotEndDate }),
      'Timetable slot ended.',
      { conflict: 'Could not end slot: slot may already be closed or term is locked.' },
    );
    if (ok) setEndingSlotId(null);
  };

  // ---- faculty assignment state & actions ----
  const blankTeacher = {
    employeeId: '',
    teachingRole: 'PRIMARY' as FacultyAssignment['teachingRole'],
    validFrom: todayIso(),
    validTo: '',
    reason: '',
  };
  const [teacherForm, setTeacherForm] = useState(blankTeacher);
  const [teacherFormErr, setTeacherFormErr] = useState<string | null>(null);
  const teacherAction = useAction(() => {
    if (open) show(open);
  });
  const [endingFaId, setEndingFaId] = useState<string | null>(null);
  const [faEndDate, setFaEndDate] = useState(todayIso());
  const [faEndReason, setFaEndReason] = useState('');

  const handleAssignTeacher = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    if (!teacherForm.employeeId.trim()) {
      setTeacherFormErr('Enter an employee ID.');
      return;
    }
    if (!DATE.test(teacherForm.validFrom.trim())) {
      setTeacherFormErr('Enter a valid start date (YYYY-MM-DD).');
      return;
    }
    if (teacherForm.validTo.trim() && !DATE.test(teacherForm.validTo.trim())) {
      setTeacherFormErr('Enter a valid end date (YYYY-MM-DD).');
      return;
    }
    if (teacherForm.reason.trim().length < 5) {
      setTeacherFormErr('Reason must be at least 5 characters.');
      return;
    }
    setTeacherFormErr(null);
    const ok = await teacherAction.run(
      () =>
        createFacultyAssignment(client, open.id, {
          employeeId: teacherForm.employeeId.trim(),
          teachingRole: teacherForm.teachingRole,
          validFrom: teacherForm.validFrom.trim(),
          ...(teacherForm.validTo.trim() ? { validTo: teacherForm.validTo.trim() } : {}),
          reason: teacherForm.reason.trim(),
        }),
      'Faculty assigned to course offering.',
      {
        conflict:
          'Assignment refused: another primary faculty may already be active, the employee has no active campus posting, or the term is locked.',
      },
    );
    if (ok) {
      setTeacherForm(blankTeacher);
    }
  };

  const handleEndTeacher = async (assignment: FacultyAssignment) => {
    if (!DATE.test(faEndDate) || faEndReason.trim().length < 5) return;
    const ok = await teacherAction.run(
      () =>
        endFacultyAssignment(client, assignment, {
          validTo: faEndDate,
          reason: faEndReason.trim(),
        }),
      'Faculty assignment ended.',
      { conflict: 'Could not end assignment: assignment may already be ended or term is locked.' },
    );
    if (ok) {
      setEndingFaId(null);
      setFaEndReason('');
    }
  };

  // ---- registration & from-section action ----
  const regAction = useAction(() => {
    if (open) show(open);
  });
  const [fromSecDate, setFromSecDate] = useState(todayIso());
  const [fromSecReason, setFromSecReason] = useState('Auto-registration from section roster');
  const [fromSecNotice, setFromSecNotice] = useState<string | null>(null);
  const [fromSecErr, setFromSecErr] = useState<string | null>(null);
  const [fromSecPending, setFromSecPending] = useState(false);

  const [droppingRegId, setDroppingRegId] = useState<string | null>(null);
  const [dropDate, setDropDate] = useState(todayIso());
  const [dropReason, setDropReason] = useState('');

  const handleRegisterFromSection = async (e: FormEvent) => {
    e.preventDefault();
    if (!open) return;
    if (!DATE.test(fromSecDate) || fromSecReason.trim().length < 5) {
      setFromSecErr('Enter a valid date (YYYY-MM-DD) and a reason of at least 5 characters.');
      return;
    }
    setFromSecErr(null);
    setFromSecNotice(null);
    setFromSecPending(true);
    try {
      const res = await registerFromSection(client, open.id, {
        validFrom: fromSecDate,
        reason: fromSecReason.trim(),
      });
      setFromSecNotice(
        `Registered ${res.created} student${res.created === 1 ? '' : 's'} (${res.alreadyRegistered} already registered).`,
      );
      if (open) show(open);
    } catch (err) {
      setFromSecErr(
        hinted(err, {
          conflict: `Registration refused: capacity may be exceeded, offering has no section, or ${lower(L.term)} is locked.`,
        }),
      );
    } finally {
      setFromSecPending(false);
    }
  };

  const handleDropRegistration = async (r: Registration) => {
    if (!DATE.test(dropDate) || dropReason.trim().length < 5) return;
    const ok = await regAction.run(
      () =>
        updateRegistration(client, r, {
          status: 'DROPPED',
          validTo: dropDate,
          reason: dropReason.trim(),
        }),
      'Registration dropped.',
      { conflict: 'Could not drop registration: record may already be closed or term is locked.' },
    );
    if (ok) {
      setDroppingRegId(null);
      setDropReason('');
    }
  };

  const liveRegistrations = detail.registrations.filter(isLive);

  return (
    <>
      <h2>Course offerings</h2>
      <ListState
        loading={terms.loading}
        error={terms.error}
        empty={terms.items.length === 0}
        emptyTitle="No terms"
        emptyText="Offerings belong to a term; no terms have been created yet."
        onRetry={terms.reload}
      />
      {terms.items.length > 0 && (
        <div className="field">
          <label htmlFor="offering-term">{L.term}</label>
          <select id="offering-term" value={termId} onChange={(e) => setTermId(e.target.value)}>
            <option value="">Select…</option>
            {terms.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} - {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {termId && (
        <>
          {isTermLocked && (
            <Alert tone="info">
              This {lower(L.term)} is {term?.status.toLowerCase()}. Offerings cannot be created or
              modified, but may be inspected.
            </Alert>
          )}

          <Feedback error={offeringAction.error} notice={offeringAction.notice} />

          {/* Creation form */}
          {canManage && !isTermLocked && (
            <Card title="New course offering">
              {offeringFormErr && <Alert tone="error">{offeringFormErr}</Alert>}
              <form
                onSubmit={(e) => void handleCreateOffering(e)}
                noValidate
                aria-label="Create course offering"
              >
                <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                  <div className="field">
                    <label htmlFor="create-offering-course">{L.course}</label>
                    <select
                      id="create-offering-course"
                      value={offeringForm.courseId}
                      onChange={(e) =>
                        setOfferingForm({ ...offeringForm, courseId: e.target.value })
                      }
                    >
                      <option value="">Select a {lower(L.course)}…</option>
                      {courses.items.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code} - {c.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="create-offering-kind">Offering kind</label>
                    <select
                      id="create-offering-kind"
                      value={offeringForm.offeringKind}
                      onChange={(e) =>
                        setOfferingForm({
                          ...offeringForm,
                          offeringKind: e.target.value,
                        })
                      }
                    >
                      {OFFERING_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="create-offering-policy">Registration policy</label>
                    <select
                      id="create-offering-policy"
                      value={offeringForm.registrationPolicy}
                      onChange={(e) =>
                        setOfferingForm({
                          ...offeringForm,
                          registrationPolicy: e.target
                            .value as (typeof REGISTRATION_POLICIES)[number],
                        })
                      }
                    >
                      {REGISTRATION_POLICIES.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="create-offering-period">{L.period} (optional)</label>
                    <select
                      id="create-offering-period"
                      value={offeringForm.cohortPeriodId}
                      onChange={(e) =>
                        setOfferingForm({
                          ...offeringForm,
                          cohortPeriodId: e.target.value,
                          sectionId: '',
                          electiveGroupId: '',
                        })
                      }
                    >
                      <option value="">None (all students in {lower(L.term)})</option>
                      {termPeriods.map((cp) => (
                        <option key={cp.id} value={cp.id}>
                          {periodLabel(cp.cohortId)} {cp.periodNo} ({cp.id.slice(-6)})
                        </option>
                      ))}
                    </select>
                  </div>
                  {offeringForm.cohortPeriodId && (
                    <>
                      <div className="field">
                        <label htmlFor="create-offering-section">{L.section} (optional)</label>
                        <select
                          id="create-offering-section"
                          value={offeringForm.sectionId}
                          onChange={(e) =>
                            setOfferingForm({ ...offeringForm, sectionId: e.target.value })
                          }
                        >
                          <option value="">All sections in {lower(L.period)}</option>
                          {sections.items
                            .filter((s) => s.cohortPeriodId === offeringForm.cohortPeriodId)
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      {createElectiveGroups.length > 0 && (
                        <div className="field">
                          <label htmlFor="create-offering-elective-group">
                            Elective group (optional)
                          </label>
                          <select
                            id="create-offering-elective-group"
                            value={offeringForm.electiveGroupId}
                            onChange={(e) =>
                              setOfferingForm({ ...offeringForm, electiveGroupId: e.target.value })
                            }
                          >
                            <option value="">None</option>
                            {createElectiveGroups.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.code} - {g.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </>
                  )}
                  <TextField
                    label="Group label (optional)"
                    value={offeringForm.groupLabel}
                    onChange={(e) =>
                      setOfferingForm({ ...offeringForm, groupLabel: e.target.value })
                    }
                    maxLength={30}
                  />
                  <TextField
                    label="Capacity (optional)"
                    value={offeringForm.capacity}
                    inputMode="numeric"
                    onChange={(e) => setOfferingForm({ ...offeringForm, capacity: e.target.value })}
                  />
                </div>
                <div style={{ marginTop: 'var(--space-2)' }}>
                  <Button type="submit" pending={offeringAction.pending}>
                    Create course offering
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <ListState
            loading={offerings.loading}
            error={offerings.error}
            empty={offerings.items.length === 0}
            emptyTitle="No offerings"
            emptyText="No course offerings in this term that you can see."
            onRetry={offerings.reload}
          />
          {offerings.items.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" aria-label="Course offerings in the selected term">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Title</th>
                    <th scope="col">{L.section}</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Credits</th>
                    <th scope="col">Capacity</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {offerings.items.map((o) => (
                    <tr key={o.id}>
                      <td>{o.codeSnapshot}</td>
                      <td>{o.titleSnapshot}</td>
                      <td>
                        {sectionName(o.sectionId)}
                        {o.groupLabel ? ` (${o.groupLabel})` : ''}
                      </td>
                      <td>{o.offeringKind}</td>
                      <td>{o.creditsSnapshot}</td>
                      <td>
                        {o.capacity === null || o.capacity === undefined ? 'Unlimited' : o.capacity}
                      </td>
                      <td>
                        <Badge>{o.status}</Badge>
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => show(o)}>
                          {canManage ? 'Manage' : 'Timetable for'} {o.codeSnapshot}
                          {o.groupLabel ? ` ${o.groupLabel}` : ''}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {open && (
        <Card title={`Manage offering: ${open.codeSnapshot} - ${open.titleSnapshot}`}>
          <Feedback error={detailAction.error} notice={detailAction.notice} />
          {detail.loading && <Spinner label="Loading details…" />}
          {detail.error && (
            <Alert tone="error">
              {detail.error}{' '}
              <Button variant="ghost" onClick={() => show(open)}>
                Retry loading
              </Button>
            </Alert>
          )}
          {!detail.loading && !detail.error && (
            <>
              <dl className="defs">
                <dt>Status</dt>
                <dd>
                  <Badge>{open.status}</Badge>
                </dd>
                <dt>{L.term}</dt>
                <dd>
                  {term?.code} ({term?.name})
                </dd>
                <dt>Audience / {L.section}</dt>
                <dd>
                  {sectionName(open.sectionId)}
                  {open.groupLabel ? ` (${open.groupLabel})` : ''}
                </dd>
                <dt>Kind & Policy</dt>
                <dd>
                  {open.offeringKind} · {open.registrationPolicy}
                </dd>
                <dt>Credits</dt>
                <dd>{open.creditsSnapshot}</dd>
                <dt>Capacity</dt>
                <dd>
                  {open.capacity === null || open.capacity === undefined
                    ? 'Unlimited'
                    : `${liveRegistrations.length} of ${open.capacity} live places taken`}
                </dd>
                {open.electiveGroupId && (
                  <>
                    <dt>Elective Basket</dt>
                    <dd>{open.electiveGroupId}</dd>
                  </>
                )}
              </dl>

              {/* Lifecycle & Capacity Management */}
              {canManage && (
                <div style={{ marginTop: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
                  {isTermLocked ? (
                    <Alert tone="info">
                      Term is {term?.status.toLowerCase()}; offering lifecycle and capacity changes
                      are locked.
                    </Alert>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'var(--space-2)',
                        alignItems: 'center',
                      }}
                    >
                      {open.status === 'DRAFT' && (
                        <Button
                          onClick={() => void handlePublishOffering()}
                          pending={detailAction.pending}
                        >
                          Publish offering
                        </Button>
                      )}
                      {open.status === 'PUBLISHED' && (
                        <>
                          {!endMode ? (
                            <>
                              <Button variant="secondary" onClick={() => setEndMode('CLOSED')}>
                                Close offering
                              </Button>
                              <Button variant="secondary" onClick={() => setEndMode('CANCELLED')}>
                                Cancel offering
                              </Button>
                            </>
                          ) : (
                            <form
                              onSubmit={(e) => void handleEndOffering(e)}
                              aria-label={
                                endMode === 'CLOSED' ? 'Close offering' : 'Cancel offering'
                              }
                              style={{
                                display: 'flex',
                                gap: 'var(--space-2)',
                                alignItems: 'flex-end',
                                flexWrap: 'wrap',
                              }}
                            >
                              <TextField
                                label={
                                  endMode === 'CLOSED' ? 'Closing reason' : 'Cancellation reason'
                                }
                                value={cancelReason}
                                onChange={(e) => setCancelReason(e.target.value)}
                                maxLength={500}
                              />
                              <Button type="submit" pending={detailAction.pending}>
                                {endMode === 'CLOSED' ? 'Confirm close' : 'Confirm cancellation'}
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setEndMode(null);
                                  setCancelReason('');
                                }}
                              >
                                Dismiss
                              </Button>
                            </form>
                          )}
                        </>
                      )}
                      {open.status !== 'CLOSED' && open.status !== 'CANCELLED' && (
                        <form
                          onSubmit={(e) => void handleUpdateCapacity(e)}
                          aria-label="Update capacity"
                          style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-end' }}
                        >
                          <TextField
                            label="Edit capacity"
                            value={capEdit}
                            inputMode="numeric"
                            placeholder="Blank for unlimited"
                            onChange={(e) => setCapEdit(e.target.value)}
                          />
                          <Button type="submit" variant="secondary" pending={detailAction.pending}>
                            Update capacity
                          </Button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Timetable slots */}
              <div style={{ marginTop: 'var(--space-4)' }}>
                <Feedback error={slotAction.error} notice={slotAction.notice} />
                <h3>Weekly timetable slots</h3>
                {detail.slots.length === 0 ? (
                  <p className="muted">No timetable slots yet.</p>
                ) : (
                  <ul aria-label="Timetable slots">
                    {detail.slots.map((sl) => (
                      <li key={sl.id} style={{ marginBottom: 'var(--space-2)' }}>
                        <strong>{WEEKDAYS[sl.weekday - 1]}</strong> {sl.startTime}-{sl.endTime}
                        {sl.roomId ? `, room ${rooms[sl.roomId] ?? 'booked'}` : ', no room'}
                        {' · '}from {sl.effectiveFrom}
                        {sl.effectiveTo ? ` to ${sl.effectiveTo} (ended)` : ''}
                        {canManage &&
                          !isTermLocked &&
                          !sl.effectiveTo &&
                          open.status !== 'CANCELLED' && (
                            <span style={{ marginLeft: 'var(--space-2)' }}>
                              {endingSlotId === sl.id ? (
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    gap: 'var(--space-1)',
                                    alignItems: 'center',
                                  }}
                                >
                                  <input
                                    type="date"
                                    aria-label={`End date for slot ${sl.id}`}
                                    value={slotEndDate}
                                    onChange={(e) => setSlotEndDate(e.target.value)}
                                  />
                                  <Button
                                    variant="secondary"
                                    onClick={() => void handleEndSlot(sl)}
                                    pending={slotAction.pending}
                                  >
                                    Confirm end
                                  </Button>
                                  <Button variant="ghost" onClick={() => setEndingSlotId(null)}>
                                    Cancel
                                  </Button>
                                </span>
                              ) : (
                                <Button variant="ghost" onClick={() => setEndingSlotId(sl.id)}>
                                  End slot
                                </Button>
                              )}
                            </span>
                          )}
                      </li>
                    ))}
                  </ul>
                )}

                {canManage && !isTermLocked && open.status !== 'CANCELLED' && (
                  <form
                    onSubmit={(e) => void handleAddSlot(e)}
                    aria-label="Add timetable slot"
                    style={{ marginTop: 'var(--space-3)' }}
                  >
                    <h4>Add timetable slot</h4>
                    {slotFormErr && <Alert tone="error">{slotFormErr}</Alert>}
                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <div className="field">
                        <label htmlFor="slot-weekday">Day of week</label>
                        <select
                          id="slot-weekday"
                          value={slotForm.weekday}
                          onChange={(e) => setSlotForm({ ...slotForm, weekday: e.target.value })}
                        >
                          {WEEKDAYS.map((name, idx) => (
                            <option key={name} value={idx + 1}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <TextField
                        label="Start time (HH:MM)"
                        value={slotForm.startTime}
                        onChange={(e) => setSlotForm({ ...slotForm, startTime: e.target.value })}
                      />
                      <TextField
                        label="End time (HH:MM)"
                        value={slotForm.endTime}
                        onChange={(e) => setSlotForm({ ...slotForm, endTime: e.target.value })}
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: 'var(--space-2)',
                        flexWrap: 'wrap',
                        marginTop: 'var(--space-2)',
                      }}
                    >
                      <div className="field">
                        <label htmlFor="slot-room">Room (optional)</label>
                        <select
                          id="slot-room"
                          value={slotForm.roomId}
                          onChange={(e) => setSlotForm({ ...slotForm, roomId: e.target.value })}
                        >
                          <option value="">No room booked</option>
                          {Object.entries(rooms).map(([id, code]) => (
                            <option key={id} value={id}>
                              {code}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="slot-faculty">Teacher assignment (optional)</label>
                        <select
                          id="slot-faculty"
                          value={slotForm.facultyAssignmentId}
                          onChange={(e) =>
                            setSlotForm({ ...slotForm, facultyAssignmentId: e.target.value })
                          }
                        >
                          <option value="">None assigned</option>
                          {detail.teachers
                            .filter((fa) => !fa.validTo)
                            .map((fa) => (
                              <option key={fa.id} value={fa.id}>
                                {TEACHING_ROLE[fa.teachingRole]} ({fa.employeeId.slice(-8)})
                              </option>
                            ))}
                        </select>
                      </div>
                      <TextField
                        label="Effective from (YYYY-MM-DD)"
                        value={slotForm.effectiveFrom}
                        onChange={(e) =>
                          setSlotForm({ ...slotForm, effectiveFrom: e.target.value })
                        }
                        placeholder={term?.startDate ?? todayIso()}
                      />
                      <TextField
                        label="Effective to (optional, YYYY-MM-DD)"
                        value={slotForm.effectiveTo}
                        onChange={(e) => setSlotForm({ ...slotForm, effectiveTo: e.target.value })}
                      />
                    </div>
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <Button type="submit" pending={slotAction.pending}>
                        Add timetable slot
                      </Button>
                    </div>
                  </form>
                )}
              </div>

              {/* Faculty assignments */}
              {(showTeachers || canAssign) && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Feedback error={teacherAction.error} notice={teacherAction.notice} />
                  <h3>Faculty and teacher assignments</h3>
                  {detail.teachers.length === 0 ? (
                    <p className="muted">No faculty assigned to this offering yet.</p>
                  ) : (
                    <ul aria-label="Teaching assignments">
                      {detail.teachers.map((a) => (
                        <li key={a.id} style={{ marginBottom: 'var(--space-2)' }}>
                          <strong>{TEACHING_ROLE[a.teachingRole]}</strong> · employee{' '}
                          {a.employeeId.slice(-8)} · from {a.validFrom}
                          {a.validTo ? ` to ${a.validTo} (ended)` : ''}
                          {canAssign &&
                            !isTermLocked &&
                            !a.validTo &&
                            open.status !== 'CANCELLED' && (
                              <div style={{ marginTop: 'var(--space-1)' }}>
                                {endingFaId === a.id ? (
                                  <form
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void handleEndTeacher(a);
                                    }}
                                    aria-label={`End assignment for ${a.employeeId}`}
                                    style={{
                                      display: 'flex',
                                      gap: 'var(--space-2)',
                                      alignItems: 'flex-end',
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <TextField
                                      label="Effective end date"
                                      value={faEndDate}
                                      onChange={(e) => setFaEndDate(e.target.value)}
                                    />
                                    <TextField
                                      label="Reason (at least 5 characters)"
                                      value={faEndReason}
                                      onChange={(e) => setFaEndReason(e.target.value)}
                                      maxLength={500}
                                    />
                                    <Button
                                      type="submit"
                                      variant="secondary"
                                      pending={teacherAction.pending}
                                    >
                                      Confirm end assignment
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      onClick={() => {
                                        setEndingFaId(null);
                                        setFaEndReason('');
                                      }}
                                    >
                                      Cancel
                                    </Button>
                                  </form>
                                ) : (
                                  <Button variant="ghost" onClick={() => setEndingFaId(a.id)}>
                                    End assignment
                                  </Button>
                                )}
                              </div>
                            )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {canAssign && !isTermLocked && open.status !== 'CANCELLED' && (
                    <form
                      onSubmit={(e) => void handleAssignTeacher(e)}
                      aria-label="Assign faculty"
                      style={{ marginTop: 'var(--space-3)' }}
                    >
                      <h4>Assign faculty to offering</h4>
                      {teacherFormErr && <Alert tone="error">{teacherFormErr}</Alert>}
                      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                        <TextField
                          label="Employee ID"
                          value={teacherForm.employeeId}
                          onChange={(e) =>
                            setTeacherForm({ ...teacherForm, employeeId: e.target.value })
                          }
                        />
                        <div className="field">
                          <label htmlFor="teacher-role">Teaching role</label>
                          <select
                            id="teacher-role"
                            value={teacherForm.teachingRole}
                            onChange={(e) =>
                              setTeacherForm({
                                ...teacherForm,
                                teachingRole: e.target.value as FacultyAssignment['teachingRole'],
                              })
                            }
                          >
                            {(
                              Object.keys(TEACHING_ROLE) as Array<FacultyAssignment['teachingRole']>
                            ).map((role) => (
                              <option key={role} value={role}>
                                {TEACHING_ROLE[role]}
                              </option>
                            ))}
                          </select>
                        </div>
                        <TextField
                          label="Valid from (YYYY-MM-DD)"
                          value={teacherForm.validFrom}
                          onChange={(e) =>
                            setTeacherForm({ ...teacherForm, validFrom: e.target.value })
                          }
                        />
                        <TextField
                          label="Valid to (optional, YYYY-MM-DD)"
                          value={teacherForm.validTo}
                          onChange={(e) =>
                            setTeacherForm({ ...teacherForm, validTo: e.target.value })
                          }
                        />
                      </div>
                      <TextField
                        label="Reason for assignment"
                        value={teacherForm.reason}
                        onChange={(e) => setTeacherForm({ ...teacherForm, reason: e.target.value })}
                        maxLength={500}
                      />
                      <Button type="submit" pending={teacherAction.pending}>
                        Assign faculty
                      </Button>
                    </form>
                  )}
                </div>
              )}

              {/* Student registrations & From-section registration */}
              {(canRoster || canRegister) && (
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Feedback error={regAction.error} notice={regAction.notice} />
                  <h3>Student registrations</h3>
                  <p className="muted">
                    Total: {detail.registrations.length} registrations ({liveRegistrations.length}{' '}
                    currently active).
                    {open.capacity !== null && open.capacity !== undefined && (
                      <span> Capacity limit: {open.capacity}.</span>
                    )}
                  </p>

                  {/* From-section auto-registration */}
                  {canRegister &&
                    open.sectionId &&
                    !isTermLocked &&
                    open.status !== 'CANCELLED' && (
                      <Card title={`Auto-register from section: ${sectionName(open.sectionId)}`}>
                        {fromSecErr && <Alert tone="error">{fromSecErr}</Alert>}
                        {fromSecNotice && <Alert tone="success">{fromSecNotice}</Alert>}
                        <form
                          onSubmit={(e) => void handleRegisterFromSection(e)}
                          aria-label="Register students from section"
                        >
                          <p className="muted">
                            Explicitly registers active students of {sectionName(open.sectionId)}{' '}
                            into this offering. This action is re-runnable.
                          </p>
                          <div
                            style={{
                              display: 'flex',
                              gap: 'var(--space-2)',
                              flexWrap: 'wrap',
                              alignItems: 'flex-end',
                            }}
                          >
                            <TextField
                              label="Registration effective date"
                              value={fromSecDate}
                              onChange={(e) => setFromSecDate(e.target.value)}
                            />
                            <TextField
                              label="Reason"
                              value={fromSecReason}
                              onChange={(e) => setFromSecReason(e.target.value)}
                              maxLength={500}
                            />
                            <Button type="submit" pending={fromSecPending}>
                              Register students from section
                            </Button>
                          </div>
                        </form>
                      </Card>
                    )}

                  {/* Registrations list */}
                  {canRoster && (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      {detail.registrations.length === 0 ? (
                        <p className="muted">No students registered yet.</p>
                      ) : (
                        <div style={{ overflowX: 'auto' }}>
                          <table
                            className="data-table"
                            aria-label="Course offering student registrations"
                          >
                            <thead>
                              <tr>
                                <th scope="col">Student ID</th>
                                <th scope="col">Status</th>
                                <th scope="col">Source</th>
                                <th scope="col">Effective span</th>
                                {canRegister && !isTermLocked && <th scope="col">Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {detail.registrations.map((r) => (
                                <tr key={r.id}>
                                  <td>{r.studentId}</td>
                                  <td>
                                    <Badge>{REG_STATUS[r.status] ?? r.status}</Badge>
                                  </td>
                                  <td>{r.source}</td>
                                  <td>
                                    {r.validFrom}
                                    {r.validTo ? ` to ${r.validTo}` : ''}
                                  </td>
                                  {canRegister && !isTermLocked && (
                                    <td>
                                      {!r.validTo && open.status !== 'CANCELLED' && (
                                        <>
                                          {droppingRegId === r.id ? (
                                            <form
                                              onSubmit={(e) => {
                                                e.preventDefault();
                                                void handleDropRegistration(r);
                                              }}
                                              aria-label={`Drop registration for ${r.studentId}`}
                                              style={{
                                                display: 'flex',
                                                gap: 'var(--space-1)',
                                                alignItems: 'center',
                                              }}
                                            >
                                              <input
                                                type="date"
                                                aria-label="Drop date"
                                                value={dropDate}
                                                onChange={(e) => setDropDate(e.target.value)}
                                              />
                                              <input
                                                type="text"
                                                placeholder="Reason (min 5)"
                                                aria-label="Drop reason"
                                                value={dropReason}
                                                onChange={(e) => setDropReason(e.target.value)}
                                                style={{ width: '120px' }}
                                              />
                                              <Button
                                                variant="secondary"
                                                type="submit"
                                                pending={regAction.pending}
                                              >
                                                Confirm drop
                                              </Button>
                                              <Button
                                                variant="ghost"
                                                onClick={() => setDroppingRegId(null)}
                                              >
                                                Cancel
                                              </Button>
                                            </form>
                                          ) : (
                                            <Button
                                              variant="ghost"
                                              onClick={() => {
                                                setDroppingRegId(r.id);
                                                setDropDate(todayIso());
                                                setDropReason('');
                                              }}
                                            >
                                              Drop
                                            </Button>
                                          )}
                                        </>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Milestone 3 Batch 3 (doc 33). Every rule (window, min/max, capacity, audience, locked terms) is the database's; the
// page only shows what it knows and explains a refusal in its own words.
const LOCAL_INSTANT = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
/** "YYYY-MM-DD HH:MM" in the browser's time zone -> ISO instant; null when malformed. */
const toInstant = (v: string): string | null => {
  const m = LOCAL_INSTANT.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const showInstant = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Whether the group takes choices right now, as far as the page can tell; the server decides at save time. */
function windowOpen(g: ElectiveGroup, now = Date.now()): boolean {
  return (
    g.status === 'OPEN' &&
    (g.opensAt === null || now >= Date.parse(g.opensAt)) &&
    (g.closesAt === null || now < Date.parse(g.closesAt))
  );
}
function windowText(g: ElectiveGroup): string {
  const span =
    g.opensAt || g.closesAt
      ? `${g.opensAt ? showInstant(g.opensAt) : 'any time'} to ${g.closesAt ? showInstant(g.closesAt) : 'no end'}`
      : 'No time limit';
  if (g.status === 'PLANNED') return `${span} · not open yet (planned)`;
  if (g.status === 'CLOSED') return `${span} · closed, choices are final`;
  return windowOpen(g) ? `${span} · open for choices` : `${span} · outside the window`;
}
const REG_STATUS: Record<Registration['status'], string> = {
  PENDING_APPROVAL: 'Awaiting approval',
  REGISTERED: 'Registered',
  REJECTED: 'Rejected',
  DROPPED: 'Dropped',
  WITHDRAWN: 'Withdrawn',
  COMPLETED: 'Completed',
};

function ElectivesTab({
  client,
  canManage,
  canRegister,
  canRoster,
}: {
  client: ApiClient;
  canManage: boolean;
  canRegister: boolean;
  canRoster: boolean;
}) {
  const L = useLabels();
  const periodLabel = usePeriodLabel();
  const periods = useList<CohortPeriod>(useCallback(() => fetchCohortPeriods(client), [client]));
  const [periodId, setPeriodId] = useState('');
  const termId = periods.items.find((p) => p.id === periodId)?.termId ?? '';
  const groups = useList<ElectiveGroup>(
    useCallback(
      () => (periodId ? fetchElectiveGroups(client, periodId) : Promise.resolve([])),
      [client, periodId],
    ),
  );
  const offerings = useList<Offering>(
    useCallback(
      () => (termId ? fetchOfferings(client, termId) : Promise.resolve([])),
      [client, termId],
    ),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => setOpenId(null), [periodId]);
  const open = groups.items.find((g) => g.id === openId) ?? null;
  const action = useAction(groups.reload);

  const blank = { code: '', name: '', min: '1', max: '1', opens: '', closes: '', why: '' };
  const [form, setForm] = useState(blank);
  const [formErr, setFormErr] = useState<string | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const min = Number(form.min);
    const max = Number(form.max);
    const opens = form.opens.trim() ? toInstant(form.opens) : undefined;
    const closes = form.closes.trim() ? toInstant(form.closes) : undefined;
    if (
      !form.code.trim() ||
      !form.name.trim() ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      max > 50 ||
      min > max ||
      opens === null ||
      closes === null ||
      (opens && closes && closes <= opens) ||
      form.why.trim().length < 5
    ) {
      setFormErr(
        'Enter a code and a name, whole numbers with 0 ≤ minimum ≤ maximum ≤ 50, an optional window (YYYY-MM-DD HH:MM) that closes after it opens, and a reason of at least 5 characters.',
      );
      return;
    }
    setFormErr(null);
    if (
      await action.run(
        () =>
          createElectiveGroup(client, periodId, {
            code: form.code.trim(),
            name: form.name.trim(),
            minSelect: min,
            maxSelect: max,
            ...(opens ? { opensAt: opens } : {}),
            ...(closes ? { closesAt: closes } : {}),
            reason: form.why.trim(),
          }),
        'Elective group created. It starts as planned: open it when choices may begin.',
        {
          conflict: `The group was refused: the code may already be used in this ${lower(L.period)}, or the ${lower(L.period)} is no longer active in a planned or active ${lower(L.term)}.`,
        },
      )
    )
      setForm(blank);
  };

  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>Elective groups</h2>
      <p className="muted">
        An elective group is a basket of offerings from which each student chooses between a minimum
        and a maximum number, while the group is open and inside its window.
      </p>
      <ListState
        loading={periods.loading}
        error={periods.error}
        empty={periods.items.length === 0}
        emptyTitle={`No ${lower(plural(L.period))}`}
        emptyText={`Elective groups belong to a ${lower(L.cohort)} ${lower(L.period)}; none exist yet.`}
        onRetry={periods.reload}
      />
      {periods.items.length > 0 && (
        <div className="field">
          <label htmlFor="elective-period">Cohort period</label>
          <select
            id="elective-period"
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
          >
            <option value="">Select…</option>
            {periods.items.map((p) => (
              <option key={p.id} value={p.id}>
                {periodLabel(p.cohortId)} {p.periodNo} ({p.id.slice(-6)})
                {p.status === 'CLOSED' ? ' - closed' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {periodId && (
        <>
          <ListState
            loading={groups.loading}
            error={groups.error}
            empty={groups.items.length === 0}
            emptyTitle="No elective groups"
            emptyText={`This ${lower(L.period)} has no elective groups.`}
            onRetry={groups.reload}
          />
          {groups.items.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" aria-label="Elective groups">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Choices</th>
                    <th scope="col">Window</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groups.items.map((g) => (
                    <tr key={g.id}>
                      <td>{g.code}</td>
                      <td>{g.name}</td>
                      <td>
                        {g.minSelect} to {g.maxSelect}
                      </td>
                      <td>{windowText(g)}</td>
                      <td>
                        <Badge>{g.status}</Badge>
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => setOpenId(g.id)}>
                          Open group {g.code}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {offerings.error && <Alert tone="error">{offerings.error}</Alert>}
          {open && (
            <ElectiveGroupPanel
              key={open.id}
              client={client}
              group={open}
              basket={offerings.items.filter((o) => o.electiveGroupId === open.id)}
              canManage={canManage}
              canRegister={canRegister}
              canRoster={canRoster}
              onChanged={groups.reload}
            />
          )}
          {canManage && (
            <form onSubmit={(e) => void create(e)} noValidate aria-label="Create elective group">
              <h3>New elective group</h3>
              {formErr && <Alert tone="error">{formErr}</Alert>}
              <TextField
                label="Group code"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                maxLength={30}
              />
              <TextField
                label="Group name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                maxLength={255}
              />
              <TextField
                label="Minimum choices"
                value={form.min}
                inputMode="numeric"
                onChange={(e) => setForm({ ...form, min: e.target.value })}
              />
              <TextField
                label="Maximum choices"
                value={form.max}
                inputMode="numeric"
                onChange={(e) => setForm({ ...form, max: e.target.value })}
              />
              <TextField
                label="Window opens (optional, YYYY-MM-DD HH:MM)"
                value={form.opens}
                onChange={(e) => setForm({ ...form, opens: e.target.value })}
              />
              <TextField
                label="Window closes (optional, YYYY-MM-DD HH:MM)"
                value={form.closes}
                onChange={(e) => setForm({ ...form, closes: e.target.value })}
              />
              <TextField
                label="Reason for the group"
                value={form.why}
                onChange={(e) => setForm({ ...form, why: e.target.value })}
                maxLength={500}
              />
              <Button type="submit" pending={action.pending}>
                Create elective group
              </Button>
            </form>
          )}
        </>
      )}
    </>
  );
}

/**
 * One elective group: its basket with capacity, the lifecycle (PLANNED → OPEN → CLOSED, CLOSED is final), the roster per
 * offering, and recording a student's choices. Eligibility is never decided here: every enrolment, offering and date is
 * submitted and the database guard accepts or refuses it.
 */
function ElectiveGroupPanel({
  client,
  group,
  basket,
  canManage,
  canRegister,
  canRoster,
  onChanged,
}: {
  client: ApiClient;
  group: ElectiveGroup;
  basket: Offering[];
  canManage: boolean;
  canRegister: boolean;
  canRoster: boolean;
  onChanged: () => void;
}) {
  const L = useLabels();
  const ids = basket.map((o) => o.id).join(',');
  const rosters = useList<[string, Registration[]]>(
    useCallback(
      () =>
        canRoster && ids
          ? Promise.all(
              ids
                .split(',')
                .map((id) =>
                  fetchOfferingRegistrations(client, id).then(
                    (r) => [id, r] as [string, Registration[]],
                  ),
                ),
            )
          : Promise.resolve([]),
      [client, canRoster, ids],
    ),
  );
  const regsOf = (id: string) => rosters.items.find(([k]) => k === id)?.[1] ?? [];
  const live = (id: string) => regsOf(id).filter(isLive).length;
  const full = (o: Offering) =>
    canRoster && o.capacity !== null && o.capacity !== undefined && live(o.id) >= o.capacity;
  const action = useAction(() => {
    onChanged();
    rosters.reload();
  });

  const [edit, setEdit] = useState({
    name: group.name,
    min: String(group.minSelect),
    max: String(group.maxSelect),
    opens: '',
    closes: '',
    why: '',
  });
  const [editErr, setEditErr] = useState<string | null>(null);
  const change = async (status?: 'OPEN' | 'CLOSED') => {
    const min = Number(edit.min);
    const max = Number(edit.max);
    const opens = edit.opens.trim() ? toInstant(edit.opens) : undefined;
    const closes = edit.closes.trim() ? toInstant(edit.closes) : undefined;
    if (
      !edit.name.trim() ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      max > 50 ||
      min > max ||
      opens === null ||
      closes === null ||
      edit.why.trim().length < 5
    ) {
      setEditErr(
        'Enter a name, whole numbers with 0 ≤ minimum ≤ maximum ≤ 50, any new window as YYYY-MM-DD HH:MM, and a reason of at least 5 characters.',
      );
      return;
    }
    setEditErr(null);
    const body = {
      ...(edit.name.trim() !== group.name ? { name: edit.name.trim() } : {}),
      ...(min !== group.minSelect ? { minSelect: min } : {}),
      ...(max !== group.maxSelect ? { maxSelect: max } : {}),
      ...(opens ? { opensAt: opens } : {}),
      ...(closes ? { closesAt: closes } : {}),
      ...(status ? { status } : {}),
      reason: edit.why.trim(),
    };
    if (Object.keys(body).length === 1) {
      setEditErr('Nothing has changed.');
      return;
    }
    const conflict =
      status === 'CLOSED'
        ? `Closing was refused: every enrolment still live in this ${lower(L.period)} must hold at least ${min} choice${min === 1 ? '' : 's'} in the group first, or the group changed since it was loaded.`
        : `The change was refused: the maximum cannot drop below what a student already holds, the ${lower(L.term)} must not be locked, or the group changed since it was loaded. Reload and try again.`;
    if (
      await action.run(
        () => updateElectiveGroup(client, group, body),
        status === 'OPEN'
          ? 'The group is open for choices.'
          : status === 'CLOSED'
            ? 'The group is closed. Its choices are final.'
            : 'Elective group updated.',
        { conflict },
      )
    )
      setEdit({ ...edit, opens: '', closes: '', why: '' });
  };

  const [rosterOf, setRosterOf] = useState('');
  const roster = regsOf(rosterOf);
  const paged = usePaged(roster);

  return (
    <Card title={`Elective group ${group.code}: ${group.name}`}>
      <Feedback error={action.error} notice={action.notice} />
      <dl className="defs">
        <dt>Status</dt>
        <dd>{group.status}</dd>
        <dt>Choices per student</dt>
        <dd>
          at least {group.minSelect}, at most {group.maxSelect}
        </dd>
        <dt>Window</dt>
        <dd>{windowText(group)}</dd>
      </dl>
      <h3>Basket</h3>
      {basket.length === 0 ? (
        <p className="muted">
          No offering of this {lower(L.term)} belongs to the group yet. Offerings join a group when
          they are created.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" aria-label={`Offerings in group ${group.code}`}>
            <thead>
              <tr>
                <th scope="col">{L.course}</th>
                <th scope="col">Status</th>
                <th scope="col">Places</th>
              </tr>
            </thead>
            <tbody>
              {basket.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.codeSnapshot} - {o.titleSnapshot}
                  </td>
                  <td>
                    <Badge>{o.status}</Badge>
                  </td>
                  <td>
                    {o.capacity === null || o.capacity === undefined
                      ? 'No limit'
                      : canRoster
                        ? `${live(o.id)} of ${o.capacity} taken`
                        : `${o.capacity} places`}
                    {full(o) && (
                      <>
                        {' '}
                        <Badge>Full</Badge>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rosters.error && <Alert tone="error">{rosters.error}</Alert>}

      {canRoster && basket.length > 0 && (
        <>
          <h3>Registrations</h3>
          <div className="field">
            <label htmlFor="elective-roster">Offering</label>
            <select
              id="elective-roster"
              value={rosterOf}
              onChange={(e) => {
                setRosterOf(e.target.value);
                paged.setPage(0);
              }}
            >
              <option value="">Select…</option>
              {basket.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.codeSnapshot}
                </option>
              ))}
            </select>
          </div>
          {rosterOf && roster.length === 0 && (
            <p className="muted">No registrations for this offering.</p>
          )}
          {roster.length > 0 && (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" aria-label="Registrations for the selected offering">
                  <thead>
                    <tr>
                      <th scope="col">Student</th>
                      <th scope="col">Status</th>
                      <th scope="col">Dates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.rows.map((r) => (
                      <tr key={r.id}>
                        <td>…{r.studentId.slice(-6)}</td>
                        <td>{REG_STATUS[r.status]}</td>
                        <td>
                          from {r.validFrom}
                          {r.validTo ? ` to ${r.validTo}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager label="Registration pages" {...paged} />
            </>
          )}
        </>
      )}

      {canRegister && (
        <StudentChoices
          client={client}
          group={group}
          basket={basket}
          full={full}
          onChanged={rosters.reload}
        />
      )}

      {canManage && group.status !== 'CLOSED' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void change();
          }}
          noValidate
          aria-label="Change elective group"
        >
          <h3>Change the group</h3>
          {editErr && <Alert tone="error">{editErr}</Alert>}
          <TextField
            label="Name"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            maxLength={255}
          />
          <TextField
            label="Minimum"
            value={edit.min}
            inputMode="numeric"
            onChange={(e) => setEdit({ ...edit, min: e.target.value })}
          />
          <TextField
            label="Maximum"
            value={edit.max}
            inputMode="numeric"
            onChange={(e) => setEdit({ ...edit, max: e.target.value })}
          />
          <TextField
            label="New window opening (optional, YYYY-MM-DD HH:MM)"
            value={edit.opens}
            onChange={(e) => setEdit({ ...edit, opens: e.target.value })}
          />
          <TextField
            label="New window closing (optional, YYYY-MM-DD HH:MM)"
            value={edit.closes}
            onChange={(e) => setEdit({ ...edit, closes: e.target.value })}
          />
          <TextField
            label="Reason for the change"
            value={edit.why}
            onChange={(e) => setEdit({ ...edit, why: e.target.value })}
            maxLength={500}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button type="submit" pending={action.pending}>
              Save changes
            </Button>
            {group.status === 'PLANNED' && (
              <Button
                type="button"
                variant="secondary"
                pending={action.pending}
                onClick={() => void change('OPEN')}
              >
                Open for choices
              </Button>
            )}
            {group.status === 'OPEN' && (
              <Button
                type="button"
                variant="secondary"
                pending={action.pending}
                onClick={() => void change('CLOSED')}
              >
                Close the group
              </Button>
            )}
          </div>
          {group.status === 'OPEN' && (
            <p className="field-hint">
              Closing is final and is refused while any enrolment holds fewer than the minimum.
            </p>
          )}
        </form>
      )}
    </Card>
  );
}

/** Records, approves and ends one student's choices in a group (staff on the student's behalf, doc 07 §3.2). */
function StudentChoices({
  client,
  group,
  basket,
  full,
  onChanged,
}: {
  client: ApiClient;
  group: ElectiveGroup;
  basket: Offering[];
  full: (o: Offering) => boolean;
  onChanged: () => void;
}) {
  const L = useLabels();
  const [studentId, setStudentId] = useState('');
  const [idErr, setIdErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    enrollments: TermEnrollment[];
    regs: Registration[];
  } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [enrollmentId, setEnrollmentId] = useState('');

  const reload = useCallback(
    (sid: string, keep?: string) => {
      setLoading(true);
      setLoadErr(null);
      fetchStudentEnrollments(client, sid)
        .then(async (all) => {
          const enrollments = all.filter((e) => e.cohortPeriodId === group.cohortPeriodId);
          const eid = keep ?? enrollments[0]?.id ?? '';
          const regs = eid ? await fetchEnrollmentRegistrations(client, eid) : [];
          setEnrollmentId(eid);
          setLoaded({ enrollments, regs: regs.filter((r) => r.electiveGroupId === group.id) });
        })
        .catch((e: unknown) => {
          setLoaded(null);
          setLoadErr(academicsErrorMessage(e));
        })
        .finally(() => setLoading(false));
    },
    [client, group.cohortPeriodId, group.id],
  );
  const action = useAction(() => {
    if (UUID.test(studentId.trim())) reload(studentId.trim(), enrollmentId);
    onChanged();
  });
  const lookup = (e: FormEvent) => {
    e.preventDefault();
    if (!UUID.test(studentId.trim())) {
      setIdErr('Enter the student ID (a UUID).');
      return;
    }
    setIdErr(null);
    reload(studentId.trim());
  };

  const held = loaded?.regs.filter(isLive) ?? [];
  const [choice, setChoice] = useState({ offering: '', from: todayIso(), pending: false, why: '' });
  const [choiceErr, setChoiceErr] = useState<string | null>(null);
  const choose = async (e: FormEvent) => {
    e.preventDefault();
    const o = basket.find((x) => x.id === choice.offering);
    if (!enrollmentId || !o || !DATE.test(choice.from) || choice.why.trim().length < 5) {
      setChoiceErr(
        'Load a student with an enrolment here, choose an offering, a start date (YYYY-MM-DD) and a reason of at least 5 characters.',
      );
      return;
    }
    setChoiceErr(null);
    const causes = [
      !windowOpen(group) && 'the group is not open for choices at this moment',
      held.length >= group.maxSelect &&
        `the student already holds the maximum of ${group.maxSelect}`,
      full(o) && 'the offering is full',
      held.some((r) => r.courseOfferingId === o.id) && 'the student already holds this offering',
    ].filter(Boolean);
    await action.run(
      () =>
        createRegistration(client, o.id, {
          termEnrollmentId: enrollmentId,
          validFrom: choice.from,
          source: 'ELECTIVE_CHOICE',
          ...(choice.pending ? { pendingApproval: true } : {}),
          reason: choice.why.trim(),
        }),
      choice.pending ? 'Choice recorded, awaiting approval.' : 'Choice registered.',
      {
        conflict: causes.length
          ? `The choice was refused: ${causes.join('; ')}.`
          : `The choice was refused. The enrolment must be registered or active, the date must lie in the ${lower(L.term)}, the student must be in the offering's ${lower(L.section)}, and there must be a place and a free choice when it is saved. Reload and check.`,
      },
    );
  };

  const [end, setEnd] = useState({ id: '', to: todayIso(), status: '', why: '' });
  const [endErr, setEndErr] = useState<string | null>(null);
  const target = held.find((r) => r.id === end.id);
  const finish = async (e: FormEvent) => {
    e.preventDefault();
    const status = end.status as 'REGISTERED' | 'REJECTED' | 'DROPPED' | 'WITHDRAWN';
    if (
      !target ||
      !status ||
      end.why.trim().length < 5 ||
      (status !== 'REGISTERED' && !DATE.test(end.to))
    ) {
      setEndErr(
        'Choose a current choice, what to do with it, a last day (YYYY-MM-DD) unless approving, and a reason of at least 5 characters.',
      );
      return;
    }
    setEndErr(null);
    await action.run(
      () =>
        updateRegistration(client, target, {
          status,
          ...(status === 'REGISTERED' ? {} : { validTo: end.to }),
          reason: end.why.trim(),
        }),
      `Choice ${REG_STATUS[status].toLowerCase()}.`,
      {
        conflict:
          'That change was refused: the last day must lie inside the term and not before the start, or the choice changed since it was loaded. Reload and try again.',
      },
    );
  };

  return (
    <>
      <h3>A student's choices</h3>
      <Feedback error={action.error} notice={action.notice} />
      <form onSubmit={lookup} noValidate aria-label="Find a student's choices">
        {idErr && <Alert tone="error">{idErr}</Alert>}
        <TextField
          label="Student ID"
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
        />
        <Button type="submit" pending={loading}>
          Load choices
        </Button>
      </form>
      {loadErr && <Alert tone="error">{loadErr}</Alert>}
      {loaded && loaded.enrollments.length === 0 && (
        <p className="muted">
          This student has no enrolment in the group's {lower(L.period)}, so there is nothing to
          choose for.
        </p>
      )}
      {loaded && loaded.enrollments.length > 0 && (
        <>
          {loaded.enrollments.length > 1 && (
            <div className="field">
              <label htmlFor="choice-enrollment">Enrolment</label>
              <select
                id="choice-enrollment"
                value={enrollmentId}
                onChange={(e) => reload(studentId.trim(), e.target.value)}
              >
                {loaded.enrollments.map((x) => (
                  <option key={x.id} value={x.id}>
                    {L.period} {x.periodNo} ({x.status})
                  </option>
                ))}
              </select>
            </div>
          )}
          <p aria-live="polite">
            Holds {held.length} of at most {group.maxSelect}
            {group.minSelect > 0
              ? held.length < group.minSelect
                ? ` (below the minimum of ${group.minSelect})`
                : ` (minimum of ${group.minSelect} met)`
              : ''}
            .
          </p>
          {loaded.regs.length > 0 && (
            <ul aria-label="Choices in this group">
              {loaded.regs.map((r) => (
                <li key={r.id}>
                  {basket.find((o) => o.id === r.courseOfferingId)?.codeSnapshot ?? 'Offering'} -{' '}
                  {REG_STATUS[r.status]} from {r.validFrom}
                  {r.validTo ? ` to ${r.validTo}` : ''}
                </li>
              ))}
            </ul>
          )}
          {group.status === 'OPEN' ? (
            <form onSubmit={(e) => void choose(e)} noValidate aria-label="Record a choice">
              {!windowOpen(group) && (
                <Alert tone="info">
                  The group is outside its window right now, so a new choice will be refused.
                </Alert>
              )}
              {choiceErr && <Alert tone="error">{choiceErr}</Alert>}
              <div className="field">
                <label htmlFor="choice-offering">Offering</label>
                <select
                  id="choice-offering"
                  value={choice.offering}
                  onChange={(e) => setChoice({ ...choice, offering: e.target.value })}
                >
                  <option value="">Select…</option>
                  {basket.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.codeSnapshot} - {o.titleSnapshot}
                      {full(o) ? ' (full)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                label="Registered from (YYYY-MM-DD)"
                value={choice.from}
                onChange={(e) => setChoice({ ...choice, from: e.target.value })}
              />
              <label style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={choice.pending}
                  onChange={(e) => setChoice({ ...choice, pending: e.target.checked })}
                />{' '}
                Needs approval before it counts as registered
              </label>
              <TextField
                label="Reason for the choice"
                value={choice.why}
                onChange={(e) => setChoice({ ...choice, why: e.target.value })}
                maxLength={500}
              />
              <Button type="submit" pending={action.pending}>
                Record choice
              </Button>
            </form>
          ) : (
            <p className="muted">
              {group.status === 'PLANNED'
                ? 'Choices can be recorded once the group is open.'
                : 'The group is closed: its choices are final.'}
            </p>
          )}
          {held.length > 0 && (
            <form onSubmit={(e) => void finish(e)} noValidate aria-label="Change a choice">
              <h3>Approve, reject or end a choice</h3>
              {endErr && <Alert tone="error">{endErr}</Alert>}
              <div className="field">
                <label htmlFor="choice-target">Current choice</label>
                <select
                  id="choice-target"
                  value={end.id}
                  onChange={(e) => setEnd({ ...end, id: e.target.value, status: '' })}
                >
                  <option value="">Select…</option>
                  {held.map((r) => (
                    <option key={r.id} value={r.id}>
                      {basket.find((o) => o.id === r.courseOfferingId)?.codeSnapshot ?? 'Offering'}{' '}
                      ({REG_STATUS[r.status]})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="choice-action">Action</label>
                <select
                  id="choice-action"
                  value={end.status}
                  onChange={(e) => setEnd({ ...end, status: e.target.value })}
                >
                  <option value="">Select…</option>
                  {target?.status === 'PENDING_APPROVAL' ? (
                    <>
                      <option value="REGISTERED">Approve</option>
                      <option value="REJECTED">Reject</option>
                    </>
                  ) : (
                    <>
                      <option value="DROPPED">Drop</option>
                      <option value="WITHDRAWN">Withdraw</option>
                    </>
                  )}
                </select>
              </div>
              {end.status !== 'REGISTERED' && (
                <TextField
                  label="Last day (YYYY-MM-DD)"
                  value={end.to}
                  onChange={(e) => setEnd({ ...end, to: e.target.value })}
                />
              )}
              <TextField
                label="Reason for the change"
                value={end.why}
                onChange={(e) => setEnd({ ...end, why: e.target.value })}
                maxLength={500}
              />
              <Button type="submit" pending={action.pending}>
                Apply
              </Button>
              <p className="field-hint">
                An ended choice stays in the history; a later choice is a new registration.
              </p>
            </form>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
const HOLIDAY_KIND: Record<Holiday['kind'], string> = {
  HOLIDAY: 'Holiday',
  NON_TEACHING_DAY: 'Non-teaching day',
  EVENT: 'Event',
};

/**
 * Organization-wide and campus holidays (doc 33 §4). A holiday is cancelled, never deleted; a moved holiday is a
 * cancellation plus a new declaration. Nothing can change on a date inside a LOCKED term of the affected campus (all
 * campuses for an organization-wide row), and only an organization-scoped administrator may write organization rows.
 */
function HolidaysTab({
  client,
  canManage,
  canCampuses,
}: {
  client: ApiClient;
  canManage: boolean;
  canCampuses: boolean;
}) {
  const L = useLabels();
  const terms = useList<Term>(useCallback(() => fetchTerms(client), [client]));
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  useEffect(() => {
    if (canCampuses)
      fetchCampuses(client)
        .then(setCampuses)
        .catch(() => setCampuses([]));
  }, [client, canCampuses]);
  const campusIds = [
    ...new Set([...campuses.map((c) => c.id), ...terms.items.map((t) => t.campusId)]),
  ];
  const campusName = (id: string | null) =>
    id === null
      ? 'Whole organization'
      : (campuses.find((c) => c.id === id)?.name ?? `Campus …${id.slice(-6)}`);
  /** The LOCKED term this date falls in, among the terms the caller can see. */
  const lockedTerm = (campusId: string | null, date: string) =>
    terms.items.find(
      (t) =>
        t.status === 'LOCKED' &&
        (campusId === null || t.campusId === campusId) &&
        t.startDate <= date &&
        date <= t.endDate,
    );

  const [campusFilter, setCampusFilter] = useState('');
  const [range, setRange] = useState({ from: '', to: '' });
  const [applied, setApplied] = useState({ from: '', to: '' });
  const [rangeErr, setRangeErr] = useState<string | null>(null);
  const holidays = useList<Holiday>(
    useCallback(
      () =>
        fetchHolidays(client, {
          ...(campusFilter ? { campusId: campusFilter } : {}),
          ...(applied.from ? { from: applied.from } : {}),
          ...(applied.to ? { to: applied.to } : {}),
        }),
      [client, campusFilter, applied],
    ),
  );
  const paged = usePaged(holidays.items);
  const action = useAction(holidays.reload);

  const ORG_ONLY =
    'Organization-wide holidays can be declared or changed only by an administrator with organization-wide access.';
  const conflictFor = (campusId: string | null, date: string) => {
    const t = lockedTerm(campusId, date);
    return t
      ? `Refused: ${date} lies in the locked ${lower(L.term)} ${t.code}. Nothing can be declared, renamed or cancelled there.`
      : `Refused: an active holiday with this name may already exist on that date for the same campus, a ${lower(L.term)} you cannot see may be locked on that date, or the holiday changed since it was loaded. Reload and try again.`;
  };

  const blank = { scope: '', date: '', name: '', kind: 'HOLIDAY' as Holiday['kind'], why: '' };
  const [form, setForm] = useState(blank);
  const [formErr, setFormErr] = useState<string | null>(null);
  const declare = async (e: FormEvent) => {
    e.preventDefault();
    if (!DATE.test(form.date) || !form.name.trim() || form.why.trim().length < 5) {
      setFormErr('Enter a date (YYYY-MM-DD), a name and a reason of at least 5 characters.');
      return;
    }
    setFormErr(null);
    const campusId = form.scope || null;
    if (
      await action.run(
        () =>
          createHoliday(client, {
            ...(campusId ? { campusId } : {}),
            holidayDate: form.date,
            name: form.name.trim(),
            kind: form.kind,
            reason: form.why.trim(),
          }),
        'Holiday declared.',
        {
          conflict: conflictFor(campusId, form.date),
          ...(campusId ? {} : { forbidden: ORG_ONLY }),
        },
      )
    )
      setForm(blank);
  };
  const formLock = DATE.test(form.date) ? lockedTerm(form.scope || null, form.date) : undefined;

  const [sel, setSel] = useState<Holiday | null>(null);
  const [edit, setEdit] = useState({ name: '', why: '' });
  const [editErr, setEditErr] = useState<string | null>(null);
  const pick = (h: Holiday) => {
    setSel(h);
    setEdit({ name: h.name, why: '' });
    setEditErr(null);
  };
  const change = async (cancel: boolean) => {
    if (!sel) return;
    const name = edit.name.trim();
    if (edit.why.trim().length < 5 || (!cancel && (!name || name === sel.name))) {
      setEditErr(
        cancel
          ? 'Give a reason of at least 5 characters for cancelling.'
          : 'Enter a different name and a reason of at least 5 characters.',
      );
      return;
    }
    setEditErr(null);
    if (
      await action.run(
        () =>
          updateHoliday(client, sel, {
            ...(cancel ? { status: 'CANCELLED' as const } : { name }),
            reason: edit.why.trim(),
          }),
        cancel ? `${sel.name} on ${sel.holidayDate} cancelled.` : 'Holiday renamed.',
        {
          conflict: conflictFor(sel.campusId, sel.holidayDate),
          ...(sel.campusId ? {} : { forbidden: ORG_ONLY }),
        },
      )
    )
      setSel(null);
  };
  const redeclare = (h: Holiday) => {
    setSel(null);
    setForm({ scope: h.campusId ?? '', date: h.holidayDate, name: h.name, kind: h.kind, why: '' });
    setFormErr(null);
    document.getElementById('holiday-declare')?.focus();
  };

  return (
    <>
      <Feedback error={action.error} notice={action.notice} />
      <h2>Holiday calendar</h2>
      <form
        noValidate
        aria-label="Filter holidays"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            (range.from && !DATE.test(range.from)) ||
            (range.to && !DATE.test(range.to)) ||
            (range.from && range.to && range.to < range.from)
          ) {
            setRangeErr('Enter dates as YYYY-MM-DD, the end not before the start.');
            return;
          }
          setRangeErr(null);
          setApplied({ ...range });
        }}
      >
        {rangeErr && <Alert tone="error">{rangeErr}</Alert>}
        <div className="field">
          <label htmlFor="holiday-campus">Calendar</label>
          <select
            id="holiday-campus"
            value={campusFilter}
            onChange={(e) => setCampusFilter(e.target.value)}
          >
            <option value="">Everything I can see</option>
            {campusIds.map((id) => (
              <option key={id} value={id}>
                {campusName(id)} (with organization-wide days)
              </option>
            ))}
          </select>
        </div>
        <TextField
          label="From (optional, YYYY-MM-DD)"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
        />
        <TextField
          label="To (optional, YYYY-MM-DD)"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
        />
        <Button type="submit" variant="secondary">
          Show holidays
        </Button>
      </form>
      {terms.error && (
        <Alert tone="error">
          {L.term} details could not be loaded, so locked {lower(plural(L.term))} cannot be shown.
        </Alert>
      )}
      <ListState
        loading={holidays.loading}
        error={holidays.error}
        empty={holidays.items.length === 0}
        emptyTitle="No holidays"
        emptyText="No holidays are declared for this selection."
        onRetry={holidays.reload}
      />
      {holidays.items.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" aria-label="Holidays">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Applies to</th>
                  <th scope="col">Status</th>
                  {canManage && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((h) => {
                  const lock = lockedTerm(h.campusId, h.holidayDate);
                  return (
                    <tr key={h.id}>
                      <td>{h.holidayDate}</td>
                      <td>{h.name}</td>
                      <td>{HOLIDAY_KIND[h.kind]}</td>
                      <td>{campusName(h.campusId)}</td>
                      <td>
                        <Badge>{h.status === 'ACTIVE' ? 'Active' : 'Cancelled'}</Badge>
                        {lock && (
                          <>
                            {' '}
                            <Badge>Locked {lower(L.term)}</Badge>
                          </>
                        )}
                      </td>
                      {canManage && (
                        <td>
                          {lock ? (
                            <span className="muted">
                              In locked {lower(L.term)} {lock.code}: cannot change
                            </span>
                          ) : h.status === 'ACTIVE' ? (
                            <Button variant="ghost" onClick={() => pick(h)}>
                              Change {h.name} on {h.holidayDate}
                            </Button>
                          ) : (
                            <Button variant="ghost" onClick={() => redeclare(h)}>
                              Re-declare {h.name} on {h.holidayDate}
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager label="Holiday pages" {...paged} />
        </>
      )}
      {canManage && sel && (
        <form
          noValidate
          aria-label="Change a holiday"
          onSubmit={(e) => {
            e.preventDefault();
            void change(false);
          }}
        >
          <h3>
            {sel.name} on {sel.holidayDate} ({campusName(sel.campusId)})
          </h3>
          <p className="field-hint">
            The date, campus and kind cannot change. To move a holiday, cancel it and declare it
            again on the new date.
          </p>
          {editErr && <Alert tone="error">{editErr}</Alert>}
          <TextField
            label="New name"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            maxLength={120}
          />
          <TextField
            label="Reason for the change"
            value={edit.why}
            onChange={(e) => setEdit({ ...edit, why: e.target.value })}
            maxLength={500}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button type="submit" pending={action.pending}>
              Rename
            </Button>
            <Button
              type="button"
              variant="secondary"
              pending={action.pending}
              onClick={() => void change(true)}
            >
              Cancel this holiday
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSel(null)}>
              Close
            </Button>
          </div>
        </form>
      )}
      {canManage && (
        <form onSubmit={(e) => void declare(e)} noValidate aria-label="Declare a holiday">
          <h3 id="holiday-declare" tabIndex={-1}>
            Declare a holiday
          </h3>
          {formErr && <Alert tone="error">{formErr}</Alert>}
          <div className="field">
            <label htmlFor="holiday-scope">Applies to</label>
            <select
              id="holiday-scope"
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
            >
              <option value="">Whole organization</option>
              {campusIds.map((id) => (
                <option key={id} value={id}>
                  {campusName(id)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Date (YYYY-MM-DD)"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
          {formLock && (
            <Alert tone="info">
              {form.date} lies in the locked {lower(L.term)} {formLock.code}; the declaration will
              be refused.
            </Alert>
          )}
          <TextField
            label="Holiday name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            maxLength={120}
          />
          <div className="field">
            <label htmlFor="holiday-kind">Kind</label>
            <select
              id="holiday-kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as Holiday['kind'] })}
            >
              {Object.entries(HOLIDAY_KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label="Reason for declaring"
            value={form.why}
            onChange={(e) => setForm({ ...form, why: e.target.value })}
            maxLength={500}
          />
          <Button type="submit" pending={action.pending}>
            Declare holiday
          </Button>
        </form>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
/** "Must be zero" items: done when nothing remains (doc 33 §7). */
const ZERO_ITEMS = new Set([
  'offeringsWithoutTeacher',
  'enrollmentsWithoutSection',
  'openTermsWithoutHolidays',
]);
function checklistLabel(key: string, L: Terminology): { title: string; todo: string } {
  const p = (w: string) => lower(plural(w));
  const map: Record<string, { title: string; todo: string }> = {
    campuses: { title: 'Active campuses', todo: 'Create a campus on the Organisation page.' },
    departments: {
      title: 'Active departments',
      todo: 'Create a department on the Organisation page.',
    },
    programs: { title: `Active ${p(L.program)}`, todo: `Create a ${lower(L.program)}.` },
    academicYears: {
      title: 'Planned or active academic years',
      todo: 'Create an academic year on the Calendar tab.',
    },
    terms: { title: `Open ${p(L.term)}`, todo: `Create a ${lower(L.term)} on the Calendar tab.` },
    cohortPeriods: {
      title: `Active ${lower(L.cohort)} ${p(L.period)} in open ${p(L.term)}`,
      todo: `Open a ${lower(L.cohort)} ${lower(L.period)} for an open ${lower(L.term)}.`,
    },
    sections: {
      title: `Active ${p(L.section)} of those ${p(L.period)}`,
      todo: `Create a ${lower(L.section)} on the ${plural(L.section)} tab.`,
    },
    courses: {
      title: `Active ${p(L.course)}`,
      todo: `Add a ${lower(L.course)} on the ${plural(L.course)} tab.`,
    },
    publishedOfferings: {
      title: `Published offerings in open ${p(L.term)}`,
      todo: 'Publish at least one course offering.',
    },
    offeringsWithoutTeacher: {
      title: 'Published offerings without a teacher to the end of their term',
      todo: 'Assign a teacher to every published offering.',
    },
    termEnrollments: {
      title: `Registered or active enrolments in open ${p(L.term)}`,
      todo: 'Enrol students on the Enrolment tab.',
    },
    enrollmentsWithoutSection: {
      title: `Live enrolments not placed in a ${lower(L.section)}`,
      todo: `Place every enrolled student in a ${lower(L.section)}.`,
    },
    courseRegistrations: {
      title: `Live course registrations in open ${p(L.term)}`,
      todo: 'Register students for their offerings.',
    },
    openTermsWithoutHolidays: {
      title: `Open ${p(L.term)} without any holiday`,
      todo: 'Declare the holidays of every open term on the Holidays tab.',
    },
  };
  return map[key] ?? { title: key, todo: 'Needs attention.' };
}

/**
 * The academic setup checklist (doc 33 §7). Every line is a count the server takes from the database each time it is
 * read: there is nothing to tick, and a line is done only when the data makes it so.
 */
function SetupTab({ client }: { client: ApiClient }) {
  const L = useLabels();
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; complete: boolean; items: ChecklistItem[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    fetchSetupChecklist(client)
      .then((d) => setState({ kind: 'ready', ...d }))
      .catch((err: unknown) =>
        setState({
          kind: 'error',
          message: hinted(err, {
            forbidden:
              'The setup checklist counts every campus, so it needs organization-wide access to academic terms.',
          }),
        }),
      );
  }, [client]);
  useEffect(load, [load]);

  return (
    <>
      <h2>Setup checklist</h2>
      <p className="muted">
        Each line is counted from the institution's records whenever this page loads. A line becomes
        verified only when the records show it; it cannot be marked complete by hand.
      </p>
      {state.kind === 'loading' && <Spinner label="Loading…" />}
      {state.kind === 'error' && (
        <Alert tone="error">
          {state.message}{' '}
          <Button variant="ghost" onClick={load}>
            Retry
          </Button>
        </Alert>
      )}
      {state.kind === 'ready' && (
        <>
          <Alert tone={state.complete ? 'success' : 'info'}>
            {state.complete
              ? 'Every item is verified by the records.'
              : `${state.items.filter((i) => !i.done).length} of ${state.items.length} items still need an administrator.`}
          </Alert>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" aria-label="Setup checklist">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Count</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {state.items.map((i) => {
                  const { title, todo } = checklistLabel(i.key, L);
                  return (
                    <tr key={i.key}>
                      <th scope="row">{title}</th>
                      <td>{i.count}</td>
                      <td>
                        {i.done ? (
                          <>
                            <Badge>Verified</Badge>{' '}
                            {ZERO_ITEMS.has(i.key) ? 'none remain' : 'present'}
                          </>
                        ) : (
                          <>
                            <Badge>Needs an administrator</Badge> {todo}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Button variant="secondary" onClick={load}>
            Count again
          </Button>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export function AcademicsPage() {
  usePageTitle('Academics');
  const { client, identity } = useAuth();
  const [tab, setTab] = useState<Tab>('calendar');
  const canProgramRead = Boolean(identity && can(identity, 'academic.program.read'));
  const navigate = useNavigate();
  const [labels, setLabels] = useState<Terminology>(DEFAULT_TERMINOLOGY);
  const [byCohort, setByCohort] = useState<Record<string, string>>({});
  const [labelsVersion, setLabelsVersion] = useState(0);
  useEffect(() => {
    if (!canProgramRead) return;
    let live = true;
    // A failure keeps the fallbacks: labels are display only, so nothing else depends on them.
    fetchTerminologyDetail(client)
      .then((d) => {
        if (!live) return;
        setLabels(d.labels);
        setByCohort(d.byCohort);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, canProgramRead, labelsVersion]);
  if (!identity) return null;
  const canTerm = can(identity, 'academic.term.manage');
  const canCourse = can(identity, 'academic.course.manage');
  const canSection = can(identity, 'academic.section.manage');
  const canEnrol = can(identity, 'enrollment.term.manage');
  const canEnrolRead = can(identity, 'enrollment.term.read', 'enrollment.term.manage');
  const tabs: Array<[Tab, string]> = [
    ['calendar', 'Calendar'],
    ['courses', plural(labels.course)],
    ['sections', plural(labels.section)],
    ['offerings', 'Offerings'],
    ...(canEnrolRead ? ([['enrolment', 'Enrolment']] as Array<[Tab, string]>) : []),
    ...(canProgramRead
      ? ([
          ['electives', 'Electives'],
          ['holidays', 'Holidays'],
        ] as Array<[Tab, string]>)
      : []),
    ...(canTerm
      ? ([
          ['wizard', 'Setup wizard'],
          ['setup', 'Setup checklist'],
        ] as Array<[Tab, string]>)
      : []),
  ];
  return (
    <LabelsContext value={labels}>
      <PeriodLabelsContext value={byCohort}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          <h1>Academics</h1>
          <div
            style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
            role="group"
            aria-label="Academics sections"
          >
            {tabs.map(([id, label]) => (
              <Button
                key={id}
                variant={tab === id ? 'primary' : 'secondary'}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <p className="lead">
          The academic calendar, course catalogue, sections, course offerings, electives, holidays
          and term enrolment. You see and can change only what your role allows.
        </p>
        {tab === 'calendar' && <CalendarTab client={client} canManage={canTerm} />}
        {tab === 'courses' && <CoursesTab client={client} canManage={canCourse} />}
        {tab === 'sections' && (
          <SectionsTab
            client={client}
            canManage={canSection}
            canRoster={canEnrolRead}
            canAssign={can(identity, 'academic.faculty.assign')}
          />
        )}
        {tab === 'offerings' && (
          <OfferingsTab
            client={client}
            showTeachers={identity.actorKind === 'STAFF'}
            canRooms={can(identity, 'org.structure.read')}
            canManage={can(identity, 'academic.offering.manage')}
            canAssign={can(identity, 'academic.faculty.assign')}
            canRegister={canEnrol}
            canRoster={canEnrolRead}
          />
        )}
        {tab === 'enrolment' && canEnrolRead && (
          <EnrolmentTab client={client} canManage={canEnrol} />
        )}
        {tab === 'electives' && canProgramRead && (
          <ElectivesTab
            client={client}
            canManage={can(identity, 'academic.offering.manage')}
            canRegister={canEnrol}
            canRoster={canEnrolRead}
          />
        )}
        {tab === 'holidays' && canProgramRead && (
          <HolidaysTab
            client={client}
            canManage={canTerm}
            canCampuses={canTerm || can(identity, 'org.structure.read')}
          />
        )}
        {tab === 'setup' && canTerm && <SetupTab client={client} />}
        {tab === 'wizard' && canTerm && (
          <SetupWizardTab
            client={client}
            canEditTerminology={can(identity, 'org.settings.manage')}
            canActivateYear={canTerm}
            onLabelsChanged={() => setLabelsVersion((v) => v + 1)}
            onGoTo={(target) =>
              target.startsWith('/') ? void navigate(target) : setTab(target as Tab)
            }
          />
        )}
      </PeriodLabelsContext>
    </LabelsContext>
  );
}
