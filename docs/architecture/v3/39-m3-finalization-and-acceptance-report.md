# 39 — M3 finalisation and acceptance report

Status: finalisation campaign of 2026-11-05. All work is uncommitted; the owner reviews and commits.
- Disposable databases only. No persistent or production database was accessed.
- No Git write. Milestone 4 not started.
- **This report does not accept M3.** Only the product owner and the school's acceptance authority can.

Inputs:
- `04` Part 16 (canonical, unchanged).
- Docs 31–35, the residual-gap assessment (doc 36), the readiness pack (doc 37) and the decision register (doc 38).

## 1. Executive outcome

**Outcome: ACCEPTANCE-READY.**
- Every technical M3 requirement of Part 16 is verified on disposable infrastructure, including a real browser against the real backend. The four UI items doc 36 left PARTIAL (U2, U3, U6, U9) now pass in the real browser.
- **One real defect was found and fixed:** closing a course offering from the UI always failed against the real backend. It is described in §3.
- **What remains is external or a decision, not technical:**
  - the school data and sign-off for D2 and G1;
  - the owner decisions OD-1 to OD-6, the 36 OD-6 items and PR-1 to PR-4 (all PENDING in doc 38);
  - the school authorisations C-1 to C-6;
  - a committed baseline with green CI;
  - production items that belong to M7.

## 2. Part 16 traceability matrix

**Columns:** API = API driver or integration test. UI = a screen exists. Browser = driven in a real browser (headless Chrome 156) through the repository's `vite.config.ts` against the real backend. Sch / Col / Uni = school, college and university regression. Sec = security or isolation evidence.

**Evidence keys:**
- **E1:** API driver 85/85.
- **E2:** Task 7 driver 77/77.
- **E3:** `/faculty` driver 21/21.
- **E4:** the existing browser driver 48/48.
- **E5:** the new browser driver 26/26.
- **E6:** the third-campus prep (all over HTTP).
- **Suites:** §7.

