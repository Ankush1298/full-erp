# 43 — M4 attendance: policy and authorization decision sheet

Status: **prepared for the owner; AD-1 to AD-9 were approved by the owner on 2026-11-07 — see §0, the decision record. The sections below are the original pending analysis, kept unchanged as history, and still say PENDING.** Nothing in this document approves, changes or implements a rule. It was produced by reading the canonical documents and the existing code only; no implementation, migration, permission, test, frontend, database or configuration file was touched, and no M3 decision or acceptance status was changed.

Scope: attendance session locking and unlocking, who may correct submitted attendance, correction windows, HOD and administrator authority, correction approval, session cancellation, and notification and audit. Implementation reviewed: M4 Slices 1 and 2 (doc 41 §1 to §8, migrations `0040` and `0041`, `backend/src/modules/attendance/`).

Authority reminder: the owner amendment of 2026-11-05 (docs 39 §14, 40 §7) allows M4 development on synthetic data before formal M3 acceptance. It does not accept M3 or M4, and does not authorise production, real data, production migrations or re-seeding. M3 stays "not accepted"; M4 formal acceptance stays "not granted".

> **Update 2026-11-07 (security containment, not a decision):** the provisional teacher grant described in §3 has since been contained: it is removed from the role matrix and the correction route answers 403 to everyone unless `ATTENDANCE_CORRECTIONS_ENABLED=true` (doc 41 §9). This closes the unapproved behaviour only. **AD-1 to AD-9 remain PENDING and nothing here approves, narrows to or chooses any option.** Statements in §2 and §3 describe the state when this sheet was written.

## 0. Owner decision record — 2026-11-07 (AD-1 to AD-9 APPROVED for Pilot V1)

On 2026-11-07 the Anesa product owner approved AD-1 to AD-9 as follows. This record supersedes the PENDING status in the tables below; the original pending text is kept unchanged as history. The approval covers these attendance policies for Pilot V1 only. It does **not** grant M3 acceptance, M4 acceptance, production deployment, real-school data processing or production migration authorisation. Development stays on synthetic data under the 45 to 75-day Pilot V1 plan.

| ID   | Approved policy (exact)                                                                                                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AD-1 | Regular assigned faculty may correct attendance within the approved correction window and canonical permitted-status rules. Substitute or lab instructors are **not** automatically granted correction authority. |
| AD-2 | Three calendar days for ordinary faculty corrections.                                                                                                                                                             |
| AD-3 | Authorized HOD, campus administrators and college administrators may correct attendance only within their permitted institutional scope.                                                                          |
| AD-4 | Corrections outside the normal faculty correction window require independent authorized approval, with no self-approval.                                                                                          |
| AD-5 | Authorized administrators may lock sessions, and locking an academic term must also lock its attendance sessions.                                                                                                 |
| AD-6 | No routine session unlocking in Pilot V1.                                                                                                                                                                         |
| AD-7 | Assigned faculty may cancel their own eligible sessions before initial submission. Administrative cancellation requires a separate explicit permission.                                                           |
| AD-8 | Relevant authorized users may receive in-app attendance notifications. Guardian messaging is excluded from Pilot V1.                                                                                              |
| AD-9 | Corrections and cancellations require Tier 2 audit events; lock-related operations require Tier 3 audit events.                                                                                                   |

The owner also confirmed that the previously observed frontend API error is fixed.

Details the approval leaves open (implementation choices, each the narrowest safe one; see doc 41 §12): the window is measured in calendar days from the session date (inclusive of day 3); "regular assigned" is read as assignment role `PRIMARY` or `CO_INSTRUCTOR`, never `SUBSTITUTE` or `LAB_INSTRUCTOR`; "permitted-status rules" is read as any change to a different canonical status with a reason from the closed list; approvers must hold a correction-approval permission and differ from the requester; administrators correct directly inside their scope when the term is ACTIVE or CLOSED and approval is not otherwise required; the term LOCKED and session LOCKED states stay absolute.

## 1. Summary: what the owner is asked to decide

