import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  badge?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  badge,
  subtitle,
  actions,
  breadcrumbs,
  className = '',
}: PageHeaderProps) {
  return (
    <header className={`page-header ${className}`.trim()}>
      {breadcrumbs && <nav className="page-header-breadcrumbs">{breadcrumbs}</nav>}
      <div className="page-header-main">
        <div className="page-header-title-wrap">
          <div className="page-header-heading-line">
            <h1 className="page-header-title">{title}</h1>
            {badge && <div className="page-header-badge">{badge}</div>}
          </div>
          {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </header>
  );
}

