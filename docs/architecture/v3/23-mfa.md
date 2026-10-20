# 23 — TOTP multi-factor authentication (Milestone 1, Phase 1C)

Status: **implemented in code and tested on disposable databases only.** Migration `0030_user_mfa.sql` has **not** been applied to any persistent or production database. Rollout: `docs/runbooks/mfa-rollout.md`; key handling: `docs/runbooks/secrets.md` ("MFA encryption keys").

Sources: ADR-004 (TOTP mandatory for admin-class roles, step-up within 10 minutes for CRITICAL permissions, recovery codes), doc 08 (`user_mfa_factors`, `user_recovery_codes`, `sessions.mfa_verified_at`), doc 09 §8 (S-10/S-11 MFA tests), doc 10 rows 3a and 10a and rule 3, doc 11 §1C and §5.4, doc 12 line 13.

TOTP is a shared-secret, phishable second factor. It raises the cost of password theft; it is **not** phishing-resistant. WebAuthn/passkeys remain reserved (`factor_type` admits only `TOTP` today).

## 1. What exists

| Piece | Where |
| --- | --- |
| RFC 4226/6238 implementation (`node:crypto` only, no dependency) | `backend/src/modules/auth/mfa/totp.ts` |
| Secret encryption (AES-256-GCM) and recovery-code generation/hashing | `backend/src/modules/auth/mfa/mfa-crypto.ts` |
| Lifecycle service and admin reset | `backend/src/modules/auth/mfa/mfa.service.ts` |
| Routes | `backend/src/modules/auth/mfa/mfa.routes.ts`, `backend/src/modules/users/user.routes.ts` (`/users/:id/mfa/reset`) |
| Required-role policy and enforcement | `backend/src/shared/authorization/mfa-policy.ts`, `backend/src/modules/auth/auth.hook.ts` |
| Session assurance writer | `AuthRepository.recordMfaVerification` / `clearMfaAssurance` (`auth.repository.ts`) |
| Configuration | `MFA_ENCRYPTION_KEYS`, `MFA_ENCRYPTION_ACTIVE_KEY_ID` (`backend/src/config/env.ts`) |
| Schema | `database/migrations/0030_user_mfa.sql` |

## 2. TOTP algorithm and verification policy

- HMAC-SHA1, 6 digits, 30-second time step, T0 = 0 (RFC 6238 defaults; what every authenticator app supports). HMAC-SHA1 is not weakened by SHA-1 collision attacks.
- Secret: 20 random bytes (160 bits, RFC 4226 §4), returned once as unpadded RFC 4648 base32 and inside an `otpauth://totp/` URI (issuer `Anesa`, label `Anesa:<e-mail>`).
- Accepted window: the current step and **one step either side** (±30 s clock skew). Anything that is not exactly six ASCII digits is refused before any HMAC is computed; every candidate step is compared with `timingSafeEqual` without an early exit.
- **Replay prevention:** `user_mfa_factors.last_used_step` records the newest accepted step. Acceptance is an atomic `UPDATE … WHERE last_used_step IS NULL OR last_used_step < $step`, so a code (and any code of an older step, even inside the window) is accepted at most once, also under concurrency; a trigger refuses any decrease of the column.
- Tests: RFC 4226 Appendix D and RFC 6238 Appendix B vectors, step boundaries, ±1/±2 skew, malformed input (`backend/tests/unit/totp.test.ts`).

## 3. Secret storage and keys

