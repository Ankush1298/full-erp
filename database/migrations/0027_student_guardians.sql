-- 0027_student_guardians
-- Owner: app_migrator
-- Milestone 1 / Phase 1D: guardian identity (app.guardians) and the student-guardian link (app.student_guardians,
-- which already exists since 0002 as a denormalised contact table).
-- Specification: docs/architecture/v3/02 §4.4 (guardians, student_guardians), 06 §6 (minors and guardians: access is
--                COMPUTED, never stored), 10 §1 rows 30-31, 11 §5.4 line 162, ADR-020 (minors, data minimisation).
--
-- Contents:
--  * permissions student.guardian.read / student.guardian.manage (doc 10 rows 30-31; catalog.ts and role-matrix.ts
--    carry the same rows, and permission-seed.test.ts requires platform.permissions to equal the catalog).
--  * app.guardians: tenant-scoped guardian identity (name, one phone, optional e-mail). Soft delete only (doc 02 §1).
--  * app.student_guardians gains the link attributes ADR-020 names ("consent / visibility / notification flags"):
--    can_give_consent, can_view_academics, can_receive_notifications, plus the link lifecycle valid_from / valid_to
--    (doc 06 §6: "the link is active") and the reference guardian_id.
--  * link rows are END-DATED (valid_to), never deleted: the runtime role keeps its 0003 DELETE grant, but a restrictive
--    policy now refuses DELETE of any row that carries a guardian_id.
--
-- DELIBERATELY NOT HERE (recorded, not silently resolved):
--  * is_emergency_contact and is_legal_guardian (doc 02 §4.4 lists them; ADR-020 does not mention either). Adding a
--    boolean NOT NULL DEFAULT false later is a cheap additive migration; removing one is not. Needs an owner decision.
--  * guardians.user_id (guardian login is post-pilot, doc 11 R-7; the GUARDIAN role is not assignable, doc 10 intro).
--    A column nobody may write is not shipped.
--  * Any backfill of pre-0027 student_guardians rows. They have guardian_id NULL ("legacy" rows), keep working exactly as
--    before for raw SQL, and are INVISIBLE to the guardian service. Both tables are FORCE ROW LEVEL SECURITY, so this
--    migration (run as app_migrator, which no policy admits) could neither read nor update them anyway: a backfill here
--    would silently copy zero rows. Read-only preflight, run as a superuser/BYPASSRLS role (zero rows expected on any
--    database that never had guardian rows written by hand):
--        SELECT count(*) FROM app.student_guardians WHERE guardian_id IS NULL;
--    A legacy row that is also is_primary occupies only the LEGACY primary slot (student_guardians_one_primary_uq, now limited
--    to guardian_id IS NULL); a new-shape primary uses its own slot (student_guardians_one_primary_link_uq) and COEXISTS with it.
--  * guardian_id NOT NULL and dropping the legacy full_name / phone / email columns of student_guardians (a later
--    contract migration, after the legacy rows are dealt with; every existing security test still writes legacy rows).
--  * Any automatic resolution of a student whose LEGACY row is primary (guardian_id NULL): the row is kept as it is and a
--    new-shape primary may coexist with it (see the index split below). Whether the legacy contact is migrated into
--    app.guardians, retired, or wins over a new primary is a business decision nobody has taken.
--  * Dates: valid_from / valid_to are written by the service in the campus-local calendar of the student's active
--    enrolment, or the UTC calendar when the student has none (there is no tenant timezone). The column default is the UTC
--    date, never the session's CURRENT_DATE.
--  * A vocabulary for student_guardians.relation: no approved vocabulary exists in the repository (0002 left it free text,
--    1-50 characters). The application validates the shape only.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0027 runs only after 0019 (and 0020-0026) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).
-- Forward-only; nothing here is applied to any persistent database by this change.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (doc 10 rows 30-31; both SENSITIVE). Granted to roles by seedTenantRoles.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.guardian.read', 'SENSITIVE'),
  ('student.guardian.manage', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.guardians
-- ---------------------------------------------------------------------------------------------
-- Data minimisation (doc 02 §4.4): a name and ONE phone are the required minimum, the e-mail is optional.
CREATE TABLE app.guardians (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  full_name        text        NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  phone            text        NOT NULL CHECK (char_length(phone) BETWEEN 5 AND 30),
  email            text        CHECK (email IS NULL OR (email = lower(email) AND char_length(email) <= 320)),
  deleted_at       timestamptz,
  version          integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guardians_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- target of the composite foreign key of student_guardians: a link can only reference a guardian of ITS OWN tenant
  CONSTRAINT guardians_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER guardians_touch     BEFORE UPDATE ON app.guardians FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER guardians_immutable BEFORE UPDATE ON app.guardians FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.guardians FORCE  ROW LEVEL SECURITY;

CREATE POLICY guardians_tenant_select ON app.guardians AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY guardians_tenant_insert ON app.guardians AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY guardians_tenant_update ON app.guardians AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Least privilege: only the contact facts and the soft-delete marker can change. No DELETE.
GRANT SELECT, INSERT ON app.guardians TO app_runtime;
GRANT UPDATE (full_name, phone, email, deleted_at) ON app.guardians TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.student_guardians: link attributes (additive; existing rows and writers keep working)
-- ---------------------------------------------------------------------------------------------
-- Legacy rows (guardian_id NULL) carry their own contact columns; rows in the new shape carry NONE (the identity lives
-- in app.guardians, so contact data is stored once). full_name / phone therefore stop being unconditionally NOT NULL;
-- the two CHECKs below keep each shape exactly as strict as before.
ALTER TABLE app.student_guardians
  ALTER COLUMN full_name DROP NOT NULL,
  ALTER COLUMN phone     DROP NOT NULL,
  ADD COLUMN guardian_id                app.uuid_v7,
  ADD COLUMN can_give_consent           boolean NOT NULL DEFAULT false,
  ADD COLUMN can_view_academics         boolean NOT NULL DEFAULT false,
  ADD COLUMN can_receive_notifications  boolean NOT NULL DEFAULT false,
  ADD COLUMN valid_from                 date    NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  ADD COLUMN valid_to                   date;

ALTER TABLE app.student_guardians
  -- tenant-safe reference (MATCH SIMPLE: not checked while guardian_id is NULL): a cross-tenant link cannot exist
  ADD CONSTRAINT student_guardians_guardian_fk FOREIGN KEY (organization_id, guardian_id)
    REFERENCES app.guardians (organization_id, id) ON DELETE RESTRICT,
  -- doc 02 §4.4 UQ(student_id, guardian_id), tenant-prefixed like every other key
  ADD CONSTRAINT student_guardians_org_student_guardian_uq UNIQUE (organization_id, student_id, guardian_id),
  ADD CONSTRAINT student_guardians_dates_ck
    CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31' AND (valid_to IS NULL OR valid_to >= valid_from)),
  -- the new-shape primary slot (student_guardians_one_primary_link_uq, below) must be free again once a link has ended
  ADD CONSTRAINT student_guardians_ended_not_primary_ck CHECK (valid_to IS NULL OR NOT is_primary),
  ADD CONSTRAINT student_guardians_legacy_contact_ck CHECK (guardian_id IS NOT NULL OR (full_name IS NOT NULL AND phone IS NOT NULL)),
  ADD CONSTRAINT student_guardians_no_copied_contact_ck CHECK (guardian_id IS NULL OR (full_name IS NULL AND phone IS NULL AND email IS NULL));

-- The single primary slot. The 0002 index (student_guardians_one_primary_uq, UNIQUE (student_id) WHERE is_primary) also
-- covered LEGACY rows, which the guardian API can neither see nor change: a student with a legacy primary row could never
-- get a primary guardian, and nobody could fix that through the API. It is replaced by two partial indexes, so each kind of
-- row keeps exactly its own rule: legacy rows keep the old rule (same index name, same columns, now limited to legacy rows)
-- and new-shape rows get their own slot. A legacy primary row is neither deleted nor demoted and COEXISTS with a new-shape
-- primary; which of the two a downstream reader should treat as "the" primary is an open owner decision (see above).
DROP INDEX app.student_guardians_one_primary_uq;
CREATE UNIQUE INDEX student_guardians_one_primary_uq
  ON app.student_guardians (student_id) WHERE is_primary AND guardian_id IS NULL;
CREATE UNIQUE INDEX student_guardians_one_primary_link_uq
  ON app.student_guardians (organization_id, student_id) WHERE is_primary AND guardian_id IS NOT NULL;

-- FK-backing index (schema-linter S-2); (organization_id, student_id[, guardian_id]) is backed by the keys above.
CREATE INDEX student_guardians_org_guardian_ix ON app.student_guardians (organization_id, guardian_id);

-- Row guard (invoker, volatile, pinned search_path; same family as student_programs_guard). Legacy rows keep their old
-- behaviour but can never be converted into the new shape. A new-shape row never changes its student, guardian or start
-- date, and an ended row is terminal (no reactivation, no flag edits after the end).
CREATE FUNCTION app.student_guardians_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.guardian_id IS NULL THEN
    IF NEW.guardian_id IS NOT NULL THEN
      RAISE EXCEPTION 'a legacy student guardian row cannot be converted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
    RAISE EXCEPTION 'student guardian link identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.valid_to IS NOT NULL THEN
    RAISE EXCEPTION 'an ended student guardian link is terminal' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER student_guardians_guard BEFORE UPDATE ON app.student_guardians
  FOR EACH ROW EXECUTE FUNCTION app.student_guardians_guard();

-- Consent and visibility flags are staff decisions: a STUDENT session (which 0003 lets touch its own legacy rows) can
-- neither create nor change a new-shape link, and nobody can hard-delete one (links are end-dated). Restrictive, so they
-- AND with the existing tenant and student_self policies; a student still READS their own links.
CREATE POLICY student_guardians_link_insert ON app.student_guardians AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (guardian_id IS NULL OR app.current_actor_kind() = 'STAFF');
CREATE POLICY student_guardians_link_update ON app.student_guardians AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (guardian_id IS NULL OR app.current_actor_kind() = 'STAFF')
  WITH CHECK (guardian_id IS NULL OR app.current_actor_kind() = 'STAFF');
CREATE POLICY student_guardians_link_no_delete ON app.student_guardians AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (guardian_id IS NULL);

-- Created here, after step 3, because it reads student_guardians.guardian_id.
-- STAFF read and write every guardian of the tenant (WHICH student's guardians a staff member may touch is decided by
-- the application's authorization engine, which the database cannot see). A STUDENT reads only guardians with an
-- ACTIVE link to their OWN student record (the subqueries run under the student_guardians and students policies) and
-- can never write: the WITH CHECK admits STAFF only. Any other actor kind sees nothing. Same shape as 0021.
CREATE POLICY guardians_actor_access ON app.guardians AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND id IN (SELECT sg.guardian_id FROM app.student_guardians AS sg
                         WHERE sg.valid_to IS NULL
                           AND sg.student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id()))))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- The 0003 column grants stay. Only the columns this migration added need granting (guardian_id and valid_from are set at
-- INSERT only; INSERT is table-wide since 0003).
GRANT UPDATE (can_give_consent, can_view_academics, can_receive_notifications, valid_to)
  ON app.student_guardians TO app_runtime;
