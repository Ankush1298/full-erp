# Runbook: TOTP MFA rollout (migration 0030, `MFA_ENCRYPTION_KEYS`)

Status: **design and checklist only. Nothing in this document has been executed against any persistent or production database.** Migration `0030_user_mfa.sql` and the MFA code have run only on disposable test databases. Design: `docs/architecture/v3/23-mfa.md`. Key handling: `docs/runbooks/secrets.md` ("MFA encryption keys").

## 1. What changes at deploy time

- **Every user holding HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN or REGISTRAR loses all administrative capability until each session completes a second factor** (`403 MFA_REQUIRED`). They keep: `/auth/me`, `/auth/step-up`, the MFA routes. Communicate this before the deploy.
- CRITICAL routes (`org.settings.manage`, `user.account.suspend`, `student.status.change`, `user.account.reset_mfa`, and `role.assignment.*` once routed) become usable for the first time: they need a fresh `PASSWORD_MFA` step-up, which only a verified TOTP or recovery code produces.
- The production process refuses to start without `MFA_ENCRYPTION_KEYS` and `MFA_ENCRYPTION_ACTIVE_KEY_ID`.
- The web client (`apps/web`) provides the full MFA user experience: challenge, enrollment, recovery codes, and AccountPage management.

## 2. Rollout ordering and prerequisites (operator responsibility)

The rollout MUST follow this strict sequence:

1. **Keys provisioned in secret manager**:
   - `MFA_ENCRYPTION_KEYS` (JSON map of `{ [keyId]: hex-encoded-32-byte-key }`) and `MFA_ENCRYPTION_ACTIVE_KEY_ID` configured in the environment per `docs/runbooks/secrets.md`.
   - Stored with an offline backup **before** any user enrolls. Losing every copy of a key makes every factor sealed with it permanently unreadable (§6).
2. **Apply migration `0030_user_mfa.sql`**:
   - Applies schema changes (new tables, session column) and **automatically grants default MFA permissions to existing tenants** (`auth.mfa.manage` with `scope_mode = 'SELF'` to all system roles, and `user.account.reset_mfa` with `scope_mode = 'GRANTED'` to `CAMPUS_ADMIN` and `COLLEGE_ADMIN`) via idempotent `ON CONFLICT DO NOTHING` statements.
   - Preserves tenant-customized permissions and existing role definitions without destructive overwrites.
3. **Run pre-enforcement verification queries** (§3):
   - Superuser/BYPASSRLS verification confirming migration ledger, permission catalog, role-permission mappings across all existing tenants, and required-role user inventory.
4. **Issue first-administrator bootstrap tickets** (§4):
   - For each tenant without an already enrolled administrator, invoke the operational bootstrap mechanism (`issueFirstAdminBootstrapTicket`) from the operational boundary (e.g., during tenant provisioning or operational CLI).
   - Securely deliver the single-use 24-hour bootstrap ticket out of band to the designated `COLLEGE_ADMIN`.
5. **Initial administrator enrollment & verification**:
   - Designated administrators log in, step-up, enroll with the bootstrap ticket, and complete verification (`POST /me/mfa/totp/verify`).
   - Operator queries confirm that `verified_enrollment = TRUE` on the factor, consuming the ticket and permanently disabling future bootstrap for the tenant.
6. **Deploy enforcing application build**:
   - Deploy the build with MFA enforcement active (`minAssuranceForCritical: 'PASSWORD_MFA'`).
   - Required-role users without MFA will receive `403 MFA_REQUIRED` on administrative routes and must enroll using tickets issued by their verified `COLLEGE_ADMIN`.

## 3. Applying the migration and operator verification

```
pnpm db:migrate --through 0030 --dry-run          # on a ledger at 0029: plans exactly [0030]
pnpm db:migrate --through 0030
```

On a ledger below `0019` the commands of `students-contract-rollout.md` apply; name `--through 0029` there if `0030` is not yet approved. `0030` takes `ACCESS EXCLUSIVE` on `platform.auth_sessions` for one `ADD COLUMN` (nullable, no default: catalog-only) under `lock_timeout = 5s`; hold time unmeasured. Forward-only: there is no rollback after commit. Reverting the application build to one without MFA leaves `0030` harmless (new tables unused, nullable column ignored) but **removes the MFA requirement**: treat a rollback of the build as a security decision.

### Verification Queries (Superuser / BYPASSRLS)

Before enabling the enforcing application build, operators must execute and verify the following read-only checks:

```sql
-- 1. Verify migration ledger head includes 0030
SELECT version, name, applied_at
  FROM platform.schema_migrations
 WHERE version = '0030';

-- 2. Verify permission registration
SELECT code, sensitivity
  FROM platform.permissions
 WHERE code IN ('auth.mfa.manage', 'user.account.reset_mfa');

-- 3. Verify existing tenant role permissions received assignments
-- Expect: auth.mfa.manage (SELF) for all 8 roles; user.account.reset_mfa (GRANTED) for CAMPUS_ADMIN and COLLEGE_ADMIN
SELECT r.organization_id, r.code AS role_code, rp.permission_code, rp.scope_mode
  FROM app.role_permissions rp
  JOIN app.roles r ON r.id = rp.role_id
 WHERE rp.permission_code IN ('auth.mfa.manage', 'user.account.reset_mfa')
 ORDER BY r.organization_id, r.code, rp.permission_code;

-- 4. Check for any required-role tenant without auth.mfa.manage (must be 0 rows)
SELECT r.organization_id, r.code
  FROM app.roles r
 WHERE r.code IN ('HOD','DEPARTMENT_ADMIN','CAMPUS_ADMIN','COLLEGE_ADMIN','REGISTRAR')
   AND NOT EXISTS (
     SELECT 1 FROM app.role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_code = 'auth.mfa.manage'
   );

-- 5. Inventory required-role users and their factor verification status
SELECT ra.organization_id,
       r.code AS role_code,
       u.id AS user_id,
       u.email,
       COALESCE(bool_or(f.status = 'ACTIVE' AND f.verified_enrollment), false) AS is_mfa_enrolled
  FROM app.role_assignments ra
  JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
  JOIN app.users u ON u.id = ra.user_id
  LEFT JOIN app.user_mfa_factors f ON f.user_id = u.id AND f.status = 'ACTIVE'
 WHERE r.code IN ('HOD','DEPARTMENT_ADMIN','CAMPUS_ADMIN','COLLEGE_ADMIN','REGISTRAR')
   AND ra.status = 'ACTIVE'
   AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())
 GROUP BY ra.organization_id, r.code, u.id, u.email
 ORDER BY ra.organization_id, r.code, u.email;
```

## 4. Enrollment tickets and first-administrator bootstrap

For users in MFA-required roles, self-enrollment requires a single-use 24-hour enrollment ticket. This prevents an attacker with compromised first-factor credentials from locking out legitimate administrators by enrolling an attacker-controlled second factor.

### First-Administrator Operational Bootstrap

When a tenant is first provisioned or during initial MFA rollout, no administrator yet has an MFA-verified session to call the administrative ticket issuance API (`POST /api/v1/users/:id/mfa/enrollment-ticket`).

To solve this without public endpoints, static secrets, or password-only bypasses, Smart Campus OS provides an auditable operational bootstrap function:
`issueFirstAdminBootstrapTicket(db, { organizationId, targetUserId })` (in `backend/src/shared/authorization/mfa-bootstrap.ts`).

#### Security Guarantees & Constraints:
- **Operational Authority Only**: Bootstrap tickets are created with `created_by = NULL`. The database RLS policy (`mfa_enrollment_tickets_issuer_insert`) strictly forbids regular application sessions (`app_runtime`) from inserting rows with `created_by IS NULL`. Furthermore, because `FORCE ROW LEVEL SECURITY` applies to table owners without bypass privileges, `app_migrator` has no tenant write access. Only an operational provisioning process using `DATABASE_ADMIN_URL` (superuser / `BYPASSRLS`) can invoke this function.
- **Strict Role & Target Binding**: The target user must be ACTIVE and hold an ACTIVE `COLLEGE_ADMIN` role assignment in the specified ACTIVE organization.
- **Fail-Closed Once Enrolled**: The function queries the tenant to verify that **NO user** holding any required role (`HOD`, `DEPARTMENT_ADMIN`, `CAMPUS_ADMIN`, `COLLEGE_ADMIN`, `REGISTRAR`) has an active verified factor (`status = 'ACTIVE' AND verified_enrollment = TRUE`). If ANY required-role user is enrolled, bootstrap is permanently disabled with `409 BOOTSTRAP_DISABLED`. In addition, `startEnrollment` independently verifies this invariant when redeeming bootstrap tickets, and factor confirmation revokes any lingering bootstrap tickets.
- **Single-Use & 24h Expiry**: The ticket uses a cryptographically secure 32-byte hex token (stored as a SHA-256 hash), expires in 24 hours, revokes all prior unconsumed bootstrap tickets for the organization, and is consumed atomically upon factor verification.
- **Auditable**: Every issuance logs a structured operational audit event (`auth.mfa.bootstrap_ticket_issue`, risk tier 3, actor type SYSTEM) recording the target user and organization.

