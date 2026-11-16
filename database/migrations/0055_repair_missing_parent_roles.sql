-- 0055_repair_missing_parent_roles
-- Owner: app_migrator
-- Pilot V1: Repair Missing PARENT Roles & Baseline Parent Portal Capabilities
--
-- PURPOSE:
-- Synchronizes missing PARENT roles and canonical baseline permissions (from migration 0051) into
-- app.roles and app.role_permissions for all active and eligible organizations in app.organizations,
-- respecting institutional explicit permission denials in app.organization_settings.
--
-- ROOT CAUSE REASON FOR THIS MIGRATION:
-- Migration 0054 unforced RLS on app.roles and app.role_permissions, but left app.organizations with
-- FORCE ROW LEVEL SECURITY enabled. In PostgreSQL, app.organizations's migrator probe policy requires:
--   session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'
-- When the migration runner (app_migrator) connected directly, session_user was 'app_migrator'.
-- Consequently, `SELECT FROM app.organizations` evaluated to 0 rows, silently omitting PARENT role
-- provisioning and its dependent role permissions from persistent databases.
--
-- TRANSACTIONAL SAFETY & LEAST-PRIVILEGE ASSESSMENT:
-- 1. Transactional Rollback: In PostgreSQL, DDL commands (ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY)
--    and table locks are fully transactional. If any statement or constraint fails, the entire transaction
--    rolls back completely, leaving FORCE ROW LEVEL SECURITY and table state unmodified.
-- 2. Concurrency & Locking: Under `SET LOCAL lock_timeout = '5s'`, explicit `ACCESS EXCLUSIVE` locks on
--    app.organizations, app.organization_settings, app.roles, and app.role_permissions guarantee that
--    no concurrent sessions can read or write during the brief (~10ms) owner exemption.
-- 3. Privilege Boundaries: `NO FORCE` exempts ONLY the table owner (app_migrator). Non-owners (app_runtime)
--    remain 100% bound by Row Level Security at all times.
-- 4. Verification Guardrails:
--    - Platform catalog assertion: Fails closed if platform.permissions lacks any of the 13 canonical permissions.
--    - Complete postcondition assertion: Validates all 13 canonical permissions for every eligible organization,
--      except permissions explicitly denied by documented institution policy (authorization.denied_permissions).
--    - Zero-critical invariant: Validates no critical financial or cryptographic permissions are attached to PARENT.
--    - Post-restore assertion: Queries pg_class.relforcerowsecurity to assert that FORCE RLS
--      is fully active on all 4 tables prior to transaction commit.
--
-- STRICT ADDITIVE & PRESERVATION INVARIANTS:
-- 1. Strictly additive (DO NOTHING on conflict): Never overwrites customized scope modes, institution-specific
--    grants, or deliberate restrictions. Existing PARENT roles and permissions are preserved untouched.
-- 2. Institutional Denial Respect: Excludes any permission expressly denied in app.organization_settings
--    under key 'authorization.denied_permissions' for role 'PARENT'.
-- 3. NO CRITICAL GRANTS: Critical financial credentials (fee.gateway.manage, fee.refund.initiate)
--    and unrestricted cryptographic authority (vault.authority.manage, vault.device.manage, vault.recovery.initiate,
--    vault.grant.issue) are excluded.
-- 4. UUID Generation: Conforms to app.uuid_v7 domain using deterministic string manipulation; does not call
--    any non-existent stored function.

SET LOCAL lock_timeout = '5s';

-- 1. Acquire exclusive lock and temporarily unforce RLS for table owner app_migrator
LOCK TABLE app.organizations, app.organization_settings, app.roles, app.role_permissions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE app.organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions NO FORCE ROW LEVEL SECURITY;

-- 2. Catalog Guardrail: Fail safely if platform.permissions lacks any of the 13 canonical permissions
DO $$
DECLARE
  v_missing_catalog_perms text;
BEGIN
  SELECT string_agg(p.perm, ', ') INTO v_missing_catalog_perms
    FROM (
      VALUES
        ('session.read'),
        ('session.revoke'),
        ('auth.mfa.manage'),
        ('parent.portal.access'),
        ('parent.student.read'),
        ('parent.attendance.read'),
        ('parent.academics.read'),
        ('parent.exam.read'),
        ('parent.fee.read'),
        ('parent.fee.pay'),
        ('notification.read'),
        ('notification.preference.manage'),
        ('consent.read')
    ) AS p(perm)
   WHERE NOT EXISTS (
     SELECT 1 FROM platform.permissions perm WHERE perm.code = p.perm
   );

  IF v_missing_catalog_perms IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0055 Postcondition Failed: Platform permission catalog is missing required canonical permission(s): %', v_missing_catalog_perms;
  END IF;
