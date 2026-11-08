-- 0040_attendance_sessions_and_records
-- Owner: app_migrator
-- Milestone 4 (Attendance), Slice 1. Authorised on synthetic data by the owner amendment of 2026-11-05 (docs 39 §14, 40 §7).
-- Specification: docs/architecture/v3/02 §4.7 (class_sessions, attendance_records, attendance_record_revisions),
--                03 (attendance.session.mark / attendance.record.read), 05 §5 (student-self policy), 04 Part 16 (M4).
--
-- Contents:
--  1. app.class_sessions                  - one teaching event of an offering on a campus-local date
--  2. app.attendance_records              - one student x session; the CURRENT value; never deleted
--  3. app.attendance_record_revisions     - append-only history; every record value has a revision of the same number
--  4. guards, the append-only trigger and the deferred record <-> revision pairing check
--  5. row level security (tenant + staff-only writes + student self) and least-privilege grants
--  6. platform.permissions: attendance.session.mark, attendance.record.read
--
-- Deliberately NOT here (later slices): attendance_policies, attendance_summaries, correction approval and
-- attendance.record.correct, session cancel/lock endpoints, excused_by_request_id / capture_session_id (no consumer yet),
-- approved_by_user_id / service_request_id on revisions, notifications. Nothing here reads or writes real school data.
--
-- Initial marking is revision 1 with status_before NULL (doc 02 makes status_before nullable). The closed reason list has
-- no "initial mark" value, so revision 1 carries reason_code OTHER; the application writes reason_text 'Initial marking'.
--
-- Role grants (role_permissions) are NOT written here: like 0037/0039 they come from the tenant role seed (role-matrix.ts).
-- Production re-seeding is a separate, unauthorised operation.
--
-- ROLLOUT: not a *_contract migration; the runner defers it behind 0009/0019 like 0020-0039. Only new tables.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.class_sessions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.class_sessions (
  id                       app.uuid_v7 PRIMARY KEY,
  organization_id          app.uuid_v7 NOT NULL,
  -- DERIVED by the guard from the offering; whatever a writer supplies is overwritten.
  campus_id                app.uuid_v7 NOT NULL,
  course_offering_id       app.uuid_v7 NOT NULL,
  timetable_slot_id        app.uuid_v7,
  conducted_by_employee_id app.uuid_v7 NOT NULL,
  session_date             date        NOT NULL CHECK (session_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  kind                     text        NOT NULL CHECK (kind IN ('REGULAR', 'EXTRA', 'MAKEUP')),
  topic                    text        CHECK (topic IS NULL OR char_length(topic) BETWEEN 1 AND 500),
  status                   text        NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CONDUCTED', 'CANCELLED')),
  cancel_reason            text        CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 1 AND 500),
  attendance_state         text        NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (attendance_state IN ('NOT_STARTED', 'OPEN', 'SUBMITTED', 'LOCKED')),
  attendance_submitted_at  timestamptz,
  attendance_submitted_by  app.uuid_v7,
  locked_at                timestamptz,
  version                  integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_sessions_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_slot_fk FOREIGN KEY (organization_id, timetable_slot_id)
    REFERENCES app.timetable_slots (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_employee_fk FOREIGN KEY (organization_id, conducted_by_employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_submitted_by_fk FOREIGN KEY (organization_id, attendance_submitted_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT class_sessions_time_ck CHECK (ends_at > starts_at),
  CONSTRAINT class_sessions_cancel_ck CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  -- a cancelled session never takes attendance; a submitted or locked one was conducted
  CONSTRAINT class_sessions_state_ck CHECK (
    (status = 'CANCELLED' AND attendance_state = 'NOT_STARTED')
    OR (status = 'SCHEDULED' AND attendance_state IN ('NOT_STARTED', 'OPEN'))
    OR (status = 'CONDUCTED')),
  CONSTRAINT class_sessions_submitted_ck CHECK (
    (attendance_state IN ('SUBMITTED', 'LOCKED')) = (attendance_submitted_at IS NOT NULL AND attendance_submitted_by IS NOT NULL)),
  CONSTRAINT class_sessions_locked_ck CHECK ((attendance_state = 'LOCKED') = (locked_at IS NOT NULL)),
  CONSTRAINT class_sessions_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT class_sessions_offering_starts_uq UNIQUE (organization_id, course_offering_id, starts_at)
);
CREATE INDEX class_sessions_org_campus_date_ix ON app.class_sessions (organization_id, campus_id, session_date);
CREATE INDEX class_sessions_org_employee_ix ON app.class_sessions (organization_id, conducted_by_employee_id, starts_at);
CREATE INDEX class_sessions_org_slot_ix ON app.class_sessions (organization_id, timetable_slot_id)
  WHERE timetable_slot_id IS NOT NULL;
CREATE INDEX class_sessions_org_submitted_by_ix ON app.class_sessions (organization_id, attendance_submitted_by)
  WHERE attendance_submitted_by IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. app.attendance_records (current value; INSERT at submission, UPDATE only paired with a revision)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.attendance_records (
  id                     app.uuid_v7 PRIMARY KEY,
  organization_id        app.uuid_v7 NOT NULL,
  class_session_id       app.uuid_v7 NOT NULL,
  student_id             app.uuid_v7 NOT NULL,
  course_registration_id app.uuid_v7 NOT NULL,
  -- DERIVED by the guard from the session; whatever a writer supplies is overwritten.
  course_offering_id     app.uuid_v7 NOT NULL,
  session_date           date        NOT NULL,
  status                 text        NOT NULL CHECK (status IN ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED')),
  source                 text        NOT NULL CHECK (source IN ('MANUAL', 'IMPORT', 'CORRECTION', 'SYSTEM', 'QR')),
  marked_by_user_id      app.uuid_v7 NOT NULL,
  marked_at              timestamptz NOT NULL DEFAULT now(),
  revision_no            integer     NOT NULL DEFAULT 1 CHECK (revision_no > 0),
  remarks                text        CHECK (remarks IS NULL OR char_length(remarks) BETWEEN 1 AND 500),
  version                integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_records_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- high-risk cross-tenant join (doc 02 §4.7)
  CONSTRAINT attendance_records_session_fk FOREIGN KEY (organization_id, class_session_id)
    REFERENCES app.class_sessions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_registration_fk FOREIGN KEY (organization_id, course_registration_id)
    REFERENCES app.course_registrations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_marked_by_fk FOREIGN KEY (organization_id, marked_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_records_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT attendance_records_session_student_uq UNIQUE (organization_id, class_session_id, student_id)
);
CREATE INDEX attendance_records_org_student_date_ix ON app.attendance_records (organization_id, student_id, session_date);
CREATE INDEX attendance_records_org_offering_student_ix ON app.attendance_records (organization_id, course_offering_id, student_id);
CREATE INDEX attendance_records_org_registration_ix ON app.attendance_records (organization_id, course_registration_id);
CREATE INDEX attendance_records_org_marked_by_ix ON app.attendance_records (organization_id, marked_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 3. app.attendance_record_revisions (append-only)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.attendance_record_revisions (
  id                   app.uuid_v7 PRIMARY KEY,
  organization_id      app.uuid_v7 NOT NULL,
  attendance_record_id app.uuid_v7 NOT NULL,
  revision_no          integer     NOT NULL CHECK (revision_no > 0),
  status_before        text        CHECK (status_before IS NULL OR status_before IN ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED')),
  status_after         text        NOT NULL CHECK (status_after IN ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED')),
  source               text        NOT NULL CHECK (source IN ('MANUAL', 'IMPORT', 'CORRECTION', 'SYSTEM', 'QR')),
  changed_by_user_id   app.uuid_v7 NOT NULL,
  changed_at           timestamptz NOT NULL DEFAULT now(),
  reason_code          varchar(40) NOT NULL CHECK (reason_code IN
    ('FACULTY_ERROR', 'STUDENT_DISPUTE', 'MEDICAL', 'DUTY_LEAVE', 'SYSTEM_RECOMPUTE', 'OTHER')),
  reason_text          text        CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 1 AND 500),
  CONSTRAINT attendance_revisions_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT attendance_revisions_record_fk FOREIGN KEY (organization_id, attendance_record_id)
    REFERENCES app.attendance_records (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_revisions_changed_by_fk FOREIGN KEY (organization_id, changed_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  -- the first revision has no previous value, every later one has; a revision always changes the value
  CONSTRAINT attendance_revisions_initial_ck CHECK ((revision_no = 1) = (status_before IS NULL)),
  CONSTRAINT attendance_revisions_changed_ck CHECK (status_before IS NULL OR status_before <> status_after),
  CONSTRAINT attendance_revisions_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT attendance_revisions_record_no_uq UNIQUE (organization_id, attendance_record_id, revision_no)
);
CREATE INDEX attendance_revisions_org_changed_by_ix ON app.attendance_record_revisions (organization_id, changed_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.class_sessions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  o_status  text;
  o_tracks  boolean;
  o_campus  uuid;
  o_term    uuid;
  t_status  text;
  t_start   date;
  t_end     date;
  tz        text;
BEGIN
  SELECT o.status, o.tracks_attendance, o.campus_id, o.term_id INTO o_status, o_tracks, o_campus, o_term
    FROM app.course_offerings o WHERE o.organization_id = NEW.organization_id AND o.id = NEW.course_offering_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- left to the foreign keys
  END IF;
  SELECT t.status, t.start_date, t.end_date, c.timezone INTO t_status, t_start, t_end, tz
    FROM app.terms t JOIN app.campuses c ON c.organization_id = t.organization_id AND c.id = t.campus_id
   WHERE t.organization_id = NEW.organization_id AND t.id = o_term FOR SHARE OF t;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'class session: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.campus_id IS DISTINCT FROM OLD.campus_id OR NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id
       OR NEW.timetable_slot_id IS DISTINCT FROM OLD.timetable_slot_id
       OR NEW.conducted_by_employee_id IS DISTINCT FROM OLD.conducted_by_employee_id
       OR NEW.session_date IS DISTINCT FROM OLD.session_date OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'class session identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         OLD.status = 'SCHEDULED' AND NEW.status IN ('CONDUCTED', 'CANCELLED')) THEN
      RAISE EXCEPTION 'invalid class session status transition % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'class_sessions_status_transition_ck';
    END IF;
    IF NEW.attendance_state IS DISTINCT FROM OLD.attendance_state AND NOT (
         (OLD.attendance_state IN ('NOT_STARTED', 'OPEN') AND NEW.attendance_state = 'SUBMITTED')
      OR (OLD.attendance_state = 'SUBMITTED' AND NEW.attendance_state = 'LOCKED')
      OR (OLD.attendance_state = 'NOT_STARTED' AND NEW.attendance_state = 'OPEN')) THEN
      RAISE EXCEPTION 'invalid attendance state transition % -> %', OLD.attendance_state, NEW.attendance_state
        USING ERRCODE = 'check_violation', CONSTRAINT = 'class_sessions_state_transition_ck';
    END IF;
    IF OLD.attendance_state = 'LOCKED' THEN
      RAISE EXCEPTION 'a locked class session is read-only' USING ERRCODE = 'restrict_violation';
    END IF;
    -- submission facts are written once, with the submission
    IF OLD.attendance_state IN ('SUBMITTED', 'LOCKED')
       AND (NEW.attendance_submitted_at IS DISTINCT FROM OLD.attendance_submitted_at
            OR NEW.attendance_submitted_by IS DISTINCT FROM OLD.attendance_submitted_by) THEN
      RAISE EXCEPTION 'submission facts are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT
  NEW.campus_id := o_campus;
  IF NEW.status <> 'SCHEDULED' OR NEW.attendance_state <> 'NOT_STARTED' THEN
    RAISE EXCEPTION 'a class session starts SCHEDULED with attendance NOT_STARTED' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_starts_scheduled_ck';
  END IF;
  IF o_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'class session: the offering is not PUBLISHED' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_offering_published_ck';
  END IF;
  IF NOT o_tracks THEN
    RAISE EXCEPTION 'class session: the offering does not track attendance' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_offering_tracks_ck';
  END IF;
  IF t_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'class session: the term is not ACTIVE' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_term_active_ck';
  END IF;
  IF NEW.session_date < t_start OR NEW.session_date > t_end THEN
    RAISE EXCEPTION 'class session: session_date must lie within the term' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_within_term_ck';
  END IF;
  -- campus-local calendar day: the instants must fall on session_date in the campus time zone
  IF (NEW.starts_at AT TIME ZONE tz)::date <> NEW.session_date OR (NEW.ends_at AT TIME ZONE tz)::date <> NEW.session_date THEN
    RAISE EXCEPTION 'class session: starts_at and ends_at must fall on session_date in the campus time zone'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'class_sessions_local_date_ck';
  END IF;
  IF NEW.timetable_slot_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.timetable_slots s
        WHERE s.organization_id = NEW.organization_id AND s.id = NEW.timetable_slot_id
          AND s.course_offering_id = NEW.course_offering_id
          AND s.effective_from <= NEW.session_date AND (s.effective_to IS NULL OR s.effective_to >= NEW.session_date)
          AND s.weekday = EXTRACT(ISODOW FROM NEW.session_date)::int) THEN
    RAISE EXCEPTION 'class session: the timetable slot is not valid for this offering and date' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'class_sessions_slot_ck';
  END IF;
  IF NEW.kind = 'REGULAR' AND EXISTS (
       SELECT 1 FROM app.holidays h
        WHERE h.organization_id = NEW.organization_id AND h.status = 'ACTIVE' AND h.kind IN ('HOLIDAY', 'NON_TEACHING_DAY')
          AND h.holiday_date = NEW.session_date AND (h.campus_id IS NULL OR h.campus_id = o_campus)) THEN
    RAISE EXCEPTION 'class session: a REGULAR session cannot fall on a holiday or non-teaching day'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'class_sessions_holiday_ck';
  END IF;
  -- the conducting employee must be ACTIVE and hold a faculty assignment on the offering that covers the date
  IF NOT EXISTS (
       SELECT 1 FROM app.employees e
         JOIN app.faculty_assignments fa ON fa.organization_id = e.organization_id AND fa.employee_id = e.id
        WHERE e.organization_id = NEW.organization_id AND e.id = NEW.conducted_by_employee_id AND e.status = 'ACTIVE'
          AND fa.course_offering_id = NEW.course_offering_id
          AND fa.valid_from <= NEW.session_date AND COALESCE(fa.valid_to, t_end) >= NEW.session_date) THEN
    RAISE EXCEPTION 'class session: the teacher holds no valid assignment on this offering for the date'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'class_sessions_teacher_ck';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.attendance_records_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  s_offering uuid;
  s_date     date;
  s_status   text;
  s_state    text;
  t_status   text;
  t_end      date;
BEGIN
  SELECT cs.course_offering_id, cs.session_date, cs.status, cs.attendance_state INTO s_offering, s_date, s_status, s_state
    FROM app.class_sessions cs WHERE cs.organization_id = NEW.organization_id AND cs.id = NEW.class_session_id FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- left to the foreign keys
  END IF;
  SELECT t.status, t.end_date INTO t_status, t_end
    FROM app.course_offerings o JOIN app.terms t ON t.organization_id = o.organization_id AND t.id = o.term_id
   WHERE o.organization_id = NEW.organization_id AND o.id = s_offering FOR SHARE OF t;
  IF t_status = 'LOCKED' THEN
    RAISE EXCEPTION 'attendance: the term is LOCKED' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.class_session_id IS DISTINCT FROM OLD.class_session_id OR NEW.student_id IS DISTINCT FROM OLD.student_id
       OR NEW.course_registration_id IS DISTINCT FROM OLD.course_registration_id
       OR NEW.course_offering_id IS DISTINCT FROM OLD.course_offering_id OR NEW.session_date IS DISTINCT FROM OLD.session_date THEN
      RAISE EXCEPTION 'attendance record identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF s_state = 'LOCKED' THEN
      RAISE EXCEPTION 'a locked class session is read-only' USING ERRCODE = 'restrict_violation';
    END IF;
    -- every change of the current value is revision N+1 (the deferred pairing check proves the revision row exists)
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.marked_by_user_id IS DISTINCT FROM OLD.marked_by_user_id OR NEW.marked_at IS DISTINCT FROM OLD.marked_at
       OR NEW.remarks IS DISTINCT FROM OLD.remarks OR NEW.revision_no IS DISTINCT FROM OLD.revision_no THEN
      IF NEW.revision_no <> OLD.revision_no + 1 THEN
        RAISE EXCEPTION 'attendance record: a change must advance revision_no by one' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'attendance_records_revision_advance_ck';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: only while the session is open for its first submission
  IF s_status = 'CANCELLED' OR s_state NOT IN ('NOT_STARTED', 'OPEN') THEN
    RAISE EXCEPTION 'attendance: the session is not open for marking' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'attendance_records_session_open_ck';
  END IF;
  IF NEW.revision_no <> 1 THEN
    RAISE EXCEPTION 'a new attendance record starts at revision 1' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'attendance_records_starts_rev1_ck';
  END IF;
  NEW.course_offering_id := s_offering;
  NEW.session_date := s_date;
  -- the student must hold a live registration on the offering on the session date (roster rule, doc 02 §7)
  IF NOT EXISTS (
       SELECT 1 FROM app.course_registrations r
        WHERE r.organization_id = NEW.organization_id AND r.id = NEW.course_registration_id
          AND r.student_id = NEW.student_id AND r.course_offering_id = s_offering
          AND r.status NOT IN ('PENDING_APPROVAL', 'REJECTED')
          AND r.valid_from <= s_date AND COALESCE(r.valid_to, t_end) >= s_date) THEN
    RAISE EXCEPTION 'attendance: the student holds no live registration on this offering for the session date'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'attendance_records_roster_ck';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION app.attendance_revisions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  last_no     integer;
  last_status text;
BEGIN
  -- serialise revisions of one record
  PERFORM 1 FROM app.attendance_records r
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.attendance_record_id FOR UPDATE;
  SELECT v.revision_no, v.status_after INTO last_no, last_status
    FROM app.attendance_record_revisions v
   WHERE v.organization_id = NEW.organization_id AND v.attendance_record_id = NEW.attendance_record_id
   ORDER BY v.revision_no DESC LIMIT 1;
  IF NEW.revision_no <> COALESCE(last_no, 0) + 1 THEN
    RAISE EXCEPTION 'attendance revision numbers are contiguous' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'attendance_revisions_contiguous_ck';
  END IF;
  IF last_no IS NOT NULL AND NEW.status_before IS DISTINCT FROM last_status THEN
    RAISE EXCEPTION 'attendance revision: status_before must equal the previous status_after' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'attendance_revisions_chain_ck';
  END IF;
  RETURN NEW;
END
$$;

-- Deferred (commit-time) pairing: the record's current revision_no, status, source and actor equal its LATEST revision, and
-- revisions are contiguous 1..revision_no. Fires on record writes and on revision inserts, so neither can change alone.
CREATE FUNCTION app.attendance_pairing_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  rec_id uuid;
  rec    app.attendance_records%ROWTYPE;
  v_cnt  integer;
  v_last app.attendance_record_revisions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'attendance_records' THEN
    rec_id := NEW.id;
  ELSE
    rec_id := NEW.attendance_record_id;
  END IF;
  SELECT * INTO rec FROM app.attendance_records r WHERE r.organization_id = NEW.organization_id AND r.id = rec_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_cnt FROM app.attendance_record_revisions v
   WHERE v.organization_id = rec.organization_id AND v.attendance_record_id = rec.id;
  SELECT * INTO v_last FROM app.attendance_record_revisions v
   WHERE v.organization_id = rec.organization_id AND v.attendance_record_id = rec.id
   ORDER BY v.revision_no DESC LIMIT 1;
  IF v_cnt <> rec.revision_no OR v_last.revision_no IS DISTINCT FROM rec.revision_no
     OR v_last.status_after IS DISTINCT FROM rec.status OR v_last.source IS DISTINCT FROM rec.source
     OR v_last.changed_by_user_id IS DISTINCT FROM rec.marked_by_user_id THEN
    RAISE EXCEPTION 'attendance record and its revision history are out of step' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'attendance_records_revision_pair_ck';
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app.class_sessions_guard(), app.attendance_records_guard(), app.attendance_revisions_guard(),
  app.attendance_pairing_check() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 4.1 Triggers
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER class_sessions_touch BEFORE UPDATE ON app.class_sessions FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER class_sessions_immutable BEFORE UPDATE ON app.class_sessions FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER class_sessions_guard_iu BEFORE INSERT OR UPDATE ON app.class_sessions FOR EACH ROW EXECUTE FUNCTION app.class_sessions_guard();
CREATE TRIGGER class_sessions_no_delete BEFORE DELETE ON app.class_sessions FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

CREATE TRIGGER attendance_records_touch BEFORE UPDATE ON app.attendance_records FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER attendance_records_immutable BEFORE UPDATE ON app.attendance_records FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
CREATE TRIGGER attendance_records_guard_iu BEFORE INSERT OR UPDATE ON app.attendance_records FOR EACH ROW EXECUTE FUNCTION app.attendance_records_guard();
CREATE TRIGGER attendance_records_no_delete BEFORE DELETE ON app.attendance_records FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
CREATE CONSTRAINT TRIGGER attendance_records_pairing AFTER INSERT OR UPDATE ON app.attendance_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.attendance_pairing_check();

-- append-only for EVERY role (same function as app.audit_events)
CREATE TRIGGER attendance_revisions_immutable BEFORE UPDATE OR DELETE ON app.attendance_record_revisions
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
CREATE TRIGGER attendance_revisions_guard_i BEFORE INSERT ON app.attendance_record_revisions
  FOR EACH ROW EXECUTE FUNCTION app.attendance_revisions_guard();
CREATE CONSTRAINT TRIGGER attendance_revisions_pairing AFTER INSERT ON app.attendance_record_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.attendance_pairing_check();

-- ---------------------------------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.class_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY class_sessions_tenant_select ON app.class_sessions AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY class_sessions_tenant_insert ON app.class_sessions AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY class_sessions_tenant_update ON app.class_sessions AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- A student sees only sessions in which they have their OWN record, and never writes.
CREATE POLICY class_sessions_student_self ON app.class_sessions AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND EXISTS (SELECT 1 FROM app.attendance_records AS ar
                          WHERE ar.organization_id = class_sessions.organization_id AND ar.class_session_id = class_sessions.id
                            AND ar.student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id()))))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_records FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_records_tenant_select ON app.attendance_records AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_records_tenant_insert ON app.attendance_records AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_records_tenant_update ON app.attendance_records AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Student-bearing (doc 05 §5 student_self_only): a STUDENT reads only their OWN rows and never writes.
CREATE POLICY attendance_records_student_self ON app.attendance_records AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.attendance_record_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_record_revisions FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_revisions_tenant_select ON app.attendance_record_revisions AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_revisions_tenant_insert ON app.attendance_record_revisions AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- No UPDATE or DELETE policy and no privilege: history cannot change for the runtime role.
CREATE POLICY attendance_revisions_student_self ON app.attendance_record_revisions AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND attendance_record_id IN (
               SELECT ar.id FROM app.attendance_records AS ar
                WHERE ar.organization_id = attendance_record_revisions.organization_id
                  AND ar.student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id()))))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- No DELETE anywhere: sessions are cancelled, records change by revision, revisions are immutable.
GRANT SELECT, INSERT ON app.class_sessions, app.attendance_records, app.attendance_record_revisions TO app_runtime;
GRANT UPDATE (status, cancel_reason, attendance_state, attendance_submitted_at, attendance_submitted_by, locked_at, topic)
  ON app.class_sessions TO app_runtime;
GRANT UPDATE (status, source, marked_by_user_id, marked_at, revision_no, remarks) ON app.attendance_records TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 6. Permissions (grants to roles come from the tenant role seed, see the header)
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('attendance.session.mark', 'SENSITIVE'),
  ('attendance.record.read', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
