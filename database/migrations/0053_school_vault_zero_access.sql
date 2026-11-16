-- 0053_school_vault_zero_access.sql
-- Anesa School Vault: True Zero-Access Encryption, Device-Bound Authenticators,
-- Institutional Security Authority, Scoped Key Grants, 2-of-3 Recovery Quorum,
-- and Universal Institution Compatibility (School / College / University).

-- -------------------------------------------------------------------------------------------------
-- 0. Universal Institution Type on Organization & Platform Permissions
-- -------------------------------------------------------------------------------------------------
ALTER TABLE app.organizations
  ADD COLUMN IF NOT EXISTS institution_type text NOT NULL DEFAULT 'SCHOOL'
  CHECK (institution_type IN ('SCHOOL', 'COLLEGE', 'UNIVERSITY'));

INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('vault.authority.manage', 'CRITICAL'),
  ('vault.authority.read', 'SENSITIVE'),
  ('vault.device.enroll', 'NORMAL'),
  ('vault.device.manage', 'CRITICAL'),
  ('vault.recovery.initiate', 'CRITICAL'),
  ('vault.grant.issue', 'CRITICAL'),
  ('vault.record.read', 'SENSITIVE'),
  ('vault.record.write', 'SENSITIVE'),
  ('adult.consent.manage', 'SENSITIVE')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- -------------------------------------------------------------------------------------------------
