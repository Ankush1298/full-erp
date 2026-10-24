import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StrictMode, useState, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { AuthProvider } from '../src/features/auth/AuthProvider';
import { StepUpProvider, useStepUp } from '../src/features/auth/StepUp';
import { ApiClient } from '../src/lib/api/client';
import { ApiError, isApiError } from '../src/lib/api/errors';
import type { StepUpLevel } from '../src/lib/api/step-up-api';
import { createFakeBackend, STAFF } from './helpers/fakeBackend';
import { renderApp } from './helpers/render';

// Deliberately unusual: if this ever reaches a log, storage, a URL or a rendered message, the checks below find it.
const SECRET_PASSWORD = 'Tr0ub4dor&3-never-persist';
const REFUSED = () => new ApiError('forbidden', 403, { code: 'STEP_UP_REQUIRED' });

type Backend = ReturnType<typeof createFakeBackend>;

/** An enrolled staff member whose session is NOT fresh enough: guarded routes answer 403 STEP_UP_REQUIRED. */
function enrolledBackend(): Backend {
  const b = createFakeBackend({ session: true, me: STAFF });
  b.state.mfa.enrolled = true;
  b.state.mfa.sessionVerified = true;
  b.state.mfa.unusedRecoveryCodes = 8;
  b.state.mfa.confirmedAt = '2026-10-20T10:00:00.000Z';
  b.state.stepUp.enforce = true;
  return b;
}
const regenerate = (b: Backend) => b.callsTo('POST', '/me/mfa/recovery-codes/regenerate');
const challenge = (b: Backend) => b.callsTo('POST', '/auth/mfa/challenge');
const passwordStepUp = (b: Backend) => b.callsTo('POST', '/auth/step-up');

afterEach(() => vi.restoreAllMocks());

describe('step-up on a CRITICAL operation (second factor, the backend default PASSWORD_MFA)', () => {
  it('prompts, verifies with the authenticator code, then retries the operation exactly once', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');

    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));

    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(regenerate(b)).toHaveLength(1); // refused once
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('aaaa-bbbb-cc')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(2); // the original + exactly one retry
    expect(challenge(b)).toHaveLength(1);
    expect(challenge(b)[0]!.body).toEqual({ code: '123456' });
    // a password is NOT how an MFA-level operation is satisfied
    expect(passwordStepUp(b)).toHaveLength(0);
  });

  it('accepts a recovery code instead', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Use recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), 'abcd-efgh-ij');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText('aaaa-bbbb-cc')).toBeInTheDocument();
    expect(challenge(b)[0]!.body).toEqual({ recoveryCode: 'abcd-efgh-ij' });
    expect(regenerate(b)).toHaveLength(2);
  });

  it('wrong code: stays open with a fixed message, does not sign the user out, does not retry; a later correct code works', async () => {
    const b = enrolledBackend();
    b.state.mfa.failChallenge = true;
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid authentication code or recovery code.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument(); // still signed in
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(1); // no retry after a failed verification

    b.state.mfa.failChallenge = false;
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByText('aaaa-bbbb-cc')).toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(2);
  });

  it('a malformed code is refused in the dialog without calling the server', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('6-digit code');
    expect(challenge(b)).toHaveLength(0);
  });

  it('cancel (button): the operation is not retried, the page shows the refusal, focus returns to the trigger', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');
    const trigger = await screen.findByRole('button', { name: 'Regenerate recovery codes' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Re-verification is required before continuing.',
    );
    expect(regenerate(b)).toHaveLength(1);
    expect(challenge(b)).toHaveLength(0);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('cancel (Escape) behaves the same', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(regenerate(b)).toHaveLength(1);
  });

  it('step-up endpoint failure (500): safe message, nothing retried, the dialog can still be cancelled', async () => {
    const b = enrolledBackend();
    b.state.stepUp.challengeMode = 'server';
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Re-verification is unavailable right now.');
    expect(alert.textContent).not.toContain('server text that must never be shown');
    expect(regenerate(b)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(regenerate(b)).toHaveLength(1);
  });

  it('expired session during step-up: signs out, nothing is retried', async () => {
    const b = enrolledBackend();
    b.state.stepUp.challengeMode = 'expired';
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(1);
  });

  it('a grant weaker than PASSWORD_MFA is never accepted: no retry', async () => {
    const b = enrolledBackend();
    b.state.stepUp.weakChallenge = true; // the server says 200 but reports only PASSWORD_REAUTH
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not strong enough');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(1);
  });

  it('works for the other CRITICAL operation too (disable MFA) and retries once', async () => {
    const b = enrolledBackend();
    b.state.mfa.required = false;
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Disable MFA' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(
      await screen.findByText('Two-factor authentication has been disabled.'),
    ).toBeInTheDocument();
    expect(b.callsTo('DELETE', '/me/mfa/totp')).toHaveLength(2);
  });

  it('no prompt when the session is already fresh: the operation just succeeds once', async () => {
    const b = enrolledBackend();
    b.state.stepUp.strength = 'PASSWORD_MFA';
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));
    expect(await screen.findByText('aaaa-bbbb-cc')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(regenerate(b)).toHaveLength(1);
  });
});

