-- 0047_student_admission_campus
-- Owner: app_migrator
-- Pilot V1: Permanent admission campus ownership for app.students.
--
-- Enables durable campus scoping for student admission, profile access, and enrolment continuity:
--  - Records the student's admission campus permanently on app.students (campus_id).
--  - Supports campus-scoped staff profile read and directory lookup before academic programme enrolment exists.
--  - Enforces cross-campus isolation for unplaced admitted students.
--  - Nullable to preserve organization-wide administrator creation without campus scope.

SET LOCAL lock_timeout = '5s';

ALTER TABLE app.students ADD COLUMN campus_id app.uuid_v7;

ALTER TABLE app.students
  ADD CONSTRAINT students_campus_fk
  FOREIGN KEY (organization_id, campus_id)
  REFERENCES app.campuses (organization_id, id)
  ON DELETE RESTRICT;

CREATE INDEX students_org_campus_idx ON app.students (organization_id, campus_id);

-- Enforce least-privilege on financial audit ledger: runtime role cannot delete financial records
REVOKE DELETE ON app.fee_categories FROM app_runtime;
REVOKE DELETE ON app.fee_structures FROM app_runtime;
REVOKE DELETE ON app.fee_structure_components FROM app_runtime;
REVOKE DELETE ON app.student_dues FROM app_runtime;
REVOKE DELETE ON app.fee_receipts FROM app_runtime;
REVOKE DELETE ON app.fee_receipt_allocations FROM app_runtime;


