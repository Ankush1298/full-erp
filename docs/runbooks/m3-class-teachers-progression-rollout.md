# Runbook — migration 0038 (class teachers, promotion and repetition)

Status: **planning document. Nothing here has been executed against any persistent database.** Execution needs a separate, explicit, operator-approved instruction. Architecture: `docs/architecture/v3/32-class-teachers-and-progression.md`.

## 1. Prerequisites

1. Migrations `0001`-`0037` are applied, in order, including the contract migrations `0009` and `0019`, and `0037` per `m3b2-offerings-rollout.md`. The runner defers `0038` until then; use `--through 0038` and `--dry-run` to bound and preview a run.
2. A tested backup exists and the restore procedure is known (none has been exercised for this repository; doc 30).
3. A short window: `CREATE TABLE ... REFERENCES` takes `SHARE ROW EXCLUSIVE` on `app.sections`, `app.employees` and `app.organizations` for the statement, blocking writes (not reads) to them. `CREATE OR REPLACE FUNCTION app.term_enrollments_guard()` takes no table lock. Lock time is **unmeasured**; the migration sets `lock_timeout = 5s` and fails rather than queue.
4. **No data preflight is needed for the rules**: the table is created empty, the replaced enrolment guard only admits more rows than before (and runs on INSERT/UPDATE only, never over existing rows), and the added `DETAINED → COMPLETED` transition only adds an option.
5. No permission is added: no re-seed beyond the one `0037` already requires.

## 2. Read-only preflight (run as a superuser / BYPASSRLS role; the tables are FORCE RLS)

```sql
-- 2.1 the ledger ends at 0037
SELECT max(version) AS latest FROM platform.schema_migrations;               -- expect '0037'

-- 2.2 the new table does not exist; the guard to be replaced is the 0033 one
SELECT to_regclass('app.section_class_teachers');                             -- expect NULL
SELECT position('term_enrollments_same_program_ck' IN pg_get_functiondef('app.term_enrollments_guard()'::regprocedure)) = 0
       AS still_0033_guard;                                                   -- expect true

-- 2.3 informational: enrolments that the new rule concerns (none can be invalid; counts only)
SELECT count(*) FILTER (WHERE status = 'DETAINED') AS detained,
       count(*) FILTER (WHERE enrollment_type = 'REPEAT') AS repeat_rows
  FROM app.term_enrollments;

-- 2.4 no long-running transaction would hold the referenced tables
SELECT pid, state, xact_start, query FROM pg_stat_activity
 WHERE xact_start < now() - interval '1 minute' AND datname = current_database(); -- expect none
```

## 3. Apply

`pnpm db:migrate --through 0038 --dry-run` (review the plan), then the same without `--dry-run`, only with approval. Do not insert a `--` before the flags.

## 4. Post-checks (read-only)

```sql
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'section_class_teachers'; -- true, true
SELECT count(*) FROM app.section_class_teachers;                                                -- 0 (superuser)
SELECT position('term_enrollments_same_program_ck' IN pg_get_functiondef('app.term_enrollments_guard()'::regprocedure)) > 0
       AS new_guard;                                                                             -- true
SELECT privilege_type FROM information_schema.role_table_grants
 WHERE grantee = 'app_runtime' AND table_name = 'section_class_teachers' ORDER BY 1;           -- INSERT, SELECT
SELECT column_name FROM information_schema.column_privileges
 WHERE grantee = 'app_runtime' AND table_name = 'section_class_teachers' AND privilege_type = 'UPDATE'; -- valid_to
```

## 5. Rollback

No down migration. Before any class-teacher row exists, the table and its guard could be dropped and the `0033` body of `app.term_enrollments_guard()` restored by a reviewed, superuser-run script; this has **not** been written or tested. Once a repeat enrolment into another cohort or a `DETAINED → COMPLETED` change exists, restoring the `0033` guard would not invalidate those rows (guards run on writes only) but would block their natural continuation; roll forward only.
