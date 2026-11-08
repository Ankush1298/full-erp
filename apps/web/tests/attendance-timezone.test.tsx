import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FACULTY_TEACHER, HOD_APPROVER, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

// ATT-1/ATT-2/ATT-3 (doc 49): the campus clock, the server's correction-window answer, and distinguishable refusals.
const OFFERING = '01900000-0000-7000-8000-0000000000f1';
const SUBMITTED = '01900000-0000-7000-8000-0000000000s2';
const SCHEDULED = '01900000-0000-7000-8000-0000000000s1';
type Backend = ReturnType<typeof createFakeBackend>;

function setup(
  b: Backend,
  opt: {
    timezone: string;
    campusToday: string;
    inside?: boolean;
    sessionDate?: string;
  },
) {
  const a = b.state.attendance;
  a.myOfferings = [
    {
      id: OFFERING,
      codeSnapshot: 'CS101',
      titleSnapshot: 'Mathematics',
      groupLabel: null,
      status: 'PUBLISHED',
      termId: 't1',
      termName: 'Term 1',
      teachingRole: 'PRIMARY',
      validFrom: '2026-06-01',
      validTo: null,
      campusId: 'camp-1',
      campusTimezone: opt.timezone,
      campusToday: opt.campusToday,
    },
  ];
  const clock = {
    campusTimezone: opt.timezone,
    campusToday: opt.campusToday,
    correctionWindowDays: 3,
  };
  a.sessions = [
    {
      id: SCHEDULED,
      courseOfferingId: OFFERING,
      campusId: 'camp-1',
      timetableSlotId: null,
      conductedByEmployeeId: 'emp-1',
      sessionDate: '2026-11-07',
      startsAt: '2026-11-07T03:30:00.000Z', // 09:00 in India
      endsAt: '2026-11-07T04:30:00.000Z',
      kind: 'REGULAR',
      topic: 'Fractions',
      status: 'SCHEDULED',
      attendanceState: 'NOT_STARTED',
      attendanceSubmittedAt: null,
      version: 1,
      courseCode: 'CS101',
      courseTitle: 'Mathematics',
      insideCorrectionWindow: true,
      ...clock,
    },
    {
      id: SUBMITTED,
      courseOfferingId: OFFERING,
      campusId: 'camp-1',
      timetableSlotId: null,
      conductedByEmployeeId: 'emp-1',
      sessionDate: opt.sessionDate ?? '2026-11-07',
      startsAt: '2026-11-07T05:30:00.000Z',
      endsAt: '2026-11-07T06:30:00.000Z',
      kind: 'REGULAR',
      topic: 'Decimals',
      status: 'CONDUCTED',
      attendanceState: 'SUBMITTED',
      attendanceSubmittedAt: '2026-11-07T06:35:00.000Z',
      version: 2,
      courseCode: 'CS101',
      courseTitle: 'Mathematics',
      counts: { present: 1, absent: 0, late: 0, excused: 0, total: 1 },
      insideCorrectionWindow: opt.inside ?? true,
      ...clock,
    },
  ];
  a.rosters[SUBMITTED] = [
    { studentId: 'st-1', admissionNumber: 'A1', displayName: 'Asha Rao', rollNumber: '1' },
  ];
  a.records[SUBMITTED] = [
    {
      id: 'rec-1',
      classSessionId: SUBMITTED,
      studentId: 'st-1',
      status: 'PRESENT',
      source: 'MANUAL',
      markedByUserId: 'u-teacher',
      markedAt: '2026-11-07T06:35:00.000Z',
      revisionNo: 1,
      remarks: null,
    },
  ];
}

const postBody = (b: Backend, path: string) =>
  b.callsTo('POST', path).at(-1)?.body as Record<string, unknown> | undefined;

