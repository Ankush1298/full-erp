-- 0032_consent_and_notifications
-- Owner: app_migrator
-- Milestone 1 / Phase 1E: Consent Management Kernel and Notification Delivery Kernel (docs/architecture/v3/02 §4.3,
-- 03 Part 13, 08 §4, 10 §1 rows 39-44, 11 §5.2-§5.4).
--
-- Contents:
--  * platform.permissions: registers consent.read (SENSITIVE), consent.record (NORMAL), consent.withdraw (NORMAL),
--    notification.read (NORMAL), notification.preference.manage (NORMAL), notification.template.manage (SENSITIVE).
--  * app.consents: tenant-scoped point-in-time consent records (A2 entity; never deleted, auditable lifecycle).
--    Supports subject-granted consent and guardian-granted consent on behalf of minors (02 §4.3, 06 §6).
--  * app.outbox_events: transactional domain event outbox for decoupled event relay (03 §13.1, 08 §4).
--  * app.notification_templates: localized notification templates (in-app, email, web push, sms, whatsapp) with
--    tenant overrides and system defaults (03 §13.2).
--  * app.notifications: user in-app notification inbox with read tracking (03 §13.2, 11 §5.4).
--  * app.notification_deliveries: per-channel attempt and delivery state tracking (03 §13.2).
--  * app.notification_preferences: recipient notification preferences by category and channel (03 §13.2).
--
-- SECURITY INVARIANTS:
--  * Full tenant isolation via FORCE ROW LEVEL SECURITY on all tenant tables.
--  * Restrictive student/self policies: students can only see their own notifications, consents, and preferences.
--  * Immutability triggers on (id, organization_id) across all tables (schema-linter S-2).
--  * Forward-only status transitions for consents: GRANTED -> WITHDRAWN; never deleted; immutable policy text hash.
--  * Foreign keys backed by composite indexes (organization_id, target_id).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (doc 10 rows 39-44). Granted to roles by seedTenantRoles from role-matrix.ts.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('consent.read',                  'SENSITIVE'),
  ('consent.record',                'NORMAL'),
  ('consent.withdraw',              'NORMAL'),
  ('notification.read',             'NORMAL'),
  ('notification.preference.manage','NORMAL'),
  ('notification.template.manage',  'SENSITIVE'),
  ('assistant.use',                 'NORMAL'),
  ('assistant.conversation.read',   'NORMAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.consents (doc 02 §4.3, doc 08 §4, doc 10 rows 39-41)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.consents (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  user_id             app.uuid_v7 NOT NULL,
  consent_type        varchar(40) NOT NULL,
  policy_version      varchar(20) NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'GRANTED'
                      CHECK (status IN ('GRANTED', 'WITHDRAWN')),
  granted_at          timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz,
  method              varchar(20) NOT NULL DEFAULT 'WEB_FORM',
  ip                  inet,
  user_agent          text,
  granted_by_user_id  app.uuid_v7 NOT NULL,
  guardian_id         app.uuid_v7,
  policy_text_hash    char(64) NOT NULL,
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT consents_dates_ck CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at),
  CONSTRAINT consents_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT consents_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT consents_granted_by_fk FOREIGN KEY (organization_id, granted_by_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT consents_guardian_fk FOREIGN KEY (organization_id, guardian_id)
    REFERENCES app.guardians (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT consents_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER consents_touch     BEFORE UPDATE ON app.consents FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER consents_immutable BEFORE UPDATE ON app.consents FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX consents_org_user_type_status_ix ON app.consents (organization_id, user_id, consent_type, status);
CREATE INDEX consents_org_granted_by_ix       ON app.consents (organization_id, granted_by_user_id);
CREATE INDEX consents_org_guardian_ix         ON app.consents (organization_id, guardian_id) WHERE guardian_id IS NOT NULL;

ALTER TABLE app.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consents FORCE  ROW LEVEL SECURITY;

CREATE POLICY consents_tenant_select ON app.consents AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY consents_tenant_insert ON app.consents AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY consents_tenant_update ON app.consents AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY consents_student_self ON app.consents AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()));

GRANT SELECT, INSERT ON app.consents TO app_runtime;
GRANT UPDATE (status, withdrawn_at, version, updated_at) ON app.consents TO app_runtime;