| ID   | Decision                                                                | Blocks                       | Recommended default (secure)                                                                                   | Status      |
| ---- | ----------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| AD-1 | Who may correct submitted attendance, and the provisional teacher grant | Any further correction work  | Narrow the grant (see §3) or withdraw it until decided                                                         | **PENDING** |
| AD-2 | Faculty correction window                                               | Window enforcement, policies | 3 days from the session date (doc 11 R-3 default), enforced by the server                                      | **PENDING** |
| AD-3 | HOD and administrator correction authority                              | New permission mapping       | HOD, campus and college administrators may correct inside their scope, with a reason, after the faculty window | **PENDING** |
| AD-4 | Correction approval                                                     | Approval path, M5 link       | No approval inside the faculty window; approval required after it                                              | **PENDING** |
| AD-5 | Session locking                                                         | Lock endpoint                | Explicit lock by an administrator permission, plus an automatic lock when the term is closed                   | **PENDING** |
| AD-6 | Unlocking and edits after a lock                                        | Unlock endpoint              | Not available to anyone except a CRITICAL override with reason, step-up and second approver                    | **PENDING** |
| AD-7 | Session cancellation authority                                          | Cancel permission            | Keep the assigned teacher; add an administrator path with a reason                                             | **PENDING** |
| AD-8 | Notifications                                                           | Event emission               | Emit the events, deliver to staff only, nothing to students or guardians until decided                         | **PENDING** |
| AD-9 | Audit requirements                                                      | Audit tiers, read access     | Keep current tiers; make cancellation tier 2; add lock and unlock tier 3                                       | **PENDING** |

Decisions that can be answered together: AD-2 to AD-4 are one policy question (doc 11 R-3, "correction approvers"); AD-5 and AD-6 are one lock lifecycle question.

## 2. What is already implemented (so the owner knows what a "yes" or "no" changes)

| Behaviour                                                                                                                                          | Where                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A teacher can create a session, submit its first attendance, and cancel it before submission                                                       | `attendance.session.mark`, FACULTY ASSIGNED (Slices 1 and 2)                                            |
| A teacher can correct any submitted record of an offering they are assigned to on the session date, to any other status, with a closed-list reason | `attendance.record.correct`, FACULTY ASSIGNED, **provisional**, `role-matrix.ts` line 55, doc 10 row 60 |
| Corrections are revisions N+1 with before and after status, actor, reason, tier-2 audit; stale revision gives 409                                  | `attendance.service.ts` `correctRecord`                                                                 |
| A correction is refused when the session is not SUBMITTED, is LOCKED, or the term is LOCKED                                                        | `correctRecord`, `0040` guards (term check at lines 184 and 297, session check at line 307)             |
| A session is cancelled only while it has no attendance; cancel is final                                                                            | `cancelSession`, `class_sessions_guard`                                                                 |
| The database already allows SUBMITTED to LOCKED, and makes a LOCKED session read-only                                                              | `0040` lines 203 and 208                                                                                |
| **Not implemented**: lock and unlock, edit window, approval, admin correction, admin cancellation, events, notifications, summaries, policies      | doc 41 §7, §8                                                                                           |

## 3. AD-1: who may correct, and the provisional teacher grant

**Canonical requirements**

- Doc 03 line 25 names `attendance.record.correct` as an example permission; no other document defines it.
- Doc 03 lines 41 to 46 list the attendance grants: STUDENT `attendance.record.read` SELF; FACULTY `attendance.session.mark` ASSIGNED and `attendance.record.read` ASSIGNED; HOD, CAMPUS_ADMIN and COLLEGE_ADMIN `attendance.record.read` GRANTED. **No role is listed for `attendance.record.correct`.**
- Doc 10 §1 (matrix) had no row for it; doc 10 §3: "Each milestone adds its permissions to the catalog and the matrix in the same change as its routes."
- Doc 01 §3.7, AttendanceRecord: "Faculty at submission; changes only via revision".
- Doc 02 lines 303 to 305: "Until [leave_records exist] EXCUSED is set by faculty/admin with a reason, or by an approved ATTENDANCE_CORRECTION / LEAVE service request."
- Doc 03 line 289: "any modification after submission" is tier 2 and "Modification: yes" (reason required).
- Doc 03 line 140 and doc 04 Milestone 5: "attendance correction via request updates attendance with revision" (`ATTENDANCE_APPLY_CORRECTION`).
- Doc 11 §3, R-3: "Pilot attendance defaults (min %, late/excused treatment, edit window, correction approvers)", needed by M4, default "3-day edit window".

**Current implementation:** FACULTY holds `attendance.record.correct` as ASSIGNED, added in Slice 2 as a provisional entry (doc 41 §7 item 1, doc 10 row 60). No other role holds it.

**Does the provisional grant exceed the written authorization? Yes, in five ways**