describe('step-up with the password (PASSWORD_REAUTH: first MFA enrollment)', () => {
  async function toEnrollment(b: Backend) {
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Begin Setup' }));
    await screen.findByRole('dialog');
    return user;
  }

  it('asks for the password, submits it to POST /auth/step-up, then retries enrollment once', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.enforce = true;
    const user = await toEnrollment(b);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText('Password'), SECRET_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(
      await screen.findByRole('heading', { name: 'Configure Authenticator App' }),
    ).toBeInTheDocument();
    expect(passwordStepUp(b)).toHaveLength(1);
    expect(passwordStepUp(b)[0]!.body).toEqual({ password: SECRET_PASSWORD });
    expect(b.callsTo('POST', '/me/mfa/totp/enroll')).toHaveLength(2);
    expect(challenge(b)).toHaveLength(0);
  });

  it('incorrect password: fixed message, still signed in, not retried; the secret is never stored, logged or echoed', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.enforce = true;
    b.state.stepUp.passwordFails = true;
    const user = await toEnrollment(b);
    await user.type(screen.getByLabelText('Password'), SECRET_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The password is incorrect.');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(b.callsTo('POST', '/me/mfa/totp/enroll')).toHaveLength(1);

    // The typed value sits only in the (controlled) input; it appears in no markup text, storage or log output.
    expect(document.body.textContent).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(Object.entries(window.localStorage))).not.toContain(SECRET_PASSWORD);
    expect(JSON.stringify(Object.entries(window.sessionStorage))).not.toContain(SECRET_PASSWORD);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_PASSWORD);
    // the only request that carried it is the single body sent to the step-up endpoint
    const carrying = b.state.calls.filter((c) => JSON.stringify(c).includes(SECRET_PASSWORD));
    expect(carrying.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /auth/step-up']);
  });

  it('too many attempts (429) and server errors show fixed text and do not retry', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.enforce = true;
    b.state.stepUp.passwordMode = 'rate';
    const user = await toEnrollment(b);
    await user.type(screen.getByLabelText('Password'), SECRET_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Please wait 30 seconds',
    );

    b.state.stepUp.passwordMode = 'server';
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Re-verification is unavailable right now.',
      ),
    );
    expect(b.callsTo('POST', '/me/mfa/totp/enroll')).toHaveLength(1);
  });

  it('an empty password is refused in the dialog without calling the server', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.enforce = true;
    const user = await toEnrollment(b);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your current password.');
    expect(passwordStepUp(b)).toHaveLength(0);
  });
});

/** Drives runWithStepUp directly, to pin the retry rules independent of any page. */
function Probe({ run, level }: { run: () => Promise<string>; level?: StepUpLevel }) {
  const { runWithStepUp } = useStepUp();
  const [result, setResult] = useState('idle');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          runWithStepUp(run, level).then(
            (v) => setResult(`ok:${v}`),
            (e: unknown) =>
              setResult(isApiError(e) ? `err:${e.kind}/${e.code ?? '-'}` : 'err:other'),
          );
        }}
      >
        run
      </button>
      <output>{result}</output>
    </>
  );
}
function renderProbe(b: Backend, children: ReactNode) {
  const client = new ApiClient({ basePath: '/api', fetchImpl: b.fetch });
  return render(
    <AuthProvider client={client}>
      <StepUpProvider>{children}</StepUpProvider>
    </AuthProvider>,
  );
}

