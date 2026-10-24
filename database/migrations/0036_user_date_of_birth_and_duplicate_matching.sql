-- 0036_user_date_of_birth_and_duplicate_matching
-- Owner: app_migrator
-- Milestone 2 (Organization + People, docs/architecture/v3/04 Part 16), Batch 2 follow-up: duplicate detection
-- ("a match check (normalized name + DOB + guardian phone, and exact admission number) warns before creating a second
-- record", doc 02 §6.2) at admission and import.
-- Specification: docs/architecture/v3/02 §4.3/§4.4 (users.date_of_birth), §6.2, 26-student-identifiers-and-imports-m2b2.md §3.5.
-- Owner decisions (2026-10-22): users.date_of_birth is added by an additive migration; the guardian phone and the date of
-- birth of an import row are used for matching ONLY and are not persisted by the import workflow (resupplied per request).
--
-- Contents:
--  1. app.users.date_of_birth: nullable `date` (the canonical type, doc 02 §4.3). NO backfill, NO default, no inference.
--     Same range as every other calendar date of the schema (1900-2200), as a CHECK added NOT VALID: a validated CHECK would
--     scan app.users while ACCESS EXCLUSIVE is held, and the new column is NULL in every existing row by construction, so there
--     is nothing to validate. NOT VALID still enforces the range on every INSERT and UPDATE; a later, ordinary migration may
--     VALIDATE it (SHARE UPDATE EXCLUSIVE) if the owner wants `convalidated` true. The `students` table gets NO date of birth (the
--     canonical schema keeps it on users).
--     Privileges: the runtime role has table-wide SELECT on app.users since 0003 (so it can read the column through the
--     tenant policies) and column-level UPDATE on (email, display_name, status) only: THIS MIGRATION GRANTS NO UPDATE ON THE
--     NEW COLUMN. (INSERT on app.users is table-wide since 0003, so the runtime role could still create a user row WITH a
--     date of birth; no code does, and narrowing that grant is out of scope. A security-db test pins both facts.) Nothing in the application writes a date of birth yet (account creation / profile editing is separate work,
--     doc 26 §7), and a column nobody may write is not given a writer (the rule of 0027). Until such a writer exists the column
--     is NULL for every row, and the duplicate rule (which needs a date of birth on BOTH sides) cannot match an existing record.
--     `identity.dob_required` (doc 02 §4.2) is NOT enforced by this migration or by the application: nothing reads it today.
--  2. A partial index for the duplicate lookup (organization, date of birth) over the rows that have one.
--  3. NO import column holds a date of birth or a guardian phone, or an unkeyed or salted digest of them. The matching-only
--     cells of an import row are RESUPPLIED by the client at every validate and commit request and live only in request
--     memory (doc 26 §3.5.4). What the database keeps:
--      * app.import_job_rows.match_presence smallint (0..3): which of the two cells (bit 1 = date of birth, bit 2 = guardian
--        phone) the client supplied for the row at the last validation. A commit whose resupplied presence differs is refused
--        without touching the stored preview, and a retry of a committed job is compared with it. Two bits of metadata,
--        updated only while the job is open (the 0035 row guard freezes the rows of a finished job).
--      * app.import_jobs.match_binding bytea + match_binding_key_label text: set ONLY when a job is COMMITTED with matching data.
--        An HMAC-SHA-256 (32 bytes) of the canonical matching data the commit used, bound to the tenant and the job, under the
--        named key of the dedicated IMPORT_MATCHING_KEYS ring. The key lives outside the database (environment), so a reader
--        of this table cannot test guesses against the MAC; the key ID supports rotation. Used to refuse a same-key retry
--        with materially different matching data (owner decision 2026-10-23, option (a)).
--     Deliberately NOT stored: any unkeyed or salted digest of the values (a salted argon2id binding was drafted and removed:
--     with its salt in the same row the values stay open to offline guessing), and the cells themselves (an earlier draft
--     added import_job_rows.match_input; it never shipped and was removed).
--
-- ROLLOUT: not a *_contract migration, but the runner defers every migration after a deferred contract migration, so 0036 runs
-- only after 0019 and 0035 in the same or a later invocation. Additive and forward-only; no down migration. Rollback strategy
-- is forward-fix: the column and index can be dropped by a later migration, and the application treats a NULL date of birth as
-- "cannot match". Nothing here is applied to any persistent database by this change.
-- LOCKS: ADD COLUMN without a default is a catalog-only change, but it takes ACCESS EXCLUSIVE on app.users for an instant
-- (bounded by lock_timeout below); CREATE INDEX (non-concurrent, inside the runner's transaction) takes SHARE on app.users and
-- reads only the rows that have a date of birth (none at first). ADD COLUMN match_presence has a constant default, also
-- catalog-only (ACCESS EXCLUSIVE on app.import_job_rows for an instant). The two app.import_jobs columns are nullable without
-- default (catalog-only); their CHECK is validated, which scans app.import_jobs under ACCESS EXCLUSIVE - a table created by
-- 0035 in the same rollout, so empty or small, and every existing row passes (both columns NULL). Lock times on
-- production-sized data are UNMEASURED.

SET LOCAL lock_timeout = '5s';

ALTER TABLE app.users
  ADD COLUMN date_of_birth date,
  ADD CONSTRAINT users_date_of_birth_range_ck
    CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND DATE '2200-12-31') NOT VALID;

CREATE INDEX users_org_dob_ix ON app.users (organization_id, date_of_birth) WHERE date_of_birth IS NOT NULL;

ALTER TABLE app.import_job_rows
  ADD COLUMN match_presence smallint NOT NULL DEFAULT 0 CHECK (match_presence BETWEEN 0 AND 3);
GRANT UPDATE (match_presence) ON app.import_job_rows TO app_runtime;

ALTER TABLE app.import_jobs
  ADD COLUMN match_binding bytea,
  ADD COLUMN match_binding_key_label text,
  ADD CONSTRAINT import_jobs_match_binding_ck
    CHECK (
      (match_binding IS NULL AND match_binding_key_label IS NULL)
      OR (
        status = 'COMMITTED'
        AND octet_length(match_binding) = 32
        AND match_binding_key_label ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$'
      )
    );
GRANT UPDATE (match_binding, match_binding_key_label) ON app.import_jobs TO app_runtime;