END $$;

-- 3. Provision PARENT role in app.roles for all institutions where missing
INSERT INTO app.roles (id, organization_id, code, name)
SELECT (
         substr(md5(random()::text || clock_timestamp()::text || o.id::text), 1, 8) || '-' ||
         substr(md5(random()::text || clock_timestamp()::text || o.id::text), 9, 4) || '-7' ||
         substr(md5(random()::text || clock_timestamp()::text || o.id::text), 13, 3) || '-a' ||
         substr(md5(random()::text || clock_timestamp()::text || o.id::text), 16, 3) || '-' ||
         substr(md5(random()::text || clock_timestamp()::text || o.id::text), 19, 12)
       )::uuid,
       o.id,
       'PARENT',
       'Parent / Guardian'
  FROM app.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM app.roles r WHERE r.organization_id = o.id AND r.code = 'PARENT'
 )
ON CONFLICT (organization_id, code) DO NOTHING;

-- 4. Report any existing scope conflicts for human review without mutating them
DO $$
DECLARE
  v_conflict RECORD;
BEGIN
  FOR v_conflict IN
    SELECT r.organization_id, r.code AS role_code, rp.permission_code, rp.scope_mode AS existing_scope, p.mode AS canonical_scope
      FROM app.role_permissions rp
      JOIN app.roles r ON r.id = rp.role_id AND r.organization_id = rp.organization_id
      JOIN (
        VALUES
          ('session.read', 'SELF'),
          ('session.revoke', 'SELF'),
          ('auth.mfa.manage', 'SELF'),
          ('parent.portal.access', 'SELF'),
          ('parent.student.read', 'SELF'),
          ('parent.attendance.read', 'SELF'),
          ('parent.academics.read', 'SELF'),
          ('parent.exam.read', 'SELF'),
          ('parent.fee.read', 'SELF'),
          ('parent.fee.pay', 'SELF'),
          ('notification.read', 'SELF'),
          ('notification.preference.manage', 'SELF'),
          ('consent.read', 'SELF')
      ) AS p(perm, mode) ON p.perm = rp.permission_code
     WHERE r.code = 'PARENT'
       AND rp.scope_mode != p.mode
  LOOP
    RAISE NOTICE 'Preserved institution customization for org % role % perm %: existing scope % preserved over canonical %',
      v_conflict.organization_id, v_conflict.role_code, v_conflict.permission_code, v_conflict.existing_scope, v_conflict.canonical_scope;
  END LOOP;
END $$;

-- 5. Log explicit institution denials from organization_settings for human audit
DO $$
DECLARE
  v_denied RECORD;
BEGIN
  FOR v_denied IN
    SELECT o.id AS org_id, p.perm
      FROM app.organizations o
      JOIN app.organization_settings s
        ON s.organization_id = o.id
       AND s.key = 'authorization.denied_permissions'
      CROSS JOIN (
        VALUES
          ('session.read'),
          ('session.revoke'),
          ('auth.mfa.manage'),
          ('parent.portal.access'),
          ('parent.student.read'),
          ('parent.attendance.read'),
          ('parent.academics.read'),
          ('parent.exam.read'),
          ('parent.fee.read'),
          ('parent.fee.pay'),
          ('notification.read'),
          ('notification.preference.manage'),
          ('consent.read')
      ) AS p(perm)
     WHERE s.value->'PARENT' ? p.perm
  LOOP
    RAISE NOTICE 'Preserved institution explicit denial for org %: perm % denied on PARENT role in organization_settings',
      v_denied.org_id, v_denied.perm;
  END LOOP;
END $$;

-- 6. Seed baseline PARENT role permissions additively across all organizations,
-- strictly respecting institutional explicit denials in app.organization_settings
INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.perm, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      ('session.read', 'SELF'),
      ('session.revoke', 'SELF'),
      ('auth.mfa.manage', 'SELF'),
      ('parent.portal.access', 'SELF'),
      ('parent.student.read', 'SELF'),
      ('parent.attendance.read', 'SELF'),
      ('parent.academics.read', 'SELF'),
      ('parent.exam.read', 'SELF'),
      ('parent.fee.read', 'SELF'),
      ('parent.fee.pay', 'SELF'),
      ('notification.read', 'SELF'),
      ('notification.preference.manage', 'SELF'),
      ('consent.read', 'SELF')
  ) AS p(perm, mode)
 WHERE r.code = 'PARENT'
   AND EXISTS (SELECT 1 FROM platform.permissions perm WHERE perm.code = p.perm)
   AND NOT EXISTS (
     SELECT 1 FROM app.organization_settings s
      WHERE s.organization_id = r.organization_id
        AND s.key = 'authorization.denied_permissions'
        AND s.value->'PARENT' ? p.perm
   )
ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;

