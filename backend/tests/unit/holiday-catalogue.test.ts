import { describe, expect, it } from 'vitest';
import { getHolidaySuggestions } from '../../src/modules/academics/holiday-catalogue.js';

describe('Holiday Catalogue: Indian Schools & Bihar State', () => {
  it('loads suggestions for an academic year spanning two calendar years (2026-04-01 to 2027-03-31)', () => {
    const suggestions = getHolidaySuggestions({
      country: 'IN',
      state: 'BR',
      from: '2026-04-01',
      to: '2027-03-31',
    });

    expect(suggestions.length).toBeGreaterThan(20);

    // Verify all returned entries lie strictly within the date bounds
    for (const h of suggestions) {
      expect(h.holidayDate >= '2026-04-01').toBe(true);
      expect(h.holidayDate <= '2027-03-31').toBe(true);
    }

    // Must be sorted chronologically
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i]!.holidayDate >= suggestions[i - 1]!.holidayDate).toBe(true);
    }

    // Includes 2026 festivals & holidays
    const names = suggestions.map((s) => s.name);
    expect(names).toContain('Independence Day');
    expect(names).toContain('Mahatma Gandhi Jayanti');
    expect(names).toContain('Diwali (Deepavali)');
    expect(names).toContain('Chhath Puja (Evening Arghya)');
    expect(names).toContain('Chhath Puja (Morning Arghya)');
    expect(names).toContain('Christmas Day');

    // Includes early 2027 holidays
    expect(names).toContain('Republic Day');
    expect(names).toContain('Bihar Diwas (Bihar Day)');

    // Excludes dates before 2026-04-01 (e.g. 2026 Republic Day on Jan 26, 2026 Bihar Diwas on Mar 22)
    const jan2026 = suggestions.filter((s) => s.holidayDate.startsWith('2026-01'));
    expect(jan2026).toHaveLength(0);

    // Excludes dates after 2027-03-31
    const apr2027 = suggestions.filter((s) => s.holidayDate.startsWith('2027-04'));
    expect(apr2027).toHaveLength(0);
  });

  it('correctly distinguishes VERIFIED, PROVISIONAL, and UNVERIFIED holidays', () => {
    const suggestions = getHolidaySuggestions({
      country: 'IN',
      state: 'BR',
      from: '2026-01-01',
      to: '2026-12-31',
    });

    const repDay = suggestions.find((s) => s.name === 'Republic Day');
    expect(repDay).toBeDefined();
    expect(repDay?.verificationStatus).toBe('VERIFIED');
    expect(repDay?.isGovernmentMandated).toBe(true);
    expect(repDay?.category).toBe('NATIONAL');
    expect(repDay?.source).toContain('Negotiable Instruments Act');

    const biharDiwas = suggestions.find((s) => s.name.includes('Bihar Diwas'));
    expect(biharDiwas).toBeDefined();
    expect(biharDiwas?.verificationStatus).toBe('VERIFIED');
    expect(biharDiwas?.category).toBe('STATE');
    expect(biharDiwas?.holidayDate).toBe('2026-03-22');

    // Movable festivals without published year-specific gazette circular are PROVISIONAL
    const chhath = suggestions.find((s) => s.name.includes('Evening Arghya'));
    expect(chhath).toBeDefined();
    expect(chhath?.verificationStatus).toBe('PROVISIONAL');
    expect(chhath?.category).toBe('STATE');
    expect(chhath?.source).toContain('Bihar');

    // Lunar festivals must be PROVISIONAL
    const eid = suggestions.find((s) => s.name === 'Eid-ul-Fitr');
    expect(eid).toBeDefined();
    expect(eid?.verificationStatus).toBe('PROVISIONAL');
    expect(eid?.notes).toContain('moon sighting');

    // Institutional recommendations must be UNVERIFIED
    const summer = suggestions.find((s) => s.name.includes('Summer Vacation'));
    expect(summer).toBeDefined();
    expect(summer?.verificationStatus).toBe('UNVERIFIED');
    expect(summer?.category).toBe('INSTITUTIONAL');
    expect(summer?.kind).toBe('NON_TEACHING_DAY');
    expect(summer?.isGovernmentMandated).toBe(false);
  });

  it('filters out state-specific holidays when state is ALL (Central / Nationwide only)', () => {
    const centralOnly = getHolidaySuggestions({
      country: 'IN',
      state: 'ALL',
      from: '2026-01-01',
      to: '2026-12-31',
    });

    const biharWithCentral = getHolidaySuggestions({
      country: 'IN',
      state: 'BR',
      from: '2026-01-01',
      to: '2026-12-31',
    });

    expect(centralOnly.length).toBeLessThan(biharWithCentral.length);

    const centralNames = centralOnly.map((s) => s.name);
    expect(centralNames).toContain('Republic Day');
    expect(centralNames).toContain('Independence Day');
    expect(centralNames).not.toContain('Bihar Diwas (Bihar Day)');
    expect(centralNames).not.toContain('Chhath Puja (Evening Arghya)');
  });

  it('handles future years gracefully with fixed days as VERIFIED and movable festivals as UNVERIFIED', () => {
    const suggestions2029 = getHolidaySuggestions({
      country: 'IN',
      state: 'BR',
      from: '2029-01-01',
      to: '2029-12-31',
    });

    expect(suggestions2029.length).toBeGreaterThan(0);

    const repDay = suggestions2029.find((s) => s.name === 'Republic Day');
    expect(repDay).toBeDefined();
    expect(repDay?.holidayDate).toBe('2029-01-26');
    expect(repDay?.verificationStatus).toBe('VERIFIED');

    const biharDiwas = suggestions2029.find((s) => s.name.includes('Bihar Diwas'));
    expect(biharDiwas).toBeDefined();
    expect(biharDiwas?.holidayDate).toBe('2029-03-22');
    expect(biharDiwas?.verificationStatus).toBe('VERIFIED');

    const holi = suggestions2029.find((s) => s.name.includes('Holi'));
    expect(holi).toBeDefined();
    expect(holi?.verificationStatus).toBe('UNVERIFIED');
    expect(holi?.notes).toContain('gazette');
  });

  it('returns empty list for invalid or reversed date windows', () => {
    expect(getHolidaySuggestions({ from: '', to: '' })).toEqual([]);
    expect(getHolidaySuggestions({ from: '2026-12-31', to: '2026-01-01' })).toEqual([]);
  });
});
