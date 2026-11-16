-- 0054_reconcile_institution_role_permissions
-- Owner: app_migrator
-- Pilot V1: Universal Institution Role & Permission Synchronization.
--
-- PURPOSE:
-- Synchronizes missing canonical baseline permissions (from migrations 0050-0053: payment gateways,
-- homework assignments, zero-access vault read/enrollment, and adult student privacy consent) into
-- app.role_permissions for all existing tenants.
--
-- ROOT CAUSE REASON FOR THIS MIGRATION:
-- Migrations 0050-0053 inserted permissions using `INSERT INTO app.role_permissions SELECT ... FROM app.roles`.
-- Because app.roles and app.role_permissions have FORCE ROW LEVEL SECURITY enabled with policies scoped TO app_runtime,
-- the migration runner (app_migrator, rolbypassrls = false) had no applicable policy and evaluated to 0 rows.
-- As a result, newly introduced baseline capabilities were omitted from persistent databases.
--
-- TRANSACTIONAL SAFETY & LEAST-PRIVILEGE ASSESSMENT:
-- 1. Transactional Rollback: In PostgreSQL, DDL commands (ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY)
--    and table locks are fully transactional. If any statement or constraint fails, the entire transaction
--    rolls back completely, leaving FORCE ROW LEVEL SECURITY and table state unmodified.
-- 2. Concurrency & Locking: Under `SET LOCAL lock_timeout = '5s'`, explicit `ACCESS EXCLUSIVE` locks on
--    app.roles and app.role_permissions guarantee that no concurrent sessions can read or write during
--    the brief (~10ms) owner exemption.
-- 3. Privilege Boundaries: `NO FORCE` exempts ONLY the table owner (app_migrator). Non-owners (app_runtime)
--    remain 100% bound by Row Level Security at all times.
-- 4. Verification Guardrail: A DO $$ block queries pg_class.relforcerowsecurity to assert that FORCE RLS
--    is fully restored prior to transaction commit.
--
-- STRICT ADDITIVE & PRESERVATION INVARIANTS:
-- 1. Strictly additive (DO NOTHING on conflict): Never overwrites customized scope modes, institution-specific
--    grants, or deliberate restrictions. Existing rows are preserved untouched.
-- 2. NO AUTOMATIC CRITICAL GRANTS: Critical financial credentials (fee.gateway.manage, fee.refund.initiate)
--    and unrestricted cryptographic authority (vault.authority.manage, vault.device.manage, vault.recovery.initiate,
--    vault.grant.issue) are deliberately EXCLUDED. They require separately approved institutional appointment.
-- 3. Grants safe baseline operational capabilities only:
--    - fee.gateway.read (Principal can view Gateway Settings tab)
--    - fee.payment.initiate (Authorized student/admin dues payment)
--    - homework.manage, homework.review, homework.read, homework.submit (Homework workflow)
--    - vault.authority.read (Principal can view Security Center status)
--    - vault.device.enroll (Users can enroll their own hardware credentials)
--    - vault.record.read, vault.record.write (Scoped zero-access encrypted records)
--    - adult.consent.manage (Adult student privacy delegation)

SET LOCAL lock_timeout = '5s';

-- 1. Acquire exclusive lock and temporarily unforce RLS for table owner app_migrator
LOCK TABLE app.roles, app.role_permissions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE app.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions NO FORCE ROW LEVEL SECURITY;

-- 2. Ensure PARENT role exists in app.roles for all active organizations (remedying 0051 RLS trap)
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

-- 3. Report any existing scope conflicts for human review without mutating them
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
          ('COLLEGE_ADMIN', 'fee.gateway.read', 'GRANTED'),
          ('COLLEGE_ADMIN', 'fee.payment.initiate', 'GRANTED'),
          ('COLLEGE_ADMIN', 'homework.manage', 'GRANTED'),
          ('COLLEGE_ADMIN', 'homework.review', 'GRANTED'),
          ('COLLEGE_ADMIN', 'homework.read', 'GRANTED'),
          ('FACULTY', 'homework.manage', 'ASSIGNED'),
          ('FACULTY', 'homework.review', 'ASSIGNED'),
          ('FACULTY', 'homework.read', 'ASSIGNED'),
          ('STUDENT', 'homework.read', 'SELF'),
          ('STUDENT', 'homework.submit', 'SELF'),
          ('COLLEGE_ADMIN', 'vault.authority.read', 'GRANTED'),
          ('COLLEGE_ADMIN', 'vault.device.enroll', 'SELF'),
          ('COLLEGE_ADMIN', 'vault.record.read', 'GRANTED'),
          ('COLLEGE_ADMIN', 'vault.record.write', 'GRANTED'),
          ('FACULTY', 'vault.record.read', 'ASSIGNED'),
          ('FACULTY', 'vault.record.write', 'ASSIGNED')
      ) AS p(role_code, perm, mode) ON p.role_code = r.code AND p.perm = rp.permission_code
     WHERE rp.scope_mode != p.mode
  LOOP
    RAISE NOTICE 'Preserved institution customization for org % role % perm %: existing scope % preserved over canonical %',
      v_conflict.organization_id, v_conflict.role_code, v_conflict.permission_code, v_conflict.existing_scope, v_conflict.canonical_scope;
  END LOOP;
END $$;

