# Milestone 3 Batch 3 — electives, course registrations, X-12, promotion tool, holidays, terminology, setup checklist

Status: **implemented, uncommitted, never applied to a persistent database.** Migration `0039_electives_registrations_holidays.sql`. Specification: doc 02 §4.5/§4.6, doc 07 §3.2, doc 01 (Holiday), doc 04 Part 16 (Milestone 3), doc 09 X-12, doc 11 R-9. Milestone 4 (attendance) is not started.

## 1. What this delivers

| Area | Delivered | Code |
|---|---|---|
| Elective groups | `app.elective_groups` (min/max, window, PLANNED → OPEN → CLOSED); `course_offerings.elective_group_id` | `registration.{schemas,service,routes}.ts` |
| Course registrations | `app.course_registrations` (effective-dated, student-bearing); create, from-section, approve/reject, drop/withdraw/complete; roster and per-enrolment reads | same |
| X-12 | real ASSIGNED resolver for FACULTY `student.profile.read` | `assigned-resolver.ts`, `role-matrix.ts`, doc 10 row 23 |
| Promotion tool | `POST /academics/cohort-periods/:id/promotion` (dry run, all-or-nothing commit, idempotent) | `term-enrollment.{service,routes,schemas}.ts` |
| Holidays | `app.holidays` (campus or organization-wide); list, declare, rename, cancel | `holiday.{service,routes}.ts` |
| Terminology | `terminology` setting registered; `GET /academics/terminology` | `settings/registry.ts`, `setup.service.ts` |
| Setup checklist | `GET /academics/setup-checklist`, every item a count over the database | `setup.service.ts` |
| Class teachers | `0038` guard replaced: postings must cover the whole assignment period | migration `0039` §5.5 |

No new permission code. Web UI: see §11 (staff screens on `/academics`; a student-facing registration screen remains open; the student timeline is doc 34).

## 2. X-12 — the ASSIGNED resolver

FACULTY holds `student.profile.read` in mode **A** (now seeded; doc 10 footnote ¹). `GET /students/:id` first requires the grant at all (none ⇒ 403), then the resolver must prove, by the campus-local date of the offering's campus:

1. the session user's own employee row (`employees.user_id`, never a request value) is `ACTIVE`;
2. it has a faculty assignment on an offering with `valid_from <= today <= COALESCE(valid_to, term end)`;
3. the offering is `PUBLISHED` or `CLOSED`;
4. the student holds a registration on the same offering with `valid_from <= today <= COALESCE(valid_to, term end)` and status neither `PENDING_APPROVAL` nor `REJECTED`.

Every row carries `organization_id = session tenant` (and RLS applies). Anything else is the same 404 as a missing student. The resolver is consulted only for this permission; it gives no list, guardian, identifier or write access. Tests (`m3b3-electives-registrations.test.ts`, "X-12"): assigned and registered ⇒ 200; not registered, dropped (ended yesterday), pending, registration starting later ⇒ 404; assignment ended yesterday, future-dated, employee ON_LEAVE, FACULTY without an employee row ⇒ 404; FACULTY role REVOKED ⇒ 403; other campus's offering both ways ⇒ 404; another tenant's teacher ⇒ 404; assignment ending today still admits today. Mutation checks: dropping the registration window or the employee-status condition each fail a test.

Rollout: existing tenants need `seedTenantRoles` re-run for FACULTY to receive the grant (runbook §3). Until then faculty keep the M1 behaviour (403).

## 3. Course registrations

Rules (all in `course_registrations_guard`, so they bind every writer, the superuser included):

