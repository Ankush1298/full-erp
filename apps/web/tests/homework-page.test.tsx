import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const TEACHER_ME: MeData = {
  tenant_id: 't1',
  user_id: 'usr_teacher_01',
  display_name: 'Dr. Rao',
  actor_kind: 'STAFF',
  roles: ['FACULTY'],
  capabilities: [
    'session.read',
    'session.revoke',
    'homework.manage',
    'homework.review',
    'homework.read',
  ],
};

const STUDENT_ME: MeData = {
  tenant_id: 't1',
  user_id: 'usr_student_01',
  display_name: 'Aarav Sharma',
  actor_kind: 'STUDENT',
  roles: ['STUDENT'],
  capabilities: [
    'session.read',
    'session.revoke',
    'student.profile.read',
    'homework.read',
    'homework.submit',
  ],
};

const PARENT_ME: MeData = {
  tenant_id: 't1',
  user_id: 'usr_parent_01',
  display_name: 'Priya Sharma',
  actor_kind: 'STAFF',
  roles: ['PARENT'],
  capabilities: [
    'session.read',
    'session.revoke',
    'parent.portal.access',
    'parent.student.read',
    'parent.attendance.read',
    'parent.academics.read',
  ],
};

describe('Homework & Assignments — Teacher Workflow', () => {
  it('renders teacher homework dashboard with assigned classes, KPI stats, and tabs', async () => {
    const backend = createFakeBackend({ session: true, me: TEACHER_ME });
    const { container } = renderApp(backend, '/homework');

    // Wait for async data to load
    expect(await screen.findByRole('heading', { name: 'Homework & Assignments' })).toBeInTheDocument();
    expect(await screen.findByText('Assigned Classes')).toBeInTheDocument();
    expect(screen.getByText('Active Homework')).toBeInTheDocument();
    expect(screen.getAllByText('Drafts').length).toBeGreaterThanOrEqual(1);

    // Action button
    expect(screen.getByRole('button', { name: '+ Create Homework' })).toBeInTheDocument();

    // Assignments table
    expect(await screen.findByText('Algebra Problem Set 1')).toBeInTheDocument();
    expect(screen.getByText('Geometry Worksheet (Draft)')).toBeInTheDocument();

    // Accessibility check
    expect((await axe(container)).violations).toEqual([]);
  });

  it('allows teacher to create a new homework assignment with live recipient preview', async () => {
    const backend = createFakeBackend({ session: true, me: TEACHER_ME });
    renderApp(backend, '/homework');

    // Wait for classes to load first
    expect(await screen.findByText('Assigned Classes')).toBeInTheDocument();

    const user = userEvent.setup();
    const createBtn = screen.getByRole('button', { name: '+ Create Homework' });
    await user.click(createBtn);

    // Modal opens
    expect(await screen.findByRole('heading', { name: 'Create Homework Assignment' })).toBeInTheDocument();

    // Live recipient preview check
    expect(await screen.findByText(/will receive this homework/i)).toBeInTheDocument();
    expect(screen.getAllByText(/28 Students/i).length).toBeGreaterThanOrEqual(1);

    // Fill form
    const titleInput = screen.getByPlaceholderText(/e\.g\. Chapter 4 Problem Set/i);
    await user.type(titleInput, 'Trigonometry Homework #2');

    const instructionsInput = screen.getByPlaceholderText(/Detailed instructions for students/i);
    await user.type(instructionsInput, 'Solve questions 1 through 10 on page 78.');

    // Save as draft
    const saveDraftBtn = screen.getByRole('button', { name: 'Save as Draft' });
    await user.click(saveDraftBtn);

    // Verifies notification and modal close
    expect(await screen.findByText(/Homework saved as draft/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Trigonometry Homework #2')).toBeInTheDocument();
    });
  });

  it('allows teacher to publish draft homework and close active assignments', async () => {
    const backend = createFakeBackend({ session: true, me: TEACHER_ME });
    renderApp(backend, '/homework');

    // Wait for data to load
    expect(await screen.findByText('Assigned Classes')).toBeInTheDocument();

    const user = userEvent.setup();
    // Locate the Publish button for draft homework
    const publishBtn = await screen.findByRole('button', { name: 'Publish' });
    await user.click(publishBtn);

    expect(await screen.findByText(/Assignment published to students successfully/i)).toBeInTheDocument();

    // Locate the Close Assignment button for published homework
    const closeBtns = await screen.findAllByRole('button', { name: 'Close Assignment' });
    expect(closeBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(closeBtns[0]!);

    expect(await screen.findByText(/Assignment marked as closed/i)).toBeInTheDocument();
  });

  it('allows teacher to review submissions, grade student work, and provide feedback', async () => {
    const backend = createFakeBackend({ session: true, me: TEACHER_ME });
    renderApp(backend, '/homework');

    expect(await screen.findByText('Assigned Classes')).toBeInTheDocument();

    const user = userEvent.setup();
    // Click Review button
    const reviewBtn = await screen.findByRole('button', { name: /Review \(20\)/i });
    await user.click(reviewBtn);

    // Modal opens showing submissions
    expect(await screen.findByRole('heading', { name: /Submissions: Algebra Problem Set 1/i })).toBeInTheDocument();
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument();

    // Click Grade / Feedback button for student
    const gradeBtn = screen.getByRole('button', { name: 'Grade / Feedback' });
    await user.click(gradeBtn);

    // Grade form opens
    expect(await screen.findByRole('heading', { name: /Grade Submission: Aarav Sharma/i })).toBeInTheDocument();

    // Enter marks and feedback
    const marksInput = screen.getByRole('spinbutton');
    await user.clear(marksInput);
    await user.type(marksInput, '95');

    const gradeInput = screen.getByPlaceholderText(/e\.g\. A\+, 95%/i);
    await user.type(gradeInput, 'A+');

    const feedbackInput = screen.getByPlaceholderText(/Feedback for student/i);
    await user.type(feedbackInput, 'Excellent algebraic proofs with clear step-by-step working.');

    const saveEvalBtn = screen.getByRole('button', { name: 'Save Evaluation' });
    await user.click(saveEvalBtn);

    // Verifies success message
    expect(await screen.findByText(/Graded submission for Aarav Sharma/i)).toBeInTheDocument();
  });
});

describe('Homework & Assignments — Student Workflow', () => {
  it('renders student homework dashboard with pending, submitted, and evaluated tasks', async () => {
    const backend = createFakeBackend({ session: true, me: STUDENT_ME });
    const { container } = renderApp(backend, '/homework');

    expect(await screen.findByRole('heading', { name: 'My Homework & Assignments' })).toBeInTheDocument();
    expect(await screen.findByText('Total Assigned')).toBeInTheDocument();
    expect(screen.getAllByText('Submitted').length).toBeGreaterThanOrEqual(1);

    // Student assignments list
    expect(await screen.findByText('Algebra Problem Set 1')).toBeInTheDocument();
    expect(screen.getByText('Dr. Rao • Section A')).toBeInTheDocument();

    // Accessibility check
    expect((await axe(container)).violations).toEqual([]);
  });

  it('allows student to open homework submission dialog and submit work', async () => {
    // Add an unsubmitted task
    const backend = createFakeBackend({ session: true, me: STUDENT_ME });
    backend.state.homework.studentAssignments = [
      {
        id: 'hw_pending_01',
        courseOfferingId: 'off_math_101',
        courseCode: 'MATH-01',
        courseTitle: 'Mathematics Grade 9',
        sectionName: 'Section A',
        teacherName: 'Dr. Rao',
        title: 'Trigonometry Worksheet',
        instructions: 'Answer all questions on sine and cosine rules.',
        submissionType: 'ONLINE',
        dueDate: '2026-11-28',
        dueTime: '17:00',
        maxMarks: 50,
        status: 'PUBLISHED',
        submissionStatus: 'PENDING',
        submittedAt: null,
        evaluatedAt: null,
        marksObtained: null,
        grade: null,
        feedback: null,
        resubmissionAllowed: true,
        attachments: [],
        mySubmissionFiles: [],
        mySubmissionText: null,
      },
    ];

    renderApp(backend, '/homework');

    const user = userEvent.setup();
    const submitBtn = await screen.findByRole('button', { name: 'Submit Work' });
    await user.click(submitBtn);

    // Modal opens
    expect(await screen.findByRole('heading', { name: 'Submit Homework' })).toBeInTheDocument();
    expect(screen.getAllByText('Trigonometry Worksheet').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Academic Honesty/i)).toBeInTheDocument();

    // Enter answer text and submit
    const textarea = screen.getByPlaceholderText(/Type your answers, solutions, or explanation/i);
    await user.type(textarea, 'Answers: Q1: 0.5, Q2: 1.0, Q3: sqrt(3)/2');

    const submitAssignmentBtn = screen.getByRole('button', { name: 'Submit Assignment' });
    await user.click(submitAssignmentBtn);

    // Confirmation message
    expect(
      await screen.findByText(/Your homework submission was uploaded and recorded successfully/i),
    ).toBeInTheDocument();
  });
});

describe('Homework & Assignments — Parent Portal Integration', () => {
  it('displays active child homework assignments in Parent Portal', async () => {
    const backend = createFakeBackend({ session: true, me: PARENT_ME });
    renderApp(backend, '/parent');

    const user = userEvent.setup();
    // Switch to Homework tab
    const homeworkTab = await screen.findByRole('button', { name: 'Homework' });
    await user.click(homeworkTab);

    // Verifies homework assignments are displayed for child
    expect(await screen.findByRole('heading', { name: 'Curriculum Homework & Assignments' })).toBeInTheDocument();
    expect(screen.getByText('Algebra Problem Set 1')).toBeInTheDocument();
    expect(screen.getByText('Mathematics Grade 9')).toBeInTheDocument();
  });
});
