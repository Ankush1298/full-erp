-- 0049_invitation_mfa_onboarding_ticket
-- Owner: app_migrator
-- Security remediation (Task A, 2026-11-09): Self-service MFA onboarding ticket issuance during invitation acceptance.
--
-- WHAT THIS CHANGES:
-- Table app.mfa_enrollment_tickets enforces FORCE ROW LEVEL SECURITY, and existing policies for app_migrator
-- only covered SELECT and UPDATE for admin resets (migration 0030).
-- When an invited user accepts their invitation, app.current_user_id() is the newly activated user, so
-- direct INSERT by app_runtime fails closed with an RLS violation under mfa_enrollment_tickets_issuer_insert.
--
-- This migration defines:
-- 1. Narrow owner policies allowing app_migrator to insert and revoke tickets during validated invitation onboarding.
-- 2. A SECURITY DEFINER function:
--    platform.mint_invitation_mfa_ticket(p_token_hash text, p_ticket_id app.uuid_v7, p_code_hash text)
--
-- SECURITY INVARIANTS:
-- 1. Strictly bound to a validated invitation: p_token_hash must match a row in app.invite_tokens with
--    purpose = 'ACCOUNT_INVITE' that was consumed (used_at IS NOT NULL) within the past 5 minutes.
-- 2. Fixed target: binds to (organization_id, user_id) from the invitation record. Arbitrary callers cannot
--    choose or escalate tenant or user.
-- 3. First-admin bootstrap protection: If created_by = user_id in the invitation (the first-admin marker),
--    the function refuses to mint a ticket and returns false. First-platform-administrator bootstrap remains
--    a separate privileged operational process.
-- 4. Single-use and revocation: revokes any existing unconsumed enrollment tickets for the user before
--    inserting a fresh 24-hour ticket.
-- 5. Hardened execution: owned by app_migrator, SECURITY DEFINER, SET search_path = pg_catalog.
--    Revoked from PUBLIC, granted strictly to app_runtime.

SET LOCAL lock_timeout = '5s';

-- 1. Permissive policies for app_migrator during invitation onboarding under FORCE ROW LEVEL SECURITY
CREATE POLICY mfa_enrollment_tickets_invitation_insert ON app.mfa_enrollment_tickets AS PERMISSIVE FOR INSERT TO app_migrator
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator' AND used_at IS NULL AND revoked_at IS NULL);

CREATE POLICY mfa_enrollment_tickets_invitation_update ON app.mfa_enrollment_tickets AS PERMISSIVE FOR UPDATE TO app_migrator
  USING (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator' AND used_at IS NULL AND revoked_at IS NULL)
  WITH CHECK (session_user::text = 'app_runtime' AND current_user::text = 'app_migrator' AND revoked_at IS NOT NULL);

-- 2. Hardened minting function
CREATE FUNCTION platform.mint_invitation_mfa_ticket(
  p_token_hash text,
  p_ticket_id app.uuid_v7,
  p_code_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_org app.uuid_v7;
  v_user app.uuid_v7;
  v_creator app.uuid_v7;
BEGIN
  -- 1. Locate the consumed invitation by its hash
  SELECT it.organization_id, it.user_id, it.created_by
    INTO v_org, v_user, v_creator
    FROM app.invite_tokens it
   WHERE it.token_hash = p_token_hash
     AND it.purpose = 'ACCOUNT_INVITE'
     AND it.used_at IS NOT NULL
     AND it.used_at >= pg_catalog.now() - interval '5 minutes';

  IF v_org IS NULL THEN
    RETURN false;
  END IF;

  -- 2. First-administrator bootstrap guard:
  -- If v_creator = v_user, this is the initial administrator bootstrap invitation.
  -- Initial bootstrap tickets remain strictly controlled by the platform operator CLI tool.
  IF v_creator = v_user THEN
    RETURN false;
  END IF;

  -- 3. Verify creator is an existing user in this tenant (not self)
  IF NOT EXISTS (
    SELECT 1 FROM app.users u
     WHERE u.organization_id = v_org AND u.id = v_creator
  ) THEN
    RETURN false;
  END IF;

  -- 4. Revoke any prior unconsumed enrollment tickets for this user in this tenant
  UPDATE app.mfa_enrollment_tickets
     SET revoked_at = pg_catalog.now()
   WHERE organization_id = v_org
     AND user_id = v_user
     AND used_at IS NULL
     AND revoked_at IS NULL;

  -- 5. Insert new 24-hour onboarding ticket
  INSERT INTO app.mfa_enrollment_tickets (
    id,
    organization_id,
    user_id,
    code_hash,
    created_by,
    created_at,
    expires_at
  ) VALUES (
    p_ticket_id,
    v_org,
    v_user,
    p_code_hash,
    v_creator,
    pg_catalog.now(),
    pg_catalog.now() + interval '24 hours'
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION platform.mint_invitation_mfa_ticket(text, app.uuid_v7, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.mint_invitation_mfa_ticket(text, app.uuid_v7, text) TO app_runtime;
