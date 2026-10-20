-- 0024_student_directory_list_permission
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students: registers the permission behind the paginated staff student directory
-- (GET /api/v1/students/directory). It is independent of student.directory.search (0023, the exact-admission-number
-- lookup): holding one confers nothing about the other.
-- Specification: docs/architecture/v3/10 §1 row 25a (student.directory.list, SENSITIVE; GRANTED to HOD, DEPARTMENT_ADMIN,
--                CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, held by no other role) and docs/architecture/v3/21-students.md §0c.
--                Only students with an ACTIVE enrolment inside the caller's GRANTED scope are listed.
--
-- Ownership rule (0014, 0017, 0022, 0023): this row, the PERMISSION_CATALOG entry in backend/src/shared/authorization/catalog.ts
-- and the ROLE_MATRIX grants in role-matrix.ts change together; tests/integration/permission-seed.test.ts requires
-- platform.permissions to equal the code catalog exactly.
--
-- Existing tenants: this migration only REGISTERS the code. Role grants live in app.role_permissions and reach a tenant
-- only through seedTenantRoles, which skips codes that are not yet registered here. So: apply 0024 first, then re-run the
-- seed for each existing tenant (a separate, explicitly authorised operation; not performed by this change). Until then
-- no role holds the permission and the endpoint refuses with 403 (fail closed).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0024 runs only after 0019 (and 0020 to 0023) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).
-- The route itself stays unregistered until valid cursor keys are configured (docs/runbooks/secrets.md), so applying this
-- migration activates nothing.

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.directory.list', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
