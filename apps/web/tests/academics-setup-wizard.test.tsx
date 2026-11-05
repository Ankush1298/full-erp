import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { validateLabels } from '../src/pages/AcademicSetupWizard';
import {
  ACADEMIC_ADMIN,
  ACADEMIC_READER,
  createFakeBackend,
  type FakeBackend,
} from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

// Task 8 (doc 35): the guided academic setup wizard and the terminology editor, against the fake backend. The wizard
// document is the server's (GET /academics/setup-wizard); these tests check what the page does with it.
const WIZ_ADMIN = {
  ...ACADEMIC_ADMIN,
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    ...ACADEMIC_ADMIN.capabilities,
    'org.settings.read',
    'org.settings.manage',
    'org.campus.manage',
    'org.department.manage',
    'academic.program.manage',
    'academic.cohort.manage',
  ],
};
const issue = (code: string, severity: 'ERROR' | 'WARNING', count = 1) => ({
  code,
  severity,
  count,
});
const step = (
  key: string,
  required: boolean,
  status: 'COMPLETE' | 'ATTENTION' | 'INCOMPLETE',
  issues: ReturnType<typeof issue>[] = [],
  counts: Record<string, number> = {},
) => ({ key, required, status, counts, issues });
const term = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: id.toUpperCase(),
  name: `Session ${id}`,
  status: 'PLANNED',
  version: 1,
  startDate: '2027-04-01',
  endDate: '2028-03-31',
  campusId: 'camp-1',
  campusName: 'Main Campus',
  academicYearId: 'ay1',
  academicYearLabel: '2027-28',
  academicYearStatus: 'ACTIVE',
  activatable: false,
  blocking: [],
  warnings: [],
  ...over,
});
function school(b: FakeBackend) {
  b.state.academics.wizard = {
    organizationName: 'Greenfield School',
    terminologyCustomised: false,
    requiredSteps: 9,
    requiredComplete: 2,
    steps: [
      step('institution', true, 'COMPLETE'),
      step('campuses', true, 'COMPLETE', [], { campuses: 3, departments: 3 }),
      step('calendar', true, 'INCOMPLETE', [issue('NO_OPEN_TERM', 'ERROR')], {
        academicYears: 1,
        terms: 0,
      }),
      step('programmes', true, 'INCOMPLETE', [issue('NO_PERIOD_TYPE', 'ERROR')]),
      step('sections', true, 'INCOMPLETE', [issue('NO_OPEN_SECTION', 'ERROR')]),
      step('curriculum', true, 'INCOMPLETE', [issue('NO_ACTIVE_COURSE', 'ERROR')]),
      step('staff', true, 'INCOMPLETE', [issue('NO_ACTIVE_EMPLOYEE', 'ERROR')]),
      step('assignments', true, 'INCOMPLETE', [issue('NO_PUBLISHED_OFFERING', 'ERROR')]),
      step('classTeachers', false, 'ATTENTION', [
        issue('SECTION_WITHOUT_CLASS_TEACHER', 'WARNING', 144),
      ]),
      step('timetable', false, 'ATTENTION', [issue('NO_ROOM', 'WARNING')]),
      step('holidays', false, 'COMPLETE'),
      step('enrolment', false, 'ATTENTION', [issue('NO_ACTIVE_STUDENT', 'WARNING')]),
      step('review', true, 'INCOMPLETE', [issue('NO_ACTIVE_TERM', 'ERROR')]),
    ],
    campuses: ['Main', 'North', 'South'].map((n, i) => ({
      id: `camp-${i + 1}`,
      code: n.toUpperCase(),
      name: `${n} Campus`,
      status: 'ACTIVE',
      departments: 1,
      openTerms: 1,
      openSections: 48,
      postedEmployees: 10,
      rooms: 0,
      campusHolidays: 0,
    })),
    terms: [
      term('t1', { blocking: [issue('OFFERING_WITHOUT_TEACHER', 'ERROR', 2)] }),
      term('t2', {
        campusId: 'camp-2',
        campusName: 'North Campus',
        activatable: true,
        warnings: [issue('TERM_WITHOUT_HOLIDAY', 'WARNING')],
      }),
    ],
  };
}
async function openWizard() {
  await userEvent.click(await screen.findByRole('button', { name: 'Setup wizard' }));
  return screen.findByRole('heading', { name: 'Academic setup wizard' });
}
const stepButton = (name: RegExp) =>
  within(screen.getByRole('navigation', { name: 'Setup steps' })).getByRole('button', { name });