-- Forward-only status guard: GRANTED -> WITHDRAWN. Identity and core content columns are immutable.
CREATE FUNCTION app.consents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.user_id            IS DISTINCT FROM OLD.user_id
     OR NEW.consent_type    IS DISTINCT FROM OLD.consent_type
     OR NEW.policy_version  IS DISTINCT FROM OLD.policy_version
     OR NEW.policy_text_hash IS DISTINCT FROM OLD.policy_text_hash
     OR NEW.granted_at      IS DISTINCT FROM OLD.granted_at
     OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
     OR NEW.guardian_id     IS DISTINCT FROM OLD.guardian_id THEN
    RAISE EXCEPTION 'consent identity and origin columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'GRANTED' AND NEW.status = 'WITHDRAWN') THEN
    RAISE EXCEPTION 'illegal consent status transition from % to %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.consents_guard() FROM PUBLIC;

CREATE TRIGGER consents_guard_upd BEFORE UPDATE ON app.consents
  FOR EACH ROW EXECUTE FUNCTION app.consents_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. app.outbox_events (doc 02 §4.11, doc 03 §13.1)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.outbox_events (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  event_type       varchar(100) NOT NULL,
  aggregate_type   varchar(60) NOT NULL,
  aggregate_id     app.uuid_v7 NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  available_at     timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  attempts         smallint NOT NULL DEFAULT 0,
  last_error       text,
  dedup_key        text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outbox_events_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT outbox_events_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT outbox_events_dedup_uq  UNIQUE (organization_id, dedup_key)
);

CREATE TRIGGER outbox_events_immutable BEFORE UPDATE ON app.outbox_events
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX outbox_events_pending_ix ON app.outbox_events (organization_id, available_at)
  WHERE processed_at IS NULL;

ALTER TABLE app.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY outbox_events_tenant_select ON app.outbox_events AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY outbox_events_tenant_insert ON app.outbox_events AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY outbox_events_tenant_update ON app.outbox_events AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

