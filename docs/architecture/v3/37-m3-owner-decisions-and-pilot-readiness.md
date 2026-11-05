# 37 — M3 owner decisions and school pilot readiness pack

Status: documentation, decision recording and validation planning only, 2026-11-05.

- No application feature, schema, migration, test or behaviour change.
- No Git write. No persistent database. Milestone 4 not started.
- **M3 is not accepted.** No decision below is approved. No school data has been supplied, and no reviewer has signed anything.

Inputs:
- `docs/architecture/v3/36-m3-residual-gap-assessment.md` (doc 36).
- `04` Part 14 and Part 16.
- Docs 24 and 31–35.
- The migrations `0008`–`0039` for field rules.

## 0. How to use this pack

| Part | Who uses it | When |
| --- | --- | --- |
| §2 Owner decision register | product owner | before the rehearsal; every row needs a recorded decision |
| §3 Pilot data submission template | the school | to supply one complete term of real data |
| §4 Pre-load findings | product owner | before the school starts filling in §3 |
| §5 Pilot validation checklist | rehearsal operator and school reviewer | after loading the data |
| §6 Formal browser acceptance script | rehearsal operator, watched by the reviewer | during the rehearsal |
| §7 Reviewer sign-off sheet | school reviewer, acceptance authority, product owner | at the end of the rehearsal |
| §8 M3 evidence register | product owner | kept current throughout |

Every pass/fail, approval, date and signature field in this document is **blank on purpose**.

## 1. Repository state and stale continuity

**Recorded before editing (2026-11-05):**
- Branch `main`, HEAD `bd05759704bda5fca37f1d4bf3358cf1e7840cb7`.
- `git status --short`: 118 entries. 0 staged, 60 unstaged (modified tracked files), 58 untracked. No stash.
- **The working tree holds every uncommitted change of Tasks 1–9:**
  - the B6 profile-scope fix;
  - migrations `0037`, `0038`, `0039`;
  - backend modules for offerings, class teachers, registrations, holidays, setup, the setup wizard, term readiness, the timeline and `/faculty` assignments;
  - web pages and tests;
  - docs 30–36 and the M3 runbooks;
  - the five local continuity/tooling items.
- **The only change since the doc 36 task** is that task's `PROJECT_LOG.md` entry. `PROJECT_CONTEXT.md` and `TASK_PROMPT.md` are byte-identical to the versions doc 36 recorded.

**Stale continuity instructions (recorded, not rewritten; both files are protected):**
1. `PROJECT_CONTEXT.md` §3, §4 item 12 and §6, and all of `TASK_PROMPT.md`, describe Milestone 2 Batch 2 at `99f7e80` with migrations up to `0036`. The actual state is HEAD `bd05759`, migrations up to `0039`, and M2 B2–B6 plus M3 Batches 1–3 and Tasks 1–9 uncommitted.
2. `PROJECT_CONTEXT.md` §1 calls the product "for higher education institutions". The owner direction is one platform for schools, colleges and universities.
3. `TASK_PROMPT.md` "Next steps" item 4 forbids starting M3 Batch 2. That has since been done on instruction.
4. `PROJECT_CONTEXT.md` §7 item 3 asks every task to update `PROJECT_CONTEXT.md` and `TASK_PROMPT.md`. Owner instructions since 2026-11-02 treat both as protected.

## 2. Owner decision register

Each decision has the same layout. The **Owner decision**, **Date** and **Decision authority** fields are blank and must be filled in by the owner. "Blocks M3" means blocks the formal acceptance of `04` Part 16 Milestone 3.

### OD-1 — Database-level term activation enforcement

**Question.** Should the activation readiness rules (ACTIVE campus, ACTIVE academic year, an active cohort period, at least one PUBLISHED offering, every published offering staffed to the term end) also be enforced inside PostgreSQL? Or is enforcement in `TermService.update` enough for M3?

**Canonical requirement.**
- `04` Part 16 M3: Features "terms (free codes, state machine)"; Tests "term lock".
- Part 16 does **not** mention activation readiness. The rules were introduced by Task 8 (doc 35 §3) and enforced on every service path by Task 9.

**Evidence (doc 36 §5, doc 35 §3 and §7 item 2a).**
- **`app_runtime` (the application role):**
  - Column-level `UPDATE (name, start_date, end_date, status, locked_at, locked_by)` on `app.terms`, under forced RLS (tenant, plus a RESTRICTIVE STAFF-only policy).
  - `NOSUPERUSER NOBYPASSRLS`, no ownership, no DDL.
  - Reached only through `db.withTenant`.
- **The only writer:** `calendar.service.ts` is the only `UPDATE app.terms` in `backend/src`. This is pinned by `term-activation.test.ts`. The pin scans only `backend/src` for that literal text.
- **What the database already enforces for every writer** (`app.terms_guard`, `0033`): forward-only transitions, ACTIVE only inside an ACTIVE academic year, dates frozen after PLANNED, identity columns immutable, LOCKED rows frozen.

**Privileged-role threat model.**

| Actor | Can activate an unready term? | Realistic? | Current mitigation |
| --- | --- | --- | --- |
| Any HTTP caller, any role | No: every route goes through `TermService.update` (PATCH and POST proven identical) | — | service rule, tests, E2E at 8 sites |
| Code inside the application process issuing raw SQL as `app_runtime` with a STAFF context | Yes | Only after an application compromise or a future code regression; a compromise already allows far more damaging writes | single-writer pin; code review |
| `app_migrator` (table owner) | Only by disabling RLS or writing in a migration (FORCE RLS applies to the owner and no policy targets it) | Operator or migration author mistake | migration review; runbooks |
| Superuser (bootstrap, dev `campusos_admin`, test harness, production DBA) | Yes. RLS is bypassed; triggers would still fire unless `session_replication_role = replica` | Operator action | operational control only |

**Impact of an unready ACTIVE term.** A running term without published or staffed offerings. It is recoverable: offerings can still be published and staffed while the term is ACTIVE. No data loss, privilege gain or tenant breach.

**Migration and locking implications of a database trigger** (doc 36 §5.3–§5.4):
- It needs migration `0040`:
  - `CREATE OR REPLACE` of `app.terms_guard`.
  - One shared SQL readiness function called by both the trigger and `term-readiness.ts`, so the rules are not written twice.
- **It must not lock child rows.** Offering publish already locks the offering and then the term `FOR SHARE`. An activation trigger that locked offerings while holding the term would invert that order, and the two would deadlock (`40P01`).
- A non-locking trigger keeps the same benign race the service has: an assignment ending just after the readiness read (doc 35 §3).
- It would break the superuser test fixture `activateTermFixture`, which is used by `academic-calendar`, `academic-calendar-routes`, `student-timeline` and `college-regression`.
- It also means updating the six migration-list pins, the schema linter, roles-and-privileges and the authorization-rls guard list.
- Rollout: forward-only. Deferred behind contract migrations `0009` and `0019` like every migration after them. Existing ACTIVE terms are not re-checked. Lock time unmeasured. Rollback is a further forward migration.

**Recommended default.** Keep service-level enforcement for M3, and record it as a documented limitation. Defer any database trigger to the M7 hardening pass. Add a read-only "ACTIVE terms that are not ready" detection query to the M3 rollout runbook when runbook changes are next authorised.

**Alternatives and consequences.**

| Option | Consequence |
| --- | --- |
| A. Service only (default) | No change. Raw and privileged writers are not stopped, as with other service-only rules (`PROJECT_CONTEXT.md` §5 item 14) |
| B. Non-locking trigger plus shared SQL function, in M3 | Stops raw `app_runtime`, migration and superuser writes (unless replica mode). Costs one migration, a fixture rework and pin updates. Same race window as A |
| C. Revoke `UPDATE (status)` and activate only through a SECURITY DEFINER function | Changes the least-privilege model and needs careful RLS and `search_path` design. Still does not stop the owner or a superuser |
| D. Detection query only | Detects rather than prevents. Fits the existing runbook pattern; combine with A |

**Blocks M3.** No.

| Owner decision | Date | Decision authority |
| --- | --- | --- |
| | | |

### OD-2 — Elective registration