| ID | Requirement (Part 16 M3) | API | UI | Browser | Sch | Col | Uni | Sec | Status | Remaining |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Academic years | E1, `academic-calendar` | Calendar | E4 | yes | yes | yes | RLS suites | PASS | — |
| F2 | Terms (free codes, state machine) | E1, `term-activation` | Calendar | E4, E5 | yes | yes | yes | scope 404 | PASS | — |
| F3 | Cohort periods (year and semester) | E1, E2, E6 | wizard, Sections | E4 | yes | YEAR + SEMESTER | SEMESTER | — | PASS | — |
| F4 | Sections | E1, E6 (56 sections) | Sections | E4 (create, duplicate refused) | yes | yes | yes | — | PASS | — |
| F5 | Courses | E1 | Courses | E4 | yes | yes | yes | — | PASS | — |
| F6 | Curriculum courses | E1, wizard tests | wizard step 6 | — (API and wizard) | yes | yes | yes | — | PASS | collection-only metadata, PR-4 |
| F7 | Elective groups with windows | E1, E6, `m3b3` | Electives | E4 | Grades 11–12 streams (E6) | — | yes | — | PASS | — |
| F8 | Course offerings (snapshots) | E1, `course-offerings` | Offerings | **E5: create, publish, capacity, close, cancel** | yes | yes | yes | snapshot freeze | PASS | — |
| F9 | Faculty assignments | E1, E3 | Offerings | **E5: assign, refuse second PRIMARY, CO_INSTRUCTOR, end** | yes | yes | yes | posting and scope rules | PASS | — |
| F10 | Term enrolments | E1, E2 | Enrolment | E4 (timeline) | yes | yes | yes | student RLS | PASS | — |
| F11 | Section memberships | E1 | Enrolment | **E5: move with history; duplicate refused** | yes | — | — | — | PASS | — |
| F12 | Course registrations (from section, elective choice, admin-assigned, backlog) | E1, `m3b3` (backlog) | Offerings, Electives | E4 (choice), **E5 (drop)** | yes | — | yes | X-12 | PASS | backlog in integration only |
| F13 | Timetable slots | E1, `course-offerings` | Offerings | **E5: create, end; room, section and teacher clashes refused; half-open slot accepted** | yes | yes | yes | — | PASS | — |
| F14 | Holidays | E1, E6 | Holidays | E4 | yes | — | — | campus 403 | PASS | — |
| F15 | Promotion tool | E1 (dry run, commit, replay) | per-student form | — | yes | yes | year-back | — | PASS | no bulk UI (not in Part 16 UI list) |
| F16 | Setup checklist | E1 | Setup checklist | E4 | yes | — | — | org scope | PASS | — |
| F17 | Terminology via settings | E1, wizard tests | wizard step 1 | E4 (step-up, save, relabel), **E5 (campus admin PUT 403)** | school labels | Year/Semester | defaults | CRITICAL + step-up | PASS | — |
| T1 | The 14 tables | migrations `0033`/`0037`/`0039` | — | — | — | — | — | RLS + FORCE (security-db) | PASS | — |
| T2 | Layout at 390 px and 1280 px | — | — | E4, **E5 (5 tabs at both widths)** | — | — | — | — | PASS | — |
| A1 | `/academics` | E1 | — | — | yes | yes | yes | — | PASS | — |
| A2 | `/students` enrolment endpoints | E1, E2 | — | — | yes | yes | yes | — | PASS | — |
| A3 | `/faculty` (assignments) | E3, `term-activation` | — | — | yes | — | — | employee and offering scope | PASS | — |
| A4 | `/faculty` "workload view" (Part 14, not an M3 Done item) | assignment list | — | — | — | — | — | — | PARTIAL (documented) | OD-4 PENDING |
| U1 | Setup wizard | E6, wizard tests | wizard | E4, **E5 (campus-scoped explanation)** | 3 campuses | yes | yes | org scope | PASS | — |
| U2 | Term board | E1, E3 | Calendar | E4 (refusal), **E5 (successful activation, one audit row)** | yes | — | — | — | PASS | no lock button: OD-3 PENDING (not required by Part 16) |
| U3 | Section allocation | E1 | Enrolment | **E5 (move, refusal, timeline)** | yes | — | — | — | PASS | initial placement uses the same form; driven only through the API |
| U4 | Offerings grid | E1 | Offerings | E4, E5 | yes | — | yes | — | PASS | — |
| U5 | Elective registration | E1 | Electives | E4 (record, maximum refused), **E5 (drop)** | — | — | yes | — | PASS (staff workflow) | OD-2 PENDING |
| U6 | Assignment screen | E3 | Offerings | **E5** | yes | — | — | — | PASS | — |
| U7 | Student timeline | `student-timeline` | profile | E4, E5 | yes | yes | yes | per-row scope | PASS | — |
| U8 | Timetable viewer | E1 | Offerings | E4, E5 | yes | — | yes | — | PASS | — |
| U9 | Offering and slot write UI | E1 | Offerings | **E5 (after the close fix)** | yes | — | — | — | PASS | — |
| D1 | Depends on M2 | `m2-acceptance` 16 | — | — | — | — | — | — | PASS | — |
| D2 | Walkthrough with the pilot's real curriculum | — | — | — | — | — | — | — | **PENDING EXTERNAL INPUT** | school data, C-1 to C-5, reviewer |
| X1 | Overlap exclusion | `course-offerings` 37 | — | E5 | yes | — | yes | superuser writers | PASS | — |
| X2 | Section-change history | E1 | — | E5 | yes | — | — | — | PASS | — |
| X3 | Term lock | `academic-calendar`, `m3b3` | — | — | yes | — | — | — | PASS | — |
| X4 | Promotion without mutation | E1 | — | — | yes | — | — | — | PASS | — |
| X5 | Offering snapshot freeze | `course-offerings` | — | — | yes | — | — | — | PASS | — |
| X6 | Elective min/max/window | `m3b3`, E1 | — | E4 | — | — | yes | — | PASS | — |
| X7 | Real ASSIGNED resolver (X-12) | `m3b3`, E1 | — | E4 | yes | — | yes | 404 on no link | PASS | — |
| X8 | Student-self RLS on new tables | security-db | — | — | — | — | — | yes | PASS | — |
| G1 | Pilot structure loaded for a full term | synthetic E6 | — | — | synthetic | — | — | — | **PENDING EXTERNAL INPUT** | real school data |
| G2 | Per-student course sets differ correctly | E1 | — | E4 | synthetic | — | yes | — | PASS | re-check on real data |
| G3 | Timeline matches as-of fixtures | `student-timeline` 14 | — | E4 | yes | yes | yes | — | PASS | — |
| G4 | S-gates still green | security 723/723 | — | — | — | — | — | yes | PASS | — |

**Totals: 46 rows.**
- **PASS:** 43.
- **PARTIAL:** 1, documented and pending an owner decision (A4).
- **PENDING EXTERNAL INPUT:** 2 (D2, G1).
- **FAIL:** none.

## 3. Implementation changes

