# 34 — Student academic timeline and as-of-date position (M3 acceptance remediation, Task 6)

Status: implemented, uncommitted. Canonical requirement: `04` Part 16, Milestone 3, UI "student timeline" and Done "timeline matches 'as of date' fixtures". No migration, no new table, no new permission.

## 1. Endpoint

`GET /api/v1/students/:id/timeline?asOf=YYYY-MM-DD` (route permission `student.profile.read`; `backend/src/modules/students/student-timeline.service.ts`, schemas in `student.schemas.ts`).

- `asOf` optional; default is **today on the campus calendar** of the student's latest programme enrolment (`UTC` when the student has none). The zone is returned as `timezone`, the date as `today`.
- `asOf` must be a real date (400 `VALIDATION_ERROR` otherwise) and **not after today** (400): a future date would present planned rows as facts.
- Envelope `{ success: true, data }`. `data`: `studentId`, `asOfDate`, `today`, `timezone`, `position`, `events`, `undatedOutcomes`, `futureEventsExcluded`, `limitations`.
- Read-only: no write, no audit event (pinned by a test), no idempotency.

## 2. Authorization

1. **Profile gate = `StudentService.getById`, unchanged.** UUID check (400), `student.profile.read`, tenant-scoped read (RLS + `organization_id`), then the scoped assert: SELF by `student_id`/`user_id`, CAMPUS/DEPARTMENT by the student's ACTIVE programme enrolment (B6 rule), FACULTY ASSIGNED by the X-12 resolver. Missing, other-tenant and out-of-scope students are one 404.
2. **Per-row filter.** Each programme enrolment (and everything under it: term enrolments, section memberships, course registrations) is returned only if the caller passes `enrollment.term.read` against **that** enrolment's frozen campus/department (the same rule as `TermEnrollmentService.listForStudent`). A 403 or 404 there hides the rows and is never an error of the whole read.
   - HOD / DEPARTMENT_ADMIN: another department's history is never returned, also not in the as-of position, the outcome list or the future-event count.
   - FACULTY (`student.profile.read` ASSIGNED, no `enrollment.term.read`): the taught student only, and only the profile-level events (admission, status). Widening this is an owner decision (§7).
   - STUDENT: own record only (SELF), all own rows.
3. No count or hint of hidden rows is returned.

## 3. Event sources (derived; no event store)

| Event                                                                                | Source row                                                           | Date                                                                                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMISSION`                                                                          | `students.admission_date`                                            | that date (omitted when NULL, limitation)                                                                                                  |
| `STUDENT_STATUS_CHANGED`                                                             | `students.status`, `status_changed_at`                               | campus-local date of `status_changed_at`; only the **latest** change; not emitted for `ADMITTED` (nothing transitions into it)            |
| `PROGRAMME_STARTED` / `PROGRAMME_ENDED`                                              | `student_programs.start_date` / `end_date`, `status`, `exit_reason`  | those dates (`end_date` = last day)                                                                                                        |
| `TERM_ENROLLED` / `REPEAT_ENROLLED`                                                  | `term_enrollments` (+ term, cohort period, period type label)        | effective start (§4)                                                                                                                       |
| `SECTION_PLACED` / `SECTION_TRANSFERRED`                                             | `section_memberships.valid_from` (a later row of the same enrolment is a transfer) | `valid_from`                                                                                                                  |
| `COURSE_REGISTERED` / `COURSE_REREGISTERED`                                          | `course_registrations.valid_from` (a later row for the same enrolment + offering is a re-registration) | `valid_from`                                                                                              |
| `COURSE_DROPPED` / `_WITHDRAWN` / `_COMPLETED` / `_REJECTED`                         | `course_registrations.status`, `valid_to`                            | `valid_to` (last day)                                                                                                                      |
| **undated:** `PROMOTED`, `DETAINED`, `TERM_COMPLETED`, `TERM_WITHDRAWN`, `TERM_ON_LEAVE` | `term_enrollments.status`                                         | **none** (`eventDate: null`, `temporal: UNDATED`), listed in `undatedOutcomes` once the enrolment's effective start is on or before `asOf` |

Promotion is visible as the undated `PROMOTED` outcome plus the next period's `TERM_ENROLLED`; repetition as `REPEAT_ENROLLED` (cohort period of the junior batch); detention as `DETAINED` (or, once a repeat closed it, `TERM_COMPLETED`, which is what the row records). `updated_at`, `registered_at` and `created_at` are **never** used as event dates: they record when a row was written or last touched, not when a decision took effect.

Every event carries typed context (`programme`, `cohortName`, `term`, `periodNo`, `periodLabel`, `section`, `course`, `status`), `sourceId` (the source row), `description` and `temporal`: `CURRENT` (the source record is in effect on `asOf`), `HISTORICAL`, or `UNDATED`.

## 4. Date-boundary rules (valid time, doc 02 §5.4)

- A record is **in effect on D** when `from <= D <= to` (both inclusive; open `to` = no end). `valid_to` / `end_date` are the last day (a section move closes the old row at `validFrom - 1`; `02` §5.4 uses `>=`).
- A **term enrolment** has no effective dates: its span is the term's `[start_date, end_date]` **clipped to its programme enrolment's** `[start_date, end_date]` (a mid-term joiner is not enrolled before joining, a leaver not after leaving).
- A **section membership or registration** never outlives its term enrolment: an open one (and a later closing date) ends at the enrolment's effective end. This is the same rule as the X-12 resolver's `COALESCE(valid_to, term end)`.
- **Events after `asOf` are excluded** and counted in `futureEventsExcluded` (scoped rows only). This excludes future-dated rows already recorded, e.g. an enrolment in a later semester, or a drop effective next week. On such a date the registration still shows as in effect.
- **No later state is projected backwards:** a registration now `DROPPED` is shown on an earlier in-window date as `REGISTERED` (`statusOnDate`), with `recordedStatus` alongside. `PENDING_APPROVAL` / `REJECTED` rows are `PENDING_APPROVAL` throughout. A programme enrolment is `ACTIVE` on every day of its span (a close is only possible from ACTIVE, `0021`).
- **Student status on D:** before `admission_date` → not admitted (`admitted: false`); `ADMITTED` today → `ADMITTED`; otherwise the current status only from the date of `status_changed_at`, **unknown (`null`) before it**.
- Recording time vs valid time: a row recorded later for an earlier period (back-office entry) is shown in its effective period. The as-of view answers "what was in effect on D according to today's records", not "what the system said on D". The second question needs history the schema does not keep (§6).

## 5. Ordering (deterministic)

`events` and `undatedOutcomes` are sorted ascending by:

1. `eventDate`;
2. lifecycle rank on the same date: admission 10 < programme start 20 < term/repeat enrolment 30 < section placement 40 < transfer 41 < course (re)registration 50 < course close 60 < programme end 80 < status change 90 (< undated outcomes 100);
3. `sourceId` (UUIDv7, time-ordered);
4. event type.

The rank, not row age, decides same-date order (a test registers a course on the day of a status change of an older student row). Two identical requests return identical bodies (tested).

## 6. Limitations (returned per response in `limitations`, never guessed)

| Code                                  | When                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ADMISSION_DATE_NOT_RECORDED`         | `admission_date` is NULL (legacy rows before the `0019` contract)                                       |
| `BEFORE_ADMISSION`                    | `asOf` is before the admission date                                                                     |
| `STATUS_BEFORE_LAST_CHANGE_UNKNOWN`   | `asOf` is before the only dated status change (or the change is undated)                                |
| `TERM_OUTCOMES_UNDATED`               | an undated outcome is listed                                                                            |
| `REGISTRATION_APPROVAL_UNDATED`       | a past `asOf` with a registration in effect: an approval after `asOf` cannot be distinguished          |

