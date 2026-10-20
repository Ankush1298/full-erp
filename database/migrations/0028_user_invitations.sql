-- 0028_user_invitations
-- Owner: app_migrator
-- Milestone 1 / Phase 1C: tenant user invitations (doc 08 invite_tokens, doc 11 §5.4 "Auth: accept-invite", "Users").
-- Specification: docs/architecture/v3/08 (invite_tokens: token_hash char(64) UQ, expires_at, used_at, created_by),
--                10 §1 rows 6, 7, 9 (user.account.read / invite / suspend), 11 §5.4 lines 149-157, ADR-005, ADR-008.
--
-- Contents:
--  * permissions user.account.read (SENSITIVE), user.account.invite (SENSITIVE), user.account.suspend (CRITICAL).
--  * app.invite_tokens: one row per issued invitation; ONLY a SHA-256 hash of the token is stored (never the token).
--    Forced RLS, tenant-scoped composite foreign keys, STAFF-only. The runtime role can insert a row and set revoked_at; it
--    CANNOT set used_at (consumption is the job of the function below).
--  * platform.lock_invitation / platform.complete_invitation: the ONLY way an invitation is consumed and a membership
--    activated. They are SECURITY DEFINER (owner app_migrator), because acceptance happens with no session and no tenant
--    context: an INVITED user is not ACTIVE, so app.context_ok() rejects it and row security hides its row. They follow the
--    precedent of platform.get_identity_memberships (0004): the owner reads/updates rows only while invoked from an
--    app_runtime session (session_user probe), and only the narrow policies below admit it.
--  * a guard trigger: the runtime role can no longer move a user into or out of INVITED by UPDATE. Activation exists only
--    through complete_invitation. (A superuser or the owner is unaffected, like every other guard in this repository.)
--
-- DELIBERATELY NOT HERE (recorded, not silently resolved):
--  * Roles in an invitation. An invitation never carries a role or a scope: roles are granted afterwards by an authorized
--    human through RoleAssignmentService.
--  * Invitation purposes other than ACCOUNT_INVITE (doc 08 lists EMAIL_VERIFY and EMAIL_CHANGE), password reset tokens,
--    MFA factors, a purge job for old rows (doc 08: purge after 30 days), and the e-mail provider.
--  * Anything about D9 (denial auditing) or D10 (step-up).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so 0028
-- runs only after 0019 (and 0020-0027) in the same or a later invocation. It follows 0027 in the ledger, so it cannot be
-- applied without 0027 even though it does not depend on it. NOT approved for persistent rollout; forward-only.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (doc 10 rows 6, 7, 9). Granted to roles by seedTenantRoles.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('user.account.read', 'SENSITIVE'),
  ('user.account.invite', 'SENSITIVE'),
  ('user.account.suspend', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.invite_tokens
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.invite_tokens (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  user_id          app.uuid_v7 NOT NULL,                       -- the INVITED membership this token activates
  purpose          text        NOT NULL CHECK (purpose = 'ACCOUNT_INVITE'),
  token_hash       text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by       app.uuid_v7 NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  revoked_at       timestamptz,
  CONSTRAINT invite_tokens_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT invite_tokens_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT invite_tokens_creator_fk FOREIGN KEY (organization_id, created_by)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT invite_tokens_hash_uq UNIQUE (token_hash),
  CONSTRAINT invite_tokens_expiry_ck CHECK (expires_at > created_at),
  -- a token is either consumed or withdrawn, never both
  CONSTRAINT invite_tokens_final_ck CHECK (used_at IS NULL OR revoked_at IS NULL)
);

-- FK-backing indexes (schema-linter S-2); organization_id alone is covered by the first.
CREATE INDEX invite_tokens_org_user_ix ON app.invite_tokens (organization_id, user_id);
CREATE INDEX invite_tokens_org_creator_ix ON app.invite_tokens (organization_id, created_by);

CREATE TRIGGER invite_tokens_immutable BEFORE UPDATE ON app.invite_tokens
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

ALTER TABLE app.invite_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invite_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY invite_tokens_tenant_select ON app.invite_tokens AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY invite_tokens_tenant_insert ON app.invite_tokens AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY invite_tokens_tenant_update ON app.invite_tokens AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- STAFF only (a STUDENT session never sees or writes an invitation); the creator is the authenticated user.
CREATE POLICY invite_tokens_staff_select ON app.invite_tokens AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');
CREATE POLICY invite_tokens_staff_insert ON app.invite_tokens AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF' AND created_by = app.current_user_id());
CREATE POLICY invite_tokens_staff_update ON app.invite_tokens AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Least privilege: insert a row, withdraw it (revoked_at). used_at is NOT granted: only complete_invitation sets it.
GRANT SELECT, INSERT ON app.invite_tokens TO app_runtime;
GRANT UPDATE (revoked_at) ON app.invite_tokens TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 3. Narrow policies for the SECURITY DEFINER functions (owner app_migrator, invoked from an app_runtime session only).
--    Same probe as users_identity_probe (0004). They admit exactly the rows and transitions the functions need.
-- ---------------------------------------------------------------------------------------------
CREATE POLICY invite_tokens_acceptance_select ON app.invite_tokens AS PERMISSIVE FOR SELECT TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator');
CREATE POLICY invite_tokens_acceptance_update ON app.invite_tokens AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND used_at IS NULL AND revoked_at IS NULL)
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator');
-- an INVITED, identity-less membership may become ACTIVE and gain its identity; nothing else
CREATE POLICY users_invitation_activation ON app.users AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
         AND status = 'INVITED' AND identity_id IS NULL)
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
              AND status = 'ACTIVE' AND identity_id IS NOT NULL);