describe('setup wizard: progress, resume and navigation', () => {
  it('resumes on the first incomplete required step, with progress and fixed-wording issues', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    expect(screen.getByText('2 of 9 required steps complete')).toBeInTheDocument();
    const progress = screen.getByLabelText('2 of 9 required steps complete');
    expect(progress).toHaveAttribute('value', '2');
    expect(
      screen.getByRole('heading', { name: 'Step 3 of 13: Academic years and terms' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No planned or active term.')).toBeInTheDocument();
    expect(stepButton(/3\. Academic years/)).toHaveAttribute('aria-current', 'step');
    // optional steps are marked and never described as required
    const nav = screen.getByRole('navigation', { name: 'Setup steps' });
    expect(within(nav).getAllByText('Optional')).toHaveLength(4);
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();
  });

  it('every step can be revisited; links open the existing screens', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/2\. Campuses and departments/));
    const table = screen.getByRole('table', { name: 'Campus readiness' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    await userEvent.click(stepButton(/9\. Class teachers/));
    expect(
      screen.getByText('Optional recommendation: it never blocks activation.'),
    ).toBeInTheDocument();
    expect(screen.getByText('144 sections without a class teacher.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));
    expect(
      screen.getByRole('heading', { name: /Step 8 of 13: Postings and teacher assignments/ }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Offerings' }));
    expect(await screen.findByRole('heading', { name: 'Course offerings' })).toBeInTheDocument();
  });

  it('a retried create is reported as a duplicate; a new one reloads the progress', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/2\. Campuses and departments/));
    const form = screen.getByRole('form', { name: 'Add a campus' });
    await userEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(within(form).getAllByText('Required.')).toHaveLength(2);
    expect(b.callsTo('POST', '/organization/campuses')).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('Campus name'), 'Main Campus');
    await userEvent.type(within(form).getByLabelText('Campus code'), 'MAIN');
    await userEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(
      await within(form).findByText(
        'A campus with this code already exists: it is already in the table above.',
      ),
    ).toBeInTheDocument();
    const before = b.callsTo('GET', '/academics/setup-wizard').length;
    await userEvent.clear(within(form).getByLabelText('Campus name'));
    await userEvent.type(within(form).getByLabelText('Campus name'), 'East Campus');
    await userEvent.clear(within(form).getByLabelText('Campus code'));
    await userEvent.type(within(form).getByLabelText('Campus code'), 'EAST');
    await userEvent.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText('Created.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/organization/campuses').at(-1)?.body).toEqual({
      name: 'East Campus',
      code: 'EAST',
      timezone: 'Asia/Kolkata',
    });
    await waitFor(() =>
      expect(b.callsTo('GET', '/academics/setup-wizard').length).toBeGreaterThan(before),
    );
  });
});