- the term enrolment is `REGISTERED`/`ACTIVE`; `valid_from` and any `valid_to` lie inside the enrolment's term; the offering is `PUBLISHED` and runs in the **same term**;
- audience: the enrolment's own cohort period (and section, on `valid_from`, for a section offering), unless `registration_kind` is `BACKLOG` or `IMPROVEMENT` (doc 07 §3: a backlog paper attaches to the current enrolment);
- one live registration per student and offering (doc 02 partial unique index); history is kept: a drop closes the row (`valid_to`), never deletes it, and a later registration is a new row;
- capacity (`course_offerings.capacity`) counted over live rows under the offering row lock; capacity cannot be lowered below the live count;
- transitions: `PENDING_APPROVAL → REGISTERED | REJECTED`, `REGISTERED → DROPPED | WITHDRAWN | COMPLETED`; a closed row is terminal; live ⇔ open (CHECK).

**Elective groups** (doc 02 §4.5 "validated against group min/max/window"): a basket offering is registered only with source `ELECTIVE_CHOICE`, only while the group is `OPEN` and `now()` is inside `[opens_at, closes_at)`; nobody exceeds `max_select`; `max_select` cannot drop below what a student holds; closing a group requires every live enrolment of the cohort period to hold `min_select`. A CLOSED group is final. No administrative override outside the window exists (not specified; owner decision §8).

**AUTO_FROM_SECTION** (doc 07 §3.2): `POST /academics/course-offerings/:id/registrations/from-section` registers the members open on `validFrom` (enrolment `REGISTERED`/`ACTIVE`) not already registered; all or nothing; re-runnable (a student placed later is picked up by the next run). It is an explicit action rather than a side effect of publishing so that the lock order stays enrolment → offering (publishing locks the offering first; registering inside it would invert the order). Owner decision §8.

Lock order: term enrolment (FOR UPDATE, per-student serialisation of `max_select`) → offering (FOR UPDATE, capacity) → elective group (FOR SHARE). From-section inserts in ascending term-enrolment id.

Authorization: writes `enrollment.term.manage` scoped to BOTH the offering's and the enrolment's campus/department; reads `enrollment.term.read` (roster staff-only; per enrolment also SELF). Groups: `academic.offering.manage` / `academic.program.read`. Audit tier 1 with a reason (doc 02: A1).

## 4. Holidays (doc 01: campus nullable = all campuses, date, name, kind; unique (campus, date, name))

`campus_id NULL` = organization-wide. Uniqueness among ACTIVE rows on (campus or organization, date, lower(name)): an organization row and a campus row may share date and name; several holidays may share a date. A campus calendar (`GET /academics/holidays?campusId=`) is that campus's rows plus the organization rows. Ranges (`from`, `to`) are inclusive. Nothing may be declared, renamed or cancelled on a date inside a **LOCKED** term of the affected campus (all campuses for an organization row). Date, campus and kind are identity (a moved holiday is cancel + declare); `ACTIVE → CANCELLED` is final and frees the name. Writes: `academic.term.manage` on the campus; an organization row needs organization scope (a campus admin gets 403). Reads: `academic.program.read`, organization rows for everyone, campus rows within the reader's campuses. A holiday changes no term and generates nothing yet (Milestone 4 sessions will read it).

## 5. Promotion tool (Part 16; doc 02 §5.3 "promotion without mutation")

`POST /academics/cohort-periods/:id/promotion` `{ targetCohortPeriodId, enrollmentIds?, reason, dryRun? }`.

- **Dry run**: lists the live enrolments as eligible (`ACTIVE`) or excluded (`REGISTERED`, `DETAINED`, `ON_LEAVE`); writes nothing; no key.
- **Commit** (Idempotency-Key required): every eligible enrolment receives exactly the per-enrolment `PROMOTE` decision of doc 32 (`applyDecision`: same checks, locks and two audit events). A selection containing a non-ACTIVE or foreign enrolment is refused. **One transaction**: any refusal rolls the whole batch back (no source changed, no target row, no audit row, no idempotency record).
- **Deterministic locking**: all candidates' student rows are locked FOR NO KEY UPDATE in ascending id before any write (the same first lock as the per-enrolment decision, so the two cannot invert), then processed in ascending student id. Overlapping runs queue on their first shared student; the loser re-reads and refuses as a whole.
- **Idempotency**: the fingerprint is the request (source, target, sorted selection, reason), not the derived candidate set, so a replay after commit returns the stored response; the same key with another body is 422; a concurrent same-key request waits and replays, or gets 409 `IDEMPOTENCY_IN_PROGRESS`.
- The response holds counts only (`promoted`, `excluded`): stored responses are capped at 16 KiB.

