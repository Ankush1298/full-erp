-- 0046_fees_dues_and_offline_receipts
-- Owner: app_migrator
-- Pilot V1: Track A Core ERP - Fees, Dues, Offline Receipts & Reconciliation (Slice 1).
-- Specification: docs/architecture/v3/01 §3.8, 02 §4.8, 10, 47 (Task 5), prompt requirements.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. app.fee_categories
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.fee_categories (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  code                text        NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description         text        CHECK (description IS NULL OR char_length(description) <= 500),
  is_active           boolean     NOT NULL DEFAULT true,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_categories_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fee_categories_code_uq UNIQUE (organization_id, code),
  CONSTRAINT fee_categories_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX fee_categories_org_ix ON app.fee_categories (organization_id);

-- ---------------------------------------------------------------------------------------------
-- 2. app.fee_structures
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.fee_structures (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  campus_id           app.uuid_v7 NOT NULL,
  academic_year_id    app.uuid_v7 NOT NULL,
  term_id             app.uuid_v7,
  program_id          app.uuid_v7,
  code                text        NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,40}$'),
  name                text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 150),
  currency            text        NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  status              text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  due_date            date        NOT NULL,
  created_by_user_id  app.uuid_v7 NOT NULL,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_structures_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_year_fk FOREIGN KEY (organization_id, academic_year_id)
    REFERENCES app.academic_years (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_term_fk FOREIGN KEY (organization_id, term_id)
    REFERENCES app.terms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_program_fk FOREIGN KEY (organization_id, program_id)
    REFERENCES app.programs (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_created_by_fk FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_structures_code_uq UNIQUE (organization_id, code),
  CONSTRAINT fee_structures_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX fee_structures_org_campus_ix ON app.fee_structures (organization_id, campus_id);
CREATE INDEX fee_structures_org_year_ix ON app.fee_structures (organization_id, academic_year_id);
CREATE INDEX fee_structures_org_term_ix ON app.fee_structures (organization_id, term_id);
CREATE INDEX fee_structures_org_program_ix ON app.fee_structures (organization_id, program_id);
CREATE INDEX fee_structures_org_created_by_ix ON app.fee_structures (organization_id, created_by_user_id);

-- ---------------------------------------------------------------------------------------------
-- 3. app.fee_structure_components
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.fee_structure_components (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  fee_structure_id    app.uuid_v7 NOT NULL,
  fee_category_id     app.uuid_v7 NOT NULL,
  amount              bigint      NOT NULL CHECK (amount > 0),
  description         text        CHECK (description IS NULL OR char_length(description) <= 500),
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_struct_comp_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fee_struct_comp_structure_fk FOREIGN KEY (organization_id, fee_structure_id)
    REFERENCES app.fee_structures (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fee_struct_comp_category_fk FOREIGN KEY (organization_id, fee_category_id)
    REFERENCES app.fee_categories (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_struct_comp_uq UNIQUE (organization_id, fee_structure_id, fee_category_id),
  CONSTRAINT fee_struct_comp_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX fee_struct_comp_org_struct_ix ON app.fee_structure_components (organization_id, fee_structure_id);
CREATE INDEX fee_struct_comp_org_cat_ix ON app.fee_structure_components (organization_id, fee_category_id);

-- ---------------------------------------------------------------------------------------------
-- 4. app.student_dues
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.student_dues (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  campus_id           app.uuid_v7 NOT NULL,
  student_id          app.uuid_v7 NOT NULL,
  fee_structure_id    app.uuid_v7 NOT NULL,
  academic_year_id    app.uuid_v7 NOT NULL,
  term_id             app.uuid_v7,
  due_number          text        NOT NULL CHECK (char_length(due_number) BETWEEN 3 AND 50),
  gross_amount        bigint      NOT NULL CHECK (gross_amount >= 0),
  discount_amount     bigint      NOT NULL DEFAULT 0 CHECK (discount_amount >= 0 AND discount_amount <= gross_amount),
  net_amount          bigint      NOT NULL CHECK (net_amount = gross_amount - discount_amount),
  paid_amount         bigint      NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= net_amount),
  balance_amount      bigint      NOT NULL CHECK (balance_amount = net_amount - paid_amount),
  status              text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PARTIAL', 'PAID', 'CANCELLED', 'WAIVED')),
  due_date            date        NOT NULL,
  concession_reason   text        CHECK (concession_reason IS NULL OR char_length(concession_reason) <= 500),
  generated_by_user_id app.uuid_v7 NOT NULL,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_dues_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_structure_fk FOREIGN KEY (organization_id, fee_structure_id)
    REFERENCES app.fee_structures (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_year_fk FOREIGN KEY (organization_id, academic_year_id)
    REFERENCES app.academic_years (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_term_fk FOREIGN KEY (organization_id, term_id)
    REFERENCES app.terms (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_generated_by_fk FOREIGN KEY (organization_id, generated_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT student_dues_due_number_uq UNIQUE (organization_id, due_number),
  CONSTRAINT student_dues_struct_student_uq UNIQUE (organization_id, fee_structure_id, student_id),
  CONSTRAINT student_dues_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX student_dues_org_campus_ix ON app.student_dues (organization_id, campus_id);
CREATE INDEX student_dues_org_student_ix ON app.student_dues (organization_id, student_id);
CREATE INDEX student_dues_org_struct_ix ON app.student_dues (organization_id, fee_structure_id);
CREATE INDEX student_dues_org_year_ix ON app.student_dues (organization_id, academic_year_id);
CREATE INDEX student_dues_org_term_ix ON app.student_dues (organization_id, term_id);
CREATE INDEX student_dues_org_generated_by_ix ON app.student_dues (organization_id, generated_by_user_id);
CREATE INDEX student_dues_org_status_ix ON app.student_dues (organization_id, status);

-- ---------------------------------------------------------------------------------------------
-- 5. app.fee_receipts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.fee_receipts (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  campus_id             app.uuid_v7 NOT NULL,
  student_id            app.uuid_v7 NOT NULL,
  receipt_number        text        NOT NULL CHECK (char_length(receipt_number) BETWEEN 3 AND 50),
  payment_date          date        NOT NULL,
  payment_method        text        NOT NULL CHECK (payment_method IN ('CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI_REFERENCE', 'OTHER_OFFLINE')),
  amount                bigint      NOT NULL CHECK (amount > 0),
  currency              text        NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  reference_number      text        CHECK (reference_number IS NULL OR char_length(reference_number) <= 100),
  reconciliation_status text        NOT NULL DEFAULT 'RECORDED' CHECK (reconciliation_status IN ('RECORDED', 'PENDING_VERIFICATION', 'CONFIRMED')),
  status                text        NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  received_by_user_id   app.uuid_v7 NOT NULL,
  idempotency_key       text        CHECK (idempotency_key IS NULL OR char_length(idempotency_key) <= 128),
  remarks               text        CHECK (remarks IS NULL OR char_length(remarks) <= 500),
  reversal_reason       text        CHECK (reversal_reason IS NULL OR char_length(reversal_reason) <= 500),
  reversed_at           timestamptz,
  reversed_by_user_id   app.uuid_v7,
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_receipts_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipts_campus_fk FOREIGN KEY (organization_id, campus_id)
    REFERENCES app.campuses (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipts_student_fk FOREIGN KEY (organization_id, student_id)
    REFERENCES app.students (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipts_received_by_fk FOREIGN KEY (organization_id, received_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipts_reversed_by_fk FOREIGN KEY (organization_id, reversed_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipts_number_uq UNIQUE (organization_id, receipt_number),
  CONSTRAINT fee_receipts_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT fee_receipts_reversal_ck CHECK (
    status <> 'REVERSED' OR (
      reversal_reason IS NOT NULL AND
      reversed_at IS NOT NULL AND
      reversed_by_user_id IS NOT NULL
    )
  )
);
CREATE INDEX fee_receipts_org_campus_ix ON app.fee_receipts (organization_id, campus_id);
CREATE INDEX fee_receipts_org_student_ix ON app.fee_receipts (organization_id, student_id);
CREATE INDEX fee_receipts_org_received_by_ix ON app.fee_receipts (organization_id, received_by_user_id);
CREATE INDEX fee_receipts_org_reversed_by_ix ON app.fee_receipts (organization_id, reversed_by_user_id);
CREATE INDEX fee_receipts_org_payment_date_ix ON app.fee_receipts (organization_id, payment_date);
CREATE INDEX fee_receipts_org_idempotency_ix ON app.fee_receipts (organization_id, idempotency_key);

-- ---------------------------------------------------------------------------------------------
-- 6. app.fee_receipt_allocations
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.fee_receipt_allocations (
  id                    app.uuid_v7 PRIMARY KEY,
  organization_id       app.uuid_v7 NOT NULL,
  receipt_id            app.uuid_v7 NOT NULL,
  student_due_id        app.uuid_v7 NOT NULL,
  allocated_amount      bigint      NOT NULL CHECK (allocated_amount > 0),
  version               integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_receipt_alloc_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipt_alloc_receipt_fk FOREIGN KEY (organization_id, receipt_id)
    REFERENCES app.fee_receipts (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipt_alloc_due_fk FOREIGN KEY (organization_id, student_due_id)
    REFERENCES app.student_dues (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT fee_receipt_alloc_receipt_due_uq UNIQUE (organization_id, receipt_id, student_due_id),
  CONSTRAINT fee_receipt_alloc_org_id_uq UNIQUE (organization_id, id)
);
CREATE INDEX fee_receipt_alloc_org_receipt_ix ON app.fee_receipt_allocations (organization_id, receipt_id);
CREATE INDEX fee_receipt_alloc_org_due_ix ON app.fee_receipt_allocations (organization_id, student_due_id);

-- ---------------------------------------------------------------------------------------------
-- 7. Guards & Triggers
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app.fee_receipts_immutable_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted fee receipts cannot be deleted. An authorized reversal is required.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'REVERSED' THEN
      RAISE EXCEPTION 'A reversed fee receipt cannot be modified.'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status = 'REVERSED' THEN
      -- Only reversal tracking fields may change
      IF NEW.amount <> OLD.amount OR
         NEW.receipt_number <> OLD.receipt_number OR
         NEW.payment_date <> OLD.payment_date OR
         NEW.payment_method <> OLD.payment_method OR
         NEW.student_id <> OLD.student_id OR
         NEW.campus_id <> OLD.campus_id OR
         NEW.organization_id <> OLD.organization_id THEN
        RAISE EXCEPTION 'Receipt details cannot be altered during reversal.'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      -- Disallow changing core financial amounts or dates on active receipts
      IF NEW.amount <> OLD.amount OR
         NEW.student_id <> OLD.student_id OR
         NEW.organization_id <> OLD.organization_id THEN
        RAISE EXCEPTION 'Core financial attributes on posted receipts are immutable.'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fee_receipts_immutable_guard
  BEFORE UPDATE OR DELETE ON app.fee_receipts
  FOR EACH ROW EXECUTE FUNCTION app.fee_receipts_immutable_guard();

-- Touch triggers
CREATE TRIGGER trg_fee_categories_touch
  BEFORE UPDATE ON app.fee_categories
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_fee_structures_touch
  BEFORE UPDATE ON app.fee_structures
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_fee_structure_components_touch
  BEFORE UPDATE ON app.fee_structure_components
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_student_dues_touch
  BEFORE UPDATE ON app.student_dues
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE TRIGGER trg_fee_receipts_touch
  BEFORE UPDATE ON app.fee_receipts
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- ---------------------------------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE app.fee_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE app.fee_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_structures FORCE ROW LEVEL SECURITY;
ALTER TABLE app.fee_structure_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_structure_components FORCE ROW LEVEL SECURITY;
ALTER TABLE app.student_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.student_dues FORCE ROW LEVEL SECURITY;
ALTER TABLE app.fee_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.fee_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.fee_receipt_allocations FORCE ROW LEVEL SECURITY;

-- Permissive tenant isolation
CREATE POLICY fee_categories_tenant ON app.fee_categories
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY fee_structures_tenant ON app.fee_structures
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY fee_structure_components_tenant ON app.fee_structure_components
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY student_dues_tenant ON app.student_dues
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY fee_receipts_tenant ON app.fee_receipts
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY fee_receipt_allocations_tenant ON app.fee_receipt_allocations
  FOR ALL TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Restrictive policies: Student self isolation & staff write guards
CREATE POLICY student_dues_student_self ON app.student_dues
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_receipts_student_self ON app.fee_receipts
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id())))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_categories_staff_write ON app.fee_categories
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_categories_staff_update ON app.fee_categories
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_categories_staff_delete ON app.fee_categories
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structures_staff_write ON app.fee_structures
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structures_staff_update ON app.fee_structures
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structures_staff_delete ON app.fee_structures
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structure_components_staff_write ON app.fee_structure_components
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structure_components_staff_update ON app.fee_structure_components
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_structure_components_staff_delete ON app.fee_structure_components
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (app.current_actor_kind() = 'STAFF');

CREATE POLICY fee_receipt_allocations_student_self ON app.fee_receipt_allocations
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT'
             AND receipt_id IN (SELECT r.id FROM app.fee_receipts r WHERE r.student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = app.current_user_id()))))
  WITH CHECK (app.current_actor_kind() = 'STAFF');

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.fee_categories,
  app.fee_structures,
  app.fee_structure_components,
  app.student_dues,
  app.fee_receipts,
  app.fee_receipt_allocations
TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 9. Permissions & Role Grants
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('fee.structure.read', 'NORMAL'),
  ('fee.structure.manage', 'SENSITIVE'),
  ('fee.dues.generate', 'SENSITIVE'),
  ('fee.dues.read', 'SENSITIVE'),
  ('fee.receipt.record', 'SENSITIVE'),
  ('fee.receipt.read', 'SENSITIVE'),
  ('fee.receipt.reverse', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

INSERT INTO app.role_permissions (organization_id, role_id, permission_code, scope_mode)
SELECT r.organization_id, r.id, p.perm, p.mode
  FROM app.roles r
  CROSS JOIN (
    VALUES
      ('COLLEGE_ADMIN', 'fee.structure.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.structure.manage', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.dues.generate', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.dues.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.receipt.record', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.receipt.read', 'GRANTED'),
      ('COLLEGE_ADMIN', 'fee.receipt.reverse', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.structure.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.dues.generate', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.dues.read', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.receipt.record', 'GRANTED'),
      ('CAMPUS_ADMIN', 'fee.receipt.read', 'GRANTED'),
      ('REGISTRAR', 'fee.structure.read', 'GRANTED'),
      ('REGISTRAR', 'fee.dues.read', 'GRANTED'),
      ('REGISTRAR', 'fee.receipt.read', 'GRANTED'),
      ('STUDENT', 'fee.dues.read', 'SELF'),
      ('STUDENT', 'fee.receipt.read', 'SELF')
  ) AS p(role_code, perm, mode)
 WHERE r.code = p.role_code
ON CONFLICT (organization_id, role_id, permission_code) DO UPDATE SET scope_mode = EXCLUDED.scope_mode;
