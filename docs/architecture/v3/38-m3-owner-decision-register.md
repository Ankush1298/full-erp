# 38 — M3 owner decision register and pilot data authorisation

Status: decision preparation only, 2026-11-05.

- No application feature, schema, migration, database operation, Git write or M4 work.
- **Every decision and authorisation in this document is PENDING.** Creating or editing this document approves nothing; only the named decision owner can change a status.
- **M3 is not accepted.**

Authoritative starting point:
- `36-m3-residual-gap-assessment.md` (doc 36).
- `37-m3-owner-decisions-and-pilot-readiness.md` (doc 37).
- Canonical requirements from `04` Part 14 and Part 16 (unchanged).

## 0. Rules of this register

**Statuses.** Only three:

| Status | Meaning |
| --- | --- |
| **PENDING** | not decided |
| **APPROVED** | the decision owner accepts the recommended default, or a stated alternative recorded in the Rationale |
| **REJECTED** | the decision owner refuses the recommendation; the Rationale says what applies instead |

**Decision owners:**
- **Product owner:** every OD and PR product item.
- **School acceptance authority:** every Section C item and every "school confirmation" item.
- **Operator authorisation:** given by the product owner for any environment that will hold real data.

**Fields.** "Approval status", "Approval date" and "Rationale" are filled in by the decision owner only. An assistant may record a decision only when the owner states it in writing, and must quote the source (message, date).

**A changed decision** keeps its history: add a dated line; never overwrite.

## 1. Repository state and continuity

**Recorded before editing:**
- Branch `main`, HEAD `bd05759704bda5fca37f1d4bf3358cf1e7840cb7`.
- `git status --short`: 119 entries. 0 staged, 60 unstaged, 59 untracked. No stash.
- **Unchanged since doc 37:** the only file modified after doc 37 was written is `PROJECT_LOG.md` (the doc 37 entry). The status list is identical.

**Protected local-only files:** `.claude/`, `CLAUDE.md`, `PROJECT_CONTEXT.md`, `PROJECT_LOG.md` and `TASK_PROMPT.md` stay untracked and unstaged. Only `PROJECT_LOG.md` receives one appended entry.

**Stale continuity instructions (recorded, not rewritten):**
1. `PROJECT_CONTEXT.md` §3, §4 item 12 and §6, and `TASK_PROMPT.md`, describe Milestone 2 Batch 2 at `99f7e80` and migrations up to `0036`. The actual state is HEAD `bd05759`, migrations up to `0039`, and M2 B2–B6, M3 and Tasks 1–9 uncommitted.
2. `PROJECT_CONTEXT.md` §1 says "for higher education institutions". The owner direction is one platform for schools, colleges and universities.
3. `TASK_PROMPT.md` forbids starting M3 Batch 2. That has since been done on instruction.
4. `PROJECT_CONTEXT.md` §7 item 3 asks every task to rewrite both files. Owner instructions treat them as protected.

## 2. Section A — Owner decisions OD-1 to OD-6

### OD-1 — Database-level term activation enforcement

| Field | Content |
| --- | --- |
| Decision ID | OD-1 |
| Question | Must the activation readiness rules also be enforced inside PostgreSQL for M3, or is enforcement in `TermService.update` enough? |
| Requirement | `04` Part 16 M3: "terms (free codes, state machine)"; Tests "term lock". Readiness is not a Part 16 criterion (introduced in Task 8, doc 35 §3) |
| Current implementation / evidence | Every PLANNED → ACTIVE goes through `TermService.update` (doc 35 §3; `term-activation.test.ts` 14 tests; E2E at 8 sites). `calendar.service.ts` is the only `UPDATE app.terms` in `backend/src` (pinned). `app_runtime` holds `UPDATE (status)` under forced RLS. A superuser, the table owner or a migration could still write directly (doc 36 §5, doc 37 OD-1) |
| Recommended default | Keep service-level enforcement for M3; defer any database trigger to M7 hardening; add a read-only detection query to the M3 runbook when runbook changes are authorised |
| Alternatives | B: non-locking trigger plus a shared SQL function now. C: a SECURITY DEFINER activation function plus revoking `UPDATE (status)`. D: detection query only |
| Consequences | Default: no change; privileged writers are not stopped. B: migration `0040`, rework of the test fixture that activates terms directly, migration pin updates; the race window stays the same. A *locking* trigger would deadlock against offering publish (doc 36 §5.3). C: changes the least-privilege model |
| Decision owner | Product owner |
| Approval status | **PENDING** |
| Approval date | |
| Rationale | |

### OD-2 — Elective registration

