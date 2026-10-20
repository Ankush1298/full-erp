import { requestFingerprint } from '../../shared/idempotency/idempotency.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { CursorCodec } from '../../shared/pagination/index.js';
import { invalid } from '../people/validation.js';
import {
  DIRECTORY_DEFAULT_LIMIT,
  DIRECTORY_MAX_LIMIT,
  STUDENT_STATUSES,
  type StudentDirectoryEntry,
} from './student.schemas.js';

export const DIRECTORY_LIST_PERMISSION = 'student.directory.list';
/** Cursor route binding AND audit action: one name, so a cursor can never be replayed against another route. */
export const DIRECTORY_LIST_ROUTE_ID = 'student.directory.list';

export interface DirectoryListInput {
  status?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface DirectoryListOptions {
  codec: CursorCodec;
  /** Key ID the codec encodes new cursors with (audit only; the cursor itself is never audited). */
  activeKeyId: string;
  meta: AuditRequestMeta;
  /** Request-scoped logger (pino `req.log`). Optional so the service stays usable without one; only identifier-free events are written. */
  log?: DirectoryLog;
}

/** The slice of a pino logger the service uses. */
export interface DirectoryLog {
  warn(obj: object, msg: string): void;
}

/** Structured event for a failed next-cursor issuance. Fixed fields only: no value, id, cursor or exception text. */
export const CURSOR_ISSUE_FAILED_EVENT = 'student_directory_cursor_issue_failed';

export interface DirectoryPage {
  items: StudentDirectoryEntry[];
  nextCursor: string | null;
}

interface Row {
  id: string;
  admission_number: string;
  display_name: string;
  status: StudentDirectoryEntry['status'];
}

/**
 * Paginated staff directory (docs/architecture/v3/21-students.md §0c). Separate from the exact lookup
 * (StudentDirectoryService), which stays unchanged.
 *
 * WHO IS LISTED: only students with an ACTIVE enrolment in `app.student_programs` whose frozen campus or department lies
 * inside one of the caller's GRANTED `student.directory.list` scopes (ORGANIZATION = every placed student). Unplaced
 * students and students whose enrolments are all closed are NEVER listed, for any role, so every returned entry has
 * `hasActiveEnrolment: true`. The scope comes from the grants read from the database, never from the request, and
 * nothing is inferred from a role name or widened hierarchically (CAMPUS does not contain DEPARTMENT).
 *
 * ORDER AND POSITION: keyset on admission_number ASC, compared and sorted by the column's own (database) collation inside
 * one statement, so the ordering and the "after this row" comparison agree. (organization_id, admission_number) is unique
 * and immutable, so the last admission number alone is an exact position. A student has at most one ACTIVE enrolment, so
 * the EXISTS never multiplies rows and LIMIT is exact. The walk is NOT a snapshot: rows enrolled, closed or created
 * during it can appear, move out of scope or be missed. `limit + 1` rows are read to learn whether another page exists.
 *
 * CURSOR: AES-GCM codec bound to tenant, user, route and the normalised `status` filter; the position never leaves the
 * encrypted envelope. Any invalid cursor is the codec's single 400 INVALID_CURSOR.
 *
 * AUDIT: every successful page is audited (`student.directory.list`, tier 1) in the SAME transaction, after the read:
 * if the audit insert fails the transaction rolls back and the request fails. Metadata holds only route, normalised
 * status, requested limit, returned count, whether a cursor was supplied and the key ID a new cursor was issued with:
 * never the cursor, an admission number, a student id or a name. Denied requests are not audited here.
 */
export class StudentDirectoryListService {
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    input: DirectoryListInput,
    options: DirectoryListOptions,
  ): Promise<DirectoryPage> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    // Staff only, before any query: row security hides enrolments from non-staff, which would read as an empty page.
    AuthorizationEngine.assertStaffActor(ctx);

    const status = parseStatus(input.status);
    const limit = parseLimit(input.limit);
    const cursor = parseCursor(input.cursor);

