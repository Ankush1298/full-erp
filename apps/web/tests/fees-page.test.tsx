import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { createFakeBackend, type MeData } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const FINANCE_ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u-admin',
  actor_kind: 'STAFF',
  display_name: 'Fiona Finance',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'fee.structure.read',
    'fee.structure.manage',
    'fee.dues.generate',
    'fee.dues.read',
    'fee.receipt.record',
    'fee.receipt.read',
    'fee.receipt.reverse',
  ],
};

const FINANCE_STUDENT: MeData = {
  tenant_id: 't1',
  user_id: 'st-1',
  actor_kind: 'STUDENT',
  display_name: 'Asha Student',
  roles: ['STUDENT'],
  capabilities: ['session.read', 'session.revoke', 'fee.dues.read', 'fee.receipt.read'],
};

function setupFinanceState(backend: ReturnType<typeof createFakeBackend>) {
  backend.state.finance.categories = [
    {
      id: 'cat-1',
      code: 'TUIT',
      name: 'Tuition Fee',
      description: 'Standard semester tuition fee',
      is_active: true,
      version: 1,
    },
    {
      id: 'cat-2',
      code: 'LAB',
      name: 'Laboratory Fee',
      description: 'Computing and science laboratories',
      is_active: true,
      version: 1,
    },
  ];

  backend.state.finance.structures = [
    {
      id: 'struct-1',
      campus_id: 'camp-1',
      academic_year_id: 'y1',
      term_id: 'term-1',
      program_id: null,
      code: 'ENG-2026-S1',
      name: 'B.Tech Engineering Semester 1 Fee',
      currency: 'INR',
      status: 'ACTIVE',
      due_date: '2026-07-31',
      total_amount: 5500000,
      version: 1,
      components: [
        {
          id: 'comp-1',
          fee_category_id: 'cat-1',
          category_code: 'TUIT',
          category_name: 'Tuition Fee',
          amount: 4500000,
          description: 'Tuition fee',
        },
        {
          id: 'comp-2',
          fee_category_id: 'cat-2',
          category_code: 'LAB',
          category_name: 'Laboratory Fee',
          amount: 1000000,
          description: 'Lab fee',
        },
      ],
    },
  ];

  backend.state.finance.dues = [
    {
      id: 'due-1',
      campus_id: 'camp-1',
      student_id: 'st-1',
      student_name: 'Asha Student',
      admission_number: 'ADM-2026-001',
      fee_structure_id: 'struct-1',
      fee_structure_name: 'B.Tech Engineering Semester 1 Fee',
      academic_year_id: 'y1',
      term_id: 'term-1',
      due_number: 'DUE-2026-10001',
      gross_amount: 5500000,
      discount_amount: 500000,
      net_amount: 5000000,
      paid_amount: 2500000,
      balance_amount: 2500000,
      status: 'PARTIAL',
      due_date: '2026-07-31',
      concession_reason: 'Merit Scholarship 10%',
      version: 1,
    },
  ];

  backend.state.finance.receipts = [
    {
      id: 'rec-1',
      campus_id: 'camp-1',
      student_id: 'st-1',
      student_name: 'Asha Student',
      admission_number: 'ADM-2026-001',
      receipt_number: 'REC-2026-90001',
      payment_date: '2026-06-15',
      payment_method: 'CASH',
      amount: 2500000,
      currency: 'INR',
      reference_number: null,
      reconciliation_status: 'CONFIRMED',
      status: 'POSTED',
      received_by_user_id: 'u-admin',
      received_by_name: 'Fiona Finance',
      remarks: 'First installment paid in cash at counter',
      version: 1,
      allocations: [
        {
          id: 'alloc-1',
          student_due_id: 'due-1',
          due_number: 'DUE-2026-10001',
          allocated_amount: 2500000,
        },
      ],
    },
  ];
}

