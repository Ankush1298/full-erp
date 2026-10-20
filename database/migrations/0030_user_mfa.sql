-- 0030_user_mfa
-- Owner: app_migrator
-- Milestone 1 / Phase 1C: TOTP MFA, recovery codes and login-time second-factor state.
-- Specification: docs/architecture/v3/23-mfa.md; doc 08 (user_mfa_factors, user_recovery_codes, sessions.mfa_verified_at),
--                doc 10 rows 3a and 10a, doc 11 §1C / §5.4 "MFA / step-up", ADR-004, doc 12 line 13, doc 09 §8.
--
-- Contents:
--  * permissions auth.mfa.manage (NORMAL, own factor and codes) and user.account.reset_mfa (CRITICAL, admin reset).
--  * platform.auth_sessions.mfa_verified_at: when THIS session last completed a second factor (NULL = never).
--  * app.user_mfa_factors: one row per enrollment attempt. The TOTP secret is stored ONLY as AES-256-GCM ciphertext
--    (secret_enc) made by the application with the dedicated MFA keyring; secret_key_label names the key. At most one
--    PENDING and one ACTIVE factor per user (partial unique indexes: concurrent enrollments cannot both win).
--    last_used_step makes every accepted TOTP time step single use (it only ever increases; a trigger enforces it).
--  * app.user_recovery_codes: SHA-256 hashes only (salted per tenant and user by the application); single use
--    (used_at), invalidated as a set on regeneration or reset (revoked_at); both terminal.
--  * Both tables: forced RLS, tenant-scoped composite foreign keys, and RESTRICTIVE self-only policies: the runtime role
--    can read and write ONLY the current user's own rows. Nobody, not even an administrator, reads another user's
--    ciphertext through the runtime role. No DELETE grant.
--  * app.mfa_enrollment_tickets: single-use, 24-hour enrollment tickets an MFA-verified administrator issues for ONE user
--    and hands over out of band (hash only stored). A factor enrolled with password + ticket is a VERIFIED enrollment;
--    only a verified factor makes a session count as MFA-verified for an MFA-required role (docs 23-mfa.md §6). This
--    closes password-only takeover of a not-yet-enrolled administrator and the "enroll as faculty, get promoted" path.
--  * platform.admin_reset_user_mfa(user): SECURITY DEFINER (owner app_migrator), the ONLY way to touch another user's MFA rows:
--    it can only REVOKE (factors -> REVOKED, unused codes -> revoked_at) inside the caller's own tenant, never for the
--    caller themself, and never create, read or return a secret. Authorization (user.account.reset_mfa at organization
--    scope, grant rules, a fresh PASSWORD_MFA step-up, a reason, the audit event) is enforced by the application before
--    it is called, exactly like platform.complete_invitation (0028) relies on its caller.
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so 0030
-- runs only after 0019 (and 0020-0029) in the same or a later invocation. Forward-only. NOT approved for persistent
-- rollout; NOT executed against any persistent database. See docs/runbooks/mfa-rollout.md.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (doc 10 rows 3a and 10a). Granted to roles by seedTenantRoles.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('auth.mfa.manage', 'NORMAL'),
  ('user.account.reset_mfa', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- Existing tenants: seed MFA permissions idempotently for existing roles without overwriting
-- tenant-customized permissions or running destructive DELETE operations:
-- All system roles receive auth.mfa.manage (SELF) so users can manage their own factors.
INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, 'auth.mfa.manage', 'SELF'
  FROM app.roles r
 WHERE r.code IN ('STUDENT', 'FACULTY', 'STAFF', 'HOD', 'DEPARTMENT_ADMIN', 'CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR')
ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;

-- CAMPUS_ADMIN and COLLEGE_ADMIN receive administrative user.account.reset_mfa (GRANTED).
INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, 'user.account.reset_mfa', 'GRANTED'
  FROM app.roles r
 WHERE r.code IN ('CAMPUS_ADMIN', 'COLLEGE_ADMIN')
ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2. Session second-factor state (doc 08 "sessions (addition) mfa_verified_at")
-- ---------------------------------------------------------------------------------------------
ALTER TABLE platform.auth_sessions ADD COLUMN mfa_verified_at timestamptz;
COMMENT ON COLUMN platform.auth_sessions.mfa_verified_at IS
  'When this session last completed a second factor (TOTP or recovery code). NULL = never. Set only by the MFA service.';

-- ---------------------------------------------------------------------------------------------
-- 2b. app.mfa_enrollment_tickets (verified first enrollment for MFA-required roles)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.mfa_enrollment_tickets (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  user_id          app.uuid_v7 NOT NULL,                 -- the ONLY user who can redeem it
  code_hash        text        NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_by       app.uuid_v7,                          -- issuing administrator, or NULL for operational bootstrap
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  revoked_at       timestamptz,
  CONSTRAINT mfa_enrollment_tickets_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT mfa_enrollment_tickets_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT mfa_enrollment_tickets_creator_fk FOREIGN KEY (organization_id, created_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT mfa_enrollment_tickets_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT mfa_enrollment_tickets_hash_uq UNIQUE (code_hash),
  CONSTRAINT mfa_enrollment_tickets_not_self_ck CHECK (created_by IS NULL OR created_by <> user_id),
  CONSTRAINT mfa_enrollment_tickets_expiry_ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT mfa_enrollment_tickets_final_ck CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX mfa_enrollment_tickets_org_user_ix ON app.mfa_enrollment_tickets (organization_id, user_id);
CREATE INDEX mfa_enrollment_tickets_org_creator_ix ON app.mfa_enrollment_tickets (organization_id, created_by);
CREATE UNIQUE INDEX mfa_enrollment_tickets_one_active_bootstrap_uq ON app.mfa_enrollment_tickets (organization_id)
  WHERE (created_by IS NULL AND used_at IS NULL AND revoked_at IS NULL);

CREATE TRIGGER mfa_enrollment_tickets_immutable BEFORE UPDATE ON app.mfa_enrollment_tickets
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- A used or revoked ticket is terminal; who, for whom, hash and lifetime never change.
CREATE FUNCTION app.mfa_enrollment_tickets_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.code_hash IS DISTINCT FROM OLD.code_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'enrollment ticket identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked enrollment ticket cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER mfa_enrollment_tickets_guard BEFORE UPDATE ON app.mfa_enrollment_tickets
  FOR EACH ROW EXECUTE FUNCTION app.mfa_enrollment_tickets_guard();

ALTER TABLE app.mfa_enrollment_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mfa_enrollment_tickets FORCE  ROW LEVEL SECURITY;

CREATE POLICY mfa_enrollment_tickets_tenant_select ON app.mfa_enrollment_tickets AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY mfa_enrollment_tickets_tenant_insert ON app.mfa_enrollment_tickets AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY mfa_enrollment_tickets_tenant_update ON app.mfa_enrollment_tickets AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Visible to the user it is for and to its issuer only. Issued only by a STAFF actor, as themself, for someone else.
-- Redeemed (used_at) or withdrawn (revoked_at) only by the user it is for.
CREATE POLICY mfa_enrollment_tickets_party_select ON app.mfa_enrollment_tickets AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (user_id = app.current_user_id() OR (created_by IS NOT NULL AND created_by = app.current_user_id()));
CREATE POLICY mfa_enrollment_tickets_issuer_insert ON app.mfa_enrollment_tickets AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF' AND created_by = app.current_user_id()
              AND user_id <> app.current_user_id() AND used_at IS NULL AND revoked_at IS NULL);
CREATE POLICY mfa_enrollment_tickets_owner_update ON app.mfa_enrollment_tickets AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (user_id = app.current_user_id() OR (created_by IS NOT NULL AND created_by = app.current_user_id()))
  WITH CHECK (user_id = app.current_user_id() OR (created_by IS NOT NULL AND created_by = app.current_user_id()));

GRANT SELECT, INSERT ON app.mfa_enrollment_tickets TO app_runtime;
GRANT UPDATE (used_at, revoked_at) ON app.mfa_enrollment_tickets TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. app.user_mfa_factors
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.user_mfa_factors (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  user_id            app.uuid_v7 NOT NULL,
  factor_type        text        NOT NULL DEFAULT 'TOTP' CHECK (factor_type = 'TOTP'),
  status             text        NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  -- [1 byte version][12 bytes IV][16 bytes tag][ciphertext of a 20-byte secret] = 49 bytes today.
  secret_enc         bytea       NOT NULL CHECK (octet_length(secret_enc) BETWEEN 45 AND 256),
  secret_key_label      text        NOT NULL CHECK (secret_key_label ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$'),
  -- The session that started a PENDING enrollment; confirmation is accepted only from that same session.
  enroll_session_id  app.uuid_v7,
  pending_expires_at timestamptz,
  confirmed_at       timestamptz,
  last_used_step     bigint      CHECK (last_used_step >= 0),
  last_used_at       timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text        CHECK (revoked_reason IN ('CANCELLED', 'EXPIRED', 'REPLACED', 'DISABLED', 'ADMIN_RESET')),
  -- The enrollment ticket this factor was enrolled with (consumed on confirmation), if any.
  enrollment_ticket_id app.uuid_v7,
  -- TRUE = enrolled with password + an administrator-issued ticket, or replacing a verified factor while holding a fresh
  -- second factor. Only a verified factor satisfies MFA for an MFA-required role. Set at insert, never updatable.
  verified_enrollment boolean   NOT NULL DEFAULT false,
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_factors_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT user_mfa_factors_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_mfa_factors_ticket_fk FOREIGN KEY (organization_id, enrollment_ticket_id)
    REFERENCES app.mfa_enrollment_tickets (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_mfa_factors_state_ck CHECK (
       (status = 'PENDING' AND confirmed_at IS NULL AND revoked_at IS NULL AND revoked_reason IS NULL
        AND pending_expires_at IS NOT NULL AND enroll_session_id IS NOT NULL)
    OR (status = 'ACTIVE' AND confirmed_at IS NOT NULL AND revoked_at IS NULL AND revoked_reason IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  )
);

-- FK-backing index (schema-linter S-2); organization_id alone is covered by it.
CREATE INDEX user_mfa_factors_org_user_ix ON app.user_mfa_factors (organization_id, user_id);
CREATE UNIQUE INDEX user_mfa_factors_one_pending_uq ON app.user_mfa_factors (organization_id, user_id)
  WHERE status = 'PENDING';
CREATE UNIQUE INDEX user_mfa_factors_one_active_uq ON app.user_mfa_factors (organization_id, user_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX user_mfa_factors_ticket_uq ON app.user_mfa_factors (organization_id, enrollment_ticket_id)
  WHERE enrollment_ticket_id IS NOT NULL;

-- Insert guard: validates enrollment ticket if present, and restricts verified_enrollment
-- to ticket-based enrollment or replacement of an existing active verified factor.
CREATE FUNCTION app.user_mfa_factors_insert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.enrollment_ticket_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.mfa_enrollment_tickets t
       WHERE t.organization_id = NEW.organization_id
         AND t.id = NEW.enrollment_ticket_id
         AND t.user_id = NEW.user_id
         AND t.used_at IS NULL
         AND t.revoked_at IS NULL
         AND t.expires_at > pg_catalog.now()
    ) THEN
      RAISE EXCEPTION 'invalid, expired or already used enrollment ticket' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW.verified_enrollment IS TRUE THEN
    IF NEW.enrollment_ticket_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM app.user_mfa_factors f
       WHERE f.organization_id = NEW.organization_id
         AND f.user_id = NEW.user_id
         AND f.status = 'ACTIVE'
         AND f.verified_enrollment IS TRUE
    ) THEN
      RAISE EXCEPTION 'verified enrollment requires a valid ticket or an existing verified factor' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_mfa_factors_insert_guard BEFORE INSERT ON app.user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app.user_mfa_factors_insert_guard();

CREATE TRIGGER user_mfa_factors_touch BEFORE UPDATE ON app.user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER user_mfa_factors_immutable BEFORE UPDATE ON app.user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- Lifecycle guard (applies to every role, the owner included): PENDING -> ACTIVE | REVOKED, ACTIVE -> REVOKED, REVOKED is
-- terminal; the owner, type and creation facts never change; last_used_step never decreases (replay protection).
CREATE FUNCTION app.user_mfa_factors_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.factor_type IS DISTINCT FROM OLD.factor_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.enroll_session_id IS DISTINCT FROM OLD.enroll_session_id
     OR NEW.pending_expires_at IS DISTINCT FROM OLD.pending_expires_at
     OR NEW.enrollment_ticket_id IS DISTINCT FROM OLD.enrollment_ticket_id
     OR NEW.verified_enrollment IS DISTINCT FROM OLD.verified_enrollment THEN
    RAISE EXCEPTION 'MFA factor identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'a revoked MFA factor cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'PENDING' THEN
    RAISE EXCEPTION 'an active MFA factor cannot return to PENDING' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.last_used_step IS NOT NULL AND (NEW.last_used_step IS NULL OR NEW.last_used_step < OLD.last_used_step) THEN
    RAISE EXCEPTION 'last_used_step never decreases' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status = 'ACTIVE' AND NEW.verified_enrollment IS TRUE THEN
    IF NEW.enrollment_ticket_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM app.mfa_enrollment_tickets t
         WHERE t.organization_id = NEW.organization_id
           AND t.id = NEW.enrollment_ticket_id
           AND t.created_by IS NULL
      ) THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('app.mfa_bootstrap_exclusive:' || NEW.organization_id, 0)
        );
        IF EXISTS (
          SELECT 1 FROM app.user_mfa_factors f
            JOIN app.role_assignments ra ON ra.organization_id = f.organization_id AND ra.user_id = f.user_id
            JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
           WHERE f.organization_id = NEW.organization_id
             AND f.id <> NEW.id
             AND f.status = 'ACTIVE'
             AND f.verified_enrollment IS TRUE
             AND r.code IN ('HOD', 'DEPARTMENT_ADMIN', 'CAMPUS_ADMIN', 'COLLEGE_ADMIN', 'REGISTRAR')
        ) THEN
          RAISE EXCEPTION 'first-administrator bootstrap is disabled: an active verified administrator already exists'
            USING ERRCODE = 'restrict_violation';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_mfa_factors_guard BEFORE UPDATE ON app.user_mfa_factors
  FOR EACH ROW EXECUTE FUNCTION app.user_mfa_factors_guard();

ALTER TABLE app.user_mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_mfa_factors FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_mfa_factors_tenant_select ON app.user_mfa_factors AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY user_mfa_factors_tenant_insert ON app.user_mfa_factors AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY user_mfa_factors_tenant_update ON app.user_mfa_factors AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Self only, for every actor kind (students may enroll too, doc 10 row 3a).
CREATE POLICY user_mfa_factors_self_select ON app.user_mfa_factors AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (user_id = app.current_user_id());
CREATE POLICY user_mfa_factors_self_insert ON app.user_mfa_factors AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (user_id = app.current_user_id() AND status = 'PENDING');
CREATE POLICY user_mfa_factors_self_update ON app.user_mfa_factors AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

GRANT SELECT, INSERT ON app.user_mfa_factors TO app_runtime;
-- secret_enc / secret_key_label: re-encryption under a new key during rotation (docs/runbooks/mfa-rollout.md §4).
GRANT UPDATE (status, secret_enc, secret_key_label, confirmed_at, last_used_step, last_used_at, revoked_at, revoked_reason)
  ON app.user_mfa_factors TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 4. app.user_recovery_codes (doc 08: code_hash char(64) UQ, used_at, created_at; 10 codes, prior sets invalidated)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.user_recovery_codes (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  user_id          app.uuid_v7 NOT NULL,
  code_hash        text        NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  used_at          timestamptz,
  revoked_at       timestamptz,
  CONSTRAINT user_recovery_codes_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT user_recovery_codes_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_recovery_codes_hash_uq UNIQUE (code_hash),
  -- a code is either consumed or invalidated, never both
  CONSTRAINT user_recovery_codes_final_ck CHECK (used_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX user_recovery_codes_org_user_ix ON app.user_recovery_codes (organization_id, user_id);

CREATE TRIGGER user_recovery_codes_immutable BEFORE UPDATE ON app.user_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- A used or invalidated code is terminal; the owner and the hash never change.
CREATE FUNCTION app.user_recovery_codes_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'recovery code identity columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a used or revoked recovery code cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_recovery_codes_guard BEFORE UPDATE ON app.user_recovery_codes
  FOR EACH ROW EXECUTE FUNCTION app.user_recovery_codes_guard();

ALTER TABLE app.user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_recovery_codes FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_recovery_codes_tenant_select ON app.user_recovery_codes AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY user_recovery_codes_tenant_insert ON app.user_recovery_codes AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY user_recovery_codes_tenant_update ON app.user_recovery_codes AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY user_recovery_codes_self_select ON app.user_recovery_codes AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (user_id = app.current_user_id());
CREATE POLICY user_recovery_codes_self_insert ON app.user_recovery_codes AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (user_id = app.current_user_id() AND used_at IS NULL AND revoked_at IS NULL);
CREATE POLICY user_recovery_codes_self_update ON app.user_recovery_codes AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

GRANT SELECT, INSERT ON app.user_recovery_codes TO app_runtime;
GRANT UPDATE (used_at, revoked_at) ON app.user_recovery_codes TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 5. platform.admin_reset_user_mfa: revoke-only path for ANOTHER user's MFA (doc 10 row 10a)
-- ---------------------------------------------------------------------------------------------
-- Narrow owner policies (same session_user probe as 0004 / 0028): only while invoked from an app_runtime session, only in
-- the current tenant, and only the transitions to REVOKED / revoked_at. SELECT is needed because the UPDATEs filter rows.
CREATE POLICY user_mfa_factors_admin_reset_select ON app.user_mfa_factors AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id());
CREATE POLICY user_mfa_factors_admin_reset_update ON app.user_mfa_factors AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id() AND status IN ('PENDING', 'ACTIVE'))
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
              AND status = 'REVOKED' AND revoked_reason = 'ADMIN_RESET');
CREATE POLICY user_recovery_codes_admin_reset_select ON app.user_recovery_codes AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id());
CREATE POLICY user_recovery_codes_admin_reset_update ON app.user_recovery_codes AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id() AND used_at IS NULL AND revoked_at IS NULL)
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
              AND revoked_at IS NOT NULL);
