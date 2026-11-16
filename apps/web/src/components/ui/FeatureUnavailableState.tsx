import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { MODULE_PREVIEWS, type ModuleCapability } from '../../lib/api/module-state';

export interface FeatureUnavailableStateProps {
  /** Identifier key corresponding to MODULE_PREVIEWS (e.g. 'examinations', 'homework', 'finance') */
  moduleKey?: string;
  /** Primary human-readable name of the module (e.g. 'Examinations & Results') */
  moduleName?: string;
  /** Custom capability list to display in the preview section */
  capabilities?: readonly (ModuleCapability | string)[];
  /** Custom primary title; defaults to 'This feature is not currently active' */
  primaryTitle?: string;
  /** Custom body copy text */
  bodyCopy?: string;
  /** Custom supporting copy text */
  supportingCopy?: string;
  /** Category badge text (e.g. 'Assessment & Evaluation') */
  category?: string;
  /** Whether to show the 'Back to Dashboard' button; defaults to true */
  showBackToDashboard?: boolean;
  /** Custom callback for 'Back to Dashboard' */
  onBackToDashboard?: () => void;
  /** Optional callback for requesting access */
  onRequestAccess?: () => void;
  /** Optional custom action element */
  action?: ReactNode;
  /** Additional CSS class names */
  className?: string;
}

export function FeatureUnavailableState({
  moduleKey,
  moduleName,
  capabilities,
  primaryTitle = 'This feature is not currently active',
  bodyCopy,
  supportingCopy,
  category,
  showBackToDashboard = true,
  onBackToDashboard,
  onRequestAccess,
  action,
  className = '',
}: FeatureUnavailableStateProps) {
  const [showAdminModal, setShowAdminModal] = useState(false);

  const previewConfig = moduleKey ? MODULE_PREVIEWS[moduleKey] : undefined;
  const resolvedModuleName = moduleName || previewConfig?.name || 'This module';
  const resolvedCategory = category || previewConfig?.category || 'ERP Module';

  const defaultBody = `${resolvedModuleName} is available when this module is enabled for your institution. Your workspace is working normally — this feature is simply not active right now.`;
  const defaultSupporting =
    'This feature is managed centrally for your institution. You can continue using your available Anesa Campus OS features as normal.';

  const resolvedBody = bodyCopy || defaultBody;
  const resolvedSupporting = supportingCopy || defaultSupporting;

  // Resolve preview capabilities
  const rawCapabilities = capabilities || previewConfig?.capabilities || [];
  const normalizedCapabilities: ModuleCapability[] = rawCapabilities.map((item) => {
    if (typeof item === 'string') {
      return { title: item, description: 'Streamlined enterprise workflow and capability' };
    }
    return item;
  });

  const handleBack = () => {
    if (onBackToDashboard) {
      onBackToDashboard();
    } else {
      window.location.assign('/');
    }
  };

  return (
    <div
      className={`feature-unavailable ${className}`.trim()}
      role="region"
      aria-label={primaryTitle}
    >
      {/* Hero Content */}
      <div className="feature-unavailable-hero">
        <div className="feature-unavailable-icon-wrapper" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* Elegant Sparkle / Module Lock Icon */}
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <circle cx="12" cy="16" r="1" fill="currentColor" />
          </svg>
        </div>

        <span className="feature-unavailable-badge">{resolvedCategory}</span>

        <h2 className="feature-unavailable-title">{primaryTitle}</h2>

        <p className="feature-unavailable-body">{resolvedBody}</p>

        <p className="feature-unavailable-supporting">{resolvedSupporting}</p>

        {/* Action Buttons */}
        <div className="feature-unavailable-actions">
          {showBackToDashboard && (
            <Button variant="primary" onClick={handleBack}>
              Back to Dashboard
            </Button>
          )}

          <Button variant="secondary" onClick={() => setShowAdminModal(true)}>
            Contact Administrator
          </Button>

          {onRequestAccess && (
            <Button variant="secondary" onClick={onRequestAccess}>
              Request Access
            </Button>
          )}

          {action}
        </div>
      </div>

      {/* Capability Preview Card Section */}
      {normalizedCapabilities.length > 0 && (
        <div className="feature-unavailable-preview">
          <div className="feature-unavailable-preview-header">
            <h3 className="feature-unavailable-preview-title">
              What&apos;s included in {resolvedModuleName}
            </h3>
            <p className="feature-unavailable-preview-subtitle">
              A preview of capabilities available when this module is activated for your campus:
            </p>
          </div>

          <div className="feature-unavailable-grid">
            {normalizedCapabilities.map((cap, index) => (
              <div key={index} className="feature-capability-card">
                <div className="feature-capability-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 20 20"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="4 10 8 14 16 6" />
                  </svg>
                </div>
                <div className="feature-capability-content">
                  <h4 className="feature-capability-title">{cap.title}</h4>
                  <p className="feature-capability-desc">{cap.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contact Administrator Dialog */}
      <Dialog
        open={showAdminModal}
        onClose={() => setShowAdminModal(false)}
        title="Contact Campus Administrator"
        description="Information regarding module availability and institution access"
        footer={
          <Button variant="primary" onClick={() => setShowAdminModal(false)}>
            Close
          </Button>
        }
      >
        <div className="space-y-4 text-sm" style={{ color: 'var(--color-text)', lineHeight: 1.6 }}>
          <p>
            This feature is managed centrally for your institution. You can continue using your available Anesa Campus OS features as normal.
          </p>
          <div
            style={{
              padding: 'var(--space-3)',
              backgroundColor: 'var(--color-primary-soft)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--color-border)',
            }}
          >
            <h4
              style={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--color-primary-ink)',
                margin: '0 0 var(--space-1) 0',
              }}
            >
              Module Availability & Inquiries
            </h4>
            <p style={{ margin: 0, color: 'var(--color-muted)' }}>
              Module availability is managed by the Anesa Platform team. For questions about enabling this feature, please contact your institution&apos;s designated administrator, who can coordinate with the platform team.
            </p>
          </div>
          <p style={{ color: 'var(--color-muted)' }}>
            All existing institutional data across other active modules remains fully accessible and completely unaffected.
          </p>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * Reusable companion state for when an institution has been placed under administrative suspension.
 */
export function InstitutionSuspendedState({
  reason,
  onBackToDashboard,
}: {
  reason?: string;
  onBackToDashboard?: () => void;
}) {
  const handleBack = () => {
    if (onBackToDashboard) {
      onBackToDashboard();
    } else {
      window.location.assign('/');
    }
  };

  return (
    <div className="feature-unavailable feature-unavailable--suspended" role="alert">
      <div className="feature-unavailable-hero">
        <div
          className="feature-unavailable-icon-wrapper"
          style={{ background: 'var(--color-amber-soft)', color: 'var(--color-amber-ink)' }}
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <span
          className="feature-unavailable-badge"
          style={{ background: 'var(--color-amber-soft)', color: 'var(--color-amber-ink)' }}
        >
          Administrative Notice
        </span>

        <h2 className="feature-unavailable-title">Institution Access Suspended</h2>

        <p className="feature-unavailable-body">
          {reason ||
            'Institution access has been suspended by the platform administrator. Records are securely preserved but operations are currently restricted.'}
        </p>

        <p className="feature-unavailable-supporting">
          All historical academic ledgers, student profiles, and examination records are immutable and safe. Please contact your campus leadership or system administration to restore active status.
        </p>

        <div className="feature-unavailable-actions">
          <Button variant="primary" onClick={handleBack}>
            Back to Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
