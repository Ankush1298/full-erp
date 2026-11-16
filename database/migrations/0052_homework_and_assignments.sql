-- 0052_homework_and_assignments.sql
-- Owner: app_migrator
-- Core Teaching & Student Workflow: Homework, Assignments and Secure Student Submissions
--
-- Supports:
--  * app.homework_assignments       - homework created by authorized faculty for a course offering and section
--  * app.homework_attachments       - teacher-attached worksheets, instructions, and reading materials
--  * app.homework_submissions       - student submission / completion records with evaluation, marks, and feedback
--  * app.homework_submission_files  - student-uploaded files for online submissions

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Platform Permissions
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('homework.manage', 'SENSITIVE'),
  ('homework.review', 'SENSITIVE'),
  ('homework.read', 'NORMAL'),
  ('homework.submit', 'NORMAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.homework_assignments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.homework_assignments (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  course_offering_id      app.uuid_v7 NOT NULL,
  section_id             app.uuid_v7,
  created_by_employee_id  app.uuid_v7 NOT NULL,
  teacher_name            text        NOT NULL DEFAULT 'Teacher',
  title                   text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  instructions            text        NOT NULL,
  submission_type         text        NOT NULL CHECK (submission_type IN ('OFFLINE', 'ONLINE')),
  status                  text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED')),
  due_date                date        CHECK (due_date IS NULL OR due_date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  due_time                time,
  max_marks               numeric(6,2) CHECK (max_marks IS NULL OR (max_marks >= 0 AND max_marks <= 1000)),
  allow_resubmission      boolean     NOT NULL DEFAULT false,
  published_at            timestamptz,
  closed_at               timestamptz,
  version                 integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT homework_assignments_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT homework_assignments_offering_fk FOREIGN KEY (organization_id, course_offering_id)
    REFERENCES app.course_offerings (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_assignments_section_fk FOREIGN KEY (organization_id, section_id)
    REFERENCES app.sections (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_assignments_creator_fk FOREIGN KEY (organization_id, created_by_employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_assignments_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER homework_assignments_touch
  BEFORE UPDATE ON app.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER homework_assignments_immutable
  BEFORE UPDATE ON app.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX homework_assignments_org_offering_ix
  ON app.homework_assignments (organization_id, course_offering_id);
CREATE INDEX homework_assignments_org_section_ix
  ON app.homework_assignments (organization_id, section_id);
CREATE INDEX homework_assignments_org_creator_ix
  ON app.homework_assignments (organization_id, created_by_employee_id);
CREATE INDEX homework_assignments_org_status_ix
  ON app.homework_assignments (organization_id, status);
CREATE INDEX homework_assignments_org_due_date_ix
  ON app.homework_assignments (organization_id, due_date);

ALTER TABLE app.homework_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.homework_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY homework_assignments_tenant_select ON app.homework_assignments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_assignments_tenant_insert ON app.homework_assignments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_assignments_tenant_update ON app.homework_assignments AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

GRANT SELECT, INSERT ON app.homework_assignments TO app_runtime;
GRANT UPDATE (title, instructions, submission_type, status, due_date, due_time, max_marks, allow_resubmission, published_at, closed_at)
  ON app.homework_assignments TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.homework_attachments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.homework_attachments (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  homework_id      app.uuid_v7 NOT NULL,
  file_id          app.uuid_v7 NOT NULL,
  file_name        text        NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_size_bytes  bigint      NOT NULL CHECK (file_size_bytes >= 0),
  mime_type        text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT homework_attachments_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT homework_attachments_hw_fk FOREIGN KEY (organization_id, homework_id)
    REFERENCES app.homework_assignments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_attachments_file_fk FOREIGN KEY (organization_id, file_id)
    REFERENCES app.files (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_attachments_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT homework_attachments_hw_file_uq UNIQUE (organization_id, homework_id, file_id)
);

CREATE TRIGGER homework_attachments_immutable
  BEFORE UPDATE ON app.homework_attachments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX homework_attachments_org_hw_ix
  ON app.homework_attachments (organization_id, homework_id);
CREATE INDEX homework_attachments_org_file_ix
  ON app.homework_attachments (organization_id, file_id);

ALTER TABLE app.homework_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.homework_attachments FORCE ROW LEVEL SECURITY;

CREATE POLICY homework_attachments_tenant_select ON app.homework_attachments AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_attachments_tenant_insert ON app.homework_attachments AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

GRANT SELECT, INSERT ON app.homework_attachments TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 4. app.homework_submissions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.homework_submissions (
  id                          app.uuid_v7 PRIMARY KEY,
  organization_id             app.uuid_v7 NOT NULL,
  homework_id                 app.uuid_v7 NOT NULL,
  student_id                  app.uuid_v7 NOT NULL,
  status                      text        NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'SUBMITTED', 'LATE', 'REVIEWED', 'RESUBMISSION_REQUESTED', 'COMPLETED')),
  submission_text             text,
  submitted_at                timestamptz,
  evaluated_at                timestamptz,
  evaluated_by_employee_id    app.uuid_v7,
  marks_obtained              numeric(6,2) CHECK (marks_obtained IS NULL OR (marks_obtained >= 0 AND marks_obtained <= 1000)),
  grade                       text        CHECK (grade IS NULL OR char_length(grade) BETWEEN 1 AND 20),
  feedback                    text,
  resubmission_allowed        boolean     NOT NULL DEFAULT false,
  resubmission_count          integer     NOT NULL DEFAULT 0 CHECK (resubmission_count >= 0),
  version                     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT homework_submissions_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT homework_submissions_hw_fk FOREIGN KEY (organization_id, homework_id)
    REFERENCES app.homework_assignments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_submissions_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_submissions_evaluator_fk FOREIGN KEY (organization_id, evaluated_by_employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_submissions_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT homework_submissions_hw_student_uq UNIQUE (organization_id, homework_id, student_id)
);

CREATE TRIGGER homework_submissions_touch
  BEFORE UPDATE ON app.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER homework_submissions_immutable
  BEFORE UPDATE ON app.homework_submissions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX homework_submissions_org_hw_ix
  ON app.homework_submissions (organization_id, homework_id);
CREATE INDEX homework_submissions_org_student_ix
  ON app.homework_submissions (organization_id, student_id);
CREATE INDEX homework_submissions_org_evaluator_ix
  ON app.homework_submissions (organization_id, evaluated_by_employee_id);
CREATE INDEX homework_submissions_org_status_ix
  ON app.homework_submissions (organization_id, status);

ALTER TABLE app.homework_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.homework_submissions FORCE ROW LEVEL SECURITY;

CREATE POLICY homework_submissions_tenant_select ON app.homework_submissions AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_submissions_tenant_insert ON app.homework_submissions AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_submissions_tenant_update ON app.homework_submissions AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY homework_submissions_student_self ON app.homework_submissions AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND student_id IN (
             SELECT s.id FROM app.students s WHERE s.organization_id = app.current_tenant_id() AND s.user_id = app.current_user_id()
         )))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND student_id IN (
             SELECT s.id FROM app.students s WHERE s.organization_id = app.current_tenant_id() AND s.user_id = app.current_user_id()
         )));

GRANT SELECT, INSERT ON app.homework_submissions TO app_runtime;
GRANT UPDATE (status, submission_text, submitted_at, evaluated_at, evaluated_by_employee_id, marks_obtained, grade, feedback, resubmission_allowed, resubmission_count)
  ON app.homework_submissions TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 5. app.homework_submission_files
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.homework_submission_files (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  submission_id    app.uuid_v7 NOT NULL,
  file_id          app.uuid_v7 NOT NULL,
  file_name        text        NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
  file_size_bytes  bigint      NOT NULL CHECK (file_size_bytes >= 0),
  mime_type        text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT homework_sub_files_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT homework_sub_files_sub_fk FOREIGN KEY (organization_id, submission_id)
    REFERENCES app.homework_submissions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_sub_files_file_fk FOREIGN KEY (organization_id, file_id)
    REFERENCES app.files (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT homework_sub_files_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT homework_sub_files_sub_file_uq UNIQUE (organization_id, submission_id, file_id)
);

CREATE TRIGGER homework_submission_files_immutable
  BEFORE UPDATE ON app.homework_submission_files
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX homework_sub_files_org_sub_ix
  ON app.homework_submission_files (organization_id, submission_id);
CREATE INDEX homework_sub_files_org_file_ix
  ON app.homework_submission_files (organization_id, file_id);

ALTER TABLE app.homework_submission_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.homework_submission_files FORCE ROW LEVEL SECURITY;

CREATE POLICY homework_sub_files_tenant_select ON app.homework_submission_files AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY homework_sub_files_tenant_insert ON app.homework_submission_files AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY homework_sub_files_student_self ON app.homework_submission_files AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND submission_id IN (
             SELECT sub.id FROM app.homework_submissions sub
               JOIN app.students s ON s.organization_id = sub.organization_id AND s.id = sub.student_id
              WHERE sub.organization_id = app.current_tenant_id() AND s.user_id = app.current_user_id()
         )))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND submission_id IN (
             SELECT sub.id FROM app.homework_submissions sub
               JOIN app.students s ON s.organization_id = sub.organization_id AND s.id = sub.student_id
              WHERE sub.organization_id = app.current_tenant_id() AND s.user_id = app.current_user_id()
         )));

GRANT SELECT, INSERT ON app.homework_submission_files TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 6. Role Permissions Seeding
-- ---------------------------------------------------------------------------------------------
INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.code, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      ('FACULTY', 'homework.manage', 'ASSIGNED'),
      ('FACULTY', 'homework.review', 'ASSIGNED'),
      ('FACULTY', 'homework.read', 'ASSIGNED'),
      ('STUDENT', 'homework.read', 'SELF'),
      ('STUDENT', 'homework.submit', 'SELF'),
      ('HOD', 'homework.manage', 'GRANTED'),
      ('HOD', 'homework.review', 'GRANTED'),
      ('HOD', 'homework.read', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.manage', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.review', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.manage', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.review', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'homework.manage', 'GRANTED'),
      ('COLLEGE_ADMIN', 'homework.review', 'GRANTED'),
      ('COLLEGE_ADMIN', 'homework.read', 'GRANTED'),
      ('REGISTRAR', 'homework.manage', 'GRANTED'),
      ('REGISTRAR', 'homework.review', 'GRANTED'),
      ('REGISTRAR', 'homework.read', 'GRANTED')
  ) AS p(role_code, code, mode)
 WHERE r.code = p.role_code
ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;
