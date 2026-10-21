# Employee separation: legacy-row preflight and reviewed backfill plan (migration 0034)

**Status: PROPOSED PLAN. Nothing in this document has been executed against any persistent or production database, and no row has been or will be changed automatically.** Owner Decision 5 (Milestone 2 Batch 1). The SQL below ran only on the disposable test database harness (`tests/integration/employee-separation-preflight.test.ts` extracts it from this file and executes it there).

## 1. Why this exists

Before migration `0034`, a `SEPARATED` employee did not need a `leaving_date` (`20-employees.md` §4 item 6: "no coupling"). Owner Decision B now makes an approved leaving date mandatory for `SEPARATED`. Migration `0034` enforces it on INSERT and on any UPDATE of `status` or `leaving_date`, and the service refuses any update of a `SEPARATED` employee that would leave the date empty. Rows that already exist in that state are **not rewritten** by the migration. Until each one has an approved date, the only edit that can succeed on it is supplying that date (or changing the status away from `SEPARATED`).

**A leaving date is never invented or inferred.** Not from `updated_at`, not from the date a status change happened to be recorded, not from the last login, not from the joining date, not from "today". Each date is a business fact that someone with the separation record must supply.

## 2. Authorization boundary

- Do **not** run any of this against a persistent database (`campusos_dev`, staging, production) without the repository's approved access procedure **and** explicit owner authorization for that run. A preflight is read-only but still reads personal-adjacent HR data.
- Run it as a superuser or `BYPASSRLS` role, inside a read-only transaction. `app.employees` is `FORCE ROW LEVEL SECURITY`: as `app_migrator` or `app_runtime` the statements see zero tenant rows and **a result of zero rows is then meaningless** (false pass). Statement (c) of §3 states whether the role bypasses RLS; an empty result counts only when it says `true`.
- Never apply `0034` (or any migration) as part of this procedure.

## 3. Read-only preflight

The statements run in one read-only transaction. The detail statement deliberately returns no names, e-mail addresses, user ids or any date that could be mistaken for a leaving date: only the organisation, the employee record id and code, the type and the joining date.

```sql
BEGIN READ ONLY;

-- (a) Summary per organisation. Expected result before rollout: no rows.
SELECT e.organization_id,
       count(*) AS separated_without_leaving_date
  FROM app.employees e
 WHERE e.status = 'SEPARATED' AND e.leaving_date IS NULL
 GROUP BY e.organization_id
 ORDER BY e.organization_id;

-- (b) Detail of the same rows, for the owner's review. Same expected result: no rows.
SELECT e.organization_id,
       e.id AS employee_id,
       e.employee_code,
       e.employee_type,
       e.joining_date
  FROM app.employees e
 WHERE e.status = 'SEPARATED' AND e.leaving_date IS NULL
 ORDER BY e.organization_id, e.employee_code, e.id;

-- (c) Visibility check. app.employees is FORCE ROW LEVEL SECURITY, so ONLY a superuser or a BYPASSRLS role sees every
--     tenant's rows. If sees_all_tenant_rows is false, (a) and (b) prove NOTHING (they are empty by construction): stop.
SELECT current_user::text AS run_as,
       (r.rolsuper OR r.rolbypassrls) AS sees_all_tenant_rows,
       (SELECT count(*) FROM app.employees) AS employees_visible_to_this_role
  FROM pg_roles r
 WHERE r.rolname = current_user;

ROLLBACK;
```

Interpretation:

| Result | Meaning | Action |
| --- | --- | --- |
| (c) `sees_all_tenant_rows` is `false` | the role is subject to RLS; (a) and (b) are empty regardless of the data | stop; the result is void; re-run as an approved superuser/`BYPASSRLS` role |
| (c) `sees_all_tenant_rows` is `true` and (a), (b) return no rows | no legacy rows | gate in §5 is satisfied; record the result (date, operator, database, ledger head) in the change record |
| (a) and (b) return rows | legacy rows exist | do **not** apply `0034`; follow §4 |

## 4. Reviewed backfill plan (to be run only after owner approval)

1. **Collect.** Give the owner the output of (b). It identifies records by organisation, record id and employee code; the owner's HR delegate looks the people up in the HR system. Do not widen the query to add personal columns; look-ups happen in the HR system, not in this database.
2. **Decide.** For every row the owner records, in the change record, either:
   - the **approved leaving date** (a real calendar date on or after the row's joining date, `employees_dates_ck`) together with the **source reference** (separation order, resignation acceptance or similar) and the **approver**; or
   - a different outcome (the employee is in fact still employed: change the status; the account is a data error: escalate). Nothing is guessed.
3. **Second review.** A second person checks every date against its source reference before anything is applied.
4. **Apply through the application, never with SQL.** For each row an organisation-scoped administrator (`COLLEGE_ADMIN`) sends `PATCH /api/v1/faculty/employees/{id}` with the current `If-Match` and a body of the form `{ "leavingDate": "YYYY-MM-DD", "reason": "<change record id>: separation order <ref>" }`. The status stays `SEPARATED`. This is the audited path: one `employee.update` audit event per row (risk tier 2, mandatory reason, field diff `leavingDate` null → date) written in the same transaction as the change, attributed to the administrator. Direct `UPDATE` statements, bulk scripts and `session_replication_role` tricks are not part of the plan: they would produce no audit event.
   - The service enforces a reason of 5 to 500 characters but **cannot verify evidence**: the source reference, the approver and the second reviewer are process controls recorded in the change record, and nothing is applied without them.
   - Use the build that is **currently deployed** (the one without `0034`). The `0034` build reads `app.employee_postings` and cannot run before the migration; the older build accepts the same request.
   - If rows are found only after `0034` was applied, the same request works on the new build: supplying the date is exactly the edit the guard allows (the date check against postings finds none for a legacy row).
5. **Verify.** Re-run §3: (a) and (b) must return no rows. Query the audit trail read-only for the processed record ids: `SELECT occurred_at, actor_user_id, resource_id, reason_text, changes FROM app.audit_events WHERE action = 'employee.update' AND resource_id = ANY(<ids from the change record>)` and attach the result to the change record.
6. **Record** anything not resolved. An unresolved row is a **rollout blocker**, not a warning.

## 5. Rollout gate

Applying `0034` to any persistent database is **blocked** until the preflight returns no rows for every organisation, or the owner has signed a written exception that names each remaining record and accepts that it cannot be edited until a date is supplied. Add this to the rollout checklist next to the person-identity and NULL-date preflights (`students-contract-rollout.md` §2). `0034` is deferred behind `0019` by the runner (it is not a `_contract` migration); that gate and `--through` are unchanged by this plan, and this plan does not authorize applying anything.

## 6. Limits

- The statements have never been run on a real server; the test above runs them on a disposable database that was populated by a superuser session with `session_replication_role = replica`, because the guard makes the legacy state unreachable any other way.
- The migration trigger is bypassable by a superuser or by `session_replication_role = replica`; those writers are outside the lifecycle guarantee and are not available to the application role.
- Employees that are `ACTIVE` or `ON_LEAVE` and carry a leaving date (a recorded notice period) are valid and are not reported.