| Field | Content |
| --- | --- |
| Decision ID | OD-2 |
| Question | Is staff-managed elective registration enough for M3, with student and parent self-service as a later capability? |
| Requirement | Part 16 M3: "elective groups with registration windows", "course registrations (… elective choice …)", UI "elective registration"; who registers is not stated |
| Current implementation / evidence | Staff Electives tab; `ELECTIVE_CHOICE` source; window, min/max and capacity enforced in the database for every writer (doc 33 §3). Browser evidence (doc 36 U5). No endpoint resolves a student's own record (doc 33 §11). Doc 35 §5 records staff-managed as an **assistant** decision |
| Recommended default | Staff-managed for M3; self-service stays a future compatible capability (the same registration model, plus a "my record" endpoint and UI later) |
| Alternatives | Student self-service in M3; parent self-service in M3 |
| Consequences | Default: no change; the school collects choices and staff record them. Student self-service: a new endpoint, a student write policy, UI and tests; reopens U5. Parent self-service: also needs guardian authorisation rules that are not specified |
| Decision owner | Product owner |
| Approval status | **PENDING** |
| Approval date | |
| Rationale | |

### OD-3 — Term-lock UI

| Field | Content |
| --- | --- |
| Decision ID | OD-3 |
| Question | Must the M3 term board offer a user-facing "lock term" action? |
| Requirement | Part 16 M3: UI "term board", Tests "term lock". Part 14 `/academics` (`04` line 24) lists "lock term" as an API operation. No explicit user-facing lock control is required (verified in doc 37 OD-3) |
| Current implementation / evidence | `PATCH /academics/terms/:id {status:'LOCKED', reason}` with lock stamp and audit; tested (doc 36 X3). No lock button (doc 36 U2) |
| Recommended default | Defer the UI action; lock through the API during the pilot; record as a documented limitation. The rehearsal must still browser-drive a successful activation (doc 37 BA-03) |
| Alternatives | Build a lock action in M3 |
| Consequences | Default: none. Build: a small UI change with a strong confirmation (LOCKED is irreversible, `0033`) and one more browser check |
| Decision owner | Product owner |
| Approval status | **PENDING** |
| Approval date | |
| Rationale | |

### OD-4 — Faculty workload

| Field | Content |
| --- | --- |
| Decision ID | OD-4 |
| Question | Is a quantitative workload figure part of M3? If so, which metric and which counting rules? |
| Requirement | `04` line 22 (Part 14): `/faculty` "workload view". Part 16 M3: "`/faculty` (assignments)", UI "assignment screen". No metric is defined in any v3 document |
| Current implementation / evidence | `GET /faculty/employees/:id/assignments[?termId=]` plus per-offering timetables. The slot teacher is optional; there is no bell-schedule entity; co-taught slots cannot carry two teachers; substitutes are M4 data (doc 36 §6, doc 37 OD-4) |
| Recommended default | Assignment and timetable views are enough for M3; defer quantitative workload; no formula adopted. **Periods per week** (needs a period definition, not stored) and **contact hours per week** (sum of slot durations, derivable only for slots that name a teacher once counting rules exist) are distinct metrics |
| Alternatives | Scheduled contact hours per week, as of a date, named slots only; periods per week (new schema); delivered load (after M4) |
| Consequences | Default: A4 stays a documented limitation. Contact hours: an aggregation endpoint plus written rules (unnamed slots, co-instructors, substitutes, CLOSED offerings, as-of date). Periods per week: a bell-schedule data model with its own design document |
| Decision owner | Product owner |
| Approval status | **PENDING** |
| Approval date | |
| Rationale | |

### OD-5 — Production Nginx

| Field | Content |
| --- | --- |
| Decision ID | OD-5 |
| Question | Must production Nginx routing be verified to accept M3, or only before production deployment? |
| Requirement | Part 16 M3 names no proxy criterion; M7 holds "Docker prod compose", "pilot go-live" |
| Current implementation / evidence | The routing contract is modelled in `docs/deployment/frontend.md` and checked by `web-api-contract.test.ts`. Verified only through the Vite proxy (E2E). No Nginx run anywhere (doc 36 §4.8) |
| Recommended default | Verify before production deployment; not an M3 functional blocker. **Exception:** if the school walkthrough is served through Nginx, verify on that host first (doc 37 V-24) |
| Alternatives | Verify inside M3 on a staging host |
| Consequences | Default: M7 owns the check. Alternative: one more rehearsal step; no code change expected |
| Decision owner | Product owner |
| Approval status | **PENDING** |
| Approval date | |
| Rationale | |

### OD-6 — Earlier decisions from docs 31–34 (36 items)

| Field | Content |
| --- | --- |
| Decision ID | OD-6 (umbrella; decided item by item below) |
| Question | Confirm or change each implemented or recorded behaviour of docs 31–34 |
| Requirement | Part 16 M3 features they implement; none is a Part 16 criterion by itself |
| Current implementation / evidence | Docs 31 §2–§4, 32 §7, 33 §8, 34 §7; doc 37 §2 OD-6 |
| Recommended default | Per item below. High pilot impact items (31-1, 31-2, 31-3, 31-6, 32-1, 33-1) should be decided before real data is loaded |
| Alternatives / consequences | Per item, in the source documents |
| Decision owner | Product owner |
| Approval status | **PENDING** (umbrella is APPROVED only when every item has a status other than PENDING) |
| Approval date | |
| Rationale | |

