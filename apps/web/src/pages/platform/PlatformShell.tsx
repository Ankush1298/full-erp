import React, { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { getPlatformToken, platformApi, setPlatformToken } from '../../lib/api/platform-api';
import { PlatformErrorBoundary } from './PlatformErrorBoundary';

interface NavItem {
  path: string;
  label: string;
  badge?: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    path: '/platform',
    label: 'Executive Dashboard',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="7" height="9" x="3" y="3" rx="1" />
        <rect width="7" height="5" x="14" y="3" rx="1" />
        <rect width="7" height="9" x="14" y="12" rx="1" />
        <rect width="7" height="5" x="3" y="16" rx="1" />
      </svg>
    ),
  },
  {
    path: '/platform/institutions',
    label: 'Institutions Directory',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
        <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
        <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
        <path d="M10 6h4" />
        <path d="M10 10h4" />
        <path d="M10 14h4" />
        <path d="M10 18h4" />
      </svg>
    ),
  },
  {
    path: '/platform/entitlements',
    label: 'Module Marketplace',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m7.5 4.27 9 5.15" />
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
    ),
  },
  {
    path: '/platform/plans',
    label: 'SaaS Plans & Pricing',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect width="20" height="14" x="2" y="5" rx="2" />
        <line x1="2" x2="22" y1="10" y2="10" />
      </svg>
    ),
  },
  {
    path: '/platform/roles',
    label: 'Universal Role Matrix',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <circle cx="12" cy="11" r="2" />
        <path d="m12 13 1 3" />
      </svg>
    ),
  },
  {
    path: '/platform/audit',
    label: 'Platform Audit Stream',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
        <path d="M19 17V5a2 2 0 0 0-2-2H4" />
        <path d="M15 8h-5" />
        <path d="M15 12h-5" />
      </svg>
    ),
  },
];

