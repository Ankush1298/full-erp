-- 0031_documents
-- Owner: app_migrator
-- Milestone 1 / Phase 1E: central file storage kernel (ADR-010).
-- Specification: ADR-010 (quarantine + scan + link-derived access), docs/architecture/v3/02 §4.11 (files, file_links
--                canonical columns), 03 Part 12 (storage strategy, key naming, upload flow, access control), 10 §1 rows
--                35-37 (document.upload / document.read / document.read_restricted), 11 §5.4 (the /documents endpoints).
--
-- Contents:
--  * permissions document.upload (NORMAL), document.read (NORMAL), document.read_restricted (CRITICAL) (doc 10 rows
--    35-37; catalog.ts and role-matrix.ts carry the same rows, and permission-matrix.test.ts / permission-seed.test.ts
--    require platform.permissions to agree with the catalog).
--  * app.files: tenant-scoped file metadata. The bucket holds bytes; this table holds everything else (doc 03 §12.5).
--    A file has NO ACL of its own (doc 03 §12.4): tenant isolation is the only row security; who may read it derives
--    from its links and is decided by the application's authorization engine, which the database cannot see.
--  * app.file_links: the polymorphic link (entity_type, entity_id) that access derives from. entity_id CANNOT carry a
--    real foreign key (the target table varies by entity_type); referential integrity of the target is the service's
--    job (it resolves the entity in-tenant, in the same transaction, before inserting the link). The link to the FILE
--    is a real tenant-safe composite FK.
--  * files_guard(): a BEFORE UPDATE trigger that freezes the identity/content columns and permits only the forward
--    scan lifecycle PENDING_UPLOAD -> SCANNING -> AVAILABLE | QUARANTINED -> DELETED -> PURGED. It is the raw-writer
--    backstop for "no duplicate completion" and "a file is never marked AVAILABLE without a CLEAN scan verdict".
--
-- SECURITY INVARIANTS enforced here (defence in depth; the service enforces the same):
--  * A file is AVAILABLE (downloadable) ONLY with scan_result = 'CLEAN' AND verified size_bytes, sha256 and
--    detected_mime (files_available_ck). The absence of a real scanner therefore keeps every file out of AVAILABLE:
--    fail closed. See the SCANNING GAP note below.
--  * storage_class, storage_key, original_name, declared_mime, size_bytes, sha256, classification and uploaded_by are
--    immutable once written (files_guard): the completion step VERIFIES them, it does not get to rewrite them.
--  * Opaque storage key with a tenant prefix and no PII (files_storage_key_ck): doc 03 §12.2.
--
-- SCANNING GAP (recorded, not silently resolved): ADR-010 mandates a ClamAV scan + magic-byte type sniff that promotes
-- a file to AVAILABLE. NO such scanner ships in this slice. The lifecycle and the `app.document_finalize_scan` trigger
-- backstop exist, but promotion to AVAILABLE requires a trustworthy verdict that only a future scan worker can supply.
-- Until that worker exists, `complete` leaves a file in SCANNING and nothing is downloadable (fail closed). See
-- docs/architecture/v3/24-documents.md and the module header in backend/src/modules/documents/.
--
-- DELIBERATELY NOT HERE (recorded): app.retention_policies (doc 02 lists it ★; R-5 "before production"), a purge job
-- (no DELETE grant; purge sets status PURGED and is a future operator-gated job), legal-hold and retention management
-- endpoints, generated-certificate verification, and GET /students/{id}/documents listing (only the POST link exists).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so
-- 0031 runs only after 0019 (and 0020-0030) in the same or a later invocation. Forward-only; nothing here is applied
-- to any persistent database by this change.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (doc 10 rows 35-37). Granted to roles by seedTenantRoles from role-matrix.ts.
-- ---------------------------------------------------------------------------------------------
INSERT INTO platform.permissions (code, sensitivity) VALUES
  ('document.upload', 'NORMAL'),
  ('document.read', 'NORMAL'),
  ('document.read_restricted', 'CRITICAL')
ON CONFLICT (code) DO UPDATE SET sensitivity = EXCLUDED.sensitivity;

