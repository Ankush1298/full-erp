# Runbook — migration 0039 (electives, course registrations, holidays, class-teacher posting rule)

Status: **planning document. Nothing here has been executed against any persistent database.** Execution needs a separate, explicit, operator-approved instruction. Architecture: `docs/architecture/v3/33-electives-registrations-holidays-m3b3.md`.

## 1. Prerequisites and order

1. Migrations `0001`-`0038` applied in order (contract migrations `0009`, `0019`; `0037` per `m3b2-offerings-rollout.md`; `0038` per `m3-class-teachers-progression-rollout.md`). Bound the run with `--through 0039`; preview with `--dry-run`.
2. A tested backup and a known restore procedure (none exercised for this repository; doc 30).
3. Order: **migration → application code → role re-seed.** Code before the migration fails on the missing tables; the re-seed before the code would grant FACULTY `student.profile.read` while no resolver is registered (the engine then denies, so this order is safe but pointless).
4. Locks: `ALTER TABLE app.course_offerings ADD COLUMN` (+ FK, CHECK) takes ACCESS EXCLUSIVE on `app.course_offerings` briefly (nullable column, no rewrite; the CHECK and FK validate an all-NULL column); the new tables' FKs take SHARE ROW EXCLUSIVE on `term_enrollments`, `course_offerings`, `cohort_periods`, `campuses`, `organizations`. Lock time **unmeasured**; `lock_timeout = 5s` fails rather than queues.

## 2. Read-only preflight (superuser / BYPASSRLS; the tables are FORCE RLS)

```sql
SELECT max(version) AS latest FROM platform.schema_migrations;                  -- expect '0038'
SELECT to_regclass('app.elective_groups'), to_regclass('app.course_registrations'), to_regclass('app.holidays'); -- expect NULLs
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'app' AND table_name = 'course_offerings' AND column_name = 'elective_group_id'; -- expect 0
-- informational: class-teacher rows that the new whole-period posting rule would refuse if written today
SELECT a.id, a.section_id, a.employee_id, a.valid_from, COALESCE(a.valid_to, t.end_date) AS until
  FROM app.section_class_teachers a
  JOIN app.sections s ON s.organization_id = a.organization_id AND s.id = a.section_id
  JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
  JOIN app.terms t ON t.organization_id = cp.organization_id AND t.id = cp.term_id
 WHERE EXISTS (
   SELECT 1 FROM generate_series(a.valid_from, COALESCE(a.valid_to, t.end_date), interval '1 day') g(day)
    WHERE NOT EXISTS (
      SELECT 1 FROM app.employee_postings p JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
       WHERE p.organization_id = a.organization_id AND p.employee_id = a.employee_id AND d.campus_id = t.campus_id
         AND p.is_primary AND p.valid_from <= g.day::date AND (p.valid_to IS NULL OR p.valid_to >= g.day::date)));
-- no long-running transaction on the referenced tables
SELECT pid, state, xact_start, query FROM pg_stat_activity
 WHERE xact_start < now() - interval '1 minute' AND datname = current_database();  -- expect none
```

The class-teacher query lists rows only for review: the migration does not re-validate existing rows.

## 3. Apply, then re-seed

`pnpm db:migrate --through 0039 --dry-run`, then without `--dry-run`, only with approval. After the code deploy, re-run `seedTenantRoles` per tenant (FACULTY gains `student.profile.read` in mode ASSIGNED; nothing else changes).

## 4. Post-checks (read-only)

```sql
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
 WHERE relnamespace = 'app'::regnamespace AND relname IN ('elective_groups', 'course_registrations', 'holidays'); -- all true
SELECT has_table_privilege('app_runtime', 'app.course_registrations', 'DELETE');                            -- false
SELECT r.code, rp.scope_mode FROM app.role_permissions rp JOIN app.roles r ON r.organization_id = rp.organization_id AND r.id = rp.role_id
 WHERE rp.permission_code = 'student.profile.read' AND r.code = 'FACULTY';                                -- ASSIGNED, per tenant after the re-seed
```

## 5. Rollback

There is no down migration. Before any row is written the three tables can be dropped and the column removed by a reviewed, approved script; after rows exist, restore from backup. Reverting the code alone is safe: the tables stay unused and FACULTY reads fall back to 404 (grant held, no resolver) until the role is re-seeded from the older matrix.