| #   | The grant allows                                                                                                                                         | The canonical text supports                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A teacher correcting a record at all                                                                                                                     | Only indirectly: "changes only via revision" (doc 01) and, for EXCUSED only, "faculty/admin with a reason" (doc 02 line 305). No role table authorises it.                              |
| 2   | Changing to **any** status (PRESENT, ABSENT, LATE, EXCUSED)                                                                                              | The only explicit faculty/admin statement is about **EXCUSED**.                                                                                                                         |
| 3   | Correcting at **any time** while the session is SUBMITTED and the term is not LOCKED                                                                     | R-3 lists an edit window with a proposed 3-day default; policy field `edit_window_days` (doc 02 line 290). Not enforced.                                                                |
| 4   | Correcting while the **term is CLOSED**                                                                                                                  | Doc 02 line 168: "CLOSED = admin corrections only". The resolver (`assigned-resolver.ts`) and the guards check only LOCKED, never CLOSED (confirmed by reading the code; not executed). |
| 5   | Correction **by any assigned teacher**, including `CO_INSTRUCTOR`, `LAB_INSTRUCTOR` and `SUBSTITUTE`, of any record in the session, with **no approval** | Doc 02 lines 290 and 453, ADR-018: `correction_requires_approval`, and "every change with reason and approver".                                                                         |

Effect today: only synthetic tenants exist and existing tenants are not re-seeded, so no real user holds the grant. The excess is a design risk, not a live exposure.

**Missing decision:** which roles may correct, to which statuses, for how long, and whether the teacher grant stays.

**Options**

- A. **Withdraw** the grant until AD-2 to AD-4 are decided (nobody can correct; Slice 2 correction code stays, unreachable). Strictest.
- B. **Narrow** it: FACULTY may correct only inside the AD-2 window, only while the term is ACTIVE, only for sessions they conducted or hold an assignment on, with a reason. Administrators per AD-3.
- C. **Keep as built** (any time, any status). Not recommended.

**Recommended secure default:** B, and treat A as the fallback if the window cannot be decided. Option B matches R-3's own default and the CLOSED-term rule.

**Consequences if B:** a migration-free role-matrix change plus service checks (term status, window); tests for window edge, CLOSED term and substitute; doc 10 row 60 reworded; `attendance_policies` or a term-level field to carry the window.

## 4. AD-2: faculty correction window

**Canonical:** doc 02 line 165 `terms.attendance_edit_until date?`; doc 02 line 290 policy `edit_window_days`; doc 07 §4 ("Rules: … `edit_window_days`, `correction_requires_approval`"); doc 11 R-3 default "3-day edit window"; doc 24 line 76 and doc 32 line 80 record that `terms.attendance_edit_until` was deferred to M4 and has no column specification.
**Current:** no window, no `attendance_edit_until` column, no `attendance_policies` table.
**Missing decision:** the number of days, what it is measured from (session date, submission time, or end of the day), whether it is per policy (doc 02) or per term (`attendance_edit_until`), and which wins when both exist.
**Recommended default:** 3 calendar days from the campus-local session date, per policy (`edit_window_days`), with `terms.attendance_edit_until` as an optional hard stop that wins when earlier. Server-enforced, not a UI hint.
**Consequences:** a new table (`attendance_policies`) or column (`attendance_edit_until`) migration, policy resolution and pinning (doc 02), date arithmetic in the campus time zone, tests at the window boundary. **PENDING.**

## 5. AD-3: HOD and administrator correction authority

**Canonical:** doc 03 lines 44 to 46 give HOD, CAMPUS_ADMIN and COLLEGE_ADMIN **read** only, with scopes department, campus and organization. Doc 02 line 168 says "CLOSED = admin corrections only" and line 305 says "faculty/admin" may set EXCUSED. No document says who "admin" is. DEPARTMENT_ADMIN and REGISTRAR have no attendance grant at all.
**Current:** none of these roles can correct.
**Missing decision:** which of HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR may correct; at what scope (the same GRANTED scopes as reading); whether HOD correction is limited to their department's offerings; whether they may act after the faculty window or in a CLOSED term.
**Recommended default:** GRANTED correction for HOD (department), CAMPUS_ADMIN (campus) and COLLEGE_ADMIN (organization), with a mandatory reason, available after the faculty window and in a CLOSED term, never in a LOCKED one. DEPARTMENT_ADMIN and REGISTRAR: none until the owner names them.
**Consequences:** role-matrix and doc 10 changes, GRANTED branch in the service (campus and department come from the offering), step-up if the owner marks the permission CRITICAL, MFA already required for these roles (`mfa-policy.ts`), tests per role and scope. **PENDING.**

