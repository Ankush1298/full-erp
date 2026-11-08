# Runbook (DRAFT) — database credential separation

Status: **draft for owner review; not an approved procedure and not yet in force.** It describes how the database credentials the code already distinguishes must be kept apart in any environment that holds real data. No value appears here: never write a password, connection string or token into this file, a ticket, a chat or a log. Production hosting, the secret manager and the people who hold each credential are open owner decisions (doc 46 §10).

## 1. The credentials (names of environment variables only)

| Credential                          | Variable                                                                                     | Database role                                                                           | What it may do                                                                                              | Used by                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Application runtime                 | `DATABASE_URL`                                                                               | `app_runtime` (LOGIN, NOSUPERUSER, NOBYPASSRLS, NOINHERIT, no object ownership, no DDL) | Tenant-scoped reads/writes through row-level security; column-limited writes on the global identity tables  | The running API only                                           |
| Migration                           | `MIGRATION_DATABASE_URL`                                                                     | `app_migrator` (same attributes; **owns** all application objects)                      | Run schema migrations; because it owns the tables it could alter or drop policies, so it is a powerful role | The migration step of a release, never the running application |
| Database administration / bootstrap | `DATABASE_ADMIN_URL`                                                                         | A PostgreSQL superuser (BYPASSRLS)                                                      | Create the two roles and schemas once; disposable-environment setup; seeding                                | First-time provisioning and local/CI only                      |
| Tenant provisioning (platform CLI)  | `PLATFORM_DATABASE_URL`, falling back to `DATABASE_ADMIN_URL`, then `MIGRATION_DATABASE_URL` | Whatever the variable points at                                                         | Create/suspend tenants, seed roles, issue first-administrator invitations and MFA tickets                   | The operator, on a trusted machine                             |
| Emergency operations                | none defined                                                                                 | none                                                                                    | –                                                                                                           | **Not yet designed** (see §6)                                  |

## 2. Rules

1. **Three roles, three secrets, never shared.** The runtime secret is never able to run DDL or bypass RLS; the migration secret is never present in the running application's environment; the administration secret never reaches an application host.
2. **No superuser in the application path.** A deployment whose `DATABASE_URL` resolves to a superuser or BYPASSRLS role must fail its release check (the security-db guardrail tests assert the roles' attributes).
3. **The platform CLI must not fall back silently.** Today it uses the first set of `PLATFORM_DATABASE_URL`, `DATABASE_ADMIN_URL`, `MIGRATION_DATABASE_URL`. In any environment with real data, set `PLATFORM_DATABASE_URL` explicitly and leave the other two unset on the operator machine so a missing value fails instead of using a stronger credential.
4. **Person-bound access.** Humans use named accounts with MFA to reach the secret store; no shared "admin" login; no credentials in shell history, repositories, images or tickets.
5. **Time-boxed, ticketed use.** Each use of the migration or administration credential on a persistent environment has a ticket naming purpose and window; the credential is fetched for that window only.
6. **Disposable versus real.** Local and CI databases are disposable and may use a superuser administration URL on the developer's own machine; first-administrator tokens print only for a local database (`PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT`). A persistent or shared environment never uses a developer-local credential and never holds real data until the readiness gates of doc 46 §9.1 pass.

## 3. Storage and rotation (expectations)

- Secrets live in the platform secret manager (provider not chosen), injected as environment variables to the process that needs them, never baked into images or committed.
- Rotate each credential at least [interval: owner decision] and immediately on suspected leak or staff change; rotating `app_runtime` or `app_migrator` means `ALTER ROLE ... PASSWORD` by the administrator, then redeploying the dependent process; verify login then revoke the old secret.
- Keep encryption keys (MFA, cursor, import-matching) in separate secrets with the rotation rules of `docs/runbooks/secrets.md`; a database credential and an encryption key must not sit in the same access group.

## 4. Logging and revocation

- Enable database connection and statement logging for the administration and migration roles, shipped to storage those roles cannot edit; review monthly.
- Enable cloud-console and secret-manager access logs.
- Revocation: remove the person from the access group, rotate every credential they could read, review their sessions' log; for a leaked runtime credential also revoke all application sessions (`platform.auth_sessions.revoked_at`) and rotate the cursor, MFA and import keys if the environment was readable.

## 5. Separation of duties

- The person who approves a use of the administration credential is not the person who uses it.
- Schema changes are reviewed by someone other than the author before the migration credential is used.
- Support staff do not hold any of these credentials; support access follows doc 46 draft 06 once a grant mechanism exists.

## 6. Gaps this runbook cannot close (doc 48 §3)

- **Provisioning uses a superuser today.** `tenant:create` and `tenant:seed` write RLS-protected tables, which only a BYPASSRLS role can do, so the CLI needs the administration credential. A narrower design (SECURITY DEFINER provisioning functions executed by a dedicated, non-superuser role) is proposed in doc 48 §3 and is **not** built; no new privileged role was created.
- **No emergency (break-glass) credential or tenant-approved support grant exists.** The former `support:grant` command was removed because it issued unauthenticated-looking tokens that authorised nothing.
- No audit of operator database sessions exists yet; this runbook only states the expectation.
