import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import {
  satisfiesLevel,
  submitMfaStepUp,
  submitPasswordStepUp,
  type StepUpLevel,
} from '../../lib/api/step-up-api';
import { isApiError } from '../../lib/api/errors';
import { isStepUpRequired, stepUpErrorMessage } from '../../lib/api/messages';
import { useAuth } from './AuthProvider';

/**
 * "Re-verify, then retry once" for operations the backend refuses with 403 STEP_UP_REQUIRED.
 *
 * Contract of `runWithStepUp(operation, level)`:
 *  - `operation` runs. Any outcome other than STEP_UP_REQUIRED (success or ANY other error) is returned/thrown untouched.
 *  - On STEP_UP_REQUIRED a modal asks for the proof `level` needs: PASSWORD_MFA (the default, what every CRITICAL route
 *    needs) takes an authenticator or recovery code; PASSWORD_REAUTH takes the password. The server's answer must report a
 *    strength that satisfies `level`; a weaker one (password for an MFA-level operation) counts as a failure, never as a pass.
 *  - Only after a verified, sufficient step-up is `operation` run ONE more time, and whatever it does (including another
 *    STEP_UP_REQUIRED) is final: no second prompt, no loop. Cancel, a dead session, or a failure leaves the original
 *    STEP_UP_REQUIRED error to the caller and never re-runs the operation.
 *  - Only the caller's own `operation` is ever replayed. At most one prompt exists at a time; an operation that is refused
 *    while a prompt is open fails with its own error and is not queued or replayed.
 *  - The backend refuses in its pre-handler, before any effect, so replaying the refused operation cannot apply it twice.
 */
export interface StepUpApi {
  runWithStepUp: <T>(operation: () => Promise<T>, level?: StepUpLevel) => Promise<T>;
}

const StepUpContext = createContext<StepUpApi | null>(null);

export function useStepUp(): StepUpApi {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used inside <StepUpProvider>.');
  return ctx;
}

type Outcome = 'verified' | 'cancelled' | 'session_ended';
interface Pending {
  level: StepUpLevel;
  settle: (outcome: Outcome) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useRef<Pending | null>(null);

  const prompt = useCallback((level: StepUpLevel) => {
    return new Promise<Outcome>((resolve) => {
      const entry: Pending = {
        level,
        settle: (outcome) => {
          if (open.current !== entry) return; // settle once
          open.current = null;
          setPending(null);
          resolve(outcome);
        },
      };
      open.current = entry;
      setPending(entry);
    });
  }, []);

  // A provider that goes away while a prompt is open must not leave its caller waiting forever.
  useEffect(() => () => open.current?.settle('cancelled'), []);

  const runWithStepUp = useCallback(
    async <T,>(operation: () => Promise<T>, level: StepUpLevel = 'PASSWORD_MFA'): Promise<T> => {
      // Captured NOW, synchronously in the caller's event handler: pages disable their trigger while the operation is
      // pending, and a disabled control cannot take focus back once the dialog closes.
      const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      try {
        return await operation();
      } catch (err) {
        if (!isStepUpRequired(err)) throw err;
        if (open.current) throw err; // a prompt is already open: this one is not queued and not replayed
        const outcome = await prompt(level);
        try {
          if (outcome === 'session_ended') void logout();
          if (outcome !== 'verified') throw err;
          return await operation(); // the single retry; its result or error is final
        } finally {
          restoreFocus(origin);
        }
      }
    },
    [prompt, logout],
  );

  const api = useMemo<StepUpApi>(() => ({ runWithStepUp }), [runWithStepUp]);

  return (
    <StepUpContext.Provider value={api}>
      {children}
      {pending ? <StepUpDialog level={pending.level} onDone={pending.settle} /> : null}
    </StepUpContext.Provider>
  );
}

/**
 * Gives focus back to where the user was, after the caller has re-enabled its controls (next task), and only if the
 * element is still on the page, usable, and nothing else has taken focus meanwhile.
 */
