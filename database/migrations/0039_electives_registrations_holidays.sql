-- 0039_electives_registrations_holidays
-- Owner: app_migrator
-- Milestone 3 (Academic Structure & Enrollment), Batch 3.
-- Specification: docs/architecture/v3/02 §4.5 (elective_groups, course_offerings.elective_group_id), §4.6
--                (course_registrations), 07 §3.2 (registration rules), 01 (Holiday: campus nullable, date, name, kind),
--                04 Part 16 (Milestone 3), docs/architecture/v3/33-electives-registrations-holidays-m3b3.md.
--
-- Contents:
--  1. app.elective_groups            - "choose min..max from this basket" of one cohort period, with a registration window
--  2. app.course_offerings           - + elective_group_id (an elective offering may belong to a basket of its cohort period)
--  3. app.course_registrations       - a student x offering, effective-dated; SEPARATE from term enrolment (doc 02 §4.5)
--  4. app.holidays                   - non-teaching days and calendar events, per campus or organization-wide
--  5. app.section_class_teachers_guard() replaced (0038): the employee's primary postings on the section's campus must
--     cover EVERY day of the assignment (effective-dated), instead of "an open posting started by today".
--
-- Deliberately NOT here: attendance tables (Milestone 4), student self-service registration writes (registrations are
-- staff-written in this batch; students read their own), an approval workflow for PENDING_APPROVAL (the status exists,
-- nothing creates it yet), cascades of any kind (closing an enrolment, a section move or an offering never closes
-- registrations silently).
--
-- Concurrency. Registrations lock their term enrolment row FOR UPDATE (per-student serialisation of max_select, like
-- section placements) and then the offering FOR UPDATE (capacity). Lock order: term enrolment -> offering -> elective
-- group (share). No existing path locks an offering and then a term enrolment. Holidays take no row locks beyond the
-- terms they read (share).
--
-- ROLLOUT: not a *_contract migration; the runner defers it behind 0009/0019 like 0020-0038. ALTER TABLE on
-- app.course_offerings takes ACCESS EXCLUSIVE briefly (nullable column, no default, no rewrite; the FK validates an
-- all-NULL column).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.elective_groups
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.elective_groups (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  cohort_period_id app.uuid_v7 NOT NULL,
  code             text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 30),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  min_select       smallint    NOT NULL CHECK (min_select BETWEEN 0 AND 50),
  max_select       smallint    NOT NULL CHECK (max_select BETWEEN 1 AND 50),
  opens_at         timestamptz,
  closes_at        timestamptz,
  status           text        NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'OPEN', 'CLOSED')),
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT elective_groups_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT elective_groups_cohort_period_fk FOREIGN KEY (organization_id, cohort_period_id)
    REFERENCES app.cohort_periods (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT elective_groups_min_max_ck CHECK (min_select <= max_select),
  CONSTRAINT elective_groups_window_ck CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
  CONSTRAINT elective_groups_period_code_uq UNIQUE (cohort_period_id, code),
  CONSTRAINT elective_groups_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT elective_groups_org_period_id_uq UNIQUE (organization_id, cohort_period_id, id)
);
CREATE INDEX elective_groups_org_cohort_period_ix ON app.elective_groups (organization_id, cohort_period_id);

