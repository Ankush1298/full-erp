# 32 — Class teachers, promotion and grade repetition (Milestone 3, school gap closure)

Status: **implemented and tested on disposable databases only; not applied to any persistent database.** Migration: `database/migrations/0038_class_teachers_and_progression.sql`. Closes the two school gaps recorded in doc 31 §4 item 2 and §4a (class teacher; repeating a grade). Specification sources: `02` §5.3 and `07` §3.1 (enrolment history, repeat/detention), `02` §4.6 (`term_enrollments`), doc 24 (Batch 1 rules), doc 31 (offerings, assignments, timetable).

Roadmap note. This is still **Milestone 3 — Academic Structure & Enrollment** (`04` Part 16). No milestone was renamed, reordered or marked complete. Milestone 3 remains open (§8). Milestone 4 (attendance) is **not** started; §6 only lists what it will need.

## 1. What this delivers

| Area | Data | API | Permission |
| --- | --- | --- | --- |
| Class teacher of a section | `section_class_teachers` (new, effective-dated) | `GET/POST /api/v1/academics/sections/:id/class-teachers`, `PATCH /api/v1/academics/class-teachers/:id` (end) | read `academic.program.read` (rows staff-only); write `academic.faculty.assign` |
| Promotion / repetition | `term_enrollments` (guard replaced) | `POST /api/v1/students/:id/term-enrollments/:eid/progression` | `enrollment.term.manage` |

No new permission: existing tenants need no re-seed beyond the one `0037` already needs. UI: Sections tab "Class teachers of …" panel (list with history; assign / end for holders of `academic.faculty.assign`); Enrolment tab "Promote or repeat" form (holders of `enrollment.term.manage`).

## 2. Class teacher (homeroom) model

A class teacher is **responsible for a section**. It is not a teaching assignment: it creates no `faculty_assignments` row, is never a timetable teacher, and the timetable conflict rules of `0037` neither read nor infer it (tested: a section's class teacher teaches another section at a time when the class has a lesson with no named teacher; the `0037` teacher rule still refuses that teacher's own double booking).

Row: `section_id`, `employee_id`, `role` (API field `classTeacherRole`, as `teachingRole` for faculty assignments; `PRIMARY` = class teacher, `ASSISTANT` = assistant/co-class teacher), `valid_from`, `valid_to`, `version`. Rules (database guard, every writer including the superuser, plus the service):

1. The section and its cohort period are ACTIVE; the term is not LOCKED; dates lie inside the section's term (a section belongs to one cohort period, so one term).
2. The employee is ACTIVE and holds an **active primary posting on the section's campus** (the `ACTIVE_PRIMARY_POSTING` predicate of `engine.ts`: primary, open, started by the campus-local date). Wrong-campus, unposted, ended-posting and future-posting employees are refused; so are ON_LEAVE and SEPARATED employees. Checked when the row is created, as for faculty assignments. **Superseded by migration `0039` (doc 33 §9):** the employee's PRIMARY postings on the section's campus must cover *every day* of the assignment (`valid_from` to `valid_to`, an open row to the term end); consecutive postings inside the campus may share the coverage, a gap of one day or a posting on another campus refuses.
3. **At most one PRIMARY per section at a time** (overlap check under the section row lock, plus a partial unique index for open rows).
4. The same employee holds at most one row per section at a time.
5. **(A) One class per class teacher: an employee is the PRIMARY class teacher of at most one section at a time, tenant-wide.** Rationale: a class teacher takes the section's daily roll call and is its single point of contact, normally at the same time of day as every other class teacher; two homerooms cannot be served at once. ASSISTANT rows are not limited (cover across sections is normal). Enforced under a per-employee advisory lock. An open row counts only until its term ends, so last session's assignment never blocks this session.
6. History: no DELETE grant; only `valid_to` is updatable, once (NULL → a date ≤ term end, ≥ `valid_from`); identity columns are immutable even for the superuser. Reassignment = end the current row (`valid_to = d − 1`), then create the successor from `d`. Every create and end needs a reason (5–500 characters) and writes an audit event at risk tier 2 (`academic.class_teacher.create` / `.end`). Ending never deletes or rewrites anything, so later attendance attributed to the earlier class teacher keeps its responsible person.
7. Scope: the section's cohort period's programme department and campus, read from the database. Not held ⇒ 403; out of scope, missing or another tenant's ⇒ the same 404. Rows are **staff-only at the database** (RESTRICTIVE policy for all commands, as `faculty_assignments`); a student reads an empty list.

