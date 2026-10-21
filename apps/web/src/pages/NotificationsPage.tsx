import { useCallback, useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationItem,
} from '../lib/api/notifications-api';

export function NotificationsPage() {
  usePageTitle('Notifications');
  const { client } = useAuth();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const loadNotifications = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchNotifications(client, unreadOnly)
      .then((res) => {
        setNotifications(res.data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message || 'Failed to load notifications.');
        setLoading(false);
      });
  }, [client, unreadOnly]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const handleMarkRead = async (id: string) => {
    setActing(true);
    try {
      await markNotificationRead(client, id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark notification as read.');
    } finally {
      setActing(false);
    }
  };

  const handleMarkAllRead = async () => {
    setActing(true);
    try {
      await markAllNotificationsRead(client);
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark all as read.');
    } finally {
      setActing(false);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Notifications</h1>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <Button
            variant="secondary"
            onClick={() => setUnreadOnly((prev) => !prev)}
            aria-pressed={unreadOnly}
          >
            {unreadOnly ? 'Show all' : 'Unread only'}
          </Button>
          {unreadCount > 0 && (
            <Button
              variant="secondary"
              onClick={() => {
                void handleMarkAllRead();
              }}
              disabled={acting}
            >
              Mark all as read
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {loading ? (
        <Spinner label="Loading notifications…" />
      ) : notifications.length === 0 ? (
        <Card title="No notifications">
          <p className="muted">
            {unreadOnly
              ? 'You have no unread notifications.'
              : 'You have no notifications at this time.'}
          </p>
        </Card>
      ) : (
        <div className="grid">
          {notifications.map((item) => (
            <Card key={item.id} title={item.title}>
              <div
                style={{ display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}
              >
                <Badge>{item.category}</Badge>
                {!item.read_at && <Badge>Unread</Badge>}
              </div>
              <p>{item.body}</p>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 'var(--space-3)',
                }}
              >
                <small className="muted">{new Date(item.created_at).toLocaleDateString()}</small>
                {!item.read_at && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void handleMarkRead(item.id);
                    }}
                    disabled={acting}
                  >
                    Mark as read
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
