# 31 — Course offerings, faculty assignments and timetable slots (Milestone 3, Batch 2)

Status: **implemented and tested on disposable databases only; not applied to any persistent database.** Specification sources: `02` §4.5 (`course_offerings`), §4.6 (`faculty_assignments`), §4.7 (`timetable_slots`), §5.1/§5.3 (history, snapshots, faculty changes), `06` §3 (offering scope), `07` §3 (model), `04` Part 16 (Milestone 3). Migration: `database/migrations/0037_course_offerings_and_faculty_assignments.sql`. Batch 1 (calendar, sections, courses, curriculum, term enrolment) is doc 24.

Roadmap note. This is the next slice of **Milestone 3 — Academic Structure & Enrollment** as listed in `04` Part 16 and deferred by doc 24 §5. No milestone was renamed, reordered, split differently or marked complete; Milestone 3 is **not** complete (see §6).

## 1. What Batch 2 delivers

| Area | Table | API (`/api/v1/academics`) | Permission |
| --- | --- | --- | --- |
| Course offerings | `course_offerings` | `GET/POST /course-offerings`, `GET/PATCH /course-offerings/:id` | read `academic.program.read`; write `academic.offering.manage` |
| Faculty / teacher assignments | `faculty_assignments` (effective-dated) | `GET/POST /course-offerings/:id/faculty-assignments`, `PATCH /faculty-assignments/:id` (end); employee view and assign: `GET/POST /faculty/employees/:id/assignments` (Task 9, doc 35 §5) | read `academic.program.read`; write `academic.faculty.assign` |
| Weekly timetable | `timetable_slots` (effective-dated) | `GET/POST /course-offerings/:id/timetable-slots`, `PATCH /timetable-slots/:id` (end) | read `academic.program.read`; write `academic.offering.manage` |

New permissions (doc 10 rows 56-57, SENSITIVE, **(A)** held by the same roles as `academic.section.manage`: DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR; not HOD, FACULTY, STAFF or STUDENT). Existing tenants receive them only after `seedTenantRoles` is re-run (not performed, not authorised).

## 2. Scope (trusted server-side data only)

