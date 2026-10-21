import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { fetchMyConsents, withdrawConsent, type ConsentItem } from '../lib/api/consents-api';

export function ConsentsPage() {
  usePageTitle('Privacy & Consents');
  const { client } = useAuth();
  const [consents, setConsents] = useState<ConsentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadConsents = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMyConsents(client)
      .then((res) => {
        setConsents(res.data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load privacy and consent records.');
        setLoading(false);
      });
  }, [client]);

  useEffect(() => {
    loadConsents();
  }, [loadConsents]);

  const handleWithdraw = async (id: string) => {
    setBusyId(id);
    setError(null);
    setSuccess(null);
    try {
      await withdrawConsent(client, id);
      setSuccess('Consent has been withdrawn.');
      setConsents((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, status: 'WITHDRAWN', withdrawn_at: new Date().toISOString() } : c,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to withdraw consent.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <h1>Privacy & Consents</h1>
      <p className="lead">
        Review and manage the consent you have granted for data processing and institutional
        communications.
      </p>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="info">{success}</Alert>}

      {loading ? (
        <Spinner label="Loading consent records…" />
      ) : consents.length === 0 ? (
        <Card title="No consent records">
          <p className="muted">No point-in-time consent records were found for your account.</p>
        </Card>
      ) : (
        <div className="grid">
          {consents.map((item) => (
            <Card key={item.id} title={item.consent_type.replace(/_/g, ' ')}>
              <div style={{ marginBottom: 'var(--space-2)' }}>
                <Badge>{item.status}</Badge>
              </div>
              <dl className="defs">
                <dt>Policy Version</dt>
                <dd>{item.policy_version}</dd>
                <dt>Granted Date</dt>
                <dd>{new Date(item.granted_at).toLocaleDateString()}</dd>
                {item.withdrawn_at && (
                  <>
                    <dt>Withdrawn Date</dt>
                    <dd>{new Date(item.withdrawn_at).toLocaleDateString()}</dd>
                  </>
                )}
              </dl>
              {item.status === 'GRANTED' && (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void handleWithdraw(item.id);
                    }}
                    disabled={busyId === item.id}
                  >
                    Withdraw consent
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