**Item fields.** "Rec." = recommended default; "Impact" = pilot impact (H/M/L). Status, Date and Rationale are owner fields. Items whose source document records them as resolved are still **PENDING** here: the owner confirms the resolution.

**Doc 31 (offerings, assignments, timetable):**

| ID | Question | Source | Current implementation | Rec. | Alternatives and consequences | Impact | Owner | Status | Date | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 31-1 | Grade as `period_no` of a programme, or a `grade_levels` table or labelling? | 31 §4 item 1 | `period_no`; one cohort per entry grade; one programme per stream | keep for M3; revisit after the pilot | table: schema change and migration; labelling: settings only | H | Product owner | PENDING | | |
| 31-2 | Whole-audience = `CORE` without a group label | 31 §3, §4 item 3 | implemented (A) | confirm | another definition changes the timetable clash rule | H | Product owner | PENDING | | |
| 31-3 | Slot teacher: optional, required, or inferred PRIMARY? | 31 §3, §4 item 3 | optional; unnamed slots are not teacher-checked | confirm optional; the pilot procedure names a teacher on every slot | required: API and UI change; inferred: re-check of every slot on each new assignment | H | Product owner | PENDING | | |
| 31-4 | A slot must start while its assignment is valid | 31 §3, §4 item 3 | implemented (A) | confirm | relaxing allows slots before a teacher exists | M | Product owner | PENDING | | |
| 31-5 | CANCELLED offerings block nothing | 31 §3 | implemented (A) | confirm | blocking would hold rooms for cancelled classes | L | Product owner | PENDING | | |
| 31-6 | Assignment needs an active primary posting on the offering's campus | 31 §3, §4 item 4 | implemented (A) | confirm | relaxing allows visiting faculty without a posting; changes scope rules | H | Product owner | PENDING | | |
| 31-7 | Only ACTIVE employees can be assigned | 31 §3, §4 item 4 | implemented (A) | confirm | allowing ON_LEAVE needs a cover rule | M | Product owner | PENDING | | |
| 31-8 | Assignment dates lie inside the term | 31 §3, §4 item 4 | implemented (A) | confirm | — | L | Product owner | PENDING | | |
| 31-9 | No two overlapping assignments of one employee on one offering | 31 §3 | implemented (A) | confirm | — | L | Product owner | PENDING | | |
| 31-10 | `academic.offering.manage` and `academic.faculty.assign` held by DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR | 31 §1, §4 item 4 | implemented (A) | confirm | adding HOD: matrix change plus re-seed (PR-3) | M | Product owner | PENDING | | |
| 31-11 | An organisation-wide course without a cohort period is refused | 31 §2, §4 item 4 | implemented (A) | confirm | allowing it creates unscoped offerings | L | Product owner | PENDING | | |
| 31-12 | Lifecycle: derive with no cascade, cascade, or refuse; CLOSED blocks to term end; slots keep an ended teacher; no void | 31 §3a, §4 item 5 | derive, no cascade; CLOSED blocks; no void | confirm for M3; decide CLOSED and void before M4 | cascade: audit per row; void: a new correction model | M | Product owner | PENDING | | |
| 31-13 | Class teacher (homeroom) | 31 §4 items 2, 6 | resolved by doc 32 (`0038`) | confirm the resolution | — | — | Product owner | PENDING | | |
| 31-14 | Repeating a grade / year-back | 31 §4 item 7 | resolved by doc 32 (`0038`) | confirm the resolution | — | — | Product owner | PENDING | | |

**Doc 32 (class teachers and progression):**

| ID | Question | Source | Current implementation | Rec. | Alternatives and consequences | Impact | Owner | Status | Date | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 32-1 | One PRIMARY class per employee at a time | 32 §7 item 1 | implemented (A) | confirm for the school pilot | relaxing serves university class advisors | H | Product owner | PENDING | | |
| 32-2 | Class-teacher writes reuse `academic.faculty.assign` | 32 §7 item 2 | implemented (A) | confirm | a dedicated permission: migration plus re-seed | L | Product owner | PENDING | | |
| 32-3 | No cascade on ON_LEAVE or SEPARATED | 32 §7 item 3 | implemented | confirm for M3 | close rows in the separation flow | L | Product owner | PENDING | | |
| 32-4 | Deactivating a section with an open class teacher is not blocked | 32 §7 item 4 | implemented (A) | confirm | block: one more guard | L | Product owner | PENDING | | |
| 32-5 | Posting checked over the whole validity window | 32 §7 item 5 | resolved by `0039` (doc 33 §9) | confirm the resolution | — | — | Product owner | PENDING | | |
| 32-6 | `DETAINED → COMPLETED` | 32 §7 item 6 | implemented (A) | confirm | a separate final status: migration | M | Product owner | PENDING | | |
| 32-7 | A repeat keeps `period_no`; the target term starts after the source term | 32 §7 item 7 | implemented (A) | confirm against school policy (doc 37 §3.9) | other repetition models: rule change | M | Product owner | PENDING | | |
| 32-8 | Bulk promotion tool | 32 §7 item 8 | resolved: delivered (doc 33 §5), PROMOTE only | confirm the resolution | — | — | Product owner | PENDING | | |
| 32-9 | Period-type-aware labels | 32 §7 item 9 | delivered for cohort-period labels (doc 35 §4) | confirm closed | — | L | Product owner | PENDING | | |
| 32-10 | Doc 31 open items carried forward | 32 §7 item 10 | covered by 31-1 to 31-12 | confirm the cross-reference | — | — | Product owner | PENDING | | |