Lock order: section (`FOR UPDATE`, the lock placements and section PATCHes already take) → employee (share) → advisory `'app.class_teacher:' || employee_id`. No existing path locks an employee and then a section.

## 3. Promotion and repetition

### 3.1 Reconciliation of doc 02 with Batch 1

Doc 02 §5.3 and doc 07 §3.1: "promotion creates the next `term_enrollment` and marks the previous `PROMOTED`"; "Repeater/backlog: new `term_enrollment` with `enrollment_type = REPEAT` against a **later cohort-period**", "history preserved; no student duplication". Batch 1 (`0033` guard `term_enrollments_same_cohort_ck`, doc 24 §3) required the cohort period to belong to the student's **own** cohort; since a cohort has one row per `period_no`, a student could never repeat with the junior batch without closing the programme enrolment and opening another (a different history, and a second programme enrolment for one programme).

**Batch 1 rule as changed by `0038`:** a term enrolment's cohort period must belong to

- the cohort of the student's programme enrolment (unchanged), **or**
- another cohort **of the same programme**, when either
  - the enrolment is a `REPEAT` of a `period_no` that the same programme enrolment already held in a term that **ended before** the new term starts, or
  - the same programme enrolment already has a `REPEAT` enrolment in that cohort (the student joined it; later promotions continue with it).

Another programme is always refused (`term_enrollments_same_program_ck`). The programme enrolment (`student_programs`) is never changed: its `cohort_id` stays the admission cohort, its frozen campus/department stay the scope, so the B6 profile and directory scope does not move (tested). A plain `POST …/term-enrollments` keeps Batch 1's behaviour except for the "joined cohort" case; joining another cohort in the first place is only possible through the progression decision.

Status machine change: **(A) `DETAINED → COMPLETED`** is added (service and guard), so a detained student's enrolment can end when they repeat. Final statuses are unchanged (`WITHDRAWN`, `PROMOTED`, `COMPLETED`); entering one still closes the open section membership (`0033` trigger).

### 3.2 The progression decision (atomic)

`POST /students/:id/term-enrollments/:eid/progression` with `Idempotency-Key`, body `{ decision: PROMOTE | REPEAT, cohortPeriodId, rollNumber?, reason }`:

| Decision | Source enrolment | Target cohort period | Source ends | New enrolment |
| --- | --- | --- | --- | --- |
| `PROMOTE` | ACTIVE | same cohort as the source's cohort period, `period_no + 1` | `PROMOTED` | `REGULAR` |
| `REPEAT` | ACTIVE or DETAINED | same programme, same `period_no`, a later cohort | `COMPLETED` | `REPEAT` |

