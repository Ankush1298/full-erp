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

function setupPoliciesState(backend: ReturnType<typeof createFakeBackend>) {
  backend.state.examinations.items = [
    {
      id: 'ex-1',
      campus_id: 'camp-1',
      term_id: 'term-1',
      name: 'Autumn Term Examinations 2026',
      exam_type: 'FINAL',
      status: 'SCHEDULED',
      starts_on: '2026-11-15',
      ends_on: '2026-11-25',
    },
  ];

  backend.state.examinations.schedules = [
    {
      id: 'sched-1',
      examination_id: 'ex-1',
      course_offering_id: 'off-1',
      course_code: 'MATH101',
      course_title: 'Mathematics Class 5',
      exam_date: '2026-11-18',
      start_time: '10:00',
      end_time: '12:00',
      max_marks: 100,
      pass_marks: 40,
      status: 'SCHEDULED',
    },
  ];

  backend.state.examinations.policyList = [
    {
      id: 'pol-inst-1',
      name: 'CBSE Baseline Academic Policy',
      description: 'Standard institutional examination policy covering attendance and grading.',
      scope: 'INSTITUTION',
      status: 'ACTIVE',
      min_attendance_percentage: 75,
      check_attendance: true,
      check_fees: false,
      attendance_cutoff_days_prior: 0,
      allow_late_enrolment_review: true,
      version: 1,
      grading_rules: {
        grading_system: 'LETTER_GRADE',
        grade_scale: [
          { grade: 'A+', min_percentage: 90, max_percentage: 100, grade_point: 10, is_passing: true },
          { grade: 'A', min_percentage: 80, max_percentage: 89.99, grade_point: 9, is_passing: true },
          { grade: 'B', min_percentage: 60, max_percentage: 79.99, grade_point: 7, is_passing: true },
          { grade: 'F', min_percentage: 0, max_percentage: 59.99, grade_point: 0, is_passing: false },
        ],
      },
      assessment_rules: {
        components: [
          { name: 'Theory Paper', component_type: 'THEORY', max_marks: 80, pass_marks: 32, weight_percentage: 80 },
          { name: 'Internal Assessment', component_type: 'INTERNAL', max_marks: 20, pass_marks: 8, weight_percentage: 20 },
        ],
      },
    },
  ];
}