async function openSchedule(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Schedule New Session/ }));
  return screen.getByRole('dialog');
}
const setField = (dialog: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

describe('ATT-1: session time is campus time', () => {
  it('India campus: the default date is the CAMPUS date (not UTC), and 09:00 is sent as 03:30Z on that date', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    // 20:00Z on 7 Nov is already 8 Nov in India: the campus date is the 8th while UTC still says the 7th
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2026-11-08' });
    renderApp(b, '/attendance');
    const dialog = await openSchedule(user);
    expect(within(dialog).getByLabelText('Session Date')).toHaveValue('2026-11-08');
    expect(within(dialog).getByText(/campus clock \(Asia\/Kolkata\)/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Start Time')).toHaveValue('09:00');
    await user.click(
      within(dialog).getByRole('button', { name: /Schedule|Create|Save/i, hidden: false }),
    );
    await waitFor(() => expect(b.callsTo('POST', '/attendance/sessions')).toHaveLength(1));
    expect(postBody(b, '/attendance/sessions')).toMatchObject({
      sessionDate: '2026-11-08',
      startsAt: '2026-11-08T03:30:00.000Z',
      endsAt: '2026-11-08T04:30:00.000Z',
    });
  });

  it('another zone: 09:00 in New York is 13:00Z in summer and 14:00Z in winter', async () => {
    for (const [date, iso] of [
      ['2026-07-15', '13:00'],
      ['2026-01-15', '14:00'],
    ] as const) {
      const user = userEvent.setup();
      const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
      setup(b, { timezone: 'America/New_York', campusToday: date });
      const { unmount } = renderApp(b, '/attendance');
      const dialog = await openSchedule(user);
      await user.click(within(dialog).getByRole('button', { name: /Schedule|Create|Save/i }));
      await waitFor(() => expect(b.callsTo('POST', '/attendance/sessions')).toHaveLength(1));
      expect(postBody(b, '/attendance/sessions')).toMatchObject({
        startsAt: `${date}T${iso}:00.000Z`,
      });
      unmount();
    }
  });

  it('a time that does not exist (daylight-saving gap), a time that occurs twice, and an end before the start are explained and nothing is sent', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, { timezone: 'America/New_York', campusToday: '2026-03-08' });
    renderApp(b, '/attendance');
    const dialog = await openSchedule(user);
    setField(dialog, 'Start Time', '02:30');
    setField(dialog, 'End Time', '03:30');
    await user.click(within(dialog).getByRole('button', { name: /Schedule|Create|Save/i }));
    expect(
      await within(dialog).findByText(/does not exist on the campus clock/),
    ).toBeInTheDocument();
    setField(dialog, 'Session Date', '2026-11-01');
    setField(dialog, 'Start Time', '01:30');
    setField(dialog, 'End Time', '03:00');
    await user.click(within(dialog).getByRole('button', { name: /Schedule|Create|Save/i }));
    expect(await within(dialog).findByText(/occurs twice on the campus clock/)).toBeInTheDocument();
    setField(dialog, 'Start Time', '10:00');
    setField(dialog, 'End Time', '09:00');
    await user.click(within(dialog).getByRole('button', { name: /Schedule|Create|Save/i }));
    expect(
      await within(dialog).findByText(/end time must be after the start time/),
    ).toBeInTheDocument();
    expect(b.callsTo('POST', '/attendance/sessions')).toHaveLength(0);
  });

  it('a server refusal is shown in the form with specific wording, not a generic status', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2026-11-08' });
    b.state.attendance.createError = 'SESSION_ON_HOLIDAY';
    renderApp(b, '/attendance');
    const dialog = await openSchedule(user);
    await user.click(within(dialog).getByRole('button', { name: /Schedule|Create|Save/i }));
    expect(await within(dialog).findByText(/holiday or non-teaching day/)).toBeInTheDocument();
    expect(screen.queryByText(/API validation/)).not.toBeInTheDocument();
  });

  it('times are DISPLAYED on the campus clock whatever the browser zone is', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2026-11-07' });
    renderApp(b, '/attendance');
    await screen.findByRole('button', { name: /Schedule New Session/ });
    expect(await screen.findByText(/09:00 – 10:00/)).toBeInTheDocument(); // 03:30Z-04:30Z in India
    expect(screen.getByText(/11:00 – 12:00/)).toBeInTheDocument(); // 05:30Z-06:30Z
    void user;
  });
});

