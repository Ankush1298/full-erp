import { Navigate, useLocation } from 'react-router';
import { LandingPage } from '../landing/LandingPage';
import { useAuth } from './AuthProvider';

/** Only same-app absolute paths may be used as a post-login target (no open redirect). */
export function safeRedirect(target: unknown): string {
  return typeof target === 'string' && /^\/(?!\/)[^\\\s]*$/.test(target) && target !== '/login'
    ? target
    : '/';
}

/** `/login` is the landing page with the sign-in dialog open. */
export function LoginPage() {
  const auth = useAuth();
  const location = useLocation();
  const from = safeRedirect((location.state as { from?: unknown } | null)?.from);
  if (auth.status === 'authenticated' || auth.status === 'no_access') {
    return <Navigate to={from} replace />;
  }
  return <LandingPage signInOpen from={from} />;
}
