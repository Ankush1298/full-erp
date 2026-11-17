import type { ReactNode } from 'react';

export interface SegmentedNavItem<T extends string = string> {
  id: T;
  label: string;
  badge?: number | string | null;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedNavProps<T extends string = string> {
  items: Array<SegmentedNavItem<T>>;
  activeId: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
  className?: string;
}

export function SegmentedNav<T extends string = string>({
  items,
  activeId,
  onChange,
  ariaLabel = 'Navigation sections',
  className = '',
}: SegmentedNavProps<T>) {
  return (
    <div className={`anesa-nav-bar ${className}`.trim()}>
      <nav className="flex items-center gap-2 overflow-x-auto w-full" aria-label={ariaLabel}>
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              aria-pressed={isActive}
              onClick={() => !item.disabled && onChange(item.id)}
              disabled={item.disabled}
              className={`anesa-nav-btn ${isActive ? 'anesa-nav-btn--active' : ''}`.trim()}
            >
              {item.icon && <span className="mr-1.5 inline-flex items-center">{item.icon}</span>}
              <span>{item.label}</span>
              {item.badge !== undefined && item.badge !== null && (
                <span className="anesa-nav-badge">{item.badge}</span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