-- ---------------------------------------------------------------------------------------------
-- 2. app.files
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.files (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  uploaded_by     app.uuid_v7 NOT NULL,
  storage_class   text NOT NULL CHECK (storage_class IN ('GENERAL', 'SENSITIVE', 'GENERATED')),
  -- Opaque key with a tenant prefix and NO PII (doc 03 §12.2): {org}/{class}/{yyyy}/{file_id}. Derived server-side from
  -- validated ids only; the client never supplies it. Bounded charset forbids path traversal and whitespace.
  storage_key     text NOT NULL CHECK (storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(GENERAL|SENSITIVE|GENERATED)/[0-9]{4}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  original_name   varchar(255) NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  declared_mime   text CHECK (declared_mime IS NULL OR declared_mime ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  detected_mime   text CHECK (detected_mime IS NULL OR detected_mime ~ '^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$'),
  size_bytes      bigint CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 104857600)),
  sha256          char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  status          text NOT NULL DEFAULT 'PENDING_UPLOAD'
                    CHECK (status IN ('PENDING_UPLOAD', 'SCANNING', 'AVAILABLE', 'QUARANTINED', 'DELETED', 'PURGED')),
  classification  text NOT NULL CHECK (classification IN ('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  -- Virus-scan verdict (doc 03 §12.5, first class). NULL until a scan runs. CLEAN is the ONLY verdict that may promote.
  scan_result     text CHECK (scan_result IS NULL OR scan_result IN ('CLEAN', 'INFECTED', 'REJECTED', 'ERROR')),
  scanned_at      timestamptz,
  retention_until date,
  legal_hold      boolean NOT NULL DEFAULT false,
  deleted_at      timestamptz,
  purged_at       timestamptz,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A file is downloadable ONLY when it has been scanned clean and its content facts are verified. This is the database
  -- half of "never mark a file clean merely because completion was requested".
  -- `IS NOT DISTINCT FROM` is null-safe: a NULL scan_result makes the clause FALSE (a plain `= 'CLEAN'` would be NULL,
  -- which a CHECK treats as satisfied — the whole point is to REJECT a NULL verdict).
  CONSTRAINT files_available_ck CHECK (
    status <> 'AVAILABLE'
    OR (scan_result IS NOT DISTINCT FROM 'CLEAN' AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND detected_mime IS NOT NULL)
  ),
  CONSTRAINT files_purged_ck CHECK ((purged_at IS NULL) = (status <> 'PURGED')),
  CONSTRAINT files_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- tenant-safe uploader reference: a file can only be owned by a user of ITS OWN tenant
  CONSTRAINT files_uploader_fk FOREIGN KEY (organization_id, uploaded_by) REFERENCES app.users (organization_id, id) ON DELETE RESTRICT,
  -- target of the composite foreign key of file_links
  CONSTRAINT files_org_id_uq UNIQUE (organization_id, id),
  -- doc 02 §4.11 UQ(storage_class, storage_key): the key is globally unique within its bucket
  CONSTRAINT files_storage_key_uq UNIQUE (storage_class, storage_key)
);

CREATE TRIGGER files_touch     BEFORE UPDATE ON app.files FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER files_immutable BEFORE UPDATE ON app.files FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- FK-backing indexes (schema-linter S-2): (organization_id) and (organization_id, uploaded_by).
CREATE INDEX files_org_status_ix   ON app.files (organization_id, status);
CREATE INDEX files_org_uploader_ix ON app.files (organization_id, uploaded_by);
-- Retention sweep of soft-deleted files (doc 02 §4.11 IDX(retention_until) WHERE status='DELETED').
CREATE INDEX files_retention_ix    ON app.files (retention_until) WHERE status = 'DELETED';

ALTER TABLE app.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.files FORCE  ROW LEVEL SECURITY;

-- A file has no ACL of its own (doc 03 §12.4): tenant isolation is the only row security. Access (who may read it) is
-- derived from file_links by the authorization engine in the service. Any in-tenant actor may create and read file
-- rows; the engine decides whether a given actor may upload-for / download a given linked entity.
CREATE POLICY files_tenant_select ON app.files AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY files_tenant_insert ON app.files AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY files_tenant_update ON app.files AS PERMISSIVE FOR UPDATE TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()))
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- Least privilege: INSERT the row at upload initiation; UPDATE only the scan-lifecycle columns. No DELETE (soft-delete
-- and purge are a future operator-gated job). Identity and content columns are set at INSERT and then frozen by
-- files_guard, so they are deliberately absent from the UPDATE grant.
GRANT SELECT, INSERT ON app.files TO app_runtime;
GRANT UPDATE (status, detected_mime, size_bytes, sha256, scan_result, scanned_at) ON app.files TO app_runtime;

