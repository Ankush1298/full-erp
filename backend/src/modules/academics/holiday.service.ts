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
import { getHolidaySuggestions } from './holiday-catalogue.js';
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
    campusId: Type.Optional(Type.Union([UuidV7Schema, Type.Null()])),
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

export const HolidayCategorySchema = Type.Union([
  Type.Literal('NATIONAL'),
  Type.Literal('STATE'),
  Type.Literal('FESTIVAL'),
  Type.Literal('RESTRICTED'),
  Type.Literal('INSTITUTIONAL'),
]);

export const VerificationStatusSchema = Type.Union([
  Type.Literal('VERIFIED'),
  Type.Literal('PROVISIONAL'),
  Type.Literal('UNVERIFIED'),
]);

export const HolidaySuggestionSchema = Type.Object(
  {
    id: Type.String(),
    holidayDate: Type.String(),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    kind: KindSchema,
    category: HolidayCategorySchema,
    jurisdiction: Type.String(),
    year: Type.Integer(),
    source: Type.String(),
    verificationStatus: VerificationStatusSchema,
    verifiedDate: Type.Union([Type.String(), Type.Null()]),
    isGovernmentMandated: Type.Boolean(),
    notes: Type.Optional(Type.String()),
    alreadyDeclared: Type.Optional(Type.Boolean()),
  },
  strict,
);
export type HolidaySuggestionDto = Static<typeof HolidaySuggestionSchema>;

export const HolidaySuggestionsQuerySchema = Type.Object(
  {
    country: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
    academicYearId: Type.Optional(UuidV7Schema),
    from: Type.Optional(DateSchema),
    to: Type.Optional(DateSchema),
    campusId: Type.Optional(UuidV7Schema),
  },
  strict,
);
export type HolidaySuggestionsQuery = Static<typeof HolidaySuggestionsQuerySchema>;