GRANT SELECT, INSERT ON app.outbox_events TO app_runtime;
GRANT UPDATE (processed_at, attempts, last_error) ON app.outbox_events TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 4. app.notification_templates (doc 03 §13.2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.notification_templates (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  event_type       varchar(100) NOT NULL,
  channel          varchar(20) NOT NULL
                   CHECK (channel IN ('IN_APP', 'EMAIL', 'WEB_PUSH', 'SMS', 'WHATSAPP')),
  locale           varchar(10) NOT NULL DEFAULT 'en',
  subject_template text,
  body_template    text NOT NULL,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status           varchar(20) NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_templates_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT notification_templates_org_id_uq UNIQUE (organization_id, id),
  CONSTRAINT notification_templates_lookup_uq UNIQUE (organization_id, event_type, channel, locale, version)
);

CREATE TRIGGER notification_templates_touch     BEFORE UPDATE ON app.notification_templates
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER notification_templates_immutable BEFORE UPDATE ON app.notification_templates
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX notification_templates_org_event_ix ON app.notification_templates (organization_id, event_type);

ALTER TABLE app.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_templates FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_templates_tenant_select ON app.notification_templates AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_templates_tenant_insert ON app.notification_templates AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_templates_tenant_update ON app.notification_templates AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

GRANT SELECT, INSERT ON app.notification_templates TO app_runtime;
GRANT UPDATE (subject_template, body_template, status, version, updated_at) ON app.notification_templates TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 5. app.notifications (in-app inbox; doc 03 §13.2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.notifications (
  id                 app.uuid_v7 PRIMARY KEY,
  organization_id    app.uuid_v7 NOT NULL,
  recipient_user_id  app.uuid_v7 NOT NULL,
  category           varchar(40) NOT NULL,
  title              varchar(255) NOT NULL,
  body               text NOT NULL,
  action_url         text,
  entity_type        varchar(60),
  entity_id          app.uuid_v7,
  read_at            timestamptz,
  version            integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT notifications_recipient_fk FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT notifications_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER notifications_touch     BEFORE UPDATE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER notifications_immutable BEFORE UPDATE ON app.notifications
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX notifications_org_recipient_created_ix ON app.notifications (organization_id, recipient_user_id, created_at DESC);
CREATE INDEX notifications_org_unread_ix           ON app.notifications (organization_id, recipient_user_id) WHERE read_at IS NULL;

ALTER TABLE app.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notifications FORCE  ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant_select ON app.notifications AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notifications_tenant_insert ON app.notifications AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notifications_tenant_update ON app.notifications AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY notifications_student_self ON app.notifications AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND recipient_user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND recipient_user_id = app.current_user_id()));

GRANT SELECT, INSERT ON app.notifications TO app_runtime;
GRANT UPDATE (read_at, updated_at) ON app.notifications TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 6. app.notification_deliveries (delivery tracking; doc 03 §13.2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.notification_deliveries (
  id                  app.uuid_v7 PRIMARY KEY,
  organization_id     app.uuid_v7 NOT NULL,
  notification_id     app.uuid_v7,
  channel             varchar(20) NOT NULL
                      CHECK (channel IN ('IN_APP', 'EMAIL', 'WEB_PUSH', 'SMS', 'WHATSAPP')),
  recipient_user_id   app.uuid_v7 NOT NULL,
  destination         text NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'QUEUED'
                      CHECK (status IN ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')),
  attempts            smallint NOT NULL DEFAULT 0,
  provider            varchar(40) NOT NULL,
  provider_message_ref text,
  error_code          text,
  suppression_reason  text,
  sent_at             timestamptz,
  version             integer     NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_deliveries_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_notification_fk FOREIGN KEY (organization_id, notification_id)
    REFERENCES app.notifications (organization_id, id) ON DELETE SET NULL,
  CONSTRAINT notification_deliveries_recipient_fk FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER notification_deliveries_touch     BEFORE UPDATE ON app.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER notification_deliveries_immutable BEFORE UPDATE ON app.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX notification_deliveries_pending_ix   ON app.notification_deliveries (organization_id, status)
  WHERE status = 'QUEUED';
CREATE INDEX notification_deliveries_recipient_ix ON app.notification_deliveries (organization_id, recipient_user_id);
CREATE INDEX notification_deliveries_notif_ix     ON app.notification_deliveries (organization_id, notification_id)
  WHERE notification_id IS NOT NULL;

ALTER TABLE app.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_deliveries_tenant_select ON app.notification_deliveries AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_deliveries_tenant_insert ON app.notification_deliveries AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_deliveries_tenant_update ON app.notification_deliveries AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY notification_deliveries_student_self ON app.notification_deliveries AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND recipient_user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND recipient_user_id = app.current_user_id()));

GRANT SELECT, INSERT ON app.notification_deliveries TO app_runtime;
GRANT UPDATE (status, attempts, provider_message_ref, error_code, suppression_reason, sent_at, updated_at)
  ON app.notification_deliveries TO app_runtime;

-- ---------------------------------------------------------------------------------------------
-- 7. app.notification_preferences (doc 03 §13.2)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.notification_preferences (
  id               app.uuid_v7 PRIMARY KEY,
  organization_id  app.uuid_v7 NOT NULL,
  user_id          app.uuid_v7 NOT NULL,
  category         varchar(40) NOT NULL,
  channel          varchar(20) NOT NULL
                   CHECK (channel IN ('IN_APP', 'EMAIL', 'WEB_PUSH', 'SMS', 'WHATSAPP')),
  enabled          boolean NOT NULL DEFAULT true,
  version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_preferences_org_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations (id) ON DELETE RESTRICT,
  CONSTRAINT notification_preferences_user_fk FOREIGN KEY (organization_id, user_id)
    REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT notification_preferences_uq UNIQUE (organization_id, user_id, category, channel),
  CONSTRAINT notification_preferences_org_id_uq UNIQUE (organization_id, id)
);

CREATE TRIGGER notification_preferences_touch     BEFORE UPDATE ON app.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER notification_preferences_immutable BEFORE UPDATE ON app.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

CREATE INDEX notification_preferences_user_ix ON app.notification_preferences (organization_id, user_id);

ALTER TABLE app.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification_preferences FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_tenant_select ON app.notification_preferences AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_preferences_tenant_insert ON app.notification_preferences AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY notification_preferences_tenant_update ON app.notification_preferences AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

CREATE POLICY notification_preferences_student_self ON app.notification_preferences AS RESTRICTIVE FOR ALL TO app_runtime
  USING (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()))
  WITH CHECK (app.current_actor_kind() = 'STAFF'
         OR (app.current_actor_kind() = 'STUDENT' AND user_id = app.current_user_id()));

GRANT SELECT, INSERT ON app.notification_preferences TO app_runtime;
GRANT UPDATE (enabled, updated_at) ON app.notification_preferences TO app_runtime;
