import { createContext, useCallback, useContext } from 'react';
import { DEFAULT_TERMINOLOGY, type Terminology } from './api/academics-api';

/**
 * Institution labels (GET /academics/terminology, doc 33 §6; doc 35 §4). Display only: no record changes with them. While
 * they load, when the caller cannot read them or the call fails, the server's own fallbacks apply.
 */
export const LabelsContext = createContext<Terminology>(DEFAULT_TERMINOLOGY);
export const useLabels = () => useContext(LabelsContext);
/** Cohort id -> its programme's own period label ("Year", "Semester"), only where the institution set one. */
export const PeriodLabelsContext = createContext<Record<string, string>>({});
/** The period label of a cohort: its programme's own label when one is set, else the institution-wide one. */
export function usePeriodLabel(): (cohortId: string | undefined) => string {
  const L = useLabels();
  const byCohort = useContext(PeriodLabelsContext);
  return useCallback(
    (cohortId) => (cohortId !== undefined ? byCohort[cohortId] : undefined) ?? L.period,
    [byCohort, L.period],
  );
}
// ponytail: naive English plural of a free-text label; add plural slots to the setting if a tenant needs irregular ones.
export const plural = (w: string) =>
  /(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
export const lower = (w: string) => w.toLowerCase();
