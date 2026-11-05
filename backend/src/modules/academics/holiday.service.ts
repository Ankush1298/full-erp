import { Type, type Static } from '@sinclair/typebox';
import { resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { parseDate, parseReason } from '../people/validation.js';
import { UuidV7Schema } from './academic.schemas.js';
import { DateSchema } from './calendar.schemas.js';
import { campusScopeFilter } from './calendar.service.js';
import {
  assertOrgWide,
  assertScoped,
  checkVersion,
  conflict,
  ensureTrusted,
  invalid,
  iso,
  mapDbError,
  text,
} from './common.js';

/**
 * Holidays and calendar events (migration 0039, doc 01 "Holiday / AcademicCalendarEvent": campus nullable = every campus,
 * date, name, kind; unique (campus, date, name)). A holiday is a calendar fact: it does not move or shorten any term and
 * nothing is derived from it yet (Milestone 4 class-session generation will read it). Cancelled, never deleted.
 *
 * AUTHORIZATION. Reads: `academic.program.read`; organization-wide rows are visible to every holder, campus rows only
 * for campuses in the holder's scope (the term-list rule). Writes: `academic.term.manage`, scoped to the row's campus;
 * an organization-wide row needs an ORGANIZATION-scoped holder (a campus admin cannot declare a holiday for other
 * campuses). The guard refuses any change on a date inside a LOCKED term of the affected campus(es).
 */

const strict = { additionalProperties: false } as const;
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });
export const HOLIDAY_KINDS = ['HOLIDAY', 'NON_TEACHING_DAY', 'EVENT'] as const;
const KindSchema = Type.Unsafe<(typeof HOLIDAY_KINDS)[number]>(
  Type.Union(HOLIDAY_KINDS.map((v) => Type.Literal(v))),
);