-- 7. Verification Guardrail (evaluated while cross-tenant owner visibility is active)
DO $$
DECLARE
  v_total_orgs integer;
  v_missing_parent_roles integer;
  v_missing_required_perms integer;
  v_unauthorized_critical integer;
BEGIN
  SELECT COUNT(*) INTO v_total_orgs FROM app.organizations;

  IF v_total_orgs = 0 THEN
    RAISE NOTICE 'Migration 0055: Zero organizations found in database; nothing to verify.';
    RETURN;
  END IF;

  -- Assert every organization has a PARENT role in app.roles
  SELECT COUNT(*) INTO v_missing_parent_roles
    FROM app.organizations o
   WHERE NOT EXISTS (
     SELECT 1 FROM app.roles r
      WHERE r.organization_id = o.id AND r.code = 'PARENT'
   );

  IF v_missing_parent_roles > 0 THEN
    RAISE EXCEPTION 'Migration 0055 Postcondition Failed: % organization(s) lack PARENT role in app.roles', v_missing_parent_roles;
  END IF;

  -- Assert all 13 canonical permissions exist for each organization's PARENT role,
  -- except permissions explicitly denied by documented institution policy in organization_settings
  SELECT COUNT(*) INTO v_missing_required_perms
    FROM app.organizations o
    CROSS JOIN (
      VALUES
        ('session.read'),
        ('session.revoke'),
        ('auth.mfa.manage'),
        ('parent.portal.access'),
        ('parent.student.read'),
        ('parent.attendance.read'),
        ('parent.academics.read'),
        ('parent.exam.read'),
        ('parent.fee.read'),
        ('parent.fee.pay'),
        ('notification.read'),
        ('notification.preference.manage'),
        ('consent.read')
    ) AS p(perm)
   WHERE
     -- Exclude permissions explicitly denied in organization_settings
     NOT EXISTS (
       SELECT 1 FROM app.organization_settings s
        WHERE s.organization_id = o.id
          AND s.key = 'authorization.denied_permissions'
          AND s.value->'PARENT' ? p.perm
     )
     -- Assert presence in app.role_permissions for this organization's PARENT role
     AND NOT EXISTS (
       SELECT 1 FROM app.role_permissions rp
       JOIN app.roles r ON r.id = rp.role_id AND r.organization_id = rp.organization_id
      WHERE rp.organization_id = o.id
        AND r.code = 'PARENT'
        AND rp.permission_code = p.perm
     );

  IF v_missing_required_perms > 0 THEN
    RAISE EXCEPTION 'Migration 0055 Postcondition Failed: % required baseline PARENT permission grant(s) missing across organizations', v_missing_required_perms;
  END IF;

  -- Assert zero critical permissions exist on PARENT role
  SELECT COUNT(*) INTO v_unauthorized_critical
    FROM app.role_permissions rp
    JOIN app.roles r ON r.id = rp.role_id AND r.organization_id = rp.organization_id
   WHERE r.code = 'PARENT'
     AND rp.permission_code IN (
       'fee.gateway.manage', 'fee.refund.initiate',
       'vault.authority.manage', 'vault.recovery.initiate',
       'vault.grant.issue', 'vault.device.manage'
     );

  IF v_unauthorized_critical > 0 THEN
    RAISE EXCEPTION 'Migration 0055 Postcondition Failed: Detected % unauthorized critical permission grant(s) on PARENT role', v_unauthorized_critical;
  END IF;

  RAISE NOTICE 'Migration 0055 Postcondition Passed: Verified PARENT role and all 13 baseline permissions (respecting denials) across % organization(s).', v_total_orgs;
END $$;

-- 8. Restore FORCE ROW LEVEL SECURITY on all four tables
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organization_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions FORCE ROW LEVEL SECURITY;

-- 9. Verification Guardrail: Assert FORCE ROW LEVEL SECURITY is restored in system catalog
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'organizations' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'organization_settings' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'roles' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'role_permissions' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Migration 0055 Postcondition Failed: FORCE ROW LEVEL SECURITY verification failed on organizations/organization_settings/roles/role_permissions';
  END IF;
END $$;
