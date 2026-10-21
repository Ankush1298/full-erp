import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine, type ResourceScope } from '../../shared/authorization/engine.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { invalid, parseReason } from '../people/validation.js';
import {
  lockActiveEnrolment,
  readActiveEnrolment,
  type ActiveEnrolmentRow,
} from './student-program.service.js';
import {
  GUARDIAN_EMAIL_MAX,
  GUARDIAN_NAME_MAX,
  GUARDIAN_PHONE_PATTERN,
  GUARDIAN_RELATION_PATTERN,
  MAX_ACTIVE_GUARDIANS,
  type StudentGuardianDto,
} from './student-guardian.schemas.js';

export const GUARDIAN_READ_PERMISSION = 'student.guardian.read';
export const GUARDIAN_MANAGE_PERMISSION = 'student.guardian.manage';
export const ADD_STUDENT_GUARDIAN_OPERATION = 'POST /api/v1/students/:id/guardians';

const PHONE_RE = new RegExp(GUARDIAN_PHONE_PATTERN);
const RELATION_RE = new RegExp(GUARDIAN_RELATION_PATTERN);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Defensive bound on the list statement only; the service itself never lets more than MAX_ACTIVE_GUARDIANS be active. */
const LIST_SAFETY_LIMIT = 50;

export interface AddStudentGuardianInput {
  fullName: unknown;
  phone: unknown;
  email?: unknown;
  relation: unknown;
  isPrimary?: unknown;
  canViewAcademics?: unknown;
  canReceiveNotifications?: unknown;
  canGiveConsent?: unknown;
  reason: unknown;
}
export interface UpdateStudentGuardianInput {
  fullName?: unknown;
  phone?: unknown;
  email?: unknown;
  relation?: unknown;
  isPrimary?: unknown;
  canViewAcademics?: unknown;
  canReceiveNotifications?: unknown;
  canGiveConsent?: unknown;
  reason: unknown;
}
export interface RemoveStudentGuardianInput {
  reason: unknown;
}

const ADD_KEYS = new Set([
  'fullName',
  'phone',
  'email',
  'relation',
  'isPrimary',
  'canViewAcademics',
  'canReceiveNotifications',
  'canGiveConsent',
  'reason',
]);
const UPDATE_KEYS = ADD_KEYS;
const REMOVE_KEYS = new Set(['reason']);

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

// ---- field validation: shape only, no database, nothing about the tenant is revealed -------------------------------

function onlyKnownKeys(input: unknown, allowed: ReadonlySet<string>, what: string): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid(`${what} payload is required.`);
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalid('The payload contains an unknown field.');
  }
}

function hasControlCharacters(s: string): boolean {
  return Array.from(s).some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f;
  });
}

function parseName(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < 1 || s.length > GUARDIAN_NAME_MAX || hasControlCharacters(s)) {
    throw invalid(
      `fullName must be 1 to ${GUARDIAN_NAME_MAX} characters without control characters.`,
    );
  }
  return s;
}

function parsePhone(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!PHONE_RE.test(s)) {
    throw invalid(
      'phone must be 5 to 30 characters: an optional "+", then digits, spaces, "-", "." or brackets.',
    );
  }
  return s;
}

/** Lower-cased: the table CHECK requires it, and equal addresses must compare equal. */
function parseEmail(value: unknown): string {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    s.length < 3 ||
    s.length > GUARDIAN_EMAIL_MAX ||
    !EMAIL_RE.test(s) ||
    hasControlCharacters(s)
  ) {
    throw invalid('email must be a valid address of at most 320 characters.');
  }
  return s;
}

function parseRelation(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!RELATION_RE.test(s)) {
    throw invalid(
      'relation must be 1 to 50 characters: letters, spaces, ".", "\'" or "-", starting with a letter.',
    );
  }
  return s;
}