-- ---------------------------------------------------------------------------------------------
-- 2. app.course_offerings.elective_group_id
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.course_offerings ADD COLUMN elective_group_id app.uuid_v7;
-- The group belongs to the offering's own cohort period (composite key; a NULL cohort period cannot carry a group).
ALTER TABLE app.course_offerings
  ADD CONSTRAINT course_offerings_elective_group_fk FOREIGN KEY (organization_id, cohort_period_id, elective_group_id)
    REFERENCES app.elective_groups (organization_id, cohort_period_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT course_offerings_elective_group_ck CHECK (
    elective_group_id IS NULL
    OR (cohort_period_id IS NOT NULL AND offering_kind IN ('ELECTIVE', 'OPEN_ELECTIVE', 'OPTIONAL')));
CREATE INDEX course_offerings_elective_group_ix
  ON app.course_offerings (organization_id, cohort_period_id, elective_group_id) WHERE elective_group_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. app.course_registrations (effective-dated, student-bearing)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.course_registrations (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  term_enrollment_id app.uuid_v7 NOT NULL,
  student_id         app.uuid_v7 NOT NULL,
  course_offering_id app.uuid_v7 NOT NULL,
  -- DERIVED by the guard from the offering; whatever a writer supplies is overwritten.
  elective_group_id  app.uuid_v7,
  status             text        NOT NULL DEFAULT 'REGISTERED' CHECK (status IN
    ('PENDING_APPROVAL', 'REGISTERED', 'REJECTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED')),
  valid_from         date        NOT NULL CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  valid_to           date        CHECK (valid_to IS NULL OR valid_to BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  source             text        NOT NULL CHECK (source IN ('AUTO_SECTION', 'MANUAL', 'ELECTIVE_CHOICE', 'ADMIN')),
  registration_kind  text        NOT NULL DEFAULT 'REGULAR' CHECK (registration_kind IN
    ('REGULAR', 'BACKLOG', 'IMPROVEMENT', 'AUDIT', 'EXEMPTED')),
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_registrations_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- the registration's student IS the enrolment's student
  CONSTRAINT course_registrations_enrollment_fk FOREIGN KEY (organization_id, student_id, term_enrollment_id)
    REFERENCES app.term_enrollments (organization_id, student_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_registrations_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_registrations_group_fk FOREIGN KEY (organization_id, elective_group_id)
    REFERENCES app.elective_groups (organization_id, id) ON DELETE RESTRICT,
  -- live (PENDING_APPROVAL, REGISTERED) <=> open; every other status is closed with a date
  CONSTRAINT course_registrations_open_iff_live_ck CHECK ((status IN ('PENDING_APPROVAL', 'REGISTERED')) = (valid_to IS NULL)),
  CONSTRAINT course_registrations_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT course_registrations_org_id_uq UNIQUE (organization_id, id)
);
-- doc 02: UQ(student_id, course_offering_id) WHERE valid_to IS NULL
CREATE UNIQUE INDEX course_registrations_one_live_uq
  ON app.course_registrations (organization_id, student_id, course_offering_id) WHERE valid_to IS NULL;
CREATE INDEX course_registrations_offering_live_ix
  ON app.course_registrations (organization_id, course_offering_id) WHERE valid_to IS NULL;
CREATE INDEX course_registrations_org_enrollment_ix
  ON app.course_registrations (organization_id, student_id, term_enrollment_id);
CREATE INDEX course_registrations_org_offering_ix ON app.course_registrations (organization_id, course_offering_id);
CREATE INDEX course_registrations_org_group_ix
  ON app.course_registrations (organization_id, elective_group_id) WHERE elective_group_id IS NOT NULL;
CREATE INDEX course_registrations_org_student_from_ix ON app.course_registrations (organization_id, student_id, valid_from);

-- ---------------------------------------------------------------------------------------------
-- 4. app.holidays (doc 01 Holiday / AcademicCalendarEvent; cancelled, never deleted)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.holidays (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  campus_id       app.uuid_v7,                -- NULL = every campus of the organization
  holiday_date    date        NOT NULL CHECK (holiday_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind            text        NOT NULL CHECK (kind IN ('HOLIDAY', 'NON_TEACHING_DAY', 'EVENT')),
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holidays_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT holidays_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT holidays_org_id_uq UNIQUE (organization_id, id)
);
-- doc 01: unique (campus, date, name), among ACTIVE rows (a cancelled holiday can be re-declared)
CREATE UNIQUE INDEX holidays_campus_date_name_uq
  ON app.holidays (organization_id, COALESCE(campus_id::text, ''), holiday_date, lower(name)) WHERE status = 'ACTIVE';
CREATE INDEX holidays_org_campus_ix ON app.holidays (organization_id, campus_id);
CREATE INDEX holidays_org_date_ix ON app.holidays (organization_id, holiday_date);

-- ---------------------------------------------------------------------------------------------
-- 5. Guards (SECURITY INVOKER, volatile, pinned search_path - the 0033/0037 family)
-- ---------------------------------------------------------------------------------------------

-- 5.1 elective_groups: under an ACTIVE cohort period in an open term; PLANNED -> OPEN -> CLOSED; identity fixed; max_select
--     cannot drop below a student's live registrations; closing needs every live enrolment of the period to meet
--     min_select (doc 02: "validated against group min/max/window").
CREATE FUNCTION app.elective_groups_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  cp_status text;
  t_status  text;
BEGIN
  SELECT cp.status, t.status INTO cp_status, t_status
    FROM app.cohort_periods cp
    JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
   WHERE cp.organization_id = NEW.organization_id AND cp.id = NEW.cohort_period_id FOR SHARE OF cp;
  IF NOT FOUND THEN
    RETURN NEW; -- the cohort period foreign key reports it
  END IF;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'elective group: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'elective group: a new group starts PLANNED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'elective_groups_starts_planned_ck';
    END IF;
    IF cp_status <> 'ACTIVE' OR t_status NOT IN ('PLANNED', 'ACTIVE') THEN
      RAISE EXCEPTION 'elective group: the cohort period must be ACTIVE in a PLANNED or ACTIVE term'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'elective_groups_period_open_ck';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.cohort_period_id IS DISTINCT FROM OLD.cohort_period_id OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'elective group identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a CLOSED elective group cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PLANNED' AND NEW.status = 'OPEN') OR (OLD.status = 'OPEN' AND NEW.status = 'CLOSED')) THEN
    RAISE EXCEPTION 'invalid elective group status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'elective_groups_transition_ck';
  END IF;
  IF NEW.max_select < OLD.max_select AND EXISTS (
    SELECT 1 FROM app.course_registrations r
     WHERE r.organization_id = NEW.organization_id AND r.elective_group_id = NEW.id AND r.valid_to IS NULL
     GROUP BY r.term_enrollment_id HAVING count(*) > NEW.max_select) THEN
    RAISE EXCEPTION 'elective group: a student already holds more than % registrations in the group', NEW.max_select
      USING ERRCODE = 'check_violation', CONSTRAINT = 'elective_groups_max_in_use_ck';
  END IF;
  IF NEW.status = 'CLOSED' AND NEW.min_select > 0 AND EXISTS (
    SELECT 1 FROM app.term_enrollments e
     WHERE e.organization_id = NEW.organization_id AND e.cohort_period_id = NEW.cohort_period_id
       AND e.status IN ('REGISTERED', 'ACTIVE')
       AND (SELECT count(*) FROM app.course_registrations r
             WHERE r.organization_id = e.organization_id AND r.term_enrollment_id = e.id
               AND r.elective_group_id = NEW.id AND r.valid_to IS NULL) < NEW.min_select) THEN
    RAISE EXCEPTION 'elective group: a live enrolment of the cohort period holds fewer than % registrations in the group',
      NEW.min_select USING ERRCODE = 'check_violation', CONSTRAINT = 'elective_groups_min_select_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 5.2 course_offerings (in addition to the 0037 guard): the elective group is fixed at creation and must not be CLOSED;
--     capacity cannot drop below the live registrations.
CREATE FUNCTION app.course_offerings_registration_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  g_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.elective_group_id IS NOT NULL THEN
      SELECT g.status INTO g_status FROM app.elective_groups g
       WHERE g.organization_id = NEW.organization_id AND g.id = NEW.elective_group_id FOR SHARE;
      IF FOUND AND g_status = 'CLOSED' THEN
        RAISE EXCEPTION 'course offering: the elective group is CLOSED' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'course_offerings_group_open_ck';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.elective_group_id IS DISTINCT FROM OLD.elective_group_id THEN
    RAISE EXCEPTION 'course offering identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.capacity IS NOT NULL AND NEW.capacity IS DISTINCT FROM OLD.capacity AND (
       SELECT count(*) FROM app.course_registrations r
        WHERE r.organization_id = NEW.organization_id AND r.course_offering_id = NEW.id AND r.valid_to IS NULL
     ) > NEW.capacity THEN
    RAISE EXCEPTION 'course offering: capacity % is below its live registrations', NEW.capacity
      USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_capacity_in_use_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 5.3 course_registrations. The term enrolment row is locked first (per-student serialisation), then the offering
--     (capacity). INSERT: a REGISTERED/ACTIVE enrolment; a PUBLISHED offering of the SAME term; the audience (the
--     enrolment's own cohort period, and its section when the offering is section-bound) unless the kind is BACKLOG or
--     IMPROVEMENT (doc 07: a backlog paper attaches to the current enrolment); valid_from inside the term; capacity; and
--     for a basket: only ELECTIVE_CHOICE, inside the window of an OPEN group, and nobody exceeds max_select. UPDATE: only a live row may close (status + valid_to together, CHECK above), once.
CREATE FUNCTION app.course_registrations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  e_status  text;
  e_term    uuid;
  e_period  uuid;
  t_status  text;
  t_start   date;
  t_end     date;
  o_status  text;
  o_term    uuid;
  o_period  uuid;
  o_section uuid;
  o_group   uuid;
  o_cap     smallint;
  g_status  text;
  g_opens   timestamptz;
  g_closes  timestamptz;
  g_max     smallint;
  cross_ok  boolean;
BEGIN
  SELECT e.status, e.term_id, e.cohort_period_id INTO e_status, e_term, e_period
    FROM app.term_enrollments e
   WHERE e.organization_id = NEW.organization_id AND e.student_id = NEW.student_id AND e.id = NEW.term_enrollment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- left to the foreign keys
  END IF;
  SELECT t.status, t.start_date, t.end_date INTO t_status, t_start, t_end
    FROM app.terms t WHERE t.organization_id = NEW.organization_id AND t.id = e_term FOR SHARE;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'course registration: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.term_enrollment_id IS DISTINCT FROM OLD.term_enrollment_id OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id
       OR NEW.elective_group_id IS DISTINCT FROM OLD.elective_group_id OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.registration_kind IS DISTINCT FROM OLD.registration_kind THEN
      RAISE EXCEPTION 'course registration identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.valid_to IS NOT NULL AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
      RAISE EXCEPTION 'a closed course registration is terminal' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('REGISTERED', 'REJECTED'))
      OR (OLD.status = 'REGISTERED' AND NEW.status IN ('DROPPED', 'WITHDRAWN', 'COMPLETED'))) THEN
      RAISE EXCEPTION 'invalid course registration status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_transition_ck';
    END IF;
    IF NEW.valid_to IS NOT NULL AND NEW.valid_to > t_end THEN
      RAISE EXCEPTION 'course registration: valid_to must lie within the term' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'course_registrations_within_term_ck';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('PENDING_APPROVAL', 'REGISTERED') THEN
    RAISE EXCEPTION 'a course registration starts REGISTERED or PENDING_APPROVAL' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'course_registrations_starts_live_ck';
  END IF;
  IF e_status NOT IN ('REGISTERED', 'ACTIVE') THEN
    RAISE EXCEPTION 'course registration: the term enrolment is not open' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'course_registrations_enrollment_open_ck';
  END IF;
  IF NEW.valid_from < t_start OR NEW.valid_from > t_end THEN
    RAISE EXCEPTION 'course registration: valid_from must lie within the term' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'course_registrations_within_term_ck';
  END IF;

  SELECT o.status, o.term_id, o.cohort_period_id, o.section_id, o.elective_group_id, o.capacity
    INTO o_status, o_term, o_period, o_section, o_group, o_cap
    FROM app.course_offerings o
   WHERE o.organization_id = NEW.organization_id AND o.id = NEW.course_offering_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the offering foreign key reports it
  END IF;
  NEW.elective_group_id := o_group; -- derived, never supplied
  IF o_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'course registration: the offering must be PUBLISHED' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'course_registrations_offering_published_ck';
  END IF;
  IF o_term <> e_term THEN
    RAISE EXCEPTION 'course registration: the offering runs in another term than the enrolment'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_same_term_ck';
  END IF;
  cross_ok := NEW.registration_kind IN ('BACKLOG', 'IMPROVEMENT');
  IF NOT cross_ok AND o_period IS NOT NULL AND o_period <> e_period THEN
    RAISE EXCEPTION 'course registration: the offering is for another cohort period (register it as BACKLOG or IMPROVEMENT)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_audience_ck';
  END IF;
  IF NOT cross_ok AND o_section IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.section_memberships m
     WHERE m.organization_id = NEW.organization_id AND m.term_enrollment_id = NEW.term_enrollment_id
       AND m.section_id = o_section AND m.valid_from <= NEW.valid_from
       AND (m.valid_to IS NULL OR m.valid_to >= NEW.valid_from)) THEN
    RAISE EXCEPTION 'course registration: the student is not in the offering''s section on valid_from'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_section_ck';
  END IF;

  IF o_group IS NOT NULL THEN
    -- doc 07 §3.2: a basket is registered by ELECTIVE_CHOICE (the student, or staff on their behalf) inside the window
    -- of an OPEN group. No administrative override outside the window is specified, so none exists (doc 33 §8).
    IF NEW.source <> 'ELECTIVE_CHOICE' THEN
      RAISE EXCEPTION 'course registration: a basket offering is registered by ELECTIVE_CHOICE'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_group_source_ck';
    END IF;
    SELECT g.status, g.opens_at, g.closes_at, g.max_select INTO g_status, g_opens, g_closes, g_max
      FROM app.elective_groups g WHERE g.organization_id = NEW.organization_id AND g.id = o_group FOR SHARE;
    IF g_status <> 'OPEN' OR (g_opens IS NOT NULL AND now() < g_opens) OR (g_closes IS NOT NULL AND now() >= g_closes) THEN
      RAISE EXCEPTION 'course registration: the elective group is not open for choices now'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_window_ck';
    END IF;
    IF (SELECT count(*) FROM app.course_registrations r
         WHERE r.organization_id = NEW.organization_id AND r.term_enrollment_id = NEW.term_enrollment_id
           AND r.elective_group_id = o_group AND r.valid_to IS NULL) >= g_max THEN
      RAISE EXCEPTION 'course registration: the student already holds % registrations in the group', g_max
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_max_select_ck';
    END IF;
  ELSIF NEW.source = 'ELECTIVE_CHOICE' THEN
    RAISE EXCEPTION 'course registration: ELECTIVE_CHOICE needs an offering in an elective group'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'course_registrations_group_source_ck';
  END IF;

  IF o_cap IS NOT NULL AND (
       SELECT count(*) FROM app.course_registrations r
        WHERE r.organization_id = NEW.organization_id AND r.course_offering_id = NEW.course_offering_id
          AND r.valid_to IS NULL) >= o_cap THEN
    RAISE EXCEPTION 'course registration: the offering is at capacity' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'course_registrations_capacity_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 5.4 holidays: nothing changes inside a LOCKED term of the campus (or of any campus, for an organization-wide row);
