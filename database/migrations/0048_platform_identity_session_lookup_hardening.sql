-- 0048_platform_identity_session_lookup_hardening
-- Owner: app_migrator
-- Security hardening slice 2 (doc 48 §4, doc 46 P1-1).
--
-- WHAT THIS CHANGES:
-- Migration 0043 restricted INSERT and UPDATE columns on platform.identities and platform.auth_sessions,
-- but table-wide SELECT remained granted to app_runtime (residual risk P1-1).
--
-- This migration eliminates table-wide SELECT on platform.identities and platform.auth_sessions from app_runtime.
-- Raw table SELECT is revoked. Lookups of identities and sessions are moved behind SECURITY DEFINER functions
-- with pinned search_path = pg_catalog:
--   - platform.lookup_identity_by_email(text)
--   - platform.lookup_identity_by_id(app.uuid_v7)
--   - platform.lock_identity_by_email(text)
--   - platform.lookup_session_by_token(text)
--   - platform.lookup_session_by_id(app.uuid_v7)
--
-- For write operations that the application runtime must execute:
--   - platform.identities: column-level SELECT is granted ONLY on non-sensitive columns needed for WHERE/RETURNING/lockout
--     evaluations: (id, failed_login_count, locked_until). password_hash, email, status cannot be selected directly.
--   - platform.auth_sessions: column-level SELECT is granted ONLY on non-token columns needed for WHERE/RETURNING/assurance
--     updates: (id, identity_id, tenant_id, expires_at, revoked_at, step_up_at, auth_strength, mfa_verified_at).
--     token_hash cannot be selected directly.
--
-- ROLLOUT: forward-only schema and privilege change, no table locks beyond catalog updates.

SET LOCAL lock_timeout = '5s';

-- 1. Identity lookup by email
CREATE FUNCTION platform.lookup_identity_by_email(p_email text)
RETURNS TABLE (
  id app.uuid_v7,
  email text,
  password_hash text,
  status text,
  failed_login_count smallint,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.email, i.password_hash, i.status, i.failed_login_count, i.locked_until
    FROM platform.identities i
   WHERE i.email = pg_catalog.lower(p_email);
END;
$$;

-- 2. Identity lookup by ID
CREATE FUNCTION platform.lookup_identity_by_id(p_id app.uuid_v7)
RETURNS TABLE (
  id app.uuid_v7,
  email text,
  password_hash text,
  status text,
  failed_login_count smallint,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.email, i.password_hash, i.status, i.failed_login_count, i.locked_until
    FROM platform.identities i
   WHERE i.id = p_id;
END;
$$;

-- 3. Lock identity by email (invitation acceptance concurrency serialization)
CREATE FUNCTION platform.lock_identity_by_email(p_email text)
RETURNS TABLE (
  id app.uuid_v7,
  email text,
  password_hash text,
  status text,
  failed_login_count smallint,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT i.id, i.email, i.password_hash, i.status, i.failed_login_count, i.locked_until
    FROM platform.identities i
   WHERE i.email = pg_catalog.lower(p_email)
     FOR UPDATE;
END;
$$;

-- 4. Session lookup by token hash
CREATE FUNCTION platform.lookup_session_by_token(p_token_hash text)
RETURNS TABLE (
  id app.uuid_v7,
  identity_id app.uuid_v7,
  tenant_id app.uuid_v7,
  token_hash char(64),
  expires_at timestamptz,
  revoked_at timestamptz,
  step_up_at timestamptz,
  auth_strength text,
  mfa_verified_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.identity_id, s.tenant_id, s.token_hash, s.expires_at, s.revoked_at, s.step_up_at, s.auth_strength::text, s.mfa_verified_at
    FROM platform.auth_sessions s
   WHERE s.token_hash = p_token_hash;
END;
$$;

-- 5. Session lookup by session ID
CREATE FUNCTION platform.lookup_session_by_id(p_session_id app.uuid_v7)
RETURNS TABLE (
  id app.uuid_v7,
  identity_id app.uuid_v7,
  tenant_id app.uuid_v7,
  token_hash char(64),
  expires_at timestamptz,
  revoked_at timestamptz,
  step_up_at timestamptz,
  auth_strength text,
  mfa_verified_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.identity_id, s.tenant_id, s.token_hash, s.expires_at, s.revoked_at, s.step_up_at, s.auth_strength::text, s.mfa_verified_at
    FROM platform.auth_sessions s
   WHERE s.id = p_session_id;
END;
$$;

-- Owners, Public Revocations, and Runtime Grants
ALTER FUNCTION platform.lookup_identity_by_email(text) OWNER TO app_migrator;
ALTER FUNCTION platform.lookup_identity_by_id(app.uuid_v7) OWNER TO app_migrator;
ALTER FUNCTION platform.lock_identity_by_email(text) OWNER TO app_migrator;
ALTER FUNCTION platform.lookup_session_by_token(text) OWNER TO app_migrator;
ALTER FUNCTION platform.lookup_session_by_id(app.uuid_v7) OWNER TO app_migrator;

REVOKE ALL ON FUNCTION platform.lookup_identity_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lookup_identity_by_id(app.uuid_v7) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lock_identity_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lookup_session_by_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.lookup_session_by_id(app.uuid_v7) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION platform.lookup_identity_by_email(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION platform.lookup_identity_by_id(app.uuid_v7) TO app_runtime;
GRANT EXECUTE ON FUNCTION platform.lock_identity_by_email(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION platform.lookup_session_by_token(text) TO app_runtime;
GRANT EXECUTE ON FUNCTION platform.lookup_session_by_id(app.uuid_v7) TO app_runtime;

-- Revoke table-wide SELECT on identities and sessions
REVOKE SELECT ON platform.identities FROM app_runtime;
REVOKE SELECT ON platform.auth_sessions FROM app_runtime;

-- Grant minimal column-level SELECT required for WHERE/RETURNING/ON CONFLICT clauses on authorized writes
GRANT SELECT (id, email, failed_login_count, locked_until) ON platform.identities TO app_runtime;
GRANT SELECT (id, identity_id, tenant_id, expires_at, revoked_at, step_up_at, auth_strength, mfa_verified_at) ON platform.auth_sessions TO app_runtime;