-- 1. Institutional Security Authority (ISA)
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.institution_security_authorities (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  user_id                 app.uuid_v7 NOT NULL,
  title                   text NOT NULL CHECK (title IN (
                            'SCHOOL_OWNER', 'SCHOOL_PRINCIPAL',
                            'COLLEGE_PRINCIPAL', 'COLLEGE_DEAN',
                            'UNIVERSITY_CHANCELLOR', 'UNIVERSITY_VICE_CHANCELLOR',
                            'UNIVERSITY_REGISTRAR', 'DESIGNATED_SECURITY_AUTHORITY'
                          )),
  institution_type        text NOT NULL DEFAULT 'SCHOOL' CHECK (institution_type IN ('SCHOOL', 'COLLEGE', 'UNIVERSITY')),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELEGATED', 'SUCCESSION_PENDING', 'REVOKED')),
  appointed_by_user_id    app.uuid_v7 NOT NULL,
  appointed_at            timestamptz NOT NULL DEFAULT now(),
  delegated_to_user_id    app.uuid_v7,
  delegated_at            timestamptz,
  revoked_at              timestamptz,
  notes                   text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT isa_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT isa_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT isa_appointed_by_fk FOREIGN KEY (organization_id, appointed_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT isa_org_id_uq UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX isa_org_active_uq ON app.institution_security_authorities (organization_id) WHERE (status = 'ACTIVE');
CREATE INDEX isa_org_user_ix ON app.institution_security_authorities (organization_id, user_id);
CREATE INDEX isa_org_appointed_by_ix ON app.institution_security_authorities (organization_id, appointed_by_user_id);

-- -------------------------------------------------------------------------------------------------
-- 2. Vault Epochs & Root Metadata
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.institution_vault_epochs (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  epoch                   integer NOT NULL CHECK (epoch > 0),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ROTATED', 'COMPROMISED_REVOKED')),
  smek_public_key         text NOT NULL, -- Base64 encoded ECDH/HPKE public key for the epoch
  rotation_reason         text CHECK (rotation_reason IS NULL OR char_length(rotation_reason) <= 500),
  created_by_user_id      app.uuid_v7 NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  rotated_at              timestamptz,
  CONSTRAINT vault_epoch_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT vault_epoch_uq UNIQUE (organization_id, epoch),
  CONSTRAINT vault_epoch_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX vault_epoch_org_status_ix ON app.institution_vault_epochs (organization_id, status);

-- -------------------------------------------------------------------------------------------------
-- 3. Device-Bound Authenticators & Encryption Keypairs (Strict 2 Devices Limit)
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.user_vault_devices (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  user_id                 app.uuid_v7 NOT NULL,
  device_number           integer NOT NULL CHECK (device_number IN (1, 2)),
  device_label            text NOT NULL CHECK (char_length(device_label) BETWEEN 1 AND 100),
  device_type             text NOT NULL DEFAULT 'PLATFORM_AUTHENTICATOR' CHECK (device_type IN ('PLATFORM_AUTHENTICATOR', 'SECURITY_KEY')),
  public_key              text NOT NULL,
  attestation_format      text,
  attestation_blob        text,
  aaguid                  text,
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  last_used_at            timestamptz,
  revoked_at              timestamptz,
  revoked_reason          text CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 500),
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uvd_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT uvd_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT uvd_org_id_uq UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX uvd_user_device_num_uq ON app.user_vault_devices (organization_id, user_id, device_number) WHERE (status = 'ACTIVE');
CREATE INDEX uvd_org_user_ix ON app.user_vault_devices (organization_id, user_id);

-- -------------------------------------------------------------------------------------------------
-- 4. Scoped Capability Key Grants
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.vault_key_grants (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  vault_epoch_id          app.uuid_v7 NOT NULL,
  device_id               app.uuid_v7 NOT NULL,
  user_id                 app.uuid_v7 NOT NULL,
  capability_key_name     text NOT NULL CHECK (capability_key_name IN (
                            'CWK_STUDENTS_PII',
                            'CWK_ACADEMICS_MARKS',
                            'CWK_HOMEWORK_SUBMISSIONS',
                            'CWK_FINANCE_PRIVATE',
                            'CWK_DOCUMENTS_VAULT'
                          )),
  scope_type              text NOT NULL DEFAULT 'ORGANIZATION' CHECK (scope_type IN (
                            'ORGANIZATION', 'CAMPUS', 'DEPARTMENT', 'COURSE_OFFERING', 'SECTION', 'SELF'
                          )),
  scope_target_id         app.uuid_v7,
  wrapped_capability_key  text NOT NULL,
  ephemeral_public_key    text NOT NULL,
  iv                      text NOT NULL,
  tag                     text NOT NULL,
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
  issued_by_user_id       app.uuid_v7 NOT NULL,
  expires_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vkg_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT vkg_epoch_fk FOREIGN KEY (organization_id, vault_epoch_id)
    REFERENCES app.institution_vault_epochs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT vkg_device_fk FOREIGN KEY (organization_id, device_id)
    REFERENCES app.user_vault_devices (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT vkg_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT vkg_issued_by_fk FOREIGN KEY (organization_id, issued_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT vkg_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX vkg_org_user_device_ix ON app.vault_key_grants (organization_id, user_id, device_id, status);
CREATE INDEX vkg_org_scope_target_ix ON app.vault_key_grants (organization_id, capability_key_name, scope_type, scope_target_id);
CREATE INDEX vkg_org_epoch_ix ON app.vault_key_grants (organization_id, vault_epoch_id);
CREATE INDEX vkg_org_device_ix ON app.vault_key_grants (organization_id, device_id);
CREATE INDEX vkg_org_issued_by_ix ON app.vault_key_grants (organization_id, issued_by_user_id);

-- -------------------------------------------------------------------------------------------------
-- 5. 2-of-3 School Recovery Quorum
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.institution_recovery_custodians (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  vault_epoch_id          app.uuid_v7 NOT NULL,
  share_index             integer NOT NULL CHECK (share_index BETWEEN 1 AND 3),
  custodian_name          text NOT NULL CHECK (char_length(custodian_name) BETWEEN 2 AND 100),
  custodian_role          text NOT NULL CHECK (char_length(custodian_role) BETWEEN 2 AND 100),
  custodian_email         text,
  share_commitment        text,
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'REVOKED')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT irc_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT irc_epoch_fk FOREIGN KEY (organization_id, vault_epoch_id)
    REFERENCES app.institution_vault_epochs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT irc_org_epoch_share_uq UNIQUE (organization_id, vault_epoch_id, share_index),
  CONSTRAINT irc_org_id_uq UNIQUE (organization_id, id)
);

CREATE TABLE app.institution_recovery_ceremonies (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  vault_epoch_id          app.uuid_v7 NOT NULL,
  target_user_id          app.uuid_v7 NOT NULL,
  status                  text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'REJECTED', 'EXPIRED')),
  required_shares         integer NOT NULL DEFAULT 2,
  shares_presented        integer NOT NULL DEFAULT 0 CHECK (shares_presented BETWEEN 0 AND 3),
  presented_share_indices integer[] NOT NULL DEFAULT '{}',
  reason                  text CHECK (reason IS NULL OR char_length(reason) <= 500),
  initiated_by_user_id    app.uuid_v7 NOT NULL,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ir_ceremony_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT ir_ceremony_epoch_fk FOREIGN KEY (organization_id, vault_epoch_id)
    REFERENCES app.institution_vault_epochs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ir_ceremony_target_user_fk FOREIGN KEY (organization_id, target_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ir_ceremony_initiated_by_fk FOREIGN KEY (organization_id, initiated_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT ir_ceremony_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX ir_ceremony_org_epoch_ix ON app.institution_recovery_ceremonies (organization_id, vault_epoch_id);
CREATE INDEX ir_ceremony_org_target_user_ix ON app.institution_recovery_ceremonies (organization_id, target_user_id);
CREATE INDEX ir_ceremony_org_initiated_by_ix ON app.institution_recovery_ceremonies (organization_id, initiated_by_user_id);

-- -------------------------------------------------------------------------------------------------
-- 6. Zero-Access Protected Records
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.vault_protected_records (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  vault_epoch_id          app.uuid_v7 NOT NULL,
  capability_key_name     text NOT NULL CHECK (capability_key_name IN (
                            'CWK_STUDENTS_PII',
                            'CWK_ACADEMICS_MARKS',
                            'CWK_HOMEWORK_SUBMISSIONS',
                            'CWK_FINANCE_PRIVATE',
                            'CWK_DOCUMENTS_VAULT'
                          )),
  entity_type             text NOT NULL CHECK (entity_type IN ('STUDENT_RECORD', 'EXAM_MARK', 'HOMEWORK_SUBMISSION', 'FEE_LEDGER', 'STUDENT_DOCUMENT')),
  entity_id               app.uuid_v7 NOT NULL,
  ciphertext              text NOT NULL,
  iv                      text NOT NULL,
  auth_tag                text NOT NULL,
  aad_context             jsonb NOT NULL,
  record_version          integer NOT NULL DEFAULT 1 CHECK (record_version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpr_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT vpr_epoch_fk FOREIGN KEY (organization_id, vault_epoch_id)
    REFERENCES app.institution_vault_epochs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT vpr_org_entity_uq UNIQUE (organization_id, entity_type, entity_id),
  CONSTRAINT vpr_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX vpr_org_cap_entity_ix ON app.vault_protected_records (organization_id, capability_key_name, entity_type, entity_id);
CREATE INDEX vpr_org_epoch_ix ON app.vault_protected_records (organization_id, vault_epoch_id);

-- -------------------------------------------------------------------------------------------------
-- 7. Adult Student Guardian Privacy Consents (Higher Ed)
-- -------------------------------------------------------------------------------------------------
CREATE TABLE app.adult_guardian_consents (
  id                      app.uuid_v7 PRIMARY KEY,
  organization_id         app.uuid_v7 NOT NULL,
  student_id              app.uuid_v7 NOT NULL,
  guardian_id             app.uuid_v7 NOT NULL,
  consent_scope           text NOT NULL DEFAULT 'ALL' CHECK (consent_scope IN ('ALL', 'ACADEMICS_ONLY', 'FINANCE_ONLY')),
  status                  text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  granted_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz,
  revoked_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agc_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT agc_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agc_guardian_fk FOREIGN KEY (organization_id, guardian_id)
    REFERENCES app.guardians (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT agc_org_id_uq UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX agc_org_student_guardian_uq ON app.adult_guardian_consents (organization_id, student_id, guardian_id, consent_scope) WHERE (status = 'ACTIVE');

CREATE INDEX agc_org_student_ix ON app.adult_guardian_consents (organization_id, student_id);
CREATE INDEX agc_org_guardian_ix ON app.adult_guardian_consents (organization_id, guardian_id);

-- -------------------------------------------------------------------------------------------------
-- 8. Row Level Security & Runtime Grants
-- -------------------------------------------------------------------------------------------------
ALTER TABLE app.institution_security_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_security_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE app.institution_vault_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_vault_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_vault_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_vault_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE app.vault_key_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vault_key_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE app.institution_recovery_custodians ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_recovery_custodians FORCE ROW LEVEL SECURITY;
ALTER TABLE app.institution_recovery_ceremonies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.institution_recovery_ceremonies FORCE ROW LEVEL SECURITY;
ALTER TABLE app.vault_protected_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vault_protected_records FORCE ROW LEVEL SECURITY;
ALTER TABLE app.adult_guardian_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.adult_guardian_consents FORCE ROW LEVEL SECURITY;

-- Permissive Tenant Scoping Policies (SELECT, INSERT, UPDATE, DELETE)

-- 1. institution_security_authorities
CREATE POLICY isa_tenant_select ON app.institution_security_authorities AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY isa_tenant_insert ON app.institution_security_authorities AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY isa_tenant_update ON app.institution_security_authorities AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY isa_tenant_delete ON app.institution_security_authorities AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 2. institution_vault_epochs
CREATE POLICY vault_epochs_tenant_select ON app.institution_vault_epochs AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vault_epochs_tenant_insert ON app.institution_vault_epochs AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vault_epochs_tenant_update ON app.institution_vault_epochs AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vault_epochs_tenant_delete ON app.institution_vault_epochs AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 3. user_vault_devices
CREATE POLICY uvd_tenant_select ON app.user_vault_devices AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY uvd_tenant_insert ON app.user_vault_devices AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY uvd_tenant_update ON app.user_vault_devices AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY uvd_tenant_delete ON app.user_vault_devices AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 4. vault_key_grants
CREATE POLICY vkg_tenant_select ON app.vault_key_grants AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vkg_tenant_insert ON app.vault_key_grants AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vkg_tenant_update ON app.vault_key_grants AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vkg_tenant_delete ON app.vault_key_grants AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 5. institution_recovery_custodians
CREATE POLICY irc_tenant_select ON app.institution_recovery_custodians AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY irc_tenant_insert ON app.institution_recovery_custodians AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY irc_tenant_update ON app.institution_recovery_custodians AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY irc_tenant_delete ON app.institution_recovery_custodians AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 6. institution_recovery_ceremonies
CREATE POLICY ir_ceremony_tenant_select ON app.institution_recovery_ceremonies AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY ir_ceremony_tenant_insert ON app.institution_recovery_ceremonies AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY ir_ceremony_tenant_update ON app.institution_recovery_ceremonies AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY ir_ceremony_tenant_delete ON app.institution_recovery_ceremonies AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 7. vault_protected_records
CREATE POLICY vpr_tenant_select ON app.vault_protected_records AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vpr_tenant_insert ON app.vault_protected_records AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vpr_tenant_update ON app.vault_protected_records AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY vpr_tenant_delete ON app.vault_protected_records AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- 8. adult_guardian_consents
CREATE POLICY agc_tenant_select ON app.adult_guardian_consents AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY agc_tenant_insert ON app.adult_guardian_consents AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY agc_tenant_update ON app.adult_guardian_consents AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY agc_tenant_delete ON app.adult_guardian_consents AS PERMISSIVE FOR DELETE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Grant access to app_runtime (least-privilege: NO DELETE)
GRANT SELECT, INSERT, UPDATE ON
  app.institution_security_authorities,
  app.institution_vault_epochs,
  app.user_vault_devices,
  app.vault_key_grants,
  app.institution_recovery_custodians,
  app.institution_recovery_ceremonies,
  app.vault_protected_records,
  app.adult_guardian_consents
TO app_runtime;

-- Immutability triggers on id and organization_id
CREATE TRIGGER isa_immutable
  BEFORE UPDATE ON app.institution_security_authorities
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER vault_epochs_immutable
  BEFORE UPDATE ON app.institution_vault_epochs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER uvd_immutable
  BEFORE UPDATE ON app.user_vault_devices
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER vkg_immutable
  BEFORE UPDATE ON app.vault_key_grants
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER irc_immutable
  BEFORE UPDATE ON app.institution_recovery_custodians
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER ir_ceremony_immutable
  BEFORE UPDATE ON app.institution_recovery_ceremonies
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER vpr_immutable
  BEFORE UPDATE ON app.vault_protected_records
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE TRIGGER agc_immutable
  BEFORE UPDATE ON app.adult_guardian_consents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();