**Doc 33 (electives, registrations, holidays):**

| ID | Question | Source | Current implementation | Rec. | Alternatives and consequences | Impact | Owner | Status | Date | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 33-1 | No administrative basket registration outside the window | 33 §8 item 1 | implemented | confirm | an override: new rule plus audit | H | Product owner | PENDING | | |
| 33-2 | AUTO_FROM_SECTION is an explicit, re-runnable action | 33 §8 item 2 | implemented | confirm | on publish: lock-order inversion (doc 33 §3) | M | Product owner | PENDING | | |
| 33-3 | Registrations do not cascade | 33 §8 item 3 | implemented | confirm | cascade: audit per row | M | Product owner | PENDING | | |
| 33-4 | `min_select` checked at group close only | 33 §8 item 4 | implemented | confirm | — | L | Product owner | PENDING | | |
| 33-5 | Holiday rules (LOCKED term; no term needed) | 33 §8 item 5 | implemented | confirm | — | L | Product owner | PENDING | | |
| 33-6 | Terminology slots and fallbacks | 33 §8 item 6, doc 35 §4 | implemented | confirm | — | M | Product owner | PENDING | | |
| 33-7 | Checklist items and organisation-only scope | 33 §8 item 7 | implemented | confirm | — | L | Product owner | PENDING | | |
| 33-8 | The promotion tool promotes only | 33 §8 item 8 | implemented | confirm | bulk repeat: new tool | L | Product owner | PENDING | | |
| 33-9 | Class-teacher postings: no re-check when a posting later ends | 33 §8 item 9 | implemented | confirm | re-check: cascade or block | L | Product owner | PENDING | | |

**Doc 34 (student timeline):**

| ID | Question | Source | Current implementation | Rec. | Alternatives and consequences | Impact | Owner | Status | Date | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 34-1 | Should FACULTY see, in the timeline, the registration in their offering? | 34 §7 item 1 | profile-level events only | keep | widen: scope change | L | Product owner | PENDING | | |
| 34-2 | Should a department-scoped holder see history in another department? | 34 §7 item 2 | no | keep | widen: scope change | L | Product owner | PENDING | | |
| 34-3 | Dated history tables for term-enrolment and status transitions? | 34 §7 item 3 | not dated | defer | migration plus writer change | L | Product owner | PENDING | | |

Count: doc 31, 14 items; doc 32, 10; doc 33, 9; doc 34, 3. Total **36**.

## 3. Section B — Pilot readiness findings PR-1 to PR-4

**Category legend:**
- **PD** = product-owner decision.
- **SC** = school confirmation.
- **TI** = technical implementation. A code or schema change; none is performed here.
- **OA** = operational authorisation. Permission to run a procedure on a named environment.

| ID | Finding | PD | SC | TI | OA |
| --- | --- | --- | --- | --- | --- |
| PR-1 | Student and staff accounts | yes | yes | only under option PR-1c, outside M3 | yes (for any real-data environment) |
| PR-2 | Campus-specific programmes | yes | yes (campus and curriculum layout) | no for M3 | no |
| PR-3 | Role re-seeding | yes (when and where) | no | no for M3 (hardening suggestions only) | yes (each environment) |
| PR-4 | Curriculum metadata | yes (accept collection-only) | yes (supplies the metadata) | only if storage is wanted (OD-4) | no |

### PR-1 — Student and staff accounts

**Evidence:**
- **`app.users`** (`0002`): `email` is `NOT NULL`, lower-case, 3–320 characters, unique per tenant. Every person record needs a `users` row.
- **ADR-003:** the account is the login identity; `students` and `employees` are separate role records. One account holds a student record **or** an employee record, never both (`0016`).
- **A student record needs an ACTIVE account.** `StudentService.insertRecord` (`student.service.ts` line 216) refuses any other status with 409. The student import refuses with `ACCOUNT_NOT_ACTIVE`.
- **An employee record does not.** The employee import refuses DEACTIVATED and warns for INVITED or SUSPENDED (`employee-import.adapter.ts` lines 204–221), so staff records can be loaded before the invitation is accepted.
- **The only way into ACTIVE** is accepting an invitation (`app.users_invited_status_guard`, `0028`: `app_runtime` cannot move a user out of INVITED). Acceptance sets a password through `POST /auth/accept-invite` with the e-mailed single-use token (doc 28).
- **Delivery is disabled in production.** `DisabledInvitationMailer` is the production default, so invitations report `FAILED`. Provider, domain, secrets and sandbox are blocked on the owner (doc 28 §4). `InMemoryInvitationMailer` is test-only.
- **What follows:**
  - In the product today, **every student with a student record is an interactive login account** that accepted an invitation sent to a real mailbox.
  - There is no record-only student account, no username login and no account creation by import.
