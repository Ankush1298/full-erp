import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  PERMISSION_CODES,
  SCOPE_MODES,
} from '../../src/shared/authorization/catalog.js';
import {
  GRANT_RULES,
  ROLE_CODES,
  ROLE_MATRIX,
  ROLE_SCOPE_TYPES,
} from '../../src/shared/authorization/role-matrix.js';

// The architecture document is the specification; the code must equal it (doc 10, intro + §4).
const doc = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../docs/architecture/v3/10-milestone-1-permission-catalog.md',
  ),
  'utf8',
);
const SENS = { N: 'NORMAL', S: 'SENSITIVE', C: 'CRITICAL' } as const;
const MODE = { S: 'SELF', A: 'ASSIGNED', G: 'GRANTED' } as const;

interface DocRow {
  sensitivity: string;
  cells: string[];
}
const docRows = new Map<string, DocRow>();
for (const line of doc.split('\n')) {
  const c = line.split('|').map((x) => x.trim());
  const code = /^`([a-z_.]+)`/.exec(c[2] ?? '')?.[1];
  if (/^\d+a?$/.test(c[1] ?? '') && code && c.length >= 12) {
    docRows.set(code, { sensitivity: c[3] ?? '', cells: c.slice(4, 12) });
  }
}

describe('permission catalog and role matrix equal docs/architecture/v3/10', () => {
  it('the document table was parsed (guards against a silent no-op test)', () => {
    expect(docRows.size).toBeGreaterThan(40);
    expect(ROLE_CODES).toHaveLength(8);
  });

  it('every catalogued permission exists in the document with the same sensitivity', () => {
    for (const p of PERMISSION_CATALOG) {
      expect(docRows.has(p.code), p.code).toBe(true);
      expect(SENS[docRows.get(p.code)!.sensitivity as keyof typeof SENS], p.code).toBe(
        p.sensitivity,
      );
    }
    expect(PERMISSION_CODES.size).toBe(PERMISSION_CATALOG.length); // codes are unique
  });

  it('every (role, permission) cell matches: mode equal, "–" absent, A¹ (not seeded in M1) absent', () => {
    for (const p of PERMISSION_CATALOG) {
      const row = docRows.get(p.code)!;
      ROLE_CODES.forEach((role, i) => {
        const cell = row.cells[i] ?? '';
        const expected =
          cell.includes('¹') || cell === '–' ? undefined : MODE[cell as keyof typeof MODE];
        expect(ROLE_MATRIX[role][p.code], `${role} ${p.code} (doc: ${cell})`).toBe(expected);
      });
    }
  });

  it('the matrix references only catalogued permissions and valid modes; no scope word in a code', () => {
    for (const [role, perms] of Object.entries(ROLE_MATRIX)) {
      for (const [code, mode] of Object.entries(perms)) {
        expect(PERMISSION_CODES.has(code), `${role} ${code}`).toBe(true);
        expect(SCOPE_MODES).toContain(mode);
      }
    }
    for (const p of PERMISSION_CATALOG)
      expect(p.code).not.toMatch(/\.(own|all|dept|department_wide)(\.|$)/);
  });

  it('reserved namespaces are not seeded (doc 10 §3)', () => {
    for (const p of PERMISSION_CATALOG)
      expect(p.code).not.toMatch(/^(attendance|exam|result|finance)\./);
  });

  it('grant rules and role scope types are defined for every role and reference real roles only', () => {
    expect(Object.keys(ROLE_SCOPE_TYPES).sort()).toEqual([...ROLE_CODES].sort());
    for (const [grantor, grantable] of Object.entries(GRANT_RULES)) {
      expect(ROLE_CODES).toContain(grantor);
      for (const r of grantable) expect(ROLE_CODES).toContain(r);
      // only a roles-manager can grant at all
      expect(ROLE_MATRIX[grantor as keyof typeof ROLE_MATRIX]['role.assignment.grant']).toBe(
        'GRANTED',
      );
    }
    // doc 06 §5: nobody but COLLEGE_ADMIN may grant COLLEGE_ADMIN
    expect(
      Object.entries(GRANT_RULES)
        .filter(([, g]) => g.includes('COLLEGE_ADMIN'))
        .map(([k]) => k),
    ).toEqual(['COLLEGE_ADMIN']);
    // every role that holds the grant permission has grant rules (otherwise the permission is dead)
    for (const [role, perms] of Object.entries(ROLE_MATRIX)) {
      if (perms['role.assignment.grant']) expect(GRANT_RULES[role], role).toBeDefined();
    }
  });

  it('student.program.assign: SENSITIVE, GRANTED to exactly DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR with their scope types', () => {
    expect(PERMISSION_CATALOG.find((p) => p.code === 'student.program.assign')).toEqual({
      code: 'student.program.assign',
      sensitivity: 'SENSITIVE',
    });
    const holders = ROLE_CODES.filter((r) => ROLE_MATRIX[r]['student.program.assign']);
    expect([...holders].sort()).toEqual(
      ['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'DEPARTMENT_ADMIN', 'REGISTRAR'].sort(),
    );
    for (const r of holders) expect(ROLE_MATRIX[r]['student.program.assign']).toBe('GRANTED');
    expect(ROLE_SCOPE_TYPES.DEPARTMENT_ADMIN).toEqual(['DEPARTMENT']);
    expect(ROLE_SCOPE_TYPES.CAMPUS_ADMIN).toEqual(['CAMPUS']);
    expect(ROLE_SCOPE_TYPES.COLLEGE_ADMIN).toEqual(['ORGANIZATION']);
    expect(ROLE_SCOPE_TYPES.REGISTRAR).toEqual(['ORGANIZATION', 'CAMPUS']);
  });

  it('student.directory.search: SENSITIVE, GRANTED to exactly HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR', () => {
    expect(PERMISSION_CATALOG.find((p) => p.code === 'student.directory.search')).toEqual({
      code: 'student.directory.search',
      sensitivity: 'SENSITIVE',
    });
    const holders = ROLE_CODES.filter((r) => ROLE_MATRIX[r]['student.directory.search']);
    expect([...holders].sort()).toEqual(
      ['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'DEPARTMENT_ADMIN', 'HOD', 'REGISTRAR'].sort(),
    );
    for (const r of holders) expect(ROLE_MATRIX[r]['student.directory.search']).toBe('GRANTED');
    for (const r of ['STUDENT', 'FACULTY', 'STAFF'] as const) {
      expect(ROLE_MATRIX[r]['student.directory.search']).toBeUndefined();
    }
  });

  it('student.status.change (0025): CRITICAL, GRANTED to exactly CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, and every holder also holds student.program.assign (the status change closes the enrolment on that authority)', () => {
    expect(PERMISSION_CATALOG.find((p) => p.code === 'student.status.change')).toEqual({
      code: 'student.status.change',
      sensitivity: 'CRITICAL',
    });
    const holders = ROLE_CODES.filter((r) => ROLE_MATRIX[r]['student.status.change']);
    expect([...holders].sort()).toEqual(['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR']);
    for (const r of holders) {
      expect(ROLE_MATRIX[r]['student.status.change']).toBe('GRANTED');
      // decision D7: the permission alone authorizes the closure, which is only safe while it is a subset of
      // student.program.assign in the role matrix; a change that breaks this must be a deliberate decision
      expect(ROLE_MATRIX[r]['student.program.assign'], r).toBe('GRANTED');
    }
    for (const r of ['STUDENT', 'FACULTY', 'STAFF', 'HOD', 'DEPARTMENT_ADMIN'] as const) {
      expect(ROLE_MATRIX[r]['student.status.change']).toBeUndefined();
    }
  });

  it('student.directory.list (0024): SENSITIVE, GRANTED to exactly HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, independent of .search, with their scope types', () => {
    expect(PERMISSION_CATALOG.find((p) => p.code === 'student.directory.list')).toEqual({
      code: 'student.directory.list',
      sensitivity: 'SENSITIVE',
    });
    const holders = ROLE_CODES.filter((r) => ROLE_MATRIX[r]['student.directory.list']);
    expect([...holders].sort()).toEqual(
      ['CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'DEPARTMENT_ADMIN', 'HOD', 'REGISTRAR'].sort(),
    );
    for (const r of holders) expect(ROLE_MATRIX[r]['student.directory.list']).toBe('GRANTED');
    for (const r of ['STUDENT', 'FACULTY', 'STAFF'] as const) {
      expect(ROLE_MATRIX[r]['student.directory.list']).toBeUndefined();
    }
    // the scope is the assignment's, never the role name's: REGISTRAR may hold an ORGANIZATION or a CAMPUS assignment,
    // HOD only a DEPARTMENT one
    expect(ROLE_SCOPE_TYPES.HOD).toEqual(['DEPARTMENT']);
    expect(ROLE_SCOPE_TYPES.DEPARTMENT_ADMIN).toEqual(['DEPARTMENT']);
    expect(ROLE_SCOPE_TYPES.CAMPUS_ADMIN).toEqual(['CAMPUS']);
    expect(ROLE_SCOPE_TYPES.COLLEGE_ADMIN).toEqual(['ORGANIZATION']);
    expect(ROLE_SCOPE_TYPES.REGISTRAR).toEqual(['ORGANIZATION', 'CAMPUS']);
    // the two directory permissions are separate catalog entries held by the same five roles today; neither implies the other
    expect(PERMISSION_CODES.has('student.directory.search')).toBe(true);
    expect(PERMISSION_CODES.has('student.directory.list')).toBe(true);
  });
});
