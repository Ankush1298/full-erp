-- 0041_attendance_correction_permission
-- Owner: app_migrator
-- Milestone 4 (Attendance), Slice 2. Authorised on synthetic data by the owner amendment of 2026-11-05 (docs 39 §14, 40 §7).
-- Specification: docs/architecture/v3/03 (attendance.record.correct, audit tier 2 "any modification after submission"),
--                02 §4.7 (revisions are append-only), 41 §6 (Slice 2).
--
-- Registers ONE permission. No table or trigger change: the 0040 guards already require a correction to advance
-- revision_no by one, to be paired with a revision row in the same transaction, to be refused once the session is LOCKED
-- or the term is LOCKED, and the revisions table is append-only. Grants to roles come from the tenant role seed
-- (role-matrix.ts), as in 0037, 0039 and 0040; production re-seeding is a separate, unauthorised operation.
--
-- Deliberately NOT here: session locking (no permission, trigger or unlock rule is defined canonically; see doc 41 §7),
-- attendance_policies (edit window, correction approval), approved_by_user_id / service_request_id on revisions.

SET LOCAL lock_timeout = '5s';

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('attendance.record.correct', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
