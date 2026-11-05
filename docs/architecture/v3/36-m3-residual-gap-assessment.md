# 36 — M3 residual-gap assessment (after Tasks 1–9)

Status: assessment only, 2026-11-05. No code, schema, migration, test or behaviour change. No Git write. No persistent database. Milestone 4 not started. M3 is **not** accepted by this document.

Canonical source: `04` Part 16, Milestone 3 (Features, Tables, APIs, UI, Depends on, Tests, Done), and the `/faculty` row of the Part 14 domain table (`04` line 22).

## 1. Executive conclusion

1. **Technically ready for a formal acceptance rehearsal: yes, with conditions.** Every Part 16 M3 feature, table, API and test criterion has passing evidence on disposable infrastructure. Four UI items are PARTIAL (§4), mostly because the real browser never drove them, not because they are missing.
2. **Formal acceptance is blocked by two canonical items that need the school:** D2 (walkthrough with the pilot's real curriculum) and G1 (pilot structure loaded for a full term). No code change can close them.
3. **Neither Task 9 technical gap is an M3 blocker:**
   - **Database-level term activation enforcement:** Part 16 does not require it. The readiness rule is a Task 8 product rule, not a canonical criterion. Risk is **Low**. Accept it as a documented limitation (§5).
   - **Quantitative faculty workload:** Part 16 M3 asks for "`/faculty` (assignments)", and that is met. "Workload view" appears only in the Part 14 `/faculty` operation list, which has no milestone, metric or formula. A reliable weekly-period metric needs rules and data the schema does not hold (§6).
4. **Two preconditions that are not Part 16 criteria but that I recommend for any formal sign-off:**
   - The 117-entry uncommitted tree has to be committed, with CI green.
   - Production Nginx routing has to be verified, or explicitly deferred to M7 by the owner.

## 2. Repository state and evidence base

- Branch `main`, HEAD `bd05759704bda5fca37f1d4bf3358cf1e7840cb7` (`feat(web): add student records UI`).
- `git status --short`: 117 entries. 0 staged, 60 unstaged (modified tracked files), 57 untracked. No stash.
- **All of Tasks 1–9 is uncommitted** (B6 fix, migrations `0037`–`0039`, Tasks 2–9 backend and web). No CI has run on this tree.
- **The code tree is the one Task 9 verified.** No status-listed file is newer than the Task 9 final browser log except `PROJECT_LOG.md`, which got the Task 9 entry. So the Task 9 suite results describe the current code. Suites were **not** re-run for this assessment.

### 2.1 Last verified results (Task 9 final code, sequential, disposable embedded PostgreSQL)

**Suites:**

| Suite | Result |
| --- | --- |
| Unit | 47 files / 928 |
| Security + security-db | 45 / 723 |
| Integration | 77 / 1,545 |
| Web | 20 / 347 |

- **Static gates:** typecheck, lint, check:secrets, build, check:bundle and `git diff --check` all exit 0. `format:check` exits 1 only on the Tasks 2–5 `PROJECT_LOG.md` entry, which is append-only and unchanged.

**End-to-end runs.** Fresh disposable database with migrations 0001–0039, the repository's `apps/web/vite.config.ts`, the real backend and headless Chrome 156:

| Driver | Result |
| --- | --- |
| API | 85/85 |
| Task 7 API | 77/77 |
| Task 9 `/faculty` | 21/21 |
| Browser | 48/48 |

The driver logs are in the Task 7–9 session scratchpad (`…/9816acdc-…/scratchpad/e2e/final-{api,t7,fac,browser}.log`). They are outside the repository and temporary, so the next rehearsal must regenerate them (§9).

**Known flakes, not M3 defects:**
- `mfa.test.ts`: concurrent first-admin bootstrap, `[200, 401]` under full-suite load (Task 7).
- A `term-activation.test.ts` timer timeout in one isolated idle run (Task 9). Not reproduced.

### 2.2 Key test files (M3)

| File | Tests | Covers |
| --- | --- | --- |
| `integration/academic-calendar.test.ts` | 39 | years, terms, state machine, sections, memberships, term lock, student RLS |
| `integration/course-offerings.test.ts` | 37 | offerings, snapshot freeze, assignments, room/audience/teacher clashes, races |
| `integration/m3b3-electives-registrations.test.ts` | 37 | elective windows, min/max, registrations, holidays, X-12, promotion tool |
| `integration/class-teachers-and-progression.test.ts` | 15 | class teachers, promote/repeat/detain |
| `integration/academic-setup-wizard.test.ts` | 15 | wizard, terminology, school/college/university |
| `integration/student-timeline.test.ts` | 14 | as-of-date timeline |
| `integration/term-activation.test.ts` | 14 | readiness on PATCH and POST, races, single-writer pin, `/faculty` routes |
| `integration/college-regression.test.ts` | 14 | YEAR + SEMESTER programmes on one campus |
| `integration/m2-acceptance.test.ts` | 16 | M2 dependency |
| `apps/web/tests/academics-offerings-write.test.tsx` | 8 | offering, assignment and slot write UI (fake backend) |
| `apps/web/tests/academics-setup-wizard.test.tsx` | 15 | wizard UI |

### 2.3 Stale continuity instructions (recorded, not rewritten)

- **`PROJECT_CONTEXT.md` §3, §4 item 12, §6 and `TASK_PROMPT.md`** still describe Milestone 2 Batch 2 at `99f7e80` with migrations up to `0036`. The actual state is HEAD `bd05759` and migrations up to `0039`, with M2 B2–B6 and M3 work after them.
  - `PROJECT_CONTEXT.md` §1 still calls the product "for higher education institutions". The owner direction is one platform for schools, colleges and universities.
  - `TASK_PROMPT.md` says "do not start … Milestone 3 Batch 2". That has since been done on instruction.
- **`PROJECT_CONTEXT.md` §7 item 3** asks every task to update `PROJECT_CONTEXT.md` and `TASK_PROMPT.md`. Owner instructions since 2026-11-02 treat both as protected, so they have stayed stale on purpose.
- **The Task 7 acceptance matrix** exists only in that session's report, not in the repository. §4 reproduces and supersedes it.
- **No pilot workbook, CSV or CBSE dataset is in the repository.** Every school structure used so far is synthetic.

## 3. Method

- Every M3 criterion of Part 16 was re-read and mapped to evidence.
- A criterion that names a UI is PASS only if it was driven in a real browser against the real backend. Component tests on the fake backend give PARTIAL.
- A criterion that needs school data is PENDING EXTERNAL INPUT.
- Nothing was waived.

## 4. Updated acceptance matrix

Legend: PASS = verified with evidence. PARTIAL = implemented but incomplete or insufficiently verified. PENDING EXTERNAL INPUT. NOT VERIFIED. FAIL = demonstrable defect. **No item is FAIL.**

### 4.1 Features (F)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| F1 | Academic years | PASS | `academic-calendar`; E2E school/college/university |
| F2 | Terms (free codes, state machine) | PASS | `0033` `terms_guard`; `academic-calendar`; `term-activation` |
| F3 | Cohort periods | PASS | `academic-calendar`; E2E |
| F4 | Sections | PASS | `academic-calendar`; browser class create |
| F5 | Courses | PASS | `0033`; E2E subjects |
| F6 | Curriculum courses | PASS | `0033`; wizard step 6 |
| F7 | Elective groups with registration windows | PASS | `m3b3` (37); E2E window/min/max |
| F8 | Course offerings (snapshots) | PASS | `course-offerings` snapshot freeze |
| F9 | Faculty assignments | PASS | `course-offerings`; `/faculty` E2E 21/21 |
| F10 | Term enrolments | PASS | E2E placement; progression tests |
| F11 | Section memberships | PASS | E2E move with history |
| F12 | Course registrations: auto-from-section, elective choice, admin-assigned, backlog | PASS | E2E for the first three. BACKLOG only in integration (`m3b3`) |
| F13 | Timetable slots | PASS | room/audience/teacher clashes, integration and E2E |
| F14 | Holidays | PASS | E2E; browser form writes the row |
| F15 | Promotion tool | PASS | API dry run, commit, replay, rows kept. Bulk promotion has no UI (Part 16 does not list one) |
| F16 | Setup checklist | PASS | counts match the database; browser: no checkboxes |
| F17 | Terminology via settings | PASS | Task 8 editor, `periodTypes` (YEAR + SEMESTER in one college); browser: preset saved through step-up, page relabelled. Was PARTIAL in Task 7 |

### 4.2 Tables and layout (T)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| T1 | All 14 canonical M3 tables | PASS | `0033`, `0037`, `0039` (`section_class_teachers` in `0038` is extra) |
| T2 | M3 data tables at 390 px (scroll inside the wrapper, no page overflow) and 1280 px | PASS | browser 48/48: five tables, wizard, profile and timeline |

### 4.3 APIs (A)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| A1 | `/academics` | PASS | API E2E 85/85 |
| A2 | `/students` enrolment endpoints | PASS | E2E; progression, timeline |
| A3 | `/faculty` (assignments) | PASS | Task 9: `GET`/`POST /faculty/employees/:id/assignments`; `term-activation` 4 tests; E2E 21/21. Was PARTIAL in Task 7 |
| A4 | `/faculty` "workload view" (Part 14, not an M3 Done item) | PARTIAL | Assignment list with offering and term only; no quantitative load (§6). The web client does not call the endpoint |

### 4.4 UI (U)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| U1 | Setup wizard | PASS | Task 8; browser: 8 wizard checks (13 steps, review, activation state, terminology). Was PARTIAL in Task 7 |
| U2 | Term board | PARTIAL | Browser: real terms listed, and an unready activation is refused with fixed wording. Gaps: a successful activation from the UI was not browser-driven (8 activation sites were API-driven), and the UI has no lock action (the lock API exists and is tested, X3) |
| U3 | Section allocation | PARTIAL | Browser: class created through the form, duplicate refused. Student placement and move were proven only through the API E2E and component tests |
| U4 | Offerings grid | PASS | browser, school data, 390/1280 px |
| U5 | Elective registration | PASS (staff workflow) | Browser: a staff member records a choice and a second choice is refused. No student self-service; doc 35 §5 records that as an assistant decision, so the owner must confirm it (§8 OD-2) |
| U6 | Assignment screen | PARTIAL | `academics-offerings-write.test.tsx` 8/8 on the fake backend only; never driven in a real browser |
| U7 | Student timeline | PASS | browser as-of view; `student-timeline` 14 |
| U8 | Timetable viewer | PASS | browser offerings/timetable with real data (2026-11-02 and Task 7 runs) |
| U9 | Offering and timetable-slot write UI (Tasks 2–5; part of "offerings grid" and "timetable CRUD") | PARTIAL | component tests only; not browser-driven against the real backend |

### 4.5 Dependencies (D)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| D1 | Depends on M2 | PASS | `m2-acceptance` 16/16 (in integration 1,545) |
| D2 | Walkthrough with the pilot's real curriculum (re-review gate) | PENDING EXTERNAL INPUT | no school data in the repository (§7) |

### 4.6 Canonical tests (X)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| X1 | Overlap exclusion constraints | PASS | `course-offerings` (37), `academic-calendar` |
| X2 | Section-change history | PASS | E2E move; timeline |
| X3 | Term lock | PASS | `academic-calendar`, `course-offerings`, `m3b3` |
| X4 | Promotion without mutation | PASS | E2E: rows kept |
| X5 | Offering snapshot freeze | PASS | `course-offerings` |
| X6 | Elective min/max/window validation | PASS | `m3b3`; E2E |
| X7 | Real ASSIGNED resolver matrix (X-12) | PASS | `m3b3`; E2E 9 checks; browser assigned/unassigned |
| X8 | Student-self RLS on new student tables | PASS | security-db `m3b3`, `academic-calendar` |

### 4.7 Done criteria (G)

| # | Criterion | Status | Evidence / gap |
| --- | --- | --- | --- |
| G1 | Pilot structure loaded for a full term | PENDING EXTERNAL INPUT | Synthetic school loaded (3 campuses × Grades 1–12 × 4 sections in the wizard tests). The real one is not available |
| G2 | Per-student course sets differ correctly | PASS | E2E electives and registrations (synthetic data). Re-check with the real roster during G1 |
| G3 | Timeline matches "as of date" fixtures | PASS | `student-timeline`; browser as-of view |
| G4 | All S-gates still green | PASS | security 45/723 (Task 9). The MFA integration flake is separate |

### 4.8 Cross-cutting checks requested for this assessment

| Check | Status | Evidence / gap |
| --- | --- | --- |
| Production Nginx | NOT VERIFIED | No Nginx binary and no Docker on this machine. The rule is only modelled in `docs/deployment/frontend.md` and checked by `unit/web-api-contract.test.ts`. The Vite proxy path is verified (E2E) |
| College annual and semester coexistence | PASS | `college-regression` 14; Task 7 E2E 17 checks (B.Com YEAR + BCA SEMESTER); programme-aware labels (Task 8); five college terms activated (Task 9) |
| University semester workflows | PASS | E2E: electives, drop/withdraw/history, second-campus activation, timeline |
| Tenant and campus isolation | PASS | E2E cross-tenant reads/writes 404; campus/department scope 404s; security-db RLS suites; `/faculty` per-offering scope test |
| Term activation integrity (service level) | PASS | `term-activation` 14 (PATCH = POST, If-Match order, date-change re-check, races, single-writer pin); E2E all 8 sites |
| Term activation integrity (database level) | Not required by Part 16; documented limitation | §5 |
| Faculty workload (quantitative) | PARTIAL | not an M3 Done criterion; needs rules (§6) |
| CI on the acceptance tree | NOT VERIFIED | 117 uncommitted entries; precondition B-3 (§8) |
| Real TOTP sign-in in E2E | NOT VERIFIED | E2E marks MFA sessions as verified directly in the throwaway database (test shortcut) |

**Totals: 55 rows.**
- 43 PASS (including U5 on the staff workflow).
- 6 PARTIAL: A4, U2, U3, U6, U9, workload.
- 2 PENDING EXTERNAL INPUT: D2, G1.
- 3 NOT VERIFIED: Nginx, CI, real TOTP.
- 1 documented limitation: database-level activation enforcement.
- 0 FAIL.

## 5. Database-level term activation enforcement

### 5.1 Facts

**Privileges on `app.terms` (`0033` lines 855–867, 977–982; `backend/tools/db/bootstrap.ts`):**

| Role | How it can write `app.terms` | Who uses it |
| --- | --- | --- |
| `app_runtime` | `UPDATE (name, start_date, end_date, status, locked_at, locked_by)` and `INSERT`. Forced RLS: tenant (`organization_id = current_tenant_id()` and `context_ok()`), plus RESTRICTIVE `current_actor_kind() = 'STAFF'`. `NOSUPERUSER NOBYPASSRLS`, no ownership, no DDL | The Fastify application, only through `db.withTenant` (static lint gate against direct pool imports) |
| `app_migrator` | Owner of the schemas and tables. FORCE RLS applies to the owner and no policy targets it, so plain DML sees and changes no rows. As owner it could still `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, disable triggers, or write through a migration | `backend/tools/db/migrate.ts` only, which refuses any other role |
| Superuser (e.g. `campusos_admin` in `infrastructure/docker/docker-compose.yml`, the test harness `adminQuery`) | Bypasses RLS. Triggers still fire unless `session_replication_role = replica` | Bootstrap, dev, CI and test fixtures (`tests/support/term-fixture.ts`), and operators in production |

**Database guards that already apply to every writer (`app.terms_guard`, `0033` §9.2):**
- Forward-only transitions (PLANNED → ACTIVE → CLOSED → LOCKED).
- ACTIVE only inside an ACTIVE academic year.
- Dates frozen after PLANNED.
- Identity columns immutable.
- LOCKED rows immutable.
- Lock stamp consistency.

**What is service-only:**
- The Task 8/9 readiness rules: ACTIVE campus, an active cohort period, at least one PUBLISHED offering, and every published offering staffed to the term end.
- They live in `term-readiness.ts` and are applied by `TermService.update` on every PLANNED → ACTIVE.

**The application path:**
- `calendar.service.ts` is the only `UPDATE app.terms` in `backend/src`. This is pinned by `term-activation.test.ts`, "the only SQL writer of app.terms is TermService".
- No writer exists in `backend/tools`, `scripts` or the migrations after `0033`.
- **Pin limitation:** the pin scans `backend/src` for the literal `UPDATE app.terms`. It would not catch quoted identifiers, generated SQL, or a writer under `backend/tools`.

### 5.2 Exploitability

**Through HTTP: none known.**
- Every route that changes a term goes through `TermService.update`.
- Both activation routes were proven identical (tests and E2E).

**Writing `status = 'ACTIVE'` on an unready term needs one of these:**
- (a) Arbitrary SQL as `app_runtime` with a STAFF context, which already means application compromise, and far more damaging writes would be open.
- (b) A future code path that bypasses `TermService`. This is a regression risk, partly covered by the pin.
- (c) A superuser or owner session: an operator, a seed script or a migration.

**Impact of an unready ACTIVE term:**
- A running term without published or staffed offerings: students without classes, and M4 attendance sessions with no teacher.
- It is operational inconsistency, not data loss, a privilege gain or a tenant breach.
- It can be recovered: offerings can still be published and staffed in an ACTIVE term.

### 5.3 Can a trigger validate readiness correctly?

**Feasible, with the same guarantees as the service and no stronger ones:**
- A `BEFORE UPDATE` branch of `terms_guard` (PLANNED → ACTIVE) can run the readiness counts. As SECURITY INVOKER under `app_runtime`, RLS gives it the tenant's rows. Under a superuser, the explicit `organization_id` predicates still scope it.
- Single source of truth: the rule must not be duplicated in TypeScript and PL/pgSQL. Move the counts into one SQL function (e.g. `app.term_readiness(org, term)`) that both the trigger and `term-readiness.ts` call. Otherwise the two drift.

**Concurrency under READ COMMITTED:**
- The readiness subqueries see committed rows at statement start.
- **Offering publish and cancel** lock the term `FOR SHARE` (`course_offerings_guard`, `0037` line 176). That conflicts with the activation's row lock, so they serialise (tested: "activation racing the cancellation …").
- **Ending a faculty assignment** locks the offering `FOR UPDATE` but not the term (`faculty_assignments_guard`, `0037` line 306). It can therefore commit just after the readiness read. Doc 35 §3 classifies this as benign, equivalent to "activate, then end", and a trigger would have the same window.
- **Cohort-period and campus deactivation:** I did not prove these serialise with activation either, and the same applies to the service.

**Making the trigger strict would create a deadlock cycle:**
- It would have to lock the child rows: offerings `FOR SHARE`, assignments.
- Activation holds the term and asks for the offering. An offering publish holds the offering and asks for the term `FOR SHARE`.
- That is a lock-order inversion (deadlock `40P01`), contrary to the top-down lock order of `PROJECT_CONTEXT.md` §2.
- **A strict invariant is not achievable without a redesign.** Readiness is a gate at activation time, not an invariant of running terms.

**Superuser bypass:**
- A trigger stops superuser `UPDATE`s unless `session_replication_role = replica` is set or the trigger is dropped.
- The test fixture `activateTermFixture` relies on activating unready terms. It is used by `academic-calendar`, `academic-calendar-routes`, `student-timeline` and `college-regression`, so every one of those tests would need fully staffed terms or a labelled bypass.

### 5.4 Alternatives considered

| Option | Effect | Cost / risk |
| --- | --- | --- |
| A. Keep service enforcement and document it (current) | All application paths covered; pinned | Raw and privileged writers are not stopped (same as several other service-only rules, e.g. `STUDENT`-role grants, `PROJECT_CONTEXT.md` §5 item 14) |
| B. Trigger branch in `terms_guard`, shared SQL function, no child locks | Also stops raw `app_runtime`, migration and superuser writes (unless replica mode) | New migration `0040` (`CREATE OR REPLACE` of `terms_guard`, new function); `term-readiness.ts` must call the function; fixture rework in 4+ test files; the 6 migration-list pins, schema-linter, roles-and-privileges and authorization-rls guard list need updating; same race window as A |
| C. Revoke `UPDATE (status)` from `app_runtime`, activate only through a SECURITY DEFINER `app.activate_term()` | Narrows the runtime privilege | Changes the least-privilege model; definer functions owned by `app_migrator` need careful RLS/`search_path` handling; still does not stop the owner or a superuser; larger change than B |
| D. Periodic read-only consistency query (operator preflight / post-check) | Detects unready ACTIVE terms whoever wrote them | Detection, not prevention; fits the existing runbook pattern |

**Migration and rollout implications of B:**
- Forward-only. Existing ACTIVE terms are not re-checked.
- It runs behind the contract gate chain like `0033`–`0039` (deferred until `0019` is applied).
- `CREATE OR REPLACE FUNCTION` takes a brief lock. The trigger itself is unchanged, so there is no table rewrite.
- **Rollback** means a further forward migration restoring the `0033` body. There are no down migrations.
- Lock time unmeasured, as for every migration since `0008`.

### 5.5 Recommendation

| Item | Assessment |
| --- | --- |
| Risk severity | Low |
| Exploitability | Not exploitable through the API. Needs application compromise, a future regression, or a privileged operator |
| M3 blocker | **No.** Part 16 M3 lists "terms (free codes, state machine)" and the "term lock" test. Neither names activation readiness, which was introduced by Task 8 |
| Preferred remediation | **A + D now:** keep the service enforcement, document it as an M3 limitation, and add the read-only "unready ACTIVE terms" query to the M3 rollout runbook when the owner next authorises runbook changes. **B only if the owner wants database defence in depth**, ideally in the M7 hardening pass. Never a locking trigger (§5.3) |
| Migration / operational implications | A + D: none. B: §5.4 |

## 6. Quantitative faculty workload

### 6.1 Exact canonical requirement

- **`04` line 22 (Part 14 domain table):** `/faculty` — resources "employee, posting, assignment view"; common operations "create, post to department, assign offerings, **workload view**".
- **`04` Part 16, Milestone 3:** APIs "`/faculty` (assignments)". UI "assignment screen". Done criteria name no workload.
- **No v3 document defines workload:** no metric, no unit, no formula. The term is absent from docs 01–35, except doc 35 §5, which records it as open.
- The superseded v1 spec has an HOD goal, "monitor faculty workload", and a dashboard tile "Faculty Workload [View Timetable]". That points at a per-teacher timetable, not a number.
- **Conclusion:** workload is a Part 14 capability with no milestone, metric or rule. It is **not** an explicit M3 Done criterion. Whether M3 needs it is **inferred**, not stated.

### 6.2 What exists now

- **`GET /api/v1/faculty/employees/:id/assignments[?termId=]`:**
  - Returns each assignment (role PRIMARY/CO_INSTRUCTOR/LAB_INSTRUCTOR/SUBSTITUTE, `validFrom`/`validTo`), plus `termId`, `offeringCode`, `offeringTitle` and `offeringStatus`.
  - Scoped by employee rules and per-offering scope.
- **`timetable_slots` (`0037`):**
  - Columns: `course_offering_id`, optional `room_id`, **optional `faculty_assignment_id`**, `weekday` 1–7, `start_time` < `end_time`, `effective_from`, optional `effective_to`.
  - Only `effective_to` is updatable.
- **Supporting rules:**
  - Teacher clash only for slots naming an assignment.
  - Open slots are bounded by their term, and CANCELLED offerings block nothing.
  - Two slots of the same offering never overlap (audience rule: `so.id = NEW.course_offering_id`).
- **`courses`:** `credits` and `course_type` (THEORY, PRACTICAL, THEORY_PRACTICAL, …). No lecture/tutorial/practical hours.
- **`curriculum_courses`:** no periods-per-week.
- **Not present:** a bell schedule or period-length entity, a planned teaching norm, `class_sessions` (M4).

### 6.3 Can weekly load be derived reliably?

**Contact time per week:** derivable by aggregation for **slots that name a teacher**.
- For an employee E and a reference week or date D: sum `end_time - start_time` over slots with `faculty_assignment_id → assignment.employee_id = E`, where the slot is effective on D, the assignment is valid on D, and the offering is not CANCELLED.
- This needs no schema change. It is not reliable as a complete figure, because:

1. **`faculty_assignment_id` is optional.** Slots without it are attributable to nobody. Inferring the PRIMARY is a rule no document states (doc 31 §4 item 3 lists the three options as an open owner decision).
2. **Periods per week cannot be derived.** There is no bell schedule. A double period stored as one 80-minute slot counts as one slot, and nothing says how long "a period" is.
3. **Co-instructors.** A slot names one assignment, and the same offering's slots cannot overlap, so a co-taught slot cannot carry two teachers. Co-instructor load is invisible or attributed to one person.
4. **Lab instructors.** These work only when the lab is its own `LAB_GROUP` offering with its own slots. That is a modelling convention, not a rule.
5. **Substitutes.**
   - A SUBSTITUTE assignment is date-bounded, and a slot cannot be re-pointed (`faculty_assignment_id` is immutable), so it needs its own slot rows.
   - Doc 02 line 452 records actual substitution in `class_sessions.conducted_by` (M4).
   - Delivered load is therefore M4 data.
6. **Date ranges.** Load changes inside a term (ended assignments, ended slots, mid-term starts), so any figure needs an as-of date or a named week.
7. **Holidays.** They reduce delivered sessions but not the scheduled weekly pattern. Which of the two is "workload" is undefined.
8. **CLOSED offerings.** They keep blocking until term end (doc 31 §4 item 5, open). Counting them is a policy choice.

### 6.4 Metric options (no formula is adopted here)

| Metric | Derivable today | Needs |
| --- | --- | --- |
| Assignments per teacher per term (count by role) | yes (already listed) | nothing |
| Scheduled slots per week per teacher (as of D) | yes, for named slots | owner rule for unnamed slots and CLOSED offerings |
| Scheduled contact hours per week (as of D) | yes, for named slots | the same rules, plus a decision on co-instructor and substitute attribution |
| Periods per week (school norm, e.g. against a teaching limit) | **no** | a bell schedule / period definition (new schema) or a stated minutes-per-period rule |
| Delivered load (sessions actually taught) | **no** | M4 `class_sessions.conducted_by` |
| Planned versus scheduled load (curriculum hours) | **no** | L-T-P or weekly-period fields on courses or curriculum (new schema) |

### 6.5 Recommendation

| Item | Assessment |
| --- | --- |
| Canonical requirement | Part 14 "workload view" (no milestone, no metric); M3 requires "`/faculty` (assignments)" only |
| Exists | assignment view by teacher and term; weekly slot data with optional teacher link |
| Missing | any quantitative figure; rules for unnamed slots, co-instructors, substitutes, CLOSED offerings and as-of date; a period definition |
| Blocks M3 | **No**, unless the owner rules that the Part 14 workload view belongs to M3 |
| Minimum acceptable M3 scope | The existing assignment view (A3) plus the existing per-offering timetable, documented as "workload view = assignment and timetable view; quantitative load deferred". This matches the only concrete source (v1: "Faculty Workload [View Timetable]") |
| If the owner wants a number in M3 | Decide OD-4 first (§8). The smallest defensible step is **scheduled slots and contact hours per week, as of a date, for named slots only**, reporting the count of unnamed slots separately rather than guessing. Aggregation only, no schema. Periods per week needs the school's bell schedule and is out of reach without new schema |

## 7. External school-input checklist

Nothing below may be invented or taken from the earlier illustrative examples. None of this is in the repository.

### 7.1 Required for D2 and G1

1. **Institution and campus:**
   - Legal name.
   - Each campus with its code, address and IANA timezone (validated against `pg_timezone_names`).
   - Departments or wings used for staff postings and scope.
2. **Academic session and terms:**
   - Session start and end dates.
   - Term or exam-cycle structure, with codes, names and dates for **one complete term** at least.
   - Which term is the pilot term.
3. **Grade structure:**
   - The grades actually offered (1–12 or a subset).
   - Entry grades: intakes other than Grade 1 need one cohort per entry grade (`intake_code`, doc 31 §4 OD-5).
   - Whether Grades 11–12 streams are separate programmes.
4. **Subjects and curriculum per grade:**
   - Code, name and type (theory / practical / both).
   - Credits, if the school uses any (otherwise the value 0 must be confirmed).
   - Whether attendance is tracked per subject.
   - Weekly periods, which is needed to build and check the timetable (it is not stored as curriculum data today, §6.2).
   - Theory and practical hours, if the school wants them recorded (no field today).
5. **Grade 11–12 streams and electives:**
   - The streams.
   - Compulsory and elective or optional subjects per stream.
   - Each elective basket's minimum and maximum choices.
   - Capacity per elective offering.
   - Selection window dates.
   - Whether choices need approval.
6. **Sections:** names per grade and capacities.
7. **Teachers:**
   - Name, login e-mail and employee code (`[A-Za-z0-9][A-Za-z0-9_-]{0,49}`).
   - Employee type and joining date.
   - Department.
   - **Primary campus posting with its start date**: assignment and class-teacher rules require an active posting on the section's campus.
8. **Subject teaching assignments:**
   - Per section and subject, the teacher and role (PRIMARY / CO_INSTRUCTOR / LAB_INSTRUCTOR / SUBSTITUTE).
   - Start date, and end date where the assignment is shorter than the term.
9. **Class teachers:** one PRIMARY per section, optional assistants, start dates.
10. **Pilot roster for one complete term:**
    - Each student's account e-mail, admission number, name and admission date.
    - Programme and cohort placement.
    - Grade and section.
    - Elective choices for Grades 11–12.
    - Guardian data only if the pilot requires it.
11. **Named institutional reviewer and acceptance authority:**
    - The person who runs the walkthrough.
    - The person who signs D2 and G1, and in what form (written sign-off).

### 7.2 Required for a timetable walkthrough (U8, U9 with real data)

12. **Timetable rules:** teaching days, the number of periods per day, bell times (start and end of each period, breaks), and double periods.
13. **Rooms:** code, kind and capacity, plus the room for each section and each lab.
14. **A weekly timetable per section**, or the school's acceptance that a representative subset of grades is timetabled for the pilot.

### 7.3 Optional (recommended; does not block D2 or G1)

15. Holiday calendar for the pilot term: organisation-wide and per campus.
16. Promotion and detention policy: who decides, and the repeat rules. Not needed for a single-term pilot; needed before the session ends.
17. Institution terminology: labels for programme, cohort, period, section, term and course (e.g. Class/Grade/Section/Subject/Session). The defaults or the school preset work without it.
18. Any teaching-load norm the school applies (periods per week per teacher). Needed only if OD-4 makes workload an M3 item.

## 8. Blocker and decision register

### 8.1 Blockers to formal M3 acceptance

| ID | Item | Kind | Closes by |
| --- | --- | --- | --- |
| B-1 | D2: walkthrough with the pilot's real curriculum | canonical; school data | §7.1 inputs, reviewer session, signed record |
| B-2 | G1: pilot structure loaded for a full term | canonical; school data | load §7.1 data through the product, verify on a disposable or approved environment |
| B-3 | Acceptance baseline is an uncommitted tree with no CI | process precondition (recommended) | owner reviews and commits the 117 entries; CI green on that commit |

### 8.2 Partials that need evidence or an owner decision

| ID | Item | Recommended action |
| --- | --- | --- |
| P-1 | U6 assignment screen, U9 offering/slot write UI: real-browser evidence missing | add browser checks against the real backend at the next rehearsal (no code expected) |
| P-2 | U3 placement and move in the UI not browser-driven | as P-1 |
| P-3 | U2 term board: no lock action in the UI; successful activation not browser-driven | browser-drive the successful activation; owner decides whether "lock term" needs a UI in M3 (OD-3) |
| P-4 | Production Nginx not verified | verify on a host with Nginx (staging), or owner defers to M7 (OD-5) |
| P-5 | A4 / workload | owner decision OD-4 |

### 8.3 Owner decisions

| ID | Decision | Default recommended here |
| --- | --- | --- |
| OD-1 | Database-level activation enforcement: documented limitation (A + D) or migration B | A + D for M3; B optional in M7 |
| OD-2 | Elective registration: staff-managed for the school pilot (doc 35 §5, an assistant decision) | confirm |
| OD-3 | Term lock in the UI as M3 scope | accept as limitation (API exists and is tested) |
| OD-4 | Is the Part 14 "workload view" in M3, and with which metric and rules (§6.3 items 1–8) | not in M3; assignment and timetable view only |
| OD-5 | Production Nginx verification inside M3 or in M7 | verify before the school walkthrough if the walkthrough runs behind Nginx; otherwise M7 |
| OD-6 | Earlier open decisions still unconfirmed: doc 31 §4 (OD-5 grade levels, audience/teacher (A) rules, CLOSED offerings, no void); doc 32 §7; doc 33 §8; doc 34 §7 | confirm or change before G1, because the real data exercises them |

### 8.4 Documented limitations proposed for acceptance

- Readiness enforced in the service only (§5).
- No quantitative workload (§6).
- No bulk-promotion UI.
- Term-enrolment status changes undated (doc 34 §6).
- No student self-service elective screen.
- All guard refusals share one `CONFLICT` code.
- The setup wizard does not remember the last step (security pin).

## 9. Minimum acceptance recommendation and next steps

### 9.1 Answers

1. **Technically ready for a formal acceptance rehearsal?** Yes, once P-1 to P-3 are run as browser checks in the same rehearsal. No implementation is expected for them.
2. **Genuine blockers:** B-1 and B-2 (school data). B-3 is recommended as a process precondition.
3. **Can be accepted as documented limitations:** database-level activation enforcement, quantitative workload, term lock UI, bulk-promotion UI, student self-service electives, and the §8.4 list.
4. **Need owner decisions:** OD-1 to OD-6.
5. **Depend on school data:** D2, G1, the real-data re-check of G2, and U8/U9 with a real timetable.
6. **Evidence the next rehearsal must collect:** §9.4.

### 9.2 Closure path 1: minimum defensible M3 acceptance scope

1. The owner records OD-1 = A + D, OD-2 = confirm, OD-3 = accept limitation, OD-4 = not in M3, OD-5, and OD-6.
2. The owner commits the tree; CI is green (B-3).
3. The school supplies §7.1 (and §7.2 if timetabling is part of the walkthrough).
4. Rehearsal on a fresh disposable database (or an approved non-production environment): load the real structure through the product, run the existing drivers, add browser checks for U2 activation, U3, U6 and U9, and verify Nginx or record the deferral.
5. The school reviewer walks through the structure and signs D2 and G1.
6. An acceptance record cites every §4 row as PASS or as an accepted limitation.

### 9.3 Closure path 2: full M3 scope (workload and database enforcement required)

All of path 1, plus:

1. **OD-4 metric decided in writing:**
   - The unit.
   - The rule for slots without a teacher (keep optional / require / infer PRIMARY).
   - Co-instructor and substitute attribution.
   - CLOSED offerings.
   - The as-of date semantics.
   - For periods per week: the school's bell schedule and a new schema to hold it, with its own design document.
2. **Implement the workload aggregation:**
   - Endpoint on `/faculty`, scoped exactly like the assignment view.
   - Tests for each counting rule.
   - Web view.
3. **Migration `0040` for OD-1 = B:**
   - Shared `app.term_readiness` SQL function called by `term-readiness.ts` and `terms_guard`, without child-row locks.
   - Fixture rework.
   - Migration pin updates.
   - Runbook preflight and post-check.
   - Mutation checks.
4. Re-run the full suites and the E2E, then the path 1 rehearsal.

### 9.4 Evidence the next rehearsal must collect

**Baseline:**
- Commit hash and CI run.
- Exact `git status`.
- Suites run one after another: unit, security, integration, web, plus static gates.
- Logs saved somewhere durable: the current E2E logs are in a temporary session scratchpad.

**Real-data load:**
- Counts per entity, compared with the school's own sheet: campuses, grades, sections, subjects, teachers, assignments, class teachers, students, registrations.
- Setup wizard state.
- Each pilot term's readiness and activation outcome.

**Per-student checks:**
- Course sets for a sample of Grade 11–12 students, compared with their chosen electives (G2 on real data).
- Timeline as-of checks for at least one moved student.

**Browser, against the real backend:**
- U2 successful activation.
- U3 placement and move.
- U6 assign, then end, an assignment.
- U9 create and publish an offering, and add and end a slot, including one refused clash.
- 390 px checks for every new screen.

**Isolation:** cross-tenant and cross-campus 404 checks on the real data.

**Nginx:** the routing contract (`/api/v1/*` forwarded unchanged; `/api/auth/*` and `/api/me/mfa*` with `/api` stripped) on a real Nginx, or the owner's written deferral.

**Sign-off:** the reviewer's name, date and written record for D2 and G1, plus any defects found, each logged before it is fixed.

### 9.5 Exact next steps

1. Owner decides OD-1 to OD-6 (§8.3).
2. Owner reviews and commits the uncommitted tree; confirm CI.
3. Send the §7 checklist to the school and name the reviewer.
4. Prepare the rehearsal drivers for P-1 to P-3 (test-only, scratchpad or repository as the owner prefers).
5. Run the rehearsal (§9.4) when the school data arrives.
6. Do not start M4 before the owner records M3 as accepted.
