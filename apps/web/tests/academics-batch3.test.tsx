import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ACADEMIC_ADMIN, ACADEMIC_READER, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

// Milestone 3 Batch 3 web UI (doc 33): electives and registrations, holidays, terminology, setup checklist.
const STUDENT_A = '0194a000-0000-7000-8000-00000000000a';
const STUDENT_B = '0194a000-0000-7000-8000-00000000000b';
const MANAGER = {
  ...ACADEMIC_ADMIN,
  capabilities: [...ACADEMIC_ADMIN.capabilities, 'academic.offering.manage'],
};
const enrolment = (id: string, studentId: string) => ({
  id,
  studentId,
  cohortPeriodId: 'cp1',
  termId: 't1',
  periodNo: 1,
  status: 'ACTIVE',
  enrollmentType: 'REGULAR',
  rollNumber: null,
  currentSection: null,
  version: 1,
});
const offering = (id: string, code: string, capacity: number | null) => ({
  id,
  termId: 't1',
  courseId: `c-${id}`,
  cohortPeriodId: 'cp1',
  sectionId: null,
  offeringKind: 'ELECTIVE',
  groupLabel: null,
  codeSnapshot: code,
  titleSnapshot: `${code} title`,
  creditsSnapshot: '3.0',
  status: 'PUBLISHED',
  version: 1,
  capacity,
  electiveGroupId: 'g1',
});
const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  cohortPeriodId: 'cp1',
  code: 'OE1',
  name: 'Open electives',
  minSelect: 1,
  maxSelect: 1,
  opensAt: null,
  closesAt: null,
  status: 'OPEN',
  version: 1,
  ...over,
});

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole('button', { name }));
}
async function openGroup() {
  await openTab('Electives');
  await userEvent.selectOptions(await screen.findByLabelText('Cohort period'), 'cp1');
  await userEvent.click(await screen.findByRole('button', { name: 'Open group OE1' }));
}
async function loadStudent(id: string) {
  const find = screen.getByRole('form', { name: "Find a student's choices" });
  const input = within(find).getByLabelText('Student ID');
  await userEvent.clear(input);
  await userEvent.type(input, id);
  await userEvent.click(within(find).getByRole('button', { name: 'Load choices' }));
}

