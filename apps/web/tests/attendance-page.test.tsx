import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { FACULTY_TEACHER, HOD_APPROVER, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const TODAY = new Date().toISOString().slice(0, 10);
const OFFERING_1 = '01900000-0000-7000-8000-0000000000f1';
const SESSION_1 = '01900000-0000-7000-8000-0000000000s1';
const SESSION_SUBMITTED = '01900000-0000-7000-8000-0000000000s2';
const STUDENT_1 = '01900000-0000-7000-8000-000000000001';
const STUDENT_2 = '01900000-0000-7000-8000-000000000002';

function setupAttendanceState(backend: ReturnType<typeof createFakeBackend>) {
  backend.state.attendance.campuses = [
    {
      id: 'camp-1',
      name: 'Main Campus',
      timezone: 'Asia/Kolkata',
      today: TODAY,
    },
  ];

  backend.state.attendance.myOfferings = [
    {
      id: OFFERING_1,
      codeSnapshot: 'CS101',
      titleSnapshot: 'Introduction to Computer Science',
      groupLabel: 'Section A',
      status: 'PUBLISHED',
      termId: 't1',
      termName: 'Odd semester',
      teachingRole: 'PRIMARY',
      validFrom: '2026-06-01',
      validTo: null,
    },
  ];

  backend.state.attendance.sessions = [
    {
      id: SESSION_1,
      courseOfferingId: OFFERING_1,
      campusId: 'camp-1',
      timetableSlotId: null,
      conductedByEmployeeId: 'emp-1',
      sessionDate: TODAY,
      startsAt: `${TODAY}T09:00:00Z`,
      endsAt: `${TODAY}T10:00:00Z`,
      kind: 'REGULAR',
      topic: 'Introduction to Functions',
      status: 'SCHEDULED',
      attendanceState: 'NOT_STARTED',
      attendanceSubmittedAt: null,
      version: 1,
      courseCode: 'CS101',
      courseTitle: 'Introduction to Computer Science',
    },
    {
      id: SESSION_SUBMITTED,
      courseOfferingId: OFFERING_1,
      campusId: 'camp-1',
      timetableSlotId: null,
      conductedByEmployeeId: 'emp-1',
      sessionDate: TODAY,
      startsAt: `${TODAY}T11:00:00Z`,
      endsAt: `${TODAY}T12:00:00Z`,
      kind: 'REGULAR',
      topic: 'Data Types',
      status: 'CONDUCTED',
      attendanceState: 'SUBMITTED',
      attendanceSubmittedAt: `${TODAY}T12:05:00Z`,
      version: 2,
      courseCode: 'CS101',
      courseTitle: 'Introduction to Computer Science',
      counts: { present: 1, absent: 1, late: 0, excused: 0, total: 2 },
    },
  ];

  backend.state.attendance.rosters[SESSION_1] = [
    {
      studentId: STUDENT_1,
      admissionNumber: 'ADM-001',
      displayName: 'Asha Rao',
      rollNumber: '101',
    },
    {
      studentId: STUDENT_2,
      admissionNumber: 'ADM-002',
      displayName: 'Bala Iyer',
      rollNumber: '102',
    },
  ];

  backend.state.attendance.rosters[SESSION_SUBMITTED] = [
    {
      studentId: STUDENT_1,
      admissionNumber: 'ADM-001',
      displayName: 'Asha Rao',
      rollNumber: '101',
    },
    {
      studentId: STUDENT_2,
      admissionNumber: 'ADM-002',
      displayName: 'Bala Iyer',
      rollNumber: '102',
    },
  ];

  backend.state.attendance.records[SESSION_SUBMITTED] = [
    {
      id: 'rec-sub-1',
      classSessionId: SESSION_SUBMITTED,
      studentId: STUDENT_1,
      status: 'PRESENT',
      source: 'MANUAL',
      markedByUserId: 'u-teacher',
      markedAt: `${TODAY}T12:05:00Z`,
      revisionNo: 1,
      remarks: null,
    },
    {
      id: 'rec-sub-2',
      classSessionId: SESSION_SUBMITTED,
      studentId: STUDENT_2,
      status: 'ABSENT',
      source: 'MANUAL',
      markedByUserId: 'u-teacher',
      markedAt: `${TODAY}T12:05:00Z`,
      revisionNo: 1,
      remarks: 'Unexcused absence',
    },
  ];
}

describe('Attendance UI & Teacher Workflow', () => {
  it('loads assigned offerings and displays scheduled sessions for the teacher', async () => {
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    expect(await screen.findByRole('heading', { name: 'Attendance' })).toBeInTheDocument();
    expect(await screen.findByText(/CS101 — Introduction to Computer Science/)).toBeInTheDocument();

    expect(await screen.findByText('Introduction to Functions')).toBeInTheDocument();
    expect(screen.getByText('Data Types')).toBeInTheDocument();
  });

  it('allows a teacher to open a session, view roster, toggle attendance, and submit', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    // Click "Mark" on the first session
    const markButtons = await screen.findAllByRole('button', { name: 'Mark' });
    await user.click(markButtons[0]!);

    // Should open marking sheet with students
    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Bala Iyer')).toBeInTheDocument();
    expect(screen.getByText('Total: 2')).toBeInTheDocument();

    // Change Bala Iyer to ABSENT
    const balaRadios = within(screen.getByRole('radiogroup', { name: 'Attendance for Bala Iyer' }));
    await user.click(balaRadios.getByRole('radio', { name: 'ABSENT' }));

    // Click Submit Attendance
    const submitBtn = screen.getByRole('button', { name: /Submit Attendance/ });
    await user.click(submitBtn);

    // Verify confirmation and submission call
    expect(await screen.findByText('Attendance submitted successfully.')).toBeInTheDocument();
    expect(backend.callsTo('POST', `/attendance/sessions/${SESSION_1}/attendance`).length).toBe(1);

    const call = backend.callsTo('POST', `/attendance/sessions/${SESSION_1}/attendance`)[0]!;
    expect(call.headers['idempotency-key']).toBeTruthy();
    expect(call.body).toMatchObject({
      records: [
        { studentId: STUDENT_1, status: 'PRESENT' },
        { studentId: STUDENT_2, status: 'ABSENT' },
      ],
    });
  });

  it('supports quick action "Mark All Present" across student roster', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    const markButtons = await screen.findAllByRole('button', { name: 'Mark' });
    await user.click(markButtons[0]!);

    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();

    const markAllPresentBtn = screen.getByRole('button', { name: 'Mark All Present' });
    await user.click(markAllPresentBtn);

    expect(screen.getByText('Present: 2')).toBeInTheDocument();
  });

  it('displays submitted register and opens revision history modal', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    backend.state.attendance.revisions['rec-sub-1'] = [
      {
        revisionNo: 1,
        statusBefore: null,
        statusAfter: 'PRESENT',
        source: 'MANUAL',
        changedByUserId: 'u-teacher',
        changedAt: `${TODAY}T12:05:00Z`,
        reasonCode: 'OTHER',
        reasonText: 'Initial marking',
      },
    ];

    renderApp(backend, '/attendance');

    const viewRegisterBtn = await screen.findByRole('button', { name: 'View Register' });
    await user.click(viewRegisterBtn);

    expect(
      await screen.findByRole('heading', { name: 'Submitted Attendance Register' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Bala Iyer')).toBeInTheDocument();

    // Click history on Asha Rao
    const historyBtns = screen.getAllByRole('button', { name: 'History' });
    await user.click(historyBtns[0]!);

    expect(
      await screen.findByRole('heading', { name: /Attendance Revision History — Asha Rao/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Initial marking')).toBeInTheDocument();

    // Close modal
    await user.click(screen.getByRole('button', { name: 'Close' }));
  });

  it('handles direct correction within 3-day window', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    const viewRegisterBtn = await screen.findByRole('button', { name: 'View Register' });
    await user.click(viewRegisterBtn);

    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();

    const correctBtns = screen.getAllByRole('button', { name: 'Correct' });
    await user.click(correctBtns[0]!); // Asha Rao

    expect(
      await screen.findByRole('heading', { name: 'Correct Attendance Record' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Within 3-Day Window/)).toBeInTheDocument();

    // Apply correction
    await user.click(screen.getByRole('button', { name: 'Apply Correction' }));

    expect(await screen.findByText(/corrected directly/)).toBeInTheDocument();
    expect(backend.callsTo('POST', '/attendance/records/rec-sub-1/corrections').length).toBe(1);
  });

  it('handles correction request outside 3-day window for approval', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    // Set session date to 10 days ago (outside 3-day window)
    const oldDate = '2026-10-10';
    backend.state.attendance.sessions[1]!.sessionDate = oldDate;

    renderApp(backend, '/attendance');

    const viewRegisterBtn = await screen.findByRole('button', { name: 'View Register' });
    await user.click(viewRegisterBtn);

    expect(await screen.findByText('Asha Rao')).toBeInTheDocument();

    const correctBtns = screen.getAllByRole('button', { name: 'Correct' });
    await user.click(correctBtns[0]!);

    expect(
      await screen.findByRole('heading', { name: 'Request Attendance Correction' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Outside 3-Day Window/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit Request' }));

    expect(await screen.findByText(/submitted for independent approval/)).toBeInTheDocument();
    expect(
      backend.callsTo('POST', '/attendance/records/rec-sub-1/correction-requests').length,
    ).toBe(1);
  });

  it('displays unavailable alert if corrections feature flag is disabled', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);
    backend.state.attendance.correctionsEnabled = false;

    renderApp(backend, '/attendance');

    const viewRegisterBtn = await screen.findByRole('button', { name: 'View Register' });
    await user.click(viewRegisterBtn);

    const correctBtns = await screen.findAllByRole('button', { name: 'Correct' });
    await user.click(correctBtns[0]!);

    await user.click(screen.getByRole('button', { name: 'Apply Correction' }));

    expect(
      await screen.findByText(
        'Attendance corrections are switched off for this institution. Nothing was changed.',
      ),
    ).toBeInTheDocument();
  });

  it('allows HOD / administrator to review pending requests and prevents self-approval', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: HOD_APPROVER, session: true });
    setupAttendanceState(backend);

    backend.state.attendance.correctionRequests = [
      {
        id: 'cr-1',
        attendanceRecordId: 'rec-sub-2',
        classSessionId: SESSION_SUBMITTED,
        studentId: STUDENT_2,
        statusBefore: 'ABSENT',
        requestedStatus: 'PRESENT',
        expectedRevisionNo: 1,
        reasonCode: 'MEDICAL',
        reasonText: 'Medical certificate produced',
        status: 'PENDING',
        requestedByUserId: 'u-other-teacher',
        requestedAt: `${TODAY}T13:00:00Z`,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        appliedRevisionNo: null,
      },
      {
        id: 'cr-2',
        attendanceRecordId: 'rec-sub-1',
        classSessionId: SESSION_SUBMITTED,
        studentId: STUDENT_1,
        statusBefore: 'ABSENT',
        requestedStatus: 'PRESENT',
        expectedRevisionNo: 1,
        reasonCode: 'FACULTY_ERROR',
        reasonText: 'Roll call mistake',
        status: 'PENDING',
        requestedByUserId: HOD_APPROVER.user_id, // Self-request!
        requestedAt: `${TODAY}T13:10:00Z`,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        appliedRevisionNo: null,
      },
    ];

    renderApp(backend, '/attendance');

    // Click "Approvals Inbox" tab
    const approvalsTab = await screen.findByRole('tab', { name: /Approvals Inbox/ });
    await user.click(approvalsTab);

    expect(
      await screen.findByRole('heading', { name: 'Attendance Correction Approvals Inbox' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Medical certificate produced')).toBeInTheDocument();
    expect(screen.getByText('Roll call mistake')).toBeInTheDocument();

    // Approve the other teacher's request
    const approveBtns = screen.getAllByRole('button', { name: 'Approve' });
    expect(approveBtns[0]).not.toBeDisabled();
    await user.click(approveBtns[0]!);

    expect(await screen.findByText('Correction request approved.')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/attendance/correction-requests/cr-1/approve').length).toBe(1);

    // The second request is a self-request: approve button must be disabled
    expect(approveBtns[1]).toBeDisabled();
    expect(screen.getByText('(Self-request)')).toBeInTheDocument();
  });

  it('supports daily school registers and date filtering for administrative inspection', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: HOD_APPROVER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    const registersTab = await screen.findByRole('tab', { name: /School Registers/ });
    await user.click(registersTab);

    expect(
      await screen.findByRole('heading', { name: 'Daily School Attendance Register' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Introduction to Functions')).toBeInTheDocument();
    expect(screen.getByText('Data Types')).toBeInTheDocument();

    // Verify student counts are shown
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('allows cancelling a scheduled unconducted session', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    renderApp(backend, '/attendance');

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    expect(
      await screen.findByRole('heading', { name: 'Cancel Scheduled Session' }),
    ).toBeInTheDocument();

    const input = screen.getByLabelText('Cancellation Reason');
    await user.type(input, 'Severe thunderstorm, campus closed');

    await user.click(screen.getByRole('button', { name: 'Confirm Cancellation' }));

    expect(await screen.findByText('Session cancelled.')).toBeInTheDocument();
    expect(backend.callsTo('POST', `/attendance/sessions/${SESSION_1}/cancel`).length).toBe(1);
  });

  it('has no detectable axe accessibility violations', async () => {
    const backend = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setupAttendanceState(backend);

    const { container } = renderApp(backend, '/attendance');
    await screen.findByRole('heading', { name: 'Attendance' });

    expect((await axe(container)).violations).toEqual([]);
  });
});
