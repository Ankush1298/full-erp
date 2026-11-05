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

describe('Academics page: offerings and timetable (read-only, doc 31)', () => {
  const seed = (b: ReturnType<typeof createFakeBackend>) => {
    b.state.academics.sections.push({
      id: 's-a',
      cohortPeriodId: 'cp1',
      name: '6-A',
      capacity: null,
      status: 'ACTIVE',
      memberCount: 0,
      version: 1,
    });
    b.state.academics.offerings.push(
      {
        id: 'o1',
        termId: 't1',
        courseId: 'c1',
        cohortPeriodId: 'cp1',
        sectionId: 's-a',
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'MATH6',
        titleSnapshot: 'Mathematics (Grade 6)',
        creditsSnapshot: '0.0',
        status: 'PUBLISHED',
        version: 2,
      },
      {
        id: 'o-other-term',
        termId: 't9',
        courseId: 'c2',
        cohortPeriodId: null,
        sectionId: null,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Programming I',
        creditsSnapshot: '4.0',
        status: 'DRAFT',
        version: 1,
      },
    );
    b.state.academics.slots['o1'] = [
      {
        id: 'sl1',
        roomId: 'room-1',
        facultyAssignmentId: null,
        weekday: 1,
        startTime: '08:00',
        endTime: '08:45',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
      },
    ];
    b.state.academics.assignments['o1'] = [
      {
        id: 'fa1',
        employeeId: '0194a000-0000-7000-8000-00000000beef',
        teachingRole: 'PRIMARY',
        validFrom: '2026-06-01',
        validTo: null,
      },
    ];
  };
  const openTerm = async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), 't1');
  };

  it("lists the term's offerings and shows the weekly timetable, teachers and room codes", async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    seed(b);
    renderApp(b, '/academics');
    await openTerm();
    const grid = await screen.findByRole('table', {
      name: 'Course offerings in the selected term',
    });
    expect(within(grid).getByText('MATH6')).toBeInTheDocument();
    expect(within(grid).getByText('6-A')).toBeInTheDocument();
    expect(within(grid).getByText('PUBLISHED')).toBeInTheDocument();
    expect(within(grid).queryByText('CS101')).not.toBeInTheDocument();
    expect(b.callsTo('GET', '/academics/course-offerings?termId=t1')).toHaveLength(1);

    await userEvent.click(within(grid).getByRole('button', { name: 'Timetable for MATH6' }));
    const slots = await screen.findByRole('list', { name: 'Timetable slots' });
    expect(slots).toHaveTextContent('Monday 08:00-08:45, room LH-101');
    expect(screen.getByRole('list', { name: 'Teaching assignments' })).toHaveTextContent(
      'Primary teacher · employee 0000beef · from 2026-06-01',
    );
    // read-only: no change controls
    expect(screen.queryByRole('button', { name: /Publish|Cancel|Assign/ })).not.toBeInTheDocument();
  });

  it('without org.structure.read the rooms list is never requested', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    seed(b);
    renderApp(b, '/academics');
    await openTerm();
    await userEvent.click(await screen.findByRole('button', { name: 'Timetable for MATH6' }));
    expect(await screen.findByRole('list', { name: 'Timetable slots' })).toHaveTextContent(
      'Monday 08:00-08:45, room booked',
    );
    expect(b.state.calls.some((c) => c.path.includes('/rooms'))).toBe(false);
  });

  it('shows the empty state and a retryable fixed-wording error', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(b, '/academics');
    await openTerm();
    expect(await screen.findByText('No offerings')).toBeInTheDocument();

    b.state.academics.offeringsMode = 'server';
    await userEvent.selectOptions(screen.getByLabelText('Term'), '');
    await userEvent.selectOptions(screen.getByLabelText('Term'), 't1');
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('INTERNAL_ERROR');
    b.state.academics.offeringsMode = 'ok';
    seed(b);
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('MATH6')).toBeInTheDocument();
  });
});

