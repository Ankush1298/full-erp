/**
 * Campus-local time (doc 49 ATT-1/ATT-2). A class's calendar day is the day on the wall clock of its CAMPUS (an IANA zone the
 * institution configures), not the browser's zone and not UTC. The API keeps UTC instants (`startsAt`, `endsAt`); this module
 * converts what a teacher types in the campus zone to those instants, and instants back to campus wall-clock text, with no
 * dependency beyond `Intl`. Deterministic: a local time that does not exist (spring-forward gap) or occurs twice (fall-back)
 * is reported, never guessed.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    dtf(timeZone).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
function wall(ms: number, timeZone: string): { date: string; time: string; asUtcMs: number } {
  const p = Object.fromEntries(
    dtf(timeZone)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const date = `${p['year']}-${p['month']}-${p['day']}`;
  const time = `${p['hour']}:${p['minute']}`;
  return { date, time, asUtcMs: Date.parse(`${date}T${time}:${p['second']}Z`) };
}

/** UTC offset (ms) of a zone at an instant. */
function offsetAt(ms: number, timeZone: string): number {
  return wall(ms, timeZone).asUtcMs - Math.floor(ms / 1000) * 1000;
}

/** The campus-local calendar date (YYYY-MM-DD) at `now`. */
export function todayInZone(timeZone: string, now: Date | number = Date.now()): string {
  return wall(typeof now === 'number' ? now : now.getTime(), timeZone).date;
}

/** The campus-local calendar date of an instant. */
export function localDateOf(isoInstant: string, timeZone: string): string {
  return wall(Date.parse(isoInstant), timeZone).date;
}

/** `HH:MM` (24-hour) of an instant on the campus wall clock. */
export function formatLocalTime(isoInstant: string, timeZone: string): string {
  const ms = Date.parse(isoInstant);
  if (Number.isNaN(ms)) return isoInstant;
  return wall(ms, timeZone).time;
}

export type LocalToInstant =
  { ok: true; iso: string } | { ok: false; reason: 'INVALID' | 'NONEXISTENT' | 'AMBIGUOUS' };

/**
 * The UTC instant at which `date` `HH:MM` shows on the wall clock of `timeZone`.
 * NONEXISTENT: the time falls in a daylight-saving gap. AMBIGUOUS: it occurs twice (clocks go back). INVALID: bad input.
 */
export function localToInstant(date: string, time: string, timeZone: string): LocalToInstant {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
    !isValidTimeZone(timeZone)
  )
    return { ok: false, reason: 'INVALID' };
  const guess = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(guess)) return { ok: false, reason: 'INVALID' };
  // Candidate offsets: those in force a day before and a day after the wall-clock guess bracket any single transition.
  const offsets = new Set([
    offsetAt(guess - 86_400_000, timeZone),
    offsetAt(guess + 86_400_000, timeZone),
  ]);
  const hits = new Set<number>();
  for (const off of offsets) {
    const candidate = guess - off;
    const w = wall(candidate, timeZone);
    if (w.date === date && w.time === time) hits.add(candidate);
  }
  if (hits.size === 0) return { ok: false, reason: 'NONEXISTENT' };
  if (hits.size > 1) return { ok: false, reason: 'AMBIGUOUS' };
  return { ok: true, iso: new Date([...hits][0]!).toISOString() };
}

/** Calendar days from `sessionDate` to `today` (both YYYY-MM-DD): 0 = today, 3 = three days ago, negative = in the future. */
export function calendarDaysBetween(sessionDate: string, today: string): number {
  return Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sessionDate}T00:00:00Z`)) / 86_400_000,
  );
}
