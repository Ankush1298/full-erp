-- 0044_examinations_and_results
-- Owner: app_migrator
-- Pilot V1: Track A Core ERP - Examinations, Marks, and Results (Slice 1).
-- Specification: docs/architecture/v3/01 §3.8, 02 §4.8, 47 (Task 5), prompt requirements.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.examinations
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.examinations (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  campus_id           app.uuid_v7 NOT NULL,
  term_id             app.uuid_v7 NOT NULL,
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  exam_type           text        NOT NULL CHECK (exam_type IN ('UNIT_TEST', 'MID_TERM', 'FINAL', 'INTERNAL', 'SUPPLEMENTARY', 'OTHER')),
  status              text        NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
  starts_on           date,
  ends_on             date,
  description         text        CHECK (description IS NULL OR char_length(description) <= 500),
  created_by_user_id  app.uuid_v7 NOT NULL,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT examinations_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT examinations_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT examinations_term_fk FOREIGN KEY (organization_id, term_id)
    REFERENCES app.terms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT examinations_created_by_fk FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT examinations_dates_ck CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on),
  CONSTRAINT examinations_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX examinations_org_term_ix ON app.examinations (organization_id, term_id);
CREATE INDEX examinations_org_campus_ix ON app.examinations (organization_id, campus_id);
CREATE INDEX examinations_org_created_by_ix ON app.examinations (organization_id, created_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 2. app.exam_schedules
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.exam_schedules (
  id                         app.uuid_v7 PRIMARY KEY,
  organization_id            app.uuid_v7 NOT NULL,
  examination_id             app.uuid_v7 NOT NULL,
  course_offering_id         app.uuid_v7 NOT NULL,
  exam_date                  date        NOT NULL,
  start_time                 text        CHECK (start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time                   text        CHECK (end_time IS NULL OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  max_marks                  numeric(6,2) NOT NULL CHECK (max_marks > 0),
  pass_marks                 numeric(6,2) NOT NULL CHECK (pass_marks >= 0 AND pass_marks <= max_marks),
  status                     text        NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'DRAFT_MARKS', 'SUBMITTED', 'PUBLISHED', 'CANCELLED')),
  marks_submitted_at         timestamptz,
  marks_submitted_by_user_id app.uuid_v7,
  published_at               timestamptz,
  published_by_user_id       app.uuid_v7,
  version                    integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_schedules_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT exam_schedules_examination_fk FOREIGN KEY (organization_id, examination_id)
    REFERENCES app.examinations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_schedules_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_schedules_submitted_by_fk FOREIGN KEY (organization_id, marks_submitted_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_schedules_published_by_fk FOREIGN KEY (organization_id, published_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_schedules_exam_offering_uq UNIQUE (organization_id, examination_id, course_offering_id),
  CONSTRAINT exam_schedules_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX exam_schedules_org_exam_ix ON app.exam_schedules (organization_id, examination_id);
CREATE INDEX exam_schedules_org_offering_ix ON app.exam_schedules (organization_id, course_offering_id);
CREATE INDEX exam_schedules_org_submitted_by_ix ON app.exam_schedules (organization_id, marks_submitted_by_user_id);
CREATE INDEX exam_schedules_org_published_by_ix ON app.exam_schedules (organization_id, published_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 3. app.exam_marks
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.exam_marks (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  exam_schedule_id    app.uuid_v7 NOT NULL,
  student_id          app.uuid_v7 NOT NULL,
  marks_obtained      numeric(6,2) CHECK (marks_obtained IS NULL OR marks_obtained >= 0),
  status              text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'ABSENT', 'EXEMPT', 'WITHHELD')),
  is_passing          boolean,
  remarks             text        CHECK (remarks IS NULL OR char_length(remarks) <= 500),
  marked_by_user_id   app.uuid_v7 NOT NULL,
  marked_at           timestamptz NOT NULL DEFAULT now(),
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_marks_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT exam_marks_schedule_fk FOREIGN KEY (organization_id, exam_schedule_id)
    REFERENCES app.exam_schedules (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_marks_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_marks_marked_by_fk FOREIGN KEY (organization_id, marked_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_marks_schedule_student_uq UNIQUE (organization_id, exam_schedule_id, student_id),
  CONSTRAINT exam_marks_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX exam_marks_org_schedule_ix ON app.exam_marks (organization_id, exam_schedule_id);
CREATE INDEX exam_marks_org_student_ix ON app.exam_marks (organization_id, student_id);
CREATE INDEX exam_marks_org_marked_by_ix ON app.exam_marks (organization_id, marked_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.exam_schedules_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_exam_term_id app.uuid_v7;
  v_exam_campus_id app.uuid_v7;
  v_offering_term_id app.uuid_v7;
  v_offering_campus_id app.uuid_v7;
BEGIN
  SELECT term_id, campus_id INTO v_exam_term_id, v_exam_campus_id
    FROM app.examinations
   WHERE organization_id = NEW.organization_id AND id = NEW.examination_id;
  IF v_exam_term_id IS NULL THEN
    RAISE EXCEPTION 'examination not found in organization' USING ERRCODE = 'check_violation';
  END IF;

  SELECT term_id, campus_id INTO v_offering_term_id, v_offering_campus_id
    FROM app.course_offerings
   WHERE organization_id = NEW.organization_id AND id = NEW.course_offering_id;
  IF v_offering_term_id IS NULL THEN
    RAISE EXCEPTION 'course offering not found in organization' USING ERRCODE = 'check_violation';
  END IF;

  IF v_exam_term_id <> v_offering_term_id THEN
    RAISE EXCEPTION 'exam schedule course offering term must match examination term' USING ERRCODE = 'check_violation';
  END IF;

  IF v_exam_campus_id <> v_offering_campus_id THEN
    RAISE EXCEPTION 'exam schedule course offering campus must match examination campus' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION app.exam_marks_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_max_marks numeric(6,2);
  v_pass_marks numeric(6,2);
  v_sched_status text;
BEGIN
  SELECT max_marks, pass_marks, status INTO v_max_marks, v_pass_marks, v_sched_status
    FROM app.exam_schedules
   WHERE organization_id = NEW.organization_id AND id = NEW.exam_schedule_id;
  IF v_max_marks IS NULL THEN
    RAISE EXCEPTION 'exam schedule not found in organization' USING ERRCODE = 'check_violation';
  END IF;

  -- Validate marks boundary against schedule max_marks
  IF NEW.marks_obtained IS NOT NULL THEN
    IF NEW.marks_obtained > v_max_marks THEN
      RAISE EXCEPTION 'marks_obtained % exceeds exam max_marks %', NEW.marks_obtained, v_max_marks USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Derive is_passing
  IF NEW.status = 'ABSENT' THEN
    NEW.is_passing := false;
  ELSIF NEW.marks_obtained IS NOT NULL THEN
    NEW.is_passing := (NEW.marks_obtained >= v_pass_marks);
  ELSE
    NEW.is_passing := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_exam_schedules_guard
  BEFORE INSERT OR UPDATE ON app.exam_schedules
  FOR EACH ROW EXECUTE FUNCTION app.exam_schedules_guard();

CREATE TRIGGER trg_exam_marks_guard
  BEFORE INSERT OR UPDATE ON app.exam_marks
  FOR EACH ROW EXECUTE FUNCTION app.exam_marks_guard();

CREATE TRIGGER examinations_immutable
  BEFORE UPDATE ON app.examinations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER exam_schedules_immutable
  BEFORE UPDATE ON app.exam_schedules
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER exam_marks_immutable
  BEFORE UPDATE ON app.exam_marks
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER examinations_touch
  BEFORE UPDATE ON app.examinations
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER exam_schedules_touch
  BEFORE UPDATE ON app.exam_schedules
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER exam_marks_touch
  BEFORE UPDATE ON app.exam_marks
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ---------------------------------------------------------------------------------------------
-- 5. Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.examinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.examinations FORCE ROW LEVEL SECURITY;

CREATE POLICY examinations_tenant_select ON app.examinations AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY examinations_tenant_insert ON app.examinations AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY examinations_tenant_update ON app.examinations AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

ALTER TABLE app.exam_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exam_schedules FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_schedules_tenant_select ON app.exam_schedules AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_schedules_tenant_insert ON app.exam_schedules AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_schedules_tenant_update ON app.exam_schedules AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY exam_schedules_student_visibility ON app.exam_schedules AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF' OR (app.current_actor_kind() = 'STUDENT' AND status = 'PUBLISHED'))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

ALTER TABLE app.exam_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exam_marks FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_marks_tenant_select ON app.exam_marks AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_marks_tenant_insert ON app.exam_marks AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_marks_tenant_update ON app.exam_marks AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY exam_marks_student_self ON app.exam_marks AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())
             AND EXISTS (SELECT 1 FROM app.exam_schedules es
                          WHERE es.organization_id = exam_marks.organization_id
                            AND es.id = exam_marks.exam_schedule_id
                            AND es.status = 'PUBLISHED')))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.examinations, app.exam_schedules, app.exam_marks TO app_runtime;
GRANT UPDATE (name, exam_type, status, starts_on, ends_on, description, version, updated_at) ON app.examinations TO app_runtime;
GRANT UPDATE (exam_date, start_time, end_time, max_marks, pass_marks, status, marks_submitted_at, marks_submitted_by_user_id, published_at, published_by_user_id, version, updated_at) ON app.exam_schedules TO app_runtime;
GRANT UPDATE (marks_obtained, status, is_passing, remarks, marked_by_user_id, marked_at, version, updated_at) ON app.exam_marks TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 6. Permissions & Role Grants
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('exam.manage', 'SENSITIVE'),
  ('exam.marks.enter', 'SENSITIVE'),
  ('result.publish', 'CRITICAL'),
  ('result.read', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.perm, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      ('COLLEGE_ADMIN', 'exam.manage', 'GRANTED'),
      ('COLLEGE_ADMIN', 'exam.marks.enter', 'GRANTED'),
      ('COLLEGE_ADMIN', 'result.publish', 'GRANTED'),
      ('COLLEGE_ADMIN', 'result.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'exam.manage', 'GRANTED'),
      ('CAMPUS_ADMIN', 'exam.marks.enter', 'GRANTED'),
      ('CAMPUS_ADMIN', 'result.publish', 'GRANTED'),
      ('CAMPUS_ADMIN', 'result.read', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'exam.manage', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'exam.marks.enter', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'result.publish', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'result.read', 'GRANTED'),
      ('HOD', 'exam.manage', 'GRANTED'),
      ('HOD', 'exam.marks.enter', 'GRANTED'),
      ('HOD', 'result.publish', 'GRANTED'),
      ('HOD', 'result.read', 'GRANTED'),
      ('REGISTRAR', 'exam.manage', 'GRANTED'),
      ('REGISTRAR', 'result.publish', 'GRANTED'),
      ('REGISTRAR', 'result.read', 'GRANTED'),
      ('FACULTY', 'exam.marks.enter', 'ASSIGNED'),
      ('FACULTY', 'result.read', 'ASSIGNED'),
      ('STUDENT', 'result.read', 'SELF')
  ) AS p(role_code, perm, mode)
 WHERE r.code = p.role_code
ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = EXCLUDED.scope_mode;

