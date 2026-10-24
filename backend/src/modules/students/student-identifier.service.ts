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
import { invalid, parseDate } from '../people/validation.js';
import {
  lockActiveEnrolment,
  readActiveEnrolment,
  type ActiveEnrolmentRow,
} from './student-program.service.js';
import {
  IDENTIFIER_ISSUER_MAX,
  IDENTIFIER_TYPES,
  IDENTIFIER_VALUE_MAX,
  MAX_IDENTIFIERS_PER_STUDENT,
  type IdentifierType,
  type StudentIdentifierDto,
} from './student-identifier.schemas.js';

/** doc 10 row 24: "IDs" are read with `student.profile.read_sensitive` (SELF for the student, GRANTED for staff). */
export const IDENTIFIER_READ_PERMISSION = 'student.profile.read_sensitive';
/** doc 10 row 27. Identifier changes are the first use of this permission; other student edits are not built yet. */
export const IDENTIFIER_MANAGE_PERMISSION = 'student.record.update';
export const ADD_STUDENT_IDENTIFIER_OPERATION = 'POST /api/v1/students/:id/identifiers';
/** Defensive bound on the list statement only; the service never lets more than MAX_IDENTIFIERS_PER_STUDENT exist. */
const LIST_SAFETY_LIMIT = 200;

export interface AddStudentIdentifierInput {
  idType: unknown;
  value: unknown;
  issuer?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
}
export interface UpdateStudentIdentifierInput {
  issuer?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
}

const ADD_KEYS = new Set(['idType', 'value', 'issuer', 'validFrom', 'validTo']);
const UPDATE_KEYS = new Set(['issuer', 'validFrom', 'validTo']);

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

// ---- field validation: shape only, no database ------------------------------------------------------------------------

function onlyKnownKeys(input: unknown, allowed: ReadonlySet<string>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Identifier payload is required.');
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

function parseIdType(value: unknown): IdentifierType {
  if (typeof value !== 'string' || !(IDENTIFIER_TYPES as readonly string[]).includes(value)) {
    throw invalid(`idType must be one of ${IDENTIFIER_TYPES.join(', ')}.`);
  }
  return value as IdentifierType;
}

/**
 * The value is stored exactly as supplied after trimming: the documents define no normalisation, so uniqueness is exact.
 * (Case and inner whitespace are significant.)
 */
function parseValue(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < 1 || s.length > IDENTIFIER_VALUE_MAX || hasControlCharacters(s)) {
    throw invalid(
      `value must be 1 to ${IDENTIFIER_VALUE_MAX} characters without control characters.`,
    );
  }
  return s;
}

function parseIssuer(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < 1 || s.length > IDENTIFIER_ISSUER_MAX || hasControlCharacters(s)) {
    throw invalid(
      `issuer must be 1 to ${IDENTIFIER_ISSUER_MAX} characters without control characters.`,
    );
  }
  return s;
}

function checkWindow(from: string | null, to: string | null): void {
  if (from !== null && to !== null && to < from) {
    throw invalid('validTo must not be before validFrom.');
  }
}

function parseIds(studentId: string, identifierId?: string): { sid: string; iid: string } {
  if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
  if (identifierId !== undefined && !isUuidV7(identifierId))
    throw invalid('Invalid identifier ID.');
  return { sid: studentId.toLowerCase(), iid: (identifierId ?? '').toLowerCase() };
}

function requireExactVersion(exp: ExpectedVersion): number {
  if (exp.type !== 'version') {
    throw invalid('If-Match must carry the exact version of the identifier.');
  }
  return exp.version;
}

// ---- rows -------------------------------------------------------------------------------------------------------------

