-- 0035_student_identifiers_and_imports
-- Owner: app_migrator
-- Milestone 2 (Organization + People, docs/architecture/v3/04 Part 16), Batch 2: student identifiers and the import
-- framework (validate -> preview -> commit).
-- Specification: docs/architecture/v3/02 §4.4 (student_identifiers) and §4.11 (import_jobs / import_job_rows), 02 §6.1/6.2
--                (identifier policy, duplicate prevention), 01 §3.1 (ImportJob), 04 Part 16, 10 rows 24/27,
--                docs/architecture/v3/26-student-identifiers-and-imports-m2b2.md (this batch, with every assumption).
--
-- Contents:
--  * permissions student.record.update (doc 10 row 27, SENSITIVE; first used by the identifier endpoints) and
--    import.job.manage (new, SENSITIVE; doc 10 row 55 is added in the same change). Granted to roles by seedTenantRoles.
--  * app.student_identifiers: the NON-primary identifiers of a student. The admission number stays on app.students
--    (set once, unique per organization) and is NOT representable here: id_type is a closed list that excludes it.
--  * app.import_jobs / app.import_job_rows: the import workflow state. Rows are the exact submitted values (raw), the exact
--    proposed change (normalized), and the stable per-row errors and warnings.
--
-- Student identifier model (doc 02 §4.4): id_type in (UNIVERSITY_PRN, APAAR, LIBRARY_CARD, HOSTEL_ID, OTHER), value,
--   optional issuer, valid_from, valid_to; UNIQUE (organization_id, id_type, value). Audit class A1.
--  * Immutable: student_id, id_type and value (database trigger; the runtime role also has no UPDATE privilege on them).
--    Mutable: issuer, valid_from, valid_to. There is NO delete (no DELETE privilege): a mistaken identifier can be end-dated
--    but keeps occupying its (id_type, value) key. Whether and how an identifier may be corrected or removed is NOT
--    specified and needs an owner decision (doc 26 §6).
--  * Uniqueness is EXACT (case- and whitespace-sensitive after trimming). The documents define no normalisation.
--  * doc 02 §6.1 also mentions an INSTITUTIONAL_EMAIL identifier; the table in §4.4 does not list it. The closed list follows
--    §4.4. Adding a value is a forward migration (drop and re-add one CHECK).
--  * No valid_to default and no "expired" semantics here: validity is informational data for the issuer's rules.
--
-- Import model (doc 02 §4.11: import_jobs / import_job_rows -> type, status [DRAFT|VALIDATED|COMMITTED|FAILED]!, file_id,
--   summary jsonb; rows: row_no, raw jsonb, status, errors jsonb):
--  * type is STUDENT_RECORDS or EMPLOYEE_RECORDS (doc 04 Part 16: "imports 100 students + 20 faculty"). The faculty import
--    creates employee records of any employee_type, so the type names the record kind, not a role.
--  * file_id is NOT created: rows arrive as JSON from the client's CSV parser (doc 04 line 71 puts the CSV importer in the
--    admin client), so nothing is stored to point at, and "a column nobody may write is not shipped" (as in 0027). A stored
--    source file and error_report_file_id (doc 01) are additive later. The error report is generated on demand from the rows.
--  * Statuses: DRAFT (rows stored, or validation found errors), VALIDATED (validation found no error; commit-eligible),
--    COMMITTED, FAILED (terminal; a commit-time revalidation found errors). COMMITTED and FAILED are terminal and their rows
--    are immutable ("rows immutable after commit", doc 01). Row statuses: PENDING, VALID, INVALID, COMMITTED.
--  * Ownership: a job is visible and usable ONLY by the staff user who created it (restrictive policy on created_by), on top
--    of the tenant boundary. Nobody else, including another administrator of the same tenant, can read a job's rows.
--    Whether administrators should see each other's jobs is an owner decision (doc 26 §6).
--  * row_count is bounded 1..1000: a technical bound chosen for this implementation (the documents state none); the HTTP
--    body limit of the platform (1 MiB) is the other bound.
--  * A committed row points at the record it created through student_id / employee_id (tenant composite foreign keys),
--    never through a loose uuid.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so 0035
-- runs only after 0019 (and 0020-0034). Forward-only; nothing here is applied to any persistent database by this change.
-- Existing tenants need seedTenantRoles re-run to receive student.record.update and import.job.manage.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.record.update', 'SENSITIVE'),
  ('import.job.manage', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.student_identifiers
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.student_identifiers (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  student_id      app.uuid_v7 NOT NULL,
  id_type         text        NOT NULL
                  CHECK (id_type IN ('UNIVERSITY_PRN', 'APAAR', 'LIBRARY_CARD', 'HOSTEL_ID', 'OTHER')),
  value           text        NOT NULL CHECK (char_length(value) BETWEEN 1 AND 100 AND value = btrim(value)),
  issuer          text        CHECK (issuer IS NULL OR (char_length(issuer) BETWEEN 1 AND 200 AND issuer = btrim(issuer))),
  valid_from      date,
  valid_to        date,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_identifiers_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- a tenant-safe reference: an identifier can only belong to a student of ITS OWN tenant
  CONSTRAINT student_identifiers_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  -- doc 02 §4.4 UQ(organization_id, id_type, value)
  CONSTRAINT student_identifiers_type_value_uq UNIQUE (organization_id, id_type, value),
  CONSTRAINT student_identifiers_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT student_identifiers_dates_ck CHECK (
    (valid_from IS NULL OR valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31')
    AND (valid_to IS NULL OR valid_to BETWEEN DATE '1900-01-01' AND DATE '2200-12-31')
    AND (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from))
);

-- Backs the composite student foreign key and the per-student list.
CREATE INDEX student_identifiers_student_ix ON app.student_identifiers (organization_id, student_id);

-- The identity of an identifier never changes (the runtime role has no UPDATE privilege on these columns either).
CREATE FUNCTION app.student_identifiers_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.id_type IS DISTINCT FROM OLD.id_type
     OR NEW.value IS DISTINCT FROM OLD.value THEN
    RAISE EXCEPTION 'student identifier identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.student_identifiers_guard() FROM PUBLIC;

CREATE TRIGGER student_identifiers_guard     BEFORE UPDATE ON app.student_identifiers
  FOR EACH ROW EXECUTE FUNCTION app.student_identifiers_guard();
CREATE TRIGGER student_identifiers_touch     BEFORE UPDATE ON app.student_identifiers
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER student_identifiers_immutable BEFORE UPDATE ON app.student_identifiers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.student_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_identifiers FORCE  ROW LEVEL SECURITY;

CREATE POLICY student_identifiers_tenant_select ON app.student_identifiers AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_identifiers_tenant_insert ON app.student_identifiers AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY student_identifiers_tenant_update ON app.student_identifiers AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- STAFF read and write every identifier of the tenant (WHICH student's identifiers a staff member may touch is decided
-- by the authorization engine, which the database cannot see). A STUDENT reads only the identifiers of their OWN student
-- record and can never write. Any other actor kind sees nothing. Same shape as 0021 / 0027.
CREATE POLICY student_identifiers_actor_access ON app.student_identifiers AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students AS s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: no DELETE; only the validity data and the issuer can change.
GRANT SELECT, INSERT ON app.student_identifiers TO app_runtime;
GRANT UPDATE (issuer, valid_from, valid_to) ON app.student_identifiers TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.import_jobs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.import_jobs (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  type            text        NOT NULL CHECK (type IN ('STUDENT_RECORDS', 'EMPLOYEE_RECORDS')),
  status          text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'VALIDATED', 'COMMITTED', 'FAILED')),
  created_by      app.uuid_v7 NOT NULL,
  row_count       integer     NOT NULL CHECK (row_count BETWEEN 1 AND 1000),
  summary         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  -- SHA-256 of the canonical per-row outcome (status, proposed change, errors, warnings) the preview showed; a commit
  -- applies only an outcome that still equals it.
  validation_hash char(64),
  committed_at    timestamptz,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_jobs_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_creator_fk FOREIGN KEY (organization_id, created_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT import_jobs_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT import_jobs_hash_ck CHECK (validation_hash IS NULL OR validation_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_jobs_validated_hash_ck CHECK (status NOT IN ('VALIDATED', 'COMMITTED') OR validation_hash IS NOT NULL),
  CONSTRAINT import_jobs_committed_at_ck CHECK ((status = 'COMMITTED') = (committed_at IS NOT NULL))
);

CREATE INDEX import_jobs_creator_ix ON app.import_jobs (organization_id, created_by, created_at DESC);

CREATE FUNCTION app.import_jobs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IN ('COMMITTED', 'FAILED') THEN
    RAISE EXCEPTION 'a finished import job is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.row_count IS DISTINCT FROM OLD.row_count THEN
    RAISE EXCEPTION 'import job identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- DRAFT -> DRAFT | VALIDATED | FAILED; VALIDATED -> VALIDATED | DRAFT | COMMITTED | FAILED. A job is never committed
  -- without having been validated.
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'VALIDATED', 'FAILED'))
          OR (OLD.status = 'VALIDATED' AND NEW.status IN ('VALIDATED', 'DRAFT', 'COMMITTED', 'FAILED'))) THEN
    RAISE EXCEPTION 'invalid import job status transition' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.import_jobs_guard() FROM PUBLIC;

