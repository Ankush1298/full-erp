import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/TextField';
import { submitMfaChallenge } from '../../lib/api/mfa-api';
import { mfaErrorMessage } from '../../lib/api/messages';
import { useAuth } from './AuthProvider';

interface MfaChallengeProps {
  onSuccess: () => void;
  onCancel?: () => void;
  inModal?: boolean;
  headingId?: string;
}

export function MfaChallenge({
  onSuccess,
  onCancel,
  inModal = true,
  headingId = 'mfa-title',
}: MfaChallengeProps) {
  const { client } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [showRecoveryHelp, setShowRecoveryHelp] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [useRecovery]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (useRecovery) {
        const normalized = recoveryCode.trim();
        if (!normalized) {
          setError('Please enter a recovery code.');
          setBusy(false);
          return;
        }
        await submitMfaChallenge(client, { recoveryCode: normalized });
      } else {
        const cleaned = code.trim().replace(/\s+/g, '');
        if (!/^[0-9]{6}$/.test(cleaned)) {
          setError('Please enter a valid 6-digit verification code.');
          setBusy(false);
          return;
        }
        await submitMfaChallenge(client, { code: cleaned });
      }
      onSuccess();
    } catch (err) {
      setError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className="mfa-challenge-flow">
      {inModal ? (
        <div className="auth-header">
          <div className="auth-icon-wrap" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="32"
              height="32"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <h1 id={headingId}>Two-factor authentication</h1>
        </div>
      ) : null}
      <p className="muted">
        {useRecovery
          ? 'Enter one of your 10-character emergency recovery codes.'
          : 'Enter the 6-digit verification code from your authenticator application.'}
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate className="auth-form">
        {useRecovery ? (
          <TextField
            label="Recovery code"
            name="recoveryCode"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="xxxx-xxxx-xx"
            autoComplete="off"
            spellCheck="false"
            required
            disabled={busy}
            inputRef={inputRef}
          />
        ) : (
          <TextField
            label="Verification code"
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            autoComplete="one-time-code"
            required
            disabled={busy}
            inputRef={inputRef}
          />
        )}

        <div className="auth-actions-stack">
          <Button type="submit" variant="primary" disabled={busy} className="btn-block">
            {busy ? 'Verifying…' : 'Verify'}
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            className="btn-block"
            onClick={() => {
              setError(null);
              setUseRecovery((prev) => !prev);
            }}
          >
            {useRecovery ? 'Use authenticator code' : 'Use recovery code'}
          </Button>

          {onCancel ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              className="btn-block"
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>

      {showRecoveryHelp ? (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Alert tone="info">
            <strong>Lost your authenticator and recovery codes?</strong>
            <br />
            Contact your school administrator or Principal to request an account MFA reset. An
            administrator will verify your identity and securely reset your MFA factors, allowing
            you to set up a new authenticator on your next sign in.
          </Alert>
        </div>
      ) : (
        <div style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
          <button
            type="button"
            className="btn-link"
            style={{
              fontSize: '0.85rem',
              background: 'none',
              border: 'none',
              color: 'var(--color-primary)',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
            onClick={() => setShowRecoveryHelp(true)}
          >
            Lost access to authenticator and recovery codes?
          </button>
        </div>
      )}

      <p className="fineprint">
        Two-factor authentication adds an extra layer of security. If you lost your device, use an
        emergency recovery code.
      </p>
    </div>
  );

  if (inModal) {
    return content;
  }

  return <Card title="Two-Factor Authentication">{content}</Card>;
}
