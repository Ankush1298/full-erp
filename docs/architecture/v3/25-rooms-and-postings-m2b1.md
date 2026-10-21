# 25 — Rooms (Milestone 2 Batch 1)

Roadmap: Milestone 2 "Organization + People" (`04` Part 16). This batch is rooms and employee postings only; student identifiers, the import framework and everything in Milestone 3 and later are untouched. Employee postings are in `20-employees.md` §6.

Specification: `01` Room (required `campus_id, code, kind`; optional `name, capacity`; owner Admin; "code unique per campus"; audit **A0**: "none (standard timestamps only)") and `02` §4.2 `rooms: FK campus_id | UQ(campus_id, code) | kind, capacity?`. Implementation: migration `0034`, `room.service.ts`, `organization.routes.ts`, `organization.schemas.ts`, `OrganisationPage.tsx`; tests `rooms.test.ts`, `phase1-pages.test.tsx`.

## 1. Model (owner Decision 1: aligned to the specification)

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | uuid v7 | no | primary key |
| `organization_id` | uuid | no | tenant; composite FK with `campus_id` to `campuses (organization_id, id)` |
| `campus_id` | uuid | no | owning campus, immutable |
| `code` | text 1–20 | no | unique per `(organization, campus)`, immutable; the same code may exist on another campus |
| `kind` | text 1–50 | **no** | free text. **The documents define no values; none is invented.** |
| `name` | text 1–255 | yes | optional |
| `capacity` | smallint > 0 | yes | optional |
| `version` | integer | no | optimistic concurrency (`ETag` / `If-Match`), `08` §4 "every mutable aggregate has `version`" |
| `created_at`, `updated_at` | timestamptz | no | standard columns |

Removed from the first implementation: `room_type` (renamed `kind`, fixed vocabulary dropped), `building`, `floor`, `status` (no lifecycle: the documents give rooms none), and the `reason` request field. The API accepts exactly `code, kind, name?, capacity?` on create and `kind?, name?, capacity?` (null clears name and capacity) on update; any other property is a 400. List filter: `kind`. Runtime grants: `SELECT, INSERT`, `UPDATE (kind, name, capacity)`; no `DELETE`. FORCE RLS; writes are staff-only at the database; tenant and campus come from the session and the URL, never the body.

## 2. Authorization (unchanged)

Reads `org.structure.read`, writes `org.campus.manage`, both scoped to the owning campus (campus-scoped administrators act on their own campus only; out of scope is 404; students and faculty cannot write: 403). No room-specific permission was added.

## 3. No room audit events (owner Decision 2)

Rooms are audit class A0, so `RoomService` writes no `audit_events` row (create, update, failed attempts). Auditing of employees, postings and separation is unchanged. A test asserts the audit table receives nothing for rooms.

## 4. No campus-status rule (resolved)

The first implementation refused to create a room on an `INACTIVE` campus. Nothing authorises that for rooms: `01` Room and `02` §4.2 impose no campus-status condition, and the only "campus ACTIVE" rule in the architecture (`18` line 32) concerns *grantable role-assignment scopes*. It was an invented business rule and was removed (service check and trigger branch). Kept: tenant isolation, the composite campus foreign key, campus-scoped authorization, code uniqueness per campus, immutability of code and campus. Tested with a private tenant whose campus is `INACTIVE`.

## 5. Gaps recorded for owner review (undefined by the documents; technical choices, not decisions)

1. `kind` vocabulary: free text of 1–50 characters. If the owner wants a controlled list, it should be an organisation setting or a lookup table, decided with the documents.
2. Bounds: `code` 1–20 characters (repository code convention), `name` ≤ 255, `capacity` a positive smallint (storage limit, not a business maximum).
3. There is no way to retire a room: no status and no delete. If rooms must be retired, that needs a specified lifecycle.
4. `created_by` / `updated_by` actor columns (`02` §4.1, "mutable business tables") are not implemented for rooms (nor for employees or postings); with A0 there is no audit trail of who changed a room.
5. `version`/`ETag` for rooms is taken from the v3.1 convention; the M1 table list in `08` §4 predates rooms.
