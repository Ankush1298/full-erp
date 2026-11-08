import { useEffect, useRef, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { fetchMfaStatus, type MfaStatus } from '../../lib/api/mfa-api';
import { genericErrorMessage } from '../../lib/api/messages';
import { LandingPage } from '../landing/LandingPage';
import { useAuth } from './AuthProvider';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnrollment } from './MfaEnrollment';

export function MfaPrompt() {
  const { client, setMfaRequired, logout } = useAuth();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

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

  // Trap focus within the modal dialog, prevent body scrolling, and close on Escape.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void logout();
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [logout]);

  const handleBackdropMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      void logout();
    }
  };

  const renderModalContent = () => {
    if (loading) {
      return (
        <div style={{ textAlign: 'center', padding: 'var(--space-6) 0' }}>
          <Spinner label="Checking authentication status…" />
        </div>
      );
    }

    if (error || !status) {
      return (
        <>
          <h1 id="mfa-title">Authentication error</h1>
          <p className="muted">There was a problem checking your two-factor requirements.</p>
          <Alert tone="error">{error || 'Unable to check authentication requirements.'}</Alert>
          <Button
            type="button"
            variant="secondary"
            className="btn-block"
            style={{ marginTop: 'var(--space-4)' }}
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </Button>
        </>
      );
    }

    if (status.enrolled) {
      return (
        <MfaChallenge
          onSuccess={() => setMfaRequired(false)}
          onCancel={() => {
            void logout();
          }}
          inModal
          headingId="mfa-title"
        />
      );
    }

    return (
      <MfaEnrollment
        isMfaRequired={status.required}
        onComplete={() => setMfaRequired(false)}
        onCancel={() => {
          void logout();
        }}
        inModal
        headingId="mfa-title"
      />
    );
  };

  return (
    <LandingPage pageTitle="Two-factor authentication">
      <div role="presentation" className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
        <div
          ref={dialogRef}
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mfa-title"
        >
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={() => {
              void logout();
            }}
          >
            ×
          </button>
          {renderModalContent()}
        </div>
      </div>
    </LandingPage>
  );
}