**Question.** For the M3 school pilot, is elective registration **staff-managed** (a staff member records each student's choice)? Or must students or parents choose for themselves?

**Canonical requirement.**
- `04` Part 16 M3: Features "elective groups with registration windows", "course registrations (… elective choice …)"; UI "elective registration"; Tests "elective min/max/window validation".
- Part 16 does not say **who** registers.

**Evidence.**
- Doc 33 §3 and §11: the staff Electives tab, plus the `ELECTIVE_CHOICE` source.
- Doc 35 §5 records "staff-managed for the school pilot" as an **assistant** decision, explicitly open to the owner.
- Doc 36 §4.4 U5: PASS for the staff workflow (browser: a choice recorded, a second choice refused at the maximum).
- Doc 33 §11: no student self-service screen, because no endpoint resolves a student's own record.

**Recommended default.** Staff-managed registration for M3. Keep student and parent self-service as a future compatible capability:
- The `course_registrations` model, the `ELECTIVE_CHOICE` source, windows, min/max, capacity and the database guard already apply to every writer.
- A later self-service screen needs a "my record" endpoint and a UI, not a new registration model.
- Nothing built for M3 may assume that staff are the only writers.

**Alternatives and consequences.**

| Option | Consequence |
| --- | --- |
| Staff-managed (default) | No change. The school collects choices outside the product, and staff record them inside the window |
| Student self-service in M3 | New endpoint resolving the student's own enrolment, a student UI, a student-self write policy on `course_registrations` (today STUDENT reads only), tests. Reopens U5 |
| Parent self-service in M3 | Also needs guardian authorization rules for academic writes, which are not specified (doc 26 and `guardian.academic_visibility`) |

**Blocks M3.** No, if the default is approved. Yes, if self-service is ruled part of M3.

| Owner decision | Date | Decision authority |
| --- | --- | --- |
| | | |

### OD-3 — Term-lock UI

**Question.** Must the M3 term board offer a user-facing "lock term" action, or is the existing lock API enough for M3?

**Canonical requirement, checked verbatim in `04`:**
- **Part 16 M3:**
  - Features "terms (free codes, state machine)".
  - UI "setup wizard, **term board**, section allocation, offerings grid, elective registration, assignment screen, student timeline, timetable viewer".
  - Tests "**term lock**".
- **Part 14 `/academics` row (line 24):** common operations "create term, publish offerings, generate registrations, **lock term**, timetable CRUD". This is an API operation list, the same kind of list that names `/faculty` "workload view".
- **Conclusion:** Part 16 requires term-lock *behaviour* (tested) and a *term board*. It does **not** explicitly require a user-facing lock control. The Part 14 "lock term" operation is met by the API (`PATCH /academics/terms/:id {status:'LOCKED', reason}`, lock stamp, audit `academic.term.lock`).

**Evidence.**
- Doc 36 §4.4 U2: PARTIAL. The term board lists real terms and refuses an unready activation in the browser. A successful UI activation was not browser-driven, and there is no lock button (`AcademicsPage.tsx` only reads `LOCKED` to disable forms).
- Doc 36 X3 term lock: PASS (`academic-calendar`, `course-offerings`, `m3b3`).

**Recommended default.** Defer the lock button: the canonical text does not explicitly require a user-facing lock, and the API exists and is tested. Record "no lock action in the term board UI" as a documented limitation. For the pilot, an administrator locks a term through the API. **Still required for U2:** the rehearsal must browser-drive a successful activation (§6 BA-03).

**Alternatives and consequences.**

| Option | Consequence |
| --- | --- |
| Defer (default) | U2 can pass on list, activation and close once BA-03 passes; locking stays an API action |
| Build the lock action in M3 | A small UI change (reason field, confirmation, If-Match). Adds a browser check. A LOCKED term is irreversible (`0033`), so the UI needs a strong confirmation |

**Blocks M3.** No, if deferred.

| Owner decision | Date | Decision authority |
| --- | --- | --- |
| | | |

### OD-4 — Faculty workload

**Question.** Is a quantitative faculty workload figure part of M3? If so, which metric, and under which counting rules?

**Canonical requirement.**
- `04` line 22 (Part 14): `/faculty` common operations include "workload view".
- Part 16 M3: APIs "`/faculty` (assignments)"; UI "assignment screen".
- Part 16 Done criteria name no workload, and no v3 document defines a workload metric.
- The superseded v1 specification shows "Faculty Workload [View Timetable]", which is a timetable view, not a number.

**Evidence (doc 36 §6, doc 35 §5).**
- **Exists:** `GET /api/v1/faculty/employees/:id/assignments[?termId=]` (assignments with offering and term), plus each offering's weekly timetable.
- **Missing:** any figure.
- **Data limits:**
  1. A timetable slot names its teacher only through the optional `faculty_assignment_id`. Unnamed slots are attributable to nobody.
  2. There is no bell schedule or period-length entity.
  3. Two slots of one offering can never overlap, so one co-taught slot cannot carry two teachers.
  4. A slot's teacher cannot be re-pointed, so a substitute needs separate slots. Actual substitution is M4 data (`class_sessions.conducted_by`).
  5. Load changes inside a term, so any figure needs an as-of date.
  6. Holidays reduce delivered, not scheduled, load.
  7. CLOSED offerings keep blocking until the term ends (OD-6 item 31-12).

**Two distinct metrics (no formula is adopted here):**
- **Periods per week:** a count of timetable periods. It needs a definition of "a period" (bell schedule, or a minutes-per-period rule), which the schema does not hold. A double period stored as one 80-minute slot is one slot but two periods.
- **Contact hours per week:** the sum of scheduled slot durations. It can be derived by aggregation, but only for slots that name a teacher, and only once the counting rules (unnamed slots, co-instructors, substitutes, CLOSED offerings, as-of date) are decided.
- The two are not interchangeable, and neither is "delivered load", which needs M4 sessions.

**Recommended default.** The assignment view (A3) plus the timetable view are enough for M3. Defer quantitative workload. Record "workload view = assignment and timetable view; no quantitative load" as a documented limitation.

**Alternatives and consequences.**

| Option | Consequence |
| --- | --- |
| Defer (default) | No change. A4 stays PARTIAL as a documented limitation |
| Scheduled contact hours per week, as of a date, named slots only, with unnamed slots reported separately | Aggregation endpoint, tests and UI. Needs written rules for every point in the evidence above |
| Periods per week | The above plus a bell-schedule data model (a new schema with its own design document) and the school's bell times |
| Delivered load | Only after M4 class sessions exist |

**Blocks M3.** No, if deferred. Yes, if a figure is ruled part of M3.

| Owner decision | Date | Decision authority |
| --- | --- | --- |
| | | |

### OD-5 — Production Nginx

**Question.** Must production Nginx routing be verified to accept M3, or before production deployment?

**Canonical requirement.**
- `04` Part 16 M3 names no proxy, deployment or Nginx criterion.
- Deployment belongs to M7: "Docker prod compose (internal-only ports)", "pilot go-live", "e2e critical paths".

**Evidence.**
- Doc 36 §4.8: NOT VERIFIED. There is no Nginx binary and no Docker on the assessment machine.
- The routing contract is modelled in `docs/deployment/frontend.md`:
  - `/api/v1/*` forwarded unchanged;
  - `/api/auth/*` and `/api/me/mfa*` forwarded with `/api` stripped.
- `backend/tests/unit/web-api-contract.test.ts` checks the contract. The repository's Vite proxy path was verified end to end (API 85/85, browser 48/48).
- History: the 2026-11-02 review found that every web data call returned 404 through the previous proxy rule. It was fixed and verified only through Vite, so the Nginx example has never run.

**Recommended default.** Verify before any production deployment, and do not treat it as an M3 functional blocker. **Exception:** if the school walkthrough (D2) runs on a host served through Nginx, the routing contract must be verified on that host before the walkthrough starts (§5 V-13).

**Alternatives and consequences.**

| Option | Consequence |
| --- | --- |
| Verify before production (default) | M3 can be accepted on the Vite-proxied rehearsal environment; M7 owns the production check |
| Verify inside M3 | Needs a host with Nginx (staging); adds one rehearsal step; no code change expected |

**Blocks M3.** No (default), except under the exception above.

| Owner decision | Date | Decision authority |
| --- | --- | --- |
| | | |

### OD-6 — Earlier owner decisions from docs 31–34

Every decision docs 31–34 record as open, or as implemented "(A)" awaiting confirmation, is listed below. **None is resolved here.**
- Items those documents themselves mark as resolved are listed for completeness with their resolving reference, and are not reopened.
- "Implemented" is the current behaviour. "Recommended" is a suggestion only.
- "Pilot impact" says whether the real school data will exercise the decision, so it should be decided before G1.

**Doc 31 (offerings, assignments, timetable), §2, §3, §3a, §4:**

| ID | Question | Implemented | Recommended | Pilot impact | Blocks M3 |
| --- | --- | --- | --- | --- | --- |
| 31-1 | OD-5 grade levels: keep a grade as `period_no` of a programme, or add a `grade_levels` table or labelling? | `period_no`; one cohort per entry grade (`intake_code`); one programme per Grade 11–12 stream | keep for M3; revisit after the pilot | high (streams, entry intakes) | no |
| 31-2 | Whole-audience definition: `CORE` without a group label clashes with every class of its section | implemented (A) | confirm | high (timetable) | no |
| 31-3 | Teacher on a slot: keep `facultyAssignmentId` optional, require it, or infer the PRIMARY? | optional; unnamed slots are not teacher-checked | confirm optional in the product; the pilot load procedure names a teacher on every slot (§3.7) | high (teacher clashes, OD-4) | no |
| 31-4 | A slot must start while its assignment is valid | implemented (A) | confirm | medium | no |
| 31-5 | CANCELLED offerings block nothing | implemented (A) | confirm | low | no |
| 31-6 | Assignment needs an active primary posting on the offering's campus (visiting faculty without a posting cannot be assigned) | implemented (A) | confirm; the school supplies postings (§3.6) | high | no |
| 31-7 | Only ACTIVE employees can be assigned | implemented (A) | confirm | medium | no |
| 31-8 | Assignment dates lie inside the term | implemented (A) | confirm | low | no |
| 31-9 | One employee cannot hold two overlapping assignments on one offering | implemented (A) | confirm | low | no |
| 31-10 | Holders of `academic.offering.manage` and `academic.faculty.assign`: DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (not HOD, FACULTY, STAFF, STUDENT) | implemented (A) | confirm | medium (who loads data) | no |
| 31-11 | An organisation-wide course offered without a cohort period is refused | implemented (A) | confirm | low | no |
| 31-12 | Lifecycle: derive with no cascade (a), cascade (b), or refuse the parent's end (c). Sub-points: should a CLOSED offering stop blocking like a CANCELLED one; should slots keep an ended teacher; is a void of a mistaken assignment or slot wanted? | (a); CLOSED blocks to term end; slots keep the ended teacher; no void | confirm (a) for M3; decide CLOSED and void before M4 | medium | no |
| 31-13 | Class teacher (homeroom) | resolved by doc 32 (`0038`) | — | — | — |
| 31-14 | Repeating a grade / year-back | resolved by doc 32 (`0038`) | — | — | — |

**Doc 32 (class teachers and progression), §7:**

| ID | Question | Implemented | Recommended | Pilot impact | Blocks M3 |
| --- | --- | --- | --- | --- | --- |
| 32-1 | One PRIMARY class per employee at a time (ASSISTANT unlimited); a university class advisor for several sections would need this relaxed | implemented (A) | confirm for the school pilot | high | no |
| 32-2 | Class-teacher writes reuse `academic.faculty.assign` (no dedicated permission) | implemented (A) | confirm | low | no |
| 32-3 | No cascade: ON_LEAVE or SEPARATED keeps open class-teacher rows; option to close them in the separation flow | no cascade | confirm for M3 | low | no |
| 32-4 | Deactivating a section with an open class teacher is not blocked | implemented (A) | confirm | low | no |
| 32-5 | Posting checked over the whole validity window at creation | resolved by `0039` (doc 33 §9); still no cascade when a posting later ends (see 32-3) | — | — | — |
| 32-6 | `DETAINED → COMPLETED`; `COMPLETED` also means "period ended without promotion" | implemented (A) | confirm | medium (detention) | no |
| 32-7 | A repeat keeps the same `period_no`, and the target term must start after the source term ends | implemented (A) | confirm against the school's policy (§3.9) | medium | no |
| 32-8 | Bulk promotion tool | resolved: delivered (doc 33 §5), PROMOTE only | — | — | — |
| 32-9 | Period-type-aware labels in the UI | delivered for cohort-period labels (doc 35 §4); listed open in doc 32 | confirm closed | low | no |
| 32-10 | Cross-reference to doc 31's open items | covered by 31-1 to 31-12 | — | — | — |

**Doc 33 (electives, registrations, holidays), §8:**

| ID | Question | Implemented | Recommended | Pilot impact | Blocks M3 |
| --- | --- | --- | --- | --- | --- |
| 33-1 | No administrative registration of a basket offering outside the window | implemented | confirm; the school must give real windows (§3.5) | high | no |
| 33-2 | AUTO_FROM_SECTION is an explicit, re-runnable action, not a side effect of publishing | implemented | confirm | medium | no |
| 33-3 | Registrations do not cascade (enrolment close, promotion, section move, offering cancel) | implemented | confirm | medium | no |
| 33-4 | A closing group checks `min_select` at that moment; a later drop below it is not prevented | implemented | confirm | low | no |
| 33-5 | Holidays: an organisation-wide row is refused when any campus has a LOCKED term on that date; no holiday has to lie inside a term | implemented | confirm | low | no |
| 33-6 | Terminology slots and fallbacks (doc 33 §6, extended by doc 35 §4) | implemented | confirm | medium (labels) | no |
| 33-7 | Checklist items and organisation-only scope | implemented | confirm | low | no |
| 33-8 | The promotion tool promotes only; repeats are per-enrolment decisions | implemented | confirm | low (single term) | no |
| 33-9 | Class-teacher postings: whole-period coverage at creation, no re-check when a posting later ends | implemented | confirm | low | no |

**Doc 34 (student timeline), §7:**

| ID | Question | Implemented | Recommended | Pilot impact | Blocks M3 |
| --- | --- | --- | --- | --- | --- |
| 34-1 | Should FACULTY see, in the timeline, the registration in the offering they teach? | profile-level events only | keep for M3 | low | no |
| 34-2 | Should a department-scoped holder see a student's earlier history in another department? | no (per-row scope) | keep | low | no |
| 34-3 | Should term-enrolment and student-status transitions get dated history tables? | not dated (doc 34 §6) | defer; a migration and writer change | low for one term | no |

**Related decisions outside docs 31–34, listed so they are not lost (not part of OD-6):**
- Doc 24 §3a item 5: campus, department and cohort deactivation guards were deferred.
- Doc 35 §7 items 3–6: "current posting" uses the database `current_date`; the wizard does not remember the last step; there are no in-wizard forms for some steps; `periodTypes` labels are keyed by period-type code.
- Docs 25 §5 and 26 §7 (M2 rooms and imports), in particular doc 26 §7 item 11 (no writer for `users.date_of_birth`).

**Blocks M3.** None of the OD-6 items blocks M3 by itself. High-impact items (31-1, 31-2, 31-3, 31-6, 32-1, 33-1) should be decided before the real data is loaded (G1), because the data will exercise them.

| OD-6 item IDs decided | Owner decision (confirm / change, with detail) | Date | Decision authority |
| --- | --- | --- | --- |
| | | | |
| | | | |
| | | | |

## 3. School pilot data submission template (one complete academic term)

### 3.1 Status and rules of this template

**What it is:**
- A **collection format** for the school to describe one complete term.
- It is **not** the product's import schema.
- The product's CSV import (`/imports`) supports only student and employee records for **existing accounts named by e-mail**. Every other entity is created through the product's screens and APIs during the rehearsal.
- No earlier illustrative workbook is authoritative, and none is in the repository. The example rows below are marked **ILLUSTRATIVE** and must not be copied as real data.

**How to submit:**
- One sheet or CSV file per table (§3.2–§3.10), UTF-8 encoding.
- Dates as `YYYY-MM-DD`, times as 24-hour `HH:MM`, date-times with a timezone offset.
- Codes are case-sensitive and must not change after submission (they are immutable in the product).

**Columns in each table:**
- **Req:** R = required; O = optional; C = required when the stated condition holds.
- **Validation:** the product's own rule, from the migrations and services. A value that fails it will be refused at load time.
- **Maps to:** the canonical entity. School terminology is display only (§3.11).

**Do not submit:**
- Passwords, one-time codes, MFA secrets, API keys or any credential.
- Students' date of birth, guardian phone numbers, home addresses, photographs, Aadhaar/APAAR or other government identifiers, medical, caste/category or financial data.
- Staff salary, bank or identity-document data.

None of these is needed for M3. Duplicate detection (name + date of birth + guardian phone) is **not** used in the pilot; that is a recorded consequence, not a gap.

### 3.2 Institution, campuses, session and terms

**Table A1 — Institution** (one row):

| Field | Req | Validation | Maps to | Notes |
| --- | --- | --- | --- | --- |
| institution_name | R | 1–255 characters | organisation | as it should appear in the product |
| institution_type | R | `SCHOOL` / `COLLEGE` / `UNIVERSITY` | information only | the product has no institution-type field; one shared model |
| board_or_affiliation | O | free text | information only | e.g. the board the school follows; not stored |
| pilot_contact_name | R | — | sign-off sheet | not loaded into the product |

**Table A2 — Campuses** (one row per campus; three for the pilot):

| Field | Req | Validation | Uniqueness | Maps to |
| --- | --- | --- | --- | --- |
| campus_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$`, immutable | unique in the institution | `campuses.code` |
| campus_name | R | 1–255 characters | — | `campuses.name` |
| timezone | R | canonical IANA name present in `pg_timezone_names` (e.g. `Asia/Kolkata`); abbreviations (`IST`), `Etc/…` and offsets are refused; immutable | — | `campuses.timezone` |
| address | O | short text, ≤ 4 KiB | — | `campuses.address` |

**Table A3 — Departments or wings** (staff postings and scope need at least one per campus):

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| campus_code | R | — | — | A2.campus_code |
| department_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$` | unique per institution | — |
| department_name | R | 1–255 characters | — | — |
| kind | R | `ACADEMIC` / `ADMINISTRATIVE` / `SERVICE` | — | — |

**Table A4 — Academic session** (organisation-wide):

| Field | Req | Validation | Uniqueness |
| --- | --- | --- | --- |
| session_label | R | 1–20 characters (e.g. ILLUSTRATIVE `2026-27`) | unique in the institution |
| start_date, end_date | R | `end_date > start_date` | — |

**Table A5 — Terms** (per campus; the product's terms belong to one campus):

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| campus_code | R | — | — | A2 |
| session_label | R | — | — | A4 |
| term_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$`, immutable | unique per campus and session | — |
| term_name | R | 1–255 characters | — | — |
| start_date, end_date | R | inside the session; `end_date > start_date`; fixed once the term is ACTIVE | — | — |
| is_pilot_term | R | `Y` for exactly one term per campus | — | — |

### 3.3 Academic structure

**How a school maps onto the shared model** (doc 31 §4; labels per §3.11):
- **Grade** = `period_no` of a programme whose period type is labelled "Grade".
- **Class in a session** = cohort period (grade N in a term).
- **Section** = section (e.g. 6-A).
- **Programme:** a programme belongs to one department, so to **one campus**. A three-campus school therefore needs at least one programme per campus.
- **Streams:** under the current OD-5 model (31-1), each Grade 11–12 stream is its own programme.

**Table B1 — Period type** (usually one row for a school):

| Field | Req | Validation | Maps to |
| --- | --- | --- | --- |
| period_type_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$`, unique | `period_types.code` |
| label, label_plural | R | 1–50 characters each (e.g. ILLUSTRATIVE `Grade` / `Grades`) | `period_types.label` |

**Table B2 — Programmes** (curriculum tracks per campus, and per stream where applicable):

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| programme_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$` | unique in the institution | — |
| programme_name | R | 1–255 characters | — | — |
| department_code | R | an ACADEMIC department | — | A3 |
| period_type_code | R | — | — | B1 |
| first_grade, last_grade | R | integers 1–12; the programme's `duration_periods` = number of grades covered | — | — |
| stream | C | required for Grades 11–12 programmes | — | B5 |
| degree_level | R | 1–30 characters (e.g. ILLUSTRATIVE `SCHOOL`) | — | — |

**Table B3 — Cohorts (entry intakes):**

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| programme_code | R | — | — | B2 |
| admission_year | R | 1900–2200 | — | — |
| intake_code | R | 1–10 characters, pattern as codes; one per entry grade (e.g. ILLUSTRATIVE `G1`, `G6`) | unique per programme and year | — |
| cohort_name | R | 1–255 characters | — | — |

**Table B4 — Classes in the pilot term, and their sections:**

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| campus_code, term_code | R | the pilot term | — | A5 |
| programme_code, admission_year, intake_code | R | the cohort studying this grade in this term | — | B3 |
| grade | R | within the programme's grades; one row per cohort and term | one grade per cohort and term | — |
| section_name | R | 1–50 characters (e.g. ILLUSTRATIVE `6-A`) | unique within the class | — |
| capacity | O | 1–10,000 | — | — |

The pilot target is four or more sections per grade where the school has them.

**Table B5 — Grade 11–12 streams:**

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| stream_code, stream_name | R | code pattern as programmes | — |
| campus_codes | R | campuses offering the stream | A2 |
| programme_code | R | the programme representing the stream (current model) | B2 |

### 3.4 Curriculum (every grade, course and subject)

**School terminology versus canonical entities:**
- A school "subject" is a canonical **course** (catalogue entry).
- Its place in a grade is a **curriculum course** (programme, regulation, `period_no`, category).
- Its delivery to a section in a term is a **course offering**.

The school fills this in using its own words; the operator maps them.

**Table C1 — Subjects (courses):**

| Field | Req | Validation | Uniqueness | Notes |
| --- | --- | --- | --- | --- |
| subject_code | R | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$`; stable school code | unique in the institution | snapshotted on publication |
| display_name | R | 1–255 characters | — | — |
| course_type | R | `THEORY` / `PRACTICAL` / `THEORY_PRACTICAL` / `PROJECT` / `INTERNSHIP` / `SEMINAR` / `AUDIT` / `OTHER` | — | — |
| credits | R | 0–99.9 (enter `0` if the school uses no credits) | — | — |
| tracks_attendance | R | `Y` / `N` | — | used from M4 |
| owning_department_code | O | — | — | A3 |
| theory_hours | O | number ≥ 0 per week or per term (state which) | — | **not stored by the product**; used for review only |
| practical_hours | O | as theory_hours | — | **not stored**; review only |

**Table C2 — Subject per grade (curriculum):**

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| programme_code | R | — | — | B2 |
| regulation | R | 1–30 characters (e.g. ILLUSTRATIVE `2026`) | — | — |
| grade | R | within the programme | — | — |
| subject_code | R | — | unique per programme, regulation and grade | C1 |
| category | R | `CORE` / `ELECTIVE` / `OPTIONAL` / `LAB` / `PROJECT` / `INTERNSHIP` | — | — |
| elective_group_code | C | required when category is `ELECTIVE` or `OPTIONAL` and chosen from a basket | — | D1 |
| weekly_periods | R | integer ≥ 0 | — | **not stored**; checked against the timetable (§5 V-08) |
| applicable_streams | C | required for Grades 11–12 | — | B5 |
| effective_term_code | R | the pilot term | — | A5 |

### 3.5 Electives

**Table D1 — Elective groups (baskets)**, one per class (cohort period) that offers a choice:

| Field | Req | Validation | Uniqueness | References |
| --- | --- | --- | --- | --- |
| campus_code, term_code, programme_code, grade | R | identifies the class | — | B4 |
| group_code | R | 1–30 characters | unique within the class | — |
| group_name | R | 1–255 characters | — | — |
| min_choices | R | 0–50 | — | — |
| max_choices | R | 1–50, ≥ min_choices | — | — |
| opens_at, closes_at | R | date-time with offset; `closes_at > opens_at`; no registration outside the window (OD-6 33-1) | — | — |
| approval_required | R | `Y` / `N` (`Y` = choices are recorded pending approval) | — | — |
| subject_codes | R | the subjects in the basket | — | C1 |
| capacity_per_subject | O | 1–10,000 per subject offering | — | — |

**Table D2 — Student elective choices** (staff-recorded under OD-2):

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| student_external_id | R | — | I1 |
| group_code | R | — | D1 |
| subject_code | R | in the basket; the student's total within min/max | D1 |

### 3.6 Staff

**Prerequisite:** each staff member needs a product account for that e-mail (an invitation, M2 B4) before the employee record can be imported.

**Table E1 — Employees:**

| Field | Req | Validation | Uniqueness | Notes |
| --- | --- | --- | --- | --- |
| employee_code | R | `^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$`, immutable | unique in the institution | — |
| login_email | R | valid e-mail; the person's own work address | one employee per account | the account cannot also hold a student record |
| full_name | R | — | — | for the account and the review |
| employee_type | R | `FACULTY` / `STAFF` / `ADMIN` / `VISITING` | — | — |
| joining_date | R | date | — | — |
| employment_status | R | `ACTIVE` / `ON_LEAVE` / `SEPARATED` | — | `SEPARATED` requires leaving_date; only ACTIVE staff can be assigned (31-7) |
| leaving_date | C | ≥ joining_date | — | — |

**Table E2 — Campus postings:**

| Field | Req | Validation | Notes |
| --- | --- | --- | --- |
| employee_code | R | — | E1 |
| department_code | R | — | A3; its campus is the posting campus |
| is_primary | R | `Y` / `N`; at most one open primary posting per employee | only the primary posting gives campus scope and assignment eligibility (31-6) |
| valid_from | R | on or before the first teaching day of the term | a later posting makes earlier assignments impossible |
| valid_to | O | ≥ valid_from; must not end inside an assignment or class-teacher period | — |

**Table E3 — Teaching assignments:**

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| employee_code | R | ACTIVE, primary posting on the section's campus covering the dates | E1, E2 |
| campus_code, term_code, grade, section_name | R | the section taught (or `ALL` for a grade-wide offering) | B4 |
| subject_code | R | in the grade's curriculum | C2 |
| teaching_role | R | `PRIMARY` / `CO_INSTRUCTOR` / `LAB_INSTRUCTOR` / `SUBSTITUTE`; one PRIMARY per section-subject at a time | — |
| valid_from, valid_to | R / O | inside the term | — |
| group_label | C | for lab groups or parallel language options (e.g. ILLUSTRATIVE `G1`) | — |

**Table E4 — Class teachers:**

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| employee_code | R | as E3; posting covers every day of the period | E1, E2 |
| campus_code, term_code, grade, section_name | R | — | B4 |
| class_teacher_role | R | `PRIMARY` / `ASSISTANT`; one PRIMARY per section; one PRIMARY section per employee (32-1) | — |
| valid_from, valid_to | R / O | inside the term | — |

### 3.7 Timetable

**Product limits:**
- The product stores **weekly slots** (weekday, start and end time, effective dates, room, teaching assignment).
- It has **no bell-schedule entity**. Table F1 is used to build and check the slots, not stored.
- **Pilot procedure:** every slot names its teacher (OD-6 31-3), so teacher clashes are checked.

**Table F1 — Bell schedule** (for building and checking only):

| Field | Req | Validation |
| --- | --- | --- |
| campus_code | R | A2 |
| teaching_days | R | ISO weekdays 1–7 (1 = Monday) |
| period_number | R | 1..n, unique per campus |
| start_time, end_time | R | `HH:MM`, start < end; periods do not overlap |
| is_break | R | `Y` for breaks and lunch (no slot is created) |

**Table F2 — Rooms:**

| Field | Req | Validation | Uniqueness |
| --- | --- | --- | --- |
| campus_code | R | A2 | — |
| room_code | R | 1–20 characters | unique per campus |
| kind | R | free text 1–50 (e.g. ILLUSTRATIVE `CLASSROOM`, `LAB`) | — |
| capacity | O | > 0 | — |

**Table F3 — Section timetable** (one row per weekly lesson):

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| campus_code, term_code, grade, section_name | R | — | B4 |
| weekday | R | 1–7, a teaching day | F1 |
| period_number | R | not a break | F1 |
| subject_code | R | — | C2 |
| employee_code | R | holds an E3 assignment for this section-subject valid on the first day | E3 |
| room_code | O | room on the same campus; no two lessons in one room at once | F2 |
| group_label | C | for parallel partial lessons (lab groups, language options) | E3 |
| double_period | O | `Y` when one lesson spans two consecutive periods (stored as one slot) | F1 |

### 3.8 Calendar: holidays

**Table G1 — Holidays** (pilot term):

| Field | Req | Validation | Uniqueness |
| --- | --- | --- | --- |
| campus_code | O | blank = every campus | — |
| date | R | — | name unique per campus or organisation and date among active rows |
| name | R | 1–120 characters | — |
| kind | R | `HOLIDAY` / `NON_TEACHING_DAY` / `EVENT` | — |

### 3.9 Progression

**Table H1 — Promotion and repetition rules** (policy text). Optional for a single-term pilot; required before the session ends.

| Field | Req | Notes |
| --- | --- | --- |
| promotion_rule | O | who decides, and when; the product records decisions, it does not compute eligibility |
| detention_rule | O | the conditions for DETAINED |
| repetition_rule | O | must fit 32-6 and 32-7 (same grade, a later term, with the junior cohort) or be raised as a decision change |
| effective_from | O | date |

### 3.10 Student pilot roster

**Prerequisite:** a student record needs an **existing product account**, named by e-mail (current import, doc 26). See §4 finding PR-1.

**Table I1 — Students:**

| Field | Req | Validation | Uniqueness | Notes |
| --- | --- | --- | --- | --- |
| student_external_id | R | the admission number, `^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$`, immutable | unique in the institution | the stable external identifier |
| login_email | R | valid e-mail | one student per account | the account must hold no staff role and no employee record |
| student_name | R | display name | — | — |
| admission_date | R | date | — | — |
| campus_code, programme_code, admission_year, intake_code | R | the student's cohort | — | B3 |

**Table I2 — Pilot-term enrolment:**

| Field | Req | Validation | References |
| --- | --- | --- | --- |
| student_external_id | R | — | I1 |
| term_code, grade | R | the student's own cohort, unless enrolment_type is `REPEAT` | B4 |
| section_name | R | where the class has sections; capacity respected | B4 |
| enrollment_type | R | `REGULAR` / `REPEAT` | — |
| enrollment_status | R | `REGISTERED` or `ACTIVE` at load time | — |
| roll_number | O | `^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$` | unique per class |
| section_from_date | R | inside the term | — |
| section_move | O | `new_section_name` and `move_date` for students who changed section during the term | B4 |

### 3.11 Terminology

**Table J1 — Labels** (optional; the defaults apply when blank):

| Slot | Canonical entity | Example school label (ILLUSTRATIVE) |
| --- | --- | --- |
| program | programme | Class |
| cohort | cohort | Batch / Intake |
| period | cohort period | Grade |
| section | section | Section |
| term | term | Term / Session |
| course | course | Subject |

Rules (doc 35 §4):
- 1–40 characters.
- No leading or trailing spaces, no control characters, no `<` `>`.
- No two slots with the same label.
- Labels change display only, never data.

### 3.12 Relationship summary

```
Institution ─ Campus (A2) ─ Department (A3) ─ Programme (B2) ─ Cohort (B3) ─ Class in term (B4) ─ Section (B4)
Campus ─ Term (A5) ─ Session (A4)           Programme ─ Curriculum (C2) ─ Subject (C1)
Class in term ─ Elective group (D1) ─ basket subjects (C1)
Employee (E1) ─ Posting (E2, department → campus) ─ Assignment (E3, section × subject) ─ Timetable lesson (F3, room F2)
Section ─ Class teacher (E4)      Student (I1) ─ Enrolment (I2, class + section) ─ Elective choice (D2)
Campus or organisation ─ Holiday (G1)
```

**Illustrative example rows** (ILLUSTRATIVE ONLY: invented values, not CBSE data, not to be loaded):

| Table | Example |
| --- | --- |
| A2 | `NORTH`, `North Campus`, `Asia/Kolkata` |
| A5 | `NORTH`, `2026-27`, `T1`, `Term 1`, `2026-04-01`, `2026-09-30`, `Y` |
| C2 | `SCH-NORTH`, `2026`, `6`, `MATH6`, `CORE`, —, `6`, —, `T1` |
| E3 | `E1001`, `NORTH`, `T1`, `6`, `6-A`, `MATH6`, `PRIMARY`, `2026-04-01`, — |
| F3 | `NORTH`, `T1`, `6`, `6-A`, `1`, `2`, `MATH6`, `E1001`, `R101`, —, `N` |
| I2 | `ADM0001`, `T1`, `6`, `6-A`, `REGULAR`, `ACTIVE`, `12`, `2026-04-01` |

## 4. Pre-load findings that need owner input

These are not new decisions in the OD-1 to OD-6 register. They are facts the pilot data will hit, and they need the owner's direction before the school prepares data.

| ID | Finding | Evidence | Options (no recommendation adopted) |
| --- | --- | --- | --- |
| PR-1 | Every student and staff record needs an existing product account named by e-mail. Many school pupils have no personal e-mail | doc 26 (imports name existing accounts; no account creation); M2 B4 invitations | (a) the school provides an institutional e-mail per pupil; (b) a pilot subset of pupils with accounts; (c) a future account-creation-by-import feature (owner decision, not M3) |
| PR-2 | A programme belongs to one campus. A three-campus school needs one programme per campus (and per stream in Grades 11–12) | `0014` programmes → department; `0033` cohort-period guard (term on the programme's campus) | accept for M3 (OD-6 31-1), or plan a model change after the pilot |
| PR-3 | Existing tenants need `seedTenantRoles` re-run for the M3 permissions and the FACULTY ASSIGNED grant; no re-seed has been authorised | doc 31 §1, doc 33 §2 | the rehearsal runs on a fresh disposable tenant, where roles are seeded on creation; production re-seed is a rollout task |
| PR-4 | Weekly periods, theory hours, practical hours and bell times have no product field | doc 36 §6.2 | collected for review only (§3.4, §3.7); storing them is a future schema decision (OD-4) |

## 5. Pilot validation checklist

Run this after the real data is loaded on the rehearsal environment.

- **Methods:** UI = a product screen. API = a documented endpoint as the stated role. SQL = a read-only query on the **disposable** rehearsal database (never on a persistent or production database without separate authorisation).
- **Result** values are PASS / FAIL / N/A, with a note.
- All Result and Evidence fields start blank.

| ID | Check | Method | Expected | Evidence to capture | Result |
| --- | --- | --- | --- | --- | --- |
| V-01 | Three-campus structure | UI wizard step 2; SQL count | 3 ACTIVE campuses, each with an IANA timezone and at least one department | screenshot plus count | |
| V-02 | Session and pilot terms | UI Calendar | one session; one pilot term per campus, dates inside the session; matches A5 | screenshot | |
| V-03 | Grades 1–12 per campus | UI Sections; SQL per campus | a class (cohort period) for every grade the campus offers, in the pilot term | table of grade × campus | |
| V-04 | Sections per grade | UI Sections; SQL | four or more sections per grade where the school has them; names and capacities match B4 | table | |
| V-05 | Entry intakes | SQL cohorts | one cohort per entry grade (`intake_code`); no class with two cohorts' students mixed | list | |
| V-06 | Grade 11–12 streams | UI Courses and Electives | each stream represented as in B5; curriculum per stream matches C2 | screenshot | |
| V-07 | Stream and elective constraints | UI Electives; API | min/max, capacity and window as in D1; a choice outside the window, above the maximum or beyond capacity is refused | refusal screenshots | |
| V-08 | Curriculum completeness | SQL / UI | every C2 row exists; each section's weekly slots per subject equal `weekly_periods` (double periods counted per F3) | reconciliation table | |
| V-09 | Staff and postings | UI employees; API | every E1 row exists; every teacher has an open primary posting on the right campus covering the term | list | |
| V-10 | Faculty, subject and section assignments | API `/faculty/employees/:id/assignments` | every E3 row exists; one PRIMARY per section-subject; no published offering without a teacher | export | |
| V-11 | Class teachers | UI Sections | one PRIMARY class teacher per section; no employee is PRIMARY of two sections | list | |
| V-12 | Timetable completeness | UI Offerings / timetable | every F3 lesson exists as a slot with a named teacher and a room; no slot in a break | reconciliation table | |
| V-13 | Timetable conflicts | API / UI | zero room, section (audience) or teacher clashes accepted; one deliberate clash of each kind refused (BA-09) | refusal evidence | |
| V-14 | Holidays | UI Holidays | every G1 row present, organisation-wide or per campus | screenshot | |
| V-15 | Student roster | UI Students; import report | every I1 row exists; admission numbers unique; the import error report is empty or explained | report | |
| V-16 | Enrolment and sections | UI Enrolment; SQL | every I2 student holds one live enrolment in the pilot term, in the right class and section; capacity respected | reconciliation table | |
| V-17 | Section moves | UI timeline | every I2 move shows both sections with the right dates | timeline screenshot | |
| V-18 | Per-student course sets (G2) | API registrations | the sample of Grade 11–12 students hold exactly their D2 choices plus the class's core subjects | sample table | |
| V-19 | Promotion and repetition rules | review against H1 | rules fit 32-6 and 32-7, or a decision change is raised; for a single term, a dry-run promotion of one class lists the expected students and writes nothing | dry-run output | |
| V-20 | Term readiness | UI wizard review | each pilot term: no blocking issue; warnings listed and accepted by the reviewer | screenshot | |
| V-21 | Tenant isolation | API as a second tenant's admin | every pilot campus, section, student and employee id answers 404 | request log | |
| V-22 | Campus isolation | API as a campus-scoped admin of campus 1 | campus 2 and 3 rows answer 404 or are absent from lists | request log | |
| V-23 | Full-term consistency | SQL | no enrolment, registration, assignment, slot or class-teacher row dated outside the term; no open row of a term dated after its end; counts match the school's sheets | query output | |
| V-24 | Nginx routing (only if the walkthrough is served through Nginx, OD-5) | HTTP | `/api/v1/*` forwarded unchanged; `/api/auth/*` and `/api/me/mfa*` forwarded with `/api` stripped; every data screen loads | request log | |

**College and university regression (the shared model must not be narrowed by the school configuration).** Run in separate tenants of the same rehearsal environment:

| ID | Check | Expected | Evidence | Result |
| --- | --- | --- | --- | --- |
| R-01 | College with YEAR and SEMESTER programmes on one campus | both programmes, terms and cohort periods coexist; programme-aware period labels (Year / Semester) | screenshot | |
| R-02 | College terms activate | an annual and a semester term each activate only when ready | API log | |
| R-03 | University semester flow | semester terms, sections, offerings, electives with min/max/window, drop and withdraw history | screenshots | |
| R-04 | University labels | default labels unchanged by the school tenant's terminology | screenshot | |
| R-05 | Regression suites | `college-regression.test.ts`, `academic-setup-wizard.test.ts`, `term-activation.test.ts`, `course-offerings.test.ts`, `m3b3-electives-registrations.test.ts` pass on the acceptance commit | suite output | |
| R-06 | Cross-tenant | school, college and university tenants cannot read each other's rows | request log | |

## 6. Formal browser acceptance script

### 6.1 General preconditions

- **P-1:** the acceptance commit is recorded (hash). The environment is a fresh disposable or owner-approved non-production database migrated `0001`–`0039`, with the real backend and the repository's web build. Through Vite, or through Nginx when OD-5 says so.
- **P-2:** the §3 school data is loaded and §5 V-01 to V-23 are done. College and university regression tenants are created (§6.3).
- **P-3:** test accounts exist for each role in the table below. Passwords are held by the operator and never written into evidence. MFA is completed through real TOTP where the role requires it. If a shortcut is used, it is written into the evidence.
- **P-4:** the browser is recorded (name and version). Viewports: **desktop 1280 × 800** and **phone 390 × 844**. Console errors are captured for every step.
- **P-5:** for each step, capture a screenshot (or a recording) and, where stated, the network request (method, path, status) and a read-only query result. Never capture tokens, cookies or passwords.

| Account | Role and scope | Used in |
| --- | --- | --- |
| ADM-S | organisation administrator (COLLEGE_ADMIN), school tenant | BA-01 to BA-10 |
| CAM-S2 | CAMPUS_ADMIN of campus 2, school tenant | BA-01, BA-12 |
| FAC-S | FACULTY with an assignment, school tenant | BA-01, BA-11, BA-12 |
| STU-S | STUDENT of the school tenant | BA-01, BA-11 |
| ADM-X | organisation administrator of another tenant | BA-12 |
| ADM-C / ADM-U | administrators of the college and university regression tenants | §6.3 |

**Every step row has a blank Pass/Fail field. Nothing below is passed in advance.**

### 6.2 Steps (school tenant)

| Step | Preconditions | Account | Viewport | Action | Expected result | Evidence | Pass/Fail |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BA-01a | P-1 to P-4 | ADM-S | 1280 | sign in; open the navigation | Students, Academics, Imports, Organisation, Users and Roles & access shown according to permissions; school labels used on Academics | screenshot | |
| BA-01b | — | FAC-S | 1280 | sign in | no setup wizard, setup checklist or user administration; academic screens read-only | screenshot | |
| BA-01c | — | STU-S | 390 | sign in | no Imports, Organisation, Users or Roles & access entries; no setup wizard or setup checklist; any academic screen shown is read-only | screenshot | |
| BA-01d | — | CAM-S2 | 1280 | sign in; open Academics | only campus 2 data visible; organisation-only screens explain the 403 | screenshot | |
| BA-02a | a campus with an incomplete setup exists, or before the last load step | ADM-S | 1280 | Academics → Setup wizard | progress count and 13 steps; required versus optional shown; resumes at the first incomplete required step | screenshot | |
| BA-02b | — | ADM-S | 1280 | open each step | counts match §5 V-01 to V-16; issues in fixed wording; links open the existing screens | screenshots | |
| BA-02c | — | ADM-S | 390 | open the wizard campus step | no page overflow (scroll width 390) | screenshot plus measured width | |
| BA-03a | pilot term PLANNED and ready (V-20); academic year ACTIVE | ADM-S | 1280 | wizard Review, or Calendar → the term → Activate → Confirm activation | term becomes ACTIVE; no error; the version changes | screenshot; network `PATCH /api/v1/academics/terms/:id` or `POST …/activation` 200; read-only status query | |
| BA-03b | — | ADM-S | 1280 | reload and activate again | no-op; still ACTIVE; no second audit row | screenshot; query | |
| BA-04a | a second PLANNED term made deliberately unready (e.g. one published offering without a teacher) | ADM-S | 1280 | Calendar → Activate | refused with the fixed readiness message; the term stays PLANNED; no server text shown | screenshot; network 409 `SETUP_INCOMPLETE`; query | |
| BA-04b | — | ADM-S | 1280 | open the wizard Review | the same blocking issue listed for that term | screenshot | |
| BA-05a | an ACTIVE enrolment without a section | ADM-S | 1280 | Enrolment → "Place in a section" → choose a section, date, reason → submit | student placed; roster shows the student | screenshot; network 2xx | |
| BA-05b | the same student | ADM-S | 1280 | "Place in a section" again with another section of the same class and a later date | moved; the old membership closed the day before, the new one open | screenshot; query of both membership rows | |
| BA-05c | the section is full | ADM-S | 1280 | place one more student | refused as a conflict; nothing changed | screenshot; 409 | |
| BA-06a | ACTIVE or PLANNED term | ADM-S | 1280 | Offerings → "Create course offering" (subject, kind CORE, policy AUTO_FROM_SECTION, class, section) | offering created as DRAFT | screenshot; 201 | |
| BA-06b | — | ADM-S | 1280 | Publish offering | PUBLISHED; snapshot of code and title shown | screenshot; query `status`, snapshots | |
| BA-06c | a second test offering | ADM-S | 1280 | Cancel offering with a reason of 5+ characters | CANCELLED; no longer blocks room or section | screenshot | |
| BA-06d | — | ADM-S | 1280 | Close offering on a published test offering | CLOSED (final); write forms disabled | screenshot | |
| BA-07a | the BA-06b offering; a teacher with a primary posting on the campus | ADM-S | 1280 | "Assign faculty to offering": employee, PRIMARY, start date, reason | assignment listed; also visible at `/faculty/employees/:id/assignments` | screenshot; network 201; GET 200 | |
| BA-07b | — | ADM-S | 1280 | assign a second PRIMARY for overlapping dates | refused | screenshot; 409 | |
| BA-07c | — | ADM-S | 1280 | "End an assignment": end date, reason | `validTo` set; history kept | screenshot; query | |
| BA-07d | a teacher posted on another campus | ADM-S | 1280 | assign that teacher | refused (posting rule) | screenshot; 409 | |
| BA-08 | the BA-06b offering with an open assignment | ADM-S | 1280 | "Add timetable slot": weekday, start, end, room, teacher | slot listed in the weekly timetable | screenshot; 201 | |
| BA-09a | slot from BA-08 | ADM-S | 1280 | add a slot of another offering in the **same room**, same weekday, overlapping time | refused; room clash explained | screenshot; 409 | |
| BA-09b | — | ADM-S | 1280 | add a slot of another whole-section CORE offering of the **same section** at an overlapping time | refused; section clash explained | screenshot; 409 | |
| BA-09c | — | ADM-S | 1280 | add a slot of another section's offering naming the **same teacher** at an overlapping time | refused; teacher clash explained | screenshot; 409 | |
| BA-09d | — | ADM-S | 1280 | add the same slot at 10:00–11:00 next to 09:00–10:00 | accepted (half-open times) | screenshot | |
| BA-10a | an OPEN elective group inside its window (Grade 11–12) | ADM-S | 1280 | Electives → find the student's choices → "Record a choice" | `ELECTIVE_CHOICE` registration recorded (pending if approval is required) | screenshot; query `source` | |
| BA-10b | the student holds the maximum | ADM-S | 1280 | record one more choice | refused; maximum explained | screenshot; 409 | |
| BA-10c | approval required | ADM-S | 1280 | approve the pending choice | REGISTERED | screenshot | |
| BA-10d | — | ADM-S | 1280 | drop a choice with an end date and reason | DROPPED with history kept | screenshot | |
| BA-11a | the BA-05b student | ADM-S | 1280 | Students → profile → Academic timeline | current position (class, section, registrations); the events list shows placement and move | screenshot | |
| BA-11b | — | ADM-S | 1280 | set "Position as of" to the day before the move → Show | the earlier section shown; later events counted | screenshot | |
| BA-11c | FAC-S teaches the student | FAC-S | 1280 | open the student's profile | profile and timeline shown (profile-level events only, 34-1) | screenshot | |
| BA-11d | FAC-S does not teach a second student | FAC-S | 1280 | open that student's profile | "Student not found" | screenshot; 404 | |
| BA-12a | — | ADM-X | 1280 | open a school student, section and employee URL directly | "not found" for each; no data shown | screenshots; 404 | |
| BA-12b | — | CAM-S2 | 1280 | open a campus 1 section and term | not found or absent | screenshot; 404 | |
| BA-12c | — | STU-S | 390 | open another student's profile URL | "Student not found" | screenshot; 404 | |
| BA-13a | — | ADM-S | 390 | open each Academics tab, the wizard, Holidays, Electives, a student profile with timeline | no page overflow on any screen; wide tables scroll inside their container | measured widths per screen | |
| BA-13b | — | ADM-S | 1280 | the same screens | no overflow; no console errors | measured widths; console log | |

### 6.3 Regression scenarios

**College (tenant C, account ADM-C):**

| Step | Viewport | Action | Expected | Evidence | Pass/Fail |
| --- | --- | --- | --- | --- | --- |
| RC-1 | 1280 | Courses: create an annual (YEAR) programme and a SEMESTER programme on one campus | both created | screenshot | |
| RC-2 | 1280 | Setup wizard step 1: college preset; save | Year and Semester labels per programme | screenshot | |
| RC-3 | 1280 | activate an unready annual term, then a ready one | refused, then ACTIVE | screenshots; 409 then 200 | |
| RC-4 | 1280 | create an offering, assign faculty, add a slot in each programme | accepted; clash rules as in the school | screenshots | |
| RC-5 | 390 | student timeline of a Year-2 student | Year label, no overflow | screenshot | |

**University (tenant U, account ADM-U):**

| Step | Viewport | Action | Expected | Evidence | Pass/Fail |
| --- | --- | --- | --- | --- | --- |
| RU-1 | 1280 | two campuses; semester terms; activate a ready term on campus 2 | ACTIVE; the campus-1 admin cannot see it | screenshots | |
| RU-2 | 1280 | elective group PLANNED → OPEN; record choices up to the maximum; one refused | as stated | screenshots | |
| RU-3 | 1280 | drop and withdraw registrations | history kept | screenshot | |
| RU-4 | 1280 | labels | defaults (Terms, Sections, Courses), unaffected by the school tenant | screenshot | |
| RU-5 | 1280 | faculty X-12: an assigned teacher sees a registered student; an unassigned one gets not found | 200 / 404 | screenshots | |

## 7. Reviewer sign-off sheet

D2 (walkthrough with the pilot's real curriculum) and G1 (pilot structure loaded for a full term) are accepted **only** with the school-side evidence and signatures below. An assistant cannot sign, and cannot mark either criterion passed.

| Field | Entry |
| --- | --- |
| Institution | |
| Campus(es) reviewed | |
| Academic session and term | |
| Reviewer name and role (school) | |
| Acceptance authority (name, role) | |
| Test date(s) | |
| Browser (name, version) and environment (URL type, database: disposable or approved non-production) | |
| Acceptance commit hash and CI run | |
| Data version (submission file names and dates, checksum) | |
| §5 validation checklist result (V-01 to V-24, R-01 to R-06) | |
| §6 browser script result (steps passed / failed / N/A) | |

**D2: real-curriculum walkthrough**

| Evidence | Reference | Reviewer initials |
| --- | --- | --- |
| Curriculum per grade reviewed against the school's own sheets (C1, C2) | | |
| Streams and electives reviewed (B5, D1) | | |
| Timetable sample reviewed (F3, V-08, V-12) | | |
| Terminology reviewed (J1) | | |

**G1: pilot structure loaded for a full term**

| Evidence | Reference | Reviewer initials |
| --- | --- | --- |
| Counts per entity match the school's submission (V-01 to V-16) | | |
| Full-term consistency (V-23) | | |
| Per-student course sets sample (V-18) | | |

**Defects found** (ID, description, severity, step, status):

| ID | Description | Severity | Step | Status |
| --- | --- | --- | --- | --- |
| | | | | |

**Accepted limitations** (default candidates from doc 36 §8.4 and §2 above; strike out any not accepted):
- Readiness enforced in the service only (OD-1).
- Staff-managed elective registration (OD-2).
- No term-lock UI action (OD-3).
- No quantitative workload (OD-4).
- Production Nginx verified before production deployment (OD-5).
- No bulk-promotion UI.
- Undated term-enrolment and status transitions (34-3).
- One `CONFLICT` code for all guard refusals.
- The wizard does not remember the last step.
- No product fields for weekly periods, hours or bell times (PR-4).

**Outstanding conditions** (for ACCEPT WITH CONDITIONS: each with owner and due date):

| Condition | Owner | Due |
| --- | --- | --- |
| | | |

**Final decision** (tick one): ☐ ACCEPT ☐ ACCEPT WITH CONDITIONS ☐ REJECT

| Signature | Name | Date |
| --- | --- | --- |
| School reviewer | | |
| School acceptance authority | | |
| Product owner | | |

## 8. M3 evidence register

**Columns:**
- Canonical requirement ID (doc 36 §4).
- Evidence artifact.
- Test, API or browser reference.
- Environment.
- Test date.
- Result.
- Reviewer.
- Outstanding defect or limitation.

The four registers are kept separate. **Historical results are recorded as they were reported on their dates and were not re-run for this document.**

### 8.1 Existing historical evidence (not re-run)

| Requirement | Evidence artifact | Reference | Environment | Test date | Result | Reviewer | Outstanding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1–F17, T1, A1–A3, X1–X8, G2–G4 | Task 9 suites | unit 47/928; security 45/723; integration 77/1,545; web 20/347 | disposable embedded PostgreSQL, uncommitted tree at HEAD `bd05759` | 2026-11-04 | pass as reported | none (assistant-run) | not on a committed tree; no CI |
| A1, A2, F-series, isolation | API E2E driver | 85/85 | fresh disposable database, real backend, Vite proxy | 2026-11-04 | pass as reported | none | logs in a temporary session scratchpad |
| School, college and university regression | Task 7 API driver | 77/77 | as above | 2026-11-04 | pass as reported | none | as above |
| A3 | Task 9 `/faculty` driver | 21/21 | as above | 2026-11-04 | pass as reported | none | as above |
| T2, U1, U4, U5, U7, U8, F14, F17 | browser driver | 48/48 (headless Chrome 156) | as above | 2026-11-04 | pass as reported | none | U2, U3, U6, U9 not covered (doc 36 §4.4) |
| Runbook SQL (M3) | runbook pre- and post-checks | doc 36 / 2026-11-02 log entry | disposable database 0036 → 0039 | 2026-11-02 | ran as documented | none | not run on a populated database |
| Overall | doc 36 matrix | 55 rows: 43 PASS, 6 PARTIAL, 2 PENDING, 3 NOT VERIFIED, 1 limitation | — | 2026-11-05 (assessment) | — | none | — |

### 8.2 New formal rehearsal evidence (to be filled in)

| Requirement | Evidence artifact | Reference | Environment | Test date | Result | Reviewer | Outstanding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | commit and CI run | | | | | | |
| All suites | suite output | | | | | | |
| U2 | BA-03, BA-04 | | | | | | |
| U3 | BA-05 | | | | | | |
| U6 | BA-07 | | | | | | |
| U9 | BA-06, BA-08, BA-09 | | | | | | |
| U5 | BA-10 | | | | | | |
| U7, G3 | BA-11 | | | | | | |
| Isolation | BA-12, V-21, V-22 | | | | | | |
| T2 | BA-13 | | | | | | |
| Regression | RC-1 to RC-5, RU-1 to RU-5, R-01 to R-06 | | | | | | |

### 8.3 External school evidence (to be filled in)

| Requirement | Evidence artifact | Reference | Environment | Test date | Result | Reviewer | Outstanding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D2 | §7 D2 table and signatures | | | | | | |
| G1 | §7 G1 table, V-01 to V-23 | | | | | | |
| G2 (real data) | V-18 | | | | | | |
| Data submission | §3 files, version and checksum | | | | | | |

### 8.4 Production deployment evidence (to be filled in; M7 unless OD-5 decides otherwise)

| Requirement | Evidence artifact | Reference | Environment | Test date | Result | Reviewer | Outstanding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Nginx routing contract | V-24 request log | | | | | | |
| Migrations `0008`–`0039` applied in order, with preflights | runbook outputs | | | | | | |
| `seedTenantRoles` re-seed | operator record | | | | | | |
| Backup and restore drill | M7 | | | | | | |

## 9. Next steps

1. **The owner records** OD-1 to OD-6 (§2) and directs PR-1 to PR-4 (§4).
2. **The owner commits** the working tree; CI runs on that commit (§8.2 baseline).
3. **The school** receives §3, fills in one complete term, and names the reviewer and the acceptance authority.
4. **The operator** loads the data on a fresh rehearsal environment and runs §5, then §6, filling in §8.2.
5. **The school reviewer** completes §7. The product owner decides on M3 acceptance from §7 and §8.
6. **Milestone 4** is not started until M3 is recorded as accepted.
