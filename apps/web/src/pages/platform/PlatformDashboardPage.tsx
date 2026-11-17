import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { platformApi, type PlatformStats } from '../../lib/api/platform-api';

function isDevMock(status: string): boolean {
  return /mock|in-memory|sandbox|dev/i.test(status);
}

export const PlatformDashboardPage: React.FC = () => {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    platformApi
      .getStats()
      .then((data) => {
        if (mounted) {
          setStats(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="platform-loading-container" aria-live="polite">
        <div className="platform-spinner" />
        <p>Loading real-time platform metrics from PostgreSQL...</p>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="platform-error-container" role="alert">
        <h2>Unable to load platform control metrics</h2>
        <p className="error-text">{error || 'Unknown error occurred'}</p>
        <button
          type="button"
          className="platform-btn platform-btn-primary"
          onClick={() => window.location.reload()}
        >
          Retry Connection
        </button>
      </div>
    );
  }

  const { institutions, subscriptions, moduleAdoption, operationalHealth, recentAuditAlerts } =
    stats;

  return (
    <div className="platform-page">
      {/* Standard Anesa Page Header */}
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">Executive Control Dashboard</h2>
          <p className="platform-page-desc">
            Multi-tenant ERP operational telemetry, institutional adoption, and cross-realm security
            status.
          </p>
        </div>
        <div className="platform-page-actions">
          <Link
            to="/platform/institutions?action=new"
            className="platform-btn platform-btn-primary"
          >
            + Provision Institution
          </Link>
        </div>
      </div>

      {/* KPI Stat Cards Row (Aligned with Anesa StatCard Design) */}
      <div className="platform-stat-grid">
        {/* Total Institutions */}
        <div className="stat-card stat-card--purple">
          <div className="stat-card-header">
            <span className="stat-card-label">Total Institutions</span>
            <span className="stat-card-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
              </svg>
            </span>
          </div>
          <div className="stat-card-body">
            <span className="stat-card-value">{institutions.total}</span>
            <span className="stat-card-helper">
              {institutions.active} Active • {institutions.schools} Schools, {institutions.colleges}{' '}
              Colleges, {institutions.universities} Universities
            </span>
          </div>
        </div>

        {/* Active Subscriptions */}
        <div className="stat-card stat-card--emerald">
          <div className="stat-card-header">
            <span className="stat-card-label">Active Subscriptions</span>
            <span className="stat-card-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <line x1="2" x2="22" y1="10" y2="10" />
              </svg>
            </span>
          </div>
          <div className="stat-card-body">
            <span className="stat-card-value">{subscriptions.active}</span>
            <span className="stat-card-helper">
              {subscriptions.trial} In Evaluation Trial • Complete & Academic Plus
            </span>
          </div>
        </div>

        {/* Operational Health */}
        <div className="stat-card stat-card--emerald">
          <div className="stat-card-header">
            <span className="stat-card-label">Operational Health</span>
            <span className="stat-card-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
              </svg>
            </span>
          </div>
          <div className="stat-card-body">
            <span className="stat-card-value text-emerald-700">100% SLA</span>
            <span className="stat-card-helper">
              Active Pool: {operationalHealth.databaseConnections} Handles • Uptime:{' '}
              {Math.floor(operationalHealth.serverUptimeSeconds / 60)}m
            </span>
          </div>
        </div>

        {/* Security & Antivirus Scanner */}
        <div className="stat-card stat-card--amber">
          <div className="stat-card-header">
            <span className="stat-card-label">Security & Audit Alerts</span>
            <span className="stat-card-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </span>
          </div>
          <div className="stat-card-body">
            <span className="stat-card-value">{stats.securityAlertsCount} Alerts</span>
            <span className="stat-card-helper">
              Zero-Access Isolation • {recentAuditAlerts.length} Logged Audit Events
            </span>
          </div>
        </div>
      </div>

      {/* Main Content Grid: Fleet Overview + Infrastructure Status */}
      <div className="platform-dashboard-grid">
        {/* Left 2 Cols: Institutional Segments & Module Adoption */}
        <div className="platform-dashboard-main">
          {/* Institutional Segments Card with Reference Gradient Pills */}
          <div className="platform-card">
            <div className="platform-card-header mb-4">
              <div>
                <h3 className="card-title">Institutional Fleet Composition</h3>
                <p className="card-subtitle">
                  Active distribution across higher education and school segments
                </p>
              </div>
            </div>

            <div className="fleet-pill-grid">
              <div className="fleet-gradient-pill fleet-gradient-pill--coral">
                <div className="pill-top-row">
                  <span className="pill-badge">K-12 School</span>
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
                    <path d="M6 12v5c3 3 9 3 12 0v-5" />
                  </svg>
                </div>
                <div>
                  <div className="pill-count">{institutions.schools}</div>
                  <div className="pill-label">Schools (CBSE, ICSE & State Boards)</div>
                </div>
              </div>

              <div className="fleet-gradient-pill fleet-gradient-pill--peach">
                <div className="pill-top-row">
                  <span className="pill-badge">Colleges & Poly</span>
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
                  </svg>
                </div>
                <div>
                  <div className="pill-count">{institutions.colleges}</div>
                  <div className="pill-label">Polytechnic & Degree Campuses</div>
                </div>
              </div>

              <div className="fleet-gradient-pill fleet-gradient-pill--indigo">
                <div className="pill-top-row">
                  <span className="pill-badge">Universities</span>
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                    <path d="M2 12h20" />
                  </svg>
                </div>
                <div>
                  <div className="pill-count">{institutions.universities}</div>
                  <div className="pill-label">Multi-Campus Systems & Higher Ed</div>
                </div>
              </div>
            </div>
          </div>

          {/* Reference Design Dual Charts: Bicolor Bar Chart & Circular Donut Chart */}
          <div className="charts-dual-grid">
            {/* Bar Chart Card */}
            <div className="platform-card chart-card-inner">
              <div className="platform-card-header mb-2 flex justify-between items-center">
                <div>
                  <h3 className="card-title">Cluster Telemetry & Load</h3>
                  <p className="card-subtitle">Monthly authenticated API throughput & workloads</p>
                </div>
                <span className="text-xs font-semibold px-2 py-1 rounded bg-slate-100 text-slate-700">
                  2026
                </span>
              </div>
              <div className="chart-bar-container">
                <svg
                  viewBox="0 0 320 120"
                  className="chart-bar-svg"
                  fill="none"
                  aria-label="Monthly Telemetry Load Bar Chart"
                >
                  <defs>
                    <linearGradient id="purpleBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#504175" />
                      <stop offset="100%" stopColor="#7B68A6" />
                    </linearGradient>
                    <linearGradient id="coralBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#FF6584" />
                      <stop offset="100%" stopColor="#FFA958" />
                    </linearGradient>
                  </defs>
                  {/* Subtle grid lines */}
                  <line
                    x1="10"
                    y1="20"
                    x2="310"
                    y2="20"
                    stroke="#F1F0F5"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <line
                    x1="10"
                    y1="60"
                    x2="310"
                    y2="60"
                    stroke="#F1F0F5"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  <line x1="10" y1="100" x2="310" y2="100" stroke="#E5E3EC" strokeWidth="1" />

                  {/* 12 Months Bicolor Rounded Bars */}
                  {[
                    { m: 'J', h1: 35, h2: 25, x: 20 },
                    { m: 'F', h1: 45, h2: 30, x: 44 },
                    { m: 'M', h1: 60, h2: 20, x: 68 },
                    { m: 'A', h1: 50, h2: 35, x: 92 },
                    { m: 'M', h1: 70, h2: 18, x: 116 },
                    { m: 'J', h1: 40, h2: 22, x: 140 },
                    { m: 'J', h1: 65, h2: 25, x: 164 },
                    { m: 'A', h1: 55, h2: 30, x: 188 },
                    { m: 'S', h1: 75, h2: 15, x: 212 },
                    { m: 'O', h1: 50, h2: 28, x: 236 },
                    { m: 'N', h1: 68, h2: 22, x: 260 },
                    { m: 'D', h1: 82, h2: 12, x: 284 },
                  ].map((bar, idx) => (
                    <g key={idx}>
                      {/* Top purple segment */}
                      <rect
                        x={bar.x}
                        y={100 - (bar.h1 + bar.h2)}
                        width="10"
                        height={bar.h1}
                        rx="5"
                        fill="url(#purpleBarGrad)"
                      />
                      {/* Bottom coral/peach segment */}
                      <rect
                        x={bar.x}
                        y={100 - bar.h2}
                        width="10"
                        height={bar.h2}
                        rx="4"
                        fill="url(#coralBarGrad)"
                      />
                      <text
                        x={bar.x + 5}
                        y="114"
                        fontSize="8"
                        fill="#887F9E"
                        textAnchor="middle"
                        fontWeight="600"
                      >
                        {bar.m}
                      </text>
                    </g>
                  ))}
                </svg>
                <div className="chart-legend-row justify-center">
                  <span>
                    <span className="chart-legend-dot" style={{ background: '#504175' }} />
                    Core ERP Traffic
                  </span>
                  <span>
                    <span className="chart-legend-dot" style={{ background: '#FF6584' }} />
                    Auth & Security Scans
                  </span>
                </div>
              </div>
            </div>

            {/* Circular Donut Chart Card */}
            <div className="platform-card chart-card-inner">
              <div className="platform-card-header mb-2">
                <h3 className="card-title">Global Telemetry & Health</h3>
                <p className="card-subtitle">Active multi-tenant isolation compliance</p>
              </div>
              <div className="chart-donut-container">
                <div className="chart-donut-wrap">
                  <svg
                    width="120"
                    height="120"
                    viewBox="0 0 120 120"
                    className="chart-donut-svg"
                  >
                    <circle cx="60" cy="60" r="46" stroke="#F1EDF8" strokeWidth="14" fill="none" />
                    {/* Ring segment 1: Purple (60%) */}
                    <circle
                      cx="60"
                      cy="60"
                      r="46"
                      stroke="#504175"
                      strokeWidth="14"
                      fill="none"
                      strokeDasharray="289"
                      strokeDashoffset="115"
                      strokeLinecap="round"
                    />
                    {/* Ring segment 2: Emerald (20%) */}
                    <circle
                      cx="60"
                      cy="60"
                      r="46"
                      stroke="#12723A"
                      strokeWidth="14"
                      fill="none"
                      strokeDasharray="289"
                      strokeDashoffset="230"
                      strokeLinecap="round"
                    />
                    {/* Ring segment 3: Coral (12%) */}
                    <circle
                      cx="60"
                      cy="60"
                      r="46"
                      stroke="#FF6584"
                      strokeWidth="14"
                      fill="none"
                      strokeDasharray="289"
                      strokeDashoffset="255"
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className="chart-donut-center">
                    <span className="chart-donut-value">100%</span>
                    <span className="chart-donut-label">SLA Up</span>
                  </div>
                </div>
                <div className="chart-legend-row justify-center mt-3">
                  <span>
                    <span className="chart-legend-dot" style={{ background: '#504175' }} />
                    Active Campuses
                  </span>
                  <span>
                    <span className="chart-legend-dot" style={{ background: '#12723A' }} />
                    DB Pools
                  </span>
                  <span>
                    <span className="chart-legend-dot" style={{ background: '#FF6584' }} />
                    Enclave
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Module Adoption Across Fleet */}
          <div className="platform-card">
            <div className="platform-card-header mb-4 flex justify-between items-center">
              <div>
                <h3 className="card-title">ERP Module Adoption Across Fleet</h3>
                <p className="card-subtitle">
                  Active tenant entitlements across the 14 official Anesa ERP capabilities
                </p>
              </div>
              <Link
                to="/platform/entitlements"
                className="text-xs font-bold text-purple-900 hover:underline"
              >
                Marketplace Catalog →
              </Link>
            </div>

            <div className="module-adoption-grid">
              {Object.entries(moduleAdoption).map(([key, count]) => {
                const percentage =
                  institutions.total > 0 ? Math.round((count / institutions.total) * 100) : 0;
                return (
                  <div key={key} className="module-adoption-item">
                    <div className="module-adoption-header">
                      <span>{key.replace('_', ' ').toUpperCase()}</span>
                      <span className="module-adoption-count">
                        {count}/{institutions.total} ({percentage}%)
                      </span>
                    </div>
                    <div className="module-adoption-track">
                      <div
                        className="module-adoption-bar"
                        style={{ width: `${Math.max(percentage, 6)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Security Alerts and Audit Warnings Table */}
          <div className="platform-card">
            <div className="platform-card-header mb-4 flex justify-between items-center">
              <div>
                <h3 className="card-title">Recent Security Events & Privilege Audits</h3>
                <p className="card-subtitle">
                  Immutable audit trail streamed from platform middleware
                </p>
              </div>
              <Link
                to="/platform/audit"
                className="text-xs font-bold text-purple-900 hover:underline"
              >
                Full Audit Stream →
              </Link>
            </div>

            {recentAuditAlerts.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500 border rounded-lg bg-slate-50">
                No high-risk security warnings or authorization denials recorded in this period.
              </div>
            ) : (
              <div className="platform-table-container">
                <table className="platform-table" aria-label="Recent platform audit alerts">
                  <thead>
                    <tr>
                      <th scope="col">Timestamp</th>
                      <th scope="col">Institution</th>
                      <th scope="col">Action</th>
                      <th scope="col">Resource</th>
                      <th scope="col">Risk Tier</th>
                      <th scope="col">Actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentAuditAlerts.map((alert) => (
                      <tr key={alert.id}>
                        <td className="text-slate-500 text-xs">
                          {new Date(alert.occurredAt).toLocaleString()}
                        </td>
                        <td className="font-semibold text-xs">
                          {alert.organizationName || 'System'}
                        </td>
                        <td>
                          <code className="text-xs px-1.5 py-0.5 rounded bg-slate-100 font-mono text-slate-800">
                            {alert.action}
                          </code>
                        </td>
                        <td className="text-xs text-slate-600">{alert.resourceType}</td>
                        <td>
                          <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-900">
                            Tier {alert.riskTier}
                          </span>
                        </td>
                        <td>
                          <span className="text-xs text-slate-500 font-medium">
                            {alert.actorType}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right 1 Col: Infrastructure Services & Zero-Access Enclave */}
        <div className="platform-dashboard-sidebar">
          {/* Spotlight Hero Card (Matching Reference Spotlight Layout) */}
          <div className="platform-spotlight-hero">
            <div className="spotlight-banner">
              <div className="spotlight-title-row">
                <span className="spotlight-badge">ROOT ENCLAVE</span>
                <span className="text-xs text-purple-200 font-mono">v3.1 Core</span>
              </div>
              <h3 className="spotlight-realm-name">Cluster Infrastructure Engine</h3>
              <p className="spotlight-realm-desc">
                Live health status of backend container, storage services & multi-tenant RLS.
              </p>
            </div>

            <div className="spotlight-body">
              <div className="spotlight-metrics-list">
                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Database Subsystem</span>
                  <span className="status-tag status-tag--emerald">
                    {operationalHealth.database}
                  </span>
                </div>

                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Active Connection Pool</span>
                  <span className="spotlight-metric-value">
                    {operationalHealth.databaseConnections} client handles
                  </span>
                </div>

                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Object Storage Engine</span>
                  <span className="status-tag status-tag--emerald">
                    {operationalHealth.storageDriver}
                  </span>
                </div>

                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Malware Scanner</span>
                  <span className="status-tag status-tag--emerald">
                    {operationalHealth.malwareScanner}
                  </span>
                </div>

                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Email Gateway</span>
                  <span
                    className={`status-tag ${isDevMock(operationalHealth.emailDelivery)
                      ? 'status-tag--amber'
                      : 'status-tag--emerald'
                      }`}
                    title={
                      isDevMock(operationalHealth.emailDelivery)
                        ? 'Development mock transport active'
                        : 'Live transactional SMTP active'
                    }
                  >
                    {operationalHealth.emailDelivery}
                  </span>
                </div>

                <div className="spotlight-metric-row">
                  <span className="spotlight-metric-label">Continuous Process Uptime</span>
                  <span className="spotlight-metric-value">
                    {Math.floor(operationalHealth.serverUptimeSeconds / 60)} minutes
                  </span>
                </div>
              </div>

              {/* Zero-Access Separation Guarantee Box */}
              <div className="guarded-guarantee-list mt-3">
                <strong>Strict Multi-Tenant Separation Guarantee:</strong>
                <p className="mt-1">
                  Platform operations run in a dedicated administrative realm. Platform credentials
                  have zero read access to student grades, exam answer scripts, parent PII, or
                  School Vault keys.
                </p>
              </div>
            </div>
          </div>

          {/* Quick Platform Actions Card */}
          <div className="platform-card">
            <h3 className="card-title mb-3">Operator Quick Actions</h3>
            <div className="operator-actions-list">
              <Link
                to="/platform/institutions"
                className="platform-btn platform-btn-secondary text-left justify-start"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                </svg>
                Manage Institutions Directory
              </Link>
              <Link
                to="/platform/entitlements"
                className="platform-btn platform-btn-secondary text-left justify-start"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                </svg>
                Configure Module Entitlements
              </Link>
              <Link
                to="/platform/plans"
                className="platform-btn platform-btn-secondary text-left justify-start"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="20" height="14" x="2" y="5" rx="2" />
                </svg>
                Review SaaS Plans & Pricing
              </Link>
              <Link
                to="/platform/audit"
                className="platform-btn platform-btn-secondary text-left justify-start"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
                </svg>
                View Platform Audit Stream
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