## 6. AD-4: correction approval

**Canonical:** doc 02 line 290 `correction_requires_approval`; doc 02 line 278 revision columns `approved_by_user_id?` and `service_request_id?`; doc 02 line 453 "every change with reason and approver"; doc 03 line 75 "optionally a second approver (`request_approvals` pattern)" for CRITICAL actions; doc 03 line 140 and doc 04 Milestone 5 (correction through an `ATTENDANCE_CORRECTION` service request, applied exactly once).
**Current:** no approval; the two revision columns were deliberately omitted from `0040`; the service request engine (M5) does not exist.
**Missing decision:** when approval is required, who approves, and whether, before M5 exists, an interim in-module approval is wanted or corrections beyond the window simply wait for the M5 request flow.
**Recommended default:** no approval inside the faculty window; beyond it, a correction needs a second authorised person (HOD or administrator) other than the requester. Until M5, beyond-window corrections are made directly by an administrator with a reason (AD-3) rather than building a parallel approval flow.
**Consequences:** add `approved_by_user_id` (and later `service_request_id`) to revisions, a rule that approver differs from requester, a link to M5 `ATTENDANCE_APPLY_CORRECTION`, tests for self-approval refusal. **PENDING.**

## 7. AD-5: session locking

**Canonical:** doc 02 line 257 `attendance_state [NOT_STARTED|OPEN|SUBMITTED|LOCKED]` and line 258 `locked_at`; doc 01 §3.7 lifecycle "NOT_STARTED→OPEN→SUBMITTED→LOCKED"; doc 03 line 289 "lock/unlock" at tier 3; doc 04 Milestone 4 features "submit/lock"; doc 02 line 453 "Sessions after term lock are read-only".
**Current:** the state and `locked_at` exist and the database makes a LOCKED session read-only; **no endpoint, permission or trigger moves a session to LOCKED** (doc 41 §7 item 3).
**Missing decision:** who locks (a person, or automatically); what triggers an automatic lock (end of the edit window, term CLOSED, term LOCKED); whether a lock needs a reason; the permission name; whether locking also locks the whole term's sessions.
**Recommended default:** a dedicated permission for administrators (not teachers); an automatic lock when the term becomes LOCKED (doc 02 already makes such sessions read-only), and an optional explicit lock by an administrator with a reason; lock is tier 3 (doc 03). No automatic lock at the end of the faculty window, so administrators can still correct after it (AD-3).
**Consequences:** a new permission and migration, a lock endpoint, an audit action `attendance.session.lock`, a decision on the term-lock cascade, tests (lock then correct is refused). **PENDING.**

## 8. AD-6: unlocking and edits after a lock

**Canonical:** doc 03 line 75 "CRITICAL permissions (term lock override, **mark edit after lock**, role grant) require `reason` and optionally a second approver"; line 289 "lock/unlock" tier 3, "Modification: yes"; doc 02 line 168 "LOCKED = nothing changes without an A2 override"; doc 10 §4 rule 3: CRITICAL needs a reason and a step-up (MFA within 10 minutes) for MFA-required roles, and always an audit event with risk tier 2 or more.
**Current:** a LOCKED session cannot be changed by anyone; there is no override and no unlock.
**Missing decision:** whether an override exists at all in the pilot; who holds it; whether a second approver is required; whether it unlocks a state or allows one edit.
**Recommended default:** no unlock and no edit after lock in the pilot. If the owner wants one: a CRITICAL permission held only by COLLEGE_ADMIN, with reason, step-up and a second approver, each use audited at tier 3, and each edit still a revision.
**Consequences:** none if "no"; if "yes", a CRITICAL permission, step-up integration (exists for other CRITICAL actions), second-approver flow, a `LOCKED` to `SUBMITTED` transition or an override path in the guards, tests. **PENDING.**

## 9. AD-7: session cancellation authority

