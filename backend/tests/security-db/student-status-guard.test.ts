import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATUS_TRANSITIONS,
  classifyTransition,
} from '../../src/modules/students/student-status.js';
import { STUDENT_STATUSES } from '../../src/modules/students/student.schemas.js';
import { adminQuery, runAs, runStepsAs } from '../support/db-harness.js';
import { CTX, NOROLE_A, ORG_A, STUDENT_A } from '../support/fixtures.js';

// Migration 0026: the database side of the student status transition table. Every statement runs through runAs /
// runStepsAs, which ROLL BACK, so the shared fixtures stay pristine. A student is INSERTED with the source status (INSERT is
// not guarded) and then UPDATEd to the target as the real runtime role with a STAFF context.

const idFor = (n: number): string => `01939a00-0000-7000-8000-${(0xe00000000000 + n).toString(16)}`;

describe('0026: the guard function and trigger follow the repository conventions', () => {
  it('SECURITY INVOKER, VOLATILE, pinned search_path, not executable by PUBLIC or the runtime role', async () => {
    const rows = await adminQuery(
      `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS runtime_exec
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'students_status_transition_guard'`,
    );
    expect(rows).toEqual([
      {
        proname: 'students_status_transition_guard',
        prosecdef: false,
        provolatile: 'v',
        proconfig: ['search_path=pg_catalog'],
        public_exec: false,
        runtime_exec: false,
      },
    ]);
  });

  it('is an enabled BEFORE UPDATE row trigger that fires only when the status changes', async () => {
    const rows = await adminQuery<{ tgenabled: string; def: string }>(
      `SELECT t.tgenabled, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
        WHERE t.tgrelid = 'app.students'::regclass AND t.tgname = 'students_status_transition_guard_upd'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tgenabled).toBe('O');
    expect(rows[0]!.def).toMatch(/BEFORE UPDATE ON app\.students FOR EACH ROW/);
    expect(rows[0]!.def).toMatch(/WHEN \(\(old\.status IS DISTINCT FROM new\.status\)\)/);
    expect(rows[0]!.def).toMatch(/EXECUTE FUNCTION app\.students_status_transition_guard\(\)/);
  });
});

describe('0026: the database agrees with the TypeScript table on all 49 pairs', () => {
  let n = 0;
  for (const from of STUDENT_STATUSES) {
    for (const to of STUDENT_STATUSES) {
      const i = ++n;
      const verdict = classifyTransition(from, to);
      // A self-transition is not a CHANGE: the trigger's WHEN clause skips it (a no-op update must stay possible), so the
      // database accepts it. The service refuses it (409 STUDENT_STATUS_TRANSITION_INVALID); see the unit test.
      const selfNoop = from === to;
      const accepted = verdict === 'ALLOWED' || selfNoop;
      it(`${from} -> ${to}: ${accepted ? (selfNoop ? 'accepted by the database (no change; the service refuses it)' : 'accepted') : 'refused with restrict_violation (23001)'}`, async () => {
        const r = await runStepsAs(CTX.staffA, [
          [
            `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
             VALUES ($1, $2, $3, $4, DATE '2024-07-01', $5)`,
            [idFor(i), ORG_A, NOROLE_A, `GUARD-${i}`, from],
          ],
          ['UPDATE app.students SET status = $2 WHERE id = $1', [idFor(i), to]],
        ]);
        if (accepted) {
          expect(r.error).toBeUndefined();
          expect(r.rowCount).toBe(1);
        } else {
          expect(r.error?.code).toBe('23001');
          expect(r.error?.message).toMatch(/invalid student status transition/);
        }
      });
    }
  }

  it('the SQL pairs equal the table: 11 accepted over the full cross product', () => {
    const accepted = STUDENT_STATUSES.flatMap((f) =>
      (ALLOWED_STATUS_TRANSITIONS[f] ?? []).map((t) => `${f}>${t}`),
    );
    expect(accepted).toHaveLength(11);
  });
});

describe('0026: scope of the guard', () => {
  it("INSERT with any of the seven statuses is not affected (the creation rule is the service's)", async () => {
    for (const [i, s] of STUDENT_STATUSES.entries()) {
      const r = await runAs(
        CTX.staffA,
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
         VALUES ($1, $2, $3, $4, DATE '2024-07-01', $5)`,
        [idFor(100 + i), ORG_A, NOROLE_A, `GUARD-INS-${i}`, s],
      );
      expect(r.error, s).toBeUndefined();
    }
  });

  it('an UPDATE that does not change the status is not blocked (even from a terminal status)', async () => {
    const r = await runStepsAs(CTX.staffA, [
      [
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
         VALUES ($1, $2, $3, 'GUARD-NOOP', DATE '2024-07-01', 'GRADUATED')`,
        [idFor(200), ORG_A, NOROLE_A],
      ],
      ['UPDATE app.students SET status = status WHERE id = $1', [idFor(200)]],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(1);
  });

  it('a STUDENT actor still cannot change any status (restrictive STAFF-only update policy): 0 rows, nothing reaches the guard', async () => {
    const r = await runAs(
      CTX.studentA,
      "UPDATE app.students SET status = 'ON_LEAVE' WHERE id = $1",
      [STUDENT_A],
    );
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(0);
  });

  it('an allowed change still stamps status_changed_at (students_guard) and bumps the version (touch)', async () => {
    const r = await runStepsAs(CTX.staffA, [
      [
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
         VALUES ($1, $2, $3, 'GUARD-STAMP', DATE '2024-07-01', 'ADMITTED')`,
        [idFor(300), ORG_A, NOROLE_A],
      ],
      [
        `UPDATE app.students SET status = 'ACTIVE' WHERE id = $1
         RETURNING version, status_changed_at = now() AS stamped`,
        [idFor(300)],
      ],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ version: 2, stamped: true });
  });
});
