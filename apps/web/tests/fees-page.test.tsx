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
    'fee.gateway.read',
    'fee.gateway.manage',
    'fee.payment.initiate',
    'fee.refund.initiate',
  ],
};

const FINANCE_STUDENT: MeData = {
  tenant_id: 't1',
  user_id: 'st-1',
  actor_kind: 'STUDENT',
  display_name: 'Asha Student',
  roles: ['STUDENT'],
  capabilities: [
    'session.read',
    'session.revoke',
    'fee.dues.read',
    'fee.receipt.read',
    'fee.payment.initiate',
  ],
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

  backend.state.finance.gatewayConfigs = [
    {
      id: 'gw-1',
      organization_id: 't1',
      campus_id: null,
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      is_active: true,
      merchant_key_masked: 'rzp_••••••••1234',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  backend.state.finance.paymentAttempts = [
    {
      id: 'att-1',
      organization_id: 't1',
      campus_id: 'camp-1',
      student_id: 'st-1',
      student_name: 'Asha Student',
      admission_number: 'ADM-2026-001',
      student_due_id: 'due-1',
      attempt_reference: 'att_test_1001',
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      amount: 2500000,
      currency: 'INR',
      order_reference: 'order_rzp_1001',
      gateway_payment_ref: 'pay_rzp_1001',
      status: 'SUCCESS',
      failure_reason: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
    expect(screen.getByRole('button', { name: /Online Payments/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Offline Payments' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Receipts & Reversals/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gateway Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconciliation' })).toBeInTheDocument();

    // Verify Overview KPI stat cards
    expect(await screen.findByText('Total Collections')).toBeInTheDocument();
    expect(screen.getByText('Active Online Gateways')).toBeInTheDocument();
    expect(screen.getByText('Online Transactions')).toBeInTheDocument();
    expect(screen.getByText('Reversals / Refunds')).toBeInTheDocument();

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

    expect(await screen.findByText(/B\.Tech Engineering Semester 1 Fee/)).toBeInTheDocument();

    // Open Create Structure dialog
    const newStructBtn = screen.getByRole('button', { name: '+ New Fee Structure' });
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

    // Verify generate dues batch button exists
    expect(screen.getByRole('button', { name: '+ Generate Dues Batch' })).toBeInTheDocument();
  });

  it('allows staff to navigate to Offline Payments and record payment receipt', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Switch to Offline Payments tab
    const offlineTab = await screen.findByRole('button', { name: 'Offline Payments' });
    await user.click(offlineTab);

    expect(await screen.findByText('Record Offline Fee Collection')).toBeInTheDocument();

    // Fill in offline payment form
    const studentInput = screen.getByLabelText(/Student ID \/ Selection/);
    const amountInput = screen.getByLabelText(/Amount \(₹\)/);

    await user.clear(studentInput);
    await user.type(studentInput, 'st-1');

    await user.clear(amountInput);
    await user.type(amountInput, '5000.00');

    // Submit form
    const submitBtn = screen.getByRole('button', { name: 'Generate Fee Receipt' });
    await user.click(submitBtn);

    expect(
      await screen.findByText('Offline fee payment receipt recorded successfully.'),
    ).toBeInTheDocument();
  });

  it('allows admin to configure payment gateway settings and test connection', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_ADMIN, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Switch to Gateway Settings tab
    const gwTab = await screen.findByRole('button', { name: 'Gateway Settings' });
    await user.click(gwTab);

    expect(await screen.findByText('School Merchant Payment Gateway Setup')).toBeInTheDocument();

    // Fill in gateway credentials
    const keyInput = screen.getByLabelText(/Key ID/);
    const secretInput = screen.getByLabelText(/Secret Key/);

    await user.type(keyInput, 'rzp_test_new_123');
    await user.type(secretInput, 'secret_pass_xyz');

    // Click Test Connection
    const testBtn = screen.getByRole('button', { name: 'Test Connection' });
    await user.click(testBtn);

    expect(await screen.findByText(/Successfully connected to RAZORPAY API/)).toBeInTheDocument();

    // Click Save Config
    const saveBtn = screen.getByRole('button', { name: 'Save & Encrypt Gateway Config' });
    await user.click(saveBtn);

    expect(
      await screen.findByText('Payment gateway RAZORPAY configured successfully.'),
    ).toBeInTheDocument();
  });

  it('allows student to view their own fee ledger and initiate online payment', async () => {
    const user = userEvent.setup();
    const backend = createFakeBackend({ me: FINANCE_STUDENT, session: true });
    setupFinanceState(backend);

    renderApp(backend, '/fees');

    // Student only sees "My Fee Ledger"
    expect(await screen.findByRole('heading', { name: 'My Fee Ledger' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Overview & Collections' }),
    ).not.toBeInTheDocument();

    // Verify ledger cards
    expect(await screen.findByText('Total Assessed Fees')).toBeInTheDocument();
    expect(screen.getByText('Total Paid')).toBeInTheDocument();
    expect(screen.getByText('Outstanding Balance')).toBeInTheDocument();

    // Verify student dues and Pay Online button
    expect(await screen.findByText(/DUE-2026-10001/)).toBeInTheDocument();
    expect(screen.getByText('B.Tech Engineering Semester 1 Fee')).toBeInTheDocument();

    const payOnlineBtn = screen.getByRole('button', { name: 'Pay Online' });
    await user.click(payOnlineBtn);

    // Dialog opens with payment prompt
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pay School Fees Online' })).toBeInTheDocument();

    // Click proceed to checkout
    const checkoutBtn = screen.getByRole('button', { name: 'Proceed to Gateway Checkout' });
    await user.click(checkoutBtn);

    // Gateway simulation view appears
    expect(await screen.findByText(/Online payment session initiated via/)).toBeInTheDocument();

    // Simulate completion
    const simulateSuccessBtn = screen.getByRole('button', {
      name: 'Simulate Gateway Payment Success',
    });
    await user.click(simulateSuccessBtn);

    expect(
      await screen.findByText(/Payment completed and verified! Receipt REC-/),
    ).toBeInTheDocument();
  });
});
