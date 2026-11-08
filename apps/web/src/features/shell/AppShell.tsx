import { Component, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Button } from '../../components/ui/Button';
import { ErrorState } from '../../components/ui/ErrorState';
import { Logo } from '../../components/Logo';
import { Footer } from '../../components/Footer';
import { BotanicalIllustration } from './BotanicalIllustration';
import { useAuth } from '../auth/AuthProvider';
import { roleLabel } from '../auth/identity';
import { visibleNav } from './navigation';

interface ShellErrorBoundaryProps {
  children: ReactNode;
}

interface ShellErrorBoundaryState {
  hasError: boolean;
  error?: Error | null;
}

export class ShellErrorBoundary extends Component<
  ShellErrorBoundaryProps,
  ShellErrorBoundaryState
> {
  constructor(props: ShellErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ShellErrorBoundaryState {
    return { hasError: true, error };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem 1.5rem', maxWidth: '720px', margin: '0 auto' }}>
          <ErrorState
            title="An error occurred while displaying this page"
            message={
              this.state.error?.message ||
              'A rendering issue prevented this page from displaying correctly. Try refreshing or navigating to another section.'
            }
            onRetry={() => this.setState({ hasError: false, error: null })}
            retryLabel="Reload section"
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function AccountMenu() {
  const { identity, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    const onClick = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  if (!identity) return null;

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await logout(); // always clears local state, even if the request fails
    } finally {
      void navigate('/login', { replace: true });
    }
  }

  return (
    <div className="account" ref={root}>
      <button
        ref={toggle}
        type="button"
        className="account-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {identity.displayName.trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="account-name">{identity.displayName || 'Account'}</span>
      </button>
      {open ? (
        <div id={panelId} className="account-panel">
          <div className="account-panel-header">
            <span className="account-panel-name">{identity.displayName || 'Account'}</span>
            <p className="account-roles">
              {identity.roles.map((r) => roleLabel(r, identity)).join(', ') || 'No role'}
            </p>
          </div>
          <div className="account-panel-divider" role="separator" />
          <NavLink to="/account" onClick={() => setOpen(false)}>
            Account
          </NavLink>
          <Button variant="secondary" pending={signingOut} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NavIcon({ id }: { id: string }) {
  switch (id) {
    case 'home':
      return (
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
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'students':
    case 'my-profile':
      return (
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
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5" />
        </svg>
      );
    case 'users':
      return (
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
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'academics':
      return (
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
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <line x1="8" y1="6" x2="16" y2="6" />
          <line x1="8" y1="10" x2="14" y2="10" />
        </svg>
      );
    case 'attendance':
      return (
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
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
          <path d="m9 16 2 2 4-4" />
        </svg>
      );
    case 'examinations':
      return (
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
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="m9 15 2 2 4-4" />
        </svg>
      );
    case 'finance':
      return (
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
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
          <line x1="6" y1="15" x2="10" y2="15" />
        </svg>
      );
    case 'organisation':
      return (
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
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <path d="M9 22v-4h6v4" />
          <path d="M8 6h.01M16 6h.01M8 10h.01M16 10h.01M8 14h.01M16 14h.01" />
        </svg>
      );
    case 'access':
      return (
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
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case 'notifications':
      return (
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
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case 'documents':
      return (
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
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
    case 'consents':
      return (
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
      );
    case 'imports':
      return (
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
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    default:
      return (
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
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
  }
}

export function AppShell() {
  const { identity } = useAuth();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const navId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const shellMain = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Close the mobile drawer on navigation, reset scroll, and move focus to the new page content.
  useEffect(() => {
    setNavOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    if (typeof shellMain.current?.scrollTo === 'function') {
      shellMain.current.scrollTo({ top: 0, behavior: 'instant' });
    } else if (shellMain.current) {
      shellMain.current.scrollTop = 0;
    }
    main.current?.focus();
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  if (!identity) return null;
  const items = visibleNav(identity);
  const currentNav = items.find(
    (item) =>
      item.to !== '/' &&
      (location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)),
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <button
          ref={menuButton}
          type="button"
          className="menu-toggle"
          aria-expanded={navOpen}
          aria-controls={navId}
          onClick={() => setNavOpen((v) => !v)}
        >
          <span className="sr-only">{navOpen ? 'Close menu' : 'Open menu'}</span>
          <span className="menu-icon" aria-hidden="true" />
        </button>
        <div className="topbar-welcome">
          <span className="topbar-greeting">Welcome to Anesa</span>
          {currentNav ? (
            <span className="topbar-breadcrumb" aria-hidden="true">
              <span className="topbar-breadcrumb-sep">/</span>
              <span className="topbar-breadcrumb-label">{currentNav.label}</span>
            </span>
          ) : null}
        </div>
        <div className="topbar-search">
          <div className="search-pill">
            <input
              type="search"
              placeholder="Search..."
              aria-label="Search"
              className="search-input"
            />
            <button type="button" className="search-btn" aria-label="Submit search">
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </div>
        </div>
        <div className="topbar-actions">
          <NavLink
            to="/notifications"
            className="topbar-action-btn"
            aria-label="View notifications"
            title="Notifications"
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
              aria-hidden="true"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span className="notification-dot" aria-hidden="true" />
          </NavLink>
          <NavLink
            to="/documents"
            className="topbar-action-btn"
            aria-label="View documents"
            title="Documents"
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
              aria-hidden="true"
            >
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
              <polyline points="22,6 12,13 2,6" />
            </svg>
          </NavLink>
          <AccountMenu />
        </div>
      </header>
      <nav id={navId} className="sidenav" aria-label="Primary" data-open={navOpen || undefined}>
        <div className="sidenav-brand">
          <Logo variant="light" />
        </div>
        <ul className="sidenav-list">
          {items.map((item) => (
            <li key={item.id} className="sidenav-item">
              <NavLink to={item.to} end={item.to === '/'}>
                <span className="sidenav-icon" aria-hidden="true">
                  <NavIcon id={item.id} />
                </span>
                <span className="sidenav-label">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <BotanicalIllustration />
      </nav>
      {navOpen ? (
        <div className="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      ) : null}
      <div className="shell-main" ref={shellMain}>
        <main id="main" ref={main} tabIndex={-1} className="content">
          <ShellErrorBoundary key={location.pathname}>
            <Outlet />
          </ShellErrorBoundary>
        </main>
        <Footer />
      </div>
    </div>
  );
}