interface IdentifierRow {
  id: string;
  student_id: string;
  id_type: IdentifierType;
  value: string;
  issuer: string | null;
  valid_from: string | null;
  valid_to: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// Dates are selected as text (the driver would otherwise build a JS Date in the server's time zone).
const COLS = `id, student_id, id_type, value, issuer, valid_from::text AS valid_from, valid_to::text AS valid_to,
              version, created_at, updated_at`;

function toDto(r: IdentifierRow): StudentIdentifierDto {
  return {
    id: r.id,
    studentId: r.student_id,
    idType: r.id_type,
    value: r.value,
    issuer: r.issuer,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

type Placement = Pick<ActiveEnrolmentRow, 'campus_id' | 'department_id'>;

function placementScope(p: Placement | null): ResourceScope {
  return p ? { campus_id: p.campus_id, department_id: p.department_id } : {};
}

function auditPlacement(p: Placement | null): { campusId?: string; departmentId?: string } {
  return p ? { campusId: p.campus_id, departmentId: p.department_id } : {};
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  return typeof err === 'object' && err !== null ? err : {};
}

/**
 * Proves the caller's `student.record.update` grant reaches this student from `placement` (the ACTIVE enrolment's frozen
 * campus/department, or null). The scope is what the database holds, never anything the caller supplied. Out of scope is
 * the same 404 as a missing student.
 */
async function assertManageScope(
  tx: TenantTx,
  ctx: TrustedContext,
  placement: Placement | null,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, IDENTIFIER_MANAGE_PERMISSION, {
    organization_id: ctx.tenantId,
    ...placementScope(placement),
  });
}

/**
 * The authoritative proof for a write. LOCK PROTOCOL (same as the guardian service): student row (`FOR NO KEY UPDATE`;
 * 404 when missing or of another tenant), THEN the student's ACTIVE enrolment (`FOR NO KEY UPDATE`). The placement the
 * grant is judged against is therefore the one that is still true when the write commits.
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
 * Student identifiers (docs/architecture/v3/02 §4.4, §6.1; migration 0035): list, add and update the NON-primary
 * identifiers of ONE student. The only code that reads or writes `app.student_identifiers`. The admission number is a
 * different thing: it lives on the student record, is set once at creation and is neither readable nor writable here.
 *
 * ORDER (each step reveals only what the one before it allowed): request shape (400) -> actor and permission held (403;
 * writes also: staff only) -> student row (missing or another tenant: 404) -> scope proof (404, the same answer as a
 * missing student) -> [add: Idempotency-Key 428/400 then claim/replay] -> [update: identifier row 404, version 409] ->
 * write -> tier-1 audit (doc 02: A1) in the caller's transaction.
 *
 * SCOPE: read is `student.profile.read_sensitive` (GRANTED, and SELF for the student); write is `student.record.update`
 * (GRANTED only). An ORGANIZATION grant covers every student; a campus- or department-scoped grant is proven only from the
 * student's ACTIVE enrolment's frozen campus/department; a student with no ACTIVE enrolment carries no placement, so only an
 * ORGANIZATION grant reaches it. A STUDENT actor reaches only their own identifiers, and only to read.
 *
 * PRIVACY: the audit event carries the identifier TYPE and the changed field names/values of the issuer and window, never
 * the identifier value (its resource id links the event to the row). The cached idempotent response carries only the new id.
 *
 * UNIQUENESS is exact per (organization, id_type, value) and global to the tenant: a conflict answers 409 without saying
 * which student holds the value (the answer necessarily confirms that someone does).
 */
export class StudentIdentifierService {
  /** Identifiers of one student. Not held: 403. Missing OR out of scope: the same 404. No audit on read. */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<StudentIdentifierDto[]> {
    ensureTrusted(ctx);
    const { sid } = parseIds(studentId);
    await AuthorizationEngine.assert(tx, ctx, IDENTIFIER_READ_PERMISSION);

    const student = await tx.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM app.students WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, sid],
    );
    const row = student.rows[0];
    if (!row) throw resourceNotFound();
    // SELF needs no placement; a staff grant is judged against the active enrolment.
    const placement = await readActiveEnrolment(tx, ctx.tenantId, sid);
    await AuthorizationEngine.assert(tx, ctx, IDENTIFIER_READ_PERMISSION, {
      organization_id: ctx.tenantId,
      student_id: row.id,
      user_id: row.user_id,
      ...placementScope(placement),
    });

    const res = await tx.query<IdentifierRow>(
      `SELECT ${COLS} FROM app.student_identifiers WHERE organization_id = $1 AND student_id = $2
        ORDER BY id_type, value, id LIMIT ${LIST_SAFETY_LIMIT}`,
      [ctx.tenantId, sid],
    );
    return res.rows.map(toDto);
  }

