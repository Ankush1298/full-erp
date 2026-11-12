-- 0050_payment_gateways_and_online_collections
-- Owner: app_migrator
-- Pilot V1: Unified Offline & Multi-Gateway Online Fee Payments.
-- Specification: Multi-gateway support (Razorpay, Cashfree, PhonePe), tenant isolation, encrypted credentials,
-- student payment attempts, online fee collections, and refund tracking.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.payment_gateway_configs
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.payment_gateway_configs (
  id                       app.uuid_v7 PRIMARY KEY,
  organization_id          app.uuid_v7 NOT NULL,
  campus_id                app.uuid_v7,
  provider                 text        NOT NULL CHECK (provider IN ('RAZORPAY', 'CASHFREE', 'PHONEPE')),
  mode                     text        NOT NULL DEFAULT 'SANDBOX' CHECK (mode IN ('SANDBOX', 'LIVE')),
  is_active                boolean     NOT NULL DEFAULT false,
  merchant_key             text        NOT NULL CHECK (char_length(merchant_key) BETWEEN 1 AND 128),
  credentials_encrypted    text        NOT NULL,
  webhook_secret_encrypted text,
  settings_json            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version                  integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gateway_configs_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT gateway_configs_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT gateway_configs_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX gateway_configs_org_ix ON app.payment_gateway_configs (organization_id);
CREATE INDEX gateway_configs_org_campus_ix ON app.payment_gateway_configs (organization_id, campus_id);
CREATE UNIQUE INDEX gateway_configs_org_provider_default_uq ON app.payment_gateway_configs (organization_id, provider) WHERE campus_id IS NULL;
CREATE UNIQUE INDEX gateway_configs_org_campus_provider_uq ON app.payment_gateway_configs (organization_id, campus_id, provider) WHERE campus_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. app.payment_attempts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.payment_attempts (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  campus_id             app.uuid_v7 NOT NULL,
  student_id            app.uuid_v7 NOT NULL,
  student_due_id        app.uuid_v7,
  gateway_config_id     app.uuid_v7 NOT NULL,
  provider              text        NOT NULL CHECK (provider IN ('RAZORPAY', 'CASHFREE', 'PHONEPE')),
  mode                  text        NOT NULL CHECK (mode IN ('SANDBOX', 'LIVE')),
  attempt_reference     text        NOT NULL CHECK (char_length(attempt_reference) BETWEEN 3 AND 64),
  order_reference       text        CHECK (order_reference IS NULL OR char_length(order_reference) <= 128),
  amount                bigint      NOT NULL CHECK (amount > 0),
  currency              text        NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  status                text        NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'USER_DROPPED', 'EXPIRED')),
  gateway_payment_ref   text        CHECK (gateway_payment_ref IS NULL OR char_length(gateway_payment_ref) <= 128),
  gateway_signature     text        CHECK (gateway_signature IS NULL OR char_length(gateway_signature) <= 512),
  failure_reason        text        CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
  receipt_id            app.uuid_v7,
  metadata_json         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  initiated_by_user_id  app.uuid_v7 NOT NULL,
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_due_fk FOREIGN KEY (organization_id, student_due_id)
    REFERENCES app.student_dues (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_config_fk FOREIGN KEY (organization_id, gateway_config_id)
    REFERENCES app.payment_gateway_configs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_receipt_fk FOREIGN KEY (organization_id, receipt_id)
    REFERENCES app.fee_receipts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_user_fk FOREIGN KEY (organization_id, initiated_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_attempt_ref_uq UNIQUE (organization_id, attempt_reference),
  CONSTRAINT payment_attempts_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX payment_attempts_org_ix ON app.payment_attempts (organization_id);
CREATE INDEX payment_attempts_org_campus_ix ON app.payment_attempts (organization_id, campus_id);
CREATE INDEX payment_attempts_org_student_ix ON app.payment_attempts (organization_id, student_id);
CREATE INDEX payment_attempts_org_due_ix ON app.payment_attempts (organization_id, student_due_id);
CREATE INDEX payment_attempts_org_config_ix ON app.payment_attempts (organization_id, gateway_config_id);
CREATE INDEX payment_attempts_org_receipt_ix ON app.payment_attempts (organization_id, receipt_id);
CREATE INDEX payment_attempts_org_user_ix ON app.payment_attempts (organization_id, initiated_by_user_id);
CREATE INDEX payment_attempts_org_status_ix ON app.payment_attempts (organization_id, status);
CREATE INDEX payment_attempts_org_gateway_pay_ix ON app.payment_attempts (organization_id, gateway_payment_ref);
CREATE INDEX payment_attempts_org_order_ref_ix ON app.payment_attempts (organization_id, order_reference);

-- ---------------------------------------------------------------------------------------------
-- 3. app.payment_refunds
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.payment_refunds (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  campus_id             app.uuid_v7 NOT NULL,
  receipt_id            app.uuid_v7 NOT NULL,
  payment_attempt_id    app.uuid_v7 NOT NULL,
  gateway_refund_ref    text        CHECK (gateway_refund_ref IS NULL OR char_length(gateway_refund_ref) <= 128),
  amount                bigint      NOT NULL CHECK (amount > 0),
  currency              text        NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  status                text        NOT NULL DEFAULT 'INITIATED' CHECK (status IN ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED')),
  reason                text        NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  initiated_by_user_id  app.uuid_v7 NOT NULL,
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_refunds_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_receipt_fk FOREIGN KEY (organization_id, receipt_id)
    REFERENCES app.fee_receipts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_attempt_fk FOREIGN KEY (organization_id, payment_attempt_id)
    REFERENCES app.payment_attempts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_user_fk FOREIGN KEY (organization_id, initiated_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_org_id_uq UNIQUE (organization_id, id)
);

CREATE INDEX payment_refunds_org_ix ON app.payment_refunds (organization_id);
CREATE INDEX payment_refunds_org_campus_ix ON app.payment_refunds (organization_id, campus_id);
CREATE INDEX payment_refunds_org_receipt_ix ON app.payment_refunds (organization_id, receipt_id);
CREATE INDEX payment_refunds_org_attempt_ix ON app.payment_refunds (organization_id, payment_attempt_id);
CREATE INDEX payment_refunds_org_user_ix ON app.payment_refunds (organization_id, initiated_by_user_id);
CREATE INDEX payment_refunds_org_status_ix ON app.payment_refunds (organization_id, status);

-- ---------------------------------------------------------------------------------------------
-- 4. Extend app.fee_receipts for online collections
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.fee_receipts DROP CONSTRAINT fee_receipts_payment_method_check;
ALTER TABLE app.fee_receipts ADD CONSTRAINT fee_receipts_payment_method_check
  CHECK (payment_method IN ('CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI_REFERENCE', 'OTHER_OFFLINE', 'ONLINE_RAZORPAY', 'ONLINE_CASHFREE', 'ONLINE_PHONEPE', 'ONLINE_GATEWAY'));

ALTER TABLE app.fee_receipts ADD COLUMN payment_attempt_id app.uuid_v7;

ALTER TABLE app.fee_receipts ADD CONSTRAINT fee_receipts_payment_attempt_fk
  FOREIGN KEY (organization_id, payment_attempt_id)
  REFERENCES app.payment_attempts (organization_id, id)
  ON DELETE RESTRICT;

CREATE INDEX fee_receipts_org_payment_attempt_ix ON app.fee_receipts (organization_id, payment_attempt_id);

-- ---------------------------------------------------------------------------------------------
-- 5. Touch triggers
-- ---------------------------------------------------------------------------------------------
CREATE TRIGGER trg_payment_gateway_configs_touch
  BEFORE UPDATE ON app.payment_gateway_configs
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_payment_attempts_touch
  BEFORE UPDATE ON app.payment_attempts
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_payment_refunds_touch
  BEFORE UPDATE ON app.payment_refunds
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ---------------------------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.payment_gateway_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_gateway_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_refunds FORCE ROW LEVEL SECURITY;

-- Permissive tenant isolation
CREATE POLICY payment_gateway_configs_tenant ON app.payment_gateway_configs
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY payment_attempts_tenant ON app.payment_attempts
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY payment_refunds_tenant ON app.payment_refunds
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Restrictive policies
CREATE POLICY payment_gateway_configs_staff ON app.payment_gateway_configs
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND is_active = true))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY payment_attempts_student_self ON app.payment_attempts
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
              OR (app.current_actor_kind() = 'STUDENT'
                  AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())));