- **MFA:** mandatory for HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR (`mfa-policy.ts`; ADR-004). STUDENT, FACULTY and STAFF are not in the list.
- **Previous E2E rehearsals** created prerequisite accounts directly as the database superuser and marked MFA sessions verified in the throwaway database. That is a labelled test shortcut and was never a product path (doc 36 §4.8).

**Two things to keep apart:**
- **Student record:** what G1 needs: admission number, admission date, programme, enrolment, section, registrations.
- **Interactive student login:** needed only for the student-facing browser steps (doc 37 BA-01c, BA-12c). Part 16 M3 Done does not require pupils to log in.

**Options (none adopted):**

| Option | Description | Category | Constraints |
| --- | --- | --- | --- |
| PR-1a | The school supplies an institution-administered mailbox for every pupil in the pilot roster; pupils are invited and accept as normal | SC + OA; needs a configured mailer (doc 28 §4) or a test mailer on the disposable environment | the addresses must be real, school-controlled and individually assigned; no shared mailbox; consent per §4 C-2 |
| PR-1b | **Pilot subset:** load the full structure (classes, sections, offerings, timetable, staff) but student records only for pupils whose real school-administered mailbox the school supplies; a small consenting set of pupil accounts carries the login steps | SC + OA | G1 then covers the structure in full and the roster only partly; the reviewer must accept that scope in writing (§4 C-5) |
| PR-1c | Product change: record-only student accounts (no login) or a non-e-mail login identifier | PD + TI; schema and auth change; **not M3** | needs its own design and security review; cannot be done by data loading |
| PR-1d | **Disposable rehearsal only:** the operator creates ACTIVE accounts as the database superuser, without a login identity (the shortcut earlier E2E runs used) | OA (explicit, labelled) | the accounts **cannot log in** (no identity, no password), so this neither shares accounts nor bypasses authentication. Not a production path. It still needs a unique e-mail per account, which must come from PR-1a, never invented. Evidence must state the shortcut |

**Forbidden in every option:** inventing or guessing e-mail addresses; using a guardian's or teacher's address for a pupil; one account shared by several people; passwords supplied by the school or written into any file; marking MFA verified outside a throwaway database; weakening `MFA_REQUIRED_ROLES` or the step-up rules.

**Staff:**
- Each staff member uses their own work mailbox and accepts an invitation.
- Admin-class roles complete real TOTP enrolment.
- Employee records may be imported while accounts are still INVITED (warning only).

**Recommendation:**
- For the M3 rehearsal: **PR-1b, with PR-1d used only on the disposable environment** to attach student records to school-supplied mailboxes without sending invitations to pupils.
- **PR-1a** for any later production pilot, once a mailer is configured.
- Record **PR-1c** as a post-M3 product question.

| Decision owner | Approval status | Approval date | Rationale |
| --- | --- | --- | --- |
| Product owner (option); school (addresses, consent) | **PENDING** | | |

### PR-2 — Campus-specific programmes

**Evidence:**
- A programme belongs to a department (`0014`). A department belongs to one campus (`0008`, `campus_id NOT NULL`).
- A cohort period needs a term **on the programme's campus**: `cohort_periods_same_campus_ck` (`0033` §9.3) and doc 24 §3.
- **Shared across campuses (no duplication):**
  - the course catalogue (`courses`, unique `(organization_id, code)`; `owning_department_id` nullable, so a course without an owner is organisation-wide);
  - period types;
  - academic years;
  - employees (one person across campuses; the campus comes from the primary posting);
  - terminology.
- **Per campus (duplicated three times for three campuses):**
  - programmes and their cohorts;
  - curriculum rows (`curriculum_courses`, unique `(program_id, regulation, period_no, course_id)`);
  - terms, cohort periods, sections, offerings, slots and rooms.
  - Terms, cohort periods, sections, offerings, slots and rooms are campus-specific in reality anyway.
- **A campus transfer** closes the student's programme enrolment and opens one in the other campus's programme. Proven in the Task 7 E2E ("second campus with a transfer"); the timeline shows both programmes.

**Assessment.** The rule supports three campuses. The only *harmful* duplication is the **curriculum**: 12 grades × the subject list, repeated per campus programme (and per stream in Grades 11–12). It can drift if one campus's curriculum is edited and the others are not.

**Mitigations without schema change:**
1. One shared course catalogue: subject codes identical on every campus, never per-campus copies of a subject.
2. One `regulation` code (curriculum version) used for all three campuses' curriculum rows.
3. A programme code convention that names the shared curriculum and the campus (e.g. ILLUSTRATIVE `SCH-<campus code>`).
4. A read-only cross-campus curriculum comparison as a validation check on the disposable environment (extends doc 37 V-08): the same `(regulation, period_no, course code)` set per programme.

**Cross-campus reporting** is possible by course (code or `course_id`), by regulation, by `period_no` and by campus. By "programme" it needs the code convention. No reporting module exists in M3 (reports start in M4+).