CREATE POLICY mfa_enrollment_tickets_admin_reset_select ON app.mfa_enrollment_tickets AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id());
CREATE POLICY mfa_enrollment_tickets_admin_reset_update ON app.mfa_enrollment_tickets AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND organization_id = app.current_tenant_id() AND used_at IS NULL AND revoked_at IS NULL)
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
              AND revoked_at IS NOT NULL);

CREATE FUNCTION platform.admin_reset_user_mfa(p_user_id app.uuid_v7)
RETURNS TABLE (factors_revoked integer, codes_revoked integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_org app.uuid_v7 := app.current_tenant_id();
  v_actor app.uuid_v7 := app.current_user_id();
  v_factors integer;
  v_codes integer;
BEGIN
  IF session_user::text <> 'app_runtime' OR NOT app.context_ok() OR app.current_actor_kind() IS DISTINCT FROM 'STAFF' THEN
    RAISE EXCEPTION 'MFA reset requires a staff tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id IS NULL OR p_user_id = v_actor THEN
    RAISE EXCEPTION 'MFA reset cannot target the caller' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE app.user_mfa_factors f
     SET status = 'REVOKED', revoked_at = pg_catalog.now(), revoked_reason = 'ADMIN_RESET'
   WHERE f.organization_id = v_org AND f.user_id = p_user_id AND f.status IN ('PENDING', 'ACTIVE');
  GET DIAGNOSTICS v_factors = ROW_COUNT;

  UPDATE app.user_recovery_codes c
     SET revoked_at = pg_catalog.now()
   WHERE c.organization_id = v_org AND c.user_id = p_user_id AND c.used_at IS NULL AND c.revoked_at IS NULL;
  GET DIAGNOSTICS v_codes = ROW_COUNT;

  UPDATE app.mfa_enrollment_tickets t
     SET revoked_at = pg_catalog.now()
   WHERE t.organization_id = v_org AND t.user_id = p_user_id AND t.used_at IS NULL AND t.revoked_at IS NULL;

  RETURN QUERY SELECT v_factors, v_codes;
END
$$;

REVOKE ALL ON FUNCTION app.mfa_enrollment_tickets_guard(), app.user_mfa_factors_insert_guard(),
  app.user_mfa_factors_guard(), app.user_recovery_codes_guard(),
  platform.admin_reset_user_mfa(app.uuid_v7) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.admin_reset_user_mfa(app.uuid_v7) TO app_runtime;
