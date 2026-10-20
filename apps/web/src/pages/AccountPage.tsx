import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { roleLabel } from '../features/auth/identity';
import { MfaEnrollment } from '../features/auth/MfaEnrollment';
import {
  disableMfa,
  fetchMfaStatus,
  regenerateRecoveryCodes,
  type MfaStatus,
} from '../lib/api/mfa-api';
import { mfaErrorMessage } from '../lib/api/messages';

export function AccountPage() {
  usePageTitle('Account');
  const { identity, client } = useAuth();
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [loadingMfa, setLoadingMfa] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    setLoadingMfa(true);
    fetchMfaStatus(client)
      .then((s) => {
        setMfaStatus(s);
        setLoadingMfa(false);
      })
      .catch(() => {
        setLoadingMfa(false);
      });
  }, [client]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  if (!identity) return null;

  const handleRegenerateCodes = async () => {
    setActionError(null);
    setActionSuccess(null);
    setBusy(true);
    try {
      const codes = await regenerateRecoveryCodes(client);
      setNewRecoveryCodes(codes);
      loadStatus();
    } catch (err) {
      setActionError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisableMfa = async () => {
    setActionError(null);
    setActionSuccess(null);
    setBusy(true);
    try {
      await disableMfa(client);
      setActionSuccess('Two-factor authentication has been disabled.');
      loadStatus();
    } catch (err) {
      setActionError(mfaErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Account</h1>
      <Card title="Profile">
        <dl className="defs">
          <dt>Name</dt>
          <dd>{identity.displayName || 'Not set'}</dd>
          <dt>Roles</dt>
          <dd>{identity.roles.map(roleLabel).join(', ') || 'None'}</dd>
        </dl>
      </Card>

      <Card title="Two-Factor Authentication (MFA)">
        {loadingMfa ? (
          <Spinner label="Loading security settings…" />
        ) : enrolling ? (
          <MfaEnrollment
            isMfaRequired={Boolean(mfaStatus?.required)}
            onComplete={() => {
              setEnrolling(false);
              setActionSuccess('Two-factor authentication has been configured successfully.');
              loadStatus();
            }}
            onCancel={() => setEnrolling(false)}
          />
        ) : (
          <>
            {actionError ? <Alert tone="error">{actionError}</Alert> : null}
            {actionSuccess ? <Alert tone="success">{actionSuccess}</Alert> : null}

            {newRecoveryCodes ? (
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <Alert tone="info">
                  Your new recovery codes are shown below. Store them safely; they will not be shown
                  again.
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
                    margin: 'var(--space-3) 0',
                  }}
                >
                  {newRecoveryCodes.map((code, idx) => (
                    <span key={idx} style={{ padding: 'var(--space-1)' }}>
                      {code}
                    </span>
                  ))}
                </div>
                <Button type="button" variant="secondary" onClick={() => setNewRecoveryCodes(null)}>
                  Dismiss recovery codes
                </Button>
              </div>
            ) : null}

            <dl className="defs">
              <dt>Status</dt>
              <dd>
                {mfaStatus?.enrolled ? (
                  <Badge>Enabled (TOTP)</Badge>
                ) : (
                  <Badge>Not configured</Badge>
                )}
                {mfaStatus?.required ? (
                  <span style={{ marginLeft: 'var(--space-2)' }}>
                    <Badge>Required for your role</Badge>
                  </span>
                ) : null}
              </dd>
              {mfaStatus?.enrolled ? (
                <>
                  <dt>Confirmed</dt>
                  <dd>
                    {mfaStatus.confirmedAt
                      ? new Date(mfaStatus.confirmedAt).toLocaleDateString()
                      : 'Active'}
                  </dd>
                  <dt>Remaining Recovery Codes</dt>
                  <dd>{mfaStatus.unusedRecoveryCodes}</dd>
                </>
              ) : null}
            </dl>

            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
              {mfaStatus?.enrolled ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      void handleRegenerateCodes();
                    }}
                  >
                    {busy ? 'Regenerating…' : 'Regenerate recovery codes'}
                  </Button>
                  {!mfaStatus.required ? (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        void handleDisableMfa();
                      }}
                    >
                      {busy ? 'Disabling…' : 'Disable MFA'}
                    </Button>
                  ) : null}
                </>
              ) : (
                <Button type="button" variant="primary" onClick={() => setEnrolling(true)}>
                  Set up two-factor authentication
                </Button>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title="Security">
        <p className="muted">
          Password changes and active-session management are not yet available.
        </p>
      </Card>
    </>
  );
}
