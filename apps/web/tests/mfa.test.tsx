import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createFakeBackend, ADMIN, STAFF } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

describe('MFA frontend experience', () => {
  it('displays MFA status on AccountPage when not configured', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    renderApp(b, '/account');

    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Two-Factor Authentication (MFA)')).toBeInTheDocument();
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeInTheDocument();
  });

  it('completes the full TOTP enrollment workflow accessibly and securely', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    const user = userEvent.setup();
    renderApp(b, '/account');

    const setupBtn = await screen.findByRole('button', {
      name: 'Set up two-factor authentication',
    });
    await user.click(setupBtn);

    // Step 1: Begin setup
    expect(
      await screen.findByRole('heading', { name: 'Set Up Two-Factor Authentication' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Begin Setup' }));

    // Step 2: Configure Authenticator App & manual secret
    expect(
      await screen.findByRole('heading', { name: 'Configure Authenticator App' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/JBSW Y3DP EHPK 3PXP/)).toBeInTheDocument();

    // Step 3: Enter verification code
    const codeInput = screen.getByLabelText(/6-Digit Verification Code/);
    await user.type(codeInput, '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm Setup' }));

    // Step 4: Displays recovery codes
    expect(
      await screen.findByRole('heading', { name: 'Emergency Recovery Codes' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1111-2222-33')).toBeInTheDocument();
    expect(screen.getByText('4444-5555-66')).toBeInTheDocument();

    // Complete setup
    await user.click(screen.getByRole('button', { name: 'I have saved my recovery codes' }));

    // Back to AccountPage with Enabled badge
    expect(await screen.findByText('Enabled (TOTP)')).toBeInTheDocument();
    expect(screen.getByText('Remaining Recovery Codes')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('regenerates recovery codes from AccountPage', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.mfa.enrolled = true;
    b.state.mfa.sessionVerified = true;
    b.state.mfa.unusedRecoveryCodes = 8;
    b.state.mfa.confirmedAt = '2026-10-20T10:00:00.000Z';

    const user = userEvent.setup();
    renderApp(b, '/account');

    expect(await screen.findByText('Enabled (TOTP)')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();

    const regenBtn = screen.getByRole('button', { name: 'Regenerate recovery codes' });
    await user.click(regenBtn);

    expect(await screen.findByText('aaaa-bbbb-cc')).toBeInTheDocument();
    expect(screen.getByText('dddd-eeee-ff')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss recovery codes' }));
    await waitFor(() => {
      expect(screen.queryByText('aaaa-bbbb-cc')).not.toBeInTheDocument();
    });
  });

  it('disables MFA when not mandatory for the role', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.mfa.enrolled = true;
    b.state.mfa.required = false;

    const user = userEvent.setup();
    renderApp(b, '/account');

    expect(await screen.findByText('Enabled (TOTP)')).toBeInTheDocument();
    const disableBtn = screen.getByRole('button', { name: 'Disable MFA' });
    await user.click(disableBtn);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(
      await screen.findByText('Two-factor authentication has been disabled.'),
    ).toBeInTheDocument();
  });

  it('shows required badge and does not allow disabling for MFA-required roles', async () => {
    const b = createFakeBackend({ session: true, me: ADMIN });
    b.state.mfa.enrolled = true;
    b.state.mfa.required = true;

    renderApp(b, '/account');

    expect(await screen.findByText('Enabled (TOTP)')).toBeInTheDocument();
    expect(screen.getByText('Required for your role')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable MFA' })).not.toBeInTheDocument();
  });
});