describe('setup wizard: review and activation', () => {
  it('a blocked term cannot be activated; a ready one only after explicit confirmation', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/13\. Review and activation/));
    expect(screen.getByRole('button', { name: 'Activate term T1' })).toBeDisabled();
    expect(
      screen.getByText('2 published offerings without a teacher to the end of the term.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Activate term T2' }));
    expect(b.callsTo('POST', '/academics/terms/t2/activation')).toHaveLength(0);
    const confirm = screen.getByRole('form', { name: 'Confirm activation of T2' });
    expect(within(confirm).getByText(/1 recommendation is still open/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Confirm activation' }));
    expect(await screen.findByText('Term T2 is now active.')).toBeInTheDocument();
    const call = b.callsTo('POST', '/academics/terms/t2/activation')[0]!;
    expect(call.headers['if-match']).toBe('"1"');
    expect(call.body).toEqual({});
  });

  it('a server refusal (SETUP_INCOMPLETE) is explained and the list refreshed', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/13\. Review and activation/));
    await userEvent.click(screen.getByRole('button', { name: 'Activate term T2' }));
    // the records changed after the page loaded: the server now refuses
    const t2 = (b.state.academics.wizard!.terms as Array<Record<string, unknown>>)[1]!;
    t2.activatable = false;
    t2.blocking = [issue('NO_PUBLISHED_OFFERING', 'ERROR')];
    const before = b.callsTo('GET', '/academics/setup-wizard').length;
    await userEvent.click(screen.getByRole('button', { name: 'Confirm activation' }));
    expect(
      await screen.findByText(/The server found items still blocking this term/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(b.callsTo('GET', '/academics/setup-wizard').length).toBeGreaterThan(before),
    );
    expect(await screen.findByText('No published offering.')).toBeInTheDocument();
  });

  it('a PLANNED academic year is activated by its own explicit button first', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    (b.state.academics.wizard!.terms as Array<Record<string, unknown>>)[0]!.academicYearStatus =
      'PLANNED';
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/13\. Review and activation/));
    expect(
      screen.getByRole('button', { name: 'Activate academic year 2027-28' }),
    ).toBeInTheDocument();
  });
});

describe('activation from the Calendar tab (PATCH) gets the same readiness answer', () => {
  it('a 409 SETUP_INCOMPLETE is explained in fixed wording and points to the wizard', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    b.state.academics.failNext = { status: 409, code: 'SETUP_INCOMPLETE' };
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Activate term ODD' }));
    expect(
      await screen.findByText(
        'This term is not ready to be activated yet. The Setup wizard lists what is still missing.',
      ),
    ).toBeInTheDocument();
    expect(b.callsTo('PATCH', '/academics/terms/t1')[0]?.body).toEqual({ status: 'ACTIVE' });
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();
  });
});

