# 24 — Academic calendar, curriculum, sections and term enrolment (Milestone 3, Batch 1)

Status: **implemented and tested on disposable databases; not applied to any persistent database.** Specification sources: `02` §4.5–4.6 (tables), `07` §3 (model), `04` Part 16 (Milestone 3), `08` §4 (RLS, `student_self_only`), `10` rows 50–54 (permissions). Migration: `database/migrations/0033_academic_calendar_and_enrollment.sql`.

Roadmap note. The seven-milestone roadmap of `04` Part 16 names this work **Milestone 3 — Academic Structure & Enrollment** and lists Milestone 2 (rooms, employee postings, student identifiers, import framework) as its dependency. Batch 1 needs none of the Milestone 2 tables, so it was started ahead of them on the owner's instruction (recorded in `PROJECT_LOG.md`). Everything that does need them is deferred (below). No roadmap item was renamed, reordered or dropped.

## 1. What Batch 1 delivers

| Area                     | Table                                  | API (`/api/v1/academics` unless noted)                                    |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------- |
| Academic years           | `academic_years`                       | `GET/POST /academic-years`, `GET/PATCH /academic-years/:id`               |
| Terms (per campus)       | `terms`                                | `GET/POST /terms`, `GET/PATCH /terms/:id`                                 |
| Cohort periods           | `cohort_periods`                       | `GET/POST /cohort-periods`, `PATCH /cohort-periods/:id` (close)           |
| Sections                 | `sections`                             | `GET/POST /sections`, `GET/PATCH /sections/:id`, `GET /sections/:id/members` |
| Courses ("subjects")     | `courses` (soft delete)                | `GET/POST /courses`, `GET/PATCH/DELETE /courses/:id`                      |
| Curriculum               | `curriculum_courses`                   | `GET/POST /curriculum-courses`, `PATCH/DELETE /curriculum-courses/:id`    |
| Term enrolment           | `term_enrollments`                     | `/api/v1/students/:id/term-enrollments` (`GET/POST`, `GET/PATCH /:eid`)   |
| Section placement        | `section_memberships` (effective-dated)| `POST /api/v1/students/:id/term-enrollments/:eid/section`                 |

"Classes" in the owner's wording are cohort periods and their sections; "subjects" are courses (`07` §3).

## 2. Permissions (doc 10 rows 50–54; same change as the routes)

Reads of every Batch 1 structure use the existing `academic.program.read` (all roles, GRANTED within scope). New, all SENSITIVE: `academic.term.manage` (academic years need an ORGANIZATION-scope holder; terms are campus-scoped), `academic.course.manage` (courses by owning department, curriculum by the program's department; a course without an owner is organization-wide), `academic.section.manage` (sections and, through `academic.cohort.manage`, cohort periods, by the program's department), `enrollment.term.read` (STUDENT = SELF, HOD and admins GRANTED, FACULTY none until the M3/M4 ASSIGNED resolver exists), `enrollment.term.manage`. Cohort periods reuse `academic.cohort.manage`. Existing tenants must be re-seeded (`seedTenantRoles`) to receive them; until then they are held by nobody and the routes answer 403 (fail closed).

Scope is always read from the database (the program's department and campus, or the student's FROZEN program-enrolment campus/department), never from the request. Held at all but out of scope, or missing, or another tenant's ⇒ the same 404; not held ⇒ 403.

## 3. Lifecycle rules (service and database guard, both)

These are the rules the specification states plus the smallest consistent completions. Every rule below marked **(A)** is an assumption the architecture does not state; it is listed so the owner can confirm or change it.

