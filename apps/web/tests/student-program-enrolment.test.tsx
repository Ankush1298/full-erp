import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ACADEMIC_ADMIN, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const PUPIL_ID = '01a1bccb-066e-7594-9aee-3f5c80e85a38';

describe('Academics page: programme assignment and term enrolment (Defect #5)', () => {
  it('shows programme admission required for a newly admitted pupil, allows programme assignment, and completes term enrolment and section placement', async () => {
    const b = createFakeBackend({
      session: true,
      me: {
        ...ACADEMIC_ADMIN,
        capabilities: [
          ...ACADEMIC_ADMIN.capabilities,
          'student.profile.read',
          'student.program.assign',
          'enrollment.term.manage',
          'enrollment.term.read',
        ],
      },
    });

    // Add pupil to student records so fakeBackend doesn't 404
    b.state.students.records.push({
      id: PUPIL_ID,
      admissionNumber: 'ADS2026-001',
      displayName: 'Rohan Kumar',
      status: 'ADMITTED',
      tenant: 't1',
      visible: true,
    });

    // Mock an admitted pupil with NO active programme enrolment
    b.state.students.timelines[PUPIL_ID] = {
      studentId: PUPIL_ID,
      asOfDate: '2026-11-02',
      today: '2026-11-02',
      timezone: 'Asia/Kolkata',
      position: {
        admitted: true,
        studentStatus: 'ADMITTED',
        programme: null,
        terms: [],
      },
      events: [],
      undatedOutcomes: [],
      futureEventsExcluded: 0,
      limitations: [],
    };

    b.state.academics.periods = [
      {
        id: 'cp-sem1',
        cohortId: '01900000-0000-7000-8000-0000000000f2',
        termId: 't1',
        periodNo: 1,
        isExtension: false,
        status: 'ACTIVE',
        version: 1,
      },
    ];

    b.state.academics.sections = [
      {
        id: 'sec-5a',
        cohortPeriodId: 'cp-sem1',
        name: 'Class 5 - A',
        capacity: 40,
        status: 'ACTIVE',
        memberCount: 0,
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));

    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), PUPIL_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));

    // Verify "Programme admission required" card is displayed
    expect(await screen.findByText('Programme admission required')).toBeInTheDocument();
    expect(
      screen.getByText(/An active programme enrolment is required before term enrolment can be completed/),
    ).toBeInTheDocument();

    // Verify Assign to programme form is rendered
    const progForm = screen.getByRole('form', { name: 'Assign to programme' });
    expect(progForm).toBeInTheDocument();

    // Fill in programme assignment form
    await userEvent.selectOptions(
      within(progForm).getByLabelText('Programme'),
      '01900000-0000-7000-8000-0000000000a1',
    );
    await userEvent.selectOptions(
      within(progForm).getByLabelText('Batch'),
      '01900000-0000-7000-8000-0000000000f2',
    );
    await userEvent.clear(within(progForm).getByLabelText('Programme start date'));
    await userEvent.type(within(progForm).getByLabelText('Programme start date'), '2026-04-01');
    await userEvent.clear(within(progForm).getByLabelText('Reason for assignment'));
    await userEvent.type(
      within(progForm).getByLabelText('Reason for assignment'),
      'Primary Class 5 regular admission placement',
    );

    // Submit programme assignment
    await userEvent.click(within(progForm).getByRole('button', { name: /Assign/i }));

    // Verify backend call was made with Idempotency-Key
    await waitFor(() => {
      const [progCall] = b.callsTo('POST', `/students/${PUPIL_ID}/programs`);
      expect(progCall).toBeDefined();
      expect(progCall?.headers['idempotency-key']).toBeDefined();
    });

    // Verify active programme card is now displayed
    expect(await screen.findByText(/Active programme enrolment/i)).toBeInTheDocument();
    expect(screen.getByText('Primary Class 5')).toBeInTheDocument();
    expect(screen.getByText('Class 5 2026')).toBeInTheDocument();

    // Now enrol for the term
    const enrolForm = await screen.findByRole('form', { name: 'Enrol for a term' });
    await userEvent.selectOptions(
      within(enrolForm).getByLabelText('Cohort period to enrol in'),
      'cp-sem1',
    );
    await userEvent.type(
      within(enrolForm).getByLabelText('Reason for enrolment'),
      'Term 1 regular enrolment',
    );
    await userEvent.click(within(enrolForm).getByRole('button', { name: 'Enrol student' }));

    expect(await screen.findByText('Student enrolled for the term.')).toBeInTheDocument();
    const [enrolCall] = b.callsTo('POST', `/students/${PUPIL_ID}/term-enrollments`);
    expect(enrolCall?.headers['idempotency-key']).toBeDefined();

    // Now place in section Class 5 - A
    const placeForm = await screen.findByRole('form', { name: 'Place in a section' });
    await userEvent.selectOptions(within(placeForm).getByLabelText('Enrolment'), 'e-1');
    await userEvent.selectOptions(within(placeForm).getByLabelText('Section'), 'sec-5a');
    await userEvent.type(within(placeForm).getByLabelText('Effective from'), '2026-04-01');
    await userEvent.type(
      within(placeForm).getByLabelText('Reason for placement'),
      'Section Class 5 - A placement',
    );
    await userEvent.click(within(placeForm).getByRole('button', { name: 'Place student' }));

    expect(await screen.findByText('Student placed in the section.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Class 5 - A (from 2026-04-01)')).toBeInTheDocument());
  });

  it('displays actionable error message if term enrolment is attempted without active programme enrolment', async () => {
    const b = createFakeBackend({
      session: true,
      me: {
        ...ACADEMIC_ADMIN,
        capabilities: [
          ...ACADEMIC_ADMIN.capabilities,
          'student.profile.read',
          'enrollment.term.manage',
          'enrollment.term.read',
        ],
      },
    });

    b.state.students.records.push({
      id: PUPIL_ID,
      admissionNumber: 'ADS2026-001',
      displayName: 'Rohan Kumar',
      status: 'ADMITTED',
      tenant: 't1',
      visible: true,
    });

    b.state.students.timelines[PUPIL_ID] = {
      studentId: PUPIL_ID,
      asOfDate: '2026-11-02',
      today: '2026-11-02',
      timezone: 'Asia/Kolkata',
      position: {
        admitted: true,
        studentStatus: 'ADMITTED',
        programme: null,
        terms: [],
      },
      events: [],
      undatedOutcomes: [],
      futureEventsExcluded: 0,
      limitations: [],
    };

    b.state.academics.periods = [
      {
        id: 'cp-sem1',
        cohortId: '01900000-0000-7000-8000-0000000000f2',
        termId: 't1',
        periodNo: 1,
        isExtension: false,
        status: 'ACTIVE',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: 'Enrolment' }));

    const find = screen.getByRole('form', { name: 'Find student enrolments' });
    await userEvent.type(within(find).getByLabelText('Student ID'), PUPIL_ID);
    await userEvent.click(within(find).getByRole('button', { name: 'Load enrolments' }));

    expect(await screen.findByText('Programme admission required')).toBeInTheDocument();

    const enrolForm = screen.getByRole('form', { name: 'Enrol for a term' });
    await userEvent.selectOptions(
      within(enrolForm).getByLabelText('Cohort period to enrol in'),
      'cp-sem1',
    );
    await userEvent.type(
      within(enrolForm).getByLabelText('Reason for enrolment'),
      'Attempt without programme',
    );
    await userEvent.click(within(enrolForm).getByRole('button', { name: 'Enrol student' }));

    expect(
      await screen.findByText(/The student has no active programme enrolment. Assign them to a programme first./),
    ).toBeInTheDocument();
  });
});
