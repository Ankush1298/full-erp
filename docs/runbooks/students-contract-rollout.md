# Runbook: students contract migration 0019 and the subsequent migrations 0020–0030

Status: **design and checklist only. Nothing in this document has been run against any persistent or production database.** The migration and its tests have only run on disposable databases.

**Migrations `0027` (student guardians), `0028` (user invitations), and `0029` (session step-up) have only been tested on disposable databases and are NOT approved for persistent rollout.** Migration `0027` carries unresolved decisions (`docs/architecture/v3/21-students.md` §6c) and its checklist has never been executed on a persistent database. Do not read the range `0020`–`0029` in this runbook as blanket approval to apply migrations beyond your approved change scope. **Migration `0030` (TOTP MFA) is likewise untested on any persistent database and needs its own approval and procedure: `docs/runbooks/mfa-rollout.md`** (keys, permission re-seed before the enforcing build, bootstrap).

`0019_students_required_dates_contract.sql` is the CONTRACT step of the expand/contract pair started by `0017_students_record_fields.sql`. It validates the two `NOT VALID` checks on `app.students`, sets `NOT NULL` on `admission_date` and `status_changed_at`, and drops the checks. It contains **no backfill** and invents no value.

## 1. Why it is gated

The file name ends in `_contract`, so an ordinary `pnpm db:migrate` defers it. It runs only with `pnpm db:migrate --allow-contract 0019` (no `--` before the flag), and on an existing database only as the **first** migration of that invocation: it cannot be bundled with pending ordinary migrations (`0010`–`0018`). `contractVersions()` is derived from the file names, so it now returns `0009` and `0019`; disposable test databases pass both on an empty ledger, which the runner exempts.

Typical sequence on a database at `0008`: `pnpm db:migrate --allow-contract 0009` applies `0009`–`0018` and defers `0019` **and `0020`–`0029`**; `0019` is a later, separate invocation, and unless bounded by `--through`, it applies subsequent pending migrations right after itself (see §6 for `0020`; the header of `database/migrations/0021_student_programs.sql` and §6a of `docs/architecture/v3/21-students.md` for `0021`; §2 items 5–6 for `0022`–`0023`; and §3 for upper-bound scoping with `--through`).

## 2. Preconditions (operator responsibility; the ledger cannot prove them)

1. The application that writes students through `POST /api/v1/students` (this phase) is deployed everywhere, and every older writer of `app.students` is drained. Anything that still inserts a student without `admission_date` will fail once `NOT NULL` is set.
2. **Every existing student row has `admission_date` and `status_changed_at`.** The migration neither guesses nor backfills them. If rows exist from before `0017`, the backfill rule (what date counts as the admission date, and what `status_changed_at` should be) is a **business decision recorded in the change record** and applied by the operator outside the migration.
3. Read-only preflight, run as a superuser or `BYPASSRLS` role (`app_migrator` sees zero tenant rows because the tables are `FORCE ROW LEVEL SECURITY`):

```sql
-- must both be 0 before running 0019
SELECT count(*) FROM app.students WHERE admission_date IS NULL;
SELECT count(*) FROM app.students WHERE status_changed_at IS NULL;
-- ledger must read 0001 .. 0018 and nothing else
SELECT version FROM platform.schema_migrations ORDER BY version;
```

   These statements have not been executed on a real server.
