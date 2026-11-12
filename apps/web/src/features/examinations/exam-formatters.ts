import { localDateOf } from '../../lib/campus-time';
import type {
  EvaluationStatus,
  ExamType,
  OverrideStatus,
  ScheduleStatus,
} from '../../lib/api/examinations-api';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Parse YYYY-MM-DD or ISO timestamp safely into friendly day month year text */
export function formatFriendlyDate(dateStr?: string | null, timeZone: string = 'Asia/Kolkata'): string {
  if (!dateStr) return '—';
  let clean = dateStr;
  if (dateStr.includes('T')) {
    try {
      clean = localDateOf(dateStr, timeZone);
    } catch {
      clean = dateStr.split('T')[0]!;
    }
  }
  const parts = clean.split('-');
  if (parts.length === 3) {
    const year = parts[0]!;
    const monthIdx = parseInt(parts[1]!, 10) - 1;
    const day = parseInt(parts[2]!, 10);
    if (!isNaN(monthIdx) && monthIdx >= 0 && monthIdx < 12 && !isNaN(day)) {
      return `${day} ${MONTH_NAMES[monthIdx]} ${year}`;
    }
  }
  return dateStr;
}

/** Formats a date range e.g. 15 Oct 2026 – 25 Oct 2026 */
export function formatDateRange(startsOn?: string | null, endsOn?: string | null): string {
  if (!startsOn && !endsOn) return 'Dates to be announced';
  if (startsOn && !endsOn) return `Commencing ${formatFriendlyDate(startsOn)}`;
  if (!startsOn && endsOn) return `Concluding ${formatFriendlyDate(endsOn)}`;
  return `${formatFriendlyDate(startsOn)} – ${formatFriendlyDate(endsOn)}`;
}

/** Formats HH:MM 24h into 12h with AM/PM e.g. 10:00 -> 10:00 AM */
export function formatFriendlyTime(timeStr?: string | null): string {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  if (parts.length >= 2) {
    let hours = parseInt(parts[0]!, 10);
    const mins = parts[1]!.padStart(2, '0');
    if (isNaN(hours)) return timeStr;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${mins} ${ampm}`;
  }
  return timeStr;
}

/** Formats a time range e.g. 10:00 AM – 12:00 PM */
export function formatTimeRange(start?: string | null, end?: string | null): string {
  if (!start && !end) return '';
  const formattedStart = formatFriendlyTime(start);
  const formattedEnd = formatFriendlyTime(end);
  if (formattedStart && formattedEnd) return `${formattedStart} – ${formattedEnd}`;
  return formattedStart || formattedEnd;
}

/** Converts raw enum exam types to school-friendly titles */
export function formatExamType(type?: ExamType | string | null): string {
  switch (type) {
    case 'MID_TERM':
      return 'Mid-Term Examination';
    case 'FINAL':
      return 'Annual Final Examination';
    case 'UNIT_TEST':
      return 'Unit Assessment Test';
    case 'INTERNAL':
      return 'Internal Continuous Evaluation';
    case 'SUPPLEMENTARY':
      return 'Supplementary Re-examination';
    case 'OTHER':
      return 'Special Examination';
    default:
      return type ? type.replace(/_/g, ' ') : 'Examination';
  }
}

/** Converts raw enum schedule statuses to clear school labels */
export function formatScheduleStatus(status?: ScheduleStatus | string | null): string {
  switch (status) {
    case 'SCHEDULED':
      return 'Scheduled';
    case 'DRAFT_MARKS':
      return 'Draft Marks Entered';
    case 'SUBMITTED':
      return 'Awaiting Review & Publishing';
    case 'PUBLISHED':
      return 'Results Published';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status ? status.replace(/_/g, ' ') : 'Pending';
  }
}

/** Returns status tone / color indicator */
export function getScheduleStatusTone(
  status?: ScheduleStatus | string | null,
): 'emerald' | 'amber' | 'purple' | 'coral' | 'neutral' {
  switch (status) {
    case 'PUBLISHED':
      return 'emerald';
    case 'SUBMITTED':
      return 'amber';
    case 'DRAFT_MARKS':
      return 'purple';
    case 'CANCELLED':
      return 'coral';
    default:
      return 'neutral';
  }
}

/** Friendly labels for evaluation status */
export function formatEvaluationStatus(status?: EvaluationStatus | string | null): string {
  switch (status) {
    case 'ELIGIBLE':
      return 'Eligible (Cleared)';
    case 'NOT_ELIGIBLE':
      return 'Disqualified';
    case 'NEEDS_REVIEW':
      return 'Needs Review';
    default:
      return status ?? '—';
  }
}

/** Friendly labels for override status */
export function formatOverrideStatus(status?: OverrideStatus | string | null): string {
  switch (status) {
    case 'NONE':
      return 'No Override';
    case 'EXEMPTED':
      return 'Exempted (Medical/Special)';
    case 'CONDITIONAL_APPROVAL':
      return 'Conditional Clearance';
    case 'DISQUALIFIED':
      return 'Disqualified by Admin';
    default:
      return status ?? '—';
  }
}
