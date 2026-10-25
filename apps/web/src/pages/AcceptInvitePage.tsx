import { useState, useRef, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { TextField } from '../components/ui/TextField';
import { Logo } from '../components/Logo';
import { Footer } from '../components/Footer';
import { usePageTitle } from '../components/usePageTitle';
import { acceptInvite } from '../lib/api/auth-api';
import { acceptInviteErrorMessage } from '../lib/api/messages';
import { useAuth } from '../features/auth/AuthProvider';

/** 32 random bytes, base64url: 43 characters matching the backend contract. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface FieldErrors {
  password?: string;
  confirmPassword?: string;
}

export function AcceptInvitePage() {
  usePageTitle('Accept invitation');
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const rawEmail = searchParams.get('email') ?? '';
  const emailHint = EMAIL_PATTERN.test(rawEmail.trim()) ? rawEmail.trim() : null;
  const isTokenValid = INVITE_TOKEN_PATTERN.test(token);

  const { client } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  if (!isTokenValid) {
    return (
      <div className="auth-page">
        <main className="auth-main" id="main">
          <div className="auth-card">
            <Logo />
            <h1>Invalid invitation link</h1>
            <Alert tone="error">
              This invitation link is invalid or incomplete. Please check the link from your
              invitation email or contact your administrator.
            </Alert>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Link to="/login" className="btn btn-secondary btn-block">
                Go to Sign in
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (accepted) {
    return (
      <div className="auth-page">
        <main className="auth-main" id="main">
          <div className="auth-card">
            <Logo />
            <h1>Invitation accepted</h1>
            <Alert tone="success">
              Your invitation has been accepted and your account is active.
            </Alert>
            <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
              You can now sign in using your email address and new password.
            </p>
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Link to="/login" className="btn btn-primary btn-block">
                Sign in to your account
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;

    const nextErrors: FieldErrors = {};
    if (!password) {
      nextErrors.password = 'Enter a password.';
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = `At least ${MIN_PASSWORD_LENGTH} characters are required.`;
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      nextErrors.password = `At most ${MAX_PASSWORD_LENGTH} characters are allowed.`;
    }

    if (!confirmPassword) {
      nextErrors.confirmPassword = 'Confirm your password.';
    } else if (password && password !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords do not match.';
    }

    setErrors(nextErrors);
    setFormError(null);

    if (nextErrors.password) {
      passwordRef.current?.focus();
      return;
    }
    if (nextErrors.confirmPassword) {
      confirmRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      await acceptInvite(client, { token, password });
      setPassword('');
      setConfirmPassword('');
      // Clean URL so the one-time token is not retained in browser history or address bar
      if (typeof window !== 'undefined' && window.history?.replaceState) {
        const cleanPath =
          window.location.pathname && window.location.pathname !== '/'
            ? window.location.pathname
            : '/accept-invite';
        window.history.replaceState({}, '', cleanPath);
      }
      setAccepted(true);
    } catch (err) {
      setPassword('');
      setConfirmPassword('');
      setFormError(acceptInviteErrorMessage(err));
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-main" id="main">
        <div className="auth-card">
          <Logo />
          <h1>Accept invitation</h1>
          {emailHint ? (
            <p className="muted">
              Activating account for <strong>{emailHint}</strong>
            </p>
          ) : (
            <p className="muted">Create a password to activate your campus account.</p>
          )}
          {formError ? <Alert tone="error">{formError}</Alert> : null}
          <form onSubmit={(e) => void onSubmit(e)} noValidate>
            <TextField
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              hint="Must be at least 12 characters."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              inputRef={passwordRef}
            />
            <TextField
              label="Confirm password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={errors.confirmPassword}
              inputRef={confirmRef}
            />
            <Button type="submit" pending={pending} className="btn-block">
              {pending ? 'Accepting invitation…' : 'Accept invitation'}
            </Button>
          </form>
          <p className="fineprint">
            By accepting this invitation, you agree to follow your institution’s acceptable use
            policy and security guidelines.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}