Tests: dry run; whole-batch rollback when one student fails (an existing target enrolment), then the same key commits after the cause is removed; replay and 422; two concurrent runs with different keys (exactly one 201); two with the same key (one set of rows); processing order equals ascending student id for a reversed selection; scope 404 / HOD 403 / tenant 404; source rows unchanged except status. Mutation checks: a fingerprint not derived from the request fails the replay test; a descending processing order fails the order test. **Not proven**: absence of deadlock under adversarial interleavings beyond the tested races (no deadlock was observed; none is constructed).

## 6. Terminology (doc 02 §4.2 `terminology`, doc 11 R-9)

Registered with a **closed** set of label slots — `program`, `cohort`, `period`, `section`, `term`, `course` — each 1..40 characters, at least one; no registry default (so the settings list is unchanged until a value is set). Written through the existing `PUT /organization/settings/terminology` (CRITICAL, step-up, reason, audit). `GET /academics/terminology` (any `academic.program.read` holder, students included) returns the stored labels over the display fallbacks Programme / Batch / Semester / Section / Term / Course (R-9 gives Batch / Section / Semester; the other three are the model's own names) and lists the customised slots. Labels are display only: the test snapshots period types, programmes, cohorts, sections, terms and enrolments before and after a school (Curriculum / Intake / Grade / Class / Session / Subject) and a university relabelling and finds them byte-identical. `period_types.label` still names each period type. The web UI reads it on `/academics` (§11); there is no web editor for the setting.

## 7. Setup checklist

`GET /academics/setup-checklist`, organization-scoped `academic.term.manage` only (counts span every campus). Every item is a count over the tenant's rows, so completion is never a ticked flag: ACTIVE campuses, departments, programmes, courses; PLANNED/ACTIVE academic years and open terms; ACTIVE cohort periods and sections in open terms; PUBLISHED offerings in open terms; and three "must be zero" items — published offerings without a teacher assignment running to the term end, live enrolments without an open section where the period has sections, open terms without an ACTIVE holiday. `complete` = every item done. Tests compare counts with direct SQL and watch an item flip when a term or holiday is added.

## 8. Owner decisions (implemented as stated; confirm or change)

1. No administrative registration of a basket offering outside the window (doc 07 names none).
2. AUTO_FROM_SECTION is an explicit, re-runnable action, not a publish side effect.
3. Registrations do not cascade: closing an enrolment, a promotion, a section move or cancelling an offering leaves registrations as they are.
4. A closing group checks `min_select` at that moment; a later drop below `min_select` is not prevented.
5. Holidays: an organization-wide row is refused when any campus has a LOCKED term on that date; no holiday must lie inside a term.
6. Terminology slots and fallbacks (§6).
7. Checklist items and the organization-only scope (§7).
8. The promotion tool promotes only; repeats remain per-enrolment decisions (doc 32).
9. Class-teacher postings: whole-period coverage at creation, no re-check when a posting later ends (doc 32 §7 item 3, no cascade).

## 9. Class-teacher posting rule (replaces `0038` §2 item 2)

`section_class_teachers_guard` (`CREATE OR REPLACE` in `0039`): every day from `valid_from` to `valid_to` (an open row: the term's end) must be covered by a PRIMARY posting of the employee in a department of the section's campus; consecutive postings may share the coverage. Tests: future posting covering a future assignment accepted; posting starting after the assignment refused; posting expiring before an open assignment refused, accepted when the assignment ends in time; already expired refused; department move inside the campus accepted; one-day gap and another campus refused; ending a posting later leaves the row unchanged. Rows created under the `0038` rule are not re-validated (runbook post-check lists them).

## 10. Migration review (`0039`)

- **RLS**: ENABLE + FORCE on all three tables (security-db test); tenant policies with `context_ok()`; writes STAFF-only (RESTRICTIVE); `course_registrations` is student-bearing: a STUDENT reads only rows of their own student record and writes none; added to the schema linter's student-bearing list.
- **Tenant-scoped foreign keys**: all eight foreign keys of the new tables and `course_offerings_elective_group_fk` (nine in all) begin with `organization_id`; the group FK on offerings is `(organization_id, cohort_period_id, elective_group_id)`, so a basket can only be of the offering's own cohort period.
- **Historical preservation**: no DELETE or TRUNCATE grant; column-level UPDATE only (`elective_groups`: name, min/max, window, status; `course_registrations`: status, valid_to; `holidays`: name, status); identities immutable; closed registrations, CLOSED groups and CANCELLED holidays are final.
- **Effective dates**: registration dates inside the term, `valid_to >= valid_from`, live ⇔ open; open rows end with their term in every reader (resolver, checklist); class-teacher coverage per day.
- **Guards**: SECURITY INVOKER, `search_path = pg_catalog`, not executable by PUBLIC.
- **Rollout ordering**: needs `0037` (offerings) and `0038` (the replaced guard). Not a contract migration; deferred behind `0009`/`0019`. `ALTER TABLE app.course_offerings` takes ACCESS EXCLUSIVE briefly (nullable column, no rewrite); `lock_timeout = 5s`. Code must deploy after the migration; the FACULTY re-seed after the code. Runbook: `docs/runbooks/m3b3-electives-registrations-rollout.md`.
- Change made during this review: the basket rule no longer admits source `ADMIN` outside the window (decision §8.1).

## 11. Web UI (`/academics`, staff only)

- **Electives** tab (`academic.program.read`): elective groups per cohort period (choices min–max, window, status, window state); per group the basket with capacity (`taken of capacity` and "Full" for `enrollment.term.read` holders), a paginated per-offering registration list, and, with `enrollment.term.manage`, a student's choices (look up by student ID; only enrolments of the group's cohort period; record an `ELECTIVE_CHOICE`, optionally pending approval; approve, reject, drop or withdraw with a last day, If-Match). Create / change / open / close a group with `academic.offering.manage`. Eligibility is never decided by the page: every request goes to the server.
- **Holidays** tab (`academic.program.read`): organization and campus calendars (cancelled rows kept), date range, 20 per page; with `academic.term.manage`: declare, rename, cancel, and re-declare a cancelled row (pre-filled new declaration). Rows and a chosen date inside a LOCKED term the caller can see are marked before submitting.
- **Setup checklist** tab (`academic.term.manage`): the server's counts, "Verified" vs "Needs an administrator", "Count again"; nothing can be ticked. A campus-scoped caller gets a fixed explanation of the 403.
- **Terminology**: labels from `GET /academics/terminology` drive tab names, headings, section titles and period names; the server's fallbacks apply while loading, on failure, or without the permission. Requests are unchanged by labels.
- **Errors**: the server's text is never shown (web policy). Every guard refusal arrives as 409 `CONFLICT`, so the page names the likely cause from what it already shows (closed window, maximum held, full offering, locked term) and otherwise lists the rules. A distinct error code per guard constraint would make this exact; not done (backend change).
- Not built: student self-service (no endpoint resolves a student's own record; `/profile` is a placeholder), the terminology editor (step-up PUT exists; built in Task 8, doc 35 §4), group creation of offerings into a basket (offerings API only), the promotion tool and AUTO_FROM_SECTION action (API only).
