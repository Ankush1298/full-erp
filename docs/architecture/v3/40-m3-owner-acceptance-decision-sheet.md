# Anesa ERP — M3 owner acceptance decision sheet

**Purpose:** owner review and preparation for formal M3 acceptance.

**Current recommendation:** ACCEPTANCE-READY, subject to the conditions below (technical outcome of doc 39).

**Important:** this document does not accept M3. It does not approve any outstanding decision, does not authorise processing of school data, and does not authorise M4.

**Sources:**
- `36-m3-residual-gap-assessment.md`
- `37-m3-owner-decisions-and-pilot-readiness.md`
- `38-m3-owner-decision-register.md` (detailed decision fields)
- `39-m3-finalization-and-acceptance-report.md` (evidence)

## 1. Technical completion summary

The M3 finalisation campaign (doc 39 §7, §4, §6) reports:

| Area | Result |
| --- | --- |
| Unit tests | 928/928 |
| Security tests | 723/723 |
| Integration tests | 1,546/1,546 (second full run; one load timeout in an unchanged test on the first run). The test (`permission-seed.test.ts`, committed and unchanged) passed 3/3 in isolation and 10/10 alongside the new re-seed test |
| Web tests | 348/348 in 3 of 7 runs. The other runs failed 1–3 different, unrelated tests by timeout under heavy machine load (load average about 7–43 from non-project processes); each test that failed passed in the other full runs |
| API contract | 86/86 |
| API E2E driver | 85/85 |
| Task 7 API | 77/77 |
| Faculty (`/faculty`) API | 21/21 |
| Existing browser workflows | 48/48 |
| New browser workflows | 26/26 |
| Migration chain | `0001`–`0039` on disposable databases |
| M3 runbooks | All 25 statements executed without SQL errors. 24 output checks matched their runbook expectations. The FACULTY-grant check requires a seeded tenant; its result was verified separately in seeded-tenant E2E and the re-seed test. |
| Typecheck, lint, secrets, build, bundle and diff checks | Passed (lint after one fix in the new integration test) |
| Formatting | the historical `PROJECT_LOG.md` issue remains (Tasks 2–5 entry, append-only) |

**Web suite.** The intermittent failures happened under heavy machine load. A reliable full run under normal load is still required (§6).

**Runbook verification sources:**
- Doc 39 §4 records that the 25 statements ran with 0 errors.
- The comparison of the other 24 outputs with the `-- expect` comments in the runbooks was made in the owner review of 2026-11-05, against the rehearsal log `c-runbooks.log`. All 24 matched.
- The 25th statement, the FACULTY `student.profile.read` grant, returned no rows in the tenant-less rehearsal database. That result does **not** prove the grant and is not counted as a matched check. The grant is covered by separate evidence, not by output of the runbook rehearsal:
  - the seeded E2E tenants (faculty profile access in the browser, doc 39 §6);
  - `backend/tests/integration/platform-cli.test.ts` (re-seed restores the matrix exactly).

**Browser verification (doc 39 §6):**
- term activation;
- section movement;
- dropping an elective choice;
- faculty assignments;
- the offering lifecycle;
- timetable conflicts;
- permission denials;
- mobile (390 px) and desktop (1280 px) layouts.

**Changes made in the campaign:**
- A real offering-closure defect was fixed (doc 39 §3).
- Tenant role re-seeding was made transactional and tested for rollback, on disposable databases only.

**Evidence limitations:**
- Earlier E2E logs and screenshots were stored in a temporary session scratchpad outside the repository. A formal acceptance rehearsal must regenerate and retain its own evidence.
- E2E authentication marked MFA as verified in the disposable database. Real TOTP sign-in was not exercised in the browser. It is covered only by the automated `mfa.test.ts` integration tests.
- Production lock times, backup and restore, and a real Nginx host were not tested (doc 39 §12).

## 2. Product-owner decisions

Review the detailed decision register in doc 38. Do not treat the recommendations below as already approved.

| Decision | Recommended position | Owner status |
| --- | --- | --- |
| OD-1: Database-level activation enforcement | Keep service-level enforcement for M3; reconsider in M7 | PENDING |
| OD-2: Elective registration | Staff-managed choices for M3; student self-service later | PENDING |
| OD-3: Term-lock control | Defer the user-facing lock button; keep the existing lock behaviour | PENDING |
| OD-4: Faculty workload metrics | Defer quantitative workload; keep the assignment and timetable views | PENDING |
| OD-5: Production Nginx | Verify before production deployment | PENDING |
| OD-6: Existing architecture decisions | Review all 36 individually in doc 38 | PENDING |

### OD-6 approval requirement

Every one of the 36 underlying decisions (doc 38 §2: 14 from doc 31, 10 from doc 32, 9 from doc 33, 3 from doc 34) must keep its own review and approval record. Do not approve the whole group by signing this summary.

