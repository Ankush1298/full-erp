-- 0034_rooms_and_employee_postings
-- Owner: app_migrator
-- Milestone 2 (Organization + People, docs/architecture/v3/04 Part 16), Batch 1: rooms and employee postings only.
-- Specification: docs/architecture/v3/02 §4.2 (rooms), §4.4 (employees, employee_postings),
--                docs/architecture/v3/06 §3 (scope resolution table),
--                docs/architecture/v3/20-employees.md §4 & §5 (FU-EMP-2, FU-EMP-3),
--                docs/architecture/v3/10 (permissions).
--
-- Contents:
--  * app.rooms: Teaching spaces of a campus (model below).
--  * app.employee_postings: Effective-dated employee placements (department and designation over time).
--  * app.employees_separation_guard: Atomically closes open postings on SEPARATED status.
--
-- Room model (owner Decision 1: aligned to the canonical text, docs 01 Room and 02 §4.2 rooms):
--  * app.rooms carries exactly: campus_id, code, kind (required), name and capacity (optional), plus the standard columns
--    (id, organization_id, version, created_at, updated_at). UNIQUE (campus, code). Audit class A0: no audit events.
--  * `kind` has NO fixed vocabulary because the documents define none; it is free text bounded only by length (1-50).
--  * No status / lifecycle, no building, no floor: nothing in the documents supports them (owner Decision 1).
--  * Genuinely undefined, kept as technical bounds and recorded for owner review: code 1-20 characters (repository code
--    convention), name 1-255, capacity a positive smallint. `version` follows 08 §4 "every mutable aggregate has version".
--  * No campus-status rule: a room may be created on a campus of any status (nothing in the documents requires otherwise).
--  * employee_postings: matches 02 (no overlap per (employee, department); designation optional; no designation rule).
--    Two bounded (valid_to set) primary postings in different departments may overlap in time: Decision C limits the
--    one-primary rule to open postings.
--  * employees: SEPARATED requires a leaving_date (owner Decision B), on INSERT and UPDATE. Rows that were SEPARATED
--    without a date before this migration are not rewritten; their next status/leaving_date UPDATE must supply one
--    (docs/runbooks/employee-separation-preflight.md).
--
-- Concurrency & Integrity design:
--  * Rooms: Unique room code per campus per tenant. RLS tenant-isolated, staff write policies.
--  * Employee Postings:
--    - Partial unique index guarantees at most one active primary posting per employee (Decision C).
--    - employee_postings_guard takes a row lock on app.employees (FOR UPDATE), serialising competing
--      posting writes for the same employee.
--    - Prevents overlapping intervals for the same employee and department.
--    - Refuses creating postings on SEPARATED employees.
--    - Guard on app.employees ensures that transitioning to SEPARATED requires an approved leaving_date
--      and atomically closes any open postings using that approved date (Decision B).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.rooms
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.rooms (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  campus_id       app.uuid_v7 NOT NULL,
  code            text        NOT NULL CHECK (char_length(code) BETWEEN 1 AND 20),
  kind            text        NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 50),
  name            text        CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255),
  capacity        smallint    CHECK (capacity IS NULL OR capacity > 0),
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rooms_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT rooms_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT rooms_org_campus_code_uq UNIQUE (organization_id, campus_id, code),
  CONSTRAINT rooms_org_id_uq UNIQUE (organization_id, id)
);
-- The campus foreign key is indexed by the leading columns of rooms_org_campus_code_uq.

CREATE FUNCTION app.rooms_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- Identity is immutable (the runtime role has no UPDATE privilege on these columns either). There is deliberately NO
  -- rule about the campus status: the documents impose none on rooms (the "campus ACTIVE" rule of doc 18 line 32 governs
  -- grantable role-assignment scopes, not rooms), so a room may be created on a campus of any status.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
     OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'room identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rooms_guard BEFORE UPDATE ON app.rooms
  FOR EACH ROW EXECUTE FUNCTION app.rooms_guard();

CREATE TRIGGER rooms_touch BEFORE UPDATE ON app.rooms
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER rooms_immutable BEFORE UPDATE ON app.rooms
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.rooms FORCE  ROW LEVEL SECURITY;

