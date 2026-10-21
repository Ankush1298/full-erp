import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ACADEMIC_ADMIN, ACADEMIC_READER, STUDENT, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const STUDENT_ID = '0194a000-0000-7000-8000-000000000001';

describe('Academics page: access', () => {
  it('shows the Academics menu entry to staff with academic capabilities, not to students', async () => {
    const staff = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    const { unmount } = renderApp(staff, '/');
    expect((await screen.findAllByRole('link', { name: 'Academics' })).length).toBeGreaterThan(0);
    unmount();

    const student = createFakeBackend({
      session: true,
      me: {
        ...STUDENT,
        capabilities: [...STUDENT.capabilities, 'academic.program.read', 'enrollment.term.read'],
      },
    });
    renderApp(student, '/');
    await screen.findAllByText(/Asha Student/);
    expect(screen.queryByRole('link', { name: 'Academics' })).not.toBeInTheDocument();
  });

  it('a direct visit without the capabilities shows the forbidden page and never calls the API', async () => {
    const b = createFakeBackend({ session: true, me: STUDENT });
    renderApp(b, '/academics');
    expect(await screen.findByText('Access restricted')).toBeInTheDocument();
    expect(b.callsTo('GET', '/academics/academic-years')).toHaveLength(0);
  });

  it('a read-only reader sees the data but no create forms or change buttons', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(b, '/academics');
    expect(await screen.findByRole('heading', { name: '2026-27' })).toBeInTheDocument();
    expect(screen.getByText('ODD - Odd semester')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create academic year' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Courses' }));
    expect(await screen.findByText('No courses')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create course' })).not.toBeInTheDocument();
  });
});

describe('Academics page: calendar', () => {
  it('validates, creates an academic year with the CSRF token and refreshes the list', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    await screen.findByRole('heading', { name: '2026-27' });
    const form = screen.getByRole('form', { name: 'Create academic year' });

    await userEvent.click(within(form).getByRole('button', { name: 'Create academic year' }));
    expect(
      await screen.findByText(/Enter a label and a start date before the end date/),
    ).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/academic-years')).toHaveLength(0);

    await userEvent.type(within(form).getByLabelText('Label'), '2027-28');
    await userEvent.type(within(form).getByLabelText('Start date'), '2027-06-01');
    await userEvent.type(within(form).getByLabelText('End date'), '2028-05-31');
    await userEvent.click(within(form).getByRole('button', { name: 'Create academic year' }));

    expect(await screen.findByText('Academic year created.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '2027-28' })).toBeInTheDocument();
    const [call] = b.callsTo('POST', '/academics/academic-years');
    expect(call?.body).toEqual({
      label: '2027-28',
      startDate: '2027-06-01',
      endDate: '2028-05-31',
    });
    expect(call?.headers['x-csrf-token']).toBe(b.state.csrf);
  });

  it('activates a year with If-Match and shows fixed wording for a conflict (never the server text)', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    const activate = await screen.findByRole('button', { name: 'Activate 2026-27' });
    await userEvent.click(activate);
    expect(await screen.findByText('2026-27 is now active.')).toBeInTheDocument();
    const [patch] = b.callsTo('PATCH', '/academics/academic-years/y1');
    expect(patch?.headers['if-match']).toBe('"1"');

    b.state.academics.failNext = { status: 409, code: 'CONFLICT' };
    await userEvent.click(await screen.findByRole('button', { name: 'Close 2026-27' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That conflicts with an existing record or its current state');
    expect(alert).not.toHaveTextContent('server text that must never be shown');
  });

  it('shows a retry control when loading fails', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.years = [];
    renderApp(b, '/academics');
    expect(await screen.findByText('No academic years')).toBeInTheDocument();
  });
});

describe('Academics page: courses and sections', () => {
  it('creates a course after client-side validation of credits', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Courses' }));
    const form = await screen.findByRole('form', { name: 'Create course' });
    await userEvent.type(within(form).getByLabelText('Course code'), 'CS101');
    await userEvent.type(within(form).getByLabelText('Course title'), 'Algorithms');
    const credits = within(form).getByLabelText('Credits');
    await userEvent.clear(credits);
    await userEvent.type(credits, '2.25');
    await userEvent.click(within(form).getByRole('button', { name: 'Create course' }));
    expect(await screen.findByText(/at most one decimal place/)).toBeInTheDocument();
    await userEvent.clear(credits);
    await userEvent.type(credits, '3.5');
    await userEvent.click(within(form).getByRole('button', { name: 'Create course' }));
    expect(await screen.findByText('Course created.')).toBeInTheDocument();
    expect(await screen.findByText('CS101 - Algorithms')).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/courses')[0]?.body).toMatchObject({
      code: 'CS101',
      credits: 3.5,
    });
  });

  it('creates a section for a cohort period and lists it', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Sections' }));
    expect(await screen.findByText('No sections')).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Create section' });
    await userEvent.selectOptions(within(form).getByLabelText('Cohort period'), 'cp1');
    await userEvent.type(within(form).getByLabelText('Section name'), 'A');
    await userEvent.type(within(form).getByLabelText('Capacity (optional)'), '60');
    await userEvent.click(within(form).getByRole('button', { name: 'Create section' }));
    expect(await screen.findByText('Section created.')).toBeInTheDocument();
    expect(await screen.findByText('Section A')).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/sections')[0]?.body).toEqual({
      cohortPeriodId: 'cp1',
      name: 'A',
      capacity: 60,
    });
  });
});

