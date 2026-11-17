import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const PARENT_ME: MeData = {
  tenant_id: 't1',
  user_id: 'usr_parent_01',
  display_name: 'Priya Sharma',
  actor_kind: 'STAFF',
  roles: ['PARENT'],
  capabilities: [
    'parent.portal.access',
    'parent.student.read',
    'parent.attendance.read',
    'parent.academics.read',
    'parent.exam.read',
    'parent.fee.read',
    'parent.fee.pay',
  ],
};

const MOCK_CHILDREN = [
  {
    studentId: 'stu_aarav_01',
    admissionNumber: 'ADM-2024-001',
    displayName: 'Aarav Sharma',
    status: 'ACTIVE',
    campusName: 'Main Campus',
    programName: 'Secondary School',
    cohortName: 'Grade 9-A',
    relation: 'Mother',
    isPrimary: true,
    canViewAcademics: true,
    canReceiveNotifications: true,
  },
  {
    studentId: 'stu_ananya_02',
    admissionNumber: 'ADM-2025-042',
    displayName: 'Ananya Sharma',
    status: 'ACTIVE',
    campusName: 'Main Campus',
    programName: 'Primary School',
    cohortName: 'Grade 5-B',
    relation: 'Mother',
    isPrimary: true,
    canViewAcademics: true,
    canReceiveNotifications: true,
  },
];

const MOCK_SUMMARY = {
  child: MOCK_CHILDREN[0]!,
  attendance: {
    rate: 94,
    conducted: 50,
    present: 47,
    absent: 3,
  },
  academics: {
    coursesCount: 6,
    todaySchedule: [],
  },
  examinations: {
    latestPublished: [
      {
        examName: 'Midterm Examination 2026',
        courseName: 'Mathematics',
        marksObtained: 92,
        maxMarks: 100,
        grade: 'A+',
        publishedDate: '2026-10-15',
      },
    ],
  },
  fees: {
    totalOutstanding: 2500000,
    currency: 'INR',
    nextDue: {
      amount: 2500000,
      dueDate: '2026-11-30',
      title: 'Term 2 Tuition Fee',
    },
  },
};

const MOCK_ATTENDANCE = {
  attendanceRate: 94,
  totalSessions: 50,
  presentCount: 47,
  absentCount: 3,
  lateCount: 0,
  records: [
    {
      date: '2026-11-10',
      period: 'Period 1 (08:30)',
      courseName: 'Mathematics',
      status: 'PRESENT',
      remarks: 'On time',
    },
    {
      date: '2026-11-09',
      period: 'Period 2 (09:30)',
      courseName: 'Science',
      status: 'ABSENT',
      remarks: 'Medical leave informed',
    },
  ],
};

const MOCK_ACADEMICS = {
  courses: [
    { courseCode: 'MATH101', courseName: 'Advanced Mathematics', facultyName: 'Dr. Rao' },
    { courseCode: 'SCI102', courseName: 'Integrated Science', facultyName: 'Prof. Mehta' },
  ],
  timetable: [],
  homeworkService: {
    status: 'NOT_CONFIGURED' as const,
    message: 'The digital homework and assignment module is pending school term deployment.',
  },
};

const MOCK_EXAMINATIONS = {
  publishedResults: [
    {
      scheduleId: 'sch_01',
      examName: 'Midterm 2026',
      courseCode: 'MATH101',
      courseName: 'Advanced Mathematics',
      marksObtained: 92,
      maxMarks: 100,
      grade: 'PASS',
      publishedDate: '2026-10-15',
    },
  ],
  upcomingExams: [
    {
      examName: 'Final Board Exam',
      courseName: 'Integrated Science',
      date: '2026-12-05',
      time: '09:00',
    },
  ],
};

const MOCK_FEES = {
  summary: {
    totalBilled: 5000000,
    totalPaid: 2500000,
    totalOutstanding: 2500000,
    currency: 'INR',
  },
  dues: [
    {
      id: 'due_01',
      dueNumber: 'DUE-2026-001',
      title: 'Term 2 Tuition Fee',
      dueDate: '2026-11-30',
      netAmount: 2500000,
      paidAmount: 0,
      balanceAmount: 2500000,
      status: 'UNPAID',
    },
  ],
  receipts: [
    {
      receiptNumber: 'RCP-2026-001',
      receiptDate: '2026-07-15',
      amount: 2500000,
      paymentMode: 'BANK_TRANSFER',
      status: 'POSTED',
    },
  ],
};

