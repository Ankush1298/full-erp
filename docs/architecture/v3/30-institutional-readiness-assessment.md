# 30 — Institutional Readiness Assessment

**Date**: 2026-10-29
**Author**: Antigravity assistant (pair programming session)
**Baseline**: HEAD `bd05759` + uncommitted B6 fix (`student.service.ts`, `docs/architecture/v3/21-students.md`,
`backend/tests/integration/m2-acceptance.test.ts`, `backend/tests/integration/student-profile-scope.test.ts`)
**Roadmap reference**: `docs/architecture/v3/04-api-frontend-phasing-adrs.md` Part 16 — seven milestones, unchanged

> **Critical rule**: All capability classifications are based on actual code inspection and test evidence, not on the
> existence of a table or route declaration alone. "Tested" means an automated test demonstrates the behaviour
> end-to-end through the HTTP or service layer.

---

## 1. B6 Verification Summary

All required checks passed on the disposable PostgreSQL harness (TEST_DATABASE_URL unset; embedded PostgreSQL 16 per
run, dropped afterwards; no persistent database was touched).

| Command | Result |
|---|---|
| Focused scope-matrix (`student-profile-scope.test.ts`) | ✅ 14/14 |
| `backend/tests/integration/m2-acceptance.test.ts` | ✅ 16/16 |
| `pnpm --filter @campusos/backend run test:integration` | ✅ **70 files, 1,399/1,399** |
| `pnpm --filter @campusos/backend run test:security` | ✅ 42 files, 680/680 |
| `pnpm --filter @campusos/web test` | ✅ 15 files, 241/241 |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0 |
| `pnpm format:check` | ✅ exit 0 |
| `pnpm check:secrets` | ✅ no findings |
| `pnpm build` | ✅ exit 0 (Vite chunk-size warning only) |
| `pnpm check:bundle` | ✅ 5 files, no findings |
| `git diff --check` | ✅ exit 0 |

**B6 authorization fix** (`student.service.ts` + `21-students.md`): `StudentService.getById` now reads the
student's ACTIVE enrolment and passes its frozen `campus_id`/`department_id` to the authorization engine.
CAMPUS- and DEPARTMENT-scoped holders are judged against that enrolment; ORGANIZATION-scoped and SELF holders are
unaffected. The 14-test scope-matrix and 16-test acceptance suite (HOD seeing exactly its 50 students, not the
other 50) verify the invariants:

- HOD access limited to students with an ACTIVE enrolment in their exact assigned department.
- Campus scope restricts to the frozen campus of the student's ACTIVE enrolment.
- Organization scope gives full tenant access, placed or unplaced.
- Student with no ACTIVE enrolment visible only to ORGANIZATION-scoped and SELF holders (fail-closed).
- Out-of-scope, nonexistent, and other-tenant records produce indistinguishable 404 (non-disclosure).
- Expired, revoked, inactive, or not-yet-started assignments grant nothing.
- Request parameters cannot supply a scope; query campus/department IDs are ignored.
- Sensitive identifiers remain gated behind `student.profile.read_sensitive` separately.

---

## 2. Dual-Institution MVP Coverage Assessment

### Classification Key
- **IT** — Implemented and tested (automated test through HTTP or service layer)
- **IU** — Implemented but insufficiently verified (code exists; only unit/static tests)
- **PA** — Partial (some aspects implemented; key parts missing)
- **MI** — Missing (designed; no code or test)
- **BL** — Blocked (open owner decision or unbuilt prerequisite)

Institution-type columns: **S** = School (K-12), **U** = College / University

---

### 2.1 Organization and Campus Management

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Create organization via platform CLI | IT | ✅ | ✅ | `platform-cli.test.ts` |
| Create / update / deactivate campus | IT | ✅ | ✅ | `campus.test.ts` 52 tests |
| Create / update / delete department + hierarchy | IT | ✅ | ✅ | `department.test.ts` 36 tests |
| Designations | IT | ✅ | ✅ | `designation.test.ts` 27 tests |
| Organization settings registry | IT | ✅ | ✅ | `organization-settings.test.ts` |
| Rooms | IT | ✅ | ✅ | `rooms.test.ts` |
| Multi-campus administration via scoped roles | IT | ✅ | ✅ | Scoped role assignment tests |
| **K-12 grade / class vocabulary** | MI | ⚠ | — | No grade table; departments can substitute (owner decision) |