--     identity (campus, date, kind) fixed; ACTIVE -> CANCELLED is final.
CREATE FUNCTION app.holidays_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'a holiday starts ACTIVE' USING ERRCODE = 'check_violation', CONSTRAINT = 'holidays_starts_active_ck';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.campus_id IS DISTINCT FROM OLD.campus_id OR NEW.holiday_date IS DISTINCT FROM OLD.holiday_date
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'holiday identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'a cancelled holiday is final' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.terms t
     WHERE t.organization_id = NEW.organization_id AND t.status = 'LOCKED'
       AND (NEW.campus_id IS NULL OR t.campus_id = NEW.campus_id)
       AND NEW.holiday_date BETWEEN t.start_date AND t.end_date) THEN
    RAISE EXCEPTION 'holiday: the date lies in a LOCKED term' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 5.5 section_class_teachers_guard (0038) with an effective-dated posting rule: every day of the assignment, from
--     valid_from to valid_to (an open row: the term's end), must be covered by a PRIMARY posting of the employee in a
--     department of the section's campus. Consecutive postings may share the coverage (a department move inside the
--     campus does not break it). Everything else is exactly the 0038 guard.
CREATE OR REPLACE FUNCTION app.section_class_teachers_guard() RETURNS trigger
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
  e_status  text;
