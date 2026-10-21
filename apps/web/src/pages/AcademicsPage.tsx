import { useCallback, useEffect, useState, type FormEvent } from 'react';
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
  createAcademicYear,
  createCourse,
  createSection,
  createTerm,
  createTermEnrollment,
  fetchAcademicYears,
  fetchCohortPeriods,
  fetchCourses,
  fetchRoster,
  fetchSections,
  fetchStudentEnrollments,
  fetchTerms,
  placeInSection,
  setAcademicYearStatus,
  setTermStatus,
  type AcademicYear,
  type CohortPeriod,
  type Course,
  type RosterEntry,
  type Section,
  type Term,
  type TermEnrollment,
} from '../lib/api/academics-api';
import { fetchCampuses, type CampusItem } from '../lib/api/organisation-api';
import type { ApiClient } from '../lib/api/client';
import { academicsErrorMessage } from '../lib/api/messages';

type Tab = 'calendar' | 'courses' | 'sections' | 'enrolment';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Runs a mutation with a pending flag, a success notice and a fixed-wording error. */
function useAction(onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(
    async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        await work();
        setNotice(success);
        onDone();
        return true;
      } catch (err) {
        setError(academicsErrorMessage(err));
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

// ---------------------------------------------------------------------------------------------------------------
function CalendarTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
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

      <h2>Terms</h2>
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
          <h3>New term</h3>
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
      <h2>Courses</h2>
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
          <h3>New course</h3>
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
}: {
  client: ApiClient;
  canManage: boolean;
  canRoster: boolean;
}) {
  const periods = useList<CohortPeriod>(useCallback(() => fetchCohortPeriods(client), [client]));
  const sections = useList<Section>(useCallback(() => fetchSections(client), [client]));
  const action = useAction(sections.reload);
  const [period, setPeriod] = useState('');
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [roster, setRoster] = useState<{ section: Section; entries: RosterEntry[] } | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

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
      <h2>Sections</h2>
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
            <Card key={s.id} title={`Section ${s.name}`}>
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
      {canManage && (
        <form onSubmit={(e) => void submit(e)} noValidate aria-label="Create section">
          <h3>New section</h3>
          {err && <Alert tone="error">{err}</Alert>}
          <div className="field">
            <label htmlFor="section-period">Cohort period</label>
            <select id="section-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">Select…</option>
              {periods.items
                .filter((p) => p.status === 'ACTIVE')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    Period {p.periodNo} ({p.id.slice(-6)})
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

// ---------------------------------------------------------------------------------------------------------------
function EnrolmentTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
  const periods = useList<CohortPeriod>(useCallback(() => fetchCohortPeriods(client), [client]));
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
            <Card key={r.id} title={`Period ${r.periodNo}`}>
              <Badge>{r.status}</Badge>
              <dl className="defs">
                <dt>Roll number</dt>
                <dd>{r.rollNumber ?? 'Not set'}</dd>
                <dt>Section</dt>
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
                      Period {p.periodNo} ({p.id.slice(-6)})
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
                        Period {r.periodNo} ({r.status})
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
  if (!identity) return null;
  const canTerm = can(identity, 'academic.term.manage');
  const canCourse = can(identity, 'academic.course.manage');
  const canSection = can(identity, 'academic.section.manage');
  const canEnrol = can(identity, 'enrollment.term.manage');
  const canEnrolRead = can(identity, 'enrollment.term.read', 'enrollment.term.manage');
  const tabs: Array<[Tab, string]> = [
    ['calendar', 'Calendar'],
    ['courses', 'Courses'],
    ['sections', 'Sections'],
    ...(canEnrolRead ? ([['enrolment', 'Enrolment']] as Array<[Tab, string]>) : []),
  ];
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Academics</h1>
        <div
          style={{ display: 'flex', gap: 'var(--space-2)' }}
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
        The academic calendar, course catalogue, sections and term enrolment. You see and can change
        only what your role allows.
      </p>
      {tab === 'calendar' && <CalendarTab client={client} canManage={canTerm} />}
      {tab === 'courses' && <CoursesTab client={client} canManage={canCourse} />}
      {tab === 'sections' && (
        <SectionsTab client={client} canManage={canSection} canRoster={canEnrolRead} />
      )}
      {tab === 'enrolment' && canEnrolRead && <EnrolmentTab client={client} canManage={canEnrol} />}
    </>
  );
}
