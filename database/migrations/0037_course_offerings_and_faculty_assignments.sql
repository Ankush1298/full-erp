-- 0037_course_offerings_and_faculty_assignments
-- Owner: app_migrator
-- Milestone 3 (Academic Structure & Enrollment), Batch 2.
-- Specification: docs/architecture/v3/02 §4.5 (course_offerings), §4.6 (faculty_assignments), §4.7 (timetable_slots),
--                §5.3 (faculty changes, snapshots), 06 §3 (offering scope), 04 Part 16 (Milestone 3),
--                docs/architecture/v3/31-course-offerings-and-scheduling-m3b2.md.
--
-- Contents (3 tables, 2 permissions):
--  * course_offerings      - a course taught in one term (optionally for one cohort period / section), with the catalogue
--                            code, title and credits SNAPSHOTTED when it is published
--  * faculty_assignments   - who teaches an offering, effective-dated, with a role; at most one PRIMARY at a time
--  * timetable_slots       - weekly slots of an offering, effective-dated; no room, section (audience) or named teacher
--                            is ever double-booked (section 4.3)
--
-- Deliberately NOT here (recorded, not silently resolved): elective_groups and course_registrations (the next M3 batch;
-- course_offerings therefore has no elective_group_id yet), attendance_policy_id (attendance_policies is Milestone 4),
-- holidays (no column specification exists in docs 02/07/08), the promotion tool, a section-level "class teacher"
-- assignment (not in the architecture; owner decision), and any K-12 grade table (owner decision OD-5; grades map to period_no today).
--
-- Concurrency design. btree_gist is not available to this migration role, so the EXCLUDE constraints of doc 02 are BEFORE
-- triggers that lock first and then test for overlap (as in 0033): faculty assignments lock their offering row FOR UPDATE;
-- timetable slots take a transaction-level advisory lock per room. Under READ COMMITTED the second writer waits and then
-- sees the first one's committed row. Lock order: terms (share) -> courses / cohort_periods / sections (share) ->
-- course_offerings -> employees (share) -> faculty_assignments / timetable_slots.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.course_offerings
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.course_offerings (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  -- campus_id (from the term) and department_id (from the cohort period's programme, else the course's owning
  -- department) are DERIVED by the guard from trusted rows; whatever a writer supplies is overwritten.
  campus_id           app.uuid_v7 NOT NULL,
  department_id       app.uuid_v7 NOT NULL,
  term_id             app.uuid_v7 NOT NULL,
  course_id           app.uuid_v7 NOT NULL,
  cohort_period_id    app.uuid_v7,
  section_id          app.uuid_v7,
  offering_kind       text        NOT NULL CHECK (offering_kind IN
    ('CORE', 'ELECTIVE', 'OPEN_ELECTIVE', 'OPTIONAL', 'LAB_GROUP', 'PROJECT', 'INTERNSHIP')),
  group_label         text        CHECK (group_label IS NULL OR char_length(group_label) BETWEEN 1 AND 30),
  code_snapshot       text        NOT NULL,
  title_snapshot      text        NOT NULL,
  credits_snapshot    numeric(4,1) NOT NULL,
  tracks_attendance   boolean     NOT NULL,
  registration_policy text        NOT NULL CHECK (registration_policy IN
    ('AUTO_FROM_SECTION', 'MANUAL', 'ELECTIVE_CHOICE', 'ADMIN_ASSIGNED')),
  capacity            smallint    CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 10000),
  status              text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED', 'CANCELLED')),
  published_at        timestamptz,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_offerings_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_department_fk FOREIGN KEY (organization_id, department_id)
    REFERENCES app.departments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_term_fk FOREIGN KEY (organization_id, term_id)
    REFERENCES app.terms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_course_fk FOREIGN KEY (organization_id, course_id)
    REFERENCES app.courses (organization_id, id) ON DELETE RESTRICT,
  -- the cohort period must run in the offering's own term; the section must belong to that cohort period
  CONSTRAINT course_offerings_cohort_period_fk FOREIGN KEY (organization_id, term_id, cohort_period_id)
    REFERENCES app.cohort_periods (organization_id, term_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_section_fk FOREIGN KEY (organization_id, cohort_period_id, section_id)
    REFERENCES app.sections (organization_id, cohort_period_id, id) ON DELETE RESTRICT,
  CONSTRAINT course_offerings_section_needs_period_ck CHECK (section_id IS NULL OR cohort_period_id IS NOT NULL),
  CONSTRAINT course_offerings_published_at_ck CHECK ((status = 'DRAFT') = (published_at IS NULL)
                                                     OR (status = 'CANCELLED')),
  CONSTRAINT course_offerings_org_id_uq UNIQUE (organization_id, id)
);
-- doc 02: UQ(term_id, course_id, coalesce(section_id), coalesce(group_label))
CREATE UNIQUE INDEX course_offerings_term_course_section_group_uq
  ON app.course_offerings (term_id, course_id, COALESCE(section_id::text, ''), COALESCE(group_label, ''));
