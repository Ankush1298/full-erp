-- 0042_attendance_policies_approval_lock
-- Owner: app_migrator
-- Milestone 4 (Attendance), Slice 4. Authorised on synthetic data by the owner amendment of 2026-11-05 (docs 39 §14, 40 §7);
-- policies AD-1 to AD-9 approved by the product owner on 2026-11-07 (doc 43 §0).
-- Specification: docs/architecture/v3/02 §4.7 (attendance_policies fields edit_window_days, correction_requires_approval;
--                revision columns approved_by_user_id), 03 (audit tiers), 43 §0, 41 §12.
--
-- Contents:
--  1. app.attendance_policies                - edit window and approval flag; READ-ONLY for the runtime role (no write API exists)
--  2. app.attendance_correction_requests     - a correction outside the faculty window, awaiting an independent approver
--  3. app.attendance_record_revisions        - approved_by_user_id, correction_request_id (nullable; append-only is unchanged)
--  4. app.class_sessions                     - locked_by_user_id, lock_reason
--  5. platform.permissions                   - attendance.correction.approve, attendance.session.lock, attendance.session.cancel
--
-- Role grants (role_permissions) are NOT written here: like 0037-0041 they come from the tenant role seed (role-matrix.ts).
-- Production re-seeding is a separate, unauthorised operation.
--
-- No policy row is seeded: with no row the service uses the approved Pilot V1 defaults (3 calendar days, approval required).
-- ROLLOUT: not a *_contract migration; new tables plus nullable columns only.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.attendance_policies (organisation default, optionally one row per campus)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.attendance_policies (
  id                          app.uuid_v7 PRIMARY KEY,
  organization_id             app.uuid_v7 NOT NULL,
  campus_id                   app.uuid_v7,
  edit_window_days            integer     NOT NULL DEFAULT 3 CHECK (edit_window_days BETWEEN 0 AND 30),
  -- AD-4: a correction outside the window needs independent approval. Pilot V1 does not allow switching this off.
  correction_requires_approval boolean    NOT NULL DEFAULT true CHECK (correction_requires_approval),
  version                     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_policies_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT attendance_policies_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_policies_org_id_uq UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX attendance_policies_scope_uq
  ON app.attendance_policies (organization_id, COALESCE(campus_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX attendance_policies_campus_ix ON app.attendance_policies (organization_id, campus_id) WHERE campus_id IS NOT NULL;

ALTER TABLE app.attendance_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_policies FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_policies_tenant_select ON app.attendance_policies AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_policies_staff_only ON app.attendance_policies AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (false);
CREATE TRIGGER attendance_policies_touch BEFORE UPDATE ON app.attendance_policies FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER attendance_policies_no_delete BEFORE DELETE ON app.attendance_policies FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();
GRANT SELECT ON app.attendance_policies TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 2. app.attendance_correction_requests (the decision is written once and never changes)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.attendance_correction_requests (
  id                   app.uuid_v7 PRIMARY KEY,
  organization_id      app.uuid_v7 NOT NULL,
  attendance_record_id app.uuid_v7 NOT NULL,
  class_session_id     app.uuid_v7 NOT NULL,
  student_id           app.uuid_v7 NOT NULL,
  status_before        text        NOT NULL CHECK (status_before IN ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED')),
  requested_status     text        NOT NULL CHECK (requested_status IN ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED')),
  expected_revision_no integer     NOT NULL CHECK (expected_revision_no > 0),
  reason_code          varchar(40) NOT NULL CHECK (reason_code IN
    ('FACULTY_ERROR', 'STUDENT_DISPUTE', 'MEDICAL', 'DUTY_LEAVE', 'OTHER')),
  reason_text          text        CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 1 AND 500),
  status               text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by_user_id app.uuid_v7 NOT NULL,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  decided_by_user_id   app.uuid_v7,
  decided_at           timestamptz,
  decision_note        text        CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
  applied_revision_no  integer     CHECK (applied_revision_no IS NULL OR applied_revision_no > 1),
  CONSTRAINT attendance_corr_req_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_record_fk FOREIGN KEY (organization_id, attendance_record_id)
    REFERENCES app.attendance_records (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_session_fk FOREIGN KEY (organization_id, class_session_id)
    REFERENCES app.class_sessions (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_requester_fk FOREIGN KEY (organization_id, requested_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_decider_fk FOREIGN KEY (organization_id, decided_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_corr_req_differs_ck CHECK (requested_status <> status_before),
  -- AD-4: no self-approval, enforced by the database for every writer
  CONSTRAINT attendance_corr_req_no_self_ck CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id),
  CONSTRAINT attendance_corr_req_decision_ck CHECK (
    (status = 'PENDING' AND decided_by_user_id IS NULL AND decided_at IS NULL AND decision_note IS NULL AND applied_revision_no IS NULL)
    OR (status = 'APPROVED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND applied_revision_no IS NOT NULL)
    OR (status = 'REJECTED' AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL
        AND applied_revision_no IS NULL)),
  CONSTRAINT attendance_corr_req_org_id_uq UNIQUE (organization_id, id)
);
-- one open request per record
CREATE UNIQUE INDEX attendance_corr_req_one_pending_uq ON app.attendance_correction_requests (organization_id, attendance_record_id)
  WHERE status = 'PENDING';
CREATE INDEX attendance_corr_req_record_ix ON app.attendance_correction_requests (organization_id, attendance_record_id);
CREATE INDEX attendance_corr_req_session_ix ON app.attendance_correction_requests (organization_id, class_session_id);
CREATE INDEX attendance_corr_req_student_ix ON app.attendance_correction_requests (organization_id, student_id);
CREATE INDEX attendance_corr_req_requester_ix ON app.attendance_correction_requests (organization_id, requested_by_user_id);
CREATE INDEX attendance_corr_req_decider_ix ON app.attendance_correction_requests (organization_id, decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;

CREATE FUNCTION app.attendance_corr_req_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'a decided correction request is immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.attendance_record_id IS DISTINCT FROM OLD.attendance_record_id OR NEW.class_session_id IS DISTINCT FROM OLD.class_session_id
       OR NEW.student_id IS DISTINCT FROM OLD.student_id OR NEW.status_before IS DISTINCT FROM OLD.status_before
       OR NEW.requested_status IS DISTINCT FROM OLD.requested_status OR NEW.expected_revision_no IS DISTINCT FROM OLD.expected_revision_no
       OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.reason_text IS DISTINCT FROM OLD.reason_text
       OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
      RAISE EXCEPTION 'a correction request can only be decided, not edited' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a correction request starts PENDING' USING ERRCODE = 'check_violation';
  END IF;
  -- the request must describe the record as it stands, in this tenant
  IF NOT EXISTS (
       SELECT 1 FROM app.attendance_records r
        WHERE r.organization_id = NEW.organization_id AND r.id = NEW.attendance_record_id
          AND r.class_session_id = NEW.class_session_id AND r.student_id = NEW.student_id
          AND r.status = NEW.status_before AND r.revision_no = NEW.expected_revision_no) THEN
    RAISE EXCEPTION 'correction request does not match the current record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.attendance_corr_req_guard() FROM PUBLIC;
CREATE TRIGGER attendance_corr_req_guard_iu BEFORE INSERT OR UPDATE ON app.attendance_correction_requests
  FOR EACH ROW EXECUTE FUNCTION app.attendance_corr_req_guard();
CREATE TRIGGER attendance_corr_req_no_delete BEFORE DELETE ON app.attendance_correction_requests
  FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

ALTER TABLE app.attendance_correction_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attendance_correction_requests FORCE  ROW LEVEL SECURITY;
CREATE POLICY attendance_corr_req_tenant_select ON app.attendance_correction_requests AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_corr_req_tenant_insert ON app.attendance_correction_requests AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY attendance_corr_req_tenant_update ON app.attendance_correction_requests AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
-- Student-bearing and staff-internal: a STUDENT never reads or writes a correction request.
CREATE POLICY attendance_corr_req_staff_only ON app.attendance_correction_requests AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');
GRANT SELECT, INSERT ON app.attendance_correction_requests TO app_runtime;
GRANT UPDATE (status, decided_by_user_id, decided_at, decision_note, applied_revision_no)
  ON app.attendance_correction_requests TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. Revisions: who approved, and which request. Existing rows keep NULL. Append-only triggers are untouched.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.attendance_record_revisions
  ADD COLUMN approved_by_user_id   app.uuid_v7,
  ADD COLUMN correction_request_id app.uuid_v7,
  ADD CONSTRAINT attendance_revisions_approver_fk FOREIGN KEY (organization_id, approved_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT attendance_revisions_request_fk FOREIGN KEY (organization_id, correction_request_id)
    REFERENCES app.attendance_correction_requests (organization_id, id) ON DELETE RESTRICT,
  -- AD-4: the approver is never the person who made the change; an approved revision names both approver and request
  ADD CONSTRAINT attendance_revisions_no_self_approval_ck CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> changed_by_user_id),
  ADD CONSTRAINT attendance_revisions_approval_pair_ck CHECK ((approved_by_user_id IS NULL) = (correction_request_id IS NULL));
CREATE INDEX attendance_revisions_approver_ix ON app.attendance_record_revisions (organization_id, approved_by_user_id)
  WHERE approved_by_user_id IS NOT NULL;
CREATE INDEX attendance_revisions_request_ix ON app.attendance_record_revisions (organization_id, correction_request_id)
  WHERE correction_request_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. Sessions: who locked and why (term-lock cascade leaves locked_by_user_id NULL and says so in lock_reason)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.class_sessions
  ADD COLUMN locked_by_user_id app.uuid_v7,
  ADD COLUMN lock_reason       text CHECK (lock_reason IS NULL OR char_length(lock_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT class_sessions_locked_by_fk FOREIGN KEY (organization_id, locked_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT class_sessions_lock_facts_ck CHECK (attendance_state = 'LOCKED' OR (locked_by_user_id IS NULL AND lock_reason IS NULL));
CREATE INDEX class_sessions_org_locked_by_ix ON app.class_sessions (organization_id, locked_by_user_id)
  WHERE locked_by_user_id IS NOT NULL;
GRANT UPDATE (locked_by_user_id, lock_reason) ON app.class_sessions TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 5. Permissions (grants to roles come from the tenant role seed, see the header)
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('attendance.correction.approve', 'SENSITIVE'),
  ('attendance.session.lock', 'CRITICAL'),
  ('attendance.session.cancel', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