- An offering's **campus** is its term's campus; its **department** is the cohort period's programme department, otherwise the course's owning department. The migration guard **derives both on INSERT and overwrites whatever a writer supplies** (also the superuser); the API never accepts a campus, department or tenant field. **(A)** An organization-wide course (no owning department) offered without a cohort period is refused, so no offering is ever unscoped; the department must lie on the term's campus.
- Every read and write is judged against those two columns: not held ⇒ 403; held but out of scope, missing or another tenant's ⇒ the same 404. Lists are filtered by the caller's GRANTED departments (campus grants expand to the campus's departments), exactly like sections.
- Faculty assignments and slots inherit the scope of their offering.

## 3. Rules (service and database guard)

- **Offering**: needs a PLANNED/ACTIVE term, a live ACTIVE course, an ACTIVE cohort period and section when given; the cohort period must run in the offering's term and the section must belong to it (composite foreign keys). Unique per `(term, course, section, group_label)` (doc 02). Status `DRAFT → PUBLISHED | CANCELLED`, `PUBLISHED → CLOSED | CANCELLED`; CLOSED and CANCELLED are final and require a reason (audit tier 2). **Publication re-copies code, title, credits and `tracks_attendance` from the catalogue and freezes them** (doc 02 §5.1 principle 3); nothing can rewrite a snapshot afterwards. Identity columns are immutable (grants allow `UPDATE (status, capacity)` only; the guard refuses any other change, superuser included). No DELETE.
- **Faculty assignment** (A2: reason and risk tier 2 on create and end): roles `PRIMARY | CO_INSTRUCTOR | LAB_INSTRUCTOR | SUBSTITUTE` (API field `teachingRole`, DB column `role`). At most **one PRIMARY at a time per offering** (doc 02 EXCLUDE, implemented as a guard under the offering row lock). **(A)** The same employee cannot hold two overlapping assignments on one offering; dates lie inside the term; the offering is DRAFT or PUBLISHED; the employee is ACTIVE; and the employee has an **active primary posting on the offering's campus** (the same posting predicate as the authorization engine). A faculty change ends the open assignment (`validTo`) and opens a new one (doc 02 §5.3); an ended assignment is final.
- **Timetable slot**: ISO weekday, `start < end`, effective dates inside the term, the room on the offering's campus, and a referenced teacher must be an assignment **of the same offering** (composite foreign key) that is **valid on the slot's first day** (A). Ended with `effectiveTo`; an ended slot is final. Three conflict rules, all in the database guard (every writer, superuser included), each serialised by a transaction-level advisory lock:

  | Rule | Two slots clash when | Source |
  | --- | --- | --- |
  | Room | same room | doc 02 EXCLUDE |
  | Audience (section/cohort) | audiences overlap **and** at least one offering is whole-audience, **or** both are the same offering | (A) |
  | Teacher | both name assignments of the same employee, each counted only while its assignment is valid | (A) |

  Common to all three: same weekday, overlapping **half-open** times (09:00-10:00 and 10:00-11:00 never clash), overlapping dates, where an open slot (`effectiveTo` null) runs to its **offering's term end** (never to the end of time, so next term can reuse the room, section and teacher), and slots of a **CANCELLED** offering block nothing (A). Tenant is part of every lookup; room campus, term dates, section, cohort period and assignment employee are read from stored rows, never from the request.

  *Audience.* An offering's audience is its section, or every section of its cohort period when it has no section. **Whole-audience** = `CORE` with no group label. `ELECTIVE`, `OPEN_ELECTIVE`, `OPTIONAL`, `LAB_GROUP`, `PROJECT`, `INTERNSHIP` and any grouped offering reach only part of the audience (who takes which is decided by course registrations, not built), so two of them may run in parallel: lab groups G1/G2 of one section, parallel electives, a school's Hindi/French second-language options. A whole-section class clashes with any class of that section; a cohort-period-wide class clashes with every section of the period. **Limitations (no schema change made):** an offering without a cohort period (an open department offering) has no known audience and is checked only against itself; two partial offerings that in fact share students (once registrations exist) are not detected.

  *Teacher.* A slot identifies its teacher **only** through `facultyAssignmentId`. A slot that names no assignment has no teacher and is **not checked** (pinned by a test). The offering's PRIMARY is deliberately not inferred: an offering can have several current teachers (co-instructor, lab instructor, substitute), and inferring would make every new assignment re-check every slot of the offering. Whether naming the teacher should become mandatory is an owner decision (§4 item 3). A teacher is one person across campuses and departments, so the rule spans the whole tenant.
- **A LOCKED term** freezes offerings, assignments and slots under it.

## 3a. Lifecycle of dependent rows (history is never rewritten; nothing cascades)

| Event | Its assignments | Its slots | Effect on conflicts | Tested |
| --- | --- | --- | --- | --- |
| Faculty assignment **ended** (`validTo`, A2, audited) | - | stay open and keep naming it | the teacher is free from `validTo + 1`; the slot still holds its room and section | yes |
| Offering **CANCELLED** (reason, tier 2) | unchanged, still open | unchanged, still open | **ineffective**: holds no room, section or teacher; no new assignment or slot can be added | yes |
| Offering **CLOSED** (reason, tier 2) | unchanged | unchanged | **still blocks until the term ends** (current behaviour, owner decision §4 item 5) | yes |
| Term **LOCKED** | frozen | frozen | its dates are in the past; later terms are not blocked | yes (frozen) |
| Slot **ended** (`effectiveTo`) | - | - | frees room, section and teacher from the next day | yes |

Rationale: ending or cancelling is a recorded event with its own audit row; a cascade would silently rewrite other rows' dates without their own audit events and reasons, and doc 02 §5.1/§5.3 keep history by closing rows explicitly. Instead the conflict rules **derive** effectiveness from the parent's state, so a cancelled offering or an ended assignment stops blocking without any row changing. There is **no revoke/void** of a mistaken assignment or slot: the earliest end date is its own first day (`validTo >= validFrom`), so a mistake still occupies that one day.
- **Row security**: all three tables `FORCE ROW LEVEL SECURITY`, tenant policies, staff-only writes. `faculty_assignments` is **staff-only for reads too** (it names employees); students see offerings and slots.

## 4. Schools and universities

The same tables serve both; nothing in this batch assumes semesters or departments-as-grades.

| | University | School |
| --- | --- | --- |
| Programme | B.Tech CSE, `period_type` SEMESTER, 8 periods | "School curriculum", `period_type` GRADE (label), 12 periods |
| Cohort | admission year | admission year + `intake_code` per entry grade (cohorts are unique per programme, year and intake) |
| Cohort period | semester N in a term | **grade N in the academic session** (`period_no` = grade) |
| Section | A, B | 6-A, 6-B |
| Offering | course in a term, per section or lab group | subject for a class section |
| Assignment | PRIMARY / CO / LAB / SUBSTITUTE faculty | **subject teacher** = PRIMARY on the section's subject offering |
| Timetable | weekly lecture slots, labs | daily periods (Mon-Fri) in the class room |

Both are exercised end to end in `tests/integration/course-offerings.test.ts` (two campuses of one tenant).

**Owner decisions, not made in code (no schema added for them):**

1. **OD-5, grade levels.** Today a grade is `period_no` of a 12-year programme on a school campus/department. This works for the tested flows but has limits: an entry grade other than 1 needs one cohort per entry grade (`intake_code`); "Grade 6" has no row of its own to hang grade-wide settings on; a school with streams in grades 11-12 needs one programme per stream. A configurable `grade_levels` table (or labelling via settings) is a schema change and needs an owner decision first.
2. **Class teacher.** _Resolved by doc 32 (migration `0038`, `section_class_teachers`); kept here for history._ The architecture defines teaching assignments on offerings only. A section-level "class teacher" (homeroom) is **not** specified; it would be a new table or a section-level assignment kind. Not built.
3. **Teacher and section conflicts (implemented as (A), confirm or change).** The audience rule and its whole-audience definition (`CORE` without a group label), the teacher rule's reliance on `facultyAssignmentId` (options: keep optional; require it on every slot; or infer the PRIMARY and re-check slots on every new assignment), and the rule that a slot must start while its assignment is valid.
4. The **(A)** rules above: posting-on-campus requirement (visiting faculty without a posting cannot be assigned), ACTIVE-only employees, dates inside the term, the role holders of the two new permissions, the "organization-wide course needs a cohort period" rule.
5. **Lifecycle (§3a).** Options for each event: (a) **derive, no cascade** (implemented); (b) end dependent rows automatically in the same transaction, writing one audit event per row and reusing the parent's reason; (c) refuse the parent's end while dependent rows are open, forcing explicit audited ends first. Specific open points: whether a **CLOSED** offering should stop blocking like a CANCELLED one (today it blocks to term end; freeing it would also make its past dates bookable again), whether slots should drop or keep an ended teacher, and whether a void (delete-like correction) of a mistaken assignment or slot is wanted.
6. **Class teacher (homeroom)** — see §4a; needs a schema change.
7. **Repeating a grade / year-back** — see §4a; needs a Batch 1 rule change.

## 4a. School MVP compatibility (findings, no schema change made)

| Need | Existing model | Verdict |
| --- | --- | --- |
| Academic years and terms | `academic_years`, per-campus `terms` (an annual session, or trimesters) | supported |
| Grades | `period_no` of a programme with period type "Grade" (OD-5) | supported with the OD-5 limits above |
| Classes and sections | cohort period (grade N in the session) + `sections` (6-A, 6-B) | supported |
| Subject teacher | PRIMARY assignment on the section's subject offering; teacher conflicts as §3 | supported (tested: one teacher cannot take 6-A and 6-B in the same period) |
| Class teacher (homeroom) | **none.** Not in the architecture. Faking it as a "homeroom" CORE offering would pollute courses, credits and the section's audience rule, so it is not recommended. | **closed by doc 32** (was: gap, needs a schema change, e.g. effective-dated `section_class_teachers`, one current per section, employee posted on the section's campus, A2 audit). Likely needed by Milestone 4 if school attendance is taken daily by the class teacher rather than per period; owner decision first. |
| Moving between sections of a grade | `section_memberships`, effective-dated (doc 24) | supported |
| Promotion to the next grade | a new term enrolment in the cohort's next period; the previous one is marked `PROMOTED` (manual; the promotion tool is not built) | supported manually |
| Repeating a grade | doc 02 §5.3 says a repeater gets a REPEAT term enrolment "against a later cohort-period", but `0033` requires the cohort period to belong to the student's **own** cohort and allows one period number per cohort, so joining the junior batch's Grade 6 is refused; the only path is closing the programme enrolment and opening one in the junior cohort | **closed by doc 32** (the Batch 1 rule now admits a REPEAT with a later cohort of the same programme; was: gap, also affecting university year-backs) |

