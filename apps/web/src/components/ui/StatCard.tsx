import type { ReactNode } from 'react';

export type StatTone =
  | 'purple'
  | 'coral'
  | 'amber'
  | 'emerald'
  | 'brand'
  | 'positive'
  | 'warning'
  | 'danger'
  | 'neutral';

export interface StatCardProps {
  label: string;
  value: string | number;
  helper?: string;
  detail?: string;
  trend?: {
    text: string;
    tone?: 'positive' | 'negative' | 'neutral';
  };
  tone?: StatTone;
  icon?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  helper,
  detail,
  trend,
  tone = 'purple',
  icon,
  compact = false,
  className = '',
}: StatCardProps) {
  const toneMap: Record<string, 'purple' | 'coral' | 'amber' | 'emerald'> = {
    brand: 'purple',
    positive: 'emerald',
    warning: 'amber',
    danger: 'coral',
    neutral: 'purple',
  };
  const resolvedTone = (toneMap[tone] || tone) as 'purple' | 'coral' | 'amber' | 'emerald';
  const compactClass = compact ? 'stat-card--compact' : '';
  const helperText = detail ?? helper;
  return (
    <div className={`stat-card stat-card--${resolvedTone} ${compactClass} ${className}`.trim()}>
      <div className="stat-card-header">
        <span className="stat-card-label">{label}</span>
        {icon && (
          <span className="stat-card-icon" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>
      <div className="stat-card-body">
        <span className="stat-card-value">{value}</span>
        {trend && (
          <span
            className={`stat-card-trend stat-card-trend--${trend.tone ?? 'neutral'}`}
            aria-label={`Trend: ${trend.text}`}
          >
            {trend.text}
          </span>
        )}
      </div>
      {helperText && <p className="stat-card-helper">{helperText}</p>}
    </div>
  );
}
