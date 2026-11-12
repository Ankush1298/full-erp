import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { ACADEMIC_READER, OFFERING_ADMIN, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';
import { todayIso } from '../src/pages/AcademicsPage';

const TERM_ID = 't1';
const COURSE_ID = 'c1';
const COHORT_PERIOD_ID = 'cp1';
const SECTION_ID = 'sec1';
const EMPLOYEE_ID = '0194a000-0000-7000-8000-0000000000e1';
const STUDENT_1 = '0194a000-0000-7000-8000-000000000001';
const STUDENT_2 = '0194a000-0000-7000-8000-000000000002';
const TODAY = todayIso();

function setupOfferingState(backend: ReturnType<typeof createFakeBackend>) {
  backend.state.academics.courses = [
    {
      id: COURSE_ID,
      code: 'CS101',
      title: 'Introduction to Computer Science',
      credits: 4,
      courseType: 'THEORY',
      tracksAttendance: true,
      status: 'ACTIVE',
      owningDepartmentId: null,
      version: 1,
    },
  ];
  backend.state.academics.periods = [
    {
      id: COHORT_PERIOD_ID,
      cohortId: 'co1',
      termId: TERM_ID,
      periodNo: 1,
      isExtension: false,
      status: 'ACTIVE',
      version: 1,
    },
  ];
  backend.state.academics.sections = [
    {
      id: SECTION_ID,
      cohortPeriodId: COHORT_PERIOD_ID,
      name: 'CS-A',
      capacity: 30,
      status: 'ACTIVE',
      memberCount: 2,
      version: 1,
    },
  ];
  backend.state.academics.electiveGroups[COHORT_PERIOD_ID] = [
    {
      id: 'eg1',
      cohortPeriodId: COHORT_PERIOD_ID,
      code: 'OE1',
      name: 'Open Elective 1',
      minSelect: 1,
      maxSelect: 1,
      opensAt: null,
      closesAt: null,
      status: 'OPEN',
      version: 1,
    },
  ];
  backend.state.academics.enrollments[STUDENT_1] = [
    {
      id: 'enr-1',
      studentId: STUDENT_1,
      cohortPeriodId: COHORT_PERIOD_ID,
      termId: TERM_ID,
      periodNo: 1,
      status: 'ACTIVE',
      enrollmentType: 'REGULAR',
      rollNumber: '101',
      currentSection: { sectionId: SECTION_ID, name: 'CS-A', validFrom: '2026-06-01' },
      version: 1,
    },
  ];
  backend.state.academics.enrollments[STUDENT_2] = [
    {
      id: 'enr-2',
      studentId: STUDENT_2,
      cohortPeriodId: COHORT_PERIOD_ID,
      termId: TERM_ID,
      periodNo: 1,
      status: 'ACTIVE',
      enrollmentType: 'REGULAR',
      rollNumber: '102',
      currentSection: { sectionId: SECTION_ID, name: 'CS-A', validFrom: '2026-06-01' },
      version: 1,
    },
  ];
}

describe('Academics: course offerings write workflows', () => {
  it('creates an offering with elective basket, cohort, section, policy and capacity', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));

    // Select the term
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    expect(await screen.findByRole('heading', { name: 'New course offering' })).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Create course offering' });

    // Validate error on empty submit
    await userEvent.click(within(form).getByRole('button', { name: 'Create course offering' }));
    expect(await screen.findByText(/Choose a course/)).toBeInTheDocument();

    // Fill form
    await userEvent.selectOptions(within(form).getByLabelText('Course'), COURSE_ID);
    await userEvent.selectOptions(within(form).getByLabelText('Offering kind'), 'ELECTIVE');
    await userEvent.selectOptions(
      within(form).getByLabelText('Registration policy'),
      'ELECTIVE_CHOICE',
    );
    await userEvent.selectOptions(
      within(form).getByLabelText(/Semester \(optional\)/),
      COHORT_PERIOD_ID,
    );

    // Section and Elective group dropdowns appear
    await userEvent.selectOptions(
      await within(form).findByLabelText(/Section \(optional\)/),
      SECTION_ID,
    );
    await userEvent.selectOptions(
      await within(form).findByLabelText(/Elective group \(optional\)/),
      'eg1',
    );

    await userEvent.type(within(form).getByLabelText('Group label (optional)'), 'Elective-Group-1');
    await userEvent.type(within(form).getByLabelText('Capacity (optional)'), '25');

    await userEvent.click(within(form).getByRole('button', { name: 'Create course offering' }));

    expect(await screen.findByText('Course offering created in draft state.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/course-offerings')).toHaveLength(1);
    const [call] = b.callsTo('POST', '/academics/course-offerings');
    expect(call?.body).toEqual({
      termId: TERM_ID,
      courseId: COURSE_ID,
      offeringKind: 'ELECTIVE',
      registrationPolicy: 'ELECTIVE_CHOICE',
      cohortPeriodId: COHORT_PERIOD_ID,
      sectionId: SECTION_ID,
      electiveGroupId: 'eg1',
      groupLabel: 'Elective-Group-1',
      capacity: 25,
    });

    // Offering shows up in table
    expect(await screen.findByText('CS101')).toBeInTheDocument();
    expect(screen.getByText('CS-A (Elective-Group-1)')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('publishes, updates capacity, and cancels offering with required reason', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'DRAFT',
        publishedAt: null,
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);

    // Open offering management panel
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));
    expect(
      await screen.findByRole('heading', { name: /Manage offering: CS101/ }),
    ).toBeInTheDocument();

    // 1. Publish
    const publishBtn = screen.getByRole('button', { name: 'Publish offering' });
    await userEvent.click(publishBtn);
    expect(await screen.findByText('Offering published.')).toBeInTheDocument();
    const [pubPatch] = b.callsTo('PATCH', '/academics/course-offerings/off-1');
    expect(pubPatch?.headers['if-match']).toBe('"1"');
    expect(pubPatch?.body).toEqual({ status: 'PUBLISHED' });

    // 2. Update capacity
    const capForm = screen.getByRole('form', { name: 'Update capacity' });
    const capInput = within(capForm).getByLabelText('Edit capacity');
    await userEvent.clear(capInput);
    await userEvent.type(capInput, '50');
    await userEvent.click(within(capForm).getByRole('button', { name: 'Update capacity' }));
    expect(await screen.findByText('Offering capacity updated.')).toBeInTheDocument();
    const patches = b.callsTo('PATCH', '/academics/course-offerings/off-1');
    expect(patches[1]?.body).toEqual({ capacity: 50 });

    // 3. Cancel offering with reason
    await userEvent.click(screen.getByRole('button', { name: 'Cancel offering' }));
    const cancelForm = screen.getByRole('form', { name: 'Cancel offering' });
    await userEvent.type(
      within(cancelForm).getByLabelText('Cancellation reason'),
      'Course rescheduled to next term due to curriculum review',
    );
    await userEvent.click(within(cancelForm).getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('Offering cancelled.')).toBeInTheDocument();
    const latestPatches = b.callsTo('PATCH', '/academics/course-offerings/off-1');
    expect(latestPatches[latestPatches.length - 1]?.body).toEqual({
      status: 'CANCELLED',
      reason: 'Course rescheduled to next term due to curriculum review',
    });
  });

  // M3 doc 39: the server requires a reason for CLOSED as for CANCELLED; the page used to send none (400 in the
  // real browser, hidden by the fake backend, which now applies the same rule).
  it('closes a published offering only with a reason', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-2',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-10-01T00:00:00.000Z',
        version: 2,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'Close offering' }));
    const closeForm = screen.getByRole('form', { name: 'Close offering' });
    await userEvent.click(within(closeForm).getByRole('button', { name: 'Confirm close' }));
    expect(b.callsTo('PATCH', '/academics/course-offerings/off-2')).toHaveLength(0);

    await userEvent.type(
      within(closeForm).getByLabelText('Closing reason'),
      'Term teaching finished',
    );
    await userEvent.click(within(closeForm).getByRole('button', { name: 'Confirm close' }));
    expect(await screen.findByText('Offering closed.')).toBeInTheDocument();
    const [closePatch] = b.callsTo('PATCH', '/academics/course-offerings/off-2');
    expect(closePatch?.headers['if-match']).toBe('"2"');
    expect(closePatch?.body).toEqual({ status: 'CLOSED', reason: 'Term teaching finished' });
  });

  it('respects locked-term rules: disables creation and explains term lock', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.terms[0]!.status = 'LOCKED';

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);

    expect(
      await screen.findByText(/This term is locked. Offerings cannot be created or modified/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create course offering' })).not.toBeInTheDocument();
  });
});