**Recommendation.** Accept one programme per campus (and per stream) for M3 with mitigations 1–4. Record a shared, multi-campus curriculum model as a post-pilot design question linked to OD-6 31-1. No schema change.

| Decision owner | Approval status | Approval date | Rationale |
| --- | --- | --- | --- |
| Product owner; school confirms the campus and curriculum layout | **PENDING** | | |

### PR-3 — Role re-seeding

**What re-seeding does** (`backend/src/shared/authorization/seed.ts`; `backend/tools/platform/platform-cli.ts`, command `tenant:seed`):

1. For every **system role** of the code matrix (`role-matrix.ts`):
   - Inserts the role if it is missing.
   - **Deletes every `app.role_permissions` row of that role that is not in the matrix.**
   - Upserts the rest, **overwriting** `scope_mode` where it differs.
2. Re-adds `auth.mfa.manage` and `user.account.reset_mfa` (`seedMfaPermissions`, insert-only).
3. **It does not read or change `app.role_assignments`.** Who holds which role, at which scope and for which validity, is untouched.

**Which edits it can remove.** `app_runtime` has no write access to `app.roles` or `app.role_permissions` (`0006` revoked it), so no application path customises role grants. A delete can only remove grants that were added or changed by hand with privileged access.

**Not one transaction.** `tenant:seed` uses an autocommit client: every statement commits on its own.
- While it runs, a role can briefly lack a grant (between its DELETE and its INSERTs).
- A failure part-way leaves some roles re-synced and others not.
- Re-running it is idempotent and completes the sync.

**Permission changes that require re-seeding existing tenants.** These are M3 migrations and matrix changes. A persistent database last seeded before them lacks all of them.

| Permission | Registered by | Roles that receive it (mode) |
| --- | --- | --- |
| `academic.term.manage` | `0033` | CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `academic.course.manage` | `0033` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `academic.section.manage` | `0033` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `enrollment.term.read` | `0033` | STUDENT (SELF); HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `enrollment.term.manage` | `0033` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `academic.offering.manage` | `0037` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `academic.faculty.assign` | `0037` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR (GRANTED) |
| `student.profile.read` — **new FACULTY grant, mode ASSIGNED** (X-12) | matrix change in Batch 3 (doc 33 §2) | FACULTY (ASSIGNED) |
| `student.record.update`, `import.job.manage` (M2, `0035`) | `0035` | DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN, REGISTRAR; `import.job.manage`: COLLEGE_ADMIN, REGISTRAR |

- **Until re-seeded**, the routes answer 403 (fail closed), and faculty keep 403 on student profiles.
- **The persistent development database** is believed to be at migration `0007`, never re-verified. It would need every permission added since M1 (`PROJECT_CONTEXT.md` §5 item 8).
- **New tenants** created by `tenant:create` are seeded on creation and need none of this.

**Rehearsal on a disposable database (no persistent operation):**
1. Create a fresh embedded or throwaway PostgreSQL. `TEST_DATABASE_URL` unset; never `.data/` or `campusos_dev`.
2. Migrate `0001`–`0039` with the contract steps authorised for that database only.
3. Create a tenant. Grant it a snapshot of role grants that represents the target environment, including at least one deliberate hand-made extra grant and one changed `scope_mode`, plus role assignments at ORGANIZATION, CAMPUS and DEPARTMENT scope.
4. Take before-images (read-only): `role_permissions` per role, and `role_assignments` with `count`, `status`, `scope_type`, `scope_id` and validity.
5. Run `tenant:seed --tenant <slug>` against that database only.
6. Compare:
   - `role_assignments` byte-identical;
   - `role_permissions` equal to the matrix;
   - the hand-made extra grant **removed** and the changed `scope_mode` **reset** (both expected);
   - the M3 permissions present for exactly the roles in the table above.
7. Re-run: no change (idempotence).
8. Smoke checks: a CAMPUS_ADMIN reaches the academic routes (200 instead of 403); FACULTY X-12 gives 200 for an assigned student and 404 for others.
9. Existing tests already exercise the seed (`tests/integration/permission-seed.test.ts`, `authorization.test.ts`); run them on the acceptance commit.

**Protecting production assignments and grants (procedure for a later, separately authorised run):**

| Step | Requirement |
| --- | --- |
| Authorisation | a written operator authorisation naming the environment, tenant(s), window and operator |
| Preconditions | migrations applied in order through the M3 set, with their preflights (runbooks `academic-structure-rollout.md`, `students-contract-rollout.md`, `m3b2-…`, `m3-class-teachers-…`, `m3b3-…`); code deployed |
| Backup | a verified database backup (restore tested on a scratch host) **and** a logical export of `app.roles`, `app.role_permissions` and `app.role_assignments` for the tenant(s), taken immediately before the run |
| Drift preflight | a read-only diff of each tenant's `role_permissions` against the matrix; every row the seed would delete or change is listed and approved, or recorded for re-application |
| Run | one tenant at a time, in a low-traffic window; record start and end time and output |
| Verification | the step 6 comparisons on the real tenant; `role_assignments` unchanged (count and checksum); smoke checks as in step 8 |
| Rollback | restore that tenant's `role_permissions` from the export (privileged session, audited by the operator). Assignments never need rollback because they are not touched. Full restore only if the export is unusable |
| Record | a log entry with authorisation reference, before and after counts and checksums, and the outcome |