CREATE INDEX course_offerings_org_term_status_ix ON app.course_offerings (organization_id, term_id, status);
CREATE INDEX course_offerings_section_ix ON app.course_offerings (organization_id, section_id) WHERE section_id IS NOT NULL;
CREATE INDEX course_offerings_org_department_ix ON app.course_offerings (organization_id, department_id);
CREATE INDEX course_offerings_org_course_ix ON app.course_offerings (organization_id, course_id);
-- FK-backing indexes with the FK's exact leading columns (schema linter S-2)
CREATE INDEX course_offerings_org_campus_ix ON app.course_offerings (organization_id, campus_id);
CREATE INDEX course_offerings_cohort_period_ix
  ON app.course_offerings (organization_id, term_id, cohort_period_id) WHERE cohort_period_id IS NOT NULL;
CREATE INDEX course_offerings_section_fk_ix
  ON app.course_offerings (organization_id, cohort_period_id, section_id) WHERE section_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. app.faculty_assignments (effective-dated)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.faculty_assignments (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  course_offering_id app.uuid_v7 NOT NULL,
  employee_id        app.uuid_v7 NOT NULL,
  role               text        NOT NULL CHECK (role IN ('PRIMARY', 'CO_INSTRUCTOR', 'LAB_INSTRUCTOR', 'SUBSTITUTE')),
  valid_from         date        NOT NULL,
  valid_to           date,
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT faculty_assignments_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT faculty_assignments_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT faculty_assignments_employee_fk FOREIGN KEY (organization_id, employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT faculty_assignments_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT faculty_assignments_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT faculty_assignments_org_offering_id_uq UNIQUE (organization_id, course_offering_id, id)
);
CREATE INDEX faculty_assignments_employee_ix ON app.faculty_assignments (organization_id, employee_id, valid_to);
CREATE INDEX faculty_assignments_org_offering_ix ON app.faculty_assignments (organization_id, course_offering_id);

-- ---------------------------------------------------------------------------------------------
-- 3. app.timetable_slots (effective-dated)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.timetable_slots (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  course_offering_id    app.uuid_v7 NOT NULL,
  room_id               app.uuid_v7,
  faculty_assignment_id app.uuid_v7,
  weekday               smallint    NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time            time        NOT NULL,
  end_time              time        NOT NULL,
  effective_from        date        NOT NULL,
  effective_to          date,
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timetable_slots_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT timetable_slots_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT timetable_slots_room_fk FOREIGN KEY (organization_id, room_id)
    REFERENCES app.rooms (organization_id, id) ON DELETE RESTRICT,
  -- the slot's teacher must be an assignment OF THIS offering
  CONSTRAINT timetable_slots_assignment_fk FOREIGN KEY (organization_id, course_offering_id, faculty_assignment_id)
    REFERENCES app.faculty_assignments (organization_id, course_offering_id, id) ON DELETE RESTRICT,
  CONSTRAINT timetable_slots_time_ck CHECK (start_time < end_time),
  CONSTRAINT timetable_slots_dates_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT timetable_slots_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX timetable_slots_org_offering_ix ON app.timetable_slots (organization_id, course_offering_id);
CREATE INDEX timetable_slots_room_weekday_ix ON app.timetable_slots (organization_id, room_id, weekday)
  WHERE room_id IS NOT NULL;
-- supports timetable_slots_assignment_fk (same leading columns, schema linter S-2)
CREATE INDEX timetable_slots_assignment_ix
  ON app.timetable_slots (organization_id, course_offering_id, faculty_assignment_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Row guards (SECURITY INVOKER, volatile, pinned search_path - the 0033 family)
-- ---------------------------------------------------------------------------------------------

-- 4.1 course_offerings: open term, live ACTIVE course, ACTIVE cohort period / section; scope derived from trusted rows;
--     DRAFT -> PUBLISHED | CANCELLED, PUBLISHED -> CLOSED | CANCELLED; snapshots re-copied at publication, then frozen.
CREATE FUNCTION app.course_offerings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  t_campus  uuid;
  t_status  text;
  c_row     record;
  cp_status text;
  cp_dept   uuid;
  s_status  text;
BEGIN
  SELECT t.campus_id, t.status INTO t_campus, t_status FROM app.terms t
   WHERE t.organization_id = NEW.organization_id AND t.id = NEW.term_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the term foreign key reports it
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF t_status NOT IN ('PLANNED', 'ACTIVE') THEN
      RAISE EXCEPTION 'course offering: the term must be PLANNED or ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'course_offerings_term_open_ck';
    END IF;
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'course offering: a new offering starts as DRAFT' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'course_offerings_starts_draft_ck';
    END IF;
    SELECT c.code, c.title, c.credits, c.tracks_attendance, c.status, c.deleted_at, c.owning_department_id
      INTO c_row FROM app.courses c
     WHERE c.organization_id = NEW.organization_id AND c.id = NEW.course_id FOR SHARE;
    IF NOT FOUND THEN
      RETURN NEW; -- the course foreign key reports it
    END IF;
    IF c_row.deleted_at IS NOT NULL OR c_row.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'course offering: the course must be live and ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'course_offerings_course_active_ck';
    END IF;
    IF NEW.cohort_period_id IS NOT NULL THEN
      SELECT cp.status, p.department_id INTO cp_status, cp_dept
        FROM app.cohort_periods cp
        JOIN app.cohorts co ON co.organization_id = cp.organization_id AND co.id = cp.cohort_id
        JOIN app.programs p ON p.organization_id = co.organization_id AND p.id = co.program_id
       WHERE cp.organization_id = NEW.organization_id AND cp.id = NEW.cohort_period_id FOR SHARE OF cp;
      IF FOUND AND cp_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'course offering: the cohort period must be ACTIVE' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'course_offerings_cohort_period_active_ck';
      END IF;
    END IF;
    IF NEW.section_id IS NOT NULL THEN
      SELECT s.status INTO s_status FROM app.sections s
       WHERE s.organization_id = NEW.organization_id AND s.id = NEW.section_id FOR SHARE;
      IF FOUND AND s_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'course offering: the section must be ACTIVE' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'course_offerings_section_active_ck';
      END IF;
    END IF;
    -- Trusted scope: never what the writer supplied.
    NEW.campus_id := t_campus;
    NEW.department_id := COALESCE(cp_dept, c_row.owning_department_id);
    IF NEW.department_id IS NULL THEN
      RAISE EXCEPTION 'course offering: an organization-wide course needs a cohort period to give it a department'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_department_ck';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.departments d
                    WHERE d.organization_id = NEW.organization_id AND d.id = NEW.department_id
                      AND d.campus_id = t_campus) THEN
      RAISE EXCEPTION 'course offering: the department must be on the term''s campus'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_department_campus_ck';
    END IF;
    NEW.code_snapshot := c_row.code;
    NEW.title_snapshot := c_row.title;
    NEW.credits_snapshot := c_row.credits;
    NEW.tracks_attendance := c_row.tracks_attendance;
    NEW.published_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'course offering: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.campus_id IS DISTINCT FROM OLD.campus_id OR NEW.department_id IS DISTINCT FROM OLD.department_id
     OR NEW.term_id IS DISTINCT FROM OLD.term_id OR NEW.course_id IS DISTINCT FROM OLD.course_id
     OR NEW.cohort_period_id IS DISTINCT FROM OLD.cohort_period_id OR NEW.section_id IS DISTINCT FROM OLD.section_id
     OR NEW.offering_kind IS DISTINCT FROM OLD.offering_kind OR NEW.group_label IS DISTINCT FROM OLD.group_label
     OR NEW.registration_policy IS DISTINCT FROM OLD.registration_policy THEN
    RAISE EXCEPTION 'course offering identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'CANCELLED'))
            OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('CLOSED', 'CANCELLED'))) THEN
      RAISE EXCEPTION 'invalid course offering status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_transition_ck';
    END IF;
    IF NEW.status = 'PUBLISHED' THEN
      IF t_status NOT IN ('PLANNED', 'ACTIVE') THEN
        RAISE EXCEPTION 'course offering: publication needs a PLANNED or ACTIVE term'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_term_open_ck';
      END IF;
      SELECT c.code, c.title, c.credits, c.tracks_attendance, c.status, c.deleted_at
        INTO c_row FROM app.courses c
       WHERE c.organization_id = NEW.organization_id AND c.id = NEW.course_id FOR SHARE;
      IF c_row.deleted_at IS NOT NULL OR c_row.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'course offering: the course must be live and ACTIVE to publish'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'course_offerings_course_active_ck';
      END IF;
      -- doc 02 §4.5 / §5.1 principle 3: what appears on official documents is frozen at publication.
      NEW.code_snapshot := c_row.code;
      NEW.title_snapshot := c_row.title;
      NEW.credits_snapshot := c_row.credits;
      NEW.tracks_attendance := c_row.tracks_attendance;
      NEW.published_at := now();
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.code_snapshot IS DISTINCT FROM OLD.code_snapshot OR NEW.title_snapshot IS DISTINCT FROM OLD.title_snapshot
     OR NEW.credits_snapshot IS DISTINCT FROM OLD.credits_snapshot
     OR NEW.tracks_attendance IS DISTINCT FROM OLD.tracks_attendance
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'course offering snapshots change only at publication' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'a % course offering is immutable', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 4.2 faculty_assignments: the offering row is locked first, so competing assignments of one offering queue.
CREATE FUNCTION app.faculty_assignments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  o_status  text;
  t_status  text;
  t_start   date;
  t_end     date;
  e_status  text;