- The TOTP secret is sealed by the application before it reaches the database: AES-256-GCM, a fresh random 96-bit IV per seal, 128-bit tag. Stored layout `[version=1][IV][tag][ciphertext]` in `secret_enc bytea`; the key ID in `secret_key_label`.
- AAD = purpose (`anesa/mfa-totp-secret`), format version, key ID, tenant, user and factor ID. A ciphertext copied to another row, user, tenant, key ID or purpose fails authentication (500 `MFA_SECRET_UNREADABLE`, generic, no detail).
- Keys come only from the dedicated ring `MFA_ENCRYPTION_KEYS` (32-byte base64url keys with IDs, same validated format as the cursor keys) and `MFA_ENCRYPTION_ACTIVE_KEY_ID`. **Required in production** (startup refuses without it), refused when it shares key material with `CURSOR_KEYS`, never logged (`Secret` wrapper). Outside production an absent ring means enrollment and TOTP verification answer `503 MFA_UNAVAILABLE`; there is no plaintext, hard-coded, derived or borrowed key.
- Rotation: new key added and made active; retiring keys keep decrypting; a factor sealed under a non-active key is re-encrypted under the active key on its next successful use. Procedure and completion criteria: `docs/runbooks/secrets.md`.
- Deviation recorded: doc 12 says "envelope encryption with an app-level KMS key". No KMS exists in this repository; the implementation uses the dedicated key directly (the approved decision). Introducing a KMS-wrapped data key later changes only `MfaSecretBox`.

## 4. Endpoints and authorization

All MFA self-service routes act on the **caller only**: no route takes a user, tenant or session identifier; the subject is the authenticated `TrustedContext`. They are mounted next to the existing `/auth/step-up` (root level, like every auth route), not under `/api/v1` as doc 11 §5.4 lists them.

| Route | Permission | Additional requirement | Effect |
| --- | --- | --- | --- |
| `GET /me/mfa` | `auth.mfa.manage` | — | status: enrolled, required, sessionVerified, pending, unused recovery codes; never a secret, code or hash |
| `POST /me/mfa/totp/enroll` | `auth.mfa.manage` | no ACTIVE factor: fresh step-up ≥ `PASSWORD_REAUTH` on this session; for MFA-required roles, a valid single-use 24h enrollment ticket is mandatory; ACTIVE factor (replacement): fresh `PASSWORD_MFA` | withdraws any pending enrollment, creates a PENDING factor (10-minute expiry, bound to this session and ticket), returns secret + URI once, `Cache-Control: no-store` |
| `DELETE /me/mfa/totp/enroll` | `auth.mfa.manage` | — | withdraws the pending enrollment |
| `POST /me/mfa/totp/verify` `{code}` | `auth.mfa.manage` | same session as enroll, not expired; rate-limited | activates (replacing an old factor atomically), consumes the enrollment ticket atomically, issues 10 recovery codes once (`no-store`), marks THIS session MFA-verified with a fresh `PASSWORD_MFA` step-up |
| `POST /auth/mfa/challenge` `{code}` or `{recoveryCode}` | `auth.mfa.manage` | ACTIVE factor (must be verified_enrollment if user holds an MFA-required role); rate-limited | marks THIS session MFA-verified and gives a fresh `PASSWORD_MFA` step-up |
| `POST /me/mfa/recovery-codes/regenerate` | `auth.mfa.manage` | ACTIVE factor, fresh `PASSWORD_MFA` | invalidates every unused code, returns 10 new ones once (`no-store`) |
| `DELETE /me/mfa/totp` | `auth.mfa.manage` | **refused (403 `MFA_DISABLE_FORBIDDEN`) while the caller holds an MFA-required role**; otherwise fresh `PASSWORD_MFA` | revokes factor and unused codes, drops MFA/step-up assurance on every live session of the membership |
| `POST /api/v1/users/:id/mfa/reset` `{reason}` | `user.account.reset_mfa` (CRITICAL) | see §7 | revoke-only reset of another user |
| `POST /api/v1/users/:id/mfa/enrollment-ticket` `{reason}` | `user.account.reset_mfa` (CRITICAL) | fresh `PASSWORD_MFA`, STAFF actor, ORGANIZATION scope, never oneself, `mayActOnAllRolesOf` | issues a single-use 24-hour enrollment ticket for the target user; stores SHA-256 hash |

`auth.mfa.manage` (NORMAL) is held SELF by every role (doc 10 row 3a). `user.account.reset_mfa` (CRITICAL) is new (doc 10 row 10a), granted to CAMPUS_ADMIN and COLLEGE_ADMIN like `user.account.reset_password`; like `user.account.suspend`, it is evaluated at ORGANIZATION scope only, so the CAMPUS_ADMIN grant is inert (403).