describe("ATT-2: the correction window is the server's answer on the campus calendar", () => {
  it('follows insideCorrectionWindow=false even when the date looks recent', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, {
      timezone: 'Asia/Kolkata',
      campusToday: '2026-11-08',
      sessionDate: '2026-11-07',
      inside: false,
    });
    renderApp(b, '/attendance');
    await user.click((await screen.findAllByRole('button', { name: 'View Register' }))[0]!);
    await user.click((await screen.findAllByRole('button', { name: 'Correct' }))[0]!);
    expect(
      await screen.findByRole('heading', { name: 'Request Attendance Correction' }),
    ).toBeInTheDocument();
  });

  it('follows insideCorrectionWindow=true even when the date looks old', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, {
      timezone: 'Asia/Kolkata',
      campusToday: '2026-11-08',
      sessionDate: '2026-01-01',
      inside: true,
    });
    renderApp(b, '/attendance');
    await user.click((await screen.findAllByRole('button', { name: 'View Register' }))[0]!);
    await user.click((await screen.findAllByRole('button', { name: 'Correct' }))[0]!);
    expect(
      await screen.findByRole('heading', { name: 'Correct Attendance Record' }),
    ).toBeInTheDocument();
  });
});

describe('ATT-3: refusals are distinguishable', () => {
  const openCorrection = async (b: Backend) => {
    const user = userEvent.setup();
    renderApp(b, '/attendance');
    await user.click((await screen.findAllByRole('button', { name: 'View Register' }))[0]!);
    await user.click((await screen.findAllByRole('button', { name: 'Correct' }))[0]!);
    await user.click(
      await screen.findByRole('button', { name: /Apply Correction|Submit Request/ }),
    );
  };

  it.each([
    ['ATTENDANCE_CORRECTIONS_DISABLED', /switched off for this institution/],
    ['FORBIDDEN', /do not have permission/],
    ['SESSION_LOCKED', /session is locked/],
    ['CORRECTION_WINDOW_PASSED', /correction window has passed/],
    ['CORRECTION_WINDOW_OPEN', /still inside the correction window/],
    ['TERM_CLOSED', /term is closed/],
    ['RECORD_CHANGED', /changed since you opened it/],
  ])('%s gets its own wording', async (code, text) => {
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2026-11-07' });
    if (code === 'ATTENDANCE_CORRECTIONS_DISABLED') b.state.attendance.correctionsEnabled = false;
    else b.state.attendance.correctionError = code;
    await openCorrection(b);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/disabled by institution configuration/)).not.toBeInTheDocument();
  });

  it('an unknown error code falls back to a neutral sentence that reveals nothing', async () => {
    const b = createFakeBackend({ me: FACULTY_TEACHER, session: true });
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2026-11-07' });
    b.state.attendance.correctionError = 'SOMETHING_NEW';
    await openCorrection(b);
    expect(
      await screen.findByText('Failed to process correction. Please try again.'),
    ).toBeInTheDocument();
  });
});

describe('register defaults use the campus clock', () => {
  it("an administrator's register opens on the campus date reported by the server (not UTC), and Today returns to it", async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: HOD_APPROVER, session: true });
    setup(b, { timezone: 'Pacific/Kiritimati', campusToday: '2099-06-02' });
    b.state.attendance.campuses = [
      { id: 'camp-1', name: 'Main', timezone: 'Pacific/Kiritimati', today: '2099-06-02' },
    ];
    renderApp(b, '/attendance');
    await user.click(await screen.findByRole('tab', { name: /School Registers/ }));
    const date = await screen.findByLabelText('Date:');
    expect(date).toHaveValue('2099-06-02');
    fireEvent.change(date, { target: { value: '2099-05-01' } });
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(date).toHaveValue('2099-06-02');
  });

  it('with two campuses a selector appears and each campus has its own today', async () => {
    const user = userEvent.setup();
    const b = createFakeBackend({ me: HOD_APPROVER, session: true });
    setup(b, { timezone: 'Asia/Kolkata', campusToday: '2099-06-02' });
    b.state.attendance.campuses = [
      { id: 'camp-1', name: 'East', timezone: 'Pacific/Kiritimati', today: '2099-06-02' },
      { id: 'camp-2', name: 'West', timezone: 'Pacific/Pago_Pago', today: '2099-06-01' },
    ];
    renderApp(b, '/attendance');
    await user.click(await screen.findByRole('tab', { name: /School Registers/ }));
    const select = await screen.findByLabelText('Campus:');
    await user.selectOptions(select, 'camp-2');
    expect(screen.getByLabelText('Date:')).toHaveValue('2099-06-01');
  });
});
