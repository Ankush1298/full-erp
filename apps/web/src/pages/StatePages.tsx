import { Link } from 'react-router';
import { Button } from '../components/ui/Button';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { Logo } from '../components/Logo';

function StateLayout({
  title,
  icon,
  badge,
  friendlyMessage,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  badge?: string;
  friendlyMessage?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="state-page brand-state-container">
      <div className="brand-state-card">
        {icon && (
          <div className="brand-state-icon" aria-hidden="true">
            {icon}
          </div>
        )}
        {badge && <span className="brand-state-tag">{badge}</span>}
        <h1 className="brand-state-title">{title}</h1>
        {friendlyMessage && <p className="brand-state-friendly">{friendlyMessage}</p>}
        {children}
      </div>
    </div>
  );
}

export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <StateLayout
      title="Page not found"
      badge="404"
      icon={
        <svg
          viewBox="0 0 24 24"
          width="40"
          height="40"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      }
      friendlyMessage="Looks like this page missed the timetable! 🧭"
    >
      <p className="brand-state-desc">
        The page you are looking for does not exist or you do not have access to it.
      </p>
      <div className="brand-state-actions">
        <Link className="btn btn-primary" to="/">
          Go to home
        </Link>
      </div>
    </StateLayout>
  );
}

export function ForbiddenPage() {
  usePageTitle('Access restricted');
  return (
    <StateLayout
      title="Access restricted"
      badge="403"
      icon={
        <svg
          viewBox="0 0 24 24"
          width="40"
          height="40"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      }
      friendlyMessage="This area is reserved for another campus role. 🔒"
    >
      <p className="brand-state-desc">
        Your account does not include access to this area. If you think it should, contact your
        administrator.
      </p>
      <div className="brand-state-actions">
        <Link className="btn btn-primary" to="/">
          Go to home
        </Link>
      </div>
    </StateLayout>
  );
}

/** Signed in, but the backend grants this account no role at all (403 on the identity call). */
export function NoAccessPage() {
  usePageTitle('No access assigned');
  const { logout } = useAuth();
  return (
    <main className="brand-state-page" id="main">
      <div className="brand-state-card">
        <div className="brand-state-logo">
          <Logo />
        </div>
        <div className="brand-state-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="40"
            height="40"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
            <line x1="18" y1="8" x2="23" y2="13" />
            <line x1="23" y1="8" x2="18" y2="13" />
          </svg>
        </div>
        <h1 className="brand-state-title">No access assigned</h1>
        <p className="brand-state-desc">
          You are signed in, but no role has been assigned to your account yet. Contact your
          institution’s administrator.
        </p>
        <div className="brand-state-actions">
          <Button variant="secondary" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </div>
    </main>
  );
}

export function ErrorPage({ onRetry }: { onRetry: () => void }) {
  usePageTitle('Something went wrong');
  return (
    <main className="brand-state-page brand-state-page--recovery" id="main">
      <div className="brand-state-card" role="alert">
        <div className="brand-state-logo">
          <Logo />
        </div>

        <div className="coffee-break-visual" aria-hidden="true">
          <svg
            viewBox="0 0 64 64"
            width="56"
            height="56"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="coffee-cup-icon"
          >
            <path d="M22 14c0-3 2-4 2-7" stroke="#ff7675" strokeWidth="2.5" />
            <path d="M32 14c0-3 2-4 2-7" stroke="#ff7675" strokeWidth="2.5" />
            <path d="M42 14c0-3 2-4 2-7" stroke="#ff7675" strokeWidth="2.5" />
            <path
              d="M14 20h36v20a14 14 0 0 1-14 14h-8A14 14 0 0 1 14 40V20z"
              fill="#f2edf8"
              stroke="#504175"
              strokeWidth="2"
            />
            <path
              d="M50 24h4a6 6 0 0 1 6 6v4a6 6 0 0 1-6 6h-4"
              stroke="#504175"
              strokeWidth="2"
            />
            <path d="M8 58h48" stroke="#504175" strokeWidth="2.5" />
          </svg>
        </div>

        <h1 className="brand-state-headline">
          Oops! Your campus took a little coffee break. <span aria-hidden="true">☕</span>
        </h1>

        <div className="brand-state-subhead">
          <span className="brand-state-tag">Something went wrong</span>
          <p className="brand-state-desc">
            We couldn&apos;t reconnect to your session just now. Check your connection; this is usually temporary.
          </p>
        </div>

        <div className="brand-state-actions">
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
          <Link to="/login" className="btn btn-secondary">
            Sign in again
          </Link>
        </div>
      </div>
    </main>
  );
}