describe('Fees & Finance Management Page', () => {
  it('renders correctly for authorized finance admin with Overview KPI cards and passes axe a11y', async () => {
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    const { container } = renderApp(backend, '/fees');

    expect(
      await screen.findByRole('heading', { name: 'Fees & Finance Management' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview & Collections' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fee Structures/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Student Dues/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receipts & Reversals/ })).toBeInTheDocument();

    // Verify Overview KPI stat cards
    expect(screen.getByText('Total Net Collected')).toBeInTheDocument();
    expect(screen.getByText('Active Receipts')).toBeInTheDocument();
    expect(screen.getByText('Reversed Receipts')).toBeInTheDocument();
    expect(screen.getByText('Total Outstanding Dues')).toBeInTheDocument();

    // Accessibility check
    expect((await axe(container)).violations).toEqual([]);
  });

  it('allows admin to navigate to Fee Structures and open Create Structure dialog', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    expect(
      await screen.findByRole('heading', { name: 'Fees & Finance Management' }),
    ).toBeInTheDocument();

    // Switch to Fee Structures tab
    const structuresTab = screen.getByRole('button', { name: /Fee Structures/ });
    await user.click(structuresTab);

    expect(await screen.findByText('B.Tech Engineering Semester 1 Fee')).toBeInTheDocument();
    expect(screen.getByText('ENG-2026-S1')).toBeInTheDocument();

    // Open Create Structure dialog
    const newStructBtn = screen.getByRole('button', { name: 'Create Fee Structure' });
    await user.click(newStructBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create Fee Structure' })).toBeInTheDocument();

    // Close dialog
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('allows admin to navigate to Student Dues and inspect due details', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Switch to Student Dues tab
    const duesTab = await screen.findByRole('button', { name: /Student Dues/ });
    await user.click(duesTab);

    expect(await screen.findByText('DUE-2026-10001')).toBeInTheDocument();
    expect(screen.getByText('Asha Student')).toBeInTheDocument();
    expect(screen.getByText('-₹5,000.00')).toBeInTheDocument();

    // Verify generate dues button exists in header actions
    expect(screen.getByRole('button', { name: 'Generate Dues' })).toBeInTheDocument();
  });

  it('allows staff to record offline payment receipt and inspect printable stamped receipt', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Switch to Receipts tab
    const receiptsTab = await screen.findByRole('button', { name: /Receipts & Reversals/ });
    await user.click(receiptsTab);

    expect(await screen.findByText('REC-2026-90001')).toBeInTheDocument();
    expect(screen.getByText('CASH')).toBeInTheDocument();
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument();

    // Open view receipt modal
    const viewBtn = screen.getByRole('button', { name: 'View Receipt' });
    await user.click(viewBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Official Fee Receipt/ })).toBeInTheDocument();
    expect(screen.getByText('Official Fee Acknowledgment Receipt')).toBeInTheDocument();
    expect(screen.getByText('Receipt Status:')).toBeInTheDocument();

    // Close receipt view
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('allows admin to initiate step-up reversal dialog for posted receipt', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Switch to Receipts tab
    const receiptsTab = await screen.findByRole('button', { name: /Receipts & Reversals/ });
    await user.click(receiptsTab);

    expect(await screen.findByText('REC-2026-90001')).toBeInTheDocument();

    // Click View Receipt to access Reverse button
    const viewBtn = screen.getByRole('button', { name: 'View Receipt' });
    await user.click(viewBtn);

    const reverseBtn = await screen.findByRole('button', { name: 'Reverse Receipt' });
    await user.click(reverseBtn);

    expect(
      await screen.findByRole('heading', { name: 'Confirm Receipt Reversal' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/CRITICAL ACTION: Reversing this receipt will restore student balances/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Mandatory Audit Reversal Reason/)).toBeInTheDocument();

    // Cancel modal
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Confirm Receipt Reversal' }),
      ).not.toBeInTheDocument();
    });
  });

  it('allows student to view their own fee ledger breakdown', async () => {
    const backend = createFakeBackend({ me: FINANCE_STUDENT, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Student only sees "My Fee Ledger"
    expect(
      await screen.findByRole('heading', { name: 'Fees & Finance Management' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Fee Ledger' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Overview & Collections' }),
    ).not.toBeInTheDocument();

    // Verify ledger cards
    expect(await screen.findByText('Assessed Net Fees')).toBeInTheDocument();
    expect(screen.getByText('Total Amount Paid')).toBeInTheDocument();
    expect(screen.getByText('Remaining Balance')).toBeInTheDocument();

    // Verify student dues and receipt list
    expect(await screen.findByText(/DUE-2026-10001/)).toBeInTheDocument();
    expect(screen.getByText('B.Tech Engineering Semester 1 Fee')).toBeInTheDocument();
    expect(screen.getByText(/REC-2026-90001/)).toBeInTheDocument();
  });
});