    // Held at all (403). The effective grants then bound which placed students are listed.
    await AuthorizationEngine.assert(tx, ctx, DIRECTORY_LIST_PERMISSION);
    const grants = (
      await AuthorizationEngine.loadGrants(tx, ctx, DIRECTORY_LIST_PERMISSION)
    ).filter((g) => g.scope_mode === 'GRANTED');
    const orgWide = grants.some((g) => g.scope_type === 'ORGANIZATION');
    const campusIds = grants
      .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id)
      .map((g) => g.scope_id);
    const departmentIds = grants
      .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id)
      .map((g) => g.scope_id);

    const binding = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      routeId: DIRECTORY_LIST_ROUTE_ID,
      filterHash: requestFingerprint(DIRECTORY_LIST_ROUTE_ID, { status }),
    };
    // Before the query: a bad cursor never reaches the database.
    const after =
      cursor === undefined ? null : options.codec.decode(cursor, binding).lastAdmissionNumber;

    const res = await tx.query<Row>(
      `SELECT s.id, s.admission_number, u.display_name, s.status
         FROM app.students s
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE s.organization_id = $1
          AND ($2::text IS NULL OR s.status = $2::text)
          AND ($3::text IS NULL OR s.admission_number > $3::text)
          AND EXISTS (SELECT 1 FROM app.student_programs sp
                       WHERE sp.organization_id = s.organization_id AND sp.student_id = s.id
                         AND sp.status = 'ACTIVE'
                         AND ($4::boolean OR sp.campus_id = ANY($5::uuid[]) OR sp.department_id = ANY($6::uuid[])))
        ORDER BY s.admission_number ASC
        LIMIT $7`,
      [ctx.tenantId, status, after, orgWide, campusIds, departmentIds, limit + 1],
    );

    const more = res.rows.length > limit;
    const rows = more ? res.rows.slice(0, limit) : res.rows;
    const last = rows[rows.length - 1];
    const nextCursor =
      more && last !== undefined
        ? issueCursor(options.codec, binding, last.admission_number, options.log)
        : null;

    await recordAudit(
      tx,
      ctx,
      {
        action: 'student.directory.list',
        resourceType: 'student_directory',
        riskTier: 1,
        metadata: {
          route: 'GET /api/v1/students/directory',
          status,
          limit,
          returned: rows.length,
          cursorPresent: cursor !== undefined,
          issuedKeyId: nextCursor === null ? null : options.activeKeyId,
        },
      },
      options.meta,
    );

    return {
      items: rows.map((r) => ({
        id: r.id,
        admissionNumber: r.admission_number,
        displayName: r.display_name,
        status: r.status,
        hasActiveEnrolment: true,
      })),
      nextCursor,
    };
  }
}

/**
 * The codec accepts only 1-64 printable ASCII characters as a position, while the database only bounds admission_number to
 * 1-50 characters (the create service enforces letters, digits, "-" and "_", but a seed, import or privileged writer does
 * not). If the LAST row of a page holds a value the codec refuses, no next cursor can be issued. The page is then refused
 * with a fixed, deliberate 500 (nothing returned, nothing audited, the value never echoed or logged) instead of an uncaught
 * codec error, and instead of silently dropping the cursor, which would present a truncated list as complete. The data
 * (or a database CHECK on admission_number) has to be fixed; that is a data/product decision, not made here.
 */
function issueCursor(
  codec: CursorCodec,
  binding: { tenantId: string; userId: string; routeId: string; filterHash: string },
  lastAdmissionNumber: string,
  log: DirectoryLog | undefined,
): string {
  try {
    return codec.encode({ ...binding, lastAdmissionNumber });
  } catch {
    // Identifier-free on purpose: the exception (its message could name the field or value), the admission number, the
    // cursor, the student, tenant and user ids are all left out. `category` is the only failure class there is today.
    log?.warn(
      {
        event: CURSOR_ISSUE_FAILED_EVENT,
        route: DIRECTORY_LIST_ROUTE_ID,
        category: 'cursor_encode_rejected',
      },
      'student directory next cursor could not be issued',
    );
    throw new AppError(
      500,
      'DIRECTORY_CURSOR_UNAVAILABLE',
      'The next page cannot be addressed. Contact an administrator.',
    );
  }
}

function parseStatus(v: unknown): StudentDirectoryEntry['status'] | null {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !(STUDENT_STATUSES as readonly string[]).includes(v)) {
    throw invalid(`status must be one of ${STUDENT_STATUSES.join(', ')}.`);
  }
  return v as StudentDirectoryEntry['status'];
}

function parseLimit(v: unknown): number {
  if (v === undefined) return DIRECTORY_DEFAULT_LIMIT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > DIRECTORY_MAX_LIMIT) {
    throw invalid(`limit must be an integer from 1 to ${DIRECTORY_MAX_LIMIT}.`);
  }
  return v;
}

function parseCursor(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  // Shape is the codec's concern (one uniform 400); only refuse a non-string so it is never decoded.
  if (typeof v !== 'string') throw invalid('cursor must be a string.');
  return v;
}
