import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const REPORT_ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u-admin',
  actor_kind: 'STAFF',
  display_name: 'Arthur Admin',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'student.directory.list',
    'attendance.record.read',
    'result.read',
    'fee.receipt.read',
  ],
};

describe('Executive & Administrative Reports Page', () => {
  it('renders student enrolment roster by default and passes axe a11y audit', async () => {
    const backend = createFakeBackend({ me: REPORT_ADMIN, session: true });
    const { container } = renderApp(backend, '/reports');

    expect(await screen.findByRole('heading', { name: 'Executive & Administrative Reports' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Student Enrolment Roster' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Daily Attendance Summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Examination Results Summary' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fee Collections & Dues' })).toBeInTheDocument();

    // Roster summary stats
    expect(await screen.findByText('Total Enrolled Students')).toBeInTheDocument();
    expect(screen.getByText('Active Academic Students')).toBeInTheDocument();

    // Student roster table row
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument();
    expect(screen.getByText('ADM-001')).toBeInTheDocument();

    // Accessibility check
    expect((await axe(container)).violations).toEqual([]);
  });

  it('navigates across all report tabs and displays relevant analytics', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: REPORT_ADMIN, session: true });
    renderApp(backend, '/reports');

    expect(await screen.findByRole('heading', { name: 'Executive & Administrative Reports' })).toBeInTheDocument();

    // 1. Switch to Daily Attendance Summary
    const attendanceTab = screen.getByRole('button', { name: 'Daily Attendance Summary' });
    await user.click(attendanceTab);

    expect(await screen.findByText('Conducted Sessions')).toBeInTheDocument();
    expect(screen.getByText('Missing Registers')).toBeInTheDocument();
    expect(screen.getByText('Mathematics')).toBeInTheDocument();
    expect(screen.getByText('Vikram Teacher')).toBeInTheDocument();

    // 2. Switch to Examination Results Summary
    const examsTab = screen.getByRole('button', { name: 'Examination Results Summary' });
    await user.click(examsTab);

    expect(await screen.findByText('Published Schedules')).toBeInTheDocument();
    expect(screen.getByText('Overall Pass Rate')).toBeInTheDocument();
    expect(screen.getByText('Mid-Term 2026')).toBeInTheDocument();
    expect(screen.getByText('MATH101')).toBeInTheDocument();

    // 3. Switch to Fee Collections & Dues
    const feesTab = screen.getByRole('button', { name: 'Fee Collections & Dues' });
    await user.click(feesTab);

    expect(await screen.findByText('Confirmed Collections')).toBeInTheDocument();
    expect(screen.getByText('In Clearing (Unverified)')).toBeInTheDocument();
    expect(screen.getByText('Total Outstanding Dues')).toBeInTheDocument();
    expect(screen.getByText('DUE-2026-10001')).toBeInTheDocument();
    expect(screen.getByText('No In-Flight Ref')).toBeInTheDocument();
  });

  it('triggers CSV export without crashing', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: REPORT_ADMIN, session: true });

    // Mock createObjectURL and revokeObjectURL
    const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    const mockRevokeObjectURL = vi.fn();
    window.URL.createObjectURL = mockCreateObjectURL;
    window.URL.revokeObjectURL = mockRevokeObjectURL;

    renderApp(backend, '/reports');

    expect(await screen.findByRole('heading', { name: 'Executive & Administrative Reports' })).toBeInTheDocument();

    const exportBtn = screen.getByRole('button', { name: /Export CSV/i });
    await user.click(exportBtn);

    await waitFor(() => {
      expect(mockCreateObjectURL).toHaveBeenCalled();
    });
  });
});
