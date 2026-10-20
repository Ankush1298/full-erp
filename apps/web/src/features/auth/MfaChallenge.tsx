import { useState, type FormEvent } from 'react';
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
}

export function MfaChallenge({ onSuccess, onCancel }: MfaChallengeProps) {
  const { client } = useAuth();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Card title="Two-Factor Authentication">
      <p className="muted">
        {useRecovery
          ? 'Enter one of your 10-character emergency recovery codes.'
          : 'Enter the 6-digit verification code from your authenticator application.'}
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
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
          />
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify'}
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setError(null);
              setUseRecovery((prev) => !prev);
            }}
          >
            {useRecovery ? 'Use authenticator code' : 'Use recovery code'}
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
