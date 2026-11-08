import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  compact = false,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`empty-state ${compact ? 'empty-state--compact' : ''} ${className}`.trim()}
      role="region"
      aria-label={title}
    >
      <div className="empty-state-icon" aria-hidden="true">
        {icon || (
          <svg
            viewBox="0 0 48 48"
            width="40"
            height="40"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M8 38V10a2 2 0 0 1 2-2h28a2 2 0 0 1 2 2v28" />
            <path d="M4 38h40" />
            <path d="M16 16h16" />
            <path d="M16 22h12" />
            <circle cx="34" cy="28" r="4" strokeWidth="1.5" />
            <path d="M37 31l5 5" strokeWidth="1.5" />
          </svg>
        )}
      </div>
      <h3 className="empty-state-title">{title}</h3>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
