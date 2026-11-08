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

function setupExamWithCandidateState(backend: ReturnType<typeof createFakeBackend>) {
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
      marks_obtained: null,
      status: 'ENTERED',
      is_passing: null,
      published: false,
    },
    {
      student_id: 'st-2',
      admission_number: 'ADM002',
      student_name: 'Bob Smith',
      roll_number: '102',
      schedule_id: 'sched-1',
      mark_id: 'm-2',
      marks_obtained: null,
      status: 'ENTERED',
      is_passing: null,
      published: false,
    },
  ];
}

describe('Examinations Eligibility & Candidate Lists (Slice 2)', () => {
  it('renders eligibility & candidates tab for authorized staff and passes axe a11y', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamWithCandidateState(backend);

    const { container } = renderApp(backend, '/examinations');

    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    expect(candTab).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(candTab);

    expect(
      await screen.findByRole('heading', {
        name: 'Candidate Eligibility & Automatic Verification',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure Policy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate Candidate List' })).toBeInTheDocument();

    expect((await axe(container)).violations).toEqual([]);
  });

  it('allows admin to configure eligibility policy with custom threshold', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamWithCandidateState(backend);

    renderApp(backend, '/examinations');

    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    await user.click(candTab);

    const configBtn = await screen.findByRole('button', { name: 'Configure Policy' });
    await user.click(configBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Configure Eligibility Policy' }),
    ).toBeInTheDocument();

    const minAttInput = screen.getByLabelText(/Min Attendance %/);
    await user.clear(minAttInput);
    await user.type(minAttInput, '80');

    const saveBtn = screen.getByRole('button', { name: 'Save Policy' });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Eligibility policy updated successfully/)).toBeInTheDocument();
    });

    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('allows admin to generate candidate list, view metrics, and inspect candidate evidence', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamWithCandidateState(backend);

    renderApp(backend, '/examinations');

    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    await user.click(candTab);

    const genBtn = await screen.findByRole('button', { name: 'Generate Candidate List' });
    await user.click(genBtn);

    await waitFor(() => {
      expect(screen.getByText(/Candidate list generated with/)).toBeInTheDocument();
    });

    // Verification of metrics cards
    expect(screen.getByText('Total Candidates')).toBeInTheDocument();
    expect(screen.getByText('Needs Review')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Candidate List Roster' })).toBeInTheDocument();

    // Verify candidates rendered
    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();

    // Open evidence modal for Alice
    const evidenceBtns = screen.getAllByRole('button', { name: 'Evidence' });
    await user.click(evidenceBtns[0]!);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Candidate Evidence — Alice Johnson/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Sessions Held')).toBeInTheDocument();

    // Close modal
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('allows admin to override candidate status with justification and approve list', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamWithCandidateState(backend);

    renderApp(backend, '/examinations');

    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    await user.click(candTab);

    // Generate candidates
    const genBtn = await screen.findByRole('button', { name: 'Generate Candidate List' });
    await user.click(genBtn);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Candidate List Roster' })).toBeInTheDocument();
    });

    // Click override on Bob Smith
    const overrideBtns = screen.getAllByRole('button', { name: 'Override' });
    await user.click(overrideBtns[1]!);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Override Candidate Eligibility — Bob Smith/ }),
    ).toBeInTheDocument();

    const reasonInput = screen.getByLabelText(/Override Justification \/ Reason/);
    await user.type(reasonInput, 'Medical leave approved by Academic Dean #402');

    const applyBtn = screen.getByRole('button', { name: 'Apply Override' });
    await user.click(applyBtn);

    await waitFor(() => {
      expect(screen.getByText(/Override applied for Bob Smith/)).toBeInTheDocument();
    });

    // Approve the candidate list
    const approveBtn = screen.getByRole('button', { name: 'Approve Candidate List' });
    await user.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Candidate list approved/)).toBeInTheDocument();
    });

    // Now freeze button should be visible
    expect(screen.getByRole('button', { name: 'Freeze Candidate List' })).toBeInTheDocument();
  });

  it('restricts marks entry for ineligible candidates when candidate list is approved', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupExamWithCandidateState(backend);

    renderApp(backend, '/examinations');

    // Generate and approve candidates
    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    await user.click(candTab);
    await user.click(await screen.findByRole('button', { name: 'Generate Candidate List' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve Candidate List' })).toBeInTheDocument();
    });

    // Mark Bob as DISQUALIFIED
    const overrideBtns = screen.getAllByRole('button', { name: 'Override' });
    await user.click(overrideBtns[1]!);
    const select = screen.getByLabelText(/Override Decision/);
    await user.selectOptions(select, 'DISQUALIFIED');
    const reasonInput = screen.getByLabelText(/Override Justification \/ Reason/);
    await user.type(reasonInput, 'Disciplinary suspension');
    await user.click(screen.getByRole('button', { name: 'Apply Override' }));
    await waitFor(() => {
      expect(screen.getByText(/Override applied for Bob Smith/)).toBeInTheDocument();
    });

    // Approve list
    await user.click(screen.getByRole('button', { name: 'Approve Candidate List' }));
    await waitFor(() => {
      expect(screen.getByText(/Candidate list approved/)).toBeInTheDocument();
    });

    // Switch to Marks Entry tab
    const marksTab = screen.getByRole('button', { name: 'Marks Entry' });
    await user.click(marksTab);

    expect(
      await screen.findByRole('table', { name: 'Student Marks Entry Table' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Candidate List Status:/)).toBeInTheDocument();

    // Alice should be eligible
    const aliceMarksInput = screen.getByLabelText('Marks for Alice Johnson');
    expect(aliceMarksInput).not.toBeDisabled();

    // Bob should have ineligible disabled input
    const bobMarksInput = screen.getByLabelText('Marks for Bob Smith');
    expect(bobMarksInput).toBeDisabled();
    expect(bobMarksInput).toHaveAttribute('placeholder', 'Ineligible');
  });

  it('allows teacher to view candidate list without administrative override buttons', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: EXAM_TEACHER, session: true });
    setupExamWithCandidateState(backend);

    // Pre-populate approved candidate list
    backend.state.examinations.candidateLists['sched-1'] = {
      list: {
        id: 'cl-1',
        exam_schedule_id: 'sched-1',
        policy_id: null,
        policy_version: 1,
        snapshot_version: 1,
        status: 'APPROVED',
        evidence_cutoff_date: '2026-10-18',
        total_candidates: 2,
        eligible_count: 2,
        not_eligible_count: 0,
        needs_review_count: 0,
        policy_snapshot: {},
        generated_at: '2026-10-18T10:00:00Z',
        approved_at: '2026-10-18T10:00:00Z',
        approved_by_user_id: 'u-admin',
      },
      policy: null,
      candidates: [
        {
          candidate_id: 'c-1',
          student_id: 'st-1',
          admission_number: 'ADM001',
          student_name: 'Alice Johnson',
          roll_number: '101',
          evaluation_status: 'ELIGIBLE',
          override_status: 'NONE',
          final_status: 'ELIGIBLE',
          reasons: ['ATTENDANCE_MET'],
          evidence_summary: {
            total_sessions: 10,
            attended_sessions: 9,
            absent_sessions: 1,
            excused_sessions: 0,
            attendance_percentage: 90,
            required_percentage: 75,
            cutoff_date: '2026-10-18',
            reasons: [],
          },
          override_reason: null,
          overridden_by_user_id: null,
          overridden_at: null,
        },
      ],
      recalculation_available: false,
    };

    renderApp(backend, '/examinations');

    const candTab = await screen.findByRole('button', { name: 'Eligibility & Candidates' });
    await user.click(candTab);

    expect(
      await screen.findByRole('heading', {
        name: 'Candidate Eligibility & Automatic Verification',
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Alice Johnson')).toBeInTheDocument();

    // Teacher cannot configure policy, approve or override
    expect(screen.queryByRole('button', { name: 'Configure Policy' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve Candidate List' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Override' })).not.toBeInTheDocument();

    // Teacher CAN view evidence
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeInTheDocument();
  });
});