describe('Academics page: class teachers and progression (doc 32)', () => {
  const ASSIGNER = {
    ...ACADEMIC_ADMIN,
    capabilities: [...ACADEMIC_ADMIN.capabilities, 'academic.faculty.assign'],
  };
  const EMP = '0194a000-0000-7000-8000-0000000000e1';
  const section = {
    id: 'sec1',
    cohortPeriodId: 'cp1',
    name: '6-A',
    capacity: 40,
    status: 'ACTIVE',
    memberCount: 0,
    version: 1,
  };

  it('assigns a class teacher, refuses a second one with fixed wording, and ends the assignment with If-Match', async () => {
    const b = createFakeBackend({ session: true, me: ASSIGNER });
    b.state.academics.sections = [section];
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Sections' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Class teachers of 6-A' }));
    expect(await screen.findByText('No class teacher')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Assign a class teacher' });
    await userEvent.click(within(form).getByRole('button', { name: 'Assign class teacher' }));
    expect(await within(form).findByText(/Enter the employee ID/)).toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText('Employee ID'), EMP);
    await userEvent.type(within(form).getByLabelText('From (YYYY-MM-DD)'), '2026-06-01');
    await userEvent.type(
      within(form).getByLabelText('Reason for the assignment'),
      'Session 2026-27',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Assign class teacher' }));
    expect(await screen.findByText('Class teacher assigned.')).toBeInTheDocument();
    expect(
      await screen.findByText(/Class teacher - employee …0000e1 from 2026-06-01 \(current\)/),
    ).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/sections/sec1/class-teachers')[0]?.body).toEqual({
      employeeId: EMP,
      classTeacherRole: 'PRIMARY',
      validFrom: '2026-06-01',
      reason: 'Session 2026-27',
    });

    // a second PRIMARY: the server refuses (409); the page shows its own wording
    await userEvent.click(within(form).getByRole('button', { name: 'Assign class teacher' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That conflicts with an existing record or its current state. Reload and try again.',
    );

    const end = screen.getByRole('form', { name: 'End a class teacher assignment' });
    await userEvent.selectOptions(within(end).getByLabelText('Current class teacher'), 'ct-1');
    await userEvent.type(within(end).getByLabelText('Last day (YYYY-MM-DD)'), '2026-09-30');
    await userEvent.type(within(end).getByLabelText('Reason for ending'), 'Handing over the class');
    await userEvent.click(within(end).getByRole('button', { name: 'End assignment' }));
    expect(await screen.findByText('Class teacher assignment ended.')).toBeInTheDocument();
    expect(await screen.findByText(/from 2026-06-01 to 2026-09-30/)).toBeInTheDocument();
    expect(b.callsTo('PATCH', '/academics/class-teachers/ct-1')[0]?.headers['if-match']).toBe(
      '"1"',
    );
  });

  it('a reader sees the class teachers but no assignment forms', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    b.state.academics.sections = [section];
    b.state.academics.classTeachers = {
      sec1: [
        {
          id: 'ct-1',
          sectionId: 'sec1',
          employeeId: EMP,
          classTeacherRole: 'PRIMARY',
          validFrom: '2026-06-01',
          validTo: null,
          version: 1,
        },
      ],
    };
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Sections' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Class teachers of 6-A' }));
    expect(
      await screen.findByText(/employee …0000e1 from 2026-06-01 \(current\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign a class teacher' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: 'End a class teacher assignment' }),
    ).not.toBeInTheDocument();
  });

  it('promotes an ACTIVE enrolment with an Idempotency-Key; the history keeps the closed enrolment', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.enrollments[STUDENT_ID] = [
      {
        id: 'e-1',
        studentId: STUDENT_ID,
        cohortPeriodId: 'cp1',
        termId: 't1',
        periodNo: 1,
        status: 'ACTIVE',
        enrollmentType: 'REGULAR',
        rollNumber: null,
        currentSection: null,
        version: 2,
      },
    ];
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));
    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), STUDENT_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));

    const move = await screen.findByRole('form', { name: 'Promote or repeat' });
    await userEvent.click(within(move).getByRole('button', { name: 'Record decision' }));
    expect(await within(move).findByText(/Choose an enrolment, a decision/)).toBeInTheDocument();
    await userEvent.selectOptions(within(move).getByLabelText('Current enrolment'), 'e-1');
    await userEvent.selectOptions(within(move).getByLabelText('Cohort period to move to'), 'cp1');
    await userEvent.type(within(move).getByLabelText('Reason for the decision'), 'Passed the year');
    await userEvent.click(within(move).getByRole('button', { name: 'Record decision' }));
    expect(await screen.findByText('Promotion recorded.')).toBeInTheDocument();
    const [post] = b.callsTo('POST', `/students/${STUDENT_ID}/term-enrollments/e-1/progression`);
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body).toEqual({
      decision: 'PROMOTE',
      cohortPeriodId: 'cp1',
      reason: 'Passed the year',
    });
    expect(await screen.findByText('PROMOTED')).toBeInTheDocument();
    expect(screen.getByText('REGISTERED')).toBeInTheDocument();
  });

  it('a read-only reader gets no promote or repeat form', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    b.state.academics.enrollments[STUDENT_ID] = [
      {
        id: 'e-1',
        studentId: STUDENT_ID,
        cohortPeriodId: 'cp1',
        termId: 't1',
        periodNo: 1,
        status: 'ACTIVE',
        enrollmentType: 'REGULAR',
        rollNumber: null,
        currentSection: null,
        version: 2,
      },
    ];
    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));
    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), STUDENT_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));
    expect(await screen.findByText('ACTIVE')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Promote or repeat' })).not.toBeInTheDocument();
  });
});