BEGIN
  SELECT s.status, cp.status, t.status, t.start_date, t.end_date, t.campus_id
    INTO s_status, cp_status, t_status, t_start, t_end, t_campus
    FROM app.sections s
    JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
    JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
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
    -- ponytail: one probe per day of the window (at most one term, ~366 rows); an interval-union scan if terms grow long.
    IF EXISTS (
      SELECT 1 FROM generate_series(NEW.valid_from, COALESCE(NEW.valid_to, t_end), interval '1 day') AS g(day)
       WHERE NOT EXISTS (
         SELECT 1 FROM app.employee_postings p
           JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
          WHERE p.organization_id = NEW.organization_id AND p.employee_id = NEW.employee_id AND d.campus_id = t_campus
            AND p.is_primary = true AND p.valid_from <= g.day::date
            AND (p.valid_to IS NULL OR p.valid_to >= g.day::date))) THEN
      RAISE EXCEPTION 'class teacher: the employee''s primary postings on the section''s campus do not cover the assignment dates'
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

REVOKE ALL ON FUNCTION app.elective_groups_guard(), app.course_offerings_registration_guard(),
  app.course_registrations_guard(), app.holidays_guard(), app.section_class_teachers_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER elective_groups_touch BEFORE UPDATE ON app.elective_groups FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER elective_groups_immutable BEFORE UPDATE ON app.elective_groups FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER elective_groups_guard_iu BEFORE INSERT OR UPDATE ON app.elective_groups FOR EACH ROW EXECUTE FUNCTION app.elective_groups_guard();

