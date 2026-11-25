# ANESA CAMPUS OS — KNOWN LIMITATIONS & DEFERRED FEATURES
**Target Release**: `v1.0.0-rc.1`
**Classification**: Release Transparency & Product Boundary Definition
**Scope**: Items deferred from Initial Pilot to subsequent minor releases without compromising core pilot viability.

---

## 1. Summary of Product Boundaries

Anesa Campus OS `v1.0.0-rc.1` is strictly scoped to core ERP operational excellence for K-12 and Higher Education institutions. In accordance with principal engineering guidance, non-essential feature expansion has been halted to prioritize security, data integrity, and reliability.

---

## 2. Non-Blocking Limitations

### 1. Low-Level Autocommit Contract Limitation in Authorization Helpers
- **Current Capability**: All production callers (`PlatformService.createInstitution`, `PlatformService.reconcileRoles`, `SettingsService.setSetting`, CLI `tenant:create` and `tenant:seed`, `seed-roles.ts`, and `dev-seed-core.ts`) run inside managed transactions (`withSystem`, `withTenant`, or explicit `BEGIN ... COMMIT` blocks), ensuring `pg_advisory_xact_lock` remains held until writes complete.
- **Limitation**: Low-level helper functions in [reconcile.ts](../../../backend/src/shared/authorization/reconcile.ts) and [seed.ts](../../../backend/src/shared/authorization/seed.ts) (`acquireDenialPolicyLock`, `executeTenantReconciliation`, `reconcileTenantPermissions`, `reconcileAllOrganizations`, `seedTenantRoles`, `seedMfaPermissions`, `setTenantExplicitDenials`, `clearTenantExplicitDenials`) do not issue unconditional `BEGIN`/`COMMIT` statements (so they never break externally managed transactions like `TenantTx`). If called directly on a raw `pg.Client` in autocommit mode, PostgreSQL releases `pg_advisory_xact_lock` immediately upon statement completion.
- **Contract**: Direct low-level callers executing multi-statement mutations outside `withTenant`/`withSystem` must wrap operations in an explicit `BEGIN ... COMMIT / ROLLBACK` transaction.

### 2. Timetable Scheduling
- **Current Capability**: Comprehensive weekly timetable scheduling is fully supported. Administrators and coordinators can map faculty to subjects, rooms, and daily periods across sections, with conflict checks preventing double-booking of teachers or classrooms.
- **Limitation**: Complex alternating A/B multi-week rotating schedules and automated constraint-satisfaction heuristic timetable solvers are not included.
- **Workaround**: Standard weekly recurring timetable schedules cover typical Indian and international K-12 school curricula.

### 3. Payment Gateway Adapters
- **Current Capability**: Complete offline cash/cheque fee collections, receipts, dues decrements, receipt cancellations with step-up authentication, and full financial reporting. Gateway webhooks and transaction status tracking are implemented.
- **Limitation**: While payment gateway abstractions and signature verifications exist, live merchant credential activation depends on individual school bank KYC approval.
- **Workaround**: Schools operate offline collections immediately; online collection switches active once institutional merchant accounts are activated.

### 4. Biometric & RFID Attendance Ingestion
- **Current Capability**: Daily classroom attendance marking by class teachers, period-wise marking by subject teachers, holiday calendar integration, policy locking, and parent notifications.
- **Limitation**: Direct TCP/IP socket polling from physical ZKTeco/Essl biometric fingerprint hardware or RFID turnstiles is not embedded in the cloud kernel.
- **Workaround**: Device logs can be imported via CSV attendance adapter, or an on-premise sync agent pushes logs to the authenticated attendance API.

### 5. Transitive Dependency CVEs in `fast-uri`
- **Current Status**: Dependency audit (`pnpm audit`) reports 10 vulnerabilities (5 low, 5 moderate; 0 high, 0 critical) on `fast-uri` through transitive dependency `backend > fastify > @fastify/ajv-compiler > ajv` (advisories `GHSA-w74x-v6f9-j3xg` and `GHSA-333x-w4r6-6crp`).
- **Assessment**: Non-exploitable in Anesa Campus OS because all URI schemes handled in Fastify are strictly validated against Zod/JSON schemas before routing.
- **Resolution**: Upstream Fastify and Ajv compiler releases will be updated in `v1.0.1` upon upstream patch publication.

---

## 3. Deferred Features (Roadmap Post-Pilot)

| Feature Description | Target Milestone | Rationale for Deferral |
| :--- | :---: | :--- |
| **Mobile Native Push Notifications** (APNs / FCM) | `v1.1.0` | In-app notification center and SMTP email notifications satisfy all pilot operational requirements. |
| **Custom Report Query Builder** (Visual SQL Drag & Drop) | `v1.1.0` | Pre-built institutional reports (Enrolment, Attendance, Fees, Exam Performance) cover pilot governance. |
| **Transport / Bus Route Live GPS Tracking** | `v1.2.0` | Requires dedicated GPS telematics hardware integration; not part of core academic ERP pilot. |
| **Hostel & Dormitory Room Allocation System** | `v1.2.0` | Non-residential day schools are prioritized for the initial pilot cohort. |
| **Alumni Association Portal & Donation Gateway** | `v1.3.0` | Long-term engagement module outside initial academic term pilot operations. |

---

## 4. Invariant Commitments

No deferred feature impacts the core security, tenant isolation, or transactional integrity of Anesa Campus OS. All financial calculations, student academic records, exam candidate lists, and audit logs remain strictly accurate and immutable.
