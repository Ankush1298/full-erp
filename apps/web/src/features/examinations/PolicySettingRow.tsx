import React, { useId } from 'react';

export interface PolicySettingRowProps {
  id?: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  badge?: string;
  children?: React.ReactNode;
}

export function PolicySettingRow({
  id: explicitId,
  label,
  description,
  checked,
  onChange,
  disabled = false,
  badge,
  children,
}: PolicySettingRowProps) {
  const generatedId = useId();
  const inputId = explicitId ?? generatedId;

  return (
    <div className="border border-border rounded-lg p-4 bg-surface hover:bg-surface-muted/20 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <label
          htmlFor={inputId}
          className="flex-1 cursor-pointer select-none space-y-1"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{label}</span>
            {badge && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p className="text-xs text-muted leading-relaxed">{description}</p>
          )}
        </label>
        <div className="pt-0.5">
          <input
            id={inputId}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="h-5 w-5 rounded border-input text-brand-600 focus:ring-brand-500 cursor-pointer disabled:opacity-50"
          />
        </div>
      </div>
      {checked && children && (
        <div className="mt-4 pt-4 border-t border-border/60 pl-2 space-y-3">
          {children}
        </div>
      )}
    </div>
  );
}
