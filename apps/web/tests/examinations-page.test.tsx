import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const EXAM_ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u-admin',
  actor_kind: 'STAFF',
  display_name: 'Adam Admin',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'exam.manage',
    'exam.marks.enter',
    'result.publish',
    'result.read',
  ],
};

const EXAM_TEACHER: MeData = {
  tenant_id: 't1',
  user_id: 'u-teacher',
  actor_kind: 'STAFF',
  display_name: 'Tara Teacher',
  roles: ['FACULTY'],
  capabilities: ['session.read', 'session.revoke', 'exam.marks.enter', 'result.read'],
};

const EXAM_STUDENT: MeData = {
  tenant_id: 't1',
  user_id: 'st-1',
  actor_kind: 'STUDENT',
  display_name: 'Alice Johnson',
  roles: ['STUDENT'],
  capabilities: ['session.read', 'session.revoke', 'result.read'],
};

function setupExamState(backend: ReturnType<typeof createFakeBackend>) {
  backend.state.examinations.items = [
    {
      id: 'ex-1',
      campus_id: 'camp-1',
      term_id: 'term-1',
      name: 'Autumn Mid-Term 2026',
      exam_type: 'MID_TERM',
      status: 'SCHEDULED',
      starts_on: '2026-10-15',
      ends_on: '2026-10-25',
    },
  ];

  backend.state.examinations.schedules = [
    {
      id: 'sched-1',
      examination_id: 'ex-1',
      course_offering_id: 'off-1',
      course_code: 'CS101',
      course_title: 'Introduction to Computer Science',
      exam_date: '2026-10-18',
      start_time: '10:00',
      end_time: '12:00',
      max_marks: 100,
      pass_marks: 40,
      status: 'SCHEDULED',
    },
  ];

  backend.state.examinations.marks = [
    {
      student_id: 'st-1',
      admission_number: 'ADM001',
      student_name: 'Alice Johnson',
      roll_number: '101',
      schedule_id: 'sched-1',
      mark_id: 'm-1',
      marks_obtained: 85,
      status: 'ENTERED',
      is_passing: true,
      published: true,
    },
    {
      student_id: 'st-2',
      admission_number: 'ADM002',
      student_name: 'Bob Smith',
      roll_number: '102',
      schedule_id: 'sched-1',
      mark_id: 'm-2',
      marks_obtained: 35,
      status: 'ENTERED',
      is_passing: false,
      published: true,
    },
  ];
}

describe('Examinations & Results Page', () => {
  it('renders correctly for authorized examination admin and passes axe a11y', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamState(backend);

    const { container } = renderApp(backend, '/examinations');

    expect(
      await screen.findByRole('heading', { name: 'Examinations, Marks & Results' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Examination Setup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marks Entry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review & Publish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marks Register' })).toBeInTheDocument();

    expect((await axe(container)).violations).toEqual([]);
  });

  it('allows teacher to record and submit student marks', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_TEACHER, session: true });
    setupExamState(backend);

    renderApp(backend, '/examinations');

    expect(
      await screen.findByRole('heading', { name: 'Examinations, Marks & Results' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marks Entry' })).toBeInTheDocument();
    // Teacher should NOT have Review & Publish (maker-checker separation)
    expect(screen.queryByRole('button', { name: 'Review & Publish' })).not.toBeInTheDocument();

    // Roster should load
    expect(await screen.findByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();

    // Submit marks
    const submitBtn = screen.getByRole('button', { name: 'Submit Marks' });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Marks submitted successfully/)).toBeInTheDocument();
    });
  });

  it('allows administrator to publish examination results (maker-checker)', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamState(backend);
    backend.state.examinations.schedules[0]!.status = 'SUBMITTED';

    renderApp(backend, '/examinations');

    const pubTab = await screen.findByRole('button', { name: 'Review & Publish' });
    await user.click(pubTab);

    expect(
      await screen.findByRole('heading', {
        name: 'Examination Papers Awaiting Review & Publication',
      }),
    ).toBeInTheDocument();

    // Click publish results button
    window.confirm = () => true;
    const pubBtn = screen.getByRole('button', { name: 'Publish Results' });
    await user.click(pubBtn);

    await waitFor(() => {
      expect(screen.getByText(/Results published successfully/)).toBeInTheDocument();
    });
  });

  it('displays class register with statistics summary cards', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamState(backend);

    renderApp(backend, '/examinations');

    const regTab = await screen.findByRole('button', { name: 'Marks Register' });
    await user.click(regTab);

    expect(await screen.findByRole('heading', { name: 'Class Marks Sheet' })).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Appeared')).toBeInTheDocument();
    expect(screen.getByText('Pass %')).toBeInTheDocument();
  });

  it('allows student to view their own published results card', async () => {
    const backend = createFakeBackend({ me: EXAM_STUDENT, session: true });
    setupExamState(backend);

    renderApp(backend, '/examinations');

    expect(
      await screen.findByRole('heading', { name: 'My Published Examination Results' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Introduction to Computer Science')).toBeInTheDocument();
    expect(screen.getByText('CS101')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
  });
});