-- 4. Additive reconciliation of safe baseline role permissions (DO NOTHING preserves existing customizations)
INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.perm, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      -- 0050 Payment Gateway & Online Collections (Safe Baseline)
      ('COLLEGE_ADMIN', 'fee.gateway.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.payment.initiate', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.gateway.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.payment.initiate', 'GRANTED'),
      ('REGISTRAR', 'fee.gateway.read', 'GRANTED'),
      ('REGISTRAR', 'fee.payment.initiate', 'GRANTED'),
      ('STUDENT', 'fee.payment.initiate', 'SELF'),

      -- 0051 Parent Identity & Portal (Safe Baseline)
      ('PARENT', 'session.read', 'SELF'),
      ('PARENT', 'session.revoke', 'SELF'),
      ('PARENT', 'auth.mfa.manage', 'SELF'),
      ('PARENT', 'parent.portal.access', 'SELF'),
      ('PARENT', 'parent.student.read', 'SELF'),
      ('PARENT', 'parent.attendance.read', 'SELF'),
      ('PARENT', 'parent.academics.read', 'SELF'),
      ('PARENT', 'parent.exam.read', 'SELF'),
      ('PARENT', 'parent.fee.read', 'SELF'),
      ('PARENT', 'parent.fee.pay', 'SELF'),
      ('PARENT', 'notification.read', 'SELF'),
      ('PARENT', 'notification.preference.manage', 'SELF'),
      ('PARENT', 'consent.read', 'SELF'),

      -- 0052 Homework & Assignments (Safe Baseline)
      ('COLLEGE_ADMIN', 'homework.manage', 'GRANTED'),
      ('COLLEGE_ADMIN', 'homework.review', 'GRANTED'),
      ('COLLEGE_ADMIN', 'homework.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.manage', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.review', 'GRANTED'),
      ('CAMPUS_ADMIN', 'homework.read', 'GRANTED'),
      ('REGISTRAR', 'homework.manage', 'GRANTED'),
      ('REGISTRAR', 'homework.review', 'GRANTED'),
      ('REGISTRAR', 'homework.read', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.manage', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.review', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'homework.read', 'GRANTED'),
      ('HOD', 'homework.manage', 'GRANTED'),
      ('HOD', 'homework.review', 'GRANTED'),
      ('HOD', 'homework.read', 'GRANTED'),
      ('FACULTY', 'homework.manage', 'ASSIGNED'),
      ('FACULTY', 'homework.review', 'ASSIGNED'),
      ('FACULTY', 'homework.read', 'ASSIGNED'),
      ('STUDENT', 'homework.read', 'SELF'),
      ('STUDENT', 'homework.submit', 'SELF'),

      -- 0053 School Vault & Privacy Consent (Safe Baseline)
      ('COLLEGE_ADMIN', 'vault.authority.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'vault.device.enroll', 'SELF'),
      ('COLLEGE_ADMIN', 'vault.record.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'vault.record.write', 'GRANTED'),
      ('COLLEGE_ADMIN', 'adult.consent.manage', 'GRANTED'),
      ('CAMPUS_ADMIN', 'vault.authority.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'vault.device.enroll', 'SELF'),
      ('CAMPUS_ADMIN', 'vault.record.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'vault.record.write', 'GRANTED'),
      ('CAMPUS_ADMIN', 'adult.consent.manage', 'GRANTED'),
      ('REGISTRAR', 'vault.authority.read', 'GRANTED'),
      ('REGISTRAR', 'vault.device.enroll', 'SELF'),
      ('REGISTRAR', 'vault.record.read', 'GRANTED'),
      ('REGISTRAR', 'vault.record.write', 'GRANTED'),
      ('REGISTRAR', 'adult.consent.manage', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'vault.authority.read', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'vault.device.enroll', 'SELF'),
      ('DEPARTMENT_ADMIN', 'vault.record.read', 'GRANTED'),
      ('DEPARTMENT_ADMIN', 'vault.record.write', 'GRANTED'),
      ('HOD', 'vault.authority.read', 'GRANTED'),
      ('HOD', 'vault.device.enroll', 'SELF'),
      ('HOD', 'vault.record.read', 'GRANTED'),
      ('HOD', 'vault.record.write', 'GRANTED'),
      ('FACULTY', 'vault.device.enroll', 'SELF'),
      ('FACULTY', 'vault.record.read', 'ASSIGNED'),
      ('FACULTY', 'vault.record.write', 'ASSIGNED'),
      ('STAFF', 'vault.device.enroll', 'SELF'),
      ('STUDENT', 'vault.device.enroll', 'SELF'),
      ('STUDENT', 'vault.record.read', 'SELF'),
      ('STUDENT', 'vault.record.write', 'SELF'),
      ('STUDENT', 'adult.consent.manage', 'SELF')
  ) AS p(role_code, perm, mode)
 WHERE r.code = p.role_code
   AND EXISTS (SELECT 1 FROM platform.permissions WHERE code = p.perm)
ON CONFLICT (organization_id, role_id, permission_code) DO NOTHING;

-- 5. Restore and verify FORCE ROW LEVEL SECURITY
ALTER TABLE app.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.role_permissions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'roles' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.relname = 'role_permissions' AND c.relnamespace = 'app'::regnamespace AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY verification failed on roles/role_permissions';
  END IF;
END $$;