export const BulkCreateHolidaysBodySchema = Type.Object(
  {
    campusId: Type.Optional(Type.Union([UuidV7Schema, Type.Null()])),
    reason: ReasonSchema,
    holidays: Type.Array(
      Type.Object(
        {
          holidayDate: DateSchema,
          name: Type.String({ minLength: 1, maxLength: 120 }),
          kind: KindSchema,
        },
        strict,
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  strict,
);
export type BulkCreateHolidaysBody = Static<typeof BulkCreateHolidaysBodySchema>;

export const BulkCreateHolidaysResponseSchema = Type.Object(
  {
    createdCount: Type.Integer({ minimum: 0 }),
    skippedCount: Type.Integer({ minimum: 0 }),
    createdIds: Type.Array(UuidV7Schema),
    skipped: Type.Array(
      Type.Object(
        {
          holidayDate: Type.String(),
          name: Type.String(),
          reason: Type.String(),
        },
        strict,
      ),
    ),
  },
  strict,
);
export type BulkCreateHolidaysResponseDto = Static<typeof BulkCreateHolidaysResponseSchema>;

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
    const campusId = !input.campusId ? null : lower(input.campusId);
    if (campusId !== null && !isUuidV7(campusId)) throw invalid('Invalid campus ID.');
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

  /**
   * Annual holiday suggestions: returns national, state, festival and institutional suggestions
   * for the given country, state and academic year / date window.
   * Cross-references against already-declared ACTIVE holidays in the database.
   */
  static async suggestions(
    tx: TenantTx,
    ctx: TrustedContext,
    q: HolidaySuggestionsQuery = {},
  ): Promise<HolidaySuggestionDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'academic.program.read');

    let from = q.from;
    let to = q.to;

    if (q.academicYearId) {
      if (!isUuidV7(q.academicYearId)) throw invalid('Invalid academic year ID.');
      const yr = await tx.query<{ start_date: string; end_date: string }>(
        `SELECT start_date::text AS start_date, end_date::text AS end_date
           FROM app.academic_years WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, lower(q.academicYearId)],
      );
      if (yr.rows[0]) {
        from = from ?? yr.rows[0].start_date;
        to = to ?? yr.rows[0].end_date;
      }
    }

    if (!from || !to) {
      // Fallback to active or most recent academic year if available
      const activeYr = await tx.query<{ start_date: string; end_date: string }>(
        `SELECT start_date::text AS start_date, end_date::text AS end_date
           FROM app.academic_years WHERE organization_id = $1
          ORDER BY (status = 'ACTIVE') DESC, start_date DESC LIMIT 1`,
        [ctx.tenantId],
      );
      if (activeYr.rows[0]) {
        from = from ?? activeYr.rows[0].start_date;
        to = to ?? activeYr.rows[0].end_date;
      } else {
        const curYear = new Date().getFullYear();
        from = from ?? `${curYear}-01-01`;
        to = to ?? `${curYear}-12-31`;
      }
    }

    const suggestions = getHolidaySuggestions({
      country: q.country,
      state: q.state,
      from,
      to,
    });

    if (suggestions.length === 0) return [];

    // Check existing active holidays in database
    const campusId = q.campusId ? lower(q.campusId) : null;
    const existing = await tx.query<{ holiday_date: string; lower_name: string }>(
      `SELECT holiday_date::text, lower(name) AS lower_name
         FROM app.holidays
        WHERE organization_id = $1
          AND (campus_id IS NULL OR $2::uuid IS NULL OR campus_id = $2::uuid)
          AND status = 'ACTIVE'
          AND holiday_date >= $3::date AND holiday_date <= $4::date`,
      [ctx.tenantId, campusId, from, to],
    );

    const existingSet = new Set(existing.rows.map((r) => `${r.holiday_date}:${r.lower_name}`));

    return suggestions.map((s) => {
      const isDeclared = existingSet.has(`${s.holidayDate}:${s.name.toLowerCase()}`);
      const entry: HolidaySuggestionDto = {
        id: s.id,
        holidayDate: s.holidayDate,
        name: s.name,
        kind: s.kind,
        category: s.category,
        jurisdiction: s.jurisdiction,
        year: s.year,
        source: s.source,
        verificationStatus: s.verificationStatus,
        verifiedDate: s.verifiedDate,
        isGovernmentMandated: s.isGovernmentMandated,
        alreadyDeclared: isDeclared,
      };
      if (s.notes !== undefined) {
        entry.notes = s.notes;
      }
      return entry;
    });
  }

  /**
   * Bulk create holidays: allows approving an annual list in one atomic transaction.
   * Skips duplicates gracefully and logs audit history.
   */
  static async bulkCreate(
    tx: TenantTx,
    ctx: TrustedContext,
    input: BulkCreateHolidaysBody,
    meta: AuditRequestMeta = {},
  ): Promise<BulkCreateHolidaysResponseDto> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Bulk payload is required.');
    const campusId = !input.campusId ? null : lower(input.campusId);
    if (campusId !== null && !isUuidV7(campusId)) throw invalid('Invalid campus ID.');
    const reason = parseReason(input.reason);
    await assertWrite(tx, ctx, campusId);

    if (!Array.isArray(input.holidays) || input.holidays.length === 0) {
      throw invalid('At least one holiday is required.');
    }
    if (input.holidays.length > 100) {
      throw invalid('Cannot bulk create more than 100 holidays at once.');
    }

    // Check for locked terms
    const lockedTerms = await tx.query<{ code: string; start_date: string; end_date: string }>(
      `SELECT code, start_date::text, end_date::text FROM app.terms
        WHERE organization_id = $1 AND status = 'LOCKED'
          AND ($2::uuid IS NULL OR campus_id = $2::uuid)`,
      [ctx.tenantId, campusId],
    );

    // Fetch existing active holidays for this tenant & campus scope
    const existing = await tx.query<{ holiday_date: string; lower_name: string }>(
      `SELECT holiday_date::text, lower(name) AS lower_name
         FROM app.holidays
        WHERE organization_id = $1
          AND ((campus_id IS NULL AND $2::uuid IS NULL) OR campus_id = $2::uuid)
          AND status = 'ACTIVE'`,
      [ctx.tenantId, campusId],
    );

    const existingSet = new Set(existing.rows.map((r) => `${r.holiday_date}:${r.lower_name}`));
    const batchSet = new Set<string>();

    const createdIds: string[] = [];
    const skipped: Array<{ holidayDate: string; name: string; reason: string }> = [];
    const createdItems: Array<{ holidayDate: string; name: string }> = [];

    for (const h of input.holidays) {
      const date = parseDate(h.holidayDate, 'holidayDate');
      const name = text(h.name, 'name', 1, 120);
      if (!(HOLIDAY_KINDS as readonly string[]).includes(h.kind)) throw invalid('Invalid kind.');

      const lock = lockedTerms.rows.find((t) => t.start_date <= date && date <= t.end_date);
      if (lock) {
        skipped.push({
          holidayDate: date,
          name,
          reason: `Date lies in locked term ${lock.code}`,
        });
        continue;
      }

      const key = `${date}:${name.toLowerCase()}`;
      if (existingSet.has(key) || batchSet.has(key)) {
        skipped.push({
          holidayDate: date,
          name,
          reason: 'Already declared',
        });
        continue;
      }

      const id = uuidv7();
      await tx.query(
        `INSERT INTO app.holidays (id, organization_id, campus_id, holiday_date, name, kind)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.tenantId, campusId, date, name, h.kind],
      );

      batchSet.add(key);
      createdIds.push(id);
      createdItems.push({ holidayDate: date, name });
    }

    if (createdIds.length > 0) {
      await recordAudit(
        tx,
        ctx,
        {
          action: 'academic.holiday.bulk_create',
          resourceType: 'holiday',
          resourceId: createdIds[0]!,
          ...(campusId ? { campusId } : {}),
          riskTier: 1,
          reasonText: reason,
          changes: {
            createdCount: { old: null, new: createdIds.length },
            skippedCount: { old: null, new: skipped.length },
            holidays: { old: null, new: createdItems.map((c) => `${c.holidayDate}: ${c.name}`) },
          },
        },
        meta,
      );
    }

    return {
      createdCount: createdIds.length,
      skippedCount: skipped.length,
      createdIds,
      skipped,
    };
  }
}
