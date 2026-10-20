import { useState, type FormEvent } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/ui/TextField';
import {
  cancelMfaEnrollment,
  startMfaEnrollment,
  verifyMfaEnrollment,
  type MfaEnrollStartData,
} from '../../lib/api/mfa-api';
import { mfaErrorMessage } from '../../lib/api/messages';
import { useAuth } from './AuthProvider';

interface MfaEnrollmentProps {
  isMfaRequired?: boolean;
  onComplete: () => void;
  onCancel?: () => void;
}

type Step = 'init' | 'scan' | 'codes';

export function MfaEnrollment({ isMfaRequired = false, onComplete, onCancel }: MfaEnrollmentProps) {
  const { client } = useAuth();
  const [step, setStep] = useState<Step>('init');
  const [ticket, setTicket] = useState('');
  const [enrollData, setEnrollData] = useState<MfaEnrollStartData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const data = await startMfaEnrollment(client, ticket || undefined);
      setEnrollData(data);
      setStep('scan');
    } catch (err) {
      setError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);

    const cleaned = verifyCode.trim().replace(/\s+/g, '');
    if (!/^[0-9]{6}$/.test(cleaned)) {
      setError('Please enter a valid 6-digit verification code.');
      setBusy(false);
      return;
    }

    try {
      const out = await verifyMfaEnrollment(client, cleaned);
      setRecoveryCodes(out.recoveryCodes);
      setStep('codes');
    } catch (err) {
      setError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (step === 'scan') {
      try {
        await cancelMfaEnrollment(client);
      } catch {
        /* ignore cancellation errors */
      }
    }
    setEnrollData(null);
    setRecoveryCodes(null);
    if (onCancel) onCancel();
  };

  const formatSecret = (value: string): string => {
    return value.match(/.{1,4}/g)?.join(' ') ?? value;
  };

  if (step === 'codes' && recoveryCodes) {
    return (
      <Card title="Emergency Recovery Codes">
        <Alert tone="info">
          Save these one-time recovery codes in a secure password manager or offline location. They
          will never be displayed again.
        </Alert>

        <div
          style={{
            fontFamily: 'monospace',
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
            background: 'var(--color-bg)',
            borderRadius: 'var(--radius)',
            margin: 'var(--space-4) 0',
          }}
        >
          {recoveryCodes.map((code, idx) => (
            <span key={idx} style={{ padding: 'var(--space-1)' }}>
              {code}
            </span>
          ))}
        </div>

        <p className="muted">
          Each recovery code can be used once if you lose access to your authenticator application.
        </p>

        <Button
          type="button"
          variant="primary"
          onClick={() => {
            setRecoveryCodes(null);
            onComplete();
          }}
        >
          I have saved my recovery codes
        </Button>
      </Card>
    );
  }

  if (step === 'scan' && enrollData) {
    return (
      <Card title="Configure Authenticator App">
        <p className="muted">
          Scan the code or enter the secret key below into your authenticator app (such as Google
          Authenticator, 1Password, or Bitwarden).
        </p>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div style={{ margin: 'var(--space-4) 0' }}>
          <span style={{ fontWeight: 600, display: 'block', marginBottom: 'var(--space-1)' }}>
            Manual Entry Secret Key:
          </span>
          <code
            style={{
              display: 'block',
              padding: 'var(--space-3)',
              background: 'var(--color-bg)',
              borderRadius: 'var(--radius)',
              fontSize: '1.1rem',
              letterSpacing: '0.1em',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {formatSecret(enrollData.secret)}
          </code>
        </div>

        <form
          onSubmit={(e) => {
            void handleVerify(e);
          }}
          noValidate
        >
          <TextField
            label="6-Digit Verification Code"
            name="verifyCode"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
            placeholder="123456"
            autoComplete="one-time-code"
            hint="Enter the code shown in your authenticator app to confirm setup."
            required
            disabled={busy}
          />

          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm Setup'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void handleCancel();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Set Up Two-Factor Authentication">
      <p className="muted">
        Two-factor authentication adds an extra layer of security to your account by requiring a
        verification code from your mobile authenticator application.
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form
        onSubmit={(e) => {
          void handleStart(e);
        }}
        noValidate
      >
        {isMfaRequired ? (
          <TextField
            label="Enrollment Ticket"
            name="ticket"
            value={ticket}
            onChange={(e) => setTicket(e.target.value)}
            placeholder="64-character administrator ticket"
            hint="An administrator-issued enrollment ticket is required to enroll MFA for your role."
            required
            disabled={busy}
          />
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Starting…' : 'Begin Setup'}
          </Button>
          {onCancel ? (
            <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