Both: the target term starts **after** the source term ends (a cohort period in the same or an overlapping term is refused); the target cohort period is ACTIVE and its term PLANNED/ACTIVE; the source term is not LOCKED; the source's programme enrolment is still ACTIVE; the student is ADMITTED/ACTIVE. Both rows change in one transaction with two audit events at tier 2 carrying the same reason (`enrollment.term.update` on the source, `enrollment.term.progress` on the new row with `fromEnrollmentId` and `decision`). Nothing is deleted or rewritten. Scope: the source's programme scope (404 when out of scope or not the path's student) and the **target's** department/campus (404, never a hint that it exists); then 409 for rule violations.

Duplicates and races: one enrolment per (student, cohort period) and one live enrolment per (student, term) remain unique indexes; the decision locks the student row first, so two simultaneous decisions on one enrolment yield exactly one 201 and one 409 (tested), and an idempotent replay returns the first result.

### 3.3 School and university

The model has no grade or semester concept of its own: `period_no` is labelled by the programme's period type (Grade, Semester, Year). School: Grade 6 → Grade 7 of the same G1 intake (promotion), or Grade 6 again with the next year's intake (repeat). University: semester 1 detained → semester 1 with the next batch (year-back), then semester 2 with that batch. Both are exercised in `tests/integration/class-teachers-and-progression.test.ts`. The web forms say "Period N" (neutral); a period-type-aware label ("Grade 6", "Semester 3") needs the programme's period type on the cohort-period read and is not built (§7 item 9).

## 4. Interaction with the timetable (`0037`)

- Subject teachers remain `faculty_assignments`; slots name a teacher only through `faculty_assignment_id`.
- A class teacher is never inferred as a slot's teacher and is never added to the teacher conflict rule; the room, audience (section) and teacher protections of `0037` are unchanged (re-run in full, plus one direct regression in the new test).
- No RLS or authorization was weakened: the new table is FORCE RLS and staff-only; `term_enrollments` policies and grants are unchanged (only the guard function body was replaced).

## 5. Concurrency and integrity

Class teachers: see §2. Progression: student (no key update) → programme enrolment (share) → source enrolment (no key update) → target cohort period (share, then the `0033`/`0038` guard share-locks programme enrolment, cohort period and term again, already held). Correct under READ COMMITTED. Mutation checks (2026-10-31): restoring the strict own-cohort rule, removing the one-class-per-teacher rule, the posting check, the per-section PRIMARY overlap check, the `DETAINED → COMPLETED` transition, or the target scope check each make at least one test fail.

## 6. What Milestone 4 (attendance) will need — not built

1. **Roster as of a date**: `GET /academics/sections/:id/members` returns open memberships only; attendance needs "members of section S on date D" (memberships with `valid_from ≤ D ≤ coalesce(valid_to, ∞)` and a live enrolment).
2. **Who may take attendance for section S on date D** (the X-12 ASSIGNED resolver): per-period attendance ⇒ the `faculty_assignments` of S's offerings valid on D (and, for a session, the slot's named assignment); daily/homeroom attendance ⇒ `section_class_teachers` rows of S valid on D (PRIMARY, or ASSISTANT as cover). The resolver must also require the employee to be ACTIVE on D (§7 item 3).
3. **Sessions**: `class_sessions` (doc 02, `conducted_by`) generated from slots of PUBLISHED, `tracks_attendance` offerings, or from the section for daily attendance; holidays (no column specification exists) and `terms.attendance_edit_until`.
4. **Audience of partial offerings**: `course_registrations` (electives, lab groups) to know who attends a non-whole-section class.
5. Faculty read access to their sections' rosters (today FACULTY holds no `enrollment.term.read`; it becomes ASSIGNED in M4).
6. A read model with employee names for teachers and class teachers (screens show id suffixes).

## 7. Owner decisions (implemented as (A) unless stated; confirm or change)

1. One PRIMARY class per employee at a time (§2 rule 5); ASSISTANT unlimited. A university "class advisor" for several sections would need this relaxed.
2. Class-teacher writes reuse `academic.faculty.assign` (same holders as section and offering management). A dedicated permission would need a migration row and a re-seed.
3. No cascade: an employee going ON_LEAVE or SEPARATED keeps their open class-teacher rows (as faculty assignments, doc 31 §3a); separation closes postings, not these. Option: close them in the separation flow.
4. Deactivating a section with an open class teacher is not blocked.
5. ~~The posting is checked when the row is created, not over the whole validity window.~~ Since `0039`: checked over the whole validity window at creation (doc 33 §9). Still no cascade when a posting later ends (item 3).
6. `DETAINED → COMPLETED` (§3.1); `COMPLETED` therefore also means "period ended without promotion".
7. A repeat keeps the same `period_no` (no repeating an earlier period) and the target term must start after the source term ends.
8. ~~No bulk promotion tool.~~ Delivered in Batch 3 (doc 33 §5): `POST /academics/cohort-periods/:id/promotion`, PROMOTE only; repeats stay per enrolment.
9. Period-type-aware labels in the UI (§3.3).
10. Still open from doc 31: OD-5 grade levels, the (A) audience/teacher rules, CLOSED offerings blocking until term end, no void of mistaken rows.

## 8. Rollout

`0038` is an ordinary (non-contract) migration, deferred by the runner like `0020`–`0037` until the contract migrations `0009` and `0019` are applied in order; it follows `0037`. It creates one empty table with its guard, triggers, policies and grants, and **replaces the body of `app.term_enrollments_guard()`** (`CREATE OR REPLACE`, same name and signature; the existing triggers keep calling it). The new rule only admits more rows than before and the new transition only adds an option, so **existing rows need no backfill and cannot become invalid**. Locks: the foreign keys take `SHARE ROW EXCLUSIVE` on `app.sections`, `app.employees` and `app.organizations` for the `CREATE TABLE`; replacing the function takes no table lock. Lock time is unmeasured. Read-only preflight and post-checks: `docs/runbooks/m3-class-teachers-progression-rollout.md`. Nothing has been applied to a persistent database.