export const CreateHolidayBodySchema = Type.Object(
  {
    campusId: Type.Optional(UuidV7Schema),
    holidayDate: DateSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: KindSchema,
    reason: ReasonSchema,
  },
  strict,
);
export type CreateHolidayBody = Static<typeof CreateHolidayBodySchema>;
export const UpdateHolidayBodySchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    status: Type.Optional(Type.Literal('CANCELLED')),
    reason: ReasonSchema,
  },
  { ...strict, minProperties: 2 },
);
export type UpdateHolidayBody = Static<typeof UpdateHolidayBodySchema>;
export const ListHolidaysQuerySchema = Type.Object(
  {
    campusId: Type.Optional(UuidV7Schema),
    from: Type.Optional(DateSchema),
    to: Type.Optional(DateSchema),
    includeCancelled: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type ListHolidaysQuery = Static<typeof ListHolidaysQuerySchema>;
export const HolidayRecordSchema = Type.Object(
  {
    id: UuidV7Schema,
    campusId: Type.Union([UuidV7Schema, Type.Null()]),
    holidayDate: Type.String(),
    name: Type.String(),
    kind: KindSchema,
    status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('CANCELLED')]),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  strict,
);
export type HolidayDto = Static<typeof HolidayRecordSchema>;

interface Row {
  id: string;
  campus_id: string | null;
  holiday_date: string;
  name: string;
  kind: HolidayDto['kind'];
  status: HolidayDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const COLS = `id, campus_id, holiday_date::text AS holiday_date, name, kind, status, version, created_at, updated_at`;
const toDto = (r: Row): HolidayDto => ({
  id: r.id,
  campusId: r.campus_id,
  holidayDate: r.holiday_date,
  name: r.name,
  kind: r.kind,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
const lower = (s: string): string => s.toLowerCase();

async function assertWrite(tx: TenantTx, ctx: TrustedContext, campusId: string | null) {
  await AuthorizationEngine.assert(tx, ctx, 'academic.term.manage');
  if (campusId === null) return assertOrgWide(tx, ctx, 'academic.term.manage');
  const c = await tx.query(`SELECT 1 FROM app.campuses WHERE organization_id = $1 AND id = $2`, [
    ctx.tenantId,
    campusId,
  ]);
  if (!c.rows[0]) throw resourceNotFound();
  return assertScoped(tx, ctx, 'academic.term.manage', { campus_id: campusId });
}

export class HolidayService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateHolidayBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Holiday payload is required.');
    if (input.campusId !== undefined && !isUuidV7(input.campusId))
      throw invalid('Invalid campus ID.');
    const campusId = input.campusId === undefined ? null : lower(input.campusId);
    const date = parseDate(input.holidayDate, 'holidayDate');
    const name = text(input.name, 'name', 1, 120);
    if (!(HOLIDAY_KINDS as readonly string[]).includes(input.kind)) throw invalid('Invalid kind.');
    const reason = parseReason(input.reason);
    await assertWrite(tx, ctx, campusId);

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.holidays (id, organization_id, campus_id, holiday_date, name, kind) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.tenantId, campusId, date, name, input.kind],
      );
    } catch (err) {
      mapDbError(err, 'A holiday with this name is already declared on that date.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.holiday.create',
        resourceType: 'holiday',
        resourceId: id,
        ...(campusId ? { campusId } : {}),
        riskTier: 1,
        reasonText: reason,
        changes: {
          campusId: { old: null, new: campusId },
          holidayDate: { old: null, new: date },
          name: { old: null, new: name },
          kind: { old: null, new: input.kind },
        },
      },
      meta,
    );
    return id;
  }

  /**
   * With `campusId`: that campus's calendar = its own rows plus the organization-wide rows. Without: every row the
   * caller may read. ACTIVE rows only unless `includeCancelled`. Ordered by date.
   */
  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    q: ListHolidaysQuery = {},
  ): Promise<HolidayDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');
    const scope = await campusScopeFilter(tx, ctx);
    const params: unknown[] = [ctx.tenantId];
    const where = ['organization_id = $1'];
    if (q.campusId !== undefined) {
      if (!isUuidV7(q.campusId)) throw invalid('Invalid campus ID.');
      const cid = lower(q.campusId);
      if (!scope.orgWide && !scope.campusIds.includes(cid)) throw resourceNotFound();
      params.push(cid);
      where.push(`(campus_id IS NULL OR campus_id = $${params.length})`);
    } else if (!scope.orgWide) {
      params.push(scope.campusIds);
      where.push(`(campus_id IS NULL OR campus_id = ANY($${params.length}::uuid[]))`);
    }
    if (q.from !== undefined) {
      params.push(parseDate(q.from, 'from'));
      where.push(`holiday_date >= $${params.length}::date`);
    }
    if (q.to !== undefined) {
      params.push(parseDate(q.to, 'to'));
      where.push(`holiday_date <= $${params.length}::date`);
    }
    if (q.includeCancelled !== true) where.push(`status = 'ACTIVE'`);
    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM app.holidays WHERE ${where.join(' AND ')}
        ORDER BY holiday_date, campus_id NULLS FIRST, lower(name), id`,
      params,
    );
    return r.rows.map(toDto);
  }

  /** Rename, or cancel (final). The date, campus and kind are identity: a moved holiday is cancel + declare. */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateHolidayBody,
    options: { expected: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<HolidayDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid holiday ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    const reason = parseReason(input.reason);
    await AuthorizationEngine.assert(tx, ctx, 'academic.term.manage');
    const r = await tx.query<Row>(
      `SELECT ${COLS} FROM app.holidays WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const cur = r.rows[0];
    if (!cur) throw resourceNotFound();
    await assertWrite(tx, ctx, cur.campus_id);
    checkVersion(options.expected, cur.version, 'Holiday');
    if (cur.status === 'CANCELLED') throw conflict('A cancelled holiday cannot change.');
    const name = input.name === undefined ? cur.name : text(input.name, 'name', 1, 120);
    const status = input.status ?? cur.status;
    let updated: Row | undefined;
    try {
      const u = await tx.query<Row>(
        `UPDATE app.holidays SET name = $3, status = $4 WHERE organization_id = $1 AND id = $2 RETURNING ${COLS}`,
        [ctx.tenantId, cur.id, name, status],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'A holiday with this name is already declared on that date.');
    }
    if (!updated) throw resourceNotFound();
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.holiday.update',
        resourceType: 'holiday',
        resourceId: cur.id,
        ...(cur.campus_id ? { campusId: cur.campus_id } : {}),
        riskTier: 1,
        reasonText: reason,
        changes: {
          ...(name !== cur.name ? { name: { old: cur.name, new: name } } : {}),
          ...(status !== cur.status ? { status: { old: cur.status, new: status } } : {}),
        },
      },
      options.meta,
    );
    return toDto(updated);
  }
}
