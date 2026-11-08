import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { useStepUp } from '../features/auth/StepUp';
import {
  DEFAULT_TERMINOLOGY,
  TERMINOLOGY_SLOTS,
  activateTerm,
  createCohort,
  createCohortPeriod,
  createCurriculumCourse,
  createPeriodType,
  createProgram,
  fetchAcademicYears,
  fetchCohorts,
  fetchCourses,
  fetchPrograms,
  fetchSetupWizard,
  fetchTerminologyDetail,
  fetchTerms,
  setAcademicYearStatus,
  type Terminology,
  type TerminologyDetail,
  type Wizard,
  type WizardIssue,
  type WizardStep,
  type WizardTerm,
} from '../lib/api/academics-api';
import {
  createCampus,
  createDepartment,
  createEmployee,
  createPosting,
  createRoom,
  fetchCampuses,
  fetchDepartments,
  fetchEmployees,
  fetchSettings,
  putSetting,
} from '../lib/api/organisation-api';
import { fetchUsers } from '../lib/api/user-api';
import type { ApiClient } from '../lib/api/client';
import { isApiError } from '../lib/api/errors';
import { academicsErrorMessage } from '../lib/api/messages';
import { lower, plural, useLabels } from '../lib/terminology';

/**
 * The guided academic setup wizard (Task 8, doc 35). Every step's state comes from GET /academics/setup-wizard, which
 * counts the institution's records: a step is "saved" when its records exist, the wizard resumes wherever the records
 * stand, and revisiting a step shows what is already there instead of creating it again (the server refuses duplicate
 * codes and names). The forms call the existing create endpoints, so every server rule still applies. Nothing is
 * activated without the administrator pressing "Confirm activation".
 */

/** An academics tab id ("calendar", "sections", ...) or an app route ("/organisation"). */
type Target = string;
type Go = (target: Target) => void;

interface StepMeta {
  title: string;
  intro: string;
  links: Array<[Target, string]>;
}
function stepMeta(key: string, L: Terminology): StepMeta {
  const p = (w: string) => lower(plural(w));
  const m: Record<string, StepMeta> = {
    institution: {
      title: 'Institution and terminology',
      intro:
        'The words this institution uses for its academic structure. Labels change what screens say, never the records.',
      links: [],
    },
    campuses: {
      title: 'Campuses and departments',
      intro:
        'Every campus the institution runs and the departments that own its programmes and courses.',
      links: [['/organisation', 'Open Organisation']],
    },
    calendar: {
      title: `Academic years and ${p(L.term)}`,
      intro: `An academic year and, for each campus, the ${p(L.term)} that run inside it.`,
      links: [['calendar', 'Open Calendar']],
    },
    programmes: {
      title: `${plural(L.program)}, intakes and ${p(L.period)}`,
      intro: `Each ${lower(L.program)} has a period type and a length; an intake (${lower(L.cohort)}) holds one ${lower(L.period)} per ${lower(L.term)}.`,
      links: [],
    },
    sections: {
      title: `${plural(L.section)} and capacity`,
      intro: `The ${p(L.section)} of each ${lower(L.period)} and how many students each can hold.`,
      links: [['sections', `Open ${plural(L.section)}`]],
    },
    curriculum: {
      title: `${plural(L.course)} and curriculum`,
      intro: `The ${p(L.course)} taught and which ${lower(L.period)} of each ${lower(L.program)} they belong to.`,
      links: [['courses', `Open ${plural(L.course)}`]],
    },
    staff: {
      title: 'Teacher and staff records',
      intro: 'An employee record for every teacher and staff member who has an account.',
      links: [
        ['/users', 'Open Users'],
        ['/imports', 'Open Imports'],
      ],
    },
    assignments: {
      title: 'Postings and teacher assignments',
      intro: `Each employee's department posting, and a teacher for every published offering.`,
      links: [['offerings', 'Open Offerings']],
    },
    classTeachers: {
      title: 'Class teachers',
      intro: `Recommended where each ${lower(L.section)} has a class teacher (for example, schools). Never required.`,
      links: [['sections', `Open ${plural(L.section)}`]],
    },
    timetable: {
      title: 'Timetable and rooms',
      intro: 'Rooms on each campus and weekly timetable slots for the published offerings.',
      links: [['offerings', 'Open Offerings']],
    },
    holidays: {
      title: 'Holiday calendar',
      intro: `Holidays for each open ${lower(L.term)}, organization-wide or per campus.`,
      links: [['holidays', 'Open Holidays']],
    },
    enrolment: {
      title: 'Students and enrolment readiness',
      intro: `Student records, ${lower(L.term)} enrolments, ${lower(L.section)} placements and course registrations.`,
      links: [
        ['/imports', 'Open Imports'],
        ['/students', 'Open Students'],
        ['enrolment', 'Open Enrolment'],
      ],
    },
    review: {
      title: 'Review and activation',
      intro: `Check each planned ${lower(L.term)} and activate it when nothing blocks it.`,
      links: [],
    },
  };
  return m[key] ?? { title: key, intro: '', links: [] };
}