Schema limits behind them (no fix in this task, no migration):

1. **Term-enrolment status changes are not dated** (REGISTERED → ACTIVE → PROMOTED/DETAINED/COMPLETED/WITHDRAWN/ON_LEAVE). Only `audit_events` holds them, and the runtime role has no `SELECT` on it (`0007`). A `term_enrollment_events` table, like `student_program_events`, would be needed to date promotion/detention.
2. **Student status history:** only `status_changed_at` (latest). Same audit restriction.
3. **Registration approval** (`PENDING_APPROVAL` → `REGISTERED`) is not dated.
4. **Programme leave** (`student_programs.ON_LEAVE`) is not produced by any service (`0021` refuses it); nothing to show.
5. **Recording-time history** ("what did the record say on D") is not reconstructible: corrections overwrite in place.

## 7. Owner decisions (open)

1. Should FACULTY see, in the timeline, the registration in the offering they teach (today: profile-level events only, the same as every other enrolment read)?
2. Should a department-scoped holder see the student's earlier history in another department (today: no, per-row scope as in `listForStudent`)?
3. Should term-enrolment and student-status transitions get dated history tables (§6 items 1-2)? That would be a migration and a writer change in `TermEnrollmentService` / `StudentStatusService`.

## 8. Web

`StudentProfilePage` → card "Academic timeline" (`apps/web/src/pages/StudentProfilePage.tsx`, client `fetchStudentTimeline` in `students-api.ts`), shown to every reader of the profile (the server filters rows):

- the date picker "Position as of" (`max` = server `today`), with "Show" and "Back to today";
- the position on the date: student status (or "Unknown on this date" / "Not yet admitted"), programme and batch, each term in effect with period (label from the programme's period type: Grade / Year / Semester), roll, section on that date, and registrations with their status on that date;
- "Incomplete history" notes (the `limitations`);
- the events table: date, event, programme, term/period, section, course and status, description, and "In effect" or "Historical";
- the count of later events not shown, and "Recorded outcomes without a date".

Column headings use the institution's terminology (`GET /academics/terminology`, display only, when `academic.program.read` is held); no canonical name changes.

## 9. Tests

- `backend/tests/integration/student-timeline.test.ts` (14), with all academic rows written over HTTP:
  - school: Grades 5→6, sections 5-A→5-B, detention and repeat with the junior batch, drop and re-registration;
  - college: annual Year 1→2, and semester with promotion into a future semester;
  - university: semester, programme transfer between departments, withdrawn year, pending registration;
  - as-of boundaries: section move day, between terms, last day of a registration, after a drop, before admission, last day of a closed programme;
  - future/malformed `asOf`, same-date order, determinism;
  - self, HOD A/B, FACULTY ASSIGNED, other tenant, 400/401/404, no audit row.
- Mutation checks (each reverted): no per-row scope filter, no `asOf` exclusion, no enrolment clipping, exclusive `valid_to`, no same-date rank, guessed status. Each fails at least one test.
- `apps/web/tests/students-timeline.test.tsx` (6, fake backend): today vs historical view, before admission, terminology, profile-only reader, error/retry, axe.
- `students-page.test.tsx`: two pins now allow exactly the timeline request for a profile-only reader.
