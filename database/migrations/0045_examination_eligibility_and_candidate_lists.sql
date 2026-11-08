-- 0045_examination_eligibility_and_candidate_lists
-- Owner: app_migrator
-- Pilot V1: Track A Core ERP - Examination Eligibility & Automatic Candidate Lists (Slice 2).
-- Specification: docs/architecture/v3/47 (Task 4/Slice 2), prompt requirements.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.exam_eligibility_policies
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.exam_eligibility_policies (
  id                          app.uuid_v7 PRIMARY KEY,
  organization_id             app.uuid_v7 NOT NULL,
  campus_id                   app.uuid_v7,
  examination_id              app.uuid_v7,
  exam_schedule_id            app.uuid_v7,
  name                        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  min_attendance_percentage   numeric(5,2) NOT NULL DEFAULT 75.00 CHECK (min_attendance_percentage >= 0 AND min_attendance_percentage <= 100),
  check_attendance            boolean     NOT NULL DEFAULT true,
  check_fees                  boolean     NOT NULL DEFAULT false,
  attendance_cutoff_days_prior integer    NOT NULL DEFAULT 0 CHECK (attendance_cutoff_days_prior >= 0),
  allow_late_enrolment_review boolean     NOT NULL DEFAULT true,
  version                     integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_id          app.uuid_v7 NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_eligibility_policies_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT exam_eligibility_policies_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_eligibility_policies_exam_fk FOREIGN KEY (organization_id, examination_id)
    REFERENCES app.examinations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT exam_eligibility_policies_sched_fk FOREIGN KEY (organization_id, exam_schedule_id)
    REFERENCES app.exam_schedules (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT exam_eligibility_policies_created_by_fk FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_eligibility_policies_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX exam_eligibility_policies_org_campus_ix ON app.exam_eligibility_policies (organization_id, campus_id);
CREATE INDEX exam_eligibility_policies_org_exam_ix ON app.exam_eligibility_policies (organization_id, examination_id);
CREATE INDEX exam_eligibility_policies_org_sched_ix ON app.exam_eligibility_policies (organization_id, exam_schedule_id);
CREATE INDEX exam_eligibility_policies_org_created_by_ix ON app.exam_eligibility_policies (organization_id, created_by_user_id);

CREATE UNIQUE INDEX exam_eligibility_policies_sched_uq ON app.exam_eligibility_policies (organization_id, exam_schedule_id)
  WHERE exam_schedule_id IS NOT NULL;
CREATE UNIQUE INDEX exam_eligibility_policies_exam_uq ON app.exam_eligibility_policies (organization_id, examination_id)
  WHERE examination_id IS NOT NULL AND exam_schedule_id IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. app.exam_candidate_lists
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.exam_candidate_lists (
  id                   app.uuid_v7 PRIMARY KEY,
  organization_id      app.uuid_v7 NOT NULL,
  exam_schedule_id     app.uuid_v7 NOT NULL,
  policy_id            app.uuid_v7,
  policy_version       integer     NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  snapshot_version     integer     NOT NULL DEFAULT 1 CHECK (snapshot_version > 0),
  status               text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'FROZEN')),
  evidence_cutoff_date date        NOT NULL,
  total_candidates     integer     NOT NULL DEFAULT 0 CHECK (total_candidates >= 0),
  eligible_count       integer     NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  not_eligible_count   integer     NOT NULL DEFAULT 0 CHECK (not_eligible_count >= 0),
  needs_review_count   integer     NOT NULL DEFAULT 0 CHECK (needs_review_count >= 0),
  policy_snapshot      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  generated_at         timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id app.uuid_v7 NOT NULL,
  approved_at          timestamptz,
  approved_by_user_id  app.uuid_v7,
  version              integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_candidate_lists_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidate_lists_sched_fk FOREIGN KEY (organization_id, exam_schedule_id)
    REFERENCES app.exam_schedules (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT exam_candidate_lists_policy_fk FOREIGN KEY (organization_id, policy_id)
    REFERENCES app.exam_eligibility_policies (organization_id, id) ON DELETE SET NULL,
  CONSTRAINT exam_candidate_lists_gen_by_fk FOREIGN KEY (organization_id, generated_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidate_lists_app_by_fk FOREIGN KEY (organization_id, approved_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidate_lists_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT exam_candidate_lists_sched_ver_uq UNIQUE (organization_id, exam_schedule_id, snapshot_version)
);

CREATE INDEX exam_candidate_lists_org_sched_ix ON app.exam_candidate_lists (organization_id, exam_schedule_id);
CREATE INDEX exam_candidate_lists_org_policy_ix ON app.exam_candidate_lists (organization_id, policy_id);
CREATE INDEX exam_candidate_lists_org_gen_by_ix ON app.exam_candidate_lists (organization_id, generated_by_user_id);
CREATE INDEX exam_candidate_lists_org_app_by_ix ON app.exam_candidate_lists (organization_id, approved_by_user_id);
CREATE INDEX exam_candidate_lists_org_status_ix ON app.exam_candidate_lists (organization_id, status);

-- ---------------------------------------------------------------------------------------------
-- 3. app.exam_candidates
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.exam_candidates (
  id                     app.uuid_v7 PRIMARY KEY,
  organization_id        app.uuid_v7 NOT NULL,
  candidate_list_id      app.uuid_v7 NOT NULL,
  student_id             app.uuid_v7 NOT NULL,
  evaluation_status      text        NOT NULL CHECK (evaluation_status IN ('ELIGIBLE', 'NOT_ELIGIBLE', 'NEEDS_REVIEW')),
  override_status        text        NOT NULL DEFAULT 'NONE' CHECK (override_status IN ('NONE', 'EXEMPTED', 'CONDITIONAL_APPROVAL', 'DISQUALIFIED')),
  final_status           text        NOT NULL CHECK (final_status IN ('ELIGIBLE', 'NOT_ELIGIBLE')),
  reasons                text[]      NOT NULL DEFAULT '{}',
  evidence_summary       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  override_reason        text        CHECK (override_status = 'NONE' OR (override_reason IS NOT NULL AND char_length(override_reason) >= 3)),
  overridden_by_user_id  app.uuid_v7,
  overridden_at          timestamptz,
  version                integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_candidates_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidates_list_fk FOREIGN KEY (organization_id, candidate_list_id)
    REFERENCES app.exam_candidate_lists (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT exam_candidates_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidates_overridden_by_fk FOREIGN KEY (organization_id, overridden_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT exam_candidates_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT exam_candidates_list_student_uq UNIQUE (organization_id, candidate_list_id, student_id)
);

CREATE INDEX exam_candidates_org_list_ix ON app.exam_candidates (organization_id, candidate_list_id);
CREATE INDEX exam_candidates_org_student_ix ON app.exam_candidates (organization_id, student_id);
CREATE INDEX exam_candidates_org_overridden_by_ix ON app.exam_candidates (organization_id, overridden_by_user_id);
CREATE INDEX exam_candidates_org_final_status_ix ON app.exam_candidates (organization_id, final_status);

-- ---------------------------------------------------------------------------------------------
-- 4. Triggers & Guards
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_exam_eligibility_policies_immutable
  BEFORE UPDATE ON app.exam_eligibility_policies
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER trg_exam_candidate_lists_immutable
  BEFORE UPDATE ON app.exam_candidate_lists
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER trg_exam_candidates_immutable
  BEFORE UPDATE ON app.exam_candidates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER exam_eligibility_policies_touch
  BEFORE UPDATE ON app.exam_eligibility_policies
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER exam_candidate_lists_touch
  BEFORE UPDATE ON app.exam_candidate_lists
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER exam_candidates_touch
  BEFORE UPDATE ON app.exam_candidates
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- Guard: Candidate modification prohibited when candidate list is FROZEN
CREATE FUNCTION app.exam_candidates_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_list_status text;
BEGIN
  SELECT status INTO v_list_status
    FROM app.exam_candidate_lists
   WHERE organization_id = NEW.organization_id AND id = NEW.candidate_list_id;

  IF v_list_status = 'FROZEN' THEN
    RAISE EXCEPTION 'cannot modify candidate evaluations on a frozen candidate list' USING ERRCODE = 'check_violation';
  END IF;

  -- Compute final_status
  IF NEW.override_status = 'EXEMPTED' OR NEW.override_status = 'CONDITIONAL_APPROVAL' THEN
    NEW.final_status := 'ELIGIBLE';
  ELSIF NEW.override_status = 'DISQUALIFIED' THEN
    NEW.final_status := 'NOT_ELIGIBLE';
  ELSE
    IF NEW.evaluation_status = 'ELIGIBLE' THEN
      NEW.final_status := 'ELIGIBLE';
    ELSE
      NEW.final_status := 'NOT_ELIGIBLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_exam_candidates_guard
  BEFORE INSERT OR UPDATE ON app.exam_candidates
  FOR EACH ROW EXECUTE FUNCTION app.exam_candidates_guard();

-- Update exam_marks_guard to enforce candidate eligibility when an approved list exists
CREATE OR REPLACE FUNCTION app.exam_marks_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_max_marks numeric(6,2);
  v_pass_marks numeric(6,2);
  v_sched_status text;
  v_has_approved_list boolean;
  v_is_eligible boolean;
BEGIN
  SELECT max_marks, pass_marks, status INTO v_max_marks, v_pass_marks, v_sched_status
    FROM app.exam_schedules
   WHERE organization_id = NEW.organization_id AND id = NEW.exam_schedule_id;
  IF v_max_marks IS NULL THEN
    RAISE EXCEPTION 'exam schedule not found in organization' USING ERRCODE = 'check_violation';
  END IF;

  -- Disallow modifying marks once schedule is published or cancelled
  IF v_sched_status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'cannot modify marks for published examination schedule' USING ERRCODE = 'check_violation';
  END IF;
  IF v_sched_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cannot modify marks for cancelled examination schedule' USING ERRCODE = 'check_violation';
  END IF;

  -- Validate marks boundary against schedule max_marks
  IF NEW.marks_obtained IS NOT NULL THEN
    IF NEW.marks_obtained > v_max_marks THEN
      RAISE EXCEPTION 'marks_obtained % exceeds exam max_marks %', NEW.marks_obtained, v_max_marks USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- If an approved candidate list exists for this schedule, verify student is an approved eligible candidate
  SELECT EXISTS (
    SELECT 1 FROM app.exam_candidate_lists
     WHERE organization_id = NEW.organization_id
       AND exam_schedule_id = NEW.exam_schedule_id
       AND status IN ('APPROVED', 'FROZEN')
  ) INTO v_has_approved_list;

  IF v_has_approved_list THEN
    SELECT EXISTS (
      SELECT 1 FROM app.exam_candidate_lists cl
        JOIN app.exam_candidates c ON c.organization_id = cl.organization_id AND c.candidate_list_id = cl.id
       WHERE cl.organization_id = NEW.organization_id
         AND cl.exam_schedule_id = NEW.exam_schedule_id
         AND cl.status IN ('APPROVED', 'FROZEN')
         AND c.student_id = NEW.student_id
         AND c.final_status = 'ELIGIBLE'
    ) INTO v_is_eligible;

    IF NOT v_is_eligible THEN
      RAISE EXCEPTION 'student % is not an approved eligible candidate for this examination schedule', NEW.student_id USING ERRCODE = 'check_violation';
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

-- ---------------------------------------------------------------------------------------------
-- 5. Row-Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.exam_eligibility_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exam_eligibility_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_eligibility_policies_tenant_select ON app.exam_eligibility_policies AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_eligibility_policies_tenant_insert ON app.exam_eligibility_policies AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_eligibility_policies_tenant_update ON app.exam_eligibility_policies AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

ALTER TABLE app.exam_candidate_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exam_candidate_lists FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_candidate_lists_tenant_select ON app.exam_candidate_lists AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_candidate_lists_tenant_insert ON app.exam_candidate_lists AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_candidate_lists_tenant_update ON app.exam_candidate_lists AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

ALTER TABLE app.exam_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exam_candidates FORCE ROW LEVEL SECURITY;

CREATE POLICY exam_candidates_tenant_select ON app.exam_candidates AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_candidates_tenant_insert ON app.exam_candidates AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY exam_candidates_tenant_update ON app.exam_candidates AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY exam_candidates_student_self ON app.exam_candidates AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

DROP POLICY IF EXISTS exam_schedules_student_visibility ON app.exam_schedules;
CREATE POLICY exam_schedules_student_visibility ON app.exam_schedules AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF' OR app.current_actor_kind() = 'STUDENT')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.exam_eligibility_policies, app.exam_candidate_lists, app.exam_candidates TO app_runtime;
GRANT UPDATE (name, min_attendance_percentage, check_attendance, check_fees, attendance_cutoff_days_prior, allow_late_enrolment_review, version, updated_at) ON app.exam_eligibility_policies TO app_runtime;
GRANT UPDATE (status, total_candidates, eligible_count, not_eligible_count, needs_review_count, policy_snapshot, approved_at, approved_by_user_id, version, updated_at) ON app.exam_candidate_lists TO app_runtime;
GRANT UPDATE (evaluation_status, override_status, final_status, reasons, evidence_summary, override_reason, overridden_by_user_id, overridden_at, version, updated_at) ON app.exam_candidates TO app_runtime;
