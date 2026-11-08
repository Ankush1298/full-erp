export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

export interface StatusBadgeProps {
  status: string;
  tone?: StatusTone;
  label?: string;
  className?: string;
}

const DEFAULT_TONES: Record<string, StatusTone> = {
  active: 'success',
  published: 'success',
  present: 'success',
  passed: 'success',
  completed: 'success',
  enrolled: 'success',
  verified: 'success',

  pending: 'warning',
  draft: 'warning',
  late: 'warning',
  attention: 'warning',
  review: 'warning',

  failed: 'error',
  absent: 'error',
  cancelled: 'error',
  suspended: 'error',
  withdrawn: 'error',
  rejected: 'error',

  excused: 'info',
  half_day: 'info',
  scheduled: 'info',
  planned: 'info',

  archived: 'neutral',
  inactive: 'neutral',
  unknown: 'neutral',
};

export function StatusBadge({
  status,
  tone,
  label,
  className = '',
}: StatusBadgeProps) {
  const normalizedKey = status.toLowerCase().replace(/[\s-]+/g, '_');
  const computedTone = tone || DEFAULT_TONES[normalizedKey] || 'neutral';
  const displayLabel = label || status.replace(/_/g, ' ');

  return (
    <span
      className={`status-badge status-badge--${computedTone} ${className}`.trim()}
      data-status={normalizedKey}
    >
      <span className="status-badge-dot" aria-hidden="true" />
      <span className="status-badge-text">{displayLabel}</span>
    </span>
  );
}