CREATE TRIGGER course_offerings_registration_guard_iu BEFORE INSERT OR UPDATE ON app.course_offerings
  FOR EACH ROW EXECUTE FUNCTION app.course_offerings_registration_guard();

CREATE TRIGGER course_registrations_touch BEFORE UPDATE ON app.course_registrations FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER course_registrations_immutable BEFORE UPDATE ON app.course_registrations FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER course_registrations_guard_iu BEFORE INSERT OR UPDATE ON app.course_registrations FOR EACH ROW EXECUTE FUNCTION app.course_registrations_guard();

CREATE TRIGGER holidays_touch BEFORE UPDATE ON app.holidays FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER holidays_immutable BEFORE UPDATE ON app.holidays FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER holidays_guard_iu BEFORE INSERT OR UPDATE ON app.holidays FOR EACH ROW EXECUTE FUNCTION app.holidays_guard();

-- ---------------------------------------------------------------------------------------------
-- 7. Row-level security (FORCE on every table) and least-privilege grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.elective_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.elective_groups FORCE  ROW LEVEL SECURITY;
CREATE POLICY elective_groups_tenant_select ON app.elective_groups AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY elective_groups_tenant_insert ON app.elective_groups AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY elective_groups_tenant_update ON app.elective_groups AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY elective_groups_staff_insert ON app.elective_groups AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY elective_groups_staff_update ON app.elective_groups AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.course_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.course_registrations FORCE  ROW LEVEL SECURITY;
CREATE POLICY course_registrations_tenant_select ON app.course_registrations AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY course_registrations_tenant_insert ON app.course_registrations AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY course_registrations_tenant_update ON app.course_registrations AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Student-bearing (doc 08 §4 student_self_only): a STUDENT reads only their OWN rows and never writes.
CREATE POLICY course_registrations_student_self ON app.course_registrations AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.holidays FORCE  ROW LEVEL SECURITY;
CREATE POLICY holidays_tenant_select ON app.holidays AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY holidays_tenant_insert ON app.holidays AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY holidays_tenant_update ON app.holidays AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY holidays_staff_insert ON app.holidays AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY holidays_staff_update ON app.holidays AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

-- No DELETE anywhere: groups close, registrations close (valid_to), holidays are cancelled.
GRANT SELECT, INSERT ON app.elective_groups, app.course_registrations, app.holidays TO app_runtime;
GRANT UPDATE (name, min_select, max_select, opens_at, closes_at, status) ON app.elective_groups TO app_runtime;
GRANT UPDATE (status, valid_to)                                          ON app.course_registrations TO app_runtime;
GRANT UPDATE (name, status)                                              ON app.holidays TO app_runtime;
