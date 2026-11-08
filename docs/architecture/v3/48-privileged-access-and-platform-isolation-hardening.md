# 48 — Privileged access and platform isolation hardening (slice 1)

Status: implemented and tested on synthetic data in disposable databases, uncommitted, 2026-11-07. Follows doc 46. It authorises no production deployment, real-school data, credential change or acceptance of M3/M4; the legal drafts remain **DRAFT — NOT LEGALLY APPROVED**. No platform-wide private-data access was added, and no new privileged role exists.

## 1. Summary of what changed

| Change                                                                               | Effect                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `support:grant` removed (fails closed)                                               | No support token can be issued; no fallback signing key remains (§2)                                                                        |
| Migration `0043`                                                                     | `app_runtime` loses DELETE on `platform.identities` and `platform.auth_sessions` and can write only the columns the application writes (§4) |
| Guardrail tests `privilege-guardrails.test.ts` + `tests/support/privilege-policy.ts` | Dynamic catalog checks of roles, RLS, grants and SECURITY DEFINER functions with a documented exception policy (§5)                         |
| Draft runbook `docs/runbooks/database-credential-separation.md`                      | Credential separation expectations (§3, no values)                                                                                          |

## 2. The support-grant stub

**Confirmed from source** (`backend/tools/platform/platform-cli.ts`, `cli.ts` before this change): `createSupportGrant` built a JSON payload (tenant id, admin e-mail, expiry, random id), signed it with HMAC-SHA-256 using `SESSION_SECRET` **or the literal fallback `support-grant-local-key`**, and printed `payload.signature`. It stored nothing, wrote no audit event, and nothing verified the token. A search of `backend/src` found **no consumer**; the only references were the CLI, two tests of the function and documentation. Nothing depended on it.

**Deficiency:** a token that looks like a signed break-glass grant but authorises nothing, signed with a public-in-the-repository key when no secret is set. If a verifier were ever added without removing it, anyone who knew the literal could forge grants.

**Containment (no replacement built):**

- `createSupportGrant()` now only throws `SupportGrantsNotImplementedError` (message: platform support grants are not implemented; no support token can be issued; use the documented privileged-access procedure). The result type, the HMAC code and the fallback key are deleted.
- `cli.ts support:grant` exits 1 with that message **before** reading any database URL or secret, connecting, or printing anything.
- Other commands (`tenant:create`, `tenant:seed`, `tenant:suspend`, `admin:invite`, `admin:invite-revoke`, `admin:mfa-ticket`) are unchanged.
- Tests: the CLI is run as a real process with no database environment (exit 1, message on stderr, empty stdout, no token-shaped output); a source scan of `backend/src` and `backend/tools` finds no `support-grant-local-key` and no `grantToken`; the integration test confirms nothing is written or audited.
- Historic documents (doc 11 line 142, doc 46 evidence) still mention the command; they are history and were not rewritten.

**Behaviour change for operators:** `support:grant` no longer works. Until a tenant-approved, stored, audited grant mechanism is designed and approved, any support access follows the draft privileged-access procedure (legal draft 06, runbook §6 here).

## 3. Database privilege map (verified against the disposable database catalog)