-- Lifecycle + immutability guard (SECURITY INVOKER, VOLATILE, search_path pinned, EXECUTE revoked from PUBLIC: the
-- repo convention for row guards, same family as students_guard / student_guardians_guard).
CREATE FUNCTION app.files_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.storage_class  IS DISTINCT FROM OLD.storage_class
     OR NEW.storage_key   IS DISTINCT FROM OLD.storage_key
     OR NEW.original_name IS DISTINCT FROM OLD.original_name
     OR NEW.declared_mime IS DISTINCT FROM OLD.declared_mime
     OR NEW.uploaded_by   IS DISTINCT FROM OLD.uploaded_by
     OR NEW.classification IS DISTINCT FROM OLD.classification
     OR NEW.size_bytes    IS DISTINCT FROM OLD.size_bytes
     OR NEW.sha256        IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'file identity and content columns are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Only the forward scan lifecycle is allowed. Anything else (including a repeated completion, SCANNING -> SCANNING)
  -- is refused: this is the raw-writer backstop for "no duplicate completion".
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'PENDING_UPLOAD' AND NEW.status = 'SCANNING')
       OR (OLD.status = 'SCANNING' AND NEW.status IN ('AVAILABLE', 'QUARANTINED'))
       OR (OLD.status IN ('AVAILABLE', 'QUARANTINED') AND NEW.status = 'DELETED')
       OR (OLD.status = 'DELETED' AND NEW.status = 'PURGED')
     ) THEN
    RAISE EXCEPTION 'illegal file status transition from % to %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.files_guard() FROM PUBLIC;

CREATE TRIGGER files_guard_upd BEFORE UPDATE ON app.files
  FOR EACH ROW EXECUTE FUNCTION app.files_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. app.file_links
-- ---------------------------------------------------------------------------------------------
CREATE TABLE app.file_links (
  id              app.uuid_v7 PRIMARY KEY,
  organization_id app.uuid_v7 NOT NULL,
  file_id         app.uuid_v7 NOT NULL,
  -- Polymorphic target (doc 02 §4.11). NO foreign key is possible: the target table varies by entity_type. The service
  -- resolves the entity in-tenant, in the same transaction, before inserting a link, so a link can never point at a row
  -- that does not exist in this tenant.
  entity_type     varchar(60) NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,59}$'),
  entity_id       app.uuid_v7 NOT NULL,
  purpose         varchar(40) NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,39}$'),
  visibility      text NOT NULL CHECK (visibility IN ('OWNER_VISIBLE', 'STAFF_ONLY')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT file_links_org_fk FOREIGN KEY (organization_id) REFERENCES app.organizations (id) ON DELETE RESTRICT,
  -- tenant-safe reference to the file; a cross-tenant link cannot exist
  CONSTRAINT file_links_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES app.files (organization_id, id) ON DELETE RESTRICT,
  -- doc 02 §4.11 UQ(file_id, entity_type, entity_id, purpose), tenant-prefixed: the same file is linked to the same
  -- entity for the same purpose at most once (prevents unauthorized relinking / duplicate links).
  CONSTRAINT file_links_uq UNIQUE (organization_id, file_id, entity_type, entity_id, purpose)
);

CREATE TRIGGER file_links_touch     BEFORE UPDATE ON app.file_links FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER file_links_immutable BEFORE UPDATE ON app.file_links FOR EACH ROW EXECUTE FUNCTION app.enforce_immutable_keys();

-- The UNIQUE above is an index leading with (organization_id, file_id): it backs both the org FK and the file FK, and
-- serves the "links of a file" lookup the download path runs. (organization_id, entity_type, entity_id) serves the
-- "documents of an entity" lookup (doc 02 §4.11 IDX(entity_type, entity_id)).
CREATE INDEX file_links_org_entity_ix ON app.file_links (organization_id, entity_type, entity_id);

ALTER TABLE app.file_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.file_links FORCE  ROW LEVEL SECURITY;

CREATE POLICY file_links_tenant_select ON app.file_links AS PERMISSIVE FOR SELECT TO app_runtime
  USING (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));
CREATE POLICY file_links_tenant_insert ON app.file_links AS PERMISSIVE FOR INSERT TO app_runtime
  WITH CHECK (organization_id = app.current_tenant_id() AND (SELECT app.context_ok()));

-- A link is immutable once created (there is no re-link or re-point service in this slice). Only SELECT and INSERT are
-- granted; no UPDATE, no DELETE.
GRANT SELECT, INSERT ON app.file_links TO app_runtime;