describe('Examination Policies & Settings System', () => {
  it('navigates to Examination Policies & Settings tab and renders policy cards cleanly', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupPoliciesState(backend);

    const { container } = renderApp(backend, '/examinations');

    const policiesTabBtn = await screen.findByRole('button', {
      name: 'Examination Policies & Settings',
    });
    expect(policiesTabBtn).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(policiesTabBtn);

    expect(
      await screen.findByRole('heading', {
        name: 'Institutional Examination Policies & Rule Sets',
      }),
    ).toBeInTheDocument();

    // Check Precedence hierarchy callout
    expect(screen.getByText(/Policy Precedence Hierarchy:/)).toBeInTheDocument();
    expect(screen.getByText(/1. Schedule Paper Override/)).toBeInTheDocument();

    // Check policy card rendered
    expect(screen.getByText('CBSE Baseline Academic Policy')).toBeInTheDocument();
    expect(screen.getByText('75% Min')).toBeInTheDocument();
    expect(screen.getByText('LETTER_GRADE')).toBeInTheDocument();

    expect((await axe(container)).violations).toEqual([]);
  });

  it('provides a 1-setting-per-row layout with clear descriptions and conditional controls', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupPoliciesState(backend);

    renderApp(backend, '/examinations');
    const user = userEvent.setup();

    const policiesTabBtn = await screen.findByRole('button', {
      name: 'Examination Policies & Settings',
    });
    await user.click(policiesTabBtn);

    const createBtn = await screen.findByRole('button', { name: '+ Create New Policy' });
    await user.click(createBtn);

    expect(
      await screen.findByRole('heading', { name: 'Create Examination Policy Template' }),
    ).toBeInTheDocument();

    // Check section headings (9 distinct sections)
    expect(screen.getByText('1. General Policy & Scope')).toBeInTheDocument();
    expect(screen.getByText('2. Attendance Requirements')).toBeInTheDocument();
    expect(screen.getByText('3. Academic Eligibility')).toBeInTheDocument();
    expect(screen.getByText('4. Fee Clearance')).toBeInTheDocument();
    expect(screen.getByText('5. Exceptions & Special Cases')).toBeInTheDocument();
    expect(screen.getByText('6. Examination Components')).toBeInTheDocument();
    expect(screen.getByText('7. Passing & Grading Rules')).toBeInTheDocument();
    expect(screen.getByText('8. Candidate Approval Workflow')).toBeInTheDocument();
    expect(
      screen.getByText(/9\. (Results Approval Authority & Publication Workflow|Result Review & Publication)/),
    ).toBeInTheDocument();

    // Check setting descriptions exist beneath checkboxes
    expect(
      screen.getByText(
        'Automatically verify that candidate session attendance meets or exceeds the required percentage before permitting examination entry.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Verify that students have cleared applicable term tuition and examination dues prior to hall ticket issuance.',
      ),
    ).toBeInTheDocument();

    // Fee clearance is initially unchecked -> balance tolerance input is not visible
    expect(screen.queryByLabelText(/Balance Tolerance/)).not.toBeInTheDocument();

    // Enable fee clearance -> conditional inputs appear
    const feeCheckbox = screen.getByLabelText(/Enforce fee clearance requirement/);
    await user.click(feeCheckbox);
    expect(screen.getByLabelText(/Balance Tolerance/)).toBeInTheDocument();
  });

  it('features an interactive grading scale calculator preview with immediate feedback', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupPoliciesState(backend);

    renderApp(backend, '/examinations');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Examination Policies & Settings' }));
    await user.click(await screen.findByRole('button', { name: '+ Create New Policy' }));

    // Interactive grading calculator input
    const scoreInput = screen.getByLabelText(/Test Score \(%\):/);
    expect(scoreInput).toBeInTheDocument();

    // Default test score is 75 -> B+ (Very Good) -> PASS
    expect(screen.getByText(/Awarded Grade:/)).toBeInTheDocument();
    expect(screen.getByText(/PASS/)).toBeInTheDocument();

    // Enter failing score (30%)
    await user.clear(scoreInput);
    await user.type(scoreInput, '30');
    expect(screen.getByText(/FAIL/)).toBeInTheDocument();
  });

  it('supports policy creation, duplication, activation and impact simulation', async () => {
    const backend = createFakeBackend({ me: EXAM_ADMIN, session: true });
    setupPoliciesState(backend);

    renderApp(backend, '/examinations');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Examination Policies & Settings' }));

    // 1. Duplicate existing policy
    const dupBtn = await screen.findByRole('button', { name: 'Duplicate' });
    await user.click(dupBtn);

    await waitFor(() => {
      expect(screen.getByText(/Duplicated policy as/)).toBeInTheDocument();
    });

    // 2. Edit duplicated policy and simulate impact
    const editBtns = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(editBtns[1] ?? editBtns[0]!);

    const simBtn = await screen.findByRole('button', { name: 'Simulate Policy Impact' });
    await user.click(simBtn);

    // Verify simulation modal
    expect(await screen.findByText('Policy Impact Simulation')).toBeInTheDocument();
    expect(screen.getByText('Rohan Kumar')).toBeInTheDocument();
    expect(screen.getByText(/Attendance requirement met: 95.0% >= 75.0%/)).toBeInTheDocument();

    // Close simulation modal
    await user.click(screen.getByRole('button', { name: 'Close' }));

    // Save policy
    await user.click(screen.getByRole('button', { name: 'Save Policy' }));
    await waitFor(() => {
      expect(screen.getByText(/updated successfully/)).toBeInTheDocument();
    });
  });
});