/** Fixed wording for each server code; `n` is the count the server reported. */
export function issueText(code: string, n: number, L: Terminology): string {
  const p = (w: string) => lower(plural(w));
  const many = (w: string) => (n === 1 ? lower(w) : p(w));
  const t: Record<string, string> = {
    NO_ACTIVE_CAMPUS: 'No active campus yet.',
    NO_ACTIVE_DEPARTMENT: 'No active department yet.',
    CAMPUS_WITHOUT_DEPARTMENT: `${n} campus${n === 1 ? ' has' : 'es have'} no department.`,
    NO_OPEN_ACADEMIC_YEAR: 'No planned or active academic year.',
    NO_OPEN_TERM: `No planned or active ${lower(L.term)}.`,
    CAMPUS_WITHOUT_OPEN_TERM: `${n} active campus${n === 1 ? ' has' : 'es have'} no open ${lower(L.term)}.`,
    NO_PERIOD_TYPE: 'No period type (for example Year, Semester or Grade) yet.',
    NO_ACTIVE_PROGRAMME: `No active ${lower(L.program)}.`,
    NO_ACTIVE_COHORT: `No active ${lower(L.cohort)}.`,
    NO_OPEN_COHORT_PERIOD: `No ${lower(L.period)} is open in a planned or active ${lower(L.term)}.`,
    PROGRAMME_WITHOUT_OPEN_PERIOD: `${n} ${many(L.program)} with no ${lower(L.period)} in an open ${lower(L.term)}.`,
    NO_OPEN_SECTION: `No ${lower(L.section)} in an open ${lower(L.term)}.`,
    PERIOD_WITHOUT_SECTION: `${n} ${many(L.period)} without a ${lower(L.section)}.`,
    SECTION_WITHOUT_CAPACITY: `${n} ${many(L.section)} without a capacity.`,
    NO_ACTIVE_COURSE: `No active ${lower(L.course)}.`,
    PROGRAMME_WITHOUT_CURRICULUM: `${n} ${many(L.program)} without curriculum ${p(L.course)}.`,
    NO_ACTIVE_EMPLOYEE: 'No active employee record.',
    NO_PUBLISHED_OFFERING: 'No published offering.',
    OFFERING_WITHOUT_TEACHER: `${n} published offering${n === 1 ? '' : 's'} without a teacher to the end of the ${lower(L.term)}.`,
    EMPLOYEE_WITHOUT_POSTING: `${n} employee${n === 1 ? '' : 's'} without a current primary posting.`,
    SECTION_WITHOUT_CLASS_TEACHER: `${n} ${many(L.section)} without a class teacher.`,
    NO_ROOM: 'No room recorded on any campus.',
    OFFERING_WITHOUT_SLOT: `${n} published offering${n === 1 ? '' : 's'} without a timetable slot.`,
    TERM_WITHOUT_HOLIDAY: `${n === 1 ? `This ${lower(L.term)} has` : `${n} open ${p(L.term)} have`} no holiday.`,
    NO_ACTIVE_STUDENT: 'No active student record.',
    NO_OPEN_ENROLMENT: `No student is enrolled in an open ${lower(L.term)}.`,
    ENROLMENT_WITHOUT_SECTION: `${n} enrolled student${n === 1 ? ' is' : 's are'} not placed in a ${lower(L.section)}.`,
    NO_LIVE_REGISTRATION: 'No course registration yet.',
    NO_ACTIVE_TERM: `No ${lower(L.term)} is active yet.`,
    CAMPUS_INACTIVE: 'Its campus is not active.',
    ACADEMIC_YEAR_NOT_ACTIVE: 'Its academic year is not active: activate the academic year first.',
    NO_COHORT_PERIOD: `No ${lower(L.period)} is open in it.`,
  };
  return t[code] ?? code;
}

const STATUS_TEXT: Record<WizardStep['status'], string> = {
  COMPLETE: 'Complete',
  ATTENTION: 'Needs attention',
  INCOMPLETE: 'Incomplete',
};

