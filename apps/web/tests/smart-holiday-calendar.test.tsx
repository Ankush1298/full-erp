import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ACADEMIC_ADMIN, ACADEMIC_READER, createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('Smart Annual Holiday Calendar (Indian Schools & Bihar State)', () => {
  let b: ReturnType<typeof createFakeBackend>;

  async function openTab(name: string) {
    await userEvent.click(await screen.findByRole('button', { name }));
  }

  beforeEach(() => {
    b = createFakeBackend({ session: true, me: ACADEMIC_ADMIN });
    b.state.academics.years = [
      {
        id: 'year-2026-2027',
        label: '2026–2027',
        startDate: '2026-04-01',
        endDate: '2027-03-31',
        status: 'ACTIVE',
        version: 1,
      },
    ];
  });

  it('renders annual holiday suggestions button and loads catalogue for academic year spanning two calendar years', async () => {
    renderApp(b, '/academics');
    await openTab('Holidays');

    // Toggle button should be visible to managers
    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    expect(toggleBtn).toBeInTheDocument();
    await userEvent.click(toggleBtn);

    // Smart holiday panel should now be visible
    expect(
      screen.getByRole('heading', {
        name: 'Annual Holiday Suggestions (Official Catalogue)',
        level: 3,
      }),
    ).toBeInTheDocument();

    // Verify configuration fields: Country, State, Academic Year, Scope
    expect(screen.getByLabelText('Country')).toHaveValue('IN');
    expect(screen.getByLabelText('State / School Calendar')).toHaveValue('BR');
    await screen.findByRole('option', { name: /2026–2027/i });
    expect(screen.getByLabelText('Academic Year')).toHaveValue('year-2026-2027');

    // Load suggestions
    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    // Suggestions table rendered
    const table = await screen.findByRole('table', { name: 'Suggested annual holidays' });
    expect(table).toBeInTheDocument();

    // Verify suggestions contain both 2026 and 2027 entries spanning the academic year
    expect(within(table).getByDisplayValue('Independence Day')).toBeInTheDocument();
    expect(within(table).getByDisplayValue('Mahatma Gandhi Jayanti')).toBeInTheDocument();
    expect(within(table).getByDisplayValue('Chhath Puja (Evening Arghya)')).toBeInTheDocument();
    expect(within(table).getByDisplayValue('Republic Day')).toBeInTheDocument();
    expect(within(table).getByDisplayValue('Bihar Diwas (Bihar Day)')).toBeInTheDocument();

    // Verify verification statuses
    expect(within(table).getAllByText('Verified').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Provisional').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Unverified').length).toBeGreaterThan(0);
  });

  it('allows editing date, name and kind before bulk approval and saves in one atomic action', async () => {
    renderApp(b, '/academics');
    await openTab('Holidays');

    // Open smart holiday workflow
    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    await userEvent.click(toggleBtn);

    // Load suggestions
    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    const table = await screen.findByRole('table', { name: 'Suggested annual holidays' });

    // Deselect all
    const deselectBtn = screen.getByRole('button', { name: 'Deselect all' });
    await userEvent.click(deselectBtn);

    // Select and edit only Republic Day
    const repCheckbox = within(table).getByRole('checkbox', { name: 'Select Republic Day' });
    await userEvent.click(repCheckbox);
    expect(repCheckbox).toBeChecked();

    const nameInput = within(table).getByDisplayValue('Republic Day');
    fireEvent.change(nameInput, { target: { value: 'Republic Day Celebrations' } });

    // Click Approve and Save
    const approveBtn = screen.getByRole('button', { name: /Approve and Save 1 Holidays/i });
    expect(approveBtn).toBeEnabled();
    await userEvent.click(approveBtn);

    // Feedback message shown
    expect(
      await screen.findByText(/Successfully approved and saved 1 holidays/i),
    ).toBeInTheDocument();

    // Verify backend received bulk call with edited name
    const bulkCalls = b.callsTo('POST', '/academics/holidays/bulk');
    expect(bulkCalls).toHaveLength(1);
    expect(bulkCalls[0]?.body).toMatchObject({
      holidays: [
        {
          holidayDate: '2027-01-26',
          name: 'Republic Day Celebrations',
          kind: 'HOLIDAY',
        },
      ],
      reason: 'Annual Indian school holiday calendar approval',
    });

    // Main holidays table reloaded with newly declared holiday
    const mainTable = screen.getByRole('table', { name: 'Holidays' });
    expect(within(mainTable).getByText('Republic Day Celebrations')).toBeInTheDocument();
  });

  it('detects already declared holidays, shows status badges and prevents duplicate re-import', async () => {
    // Pre-declare Gandhi Jayanti
    b.state.academics.holidays = [
      {
        id: 'h-1',
        campusId: null,
        holidayDate: '2026-10-02',
        name: 'Mahatma Gandhi Jayanti',
        kind: 'HOLIDAY',
        status: 'ACTIVE',
        version: 1,
      },
    ];

    renderApp(b, '/academics');
    await openTab('Holidays');

    // Open smart holiday workflow
    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    await userEvent.click(toggleBtn);

    // Load suggestions
    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    const table = await screen.findByRole('table', { name: 'Suggested annual holidays' });

    // Mahatma Gandhi Jayanti row should be disabled and show "Already Declared" badge
    const gandhiRow = within(table).getByDisplayValue('Mahatma Gandhi Jayanti').closest('tr')!;
    expect(within(gandhiRow).getByText('Already Declared')).toBeInTheDocument();

    const gandhiCheckbox = within(gandhiRow).getByRole('checkbox');
    expect(gandhiCheckbox).toBeDisabled();
    expect(gandhiCheckbox).not.toBeChecked();

    // Summary counts should reflect already declared item
    expect(screen.getByText('Already Declared: 1')).toBeInTheDocument();
  });

  it('hides smart holiday tools from read-only viewers without academic.term.manage', async () => {
    const readerB = createFakeBackend({ session: true, me: ACADEMIC_READER });
    renderApp(readerB, '/academics');
    await openTab('Holidays');

    // Smart holiday loader button must not be rendered
    expect(
      screen.queryByRole('button', {
        name: /Load Annual Holiday Calendar/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('approves a verified-only selection directly without provisional confirmation', async () => {
    renderApp(b, '/academics');
    await openTab('Holidays');

    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    await userEvent.click(toggleBtn);

    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    // Click 'Select verified only'
    const selectVerifiedBtn = screen.getByRole('button', { name: 'Select verified only' });
    await userEvent.click(selectVerifiedBtn);

    // Confirmation checkbox should NOT be present when only verified holidays are selected
    expect(
      screen.queryByLabelText(/Confirm inclusion of provisional or unverified holidays/i),
    ).not.toBeInTheDocument();

    // Click Approve
    const approveBtn = screen.getByRole('button', { name: /Approve and Save/i });
    await userEvent.click(approveBtn);

    expect(
      await screen.findByText(/Successfully approved and saved/i),
    ).toBeInTheDocument();
  });

  it('requires explicit confirmation for mixed selection including provisional holidays', async () => {
    renderApp(b, '/academics');
    await openTab('Holidays');

    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    await userEvent.click(toggleBtn);

    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    // Select all unimported (includes provisional entries)
    const selectAllBtn = screen.getByRole('button', { name: 'Select all unimported' });
    await userEvent.click(selectAllBtn);

    // Provisional confirmation checkbox should be visible
    const confirmCheckbox = screen.getByLabelText(/Confirm inclusion of provisional or unverified holidays/i);
    expect(confirmCheckbox).toBeInTheDocument();
    expect(confirmCheckbox).not.toBeChecked();

    // Attempting to approve without checking displays validation notice
    const approveBtn = screen.getByRole('button', { name: /Approve and Save/i });
    await userEvent.click(approveBtn);

    expect(
      await screen.findByText(/Please confirm their inclusion before proceeding/i),
    ).toBeInTheDocument();

    // Check confirmation and approve
    await userEvent.click(confirmCheckbox);
    expect(confirmCheckbox).toBeChecked();

    await userEvent.click(approveBtn);
    expect(
      await screen.findByText(/Successfully approved and saved/i),
    ).toBeInTheDocument();
  });

  it('displays actionable validation error message instead of generic API validation (400)', async () => {
    // Override fetch to return HTTP 400 on bulk create
    const originalFetch = b.fetch;
    b.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/academics/holidays/bulk') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid holiday date format.',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    };

    renderApp(b, '/academics');
    await openTab('Holidays');

    const toggleBtn = await screen.findByRole('button', {
      name: /Load Annual Holiday Calendar \(India \/ Bihar\)/i,
    });
    await userEvent.click(toggleBtn);

    const loadBtn = screen.getByRole('button', { name: 'Load Suggested Holidays' });
    await userEvent.click(loadBtn);

    const selectVerifiedBtn = screen.getByRole('button', { name: 'Select verified only' });
    await userEvent.click(selectVerifiedBtn);

    const approveBtn = screen.getByRole('button', { name: /Approve and Save/i });
    await userEvent.click(approveBtn);

    // Must show helpful message, not "API validation (400)"
    expect(
      await screen.findByText(/Some holiday details could not be validated/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/API validation \(400\)/i)).not.toBeInTheDocument();
  });
});
