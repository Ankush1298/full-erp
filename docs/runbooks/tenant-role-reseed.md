# Runbook — re-seeding tenant roles (`tenant:seed`)

Status: procedure only. **Never executed against a persistent or production database.**
- Rehearsed on disposable databases only:
  - `backend/tests/integration/platform-cli.test.ts`, "re-seed: resets hand-made grant drift, never touches role assignments, and is all or nothing".
  - The M3 finalisation campaign (doc 39 §8).
- Every execution needs a separate, written operator authorisation naming the environment, the tenant(s), the window and the operator.

## 1. What the command does

`pnpm --filter @campusos/backend run platform:cli tenant:seed --tenant <id|slug>`. It connects with `PLATFORM_DATABASE_URL`, `DATABASE_ADMIN_URL` or `MIGRATION_DATABASE_URL`, a privileged role.

1. **Looks up the organisation** by id or slug. This is read-only; an unknown tenant fails without writing.
2. **One transaction** (since doc 39; before that, every statement committed on its own):
   - **Each system role in `backend/src/shared/authorization/role-matrix.ts`:**
     - inserts the role if it is missing;
     - **deletes every `app.role_permissions` row of that role that is not in the matrix**;
     - upserts the rest, **overwriting a different `scope_mode`**.
   - **MFA grants:** `seedMfaPermissions` adds `auth.mfa.manage` (SELF) and `user.account.reset_mfa` (GRANTED) where missing. It is insert-only.
   - **On any error** the whole re-seed is rolled back and the tenant keeps its previous grants. Re-running is idempotent.
3. **Never touched:** `app.role_assignments`, meaning who holds which role, at which scope, for which validity.
   - The application role `app_runtime` cannot write `app.roles` or `app.role_permissions` (`0006`), so the only grants a re-seed can remove are ones added or changed by hand in a privileged session.

**When a re-seed is needed:**
- after a migration registers a permission that the matrix grants;
- after a matrix change.

Until then the affected routes answer 403 (fail closed). For Milestone 3 these are:
- **Migration `0033`:** `academic.term.manage`, `academic.course.manage`, `academic.section.manage`, `enrollment.term.read`, `enrollment.term.manage`.
- **Migration `0037`:** `academic.offering.manage`, `academic.faculty.assign`.
- **Matrix change (Batch 3):** FACULTY `student.profile.read` in mode ASSIGNED.
- **Milestone 2 (`0035`):** `student.record.update`, `import.job.manage`.

Doc 38 §3 PR-3 lists the role holders. A tenant created by `tenant:create` is seeded on creation and needs none of this.

## 2. Preconditions

- **Migrations** applied in order, with their own preflights: `academic-structure-rollout.md`, `students-contract-rollout.md`, `m3b2-offerings-rollout.md`, `m3-class-teachers-progression-rollout.md`, `m3b3-electives-registrations-rollout.md`.
- **Code** deployed at the commit whose matrix is to be applied.
- **The operator session** must not be shared with application traffic. The command uses a dedicated client.

## 3. Backup

1. **Verified database backup.** Its restore has been tested on a scratch host.
2. **Logical export of the tenant's grants and assignments,** taken immediately before the run. Run it as a superuser or BYPASSRLS role, because the tables are FORCE RLS.

```sql
\copy (SELECT * FROM app.roles WHERE organization_id = :'org') TO 'roles.csv' CSV HEADER
\copy (SELECT * FROM app.role_permissions WHERE organization_id = :'org') TO 'role_permissions.csv' CSV HEADER
\copy (SELECT * FROM app.role_assignments WHERE organization_id = :'org') TO 'role_assignments.csv' CSV HEADER
SELECT count(*) AS assignments, md5(string_agg(id::text || status || coalesce(valid_until::text, ''), ',' ORDER BY id))
  FROM app.role_assignments WHERE organization_id = :'org';
```

## 4. Preview (read-only drift report)

These are the rows the re-seed would **delete** or **change**. Compare the current grants with the matrix of the deployed code.
- Export the matrix with `node -e` from `role-matrix.ts`, or read it from the code review.
- List the tenant's current grants:

```sql
SELECT r.code AS role, rp.permission_code, rp.scope_mode
  FROM app.role_permissions rp JOIN app.roles r ON r.id = rp.role_id
 WHERE rp.organization_id = :'org' ORDER BY 1, 2;
```

Every row that differs from the matrix needs one of two outcomes before the run:
- approved for removal or reset; or
- recorded for re-application through a reviewed change. The matrix is the policy; there is no supported tenant-specific grant.

## 5. Execution

One tenant at a time, in a low-traffic window. Record the start time, end time and full output.

```
pnpm --filter @campusos/backend run platform:cli tenant:seed --tenant <slug>
```

A non-zero exit means nothing changed (one transaction). Investigate before retrying.

## 6. Verification

1. The `role_permissions` of the tenant equal the matrix: re-run §4; no differences.
2. `role_assignments` is unchanged: the count and checksum from §3 step 2 are identical.
3. Smoke checks with real accounts of the tenant:
   - a CAMPUS_ADMIN reaches `GET /api/v1/academics/terms` (200, not 403);
   - a FACULTY member gets 200 on `GET /api/v1/students/:id` for a student registered in their offering, and 404 for others.
4. Run the command a second time: no change (idempotence).

## 7. Rollback

- **Grants only, the normal case:**
  - In one privileged transaction, delete the tenant's `app.role_permissions` rows and re-insert them from `role_permissions.csv`.
  - Record the operator, the reason and the time in the change log.
  - Assignments never need rollback: the re-seed does not touch them.
- **Full restore** from the §3 backup only if the export is unusable.

## 8. Record

Write a log entry: the authorisation reference, tenant, before/after counts and checksums, drift approved, outcome.