describe('Batch 3: terminology', () => {
  const sec = {
    id: 'sec1',
    cohortPeriodId: 'cp1',
    name: '6-A',
    capacity: null,
    status: 'ACTIVE',
    memberCount: 0,
    version: 1,
  };

  it('a school configuration relabels tabs, headings and periods; record writes are unchanged', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.terminology = {
      program: 'Curriculum',
      cohort: 'Intake',
      period: 'Grade',
      section: 'Class',
      term: 'Session',
      course: 'Subject',
    };
    b.state.academics.sections = [sec];
    renderApp(b, '/academics');
    expect(await screen.findByRole('heading', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subjects' })).toBeInTheDocument();
    await openTab('Classes');
    expect(await screen.findByRole('heading', { name: 'Class 6-A' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Create section' });
    expect(within(form).getByRole('option', { name: /^Grade 1/ })).toBeInTheDocument();
    await userEvent.selectOptions(within(form).getByLabelText('Cohort period'), 'cp1');
    await userEvent.type(within(form).getByLabelText('Section name'), '6-B');
    await userEvent.click(within(form).getByRole('button', { name: 'Create section' }));
    expect(await screen.findByText('Section created.')).toBeInTheDocument();
    // labels are display only: the request carries the same fields under any configuration
    expect(b.callsTo('POST', '/academics/sections')[0]?.body).toEqual({
      cohortPeriodId: 'cp1',
      name: '6-B',
    });
  });

  it('a university keeps the defaults when nothing is configured', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.sections = [sec];
    renderApp(b, '/academics');
    await openTab('Sections');
    expect(await screen.findByRole('heading', { name: 'Section 6-A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Semester 1/ })).toBeInTheDocument();
  });

  it('falls back to the defaults when the labels cannot be read, and never asks without the permission', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.terminologyMode = 'server';
    renderApp(b, '/academics');
    expect(await screen.findByRole('heading', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const noRead = createFakeBackend({
      session: true,
      me: {
        ...ACADEMIC_ADMIN,
        capabilities: ACADEMIC_ADMIN.capabilities.filter((c) => c !== 'academic.program.read'),
      },
    });
    renderApp(noRead, '/academics');
    await screen.findAllByRole('heading', { name: 'Terms' });
    expect(noRead.callsTo('GET', '/academics/terminology')).toHaveLength(0);
  });
});

describe('Batch 3: elective groups and registrations', () => {
  it('creates a group (validated, starts planned) and opens it with If-Match and a reason', async () => {
    const b = createFakeBackend({ session: true, me: MANAGER });
    renderApp(b, '/academics');
    await openTab('Electives');
    await userEvent.selectOptions(await screen.findByLabelText('Cohort period'), 'cp1');
    expect(await screen.findByText('No elective groups')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Create elective group' });
    await userEvent.type(within(form).getByLabelText('Group code'), 'OE1');
    await userEvent.type(within(form).getByLabelText('Group name'), 'Open electives');
    await userEvent.clear(within(form).getByLabelText('Minimum choices'));
    await userEvent.type(within(form).getByLabelText('Minimum choices'), '3');
    await userEvent.click(within(form).getByRole('button', { name: 'Create elective group' }));
    expect(await within(form).findByText(/0 ≤ minimum ≤ maximum ≤ 50/)).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/cohort-periods/cp1/elective-groups')).toHaveLength(0);

    await userEvent.clear(within(form).getByLabelText('Minimum choices'));
    await userEvent.type(within(form).getByLabelText('Minimum choices'), '1');
    await userEvent.type(
      within(form).getByLabelText('Window closes (optional, YYYY-MM-DD HH:MM)'),
      '2099-01-01 09:00',
    );
    await userEvent.type(
      within(form).getByLabelText('Reason for the group'),
      'Odd semester basket',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Create elective group' }));
    expect(await screen.findByText(/Elective group created/)).toBeInTheDocument();
    const body = b.callsTo('POST', '/academics/cohort-periods/cp1/elective-groups')[0]?.body as {
      closesAt: string;
    };
    expect(body).toMatchObject({ code: 'OE1', minSelect: 1, maxSelect: 1 });
    expect(new Date(body.closesAt).toISOString()).toBe(body.closesAt);

    await userEvent.click(await screen.findByRole('button', { name: 'Open group OE1' }));
    const change = screen.getByRole('form', { name: 'Change elective group' });
    await userEvent.type(within(change).getByLabelText('Reason for the change'), 'Choices begin');
    await userEvent.click(within(change).getByRole('button', { name: 'Open for choices' }));
    expect(await screen.findByText('The group is open for choices.')).toBeInTheDocument();
    const [patch] = b.callsTo('PATCH', '/academics/elective-groups/g-1');
    expect(patch?.headers['if-match']).toBe('"1"');
    expect(patch?.body).toEqual({ status: 'OPEN', reason: 'Choices begin' });
  });

  it('records a choice, refuses a second beyond the maximum and a full offering, and drops with a date', async () => {
    const b = createFakeBackend({ session: true, me: MANAGER });
    b.state.academics.electiveGroups = { cp1: [group()] };
    b.state.academics.offerings = [offering('o1', 'AI101', 1), offering('o2', 'BIO101', null)];
    b.state.academics.enrollments = {
      [STUDENT_A]: [enrolment('e1', STUDENT_A)],
      [STUDENT_B]: [enrolment('e2', STUDENT_B)],
    };
    renderApp(b, '/academics');
    await openGroup();
    expect(await screen.findByText('0 of 1 taken')).toBeInTheDocument();

    await loadStudent(STUDENT_A);
    expect(
      await screen.findByText('Holds 0 of at most 1 (below the minimum of 1).'),
    ).toBeInTheDocument();
    const choose = screen.getByRole('form', { name: 'Record a choice' });
    await userEvent.selectOptions(within(choose).getByLabelText('Offering'), 'o1');
    await userEvent.type(within(choose).getByLabelText('Reason for the choice'), 'Student form');
    await userEvent.click(within(choose).getByRole('button', { name: 'Record choice' }));
    expect(await screen.findByText('Choice registered.')).toBeInTheDocument();
    expect(
      b.callsTo('POST', '/academics/course-offerings/o1/registrations')[0]?.body,
    ).toMatchObject({
      termEnrollmentId: 'e1',
      source: 'ELECTIVE_CHOICE',
      reason: 'Student form',
    });
    expect(await screen.findByText('Holds 1 of at most 1 (minimum of 1 met).')).toBeInTheDocument();
    expect(await screen.findByText('1 of 1 taken')).toBeInTheDocument();
    expect(screen.getByText('Full')).toBeInTheDocument();

    // a second choice: the server refuses; the page names the cause it can see
    await userEvent.selectOptions(within(choose).getByLabelText('Offering'), 'o2');
    await userEvent.click(within(choose).getByRole('button', { name: 'Record choice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The choice was refused: the student already holds the maximum of 1.',
    );

    // another student and the full offering
    await loadStudent(STUDENT_B);
    await screen.findByText('Holds 0 of at most 1 (below the minimum of 1).');
    const chooseB = screen.getByRole('form', { name: 'Record a choice' });
    await userEvent.selectOptions(within(chooseB).getByLabelText('Offering'), 'o1');
    await userEvent.type(within(chooseB).getByLabelText('Reason for the choice'), 'Student form');
    await userEvent.click(within(chooseB).getByRole('button', { name: 'Record choice' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The choice was refused: the offering is full.',
    );

    // drop the first student's choice: history kept, If-Match sent, a last day required
    await loadStudent(STUDENT_A);
    const end = await screen.findByRole('form', { name: 'Change a choice' });
    await userEvent.selectOptions(within(end).getByLabelText('Current choice'), 'r-1');
    await userEvent.selectOptions(within(end).getByLabelText('Action'), 'DROPPED');
    await userEvent.type(within(end).getByLabelText('Reason for the change'), 'Changed mind');
    await userEvent.click(within(end).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Choice dropped.')).toBeInTheDocument();
    const [patch] = b.callsTo('PATCH', '/academics/course-registrations/r-1');
    expect(patch?.headers['if-match']).toBe('"1"');
    expect(patch?.body).toMatchObject({ status: 'DROPPED', reason: 'Changed mind' });
    expect(await screen.findByText(/AI101 - Dropped from/)).toBeInTheDocument();
  });

  it('closing below the minimum is refused with its own wording; a choice outside the window is flagged', async () => {
    const b = createFakeBackend({ session: true, me: MANAGER });
    b.state.academics.electiveGroups = {
      cp1: [group({ closesAt: '2020-01-01T00:00:00.000Z' })],
    };
    b.state.academics.offerings = [offering('o1', 'AI101', null)];
    b.state.academics.enrollments = { [STUDENT_A]: [enrolment('e1', STUDENT_A)] };
    renderApp(b, '/academics');
    await openGroup();
    expect((await screen.findAllByText(/outside the window/)).length).toBe(2);

    const change = screen.getByRole('form', { name: 'Change elective group' });
    await userEvent.type(within(change).getByLabelText('Reason for the change'), 'End of window');
    await userEvent.click(within(change).getByRole('button', { name: 'Close the group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Closing was refused: every enrolment still live in this semester must hold at least 1 choice',
    );

    await loadStudent(STUDENT_A);
    const choose = await screen.findByRole('form', { name: 'Record a choice' });
    expect(within(choose).getByText(/outside its window right now/)).toBeInTheDocument();
    await userEvent.selectOptions(within(choose).getByLabelText('Offering'), 'o1');
    await userEvent.type(within(choose).getByLabelText('Reason for the choice'), 'Late form');
    await userEvent.click(within(choose).getByRole('button', { name: 'Record choice' }));
    expect(
      await screen.findByText(
        'The choice was refused: the group is not open for choices at this moment.',
      ),
    ).toBeInTheDocument();
  });

  it('a reader sees groups, basket and roster but no write forms', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    b.state.academics.electiveGroups = { cp1: [group()] };
    b.state.academics.offerings = [offering('o1', 'AI101', 30)];
    renderApp(b, '/academics');
    await openGroup();
    expect(await screen.findByText('0 of 30 taken')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create elective group' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Change elective group' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: "Find a student's choices" }),
    ).not.toBeInTheDocument();
  });
});

describe('Batch 3: holiday calendar', () => {
  const holiday = (i: number, over: Record<string, unknown> = {}) => ({
    id: `h${i}`,
    campusId: null,
    holidayDate: `2026-08-${String(i).padStart(2, '0')}`,
    name: `Day ${i}`,
    kind: 'HOLIDAY',
    status: 'ACTIVE',
    version: 1,
    ...over,
  });

  it('lists organization and campus days in pages, declares, cancels and re-declares with reasons', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.holidays = Array.from({ length: 22 }, (_, i) =>
      holiday(i + 1, i === 0 ? { campusId: 'camp-1', name: 'Campus day' } : {}),
    );
    renderApp(b, '/academics');
    await openTab('Holidays');
    const table = await screen.findByRole('table', { name: 'Holidays' });
    expect(within(table).getByText('Campus day')).toBeInTheDocument();
    expect(within(table).getAllByText('Whole organization').length).toBeGreaterThan(0);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Day 22')).toBeInTheDocument();
    expect(b.callsTo('GET', '/academics/holidays?includeCancelled=true')).toHaveLength(1);

    const form = screen.getByRole('form', { name: 'Declare a holiday' });
    await userEvent.click(within(form).getByRole('button', { name: 'Declare holiday' }));
    expect(await within(form).findByText(/Enter a date/)).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Date (YYYY-MM-DD)'), '2026-10-02');
    await userEvent.type(within(form).getByLabelText('Holiday name'), 'Gandhi Jayanti');
    await userEvent.type(within(form).getByLabelText('Reason for declaring'), 'National holiday');
    await userEvent.click(within(form).getByRole('button', { name: 'Declare holiday' }));
    expect(await screen.findByText('Holiday declared.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/holidays')[0]?.body).toEqual({
      holidayDate: '2026-10-02',
      name: 'Gandhi Jayanti',
      kind: 'HOLIDAY',
      reason: 'National holiday',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change Gandhi Jayanti on 2026-10-02' }),
    );
    const edit = screen.getByRole('form', { name: 'Change a holiday' });
    await userEvent.click(within(edit).getByRole('button', { name: 'Cancel this holiday' }));
    expect(await within(edit).findByText(/reason of at least 5 characters/)).toBeInTheDocument();
    await userEvent.type(within(edit).getByLabelText('Reason for the change'), 'Moved to Monday');
    await userEvent.click(within(edit).getByRole('button', { name: 'Cancel this holiday' }));
    expect(await screen.findByText('Gandhi Jayanti on 2026-10-02 cancelled.')).toBeInTheDocument();
    const [patch] = b.callsTo('PATCH', '/academics/holidays/HOLIDAY-23');
    expect(patch?.headers['if-match']).toBe('"1"');
    expect(patch?.body).toEqual({ status: 'CANCELLED', reason: 'Moved to Monday' });

    // the cancelled row stays listed; re-declaring pre-fills a new declaration
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Re-declare Gandhi Jayanti on 2026-10-02' }),
    );
    expect(within(form).getByLabelText('Holiday name')).toHaveValue('Gandhi Jayanti');
    await userEvent.type(within(form).getByLabelText('Reason for declaring'), 'Declared again');
    await userEvent.click(within(form).getByRole('button', { name: 'Declare holiday' }));
    expect(await screen.findByText('Holiday declared.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/holidays')).toHaveLength(2);
  });

  it('shows a locked term on the row and before declaring, and the refusal names it', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.terms = [{ ...b.state.academics.terms[0]!, status: 'LOCKED' }];
    b.state.academics.holidays = [holiday(15, { name: 'Independence Day' })];
    renderApp(b, '/academics');
    await openTab('Holidays');
    const table = await screen.findByRole('table', { name: 'Holidays' });
    expect(await within(table).findByText('Locked term')).toBeInTheDocument();
    expect(within(table).getByText('In locked term ODD: cannot change')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Change/ })).not.toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Declare a holiday' });
    await userEvent.type(within(form).getByLabelText('Date (YYYY-MM-DD)'), '2026-09-05');
    expect(within(form).getByText(/lies in the locked term ODD/)).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Holiday name'), 'Teachers Day');
    await userEvent.type(within(form).getByLabelText('Reason for declaring'), 'Annual holiday');
    await userEvent.click(within(form).getByRole('button', { name: 'Declare holiday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Refused: 2026-09-05 lies in the locked term ODD.',
    );
  });

  it('a campus-scoped administrator is told organization-wide days need organization access', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.campusScopedOnly = true;
    renderApp(b, '/academics');
    await openTab('Holidays');
    const form = await screen.findByRole('form', { name: 'Declare a holiday' });
    await userEvent.type(within(form).getByLabelText('Date (YYYY-MM-DD)'), '2027-01-26');
    await userEvent.type(within(form).getByLabelText('Holiday name'), 'Republic Day');
    await userEvent.type(within(form).getByLabelText('Reason for declaring'), 'National holiday');
    await userEvent.click(within(form).getByRole('button', { name: 'Declare holiday' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Organization-wide holidays can be declared or changed only by an administrator with organization-wide access.',
    );
  });

  it('a reader sees the calendar but no declare form or change buttons', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    b.state.academics.holidays = [holiday(15)];
    renderApp(b, '/academics');
    await openTab('Holidays');
    expect(await screen.findByText('Day 15')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Declare a holiday' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change Day 15/ })).not.toBeInTheDocument();
  });
});

describe('Batch 3: setup checklist', () => {
  const items = [
    { key: 'campuses', done: true, count: 2, detail: 'server text that must never be shown' },
    { key: 'terms', done: false, count: 0, detail: 'x' },
    { key: 'offeringsWithoutTeacher', done: true, count: 0, detail: 'x' },
    { key: 'openTermsWithoutHolidays', done: false, count: 3, detail: 'x' },
  ];

  it('shows database counts, separates verified items from those needing an administrator, offers nothing to tick', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.checklist = { complete: false, items };
    renderApp(b, '/academics');
    await openTab('Setup checklist');
    const table = await screen.findByRole('table', { name: 'Setup checklist' });
    const row = (name: string) => within(table).getByRole('row', { name: new RegExp(name) });
    expect(row('Active campuses')).toHaveTextContent('2Verified present');
    expect(row('Open terms 0')).toHaveTextContent('Needs an administrator');
    expect(row('Published offerings without a teacher')).toHaveTextContent('Verified none remain');
    expect(row('Open terms without any holiday')).toHaveTextContent(
      '3Needs an administrator Declare the holidays',
    );
    expect(screen.getByText('2 of 4 items still need an administrator.')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByText('server text that must never be shown')).not.toBeInTheDocument();

    b.state.academics.checklist = {
      complete: true,
      items: items.map((i) => ({ ...i, done: true, count: i.key === 'terms' ? 1 : 0 })),
    };
    await userEvent.click(screen.getByRole('button', { name: 'Count again' }));
    expect(await screen.findByText('Every item is verified by the records.')).toBeInTheDocument();
    expect(b.callsTo('GET', '/academics/setup-checklist')).toHaveLength(2);
  });

  it('explains a campus-scoped refusal and is not offered without academic.term.manage', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.campusScopedOnly = true;
    const { unmount } = renderApp(b, '/academics');
    await openTab('Setup checklist');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'needs organization-wide access to academic terms',
    );
    unmount();

    const r = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(r, '/academics');
    await screen.findByRole('button', { name: 'Holidays' });
    expect(screen.queryByRole('button', { name: 'Setup checklist' })).not.toBeInTheDocument();
    await waitFor(() => expect(r.callsTo('GET', '/academics/setup-checklist')).toHaveLength(0));
  });
});
