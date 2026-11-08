import { isApiError } from './api/errors';

/**
 * Plain-language wording for the attendance API's stable error codes (doc 49 ATT-3). The server never sends text to show; it
 * sends a code, and unknown codes fall back to a generic sentence. Nothing here decides anything: the server already did.
 */
const BY_CODE: Record<string, string> = {
  ATTENDANCE_CORRECTIONS_DISABLED:
    'Attendance corrections are switched off for this institution. Nothing was changed.',
  FORBIDDEN: 'You do not have permission to do this.',
  SESSION_LOCKED: 'This session is locked. Its attendance can no longer be changed.',
  TERM_CLOSED: 'The term is closed; only an institution administrator can correct its attendance.',
  TERM_NOT_OPEN: 'The term is not open for this change.',
  ATTENDANCE_NOT_SUBMITTED: 'Attendance for this session has not been submitted yet.',
  CORRECTION_WINDOW_PASSED:
    'The correction window has passed for this session. Submit a correction request for approval instead.',
  CORRECTION_WINDOW_OPEN:
    'This session is still inside the correction window. Correct the record directly instead of requesting approval.',
  RECORD_CHANGED: 'This record changed since you opened it. Reload and try again.',
  NO_CHANGE: 'The record already has that status.',
  SESSION_EXISTS: 'A session already starts at that time for this offering.',
  SESSION_TIME_OUTSIDE_DAY:
    'The start and end must both fall on the chosen date in the campus time zone. A class cannot cross midnight; schedule two sessions instead.',
  SESSION_DATE_OUTSIDE_TERM: 'The date is outside the term of this offering.',
  SESSION_ON_HOLIDAY:
    'That date is a holiday or non-teaching day. Choose "Extra" or "Make-up" to hold a class anyway.',
  TEACHER_NOT_ASSIGNED: 'You are not assigned to teach this offering on that date.',
  TIMETABLE_SLOT_INVALID: 'The timetable slot does not fit this offering and date.',
  OFFERING_NOT_PUBLISHED: 'This offering is not published.',
  OFFERING_NOT_TRACKED: 'This offering does not take attendance.',
};

export function attendanceErrorMessage(err: unknown, fallback: string): string {
  if (isApiError(err) && err.code !== undefined && BY_CODE[err.code] !== undefined)
    return BY_CODE[err.code]!;
  return fallback;
}