| Purpose                                   | Credential variable                                                                     | Role (verified attributes)                                                                                                                                         | Notes                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal application requests               | `DATABASE_URL`                                                                          | `app_runtime`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE/DB, NOREPLICATION, NOINHERIT; no CREATE on database, `app`, `platform` or `public`; member of no role | `Database.withTenant` sets the tenant context per transaction; every `app.*` table is RLS-enabled and forced                                                                                             |
| Authentication and session operations     | `DATABASE_URL` (same role) via `Database.withSystem`                                    | `app_runtime` with **no tenant context**                                                                                                                           | `withSystem` runs before a tenant is known. `app.*` tables return nothing without context; `platform.*` is readable (the residual in §4). Cross-tenant steps use five SECURITY DEFINER functions (below) |
| Tenant provisioning (platform CLI)        | `PLATFORM_DATABASE_URL` → falls back to `DATABASE_ADMIN_URL` → `MIGRATION_DATABASE_URL` | whatever the variable names                                                                                                                                        | `tenant:create`/`tenant:seed` write RLS-protected tables that even their owner cannot write from outside a tenant context, so in practice a **superuser/BYPASSRLS** connection is used: overuse          |
| Migrations                                | `MIGRATION_DATABASE_URL`                                                                | `app_migrator`: same attributes as runtime, but **owns every `app`/`platform` object**                                                                             | FORCE RLS applies to owners for ordinary queries, yet an owner can `ALTER TABLE ... NO FORCE`, disable RLS or drop policies, so this role is powerful                                                    |
| Bootstrap, seeding, dev/CI administration | `DATABASE_ADMIN_URL`                                                                    | cluster superuser (in the test cluster `postgres`; the only superuser/BYPASSRLS role the guardrail test allows)                                                    | one-time role/schema creation; dev seeding; tests                                                                                                                                                        |
| Platform operator tasks                   | as provisioning                                                                         | as provisioning                                                                                                                                                    | no separate role exists                                                                                                                                                                                  |

Verified in the catalog: all `app` tables are owned by `app_migrator`; `PUBLIC` holds no privilege on any table or on the `app`/`platform` schemas; `PUBLIC` cannot execute any function in them; `app_runtime` holds no TRUNCATE, REFERENCES or TRIGGER anywhere and DELETE only on `app.curriculum_courses` and `app.student_guardians` (documented exceptions, still tenant-confined by RLS).

**SECURITY DEFINER functions (complete approved set, all owned by `app_migrator`, search_path pinned, EXECUTE only for the two roles):** `app.context_ok`, `platform.get_identity_memberships`, `platform.lock_invitation`, `platform.complete_invitation`, `platform.admin_reset_user_mfa`. The guardrail fails on any other, on a missing or `public`-containing search_path, or on PUBLIC execute.

**Where privileged connections are necessary:** one-time bootstrap (superuser), migrations (owner role), tenant creation/seeding (BYPASSRLS today).
**Where they are overused:** (1) the CLI's silent fallback from `PLATFORM_DATABASE_URL` to the admin and then the migrator URL; (2) every provisioning action, including the new first-administrator commands, runs on a superuser although each needs only a few INSERTs/UPDATEs; (3) there is no separate audit of operator sessions.
**Proposal (not built, no new role created):** provisioning through a small set of SECURITY DEFINER functions (`provision_tenant`, `seed_tenant_roles`, `issue_first_admin_invite`, …) executed by one dedicated non-superuser, non-BYPASSRLS `app_provisioner` role, with statement logging, so the CLI never needs a superuser and each action is bounded. This needs an owner-approved design and its own migration.

## 4. Identity and session tables

**Are they tenant business tables? No.** `platform.identities` (e-mail, argon2id hash, lockout counters) is one global login identity that may belong to several tenants; sign-in looks it up by e-mail before any tenant is known. `platform.auth_sessions` is looked up by token hash before a tenant context exists. Tenant RLS cannot be added without breaking sign-in, so the guardrail classifies them as **approved global tables** (exception policy with reason, owner, review condition) rather than ignoring them or forcing RLS.

**What the code actually needs** (from every SQL statement touching them in `AuthRepository`, `RoleAssignmentService`, `AuthService`):

- `identities`: SELECT six columns; INSERT `id, email, password_hash, status`; UPDATE `failed_login_count, locked_until`. Never DELETE; no password-change or e-mail-change feature exists.
- `auth_sessions`: SELECT nine columns; INSERT `id, identity_id, tenant_id, token_hash, expires_at`; UPDATE `revoked_at, step_up_at, auth_strength, mfa_verified_at`. Never DELETE.

**Implemented (migration `0043`, forward-only, no data touched):** revoke table-wide INSERT/UPDATE/DELETE from `app_runtime` and grant exactly those column lists. A compromised runtime can no longer delete identities or sessions, overwrite a password hash/e-mail/status, re-point a session to another identity or tenant, extend a session's `expires_at` or replace its token hash. All 1,647 integration tests (login, MFA, invitations, step-up, role grants, tenant isolation) pass unchanged, and a behaviour test proves each refused statement returns `42501` while lockout and revoke updates still work.