function parseFlag(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${field} must be true or false.`);
  return value;
}

function parseIds(studentId: string, guardianId?: string): { sid: string; gid: string } {
  if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
  if (guardianId !== undefined && !isUuidV7(guardianId)) throw invalid('Invalid guardian ID.');
  return { sid: studentId.toLowerCase(), gid: (guardianId ?? '').toLowerCase() };
}

function requireExactVersion(exp: ExpectedVersion): number {
  if (exp.type !== 'version') {
    throw invalid('If-Match must carry the exact version of the guardian.');
  }
  return exp.version;
}

// ---- rows ------------------------------------------------------------------------------------------------------------

interface GuardianRow {
  guardian_id: string;
  student_id: string;
  full_name: string;
  phone: string;
  email: string | null;
  relation: string;
  is_primary: boolean;
  can_view_academics: boolean;
  can_receive_notifications: boolean;
  can_give_consent: boolean;
  valid_from: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

type Placement = Pick<ActiveEnrolmentRow, 'campus_id' | 'department_id'>;

// An ACTIVE link (valid_to IS NULL) to a guardian that is not soft-deleted. Dates are selected as text (the driver would
// otherwise build a JS Date in the server's time zone). The contact data comes from app.guardians only.
const ACTIVE_LINKS = `SELECT sg.guardian_id, sg.student_id, g.full_name, g.phone, g.email, sg.relation, sg.is_primary,
       sg.can_view_academics, sg.can_receive_notifications, sg.can_give_consent,
       sg.valid_from::text AS valid_from, sg.version, sg.created_at, sg.updated_at
  FROM app.student_guardians sg
  JOIN app.guardians g ON g.organization_id = sg.organization_id AND g.id = sg.guardian_id
 WHERE sg.organization_id = $1 AND sg.student_id = $2 AND sg.valid_to IS NULL AND g.deleted_at IS NULL`;

function toDto(r: GuardianRow): StudentGuardianDto {
  return {
    id: r.guardian_id,
    studentId: r.student_id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    relation: r.relation,
    isPrimary: r.is_primary,
    canViewAcademics: r.can_view_academics,
    canReceiveNotifications: r.can_receive_notifications,
    canGiveConsent: r.can_give_consent,
    validFrom: r.valid_from,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null ? err : {};
}

function primaryTaken(): AppError {
  return new AppError(
    409,
    'STUDENT_GUARDIAN_PRIMARY_EXISTS',
    'This student already has a primary guardian. Demote it first.',
  );
}

/**
 * Student guardians (docs/architecture/v3/02 §4.4, 06 §6, ADR-020; migration 0027): list, add, update and remove the
 * guardians of ONE student. The only code that reads or writes `app.guardians` and the new-shape rows of
 * `app.student_guardians` (a static test pins that, and pins that no other module's SQL mentions a guardian).
 *
 * ORDER (each step can only reveal what the one before it allowed): request shape (400) -> actor and permission held
 * (403; add also: staff only) -> [add: unlocked scope proof (404), then Idempotency-Key (428/400), then claim/replay] ->
 * student row (`FOR NO KEY UPDATE` for writes; missing or other tenant: 404) -> scope proof under the lock (404, the same
 * answer as a missing student) -> [update/remove: link row locked, 404; version 409] -> write -> tier-2 audit LAST, in the
 * caller's transaction (no audit, no change).
 *
 * SCOPE: both permissions are GRANTED (read is also SELF for the student). An ORGANIZATION grant covers every student; a
 * campus- or department-scoped grant is proven only from the student's ACTIVE enrolment's frozen campus/department; a
 * student with no ACTIVE enrolment carries no placement, so only an ORGANIZATION grant reaches it (same rule as the status
 * service). A STUDENT actor reaches only their own student (SELF) and only read, never write.
 *
 * LOCKS: every write takes the student row first, then the student's ACTIVE enrolment, then the link and guardian rows: the
 * student-first order of the status and enrolment services. All guardian writes of one student are serialised (the cap and
 * the primary slot cannot race) and an explicit enrolment close cannot change the placement under a scope proof.
 *
 * PRIVACY (ADR-020): contact data is stored once (app.guardians); the audit event carries field NAMES and non-contact
 * values, never a name, phone or e-mail; the cached idempotent response carries only the new id; a guardian is created
 * together with its one link (no lookup of existing guardians by phone or name, which would let a scoped manager discover
 * guardians of students outside their scope). The flags record consent and visibility, they do not compute access.
 *
 * REMOVE = end-dating (`valid_to` = campus-local today, never before `valid_from`; primary slot freed), never a delete; the guardian is soft-deleted when its last
 * active link ends. This is accountability (a mandatory reason), NOT step-up authentication, and denied requests are not
 * audited: both are separate, unresolved gates.
 */
export class StudentGuardianService {
  /** Active guardians of one student. Not held: 403. Missing OR out of scope: the same 404. No audit on read. */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<StudentGuardianDto[]> {
    ensureTrusted(ctx);
    const { sid } = parseIds(studentId);
    await AuthorizationEngine.assert(tx, ctx, GUARDIAN_READ_PERMISSION);

    const student = await tx.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM app.students WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, sid],
    );
    const row = student.rows[0];
    if (!row) throw resourceNotFound();
    // SELF needs no placement; a staff grant is judged against the active enrolment. Read for every actor: row security
    // shows a student only their own enrolment, and no actor-kind comparison belongs in a service.
    const placement = await readActiveEnrolment(tx, ctx.tenantId, sid);
    await AuthorizationEngine.assert(tx, ctx, GUARDIAN_READ_PERMISSION, {
      organization_id: ctx.tenantId,
      student_id: row.id,
      user_id: row.user_id,
      ...placementScope(placement),
    });

    const res = await tx.query<GuardianRow>(
      `${ACTIVE_LINKS} ORDER BY sg.is_primary DESC, sg.created_at, sg.guardian_id LIMIT ${LIST_SAFETY_LIMIT}`,
      [ctx.tenantId, sid],
    );
    return res.rows.map(toDto);
  }

  /**
   * Creates a guardian and its link to the student, idempotently (`Idempotency-Key`). Flags default to false and nothing
   * is primary unless asked. 409 when the student already has MAX_ACTIVE_GUARDIANS active guardians or a primary one.
   */
  static async add(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: AddStudentGuardianInput,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    onlyKnownKeys(input, ADD_KEYS, 'Guardian');
    const { sid } = parseIds(studentId);
    const fullName = parseName(input.fullName);
    const phone = parsePhone(input.phone);
    const email = input.email === undefined ? null : parseEmail(input.email);
    const relation = parseRelation(input.relation);
    const isPrimary = parseFlag(input.isPrimary, 'isPrimary') ?? false;
    const canViewAcademics = parseFlag(input.canViewAcademics, 'canViewAcademics') ?? false;
    const canReceiveNotifications =
      parseFlag(input.canReceiveNotifications, 'canReceiveNotifications') ?? false;
    const canGiveConsent = parseFlag(input.canGiveConsent, 'canGiveConsent') ?? false;
    const reason = parseReason(input.reason);

    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, GUARDIAN_MANAGE_PERMISSION);
    // Scope BEFORE the claim (unlocked, like StudentProgramService.open): a replay of a stored response must not bypass
    // it. The callback below proves it again under the student row lock, which is the authoritative check.
    const known = await tx.query(
      'SELECT 1 FROM app.students WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, sid],
    );
    if ((known.rowCount ?? 0) === 0) throw resourceNotFound();
    await assertManageScope(tx, ctx, await readActiveEnrolment(tx, ctx.tenantId, sid));
    // Only an authorized caller learns whether its key header is acceptable.
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: ADD_STUDENT_GUARDIAN_OPERATION,
        // The NORMALISED request (trimmed, e-mail lower-cased, flags resolved): equal requests hash equally.
        request: {
          studentId: sid,
          fullName,
          phone,
          email,
          relation,
          isPrimary,
          canViewAcademics,
          canReceiveNotifications,
          canGiveConsent,
          reason,
        },
      },
      async () => {
        const placement = await lockStudentAndProveScope(tx, ctx, sid);

        const active = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM app.student_guardians
            WHERE organization_id = $1 AND student_id = $2 AND guardian_id IS NOT NULL AND valid_to IS NULL`,
          [ctx.tenantId, sid],
        );
        if (Number(active.rows[0]?.n ?? 0) >= MAX_ACTIVE_GUARDIANS) {
          throw new AppError(
            409,
            'STUDENT_GUARDIAN_LIMIT_REACHED',
            `A student can have at most ${MAX_ACTIVE_GUARDIANS} active guardians.`,
          );
        }

        const guardianId = uuidv7();
        await tx.query(
          `INSERT INTO app.guardians (id, organization_id, full_name, phone, email)
           VALUES ($1, $2, $3, $4, $5)`,
          [guardianId, ctx.tenantId, fullName, phone, email],
        );
        try {
          await tx.query(
            `INSERT INTO app.student_guardians
               (id, organization_id, student_id, guardian_id, relation, is_primary,
                can_view_academics, can_receive_notifications, can_give_consent, valid_from)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)`,
            [
              uuidv7(),
              ctx.tenantId,
              sid,
              guardianId,
              relation,
              isPrimary,
              canViewAcademics,
              canReceiveNotifications,
              canGiveConsent,
              await calendarToday(tx, ctx.tenantId, placement),
            ],
          );
        } catch (err) {
          if (
            pgError(err).code === '23505' &&
            pgError(err).constraint === 'student_guardians_one_primary_link_uq'
          ) {
            throw primaryTaken();
          }
          throw err;
        }

        await recordAudit(
          tx,
          ctx,
          {
            action: 'student_guardian.add',
            resourceType: 'student_guardian',
            resourceId: guardianId,
            subjectStudentId: sid,
            ...auditPlacement(placement),
            riskTier: 2,
            reasonText: reason,
            // Field names and non-contact values only: the guardian's name, phone and e-mail are never copied here.
            changes: {
              relation: { old: null, new: relation },
              isPrimary: { old: null, new: isPrimary },
              canViewAcademics: { old: null, new: canViewAcademics },
              canReceiveNotifications: { old: null, new: canReceiveNotifications },
              canGiveConsent: { old: null, new: canGiveConsent },
            },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id: guardianId } } };
      },
    );
  }

  /**
   * Changes the guardian's contact data and/or the link attributes. `If-Match` must carry the exact version (the link's).
   * An empty change (every value equals the stored one) answers the current record without a write, a version bump or an
   * audit event. 409 on a stale version or when another guardian is already primary.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    guardianId: string,
    input: UpdateStudentGuardianInput,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<StudentGuardianDto> {
    ensureTrusted(ctx);
    onlyKnownKeys(input, UPDATE_KEYS, 'Guardian');
    const { sid, gid } = parseIds(studentId, guardianId);
    const patch = {
      fullName: input.fullName === undefined ? undefined : parseName(input.fullName),
      phone: input.phone === undefined ? undefined : parsePhone(input.phone),
      email:
        input.email === undefined
          ? undefined
          : input.email === null
            ? null
            : parseEmail(input.email),
      relation: input.relation === undefined ? undefined : parseRelation(input.relation),
      isPrimary: parseFlag(input.isPrimary, 'isPrimary'),
      canViewAcademics: parseFlag(input.canViewAcademics, 'canViewAcademics'),
      canReceiveNotifications: parseFlag(input.canReceiveNotifications, 'canReceiveNotifications'),
      canGiveConsent: parseFlag(input.canGiveConsent, 'canGiveConsent'),
    };
    if (Object.values(patch).every((v) => v === undefined)) {
      throw invalid('At least one field to change is required.');
    }
    const reason = parseReason(input.reason);
    const expectedVersion = requireExactVersion(options.expected);

    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, GUARDIAN_MANAGE_PERMISSION);
    const placement = await lockStudentAndProveScope(tx, ctx, sid);
    const current = await lockActiveLink(tx, ctx.tenantId, sid, gid);

    // Only now may the caller learn anything about the stored version or state.
    if (current.version !== expectedVersion) {
      throw new AppError(409, 'CONFLICT', 'Guardian version mismatch.');
    }

    const next = {
      fullName: patch.fullName ?? current.full_name,
      phone: patch.phone ?? current.phone,
      email: patch.email === undefined ? current.email : patch.email,
      relation: patch.relation ?? current.relation,
      isPrimary: patch.isPrimary ?? current.is_primary,
      canViewAcademics: patch.canViewAcademics ?? current.can_view_academics,
      canReceiveNotifications: patch.canReceiveNotifications ?? current.can_receive_notifications,
      canGiveConsent: patch.canGiveConsent ?? current.can_give_consent,
    };
    const contactChanged =
      next.fullName !== current.full_name ||
      next.phone !== current.phone ||
      next.email !== current.email;
    const linkChanges: Record<string, { old: unknown; new: unknown }> = {};
    const track = (name: string, before: unknown, after: unknown): void => {
      if (before !== after) linkChanges[name] = { old: before, new: after };
    };
    track('relation', current.relation, next.relation);
    track('isPrimary', current.is_primary, next.isPrimary);
    track('canViewAcademics', current.can_view_academics, next.canViewAcademics);
    track(
      'canReceiveNotifications',
      current.can_receive_notifications,
      next.canReceiveNotifications,
    );
    track('canGiveConsent', current.can_give_consent, next.canGiveConsent);
    if (!contactChanged && Object.keys(linkChanges).length === 0) return toDto(current);

    if (contactChanged) {
      await tx.query(
        `UPDATE app.guardians SET full_name = $3, phone = $4, email = $5
          WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, gid, next.fullName, next.phone, next.email],
      );
    }
    // Always written (identical values are fine): the link's version is the ETag of the whole guardian resource, so a
    // contact-only change must bump it too, and the guarded WHERE makes the version check atomic.
    let updated;
    try {
      updated = await tx.query(
        `UPDATE app.student_guardians
            SET relation = $5, is_primary = $6, can_view_academics = $7,
                can_receive_notifications = $8, can_give_consent = $9
          WHERE organization_id = $1 AND student_id = $2 AND guardian_id = $3 AND version = $4
            AND valid_to IS NULL`,
        [
          ctx.tenantId,
          sid,
          gid,
          current.version,
          next.relation,
          next.isPrimary,
          next.canViewAcademics,
          next.canReceiveNotifications,
          next.canGiveConsent,
        ],
      );
    } catch (err) {
      if (
        pgError(err).code === '23505' &&
        pgError(err).constraint === 'student_guardians_one_primary_link_uq'
      ) {
        throw primaryTaken();
      }
      throw err;
    }
    if (updated.rowCount !== 1) {
      throw new AppError(409, 'CONFLICT', 'Guardian was changed concurrently. Retry.');
    }

    const fresh = await tx.query<GuardianRow>(`${ACTIVE_LINKS} AND sg.guardian_id = $3`, [
      ctx.tenantId,
      sid,
      gid,
    ]);
    const saved = fresh.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'Guardian was changed concurrently. Retry.');

    await recordAudit(
      tx,
      ctx,
      {
        action: 'student_guardian.update',
        resourceType: 'student_guardian',
        resourceId: gid,
        subjectStudentId: sid,
        ...auditPlacement(placement),
        riskTier: 2,
        reasonText: reason,
        changes: {
          ...linkChanges,
          // Contact fields are named, never valued (ADR-020 data minimisation).
          ...(next.fullName !== current.full_name ? { fullName: { changed: true } } : {}),
          ...(next.phone !== current.phone ? { phone: { changed: true } } : {}),
          ...(next.email !== current.email ? { email: { changed: true } } : {}),
        },
      },
      options.meta ?? {},
    );
    return toDto(saved);
  }

  /**
   * Ends the guardian's link to the student (`valid_to` = the campus-local date of the active enrolment, or the UTC date
   * when there is none, never before `valid_from`; primary slot freed); the guardian is soft-deleted when it has no
   * other active link. `If-Match` must carry the exact version. An ended link is terminal: a second remove is 404.
   */
  static async remove(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    guardianId: string,
    input: RemoveStudentGuardianInput,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<void> {
    ensureTrusted(ctx);
    onlyKnownKeys(input, REMOVE_KEYS, 'Guardian removal');
    const { sid, gid } = parseIds(studentId, guardianId);
    const reason = parseReason(input.reason);
    const expectedVersion = requireExactVersion(options.expected);

    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, GUARDIAN_MANAGE_PERMISSION);
    const placement = await lockStudentAndProveScope(tx, ctx, sid);
    const current = await lockActiveLink(tx, ctx.tenantId, sid, gid);

    if (current.version !== expectedVersion) {
      throw new AppError(409, 'CONFLICT', 'Guardian version mismatch.');
    }

    const ended = await tx.query<{ valid_to: string }>(
      `UPDATE app.student_guardians SET valid_to = GREATEST($5::date, valid_from), is_primary = false
        WHERE organization_id = $1 AND student_id = $2 AND guardian_id = $3 AND version = $4
          AND valid_to IS NULL
    RETURNING valid_to::text AS valid_to`,
      [ctx.tenantId, sid, gid, current.version, await calendarToday(tx, ctx.tenantId, placement)],
    );
    const endedRow = ended.rows[0];
    if (!endedRow) throw new AppError(409, 'CONFLICT', 'Guardian was changed concurrently. Retry.');

    // The identity outlives the link only while another active link still needs it.
    await tx.query(
      `UPDATE app.guardians g SET deleted_at = now()
        WHERE g.organization_id = $1 AND g.id = $2 AND g.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM app.student_guardians o
                           WHERE o.organization_id = g.organization_id AND o.guardian_id = g.id
                             AND o.valid_to IS NULL)`,
      [ctx.tenantId, gid],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'student_guardian.remove',
        resourceType: 'student_guardian',
        resourceId: gid,
        subjectStudentId: sid,
        ...auditPlacement(placement),
        riskTier: 2,
        reasonText: reason,
        changes: {
          validTo: { old: null, new: endedRow.valid_to },
          ...(current.is_primary ? { isPrimary: { old: true, new: false } } : {}),
        },
      },
      options.meta ?? {},
    );
  }

  /**
   * Verifies that a guardian is actively linked to the student with can_give_consent = true.
   * Internal verification helper for consent recording (doc 02 §4.3).
   */
  public static async verifyConsentAuthority(
    tx: TenantTx,
    tenantId: string,
    studentUserId: string,
    guardianId: string,
  ): Promise<boolean> {
    const res = await tx.query<{
      can_give_consent: boolean;
      valid_from: string;
      valid_to: string | null;
    }>(
      `SELECT sg.can_give_consent, sg.valid_from::text, sg.valid_to::text
         FROM app.student_guardians sg
         JOIN app.guardians g ON g.organization_id = sg.organization_id AND g.id = sg.guardian_id
         JOIN app.students s ON s.organization_id = sg.organization_id AND s.id = sg.student_id
        WHERE sg.organization_id = $1 AND g.id = $2 AND s.user_id = $3 AND g.deleted_at IS NULL`,
      [tenantId, guardianId, studentUserId],
    );
    const activeLink = res.rows.find((link) => {
      const today = new Date().toISOString().slice(0, 10);
      return link.valid_from <= today && (!link.valid_to || link.valid_to >= today);
    });
    return activeLink?.can_give_consent === true;
  }
}

