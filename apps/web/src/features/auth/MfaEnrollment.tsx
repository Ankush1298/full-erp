import { useEffect, useRef, useState, type FormEvent } from 'react';
import { QrCode } from './QrCode';
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
import { useStepUp } from './StepUp';

interface MfaEnrollmentProps {
  isMfaRequired?: boolean;
  onComplete: () => void;
  onCancel?: () => void;
  inModal?: boolean;
  headingId?: string;
}

type Step = 'init' | 'scan' | 'codes';

export function MfaEnrollment({
  isMfaRequired = false,
  onComplete,
  onCancel,
  inModal = false,
  headingId = 'mfa-title',
}: MfaEnrollmentProps) {
  const { client } = useAuth();
  const { runWithStepUp } = useStepUp();
  const [step, setStep] = useState<Step>('init');
  const [ticket, setTicket] = useState('');
  const [showManualTicket, setShowManualTicket] = useState(false);
  const [enrollData, setEnrollData] = useState<MfaEnrollStartData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [savedCodesConfirmed, setSavedCodesConfirmed] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);
  const [codesCopied, setCodesCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verifyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'scan') {
      verifyInputRef.current?.focus();
    }
  }, [step]);

  const handleStart = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const data = await runWithStepUp(
        () => startMfaEnrollment(client, ticket || undefined),
        'PASSWORD_REAUTH',
      );
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
    const body = (
      <div className="mfa-enrollment-flow">
        {inModal ? (
          <div className="auth-header">
            <div className="auth-icon-wrap auth-icon-wrap--success" aria-hidden="true">
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
                <polyline points="9 12 11 14 15 10" />
              </svg>
            </div>
            <h1 id={headingId}>Emergency Recovery Codes</h1>
          </div>
        ) : null}
        <Alert tone="info">
          Save these one-time recovery codes in a secure password manager or offline location. They
          will never be displayed again.
        </Alert>

        <div className="recovery-codes-grid">
          {recoveryCodes.map((code, idx) => (
            <div key={idx} className="recovery-code-pill">
              <span className="recovery-code-num">{idx + 1}.</span>
              <code className="recovery-code-val">{code}</code>
            </div>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            margin: 'var(--space-3) 0',
            flexWrap: 'wrap',
          }}
        >
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(recoveryCodes.join('\n'));
              setCodesCopied(true);
              setTimeout(() => setCodesCopied(false), 2500);
            }}
          >
            {codesCopied ? 'Codes copied!' : 'Copy all recovery codes'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const content = [
                'Anesa Campus OS - Emergency Recovery Codes',
                `Generated: ${new Date().toISOString()}`,
                '',
                'Keep these codes safe. Each code can only be used once.',
                '',
                ...recoveryCodes.map((c, i) => `${i + 1}. ${c}`),
                '',
              ].join('\n');
              const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'anesa-recovery-codes.txt';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download codes (.txt)
          </Button>
        </div>

        <p className="muted">
          Each recovery code can be used once if you lose access to your authenticator application.
        </p>

        <div
          style={{
            margin: 'var(--space-4) 0',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
            backgroundColor: 'var(--color-surface, #f8f9fa)',
            borderRadius: 'var(--radius-md, 6px)',
            border: '1px solid var(--color-border, #dadce0)',
          }}
        >
          <input
            type="checkbox"
            id="confirm-saved-codes"
            checked={savedCodesConfirmed}
            onChange={(e) => setSavedCodesConfirmed(e.target.checked)}
            style={{ marginTop: '3px' }}
          />
          <label htmlFor="confirm-saved-codes" style={{ fontSize: '0.9rem', cursor: 'pointer' }}>
            <strong>I have safely saved these recovery codes.</strong> I understand they will never
            be displayed again.
          </label>
        </div>

        <Button
          type="button"
          variant="primary"
          className={inModal ? 'btn-block' : undefined}
          onClick={() => {
            setRecoveryCodes(null);
            onComplete();
          }}
        >
          I have saved my recovery codes
        </Button>
      </div>
    );

    return inModal ? body : <Card title="Emergency Recovery Codes">{body}</Card>;
  }

  if (step === 'scan' && enrollData) {
    const body = (
      <div className="mfa-enrollment-flow">
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
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </div>
            <h1 id={headingId}>Configure Authenticator App</h1>
          </div>
        ) : null}
        <p className="muted">
          Scan this QR code with your authenticator app (such as Google Authenticator, 1Password, or
          Bitwarden), or enter the setup key below.
        </p>

        <div className="qr-code-wrapper">
          <QrCode
            value={enrollData.otpauthUri}
            label="QR code for your authenticator app. If you cannot scan it, use the setup key shown below."
          />
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="setup-key-block">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 'var(--space-1)',
            }}
          >
            <span className="setup-key-label">Can’t scan? Enter this setup key:</span>
            <Button
              type="button"
              variant="secondary"
              style={{ fontSize: '0.8rem', padding: 'var(--space-1) var(--space-2)' }}
              onClick={() => {
                void navigator.clipboard?.writeText(enrollData.secret);
                setSecretCopied(true);
                setTimeout(() => setSecretCopied(false), 2500);
              }}
            >
              {secretCopied ? 'Copied key!' : 'Copy key'}
            </Button>
          </div>
          <code className="setup-key-code">{formatSecret(enrollData.secret)}</code>
        </div>

        <ol
          className="mfa-instructions-list"
          style={{
            paddingLeft: 'var(--space-4)',
            margin: 'var(--space-3) 0',
            fontSize: '0.85rem',
            color: 'var(--color-text-secondary)',
          }}
        >
          <li>
            Open <strong>Google Authenticator</strong>, <strong>Microsoft Authenticator</strong>,{' '}
            <strong>1Password</strong>, or your preferred TOTP app.
          </li>
          <li>Scan the QR code above or enter the setup key manually.</li>
          <li>Enter the 6-digit confirmation code generated by your app below.</li>
        </ol>

        <form
          onSubmit={(e) => {
            void handleVerify(e);
          }}
          noValidate
          className="auth-form"
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
            inputRef={verifyInputRef}
          />

          <div className="auth-actions-stack">
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              className={inModal ? 'btn-block' : undefined}
            >
              {busy ? 'Confirming…' : 'Confirm Setup'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              className={inModal ? 'btn-block' : undefined}
              onClick={() => {
                void handleCancel();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    );

    return inModal ? body : <Card title="Configure Authenticator App">{body}</Card>;
  }

  const body = (
    <div className="mfa-enrollment-flow">
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
          <h1 id={headingId}>Set Up Two-Factor Authentication</h1>
        </div>
      ) : null}
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
        className="auth-form"
      >
        {isMfaRequired ? (
          showManualTicket ? (
            <TextField
              label="Enrollment Ticket"
              name="ticket"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="64-character administrator ticket"
              hint="An administrator-issued enrollment ticket. Leave blank if onboarding via invitation."
              disabled={busy}
            />
          ) : (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <button
                type="button"
                className="btn-link"
                style={{
                  fontSize: '0.85rem',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--color-primary)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
                onClick={() => setShowManualTicket(true)}
              >
                Have a manual administrator enrollment ticket?
              </button>
            </div>
          )
        ) : null}

        <div className="auth-actions-stack">
          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            className={inModal ? 'btn-block' : undefined}
          >
            {busy ? 'Starting…' : 'Begin Setup'}
          </Button>
          {onCancel ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              className={inModal ? 'btn-block' : undefined}
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );

  return inModal ? body : <Card title="Set Up Two-Factor Authentication">{body}</Card>;
}
