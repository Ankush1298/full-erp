import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_CODES, ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import {
  BASE_ROLE_LABELS,
  INSTITUTION_TYPES,
  roleLabelsFor,
} from '../../src/shared/settings/institution.js';

// Doc 44: institution-aware role names are DISPLAY ONLY.
describe('institution role labels', () => {
  it('every institution type, and "not chosen", labels exactly the eight role codes and nothing else', () => {
    for (const type of [null, ...INSTITUTION_TYPES]) {
      expect(Object.keys(roleLabelsFor(type)).sort(), String(type)).toEqual([...ROLE_CODES].sort());
    }
  });

  it('"not chosen" and COLLEGE keep the pre-onboarding labels; SCHOOL and UNIVERSITY differ only where documented', () => {
    expect(roleLabelsFor(null)).toEqual(BASE_ROLE_LABELS);
    expect(roleLabelsFor('COLLEGE')).toEqual(BASE_ROLE_LABELS);
    const school = roleLabelsFor('SCHOOL');
    expect(school).toMatchObject({
      FACULTY: 'Teacher',
      COLLEGE_ADMIN: 'Principal',
      CAMPUS_ADMIN: 'Vice Principal',
    });
    expect(school['STUDENT']).toBe('Student');
    expect(roleLabelsFor('UNIVERSITY')['COLLEGE_ADMIN']).toBe('University administrator');
  });

  it('labels within one institution are distinct (two roles never read alike)', () => {
    for (const type of [null, ...INSTITUTION_TYPES]) {
      const values = Object.values(roleLabelsFor(type));
      expect(new Set(values).size, String(type)).toBe(values.length);
    }
  });

  it('the role matrix is keyed by role code and carries no labels; the authorization layer never imports the institution module', () => {
    expect(Object.keys(ROLE_MATRIX).sort()).toEqual([...ROLE_CODES].sort());
    const dir = resolve(__dirname, '../../src/shared/authorization');
    for (const f of readdirSync(dir).filter((n) => statSync(resolve(dir, n)).isFile())) {
      const text = readFileSync(resolve(dir, f), 'utf8');
      expect(text, f).not.toMatch(
        /institution\.js|roleLabelsFor|INSTITUTION_TYPE|institution\.type/i,
      );
    }
  });
});
