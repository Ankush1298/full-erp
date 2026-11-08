# Runbook — first-administrator onboarding (operator only)

Scope: creating one **synthetic** institution and activating its first administrator on a **local development or disposable** database. This is not authorised for a real school, a shared environment or production (owner decision OD-I1 is PROPOSED, not approved; doc 45 §5). Every secret below is shown as a placeholder: never write a real token, ticket or password into a ticket, chat, document or log.

## Who and where

- The operator runs the commands on their own machine with the platform database URL in `DATABASE_ADMIN_URL` (a privileged connection; never the application's runtime role).
- Commands that print a one-time secret refuse unless **all** hold: `NODE_ENV` is not `production`, `PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT=true` is set for that command, and the database host is this machine (`localhost`, `127.0.0.1`, `::1` or a socket). The refusal happens **before** anything is issued.
- There is no HTTP endpoint for any of this and no way to issue a token from the web app.

## Steps

All commands run from `backend/` as `pnpm platform:cli <command> ...` (or `tsx tools/platform/cli.ts`).

1. **Create the institution and name its administrator**
   `tenant:create --name "<institution name>" --slug <slug> --admin-email <administrator email>`
   Creates the tenant, the eight roles with their grants, and one `INVITED` administrator holding COLLEGE_ADMIN at organization scope. No password, no identity and no token exist yet.
2. **Issue the invitation**
   `PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT=true admin:invite --tenant <slug> [--admin-email <email>] [--hours 1-72] [--reason "<text>"]`
   Prints the user id, expiry (default 24 h, maximum 72 h) and the invitation code (the token) **once**. Only the SHA-256 of the token is stored. Running the command again withdraws the earlier unused token (at most one live token). Use `--admin-email` if more than one invited COLLEGE_ADMIN exists. To cancel: `admin:invite-revoke --tenant <slug> --reason "<text>"`.
3. **Hand the token to the administrator** through a channel you trust (in person, for the pilot). Invitation e-mail is not built (doc 45 G4).
4. **The administrator activates the account** on the sign-in site's accept-invitation page (`/accept-invite`) by entering the token and choosing a password of at least 12 characters. The token is consumed on success only; a rejected password leaves it usable. A used, expired, withdrawn or unknown token gives the same generic error.
5. **Issue the MFA enrolment ticket** (only after step 4; the tool refuses before):
   `PLATFORM_ALLOW_LOCAL_TOKEN_OUTPUT=true admin:mfa-ticket --tenant <slug> [--admin-email <email>] [--reason "<text>"]`
   Prints the ticket once (valid 24 h, single use). Re-running replaces the previous ticket. It is refused once any administrator of the tenant has a verified authenticator.
6. **The administrator signs in, confirms their password (step-up) and enrols** an authenticator app, pasting the ticket at the enrolment prompt and verifying the first code. Until then every administrative route answers 403 (MFA required).
7. **Verify**: the administrator can open organization settings and is shown the recovery codes once. Then they choose the institution type (doc 44), which is a separate, audited, step-up action.

## What is recorded

Tier-3 system audit events (ids, expiry, reason; **never** a token or ticket): `platform.first_admin.invite_issue`, `platform.first_admin.invite_revoke`, `auth.mfa.bootstrap_ticket_issue`; plus the normal `user.invitation_accept` and MFA enrolment events written by the application.

## Failures and meanings

| Error                  | Meaning                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_ONLY`           | The guard in "Who and where" is not satisfied. Nothing was issued.                                                     |
| `TENANT_NOT_FOUND`     | Unknown or non-active tenant.                                                                                          |
| `NO_DESIGNATED_ADMIN`  | No invited, not yet activated COLLEGE_ADMIN (or the e-mail does not match).                                            |
| `AMBIGUOUS_ADMIN`      | More than one candidate: pass `--admin-email`.                                                                         |
| `ADMIN_ALREADY_ACTIVE` | An organization administrator is already active; this path is closed for the tenant (no second initial administrator). |
| `NO_ACTIVE_ADMIN`      | The invitation has not been accepted yet.                                                                              |
| `INVALID_TTL`          | `--hours` outside 1 to 72.                                                                                             |

## Limits

Delivery is manual. The recovery path for a lost authenticator is the existing administrative MFA reset, which needs another administrator; a sole administrator who loses both authenticator and recovery codes needs an operator procedure that is not yet defined.
