import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATUS_TRANSITIONS,
  ENROLMENT_CLOSE_OUTCOME,
  STATUS_ENROLMENT_NOT_CLOSABLE,
  STATUS_TRANSITION_INVALID,
  STATUS_TRANSITION_UNAVAILABLE,
  assertTransitionAllowed,
  classifyTransition,
  isStudentStatus,
} from '../../src/modules/students/student-status.js';
import { CLOSE_OUTCOMES } from '../../src/modules/students/student-program.service.js';
import {
  STUDENT_STATUSES,
  type StudentStatus,
} from '../../src/modules/students/student.schemas.js';

// The approved transition table (Phase 3b, decisions D1-D4), written out INDEPENDENTLY of the code under test: one row per
// source status, one character per target in STUDENT_STATUSES order (ADMITTED, ACTIVE, ON_LEAVE, SUSPENDED, GRADUATED,
// DISCONTINUED, TRANSFERRED_OUT). 'A' allowed, 'D' deferred (TRANSFERRED_OUT, answers ..._UNAVAILABLE), '.' invalid.
const ORDER = [
  'ADMITTED',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'GRADUATED',
  'DISCONTINUED',
  'TRANSFERRED_OUT',
] as const;
const MATRIX: Record<StudentStatus, string> = {
  ADMITTED: '.A...A.',
  ACTIVE: '..AAAAD',
  ON_LEAVE: '.A..AAD',
  SUSPENDED: '.A...AD',
  GRADUATED: '.......',
  DISCONTINUED: '.......',
  TRANSFERRED_OUT: '.......',
};

describe('student status transitions: the 49-pair table', () => {
  it('covers exactly the seven schema statuses (as a set; the column order of this test is its own)', () => {
    expect([...STUDENT_STATUSES].sort()).toEqual([...ORDER].sort());
    expect(Object.keys(MATRIX).sort()).toEqual([...ORDER].sort());
    expect(Object.keys(ALLOWED_STATUS_TRANSITIONS).sort()).toEqual([...ORDER].sort());
  });

  for (const from of ORDER) {
    for (const [i, to] of ORDER.entries()) {
      const cell = MATRIX[from][i];
      const verdict = cell === 'A' ? 'ALLOWED' : cell === 'D' ? 'DEFERRED' : 'INVALID';
      it(`${from} -> ${to}: ${verdict}`, () => {
        expect(classifyTransition(from, to)).toBe(verdict);
        if (verdict === 'ALLOWED') {
          expect(() => assertTransitionAllowed(from, to)).not.toThrow();
        } else {
          const code =
            verdict === 'DEFERRED' ? STATUS_TRANSITION_UNAVAILABLE : STATUS_TRANSITION_INVALID;
          expect(() => assertTransitionAllowed(from, to)).toThrowError(
            expect.objectContaining({ statusCode: 409, code }),
          );
        }
      });
    }
  }

  it('the table has 11 allowed, 3 deferred and 35 rejected pairs (7 of them self-transitions)', () => {
    const verdicts = ORDER.flatMap((f) => ORDER.map((t) => classifyTransition(f, t)));
    expect(verdicts).toHaveLength(49);
    expect(verdicts.filter((v) => v === 'ALLOWED')).toHaveLength(11);
    expect(verdicts.filter((v) => v === 'DEFERRED')).toHaveLength(3);
    expect(verdicts.filter((v) => v === 'INVALID')).toHaveLength(35);
    for (const s of ORDER) expect(classifyTransition(s, s), `${s} -> ${s}`).toBe('INVALID');
  });

  it('nothing leads to ADMITTED, the three exit statuses are terminal, and TRANSFERRED_OUT is never allowed', () => {
    for (const f of ORDER) expect(ALLOWED_STATUS_TRANSITIONS[f]).not.toContain('ADMITTED');
    for (const f of ['GRADUATED', 'DISCONTINUED', 'TRANSFERRED_OUT'] as const) {
      expect(ALLOWED_STATUS_TRANSITIONS[f]).toEqual([]);
    }
    for (const f of ORDER) expect(ALLOWED_STATUS_TRANSITIONS[f]).not.toContain('TRANSFERRED_OUT');
  });

  it('the documented chain is present: ADMITTED->ACTIVE, ACTIVE<->ON_LEAVE, ON_LEAVE->GRADUATED and the ACTIVE exits', () => {
    expect(classifyTransition('ADMITTED', 'ACTIVE')).toBe('ALLOWED');
    expect(classifyTransition('ACTIVE', 'ON_LEAVE')).toBe('ALLOWED');
    expect(classifyTransition('ON_LEAVE', 'ACTIVE')).toBe('ALLOWED');
    expect(classifyTransition('ON_LEAVE', 'GRADUATED')).toBe('ALLOWED');
    expect(classifyTransition('ACTIVE', 'DISCONTINUED')).toBe('ALLOWED');
  });

  it('SUSPENDED: entered only from ACTIVE; left to ACTIVE or DISCONTINUED; never straight to graduation', () => {
    const into = ORDER.filter((f) => classifyTransition(f, 'SUSPENDED') === 'ALLOWED');
    expect(into).toEqual(['ACTIVE']);
    expect([...ALLOWED_STATUS_TRANSITIONS.SUSPENDED]).toEqual(['ACTIVE', 'DISCONTINUED']);
    expect(classifyTransition('SUSPENDED', 'GRADUATED')).toBe('INVALID');
  });
});