#### Operational Procedure for First-Admin Bootstrap:
1. Operator connects to the provisioning environment and executes the bootstrap script using `DATABASE_ADMIN_URL` targeting the tenant's primary `COLLEGE_ADMIN`:
   ```bash
   # Example operational invocation within tenant provisioning tooling
   pnpm --filter @campusos/backend exec tsx -e "
     import pg from 'pg';
     import { issueFirstAdminBootstrapTicket } from './src/shared/authorization/mfa-bootstrap';
     const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
     const result = await issueFirstAdminBootstrapTicket(pool, {
       organizationId: process.env.TARGET_ORG_ID,
       userId: process.env.TARGET_ADMIN_USER_ID,
     });
     console.log('Bootstrap ticket issued; expires at', result.expiresAt);
     console.log('Ticket token:', result.ticket);
     await pool.end();
   "
   ```
2. Operator securely transmits the ticket token to the administrator out of band (e.g. encrypted administrative channel).
3. The administrator completes enrollment:
   - `POST /auth/login` (session receives `403 MFA_REQUIRED` on admin routes).
   - `POST /auth/step-up` with password (fresh `PASSWORD_REAUTH`).
   - `POST /me/mfa/totp/enroll` with `{ ticket: \"<ticketToken>\" }` → receive `otpauthUri` and secret.
   - `POST /me/mfa/totp/verify` with current 6-digit TOTP code within 10 minutes → factor becomes verified, recovery codes generated, ticket consumed.
4. Future required-role users within that tenant are issued enrollment tickets normally by that verified `COLLEGE_ADMIN` via `POST /api/v1/users/:id/mfa/enrollment-ticket`.

## 5. Recovery paths

| Situation | Path |
| --- | --- |
| Lost authenticator, recovery codes available | `POST /auth/mfa/challenge {recoveryCode}`, then enroll a replacement (`/me/mfa/totp/enroll` with that fresh `PASSWORD_MFA`, then `/verify`); the old factor is revoked atomically on confirmation |
| Lost authenticator and codes, another administrator exists | that administrator (COLLEGE_ADMIN, MFA-verified, fresh `PASSWORD_MFA`, allowed by the grant rules to grant every role of the target) calls `POST /api/v1/users/:id/mfa/reset {reason}` after verifying the person's identity out of band; the target re-enrolls |
| The tenant's ONLY COLLEGE_ADMIN lost authenticator and codes | **break-glass, platform operator, two people**: verify identity out of band; record the change in the change record; as a superuser revoke that user's factors and codes and sessions with the same transitions the reset function performs (factors → `REVOKED`/`ADMIN_RESET`, unused codes → `revoked_at`, sessions → `revoked_at`). No application path exists for this on purpose. Not exercised |

## 6. Key incidents

| Incident | Response |
| --- | --- |
| Key suspected compromised | Ciphertexts are only as safe as the key **plus** database access. Generate a new key, make it active everywhere, then treat every factor sealed under the old key as exposed: administratively reset those users (or require re-enrollment) and remove the old key. Query to size it: `SELECT secret_key_label, status, count(*) FROM app.user_mfa_factors GROUP BY 1, 2` (superuser) |
| Key lost (all copies) | Factors sealed with it cannot be verified (`503 MFA_UNAVAILABLE` if the ID is gone from the ring, `500 MFA_SECRET_UNREADABLE` if a wrong key is configured under the ID). Users can still sign in with recovery codes; then reset and re-enroll every affected factor |
| Process refuses to start | Message names the variable and the rule (never a value): fix the ring; there is no override |

## 7. Monitoring

Audit actions `auth.mfa.*` and `auth.authorization_denied` with reasons `MFA_REQUIRED` / `STEP_UP_REQUIRED` (see `23-mfa.md` §8). Watch for: repeated `auth.mfa.challenge_failed` (guessing; also drives the 10-failure account lock), `auth.mfa.admin_reset` (tier 3), recovery-code use leaving few `unusedCodes`.

## 8. Sign-off gates (none performed)

- [ ] Keys provisioned and backed up; separate per environment.
- [ ] `0030` approved separately; dry run reviewed; applied; ledger and permission checks pass.
- [ ] Role permissions verified via query: `auth.mfa.manage` present for all system roles, `user.account.reset_mfa` present for admin roles across all tenants.
- [ ] First administrator bootstrap ticket issued and redeemed for each tenant before enforcing build cutover.
- [ ] Post-enrollment check confirms `verified_enrollment = TRUE` and bootstrap is disabled (`BOOTSTRAP_DISABLED`).
- [ ] Required-role users informed; break-glass owners named.
- [ ] Lock-time rehearsal on a throw-away copy; restore procedure exercised (neither exists today).