- **Academic year**: `PLANNED → ACTIVE → CLOSED`, forward only; label immutable; dates editable only while PLANNED; no two years of a tenant overlap (inclusive dates); closing needs every term CLOSED or LOCKED. Overlap is enforced by a trigger under a per-tenant advisory lock (`btree_gist` is not available to the migration role), so two simultaneous overlapping creates cannot both succeed.
- **Term**: `PLANNED → ACTIVE → CLOSED → LOCKED`, forward only; dates must lie inside the year; code/campus/year immutable; dates editable only while PLANNED; **(A)** a term can only become ACTIVE inside an ACTIVE year and cannot be added to a CLOSED year; LOCKED requires a reason (A2, risk tier 2 audit), stamps `locked_at/locked_by`, and is terminal in Batch 1 (the A2 admin override of `02` §4.5 is deferred). Nothing in a LOCKED term changes (terms, term enrolments, section memberships).
- **Cohort period**: needs an ACTIVE cohort and a PLANNED/ACTIVE term **on the cohort's program campus**; `period_no` within `1..duration_periods` unless flagged `is_extension`; unique per (cohort, term) and (cohort, period_no); **(A)** status is `ACTIVE | CLOSED` (the spec gives no values) and CLOSED is terminal.
- **Section**: only under an ACTIVE cohort period; unique name per period; capacity cannot drop below the live roster; a section with live members cannot be deactivated.
- **Course**: unique code among live rows; code and owning department immutable; credits `numeric(4,1)` (more than one decimal is rejected, not rounded); soft delete only while no curriculum entry prescribes it; an INACTIVE course stays in existing curricula but cannot be added to new entries.
- **Curriculum entry**: ACTIVE program, live ACTIVE course, `period_no` within the programme; unique per (program, regulation, period, course); **(A)** an elective basket code is only allowed on `ELECTIVE` entries (elective groups themselves are Batch 2).
- **Term enrolment**: starts `REGISTERED` for a student whose status is `ADMITTED` or `ACTIVE` and who has an ACTIVE program enrolment **in the cohort period's own cohort**; `period_no`/`term` are copied from the cohort period (composite foreign keys). Unique per (student, cohort period) and per (cohort period, roll number); **(A)** at most one *live* enrolment per student per term (partial unique index). **(A)** Transitions: `REGISTERED → ACTIVE|WITHDRAWN`; `ACTIVE → WITHDRAWN|DETAINED|PROMOTED|COMPLETED|ON_LEAVE`; `ON_LEAVE|DETAINED → ACTIVE|WITHDRAWN`; `WITHDRAWN`, `PROMOTED`, `COMPLETED` are final and entering one closes the open section membership **in the same statement, for every writer** (AFTER UPDATE trigger `term_enrollments_close_membership`: `valid_to` = campus-local date, never before `valid_from`). Every change needs a reason (5–500 characters, audit tier 2) and `If-Match`.
- **Section placement**: effective-dated. Placing opens a membership; moving closes the open one at `validFrom − 1` and opens the new one atomically. `validFrom` must lie inside the term and after the current membership's start; the section must belong to the enrolment's own cohort period (composite foreign key) and be ACTIVE; **capacity is enforced by the database for every writer**: the membership INSERT guard takes the section row `FOR UPDATE` and counts OPEN memberships (`valid_to IS NULL`); closed memberships do not consume a seat. One OPEN membership per enrolment (partial unique index); closed intervals cannot overlap (guard under the enrolment row lock); a closed membership is terminal.
- **Program enrolment close** (`student_programs`): refused while the enrolment has live term enrolments (REGISTERED, ACTIVE, DETAINED, ON_LEAVE), in the service and in a trigger (`student_programs_live_term_enrollments_guard`). This also covers the student-status-change path (GRADUATED and DISCONTINUED close the active enrolment through the same function). **Current product behaviour: the block stands; nothing is withdrawn or completed automatically.** Error contract: HTTP 409 with the stable code `STUDENT_PROGRAM_HAS_LIVE_TERM_ENROLLMENTS` on `POST /api/v1/students/:id/programs/:pid/close` and `POST /api/v1/students/:id/status`; the whole request is rolled back (student, enrolment and audit unchanged). Withdraw or complete the term enrolments first. The owner has confirmed decision D-M3-1: no automatic cascade; graduation and discontinuation remain strictly blocked while live term enrolments exist.
- **Program duration** (`programs.duration_periods`): cannot be reduced below the highest `period_no` used by a curriculum entry or by a non-extension cohort period of the program (409 from `ProgramService.update`; trigger `programs_duration_guard` for every writer). Extension periods (`is_extension`) do not count. Curriculum and cohort-period inserts share-lock the program, so a racing insert and shrink cannot both succeed.

## 3a. Product rules and confirmed owner decisions

Nothing below was invented silently; "(A)" = not stated by the architecture documents. The owner has confirmed decisions 1–5 below:

