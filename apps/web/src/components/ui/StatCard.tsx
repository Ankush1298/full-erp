import type { ReactNode } from 'react';

export type StatTone = 'purple' | 'coral' | 'amber' | 'emerald';

export interface StatCardProps {
  label: string;
  value: string | number;
  helper?: string;
  trend?: {
    text: string;
    tone?: 'positive' | 'negative' | 'neutral';
  };
  tone?: StatTone;
  icon?: ReactNode;
  className?: string;
}

export function StatCard({
  label,
  value,
  helper,
  trend,
  tone = 'purple',
  icon,
  className = '',
}: StatCardProps) {
  return (
    <div className={`stat-card stat-card--${tone} ${className}`.trim()}>
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
      {helper && <p className="stat-card-helper">{helper}</p>}
    </div>
  );
}