**Canonical:** doc 01 §3.7 ClassSession owner "Faculty (own), admin"; lifecycle "SCHEDULED→CONDUCTED/CANCELLED"; doc 02 line 256 `cancel_reason`; doc 04 Milestone 4 "class sessions (from timetable, extras, cancel)". No cancel permission, tier or reason list is defined; doc 03 line 289 does not list cancellation.
**Current:** cancel uses `attendance.session.mark` (FACULTY ASSIGNED), works only before attendance is submitted, needs a 5 to 500 character reason, tier-1 audit. Administrators cannot cancel (they do not hold `session.mark`).
**Missing decision:** whether administrators may cancel (the canonical owner line says "Faculty (own), admin"); whether a conducted session may ever be cancelled; whether a dedicated permission is wanted; the audit tier; whether the student sees the cancellation.
**Recommended default:** keep the assigned teacher; add administrator cancellation (HOD, campus and college scopes, as AD-3) with a reason; no cancellation of a conducted session (use correction); cancellation is tier 2 because it removes a teaching record from reporting; no student notification until AD-8.
**Consequences:** either a new `attendance.session.cancel` permission or reuse with GRANTED scopes, matrix and doc 10 rows, a GRANTED branch in `cancelSession`, tests. **PENDING.**

## 10. AD-8: notification requirements

**Canonical:** doc 03 line 401 event catalogue "`attendance.session_submitted`, `attendance.low`, `attendance.record_corrected`"; doc 07 §4 "Events: `attendance.session_submitted`, `attendance.low`, `attendance.record_corrected`" and the paragraph that notifications map event to audience and channels via a `ChannelProvider` registry, "guardian copy only if `guardian.notification_policy` and link flags allow, with minimal content"; doc 04 Milestone 4 "warning thresholds → `attendance.low` events → in-app/push/email"; ADR-020 minors and data minimisation.
**Current:** no event is emitted (the outbox consumer side is not built) and no notification is sent; email delivery has no production mailer.
**Missing decision:** which events are emitted in M4; who is notified of a correction (the student, the HOD, nobody); whether guardians of minors are notified and under which consent; what the message may contain (the status change, or only "your attendance was updated"); which channels.
**Recommended default:** emit all three events to the outbox, deliver in-app to staff only, send nothing to students or guardians until the owner approves audience, content and consent rules; messages carry no reason text and no other student's data.
**Consequences:** outbox event writes in the same transaction as the correction (so a correction never loses its event), a consumer, preference and consent checks, tests that a failed notification never fails the correction. **PENDING.**

## 11. AD-9: audit requirements

**Canonical:** doc 03 line 269 audit fields (`action`, `resource_type`, `resource_id`, `subject_student_id`); line 289 attendance tiers "submit 1, **modification after submission 2**, bulk import 2, lock/unlock 3" with a reason for modification; line 25 "CRITICAL permissions … always emit audit"; doc 02 line 278 revisions are A2 and append-only; doc 06 audit read model (`audit.event.read_student` for student-scoped events).
**Current:** `attendance.session.create` and `attendance.session.submit` tier 1; `attendance.record.correct` tier 2 with reason code, text, subject student, old and new status and revision; `attendance.session.cancel` tier 1 with reason. Revisions are append-only in the database. Denied accesses follow the platform denial audit.
**Missing decision:** the cancellation tier; audit actions and tiers for lock, unlock and override; whether reading a record's revision history is itself audited; whether corrections require the reason text for every reason code (currently only for OTHER).
**Recommended default:** keep submit tier 1 and correction tier 2; raise cancellation to tier 2; lock and unlock tier 3 with a mandatory reason; do not audit ordinary reads (SENSITIVE reads already audit denials); require reason text on every correction once approval exists (AD-4).
**Consequences:** audit action registrations, tier changes in the service, tests per action. **PENDING.**

## 12. What can proceed without these decisions

Work that does not depend on AD-1 to AD-9: `attendance_summaries` and percentage maths using the R-3 defaults that doc 11 already states (75% minimum, LATE counts as present, EXCUSED excluded), student read routes (the SELF read exists in the database), reports, and timetable-driven session generation. Policy storage (`attendance_policies`) should wait for AD-2 to AD-4, because the window and approval fields are part of its schema.

## 13. Owner sign-off (blank; no decision recorded)

| Field                                                   | Entry |
| ------------------------------------------------------- | ----- |
| AD-1 to AD-9 outcomes                                   |       |
| Provisional teacher grant: withdraw / narrow (B) / keep |       |
| Owner                                                   |       |
| Date                                                    |       |

**Formal M3 acceptance:** NOT YET GRANTED (unchanged). **M4 formal acceptance:** NOT GRANTED (unchanged).
