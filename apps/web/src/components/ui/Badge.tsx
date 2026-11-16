import type { ReactNode } from 'react';

export interface BadgeProps {
  children: ReactNode;
  tone?: 'positive' | 'warning' | 'danger' | 'neutral' | 'brand' | 'purple' | 'emerald' | 'amber' | 'coral' | string;
  className?: string;
}

export function Badge({ children, tone, className = '' }: BadgeProps) {
  const toneClass = tone ? `badge--${tone}` : '';
  return <span className={`badge ${toneClass} ${className}`.trim()}>{children}</span>;
}