| File | Change | Why |
| --- | --- | --- |
| `apps/web/src/pages/AcademicsPage.tsx` | "Close offering" now opens a reason form ("Closing reason", "Confirm close"), shared with cancellation. The page sends `{status:'CLOSED', reason}` and sends nothing without a reason of 5 or more characters | **Defect:** `CourseOfferingService.update` requires a reason for both final states (`parseReason`), but the page sent none, so every close got 400 in the real browser (doc 39 browser run 1). The fake backend accepted it, so component tests passed |
| `apps/web/tests/helpers/fakeBackend.ts` | The fake offering PATCH requires a reason for CLOSED as well as CANCELLED | test double aligned with the server, so the gap cannot hide again |
| `apps/web/tests/academics-offerings-write.test.tsx` | New test "closes a published offering only with a reason" | pins the fix. Mutation check: sending no reason for CLOSED makes it fail (restored byte-for-byte) |
| `backend/tools/platform/platform-cli.ts` | `seedTenant` (the `tenant:seed` command) runs its writes in one transaction | **PR-3:** in autocommit a role briefly had no grants between its DELETE and INSERTs, and a failure part-way left a half-synced tenant. The policy (`ROLE_MATRIX`) is unchanged |
| `backend/tests/integration/platform-cli.test.ts` | New test: a re-seed removes a hand-made extra grant, resets a changed `scope_mode`, never touches `role_assignments`, and a failure at the 40th insert rolls everything back | pins the documented behaviour. Mutation check: without the transaction the test fails (restored byte-for-byte) |
| `docs/runbooks/tenant-role-reseed.md` | New runbook: backup, read-only drift preview, execution, verification, rollback, record | PR-3 operational procedure |
| `docs/architecture/v3/39-m3-finalization-and-acceptance-report.md` | this report | — |

**Checked and found consistent (no change):**
- Every other web status change was compared with its server rule. Academic years and terms need no reason except LOCK. Elective-group, registration, assignment, slot, holiday and placement writes already send their required reasons.
- **The wizard tab for a campus-scoped holder** of `academic.term.manage` is shown with the fixed explanation "needs organization-wide access" (doc 35). This is by design, not a defect.

## 4. Migrations and compatibility

**No new migration.** The chain is `0001`–`0039`.

**Fresh disposable databases:**
- Five E2E stacks each applied 39 of 39 migrations, with the contract steps authorised for those throwaway databases only.
- **Runbook rehearsal** (`0036 → 0037 → 0038 → 0039`, with `--through` dry runs): the preflight and post-check SQL of the three M3 runbooks ran verbatim, 25 statements, 0 errors.

**Verified by the suites:**
- RLS and FORCE RLS on every tenant table; tenant-scoped composite foreign keys; indexes and uniqueness (schema linter, roles-and-privileges, authorization-rls, migration lists: security 723/723, integration 1,546/1,546).
- Concurrent activation: PATCH against POST, and activation racing a cancellation (`term-activation`).
- `lock_timeout = '5s'` is set inside the M3 migrations (read from the source). Its effect on a populated or production database is **not measured**.

**Rollback:** migrations are forward-only; there are no down migrations. Rollback is a further forward migration or a restore. No restore was exercised.

**Backward compatibility:**
- The close fix only adds the reason the API always required.
- `tenant:seed` keeps its inputs and outputs; only atomicity changed.

## 5. School, college and university regression

**School (synthetic data):**
- **Three campuses in one tenant.**
  - Campus 1: one or two grade programmes, at scale (E1, E2).
  - Campus 2: a transfer campus (E2).
  - **Campus 3, built entirely over HTTP (E6):** Grades 1–10 plus Science and Commerce streams for Grades 11–12. That is 14 classes and 56 sections (four per class), a Grade 11 science elective basket (min 1, max 1, capacity 30), staffed published offerings, a class teacher, a room-booked slot and a campus holiday.
  - Campus 3's term was ready, with no blocking issues and three warnings, and was activated in the browser.
- **Also covered:** staff and postings, assignments, class teachers, holidays, enrolment, promotion and repetition (E1), and the timeline.

**College:**
- `college-regression` (14).
- B.Com YEAR and BCA SEMESTER programmes on one campus (E2).
- Five annual and semester terms activated (E1, E3).

**University:** semester terms on two campuses, electives with min/max/window, drop and withdraw with history, X-12, the timeline (E1, E4, E5).

**Labels are display only:** school labels never leaked to the university tenant (E4).

## 6. Real-browser workflows and evidence