## 5. Concurrency

Lock order (service and triggers): term (share) → course / cohort period / section (share) → offering → employee (share) → assignment / slot. Assignments lock the offering row `FOR UPDATE`; slots share-lock the offering, then take transaction-level advisory locks in a **fixed order**: room (`'app.timetable_room:' || room_id`), audience (`'app.timetable_audience:' || coalesce(cohort_period_id, offering_id)`, so every audience inside one cohort period is serialised together), teacher (`'app.timetable_teacher:' || employee_id`), each hashed with `hashtextextended(…, 0)`. Under READ COMMITTED the second writer waits and then sees the first one's committed row. The API inserts one slot per transaction; a raw writer inserting several slots per transaction in different orders can deadlock (40P01, one aborted) but never double-book. Only inserts are checked: every allowed update (ending a slot or assignment, cancelling or closing an offering) shrinks or removes a booking and cannot create a clash. Tests race two PRIMARY assignments, two bookings of one room, one teacher, one section, and one teacher across offerings with no shared audience; each asserts exactly one 201 and one 409. Mutation checks (2026-10-30): removing each rule and each of the audience and teacher locks makes at least one test fail.

## 6. Not in this batch (Milestone 3 remains open)

`elective_groups` and `course_registrations` (since delivered by Batch 3, doc 33: `course_offerings.elective_group_id`, and `AUTO_FROM_SECTION` registrations through an explicit from-section action), `attendance_policy_id` (attendance policies are Milestone 4), `holidays` (listed in doc 07 but **no column specification exists** in docs 02/07/08), `terms.attendance_edit_until`, the A2 override of LOCKED terms, the promotion tool, the setup checklist, the student timeline, the ASSIGNED resolver for faculty (X-12) that will read `faculty_assignments`, and the **write UI** (create/publish/cancel offerings, the assignment screen, slot booking; Part 16 "assignment screen"). Delivered UI: a **read-only** Offerings tab on `/academics` (term picker, offerings grid, weekly timetable of one offering; teachers shown to staff only; room codes only when the caller holds `org.structure.read`; teachers are shown by employee-id suffix because no employee-name read model exists for this screen). Tests: `apps/web/tests/academics-page.test.tsx` (fake backend only). Attendance is not started; face recognition is not introduced (ADR-016).

## 7. Rollout

`0037` is an ordinary (non-contract) migration: it creates three new empty tables, their guards and triggers, policies and grants, and inserts two permission rows. It alters no existing table. Like `0020`-`0036` it is deferred by the runner until the contract migrations `0009` and `0019` are applied in order. Lock times are unmeasured (new tables only; the foreign keys take `SHARE ROW EXCLUSIVE` on the referenced tables for the duration of the `CREATE TABLE`). Read-only preflight and post-checks: `docs/runbooks/m3b2-offerings-rollout.md`. Nothing has been applied to a persistent database.
