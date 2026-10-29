# 29 — Student Records UI (Milestone 2, Batch 5)

Status: **web-only, implemented and tested against the fake backend.** No backend, migration, permission or configuration change. Doc 04 Part 16, Milestone 2 "UI: … student profile". Nothing here has been verified against a running backend or a real database.

## 1. Routes

| Web route | Guard (UX only; the API is the boundary) | API calls |
|---|---|---|
| `/students` | any of `student.profile.read`, `student.directory.list`, `student.directory.search` | `GET /api/v1/students/directory?limit=25[&status][&cursor]` (only with `student.directory.list`); `GET /api/v1/students?admissionNumber=` (only with `student.directory.search`) |
| `/students/:id` | `student.profile.read` | `GET /api/v1/students/:id`; then `GET …/:id/identifiers` (only with `student.profile.read_sensitive`); `GET …/:id/term-enrollments` (only with `enrollment.term.read`); `GET /api/v1/academics/terms` (only with `academic.program.read`, and only when there are enrolments, to show term names) |

Code: `apps/web/src/lib/api/students-api.ts`, `src/pages/StudentsPage.tsx`, `src/pages/StudentProfilePage.tsx`; `studentReadMessage` / `directoryFailure` in `src/lib/api/messages.ts`. Tests: `apps/web/tests/students-page.test.tsx`.

## 2. Behaviour

- **Directory** (doc 21 §0c): the server decides who is listed (placed students inside the caller's scopes). The UI sends only `limit`, `status` and the opaque `nextCursor`; it never sends a tenant, campus or department. "Load more" appends the next page; changing the status filter restarts from the first page (the cursor is bound to the filter). The cursor is held in component state only (never storage, never the page URL).
- **Feature flag / cursor keys**: the browser cannot see `STUDENT_DIRECTORY_LIST_ENABLED` or `CURSOR_KEYS`. **Contract gap: the backend has no stable signal for "directory not enabled".** When the route is not registered the path is read as `GET /students/:id` with a malformed id, and the answer is `400 BAD_REQUEST`, the same status and code as a malformed directory query (bad `status`, out-of-range `limit`, unknown parameter) on an enabled server; only `INVALID_CURSOR` is distinct (observed on 2026-10-29 with a database-free probe of the real `buildApp`, consistent with `tests/unit/student-directory-activation.test.ts`). The UI therefore reports any other directory `400` with one neutral message ("the server did not accept the request. It may not be enabled on this server"), never asserts that the flag is off, lists nothing, and does **not** fall back to another listing. A distinguishable answer (for example a stub route returning a dedicated code) would be a backend change that doc 21 §0c deliberately did not make; it is an owner decision and is not made here.
- **Expired / rejected cursor** (`400 INVALID_CURSOR`): the next page is refused, the rows already shown stay, and the user can restart from the first page. `429` shows the `Retry-After` wait. `500 DIRECTORY_CURSOR_UNAVAILABLE` shows the generic failure. A filter change while "Load more" is in flight discards that answer.
- **Search**: exact, case-sensitive admission number (doc 21 §0b), at most one result. Unknown, out-of-scope and other-tenant numbers produce the one message "No student was found, or the record is outside your access."
- **Profile**: admission number, status, status-since date, admission date. `organizationId`, `userId` and `version` are parsed but never shown. Missing, out-of-scope, other-tenant and malformed ids give one "Student not found" state and no section is requested. A server `403` shows the access-restricted page. Identifiers, term enrolments and term details each have their own loading, empty, error and retry state; a failing section does not hide or re-request the others. Nothing after the record is requested when the record is not found or refused.
- All wording is fixed in the client; server message text is never rendered. Nothing is written to `localStorage` or `sessionStorage`, and nothing is logged.

## 3. Gaps (not built; no API exists or the API does not return it)

1. **No name on the profile.** `GET /students/:id` returns no display name; only the directory and lookup DTOs carry one. The profile heading uses the admission number. Passing the name through navigation state was rejected (it would put personal data in browser history state).
2. **No programme / cohort / campus / department on the profile.** There is no read endpoint for `student_programs` (only open/close `POST`s), and the term enrolment carries only `studentProgramId`.
3. **Term names** come from `GET /academics/terms` (`academic.program.read`). Without that permission, or when the server-scoped list does not contain the term, the row shows "Term details unavailable". There is no per-term read for enrolment readers.
4. **No course registrations or timetable** on the profile: no such student-scoped read API exists.
5. **No name search, totals or facets** in the directory (doc 21 §0c, deliberate).
6. **Students' own profile (`/profile`) stays a placeholder.** A student would need their own student id, which `/auth/me` does not return, and no implicit `STUDENT` role assignment exists yet (doc 21, follow-up).
7. **Guardians are not shown** (out of scope for this batch; `student.guardian.read` exists).
8. No editing of any kind (status change, identifiers, enrolments) is offered here.

## 4. Operational dependencies (unchanged by this batch)

- The directory works only where the operator has configured valid `CURSOR_KEYS` + `CURSOR_ACTIVE_KEY_ID` **and** `STUDENT_DIRECTORY_LIST_ENABLED=true`, with the single-instance limiter, audit-volume and query-plan caveats of doc 21 §0c.
- `student.directory.list` (`0024`) and `student.directory.search` (`0023`) reach existing tenants only after those migrations and a `seedTenantRoles` re-run, neither of which has been performed.