describe('terminology editor', () => {
  it('school preset, validation, save with If-Match and a reason; labels apply to the page', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/1\. Institution and terminology/));
    const form = await screen.findByRole('form', { name: 'Terminology' });
    await userEvent.click(within(form).getByRole('button', { name: 'School preset' }));
    expect(within(form).getByLabelText('Programme (the model: programme)')).toHaveValue('Class');
    expect(
      within(form).getByLabelText('Period, institution-wide (the model: cohort period)'),
    ).toHaveValue('Grade');
    const section = within(form).getByLabelText('Section (the model: section)');
    await userEvent.clear(section);
    await userEvent.type(section, 'class');
    await userEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    expect(
      within(form).getAllByText('Same as the program label; labels must differ.').length,
    ).toBeGreaterThan(0);
    expect(within(form).getByText('At least 5 characters.')).toBeInTheDocument();
    expect(b.callsTo('PUT', '/organization/settings/terminology')).toHaveLength(0);

    await userEvent.clear(section);
    await userEvent.type(section, 'Section');
    await userEvent.type(within(form).getByLabelText('Reason for the change'), 'School vocabulary');
    await userEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    expect(await within(form).findByText(/Labels saved/)).toBeInTheDocument();
    const put = b.callsTo('PUT', '/organization/settings/terminology')[0]!;
    expect(put.headers['if-match']).toBe('"0"');
    expect(put.body).toEqual({
      value: {
        program: 'Class',
        period: 'Grade',
        section: 'Section',
        term: 'Term',
        course: 'Subject',
      },
      reason: 'School vocabulary',
    });
    // the page reloads the labels: the courses tab is now "Subjects"
    expect(await screen.findByRole('button', { name: 'Subjects' })).toBeInTheDocument();
  });

  it('per period type labels are saved under periodTypes (college preset)', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    b.state.academics.periodTypes = [
      { id: 'pt-y', code: 'YEAR', periodTypeLabel: 'Year' },
      { id: 'pt-s', code: 'SEMESTER', periodTypeLabel: 'Semester' },
    ];
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/1\. Institution and terminology/));
    const form = await screen.findByRole('form', { name: 'Terminology' });
    await userEvent.click(within(form).getByRole('button', { name: 'College preset' }));
    expect(within(form).getByLabelText('Year (YEAR)')).toHaveValue('Year');
    await userEvent.type(within(form).getByLabelText('Reason for the change'), 'Mixed college');
    await userEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    await within(form).findByText(/Labels saved/);
    expect(
      (b.callsTo('PUT', '/organization/settings/terminology')[0]!.body as { value: unknown }).value,
    ).toEqual({
      program: 'Programme',
      section: 'Section',
      course: 'Course',
      periodTypes: { YEAR: 'Year', SEMESTER: 'Semester' },
    });
  });

  it('a server 400 or 409 is shown in fixed wording; 409 reloads the stored version', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/1\. Institution and terminology/));
    const form = await screen.findByRole('form', { name: 'Terminology' });
    await userEvent.type(within(form).getByLabelText('Course (the model: course)'), 'Paper');
    await userEvent.type(within(form).getByLabelText('Reason for the change'), 'College words');
    b.state.academics.failNext = { status: 400, code: 'VALIDATION_ERROR' };
    await userEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    expect(await within(form).findByText(/The server refused these labels/)).toBeInTheDocument();
    b.state.academics.terminologyVersion = 4; // someone else saved meanwhile
    await userEvent.click(within(form).getByRole('button', { name: 'Save labels' }));
    expect(
      await within(form).findByText(/The labels changed since this page loaded/),
    ).toBeInTheDocument();
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();
  });

  it('without org.settings.manage the labels are shown read-only', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    school(b);
    renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/1\. Institution and terminology/));
    expect(await screen.findByRole('heading', { name: 'Labels in use' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save labels' })).not.toBeInTheDocument();
    expect(b.callsTo('GET', '/organization/settings')).toHaveLength(0);
  });

  it('the client rules match the server: blanks mean default, padding/brackets/duplicates refused', () => {
    expect(validateLabels({ program: '', section: '' }, {})).toEqual({});
    expect(validateLabels({ section: ' Class' }, {}).section).toMatch(/leading or trailing/);
    expect(validateLabels({ section: '<b>' }, {}).section).toMatch(/angle brackets/);
    expect(validateLabels({ section: 'Batch' }, {}).section).toMatch(/cohort label/); // the default cohort label
    expect(validateLabels({}, { YEAR: 'term' })['pt:YEAR']).toMatch(/term label/);
    expect(validateLabels({}, { YEAR: 'Year', SEMESTER: 'Semester' })).toEqual({});
  });
});

describe('programme-aware labels and access', () => {
  it('a cohort whose programme has its own period label shows it; others keep the institution label', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.byCohort = { co1: 'Year' };
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Sections' }));
    const form = await screen.findByRole('form', { name: 'Create section' });
    expect(within(form).getByRole('option', { name: /^Year 1/ })).toBeInTheDocument();
    expect(within(form).queryByRole('option', { name: /^Semester 1/ })).not.toBeInTheDocument();
  });

  it('a campus-scoped administrator is told why the wizard is unavailable', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    b.state.academics.campusScopedOnly = true;
    renderApp(b, '/academics');
    await openWizard();
    expect(
      await screen.findByText(/needs organization-wide access to academic terms/),
    ).toBeInTheDocument();
  });

  it('there is no wizard tab without academic.term.manage, and nothing is requested', async () => {
    const r = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(r, '/academics');
    await screen.findByRole('button', { name: 'Calendar' });
    expect(screen.queryByRole('button', { name: 'Setup wizard' })).not.toBeInTheDocument();
    expect(r.callsTo('GET', '/academics/setup-wizard')).toHaveLength(0);
  });

  it('passes an axe audit on the review step', async () => {
    const b = createFakeBackend({ session: true, me: WIZ_ADMIN });
    school(b);
    const { container } = renderApp(b, '/academics');
    await openWizard();
    await userEvent.click(stepButton(/13\. Review and activation/));
    expect((await axe(container)).violations).toEqual([]);
  });
});
