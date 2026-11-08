-- 0043_platform_identity_session_least_privilege
-- Owner: app_migrator
-- Security hardening slice 1 (doc 48, doc 46 P1-1). Synthetic-data hardening; no data is read or changed.
--
-- WHAT THESE TABLES ARE: platform.identities (login e-mail, password hash, lockout state) and platform.auth_sessions (session
-- token hash, identity, tenant, assurance level) are GLOBAL identity infrastructure: one identity can belong to several
-- tenants and login must find an identity by e-mail BEFORE any tenant is known. They are deliberately not tenant-scoped, so
-- tenant row-level security cannot be added without breaking sign-in; doc 48 §4 records why and what remains open.
--
-- WHAT THIS CHANGES: 0004 and 0029 gave app_runtime table-wide SELECT, INSERT, UPDATE and DELETE. The application's own SQL
-- (AuthRepository, RoleAssignmentService, AuthService) never deletes from either table, never changes an identity's e-mail,
-- password hash, status or id, and never rewrites a session's identity or tenant. This migration removes exactly those
-- unused powers, so a compromised or buggy runtime process can no longer
--   * delete identities or sessions,
--   * overwrite a password hash, e-mail or status,
--   * re-point a session at another identity or tenant (session hijack by rewrite),
--   * extend a session's lifetime.
-- It is NOT a cross-tenant read control: SELECT stays (login lookup is global by design).
--
-- Passwords are never changed here; there is no password-change feature in the application yet. When one is built it must
-- add its own narrowly scoped column grant or SECURITY DEFINER function in its own migration.
--
-- ROLLOUT: forward-only privilege change, no data touched, no table lock beyond the catalog update.

SET LOCAL lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE ON platform.identities FROM app_runtime;
GRANT INSERT (id, email, password_hash, status) ON platform.identities TO app_runtime;
GRANT UPDATE (failed_login_count, locked_until) ON platform.identities TO app_runtime;

REVOKE INSERT, UPDATE, DELETE ON platform.auth_sessions FROM app_runtime;
GRANT INSERT (id, identity_id, tenant_id, token_hash, expires_at) ON platform.auth_sessions TO app_runtime;
GRANT UPDATE (revoked_at, step_up_at, auth_strength, mfa_verified_at) ON platform.auth_sessions TO app_runtime;
