-- 0033_academic_calendar_and_enrollment
-- Owner: app_migrator
-- Milestone 3 (Academic Structure & Enrollment), Batch 1.
-- Specification: docs/architecture/v3/02 §4.5 / §4.6 (tables), 07 §3 (model), 04 Part 16 (Milestone 3),
--                08 §4 (RLS conventions, student_self_only), 10 (permissions), docs/architecture/v3/24-academic-calendar-and-enrollment.md.
--
-- Contents (8 tables, 5 permissions):
--  * academic_years, terms                  - the academic calendar (terms are per campus)
--  * cohort_periods, sections               - "this cohort's Nth study period runs in this term" and its sections
--  * courses, curriculum_courses            - the course catalogue and what a programme prescribes per period
--  * term_enrollments, section_memberships  - a student's placement in a cohort period and, effective-dated, in a section
--
-- Deliberately NOT here (Batch 2+, recorded rather than silently resolved): elective_groups, course_offerings,
-- course_registrations, faculty_assignments (need employee_postings, Milestone 2), timetable_slots, holidays,
-- terms.attendance_edit_until (an attendance concern, Milestone 4), the A2 "admin override" of LOCKED terms, and any
-- promotion tooling. Attendance integration remains deferred.
--
-- Concurrency design. btree_gist is NOT available to this migration role, so the EXCLUDE overlap constraints of doc 02 are
-- implemented as BEFORE triggers that take a per-parent lock first (a transaction-level advisory lock per organization for
-- academic years; the parent term_enrollment row for section memberships) and then test for overlap. Under READ COMMITTED
-- this serialises competing writers: the second one waits, then sees the first one's committed row. A partial unique index
-- additionally guarantees at most one OPEN membership per enrollment without any trigger. Lock order everywhere is top-down:
-- academic_years -> terms -> cohort_periods -> sections -> term_enrollments -> section_memberships.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.academic_years
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.academic_years (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  label           text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  start_date      date        NOT NULL CHECK (start_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  end_date        date        NOT NULL CHECK (end_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  status          text        NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'ACTIVE', 'CLOSED')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_years_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT academic_years_dates_ck CHECK (end_date > start_date),
  CONSTRAINT academic_years_org_label_uq UNIQUE (organization_id, label),
  CONSTRAINT academic_years_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX academic_years_org_status_ix ON app.academic_years (organization_id, status);

-- ---------------------------------------------------------------------------------------------
-- 2. app.terms
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.terms (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  campus_id        app.uuid_v7 NOT NULL,
  academic_year_id app.uuid_v7 NOT NULL,
  code             text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 30),
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  start_date       date        NOT NULL CHECK (start_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  end_date         date        NOT NULL CHECK (end_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  status           text        NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'ACTIVE', 'CLOSED', 'LOCKED')),
  locked_at        timestamptz,
  locked_by        app.uuid_v7,
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terms_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT terms_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT terms_year_fk FOREIGN KEY (organization_id, academic_year_id)
    REFERENCES app.academic_years (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT terms_locked_by_fk FOREIGN KEY (organization_id, locked_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT terms_dates_ck CHECK (end_date > start_date),
  -- LOCKED is the only state that carries (and always carries) a lock stamp.
  CONSTRAINT terms_lock_stamp_ck CHECK (
    (status = 'LOCKED') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)
  ),
  CONSTRAINT terms_campus_year_code_uq UNIQUE (campus_id, academic_year_id, code),
  CONSTRAINT terms_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX terms_org_status_ix        ON app.terms (organization_id, status);
CREATE INDEX terms_org_campus_ix        ON app.terms (organization_id, campus_id);
CREATE INDEX terms_org_year_ix          ON app.terms (organization_id, academic_year_id);
CREATE INDEX terms_org_locked_by_ix     ON app.terms (organization_id, locked_by);

-- ---------------------------------------------------------------------------------------------
-- 3. app.cohort_periods
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.cohort_periods (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  cohort_id       app.uuid_v7 NOT NULL,
  term_id         app.uuid_v7 NOT NULL,
  period_no       smallint    NOT NULL CHECK (period_no BETWEEN 1 AND 200),
  is_extension    boolean     NOT NULL DEFAULT false,
  status          text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cohort_periods_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT cohort_periods_cohort_fk FOREIGN KEY (organization_id, cohort_id)
    REFERENCES app.cohorts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cohort_periods_term_fk FOREIGN KEY (organization_id, term_id)
    REFERENCES app.terms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT cohort_periods_cohort_term_uq UNIQUE (cohort_id, term_id),
  CONSTRAINT cohort_periods_cohort_period_uq UNIQUE (cohort_id, period_no),
  CONSTRAINT cohort_periods_org_id_uq UNIQUE (organization_id, id),
  -- targets of the composite foreign keys of sections and term_enrollments
  CONSTRAINT cohort_periods_org_term_id_uq UNIQUE (organization_id, term_id, id),
  CONSTRAINT cohort_periods_org_id_period_uq UNIQUE (organization_id, id, period_no),
  CONSTRAINT cohort_periods_org_cohort_id_uq UNIQUE (organization_id, cohort_id, id)
);
CREATE INDEX cohort_periods_org_cohort_ix ON app.cohort_periods (organization_id, cohort_id);
CREATE INDEX cohort_periods_org_term_ix   ON app.cohort_periods (organization_id, term_id);

-- ---------------------------------------------------------------------------------------------
-- 4. app.sections
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.sections (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  cohort_period_id app.uuid_v7 NOT NULL,
  name             text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  capacity         smallint    CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 10000),
  status           text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sections_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT sections_cohort_period_fk FOREIGN KEY (organization_id, cohort_period_id)
    REFERENCES app.cohort_periods (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT sections_cohort_period_name_uq UNIQUE (cohort_period_id, name),
  CONSTRAINT sections_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT sections_org_period_id_uq UNIQUE (organization_id, cohort_period_id, id)
);
CREATE INDEX sections_org_cohort_period_ix ON app.sections (organization_id, cohort_period_id);

-- ---------------------------------------------------------------------------------------------
-- 5. app.courses (soft-deletable catalogue)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.courses (
  id                   app.uuid_v7 PRIMARY KEY,
  organization_id      app.uuid_v7 NOT NULL,
  owning_department_id app.uuid_v7,
  code                 text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 30),
  title                text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  credits              numeric(4,1) NOT NULL CHECK (credits >= 0 AND credits <= 99.9),
  course_type          text        NOT NULL CHECK (course_type IN
    ('THEORY', 'PRACTICAL', 'THEORY_PRACTICAL', 'PROJECT', 'INTERNSHIP', 'SEMINAR', 'AUDIT', 'OTHER')),
  tracks_attendance    boolean     NOT NULL DEFAULT true,
  status               text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  deleted_at           timestamptz,
  version              integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT courses_department_fk FOREIGN KEY (organization_id, owning_department_id)
    REFERENCES app.departments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT courses_org_id_uq UNIQUE (organization_id, id)
);
-- Unique constraints on soft-deletable tables are partial (doc 02 §1).
CREATE UNIQUE INDEX courses_org_code_active_uq ON app.courses (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX courses_org_department_ix ON app.courses (organization_id, owning_department_id);
CREATE INDEX courses_org_status_ix     ON app.courses (organization_id, status);

-- ---------------------------------------------------------------------------------------------
-- 6. app.curriculum_courses
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.curriculum_courses (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  program_id          app.uuid_v7 NOT NULL,
  course_id           app.uuid_v7 NOT NULL,
  regulation          text        NOT NULL CHECK (char_length(regulation) BETWEEN 1 AND 30),
  period_no           smallint    NOT NULL CHECK (period_no BETWEEN 1 AND 200),
  category            text        NOT NULL CHECK (category IN
    ('CORE', 'ELECTIVE', 'OPTIONAL', 'LAB', 'PROJECT', 'INTERNSHIP')),
  elective_group_code text        CHECK (elective_group_code IS NULL OR char_length(elective_group_code) BETWEEN 1 AND 30),
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_courses_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT curriculum_courses_program_fk FOREIGN KEY (organization_id, program_id)
    REFERENCES app.programs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT curriculum_courses_course_fk FOREIGN KEY (organization_id, course_id)
    REFERENCES app.courses (organization_id, id) ON DELETE RESTRICT,
  -- A basket code only makes sense for an elective (elective_groups themselves arrive in Batch 2).
  CONSTRAINT curriculum_courses_group_only_elective_ck
    CHECK (elective_group_code IS NULL OR category = 'ELECTIVE'),
  CONSTRAINT curriculum_courses_prescription_uq UNIQUE (program_id, regulation, period_no, course_id)
);
CREATE INDEX curriculum_courses_org_program_ix ON app.curriculum_courses (organization_id, program_id);
CREATE INDEX curriculum_courses_org_course_ix  ON app.curriculum_courses (organization_id, course_id);

-- ---------------------------------------------------------------------------------------------
-- 7. app.term_enrollments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.term_enrollments (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  student_id         app.uuid_v7 NOT NULL,
  student_program_id app.uuid_v7 NOT NULL,
  cohort_period_id   app.uuid_v7 NOT NULL,
  term_id            app.uuid_v7 NOT NULL,
  period_no          smallint    NOT NULL,
  status             text        NOT NULL DEFAULT 'REGISTERED' CHECK (status IN
    ('REGISTERED', 'ACTIVE', 'WITHDRAWN', 'DETAINED', 'PROMOTED', 'COMPLETED', 'ON_LEAVE')),
  enrollment_type    text        NOT NULL DEFAULT 'REGULAR' CHECK (enrollment_type IN
    ('REGULAR', 'REPEAT', 'BACKLOG', 'SUMMER')),
  roll_number        text        CHECK (roll_number IS NULL OR char_length(roll_number) BETWEEN 1 AND 30),
  registered_at      timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT term_enrollments_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- the student_program IS this student's
  CONSTRAINT term_enrollments_student_program_fk FOREIGN KEY (organization_id, student_id, student_program_id)
    REFERENCES app.student_programs (organization_id, student_id, id) ON DELETE RESTRICT,
  -- the term IS the cohort period's term, and period_no IS the cohort period's
  CONSTRAINT term_enrollments_cohort_period_term_fk FOREIGN KEY (organization_id, term_id, cohort_period_id)
    REFERENCES app.cohort_periods (organization_id, term_id, id) ON DELETE RESTRICT,
  CONSTRAINT term_enrollments_cohort_period_no_fk FOREIGN KEY (organization_id, cohort_period_id, period_no)
    REFERENCES app.cohort_periods (organization_id, id, period_no) ON DELETE RESTRICT,
  CONSTRAINT term_enrollments_student_period_uq UNIQUE (student_id, cohort_period_id),
  CONSTRAINT term_enrollments_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT term_enrollments_org_student_id_uq UNIQUE (organization_id, student_id, id),
  CONSTRAINT term_enrollments_org_period_id_uq UNIQUE (organization_id, cohort_period_id, id)
);
CREATE UNIQUE INDEX term_enrollments_roll_uq
  ON app.term_enrollments (cohort_period_id, roll_number) WHERE roll_number IS NOT NULL;
-- A student holds at most ONE live enrolment per term (no two contradictory placements at once). Terminal
-- states (WITHDRAWN, PROMOTED, COMPLETED) free the slot; the service maps 23505 on this index to 409.
CREATE UNIQUE INDEX term_enrollments_one_live_per_term_uq
  ON app.term_enrollments (organization_id, student_id, term_id)
  WHERE status IN ('REGISTERED', 'ACTIVE', 'DETAINED', 'ON_LEAVE');
CREATE INDEX term_enrollments_org_student_program_ix ON app.term_enrollments (organization_id, student_id, student_program_id);
CREATE INDEX term_enrollments_org_term_period_ix     ON app.term_enrollments (organization_id, term_id, cohort_period_id);
CREATE INDEX term_enrollments_org_period_no_ix       ON app.term_enrollments (organization_id, cohort_period_id, period_no);
CREATE INDEX term_enrollments_period_status_ix       ON app.term_enrollments (cohort_period_id, status);

-- ---------------------------------------------------------------------------------------------
-- 8. app.section_memberships (effective-dated)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.section_memberships (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  term_enrollment_id app.uuid_v7 NOT NULL,
  student_id         app.uuid_v7 NOT NULL,
  cohort_period_id   app.uuid_v7 NOT NULL,
  section_id         app.uuid_v7 NOT NULL,
  valid_from         date        NOT NULL CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  valid_to           date        CHECK (valid_to IS NULL OR valid_to BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  change_reason      text        CHECK (change_reason IS NULL OR char_length(change_reason) BETWEEN 1 AND 100),
  changed_by         app.uuid_v7 NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT section_memberships_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- the membership's student IS the enrolment's student, and its section belongs to the enrolment's cohort period
  CONSTRAINT section_memberships_enrollment_student_fk FOREIGN KEY (organization_id, student_id, term_enrollment_id)
    REFERENCES app.term_enrollments (organization_id, student_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_memberships_enrollment_period_fk FOREIGN KEY (organization_id, cohort_period_id, term_enrollment_id)
    REFERENCES app.term_enrollments (organization_id, cohort_period_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_memberships_section_fk FOREIGN KEY (organization_id, cohort_period_id, section_id)
    REFERENCES app.sections (organization_id, cohort_period_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_memberships_changed_by_fk FOREIGN KEY (organization_id, changed_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT section_memberships_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- At most one OPEN membership per enrolment; closed intervals are kept disjoint by the guard below.
CREATE UNIQUE INDEX section_memberships_one_open_uq
  ON app.section_memberships (organization_id, term_enrollment_id) WHERE valid_to IS NULL;
CREATE INDEX section_memberships_org_enrollment_ix ON app.section_memberships (organization_id, term_enrollment_id, valid_from);
CREATE INDEX section_memberships_org_student_ix    ON app.section_memberships (organization_id, student_id, term_enrollment_id);
CREATE INDEX section_memberships_org_period_enr_ix ON app.section_memberships (organization_id, cohort_period_id, term_enrollment_id);
CREATE INDEX section_memberships_org_section_ix    ON app.section_memberships (organization_id, cohort_period_id, section_id);
CREATE INDEX section_memberships_section_open_ix   ON app.section_memberships (section_id) WHERE valid_to IS NULL;
CREATE INDEX section_memberships_org_changed_by_ix ON app.section_memberships (organization_id, changed_by);

-- ---------------------------------------------------------------------------------------------
-- 9. Row guards (SECURITY INVOKER, volatile, pinned search_path - same family as the 0021 guards).
--    Parents the writer cannot see are left to the foreign keys (23503); the guards judge rows whose parents they can read.
-- ---------------------------------------------------------------------------------------------

-- 9.1 academic_years: non-overlapping, forward-only lifecycle, dates frozen once the year leaves PLANNED.
CREATE FUNCTION app.academic_years_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'an academic year starts PLANNED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'academic_years_starts_planned_ck';
    END IF;
  ELSE
    IF NEW.label IS DISTINCT FROM OLD.label THEN
      RAISE EXCEPTION 'academic year label is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date)
       AND OLD.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'academic year dates are fixed once the year leaves PLANNED' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'PLANNED' AND NEW.status = 'ACTIVE') OR (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED')) THEN
      RAISE EXCEPTION 'invalid academic year status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Serialise every writer of this tenant's years, then test for overlap (inclusive date ranges).
  PERFORM pg_advisory_xact_lock(hashtextextended('app.academic_years:' || NEW.organization_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM app.academic_years y
     WHERE y.organization_id = NEW.organization_id AND y.id <> NEW.id
       AND y.start_date <= NEW.end_date AND y.end_date >= NEW.start_date
  ) THEN
    RAISE EXCEPTION 'academic year overlaps another academic year' USING ERRCODE = 'exclusion_violation',
      CONSTRAINT = 'academic_years_no_overlap';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Children must stay inside the (possibly adjusted) range, and a year may only close once its terms are done.
    IF EXISTS (SELECT 1 FROM app.terms t
                WHERE t.organization_id = NEW.organization_id AND t.academic_year_id = NEW.id
                  AND (t.start_date < NEW.start_date OR t.end_date > NEW.end_date)) THEN
      RAISE EXCEPTION 'academic year dates must contain all of its terms' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'academic_years_contains_terms_ck';
    END IF;
    IF NEW.status = 'CLOSED' AND OLD.status <> 'CLOSED'
       AND EXISTS (SELECT 1 FROM app.terms t
                    WHERE t.organization_id = NEW.organization_id AND t.academic_year_id = NEW.id
                      AND t.status IN ('PLANNED', 'ACTIVE')) THEN
      RAISE EXCEPTION 'an academic year cannot close while it has PLANNED or ACTIVE terms'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_years_close_needs_done_terms_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 9.2 terms: dates inside the year, forward-only lifecycle, identity frozen, nothing changes once LOCKED.
CREATE FUNCTION app.terms_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  y_status text;
  y_start  date;
  y_end    date;
BEGIN
  SELECT y.status, y.start_date, y.end_date INTO y_status, y_start, y_end
    FROM app.academic_years y
   WHERE y.organization_id = NEW.organization_id AND y.id = NEW.academic_year_id
     FOR SHARE;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'a term starts PLANNED' USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_starts_planned_ck';
    END IF;
    IF FOUND AND y_status = 'CLOSED' THEN
      RAISE EXCEPTION 'a term cannot be added to a CLOSED academic year' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'terms_year_not_closed_ck';
    END IF;
  ELSE
    IF OLD.status = 'LOCKED' THEN
      RAISE EXCEPTION 'a LOCKED term cannot change' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.campus_id IS DISTINCT FROM OLD.campus_id OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
       OR NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'term identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date)
       AND OLD.status <> 'PLANNED' THEN
      RAISE EXCEPTION 'term dates are fixed once the term leaves PLANNED' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status = 'PLANNED' AND NEW.status = 'ACTIVE')
           OR (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED')
           OR (OLD.status = 'CLOSED' AND NEW.status = 'LOCKED')) THEN
        RAISE EXCEPTION 'invalid term status transition % -> %', OLD.status, NEW.status
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.status = 'ACTIVE' AND FOUND AND y_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'a term can only become ACTIVE inside an ACTIVE academic year'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'terms_active_needs_active_year_ck';
      END IF;
    END IF;
  END IF;

  IF FOUND AND (NEW.start_date < y_start OR NEW.end_date > y_end) THEN
    RAISE EXCEPTION 'term dates must lie within the academic year' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'terms_within_year_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 9.3 cohort_periods: an ACTIVE cohort, an open term on the program's own campus, period_no within the programme.
CREATE FUNCTION app.cohort_periods_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  c_status text;
  c_campus uuid;
  c_duration smallint;
  t_status text;
  t_campus uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id OR NEW.term_id IS DISTINCT FROM OLD.term_id
       OR NEW.period_no IS DISTINCT FROM OLD.period_no OR NEW.is_extension IS DISTINCT FROM OLD.is_extension THEN
      RAISE EXCEPTION 'cohort period identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'CLOSED') THEN
      RAISE EXCEPTION 'a closed cohort period is terminal' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT c.status, d.campus_id, p.duration_periods INTO c_status, c_campus, c_duration
    FROM app.cohorts c
    JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
    JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
   WHERE c.organization_id = NEW.organization_id AND c.id = NEW.cohort_id
     FOR SHARE OF c, p;
  IF FOUND THEN
    IF c_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'cohort period: the cohort must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'cohort_periods_cohort_active_ck';
    END IF;
    IF NOT NEW.is_extension AND NEW.period_no > c_duration THEN
      RAISE EXCEPTION 'cohort period: period_no % exceeds the programme duration % (flag it as an extension)',
        NEW.period_no, c_duration USING ERRCODE = 'check_violation', CONSTRAINT = 'cohort_periods_within_duration_ck';
    END IF;
  END IF;

  SELECT t.status, t.campus_id INTO t_status, t_campus
    FROM app.terms t WHERE t.organization_id = NEW.organization_id AND t.id = NEW.term_id FOR SHARE;
  IF FOUND THEN
    IF t_status NOT IN ('PLANNED', 'ACTIVE') THEN
      RAISE EXCEPTION 'cohort period: the term must be PLANNED or ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'cohort_periods_term_open_ck';
    END IF;
    IF c_campus IS NOT NULL AND t_campus <> c_campus THEN
      RAISE EXCEPTION 'cohort period: the term belongs to a different campus than the cohort''s program'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'cohort_periods_same_campus_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 9.4 sections: only under an ACTIVE cohort period; capacity and deactivation respect the live roster.
CREATE FUNCTION app.sections_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  cp_status text;
  members integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT cp.status INTO cp_status FROM app.cohort_periods cp
     WHERE cp.organization_id = NEW.organization_id AND cp.id = NEW.cohort_period_id FOR SHARE;
    IF FOUND AND cp_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'section: the cohort period must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'sections_cohort_period_active_ck';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.cohort_period_id IS DISTINCT FROM OLD.cohort_period_id THEN
    RAISE EXCEPTION 'a section cannot move to another cohort period' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.capacity IS DISTINCT FROM OLD.capacity OR (NEW.status = 'INACTIVE' AND OLD.status <> 'INACTIVE') THEN
    SELECT count(*) INTO members FROM app.section_memberships m
     WHERE m.organization_id = NEW.organization_id AND m.section_id = NEW.id AND m.valid_to IS NULL;
    IF NEW.capacity IS NOT NULL AND members > NEW.capacity THEN
      RAISE EXCEPTION 'section capacity % is below its % current members', NEW.capacity, members
        USING ERRCODE = 'check_violation', CONSTRAINT = 'sections_capacity_ck';
    END IF;
    IF NEW.status = 'INACTIVE' AND OLD.status <> 'INACTIVE' AND members > 0 THEN
      RAISE EXCEPTION 'a section with current members cannot be deactivated' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'sections_deactivate_empty_ck';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- 9.5 courses: soft delete only while no curriculum entry prescribes the course; a deleted course never returns.
CREATE FUNCTION app.courses_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted course cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.owning_department_id IS DISTINCT FROM OLD.owning_department_id THEN
    RAISE EXCEPTION 'course identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.deleted_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM app.curriculum_courses cc
        WHERE cc.organization_id = NEW.organization_id AND cc.course_id = NEW.id) THEN
    RAISE EXCEPTION 'a course that a curriculum prescribes cannot be deleted' USING ERRCODE = 'restrict_violation',
      CONSTRAINT = 'courses_delete_unreferenced_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 9.6 curriculum_courses: ACTIVE program, live ACTIVE course, period within the programme.
CREATE FUNCTION app.curriculum_courses_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  p_status text;
  p_duration smallint;
  c_status text;
  c_deleted timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.program_id IS DISTINCT FROM OLD.program_id OR NEW.course_id IS DISTINCT FROM OLD.course_id
       OR NEW.regulation IS DISTINCT FROM OLD.regulation OR NEW.period_no IS DISTINCT FROM OLD.period_no THEN
      RAISE EXCEPTION 'curriculum entry identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.status, p.duration_periods INTO p_status, p_duration
    FROM app.programs p WHERE p.organization_id = NEW.organization_id AND p.id = NEW.program_id FOR SHARE;
  IF FOUND THEN
    IF p_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'curriculum: the program must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'curriculum_courses_program_active_ck';
    END IF;
    IF NEW.period_no > p_duration THEN
      RAISE EXCEPTION 'curriculum: period_no % exceeds the programme duration %', NEW.period_no, p_duration
        USING ERRCODE = 'check_violation', CONSTRAINT = 'curriculum_courses_within_duration_ck';
    END IF;
  END IF;
  SELECT c.status, c.deleted_at INTO c_status, c_deleted
    FROM app.courses c WHERE c.organization_id = NEW.organization_id AND c.id = NEW.course_id FOR SHARE;
  IF FOUND AND (c_status <> 'ACTIVE' OR c_deleted IS NOT NULL) THEN
    RAISE EXCEPTION 'curriculum: the course must be ACTIVE and not deleted' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'curriculum_courses_course_active_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 9.7 term_enrollments: INSERT requires an ACTIVE enrolment of the same student in the cohort period's own cohort, an
--     ACTIVE cohort period and an open term. UPDATE: only status / roll_number, forward-only machine, nothing in a LOCKED term.
CREATE FUNCTION app.term_enrollments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  sp_status text;
  sp_cohort uuid;
  cp_status text;
  cp_cohort uuid;
  t_status  text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT sp.status, sp.cohort_id INTO sp_status, sp_cohort
      FROM app.student_programs sp
     WHERE sp.organization_id = NEW.organization_id AND sp.student_id = NEW.student_id AND sp.id = NEW.student_program_id
       FOR SHARE;
    SELECT cp.status, cp.cohort_id INTO cp_status, cp_cohort
      FROM app.cohort_periods cp
     WHERE cp.organization_id = NEW.organization_id AND cp.id = NEW.cohort_period_id FOR SHARE;
    IF sp_status IS NOT NULL AND cp_cohort IS NOT NULL THEN
      IF sp_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'term enrolment: the student program must be ACTIVE' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'term_enrollments_program_active_ck';
      END IF;
      IF sp_cohort <> cp_cohort THEN
        RAISE EXCEPTION 'term enrolment: the student''s program enrolment is in a different cohort'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'term_enrollments_same_cohort_ck';
      END IF;
    END IF;
    IF cp_status IS NOT NULL AND cp_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'term enrolment: the cohort period must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'term_enrollments_cohort_period_active_ck';
    END IF;
    SELECT t.status INTO t_status FROM app.terms t
     WHERE t.organization_id = NEW.organization_id AND t.id = NEW.term_id FOR SHARE;
    IF FOUND AND t_status NOT IN ('PLANNED', 'ACTIVE') THEN
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
    OR (OLD.status = 'DETAINED'   AND NEW.status IN ('ACTIVE', 'WITHDRAWN'))
  ) THEN
    RAISE EXCEPTION 'invalid term enrolment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 9.8 section_memberships: the parent enrolment row is locked first, so competing section changes of one enrolment queue.
--     INSERT: the enrolment is REGISTERED/ACTIVE in a non-LOCKED term, valid_from lies inside the term, the section is
--     ACTIVE, and the new interval overlaps no existing one. UPDATE: only valid_to (NULL -> a date) may change.
CREATE FUNCTION app.section_memberships_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  e_status text;
  e_term   uuid;
  t_status text;
  t_start  date;
  t_end    date;
  s_status text;
  s_capacity smallint;
BEGIN
  SELECT e.status, e.term_id INTO e_status, e_term
    FROM app.term_enrollments e
   WHERE e.organization_id = NEW.organization_id AND e.id = NEW.term_enrollment_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- left to the foreign keys
  END IF;
  SELECT t.status, t.start_date, t.end_date INTO t_status, t_start, t_end
    FROM app.terms t WHERE t.organization_id = NEW.organization_id AND t.id = e_term FOR SHARE;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'section membership: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.term_enrollment_id IS DISTINCT FROM OLD.term_enrollment_id OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.cohort_period_id IS DISTINCT FROM OLD.cohort_period_id OR NEW.section_id IS DISTINCT FROM OLD.section_id
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
       OR NEW.changed_by IS DISTINCT FROM OLD.changed_by THEN
      RAISE EXCEPTION 'section membership identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'a closed section membership is terminal' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF e_status NOT IN ('REGISTERED', 'ACTIVE') THEN
    RAISE EXCEPTION 'section membership: the term enrolment is not open for placement' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'section_memberships_enrollment_open_ck';
  END IF;
  IF NEW.valid_from < t_start OR NEW.valid_from > t_end THEN
    RAISE EXCEPTION 'section membership: valid_from must lie within the term' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'section_memberships_within_term_ck';
  END IF;
  -- The section row lock serialises capacity decisions for every writer (lock order: enrolment -> section).
  SELECT s.status, s.capacity INTO s_status, s_capacity FROM app.sections s
   WHERE s.organization_id = NEW.organization_id AND s.cohort_period_id = NEW.cohort_period_id AND s.id = NEW.section_id
     FOR UPDATE;
  IF FOUND THEN
    IF s_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'section membership: the section must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'section_memberships_section_active_ck';
    END IF;
    IF s_capacity IS NOT NULL AND NEW.valid_to IS NULL AND (
         SELECT count(*) FROM app.section_memberships m
          WHERE m.organization_id = NEW.organization_id AND m.section_id = NEW.section_id AND m.valid_to IS NULL
       ) >= s_capacity THEN
      RAISE EXCEPTION 'section membership: the section is at capacity' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'section_memberships_capacity_ck';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.section_memberships m
     WHERE m.organization_id = NEW.organization_id AND m.term_enrollment_id = NEW.term_enrollment_id
       AND m.valid_from <= COALESCE(NEW.valid_to, DATE '2200-12-31')
       AND COALESCE(m.valid_to, DATE '2200-12-31') >= NEW.valid_from
  ) THEN
    RAISE EXCEPTION 'section membership overlaps an existing membership of this enrolment'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'section_memberships_no_overlap';
  END IF;
  RETURN NEW;
END
$$;

-- 9.9 student_programs: an enrolment cannot be closed while it still has LIVE term enrolments (they would be orphaned).
--     The term_enrollments INSERT guard share-locks the student_programs row, so a close that races an enrolment waits and
--     then sees it (READ COMMITTED), and an enrolment that loses the race sees a non-ACTIVE program. Fires only on a status
--     change away from ACTIVE; nothing else about student_programs changes.
CREATE FUNCTION app.student_programs_live_term_enrollments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.term_enrollments e
     WHERE e.organization_id = NEW.organization_id AND e.student_id = NEW.student_id
       AND e.student_program_id = NEW.id
       AND e.status IN ('REGISTERED', 'ACTIVE', 'DETAINED', 'ON_LEAVE')
  ) THEN
    RAISE EXCEPTION 'student program has live term enrolments; withdraw or complete them first'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'student_programs_no_live_term_enrollments_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 9.10 programs: the duration cannot shrink below a period that curriculum entries or (non-extension) cohort periods
--      already use. Curriculum and cohort-period INSERT guards share-lock the program, so a racing insert waits for this
--      statement (or this statement waits for it) and the loser sees the winner's committed row.
CREATE FUNCTION app.programs_duration_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app.curriculum_courses cc
        WHERE cc.organization_id = NEW.organization_id AND cc.program_id = NEW.id AND cc.period_no > NEW.duration_periods
     )
     OR EXISTS (
       SELECT 1 FROM app.cohort_periods cp
         JOIN app.cohorts c ON c.organization_id = cp.organization_id AND c.id = cp.cohort_id
        WHERE c.organization_id = NEW.organization_id AND c.program_id = NEW.id
          AND NOT cp.is_extension AND cp.period_no > NEW.duration_periods
     ) THEN
    RAISE EXCEPTION 'program duration is below a period that curriculum entries or cohort periods already use'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'programs_duration_in_use_ck';
  END IF;
  RETURN NEW;
END
$$;

-- 9.11 term_enrollments: entering a final status closes the open section membership in the same statement, whoever the
--      writer is (campus-local date, never before the membership started). AFTER trigger: the status change is already
--      validated by the BEFORE guard above.
CREATE FUNCTION app.term_enrollments_close_membership() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE app.section_memberships m
     SET valid_to = GREATEST(m.valid_from, (now() AT TIME ZONE c.timezone)::date)
    FROM app.terms t
    JOIN app.campuses c ON c.organization_id = t.organization_id AND c.id = t.campus_id
   WHERE m.organization_id = NEW.organization_id AND m.term_enrollment_id = NEW.id AND m.valid_to IS NULL
     AND t.organization_id = NEW.organization_id AND t.id = NEW.term_id;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION
  app.academic_years_guard(), app.terms_guard(), app.cohort_periods_guard(), app.sections_guard(),
  app.courses_guard(), app.curriculum_courses_guard(), app.term_enrollments_guard(), app.section_memberships_guard(),
  app.student_programs_live_term_enrollments_guard(), app.programs_duration_guard(),
  app.term_enrollments_close_membership()
  FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 10. Triggers (touch_row + immutable keys + guards)
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER academic_years_touch BEFORE UPDATE ON app.academic_years FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER academic_years_immutable BEFORE UPDATE ON app.academic_years FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER academic_years_guard_iu BEFORE INSERT OR UPDATE ON app.academic_years FOR EACH ROW EXECUTE FUNCTION app.academic_years_guard();

CREATE TRIGGER terms_touch BEFORE UPDATE ON app.terms FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER terms_immutable BEFORE UPDATE ON app.terms FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER terms_guard_iu BEFORE INSERT OR UPDATE ON app.terms FOR EACH ROW EXECUTE FUNCTION app.terms_guard();

CREATE TRIGGER cohort_periods_touch BEFORE UPDATE ON app.cohort_periods FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER cohort_periods_immutable BEFORE UPDATE ON app.cohort_periods FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER cohort_periods_guard_iu BEFORE INSERT OR UPDATE ON app.cohort_periods FOR EACH ROW EXECUTE FUNCTION app.cohort_periods_guard();

CREATE TRIGGER sections_touch BEFORE UPDATE ON app.sections FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER sections_immutable BEFORE UPDATE ON app.sections FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER sections_guard_iu BEFORE INSERT OR UPDATE ON app.sections FOR EACH ROW EXECUTE FUNCTION app.sections_guard();

CREATE TRIGGER courses_touch BEFORE UPDATE ON app.courses FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER courses_immutable BEFORE UPDATE ON app.courses FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER courses_guard_upd BEFORE UPDATE ON app.courses FOR EACH ROW EXECUTE FUNCTION app.courses_guard();

CREATE TRIGGER curriculum_courses_touch BEFORE UPDATE ON app.curriculum_courses FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER curriculum_courses_immutable BEFORE UPDATE ON app.curriculum_courses FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER curriculum_courses_guard_iu BEFORE INSERT OR UPDATE ON app.curriculum_courses FOR EACH ROW EXECUTE FUNCTION app.curriculum_courses_guard();

CREATE TRIGGER term_enrollments_touch BEFORE UPDATE ON app.term_enrollments FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER term_enrollments_immutable BEFORE UPDATE ON app.term_enrollments FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER term_enrollments_guard_iu BEFORE INSERT OR UPDATE ON app.term_enrollments FOR EACH ROW EXECUTE FUNCTION app.term_enrollments_guard();

CREATE TRIGGER section_memberships_touch BEFORE UPDATE ON app.section_memberships FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER section_memberships_immutable BEFORE UPDATE ON app.section_memberships FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER section_memberships_guard_iu BEFORE INSERT OR UPDATE ON app.section_memberships FOR EACH ROW EXECUTE FUNCTION app.section_memberships_guard();

CREATE TRIGGER student_programs_live_term_enrollments_guard_upd BEFORE UPDATE OF status ON app.student_programs
  FOR EACH ROW WHEN (OLD.status = 'ACTIVE' AND NEW.status IS DISTINCT FROM 'ACTIVE')
  EXECUTE FUNCTION app.student_programs_live_term_enrollments_guard();

CREATE TRIGGER programs_duration_guard_upd BEFORE UPDATE OF duration_periods ON app.programs
  FOR EACH ROW WHEN (NEW.duration_periods < OLD.duration_periods)
  EXECUTE FUNCTION app.programs_duration_guard();

CREATE TRIGGER term_enrollments_close_membership_upd AFTER UPDATE OF status ON app.term_enrollments
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('WITHDRAWN', 'PROMOTED', 'COMPLETED'))
  EXECUTE FUNCTION app.term_enrollments_close_membership();

-- ---------------------------------------------------------------------------------------------
-- 11. Row-level security (FORCE on every table) and least-privilege grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.academic_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.academic_years FORCE  ROW LEVEL SECURITY;
CREATE POLICY academic_years_tenant_select ON app.academic_years AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY academic_years_tenant_insert ON app.academic_years AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY academic_years_tenant_update ON app.academic_years AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY academic_years_staff_insert ON app.academic_years AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY academic_years_staff_update ON app.academic_years AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.terms FORCE  ROW LEVEL SECURITY;
CREATE POLICY terms_tenant_select ON app.terms AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY terms_tenant_insert ON app.terms AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY terms_tenant_update ON app.terms AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY terms_staff_insert ON app.terms AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY terms_staff_update ON app.terms AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.cohort_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.cohort_periods FORCE  ROW LEVEL SECURITY;
CREATE POLICY cohort_periods_tenant_select ON app.cohort_periods AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY cohort_periods_tenant_insert ON app.cohort_periods AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY cohort_periods_tenant_update ON app.cohort_periods AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY cohort_periods_staff_insert ON app.cohort_periods AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY cohort_periods_staff_update ON app.cohort_periods AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sections FORCE  ROW LEVEL SECURITY;
CREATE POLICY sections_tenant_select ON app.sections AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY sections_tenant_insert ON app.sections AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY sections_tenant_update ON app.sections AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY sections_staff_insert ON app.sections AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY sections_staff_update ON app.sections AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.courses FORCE  ROW LEVEL SECURITY;
CREATE POLICY courses_tenant_select ON app.courses AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY courses_tenant_insert ON app.courses AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY courses_tenant_update ON app.courses AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY courses_staff_insert ON app.courses AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY courses_staff_update ON app.courses AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.curriculum_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.curriculum_courses FORCE  ROW LEVEL SECURITY;
CREATE POLICY curriculum_courses_tenant_select ON app.curriculum_courses AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY curriculum_courses_tenant_insert ON app.curriculum_courses AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY curriculum_courses_tenant_update ON app.curriculum_courses AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY curriculum_courses_staff_insert ON app.curriculum_courses AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY curriculum_courses_staff_update ON app.curriculum_courses AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.term_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.term_enrollments FORCE  ROW LEVEL SECURITY;
CREATE POLICY term_enrollments_tenant_select ON app.term_enrollments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY term_enrollments_tenant_insert ON app.term_enrollments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY term_enrollments_tenant_update ON app.term_enrollments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY term_enrollments_staff_insert ON app.term_enrollments AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY term_enrollments_staff_update ON app.term_enrollments AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.section_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.section_memberships FORCE  ROW LEVEL SECURITY;
CREATE POLICY section_memberships_tenant_select ON app.section_memberships AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY section_memberships_tenant_insert ON app.section_memberships AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY section_memberships_tenant_update ON app.section_memberships AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Writes are staff-only at the database; WHICH staff member, and in which scope, is the engine's decision.
CREATE POLICY section_memberships_staff_insert ON app.section_memberships AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY section_memberships_staff_update ON app.section_memberships AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY curriculum_courses_tenant_delete ON app.curriculum_courses AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY curriculum_courses_staff_delete ON app.curriculum_courses AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

-- Student-bearing tables: a STUDENT reads only their OWN rows (doc 08 §4 student_self_only); STAFF read the tenant.
CREATE POLICY term_enrollments_student_self ON app.term_enrollments AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY section_memberships_student_self ON app.section_memberships AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.academic_years, app.terms, app.cohort_periods, app.sections, app.courses,
                        app.curriculum_courses, app.term_enrollments, app.section_memberships TO app_runtime;
GRANT DELETE ON app.curriculum_courses TO app_runtime;
-- id, organization_id and every identity / business-key column are fixed at creation.
GRANT UPDATE (start_date, end_date, status)                            ON app.academic_years     TO app_runtime;
GRANT UPDATE (name, start_date, end_date, status, locked_at, locked_by) ON app.terms             TO app_runtime;
GRANT UPDATE (status)                                                  ON app.cohort_periods     TO app_runtime;
GRANT UPDATE (name, capacity, status)                                  ON app.sections           TO app_runtime;
GRANT UPDATE (title, credits, course_type, tracks_attendance, status, deleted_at) ON app.courses TO app_runtime;
GRANT UPDATE (category, elective_group_code)                           ON app.curriculum_courses TO app_runtime;
GRANT UPDATE (status, roll_number)                                     ON app.term_enrollments   TO app_runtime;
GRANT UPDATE (valid_to)                                                ON app.section_memberships TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 12. Permissions (doc 10 §1 rows 50-54). Granted to roles by seedTenantRoles; existing tenants must be re-seeded.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('academic.term.manage', 'SENSITIVE'),
  ('academic.course.manage', 'SENSITIVE'),
  ('academic.section.manage', 'SENSITIVE'),
  ('enrollment.term.read', 'SENSITIVE'),
  ('enrollment.term.manage', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