**Environment:**
- A fresh embedded PostgreSQL 16 for each stack.
- The real backend (`buildApp`) on :4000.
- The repository's `apps/web/vite.config.ts` (Vite 8.3.4) on :5173.
- Headless Chrome 156 over CDP.
- Test accounts were created by the harness as superuser, and MFA-required sessions were marked verified in the throwaway database. That is the documented harness shortcut, not real TOTP.

**Final clean run (one database):** E1 85/85, E2 77/77, E3 21/21, E4 48/48, E5 26/26.

**What E5 covers:**
- U9: create, publish, capacity, close (refused without a reason, done with one), cancel with a reason.
- U6: assign PRIMARY; second PRIMARY refused; CO_INSTRUCTOR; end with date and reason.
- Timetable: slot with room and teacher; section, room and teacher clashes refused; adjacent half-open slot accepted; end slot.
- U3: move with old row closed the day before and new row open; duplicate refused; "Section transfer" on the timeline.
- U2: successful activation, PLANNED → ACTIVE, version +1, exactly one audit event.
- U5: drop a choice (DROPPED, history kept).
- Permissions: campus admin sees the wizard explanation, and a terminology PUT is refused with 403.
- Layouts: 390 px and 1280 px on five tabs.
- No console errors.

**Defect evidence:** browser run 1 showed the offering still PUBLISHED after "Close offering". The run after the fix shows PUBLISHED → CLOSED.

**Driver problems fixed during the campaign (not product defects):**
- an over-broad success-message regex;
- the capacity label;
- a pupil already promoted by E1;
- a missing "Open group" click;
- a wrong expectation about the wizard tab.

**Interrupted run:** one run stalled when Chrome stopped answering CDP after a long idle. It was stopped by the time limit and rerun cleanly.

Logs, result JSON and screenshots are in the session scratchpad (`scratchpad/e2e/evidence/`). It is temporary and outside the repository.

## 7. Automated checks (final code, sequential)

| Check | Result |
| --- | --- |
| Unit | 47 files, **928/928** |
| Security (security + security-db) | 45 files, **723/723** |
| Integration | 77 files, **1,546/1,546** (second full run). The first full run had 1 failure: a 30 s timeout in `permission-seed.test.ts` "new tenants receive auth.mfa.manage …" (committed test, unchanged since `b8e7926`; seeding through the per-statement test executor takes 7–15 s idle; 3/3 isolated runs and 10/10 together with the new test passed) |
| Web | 20 files, **348/348** (see note) |
| API contract (`web-api-contract.test.ts`) | 86/86 |
| Browser E2E | E4 48/48, E5 26/26 |
| Typecheck | exit 0 |
| Lint | exit 0, after fixing one `no-unsafe-return` in the new integration test |
| Format | the campaign's files pass. `format:check` exits 1 **only** on `PROJECT_LOG.md` (the pre-existing Tasks 2–5 entry; append-only, unchanged) |
| Secrets scan | no findings |
| Build | exit 0 (Vite chunk-size warning) |
| Bundle check | exit 0 |
| `git diff --check` | exit 0 |

**Web note.** After the formatting pass, the full web suite was run five times while the machine's load average was about 43, caused by macOS Storage Management and other desktop processes, not by this project.
- Runs 1 and 2: 348/348.
- Runs 3, 4 and 5 failed 1, 3 and 1 tests, a different one each time: users page, an axe audit, the timeline, from-section. These are timing failures unrelated to the change.
- A further run of 348/348 was also observed during the campaign (before the formatting pass, the same code).

- After the load fell to about 7–13: run 6 failed 1 (`users-page.test.tsx` "renders loading state …", a `findBy` timeout for the "User directory" table); run 7 was 348/348.
- `users-page.test.tsx` passed 5/5 in isolation. Its test and page files are committed and unmodified by this campaign.

These are reported as load flakes, not passes: 3 of 7 full web runs on the final code were 348/348 (runs 1, 2, 7); every test that failed once passed in the other full runs.

## 8. PR-1 to PR-4 outcomes

**PR-1 (student records without login): not an M3 requirement; no code change.**
- Part 16 M3 needs the pilot structure and per-student course sets, not records without accounts.
- ADR-003 (accepted, M1) defines `students.user_id` as the login account. Changing that touches `actor_kind`, the person-identity triggers (`0016`/`0020`), student-self RLS and imports. It is a cross-cutting identity change beyond M3.
- **Recorded as a prioritised post-M3 product requirement:** a student academic record with an optional login account, the link required for self-service, no invented addresses, no default passwords.
- **For the pilot:** the doc 38 options remain (PR-1b pilot subset with school-administered mailboxes; PR-1d disposable-only shortcut). Both need owner and school approval. Roster reduction is the school's decision and has not been taken here.

