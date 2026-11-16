import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const VALID_TOKEN = 'aB3_dE5-gH7_jK9-mN1_pQ3-sT5_vW7-yZ9_bC1-eF3';
const PW = /* secret-scan:allow */ 'CorrectPassword123!';

describe('Self-Service MFA Onboarding & Lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Stub clipboard
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
  });

  it('Flow 1: Teacher accepts invitation, sets password, signs in, configures MFA, saves recovery codes, and enters dashboard', async () => {
    const b = createFakeBackend();
    b.state.session = false;
    const user = userEvent.setup();

    // 1. Teacher opens accept invitation page with token
    renderApp(b, `/accept-invite?token=${VALID_TOKEN}&email=teacher%40school.test`); // secret-scan:allow

    expect(await screen.findByRole('heading', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(screen.getByText(/teacher@school\.test/)).toBeInTheDocument();

    // 2. Teacher sets password
    await user.type(screen.getByLabelText('New password'), PW);
    await user.type(screen.getByLabelText('Confirm password'), PW);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    // 3. Sees success and clicks proceed to sign in & MFA setup
    expect(await screen.findByRole('heading', { name: 'Invitation accepted' })).toBeInTheDocument();
    const proceedLink = screen.getByRole('link', { name: /Sign in to your account/i });
    expect(proceedLink).toBeInTheDocument();

    // 4. Configure backend to simulate invited user with MFA required on first sign-in
    b.state.mfa.required = true;
    b.state.mfa.enrolled = false;
    b.state.mfa.sessionVerified = false;

    await user.click(proceedLink);

    // 5. Sign in
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'teacher@school.test');
    await user.type(screen.getByLabelText('Password'), PW);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // 6. User is directed to MFA setup modal
    expect(
      await screen.findByRole('heading', { name: 'Set Up Two-Factor Authentication' }),
    ).toBeInTheDocument();

    // 7. Click Begin Setup
    await user.click(screen.getByRole('button', { name: 'Begin Setup' }));

    // 8. Step 'scan': QR code, instructions, secret key, and copy button are displayed
    expect(
      await screen.findByRole('heading', { name: 'Configure Authenticator App' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Google Authenticator/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Copy key/i })).toBeInTheDocument();

    // Click copy key
    await user.click(screen.getByRole('button', { name: /Copy key/i }));
    expect(await screen.findByText('Copied key!')).toBeInTheDocument();

    // 9. Enter 6-digit verification code
    const codeInput = screen.getByLabelText('6-Digit Verification Code');
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm Setup' }));

    // 10. Step 'codes': Emergency recovery codes displayed
    expect(
      await screen.findByRole('heading', { name: 'Emergency Recovery Codes' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1111-2222-33')).toBeInTheDocument();

    // Copy all recovery codes
    const copyCodesBtn = screen.getByRole('button', { name: /Copy all recovery codes/i });
    await user.click(copyCodesBtn);
    expect(await screen.findByText('Codes copied!')).toBeInTheDocument();

    // Check the confirmation checkbox
    const confirmCheckbox = screen.getByRole('checkbox', {
      name: /I have safely saved these recovery codes/i,
    });
    expect(confirmCheckbox).not.toBeChecked();
    await user.click(confirmCheckbox);
    expect(confirmCheckbox).toBeChecked();

    // 11. Complete onboarding and enter dashboard
    const doneBtn = screen.getByRole('button', { name: 'I have saved my recovery codes' });
    await user.click(doneBtn);
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Emergency Recovery Codes' }),
      ).not.toBeInTheDocument();
    });
  });

  it('Flow 2: Subsequent sign-in requires TOTP verification, and allows emergency recovery code', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();

    // Simulate user who is already enrolled in MFA
    b.state.mfa.enrolled = true;
    b.state.mfa.required = true;
    b.state.mfa.sessionVerified = false;

    renderApp(b, '/login');
    await user.type(await screen.findByLabelText('Email address'), 'teacher@school.test');
    await user.type(screen.getByLabelText('Password'), PW);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Prompted for Two-factor authentication challenge
    expect(
      await screen.findByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();

    // Switch to recovery code mode
    await user.click(screen.getByRole('button', { name: 'Use recovery code' }));
    expect(screen.getByLabelText('Recovery code')).toBeInTheDocument();

    // Enter recovery code
    await user.type(screen.getByLabelText('Recovery code'), '1111-2222-33');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    // Verification succeeds and user enters app
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Two-factor authentication' }),
      ).not.toBeInTheDocument();
    });
  });

  it('Flow 3: User who lost phone can access clear MFA recovery instructions', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();

    b.state.mfa.enrolled = true;
    b.state.mfa.required = true;
    b.state.mfa.sessionVerified = false;

    renderApp(b, '/login');
    await user.type(await screen.findByLabelText('Email address'), 'teacher@school.test');
    await user.type(screen.getByLabelText('Password'), PW);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: 'Two-factor authentication' }),
    ).toBeInTheDocument();

    // Click "Lost access to authenticator and recovery codes?"
    const helpBtn = screen.getByRole('button', {
      name: /Lost access to authenticator and recovery codes/i,
    });
    await user.click(helpBtn);

    expect(
      screen.getByText(
        /Contact your school administrator or Principal to request an account MFA reset/i,
      ),
    ).toBeInTheDocument();
  });

  it('Flow 4: School administrator views MFA status and can reset MFA for staff', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();

    // Logged in as College Admin / Principal with reset_mfa capability
    b.state.session = true;
    b.state.mfa.enrolled = true;
    b.state.mfa.sessionVerified = true;
    b.state.me = {
      tenant_id: 'org-school-1',
      user_id: 'principal-1',
      actor_kind: 'STAFF',
      display_name: 'Principal Sharma',
      roles: ['COLLEGE_ADMIN'],
      capabilities: [
        'user.account.read',
        'user.account.invite',
        'user.account.suspend',
        'user.account.reset_mfa',
      ],
    };

    // Populate mock user directory with a staff member who has MFA enrolled
    b.state.access.users = [
      {
        id: 'principal-1',
        email: 'principal@school.test',
        displayName: 'Principal Sharma',
        status: 'ACTIVE',
        version: 1,
        createdAt: '2026-09-01T08:00:00.000Z',
        mfaEnrolled: true,
      },
      {
        id: 'teacher-2',
        email: 'ramesh@school.test',
        displayName: 'Ramesh Teacher',
        status: 'ACTIVE',
        version: 1,
        createdAt: '2026-09-15T08:00:00.000Z',
        mfaEnrolled: true,
      },
    ];

    renderApp(b, '/users');

    // Verify user directory table displays MFA status
    expect(await screen.findByRole('heading', { name: 'User directory' })).toBeInTheDocument();
    expect(await screen.findByText('Ramesh Teacher')).toBeInTheDocument();

    // Click details for Ramesh
    const detailsBtn = screen.getByRole('button', {
      name: /View details for ramesh@school\.test/i,
    });
    await user.click(detailsBtn);

    expect(
      await screen.findByRole('heading', { name: 'Account details: Ramesh Teacher' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Issue MFA ticket' })).toBeInTheDocument();

    // Click Reset MFA
    await user.click(screen.getByRole('button', { name: 'Reset MFA' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Reset Multi-Factor Authentication: Ramesh Teacher',
      }),
    ).toBeInTheDocument();

    // Enter reason and submit
    await user.type(
      screen.getByLabelText('Reason for MFA reset'),
      'Teacher lost mobile phone during vacation',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm MFA reset' }));

    // Success notice displayed
    expect(
      await screen.findByText(/MFA reset successfully for Ramesh Teacher/i),
    ).toBeInTheDocument();
  });

  it('Flow 5: Invalid or expired invitation token displays clear guidance to contact school admin', async () => {
    const b = createFakeBackend();
    renderApp(b, '/accept-invite?token=invalid-token'); // secret-scan:allow

    expect(
      await screen.findByRole('heading', { name: 'Invalid invitation link' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Invitation links expire after 7 days and can only be used once/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Sign in' })).toBeInTheDocument();
  });
});