CREATE POLICY payment_refunds_staff ON app.payment_refunds
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF')
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Update 0046 restrictive policies to allow student actors to record verified online receipts and allocations
DROP POLICY IF EXISTS fee_receipts_student_self ON app.fee_receipts;
CREATE POLICY fee_receipts_student_self ON app.fee_receipts
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
              OR (app.current_actor_kind() = 'STUDENT'
                  AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())
                  AND payment_attempt_id IS NOT NULL));

DROP POLICY IF EXISTS fee_receipt_allocations_student_self ON app.fee_receipt_allocations;
CREATE POLICY fee_receipt_allocations_student_self ON app.fee_receipt_allocations
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND receipt_id IN (SELECT r.id FROM app.fee_receipts r WHERE r.student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id()))))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
              OR (app.current_actor_kind() = 'STUDENT'
                  AND receipt_id IN (SELECT r.id FROM app.fee_receipts r WHERE r.student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id()) AND r.payment_attempt_id IS NOT NULL)));

DROP POLICY IF EXISTS student_dues_student_self ON app.student_dues;
CREATE POLICY student_dues_student_self ON app.student_dues
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
              OR (app.current_actor_kind() = 'STUDENT'
                  AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())));

-- Grants (app_runtime has NO DELETE on financial/payment audit tables)
GRANT SELECT, INSERT, UPDATE ON
  app.payment_gateway_configs,
  app.payment_attempts,
  app.payment_refunds
TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 7. Permissions & Role Grants
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('fee.gateway.read', 'SENSITIVE'),
  ('fee.gateway.manage', 'CRITICAL'),
  ('fee.payment.initiate', 'NORMAL'),
  ('fee.refund.initiate', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.perm, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      ('COLLEGE_ADMIN', 'fee.gateway.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.gateway.manage', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.payment.initiate', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.refund.initiate', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.gateway.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.payment.initiate', 'GRANTED'),
      ('REGISTRAR', 'fee.gateway.read', 'GRANTED'),
      ('REGISTRAR', 'fee.payment.initiate', 'GRANTED'),
      ('STUDENT', 'fee.payment.initiate', 'SELF')
  ) AS p(role_code, perm, mode)
 WHERE r.code = p.role_code
ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = EXCLUDED.scope_mode;