BEGIN
  SELECT o.status, t.status, t.start_date, t.end_date INTO o_status, t_status, t_start, t_end
    FROM app.course_offerings o
    JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
   WHERE o.organization_id = NEW.organization_id AND o.id = NEW.course_offering_id FOR UPDATE OF o;
  IF NOT FOUND THEN
    RETURN NEW; -- the offering foreign key reports it
  END IF;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'faculty assignment: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.valid_from < t_start OR NEW.valid_from > t_end OR (NEW.valid_to IS NOT NULL AND NEW.valid_to > t_end) THEN
    RAISE EXCEPTION 'faculty assignment: the dates must lie inside the term (% to %)', t_start, t_end
      USING ERRCODE = 'check_violation', CONSTRAINT = 'faculty_assignments_in_term_ck';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF o_status NOT IN ('DRAFT', 'PUBLISHED') THEN
      RAISE EXCEPTION 'faculty assignment: the offering must be DRAFT or PUBLISHED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'faculty_assignments_offering_open_ck';
    END IF;
    SELECT e.status INTO e_status FROM app.employees e
     WHERE e.organization_id = NEW.organization_id AND e.id = NEW.employee_id FOR SHARE;
    IF FOUND AND e_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'faculty assignment: the employee must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'faculty_assignments_employee_active_ck';
    END IF;
    -- doc 02: EXCLUDE (course_offering_id WITH =, daterange WITH &&) WHERE role = 'PRIMARY'
    IF NEW.role = 'PRIMARY' AND EXISTS (
      SELECT 1 FROM app.faculty_assignments a
       WHERE a.organization_id = NEW.organization_id AND a.course_offering_id = NEW.course_offering_id
         AND a.role = 'PRIMARY'
         AND daterange(a.valid_from, a.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')) THEN
      RAISE EXCEPTION 'faculty assignment: the offering already has a PRIMARY teacher in that period'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'faculty_assignments_primary_excl';
    END IF;
    IF EXISTS (
      SELECT 1 FROM app.faculty_assignments a
       WHERE a.organization_id = NEW.organization_id AND a.course_offering_id = NEW.course_offering_id
         AND a.employee_id = NEW.employee_id
         AND daterange(a.valid_from, a.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')) THEN
      RAISE EXCEPTION 'faculty assignment: the employee is already assigned to the offering in that period'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'faculty_assignments_employee_excl';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only closing an open assignment (valid_to NULL -> a date) is a change; a closed assignment is terminal.
  IF NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
     OR NEW.role IS DISTINCT FROM OLD.role OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'faculty assignment identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to AND (OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL) THEN
    RAISE EXCEPTION 'faculty assignment: only an open assignment can be closed, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 4.3 timetable_slots: three conflict rules, each serialised by a transaction-level advisory lock taken in a FIXED order
--     (room -> audience -> teacher), then an overlap test that sees every committed booking (READ COMMITTED).
--     A slot never outlives its offering's term, so an open slot (effective_to NULL) counts until that term's end date;
--     slots of a CANCELLED offering are never taught and block nothing. Times are half-open (09:00-10:00 and 10:00-11:00
--     do not clash). The API inserts one slot per transaction; a raw writer inserting several slots in one transaction
--     in different orders can deadlock (PostgreSQL then aborts one of them, 40P01), it can never double-book.
--   * ROOM (doc 02 EXCLUDE): one booking per room at a time.
--   * AUDIENCE (A, doc 31 §3): the students of one section cannot have two classes at once. An offering's audience is its
--     section, or every section of its cohort period when it has no section. An offering is WHOLE-AUDIENCE when it is
--     CORE without a group label; ELECTIVE / OPEN_ELECTIVE / OPTIONAL / LAB_GROUP / PROJECT / INTERNSHIP offerings and
--     any offering with a group label reach only part of the audience (who takes which is decided by course
--     registrations, not built yet), so two partial offerings may run in parallel (lab groups, parallel electives,
--     second-language options). Two slots clash when the audiences overlap and at least one of them is whole-audience,
--     or when both belong to the same offering. An offering without a cohort period has no known audience and is only
--     checked against itself.
--   * TEACHER (A, doc 31 §3): one person cannot teach two slots at once. A slot names its teacher only through
--     faculty_assignment_id; a slot without one has no teacher and is not checked (the limitation is recorded in doc 31).
--     A booking counts only while the named assignment is valid, so an ended assignment stops blocking its teacher on
--     the day after valid_to. A new slot must start while its assignment is valid.
CREATE FUNCTION app.timetable_slots_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  o_status  text;
  o_campus  uuid;
  o_period  uuid;
  o_section uuid;
  o_whole   boolean;
  t_status  text;
  t_start   date;
  t_end     date;
  r_campus  uuid;
  n_to      date;
  a_emp     uuid;
  a_from    date;
  a_to      date;
BEGIN
  SELECT o.status, o.campus_id, o.cohort_period_id, o.section_id, (o.offering_kind = 'CORE' AND o.group_label IS NULL),
         t.status, t.start_date, t.end_date
    INTO o_status, o_campus, o_period, o_section, o_whole, t_status, t_start, t_end
    FROM app.course_offerings o
    JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
   WHERE o.organization_id = NEW.organization_id AND o.id = NEW.course_offering_id FOR SHARE OF o;
  IF NOT FOUND THEN
    RETURN NEW; -- the offering foreign key reports it
  END IF;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'timetable slot: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.effective_from < t_start OR NEW.effective_from > t_end
     OR (NEW.effective_to IS NOT NULL AND NEW.effective_to > t_end) THEN
    RAISE EXCEPTION 'timetable slot: the dates must lie inside the term (% to %)', t_start, t_end
      USING ERRCODE = 'check_violation', CONSTRAINT = 'timetable_slots_in_term_ck';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF o_status NOT IN ('DRAFT', 'PUBLISHED') THEN
      RAISE EXCEPTION 'timetable slot: the offering must be DRAFT or PUBLISHED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'timetable_slots_offering_open_ck';
    END IF;
    n_to := COALESCE(NEW.effective_to, t_end);

    IF NEW.faculty_assignment_id IS NOT NULL THEN
      SELECT a.employee_id, a.valid_from, COALESCE(a.valid_to, t_end) INTO a_emp, a_from, a_to
        FROM app.faculty_assignments a
       WHERE a.organization_id = NEW.organization_id AND a.course_offering_id = NEW.course_offering_id
         AND a.id = NEW.faculty_assignment_id;
      IF FOUND AND (NEW.effective_from < a_from OR NEW.effective_from > a_to) THEN
        RAISE EXCEPTION 'timetable slot: the slot must start while its teacher''s assignment is valid (% to %)', a_from, a_to
          USING ERRCODE = 'check_violation', CONSTRAINT = 'timetable_slots_assignment_valid_ck';
      END IF;
    END IF;

    -- ROOM
    IF NEW.room_id IS NOT NULL THEN
      SELECT r.campus_id INTO r_campus FROM app.rooms r
       WHERE r.organization_id = NEW.organization_id AND r.id = NEW.room_id;
      IF FOUND AND r_campus IS DISTINCT FROM o_campus THEN
        RAISE EXCEPTION 'timetable slot: the room must be on the offering''s campus' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'timetable_slots_room_campus_ck';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('app.timetable_room:' || NEW.room_id::text, 0));
      IF EXISTS (
        SELECT 1 FROM app.timetable_slots s
          JOIN app.course_offerings so ON so.organization_id = s.organization_id AND so.id = s.course_offering_id
          JOIN app.terms st ON st.organization_id = so.organization_id AND st.id = so.term_id
         WHERE s.organization_id = NEW.organization_id AND s.room_id = NEW.room_id AND s.weekday = NEW.weekday
           AND so.status <> 'CANCELLED'
           AND s.start_time < NEW.end_time AND NEW.start_time < s.end_time
           AND s.effective_from <= n_to AND NEW.effective_from <= COALESCE(s.effective_to, st.end_date)) THEN
        RAISE EXCEPTION 'timetable slot: the room is already booked at that time' USING ERRCODE = 'exclusion_violation',
          CONSTRAINT = 'timetable_slots_room_excl';
      END IF;
    END IF;

    -- AUDIENCE (the cohort period serialises every audience inside it; an offering without one only itself)
    PERFORM pg_advisory_xact_lock(hashtextextended('app.timetable_audience:'
                                                   || COALESCE(o_period, NEW.course_offering_id)::text, 0));
    IF EXISTS (
      SELECT 1 FROM app.timetable_slots s
        JOIN app.course_offerings so ON so.organization_id = s.organization_id AND so.id = s.course_offering_id
        JOIN app.terms st ON st.organization_id = so.organization_id AND st.id = so.term_id
       WHERE s.organization_id = NEW.organization_id AND s.weekday = NEW.weekday
         AND so.status <> 'CANCELLED'
         AND s.start_time < NEW.end_time AND NEW.start_time < s.end_time
         AND s.effective_from <= n_to AND NEW.effective_from <= COALESCE(s.effective_to, st.end_date)
         AND (so.id = NEW.course_offering_id
              OR (o_period IS NOT NULL AND so.cohort_period_id = o_period
                  AND (o_section IS NULL OR so.section_id IS NULL OR so.section_id = o_section)
                  AND (o_whole OR (so.offering_kind = 'CORE' AND so.group_label IS NULL))))) THEN
      RAISE EXCEPTION 'timetable slot: the section already has a class at that time' USING ERRCODE = 'exclusion_violation',
        CONSTRAINT = 'timetable_slots_audience_excl';
    END IF;

    -- TEACHER (each booking counts only inside its own assignment's validity)
    IF a_emp IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('app.timetable_teacher:' || a_emp::text, 0));
      IF EXISTS (
        SELECT 1 FROM app.timetable_slots s
          JOIN app.faculty_assignments a ON a.organization_id = s.organization_id AND a.id = s.faculty_assignment_id
          JOIN app.course_offerings so ON so.organization_id = s.organization_id AND so.id = s.course_offering_id
          JOIN app.terms st ON st.organization_id = so.organization_id AND st.id = so.term_id
          CROSS JOIN LATERAL (SELECT GREATEST(s.effective_from, a.valid_from) AS lo,
                                     LEAST(COALESCE(s.effective_to, st.end_date), COALESCE(a.valid_to, st.end_date)) AS hi) b
         WHERE s.organization_id = NEW.organization_id AND a.employee_id = a_emp AND s.weekday = NEW.weekday
           AND so.status <> 'CANCELLED'
           AND s.start_time < NEW.end_time AND NEW.start_time < s.end_time
           AND b.lo <= b.hi AND b.lo <= LEAST(n_to, a_to) AND NEW.effective_from <= b.hi) THEN
        RAISE EXCEPTION 'timetable slot: the teacher already has a class at that time'
          USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'timetable_slots_teacher_excl';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only ending an open slot (effective_to NULL -> a date); an ended slot is terminal.
  IF NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.faculty_assignment_id IS DISTINCT FROM OLD.faculty_assignment_id OR NEW.weekday IS DISTINCT FROM OLD.weekday
     OR NEW.start_time IS DISTINCT FROM OLD.start_time OR NEW.end_time IS DISTINCT FROM OLD.end_time
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'timetable slot identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND (OLD.effective_to IS NOT NULL OR NEW.effective_to IS NULL) THEN
    RAISE EXCEPTION 'timetable slot: only an open slot can be ended, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Triggers (touch_row + immutable keys + guards)
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER course_offerings_touch BEFORE UPDATE ON app.course_offerings FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER course_offerings_immutable BEFORE UPDATE ON app.course_offerings FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER course_offerings_guard_iu BEFORE INSERT OR UPDATE ON app.course_offerings FOR EACH ROW EXECUTE FUNCTION app.course_offerings_guard();

CREATE TRIGGER faculty_assignments_touch BEFORE UPDATE ON app.faculty_assignments FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER faculty_assignments_immutable BEFORE UPDATE ON app.faculty_assignments FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER faculty_assignments_guard_iu BEFORE INSERT OR UPDATE ON app.faculty_assignments FOR EACH ROW EXECUTE FUNCTION app.faculty_assignments_guard();

CREATE TRIGGER timetable_slots_touch BEFORE UPDATE ON app.timetable_slots FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER timetable_slots_immutable BEFORE UPDATE ON app.timetable_slots FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER timetable_slots_guard_iu BEFORE INSERT OR UPDATE ON app.timetable_slots FOR EACH ROW EXECUTE FUNCTION app.timetable_slots_guard();

-- ---------------------------------------------------------------------------------------------
-- 6. Row-level security (FORCE on every table) and least-privilege grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.course_offerings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.course_offerings FORCE  ROW LEVEL SECURITY;
CREATE POLICY course_offerings_tenant_select ON app.course_offerings AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY course_offerings_tenant_insert ON app.course_offerings AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY course_offerings_tenant_update ON app.course_offerings AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY course_offerings_staff_insert ON app.course_offerings AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY course_offerings_staff_update ON app.course_offerings AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.faculty_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.faculty_assignments FORCE  ROW LEVEL SECURITY;
CREATE POLICY faculty_assignments_tenant_select ON app.faculty_assignments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY faculty_assignments_tenant_insert ON app.faculty_assignments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY faculty_assignments_tenant_update ON app.faculty_assignments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Staff-only for reads too: an assignment names an employee (A2); students get teacher names through later read models.
CREATE POLICY faculty_assignments_staff_only ON app.faculty_assignments AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.timetable_slots FORCE  ROW LEVEL SECURITY;
CREATE POLICY timetable_slots_tenant_select ON app.timetable_slots AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY timetable_slots_tenant_insert ON app.timetable_slots AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY timetable_slots_tenant_update ON app.timetable_slots AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY timetable_slots_staff_insert ON app.timetable_slots AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY timetable_slots_staff_update ON app.timetable_slots AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

-- No DELETE anywhere: an offering is CANCELLED, an assignment or slot is ended (history is kept, doc 02 §5.1).
GRANT SELECT, INSERT ON app.course_offerings, app.faculty_assignments, app.timetable_slots TO app_runtime;
GRANT UPDATE (status, capacity) ON app.course_offerings    TO app_runtime;
GRANT UPDATE (valid_to)         ON app.faculty_assignments TO app_runtime;
GRANT UPDATE (effective_to)     ON app.timetable_slots     TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 7. Permissions (doc 10 §118: each milestone adds its own). Granted by seedTenantRoles; existing tenants must be
--    re-seeded. Reads use the existing academic.program.read.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('academic.offering.manage', 'SENSITIVE'),
  ('academic.faculty.assign', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