## 3. Pilot readiness decisions

| Finding | Recommended position | Status |
| --- | --- | --- |
| PR-1: Student account provisioning | Keep the current authentication model for M3; record record-only student support as a post-M3 product requirement | PENDING |
| PR-2: Campus-specific programmes | Use campus-specific programmes with shared subject codes and curriculum consistency checks | PENDING |
| PR-3: Role re-seeding | Use the transactional implementation, and rehearse only on disposable databases until separately authorised | PENDING |
| PR-4: Curriculum metadata | Treat theory hours, practical hours, weekly periods, bell times and timetable period numbers as collection-only | PENDING |

### PR-1 pilot decision

**The constraint:** the current implementation requires every student record to link to an ACTIVE account. Do not invent e-mail addresses, use shared accounts, or weaken authentication.

**The school must explicitly confirm** one of:
- it can supply a suitable pilot subset with individual school-administered mailboxes; or
- the pilot must wait for a product change.

**Rehearsal option PR-1d (doc 38 §3; not approved):** on a disposable rehearsal environment only, an operator may attach student records to accounts created directly in the database, without login credentials. This:
- remains a test-only technique;
- requires real school-administered addresses per pupil;
- requires C-6 authorisation;
- is never a production onboarding path.

It does not replace the school-facing decision above, which stays open.

**No roster reduction is approved by this document.**

## 4. School authorisations

These require school-side approval and must be documented separately.

| Authorisation | Required evidence | Status |
| --- | --- | --- |
| C-1: Share one-term pilot data | Written school authorisation | PENDING |
| C-2: Use student and staff records in a test environment | Explicit data-processing authorisation | PENDING |
| C-3: Name the school reviewer | Named reviewer and role | PENDING |
| C-4: Name the acceptance authority | Authorised signatory | PENDING |
| C-5: Approve the one-term pilot scope | Full roster or an explicitly approved subset | PENDING |

The product owner must separately complete **C-6**, authorising the environment that will hold the pilot data. Status: PENDING.

## 5. Required school inputs

The school must provide or confirm (template: doc 37 §3):

- Institution and campus details.
- Academic session and term dates.
- Grades, programmes, streams and sections.
- Curriculum and subject codes.
- Elective groups and choice constraints.
- Staff, departments and campus postings.
- Faculty assignments and class teachers.
- Timetable, rooms and holidays.
- Promotion and detention rules.
- Approved terminology.
- Pilot roster and term enrolments.
- Named reviewer and acceptance authority.

Weekly periods, theory and practical hours, bell times and timetable period numbers are collection-only metadata in the current implementation. They must not be represented as stored or importable fields.

## 6. Final acceptance conditions

Before formal M3 acceptance:

- [ ] Owner decisions OD-1 through OD-6 reviewed.
- [ ] All 36 OD-6 decisions individually resolved.
- [ ] PR-1 through PR-4 disposition approved.
- [ ] C-6 environment authorisation completed.
- [ ] School authorisations C-1 through C-5 received.
- [ ] Reviewed implementation committed by the owner.
- [ ] CI passes on the reviewed commit.
- [ ] Full web suite passes 348/348 on the reviewed commit, in CI or on a quiet machine, with captured test output.
- [ ] D2: real school curriculum walkthrough completed.
- [ ] G1: full-term pilot structure verified.
- [ ] Defects, limitations and accepted conditions documented.
- [ ] Formal acceptance recorded by the authorised parties.

## 7. Explicit scope boundary

- M3 remains the current milestone.
- ~~No M4 attendance implementation may begin before formal M3 acceptance.~~ Amended 2026-11-05 by the product owner: M4 development may proceed on synthetic data before formal M3 acceptance. M3 D2/G1 remain mandatory and pending, M3 is not accepted, M4 cannot be formally accepted before M3, no real school data or production deployment is authorised, and future real-school validation may require M4 changes.
- This decision sheet authorises no production migrations, no production role re-seeding and no production data loading.
- Production Nginx verification, the backup and restore rehearsal, real invitation delivery, and production security and load testing remain separate operational-readiness work.

## 8. Owner decision

**Select one outcome after reviewing the evidence:**

- ACCEPTANCE-READY: technical M3 work is sufficiently complete; external acceptance conditions remain.
- RETURN FOR TECHNICAL REMEDIATION: specific defects must be corrected before acceptance.
- HOLD: owner or school decisions or data are not yet available.

| Field | Entry |
| --- | --- |
| Owner decision | |
| Rationale / conditions | |
| Owner | |
| Date | |
| Reviewed commit hash | |
| CI run reference | |
| School acceptance authority | |
| School sign-off date | |

**Formal M3 acceptance:** NOT YET GRANTED

**M4 authorisation:** synthetic-data development authorised (owner amendment 2026-11-05, §7); M4 formal acceptance NOT GRANTED and impossible before M3 acceptance
