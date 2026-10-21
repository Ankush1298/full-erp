import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import {
  ROOM_CAPACITY_MAX,
  ROOM_KIND_MAX,
  type CreateRoomBody,
  type ListRoomsQuery,
  type RoomRecordDto,
  type UpdateRoomBody,
} from './organization.schemas.js';

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/;

function invalid(message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message);
}

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface RoomRow {
  id: string;
  organization_id: string;
  campus_id: string;
  code: string;
  kind: string;
  name: string | null;
  capacity: number | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const COLS =
  'id, organization_id, campus_id, code, kind, name, capacity, version, created_at, updated_at';

function toDto(r: RoomRow): RoomRecordDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    campusId: r.campus_id,
    code: r.code,
    kind: r.kind,
    name: r.name,
    capacity: r.capacity !== null ? Number(r.capacity) : null,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function parseKind(value: unknown): string {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (kind.length < 1 || kind.length > ROOM_KIND_MAX) {
    throw invalid(`Room kind must be between 1 and ${ROOM_KIND_MAX} characters.`);
  }
  return kind;
}

function parseName(value: unknown): string | null {
  if (value === null) return null;
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length < 1 || name.length > 255) {
    throw invalid('Room name must be between 1 and 255 characters.');
  }
  return name;
}

function parseCapacity(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > ROOM_CAPACITY_MAX
  ) {
    throw invalid(`Room capacity must be a positive integer up to ${ROOM_CAPACITY_MAX}.`);
  }
  return value;
}

/**
 * Rooms (docs 01 Room, 02 §4.2): audit class A0, so no room service writes an audit event (owner Decision 2). Reads and
 * writes are authorised by org.structure.read / org.campus.manage scoped to the owning campus.
 */
export class RoomService {
  /** Creates a room within a campus. Authorized by org.campus.manage scoped to the campus. */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    campusId: string,
    input: CreateRoomBody,
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!isUuidV7(campusId)) throw invalid('Invalid campus ID.');
    if (!input || typeof input !== 'object') throw invalid('Room payload is required.');

    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!CODE_RE.test(code)) {
      throw invalid('Room code must be 1 to 20 letters, digits, "-" or "_".');
    }
    const kind = parseKind(input.kind);
    const name = input.name === undefined ? null : parseName(input.name);
    const capacity = input.capacity === undefined ? null : parseCapacity(input.capacity);

    // The owning campus must exist in this tenant (another tenant's campus is indistinguishable from a missing one).
    // Its status is deliberately not examined: the documents impose no campus-status rule on rooms.
    const campusRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.campuses WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, campusId],
    );
    if (!campusRes.rows[0]) throw resourceNotFound();

    // Authorization: org.campus.manage with campus scope
    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
    });

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.rooms (id, organization_id, campus_id, code, kind, name, capacity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.tenantId, campusId, code, kind, name, capacity],
      );
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'rooms_org_campus_code_uq') {
        throw new AppError(
          409,
          'CONFLICT',
          `A room with code "${code}" already exists on this campus.`,
        );
      }
      throw err;
    }
    return id;
  }

  /** Retrieves a single room by ID. Authorized by org.structure.read scoped to the owning campus. */
  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<RoomRecordDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid room ID.');

    const res = await tx.query<RoomRow>(
      `SELECT ${COLS} FROM app.rooms WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, id],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();

    await AuthorizationEngine.assert(tx, ctx, 'org.structure.read', {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
    });

    return toDto(row);
  }

  /** Lists the rooms of a campus, optionally by kind. Authorized by org.structure.read scoped to the campus. */
  static async listByCampus(
    tx: TenantTx,
    ctx: TrustedContext,
    campusId: string,
    filter: ListRoomsQuery = {},
  ): Promise<RoomRecordDto[]> {
    ensureTrusted(ctx);
    if (!isUuidV7(campusId)) throw invalid('Invalid campus ID.');

    const campus = await tx.query<{ id: string }>(
      `SELECT id FROM app.campuses WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, campusId],
    );
    if (!campus.rows[0]) throw resourceNotFound();

    await AuthorizationEngine.assert(tx, ctx, 'org.structure.read', {
      organization_id: ctx.tenantId,
      campus_id: campusId,
    });

    const conditions = ['organization_id = $1', 'campus_id = $2'];
    const params: unknown[] = [ctx.tenantId, campusId];
    if (filter.kind !== undefined) {
      params.push(parseKind(filter.kind));
      conditions.push(`kind = $${params.length}`);
    }

    const res = await tx.query<RoomRow>(
      `SELECT ${COLS} FROM app.rooms WHERE ${conditions.join(' AND ')} ORDER BY code, id`,
      params,
    );
    return res.rows.map(toDto);
  }

  /**
   * Updates kind, name or capacity (code and campus are immutable). Authorized by org.campus.manage scoped to the
   * owning campus; optimistic concurrency via If-Match. No audit event (A0).
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateRoomBody,
    options: { expected: ExpectedVersion },
  ): Promise<RoomRecordDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid room ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    if (input.kind === undefined && input.name === undefined && input.capacity === undefined) {
      throw invalid('At least one field to change must be provided.');
    }
    const newKind = input.kind === undefined ? undefined : parseKind(input.kind);
    const newName = input.name === undefined ? undefined : parseName(input.name);
    const newCapacity = input.capacity === undefined ? undefined : parseCapacity(input.capacity);

    const current = await tx.query<RoomRow>(
      `SELECT ${COLS} FROM app.rooms WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, id],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();

    await AuthorizationEngine.assert(tx, ctx, 'org.campus.manage', {
      organization_id: ctx.tenantId,
      campus_id: row.campus_id,
    });

    const exp = options.expected;
    if (exp.type === 'initial' || (exp.type === 'version' && exp.version !== row.version)) {
      throw new AppError(409, 'CONFLICT', 'Room version mismatch.');
    }

    const finalKind = newKind ?? row.kind;
    const finalName = newName === undefined ? row.name : newName;
    const finalCapacity = newCapacity === undefined ? row.capacity : newCapacity;
    if (finalKind === row.kind && finalName === row.name && finalCapacity === row.capacity) {
      return toDto(row); // no-op: no version bump
    }

    const updated = await tx.query<RoomRow>(
      `UPDATE app.rooms SET kind = $3, name = $4, capacity = $5
        WHERE organization_id = $1 AND id = $2 AND version = $6
        RETURNING ${COLS}`,
      [ctx.tenantId, id, finalKind, finalName, finalCapacity, row.version],
    );
    const saved = updated.rows[0];
    if (!saved) throw new AppError(409, 'CONFLICT', 'Room was changed concurrently. Retry.');
    return toDto(saved);
  }
}