function restoreFocus(origin: HTMLElement | null): void {
  setTimeout(() => {
    const idle = document.activeElement === null || document.activeElement === document.body;
    const usable = origin?.isConnected === true && !(origin as HTMLButtonElement).disabled;
    if (origin && idle && usable) origin.focus();
  }, 0);
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function StepUpDialog({ level, onDone }: { level: StepUpLevel; onDone: (o: Outcome) => void }) {
  const { client } = useAuth();
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Move focus into the dialog. (The provider returns it to where the user was once the operation has settled.)
  // `alive` is set to true on EVERY run of this effect, not only initialised once: React 19 StrictMode (development)
  // mounts, cleans up and re-mounts effects, and refs survive that cycle, so a cleanup-only `false` would make the dialog
  // ignore every answer for the rest of its life. It is false only between a real unmount and nothing else.
  useEffect(() => {
    alive.current = true;
    inputRef.current?.focus();
    return () => {
      alive.current = false;
    };
  }, []);
  // Focus the field again when the form switches between authenticator code and recovery code.
  useEffect(() => {
    inputRef.current?.focus();
  }, [useRecovery]);

  const cancel = (): void => {
    if (!submitting.current) onDone('cancelled');
  };

  // Escape cancels and Tab is kept inside the dialog. A listener on the element (not a JSX handler) because the container
  // is a non-interactive dialog role. It reads only refs and the stable `onDone`, so it is registered once per prompt.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const listener = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!submitting.current) onDone('cancelled');
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', listener);
    return () => el.removeEventListener('keydown', listener);
  }, [onDone]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting.current) return;
    setError(null);

    let attempt: () => Promise<string>;
    if (level === 'PASSWORD_REAUTH') {
      if (password === '') {
        setError('Enter your current password.');
        return;
      }
      const secret = password;
      attempt = () => submitPasswordStepUp(client, secret);
    } else if (useRecovery) {
      const secret = recoveryCode.trim();
      if (secret === '') {
        setError('Enter a recovery code.');
        return;
      }
      attempt = () => submitMfaStepUp(client, { recoveryCode: secret });
    } else {
      const secret = code.trim().replace(/\s+/g, '');
      if (!/^[0-9]{6}$/.test(secret)) {
        setError('Enter the 6-digit code from your authenticator application.');
        return;
      }
      attempt = () => submitMfaStepUp(client, { code: secret });
    }

    submitting.current = true;
    setBusy(true);
    try {
      const granted = await attempt();
      if (!alive.current) return;
      // Never accept a weaker level than the operation needs (a password is not a second factor).
      if (!satisfiesLevel(granted, level)) {
        setError('Re-verification was not strong enough for this action. Nothing was changed.');
        return;
      }
      setPassword('');
      setCode('');
      setRecoveryCode('');
      submitting.current = false;
      onDone('verified');
    } catch (err) {
      if (!alive.current) return;
      if (isApiError(err) && err.kind === 'unauthenticated' && err.code === 'UNAUTHORIZED') {
        submitting.current = false;
        onDone('session_ended'); // the session is gone: the provider signs out; nothing is retried
        return;
      }
      setError(stepUpErrorMessage(err, level));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const mfa = level === 'PASSWORD_MFA';
  return (
    <div className="stepup-backdrop">
      <div
        ref={dialogRef}
        className="stepup-dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
      >
        <h2 id={titleId} className="card-title">
          Confirm it&apos;s you
        </h2>
        <p id={descId} className="muted">
          {!mfa
            ? 'For your security, enter your password to continue.'
            : useRecovery
              ? 'This action needs a fresh second-factor check. Enter one of your recovery codes.'
              : 'This action needs a fresh second-factor check. Enter the 6-digit code from your authenticator application.'}
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <form onSubmit={(e) => void submit(e)} noValidate>
          {!mfa ? (
            <TextField
              label="Password"
              name="stepUpPassword"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              inputRef={inputRef}
              required
              disabled={busy}
            />
          ) : useRecovery ? (
            <TextField
              label="Recovery code"
              name="stepUpRecoveryCode"
              autoComplete="off"
              spellCheck="false"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              inputRef={inputRef}
              required
              disabled={busy}
            />
          ) : (
            <TextField
              label="Verification code"
              name="stepUpCode"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputRef={inputRef}
              required
              disabled={busy}
            />
          )}
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <Button type="submit" variant="primary" pending={busy}>
              {busy ? 'Verifying…' : 'Verify'}
            </Button>
            {mfa ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setUseRecovery((v) => !v);
                }}
              >
                {useRecovery ? 'Use authenticator code' : 'Use recovery code'}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