// ---- shared steps ----------------------------------------------------------------------------------------------------

function placementScope(p: Placement | null): ResourceScope {
  return p ? { campus_id: p.campus_id, department_id: p.department_id } : {};
}

function auditPlacement(p: Placement | null): { campusId?: string; departmentId?: string } {
  return p ? { campusId: p.campus_id, departmentId: p.department_id } : {};
}

/**
 * Proves the caller's `student.guardian.manage` grant reaches this student from `placement`: the ACTIVE enrolment's frozen
 * campus/department, or null. The scope is what the database holds, never anything the caller supplied. Out of scope is
 * the same 404 as a missing student.
 */
async function assertManageScope(
  tx: TenantTx,
  ctx: TrustedContext,
  placement: Placement | null,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, GUARDIAN_MANAGE_PERMISSION, {
    organization_id: ctx.tenantId,
    ...placementScope(placement),
  });
}

/**
 * The authoritative proof for a write. LOCK PROTOCOL: student row (`FOR NO KEY UPDATE`; 404 when missing or of another
 * tenant), THEN the student's ACTIVE enrolment (`FOR NO KEY UPDATE`, `lockActiveEnrolment`): the order of the status
 * service and of `StudentProgramService.open` (student first; `close` locks only the enrolment, so no cycle). `open` and the
 * status change are serialised with this write by the student lock; an explicit `close` is held back by the enrolment lock
 * until this transaction ends. The placement the grant is judged against is therefore the one that is still true when the
 * write commits; a read without the lock could be changed by a close that commits in between.
 */
