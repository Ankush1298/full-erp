import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Spinner } from '../../components/ui/Spinner';
import { fetchMfaStatus, type MfaStatus } from '../../lib/api/mfa-api';
import { genericErrorMessage } from '../../lib/api/messages';
import { useAuth } from './AuthProvider';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollment } from './MfaEnrollment';

export function MfaPrompt() {
  const { client, setMfaRequired, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchMfaStatus(client)
      .then((s) => {
        if (active) {
          setStatus(s);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(genericErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  if (loading) {
    return (
      <div className="fullpage">
        <Spinner label="Checking authentication status…" />
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="auth-card">
        <Alert tone="error">{error || 'Unable to check authentication requirements.'}</Alert>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void logout();
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (status.enrolled) {
    return (
      <div className="auth-card">
        <MfaChallenge
          onSuccess={() => setMfaRequired(false)}
          onCancel={() => {
            void logout();
          }}
        />
      </div>
    );
  }

  return (
    <div className="auth-card">
      <MfaEnrollment
        isMfaRequired={status.required}
        onComplete={() => setMfaRequired(false)}
        onCancel={() => {
          void logout();
        }}
      />
    </div>
  );
}
