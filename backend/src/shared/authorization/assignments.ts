import { AppError, resourceNotFound } from '../errors/http-errors.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { uuidv7, isUuidV7 } from '../ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../audit/index.js';
import { SCOPE_TYPES, type ScopeType } from './catalog.js';
import { AuthorizationEngine, scopeContains, type Scope } from './engine.js';
import { lockPersonIdentity } from './person-identity.js';
import { GRANT_RULES, ROLE_SCOPE_TYPES, isRoleCode, type RoleCode } from './role-matrix.js';
import { PERMISSION_CATALOG } from './catalog.js';
import { MFA_REQUIRED_ROLES } from './mfa-policy.js';

function forbidden(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Access denied.');
}

export interface GrantInput {
  targetUserId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string;
  /** Why the role is being granted (06 §5: CRITICAL actions need a reason). Stored in the audit row. */
  reason: string;
  /**
   * Optional end of the assignment: an RFC 3339 date-time WITH an offset, strictly in the future. Absent = no expiry.
   * Enforced by the engine (every authorization query filters `valid_until > now()`), never by the UI.
   */
  validUntil?: unknown;
}

/** Serialises every "might remove the last administrator" decision of a tenant (shared with UserService.suspend). */
export function administratorLockKey(tenantId: string): string {
  return `app.user_admin_exclusive:${tenantId}`;
}

const MAX_VALID_UNTIL_YEAR = 2200; // the platform-wide calendar bound (every date column of the schema)
const OFFSET_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/**
 * Strict end-of-assignment parser: an ISO date-time string with an explicit offset (no ambiguous local times), a real instant
 * not beyond the platform bound. Returns the normalised UTC instant. Whether it lies in the FUTURE is decided against the
 * database clock by the caller (`assertFuture`). Messages never echo the value.
 */
export function parseValidUntil(value: unknown): string {
  const bad = () =>
    new AppError(
      400,
      'VALIDATION_ERROR',
      'validUntil must be an ISO 8601 date-time with a time zone offset, for example 2027-06-30T18:30:00Z.',
    );
  const m = typeof value === 'string' && value.length <= 40 ? OFFSET_DATE_TIME.exec(value) : null;
  if (!m || typeof value !== 'string') throw bad();
  // Date.parse accepts impossible calendar dates (2030-02-30 rolls over to March) and leap seconds: check the parts.
  const [y, mo, dayOfMonth, hh, mi, ss, oh, om] = [
    m[1],
    m[2],
    m[3],
    m[4],
    m[5],
    m[6],
    m[7],
    m[8],
  ].map((x) => (x === undefined ? 0 : Number(x))) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const day = new Date(Date.UTC(y, mo - 1, dayOfMonth));
  if (
    day.getUTCFullYear() !== y ||
    day.getUTCMonth() !== mo - 1 ||
    day.getUTCDate() !== dayOfMonth ||
    hh > 23 ||
    mi > 59 ||
    ss > 59 ||
    oh > 23 ||
    om > 59
  ) {
    throw bad();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw bad();
  const d = new Date(ms);
  if (d.getUTCFullYear() > MAX_VALID_UNTIL_YEAR) throw bad();
  return d.toISOString();
}

async function assertFuture(tx: TenantTx, instant: string): Promise<void> {
  const res = await tx.query<{ ok: boolean }>('SELECT $1::timestamptz > now() AS ok', [instant]);
  if (res.rows[0]?.ok !== true) {
    throw new AppError(400, 'VALIDATION_ERROR', 'validUntil must be in the future.');
  }
}

function adminsCannotExpire(): AppError {
  return new AppError(
    400,
    'VALIDATION_ERROR',
    'An organization administrator assignment cannot have an expiry: the organization must always keep an effective administrator.',
  );
}

/** A meaningful reason: trimmed, 5..500 characters, with at least one letter or digit. */
export function normaliseReason(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 5 || text.length > 500 || !/[\p{L}\p{N}]/u.test(text)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'A reason of 5 to 500 characters is required for this change.',
    );
  }
  return text;
}

/**
 * The only writer of role_assignments. Authorization for a grant/revoke is decided here from
 * server-side state: the grantor's permission, the grantor's own assignments (scope containment +
 * grant rules, 06 §5) and the target role/user rows read inside the tenant transaction.
 */