CREATE POLICY rooms_tenant_select ON app.rooms AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY rooms_tenant_insert ON app.rooms AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY rooms_tenant_update ON app.rooms AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Writes are staff-only at the database; which staff member may manage which campus room is decided by AuthorizationEngine (org.campus.manage).
CREATE POLICY rooms_staff_insert ON app.rooms AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY rooms_staff_update ON app.rooms AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.rooms TO app_runtime;
GRANT UPDATE (kind, name, capacity) ON app.rooms TO app_runtime;


-- ---------------------------------------------------------------------------------------------
-- 2. app.employee_postings
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.employee_postings (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  employee_id     app.uuid_v7 NOT NULL,
  department_id   app.uuid_v7 NOT NULL,
  designation_id  app.uuid_v7,
  valid_from      date        NOT NULL CHECK (valid_from BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  valid_to        date        CHECK (valid_to IS NULL OR valid_to BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
  is_primary      boolean     NOT NULL DEFAULT false,
  version         integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_postings_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT employee_postings_employee_fk FOREIGN KEY (organization_id, employee_id)
    REFERENCES app.employees (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT employee_postings_department_fk FOREIGN KEY (organization_id, department_id)
    REFERENCES app.departments (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT employee_postings_designation_fk FOREIGN KEY (organization_id, designation_id)
    REFERENCES app.designations (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT employee_postings_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT employee_postings_dates_ck CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- At most one open primary posting per employee across all writers (Decision C).
CREATE UNIQUE INDEX employee_postings_one_primary_uq ON app.employee_postings (organization_id, employee_id)
  WHERE is_primary = true AND valid_to IS NULL;

CREATE INDEX employee_postings_dept_valid_to_ix ON app.employee_postings (organization_id, department_id, valid_to);
CREATE INDEX employee_postings_employee_ix ON app.employee_postings (organization_id, employee_id, valid_from);
CREATE INDEX employee_postings_designation_ix ON app.employee_postings (organization_id, designation_id);

CREATE FUNCTION app.employee_postings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  emp_status text;
  emp_leaving date;
  dept_status text;
  dept_deleted timestamptz;
  des_status text;
BEGIN
  -- Serialise posting changes for this employee by locking the parent employee row first.
  SELECT e.status, e.leaving_date INTO emp_status, emp_leaving
    FROM app.employees e
   WHERE e.organization_id = NEW.organization_id AND e.id = NEW.employee_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- Foreign key handles non-existent employee
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF emp_status = 'SEPARATED' THEN
      RAISE EXCEPTION 'cannot create posting for separated employee' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'employee_postings_employee_active_ck';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.department_id IS DISTINCT FROM OLD.department_id
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from THEN
      RAISE EXCEPTION 'employee posting identity columns are immutable' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.valid_to IS NOT NULL THEN
      RAISE EXCEPTION 'a closed employee posting cannot be modified' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Department must be active and not soft-deleted when a posting is created. Not re-checked on UPDATE: closing a
  -- posting (and the closure that separation performs) must keep working after its department was deactivated.
  IF TG_OP = 'INSERT' THEN
    SELECT d.status, d.deleted_at INTO dept_status, dept_deleted
      FROM app.departments d
     WHERE d.organization_id = NEW.organization_id AND d.id = NEW.department_id
       FOR SHARE;
    IF FOUND THEN
      IF dept_status <> 'ACTIVE' OR dept_deleted IS NOT NULL THEN
        RAISE EXCEPTION 'posting department must be ACTIVE' USING ERRCODE = 'check_violation',
          CONSTRAINT = 'employee_postings_dept_active_ck';
      END IF;
    END IF;
  END IF;

  -- Designation, if provided, must be active when it is set (on INSERT, or when an UPDATE changes it)
  IF NEW.designation_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.designation_id IS DISTINCT FROM OLD.designation_id) THEN
    SELECT des.status INTO des_status
      FROM app.designations des
     WHERE des.organization_id = NEW.organization_id AND des.id = NEW.designation_id
       FOR SHARE;
    IF FOUND AND des_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'posting designation must be ACTIVE' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'employee_postings_designation_active_ck';
    END IF;
  END IF;

  -- If employee is separated, postings must not be open
  IF emp_status = 'SEPARATED' AND NEW.valid_to IS NULL THEN
    RAISE EXCEPTION 'posting on separated employee cannot be open' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'employee_postings_separated_no_open_ck';
  END IF;

  -- If employee has a recorded separation leaving date and is separated, valid_to cannot exceed it
  IF emp_status = 'SEPARATED' AND emp_leaving IS NOT NULL AND NEW.valid_to IS NOT NULL AND NEW.valid_to > emp_leaving THEN
    RAISE EXCEPTION 'posting valid_to cannot exceed employee leaving_date' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'employee_postings_valid_to_leaving_ck';
  END IF;

  -- No overlapping intervals for the same employee and department
  IF EXISTS (
    SELECT 1 FROM app.employee_postings p
     WHERE p.organization_id = NEW.organization_id
       AND p.employee_id = NEW.employee_id
       AND p.department_id = NEW.department_id
       AND (TG_OP = 'INSERT' OR p.id <> NEW.id)
       AND p.valid_from <= COALESCE(NEW.valid_to, DATE '2200-12-31')
       AND COALESCE(p.valid_to, DATE '2200-12-31') >= NEW.valid_from
  ) THEN
    RAISE EXCEPTION 'employee posting overlaps an existing posting in this department'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'employee_postings_no_overlap';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER employee_postings_guard BEFORE INSERT OR UPDATE ON app.employee_postings
  FOR EACH ROW EXECUTE FUNCTION app.employee_postings_guard();

CREATE TRIGGER employee_postings_touch BEFORE UPDATE ON app.employee_postings
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER employee_postings_immutable BEFORE UPDATE ON app.employee_postings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.employee_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.employee_postings FORCE  ROW LEVEL SECURITY;

CREATE POLICY employee_postings_tenant_select ON app.employee_postings AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY employee_postings_tenant_insert ON app.employee_postings AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY employee_postings_tenant_update ON app.employee_postings AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Restrictive staff-only: students never read or write employee postings.
CREATE POLICY employee_postings_staff_select ON app.employee_postings AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');
CREATE POLICY employee_postings_staff_insert ON app.employee_postings AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');
CREATE POLICY employee_postings_staff_update ON app.employee_postings AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF') WITH CHECK (app.current_actor_kind() = 'STAFF');

GRANT SELECT, INSERT ON app.employee_postings TO app_runtime;
GRANT UPDATE (designation_id, valid_to, is_primary) ON app.employee_postings TO app_runtime;


-- ---------------------------------------------------------------------------------------------
-- 3. Employee separation trigger on app.employees (Decision B)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.employees_separation_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'SEPARATED' THEN
    IF NEW.leaving_date IS NULL THEN
      RAISE EXCEPTION 'an employee must have an approved leaving_date to be SEPARATED' USING ERRCODE = 'check_violation',
        CONSTRAINT = 'employees_separated_leaving_date_ck';
    END IF;

    IF TG_OP = 'INSERT' THEN
      RETURN NEW; -- a new employee has no postings
    END IF;

    IF OLD.status = 'SEPARATED' AND NEW.leaving_date IS DISTINCT FROM OLD.leaving_date THEN
      -- Closed history is never rewritten, so the date of an already separated employee cannot move before a posting
      -- that starts or ends after it (the posting guard forbids that state for postings; this forbids it for the date).
      IF EXISTS (
        SELECT 1 FROM app.employee_postings
         WHERE organization_id = NEW.organization_id
           AND employee_id = NEW.id
           AND (valid_from > NEW.leaving_date OR valid_to > NEW.leaving_date)
      ) THEN
        RAISE EXCEPTION 'cannot move the leaving_date before an existing posting of a separated employee'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'employees_separated_leaving_date_history_ck';
      END IF;
    END IF;

    -- Ensure no open posting starts after the approved separation date
    IF EXISTS (
      SELECT 1 FROM app.employee_postings
       WHERE organization_id = NEW.organization_id
         AND employee_id = NEW.id
         AND valid_to IS NULL
         AND valid_from > NEW.leaving_date
    ) THEN
      RAISE EXCEPTION 'cannot separate employee: an active posting starts after the approved leaving_date'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'employee_postings_separation_date_ck';
    END IF;

    -- Atomically close any open postings with the approved separation effective date
    UPDATE app.employee_postings
       SET valid_to = NEW.leaving_date
     WHERE organization_id = NEW.organization_id
       AND employee_id = NEW.id
       AND valid_to IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER employees_separation_guard BEFORE INSERT OR UPDATE OF status, leaving_date ON app.employees
  FOR EACH ROW EXECUTE FUNCTION app.employees_separation_guard();

REVOKE ALL ON FUNCTION app.rooms_guard(), app.employee_postings_guard(), app.employees_separation_guard() FROM PUBLIC;
