import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { ApiClient } from '../lib/api/client';
import {
  searchFacultyForAssignment,
  type FacultyAssignee,
} from '../lib/api/academics-api';

export interface FacultySelectorProps {
  client: ApiClient;
  campusId?: string | undefined;
  value: string;
  onChange: (employeeId: string, employee?: FacultyAssignee | null) => void;
  error?: string | null | undefined;
  disabled?: boolean;
  label?: string;
  required?: boolean;
}

export function FacultySelector({
  client,
  campusId,
  value,
  onChange,
  error,
  disabled = false,
  label = 'Teacher / Faculty member',
  required = false,
}: FacultySelectorProps) {
  const id = useId();
  const listId = `${id}-listbox`;
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FacultyAssignee[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [selectedFaculty, setSelectedFaculty] = useState<FacultyAssignee | null>(null);

  // If a value is provided on mount or changes from parent
  useEffect(() => {
    if (!value) {
      setSelectedFaculty(null);
      setQuery('');
    } else if (selectedFaculty && selectedFaculty.id !== value) {
      // Value changed externally without selectedFaculty object
      setSelectedFaculty(null);
      setQuery('');
    }
  }, [value, selectedFaculty]);

  // Debounced search
  useEffect(() => {
    if (selectedFaculty) return; // Don't search if item already selected
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await searchFacultyForAssignment(client, {
          ...(query.trim() ? { q: query.trim() } : {}),
          ...(campusId ? { campusId } : {}),
          limit: 20,
        });
        if (!cancelled) {
          setResults(data);
          setActiveIndex(-1);
        }
      } catch {
        if (!cancelled) {
          setLoadError('Failed to load faculty options.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, query, campusId, selectedFaculty]);

  // Close on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const formatFacultyLabel = (f: FacultyAssignee) => {
    const campus = f.campusName || 'Main Campus';
    return `${f.displayName} — ${f.employeeCode} — ${campus}`;
  };

  const handleSelect = (f: FacultyAssignee) => {
    setSelectedFaculty(f);
    setQuery(formatFacultyLabel(f));
    setIsOpen(false);
    setActiveIndex(-1);
    onChange(f.id, f);
  };

  const handleClear = () => {
    setSelectedFaculty(null);
    setQuery('');
    setResults([]);
    onChange('', null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < results.length) {
        handleSelect(results[activeIndex]!);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setActiveIndex(-1);
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const activeOptionId =
    activeIndex >= 0 && results[activeIndex] ? `${id}-opt-${activeIndex}` : undefined;

  return (
    <div
      ref={containerRef}
      className="field"
      style={{ position: 'relative', minWidth: '280px', flex: '1 1 280px' }}
    >
      <label htmlFor={id}>
        {label} {required && <span aria-hidden="true">*</span>}
      </label>
      <div style={{ display: 'flex', position: 'relative', alignItems: 'center' }}>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listId}
          aria-activedescendant={activeOptionId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={selectedFaculty ? formatFacultyLabel(selectedFaculty) : query}
          onChange={(e) => {
            if (selectedFaculty) {
              setSelectedFaculty(null);
              onChange('', null);
            }
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            if (!disabled && !selectedFaculty) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search by name, employee code, or email..."
          disabled={disabled}
          autoComplete="off"
          style={{
            paddingRight: selectedFaculty ? '3rem' : '1rem',
            width: '100%',
          }}
        />

        {selectedFaculty && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear selected faculty"
            title="Clear selection"
            style={{
              position: 'absolute',
              right: '8px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.1rem',
              color: 'var(--color-muted, #666)',
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {isOpen && !selectedFaculty && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Faculty suggestions"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 100,
            maxHeight: '240px',
            overflowY: 'auto',
            background: 'var(--color-surface, #ffffff)',
            border: '1px solid var(--color-border, #d0d7de)',
            borderRadius: 'var(--radius, 6px)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            margin: '4px 0 0 0',
            padding: '4px 0',
            listStyle: 'none',
          }}
        >
          {loading && (
            <li
              style={{
                padding: '8px 12px',
                color: 'var(--color-muted, #666)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span aria-live="polite">Searching faculty...</span>
            </li>
          )}

          {loadError && (
            <li
              style={{
                padding: '8px 12px',
                color: 'var(--color-danger, #cf222e)',
              }}
            >
              {loadError}
            </li>
          )}

          {!loading && !loadError && results.length === 0 && (
            <li
              style={{
                padding: '8px 12px',
                color: 'var(--color-muted, #666)',
              }}
            >
              {query.trim()
                ? `No eligible faculty found matching "${query.trim()}".`
                : 'No eligible faculty available for this campus.'}
            </li>
          )}

          {!loading &&
            results.map((f, idx) => {
              const isHighlight = idx === activeIndex;
              return (
                <li
                  key={f.id}
                  id={`${id}-opt-${idx}`}
                  role="option"
                  aria-selected={isHighlight}
                  onClick={() => handleSelect(f)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    background: isHighlight
                      ? 'var(--color-primary-soft, #e8f0fe)'
                      : 'transparent',
                    borderBottom:
                      idx < results.length - 1
                        ? '1px solid var(--color-border-subtle, #f0f0f0)'
                        : 'none',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{formatFacultyLabel(f)}</div>
                  {f.email && (
                    <div
                      style={{
                        fontSize: '0.8125rem',
                        color: 'var(--color-muted, #666)',
                        marginTop: '2px',
                      }}
                    >
                      {f.email}
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      )}

      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