describe('student status transitions: the effect on the ACTIVE enrolment', () => {
  it('only GRADUATED (COMPLETED) and DISCONTINUED (DISCONTINUED) close it; every other target leaves it alone', () => {
    expect(ENROLMENT_CLOSE_OUTCOME).toEqual({
      GRADUATED: 'COMPLETED',
      DISCONTINUED: 'DISCONTINUED',
    });
    for (const outcome of Object.values(ENROLMENT_CLOSE_OUTCOME)) {
      expect(CLOSE_OUTCOMES as readonly string[]).toContain(outcome);
    }
  });

  it('every ALLOWED transition has a defined effect: closes (GRADUATED, DISCONTINUED) or leaves the enrolment unchanged', () => {
    let allowed = 0;
    for (const from of ORDER) {
      for (const to of ALLOWED_STATUS_TRANSITIONS[from]) {
        allowed++;
        const effect = ENROLMENT_CLOSE_OUTCOME[to] ?? 'UNCHANGED';
        expect(['COMPLETED', 'DISCONTINUED', 'UNCHANGED'], `${from} -> ${to}`).toContain(effect);
        if (to === 'ACTIVE' || to === 'ON_LEAVE' || to === 'SUSPENDED')
          expect(effect).toBe('UNCHANGED');
      }
    }
    expect(allowed).toBe(11);
  });
});

describe('student status transitions: stable error codes and input guards', () => {
  it('the three codes are fixed strings (a documented API contract)', () => {
    expect(STATUS_TRANSITION_INVALID).toBe('STUDENT_STATUS_TRANSITION_INVALID');
    expect(STATUS_TRANSITION_UNAVAILABLE).toBe('STUDENT_STATUS_TRANSITION_UNAVAILABLE');
    expect(STATUS_ENROLMENT_NOT_CLOSABLE).toBe('STUDENT_STATUS_ENROLMENT_NOT_CLOSABLE');
  });

  it('isStudentStatus accepts exactly the seven statuses', () => {
    for (const s of ORDER) expect(isStudentStatus(s)).toBe(true);
    for (const v of ['active', 'ANONYMIZED', '', ' ACTIVE', null, undefined, 1, {}]) {
      expect(isStudentStatus(v), JSON.stringify(v) ?? 'undefined').toBe(false);
    }
  });

  it('the deferred answer never names a different status than TRANSFERRED_OUT and the invalid answer names both ends', () => {
    expect(() => assertTransitionAllowed('ACTIVE', 'TRANSFERRED_OUT')).toThrowError(
      /TRANSFERRED_OUT is not available yet/,
    );
    expect(() => assertTransitionAllowed('GRADUATED', 'ACTIVE')).toThrowError(
      /cannot change from GRADUATED to ACTIVE/,
    );
  });
});