function Issues({ list, L }: { list: WizardIssue[]; L: Terminology }) {
  if (list.length === 0) return null;
  return (
    <ul>
      {list.map((i) => (
        <li key={i.code}>
          <Badge>{i.severity === 'ERROR' ? 'Required' : 'Recommended'}</Badge>{' '}
          {issueText(i.code, i.count, L)}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------
export function SetupWizardTab({
  client,
  canEditTerminology,
  canActivateYear,
  onLabelsChanged,
  onGoTo,
}: {
  client: ApiClient;
  canEditTerminology: boolean;
  canActivateYear: boolean;
  onLabelsChanged: () => void;
  onGoTo: Go;
}) {
  const L = useLabels();
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; w: Wizard } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [current, setCurrent] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchSetupWizard(client)
      .then((w) => {
        setState({ kind: 'ready', w });
        // resume: the step already open, else the first required step the records do not yet complete
        setCurrent(
          (cur) =>
            cur ??
            w.steps.find((s) => s.required && s.status === 'INCOMPLETE')?.key ??
            w.steps[0]?.key ??
            null,
        );
      })
      .catch((err: unknown) =>
        setState({
          kind: 'error',
          message:
            isApiError(err) && err.kind === 'forbidden'
              ? 'The setup wizard counts every campus, so it needs organization-wide access to academic terms.'
              : academicsErrorMessage(err),
        }),
      );
  }, [client]);
  useEffect(load, [load]);
  const choose = (key: string) => setCurrent(key);

  if (state.kind === 'loading') return <Spinner label="Loading…" />;
  if (state.kind === 'error')
    return (
      <>
        <h2>Academic setup wizard</h2>
        <Alert tone="error">
          {state.message}{' '}
          <Button variant="ghost" onClick={load}>
            Retry
          </Button>
        </Alert>
      </>
    );
  const { w } = state;
  const idx = Math.max(
    0,
    w.steps.findIndex((s) => s.key === current),
  );
  const step = w.steps[idx]!;
  const meta = stepMeta(step.key, L);
  const reload = () => load();

  return (
    <>
      <h2>Academic setup wizard</h2>
      <p className="muted">
        Each step is checked against {w.organizationName}'s records whenever this page loads. Your
        progress is the records themselves: leave at any time and continue later from here.
      </p>
      <div className="field">
        <label htmlFor="setup-progress">
          {w.requiredComplete} of {w.requiredSteps} required steps complete
        </label>
        <progress id="setup-progress" max={w.requiredSteps} value={w.requiredComplete} />
      </div>
      <nav aria-label="Setup steps">
        <ol className="wizard-steps">
          {w.steps.map((s, i) => (
            <li key={s.key}>
              <Button
                variant={s.key === step.key ? 'primary' : 'ghost'}
                aria-current={s.key === step.key ? 'step' : undefined}
                onClick={() => choose(s.key)}
              >
                {i + 1}. {stepMeta(s.key, L).title}
              </Button>{' '}
              <Badge>{STATUS_TEXT[s.status]}</Badge> {s.required ? null : <Badge>Optional</Badge>}
            </li>
          ))}
        </ol>
      </nav>

      <Card headingLevel={3} title={`Step ${idx + 1} of ${w.steps.length}: ${meta.title}`}>
        <p>
          <Badge>{STATUS_TEXT[step.status]}</Badge>{' '}
          {step.required
            ? 'Required step.'
            : 'Optional recommendation: it never blocks activation.'}
        </p>
        <p className="muted">{meta.intro}</p>
        {Object.keys(step.counts).length > 0 && (
          <p>
            {Object.entries(step.counts)
              .map(([k, v]) => `${countLabel(k, L)}: ${v}`)
              .join(' · ')}
          </p>
        )}
        {step.issues.length === 0 ? (
          <Alert tone="success">Nothing is missing in this step.</Alert>
        ) : (
          <Issues list={step.issues} L={L} />
        )}
        {meta.links.length > 0 && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            {meta.links.map(([target, label]) => (
              <Button key={target} variant="secondary" onClick={() => onGoTo(target)}>
                {label}
              </Button>
            ))}
          </div>
        )}
        <StepBody
          step={step.key}
          w={w}
          client={client}
          canEditTerminology={canEditTerminology}
          canActivateYear={canActivateYear}
          onLabelsChanged={onLabelsChanged}
          onChanged={reload}
        />
      </Card>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button
          variant="secondary"
          disabled={idx === 0}
          onClick={() => choose(w.steps[idx - 1]!.key)}
        >
          Previous step
        </Button>
        <Button
          variant="secondary"
          disabled={idx === w.steps.length - 1}
          onClick={() => choose(w.steps[idx + 1]!.key)}
        >
          Next step
        </Button>
        <Button variant="ghost" onClick={reload}>
          Check again
        </Button>
      </div>
    </>
  );
}

function countLabel(k: string, L: Terminology): string {
  const p = (w: string) => plural(w);
  const m: Record<string, string> = {
    campuses: 'Campuses',
    departments: 'Departments',
    academicYears: 'Open academic years',
    terms: `Open ${lower(p(L.term))}`,
    periodTypes: 'Period types',
    programmes: p(L.program),
    cohorts: p(L.cohort),
    cohortPeriods: `Open ${lower(p(L.period))}`,
    sections: p(L.section),
    courses: p(L.course),
    employees: 'Employees',
    offerings: 'Published offerings',
    rooms: 'Rooms',
    students: 'Students',
    enrolments: 'Enrolments',
    registrations: 'Course registrations',
    activeTerms: `Active ${lower(p(L.term))}`,
  };
  return m[k] ?? k;
}

function StepBody(props: {
  step: string;
  w: Wizard;
  client: ApiClient;
  canEditTerminology: boolean;
  canActivateYear: boolean;
  onLabelsChanged: () => void;
  onChanged: () => void;
}) {
  const { identity } = useAuth();
  const { client, onChanged } = props;
  const has = (p: string) => Boolean(identity && can(identity, p));
  switch (props.step) {
    case 'institution':
      return (
        <>
          <InstitutionTypeForm client={client} canEdit={props.canEditTerminology} />
          <TerminologyEditor
            client={client}
            canEdit={props.canEditTerminology}
            onSaved={() => {
              props.onLabelsChanged();
              onChanged();
            }}
          />
        </>
      );
    case 'campuses':
      return (
        <>
          <CampusTable w={props.w} />
          {has('org.campus.manage') && <CampusForm client={client} onDone={onChanged} />}
          {has('org.department.manage') && (
            <DepartmentForm client={client} onDone={onChanged} refresh={props.w} />
          )}
        </>
      );
    case 'programmes':
      return <ProgrammeForms client={client} onDone={onChanged} has={has} />;
    case 'curriculum':
      return has('academic.course.manage') ? (
        <CurriculumForm client={client} onDone={onChanged} />
      ) : null;
    case 'staff':
      return has('employee.record.create') ? (
        <EmployeeForm client={client} onDone={onChanged} />
      ) : null;
    case 'assignments':
      return has('employee.record.update') ? (
        <PostingForm client={client} onDone={onChanged} />
      ) : null;
    case 'timetable':
      return has('org.campus.manage') ? <RoomForm client={client} onDone={onChanged} /> : null;
    case 'review':
      return (
        <ReviewStep
          w={props.w}
          client={client}
          canActivateYear={props.canActivateYear}
          onChanged={onChanged}
        />
      );
    default:
      return null;
  }
}

function CampusTable({ w }: { w: Wizard }) {
  const L = useLabels();
  if (w.campuses.length === 0) return null;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" aria-label="Campus readiness">
        <thead>
          <tr>
            <th scope="col">Campus</th>
            <th scope="col">Status</th>
            <th scope="col">Departments</th>
            <th scope="col">Open {lower(plural(L.term))}</th>
            <th scope="col">{plural(L.section)}</th>
            <th scope="col">Posted staff</th>
            <th scope="col">Rooms</th>
            <th scope="col">Campus holidays</th>
          </tr>
        </thead>
        <tbody>
          {w.campuses.map((c) => (
            <tr key={c.id}>
              <th scope="row">
                {c.name} ({c.code})
              </th>
              <td>{c.status}</td>
              <td>{c.departments}</td>
              <td>{c.openTerms}</td>
              <td>{c.openSections}</td>
              <td>{c.postedEmployees}</td>
              <td>{c.rooms}</td>
              <td>{c.campusHolidays}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- small create forms over the existing endpoints -----------------------------------------------------------
interface Field {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  options?: Array<[string, string]>;
  optional?: boolean;
  hint?: string;
  initial?: string;
}
type Values = Record<string, string>;

/**
 * One create form: required fields are checked here for a quick message, everything else is the server's (its 400/409
 * answer is shown in fixed wording). A refused duplicate is reported as such, so retrying a step never adds a copy.
 */
function QuickCreate({
  title,
  fields,
  submit,
  onDone,
  conflict,
}: {
  title: string;
  fields: Field[];
  submit: (v: Values) => Promise<unknown>;
  onDone: () => void;
  conflict: string;
}) {
  const { runWithStepUp } = useStepUp();
  const init = useCallback(
    () =>
      Object.fromEntries(
        fields.map((f) => [f.name, f.initial ?? (f.type === 'checkbox' ? 'true' : '')]),
      ),
    [fields],
  );
  const [values, setValues] = useState<Values>(init);
  const [errors, setErrors] = useState<Values>({});
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: Values = {};
    for (const f of fields) {
      const v = (values[f.name] ?? '').trim();
      if (!f.optional && f.type !== 'checkbox' && v === '') errs[f.name] = 'Required.';
      else if (f.type === 'number' && v !== '' && !/^\d+$/.test(v))
        errs[f.name] = 'A whole number.';
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setPending(true);
    setMsg(null);
    try {
      await runWithStepUp(() => submit(values));
      setMsg({ ok: true, text: 'Created.' });
      setValues(init());
      onDone();
    } catch (err) {
      setMsg({
        ok: false,
        text: isApiError(err) && err.status === 409 ? conflict : academicsErrorMessage(err),
      });
    } finally {
      setPending(false);
    }
  };
  const id = title.replace(/\W+/g, '-').toLowerCase();
  return (
    <form onSubmit={(e) => void onSubmit(e)} noValidate aria-label={title}>
      <h4>{title}</h4>
      {fields.map((f) =>
        f.type === 'select' ? (
          <div className="field" key={f.name}>
            <label htmlFor={`${id}-${f.name}`}>{f.label}</label>
            <select
              id={`${id}-${f.name}`}
              value={values[f.name]}
              onChange={(e) => set(f.name, e.target.value)}
              aria-invalid={errors[f.name] ? true : undefined}
            >
              <option value="">Select…</option>
              {(f.options ?? []).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {errors[f.name] && <p className="field-error">{errors[f.name]}</p>}
          </div>
        ) : f.type === 'checkbox' ? (
          <div className="field" key={f.name}>
            <label>
              <input
                type="checkbox"
                checked={values[f.name] === 'true'}
                onChange={(e) => set(f.name, String(e.target.checked))}
              />{' '}
              {f.label}
            </label>
          </div>
        ) : (
          <TextField
            key={f.name}
            label={f.label}
            type={f.type === 'number' ? 'text' : (f.type ?? 'text')}
            inputMode={f.type === 'number' ? 'numeric' : undefined}
            value={values[f.name] ?? ''}
            onChange={(e) => set(f.name, e.target.value)}
            error={errors[f.name]}
            hint={f.hint}
          />
        ),
      )}
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <Button type="submit" pending={pending}>
        Create
      </Button>
    </form>
  );
}

/** Loads option lists once; a failure leaves the list empty (the form then cannot be submitted). */
function useOptions<T>(load: () => Promise<T[]>, deps: unknown[]): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let live = true;
    load()
      .then((x) => live && setItems(x))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return items;
}

function CampusForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  return (
    <QuickCreate
      title="Add a campus"
      fields={[
        { name: 'name', label: 'Campus name' },
        { name: 'code', label: 'Campus code', hint: 'Unique; cannot change later.' },
        { name: 'timezone', label: 'Time zone (IANA)', initial: 'Asia/Kolkata' },
      ]}
      submit={(v) => createCampus(client, { name: v.name!, code: v.code!, timezone: v.timezone! })}
      onDone={onDone}
      conflict="A campus with this code already exists: it is already in the table above."
    />
  );
}

function DepartmentForm({
  client,
  onDone,
  refresh,
}: {
  client: ApiClient;
  onDone: () => void;
  /** Changes whenever the wizard reloads, so a campus created just above appears in the list (found in the browser rehearsal). */
  refresh?: unknown;
}) {
  const [tick, setTick] = useState(0);
  const campuses = useOptions(() => fetchCampuses(client), [client, tick, refresh]);
  return (
    <QuickCreate
      title="Add a department"
      fields={[
        {
          name: 'campusId',
          label: 'Campus',
          type: 'select',
          options: campuses.map((c) => [c.id, `${c.name} (${c.code})`]),
        },
        { name: 'name', label: 'Department name' },
        { name: 'code', label: 'Department code' },
      ]}
      submit={(v) =>
        createDepartment(client, { campusId: v.campusId!, name: v.name!, code: v.code! })
      }
      onDone={() => {
        setTick((t) => t + 1);
        onDone();
      }}
      conflict="A department with this code already exists on that campus."
    />
  );
}

function ProgrammeForms({
  client,
  onDone,
  has,
}: {
  client: ApiClient;
  onDone: () => void;
  has: (p: string) => boolean;
}) {
  const L = useLabels();
  const [tick, setTick] = useState(0);
  const done = () => {
    setTick((t) => t + 1);
    onDone();
  };
  const terminology = useOptions<TerminologyDetail>(
    () => fetchTerminologyDetail(client).then((d) => [d]),
    [client, tick],
  )[0];
  const departments = useOptions(() => fetchDepartments(client), [client, tick]);
  const programs = useOptions(() => fetchPrograms(client), [client, tick]);
  const cohorts = useOptions(() => fetchCohorts(client), [client, tick]);
  const terms = useOptions(() => fetchTerms(client), [client, tick]);
  const types = terminology?.periodTypes ?? [];
  return (
    <>
      {has('academic.program.manage') && (
        <>
          <QuickCreate
            title="Add a period type"
            fields={[
              { name: 'code', label: 'Code', hint: 'For example GRADE, YEAR or SEMESTER.' },
              { name: 'label', label: 'Label', hint: 'For example Grade.' },
              { name: 'labelPlural', label: 'Plural label', hint: 'For example Grades.' },
            ]}
            submit={(v) =>
              createPeriodType(client, {
                code: v.code!,
                label: v.label!,
                labelPlural: v.labelPlural!,
              })
            }
            onDone={done}
            conflict="A period type with this code already exists."
          />
          <QuickCreate
            title={`Add a ${lower(L.program)}`}
            fields={[
              {
                name: 'departmentId',
                label: 'Owning department',
                type: 'select',
                options: departments.map((d) => [d.id, `${d.name} (${d.code})`]),
              },
              {
                name: 'periodTypeId',
                label: 'Period type',
                type: 'select',
                options: types.map((t) => [t.id, `${t.periodTypeLabel} (${t.code})`]),
              },
              { name: 'name', label: 'Name' },
              { name: 'code', label: 'Code' },
              { name: 'degreeLevel', label: 'Level', hint: 'For example SCHOOL, UG or PG.' },
              {
                name: 'durationPeriods',
                label: `Number of ${lower(plural(L.period))}`,
                type: 'number',
              },
              { name: 'periodsPerYear', label: 'Periods per year', type: 'number', optional: true },
            ]}
            submit={(v) =>
              createProgram(client, {
                departmentId: v.departmentId!,
                periodTypeId: v.periodTypeId!,
                name: v.name!,
                code: v.code!,
                degreeLevel: v.degreeLevel!,
                durationPeriods: Number(v.durationPeriods),
                ...(v.periodsPerYear ? { periodsPerYear: Number(v.periodsPerYear) } : {}),
              })
            }
            onDone={done}
            conflict={`A ${lower(L.program)} with this code already exists.`}
          />
        </>
      )}
      {has('academic.cohort.manage') && (
        <>
          <QuickCreate
            title={`Add a ${lower(L.cohort)}`}
            fields={[
              {
                name: 'programId',
                label: L.program,
                type: 'select',
                options: programs.map((p) => [p.id, `${p.name} (${p.code})`]),
              },
              { name: 'admissionYear', label: 'Admission year', type: 'number' },
              { name: 'name', label: 'Name' },
            ]}
            submit={(v) =>
              createCohort(client, {
                programId: v.programId!,
                admissionYear: Number(v.admissionYear),
                name: v.name!,
              })
            }
            onDone={done}
            conflict={`That ${lower(L.cohort)} already exists for this ${lower(L.program)}.`}
          />
          <QuickCreate
            title={`Open a ${lower(L.period)} in a ${lower(L.term)}`}
            fields={[
              {
                name: 'cohortId',
                label: L.cohort,
                type: 'select',
                options: cohorts.map((c) => [c.id, c.name]),
              },
              {
                name: 'termId',
                label: L.term,
                type: 'select',
                options: terms
                  .filter((t) => t.status === 'PLANNED' || t.status === 'ACTIVE')
                  .map((t) => [t.id, `${t.code} (${t.status})`]),
              },
              { name: 'periodNo', label: `${L.period} number`, type: 'number' },
            ]}
            submit={(v) =>
              createCohortPeriod(client, {
                cohortId: v.cohortId!,
                termId: v.termId!,
                periodNo: Number(v.periodNo),
              })
            }
            onDone={done}
            conflict={`That ${lower(L.cohort)} already has a ${lower(L.period)} in this ${lower(L.term)}, or the number is outside its ${lower(L.program)}.`}
          />
        </>
      )}
    </>
  );
}

function CurriculumForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const L = useLabels();
  const programs = useOptions(() => fetchPrograms(client), [client]);
  const courses = useOptions(() => fetchCourses(client), [client]);
  return (
    <QuickCreate
      title={`Add a ${lower(L.course)} to a curriculum`}
      fields={[
        {
          name: 'programId',
          label: L.program,
          type: 'select',
          options: programs.map((p) => [p.id, `${p.name} (${p.code})`]),
        },
        {
          name: 'courseId',
          label: L.course,
          type: 'select',
          options: courses.map((c) => [c.id, `${c.code} ${c.title}`]),
        },
        { name: 'regulation', label: 'Regulation', hint: 'For example R2026.' },
        { name: 'periodNo', label: `${L.period} number`, type: 'number' },
        {
          name: 'category',
          label: 'Category',
          type: 'select',
          options: ['CORE', 'ELECTIVE', 'OPTIONAL', 'LAB', 'PROJECT', 'INTERNSHIP'].map((c) => [
            c,
            c,
          ]),
        },
      ]}
      submit={(v) =>
        createCurriculumCourse(client, {
          programId: v.programId!,
          courseId: v.courseId!,
          regulation: v.regulation!,
          periodNo: Number(v.periodNo),
          category: v.category!,
        })
      }
      onDone={onDone}
      conflict={`That ${lower(L.course)} is already in this curriculum.`}
    />
  );
}

function EmployeeForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const users = useOptions(
    () => fetchUsers(client, { status: 'ACTIVE' }).then((r) => r.users),
    [client],
  );
  return (
    <QuickCreate
      title="Add an employee record"
      fields={[
        {
          name: 'userId',
          label: 'Account',
          type: 'select',
          options: users.map((u) => [u.id, `${u.displayName} (${u.email})`]),
        },
        { name: 'employeeCode', label: 'Employee code' },
        {
          name: 'employeeType',
          label: 'Type',
          type: 'select',
          options: ['FACULTY', 'STAFF', 'ADMIN', 'VISITING'].map((t) => [t, t]),
        },
        { name: 'joiningDate', label: 'Joining date (YYYY-MM-DD)', type: 'date' },
        { name: 'reason', label: 'Reason' },
      ]}
      submit={(v) =>
        createEmployee(client, {
          userId: v.userId!,
          employeeCode: v.employeeCode!,
          employeeType: v.employeeType!,
          joiningDate: v.joiningDate!,
          reason: v.reason!,
        })
      }
      onDone={onDone}
      conflict="That account already has an employee record, or the code is used."
    />
  );
}

function PostingForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const employees = useOptions(() => fetchEmployees(client), [client]);
  const departments = useOptions(() => fetchDepartments(client), [client]);
  return (
    <QuickCreate
      title="Post an employee to a department"
      fields={[
        {
          name: 'employeeId',
          label: 'Employee',
          type: 'select',
          options: employees
            .filter((e) => e.status === 'ACTIVE')
            .map((e) => [e.id, `${e.employeeCode} (${e.employeeType})`]),
        },
        {
          name: 'departmentId',
          label: 'Department',
          type: 'select',
          options: departments.map((d) => [d.id, `${d.name} (${d.code})`]),
        },
        { name: 'validFrom', label: 'From (YYYY-MM-DD)', type: 'date' },
        { name: 'isPrimary', label: 'Primary posting', type: 'checkbox' },
        { name: 'reason', label: 'Reason' },
      ]}
      submit={(v) =>
        createPosting(client, v.employeeId!, {
          departmentId: v.departmentId!,
          validFrom: v.validFrom!,
          isPrimary: v.isPrimary === 'true',
          reason: v.reason!,
        })
      }
      onDone={onDone}
      conflict="That posting overlaps an existing one for this employee."
    />
  );
}

function RoomForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const campuses = useOptions(() => fetchCampuses(client), [client]);
  return (
    <QuickCreate
      title="Add a room"
      fields={[
        {
          name: 'campusId',
          label: 'Campus',
          type: 'select',
          options: campuses.map((c) => [c.id, `${c.name} (${c.code})`]),
        },
        { name: 'code', label: 'Room code' },
        { name: 'kind', label: 'Kind', hint: 'For example CLASSROOM or LAB.' },
        { name: 'capacity', label: 'Capacity', type: 'number', optional: true },
      ]}
      submit={(v) =>
        createRoom(client, v.campusId!, {
          code: v.code!,
          kind: v.kind!,
          ...(v.capacity ? { capacity: Number(v.capacity) } : {}),
        })
      }
      onDone={onDone}
      conflict="A room with this code already exists on that campus."
    />
  );
}

