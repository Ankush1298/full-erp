import { AppError } from '../../shared/errors/http-errors.js';
import { STUDENT_STATUSES, type StudentStatus } from './student.schemas.js';
import type { CloseOutcome } from './student-program.service.js';

/**
 * Student status transitions (Phase 3b, docs/architecture/v3/21-students.md §6b). THE one table: the service, the unit
 * tests and the SQL parity test all read it, and migration 0026 states the same 11 pairs in the database guard.
 *
 * Source of each rule (see 21 §6b): the documented lifecycle `ADMITTED -> ACTIVE <-> ON_LEAVE -> GRADUATED` with the
 * exits DISCONTINUED / TRANSFERRED_OUT (doc 02 §6.3) covers ADMITTED -> ACTIVE, ACTIVE <-> ON_LEAVE, ON_LEAVE ->
 * GRADUATED and the exits from ACTIVE. ACTIVE -> GRADUATED, every SUSPENDED edge and the exits from ADMITTED and ON_LEAVE
 * are APPROVED POLICY (decisions D1-D3), not document text. GRADUATED, DISCONTINUED and TRANSFERRED_OUT are terminal for
 * this endpoint; nothing transitions into ADMITTED.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<StudentStatus, readonly StudentStatus[]>> =
  {
    ADMITTED: ['ACTIVE', 'DISCONTINUED'],
    ACTIVE: ['ON_LEAVE', 'SUSPENDED', 'GRADUATED', 'DISCONTINUED'],
    ON_LEAVE: ['ACTIVE', 'GRADUATED', 'DISCONTINUED'],
    SUSPENDED: ['ACTIVE', 'DISCONTINUED'],
    GRADUATED: [],
    DISCONTINUED: [],
    TRANSFERRED_OUT: [],
  };

/**
 * Transitions INTO TRANSFERRED_OUT from a non-terminal, non-initial status are deferred (D4): the institutional meaning of
 * the status and its enrolment effect are not yet confirmed. They answer a stable, documented conflict, different from
 * the answer for a pair that is simply not part of the lifecycle.
 */
export const DEFERRED_STATUS_TRANSITION_SOURCES: readonly StudentStatus[] = [
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
];
export const DEFERRED_STATUS_TARGET: StudentStatus = 'TRANSFERRED_OUT';

export type TransitionVerdict = 'ALLOWED' | 'DEFERRED' | 'INVALID';

export function classifyTransition(from: StudentStatus, to: StudentStatus): TransitionVerdict {
  if (to === DEFERRED_STATUS_TARGET && DEFERRED_STATUS_TRANSITION_SOURCES.includes(from)) {
    return 'DEFERRED';
  }
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to) ? 'ALLOWED' : 'INVALID';
}

/**
 * What a transition does to the student's ACTIVE enrolment. Only these targets close it; ON_LEAVE and SUSPENDED
 * deliberately leave it ACTIVE (the enrolment schema has no usable leave/suspension state: migration 0021 refuses to
 * create or leave an ON_LEAVE row), and ACTIVE changes nothing.
 */
export const ENROLMENT_CLOSE_OUTCOME: Readonly<Partial<Record<StudentStatus, CloseOutcome>>> = {
  GRADUATED: 'COMPLETED',
  DISCONTINUED: 'DISCONTINUED',
};

export const STATUS_TRANSITION_INVALID = 'STUDENT_STATUS_TRANSITION_INVALID';
export const STATUS_TRANSITION_UNAVAILABLE = 'STUDENT_STATUS_TRANSITION_UNAVAILABLE';
export const STATUS_ENROLMENT_NOT_CLOSABLE = 'STUDENT_STATUS_ENROLMENT_NOT_CLOSABLE';

/** Throws the 409 for a pair that may not happen. The message names the two statuses; it reveals nothing else. */
export function assertTransitionAllowed(from: StudentStatus, to: StudentStatus): void {
  const verdict = classifyTransition(from, to);
  if (verdict === 'ALLOWED') return;
  if (verdict === 'DEFERRED') {
    throw new AppError(
      409,
      STATUS_TRANSITION_UNAVAILABLE,
      'A transition to TRANSFERRED_OUT is not available yet.',
    );
  }
  throw new AppError(
    409,
    STATUS_TRANSITION_INVALID,
    `A student cannot change from ${from} to ${to}.`,
  );
}

export function isStudentStatus(v: unknown): v is StudentStatus {
  return typeof v === 'string' && (STUDENT_STATUSES as readonly string[]).includes(v);
}
