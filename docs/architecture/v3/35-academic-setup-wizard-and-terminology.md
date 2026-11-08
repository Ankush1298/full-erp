# 35 — Guided academic setup wizard and terminology management (M3 acceptance remediation, Task 8)

Status: implemented, uncommitted (Task 8; activation integrity and `/faculty` assignments added in Task 9). Canonical requirement: `04` Part 16, Milestone 3, Features "setup checklist", "Terminology via settings" and UI "setup wizard". No migration, no new table, no new permission. Milestone 4 not started.

> **Later note (2026-11-07):** step 1 of the wizard now also holds the institution-type selector (School, College, University) and the role display names that follow from it; see doc 44. Nothing below was changed.

## 1. What was built

| Piece | Where |
|---|---|
| `GET /api/v1/academics/setup-wizard` (read-only) | `backend/src/modules/academics/setup-wizard.service.ts`, `setup.routes.ts` |
| `POST /api/v1/academics/terms/:id/activation` (checked PLANNED → ACTIVE) | same files |
| `terminology` setting: stricter label rule, optional `periodTypes`, duplicate check | `backend/src/shared/settings/registry.ts`, `organization/settings.service.ts` (new `validate` hook) |
| `GET /academics/terminology` also returns `periodTypes` and `byCohort` | `setup.service.ts` |
| Web: "Setup wizard" tab with the terminology editor in step 1 | `apps/web/src/pages/AcademicSetupWizard.tsx`, `AcademicsPage.tsx`, `src/lib/terminology.ts` |

The existing setup checklist (doc 33 §7) is unchanged and stays as its own tab.

## 2. Wizard steps

Thirteen steps, in this order. **Required** steps decide the progress count. **Optional** steps are recommendations and never block activation.

| # | Key | Required | ERROR (blocks the step) | WARNING (recommendation) | In-wizard form (existing endpoint) |
|---|---|---|---|---|---|
| 1 | `institution` | yes | — | — | terminology editor (`PUT /organization/settings/terminology`) |
| 2 | `campuses` | yes | no active campus; no active department | campus without department | campus, department |
| 3 | `calendar` | yes | no open academic year; no open term | active campus without an open term | — (Calendar tab) |
| 4 | `programmes` | yes | no period type / programme / cohort / open cohort period | programme without an open period | period type, programme, cohort, cohort period |
| 5 | `sections` | yes | no section in an open term | period without section; section without capacity | — (Sections tab) |
| 6 | `curriculum` | yes | no active course | programme without curriculum | curriculum course |
| 7 | `staff` | yes | no active employee | — | employee record (links: Users, Imports) |
| 8 | `assignments` | yes | no published offering; published offering without a teacher to the term end | employee without a current primary posting | posting (link: Offerings) |
| 9 | `classTeachers` | **no** | — | section without a PRIMARY class teacher | — (Sections tab) |
| 10 | `timetable` | **no** | — | no room; published offering without a slot | room (link: Offerings) |
| 11 | `holidays` | **no** | — | open term without a holiday | — (Holidays tab) |
| 12 | `enrolment` | **no** | — | no student / open enrolment / registration; enrolment without section | — (links: Imports, Students, Enrolment) |
| 13 | `review` | yes | no active term | — | academic-year and term activation |

"Open" means PLANNED or ACTIVE, as in the checklist.

The step list is the same for every institution. The steps that only schools need (class teachers) are optional, so a college or university is never held up by them. Titles and texts use the institution's labels.

A form appears only when the user holds the endpoint's own permission (`org.campus.manage`, `academic.program.manage`, …). Every form sends exactly the existing endpoint's body.

## 3. Save, resume, duplicates, activation

- **Progress is derived.** Every count is taken from the records on each read, so there is no wizard table and no flag anyone can tick. Saving a step means creating its records. Resuming opens the first required step that is not complete, and any step can be revisited.
- **No browser storage.** The web security pin (`tests/security-static.test.ts`) forbids `localStorage` and `sessionStorage`, so the wizard does not remember the last-opened step. It resumes from the records instead.
- **No duplicates.** The wizard itself writes nothing except activation. Retried creates hit the existing unique keys (campus code, section name in its period, …) and get 409, which the form reports as "already exists". Tests pin a retried campus create and a retried section create.
- **Activation readiness of a term:**
  - **Blocking (ERROR):** the campus is not ACTIVE; the academic year is not ACTIVE (the `0033` terms guard admits PLANNED → ACTIVE only inside an ACTIVE year; Task 8 found this when its first test failed); no ACTIVE cohort period; no PUBLISHED offering; a published offering without a teacher to the term end.
  - **Recommendations (WARNING):** period without section, section without class teacher, offering without slot, no holiday, no enrolment, enrolment without section.
