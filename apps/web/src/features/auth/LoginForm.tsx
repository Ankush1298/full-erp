import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { Logo } from '../../components/Logo';
import { loginErrorMessage } from '../../lib/api/messages';
import { useAuth } from './AuthProvider';

interface FieldErrors {
  email?: string;
  password?: string;
}

/** The sign-in form (heading, fields, submit). Rendered inside the landing page's sign-in dialog. */
export function LoginForm({ from, headingId }: { from: string; headingId: string }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenant, setTenant] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Show the session notice once, then forget it.
  const notice = auth.notice;
  const { clearNotice } = auth;
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(clearNotice, 0);
    return () => window.clearTimeout(t);
  }, [notice, clearNotice]);

  // The dialog opens on the first field.
  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    // Client-side checks are a convenience only; the server validates everything again.
    const next: FieldErrors = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError(null);
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();

    setPending(true);
    try {
      await auth.login({
        email: email.trim(),
        password,
        ...(tenant.trim() ? { tenant: tenant.trim() } : {}),
      });
      setPassword('');
      void navigate(from, { replace: true });
    } catch (err) {
      setPassword('');
      setFormError(loginErrorMessage(err));
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-dialog-content">
      <div className="auth-brand-badge">
        <Logo />
      </div>
      <div className="auth-header">
        <h1 id={headingId}>Sign in</h1>
        <p className="muted">Use your campus account to continue.</p>
      </div>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      {formError ? <Alert tone="error">{formError}</Alert> : null}
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="auth-form">
        <TextField
          label="Email address"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          inputRef={emailRef}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          inputRef={passwordRef}
        />
        <details className="optional">
          <summary>Belong to more than one organisation?</summary>
          <TextField
            label="Organisation code (optional)"
            name="tenant"
            type="text"
            autoComplete="organization"
            autoCapitalize="none"
            spellCheck={false}
            hint="Only needed if you were given a code by your institution."
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
          />
        </details>
        <Button type="submit" pending={pending} className="btn-block">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="fineprint">
        Access is limited to authorised users. Forgot your password? Contact your institution’s
        administrator; self-service reset is not available yet.
      </p>
    </div>
  );
}
