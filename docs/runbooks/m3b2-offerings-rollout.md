# Runbook — Milestone 3 Batch 2 (migration 0037: course offerings, faculty assignments, timetable slots)

Status: **planning document. Nothing here has been executed against any persistent database.** Execution needs a separate, explicit, operator-approved instruction. Architecture: `docs/architecture/v3/31-course-offerings-and-scheduling-m3b2.md`.

## 1. Prerequisites

1. Migrations `0001`-`0036` are applied, in order, including the contract migrations `0009` and `0019` (see `academic-structure-rollout.md` and `students-contract-rollout.md`). The runner defers `0037` until then; use `--through 0037` and `--dry-run` to bound and preview a run.
2. A tested backup exists and the restore procedure is known (no restore has been exercised for this repository; doc 30).
3. A maintenance window: `CREATE TABLE ... REFERENCES` takes `SHARE ROW EXCLUSIVE` on `app.terms`, `app.courses`, `app.cohort_periods`, `app.sections`, `app.campuses`, `app.departments`, `app.employees` and `app.rooms` for the duration of each statement, blocking writes (not reads) to them. Lock time is **unmeasured**; the migration sets `lock_timeout = 5s` and fails rather than queue behind a long transaction.

4. The timetable conflict rules (room, section/audience, teacher; doc 31 §3) and the lifecycle behaviour (§3a) live in the `0037` guards. They apply to new rows only and `0037` creates the tables empty, so **no data preflight is needed for them**. Their cost on large timetables (three overlap scans per slot insert, each under an advisory lock) is **unmeasured**. A database that ran an earlier draft of `0037` (only disposable test databases ever did) would carry a different checksum; never rewrite an applied migration.

## 2. Read-only preflight (run as a superuser / BYPASSRLS role; the tables are FORCE RLS)

```sql
-- 2.1 the ledger ends at 0036 and contains both contract migrations
SELECT max(version) AS latest, bool_or(version = '0009') AS has_0009, bool_or(version = '0019') AS has_0019
  FROM platform.schema_migrations;                         -- expect latest = '0036', true, true

-- 2.2 nothing named like the new objects exists yet
SELECT to_regclass('app.course_offerings'), to_regclass('app.faculty_assignments'), to_regclass('app.timetable_slots');
                                                           -- expect three NULLs
SELECT code FROM platform.permissions
 WHERE code IN ('academic.offering.manage', 'academic.faculty.assign'); -- expect zero rows

-- 2.3 no long-running transaction would hold the referenced tables
SELECT pid, state, xact_start, query FROM pg_stat_activity
 WHERE xact_start < now() - interval '1 minute' AND datname = current_database(); -- expect none
```

## 3. Apply

`pnpm db:migrate --through 0037 --dry-run` (review the plan), then the same without `--dry-run`, only with approval. Do not insert a `--` before the flags.

## 4. Post-checks (read-only)

```sql
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relname IN ('course_offerings', 'faculty_assignments', 'timetable_slots');  -- all true, true
SELECT count(*) FROM app.course_offerings;                                         -- 0 (superuser)
SELECT code, sensitivity FROM platform.permissions
 WHERE code IN ('academic.offering.manage', 'academic.faculty.assign');           -- two SENSITIVE rows
```

## 5. Role re-seed (separate approval)

The two permissions reach existing tenants only after `seedTenantRoles` is re-run for each tenant. Until then no role holds them and every write route answers 403 (fail closed); reads keep working through `academic.program.read`. The re-seed changes tenant role data and needs its own approved plan (doc 30 OD-8).

## 6. Rollback

There are no down migrations. Before any offering exists, the objects could be dropped by a reviewed, superuser-run script (tables, the three guard functions, the two permission rows after removing their `role_permissions`); this has **not** been written or tested. After data exists, roll forward only.
