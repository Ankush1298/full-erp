# ANESA CAMPUS OS — MODULE READINESS MATRIX
**Evaluation Date**: 2026-11-25
**Release Target**: `v1.0.0-rc.1`
**Classification Standard**: Canonical Architecture & Production Pilot Acceptance Criteria

---

## 1. Audit Methodology & Assessment Criteria

Each implemented module was audited across eleven fundamental engineering vectors:
1. **Backend Implementation**: Node.js/Fastify route controllers, service layer encapsulation, parameterization.
2. **Frontend Implementation**: React 19 SPA pages, accessible components, semantic design system.
3. **API Integration**: RESTful contracts, Zod schema validation, consistent response models.
4. **Authorization & RBAC**: Least-privilege role matrix, canonical capability checks, fail-closed access.
5. **Multi-Tenant Isolation**: Row-Level Security (RLS) enforcement, `TrustedContext`, cross-tenant guards.
6. **Database Integrity**: Foreign key cascades, immutability constraints, trigger validations, sequence consistency.
7. **Validation & Error Handling**: Strong schema parsing, structured RFC-7807/AppError responses, sanitization.
8. **Automated Test Coverage**: Dedicated unit and integration tests with deterministic fixtures.
9. **End-to-End Workflow**: Complete lifecycle execution from initial creation to final reconciliation.
10. **Institutional Configuration**: Timezone awareness, institution type (`SCHOOL`/`COLLEGE`/`UNIVERSITY`), terminology presets.
11. **State Handling**: Distinct empty, loading, error, and forbidden states rendered in UI.

---

## 2. Complete Module Matrix (30 Modules Audited)