- **`POST /terms/:id/activation`:**
  - Requires `If-Match` (428 missing, 409 stale) and `academic.term.manage` on the term's campus (403 without the permission, 404 when out of scope or missing).
  - Re-checks readiness on the server: 409 `SETUP_INCOMPLETE`, with `details[].field` = blocking code and `message` = count.
  - Then calls the existing `TermService.update({status:'ACTIVE'})`, so transitions, version and audit (`academic.term.update`) are unchanged.
  - A retry on an ACTIVE term with its current version is a no-op: no version bump, no audit.
  - The web asks for an explicit "Confirm activation"; the reason is optional. The academic year has its own explicit button (existing `PATCH /academic-years/:id`).
- **Enforced on every path (Task 9).** The rules live in `term-readiness.ts` and are applied by `TermService.update` itself on every PLANNED → ACTIVE transition, so `PATCH /terms/:id {status:'ACTIVE'}`, `POST /terms/:id/activation` and any future caller give the same 409 `SETUP_INCOMPLETE` with the same `details`.
  - **Order:** the scope check (403/404), the transition check, then the term row lock (after its academic year, `FOR SHARE`), the `If-Match` check (a stale version is 409 `CONFLICT`, never a readiness answer), and only then readiness, in the same transaction.
  - **Unchanged:** other edits (name, dates, CLOSED, LOCKED with reason) and the no-op retry.
  - **Activation with a date change:** a PATCH that activates and moves the dates in one request is checked again on the new dates after the UPDATE (Task 9 closeout found that the first check read the stored dates); a refusal rolls the transaction back.
  - **Only one writer:** `calendar.service.ts` is the only SQL writer of `app.terms`, and a test pins this, so no alternate route can skip the rule.
  - **Concurrency:** publishing or cancelling an offering locks its term `FOR SHARE` (`0037` guard), so it serialises with activation. Ending an assignment does not lock the term, but racing it is equivalent to "activate, then end", which is legal: readiness is a gate at activation time, not an invariant of running terms.
  - **Test fixtures:** tests whose subject is not activation activate their terms with a labelled superuser fixture (`tests/support/term-fixture.ts`); the database's own year guard still applies to it.

## 4. Terminology

- **Slots** (unchanged): `program`, `cohort`, `period`, `section`, `term`, `course`.
  - Each label is 1–40 characters with no leading or trailing whitespace, no control characters and no `<` `>`.
  - No two slots may show the same label. Comparison ignores case and spacing, and counts the fallback of an unset slot (so `section: 'Batch'` clashes with the default cohort label).
  - Messages name the slots, never the submitted value.
- **Programme-aware period label:** the optional `periodTypes: { <period type code>: label }` (at most 50 entries).
  - A cohort period shows its programme's period-type label where one is set, and otherwise the institution-wide `period` label.
  - A period-type label may not reuse a non-period slot's label.
  - This is the smallest safe fix for the doc 32/college-regression finding that a tenant-wide `period` label cannot serve a college with both YEAR and SEMESTER programmes. No migration: the value lives in the existing `organization_settings` row, and `period_types.label` is not changed.