CREATE TRIGGER import_jobs_guard     BEFORE UPDATE ON app.import_jobs
  FOR EACH ROW EXECUTE FUNCTION app.import_jobs_guard();
CREATE TRIGGER import_jobs_touch     BEFORE UPDATE ON app.import_jobs
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER import_jobs_immutable BEFORE UPDATE ON app.import_jobs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_jobs FORCE  ROW LEVEL SECURITY;

CREATE POLICY import_jobs_tenant_select ON app.import_jobs AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY import_jobs_tenant_insert ON app.import_jobs AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY import_jobs_tenant_update ON app.import_jobs AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Ownership at the database: only a STAFF actor, and only the user who created the job, can see or change it.
CREATE POLICY import_jobs_owner_only ON app.import_jobs AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF' AND created_by = app.current_user_id())
  WITH CHECK (app.current_actor_kind() = 'STAFF' AND created_by = app.current_user_id());

GRANT SELECT, INSERT ON app.import_jobs TO app_runtime;
GRANT UPDATE (status, summary, validation_hash, committed_at) ON app.import_jobs TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 4. app.import_job_rows
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.import_job_rows (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  job_id          app.uuid_v7 NOT NULL,
  row_no          integer     NOT NULL CHECK (row_no BETWEEN 1 AND 1000),
  raw             jsonb       NOT NULL CHECK (jsonb_typeof(raw) = 'object'),
  status          text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VALID', 'INVALID', 'COMMITTED')),
  -- the exact change a commit would apply, once the row parsed (NULL while PENDING or when the row has no parseable shape)
  normalized      jsonb       CHECK (normalized IS NULL OR jsonb_typeof(normalized) = 'object'),
  errors          jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  warnings        jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  student_id      app.uuid_v7,
  employee_id     app.uuid_v7,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_job_rows_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT import_job_rows_job_fk FOREIGN KEY (organization_id, job_id)
    REFERENCES app.import_jobs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT import_job_rows_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT import_job_rows_employee_fk FOREIGN KEY (organization_id, employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT import_job_rows_job_row_uq UNIQUE (organization_id, job_id, row_no),
  CONSTRAINT import_job_rows_target_ck CHECK (num_nonnulls(student_id, employee_id) <= 1),
  CONSTRAINT import_job_rows_committed_ck CHECK ((status = 'COMMITTED') = (num_nonnulls(student_id, employee_id) = 1)),
  CONSTRAINT import_job_rows_invalid_errors_ck CHECK (status <> 'INVALID' OR jsonb_array_length(errors) > 0)
);

-- The job foreign key is backed by import_job_rows_job_row_uq; the record references are partial indexes.
CREATE INDEX import_job_rows_student_ix  ON app.import_job_rows (organization_id, student_id)  WHERE student_id IS NOT NULL;
CREATE INDEX import_job_rows_employee_ix ON app.import_job_rows (organization_id, employee_id) WHERE employee_id IS NOT NULL;

-- Rows are created together with their job (DRAFT) and frozen when the job is COMMITTED or FAILED. The job row is
-- share-locked, so a row write and the job's terminal transition (which holds the job row FOR UPDATE) serialise.
CREATE FUNCTION app.import_job_rows_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  job_status text;
BEGIN
  SELECT j.status INTO job_status
    FROM app.import_jobs AS j
   WHERE j.organization_id = NEW.organization_id AND j.id = NEW.job_id
     FOR SHARE;
  IF TG_OP = 'INSERT' THEN
    IF job_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'rows can only be added to a DRAFT import job' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.row_no IS DISTINCT FROM OLD.row_no
     OR NEW.raw IS DISTINCT FROM OLD.raw THEN
    RAISE EXCEPTION 'import row identity and raw columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF job_status IS NULL OR job_status NOT IN ('DRAFT', 'VALIDATED') THEN
    RAISE EXCEPTION 'rows of a finished import job are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.import_job_rows_guard() FROM PUBLIC;

CREATE TRIGGER import_job_rows_guard     BEFORE INSERT OR UPDATE ON app.import_job_rows
  FOR EACH ROW EXECUTE FUNCTION app.import_job_rows_guard();
CREATE TRIGGER import_job_rows_touch     BEFORE UPDATE ON app.import_job_rows
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER import_job_rows_immutable BEFORE UPDATE ON app.import_job_rows
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.import_job_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_job_rows FORCE  ROW LEVEL SECURITY;

CREATE POLICY import_job_rows_tenant_select ON app.import_job_rows AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY import_job_rows_tenant_insert ON app.import_job_rows AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY import_job_rows_tenant_update ON app.import_job_rows AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- A row is reachable only through a job its actor owns: the subquery runs under the import_jobs policies (owner only).
CREATE POLICY import_job_rows_owner_only ON app.import_job_rows AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         AND EXISTS (SELECT 1 FROM app.import_jobs AS j
                      WHERE j.organization_id = import_job_rows.organization_id AND j.id = import_job_rows.job_id))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         AND EXISTS (SELECT 1 FROM app.import_jobs AS j
                      WHERE j.organization_id = import_job_rows.organization_id AND j.id = import_job_rows.job_id));

GRANT SELECT, INSERT ON app.import_job_rows TO app_runtime;
GRANT UPDATE (status, normalized, errors, warnings, student_id, employee_id) ON app.import_job_rows TO app_runtime;