**PR-2 (campus-bound programmes): no change.**
- The model supports three campuses. Verified in E6: one programme per campus and per stream; a shared course catalogue (subject codes once per tenant); shared period types, years and employees.
- Curriculum rows are per programme; the drift mitigations and the comparison check are in doc 38 §3. Part 16 does not require a shared multi-campus curriculum.

**PR-3 (re-seeding): fixed and documented.**
- `tenant:seed` is now one transaction.
- Verified on the disposable harness:
  - it deletes grants outside the matrix and resets changed scope modes;
  - it never touches assignments;
  - it rolls back completely on failure;
  - it is idempotent.
- Runbook: `docs/runbooks/tenant-role-reseed.md`. No persistent tenant was re-seeded.

**PR-4 (metadata): no change.**
- **Stored:** course code, title, credits, course type, curriculum category, grade or period number (cohort period), and each lesson's weekday and times.
- **Collection-only, not stored, not importable:** theory hours, practical hours, weekly periods, bell times, timetable period numbers.
- None is a Part 16 M3 field.

## 9. Remaining owner decisions (all PENDING, doc 38)

- **OD-1:** database-level activation enforcement. Recommended: service-level for M3; trigger in M7. Locking triggers are not safe.
- **OD-2:** staff-managed electives.
- **OD-3:** no term-lock button.
- **OD-4:** no quantitative workload.
- **OD-5:** Nginx before production.
- **OD-6:** 36 items.
- **PR-1 to PR-4:** the option and procedure choices.
- **C-6:** the real-data environment.

No decision was taken in this campaign.

## 10. Remaining school inputs and approvals

- **Inputs:** the doc 37 §3 data for one term.
- **School authorisations (doc 38 §4):** C-1 data sharing; C-2 test-environment use; C-3 reviewer; C-4 acceptance authority; C-5 one-term scope.
- **Sign-off:** D2 and G1 are signed by the school only (doc 37 §7).
- **No school data has been received.**

## 11. Operational limitations

- **Evidence storage:** the E2E evidence lives in a temporary scratchpad. The rehearsal must store it durably (doc 37 §8).
- **MFA in the E2E runs:** the MFA shortcut was used; real TOTP is covered only by `mfa.test.ts`.
- **Harness stop race:** stopping the embedded PostgreSQL races its own shutdown hook. The leftover temp directories from this campaign were removed; older ones from earlier sessions were left untouched.
- **Load-sensitive tests:** `permission-seed.test.ts` (30 s limit) and several web tests time out under heavy machine load.
- **Readiness** is enforced in the service, not in the database (OD-1).

## 12. Production-readiness limitations (outside M3; M7 unless the owner decides otherwise)

- **Nginx routing contract:** not run on a real Nginx (no binary or Docker here).
- **Persistent databases:** none migrated. The contract steps and preflights are planned only. Lock times are unmeasured.
- **Existing tenants:** no `seedTenantRoles` run (runbook ready).
- **Backup and restore:** not exercised.
- **Invitations:** delivery is disabled in production (`DisabledInvitationMailer`; doc 28 §4 decisions blocked on the owner).
- **Load and penetration testing:** not done.

## 13. M3 acceptance recommendation

**Technical result:** ACCEPTANCE-READY. No named technical defect remains.

**To record M3 as accepted, in this order:**
1. **The owner** decides OD-1 to OD-6, PR-1 to PR-4 and C-6 (doc 38).
2. **The owner** commits the tree and CI is green on that commit.
3. **The school** gives C-1 to C-5 and supplies the doc 37 data.
4. **Rehearsal:** load the data on a disposable environment; run doc 37 §5 and §6 with durable evidence.
5. **School sign-off** of D2 and G1 (doc 37 §7).
6. **The owner** records the M3 acceptance decision.

Until then M3 is **not accepted**.

## 14. M4 gate

Milestone 4 (Attendance) **must not start** until M3 is formally accepted per §13. Nothing in this campaign started M4: no attendance tables, routes, sessions or policies were created.

**Owner amendment (2026-11-05): M4 early start.** The product owner authorised Milestone 4 development on synthetic data before formal M3 acceptance, on these conditions:
- M3 D2 and G1 remain mandatory and pending; M3 is not formally accepted.
- M4 cannot be formally accepted before M3.
- No real school data and no production deployment are authorised.
- Future real-school validation may require M4 changes.

This amends only the sequencing rule above; no M3 requirement changes.
