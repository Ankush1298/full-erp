# Blueprint v3.1 — Milestone 1 Permission Catalog

Single source of truth in code: `permissions/catalog.ts` + `permissions/role-matrix.ts` (generated into `permissions` / `role_permissions` at provisioning). This document is its specification. A CI test asserts code ≡ this matrix (document-driven: the matrix below is mirrored in a machine-readable file `permission-matrix.yaml`).

Legend — scope mode: **S** = SELF · **A** = ASSIGNED (reserved here, becomes real in M3/M4) · **G** = GRANTED within the scope of the actor's role assignment (department / campus / organization) · **–** = not held.
Sensitivity: N = normal · S = sensitive (audit denials, no bulk export) · **C** = critical (reason required, always audited, optional second approver).
A user holds the **union** of permissions of all active role assignments; a single role holds each permission in exactly one mode.

Roles seeded in M1: STUDENT, FACULTY, STAFF, HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR. (GUARDIAN role is defined but not assignable — guardians are contacts, not logins, in the pilot.) Platform operators are not tenant roles.

Implicit assignments: `students` row ⇒ STUDENT (ORGANIZATION scope, SELF-mode permissions); `employees` row with type FACULTY ⇒ FACULTY; type STAFF ⇒ STAFF.

---

## 1. Matrix