**Assessment**: Complete for universities. For schools, the grade layer is absent. An MVP school may use
departments as grade-groups and sections (M3) as classes, if the owner confirms this is acceptable.

---

### 2.2 Student and Staff Management

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Create student record (idempotent, audited, person-locked) | IT | ✅ | ✅ | `student.test.ts`, `student-atomicity.test.ts` |
| Student profile read (scope-enforced per enrolment) | IT | ✅ | ✅ | `student-profile-scope.test.ts` 14, `m2-acceptance.test.ts` |
| Student status transitions | IT | ✅ | ✅ | `student-status.test.ts`; guard migration `0026` |
| Student directory search (admission number) | IT | ✅ | ✅ | `student-directory.test.ts` |
| Student directory list (cursor-paginated, flag+key gated) | IT | ✅ | ✅ | `student-directory-list.test.ts` |
| Student identifiers (PRN, APAAR, etc.; immutable) | IT | ✅ | ✅ | `student-identifiers.test.ts` |
| Student guardians | IT | ✅ | ✅ | `student-guardian.test.ts`, `migration-0027.test.ts` |
| Student program assignment (enrolment; campus/dept frozen) | IT | ✅ | ✅ | `student-program.test.ts`, `enrolment-guards.test.ts` |
| Student import (CSV, all-or-nothing, duplicate detection) | IT | ✅ | ✅ | `import-framework.test.ts`, `student-duplicates.test.ts` |
| Student update (name, DOB) | MI | ⚠ | ⚠ | No PATCH route; only status is writable |
| Student merge | MI | ⚠ | ⚠ | Designed; no code |
| Free-text / name search | MI | ⚠ | ⚠ | Admission-number search only |
| Create employee record (idempotent, audited, person-locked) | IT | ✅ | ✅ | `employee.test.ts` |
| List employees (filtered) | IT | ✅ | ✅ | `employee-routes.test.ts`; limit/offset (cursor pagination TBD) |
| Employee postings (department, designation) | IT | ✅ | ✅ | `employee-postings.test.ts` |
| Employee separation | IT | ✅ | ✅ | `employee-scope-and-separation.test.ts` |
| Employee import (CSV) | IT | ✅ | ✅ | `import-framework.test.ts` |
| **Student age-of-majority / minor flags** | PA | ⚠ | — | Setting key exists; no enforcement; no DOB writer |

---

### 2.3 Guardian Support

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Guardian record creation + phone normalisation | IT | ✅ | ✅ | `student-guardian.test.ts` |
| Guardian notification policy (setting key) | IU | ✅ | ✅ | Key registered; no delivery hook |
| Guardian academic visibility (setting key) | IU | ✅ | ✅ | Key registered; no guardian API |
| Guardian portal / login | MI | ⚠ | — | Not built; post-pilot milestone |
| Guardian consent management | PA | ✅ | ✅ | `consent.test.ts`; no guardian-specific flow |

**Assessment**: Guardian records are fully built. Portals, notification delivery, and visibility enforcement are not.
Significant for schools; safely deferred for universities.

---