- **Read side:** `GET /academics/terminology` adds two fields.
  - `periodTypes[]`: every period type with its resolved label.
  - `byCohort`: cohort id → label, only for cohorts whose period type has its own label. It is built with `CohortService.list` and `ProgramService.list`, so it shows exactly the cohorts the reader can already list (an HOD sees their department's only, other tenants see none), and it is empty when no period-type label is set.
- **Backward compatible:**
  - Stored values without `periodTypes` keep their meaning; defaults are unchanged.
  - Older web clients ignore the new fields; the new web client defaults them when an older server omits them.
- **Editing:**
  - Uses the existing `PUT /organization/settings/terminology`: `org.settings.manage` (only `COLLEGE_ADMIN` at organisation scope), step-up, `If-Match`, mandatory reason, tier-2 audit.
  - The web checks the same rules first, then lets the server decide.
  - Presets fill the fields but do not save them:
    - **School:** Programme → Class, Period → Grade, Course → Subject, Section → Section, Term → Term.
    - **College:** each period type's own label (Year/Semester).
    - **University:** Semester.
  - An empty field means the default. "All defaults" is stored as the defaults themselves, because the setting needs at least one key.
- **Labels are display only.** Tests snapshot every academic row of the tenant (and of another tenant) around a label change and find them identical, `period_types.label` included.

## 5. Decisions recorded

- **Elective registration stays staff-managed for the school pilot.** Grades 11–12 electives use the existing staff workflow (doc 33, Electives tab). College and university registration APIs and lifecycle are unchanged. Student or parent self-service selection is a **future product enhancement**: Part 16 lists "elective registration" as a UI without naming who registers, so it is not treated as an M3 blocker here. The owner may decide otherwise.
- **`/faculty` assignments: implemented (Task 9; this supersedes Task 8's "no separate API").** The canonical API table (`04` line 22) gives `/faculty` the resources "employee, posting, **assignment view**" and the operations "create, post to department, **assign offerings**, **workload view**"; Milestone 3 lists "`/faculty` (assignments)". Nothing under `/faculty` served assignments, so the criterion was not met. Added (`faculty.routes.ts`), both on the existing `FacultyAssignmentService`, with no second model:
  - `GET /api/v1/faculty/employees/:id/assignments[?termId=]`: the assignment/workload view. Each row is the assignment record plus `termId`, `offeringCode`, `offeringTitle`, `offeringStatus`.
    - The employee must be visible under the existing employee rules (`EmployeeService.getById`): `employee.profile.read`, SELF for a teacher's own record, department and campus scope by posting, 404 out of scope or for another tenant.
    - The caller must also hold `academic.program.read`.
    - Each row must pass the same per-offering scope check as `GET /course-offerings/:id/faculty-assignments`, so an HOD does not see the employee's assignments in another department's offerings.
  - `POST /api/v1/faculty/employees/:id/assignments {courseOfferingId, teachingRole, validFrom, validTo?, reason}` ("assign offerings") calls `FacultyAssignmentService.create`. It keeps the same `academic.faculty.assign` permission, posting/ACTIVE/one-PRIMARY rules, conflicts and audit action (`academic.faculty_assignment.create`).
  - Ending an assignment stays `PATCH /academics/faculty-assignments/:id`. The course-offering routes are unchanged (backward compatible).
  - **Workload view: partly met.** The GET lists a teacher's assignments with offering and term (filterable by term). It reports no quantitative load (weekly timetable periods or hours); that remains an open acceptance item.

## 6. Tests

- `backend/tests/integration/academic-setup-wizard.test.ts` (15 tests):
  - **School (synthetic):** 3 campuses × Grades 1–12 × 4 sections = 144 sections, built over HTTP with the wizard re-read after each step. Also: an incomplete tenant, a read-only check, authorization (campus admin, campus registrar, HOD, faculty and student get 403; org registrar 200; unauthenticated 401), retried creates, activation blocked then explicit (428/409/404/403/400), a no-op retry with one audit row, the CLOSED lifecycle, holiday and class-teacher warnings per campus.
  - **Terminology:** the school preset with an unchanged-data snapshot; validation (11 refused values, legacy shape accepted); only a settings manager may write.
  - **College:** YEAR and SEMESTER programmes, the `byCohort` map by scope.
  - **University:** defaults.
- `backend/tests/unit/settings-registry.test.ts`: three new tests (pattern, `periodTypes`, duplicate rule).
- `apps/web/tests/academics-setup-wizard.test.tsx` (15 tests): resume on the first incomplete required step, progress, optional steps, revisiting and links, a duplicate refused then created, blocked/ready/confirmed activation with `If-Match`, server refusal with refresh, the academic-year button, the school and college presets, server 400/409 wording, a read-only editor without permission, the client label rules, the programme-aware option label, a campus-scoped 403, no tab without permission, an axe audit.

The real pilot curriculum is **not** used anywhere; all school data is synthetic.

## 7. Limitations and open owner decisions

1. Resolved in Task 9: every activation path enforces readiness (§3).
2. Resolved in Task 9: readiness is read after the term lock; the remaining race (ending an assignment) is benign (§3).
2a. Readiness is enforced in the service, not by a database trigger. `app_runtime` holds `UPDATE (status)` on `app.terms` (`0033`), and `calendar.service.ts` is today the only code that writes the table (verified by search of `backend/src`, `backend/tools` and the migrations, and pinned by a test). A future code path, a superuser or a migration could still write `app.terms.status` directly.
3. "Current posting" uses the database `current_date`, not each campus's calendar day (off by at most one day near midnight).
4. The wizard does not remember the last-opened step (security pin, §3).
5. There are no in-wizard forms for academic years and terms, sections, offerings and assignments, class teachers, timetable slots, holidays or enrolment. Those steps link to the existing screens, which already have forms.
6. `periodTypes` labels are keyed by period-type code; a code change (not possible today: no update endpoint) would orphan a label.
7. The pilot's real CBSE curriculum walkthrough and a real full-term structure remain **pending school input** (Task 7 report).