-- ---------------------------------------------------------------------------------------------
-- 4. Guard: the runtime role cannot move a user into or out of INVITED
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.users_invited_status_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user::text = 'app_runtime' AND ((OLD.status = 'INVITED') IS DISTINCT FROM (NEW.status = 'INVITED')) THEN
    RAISE EXCEPTION 'a user can leave INVITED only by accepting an invitation, and cannot return to it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER users_invited_status_guard BEFORE UPDATE OF status ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_invited_status_guard();

-- ---------------------------------------------------------------------------------------------
-- 5. platform.lock_invitation: find and LOCK a usable invitation by the hash of its token
-- ---------------------------------------------------------------------------------------------
-- Usable = unused, not withdrawn, not expired, the membership still INVITED and without an identity, the organization
-- ACTIVE. The row locks (FOR UPDATE) are held until the caller's transaction ends, so concurrent acceptances of one token
-- queue here; the loser re-evaluates the predicate after the winner commits and finds nothing. Returns the e-mail and display
-- name of the INVITED membership (never the token, never anything about other tenants).
CREATE FUNCTION platform.lock_invitation(p_token_hash text)
RETURNS TABLE (organization_id app.uuid_v7, user_id app.uuid_v7, email text, display_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  RETURN QUERY
  SELECT it.organization_id, it.user_id, u.email, u.display_name
    FROM app.invite_tokens it
    JOIN app.users u ON u.organization_id = it.organization_id AND u.id = it.user_id
    JOIN app.organizations o ON o.id = it.organization_id
   WHERE it.token_hash = p_token_hash
     AND it.purpose = 'ACCOUNT_INVITE'
     AND it.used_at IS NULL AND it.revoked_at IS NULL
     AND it.expires_at > pg_catalog.now()
     AND u.status = 'INVITED' AND u.identity_id IS NULL
     AND o.status = 'ACTIVE'
     FOR UPDATE OF it, u;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. platform.complete_invitation: consume the token and activate the membership, atomically
-- ---------------------------------------------------------------------------------------------
-- Single use: the UPDATE ... WHERE used_at IS NULL claims the token; if it matches nothing, or the membership is no longer
-- INVITED/identity-less, or the identity is not an ACTIVE identity with the membership's own e-mail, the function RAISES and
-- the caller's transaction rolls back. Every other outstanding token of the same membership is withdrawn. On success it sets
-- the TRANSACTION-LOCAL context (tenant, user, STAFF) that Database.withTenant would set, derived ONLY from the invitation
-- row, so the caller can write the audit event in the same transaction under the normal audit policy. It returns the
-- tenant and the membership; roles are never granted here.
CREATE FUNCTION platform.complete_invitation(p_token_hash text, p_identity_id app.uuid_v7)
RETURNS TABLE (organization_id app.uuid_v7, user_id app.uuid_v7)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_org app.uuid_v7;
  v_user app.uuid_v7;
BEGIN
  UPDATE app.invite_tokens it SET used_at = pg_catalog.now()
   WHERE it.token_hash = p_token_hash
     AND it.purpose = 'ACCOUNT_INVITE'
     AND it.used_at IS NULL AND it.revoked_at IS NULL
     AND it.expires_at > pg_catalog.now()
  RETURNING it.organization_id, it.user_id INTO v_org, v_user;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'invitation is not usable' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE app.users u SET status = 'ACTIVE', identity_id = p_identity_id
   WHERE u.organization_id = v_org AND u.id = v_user
     AND u.status = 'INVITED' AND u.identity_id IS NULL
     AND EXISTS (SELECT 1 FROM platform.identities i
                  WHERE i.id = p_identity_id AND i.email = u.email AND i.status = 'ACTIVE');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation cannot activate this membership' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE app.invite_tokens it SET revoked_at = pg_catalog.now()
   WHERE it.organization_id = v_org AND it.user_id = v_user
     AND it.used_at IS NULL AND it.revoked_at IS NULL;

  PERFORM pg_catalog.set_config('app.tenant_id', v_org::text, true),
          pg_catalog.set_config('app.user_id', v_user::text, true),
          pg_catalog.set_config('app.actor_kind', 'STAFF', true);

  RETURN QUERY SELECT v_org, v_user;
END
$$;

REVOKE ALL ON FUNCTION app.users_invited_status_guard(), platform.lock_invitation(text),
  platform.complete_invitation(text, app.uuid_v7) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.lock_invitation(text), platform.complete_invitation(text, app.uuid_v7)
  TO app_runtime;