**Not implemented — documented blockers:** SELECT stays table-wide, so a compromised runtime process can still read **every tenant's login e-mails, password hashes and session token hashes** (the hashes are slow argon2id and SHA-256 of 256-bit tokens; reading them does not by itself yield a session). Closing this needs the login/session path rebuilt on SECURITY DEFINER functions returning minimal rows: about thirteen statements in `AuthRepository` (two lookups by e-mail, one `FOR UPDATE` lookup plus `INSERT ... ON CONFLICT` in the invitation flow, session lookups by hash and id, six session updates), the identity-status check in `AuthService`, and the session update in `RoleAssignmentService`. `FOR UPDATE` row locking, the lockout arithmetic, and the existing mocks in the auth tests must be preserved. That is a design-and-test task of its own (§7), not a quick privilege change, and doing it partially would risk breaking authentication. **Residual risk P1-1 is therefore narrowed, not closed.**

## 5. Guardrail tests (`tests/security-db/privilege-guardrails.test.ts`, 19 tests)

They read the live catalog, so a future table, grant or function is judged by rule, with no table counts or migration names:

1. Role attributes of `app_runtime`/`app_migrator` (no superuser, BYPASSRLS, CREATEROLE/DB, replication, inheritance; no role memberships); the **only** other superuser/BYPASSRLS role in the cluster is the provisioning role the harness connects with.
2. No CREATE on the database or on `app`/`platform`/`public` for either role; PUBLIC has no schema access.
3. Every table in `app`/`platform` is tenant-owned (has `organization_id`) or listed in `GLOBAL_TABLES` with reason, owner, review condition, expected RLS state and allowed runtime privileges; stale entries fail.
4. Every tenant table has RLS enabled **and** forced; all application tables are owned by the migration role.
5. For every tenant table and every privilege `app_runtime` actually holds, a permissive policy for that command references the tenant context.
6. A tenant-A session sees zero rows of any other tenant in every readable table (checked where other tenants' rows exist), and a session with no context sees no tenant row.
7. No TRUNCATE/REFERENCES/TRIGGER for the runtime role; DELETE only through documented exceptions; no grantee other than the owner, runtime role and cluster administrator on any table.
8. Column-level write grants on the two identity tables equal the documented lists; hostile statements (delete, password/e-mail/status/identity/tenant/expiry/token-hash rewrites, TRUNCATE) are refused with `42501`; legitimate lockout and revoke updates run.
9. SECURITY DEFINER functions: only the approved five; owner, pinned search_path, no `public`, no PUBLIC execute; no function in either schema is executable by PUBLIC.
   A mutation check was run: removing the `platform.identities` and `student_guardians` exceptions made three guardrail tests fail, then the file was restored.

## 6. Risk status after this slice (doc 46 register)

| Risk                            | Status                      | Basis                                                                                                                    |
| ------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P0-3 `support:grant` stub       | **Mitigated**               | Removed; tests in §2 pass. No replacement exists, so real support access remains an unbuilt control (still part of P0-2) |
| P0-2 privileged/operator access | **Open, better understood** | Privilege map and overuse documented; no PAM, session recording or role split built                                      |
| P0-1, P0-4, P0-5, P0-6, P0-7    | **Open**                    | Not addressed                                                                                                            |
| P1-1 identity/session tables    | **Partly mitigated**        | Destructive and rewrite powers removed (tested); cross-tenant SELECT remains                                             |
| P1-5 platform realm             | Open                        | Not built                                                                                                                |

## 7. Next recommended security task

Build the **provisioning role and functions** (§3 proposal) so the CLI no longer needs a superuser, then **function-based identity/session access** (§4) to remove cross-tenant SELECT. Both need an owner-approved design, a migration and updated auth tests. Before either, decide who holds each credential in a real environment (doc 46 §10).

## 8. Validation

Commands and counts are in PROJECT_LOG (2026-11-07 "Security hardening slice 1").