Wrong, malformed, replayed or unusable codes always answer the same `401 INVALID_CREDENTIALS`; they also increment the shared account failure counter (`platform.identities.failed_login_count`; 10 failures lock the account for 15 minutes across login, password step-up and MFA) and are audited.

## 5. Session assurance

| Session column | Written by | Meaning |
| --- | --- | --- |
| `mfa_verified_at` (new, `0030`) | `recordMfaVerification` only, after a verified TOTP or recovery code for the session's own user | this session completed a second factor; lasts for the session's lifetime |
| `step_up_at`, `auth_strength` (`0029`) | `recordStepUp('PASSWORD_REAUTH')` after a password re-entry; `recordMfaVerification` sets `PASSWORD_MFA` | freshness for CRITICAL actions (10 minutes) |

- `minAssuranceForCritical` stays `'PASSWORD_MFA'` (static test). Password re-authentication still records only `PASSWORD_REAUTH` and never satisfies a CRITICAL route; a static test pins that `PASSWORD_MFA` is written by exactly one repository statement, called only from the MFA service.
- Assurance is per session and per user: it is written for the authenticated session row only (re-read and checked for tenant, revocation, expiry and an ACTIVE, unlocked identity inside the same transaction). Login always creates a fresh session with no MFA state; logout and revocation end it; disabling MFA clears it on every session of the membership; an administrative reset revokes every session of the target.
- **Role promotion assurance invalidation:** When an account is granted an MFA-required role in `RoleAssignmentService.grant`, all active sessions of that user have their MFA assurance cleared (`mfa_verified_at = NULL, step_up_at = NULL, auth_strength = 'PASSWORD'`), forcing immediate re-evaluation and second-factor verification. If the user had self-enrolled voluntarily without an administrator ticket (`verified_enrollment = false`), challenges are refused (`403 MFA_UNVERIFIED_FACTOR`) until an administrator issues a ticket and verified enrollment occurs.

## 6. Required roles and enforcement

- Policy (ADR-004 default): HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (`MFA_REQUIRED_ROLES`). ADR-004's tenant setting `security.mfa_required_roles` is **not built**; the default applies to every tenant. A future setting must only add roles.
- Enforcement (doc 09 §8 "cannot obtain a session with admin capabilities without MFA"): in the shared preHandler, before the permission check, a session without `mfa_verified_at` whose user currently holds an effective MFA-required role assignment gets `403 MFA_REQUIRED` on every route except those whose permissions are all in {`session.read`, `session.revoke`, `auth.mfa.manage`}. The denial is audited (`auth.authorization_denied`, reason `MFA_REQUIRED`).
- Roles are evaluated per request: a role granted mid-session restricts the next request; a revoked role lifts the restriction. Users outside the policy may enroll voluntarily; they are never restricted.

### First-admin bootstrap and enrollment tickets

- **Controlled enrollment tickets:** For users in MFA-required roles, self-enrollment cannot be initiated without a single-use 24-hour ticket issued by an authorized administrator (`POST /api/v1/users/:id/mfa/enrollment-ticket`) holding fresh `PASSWORD_MFA`. This prevents an attacker with compromised first-factor credentials from locking out legitimate administrators by enrolling an attacker-controlled second factor.
- **First-admin bootstrap:** Remains strictly **fail-closed**. There is no public, unauthenticated bootstrap bypass or password-only backdoor. Initial tenant provisioning or break-glass operator procedures must securely establish or issue the first administrator's enrollment ticket in an approved administrative channel.
- **Atomic consumption:** Tickets are bound to the tenant and target user, checked with `FOR UPDATE`, and atomically consumed on confirmation (`used_at = now()`). Partial unique indexes enforce at most one active factor per user and single ticket binding.
- Partially completed enrollment: a PENDING factor expires after 10 minutes and is withdrawn by the next enrollment start or by `DELETE /me/mfa/totp/enroll`. Unavailable encryption configuration: enrollment and TOTP verification fail closed with 503; recovery codes still work.