describe('runWithStepUp rules', () => {
  it('errors that are not STEP_UP_REQUIRED pass through untouched, with no prompt and no replay', async () => {
    const cases: Array<[Error, string]> = [
      [new ApiError('server', 500, { code: 'INTERNAL_ERROR' }), 'err:server/INTERNAL_ERROR'],
      [new ApiError('forbidden', 403, { code: 'FORBIDDEN' }), 'err:forbidden/FORBIDDEN'],
      [
        new ApiError('unauthenticated', 401, { code: 'UNAUTHORIZED' }),
        'err:unauthenticated/UNAUTHORIZED',
      ],
      [
        new ApiError('mfa_required', 403, { code: 'MFA_REQUIRED' }),
        'err:mfa_required/MFA_REQUIRED',
      ],
      [new Error('boom'), 'err:other'],
    ];
    for (const [error, expected] of cases) {
      const b = createFakeBackend({ session: true, me: STAFF });
      const run = vi.fn(() => Promise.reject(error));
      const user = userEvent.setup();
      const view = renderProbe(b, <Probe run={run} />);
      await user.click(screen.getByRole('button', { name: 'run' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(expected));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(run).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('returns a successful first attempt without any prompt', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    const run = vi.fn(() => Promise.resolve('done'));
    const user = userEvent.setup();
    renderProbe(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:done'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retries at most once: a second refusal after a successful step-up is final (no second prompt, no loop)', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    const run = vi.fn(() => Promise.reject(REFUSED()));
    const user = userEvent.setup();
    renderProbe(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('err:forbidden/STEP_UP_REQUIRED'),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(challenge(b)).toHaveLength(1);
  });

  it('does not replay on cancel, and gives the caller its original STEP_UP_REQUIRED error', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    const run = vi.fn(() => Promise.reject(REFUSED()));
    const user = userEvent.setup();
    renderProbe(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('err:forbidden/STEP_UP_REQUIRED'),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(challenge(b)).toHaveLength(0);
    expect(passwordStepUp(b)).toHaveLength(0);
  });

  it('only the refused operation is replayed: a second one refused while the prompt is open is not queued or retried', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    let first = 0;
    const runFirst = vi.fn(() =>
      first++ === 0 ? Promise.reject(REFUSED()) : Promise.resolve('one'),
    );
    const runSecond = vi.fn(() => Promise.reject(REFUSED()));
    const user = userEvent.setup();
    renderProbe(
      b,
      <>
        <Probe run={runFirst} />
        <Probe run={runSecond} />
      </>,
    );
    const [btn1, btn2] = screen.getAllByRole('button', { name: 'run' });
    await user.click(btn1!);
    await screen.findByRole('dialog');
    await user.click(btn2!); // refused while the prompt is open
    await waitFor(() => expect(runSecond).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getAllByRole('status')[0]).toHaveTextContent('ok:one'));
    expect(runFirst).toHaveBeenCalledTimes(2);
    expect(runSecond).toHaveBeenCalledTimes(1); // never replayed
    expect(screen.getAllByRole('status')[1]).toHaveTextContent('err:forbidden/STEP_UP_REQUIRED');
    expect(challenge(b)).toHaveLength(1);
  });

  it('a PASSWORD_REAUTH level asks for the password and never calls the MFA challenge', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    let n = 0;
    const run = vi.fn(() => (n++ === 0 ? Promise.reject(REFUSED()) : Promise.resolve('ok')));
    const user = userEvent.setup();
    renderProbe(b, <Probe run={run} level="PASSWORD_REAUTH" />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await user.type(await screen.findByLabelText('Password'), SECRET_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:ok'));
    expect(passwordStepUp(b)).toHaveLength(1);
    expect(challenge(b)).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('React StrictMode (development double-invoked effects)', () => {
  // StrictMode mounts, cleans up and re-mounts every effect in development. The dialog must treat that simulated unmount
  // as "still mounted", otherwise it ignores the server's answer and the protected operation is never retried.
  function renderStrict(b: Backend, children: ReactNode) {
    const client = new ApiClient({ basePath: '/api', fetchImpl: b.fetch });
    return render(
      <StrictMode>
        <AuthProvider client={client}>
          <StepUpProvider>{children}</StepUpProvider>
        </AuthProvider>
      </StrictMode>,
    );
  }

  it('completes a second-factor step-up and retries the operation exactly once', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    let n = 0;
    const run = vi.fn(() => (n++ === 0 ? Promise.reject(REFUSED()) : Promise.resolve('done')));
    const user = userEvent.setup();
    renderStrict(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:done'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(2); // the refused attempt + exactly one retry
    expect(challenge(b)).toHaveLength(1);
  });

  it('shows a failed verification and recovers: still no retry until a correct code, then exactly one', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.mfa.failChallenge = true;
    let n = 0;
    const run = vi.fn(() => (n++ === 0 ? Promise.reject(REFUSED()) : Promise.resolve('done')));
    const user = userEvent.setup();
    renderStrict(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid authentication code');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled(); // not stuck on "Verifying…"
    expect(run).toHaveBeenCalledTimes(1);

    b.state.mfa.failChallenge = false;
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:done'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('password variant also completes under StrictMode (one retry)', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    let n = 0;
    const run = vi.fn(() => (n++ === 0 ? Promise.reject(REFUSED()) : Promise.resolve('ok')));
    const user = userEvent.setup();
    renderStrict(b, <Probe run={run} level="PASSWORD_REAUTH" />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await user.type(await screen.findByLabelText('Password'), SECRET_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ok:ok'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(passwordStepUp(b)).toHaveLength(1);
  });

  it('a dead session under StrictMode still signs out and never retries', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.challengeMode = 'expired';
    const run = vi.fn(() => Promise.reject(REFUSED()));
    const user = userEvent.setup();
    renderStrict(b, <Probe run={run} />);
    await user.click(screen.getByRole('button', { name: 'run' }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('err:forbidden/STEP_UP_REQUIRED'),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('step-up dialog accessibility', () => {
  it('is a named, described modal; focus moves in, is trapped, and returns on Escape; no axe violations', async () => {
    const b = enrolledBackend();
    const user = userEvent.setup();
    renderApp(b, '/account');
    const trigger = await screen.findByRole('button', { name: 'Regenerate recovery codes' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(dialog).toHaveAccessibleDescription(/second-factor check/);
    const input = screen.getByLabelText('Verification code');
    expect(input).toHaveFocus();

    // Tab order inside the dialog: code, Verify, Use recovery code, Cancel, then back to the code field
    await user.tab();
    expect(screen.getByRole('button', { name: 'Verify' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Use recovery code' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    expect((await axe(dialog)).violations).toEqual([]);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('the password variant is labelled and has no axe violations', async () => {
    const b = createFakeBackend({ session: true, me: STAFF });
    b.state.stepUp.enforce = true;
    const user = userEvent.setup();
    renderApp(b, '/account');
    await user.click(
      await screen.findByRole('button', { name: 'Set up two-factor authentication' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Begin Setup' }));
    const dialog = await screen.findByRole('dialog', { name: "Confirm it's you" });
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect((await axe(dialog)).violations).toEqual([]);
  });
});

describe('step-up code shape (static pins)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const api = read('src/lib/api/step-up-api.ts');
  const ui = read('src/features/auth/StepUp.tsx');

  it('both step-up calls opt out of the global "401 means expired" handler, and only on these two endpoints', () => {
    expect(api.match(/public: true/g)).toHaveLength(2);
    expect(api).toMatch(/'\/auth\/step-up'/);
    expect(api).toMatch(/'\/auth\/mfa\/challenge'/);
  });

  it('a verified grant must satisfy the requested level; PASSWORD_REAUTH never ranks as PASSWORD_MFA', () => {
    expect(ui).toMatch(/!satisfiesLevel\(granted, level\)/);
    expect(api).toMatch(/PASSWORD_REAUTH: 2, PASSWORD_MFA: 3/);
    expect(api).toMatch(/Infinity/); // an unknown level can never be satisfied
  });

  it('the operation is replayed in exactly one place, after a verified outcome', () => {
    expect(ui.match(/await operation\(\)/g)).toHaveLength(2); // the first attempt and the single retry
    expect(ui).toMatch(/if \(outcome !== 'verified'\) throw err;/);
    expect(ui).not.toMatch(/runWithStepUp\(operation/); // no recursion, so no loop
  });

  it('the default level is the backend default for CRITICAL routes (PASSWORD_MFA)', () => {
    expect(ui).toMatch(/level: StepUpLevel = 'PASSWORD_MFA'/);
  });

  it('secrets never reach storage, logs or URLs from the step-up code', () => {
    for (const text of [api, ui]) {
      expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
      expect(text).not.toMatch(/location\.|history\.|URLSearchParams|\?(?:password|code)\b/);
    }
  });
});