async function lockStudentAndProveScope(
  tx: TenantTx,
  ctx: TrustedContext,
  studentId: string,
): Promise<Placement | null> {
  const student = await tx.query<{ id: string }>(
    `SELECT id FROM app.students WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [ctx.tenantId, studentId],
  );
  if (!student.rows[0]) throw resourceNotFound();
  const placement = await lockActiveEnrolment(tx, ctx.tenantId, studentId);
  await assertManageScope(tx, ctx, placement);
  return placement;
}

/**
 * Today's calendar date for a guardian date. Same convention as `StudentProgramService` (`now() AT TIME ZONE` the campus's
 * IANA zone): the campus of the student's ACTIVE enrolment. A student with NO active enrolment has no campus, and the
 * tenant has no timezone of its own, so the UTC date is used, explicitly (never the database session's date).
 */
async function calendarToday(
  tx: TenantTx,
  tenantId: string,
  placement: Placement | null,
): Promise<string> {
  const res = placement
    ? await tx.query<{ today: string }>(
        `SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM app.campuses
          WHERE organization_id = $1 AND id = $2`,
        [tenantId, placement.campus_id],
      )
    : await tx.query<{ today: string }>(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today`);
  const today = res.rows[0]?.today;
  if (!today) throw resourceNotFound(); // the composite foreign keys make this unreachable for a placed student
  return today;
}

/** The ACTIVE link of this guardian to this student, with the link and the guardian row locked. Else 404. */
async function lockActiveLink(
  tx: TenantTx,
  tenantId: string,
  studentId: string,
  guardianId: string,
): Promise<GuardianRow> {
  const res = await tx.query<GuardianRow>(
    `${ACTIVE_LINKS} AND sg.guardian_id = $3 FOR NO KEY UPDATE OF sg, g`,
    [tenantId, studentId, guardianId],
  );
  const row = res.rows[0];
  if (!row) throw resourceNotFound();
  return row;
}
