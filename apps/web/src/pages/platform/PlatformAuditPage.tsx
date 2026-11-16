import React, { useEffect, useState } from 'react';
import { platformApi } from '../../lib/api/platform-api';

interface AuditItem {
  id: string;
  occurredAt: string;
  action: string;
  resourceType: string;
  riskTier: number;
  actorType: string;
  organizationName?: string;
  reasonText?: string;
}

export const PlatformAuditPage: React.FC = () => {
  const [events, setEvents] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = () => {
    setLoading(true);
    platformApi
      .getAuditEvents(100)
      .then((data) => {
        setEvents(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchEvents();
  }, []);

  if (loading) {
    return (
      <div className="platform-loading-container" aria-live="polite">
        <div className="platform-spinner" />
        <p>Loading immutable security audit stream...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="platform-error-container" role="alert">
        <h2>Unable to load audit stream</h2>
        <p className="error-text">{error}</p>
        <button type="button" className="platform-btn platform-btn-primary" onClick={fetchEvents}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="platform-page">
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">Platform Audit & Security Event Stream</h2>
          <p className="platform-page-desc">
            Immutable append-only audit trail capturing security-sensitive actions, privilege escalations, authentication challenges, and authorization denials.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="platform-btn platform-btn-secondary" onClick={fetchEvents}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
            Refresh Audit Stream
          </button>
        </div>
      </div>

      <div className="platform-card p-0 mt-6">
        <div className="platform-table-container">
          <table className="platform-table" aria-label="Platform security audit log">
          <thead>
            <tr>
              <th scope="col">Event ID / Time</th>
              <th scope="col">Institution</th>
              <th scope="col">Action</th>
              <th scope="col">Target Resource</th>
              <th scope="col">Risk Tier</th>
              <th scope="col">Actor Kind</th>
            </tr>
          </thead>
          <tbody>
            {events.map((evt) => (
              <tr key={evt.id}>
                <td>
                  <div className="audit-time-cell">
                    <span className="font-semibold">{new Date(evt.occurredAt).toLocaleTimeString()}</span>
                    <span className="text-muted text-xs">{new Date(evt.occurredAt).toLocaleDateString()}</span>
                  </div>
                </td>
                <td>
                  <span className="font-semibold">{evt.organizationName || 'Platform Root'}</span>
                </td>
                <td>
                  <code className="code-pill font-mono">{evt.action}</code>
                </td>
                <td>
                  <span className="resource-name">{evt.resourceType}</span>
                </td>
                <td>
                  <span className={`risk-tag risk-tag-${evt.riskTier}`}>
                    Tier {evt.riskTier}
                  </span>
                </td>
                <td>
                  <span className="actor-tag">{evt.actorType}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
};
