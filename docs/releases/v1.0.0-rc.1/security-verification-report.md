# ANESA CAMPUS OS — SECURITY & DATA INTEGRITY VERIFICATION REPORT
**Target Release**: `v1.0.0-rc.1`
**Verification Date**: 2026-11-25
**Security Standard**: Strict Multi-Tenant Isolation, Least Privilege, Zero-Trust Defense-in-Depth
**Audit Status**: **PASSED (ALL TECHNICAL GATES VERIFIED)**

---

## 1. Multi-Tenant Isolation & Cross-Tenant Protection

### Isolation Mechanism
Multi-tenant boundaries in Anesa Campus OS are enforced at the database kernel level via PostgreSQL Row-Level Security (RLS) policies:
```sql
CREATE POLICY tenant_isolation_policy ON app.<table>
  AS RESTRICTIVE
  USING (organization_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```
- **Context Injection Prevention**: Application code cannot directly query tables. All access must pass through `Database.withTenant(ctx, work)` ([database.ts](../../../backend/src/shared/database/database.ts)), which accepts only a cryptographically signed/verified `TrustedContext`.
- **Cross-Tenant Attack Proofs**: Verified in [documents.test.ts](../../../backend/tests/integration/documents.test.ts), [student-routes.test.ts](../../../backend/tests/integration/student-routes.test.ts), and [platform-and-entitlement-isolation.test.ts](../../../backend/tests/integration/platform-and-entitlement-isolation.test.ts):
  - Requesting records belonging to Tenant B while authenticated under Tenant A returns strictly `404 Not Found` or `401 Context Rejected`.
  - Supplying forged `organization_id` parameters in HTTP request bodies or query strings is rejected by Zod schema stripping or SQL guards.

---

## 2. Authentication, Session & MFA Security

### Credentials & Cryptographic Standards
- **Password Hashing**: Argon2id (`memoryCost: 65536, timeCost: 3, parallelism: 4`).
- **Session Tokens**: Cryptographically random 256-bit entropy tokens stored in `platform.sessions`. Transmitted exclusively via `HttpOnly`, `SameSite=Lax` (or `Strict`), `Secure` cookies.
- **MFA Enforcement**:
  - RFC 6238 TOTP using SHA-1, 30-second time steps, 6-digit codes.
  - TOTP secrets are encrypted at rest using an AES-256-GCM envelope (`MfaSecretBox`) with versioned encryption key rings.
  - Emergency single-use recovery codes are hashed via Argon2id before storage in `app.user_mfa_recovery_codes`.
  - Mandatory MFA enforcement on administrative roles (`COLLEGE_ADMIN`, `CAMPUS_ADMIN`, `REGISTRAR`, `HOD`, `DEPARTMENT_ADMIN`).
- **Step-Up Authentication**:
  - Critical financial reversals and credential resets require active re-authentication within a 5-minute elevated session window (`app.elevated_sessions`).

---

## 3. Authorization, Role Matrix & Transaction Contract Verification

### Security Guarantees Verified:
1. **Multi-Tier Capability Matrix**:
   - Canonical role capabilities defined strictly in [role-matrix.ts](../../../backend/src/shared/authorization/role-matrix.ts).
   - Critical capabilities (`auth.mfa.reset`, `role.assign`, `document.read_restricted`) require explicit `allowCriticalGrants: true` and are refused in background syncs.
2. **Fail-Closed Explicit-Denial Policies**:
   - Institutional permission denials (`authorization.denied_permissions`) validate against root null/array/boolean types, prototype pollution (`__proto__`, `constructor`, `prototype`), and non-string elements.
   - Denial mutations acquire mutual-exclusion advisory transaction locks (`pg_advisory_xact_lock`), preventing race conditions during reconciliation.