  /** Adds an identifier, idempotently (`Idempotency-Key`). 409 on a duplicate (id_type, value) or when the cap is reached. */
  static async add(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: AddStudentIdentifierInput,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    onlyKnownKeys(input, ADD_KEYS);
    const { sid } = parseIds(studentId);
    const idType = parseIdType(input.idType);
    const value = parseValue(input.value);
    const issuer = input.issuer === undefined ? null : parseIssuer(input.issuer);
    const validFrom =
      input.validFrom === undefined ? null : parseDate(input.validFrom, 'validFrom');
    const validTo = input.validTo === undefined ? null : parseDate(input.validTo, 'validTo');
    checkWindow(validFrom, validTo);

    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, IDENTIFIER_MANAGE_PERMISSION);
    // Scope BEFORE the claim (unlocked): a replay of a stored response must not bypass it. The callback below proves it
    // again under the student row lock, which is the authoritative check.
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
        operation: ADD_STUDENT_IDENTIFIER_OPERATION,
        // The NORMALISED request (trimmed values, nulls resolved): equal requests hash equally.
        request: { studentId: sid, idType, value, issuer, validFrom, validTo },
      },
      async () => {
        const placement = await lockStudentAndProveScope(tx, ctx, sid);

        const count = await tx.query<{ n: string }>(
          `SELECT count(*) AS n FROM app.student_identifiers WHERE organization_id = $1 AND student_id = $2`,
          [ctx.tenantId, sid],
        );
        if (Number(count.rows[0]?.n ?? 0) >= MAX_IDENTIFIERS_PER_STUDENT) {
          throw new AppError(
            409,
            'STUDENT_IDENTIFIER_LIMIT_REACHED',
            `A student can have at most ${MAX_IDENTIFIERS_PER_STUDENT} identifiers.`,
          );
        }

        const id = uuidv7();
        try {
          await tx.query(
            `INSERT INTO app.student_identifiers
               (id, organization_id, student_id, id_type, value, issuer, valid_from, valid_to)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date)`,
            [id, ctx.tenantId, sid, idType, value, issuer, validFrom, validTo],
          );
        } catch (err) {
          if (
            pgError(err).code === '23505' &&
            pgError(err).constraint === 'student_identifiers_type_value_uq'
          ) {
            throw new AppError(
              409,
              'STUDENT_IDENTIFIER_EXISTS',
              'An identifier of this type with this value already exists.',
            );
          }
          throw err;
        }

        await recordAudit(
          tx,
          ctx,
          {
            action: 'student_identifier.add',
            resourceType: 'student_identifier',
            resourceId: id,
            subjectStudentId: sid,
            ...auditPlacement(placement),
            riskTier: 1,
            changes: {
              idType: { old: null, new: idType },
              issuer: { old: null, new: issuer },
              validFrom: { old: null, new: validFrom },
              validTo: { old: null, new: validTo },
            },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id } } };
      },
    );
  }

  /**
   * Changes the issuer and/or the validity window. `If-Match` must carry the exact version. An empty change (every value
   * equals the stored one) answers the current record without a write, a version bump or an audit event. The identity
   * (student, type, value) cannot change: the schema rejects it, the runtime role has no privilege on it, and a trigger
   * refuses it for any other writer.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    identifierId: string,
    input: UpdateStudentIdentifierInput,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<StudentIdentifierDto> {
    ensureTrusted(ctx);
    onlyKnownKeys(input, UPDATE_KEYS);
    const { sid, iid } = parseIds(studentId, identifierId);
    const patch = {
      issuer:
        input.issuer === undefined
          ? undefined
          : input.issuer === null
            ? null
            : parseIssuer(input.issuer),
      validFrom:
        input.validFrom === undefined
          ? undefined
          : input.validFrom === null
            ? null
            : parseDate(input.validFrom, 'validFrom'),
      validTo:
        input.validTo === undefined
          ? undefined
          : input.validTo === null
            ? null
            : parseDate(input.validTo, 'validTo'),
    };
    if (Object.values(patch).every((v) => v === undefined)) {
      throw invalid('At least one field to change is required.');
    }
    const expectedVersion = requireExactVersion(options.expected);

    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, IDENTIFIER_MANAGE_PERMISSION);
    const placement = await lockStudentAndProveScope(tx, ctx, sid);

    const found = await tx.query<IdentifierRow>(
      `SELECT ${COLS} FROM app.student_identifiers
        WHERE organization_id = $1 AND student_id = $2 AND id = $3 FOR NO KEY UPDATE`,
      [ctx.tenantId, sid, iid],
    );
    const current = found.rows[0];
    if (!current) throw resourceNotFound();
    // Only now may the caller learn anything about the stored version or state.
    if (current.version !== expectedVersion) {
      throw new AppError(409, 'CONFLICT', 'Identifier version mismatch.');
    }

    const next = {
      issuer: patch.issuer === undefined ? current.issuer : patch.issuer,
      validFrom: patch.validFrom === undefined ? current.valid_from : patch.validFrom,
      validTo: patch.validTo === undefined ? current.valid_to : patch.validTo,
    };
    checkWindow(next.validFrom, next.validTo);
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (next.issuer !== current.issuer) changes.issuer = { old: current.issuer, new: next.issuer };
    if (next.validFrom !== current.valid_from) {
      changes.validFrom = { old: current.valid_from, new: next.validFrom };
    }
    if (next.validTo !== current.valid_to) {
      changes.validTo = { old: current.valid_to, new: next.validTo };
    }
    if (Object.keys(changes).length === 0) return toDto(current);

    const updated = await tx.query<IdentifierRow>(
      `UPDATE app.student_identifiers
          SET issuer = $5, valid_from = $6::date, valid_to = $7::date
        WHERE organization_id = $1 AND student_id = $2 AND id = $3 AND version = $4
    RETURNING ${COLS}`,
      [ctx.tenantId, sid, iid, expectedVersion, next.issuer, next.validFrom, next.validTo],
    );
    const row = updated.rows[0];
    if (!row) throw new AppError(409, 'CONFLICT', 'Identifier version mismatch.');

    await recordAudit(
      tx,
      ctx,
      {
        action: 'student_identifier.update',
        resourceType: 'student_identifier',
        resourceId: iid,
        subjectStudentId: sid,
        ...auditPlacement(placement),
        riskTier: 1,
        changes,
      },
      options.meta ?? {},
    );
    return toDto(row);
  }
}