export const PlatformShell: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [tokenInput, setTokenInput] = useState(getPlatformToken());
  const [tokenRevision, setTokenRevision] = useState(0);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [globalSearch, setGlobalSearch] = useState('');

  // Sidebar collapse state (desktop)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Mobile drawer state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Mobile account popover state
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // Session state
  const [authenticatedOperator, setAuthenticatedOperator] = useState<{ role: string } | null>(null);

  // Close menus on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setAccountMenuOpen(false);
  }, [location.pathname]);

  // Handle Escape key dismissal for drawer and account popover
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
        setAccountMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    let mounted = true;
    platformApi
      .getMe()
      .then((res) => {
        if (mounted && res?.role) {
          setAuthenticatedOperator({ role: res.role });
        }
      })
      .catch(() => {
        // Fallback to in-memory key if session cookie not established
      });
    return () => {
      mounted = false;
    };
  }, [tokenRevision]);

  const handleSaveToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    try {
      const res = await platformApi.login(tokenInput.trim());
      setPlatformToken(tokenInput.trim());
      setAuthenticatedOperator({ role: res.role || 'OPERATOR' });
      setTokenSaved(true);
      setTokenRevision((previous) => previous + 1);
      setTimeout(() => {
        setTokenSaved(false);
        setShowTokenModal(false);
      }, 500);
    } catch (err) {
      setLoginError((err as Error).message || 'Invalid operator credentials');
    }
  };

  const handleLogout = async () => {
    try {
      await platformApi.logout();
    } catch {
      // ignore
    }
    setAuthenticatedOperator(null);
    setPlatformToken('');
    setTokenRevision((prev) => prev + 1);
  };

  const isActive = (path: string) => {
    if (path === '/platform') {
      return location.pathname === '/platform' || location.pathname === '/platform/';
    }
    return location.pathname.startsWith(path);
  };

  const getPageTitle = () => {
    const p = location.pathname;
    if (p === '/platform' || p === '/platform/') return 'Executive Overview';
    if (p.startsWith('/platform/institutions/')) return 'Institution Administration';
    if (p.startsWith('/platform/institutions')) return 'Institutions Directory';
    if (p.startsWith('/platform/entitlements')) return 'Module Marketplace & Entitlements';
    if (p.startsWith('/platform/plans')) return 'SaaS Plans & Pricing';
    if (p.startsWith('/platform/roles')) return 'Universal Role Matrix';
    if (p.startsWith('/platform/audit')) return 'Platform Audit Stream';
    return 'Platform Control Center';
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (globalSearch.trim()) {
      void navigate(`/platform/institutions?search=${encodeURIComponent(globalSearch.trim())}`);
    }
  };

  return (
    <div className={`platform-layout ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      {/* Mobile Drawer Backdrop */}
      {mobileMenuOpen && (
        <div
          className="platform-drawer-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Account Popover Backdrop */}
      {accountMenuOpen && (
        <div
          className="platform-popover-backdrop"
          onClick={() => setAccountMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Sidebar (Desktop Rail + Mobile Overlay Drawer) */}
      <aside
        className={`platform-sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${mobileMenuOpen ? 'mobile-open' : ''}`}
        aria-label="Platform navigation"
        role={mobileMenuOpen ? 'dialog' : undefined}
        aria-modal={mobileMenuOpen ? 'true' : undefined}
      >
        <div className="sidebar-top-section">
          {/* Brand Logo & Title with Mobile Close Button */}
          <div className="platform-brand">
            <div className="platform-logo-badge" title="Anesa Campus OS Platform">
              AO
            </div>
            {!sidebarCollapsed && (
              <div className="platform-title-group">
                <h1 className="platform-title">ANESA CAMPUS OS</h1>
                <span className="platform-subtitle">Platform Owner Control Center</span>
              </div>
            )}
            {/* Mobile Close Button */}
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation drawer"
            >
              ×
            </button>
          </div>

          {!sidebarCollapsed && <div className="sidebar-section-title">PLATFORM MANAGEMENT</div>}

          {/* Navigation Links with Professional SVGs */}
          <nav className="platform-nav" aria-label="Main platform routes">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`platform-nav-link ${active ? 'active' : ''}`}
                  title={sidebarCollapsed ? item.label : undefined}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  {!sidebarCollapsed && <span className="nav-label">{item.label}</span>}
                  {!sidebarCollapsed && item.badge && (
                    <span className="nav-badge">{item.badge}</span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="platform-sidebar-footer">
          {sidebarCollapsed ? (
            <button
              type="button"
              className="collapsed-security-icon-btn"
              onClick={() => setShowTokenModal(true)}
              title="Configure Security Credentials"
              aria-label="Configure Security Credentials"
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </button>
          ) : (
            <div className="platform-security-card">
              <div className="security-card-illustration" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <div className="security-card-title">Security Enclave</div>
              <div className="security-card-subtitle">Zero-Access Tenant Isolation</div>
              <button
                type="button"
                className="security-card-btn"
                onClick={() => setShowTokenModal(true)}
              >
                Configure Credentials
              </button>
            </div>
          )}

          {/* Quick Exit to School ERP for Mobile Drawer */}
          <div className="sidebar-quick-actions">
            <Link
              to="/dashboard"
              className="sidebar-exit-link"
              onClick={() => setMobileMenuOpen(false)}
            >
              ← Return to Campus ERP
            </Link>
          </div>

          {!sidebarCollapsed && (
            <div className="platform-version-tag">Platform API v1.0 • DB: PostgreSQL 16</div>
          )}
        </div>
      </aside>

      {/* Main Content Area Container */}
      <div className="platform-main-container">
        {/* Top Header Bar */}
        <header className="platform-topbar">
          <div className="platform-topbar-left">
            {/* Desktop-only collapse/expand arrow button */}
            <button
              type="button"
              className={`topbar-collapse-btn ${sidebarCollapsed ? 'is-collapsed' : ''}`}
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!sidebarCollapsed}
            >
              {sidebarCollapsed ? '→' : '←'}
            </button>

            {/* Mobile-only hamburger toggle button */}
            <button
              type="button"
              className="topbar-mobile-menu-btn"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              title="Open navigation menu"
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
            >
              ☰
            </button>

            {/* Fluid truncated page heading */}
            <div className="topbar-heading-wrap">
              <span className="topbar-heading">{getPageTitle()}</span>
            </div>
          </div>

          {/* Desktop Search Input */}
          <form onSubmit={handleSearchSubmit} className="platform-topbar-search">
            <span className="topbar-search-icon" aria-hidden="true">
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
                <circle cx="11" cy="11" r="8" />
                <line x1="21" x2="16.65" y1="21" y2="16.65" />
              </svg>
            </span>
            <input
              type="search"
              placeholder="Search institutions, modules, operational logs..."
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              className="topbar-search-input"
              aria-label="Global search"
            />
          </form>

          {/* Actions Container */}
          <div className="platform-topbar-actions">
            {/* Desktop-only expanded action badges */}
            <div className="desktop-actions">
              <div
                className="platform-health-pill"
                title="Strict physical schema isolation enforced"
              >
                <span className="platform-health-dot" />
                <span className="platform-health-text">Zero-Access Isolation: Active</span>
              </div>

              <button
                type="button"
                className="platform-operator-badge-btn"
                onClick={() => setShowTokenModal(true)}
                title="Configure Platform Operator Credentials"
              >
                <span className="operator-role-tag">OPERATOR</span>
                <span className="operator-token-preview">
                  {authenticatedOperator ? 'Active' : tokenInput ? 'Configured' : 'Missing'}
                </span>
              </button>

              {authenticatedOperator && (
                <button
                  type="button"
                  className="platform-btn-logout"
                  onClick={() => {
                    void handleLogout();
                  }}
                  title="End Operator Session"
                >
                  Sign Out
                </button>
              )}

              <Link
                to="/dashboard"
                className="platform-exit-link"
                title="Return to Institution Portal"
              >
                ← Switch to School ERP
              </Link>
            </div>

            {/* Mobile & Tablet Compact Account Toggle Button */}
            <div className="mobile-actions-wrap">
              <button
                type="button"
                className={`topbar-mobile-account-btn ${accountMenuOpen ? 'is-active' : ''}`}
                onClick={() => setAccountMenuOpen(!accountMenuOpen)}
                aria-label="Operator account and platform actions"
                aria-expanded={accountMenuOpen}
              >
                <span className="mobile-operator-icon" aria-hidden="true">
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
                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <span className="mobile-account-tag">ADMIN</span>
                <span className="mobile-account-dot" />
              </button>

              {/* Mobile Account Popover Menu */}
              {accountMenuOpen && (
                <div
                  className="platform-account-popover"
                  role="dialog"
                  aria-label="Operator quick actions"
                >
                  <div className="popover-header">
                    <div className="popover-identity">
                      <span className="operator-role-tag">OPERATOR ENCLAVE</span>
                      <span className="popover-token-info">
                        {authenticatedOperator
                          ? 'Active Session'
                          : `Key: ••••${tokenInput.slice(-4)}`}
                      </span>
                    </div>
                    <div className="popover-health-badge">
                      <span className="platform-health-dot" />
                      <span>Zero-Access Isolation</span>
                    </div>
                  </div>

                  <div className="popover-actions">
                    <button
                      type="button"
                      className="popover-action-btn"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        setShowTokenModal(true);
                      }}
                    >
                      Configure Operator Key
                    </button>

                    <Link
                      to="/dashboard"
                      className="popover-action-btn popover-action-link"
                      onClick={() => setAccountMenuOpen(false)}
                    >
                      ← Return to Campus ERP
                    </Link>

                    {authenticatedOperator && (
                      <button
                        type="button"
                        className="popover-action-btn popover-action-logout"
                        onClick={() => {
                          setAccountMenuOpen(false);
                          void handleLogout();
                        }}
                      >
                        Sign Out
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Page Content Outlet with Contained Error Boundary */}
        <main className="platform-main" id="platform-main-content">
          <PlatformErrorBoundary>
            <Outlet key={tokenRevision} />
          </PlatformErrorBoundary>
        </main>
      </div>

      {/* Operator Credential & Session Modal */}
      {showTokenModal && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowTokenModal(false);
          }}
        >
          <div
            className="platform-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="token-modal-title"
          >
            <div className="platform-modal-header">
              <h2 id="token-modal-title">Platform Operator Authentication</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowTokenModal(false)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>
            <form
              onSubmit={(e) => {
                void handleSaveToken(e);
              }}
              className="platform-modal-body"
            >
              <p className="modal-desc">
                The Platform Owner Control Center communicates through a dedicated platform
                administration channel using independent credentials.
              </p>

              {loginError && (
                <div className="form-error-alert" role="alert">
                  {loginError}
                </div>
              )}

              <div className="form-group">
                <label htmlFor="platform-token-input">Operator Secret Key</label>
                <input
                  id="platform-token-input"
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Enter operator token..."
                  className="platform-input"
                  required
                />
                <span className="input-hint">Default Dev Key: change_me</span>
              </div>
              <div className="platform-modal-actions">
                <button
                  type="button"
                  className="platform-btn platform-btn-secondary"
                  onClick={() => setShowTokenModal(false)}
                >
                  Cancel
                </button>
                <button type="submit" className="platform-btn platform-btn-primary">
                  {tokenSaved ? 'Authenticated!' : 'Save & Authenticate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