4. Roles for new students: existing tenants need `seedTenantRoles` re-run to receive `student.record.create` (added by `0017`). Until then no role holds it and creation is refused (fail closed).
5. Roles for program enrolment: migration `0022` registers `student.program.assign` (SENSITIVE; `GRANTED` to `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`). Registration must come first: `seedTenantRoles` only syncs permissions already present in `platform.permissions`, so a re-seed before `0022` silently skips the grant. After `0022`, existing tenants need `seedTenantRoles` re-run to receive it; until then no role holds it and the enrolment service (Step 2B) refuses with 403 (fail closed). `0022` is deferred behind `0019` like `0020` and `0021`. The re-seed changes tenant role data and needs its own explicit authorisation; it has not been run.
6. Roles for the student directory lookup: migration `0023` registers `student.directory.search` (SENSITIVE; `GRANTED` to `HOD`, `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`). Same ordering rule as item 5: apply `0023` **first**, then re-run `seedTenantRoles` (it only syncs permissions already in `platform.permissions`, so a re-seed before `0023` silently skips the grant). `0023` is deferred behind `0019` like `0020`–`0022`, and is applied by `pnpm db:migrate --allow-contract 0019` after `0019`–`0022`. Until the re-seed, no role holds the permission and `GET /api/v1/students?admissionNumber=` refuses with 403 (fail closed). The re-seed changes tenant role data and needs its own explicit authorisation; it has not been run.
6a. Roles for the paginated student directory: migration `0024` registers `student.directory.list` (SENSITIVE; `GRANTED` to `HOD`, `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`), independent of `student.directory.search`. Same ordering rule as items 5 and 6: apply `0024` **first**, then re-run `seedTenantRoles`. `0024` is deferred behind `0019` and applied by `--allow-contract 0019` after `0019`–`0023`. `GET /api/v1/students/directory` additionally exists **only** when `CURSOR_KEYS` and `CURSOR_ACTIVE_KEY_ID` are configured **and** `STUDENT_DIRECTORY_LIST_ENABLED=true` is set (`docs/runbooks/secrets.md`); applying `0024`, re-seeding or configuring keys activates nothing by itself. Its rate limiter is per process and the flag does not check the instance count, so do not set it on a multi-instance deployment until coordinated rate limiting exists (`docs/architecture/v3/21-students.md` §0c). Not performed.
6b. Roles for student status changes: migration `0025` registers `student.status.change` (**CRITICAL**; `GRANTED` to `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR` only) and `0026` installs the database transition guard on `app.students.status` (trigger `students_status_transition_guard_upd`; refuses any pair outside the 11 allowed ones, `23001`; see `docs/architecture/v3/21-students.md` §6b). Same ordering rule as items 5-6a: apply `0025` **first**, then re-run `seedTenantRoles`; until then `POST /api/v1/students/:id/status` refuses with 403. Both are deferred behind `0019`. **The guard binds every writer once applied**, including seed scripts and DBA sessions (except `session_replication_role = replica`); check that no operational script sets `students.status` outside the allowed pairs first. Production gates recorded in §6b and **not resolved**: D5 (no correction/reinstatement workflow), D9 (no denial auditing; owner TBD), D10 (no step-up or second approver; reason + audit is not MFA). The migrations, the re-seed and the deploy are separate, separately authorised operations; none has been run.
6c. Roles for student guardians: migration `0027` registers `student.guardian.read` and `student.guardian.manage` (both SENSITIVE; read is `SELF` for `STUDENT` and `GRANTED` to `HOD`, `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`; manage is `GRANTED` to `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR` only; doc 10 rows 30-31). Same ordering rule as items 5-6b: apply `0027` **first**, then re-run `seedTenantRoles` **using the build that contains these permissions** (an older build's seed deletes `role_permissions` rows outside its own matrix). `0027` is deferred behind `0019` like `0020`-`0026`. Until the re-seed no role holds either permission and every guardian route refuses with 403 (fail closed; a STUDENT also gets 403 because the route gate finds no grant). The re-seed changes tenant role data and needs its own explicit authorisation; it has not been run.
6d. **Guardian preflight (read-only; run before applying `0027`).** Run as a superuser or `BYPASSRLS` role (`app.student_guardians` is `FORCE ROW LEVEL SECURITY`; `app_migrator` sees zero rows and would report a false zero):

```sql
-- pre-0027 ("legacy") rows: guardian_id does not exist yet, so on a database still at 0026 every row is legacy
SELECT count(*) AS legacy_rows FROM app.student_guardians;
-- students that already hold a primary legacy row: they keep it, and a new-shape primary will COEXIST with it
SELECT organization_id, student_id, id AS legacy_row_id
  FROM app.student_guardians
 WHERE is_primary
 ORDER BY organization_id, student_id;
```

   Zero rows is expected on a database where nobody wrote guardian rows by hand, because no application code writes `app.student_guardians` before `0027`. **Non-zero is not an error and nothing is changed or migrated automatically:** `0027` does not backfill, convert, delete or demote any legacy row (the migration role could not even read them under row security), the guardian API never lists or edits them, and they do not count toward the 10-guardian cap. Each legacy contact needs a business decision (migrate into `app.guardians`, retire, or whether a legacy primary outranks a new one; `21-students.md` §6c decision 1); record it in the change record. These statements have not been executed on a real server.
6e. **`0027` rewrites one index and sets a lock bound only.** It drops `student_guardians_one_primary_uq` and creates two partial unique indexes (a legacy-only one under the old name and `student_guardians_one_primary_link_uq`), alters `app.student_guardians` (two columns lose `NOT NULL`, six are added, six constraints, three restrictive policies on it plus one restrictive policy on `app.guardians`, one trigger) and creates `app.guardians`. `ALTER TABLE` and `DROP INDEX` take `ACCESS EXCLUSIVE` on `app.student_guardians`; the lock wait is bounded by `SET LOCAL lock_timeout = '5s'`, the hold time is **unmeasured** (the table is expected to be small, an assumption not a measurement). Forward-only: there is no rollback after commit, and the only recovery is a new reviewed migration.
6f. Roles for user invitations: migration `0028` registers `user.account.read` (SENSITIVE), `user.account.invite` (SENSITIVE), and `user.account.suspend` (CRITICAL). Same ordering rule as items 5–6c: apply `0028` **first**, then re-run `seedTenantRoles` using the matching build. `0028` is deferred behind `0019`. Until the re-seed, invitation management routes refuse callers without appropriate permissions (fail closed).
6g. Session step-up authentication: migration `0029` adds `step_up_at` and `auth_strength` columns to `platform.auth_sessions` (Milestone 1 / Phase 1C, D10). It is a non-contract migration deferred behind `0019` until contract rollout.
6h. TOTP MFA: migration `0030` adds `app.user_mfa_factors`, `app.user_recovery_codes`, `platform.auth_sessions.mfa_verified_at`, the revoke-only function `platform.admin_reset_user_mfa` and the permissions `auth.mfa.manage` / `user.account.reset_mfa`. Deferred behind `0019` like `0020`–`0029`. Its own prerequisites (dedicated encryption keys, `seedTenantRoles` before the enforcing build) are in `docs/runbooks/mfa-rollout.md`.
7. **Which build is live when the migration runs.** Before `pnpm db:migrate --allow-contract 0019`, the build deployed for item 1 must be one that does **not** query `app.student_programs` (no student-program enrolment or student-directory code). Do not deploy the current student-program/directory build until migration `0021` has been applied (in practice, until the ledger reaches at least `0026`, or `0029` if deploying the tip of `main`). If it goes live too early, these existing operations are expected to fail with HTTP 500 because the relation `app.student_programs` does not exist: department deactivation (`DepartmentService.update`, status ACTIVE to INACTIVE), department soft-delete (`DepartmentService.softDelete`), and a cohort status change away from ACTIVE (`CohortService.update`). The failed request rolls back and writes nothing. This comes from reading the current code (`department.service.ts`, `academic.service.ts`, `shared/http/hardening.ts`); it has not been run against a database without `0021`.
8. **Preflight order.** When applying contract migration `0019` alone using `--through 0019`, subsequent migration `0020` is deferred. If applying beyond `0019` in the same invocation (e.g., `--through 0026`, `--through 0029`, or without `--through`), `0020` is applied immediately after `0019`. Whenever `0020` is in scope to be applied (either bundled or in a subsequent run), the person-identity preflight (the SQL under "Person-identity preflight", after §6) must be completed, with zero rows or each row resolved, **before** applying `0020`, in addition to the NULL-date check and approved backfill of items 2 and 3 for `0019`.

## 3. Applying it

> **AUTHORIZATION BOUNDARY & UPPER-BOUND ENFORCEMENT (`--through`)**
>
> The migration runner now provides an explicit upper-bound option: `--through <exact 4-digit version>`.
> When provided, the runner plans and executes only migrations up to and including that exact version, deferring any subsequent migrations.
>
> **CRITICAL WARNING — OMITTING `--through` APPLIES ALL SUBSEQUENT MIGRATIONS:**
> If `--through` is omitted, running `pnpm db:migrate --allow-contract 0019` will apply `0019` AND **every subsequent pending migration found in `database/migrations/` in that checkout**. On the current repository tip, this includes `0020` through `0030` (`0027` student guardians, `0028` user invitations, `0029` session step-up, and `0030` TOTP MFA). Naming `--allow-contract 0019` alone does NOT imply approval to apply migrations `0020`–`0030`.
>
> **DRY-RUN INSPECTION (`--dry-run`):**
> Operators should execute a dry run before applying changes to inspect the current ledger head, planned migrations, and deferral reasons without modifying the database:
> ```bash
> pnpm db:migrate --allow-contract 0019 --through 0019 --dry-run
> ```
> A dry run connects to the database to inspect `platform.schema_migrations` and validate ledger contiguity and contract phase boundaries, but executes NO migration SQL, schema modifications, or ledger writes.
>
> **HOW TO APPLY ONLY APPROVED RANGES:**
> Operators should use the explicit `--through` option to match the exact approved change scope:
>
> 1. **To apply ONLY contract migration `0019` (deferring all subsequent migrations):**
>    ```bash
>    pnpm db:migrate --allow-contract 0019 --through 0019
>    ```
>    This applies `0019` and defers `0020` through `0030`.
>
> 2. **To apply through `0026` (when `0027`–`0029` are NOT yet approved):**
>    ```bash
>    pnpm db:migrate --allow-contract 0019 --through 0026
>    ```
>    This applies `0019` through `0026`, leaving `0027` (guardians), `0028` (invitations), `0029` (step-up) and `0030` (MFA) deferred.
>
> 3. **To apply through `0029` (when the entire slice is approved):**
>    ```bash
>    pnpm db:migrate --allow-contract 0019 --through 0029
>    ```
>    This leaves `0030` (TOTP MFA) deferred.
>
> 4. **To apply through `0030` (only when MFA is separately approved, `docs/runbooks/mfa-rollout.md`):**
>    ```bash
>    pnpm db:migrate --allow-contract 0019 --through 0030
>    ```
>
> **BUILD / CHECKOUT SELECTION:**
> When institutional governance requires physical exclusion of unapproved migrations (so unapproved SQL files do not even reside on the deployment runner or container), deploy an immutable build artifact or check out a specific Git commit tag/hash whose `database/migrations/` directory contains only the approved migrations.
> **Never delete, rename, or edit migration files to limit execution.** Editing or removing committed migration files causes checksum drift errors and violates immutability.
>
> **RUNNER GUARANTEE LIMITATIONS:**
> Note that `--through` is an execution ceiling for the migration runner client. It does not replace transaction isolation, database RLS, or preflight verification requirements.

Expected outcome when running `pnpm db:migrate --allow-contract 0019 --through 0019`: `0019` applied first in its own transaction; `0020` through `0030` reported as `DEFERRED [0020, 0021, ...]`.
`ALTER TABLE` takes `ACCESS EXCLUSIVE` on `app.students` for the validation scan; the wait for the lock is bounded by `lock_timeout = 5s`, the scan time is **unmeasured**.

After the command succeeds, in this order:

1. Verify the ledger reads up to the target version and that expected permissions are present in `platform.permissions` (read-only checks, as a superuser or `BYPASSRLS` role). If the run stopped early, do not deploy the current build (see §4).
2. Deploy the corresponding application build. Until the reseed, newly gated routes refuse every caller with 403 (fail closed).
3. Run `seedTenantRoles` for each existing tenant **using that matching build**, as a separately authorised operation; it changes tenant role data and **has not been run**. Never run the seed from an older build once these grants exist: it deletes `role_permissions` rows that are not in its own role matrix, which would remove the new grants.

This order is derived from reading the code and migrations. It has not been validated against a real deployment, and nothing in this document has been run against any persistent or production database.

**Guardians (`0027`) after the apply.** Existing tenants have no guardian rows in the new shape. Guardian dates are campus-local for placed students and **UTC for students with no active enrolment** (an implementation choice, not a tenant-timezone policy). Do not deploy a build without the guardian code against a database at `0027` expecting the old primary-slot rule: a legacy primary row and a new-shape primary may then coexist, and nothing in the database prefers either. The migration has been exercised only on disposable databases (`tests/integration/migration-0027.test.ts` upgrades a `0026` database holding legacy primary and non-primary rows and checks them byte-for-byte); no persistent-database rehearsal, lock-time measurement or restore exercise exists.

## 4. If it fails

Each migration runs in its own transaction. A failing migration rolls back its own SQL and its ledger insert, migrations that already committed earlier in the same invocation stay applied and recorded, and later migrations do not run. The runner throws instead of returning its applied list, so read `platform.schema_migrations` to see how far it got. If `0019` itself fails: `SQLSTATE 23514` with `students_admission_date_ck` or `students_status_changed_at_ck` means a NULL remains: find the rows with the preflight query, backfill by the approved rule, retry. `55P03` means the lock could not be taken in 5 s: find the long transaction, retry later. Never edit an applied migration, never edit the ledger, never relax row security.

## 5. After it

`NOT NULL` replaces the checks: a missing `admission_date` is refused with `23502` instead of `23514`. There is no rollback (forward-only migrations); a later migration could drop `NOT NULL`, which would be a new, reviewed change.

**Application rollback after enrolments exist.** The database does not stop a department or cohort with an ACTIVE enrolment from being deactivated; that rule lives only in the application (`DepartmentService.update` / `softDelete`, `CohortService.update`). If the application is rolled back to a build without those guards once enrolments exist, department deactivation, department soft-delete and cohort status changes away from ACTIVE could succeed while ACTIVE enrolments reference them. During such a rollback, freeze those operations unless equivalent protection has been independently verified. This is a code-reading conclusion, not a tested rollback procedure.

## 6. Migration 0020: the database backstop of the person-identity invariant

`0020_student_staff_role_exclusivity.sql` adds triggers on `app.role_assignments` and `app.students` that enforce, for every writer (including privileged ones), that an account with a student record has no **staff-capable role assignment**. It is a new file; `0016`–`0019` are unchanged. The services already enforce the same rule and take the same per-person advisory lock (`shared/authorization/person-identity.ts`); the triggers are the backstop.

**Rollout boundary, stated precisely.** `0019` is the contract migration (its name ends in `_contract`), so it runs only when named with `--allow-contract 0019`. `0020`–`0030` are not `_contract` migrations, but the runner defers every migration that follows a deferred contract migration. Therefore:

- an ordinary `pnpm db:migrate` and `pnpm db:migrate --allow-contract 0009` leave `0019` **and `0020`–`0030`** deferred (`blockedBy` `0019`);
- `0020`–`0030` are applied only by `pnpm db:migrate --allow-contract 0019` (after `0019`, in order, up to any `--through` limit), or by a later plain `pnpm db:migrate` once `0019` is in the ledger;
- **until then the `0020` database backstop is INACTIVE.** The invariant is protected only by the service checks and the per-person lock, which a privileged or raw writer (seed script, DBA session, a future importer) does not go through.

**Staff-capable assignment** (the single predicate: `AuthorizationEngine.hasStaffCapableAssignment`, the two trigger functions, and the query below): a row of `app.role_assignments` whose role code is **not** `STUDENT`, with `status = 'ACTIVE'` and `valid_until` either NULL or in the future. `valid_from` is ignored, so a future-dated active assignment conflicts. Revoked, expired and ended-window rows do not. A `STUDENT`-role assignment never conflicts.

## Person-identity preflight (read-only; run before applying 0020)

The triggers are forward-only: they prevent new violations and neither reject nor change existing rows. Run this as a superuser or `BYPASSRLS` role (the tables are `FORCE ROW LEVEL SECURITY`; `app_migrator` sees zero tenant rows). **Zero rows is the expected result.** There is no automatic remediation: each row is a business decision (revoke the assignment through `RoleAssignmentService`, or leave the student record), recorded in the change record.

```sql
SELECT s.organization_id, s.user_id, s.id AS student_id,
       ra.id AS assignment_id, r.code AS role_code, ra.status, ra.valid_from, ra.valid_until
  FROM app.students s
  JOIN app.role_assignments ra ON ra.organization_id = s.organization_id AND ra.user_id = s.user_id
  JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
 WHERE r.code <> 'STUDENT'
   AND ra.status = 'ACTIVE'
   AND (ra.valid_until IS NULL OR ra.valid_until > now())
 ORDER BY s.organization_id, s.user_id, ra.id;
```

This statement has not been executed on a real server; `tests/integration/person-identity-invariant.test.ts` runs it, extracted from this file, on disposable databases and compares it with the engine and the triggers.

An existing account that holds BOTH a student and an employee record (left by data older than `0016`) is a separate pre-existing gap and is not covered by this query.

Not done and not automatic: `0020` does not backfill, validate or alter any row; it does not make `RoleAssignmentService.grant`'s rule "a `STUDENT` role requires a student record" a database rule (that is a service rule only).
