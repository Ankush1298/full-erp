import { describe, expect, it } from 'vitest';
import {
  calendarDaysBetween,
  formatLocalTime,
  localDateOf,
  localToInstant,
  todayInZone,
} from '../src/lib/campus-time';

// ATT-1/ATT-2: the campus wall clock, not the browser or UTC, defines a class's time and calendar day.
describe('localToInstant', () => {
  it('09:00 in an India campus is 03:30Z and reads back as 09:00 on the same date', () => {
    const r = localToInstant('2026-11-07', '09:00', 'Asia/Kolkata');
    expect(r).toEqual({ ok: true, iso: '2026-11-07T03:30:00.000Z' });
    expect(formatLocalTime('2026-11-07T03:30:00.000Z', 'Asia/Kolkata')).toBe('09:00');
    expect(localDateOf('2026-11-07T03:30:00.000Z', 'Asia/Kolkata')).toBe('2026-11-07');
  });

  it('an evening class stays on the campus date even though it is the next UTC day', () => {
    const r = localToInstant('2026-11-07', '23:30', 'Asia/Kolkata');
    expect(r).toEqual({ ok: true, iso: '2026-11-07T18:00:00.000Z' });
    const early = localToInstant('2026-11-07', '01:00', 'Asia/Kolkata'); // 19:30Z on the 6th
    expect(early).toEqual({ ok: true, iso: '2026-11-06T19:30:00.000Z' });
    expect(localDateOf('2026-11-06T19:30:00.000Z', 'Asia/Kolkata')).toBe('2026-11-07');
  });

  it('other zones: half-hour, quarter-hour and +14 offsets, and a zone behind UTC', () => {
    expect(localToInstant('2026-06-15', '09:00', 'Asia/Kathmandu')).toEqual({
      ok: true,
      iso: '2026-06-15T03:15:00.000Z',
    });
    expect(localToInstant('2026-06-15', '09:00', 'Pacific/Kiritimati')).toEqual({
      ok: true,
      iso: '2026-06-14T19:00:00.000Z',
    });
    expect(localToInstant('2026-06-15', '09:00', 'Pacific/Pago_Pago')).toEqual({
      ok: true,
      iso: '2026-06-15T20:00:00.000Z',
    });
    expect(localToInstant('2026-01-15', '09:00', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-01-15T14:00:00.000Z',
    });
    expect(localToInstant('2026-07-15', '09:00', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-07-15T13:00:00.000Z',
    });
  });

  it('daylight saving: a time in the spring-forward gap does not exist; a fall-back time is ambiguous; neighbours are fine', () => {
    expect(localToInstant('2026-03-08', '02:30', 'America/New_York')).toEqual({
      ok: false,
      reason: 'NONEXISTENT',
    });
    expect(localToInstant('2026-03-08', '03:00', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-03-08T07:00:00.000Z',
    });
    expect(localToInstant('2026-03-08', '01:59', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-03-08T06:59:00.000Z',
    });
    expect(localToInstant('2026-11-01', '01:30', 'America/New_York')).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
    });
    expect(localToInstant('2026-11-01', '02:00', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-11-01T07:00:00.000Z',
    });
    expect(localToInstant('2026-11-01', '00:30', 'America/New_York')).toEqual({
      ok: true,
      iso: '2026-11-01T04:30:00.000Z',
    });
    // southern hemisphere and a half-hour DST zone
    expect(localToInstant('2026-09-27', '02:30', 'Pacific/Auckland')).toEqual({
      ok: false,
      reason: 'NONEXISTENT',
    });
    expect(localToInstant('2026-10-04', '02:15', 'Australia/Lord_Howe')).toEqual({
      ok: false,
      reason: 'NONEXISTENT',
    });
  });

  it('rejects malformed input and unknown zones', () => {
    expect(localToInstant('2026-13-40', '09:00', 'Asia/Kolkata').ok).toBe(false);
    expect(localToInstant('2026-11-07', '24:00', 'Asia/Kolkata')).toEqual({
      ok: false,
      reason: 'INVALID',
    });
    expect(localToInstant('2026-11-07', '9:00', 'Asia/Kolkata')).toEqual({
      ok: false,
      reason: 'INVALID',
    });
    expect(localToInstant('2026-11-07', '09:00', 'Mars/Olympus')).toEqual({
      ok: false,
      reason: 'INVALID',
    });
  });
});

describe('the campus calendar day differs from the UTC day', () => {
  it('around UTC midnight: 20:00Z on 7 Nov is already 8 Nov in India and still 7 Nov in New York', () => {
    const now = Date.parse('2026-11-07T20:00:00Z');
    expect(todayInZone('Asia/Kolkata', now)).toBe('2026-11-08');
    expect(todayInZone('America/New_York', now)).toBe('2026-11-07');
    expect(todayInZone('Pacific/Kiritimati', now)).toBe('2026-11-08');
    expect(todayInZone('Pacific/Pago_Pago', now)).toBe('2026-11-07');
    const early = Date.parse('2026-11-07T02:00:00Z'); // 07:30 in India, 21:00 on the 6th in New York
    expect(todayInZone('Asia/Kolkata', early)).toBe('2026-11-07');
    expect(todayInZone('America/New_York', early)).toBe('2026-11-06');
    expect(todayInZone('Pacific/Pago_Pago', early)).toBe('2026-11-06');
  });

  it('calendar-day differences use dates, not elapsed hours', () => {
    expect(calendarDaysBetween('2026-11-04', '2026-11-07')).toBe(3);
    expect(calendarDaysBetween('2026-11-04', '2026-11-08')).toBe(4);
    expect(calendarDaysBetween('2026-11-08', '2026-11-07')).toBe(-1);
    // across a DST change a day is still one calendar day
    expect(calendarDaysBetween('2026-03-07', '2026-03-09')).toBe(2);
  });
});
