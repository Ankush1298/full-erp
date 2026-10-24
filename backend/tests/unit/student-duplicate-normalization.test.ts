import { describe, expect, it } from 'vitest';
import {
  firstEarlierMatches,
  normalizeName,
  normalizePhone,
} from '../../src/modules/students/student-duplicate.service.js';
import { studentImportAdapter } from '../../src/modules/students/student-import.adapter.js';
import { MATCHING_ONLY_COLUMNS } from '../../src/modules/imports/import.common.js';

// The owner-approved MINIMUM normalisation (2026-10-22): names are trimmed and case-folded, phones keep digits only.
describe('normalisation', () => {
  it('names: trim and case-fold, nothing else', () => {
    expect(normalizeName('  Asha Verma ')).toBe('asha verma');
    expect(normalizeName('ASHA verma')).toBe(normalizeName('asha VERMA'));
    expect(normalizeName('Straße')).toBe(normalizeName('STRASSE')); // full case folding
    // deliberately NOT done
    expect(normalizeName('Asha  Verma')).not.toBe(normalizeName('Asha Verma')); // inner whitespace kept
    expect(normalizeName('Verma Asha')).not.toBe(normalizeName('Asha Verma')); // no token reordering
    expect(normalizeName('José')).not.toBe(normalizeName('Jose')); // no diacritic removal
    expect(normalizeName('José')).not.toBe(normalizeName('José')); // no Unicode normalisation
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName(5)).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('phones: ASCII digits only, nothing inferred', () => {
    expect(normalizePhone('+91 (98765) 43-210')).toBe('919876543210');
    expect(normalizePhone('919876543210')).toBe('919876543210');
    expect(normalizePhone('09876543210')).not.toBe(normalizePhone('9876543210')); // no leading-zero removal
    expect(normalizePhone('9876543210')).not.toBe(normalizePhone('+919876543210')); // no country-code inference
    expect(normalizePhone('---')).toBe('');
    expect(normalizePhone('٩٨٧٦')).toBe(''); // non-ASCII digits are not mapped
    expect(normalizePhone(null)).toBe('');
  });
});

describe('student import row: the matching-only cells', () => {
  const base = { email: 'A@x.test', admissionNumber: 'ADM-1', admissionDate: '2024-07-01' };

  it('a stored row carries only the name; the proposal never holds a matching value', () => {
    const plain = studentImportAdapter.parse(base);
    expect(plain.errors).toEqual([]);
    expect(plain.match).toEqual({});
    const withName = studentImportAdapter.parse({ ...base, name: ' Asha Verma ' });
    expect(withName.errors).toEqual([]);
    expect(withName.match).toEqual({ name: 'Asha Verma' });
    expect(withName.proposal).toEqual(plain.proposal);
    // the sensitive columns are not columns of a stored row any more (the create request refuses them)
    for (const col of MATCHING_ONLY_COLUMNS) {
      const r = studentImportAdapter.parse({ ...base, [col]: 'x' });
      expect(r.errors.map((e) => e.code)).toEqual(['UNKNOWN_COLUMN']);
      expect(JSON.stringify(r)).not.toContain('"x"');
    }
  });

  it('parseMatching validates the resupplied cells and normalises nothing it keeps', () => {
    const ok = studentImportAdapter.parseMatching!({
      dateOfBirth: ' 2005-03-04 ',
      guardianPhone: '+91 98765 43210',
    });
    expect(ok.errors).toEqual([]);
    expect(ok.match).toEqual({ dateOfBirth: '2005-03-04', guardianPhone: '+91 98765 43210' });
    expect(studentImportAdapter.parseMatching!({}).match).toEqual({});
    expect(
      studentImportAdapter.parseMatching!({ dateOfBirth: '  ', guardianPhone: '' }).match,
    ).toEqual({});
  });

  it('rejects an invalid, impossible or future date of birth strictly, with fixed text that never echoes the value', () => {
    for (const bad of [
      '2005-02-30',
      '2005-3-4',
      '04/03/2005',
      '2005-03-04T00:00',
      '2999-12-31',
      '1899-12-31',
      'x',
    ]) {
      const r = studentImportAdapter.parseMatching!({ dateOfBirth: bad });
      expect(r.match, bad).toEqual({});
      expect(r.errors, bad).toEqual([
        {
          code: 'INVALID_DATE',
          field: 'dateOfBirth',
          message: 'Must be a real calendar date in the past, YYYY-MM-DD.',
        },
      ]);
    }
  });

  it('bounds the name and the phone', () => {
    expect(studentImportAdapter.parse({ ...base, name: 'n'.repeat(201) }).errors[0]?.code).toBe(
      'INVALID_NAME',
    );
    expect(
      studentImportAdapter.parseMatching!({ guardianPhone: '1'.repeat(31) }).errors[0]?.code,
    ).toBe('INVALID_PHONE');
    expect(studentImportAdapter.parse({ ...base, name: '  ' }).match).toEqual({});
  });

  it('the framework refuses exactly these two columns at job creation', () => {
    expect([...MATCHING_ONLY_COLUMNS]).toEqual(['dateOfBirth', 'guardianPhone']);
  });
});

describe('within-file matching', () => {
  const p = (name: string | null, dateOfBirth: string | null, guardianPhone: string | null) => ({
    name,
    dateOfBirth,
    guardianPhone,
  });

  it('flags a row against the FIRST earlier row of its group, once, with the approved normalisation', () => {
    const probes = [
      p('Asha Verma', '2005-03-04', '98765 43210'), // 0: anchor
      p('  ASHA verma ', '2005-03-04', '+(98765)-43210'), // 1: matches 0
      p('Asha Verma', '2005-03-04', '9876543210'), // 2: matches 0 (not 1)
      p('Asha Verma', '2005-03-05', '9876543210'), // 3: other date of birth
      p('Ravi Rao', '2005-03-04', '9876543210'), // 4: other name
      p('Asha Verma', '2005-03-04', '9876543211'), // 5: other phone
    ];
    expect(firstEarlierMatches(probes)).toEqual([null, 0, 0, null, null, null]);
  });

  it('a missing or unusable value never matches, even against another missing value', () => {
    const probes = [
      p('A B', null, '123'),
      p('A B', null, '123'),
      p('A B', '2005-03-04', null),
      p('A B', '2005-03-04', null),
      p('A B', '2005-03-04', '---'),
      p('A B', '2005-03-04', '---'),
      p(null, '2005-03-04', '123'),
      p('  ', '2005-03-04', '123'),
    ];
    expect(firstEarlierMatches(probes)).toEqual(probes.map(() => null));
  });

  it('is deterministic and depends only on row order', () => {
    const a = p('X Y', '2000-01-01', '111');
    const b = p('x y', '2000-01-01', '1-1-1');
    expect(firstEarlierMatches([a, b])).toEqual(firstEarlierMatches([a, b]));
    expect(firstEarlierMatches([a, b])).toEqual([null, 0]);
    expect(firstEarlierMatches([b, a])).toEqual([null, 0]);
  });
});