3. **Production Reconciliation Callers & Autocommit Contract**:
   - **Verified Production Callers**: All production callers (`PlatformService.createInstitution` and `PlatformService.reconcileRoles` via `withSystem`, `SettingsService.setSetting` via `withTenant`, CLI `tenant:create` and `tenant:seed` via explicit `BEGIN ... COMMIT`, and `seed-roles.ts` / `dev-seed-core.ts` via `BEGIN ... COMMIT`) execute inside managed transactions.
   - **Remaining Low-Level Autocommit Contract Limitation**: Low-level authorization helpers (`acquireDenialPolicyLock`, `executeTenantReconciliation`, `reconcileTenantPermissions`, `reconcileAllOrganizations`, `seedTenantRoles`, `seedMfaPermissions`, `setTenantExplicitDenials`, `clearTenantExplicitDenials`) in [reconcile.ts](../../../backend/src/shared/authorization/reconcile.ts) and [seed.ts](../../../backend/src/shared/authorization/seed.ts) do not issue unconditional `BEGIN`/`COMMIT` statements (so they never break callers passing a `TenantTx` or active outer transaction). Therefore, any low-level caller invoking them directly with a raw `pg.Client` in autocommit mode loses `pg_advisory_xact_lock` protection at statement end unless wrapped in an explicit `BEGIN ... COMMIT` block.

---

## 4. File Upload, Storage & Antivirus Security

### Pipeline Invariants ([document.service.ts](../../../backend/src/modules/documents/document.service.ts)):
1. **Three-Stage Lifecycle**:
   `PENDING_UPLOAD` -> `SCANNING` -> `AVAILABLE` (or `QUARANTINED` / `REJECTED`).
2. **Malware Scanning**:
   - All uploaded files are scanned asynchronously by `DocumentScanWorker` via ClamAV daemon (`INSTREAM` protocol).
   - Infected files transition to `QUARANTINED` (`quarantined_at = now()`, `quarantine_reason = 'MALWARE_DETECTED'`).
   - Quarantined files can never be downloaded or linked to any entity.
3. **Integrity Verification**:
   - Client-reported SHA-256 digest and byte size are verified against actual bytes read from storage before file completion.
4. **Access Control**:
   - Direct object storage URLs are never exposed. Downloads require a short-lived, signed token or authenticated proxy endpoint verifying entity linkage (`SELF`, `GUARDIAN`, `STAFF_ONLY`), role permissions, and classification (`PUBLIC`, `INTERNAL`, `RESTRICTED`, `CONFIDENTIAL`).

---

## 5. Input Validation, SQL Injection, XSS & CSRF Defenses

- **SQL Injection**: Zero string-concatenated SQL queries in application logic. Enforced by ESLint rules and `assertSafeSql()` guard inside `TenantTx` ([sql-guard.ts](../../../backend/src/shared/database/sql-guard.ts)).
- **CSRF Protection**: Fastify CSRF plugin verifies custom header `X-CSRF-Token` on all mutating HTTP methods (`POST`, `PUT`, `PATCH`, `DELETE`).
- **XSS & Content Security**:
  - React 19 automatic JSX text escaping.
  - HTTP Content-Security-Policy headers restricting script sources and frame ancestors.
  - CSV exports sanitize formula injection prefixes (`=`, `+`, `-`, `@`).

---

## 6. Dependency Audit & Secret Scanning Evidence

- **Secret Scanning**: `pnpm check:secrets` -> `secret-scan: no findings` (Exit code `0`).
- **Dependency Audit (`pnpm audit`)**:
  - Reported **10 vulnerabilities** (5 low, 5 moderate; **0 high, 0 critical**) in transitive dependency `fast-uri` (`backend > fastify > @fastify/ajv-compiler > fast-uri` and `ajv > fast-uri`, advisories `GHSA-w74x-v6f9-j3xg` and `GHSA-333x-w4r6-6crp`).
  - **Risk Assessment**: Non-exploitable in Anesa Campus OS because Fastify does not parse untrusted arbitrary URI schemes with `fast-uri` outside strict Zod/JSON schemas. Tracked for upstream patch uptake in `v1.0.1`.

---

## 7. Financial Integrity & Audit Trail Immutability

- **Minor Unit Invariant**: All fees, concessions, receipts, dues, and balances are stored and calculated as 64-bit integer minor currency units (paise / cents). Floating-point arithmetic is strictly forbidden.
- **Audit Trail**: `app.audit_events` is an append-only ledger protected by PostgreSQL triggers preventing `UPDATE` or `DELETE`. Sensitive fields (passwords, TOTP secrets, tokens) are masked prior to event insertion.