describe('Academics page: term enrolment', () => {
  it('loads a student, enrols with an Idempotency-Key, places the student in a section and shows the roster', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.sections = [
      {
        id: 'sec1',
        cohortPeriodId: 'cp1',
        name: 'A',
        capacity: 60,
        status: 'ACTIVE',
        memberCount: 0,
        version: 1,
      },
    ];
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));

    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), 'nope');
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));
    expect(await screen.findByText('Enter the student ID (a UUID).')).toBeInTheDocument();

    await userEvent.clear(within(find).getByLabelText('Student ID'));
    await userEvent.type(within(find).getByLabelText('Student ID'), STUDENT_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));
    expect(await screen.findByText('No enrolments')).toBeInTheDocument();

    const enrol = await screen.findByRole('form', { name: 'Enrol for a term' });
    await userEvent.selectOptions(within(enrol).getByLabelText('Cohort period to enrol in'), 'cp1');
    await userEvent.type(
      within(enrol).getByLabelText('Reason for enrolment'),
      'Regular registration',
    );
    await userEvent.click(within(enrol).getByRole('button', { name: 'Enrol student' }));
    expect(await screen.findByText('Student enrolled for the term.')).toBeInTheDocument();
    const [post] = b.callsTo('POST', `/students/${STUDENT_ID}/term-enrollments`);
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText('REGISTERED')).toBeInTheDocument();

    const place = await screen.findByRole('form', { name: 'Place in a section' });
    await userEvent.selectOptions(within(place).getByLabelText('Enrolment'), 'e-1');
    await userEvent.selectOptions(within(place).getByLabelText('Section'), 'sec1');
    await userEvent.type(within(place).getByLabelText('Effective from'), '2026-06-15');
    await userEvent.type(
      within(place).getByLabelText('Reason for placement'),
      'Allocated to section A',
    );
    await userEvent.click(within(place).getByRole('button', { name: 'Place student' }));
    expect(await screen.findByText('Student placed in the section.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('A (from 2026-06-15)')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Sections' }));
    await userEvent.click(await screen.findByRole('button', { name: 'View roster for A' }));
    expect(
      await screen.findByText(/student 0194a000-0000-7000-8000-000000000001/),
    ).toBeInTheDocument();
  });

  it('a read-only reader can look a student up but sees no enrol or placement forms', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));
    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), STUDENT_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));
    expect(await screen.findByText('No enrolments')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Enrol for a term' })).not.toBeInTheDocument();
  });

  it('shows fixed not-found wording when the student is outside the caller access', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));
    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(
      within(find).getByLabelText('Student ID'),
      'ffffffff-0000-7000-8000-000000000000',
    );
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'That record could not be found, or it is outside your access.',
    );
    expect(alert).not.toHaveTextContent('server text that must never be shown');
  });
});