// ---- review and activation --------------------------------------------------------------------------------------
function ReviewStep({
  w,
  client,
  canActivateYear,
  onChanged,
}: {
  w: Wizard;
  client: ApiClient;
  canActivateYear: boolean;
  onChanged: () => void;
}) {
  const L = useLabels();
  const incomplete = w.steps.filter((s) => s.required && s.status === 'INCOMPLETE');
  if (w.terms.length === 0)
    return <p>No planned or active {lower(L.term)} yet: create one in the calendar step.</p>;
  return (
    <>
      {incomplete.length > 0 && (
        <Alert tone="info">
          Required steps still incomplete:{' '}
          {incomplete.map((s) => stepMeta(s.key, L).title).join(', ')}. A {lower(L.term)} can still
          be activated once its own blocking items are resolved.
        </Alert>
      )}
      {w.terms.map((t) => (
        <TermCard
          key={t.id}
          t={t}
          client={client}
          canActivateYear={canActivateYear}
          onChanged={onChanged}
        />
      ))}
    </>
  );
}

function TermCard({
  t,
  client,
  canActivateYear,
  onChanged,
}: {
  t: WizardTerm;
  client: ApiClient;
  canActivateYear: boolean;
  onChanged: () => void;
}) {
  const L = useLabels();
  const { runWithStepUp } = useStepUp();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (work: () => Promise<unknown>, success: string, refused: string) => {
    setPending(true);
    setMsg(null);
    try {
      await runWithStepUp(work);
      setMsg({ ok: true, text: success });
      setConfirming(false);
      onChanged();
    } catch (err) {
      setMsg({
        ok: false,
        text: isApiError(err) && err.status === 409 ? refused : academicsErrorMessage(err),
      });
      onChanged();
    } finally {
      setPending(false);
    }
  };
  const activateYear = () =>
    run(
      async () => {
        const year = (await fetchAcademicYears(client)).find((y) => y.id === t.academicYearId);
        if (!year) throw new Error('missing year');
        return setAcademicYearStatus(client, year, 'ACTIVE');
      },
      `Academic year ${t.academicYearLabel} activated.`,
      'The academic year changed since this page loaded. Check again and retry.',
    );
  const reasonError =
    reason.trim() !== '' && reason.trim().length < 5 ? 'At least 5 characters.' : undefined;
  return (
    <section className="card" aria-labelledby={`term-${t.id}`}>
      <h4 id={`term-${t.id}`}>{`${t.name} (${t.code}), ${t.campusName}`}</h4>
      <p>
        <Badge>{t.status}</Badge> {t.startDate} to {t.endDate}. Academic year {t.academicYearLabel}{' '}
        ({t.academicYearStatus}).
      </p>
      {t.blocking.length > 0 && (
        <>
          <h5>Blocking activation</h5>
          <Issues list={t.blocking} L={L} />
        </>
      )}
      {t.warnings.length > 0 && (
        <>
          <h5>Recommendations (do not block)</h5>
          <Issues list={t.warnings} L={L} />
        </>
      )}
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      {t.status === 'PLANNED' && t.academicYearStatus === 'PLANNED' && canActivateYear && (
        <Button variant="secondary" pending={pending} onClick={() => void activateYear()}>
          Activate academic year {t.academicYearLabel}
        </Button>
      )}
      {t.status === 'PLANNED' && !confirming && (
        <Button disabled={!t.activatable} onClick={() => setConfirming(true)}>
          Activate {lower(L.term)} {t.code}
        </Button>
      )}
      {t.status === 'PLANNED' && !t.activatable && (
        <p className="muted">Resolve the blocking items above to activate this {lower(L.term)}.</p>
      )}
      {confirming && (
        <form
          aria-label={`Confirm activation of ${t.code}`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (reasonError) return;
            void run(
              () => activateTerm(client, t, reason.trim() || undefined),
              `${L.term} ${t.code} is now active.`,
              `The server found items still blocking this ${lower(L.term)}, or it changed since this page loaded. The list has been refreshed.`,
            );
          }}
        >
          <p>
            Activating makes {t.code} the running {lower(L.term)} of {t.campusName}.
            {t.warnings.length > 0
              ? ` ${t.warnings.length} recommendation${t.warnings.length === 1 ? ' is' : 's are'} still open; you accept them by confirming.`
              : ''}
          </p>
          <TextField
            label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            error={reasonError}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button type="submit" pending={pending}>
              Confirm activation
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

// ---- terminology editor -----------------------------------------------------------------------------------------
const SLOT_TEXT: Record<(typeof TERMINOLOGY_SLOTS)[number], string> = {
  program: 'Programme (the model: programme)',
  cohort: 'Intake group (the model: cohort)',
  period: 'Period, institution-wide (the model: cohort period)',
  section: 'Section (the model: section)',
  term: 'Term (the model: term)',
  course: 'Course (the model: course)',
};
type Draft = Record<string, string>;
const PRESETS: Record<'school' | 'college' | 'university', Partial<Terminology>> = {
  school: {
    program: 'Class',
    period: 'Grade',
    course: 'Subject',
    section: 'Section',
    term: 'Term',
  },
  college: { program: 'Programme', course: 'Course', section: 'Section' },
  university: { program: 'Programme', period: 'Semester', course: 'Course', section: 'Section' },
};
/** Plain text: no leading/trailing whitespace, control characters or angle brackets (the server's LABEL pattern). */
const labelOk = (v: string) =>
  v.trim() === v &&
  ![...v].some(
    (ch) => ch === '<' || ch === '>' || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
  );
const norm = (x: string) => x.trim().replace(/\s+/g, ' ').toLowerCase();

/** The same rules the server applies (registry `terminology`); the server stays authoritative. */
export function validateLabels(slots: Draft, types: Draft): Draft {
  const errors: Draft = {};
  const check = (key: string, v: string) => {
    if (v === '') return;
    if (v.length > 40) errors[key] = 'At most 40 characters.';
    else if (!labelOk(v))
      errors[key] = 'No leading or trailing spaces, line breaks, tabs or angle brackets.';
  };
  for (const [k, v] of Object.entries(slots)) check(k, v);
  for (const [k, v] of Object.entries(types)) check(`pt:${k}`, v);
  const effective = TERMINOLOGY_SLOTS.map((k) => [k, norm(slots[k] || DEFAULT_TERMINOLOGY[k])]);
  for (const [k, l] of effective) {
    const twin = effective.find(([k2, l2]) => k2 !== k && l2 === l);
    if (twin && !errors[k!]) errors[k!] = `Same as the ${twin[0]} label; labels must differ.`;
  }
  for (const [code, v] of Object.entries(types)) {
    const twin = effective.find(([k2, l2]) => k2 !== 'period' && l2 === norm(v));
    if (v !== '' && twin && !errors[`pt:${code}`])
      errors[`pt:${code}`] = `Same as the ${twin[0]} label; labels must differ.`;
  }
  return errors;
}

const INSTITUTION_TYPES = [
  ['SCHOOL', 'School'],
  ['COLLEGE', 'College'],
  ['UNIVERSITY', 'University'],
] as const;

/**
 * Doc 44: the institution picks School, College or University. It changes the role names and wording shown, never what anyone
 * may do. The server refuses a change once academic years exist.
 */
function InstitutionTypeForm({ client, canEdit }: { client: ApiClient; canEdit: boolean }) {
  const { runWithStepUp } = useStepUp();
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [version, setVersion] = useState<number | null>(null);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await fetchTerminologyDetail(client);
      setCurrent(d.institutionType);
      setChoice(d.institutionType ?? '');
      if (canEdit) {
        const row = (await fetchSettings(client)).find((x) => x.key === 'institution.type');
        setVersion(row?.version ?? null);
      }
    } catch (err) {
      setError(academicsErrorMessage(err));
    }
  }, [client, canEdit]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (current === undefined) return <Spinner label="Loading institution type…" />;
  const name = INSTITUTION_TYPES.find(([v]) => v === current)?.[1];
  if (!canEdit)
    return (
      <p className="muted">
        Institution type: {name ?? 'not chosen yet'}. Only an organization-wide settings
        administrator can choose it.
      </p>
    );
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!choice) return setMsg({ ok: false, text: 'Choose School, College or University.' });
    if (reason.trim().length < 5)
      return setMsg({ ok: false, text: 'Give a reason of at least 5 characters.' });
    setPending(true);
    setMsg(null);
    try {
      await runWithStepUp(() =>
        putSetting(client, 'institution.type', choice, reason.trim(), version),
      );
      setMsg({
        ok: true,
        text: 'Institution type saved. Role names update the next time the app loads; no permission changed.',
      });
      setReason('');
      await load();
    } catch (err) {
      setMsg({
        ok: false,
        text:
          isApiError(err) && err.status === 409
            ? 'The institution type cannot be changed once academic years exist.'
            : academicsErrorMessage(err),
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label="Institution type">
      <h4>Institution type</h4>
      <p className="muted">
        Currently: {name ?? 'not chosen yet'}. This sets the role names and wording; it never
        changes what anyone is allowed to do.
      </p>
      <label>
        Type of institution
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose…</option>
          {INSTITUTION_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <Button type="submit" pending={pending}>
        Save institution type
      </Button>
    </form>
  );
}

function TerminologyEditor({
  client,
  canEdit,
  onSaved,
}: {
  client: ApiClient;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const { runWithStepUp } = useStepUp();
  const [detail, setDetail] = useState<TerminologyDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [slots, setSlots] = useState<Draft>({});
  const [types, setTypes] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Draft>({});
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await fetchTerminologyDetail(client);
      setDetail(d);
      const own = Object.fromEntries(
        d.customised.map((k) => [k, d.labels[k as keyof Terminology]]),
      );
      setSlots(Object.fromEntries(TERMINOLOGY_SLOTS.map((k) => [k, own[k] ?? ''])));
      setTypes(Object.fromEntries(d.periodTypes.map((p) => [p.code, p.customised ? p.label : ''])));
      if (canEdit) {
        const row = (await fetchSettings(client)).find((x) => x.key === 'terminology');
        setVersion(row?.version ?? null);
      }
    } catch (err) {
      setLoadError(academicsErrorMessage(err));
    }
  }, [client, canEdit]);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError)
    return (
      <Alert tone="error">
        {loadError}{' '}
        <Button variant="ghost" onClick={() => void load()}>
          Retry
        </Button>
      </Alert>
    );
  if (!detail) return <Spinner label="Loading labels…" />;
  if (!canEdit)
    return (
      <>
        <h4>Labels in use</h4>
        <ul>
          {TERMINOLOGY_SLOTS.map((k) => (
            <li key={k}>
              {SLOT_TEXT[k]}: {detail.labels[k]}
            </li>
          ))}
        </ul>
        <p className="muted">Only an organization-wide settings administrator can change labels.</p>
      </>
    );

  const applyPreset = (name: keyof typeof PRESETS) => {
    const p = PRESETS[name];
    setSlots((s) => ({
      ...s,
      ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? ''])),
    }));
    // colleges show each programme's own period ("Year" or "Semester"): the period type's own label
    setTypes(
      Object.fromEntries(
        detail.periodTypes.map((t) => [t.code, name === 'college' ? t.periodTypeLabel : '']),
      ),
    );
    setMsg(null);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateLabels(slots, types);
    if (reason.trim().length < 5) errs.reason = 'At least 5 characters.';
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const value: Record<string, unknown> = Object.fromEntries(
      Object.entries(slots).filter(([, v]) => v !== ''),
    );
    const pt = Object.fromEntries(Object.entries(types).filter(([, v]) => v !== ''));
    if (Object.keys(pt).length > 0) value.periodTypes = pt;
    // the setting needs at least one key: "all defaults" is stored as the defaults themselves
    const body = Object.keys(value).length > 0 ? value : { ...DEFAULT_TERMINOLOGY };
    setPending(true);
    setMsg(null);
    try {
      await runWithStepUp(() => putSetting(client, 'terminology', body, reason.trim(), version));
      setMsg({ ok: true, text: 'Labels saved. Screens now use them; no record was changed.' });
      setReason('');
      await load();
      onSaved();
    } catch (err) {
      setMsg({
        ok: false,
        text:
          isApiError(err) && err.status === 409
            ? 'The labels changed since this page loaded. They have been reloaded; review and save again.'
            : isApiError(err) && err.status === 400
              ? 'The server refused these labels: each must be 1 to 40 characters, plain text, and different from the others.'
              : academicsErrorMessage(err),
      });
      if (isApiError(err) && err.status === 409) await load();
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label="Terminology">
      <h4>Terminology</h4>
      <p className="muted">
        Leave a field empty to use the default shown. Records, codes and permissions keep their
        canonical names whatever the labels say.
      </p>
      <div
        style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}
        role="group"
        aria-label="Label presets"
      >
        <Button variant="secondary" onClick={() => applyPreset('school')}>
          School preset
        </Button>
        <Button variant="secondary" onClick={() => applyPreset('college')}>
          College preset
        </Button>
        <Button variant="secondary" onClick={() => applyPreset('university')}>
          University preset
        </Button>
      </div>
      {TERMINOLOGY_SLOTS.map((k) => (
        <TextField
          key={k}
          label={SLOT_TEXT[k]}
          value={slots[k] ?? ''}
          placeholder={DEFAULT_TERMINOLOGY[k]}
          maxLength={40}
          onChange={(e) => setSlots((s) => ({ ...s, [k]: e.target.value }))}
          error={errors[k]}
        />
      ))}
      {detail.periodTypes.length > 0 && (
        <>
          <h5>Period label by period type</h5>
          <p className="muted">
            A programme shows its own period label where one is set here (for example Year for
            annual and Semester for semester programmes); otherwise the institution-wide period
            label.
          </p>
          {detail.periodTypes.map((p) => (
            <TextField
              key={p.code}
              label={`${p.periodTypeLabel} (${p.code})`}
              value={types[p.code] ?? ''}
              placeholder={slots.period || DEFAULT_TERMINOLOGY.period}
              maxLength={40}
              onChange={(e) => setTypes((t) => ({ ...t, [p.code]: e.target.value }))}
              error={errors[`pt:${p.code}`]}
            />
          ))}
        </>
      )}
      <TextField
        label="Reason for the change"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        error={errors.reason}
      />
      {msg && <Alert tone={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      <Button type="submit" pending={pending}>
        Save labels
      </Button>
    </form>
  );
}
