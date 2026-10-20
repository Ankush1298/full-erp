-- 0026_student_status_transition_guard
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students Phase 3b: the database side of the student status transition table
-- (docs/architecture/v3/21-students.md §6b; backend/src/modules/students/student-status.ts is the TypeScript side, and
-- tests/security-db/student-status-guard.test.ts pins that the two agree for all 49 pairs).
--
-- Why a database guard: the runtime role holds a direct column-level UPDATE (status) on app.students (0017), and
-- app.students_guard() only stamps status_changed_at. Without this trigger any code path (or a mistake in a future one)
-- could write an arbitrary status. The service is the primary check and answers with stable error codes; this is defence in
-- depth, the same pattern as app.student_programs_guard() (0021).
--
-- The 11 permitted pairs (everything else, self-transitions included, raises restrict_violation / SQLSTATE 23001):
--   ADMITTED -> ACTIVE, DISCONTINUED
--   ACTIVE   -> ON_LEAVE, SUSPENDED, GRADUATED, DISCONTINUED
--   ON_LEAVE -> ACTIVE, GRADUATED, DISCONTINUED
--   SUSPENDED-> ACTIVE, DISCONTINUED
-- GRADUATED, DISCONTINUED and TRANSFERRED_OUT are terminal, nothing leads to ADMITTED, and NO transition into
-- TRANSFERRED_OUT is permitted yet: its institutional meaning and enrolment effect are not confirmed (decision D4). Enabling
-- it later is a new migration that replaces this function.
--
-- It fires only when the status CHANGES (WHEN clause), for every role including a superuser; like the other guards it is not
-- fired for a session with session_replication_role = replica (the runtime role cannot set it) or after the trigger is
-- dropped. INSERT is unaffected (a new student starts ADMITTED, the service's rule), and existing rows are not touched.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so 0026
-- runs only after 0019 (and 0020 to 0025). Until then the database guard is INACTIVE and only the service protects the
-- transition table (docs/runbooks/students-contract-rollout.md).

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION app.students_status_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT (
       (OLD.status = 'ADMITTED'  AND NEW.status IN ('ACTIVE', 'DISCONTINUED'))
    OR (OLD.status = 'ACTIVE'    AND NEW.status IN ('ON_LEAVE', 'SUSPENDED', 'GRADUATED', 'DISCONTINUED'))
    OR (OLD.status = 'ON_LEAVE'  AND NEW.status IN ('ACTIVE', 'GRADUATED', 'DISCONTINUED'))
    OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'DISCONTINUED'))
  ) THEN
    RAISE EXCEPTION 'invalid student status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.students_status_transition_guard() FROM PUBLIC;

CREATE TRIGGER students_status_transition_guard_upd BEFORE UPDATE ON app.students
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION app.students_status_transition_guard();
