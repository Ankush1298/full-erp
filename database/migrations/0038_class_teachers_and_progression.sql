-- 0038_class_teachers_and_progression
-- Owner: app_migrator
-- Milestone 3 (Academic Structure & Enrollment): school academic-model gaps found in Batch 2 (doc 31 §4a).
-- Specification: docs/architecture/v3/32-class-teachers-and-progression.md; 02 §5.3 and 07 §3.1 (repeaters get a REPEAT
--                term enrolment "against a later cohort-period", history preserved, no student duplication).
--
-- Contents:
--  1. app.section_class_teachers - the class (homeroom) teacher of a section, effective-dated, PRIMARY or ASSISTANT. A class
--     teacher is responsible for a section; it is NOT a teaching assignment (faculty_assignments) and never feeds the
--     timetable conflict rules of 0037.
--  2. app.term_enrollments_guard() replaced (0033 §9.7): the own-cohort rule now also admits a REPEAT of an earlier period
--     in a later cohort of the SAME programme, and later enrolments in a cohort joined that way; DETAINED may end as
--     COMPLETED. Nothing else in the guard changes. Existing rows are untouched (the rule only relaxes).
--
-- Deliberately NOT here: a new permission (writes reuse academic.faculty.assign, reads academic.program.read), bulk
-- promotion tooling, attendance (Milestone 4), a link column from a repeat enrolment to the repeated one (the audit event
-- carries it).
--
-- Concurrency. Class teachers: the section row is locked FOR UPDATE (the lock placements and section PATCHes already take,
-- so a section's class teachers are serialised), then the employee (share), then - for a PRIMARY - a transaction-level
-- advisory lock per employee for the "one class per class teacher" rule across sections. Lock order: section -> employee
-- -> advisory; no existing path locks an employee and then a section.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.section_class_teachers (effective-dated)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.section_class_teachers (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  section_id      app.uuid_v7 NOT NULL,
  employee_id     app.uuid_v7 NOT NULL,
  role            text        NOT NULL CHECK (role IN ('PRIMARY', 'ASSISTANT')),
  valid_from      date        NOT NULL,
  valid_to        date,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT section_class_teachers_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT section_class_teachers_section_fk FOREIGN KEY (organization_id, section_id)
    REFERENCES app.sections (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_class_teachers_employee_fk FOREIGN KEY (organization_id, employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_class_teachers_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT section_class_teachers_org_id_uq UNIQUE (organization_id, id)
);
-- At most one OPEN primary per section without any trigger; closed intervals are kept disjoint by the guard.
CREATE UNIQUE INDEX section_class_teachers_one_open_primary_uq
  ON app.section_class_teachers (organization_id, section_id) WHERE role = 'PRIMARY' AND valid_to IS NULL;
CREATE INDEX section_class_teachers_org_section_ix ON app.section_class_teachers (organization_id, section_id);
CREATE INDEX section_class_teachers_org_employee_ix ON app.section_class_teachers (organization_id, employee_id, valid_to);

-- 1.1 Guard. The section (and its cohort period, term and campus) is read under the section row lock.
--     INSERT: open term, dates inside the term, ACTIVE section and cohort period, ACTIVE employee with an active primary
--     posting on the section's campus (the predicate of engine.ts ACTIVE_PRIMARY_POSTING), no overlapping PRIMARY on the
--     section, no overlapping row of the same employee on the section, and (A) a PRIMARY class teacher of one section at a
--     time per employee. An open row counts until its term's end, so last year's assignment never blocks this year.
--     UPDATE: only ending an open row (valid_to NULL -> a date), once; nothing in a LOCKED term.
CREATE FUNCTION app.section_class_teachers_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  s_status  text;
  cp_status text;
  t_status  text;
  t_start   date;
  t_end     date;
  t_campus  uuid;
  tz        text;
  e_status  text;
BEGIN
  SELECT s.status, cp.status, t.status, t.start_date, t.end_date, t.campus_id, c.timezone
    INTO s_status, cp_status, t_status, t_start, t_end, t_campus, tz
    FROM app.sections s
    JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
    JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
    JOIN app.campuses c ON c.organization_id = t.organization_id AND c.id = t.campus_id
   WHERE s.organization_id = NEW.organization_id AND s.id = NEW.section_id
     FOR UPDATE OF s;
  IF NOT FOUND THEN
    RETURN NEW; -- the section foreign key reports it
  END IF;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'class teacher: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.valid_from < t_start OR NEW.valid_from > t_end OR (NEW.valid_to IS NOT NULL AND NEW.valid_to > t_end) THEN
    RAISE EXCEPTION 'class teacher: the dates must lie inside the term (% to %)', t_start, t_end
      USING ERRCODE = 'check_violation', CONSTRAINT = 'section_class_teachers_in_term_ck';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.section_id IS DISTINCT FROM OLD.section_id OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.role IS DISTINCT FROM OLD.role OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
      RAISE EXCEPTION 'class teacher identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.valid_to IS DISTINCT FROM OLD.valid_to AND (OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL) THEN
      RAISE EXCEPTION 'class teacher: only an open assignment can be ended, once' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF s_status <> 'ACTIVE' OR cp_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'class teacher: the section and its cohort period must be ACTIVE' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'section_class_teachers_section_active_ck';
  END IF;
  SELECT e.status INTO e_status FROM app.employees e
   WHERE e.organization_id = NEW.organization_id AND e.id = NEW.employee_id FOR SHARE;
  IF FOUND THEN
    IF e_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'class teacher: the employee must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'section_class_teachers_employee_active_ck';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app.employee_postings p
        JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
       WHERE p.organization_id = NEW.organization_id AND p.employee_id = NEW.employee_id AND d.campus_id = t_campus
         AND p.is_primary = true AND p.valid_to IS NULL AND p.valid_from <= (now() AT TIME ZONE tz)::date) THEN
      RAISE EXCEPTION 'class teacher: the employee has no active primary posting on the section''s campus'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'section_class_teachers_employee_posted_ck';
    END IF;
  END IF;

  IF NEW.role = 'PRIMARY' AND EXISTS (
    SELECT 1 FROM app.section_class_teachers a
     WHERE a.organization_id = NEW.organization_id AND a.section_id = NEW.section_id AND a.role = 'PRIMARY'
       AND a.valid_from <= COALESCE(NEW.valid_to, t_end) AND NEW.valid_from <= COALESCE(a.valid_to, t_end)) THEN
    RAISE EXCEPTION 'class teacher: the section already has a primary class teacher in that period'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'section_class_teachers_primary_excl';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.section_class_teachers a
     WHERE a.organization_id = NEW.organization_id AND a.section_id = NEW.section_id AND a.employee_id = NEW.employee_id
       AND a.valid_from <= COALESCE(NEW.valid_to, t_end) AND NEW.valid_from <= COALESCE(a.valid_to, t_end)) THEN
    RAISE EXCEPTION 'class teacher: the employee is already a class teacher of the section in that period'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'section_class_teachers_employee_excl';
  END IF;

  IF NEW.role = 'PRIMARY' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('app.class_teacher:' || NEW.employee_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM app.section_class_teachers a
        JOIN app.sections s2 ON s2.organization_id = a.organization_id AND s2.id = a.section_id
        JOIN app.cohort_periods cp2 ON cp2.organization_id = s2.organization_id AND cp2.id = s2.cohort_period_id
        JOIN app.terms t2 ON t2.organization_id = cp2.organization_id AND t2.id = cp2.term_id
       WHERE a.organization_id = NEW.organization_id AND a.employee_id = NEW.employee_id AND a.role = 'PRIMARY'
         AND a.section_id <> NEW.section_id
         AND a.valid_from <= COALESCE(NEW.valid_to, t_end) AND NEW.valid_from <= COALESCE(a.valid_to, t2.end_date)) THEN
      RAISE EXCEPTION 'class teacher: the employee is already the primary class teacher of another section in that period'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'section_class_teachers_one_class_excl';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. app.term_enrollments_guard() - 0033 §9.7 with the progression rule of doc 32 §3 (02 §5.3)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.term_enrollments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  sp_status  text;
  sp_cohort  uuid;
  sp_program uuid;
  cp_status  text;
  cp_cohort  uuid;
  cp_program uuid;
  t_status   text;
  t_start    date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT sp.status, sp.cohort_id, sp.program_id INTO sp_status, sp_cohort, sp_program
      FROM app.student_programs sp
     WHERE sp.organization_id = NEW.organization_id AND sp.student_id = NEW.student_id AND sp.id = NEW.student_program_id
       FOR SHARE;
    SELECT cp.status, cp.cohort_id, co.program_id INTO cp_status, cp_cohort, cp_program
      FROM app.cohort_periods cp
      JOIN app.cohorts co ON co.organization_id = cp.organization_id AND co.id = cp.cohort_id
     WHERE cp.organization_id = NEW.organization_id AND cp.id = NEW.cohort_period_id FOR SHARE OF cp;
    SELECT t.status, t.start_date INTO t_status, t_start FROM app.terms t
     WHERE t.organization_id = NEW.organization_id AND t.id = NEW.term_id FOR SHARE;
    IF sp_status IS NOT NULL AND cp_cohort IS NOT NULL THEN
      IF sp_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'term enrolment: the student program must be ACTIVE' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'term_enrollments_program_active_ck';
      END IF;
      IF sp_cohort <> cp_cohort THEN
        IF sp_program <> cp_program THEN
          RAISE EXCEPTION 'term enrolment: the cohort period belongs to another programme'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'term_enrollments_same_program_ck';
        END IF;
        -- Another cohort of the same programme (doc 32 §3): a REPEAT of a period this program enrolment already held in
        -- an earlier term, or a later enrolment in a cohort this program enrolment joined by such a REPEAT.
        IF NOT (
             (NEW.enrollment_type = 'REPEAT' AND EXISTS (
                SELECT 1 FROM app.term_enrollments e
                  JOIN app.terms et ON et.organization_id = e.organization_id AND et.id = e.term_id
                 WHERE e.organization_id = NEW.organization_id AND e.student_id = NEW.student_id
                   AND e.student_program_id = NEW.student_program_id AND e.period_no = NEW.period_no
                   AND et.end_date < t_start))
          OR EXISTS (
                SELECT 1 FROM app.term_enrollments e
                  JOIN app.cohort_periods ecp ON ecp.organization_id = e.organization_id AND ecp.id = e.cohort_period_id
                 WHERE e.organization_id = NEW.organization_id AND e.student_id = NEW.student_id
                   AND e.student_program_id = NEW.student_program_id AND e.enrollment_type = 'REPEAT'
                   AND ecp.cohort_id = cp_cohort)
        ) THEN
          RAISE EXCEPTION 'term enrolment: the student''s program enrolment is in a different cohort'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'term_enrollments_same_cohort_ck';
        END IF;
      END IF;
    END IF;
    IF cp_status IS NOT NULL AND cp_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'term enrolment: the cohort period must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'term_enrollments_cohort_period_active_ck';
    END IF;
    IF t_status IS NOT NULL AND t_status NOT IN ('PLANNED', 'ACTIVE') THEN
      RAISE EXCEPTION 'term enrolment: the term must be PLANNED or ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'term_enrollments_term_open_ck';
    END IF;
    IF NEW.status <> 'REGISTERED' THEN
      RAISE EXCEPTION 'a term enrolment starts REGISTERED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'term_enrollments_starts_registered_ck';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.student_id IS DISTINCT FROM OLD.student_id OR NEW.student_program_id IS DISTINCT FROM OLD.student_program_id
     OR NEW.cohort_period_id IS DISTINCT FROM OLD.cohort_period_id OR NEW.term_id IS DISTINCT FROM OLD.term_id
     OR NEW.period_no IS DISTINCT FROM OLD.period_no OR NEW.enrollment_type IS DISTINCT FROM OLD.enrollment_type
     OR NEW.registered_at IS DISTINCT FROM OLD.registered_at THEN
    RAISE EXCEPTION 'term enrolment identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT t.status INTO t_status FROM app.terms t
   WHERE t.organization_id = NEW.organization_id AND t.id = NEW.term_id FOR SHARE;
  IF FOUND AND t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'a term enrolment in a LOCKED term cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('WITHDRAWN', 'PROMOTED', 'COMPLETED') THEN
    RAISE EXCEPTION 'a % term enrolment is terminal', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'REGISTERED' AND NEW.status IN ('ACTIVE', 'WITHDRAWN'))
    OR (OLD.status = 'ACTIVE'     AND NEW.status IN ('WITHDRAWN', 'DETAINED', 'PROMOTED', 'COMPLETED', 'ON_LEAVE'))
    OR (OLD.status = 'ON_LEAVE'   AND NEW.status IN ('ACTIVE', 'WITHDRAWN'))
    OR (OLD.status = 'DETAINED'   AND NEW.status IN ('ACTIVE', 'WITHDRAWN', 'COMPLETED'))
  ) THEN
    RAISE EXCEPTION 'invalid term enrolment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.section_class_teachers_guard(), app.term_enrollments_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 3. Triggers, row-level security (FORCE) and least-privilege grants
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER section_class_teachers_touch BEFORE UPDATE ON app.section_class_teachers FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER section_class_teachers_immutable BEFORE UPDATE ON app.section_class_teachers FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER section_class_teachers_guard_iu BEFORE INSERT OR UPDATE ON app.section_class_teachers FOR EACH ROW EXECUTE FUNCTION app.section_class_teachers_guard();

ALTER TABLE app.section_class_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.section_class_teachers FORCE  ROW LEVEL SECURITY;
CREATE POLICY section_class_teachers_tenant_select ON app.section_class_teachers AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY section_class_teachers_tenant_insert ON app.section_class_teachers AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY section_class_teachers_tenant_update ON app.section_class_teachers AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Staff-only for reads too: a row names an employee (A2), like faculty_assignments.
CREATE POLICY section_class_teachers_staff_only ON app.section_class_teachers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

-- No DELETE: an assignment is ended, never removed (history, doc 02 §5.1).
GRANT SELECT, INSERT ON app.section_class_teachers TO app_runtime;
GRANT UPDATE (valid_to) ON app.section_class_teachers TO app_runtime;