### 2.4 Academic Structure

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Programs (degree programmes) | IT | — | ✅ | `academic.test.ts`; department-owned |
| Cohorts (admission batches) | IT | — | ✅ | `academic.test.ts` |
| Period types (SEMESTER, YEAR, etc.) | IT | — | ✅ | Tenant-created; `academic.test.ts` |
| Academic years and terms (state machine) | IT | ✅ | ✅ | `academic-calendar.test.ts`, `academic-calendar-routes.test.ts` |
| Term enrollment | IT | — | ✅ | `academic-calendar.test.ts` |
| Sections | IT | ✅ | ✅ | _Corrected 2026-11-05:_ `app.sections` and `app.section_memberships` (migration `0033`, committed `6255e0e`, 2026-10-21); `academic-calendar.test.ts`. The original entry said "Roadmap M3 Batch 2; no table, no code" |
| Courses, curriculum | IT | ✅ | ✅ | _Corrected 2026-11-05:_ `app.courses`, `app.curriculum_courses` (migration `0033`); `curriculum.service.ts`; `academic-calendar.test.ts`. The original entry listed them as missing |
| Elective groups | MI | ⚠ | ⚠ | Roadmap M3 (true at this assessment's date; later built in `0039`, doc 33) |
| Course offerings + faculty assignments | MI | ⚠ | ⚠ | Roadmap M3 |
| Timetable slots | MI | ⚠ | ⚠ | Roadmap M3 |
| Promotion tool | MI | ⚠ | ⚠ | Roadmap M3 |
| **K-12 grade levels** | MI | ⚠ | — | No grade table |

**Assessment**: University programmes and term-enrolment are fully implemented. Sections, courses, timetables,
and promotions — the core of M3 Batch 2 — are entirely absent. This blocks attendance and course registration
for both institution types.

> **Correction (2026-11-05).** The original assessment above is kept as written, but its statement that sections and
> courses were absent was already wrong on 2026-10-29: sections, section memberships, courses and curriculum courses
> were implemented and tested in M3 Batch 1 (migration `0033`, committed `6255e0e` on 2026-10-21; doc 24). What was
> genuinely missing on that date was course offerings, faculty assignments, timetable slots, elective groups,
> registrations, holidays and the promotion tool, which were implemented later (migrations `0037`–`0039`; docs 31–33).
> The same correction applies to later passages of this document that list sections or courses as missing (§3 table
> row "Sections + courses + curriculum", §4.1 item 2, §5 Scenario B, §6, §7 item 2 and §8); for the current M3 status
> see doc 39.

---

### 2.5 Attendance and Audited Corrections

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Class sessions, marking, submit/lock | MI | ⚠ | ⚠ | Roadmap M4; depends on M3 sections |
| Attendance policies (resolution, pinning, recompute) | MI | ⚠ | ⚠ | Roadmap M4 |
| At-risk warnings and summaries | MI | ⚠ | ⚠ | Roadmap M4 |
| Audited corrections | MI | ⚠ | ⚠ | Roadmap M4 |

**Assessment**: Attendance is entirely missing. Both institution types require it for daily operations.

---

### 2.6 Role and Scope Administration

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Role matrix seeding per tenant | IT | ✅ | ✅ | `platform-cli.test.ts`, `permission-seed.test.ts` |
| Grant / revoke role assignment (scoped, with reason, expiry) | IT | ✅ | ✅ | `assignments.test.ts`, `role-administration.test.ts` |
| Last-administrator guard | IT | ✅ | ✅ | `role-administration.test.ts` |
| Person-identity exclusivity (student ↔ staff) | IT | ✅ | ✅ | `person-identity-invariant.test.ts` |
| Step-up MFA for critical role changes | IT | ✅ | ✅ | `step-up.test.ts`, `mfa.test.ts` |
| Hierarchical scope containment | MI | ⚠ | ⚠ | Exact-match only; documented, fail-closed |
| **Teacher scope by class (school)** | PA | ⚠ | — | Requires sections (M3) |

---

### 2.7 Invitation and Onboarding

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Admin sends invitation (single-use token) | IT | ✅ | ✅ | `user-invitations.test.ts` 31 tests; InMemoryInvitationMailer in tests |
| Invitee accepts invitation | IT | ✅ | ✅ | Same; rate-limited, uniform error |
| MFA enrollment after login | IT | ✅ | ✅ | `mfa.test.ts` |
| Step-up re-verification for critical actions | IT | ✅ | ✅ | `step-up.test.ts` 45 tests |
| **Actual email delivery in production** | BL | ⚠ | ⚠ | DisabledInvitationMailer is the production default; owner decision required |

---

### 2.8 Data Import

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Student record import (CSV; validate → preview → commit) | IT | ✅ | ✅ | `import-framework.test.ts`, `m2-acceptance.test.ts` (100 students) |
| Employee record import (CSV) | IT | ✅ | ✅ | Same (20 faculty) |
| Import duplicate detection + HMAC replay binding | IT | ✅ | ✅ | `student-duplicates.test.ts`; IMPORT_MATCHING_KEYS required in production |
| Import of accounts (create new users in one step) | MI | ⚠ | ⚠ | Rows name existing accounts by e-mail only |
| Import of program enrolments | MI | ⚠ | ⚠ | Per-student via POST /students/:id/programs |
| Import of guardian data | MI | ⚠ | ⚠ | Not in M2 scope |

---

### 2.9 Deployment, Secrets, Backups, and Monitoring

| Capability | Status | S | U | Evidence / Gap |
|---|---|---|---|---|
| Docker Compose dev environment | PA | ✅ | ✅ | Exists; not verified in this assessment |
| Production secrets model documented | IT | ✅ | ✅ | `docs/runbooks/secrets.md`; static tests pin TTL constants |
| Database migrations (forward-only, gated) | IT | ✅ | ✅ | `migration-contract.test.ts`, advisory locking |
| Migration runbooks | IT | ✅ | ✅ | academic-structure, students-contract, employee-separation, mfa, secrets |
| Backup procedure | MI | ⚠ | ⚠ | Not specified; M7 deliverable |
| Restore drill | MI | ⚠ | ⚠ | M7 deliverable; RPO/RTO undocumented |
| Observability / metrics | MI | ⚠ | ⚠ | /health + /ready only; no metrics, no alerting |
| Rate limiting | PA | ✅ | ✅ | FixedWindowLimiter on login/invite/directory; no global limiter |
| Tenant roles re-seed after new permissions | BL | ⚠ | ⚠ | seedTenantRoles not run on any persistent database; owner-approved operation needed per tenant |

---

## 3. Capability Summary Table

| Domain | School (S) | University (U) | Milestone |
|---|---|---|---|
| Organization / campus / department | ✅ PA (no grade table) | ✅ IT | M1–M2 |
| Rooms | ✅ IT | ✅ IT | M2 |
| Employee records + postings | ✅ IT | ✅ IT | M1–M2 |
| Student records + identifiers | ✅ IT | ✅ IT | M1–M2 |
| Guardian records | ✅ IT | ✅ IT | M1–M2 |
| Guardian portal / delivery | ❌ MI | ❌ MI | Post-pilot |
| Programs + cohorts | — | ✅ IT | M1–M3 partial |
| Academic calendar + terms | ✅ IT | ✅ IT | M3 Batch 1 |
| Term enrollment | — | ✅ IT | M3 Batch 1 |
| Sections + courses + curriculum | ❌ MI | ❌ MI | M3 Batch 2 |
| Timetable | ❌ MI | ❌ MI | M3 |
| Faculty assignments | ❌ MI | ❌ MI | M3 |
| Attendance | ❌ MI | ❌ MI | M4 |
| Student + employee import (CSV) | ✅ IT | ✅ IT | M2 |
| Invitation + onboarding | ✅ IT (no live email) | ✅ IT (no live email) | M2 |
| Role administration + scoping | ✅ IT | ✅ IT | M2 |
| MFA + step-up | ✅ IT | ✅ IT | M1 |
| Audit logging (write) | ✅ IT | ✅ IT | M1 |
| Audit trail read API | ❌ IU | ❌ IU | Post M6 |
| Service requests | ❌ MI | ❌ MI | M5 |
| Ticketing | ❌ MI | ❌ MI | M6 |
| Reporting (other than import errors) | ❌ MI | ❌ MI | M4–M7 |
| Backup / restore | ❌ MI | ❌ MI | M7 |
| Observability | ❌ MI (health/ready only) | ❌ MI | M7 |

---

## 4. Minimum Launchable MVP

### 4.1 Essential for Launch (blocking — cannot operate without these)

1. **Email delivery**: Configure a provider (SES, SendGrid, Postmark). Verify DNS, SPF, DKIM, DMARC. Wire
   InvitationMailer implementation. Without this, no account can be activated via invitation.
2. **Sections and M3 Batch 2**: Every attendance record and course registration depends on sections. Neither school
   nor university can run academic operations without them. Approximately 4–5 weeks of development.
3. **Attendance (M4)**: Schools and universities both need daily attendance marking. Depends on M3. Another ~4 weeks.
4. **Tenant roles re-seed**: All permissions added by migrations 0010–0036 must be seeded into every tenant's role
   matrix before staff can use them. Not yet executed on any persistent database.
5. **Migration sequence to 0036**: All 29 remaining migrations must be applied in order (two operator-approved
   contract boundaries: --allow-contract 0009, then --allow-contract 0019). The persistent development database is
   at 0007. Lock times are unmeasured against a production-sized dataset.
6. **Production secrets**: CURSOR_KEYS + CURSOR_ACTIVE_KEY_ID (student directory), MFA_ENCRYPTION_KEYS (TOTP),
   IMPORT_MATCHING_KEYS (import replay binding). None provisioned for any environment.
7. **Student name + DOB writer**: users.date_of_birth has no UPDATE grant or route. Duplicate detection will not
   match in production without it (owner decision, doc 26 §7 item 11).
8. **Backup and restore procedure (M7)**: No backup strategy exists. A production deployment without a tested
   restore path is a critical operational risk.

### 4.2 Safe to Defer After Launch

1. Guardian portal and notification delivery (post-pilot milestone 12).
2. Service requests (M5) and ticketing (M6).
3. Elective registration windows and advanced course registration.
4. Cursor-based employee list pagination (FU-EMP-1; limit/offset functional for small staff lists).
5. Audit trail read API and cross-domain reporting.
6. Finance module (post-pilot milestone 11).
7. Student merge workflow.
8. Hierarchical scope containment (campus admin → department delegation).
9. QR/biometric attendance capture (post-pilot, after separate design + legal review per ADR-016, ADR-022).
10. Student AI assistant (post-pilot milestone 10).
11. Import-row retention policy and purge job (doc 26 §7 item 16, temporarily accepted).
12. PWA offline caches, multi-campus UI, parent portal, analytics (post-pilot milestone 12).
13. K-12 grade vocabulary — if owner confirms departments-as-grades is acceptable for initial school pilots.

### 4.3 Required Owner Decisions

| # | Decision | Impact if deferred |
|---|---|---|
| OD-1 | Email provider + DNS setup | Invitations blocked; no onboarding |
| OD-2 | users.date_of_birth writer (doc 26 §7 item 11) | Duplicate detection inert in production |
| OD-3 | Import-row retention policy (doc 26 §7 item 16) | Non-sensitive import rows accumulate |
| OD-4 | Guardian portal scope (schools vs universities) | Missing for schools; deferred for universities |
| OD-5 | K-12 grade table vs departments-as-grades | Blocks school-specific pilots |
| OD-6 | Production secret manager choice for key rings | Rings exist in code; no provisioning path |
| OD-7 | Cloud vs self-hosted deployment target | Docker Compose exists; provider not chosen |
| OD-8 | Tenant roles re-seed approval and execution plan | All M2 permissions inert in production |
| OD-9 | Lock time measurement + maintenance window for 0008/0009/0019/0036 | Risk of unacceptable lock duration |

---

## 5. Representative Acceptance Scenarios

### Scenario A — Primary School (K-12)

**Institution**: "Sunrise Public School", two campuses (Main and Annex), grades 1–10.

**Same-platform configuration**:
- Departments as grade-groups (Grade-1 … Grade-10) under each campus.
- identity.age_of_majority = 18 setting; guardian portal not built.
- Academic calendar: two-semester school year.
- STUDENT_DIRECTORY_LIST_ENABLED = true; CURSOR_KEYS provisioned.
- Invitation mailer configured; all staff invited by COLLEGE_ADMIN.

**Opening-term workflow (what must work for launch)**:
1. COLLEGE_ADMIN creates both campuses and all grade-departments via the organization API.
2. Import 1,200 student records and 80 staff (CSV; existing accounts created via invitations).
3. Assign class teachers as HOD of their grade-department (scoped role grant via /access).
4. Guardian records entered per student (manual API call; no portal).
5. COLLEGE_ADMIN places students into their grade-department via POST /students/:id/programs.
6. HOD of Grade-5 lists and views exactly the Grade-5 student profiles; cannot see Grade-6.
7. Suspension of a student by COLLEGE_ADMIN revokes their session immediately.

**Currently blocked**:
- No attendance module (M4); teachers cannot mark attendance.
- No timetable (M3); class schedules cannot be managed.
- Guardian portal does not exist.
- If no email provider is configured, invitations cannot be sent.

### Scenario B — Engineering College (University)

**Institution**: "Anesa College of Engineering", one campus, four departments (CSE, ECE, ME, CE), B.Tech.

**Same-platform configuration**:
- Departments = engineering departments.
- Programs: B.Tech CSE, ECE, ME, CE (4 years / 8 semesters).
- Cohorts: admission years 2022–2025.
- STUDENT_DIRECTORY_LIST_ENABLED = true.

**Opening-term workflow**:
1. COLLEGE_ADMIN creates the campus, four departments, period type SEMESTER, and all B.Tech programs.
2. Import 2,000 student records and 200 faculty (CSV).
3. Place students into their program + cohort via POST /students/:id/programs.
4. HOD of CSE sees exactly the CSE student profiles; CAMPUS_ADMIN sees all 2,000.
5. Cursor-paginated student directory works end-to-end.
6. Import replay with same idempotency key and HMAC replays correctly; changed data is rejected.

**Currently blocked**:
- No sections, course offerings, or timetable (M3).
- No attendance module (M4).
- Faculty assignment to courses not possible (M3).
- If no email provider configured, invitations cannot be sent.

---

## 6. Gap-to-Roadmap Mapping

| Gap | Roadmap item |
|---|---|
| Sections, courses, curriculum, elective groups, course offerings | M3 Batch 2 |
| Timetable slots, holidays, promotion tool | M3 Batch 2 |
| Faculty assignments to offerings | M3 Batch 2 |
| Attendance (all aspects) | M4 |
| Attendance reporting | M4 |
| Service requests | M5 |
| Ticketing | M6 |
| Backup / restore / observability / pen-test | M7 |
| Guardian portal | Post-pilot M12 |
| K-12 grade table | Owner decision + new migration (outside current roadmap scope) |
| users.date_of_birth writer | Owner decision, doc 26 §7 item 11 |
| Email provider / DNS setup | Owner decision, infra |
| Production secret provisioning | Owner decision + M7 |
| Tenant roles re-seed execution | Owner-approved operation |

---

## 7. Top 8 Launch Blockers

1. **Email delivery (OD-1)**: DisabledInvitationMailer is the production default. No invitation can reach a real
   mailbox without an owner-approved provider, DNS records, and a wired mailer implementation.
2. **Sections + M3 Batch 2**: Neither school nor university can track students in classes or run attendance without
   sections. Approximately 4–5 weeks of development.
3. **Attendance (M4)**: The core daily workflow is absent. Depends on M3. Another ~4 weeks.
4. **Migration sequence execution**: The persistent development database is at 0007. All 29 remaining migrations must
   be applied with operator approval for two contract boundaries. Lock times are unmeasured.
5. **Tenant roles re-seed**: Until seedTenantRoles is run after each contract migration batch, all permissions added
   since 0009 are inert in production.
6. **Production secrets provisioning**: CURSOR_KEYS, MFA_ENCRYPTION_KEYS, and IMPORT_MATCHING_KEYS must be
   provisioned before the corresponding features are active.
7. **Backup and restore (M7)**: No backup strategy exists. No restore drill has been performed.
8. **users.date_of_birth writer**: Duplicate detection at creation and import will not match without this field
   being writable (owner decision required).

---

## 8. Go / No-Go Recommendation

**Go/No-Go for production launch today: NO-GO**

Milestones 3 (sections, courses, timetables) and 4 (attendance) are entirely absent. Email delivery is blocked.
No backup/restore procedure exists. The persistent development database is 29 migrations behind.

**Go/No-Go for a limited pilot (data loading and role administration only): CONDITIONAL**

A restricted pilot — testing onboarding, student imports, and scoped role visibility without attendance,
timetabling, or course registration — could proceed once:

1. Email provider configured (OD-1).
2. Migrations 0008–0036 applied in documented order on the pilot database (operator approval).
3. seedTenantRoles executed for the pilot tenant.
4. Production secrets provisioned (CURSOR_KEYS, MFA_ENCRYPTION_KEYS; IMPORT_MATCHING_KEYS if import is used).
5. STUDENT_DIRECTORY_LIST_ENABLED=true confirmed under single-instance constraint (rate limiter is per-process).

**This assessment does not constitute a deployment or production readiness claim.** All test evidence is from
disposable databases. No staging environment, real provider, or production configuration has been verified.

---

## 9. What This Assessment Does Not Claim

- The platform is ready for production. It is not.
- The seven-milestone roadmap should be changed or compressed. It should not.
- University-only or school-only divergence is necessary. The roadmap already supports both through configurable
  settings, departments-as-grades for K-12, and institution-type settings.
- Any test result implies behaviour under load, in a cloud environment, or with real email, S3, or external secret
  managers. It does not.
