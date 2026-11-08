import type { ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  secondaryAction,
  compact = false,
  className = '',
}: ErrorStateProps) {
  return (
    <div
      className={`error-state ${compact ? 'error-state--compact' : ''} ${className}`.trim()}
      role="alert"
    >
      <div className="error-state-icon" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <div className="error-state-content">
        <h4 className="error-state-title">{title}</h4>
        <p className="error-state-message">{message}</p>
        {(onRetry || secondaryAction) && (
          <div className="error-state-actions">
            {onRetry && (
              <Button variant="secondary" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}

