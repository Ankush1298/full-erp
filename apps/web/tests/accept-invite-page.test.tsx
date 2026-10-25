import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBackend } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

const VALID_TOKEN = /* secret-scan:allow */ 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
const VALID_PW = /* secret-scan:allow */ 'ValidPassword123!';
const SHORT_PW = /* secret-scan:allow */ 'short';

describe('AcceptInvitePage', () => {
  it('renders invalid link state when token is missing', async () => {
    const b = createFakeBackend();
    const { container } = renderApp(b, '/accept-invite');

    expect(
      await screen.findByRole('heading', { name: 'Invalid invitation link' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This invitation link is invalid or incomplete/i)).toBeInTheDocument();
    const loginLink = screen.getByRole('link', { name: 'Go to Sign in' });
    expect(loginLink).toHaveAttribute('href', '/login');

    const { axe } = await import('vitest-axe');
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('renders invalid link state when token is malformed', async () => {
    const b = createFakeBackend();
    renderApp(b, '/accept-invite?token=too-short'); /* secret-scan:allow */

    expect(
      await screen.findByRole('heading', { name: 'Invalid invitation link' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This invitation link is invalid or incomplete/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/New password/i)).not.toBeInTheDocument();
  });

  it('renders invitation form when token is valid', async () => {
    const b = createFakeBackend();
    const { container } = renderApp(
      b,
      `/accept-invite?token=${VALID_TOKEN}`,
    ); /* secret-scan:allow */

    expect(await screen.findByRole('heading', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(
      screen.getByText('Create a password to activate your campus account.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();

    const { axe } = await import('vitest-axe');
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it('displays email context when safe and valid email is in search params', async () => {
    const b = createFakeBackend();
    renderApp(
      b,
      `/accept-invite?token=${VALID_TOKEN}&email=ada%40college.test`,
    ); /* secret-scan:allow */

    expect(await screen.findByRole('heading', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(screen.getByText(/Activating account for/i)).toBeInTheDocument();
    expect(screen.getByText('ada@college.test')).toBeInTheDocument();
  });

  it('validates password requirements on client side before sending request', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */

    const submitBtn = await screen.findByRole('button', { name: 'Accept invitation' });
    await user.click(submitBtn);

    // Empty password
    const pwInput = screen.getByLabelText('New password');
    expect(pwInput).toHaveAttribute('aria-invalid', 'true');
    expect(pwInput).toHaveFocus();
    expect(screen.getByText('Enter a password.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/auth/accept-invite')).toHaveLength(0);

    // Password too short (< 12 chars)
    await user.type(pwInput, SHORT_PW);
    await user.click(submitBtn);
    expect(screen.getByText('At least 12 characters are required.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/auth/accept-invite')).toHaveLength(0);

    // Valid length password, missing confirmation
    await user.clear(pwInput);
    await user.type(pwInput, VALID_PW);
    await user.click(submitBtn);
    const confirmInput = screen.getByLabelText('Confirm password');
    expect(confirmInput).toHaveAttribute('aria-invalid', 'true');
    expect(confirmInput).toHaveFocus();
    expect(screen.getByText('Confirm your password.')).toBeInTheDocument();

    // Mismatched passwords
    await user.type(confirmInput, 'DifferentPassword123!');
    await user.click(submitBtn);
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(b.callsTo('POST', '/auth/accept-invite')).toHaveLength(0);
  });

  it('successfully submits acceptance, cleans URL, and displays success state', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    const { container } = renderApp(
      b,
      `/accept-invite?token=${VALID_TOKEN}`,
    ); /* secret-scan:allow */

    const pwInput = await screen.findByLabelText('New password');
    const confirmInput = screen.getByLabelText('Confirm password');
    const submitBtn = screen.getByRole('button', { name: 'Accept invitation' });

    await user.type(pwInput, VALID_PW);
    await user.type(confirmInput, VALID_PW);
    await user.click(submitBtn);

    expect(await screen.findByRole('heading', { name: 'Invitation accepted' })).toBeInTheDocument();
    expect(
      screen.getByText('Your invitation has been accepted and your account is active.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('You can now sign in using your email address and new password.'),
    ).toBeInTheDocument();
    const signinLink = screen.getByRole('link', { name: 'Sign in to your account' });
    expect(signinLink).toHaveAttribute('href', '/login');

    // Server was called with exact contract: only token and password
    const calls = b.callsTo('POST', '/auth/accept-invite');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      token: VALID_TOKEN,
      password: VALID_PW,
    });

    // Verify token was scrubbed from URL history
    expect(replaceStateSpy).toHaveBeenCalledWith({}, '', '/accept-invite');

    const { axe } = await import('vitest-axe');
    const results = await axe(container);
    expect(results.violations).toEqual([]);

    replaceStateSpy.mockRestore();
  });

  it('handles server rejection for invalid/expired/used invitation safely', async () => {
    const b = createFakeBackend();
    b.state.acceptInviteMode = 'invalid';
    const user = userEvent.setup();

    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */

    const pwInput = await screen.findByLabelText('New password');
    const confirmInput = screen.getByLabelText('Confirm password');
    const submitBtn = screen.getByRole('button', { name: 'Accept invitation' });

    await user.type(pwInput, VALID_PW);
    await user.type(confirmInput, VALID_PW);
    await user.click(submitBtn);

    expect(
      await screen.findByText(
        'This invitation link is invalid, expired, or has already been used. Please ask your administrator to send a new invitation.',
      ),
    ).toBeInTheDocument();

    // Sensitive passwords cleared on failure
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveFocus();
  });

  it('handles rate limiting with retry-after notice', async () => {
    const b = createFakeBackend();
    b.state.acceptInviteMode = 'rate';
    const user = userEvent.setup();

    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */

    await user.type(await screen.findByLabelText('New password'), VALID_PW);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PW);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(/Too many attempts\. Please wait 2 minutes and try again\./i),
    ).toBeInTheDocument();
  });

  it('handles network failure safely', async () => {
    const b = createFakeBackend();
    b.state.acceptInviteMode = 'network';
    const user = userEvent.setup();

    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */

    await user.type(await screen.findByLabelText('New password'), VALID_PW);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PW);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText('Cannot reach the server. Check your connection and try again.'),
    ).toBeInTheDocument();
  });

  it('handles unexpected server error safely', async () => {
    const b = createFakeBackend();
    b.state.acceptInviteMode = 'server';
    const user = userEvent.setup();

    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */

    await user.type(await screen.findByLabelText('New password'), VALID_PW);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PW);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(
      await screen.findByText(
        'Invitation acceptance is temporarily unavailable. Please try again shortly.',
      ),
    ).toBeInTheDocument();
  });

  it('never saves sensitive credentials or tokens in localStorage or sessionStorage', async () => {
    const b = createFakeBackend();
    const user = userEvent.setup();

    renderApp(b, `/accept-invite?token=${VALID_TOKEN}`); /* secret-scan:allow */
    await user.type(await screen.findByLabelText('New password'), VALID_PW);
    await user.type(screen.getByLabelText('Confirm password'), VALID_PW);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    await screen.findByRole('heading', { name: 'Invitation accepted' });

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('password')).toBeNull();
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('password')).toBeNull();
  });
});
