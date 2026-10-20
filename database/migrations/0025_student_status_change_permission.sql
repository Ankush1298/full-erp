-- 0025_student_status_change_permission
-- Owner: app_migrator
-- Milestone 1 / Phase 1D, Students Phase 3b: registers the permission behind POST /api/v1/students/:id/status.
-- Specification: docs/architecture/v3/10 §1 row 28 (student.status.change, CRITICAL: reason required, always audited;
--                GRANTED to CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR, held by no other role) and
--                docs/architecture/v3/21-students.md §6b.
--
-- Ownership rule (0014, 0017, 0022-0024): this row, the PERMISSION_CATALOG entry in backend/src/shared/authorization/
-- catalog.ts and the ROLE_MATRIX grants in role-matrix.ts change together; tests/integration/permission-seed.test.ts
-- requires platform.permissions to equal the code catalog exactly.
--
-- Existing tenants: this migration only REGISTERS the code. Role grants live in app.role_permissions and reach a tenant
-- only through seedTenantRoles, which skips codes that are not yet registered here. So: apply 0025 first, then re-run the
-- seed for each existing tenant (a separate, explicitly authorised operation; not performed by this change). Until then
-- no role holds the permission and the endpoint refuses with 403 (fail closed).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0025 runs only after 0019 (and 0020 to 0024) in the same or a later invocation (docs/runbooks/students-contract-rollout.md).

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('student.status.change', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;