export class RoleAssignmentService {
  /** The grantor must hold one active assignment whose role may grant `target` and whose scope contains `scope`. */
  private static async assertMayManage(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: 'role.assignment.grant' | 'role.assignment.revoke',
    targetRole: RoleCode,
    scope: Scope,
  ): Promise<void> {
    await AuthorizationEngine.assert(tx, ctx, permission); // 403 if the permission is not held at all

    const mine = await tx.query<{ code: string; scope_type: ScopeType; scope_id: string | null }>(
      `SELECT r.code, ra.scope_type, ra.scope_id
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())`,
      [ctx.tenantId, ctx.userId],
    );
    const ok = mine.rows.some(
      (a) =>
        (GRANT_RULES[a.code] ?? []).includes(targetRole) &&
        scopeContains({ type: a.scope_type, id: a.scope_id }, scope),
    );
    if (!ok) throw forbidden();
  }

  /**
   * Proves the target campus/department is grantable AND keeps it so until this transaction ends.
   *
   * LOCK ORDER (the convention every writer of campuses/departments must follow): campus first, then
   * department, one row per statement. Plain `FOR SHARE` rows block a concurrent status/soft-delete UPDATE
   * (which takes FOR NO KEY UPDATE) until the grant commits, so a deactivation cannot land between this check
   * and the INSERT. The foreign keys of the INSERT do NOT provide that protection: they take FOR KEY SHARE,
   * which a non-key UPDATE does not conflict with. Under READ COMMITTED a row changed by a transaction that
   * committed while we waited is re-checked against the WHERE clause, so a deactivation that wins is seen.
   * Two grants only ever share-lock, so they cannot deadlock each other; a deactivation that follows the
   * same order (campus before department) cannot form a cycle with a grant either.
   */
  private static async lockGrantableScope(
    tx: TenantTx,
    tenantId: string,
    scopeType: ScopeType,
    scopeId: string | undefined,
  ): Promise<void> {
    if (scopeType === 'ORGANIZATION') return;
    let campusId = scopeId;
    if (scopeType === 'DEPARTMENT') {
      // campus_id of a department is immutable (no UPDATE grant), so reading it unlocked is safe.
      const dept = await tx.query<{ campus_id: string }>(
        `SELECT campus_id FROM app.departments
          WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'`,
        [tenantId, scopeId],
      );
      campusId = dept.rows[0]?.campus_id;
      if (!campusId) throw resourceNotFound();
    }
    const campus = await tx.query(
      `SELECT 1 FROM app.campuses
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
          FOR SHARE`,
      [tenantId, campusId],
    );
    if (campus.rowCount === 0) throw resourceNotFound();
    if (scopeType === 'DEPARTMENT') {
      // Second lock, re-checking the state the unlocked read saw.
      const dept = await tx.query(
        `SELECT 1 FROM app.departments
          WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'ACTIVE'
            FOR SHARE`,
        [tenantId, scopeId],
      );
      if (dept.rowCount === 0) throw resourceNotFound();
    }
  }