| # | Permission | Sens. | STUDENT | FACULTY | STAFF | HOD | DEPT_ADMIN | CAMPUS_ADMIN | COLLEGE_ADMIN | REGISTRAR |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Session** |
| 1 | `session.read` (own sessions) | N | S | S | S | S | S | S | S | S |
| 2 | `session.revoke` (own sessions) | N | S | S | S | S | S | S | S | S |
| 3 | `session.revoke_any` | S | – | – | – | – | – | G | G | – |
| 3a | `auth.mfa.manage` (own TOTP factors and recovery codes) | N | S | S | S | S | S | S | S | S |
| **User & profile** |
| 4 | `user.profile.read` | N | S | S | S | S | S | S | S | S |
| 5 | `user.profile.update` (phone, locale, avatar, notification email) | N | S | S | S | S | S | S | S | S |
| 6 | `user.account.read` | S | – | – | – | G | G | G | G | G |
| 7 | `user.account.invite` | S | – | – | – | – | G | G | G | G |
| 8 | `user.account.update` (name, email, phone) | S | – | – | – | – | G | G | G | G |
| 9 | `user.account.suspend` | C | – | – | – | – | – | G | G | – |
| 10 | `user.account.reset_password` (admin-initiated email reset) | C | – | – | – | – | – | G | G | – |
| 10a | `user.account.reset_mfa` (admin reset of another user's MFA factor and recovery codes; never the caller's own; see `23-mfa.md` §7) | C | – | – | – | – | – | G | G | – |
| **Roles** |
| 11 | `role.read` | N | – | – | – | – | G | G | G | – |
| 12 | `role.assignment.read` | S | S | S | S | G | G | G | G | – |
| 13 | `role.assignment.grant` | C | – | – | – | – | G | G | G | – |
| 14 | `role.assignment.revoke` | C | – | – | – | – | G | G | G | – |
| **Organization** |
| 15 | `org.structure.read` (campuses, departments, designations) | N | G | G | G | G | G | G | G | G |
| 16 | `org.campus.manage` | S | – | – | – | – | – | G | G | – |
| 17 | `org.department.manage` | S | – | – | – | – | – | G | G | – |
| 18 | `org.settings.read` | N | – | – | – | – | – | G | G | G |
| 19 | `org.settings.manage` | C | – | – | – | – | – | – | G | – |
| **Programs (minimal)** |
| 20 | `academic.program.read` (programs, cohorts, period types; M3 adds academic years, terms, cohort periods, sections, courses, curriculum) | N | G | G | G | G | G | G | G | G |
| 21 | `academic.program.manage` | S | – | – | – | – | G | G | G | G |
| 22 | `academic.cohort.manage` | S | – | – | – | – | G | G | G | G |
| **Students** |
| 23 | `student.profile.read` | S | S | A | – | G | G | G | G | G |
| 24 | `student.profile.read_sensitive` (guardian contacts, DOB, address, IDs) | S | S | – | – | – | G | G | G | G |
| 25 | `student.directory.search` | S | – | – | – | G | G | G | G | G |
| 25a | `student.directory.list` | S | – | – | – | G | G | G | G | G |
| 26 | `student.record.create` | S | – | – | – | – | G | G | G | G |
| 27 | `student.record.update` | S | – | – | – | – | G | G | G | G |
| 28 | `student.status.change` | C | – | – | – | – | – | G | G | G |
| 29 | `student.program.assign` (open/close student_programs) | S | – | – | – | – | G | G | G | G |
| 30 | `student.guardian.read` | S | S | – | – | G | G | G | G | G |
| 31 | `student.guardian.manage` | S | – | – | – | – | G | G | G | G |
| **Employees** |
| 32 | `employee.profile.read` | N | – | S | S | G | G | G | G | – |
| 33 | `employee.record.create` | S | – | – | – | – | G | G | G | – |
| 34 | `employee.record.update` | S | – | – | – | – | G | G | G | – |
| **Documents** |
| 35 | `document.upload` | N | S | S | S | – | G | G | G | G |
| 36 | `document.read` | N | S | S | S | G | G | G | G | G |
| 37 | `document.read_restricted` (RESTRICTED class, e.g. ID proofs) | C | S | – | – | – | – | – | G | G |
| 38 | `document.delete` | S | S | S | S | – | – | G | G | G |
| **Consent** |
| 39 | `consent.read` | S | S | S | S | – | – | G | G | – |
| 40 | `consent.record` | N | S | S | S | S | S | S | S | S |
| 41 | `consent.withdraw` | N | S | S | S | S | S | S | S | S |
| **Notifications** |
| 42 | `notification.read` | N | S | S | S | S | S | S | S | S |
| 43 | `notification.preference.manage` | N | S | S | S | S | S | S | S | S |
| 44 | `notification.template.manage` | S | – | – | – | – | – | – | G | – |
| **Audit** |
| 45 | `audit.event.read` | S | – | – | – | G | G | G | G | – |
| 46 | `audit.event.read_student` | S | – | – | – | – | – | G | G | G |
| 47 | `audit.export` | C | – | – | – | – | – | – | G | – |
| **AI foundation** |
| 48 | `assistant.use` | N | S | S | – | – | – | – | – | – |
| 49 | `assistant.conversation.read` (own) | N | S | S | – | – | – | – | – | – |
| **Academic calendar & enrollment (Milestone 3, Batch 1)** |
| 50 | `academic.term.manage` (academic years - organization scope - and campus terms, cohort periods are under `academic.cohort.manage`; holidays (doc 33: a campus row by campus scope, an organization-wide row and the setup checklist by organization scope)) | S | – | – | – | – | – | G | G | G |
| 51 | `academic.course.manage` (courses and curriculum entries) | S | – | – | – | – | G | G | G | G |
| 52 | `academic.section.manage` (sections) | S | – | – | – | – | G | G | G | G |
| 53 | `enrollment.term.read` (term enrolments, section memberships and course registrations) | S | S | – | – | G | G | G | G | G |
| 54 | `enrollment.term.manage` (create / change term enrolments, place students in sections, promotion / repetition decisions (doc 32) and the cohort promotion tool, course registrations (doc 33)) | S | – | – | – | – | G | G | G | G |
| **Imports (Milestone 2, Batch 2)** |
| 55 | `import.job.manage` (create, validate, preview, commit and download the error report of the caller's own student and faculty import jobs; a commit additionally requires `student.record.create` / `employee.record.create` at organization scope) | S | – | – | – | – | – | – | G | G |
| **Course offerings & scheduling (Milestone 3, Batch 2; doc 31)** |
| 56 | `academic.offering.manage` (course offerings - create, publish, close, cancel - their timetable slots, and elective groups of a cohort period (doc 33), by the derived department) | S | – | – | – | – | G | G | G | G |
| 57 | `academic.faculty.assign` (assign and end teachers on an offering, and class teachers of a section (doc 32); A2, every change audited at tier 2 with a reason) | S | – | – | – | – | G | G | G | G |
| **Attendance (Milestone 4, Slice 1; doc 41)** |
| 58 | `attendance.session.mark` (create a class session and submit its attendance; FACULTY by an ASSIGNED faculty assignment valid on the session date, doc 03) | S | – | A | – | – | – | – | – | – |
| 59 | `attendance.record.read` (a session's records and each record's revision history; STUDENT own records, FACULTY ASSIGNED as above, HOD department, CAMPUS_ADMIN campus, COLLEGE_ADMIN organization) | S | S | A | – | G | – | G | G | – |
| 60 | `attendance.record.correct` (change a submitted attendance value as a new revision with a reason: directly inside the 3-calendar-day faculty window, otherwise as a request that needs independent approval; AD-1 to AD-4, doc 43 §0; FACULTY ASSIGNED only for PRIMARY and CO_INSTRUCTOR assignments, HOD department, CAMPUS_ADMIN campus, COLLEGE_ADMIN organization). The routes also answer 403 to everyone unless `ATTENDANCE_CORRECTIONS_ENABLED=true` | S | – | A | – | G | – | G | G | – |
| 61 | `attendance.correction.approve` (approve or reject a correction request made by someone else; never one's own; AD-4) | S | – | – | – | G | – | G | G | – |
| 62 | `attendance.session.lock` (lock a submitted session; no unlock exists in Pilot V1; AD-5, AD-6; CRITICAL: reason and step-up) | C | – | – | – | – | – | G | G | – |
| 63 | `attendance.session.cancel` (administrative cancellation of a session that took no attendance; AD-7; separate from the faculty path, which uses `attendance.session.mark`) | S | – | – | – | – | – | G | G | – |
| **Examinations & Results (Pilot V1; doc 47 Task 5)** |
| 64 | `exam.manage` (create examinations and schedule exam papers for eligible course offerings) | S | – | – | – | G | G | G | G | G |
| 65 | `exam.marks.enter` (record and save draft marks or submit student scores for scheduled exam papers) | S | – | A | – | G | G | G | G | – |
| 66 | `result.publish` (publish exam results making them official and student-visible; maker-checker separation) | C | – | – | – | G | G | G | G | G |
| 67 | `result.read` (view class-wise marks registers or individual student results) | S | S | A | – | G | G | G | G | G |
| **Finance, Dues & Receipts (Pilot V1; doc 47 Task 5)** |
| 68 | `fee.structure.read` (view fee categories and fee structure configurations) | N | – | – | – | – | – | G | G | G |
| 69 | `fee.structure.manage` (create and configure fee categories, structures, and components) | S | – | – | – | – | – | – | G | – |
| 70 | `fee.dues.generate` (generate term fee dues assessments for students and cohorts) | S | – | – | – | – | – | G | G | – |
| 71 | `fee.dues.read` (view student dues registers, class balances, and outstanding dues ledgers) | S | S | – | – | – | – | G | G | G |
| 72 | `fee.receipt.record` (record offline payments and allocate to student dues) | S | – | – | – | – | – | G | G | – |
| 73 | `fee.receipt.read` (view payment receipts and daily collection registers) | S | S | – | – | – | – | G | G | G |
| 74 | `fee.receipt.reverse` (reverse a posted receipt with reason and step-up authentication) | C | – | – | – | – | – | – | G | – |
| 75 | `fee.gateway.read` (view configured payment gateways, active provider status, and masked credentials) | S | – | – | – | – | – | G | G | G |
| 76 | `fee.gateway.manage` (configure payment gateway merchant keys, secrets, test/live mode, and webhooks) | C | – | – | – | – | – | – | G | – |
| 77 | `fee.payment.initiate` (initiate online checkout session and payment attempt for student dues) | N | S | – | – | – | – | G | G | G |
| 78 | `fee.refund.initiate` (initiate payment gateway refund for online transaction) | C | – | – | – | – | – | – | G | – |

¹ FACULTY `student.profile.read` is `A` (assigned). In M1 it was not seeded and only the resolver contract was tested with a stub; Milestone 3 Batch 3 (doc 33 §2, X-12) seeds it with the real resolver: an ACTIVE teacher reads a student only while one of the teacher's faculty assignments and the student's course registration on the same PUBLISHED/CLOSED offering are both valid today. Existing tenants need their roles re-seeded (runbook `m3b3-electives-registrations-rollout.md`).

Notes
- `G` for STUDENT/FACULTY/STAFF on rows 15 and 20 means *organization-wide read of non-sensitive structure* via their implicit ORGANIZATION-scope assignment.
- HOD/DEPT_ADMIN `G` is bounded to their DEPARTMENT scope; CAMPUS_ADMIN to their CAMPUS; COLLEGE_ADMIN and REGISTRAR to the ORGANIZATION (REGISTRAR assignments are normally ORGANIZATION-scoped but may be CAMPUS-scoped for multi-campus tenants).
- Student-visible staff data: none. Students cannot search or list other students, employees or accounts (rows 6, 25, 32 are not held).
- Row 24: the student's own sensitive data is readable by the student (S); staff need explicit `read_sensitive` and every read of RESTRICTED documents is audited.

---

## 2. Platform realm permissions (separate catalog, not tenant roles)

| Permission | Holder | Sens. |
|---|---|:-:|
| `platform.tenant.create` | PLATFORM_OPERATOR | C |
| `platform.tenant.read` | PLATFORM_OPERATOR, PLATFORM_SUPPORT | N |
| `platform.tenant.suspend` | PLATFORM_OPERATOR | C |
| `platform.support.request_grant` | PLATFORM_SUPPORT | S |
| `platform.audit.read` | PLATFORM_OPERATOR | S |

Support access to tenant data additionally requires a tenant-approved `platform_support_grants` row (≤ 8 h).

---

## 3. Reserved namespaces (not seeded in M1)

`enrollment.*`, `academic.term.*`, `academic.course.*`, `service.*`, `request.*`, `ticket.*`, `exam.*`, `result.*`, `finance.*`, `report.*`, `push.*` (M2). Each milestone adds its permissions to the catalog and the matrix **in the same change** as its routes (the route-coverage test fails otherwise).

---

## 4. Catalog rules (tested)

1. Every route has exactly one required permission (or is on the public allowlist: `/health`, `/ready`, `/public/tenant`, `/auth/login|refresh|forgot-password|reset-password|accept-invite`).
2. Every permission in the catalog is referenced by ≥ 1 route or declared `internal` (e.g., `assistant.*`).
3. CRITICAL permissions require a `reason` in the request, a **step-up** (MFA verification within the last 10 minutes on the current session) for users in MFA-required roles, and always produce an audit event with `risk_tier ≥ 2`.
4. Mode per role is single-valued; generated seeds are idempotent.
5. Changing the matrix requires a migration (`role_permissions` update) **and** bumps `authz_version` for affected users.
6. No permission name contains a scope word (`own`, `all`, `dept`); scope is data (`scope_mode` + assignment).