| Rule | Where enforced | Status |
| --- | --- | --- |
| (A) Term ACTIVE only inside an ACTIVE year; no term added to a CLOSED year | service (create) + DB guard (activation) | implemented, unconfirmed |
| (A) Cohort period status `ACTIVE | CLOSED`, CLOSED terminal | DB guard | implemented, unconfirmed |
| (A) Elective basket code only on ELECTIVE entries | CHECK + service | implemented, unconfirmed |
| (A) At most one live enrolment per student per term | partial unique index | implemented; practically unreachable (one active program, one period per cohort and term) |
| (A) Enrolment status machine and its final states | service + DB guard (identical tables) | implemented, unconfirmed |
| (A) A final status closes the open section membership | DB trigger (all writers) | implemented, owner-confirmed |
| A year closes only when its terms are CLOSED or LOCKED | DB guard | not in the spec; unconfirmed |
| Section deactivation blocked with members; capacity not below roster; capacity enforced at placement | DB guards + service | implemented, owner-confirmed |
| An INACTIVE course cannot be added to new curriculum entries (existing entries stay) | service + DB guard | not in the spec; unconfirmed |
| A cohort period needs an ACTIVE cohort and a PLANNED/ACTIVE term on the program's campus | service + DB guard | follows `02` §4.5; the campus/status details are unconfirmed |
| Program close blocked by live term enrolments (no cascade; D-M3-1 resolved) | service + trigger | implemented, owner-confirmed |
| Program duration cannot drop below a period in use | service + trigger | implemented, owner-confirmed |
| Credits have at most one decimal; roll-number pattern; placement reason 5-100 characters | service / schema | implementation limits (`numeric(4,1)`, `varchar(30)`, `varchar(100)`) |
| Only students with status ADMITTED or ACTIVE can be enrolled | service | copied from program enrolment (Phase 3a) |

Not covered by any guard today: deactivating a campus, department or cohort that still has terms, courses or cohort periods under it remains unchanged for this batch (owner-confirmed; deferred as documented follow-up work).

## 4. Concurrency and integrity

Lock order is top-down everywhere (service and triggers): enrolment row -> section row for placement, student -> program -> cohort period -> term for enrolment, year (share) -> term for term changes, program (share, by the curriculum / cohort-period guards) for duration changes, and the per-tenant advisory lock only inside the academic-year guard. No path takes a lower lock and then a higher one, so no cycle exists; the six overlap tests (`academic-calendar.test.ts`, "M5") order two real transactions with `pg_stat_activity` lock waits and assert the single valid outcome. Originally stated order: campus → academic year → term → cohort/program → cohort period → section → term enrolment → membership. The migration guards take `FOR SHARE` on parents and `FOR UPDATE` on the enrolment row before judging a membership, so every race resolves to exactly one winner and one 409 (tests: overlapping years, duplicate enrolment, last seat in a section). Optimistic concurrency uses `version` with mandatory `If-Match` on every PATCH/DELETE (428 missing, 400 malformed or weak, 409 stale). Term-enrolment creation is idempotent (`Idempotency-Key`, same mechanism as program enrolment). Every mutation writes its audit event in the same transaction.

Row security: every table is `FORCE ROW LEVEL SECURITY` with tenant policies and RESTRICTIVE staff-only write policies; `term_enrollments` and `section_memberships` additionally carry the `student_self_only` RESTRICTIVE policy (a student sees only their own rows and can never write). Cross-tenant parents are impossible: all foreign keys are tenant-composite. Runtime grants are least-privilege (`UPDATE` on named columns only; `DELETE` only on `curriculum_courses`).

## 5. Deferred (not in Batch 1)

`elective_groups`, `course_offerings`, `course_registrations`, `faculty_assignments` (need `employee_postings`, Milestone 2), `timetable_slots`, `holidays`, `terms.attendance_edit_until`, the A2 override of LOCKED terms, promotion tooling, a `term_enrollments` history table (the audit event carries the old/new diff and reason; `section_memberships` is itself the placement history), per-tenant default `period_types`, list pagination (these lists are small and bounded per tenant; the signed-cursor capability of FU-EMP-1 is still unbuilt). **Attendance integration is not started** and face recognition is not introduced (ADR-016).

## 6. Rollout

Migration `0033` is an ordinary (non-contract) migration, but the runner defers every migration behind a deferred contract migration, so it follows `0019` like `0020`–`0032`. It adds only new tables, functions, triggers and one trigger on `student_programs` (`BEFORE UPDATE OF status`, fires only when an ACTIVE enrolment leaves ACTIVE). Lock times are unmeasured. Nothing has been applied to a persistent database; the existing gates in `docs/runbooks/students-contract-rollout.md` and `docs/runbooks/academic-structure-rollout.md` still apply.
