# 27 — Role administration API and `/access` page (Milestone 2, Batch B2)

Roadmap note. `04` Part 16 lists "role assignment UI (with reasons, expiry)" under **Milestone 2**; this batch builds the
API additions and the page behind it. It does not complete Milestone 2 (web push, invitation delivery, the student profile
UI and the "Done" demonstration remain). Nothing in `04` was changed.

## 1. What already existed (unchanged in meaning)

`RoleAssignmentService` (`shared/authorization/assignments.ts`, the only writer of `role_assignments`): grant and revoke with
a mandatory reason, grant rules and scope containment per grantor, no self-grant or self-revoke, the person-identity
invariant (student vs staff roles), scope locking, tier-2 audit in the same transaction. Routes `POST /users/:id/role-assignments`
and `POST /role-assignments/:id/revoke` (both CRITICAL). `valid_until` existed in the schema (migration `0005`, window check
and `status`/`valid_until`-only updates in `0006`, student-exclusivity trigger on `valid_until` in `0020`) and the engine
already filters every decision by `valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`.

## 2. Added

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/v1/roles` | `user.account.read` (SENSITIVE), organization scope | Roles of the caller's tenant that are in the platform role model (`ROLE_CODES`); allowed scope types; permission and critical-permission counts; `grantable` = the caller's role-level grant rule |
| `GET /api/v1/users/:id` | `user.account.read`, organization scope | The existing `UserDto`; `ETag` = version; foreign or unknown user: 404 |
| `GET /api/v1/users/:id/role-assignments` | `user.account.read`, organization scope | History included, newest first, at most 200, computed `state` (`EFFECTIVE`, `EXPIRED`, `PENDING`, `REVOKED`), scope name |
| `POST /api/v1/users/:id/role-assignments` | `role.assignment.grant` (CRITICAL) | New optional `validUntil` |
| `PATCH /api/v1/role-assignments/:id` | `role.assignment.grant` (CRITICAL) | Change or clear (`null`) the end; `If-Match` = assignment version (428 missing, 400 malformed, 409 stale); mandatory reason; tier-2 audit `role.assignment.update_expiry` with old and new |

Reads are SENSITIVE, not CRITICAL, on purpose: the page must load without a step-up. Every change stays CRITICAL and needs a fresh
`PASSWORD_MFA` (`minAssuranceForCritical` is unchanged). The queries on the role tables live in `shared/authorization` (a static
test allows no other module to read them); `UserService` proves the permission and the target user first.

## 3. Rules

- **Expiry** (`validUntil`): an ISO 8601 date-time **with an offset**, a real calendar date (the parser rejects `2030-02-30`,
  which `Date.parse` would silently roll over), not beyond the platform year bound, and strictly in the **future by the database
  clock**. It is enforced by authorization, not by the UI: an expired assignment confers nothing (`describeActor`, `assert` and
  `effectiveAdministratorIds` all filter on it). An expired assignment cannot be extended (`409 ASSIGNMENT_NOT_EFFECTIVE`); grant
  the role again (an expired row does not count as a duplicate). Changing an expiry needs the grantor's own authority over that
  role and scope, never on yourself, and a stale `If-Match` is a 409.
- **Administrators never expire.** A `COLLEGE_ADMIN` assignment cannot be granted or changed with an end date (400): the
  "last effective administrator" invariant is about *effective* administrators and a date would make one disappear silently.
- **Last effective administrator.** Revoking a `COLLEGE_ADMIN` assignment takes the tenant's administrator advisory lock (the same one
  `UserService.suspend` takes) and, if the organization had an effective administrator before and none after, rolls the whole
  transaction back (`409 LAST_ADMINISTRATOR`). **Defect fixed in this batch:** the previous reasoning ("only an administrator may revoke
  an administrator and not themselves, so one always remains") does not hold for two administrators revoking each other at the same
  moment; the integration test reproduces that without the lock (mutation-checked). The `LAST_ADMINISTRATOR` branch itself is a
  defensive backstop that the normal flow cannot reach (the caller is always an effective administrator); the race is closed by the lock
  and the loser answers `403` (it has lost its own authority) or `409`.
- Lock order for the new writer: person lock (the `0020` trigger re-takes it) before the assignment row; administrator lock before the
  assignment row for revocations.
- **Scope containment is exact-match** (documented elsewhere): a campus administrator cannot manage department-scoped assignments
  through this page either. The user list requires organization scope, so campus- and department-scoped administrators receive 403 from
  the reads and see an explanation; making the page useful to them is an open product decision (`PROJECT_CONTEXT.md` section 5, item 4).

## 4. The page (`/access`)

Route requires `role.assignment.grant` or `role.assignment.revoke` (UX guard only; the API decides). Users (filter, "load more"),
the selected user's assignments (role, scope, state, expiry), grant form (grantable roles only; the scope picker follows the role's
allowed scope types; no expiry field for an administrator role), inline revoke and expiry panels. Loading, empty, validation and API
error states use fixed wording. Every mutation runs through `runWithStepUp(…, 'PASSWORD_MFA')`: the prompt appears only on
`STEP_UP_REQUIRED`, the operation is retried at most once and never after a cancelled or failed verification (B1 contract). After a
success the assignments are reloaded from the server.

## 5. Not done / open

Campus- and department-scoped administration of accounts; user detail beyond the list row; a role-permission matrix view; bulk
assignment; notification of the grantee; the scheduled "expired" status transition (state is computed, never stored as EXPIRED).
No migration was needed or created.