**Possible hardening (TI, not M3, not performed):** run the seed inside one transaction per tenant, and add a `--dry-run` mode that prints the diff.

**Recommendation.** No persistent re-seed for M3. Rehearse the procedure above on the disposable environment during the M3 rehearsal. Approve the production procedure (backup, drift preflight, export rollback) as part of M7 rollout planning.

| Decision owner | Approval status | Approval date | Rationale |
| --- | --- | --- | --- |
| Product owner (procedure); operator authorisation per environment | **PENDING** | | |

### PR-4 — Curriculum metadata

| Data item | Stored today? | Where / why not | Import path? |
| --- | --- | --- | --- |
| Subject code, title | **Supported** | `courses.code` (`^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$`), `courses.title` | created through the Courses screen or API; no curriculum CSV import |
| Credits | **Supported** | `courses.credits` 0–99.9 | as above |
| Course type (theory / practical / both / …) | **Supported** | `courses.course_type` | as above |
| Attendance tracked | **Supported** | `courses.tracks_attendance` | as above |
| Subject in a grade, category, elective basket code | **Supported** | `curriculum_courses` (`period_no`, `category`, `elective_group_code`, `regulation`) | as above |
| Grade / semester / year number | **Supported** | `curriculum_courses.period_no`, `cohort_periods.period_no` (1–200). **This "period" is the canonical cohort period (a grade or semester), not a timetable period** | as above |
| Periods per year of a programme | **Supported** | `programs.periods_per_year` (e.g. 2 semesters per year). **Not weekly periods** | as above |
| Lesson day and times | **Supported per lesson** | `timetable_slots.weekday`, `start_time`, `end_time`, effective dates | created through the Offerings screen or API |
| **Theory hours** | **Collection-only** | no column on `courses`, `curriculum_courses` or offerings | none |
| **Practical hours** | **Collection-only** | as theory hours | none |
| **Weekly periods** (per subject per grade) | **Collection-only** | no column; checked by the reviewer by counting slots (doc 37 V-08) | none |
| **Bell times** (the school's period schedule) | **Collection-only** | no bell-schedule entity; each slot stores its own times, but nothing stores "period 3 = 09:40–10:20" | none |
| **Timetable period numbering** (period 1, 2, …) | **Collection-only** | slots carry no period number; a double period is one slot with a longer time range | none |

**The only CSV imports** are `STUDENT_RECORDS` (`email`, `admissionNumber`, `admissionDate`, `name`) and `EMPLOYEE_RECORDS` (`email`, `employeeCode`, `employeeType`, `joiningDate`). Nothing in this table can be imported by file.

**Recommendation.** Accept the collection-only items for M3. The school supplies them (doc 37 §3.4, §3.7) for building and reviewing the timetable only. No product screen will show them. Storing any of them is a schema decision tied to OD-4.

| Decision owner | Approval status | Approval date | Rationale |
| --- | --- | --- | --- |
| Product owner; school supplies the metadata | **PENDING** | | |

## 4. Section C — School authorisations

**Decision owner for every item:** the school acceptance authority. The product owner countersigns C-1 and C-2 as data recipient.

**Data minimisation (applies to C-1 and C-2):**
- **Request only** the fields of doc 37 §3.
- **Never request or accept:**
  - passwords, one-time codes, MFA secrets or any credential;
  - students' dates of birth;
  - guardian names, phone numbers or e-mail addresses;
  - home addresses;
  - government or board identifiers (e.g. Aadhaar, APAAR);
  - photographs, medical, caste/category or financial data;
  - staff salary, bank or identity-document data.
- **Personal addresses:** e-mail addresses are school-administered mailboxes (PR-1), never personal ones.
- **If received anyway:** data outside this list is deleted on receipt and the school is told.

| ID | Authorisation | What is authorised | Safeguards | Status | Date | Authorised by (name, role) | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C-1 | Sharing the pilot data | transfer of the doc 37 §3 tables for one term, by a channel the school approves | minimised fields only; encrypted transfer; a named recipient; one stored copy outside any Git repository; checksum recorded (doc 37 §8.3); deletion date agreed in advance | **PENDING** | | | |
| C-2 | Using student and staff records in a test environment | loading the data into the disposable rehearsal environment named by the product owner (environment, host, operator) | not committed to any repository or scratch file kept beyond the rehearsal; access limited to the operator, reviewer and product owner; screenshots and logs as evidence only, stored with the data copy and deleted with it; no third-party service receives the data; the environment is destroyed after sign-off and the destruction recorded | **PENDING** | | | |
| C-3 | Identifying the school-side reviewer | the person who runs the walkthrough and initials D2 and G1 evidence (doc 37 §7) | name and role only | **PENDING** | | | |
| C-4 | Identifying the school-side acceptance authority | the person entitled to sign ACCEPT / ACCEPT WITH CONDITIONS / REJECT for the school | name and role only; may not be the same person as the reviewer if school policy requires separation | **PENDING** | | | |
| C-5 | Approving the one-term pilot scope | campuses, session, the one pilot term, grades and sections included, roster coverage (full or the PR-1b subset), and which browser steps use real pupil logins | written scope, attached to the sign-off sheet | **PENDING** | | | |

**Operator authorisation (product owner, prerequisite to C-2):**

| ID | Authorisation | Status | Date | Authorised by | Rationale |
| --- | --- | --- | --- | --- | --- |
| C-6 | Name the rehearsal environment for real data (disposable or approved non-production), its host, its operator and its destruction procedure; confirm that no persistent or production database is used | **PENDING** | | | |

## 5. Decision dependency map

**Required approvals per stage.** "All OD-6 H-items" = 31-1, 31-2, 31-3, 31-6, 32-1, 33-1.

| Stage | Must be APPROVED (or REJECTED with a recorded alternative) first | Why |
| --- | --- | --- |
| 1. Send the school template (doc 37 §3) | PR-1 (option), PR-2, PR-4 | the template's account, programme and metadata columns depend on them |
| 2. Receive school data | stage 1, plus C-1 and C-3 | lawful transfer and a named school contact |
| 3. Load into the disposable pilot environment | stage 2, plus C-2, C-6, C-5, all OD-6 H-items, OD-2 | where the data may live, what is in scope, and the rules the load will exercise |
| 4. Run the full-term walkthrough | stage 3, plus OD-3, OD-5 (and a verified Nginx if the walkthrough runs behind it), PR-3 (disposable re-seed rehearsal) | what the script tests and on which host |
| 5. Sign off D2 and G1 | stage 4, plus C-4 | only the school authority signs |
| 6. Formally accept M3 | stage 5, plus OD-1, OD-4, OD-6 umbrella (every item decided), and the committed baseline with green CI (doc 36 B-3) | the accepted-limitations list and the reproducible baseline |

**Deferrable without blocking M3** (approving the recommended default *is* the deferral; leaving them PENDING blocks stage 6 only):
- **OD-1:** database trigger deferred to M7.
- **OD-3:** lock UI deferred.
- **OD-4:** quantitative workload deferred.
- **OD-5:** Nginx deferred to production, except the walkthrough-host case.
- **OD-6 M- and L-items:** may be confirmed in one batch before stage 6.
- **PR-1c** (product change) and the PR-3 production procedure: post-M3 / M7.

```
PR-1, PR-2, PR-4 ──► [1 template] ──► C-1, C-3 ──► [2 receive] ──► C-2, C-5, C-6, OD-2, OD-6(H) ──► [3 load]
   ──► OD-3, OD-5, PR-3 (rehearsal) ──► [4 walkthrough] ──► C-4 ──► [5 D2/G1 sign-off]
   ──► OD-1, OD-4, OD-6 (all), commit + CI ──► [6 M3 acceptance]
```

## 6. Approval summary (for quick owner review)

| ID | Subject | Recommended default | Owner | Needed before stage | Status | Date | Initials |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OD-1 | DB-level activation enforcement | service-level for M3; trigger in M7 | Product owner | 6 | PENDING | | |
| OD-2 | Elective registration | staff-managed for M3 | Product owner | 3 | PENDING | | |
| OD-3 | Term-lock UI | defer | Product owner | 4 | PENDING | | |
| OD-4 | Faculty workload | assignment and timetable views; no figure | Product owner | 6 | PENDING | | |
| OD-5 | Production Nginx | verify before production (walkthrough-host exception) | Product owner | 4 | PENDING | | |
| OD-6 | 36 earlier decisions | per item (§2) | Product owner | 3 (H-items), 6 (all) | PENDING | | |
| PR-1 | Accounts | PR-1b, with PR-1d on the disposable environment only | Product owner, school | 1 | PENDING | | |
| PR-2 | Campus programmes | one programme per campus, with mitigations | Product owner, school | 1 | PENDING | | |
| PR-3 | Role re-seeding | disposable rehearsal now; production procedure in M7 | Product owner, operator | 4 | PENDING | | |
| PR-4 | Curriculum metadata | collection-only for M3 | Product owner, school | 1 | PENDING | | |
| C-1 | Data sharing | minimised one-term transfer | School authority | 2 | PENDING | | |
| C-2 | Test-environment use | disposable environment, destroyed after sign-off | School authority | 3 | PENDING | | |
| C-3 | School reviewer | — | School authority | 2 | PENDING | | |
| C-4 | School acceptance authority | — | School authority | 5 | PENDING | | |
| C-5 | One-term pilot scope | — | School authority | 3 | PENDING | | |
| C-6 | Real-data environment | — | Product owner | 3 | PENDING | | |

All 16 summary rows and all 36 OD-6 items are **PENDING**. Nothing is approved by the creation of this document.