  /**
   * Grants a role. The assignment row and its audit event are written in the CALLER'S tenant
   * transaction (`tx`): they commit or roll back together, and an audit failure fails the grant.
   */
  static async grant(
    tx: TenantTx,
    ctx: TrustedContext,
    input: GrantInput,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    const { targetUserId, roleId, scopeType, scopeId } = input;
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    const reason = normaliseReason(input.reason);
    const validUntil = input.validUntil === undefined ? null : parseValidUntil(input.validUntil);
    if (!SCOPE_TYPES.includes(scopeType)) throw forbidden();
    if (scopeType === 'ORGANIZATION' ? scopeId !== undefined : !scopeId || !isUuidV7(scopeId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid scope.');
    }
    const scope: Scope = { type: scopeType, id: scopeId ?? null };

    // FIRST database statement: the per-person lock shared with student and employee creation, taken before any other
    // lock or read the decision depends on (shared/authorization/person-identity.ts). It is taken before the
    // permission check on purpose (the lock order has no exceptions); no HTTP route calls this service yet, and a
    // route that does must gate the permission first, as every route does through its `config.permission`.
    if (typeof targetUserId === 'string' && isUuidV7(targetUserId)) {
      await lockPersonIdentity(tx, ctx.tenantId, targetUserId);
    }
    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.grant');
    if (ctx.userId === targetUserId) throw forbidden(); // no self-elevation

    // Target user and role must exist in THIS tenant (RLS hides other tenants: same 404 as absent).
    const user = await tx.query('SELECT 1 FROM app.users WHERE organization_id = $1 AND id = $2', [
      ctx.tenantId,
      targetUserId,
    ]);
    const role = await tx.query<{ code: string }>(
      'SELECT code FROM app.roles WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, roleId],
    );
    const roleCode = role.rows[0]?.code;
    if (user.rowCount === 0 || !roleCode || !isRoleCode(roleCode)) throw resourceNotFound();

    if (!ROLE_SCOPE_TYPES[roleCode].includes(scopeType)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Scope type is not valid for this role.');
    }
    await this.assertMayManage(tx, ctx, 'role.assignment.grant', roleCode, scope);

    // Expiry rules, after authorization. An administrator assignment never expires (the last-administrator invariant is
    // about EFFECTIVE administrators; a date would make it vanish silently), and any other end must lie in the future.
    if (validUntil !== null) {
      if (roleCode === 'COLLEGE_ADMIN') throw adminsCannotExpire();
      await assertFuture(tx, validUntil);
    }

    // Person-identity invariant (docs/architecture/v3/21-students.md §6), decided after authorization so an
    // unauthorised caller learns nothing about student records, and under the lock taken above:
    //  * a STUDENT role belongs to a student: it requires an existing student record (service rule only; the trigger
    //    of migration 0020 does not impose it, so raw writers keep their order freedom);
    //  * any OTHER role is refused on an account that has a student record (the trigger of 0020 is the backstop).
    const student = await tx.query(
      'SELECT 1 FROM app.students WHERE organization_id = $1 AND user_id = $2',
      [ctx.tenantId, targetUserId],
    );
    const hasStudentRecord = (student.rowCount ?? 0) > 0;
    if (roleCode === 'STUDENT' && !hasStudentRecord) {
      throw new AppError(
        409,
        'CONFLICT',
        'The STUDENT role can only be granted to an account that already has a student record.',
      );
    }
    if (roleCode !== 'STUDENT' && hasStudentRecord) {
      throw new AppError(
        409,
        'CONFLICT',
        'This account has a student record and cannot be given a staff role.',
      );
    }

    // Checked only AFTER the grantor is authorised for this scope, so an unauthorised caller cannot use the
    // response to learn which campus/department ids exist. Unknown, other-tenant, INACTIVE, soft-deleted
    // scopes (and a department under an INACTIVE campus) are the same 404 as an unknown role or user.
    await this.lockGrantableScope(tx, ctx.tenantId, scopeType, scopeId);

    const existing = await tx.query(
      `SELECT 1 FROM app.role_assignments
        WHERE organization_id = $1 AND user_id = $2 AND role_id = $3 AND status = 'ACTIVE'
          AND (valid_until IS NULL OR valid_until > now())
          AND scope_type = $4 AND scope_id IS NOT DISTINCT FROM $5::uuid`,
      [ctx.tenantId, targetUserId, roleId, scopeType, scopeId ?? null],
    );
    if ((existing.rowCount ?? 0) > 0) {
      throw new AppError(409, 'CONFLICT', 'User already has this role in this scope.');
    }

    const id = uuidv7();
    // scope_id stays the engine's source of truth; the typed column that matches the scope type is
    // written with the same value (the others stay NULL) so the 0009 integrity check holds.
    try {
      await tx.query(
        `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          id,
          ctx.tenantId,
          targetUserId,
          roleId,
          scopeType,
          scopeId ?? null,
          scopeType === 'CAMPUS' ? scopeId : null,
          scopeType === 'DEPARTMENT' ? scopeId : null,
          validUntil,
        ],
      );
    } catch (err) {
      // Backstop of migration 0020 (a writer that bypassed the check above): same answer as the explicit check.
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23P01' && e.constraint === 'person_record_exclusive') {
        throw new AppError(
          409,
          'CONFLICT',
          'This account has a student record and cannot be given a staff role.',
        );
      }
      throw err;
    }
    if (MFA_REQUIRED_ROLES.includes(roleCode as (typeof MFA_REQUIRED_ROLES)[number])) {
      const u = await tx.query<{ identity_id: string | null }>(
        'SELECT identity_id FROM app.users WHERE organization_id = $1 AND id = $2',
        [ctx.tenantId, targetUserId],
      );
      if (u.rows[0]?.identity_id) {
        await tx.query(
          `UPDATE platform.auth_sessions
              SET mfa_verified_at = NULL, step_up_at = NULL, auth_strength = 'PASSWORD'
            WHERE identity_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
          [u.rows[0].identity_id, ctx.tenantId],
        );
      }
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'role.assignment.grant',
        resourceType: 'role_assignment',
        resourceId: id,
        riskTier: 2,
        ...(scopeType === 'CAMPUS' && scopeId ? { campusId: scopeId } : {}),
        ...(scopeType === 'DEPARTMENT' && scopeId ? { departmentId: scopeId } : {}),
        changes: {
          status: { old: null, new: 'ACTIVE' },
          user_id: { old: null, new: targetUserId },
          role_code: { old: null, new: roleCode },
          scope_type: { old: null, new: scopeType },
          scope_id: { old: null, new: scopeId ?? null },
          // only when an end was set: the audit shape of a grant without an expiry is unchanged (role-audit.test.ts pins it)
          ...(validUntil !== null ? { valid_until: { old: null, new: validUntil } } : {}),
        },
        reasonText: reason,
      },
      meta,
    );
    return id;
  }

  /** Revokes an assignment. Same atomicity as `grant`: the status change and its audit event share `tx`. */
  static async revoke(
    tx: TenantTx,
    ctx: TrustedContext,
    assignmentId: string,
    reason: string,
    meta: AuditRequestMeta = {},
  ): Promise<void> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    const cleanReason = normaliseReason(reason);
    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.revoke');

    // The role of an assignment is immutable (guard trigger), so it can be read before the lock. An administrator
    // assignment is revoked only under the tenant's administrator lock (the one UserService.suspend takes), because two
    // administrators revoking each other must not both pass the "someone remains" check below.
    const peek = await tx.query<{ code: string }>(
      `SELECT r.code FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.id = $2`,
      [ctx.tenantId, assignmentId],
    );
    const isAdminRole = peek.rows[0]?.code === 'COLLEGE_ADMIN';
    if (isAdminRole) {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        administratorLockKey(ctx.tenantId),
      ]);
    }
    const adminsBefore = isAdminRole
      ? (await AuthorizationEngine.effectiveAdministratorIds(tx, ctx.tenantId)).length
      : 0;

    const found = await tx.query<{
      user_id: string;
      code: string;
      scope_type: ScopeType;
      scope_id: string | null;
    }>(
      `SELECT ra.user_id, r.code, ra.scope_type, ra.scope_id
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.id = $2 AND ra.status = 'ACTIVE'
        FOR UPDATE OF ra`,
      [ctx.tenantId, assignmentId],
    );
    const row = found.rows[0];
    if (!row || !isRoleCode(row.code)) throw resourceNotFound();

    if (row.user_id === ctx.userId) throw forbidden(); // no self-revocation
    await this.assertMayManage(tx, ctx, 'role.assignment.revoke', row.code, {
      type: row.scope_type,
      id: row.scope_id,
    });

    await tx.query(
      `UPDATE app.role_assignments SET status = 'REVOKED' WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, assignmentId],
    );
    // Last-administrator protection (06 §5), exact and race-free: under the administrator lock, if the organization HAD an
    // effective administrator and this revocation leaves none, the whole transaction (update and audit) is rolled back.
    // (The old reasoning "only an administrator may revoke an administrator, and not themselves" is not enough: two
    // administrators can revoke each other concurrently.)
    if (isAdminRole && adminsBefore > 0) {
      const after = await AuthorizationEngine.effectiveAdministratorIds(tx, ctx.tenantId);
      if (after.length === 0) {
        throw new AppError(
          409,
          'LAST_ADMINISTRATOR',
          'The last effective administrator of the organization cannot be revoked.',
        );
      }
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'role.assignment.revoke',
        resourceType: 'role_assignment',
        resourceId: assignmentId,
        riskTier: 2,
        ...(row.scope_type === 'CAMPUS' && row.scope_id ? { campusId: row.scope_id } : {}),
        ...(row.scope_type === 'DEPARTMENT' && row.scope_id ? { departmentId: row.scope_id } : {}),
        changes: { status: { old: 'ACTIVE', new: 'REVOKED' } },
        metadata: {
          user_id: row.user_id,
          role_code: row.code,
          scope_type: row.scope_type,
          scope_id: row.scope_id,
        },
        reasonText: cleanReason,
      },
      meta,
    );
  }

  /**
   * Changes (or clears) the end of an ACTIVE, still effective assignment. Authorized exactly like a grant (a longer or
   * unlimited assignment IS a grant): `role.assignment.grant` (CRITICAL), the grantor's own rules and scope, never on
   * yourself. Optimistic concurrency on the row version (409 on a mismatch), mandatory reason, tier-2 audit in the same
   * transaction. An expired assignment cannot be extended (grant again instead); an administrator assignment never expires.
   */
  static async updateExpiry(
    tx: TenantTx,
    ctx: TrustedContext,
    assignmentId: string,
    input: { validUntil: unknown; reason: unknown; expectedVersion: number },
    meta: AuditRequestMeta = {},
  ): Promise<{ id: string; validUntil: string | null; version: number }> {
    if (!isTrustedContext(ctx)) {
      throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
    }
    const reason = normaliseReason(input.reason);
    const next = input.validUntil === null ? null : parseValidUntil(input.validUntil);
    if (!isUuidV7(assignmentId))
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid assignment ID.');

    // The person lock is the first statement of every writer that can reach the 0020 trigger (a valid_until change does).
    // user_id of an assignment is immutable, so it can be read before the lock.
    const peek = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM app.role_assignments WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, assignmentId],
    );
    if (peek.rows[0]) await lockPersonIdentity(tx, ctx.tenantId, peek.rows[0].user_id);
    await AuthorizationEngine.assert(tx, ctx, 'role.assignment.grant');

    const found = await tx.query<{
      user_id: string;
      code: string;
      scope_type: ScopeType;
      scope_id: string | null;
      valid_until: Date | null;
      version: number;
      effective: boolean;
    }>(
      `SELECT ra.user_id, r.code, ra.scope_type, ra.scope_id, ra.valid_until, ra.version,
              (ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())) AS effective
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.id = $2 AND ra.status = 'ACTIVE'
        FOR UPDATE OF ra`,
      [ctx.tenantId, assignmentId],
    );
    const row = found.rows[0];
    if (!row || !isRoleCode(row.code)) throw resourceNotFound();
    if (row.user_id === ctx.userId) throw forbidden(); // no self-elevation
    await this.assertMayManage(tx, ctx, 'role.assignment.grant', row.code, {
      type: row.scope_type,
      id: row.scope_id,
    });

    if (row.version !== input.expectedVersion) {
      throw new AppError(409, 'CONFLICT', 'Role assignment version mismatch.');
    }
    if (!row.effective) {
      throw new AppError(
        409,
        'ASSIGNMENT_NOT_EFFECTIVE',
        'This assignment has expired or has not started. Grant the role again instead.',
      );
    }
    if (next !== null) {
      if (row.code === 'COLLEGE_ADMIN') throw adminsCannotExpire();
      await assertFuture(tx, next);
    }
    const before = row.valid_until ? row.valid_until.toISOString() : null;
    if (before === next) return { id: assignmentId, validUntil: before, version: row.version }; // no-op: no write, no audit

    const updated = await tx.query<{ version: number }>(
      `UPDATE app.role_assignments SET valid_until = $3::timestamptz
        WHERE organization_id = $1 AND id = $2 AND version = $4 AND status = 'ACTIVE'
        RETURNING version`,
      [ctx.tenantId, assignmentId, next, row.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'Role assignment version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'role.assignment.update_expiry',
        resourceType: 'role_assignment',
        resourceId: assignmentId,
        riskTier: 2,
        ...(row.scope_type === 'CAMPUS' && row.scope_id ? { campusId: row.scope_id } : {}),
        ...(row.scope_type === 'DEPARTMENT' && row.scope_id ? { departmentId: row.scope_id } : {}),
        changes: { valid_until: { old: before, new: next } },
        metadata: {
          user_id: row.user_id,
          role_code: row.code,
          scope_type: row.scope_type,
          scope_id: row.scope_id,
        },
        reasonText: reason,
      },
      meta,
    );
    return { id: assignmentId, validUntil: next, version: saved.version };
  }

  // ---- read side for role administration (Milestone 2, B2) ---------------------------------------------------------------
  // These queries live here because this layer alone may read the role tables. They perform NO authorization: the only
  // caller, UserService, proves `user.account.read` at organization scope (and the target user's existence) first.

  /**
   * Roles of the caller's tenant that the platform defines (`ROLE_CODES`): a row whose code is not a known role is never
   * returned, so nothing outside the role model can be offered for assignment. `grantable` is the caller's role-level grant rule.
   */
  static async describeRoles(
    tx: TenantTx,
    ctx: TrustedContext,
  ): Promise<
    {
      id: string;
      code: string;
      name: string;
      allowedScopeTypes: ScopeType[];
      permissionCount: number;
      criticalPermissionCount: number;
      grantable: boolean;
    }[]
  > {
    const roles = await tx.query<{ id: string; code: string; name: string; permissions: string[] }>(
      `SELECT r.id, r.code, r.name,
              COALESCE(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM app.roles r
         LEFT JOIN app.role_permissions rp ON rp.organization_id = r.organization_id AND rp.role_id = r.id
        WHERE r.organization_id = $1
        GROUP BY r.id, r.code, r.name
        ORDER BY r.code`,
      [ctx.tenantId],
    );
    const mine = await tx.query<{ code: string }>(
      `SELECT DISTINCT r.code FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
          AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())`,
      [ctx.tenantId, ctx.userId],
    );
    const grantableCodes = new Set(mine.rows.flatMap((m) => GRANT_RULES[m.code] ?? []));
    const critical = new Set(
      PERMISSION_CATALOG.filter((p) => p.sensitivity === 'CRITICAL').map((p) => p.code),
    );
    return roles.rows.flatMap((r) =>
      isRoleCode(r.code)
        ? [
            {
              id: r.id,
              code: r.code,
              name: r.name,
              allowedScopeTypes: [...ROLE_SCOPE_TYPES[r.code]],
              permissionCount: r.permissions.length,
              criticalPermissionCount: r.permissions.filter((x) => critical.has(x)).length,
              grantable: grantableCodes.has(r.code),
            },
          ]
        : [],
    );
  }

  /** Every assignment of one account of the caller's tenant (history included, newest first, at most 200). */
  static async listForUser(
    tx: TenantTx,
    ctx: TrustedContext,
    userId: string,
  ): Promise<
    {
      id: string;
      roleId: string;
      roleCode: string;
      scopeType: ScopeType;
      scopeId: string | null;
      scopeName: string | null;
      state: 'EFFECTIVE' | 'EXPIRED' | 'PENDING' | 'REVOKED';
      validFrom: string;
      validUntil: string | null;
      version: number;
      createdAt: string;
    }[]
  > {
    const res = await tx.query<{
      id: string;
      role_id: string;
      code: string;
      scope_type: ScopeType;
      scope_id: string | null;
      scope_name: string | null;
      status: string;
      started: boolean;
      ended: boolean;
      valid_from: Date;
      valid_until: Date | null;
      version: number;
      created_at: Date;
    }>(
      `SELECT ra.id, ra.role_id, r.code, ra.scope_type, ra.scope_id, COALESCE(c.name, d.name) AS scope_name,
              ra.status, (ra.valid_from <= now()) AS started,
              (ra.valid_until IS NOT NULL AND ra.valid_until <= now()) AS ended,
              ra.valid_from, ra.valid_until, ra.version, ra.created_at
         FROM app.role_assignments ra
         JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
         LEFT JOIN app.campuses c ON c.organization_id = ra.organization_id AND c.id = ra.campus_id
         LEFT JOIN app.departments d ON d.organization_id = ra.organization_id AND d.id = ra.department_id
        WHERE ra.organization_id = $1 AND ra.user_id = $2
        ORDER BY ra.created_at DESC, ra.id DESC
        LIMIT 200`,
      [ctx.tenantId, userId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      roleId: r.role_id,
      roleCode: r.code,
      scopeType: r.scope_type,
      scopeId: r.scope_id,
      scopeName: r.scope_name,
      state:
        r.status === 'ACTIVE'
          ? r.ended
            ? ('EXPIRED' as const)
            : r.started
              ? ('EFFECTIVE' as const)
              : ('PENDING' as const)
          : r.status === 'EXPIRED'
            ? ('EXPIRED' as const)
            : ('REVOKED' as const),
      validFrom: r.valid_from.toISOString(),
      validUntil: r.valid_until ? r.valid_until.toISOString() : null,
      version: r.version,
      createdAt: r.created_at.toISOString(),
    }));
  }
}
