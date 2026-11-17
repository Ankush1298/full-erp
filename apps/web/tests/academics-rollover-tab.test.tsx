import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ACADEMIC_ADMIN, ACADEMIC_READER, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('Academics page: Promotion & Rollover tab', () => {
  it('renders the Rollover tab button for academic managers and readers', async () => {
    const staff = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    renderApp(staff, '/academics');
    const tab = await screen.findByRole('button', { name: /Rollover/ });
    expect(tab).toBeInTheDocument();
  });

  it('navigates to Rollover tab, displays policy summary and generates rollover preview', async () => {
    const staff = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    // Add target term to fake backend
    staff.state.academics.terms.push({
      id: 't2',
      campusId: 'camp-1',
      academicYearId: 'y1',
      code: 'EVEN',
      name: 'Even semester',
      startDate: '2027-01-01',
      endDate: '2027-05-31',
      status: 'PLANNED',
      version: 1,
    });
    (staff.state.academics.terms[0] as { status: string }).status = 'ACTIVE';

    renderApp(staff, '/academics');
    const tab = await screen.findByRole('button', { name: /Rollover/ });
    await userEvent.click(tab);

    expect(await screen.findByText('Promotion & Rollover Policy')).toBeInTheDocument();
    expect(screen.getByText('Annual Session Rollover Workbench')).toBeInTheDocument();

    // Verify policy summary details (both min aggregate and min subject are 35%)
    expect(screen.getAllByText('35%').length).toBeGreaterThanOrEqual(1);

    // Generate Preview
    const generateBtn = screen.getByRole('button', { name: 'Generate Promotion Preview' });
    expect(generateBtn).toBeInTheDocument();
    await userEvent.click(generateBtn);

    // Verify preview results render
    expect(await screen.findByText(/Rollover Batch Preview:/)).toBeInTheDocument();

    expect(screen.getByText('Asha Student')).toBeInTheDocument();
    expect(screen.getByText('ADM-001')).toBeInTheDocument();

    // Verify KPI cards rendered
    expect(screen.getByText('Promoted Students')).toBeInTheDocument();
  });

  it('allows Principal approval and batch execution workflow', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const staff = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    staff.state.academics.terms.push({
      id: 't2',
      campusId: 'camp-1',
      academicYearId: 'y1',
      code: 'EVEN',
      name: 'Even semester',
      startDate: '2027-01-01',
      endDate: '2027-05-31',
      status: 'PLANNED',
      version: 1,
    });
    (staff.state.academics.terms[0] as { status: string }).status = 'ACTIVE';

    renderApp(staff, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: /Rollover/ }));

    // Wait for initial data load
    expect(await screen.findByText('Promotion & Rollover Policy')).toBeInTheDocument();

    // Generate preview
    await userEvent.click(screen.getByRole('button', { name: 'Generate Promotion Preview' }));
    await screen.findByText(/Rollover Batch Preview:/);

    // Approve Preview (Principal approval)
    const approveBtn = screen.getByRole('button', { name: 'Approve Preview (Principal)' });
    expect(approveBtn).toBeInTheDocument();
    await userEvent.click(approveBtn);

    // Execute button should now be enabled
    const executeBtn = screen.getByRole('button', { name: 'Execute Rollover & Advance Students' });
    expect(executeBtn).toBeInTheDocument();
    await waitFor(() => {
      expect(executeBtn).not.toBeDisabled();
    });
    await userEvent.click(executeBtn);

    await waitFor(() => {
      expect(screen.getByText(/Session Rollover successfully executed!/)).toBeInTheDocument();
    });
  });

  it('read-only readers cannot edit policy or execute rollover', async () => {
    const reader = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(reader, '/academics');
    await userEvent.click(await screen.findByRole('button', { name: /Rollover/ }));

    expect(await screen.findByText('Promotion & Rollover Policy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate Promotion Preview' })).not.toBeInTheDocument();
  });
});