| # | Module Name | Backend Scope | Frontend Scope | Status | Notes & Limitations |
| :- | :--- | :--- | :--- | :---: | :--- |
| **1** | **Platform Administration** | [tools/platform/](../../../backend/tools/platform/) | [pages/platform/](../../../apps/web/src/pages/platform/) | **READY** | Full metrics, tenant provisioning, entitlement management, audit browser. |
| **2** | **Institution Administration** | [modules/organization/](../../../backend/src/modules/organization/) | [OrganisationPage.tsx](../../../apps/web/src/pages/OrganisationPage.tsx) | **READY** | Structure, facilities, campuses, school/college/univ type settings, terminology presets. |
| **3** | **Authentication & MFA** | [modules/auth/](../../../backend/src/modules/auth/) | [features/auth/](../../../apps/web/src/features/auth/) | **READY** | Argon2id hashing, TOTP RFC-6238, encrypted secret box, step-up elevation. |
| **4** | **Users, Roles & Permissions** | [modules/access/](../../../backend/src/modules/access/), [shared/authorization/](../../../backend/src/shared/authorization/) | [AccessPage.tsx](../../../apps/web/src/pages/AccessPage.tsx), [UsersPage.tsx](../../../apps/web/src/pages/UsersPage.tsx) | **READY** | Multi-tier role matrix, explicit denials, advisory lock synchronization, canonical display titles. |
| **5** | **Institution & Campus Config** | [modules/organization/](../../../backend/src/modules/organization/) | [OrganisationPage.tsx](../../../apps/web/src/pages/OrganisationPage.tsx) | **READY** | Per-campus timezone configuration (`Asia/Kolkata` baseline), address metadata. |
| **6** | **Departments & Academic Struct.**| [modules/academics/](../../../backend/src/modules/academics/) | [AcademicsPage.tsx](../../../apps/web/src/pages/AcademicsPage.tsx) | **READY** | Academic/administrative departments, room facilities, hierarchical linking. |
| **7** | **Academic Years & Terms** | [modules/academics/](../../../backend/src/modules/academics/) | [AcademicSetupWizard.tsx](../../../apps/web/src/pages/AcademicSetupWizard.tsx) | **READY** | Term date validation, status transitions (`PLANNING`, `ACTIVE`, `CONCLUDED`), rollover tab. |
| **8** | **Admissions** | [modules/students/](../../../backend/src/modules/students/) | [StudentsPage.tsx](../../../apps/web/src/pages/StudentsPage.tsx) | **READY** | Scoped admission numbers, duplicate student detection, birth date verification. |
| **9** | **Student Lifecycle** | [modules/students/](../../../backend/src/modules/students/) | [StudentsPage.tsx](../../../apps/web/src/pages/StudentsPage.tsx) | **READY** | State machine (`ENROLLED`, `SUSPENDED`, `ALUMNI`, `WITHDRAWN`), program enrollment. |
| **10** | **Staff & Faculty Management** | [modules/people/](../../../backend/src/modules/people/) | [UsersPage.tsx](../../../apps/web/src/pages/UsersPage.tsx) | **READY** | Employee profiles, designations, department postings, class teacher assignments. |
| **11** | **Parent & Guardian Management** | [modules/parent-portal/](../../../backend/src/modules/parent-portal/) | [ParentPortalPage.tsx](../../../apps/web/src/pages/ParentPortalPage.tsx) | **READY** | Guardian verification, child switcher, primary guardian flags, privacy isolation. |
| **12** | **Timetable** | [modules/academics/](../../../backend/src/modules/academics/) | [AcademicsPage.tsx](../../../apps/web/src/pages/AcademicsPage.tsx) | **READY WITH LIMITATIONS** | Class/room/teacher slot scheduling is verified; complex multi-week rotation deferred. |
| **13** | **Attendance** | [modules/attendance/](../../../backend/src/modules/attendance/) | [AttendancePage.tsx](../../../apps/web/src/pages/AttendancePage.tsx) | **READY** | Daily roster marking, holiday calendar integration, policy locking, correction controls. |
| **14** | **Homework & Assignments** | [modules/homework/](../../../backend/src/modules/homework/) | [HomeworkPage.tsx](../../../apps/web/src/pages/HomeworkPage.tsx) | **READY** | Dynamic deadline evaluation, late submission detection, attachment linking, grading. |
| **15** | **Examinations** | [modules/examinations/](../../../backend/src/modules/examinations/) | [ExaminationsPage.tsx](../../../apps/web/src/pages/ExaminationsPage.tsx) | **READY** | Exam definitions, date windows, 75% attendance threshold gating, candidate list freezing. |
| **16** | **Results & Grading** | [modules/examinations/](../../../backend/src/modules/examinations/) | [ExaminationsPage.tsx](../../../apps/web/src/pages/ExaminationsPage.tsx) | **READY** | Teacher marks entry, maker-checker publication separation, student/parent visibility controls. |
| **17** | **Fees & Financial Operations** | [modules/finance/](../../../backend/src/modules/finance/) | [FeesPage.tsx](../../../apps/web/src/pages/FeesPage.tsx) | **READY** | Integer minor units, dues generation, offline cash receipts, reversal with step-up. |
| **18** | **Document Center** | [modules/documents/](../../../backend/src/modules/documents/) | [DocumentsPage.tsx](../../../apps/web/src/pages/DocumentsPage.tsx) | **READY** | Role-aware My vs Institutional documents, SHA-256 digests, clean file promotion. |
| **19** | **Notifications** | [modules/notifications/](../../../backend/src/modules/notifications/) | [NotificationsPage.tsx](../../../apps/web/src/pages/NotificationsPage.tsx) | **READY** | In-app alerts, SMTP/in-memory email provider, read/unread status tracking. |
| **20** | **Reports** | [modules/reports/](../../../backend/src/modules/reports/) | [ReportsPage.tsx](../../../apps/web/src/pages/ReportsPage.tsx) | **READY** | Enrolment rosters, daily attendance summaries, fee collection reports, CSV exports. |
| **21** | **Audit Logs** | [modules/audit/](../../../backend/src/modules/audit/) | [PlatformAuditPage.tsx](../../../apps/web/src/pages/platform/PlatformAuditPage.tsx) | **READY** | Immutable append-only audit trail, risk tiering, actor attribution, sensitive masking. |
| **22** | **Settings** | [settings.service.ts](../../../backend/src/modules/organization/settings.service.ts) | [OrganisationPage.tsx](../../../apps/web/src/pages/OrganisationPage.tsx) | **READY** | Fail-closed settings registry, strict schema validation, concurrent advisory locking. |
| **23** | **Student Portal** | [modules/students/](../../../backend/src/modules/students/) | [Homes.tsx](../../../apps/web/src/features/home/Homes.tsx) | **READY** | Student home dashboard displaying attendance, timetable, homework, documents, results. |
| **24** | **Parent Portal** | [modules/parent-portal/](../../../backend/src/modules/parent-portal/) | [ParentPortalPage.tsx](../../../apps/web/src/pages/ParentPortalPage.tsx) | **READY** | Verified child attendance summary, homework submissions, fee dues, report cards. |
| **25** | **Faculty Portal** | [modules/homework/](../../../backend/src/modules/homework/), [modules/attendance/](../../../backend/src/modules/attendance/) | [Homes.tsx](../../../apps/web/src/features/home/Homes.tsx) | **READY** | Attendance taking, marks entry, homework creation, syllabus progression. |
| **26** | **School Vault (Zero-Access)** | [modules/vault/](../../../backend/src/modules/vault/) | [vault-client.ts](../../../apps/web/src/lib/crypto/vault-client.ts) | **READY** | Client-side envelope encryption, key derivation, unreadable by platform operators. |
| **27** | **Bulk CSV Imports** | [modules/imports/](../../../backend/src/modules/imports/) | [ImportsPage.tsx](../../../apps/web/src/pages/ImportsPage.tsx) | **READY** | Student and staff bulk imports, header validation, dry-run previews, conflict detection. |
| **28** | **Consents Management** | [modules/consent/](../../../backend/src/modules/consent/) | [ConsentsPage.tsx](../../../apps/web/src/pages/ConsentsPage.tsx) | **READY** | Institutional consent forms, guardian digital opt-in/opt-out, audit logging. |
| **29** | **Backup & Disaster Recovery** | [backup-manager.ts](../../../backend/tools/backup/backup-manager.ts) | CLI & Monitoring API | **READY** | AES-256-GCM encrypted dumps, checksum verification, tamper rejection, DR rehearsal. |
| **30** | **Monitoring & Telemetry** | [modules/monitoring/](../../../backend/src/modules/monitoring/) | Monitoring API | **READY** | Live cluster health status, database pool metrics, memory and uptime telemetry. |

---

## 3. Summary of Status Classifications

- **READY**: 29 Modules (96.7%)
- **READY WITH NON-BLOCKING LIMITATIONS**: 1 Module (3.3% — Timetable basic weekly schedule supported; automated AI scheduling optimization deferred)
- **BLOCKED**: 0 Modules (0.0%)
- **NOT IMPLEMENTED**: 0 Modules (0.0%)
