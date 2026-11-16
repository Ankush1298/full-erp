-- 0051_parent_identity_and_portal
-- Owner: app_migrator
-- Pilot V1: Authenticated Parent / Guardian Portal & Verified Student Links.
-- Specification: Guardian identity link to app.users, PARENT role seeding,
-- parent portal permissions, and verified parent-child relationship authorization.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Link app.guardians to app.users
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.guardians
  ADD COLUMN user_id app.uuid_v7,
  ADD CONSTRAINT guardians_user_fk
    FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id)
    ON DELETE SET NULL;

CREATE INDEX guardians_org_user_ix
  ON app.guardians (organization_id, user_id)
  WHERE user_id IS NOT NULL;

GRANT UPDATE (user_id) ON app.guardians TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 2. Platform Permissions for Parent Portal
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('parent.portal.access', 'NORMAL'),
  ('parent.student.read', 'SENSITIVE'),
  ('parent.attendance.read', 'SENSITIVE'),
  ('parent.academics.read', 'SENSITIVE'),
  ('parent.exam.read', 'SENSITIVE'),
  ('parent.fee.read', 'SENSITIVE'),
  ('parent.fee.pay', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 3. Seed PARENT Role and Permissions for all Organizations
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  org RECORD;
  parent_role_id app.uuid_v7;
BEGIN
  FOR org IN SELECT id FROM app.organizations LOOP
    -- Insert PARENT role if not present
    INSERT INTO app.roles (id, organization_id, code, name)
    VALUES (app.uuid_v7(), org.id, 'PARENT', 'Parent / Guardian')
    ON CONFLICT (organization_id, code) DO NOTHING;

    SELECT id INTO parent_role_id FROM app.roles
    WHERE organization_id = org.id AND code = 'PARENT';

    IF parent_role_id IS NOT NULL THEN
      -- Seed permissions for PARENT role
      INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode) VALUES
        (org.id, parent_role_id, 'session.read', 'SELF'),
        (org.id, parent_role_id, 'session.revoke', 'SELF'),
        (org.id, parent_role_id, 'auth.mfa.manage', 'SELF'),
        (org.id, parent_role_id, 'parent.portal.access', 'SELF'),
        (org.id, parent_role_id, 'parent.student.read', 'SELF'),
        (org.id, parent_role_id, 'parent.attendance.read', 'SELF'),
        (org.id, parent_role_id, 'parent.academics.read', 'SELF'),
        (org.id, parent_role_id, 'parent.exam.read', 'SELF'),
        (org.id, parent_role_id, 'parent.fee.read', 'SELF'),
        (org.id, parent_role_id, 'parent.fee.pay', 'SELF'),
        (org.id, parent_role_id, 'notification.read', 'SELF'),
        (org.id, parent_role_id, 'notification.preference.manage', 'SELF'),
        (org.id, parent_role_id, 'consent.read', 'SELF')
      ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Helper Function: app.guardian_authorized_student_ids()
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.guardian_authorized_student_ids()
RETURNS TABLE(student_id app.uuid_v7)
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
  SELECT sg.student_id
    FROM app.student_guardians sg
    JOIN app.guardians g ON g.id = sg.guardian_id AND g.organization_id = sg.organization_id
   WHERE g.organization_id = app.current_tenant_id()
     AND g.user_id = app.current_user_id()
     AND g.deleted_at IS NULL
     AND (sg.valid_to IS NULL OR sg.valid_to >= (now() AT TIME ZONE 'UTC')::date)
     AND sg.valid_from <= (now() AT TIME ZONE 'UTC')::date;
$$;

GRANT EXECUTE ON FUNCTION app.guardian_authorized_student_ids() TO app_runtime;