function setupParentBackend() {
  const b = createFakeBackend({ session: true, me: PARENT_ME });
  b.state.parent.children = MOCK_CHILDREN;
  b.state.parent.summary = MOCK_SUMMARY;
  b.state.parent.attendance = MOCK_ATTENDANCE;
  b.state.parent.academics = MOCK_ACADEMICS;
  b.state.parent.examinations = MOCK_EXAMINATIONS;
  b.state.parent.fees = MOCK_FEES;
  return b;
}

describe('Parent Portal Component, Navigation & Security Isolation', () => {
  it('renders child switcher, active child profile and summary overview', async () => {
    const b = setupParentBackend();
    renderApp(b, '/parent');

    // Header banner
    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument();
    expect(screen.getByText(/Admission #ADM-2024-001/)).toBeInTheDocument();
    expect(screen.getByText(/Grade 9-A/)).toBeInTheDocument();

    // Segmented Navigation tabs
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attendance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Academics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Examinations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fees & Payments' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Family Profile' })).toBeInTheDocument();

    // Summary KPIs
    expect(await screen.findByText('94%')).toBeInTheDocument();
    expect(screen.getByText('Attendance Rate')).toBeInTheDocument();
    expect(screen.getAllByText('₹25,000').length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to Attendance tab and displays session logs with status badges', async () => {
    const user = userEvent.setup();
    const b = setupParentBackend();
    renderApp(b, '/parent');

    const attTab = await screen.findByRole('button', { name: 'Attendance' });
    await user.click(attTab);

    // Attendance stats
    expect(await screen.findByText('Overall Attendance')).toBeInTheDocument();
    expect(screen.getByText('Conducted Sessions')).toBeInTheDocument();

    // Session log rows
    expect(screen.getByText('Period 1 (08:30)')).toBeInTheDocument();
    expect(screen.getByText('Medical leave informed')).toBeInTheDocument();
  });

  it('navigates to Academics tab and shows enrolled subjects with term notice', async () => {
    const user = userEvent.setup();
    const b = setupParentBackend();
    renderApp(b, '/parent');

    const acadTab = await screen.findByRole('button', { name: 'Academics' });
    await user.click(acadTab);

    expect(await screen.findByText('Enrolled Subjects & Faculty')).toBeInTheDocument();
    expect(screen.getByText('Advanced Mathematics')).toBeInTheDocument();
    expect(screen.getByText('Dr. Rao')).toBeInTheDocument();
    expect(
      screen.getByText(/The digital homework and assignment module is pending/),
    ).toBeInTheDocument();
  });

  it('navigates to Examinations tab and displays strictly published results', async () => {
    const user = userEvent.setup();
    const b = setupParentBackend();
    renderApp(b, '/parent');

    const examTab = await screen.findByRole('button', { name: 'Examinations' });
    await user.click(examTab);

    expect(await screen.findByText('Official Published Results')).toBeInTheDocument();
    expect(screen.getByText('MATH101')).toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('Final Board Exam')).toBeInTheDocument();
  });

  it('navigates to Fees tab, shows dues ledger, and opens sandbox payment simulation', async () => {
    const user = userEvent.setup();
    const b = setupParentBackend();
    renderApp(b, '/parent');

    const feesTab = await screen.findByRole('button', { name: 'Fees & Payments' });
    await user.click(feesTab);

    expect(await screen.findByText('Fee Dues Ledger')).toBeInTheDocument();
    expect(screen.getByText('DUE-2026-001')).toBeInTheDocument();

    // Open sandbox payment modal
    const payBtn = screen.getByRole('button', { name: 'Pay Outstanding Balance' });
    await user.click(payBtn);

    expect(await screen.findByText('Secure Fee Payment')).toBeInTheDocument();
    expect(screen.getByText('Simulate Payment')).toBeInTheDocument();
  });

  it('has zero detectable axe accessibility violations', async () => {
    const b = setupParentBackend();
    const { container } = renderApp(b, '/parent');
    await screen.findByText('Aarav Sharma');

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
