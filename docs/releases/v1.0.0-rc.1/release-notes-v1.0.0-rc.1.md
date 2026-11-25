# ANESA CAMPUS OS — RELEASE NOTES
**Version**: `v1.0.0-rc.1`
**Release Name**: "Foundations & Institutional Governance"
**Date**: 2026-11-25
**Target Audience**: Institutional Administrators, Platform Operators, Security Auditors

---

## 1. Overview

Anesa Campus OS `v1.0.0-rc.1` is the inaugural pilot release candidate of the institutional operating system designed for schools, colleges, and universities. This release delivers a unified ERP foundation spanning academic structure, student lifecycle, admissions, staff management, timetable, attendance, homework, examinations, fees, role-aware document governance, and zero-access school vaults.

---

## 2. Key Highlights & New Capabilities

### 1. Role-Aware Document Center
- **Workspaces**: Seamlessly switch between *My Documents* (user-owned transcripts, contracts, and receipts) and *Institutional Documents* (campus governance records, fire safety NOCs, affiliation documents).
- **Dynamic Category Tabs**: Academic, Personal & Identity, Employee Records, Institutional Compliance, and Fee Receipts.
- **Antivirus Pipeline**: All uploads are inspected asynchronously via ClamAV daemon (`INSTREAM` protocol) with SHA-256 cryptographic integrity verification before promotion to `AVAILABLE`.
- **Classification Tiering**: Supports `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, and `RESTRICTED` security classifications.

### 2. Enterprise Authorization & Transaction Hardening
- **Advisory Transaction Locking**: Permission reconciliation and explicit denial policies synchronize via `pg_advisory_xact_lock`, eliminating race conditions between concurrent syncs.
- **Fail-Closed Explicit Denials**: Strict validation blocks prototype pollution, root-level malformed objects, and invalid permission codes.
- **Atomic CLI Tenant Provisioning**: `tenant:create` wraps in explicit PostgreSQL transactions, ensuring all-or-nothing rollback on creation errors.

### 3. Date-Resilient Academic Workflows
- **Timezone-Safe Homework & Attendance**: Homework submissions and attendance sessions dynamically evaluate against campus timezones (`Asia/Kolkata` baseline), ensuring year-resilient evaluations.

### 4. Zero-Access School Vault
- **Client-Side Envelope Encryption**: Institutional records and sensitive compliance credentials can be stored with zero-access encryption unreadable even by platform operators.

### 5. Platform Super Admin First-Administrator Onboarding
- **End-to-End Principal Onboarding in Control Center UI**: Operators can now inspect first-administrator activation/invitation/MFA status, generate or send invitations (`APP_ORIGINS`-bound), copy one-time activation links, reissue or revoke unused invitations, and issue one-time MFA bootstrap tickets directly from `/platform/institutions/:id` (with automatic SMTP delivery when configured and manual copy-link fallback when unconfigured).

---

## 3. Bug Fixes & Refactorings

1. **Migration Catalog Sync**: Updated deferred migration contracts in [migration-0017.test.ts](../../../backend/tests/integration/migration-0017.test.ts) and [migration-0019.test.ts](../../../backend/tests/integration/migration-0019.test.ts) to account for migrations `0054` and `0055`.
2. **Staff Onboarding & Tenant Context**: Corrected session lookup and active membership bindings in [first-admin-onboarding.test.ts](../../../backend/tests/integration/first-admin-onboarding.test.ts).
3. **Homework Date Dependencies**: Replaced hardcoded date strings in [homework-workflow.test.ts](../../../backend/tests/integration/homework-workflow.test.ts) with dynamic timezone-aware future dates.
4. **Role Version Churn**: Eliminated duplicate upsert loops in role seeding ([seed.ts](../../../backend/src/shared/authorization/seed.ts) & [reconcile.ts](../../../backend/src/shared/authorization/reconcile.ts)), restoring idempotency.
5. **Platform CLI Scope Drift**: Restored operator CLI ability to re-sync canonical scopes during intentional re-seed runs ([platform-cli.ts](../../../backend/tools/platform/platform-cli.ts)).

---

## 4. Automated Test Summary

- **Total Tests Passed**: **3,591 passed tests** across 207 suites (**100% pass rate**).
  - Integration: 1,898 passed / 1,898 total (105 test files)
  - Backend Unit: 1,159 passed / 1,159 total (58 test files)
  - Frontend Web: 534 passed / 534 total (44 test files)
- **Browser E2E Verification**: Repeatable headless Chrome verification scripts preserved in `backend/tools/e2e/first-admin-onboarding-browser.mjs` and `backend/tools/e2e/platform-browser-smoke.mjs` (both passed against disposable embedded PostgreSQL).
- **Code Quality**:
  - Prettier (`format:check`), ESLint (`lint`), and TypeScript (`typecheck`) all pass with 0 errors.
  - Secret scan (`check:secrets`): 0 findings.
  - Git whitespace diff check (`git diff --check HEAD`): Clean.

---

## 5. Upgrade & Deployment Instructions

See [Production Deployment Runbook](./production-deployment-runbook.md) for full details:

1. **Deploy Codebase**: Pull release tag `v1.0.0-rc.1`.
2. **Apply Database Migrations**:
   ```bash
   pnpm --filter @campusos/backend run migrate:up
   ```
3. **Build Web & Backend Bundles**:
   ```bash
   pnpm --filter @campusos/web run build
   pnpm --filter @campusos/backend run build
   ```
4. **Restart Services**:
   ```bash
   sudo systemctl restart campusos-api
   ```
5. **Run Health Verification**:
   ```bash
   curl -f http://127.0.0.1:4000/api/v1/monitoring/health
   ```