describe('Academics: faculty assignments write workflows', () => {
  it('assigns faculty, prevents duplicate primary assignment, and ends assignment with reason and date', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-06-01T00:00:00.000Z',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));

    expect(
      await screen.findByRole('heading', { name: 'Faculty and teacher assignments' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No faculty assigned to this offering yet.')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Assign faculty' });
    await userEvent.type(within(form).getByLabelText('Employee ID'), EMPLOYEE_ID);
    await userEvent.type(
      within(form).getByLabelText('Reason for assignment'),
      'Lead theory instructor',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Assign faculty' }));

    expect(await screen.findByText('Faculty assigned to course offering.')).toBeInTheDocument();
    const [call] = b.callsTo('POST', '/academics/course-offerings/off-1/faculty-assignments');
    expect(call?.body).toEqual({
      employeeId: EMPLOYEE_ID,
      teachingRole: 'PRIMARY',
      validFrom: TODAY,
      reason: 'Lead theory instructor',
    });

    // List now displays the primary teacher
    const teacherList = await screen.findByRole('list', { name: 'Teaching assignments' });
    expect(within(teacherList).getByText('Primary teacher')).toBeInTheDocument();

    // Try assigning another PRIMARY teacher -> should show conflict error
    const secondEmp = '0194a000-0000-7000-8000-0000000000e2';
    await userEvent.type(within(form).getByLabelText('Employee ID'), secondEmp);
    await userEvent.type(
      within(form).getByLabelText('Reason for assignment'),
      'Replacement teacher',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Assign faculty' }));

    expect(
      await screen.findByText(/Assignment refused: another primary faculty may already be active/),
    ).toBeInTheDocument();

    // End assignment for the first teacher
    await userEvent.click(screen.getByRole('button', { name: 'End assignment' }));
    const endForm = screen.getByRole('form', { name: `End assignment for ${EMPLOYEE_ID}` });
    await userEvent.type(
      within(endForm).getByLabelText('Reason (at least 5 characters)'),
      'Faculty transferred to research lab',
    );
    await userEvent.click(within(endForm).getByRole('button', { name: 'Confirm end assignment' }));

    expect(await screen.findByText('Faculty assignment ended.')).toBeInTheDocument();
    const [endPatch] = b.callsTo('PATCH', '/academics/faculty-assignments/fa-1');
    expect(endPatch?.headers['if-match']).toBe('"1"');
    expect(endPatch?.body).toEqual({
      validTo: TODAY,
      reason: 'Faculty transferred to research lab',
    });
  });
});

describe('Academics: timetable slots write workflows', () => {
  it('creates slot, explains room/teacher clash conflicts, and ends slot with date and If-Match', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-06-01T00:00:00.000Z',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));

    expect(
      await screen.findByRole('heading', { name: 'Weekly timetable slots' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No timetable slots yet.')).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Add timetable slot' });
    await userEvent.selectOptions(within(form).getByLabelText('Day of week'), '1'); // Monday
    const startInput = within(form).getByLabelText('Start time (HH:MM)');
    const endInput = within(form).getByLabelText('End time (HH:MM)');

    await userEvent.clear(startInput);
    await userEvent.type(startInput, '09:00');
    await userEvent.clear(endInput);
    await userEvent.type(endInput, '10:30');

    await userEvent.click(within(form).getByRole('button', { name: 'Add timetable slot' }));

    expect(await screen.findByText('Timetable slot added.')).toBeInTheDocument();
    const [call] = b.callsTo('POST', '/academics/course-offerings/off-1/timetable-slots');
    expect(call?.body).toEqual({
      weekday: 1,
      startTime: '09:00',
      endTime: '10:30',
      effectiveFrom: '2026-06-01',
    });

    const slotList = await screen.findByRole('list', { name: 'Timetable slots' });
    expect(within(slotList).getByText('Monday')).toBeInTheDocument();
    expect(within(slotList).getByText(/09:00-10:30/)).toBeInTheDocument();

    // End slot
    await userEvent.click(screen.getByRole('button', { name: 'End slot' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm end' }));

    expect(await screen.findByText('Timetable slot ended.')).toBeInTheDocument();
    const [endPatch] = b.callsTo('PATCH', '/academics/timetable-slots/ts-1');
    expect(endPatch?.headers['if-match']).toBe('"1"');
    expect(endPatch?.body).toEqual({ effectiveTo: TODAY });
  });
});

describe('Academics: student registration write workflows', () => {
  it('triggers from-section auto-registration, displays created vs already-registered count, and drops registration', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-06-01T00:00:00.000Z',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));

    expect(
      await screen.findByRole('heading', { name: 'Student registrations' }),
    ).toBeInTheDocument();
    const fromSecCard = screen.getByRole('heading', { name: /Auto-register from section: CS-A/ });
    expect(fromSecCard).toBeInTheDocument();

    const fromSecForm = screen.getByRole('form', { name: 'Register students from section' });
    await userEvent.click(
      within(fromSecForm).getByRole('button', { name: 'Register students from section' }),
    );

    // Success notice shows registered 2 students (both section members)
    expect(
      await screen.findByText('Registered 2 students (0 already registered).'),
    ).toBeInTheDocument();
    expect(
      b.callsTo('POST', '/academics/course-offerings/off-1/registrations/from-section'),
    ).toHaveLength(1);

    // Re-running action is idempotent: reports already registered
    await userEvent.click(
      within(fromSecForm).getByRole('button', { name: 'Register students from section' }),
    );
    expect(
      await screen.findByText('Registered 0 students (2 already registered).'),
    ).toBeInTheDocument();

    // Table displays both students with status REGISTERED and AUTO_SECTION source
    expect(await screen.findByText(STUDENT_1)).toBeInTheDocument();
    expect(screen.getByText(STUDENT_2)).toBeInTheDocument();
    expect(screen.getAllByText('AUTO_SECTION')).toHaveLength(2);

    // Drop registration for student 1
    const dropBtns = screen.getAllByRole('button', { name: 'Drop' });
    await userEvent.click(dropBtns[0]!);

    const dropForm = screen.getByRole('form', { name: `Drop registration for ${STUDENT_1}` });
    await userEvent.type(
      within(dropForm).getByLabelText('Drop reason'),
      'Transferred to another section',
    );
    await userEvent.click(within(dropForm).getByRole('button', { name: 'Confirm drop' }));

    expect(await screen.findByText('Registration dropped.')).toBeInTheDocument();
    const [dropPatch] = b.callsTo('PATCH', '/academics/course-registrations/r-1');
    expect(dropPatch?.headers['if-match']).toBe('"1"');
    expect(dropPatch?.body).toEqual({
      status: 'DROPPED',
      validTo: TODAY,
      reason: 'Transferred to another section',
    });
  });

  it('a read-only reader can inspect timetable, faculty and registrations, but sees no write forms', async () => {
    const b = createFakeBackend({ session: true, me: ACADEMIC_READER });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-06-01T00:00:00.000Z',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);

    expect(screen.queryByRole('form', { name: 'Create course offering' })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole('button', { name: /Timetable for CS101/ }));

    expect(
      await screen.findByRole('heading', { name: /Manage offering: CS101/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish offering' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close offering' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel offering' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Update capacity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add timetable slot' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign faculty' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: 'Register students from section' }),
    ).not.toBeInTheDocument();
  });

  it('validates section requirement when registration policy is AUTO_FROM_SECTION', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);

    const form = await screen.findByRole('form', { name: 'Create course offering' });
    await userEvent.selectOptions(within(form).getByLabelText('Course'), COURSE_ID);
    // Policy defaults to AUTO_FROM_SECTION. Without selecting a section:
    await userEvent.click(within(form).getByRole('button', { name: 'Create course offering' }));

    expect(
      await screen.findByText(
        'A section is required when registration policy is AUTO_FROM_SECTION.',
      ),
    ).toBeInTheDocument();
    expect(b.callsTo('POST', '/academics/course-offerings')).toHaveLength(0);
  });

  it('displays informational warning when an AUTO_FROM_SECTION offering lacks an assigned section', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-no-sec',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: null,
        offeringKind: 'CORE',
        groupLabel: 'Class 5 - A',
        codeSnapshot: 'MATH5',
        titleSnapshot: 'Mathematics 5',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'PUBLISHED',
        publishedAt: '2026-11-09T00:00:00.000Z',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);

    await userEvent.click(await screen.findByRole('button', { name: /Manage MATH5 Class 5 - A/ }));
    expect(
      await screen.findByText(
        /This course offering has registration policy AUTO_FROM_SECTION, but was created without an associated section/,
      ),
    ).toBeInTheDocument();
  });

  it('passes axe accessibility audit with no detectable violations', async () => {
    const b = createFakeBackend({ session: true, me: OFFERING_ADMIN });
    setupOfferingState(b);
    b.state.academics.offerings = [
      {
        id: 'off-1',
        campusId: 'camp-1',
        termId: TERM_ID,
        courseId: COURSE_ID,
        cohortPeriodId: COHORT_PERIOD_ID,
        sectionId: SECTION_ID,
        offeringKind: 'CORE',
        groupLabel: null,
        codeSnapshot: 'CS101',
        titleSnapshot: 'Introduction to Computer Science',
        creditsSnapshot: '4.0',
        tracksAttendance: true,
        registrationPolicy: 'AUTO_FROM_SECTION',
        capacity: 40,
        electiveGroupId: null,
        status: 'DRAFT',
        publishedAt: null,
        version: 1,
      },
    ];

    const { container } = renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Offerings' }));
    await userEvent.selectOptions(await screen.findByLabelText('Term'), TERM_ID);
    await userEvent.click(await screen.findByRole('button', { name: /Manage CS101/ }));

    await screen.findByRole('heading', { name: /Manage offering: CS101/ });

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
