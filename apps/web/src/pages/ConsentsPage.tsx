import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
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
      .catch((err: unknown) => {
        setError(
          err instanceof Error && err.message && !err.message.startsWith('API ')
            ? err.message
            : 'Failed to load privacy and consent records.',
        );
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
      <PageHeader
        title="Privacy & Consents"
        subtitle="Review and manage the consent you have granted for data processing and institutional communications."
      />

      {error && (
        <ErrorState
          title="Consent error"
          message={error}
          onRetry={loadConsents}
          retryLabel="Retry"
        />
      )}
      {success && <Alert tone="info">{success}</Alert>}

      {loading ? (
        <Spinner label="Loading consent records…" />
      ) : consents.length === 0 ? (
        <EmptyState
          title="No consent records"
          description="No point-in-time consent records were found for your account."
          compact
        />
      ) : (
        <div className="grid">
          {consents.map((item) => (
            <Card key={item.id} title={item.consent_type.replace(/_/g, ' ')}>
              <div style={{ marginBottom: 'var(--space-2)' }}>
                <StatusBadge status={item.status} />
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