## 7. Recovery codes, disable and administrative reset

- Recovery codes: exactly 10 per set, each 20 Crockford-base32 symbols (100 random bits), shown once. Stored as SHA-256 over a purpose/version prefix, tenant, user and the normalised code (unique per owner). A fast hash is appropriate for 100-bit random codes (unlike passwords). Consumption is one atomic `UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL`; used and revoked codes are terminal (trigger). Regeneration and confirmation of a new factor invalidate every earlier unused code. A successful use is audited with the remaining count.
- Disable: refused for MFA-required roles (an administrator must reset instead). Otherwise needs a fresh `PASSWORD_MFA`.
- **Administrative reset** (`POST /api/v1/users/:id/mfa/reset`): CRITICAL, so the shared gate demands the **administrator's own fresh `PASSWORD_MFA`** step-up; the service requires a STAFF actor, the permission at ORGANIZATION scope, a reason (5–500 characters), a target that is not the caller, and the grant rules: the administrator must be allowed to grant every role the target holds (a campus administrator can never reset a college administrator). It calls `platform.admin_reset_user_mfa`, which can only **revoke** (factors to `REVOKED`/`ADMIN_RESET`, unused codes to revoked) inside the caller's tenant, then revokes every live session of the target. Audited at risk tier 3 with the reason. The administrator receives no secret, no code, no session and no assurance; the target signs in with their own password and must be issued an enrollment ticket to re-enroll.

## 8. Audit events, rate limits, logging

| Action | Tier | Notes |
| --- | --- | --- |
| `auth.mfa.enroll_start` | 2 | metadata `replacing` |
| `auth.mfa.enroll_cancel` | 1 | |
| `auth.mfa.enroll_confirm` / `auth.mfa.enroll_confirm_failed` | 2 | replaced factor id, issued code count |
| `auth.mfa.challenge` / `auth.mfa.challenge_failed` | 2 | `method` TOTP or RECOVERY_CODE, `unusedCodes` after a recovery code |
| `auth.mfa.recovery_codes_regenerate` | 2 | |
| `auth.mfa.disable` | 2 | sessions downgraded |
| `auth.mfa.admin_reset` | 3 | reason; factors, codes and sessions revoked |
| `auth.mfa.enrollment_ticket_issue` | 3 | reason; ticketId, expiresAt |
| `auth.authorization_denied` | 2 | reasons `MFA_REQUIRED`, `STEP_UP_REQUIRED` |

- No audit row, log line or error carries a secret, a provisioning URI, a recovery code or a code hash (audit key denylist includes `secret`, `totp`, `recoverycode`; tested end to end in `backend/tests/integration/mfa.test.ts`).
- Code attempts (`/me/mfa/totp/verify`, `/auth/mfa/challenge`) are budgeted per IP, per session and per user (5 per 15 minutes) by an in-process `FixedWindowLimiter`: **single instance only**, like the other limiters; the shared account lockout above is database-backed and holds across instances.

## 9. Known limitations and open decisions

1. First-admin bootstrap procedure for freshly provisioned tenants (§6) requires an agreed operational standard (e.g. provisioning CLI with operator-signed key or initial onboarding link).
2. No second approver for administrative MFA reset; no notification to the affected user (no mail provider is approved).
3. Single-administrator tenants: if the only COLLEGE_ADMIN loses the authenticator and every recovery code, nobody in the tenant can reset them; recovery is the operator break-glass in the rollout runbook.
4. `security.mfa_required_roles` setting not built (§6).
5. Rate limiter is per process.
6. The web client (`apps/web`) includes the MFA frontend experience: enrollment, challenge, recovery codes, and AccountPage management. Raw secrets and recovery codes are held strictly in React component memory and never written to storage or console.
7. Platform operators (`platform_admins`, doc 08) are not built; their MFA is not covered here.
