import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { parseDate, parseReason } from '../people/validation.js';
import { departmentScopeFilter } from './academic.service.js';
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
import type {
  AcademicYearDto,
  CohortPeriodDto,
  CreateAcademicYearBody,
  CreateCohortPeriodBody,
  CreateSectionBody,
  CreateTermBody,
  ListAcademicYearsQuery,
  ListCohortPeriodsQuery,
  ListSectionsQuery,
  ListTermsQuery,
  SectionDto,
  TermDto,
  UpdateAcademicYearBody,
  UpdateCohortPeriodBody,
  UpdateSectionBody,
  UpdateTermBody,
} from './calendar.schemas.js';

type Meta = AuditRequestMeta | undefined;
interface UpdateOptions {
  expected: ExpectedVersion;
  meta?: Meta;
}

const TERM_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;
const READ_PERMISSION = 'academic.program.read';
const lower = (s: string): string => s.toLowerCase();

/** Campuses the caller may read terms of: ORGANIZATION grant ⇒ all; CAMPUS ⇒ itself; DEPARTMENT ⇒ the department's campus. */
async function campusScopeFilter(
  tx: TenantTx,
  ctx: TrustedContext,
): Promise<{ orgWide: boolean; campusIds: string[] }> {
  const grants = await AuthorizationEngine.loadGrants(tx, ctx, READ_PERMISSION);
  if (grants.some((g) => g.scope_type === 'ORGANIZATION')) return { orgWide: true, campusIds: [] };
  const campusIds = grants
    .filter((g) => g.scope_type === 'CAMPUS' && g.scope_id !== null)
    .map((g) => g.scope_id as string);
  const deptIds = grants
    .filter((g) => g.scope_type === 'DEPARTMENT' && g.scope_id !== null)
    .map((g) => g.scope_id as string);
  if (deptIds.length > 0) {
    const r = await tx.query<{ campus_id: string }>(
      `SELECT DISTINCT campus_id FROM app.departments WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [ctx.tenantId, deptIds],
    );
    campusIds.push(...r.rows.map((x) => x.campus_id));
  }
  return { orgWide: false, campusIds: [...new Set(campusIds)] };
}

/** The department (and campus) a cohort hangs off, via its program. Missing ⇒ 404. */
export async function cohortScope(
  tx: TenantTx,
  ctx: TrustedContext,
  cohortId: string,
): Promise<{ campusId: string; departmentId: string; cohortStatus: string }> {
  const r = await tx.query<{ campus_id: string; department_id: string; status: string }>(
    `SELECT d.campus_id, p.department_id, c.status
       FROM app.cohorts c
       JOIN app.programs p    ON p.organization_id = c.organization_id AND p.id = c.program_id
       JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
      WHERE c.organization_id = $1 AND c.id = $2`,
    [ctx.tenantId, cohortId],
  );
  const row = r.rows[0];
  if (!row) throw resourceNotFound();
  return { campusId: row.campus_id, departmentId: row.department_id, cohortStatus: row.status };
}

// =============================================================================================
// Academic years (organization-wide)
// =============================================================================================
interface YearRow {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  status: AcademicYearDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const YEAR_COLS = `id, label, start_date::text AS start_date, end_date::text AS end_date, status, version, created_at, updated_at`;
const toYear = (r: YearRow): AcademicYearDto => ({
  id: r.id,
  label: r.label,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class AcademicYearService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateAcademicYearBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Academic year payload is required.');
    const label = text(input.label, 'label', 1, 20);
    const startDate = parseDate(input.startDate, 'startDate');
    const endDate = parseDate(input.endDate, 'endDate');
    if (endDate <= startDate) throw invalid('endDate must be after startDate.');
    await assertOrgWide(tx, ctx, 'academic.term.manage');

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.academic_years (id, organization_id, label, start_date, end_date)
         VALUES ($1, $2, $3, $4::date, $5::date)`,
        [id, ctx.tenantId, label, startDate, endDate],
      );
    } catch (err) {
      mapDbError(err, 'An academic year with this label already exists.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.year.create',
        resourceType: 'academic_year',
        resourceId: id,
        riskTier: 1,
        changes: {
          label: { old: null, new: label },
          startDate: { old: null, new: startDate },
          endDate: { old: null, new: endDate },
          status: { old: null, new: 'PLANNED' },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListAcademicYearsQuery = {},
  ): Promise<AcademicYearDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const params: unknown[] = [ctx.tenantId];
    let where = 'organization_id = $1';
    if (filter.status) {
      params.push(filter.status);
      where += ` AND status = $${params.length}`;
    }
    const r = await tx.query<YearRow>(
      `SELECT ${YEAR_COLS} FROM app.academic_years WHERE ${where} ORDER BY start_date DESC`,
      params,
    );
    return r.rows.map(toYear);
  }

  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<AcademicYearDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid academic year ID.');
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const r = await tx.query<YearRow>(
      `SELECT ${YEAR_COLS} FROM app.academic_years WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    if (!r.rows[0]) throw resourceNotFound();
    return toYear(r.rows[0]);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateAcademicYearBody,
    options: UpdateOptions,
  ): Promise<AcademicYearDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid academic year ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    await assertOrgWide(tx, ctx, 'academic.term.manage');

    const r = await tx.query<YearRow>(
      `SELECT ${YEAR_COLS} FROM app.academic_years WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    checkVersion(options.expected, row.version, 'Academic year');

    const startDate =
      input.startDate === undefined ? row.start_date : parseDate(input.startDate, 'startDate');
    const endDate =
      input.endDate === undefined ? row.end_date : parseDate(input.endDate, 'endDate');
    if (endDate <= startDate) throw invalid('endDate must be after startDate.');
    const status = input.status ?? row.status;
    const datesChanged = startDate !== row.start_date || endDate !== row.end_date;
    if (datesChanged && row.status !== 'PLANNED') {
      throw conflict('Dates can only change while the academic year is PLANNED.');
    }
    if (
      status !== row.status &&
      !(
        (row.status === 'PLANNED' && status === 'ACTIVE') ||
        (row.status === 'ACTIVE' && status === 'CLOSED')
      )
    ) {
      throw conflict(`An academic year cannot move from ${row.status} to ${status}.`);
    }
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (startDate !== row.start_date) changes.startDate = { old: row.start_date, new: startDate };
    if (endDate !== row.end_date) changes.endDate = { old: row.end_date, new: endDate };
    if (status !== row.status) changes.status = { old: row.status, new: status };
    if (Object.keys(changes).length === 0) return toYear(row); // no-op: no version bump, no audit

    let updated: YearRow | undefined;
    try {
      const u = await tx.query<YearRow>(
        `UPDATE app.academic_years SET start_date = $3::date, end_date = $4::date, status = $5
          WHERE organization_id = $1 AND id = $2 AND version = $6 RETURNING ${YEAR_COLS}`,
        [ctx.tenantId, row.id, startDate, endDate, status, row.version],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'The academic year conflicts with an existing record.');
    }
    if (!updated) throw conflict('Academic year version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.year.update',
        resourceType: 'academic_year',
        resourceId: row.id,
        riskTier: changes.status ? 2 : 1,
        changes,
      },
      options.meta ?? {},
    );
    return toYear(updated);
  }
}

// =============================================================================================
// Terms (per campus)
// =============================================================================================
interface TermRow {
  id: string;
  campus_id: string;
  academic_year_id: string;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  status: TermDto['status'];
  locked_at: Date | null;
  locked_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const TERM_COLS = `id, campus_id, academic_year_id, code, name, start_date::text AS start_date, end_date::text AS end_date,
                   status, locked_at, locked_by, version, created_at, updated_at`;
const toTerm = (r: TermRow): TermDto => ({
  id: r.id,
  campusId: r.campus_id,
  academicYearId: r.academic_year_id,
  code: r.code,
  name: r.name,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  lockedAt: r.locked_at ? iso(r.locked_at) : null,
  lockedBy: r.locked_by,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});
const TERM_NEXT: Record<string, string> = { PLANNED: 'ACTIVE', ACTIVE: 'CLOSED', CLOSED: 'LOCKED' };

export class TermService {
  /** Lock order: campus (share) -> academic year (share) -> insert. */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateTermBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Term payload is required.');
    if (!isUuidV7(input.campusId)) throw invalid('Invalid campus ID.');
    if (!isUuidV7(input.academicYearId)) throw invalid('Invalid academic year ID.');
    const code = text(input.code, 'code', 1, 30, TERM_CODE_RE);
    const name = text(input.name, 'name', 1, 255);
    const startDate = parseDate(input.startDate, 'startDate');
    const endDate = parseDate(input.endDate, 'endDate');
    if (endDate <= startDate) throw invalid('endDate must be after startDate.');
    const campusId = lower(input.campusId);
    const yearId = lower(input.academicYearId);

    await AuthorizationEngine.assert(tx, ctx, 'academic.term.manage');
    await assertScoped(tx, ctx, 'academic.term.manage', { campus_id: campusId });

    const campus = await tx.query(
      `SELECT 1 FROM app.campuses WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE' FOR SHARE`,
      [ctx.tenantId, campusId],
    );
    if (!campus.rows[0]) throw resourceNotFound();
    const year = await tx.query<{ status: string; start_date: string; end_date: string }>(
      `SELECT status, start_date::text AS start_date, end_date::text AS end_date FROM app.academic_years
        WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, yearId],
    );
    const y = year.rows[0];
    if (!y) throw resourceNotFound();
    if (y.status === 'CLOSED') throw conflict('A term cannot be added to a CLOSED academic year.');
    if (startDate < y.start_date || endDate > y.end_date) {
      throw invalid('Term dates must lie within the academic year.');
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.terms (id, organization_id, campus_id, academic_year_id, code, name, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date)`,
        [id, ctx.tenantId, campusId, yearId, code, name, startDate, endDate],
      );
    } catch (err) {
      mapDbError(err, 'A term with this code already exists for the campus and academic year.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.term.create',
        resourceType: 'term',
        resourceId: id,
        campusId,
        riskTier: 1,
        changes: {
          code: { old: null, new: code },
          name: { old: null, new: name },
          academicYearId: { old: null, new: yearId },
          startDate: { old: null, new: startDate },
          endDate: { old: null, new: endDate },
          status: { old: null, new: 'PLANNED' },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListTermsQuery = {},
  ): Promise<TermDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const scope = await campusScopeFilter(tx, ctx);
    if (!scope.orgWide && scope.campusIds.length === 0) return [];
    const params: unknown[] = [ctx.tenantId];
    const where = ['organization_id = $1'];
    if (!scope.orgWide) {
      params.push(scope.campusIds);
      where.push(`campus_id = ANY($${params.length}::uuid[])`);
    }
    for (const [key, col] of [
      ['campusId', 'campus_id'],
      ['academicYearId', 'academic_year_id'],
      ['status', 'status'],
    ] as const) {
      const v = filter[key];
      if (v !== undefined) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    const r = await tx.query<TermRow>(
      `SELECT ${TERM_COLS} FROM app.terms WHERE ${where.join(' AND ')} ORDER BY start_date DESC, code`,
      params,
    );
    return r.rows.map(toTerm);
  }

  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<TermDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid term ID.');
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const r = await tx.query<TermRow>(
      `SELECT ${TERM_COLS} FROM app.terms WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    await assertScoped(tx, ctx, READ_PERMISSION, { campus_id: row.campus_id });
    return toTerm(row);
  }

  /** Lock order: academic year (share) -> term (no key update). LOCKED needs a reason (A2) and is terminal in Batch 1. */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateTermBody,
    options: UpdateOptions,
  ): Promise<TermDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid term ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    await AuthorizationEngine.assert(tx, ctx, 'academic.term.manage');

    const probe = await tx.query<{ campus_id: string; academic_year_id: string }>(
      `SELECT campus_id, academic_year_id FROM app.terms WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    const found = probe.rows[0];
    if (!found) throw resourceNotFound();
    await assertScoped(tx, ctx, 'academic.term.manage', { campus_id: found.campus_id });

    await tx.query(
      `SELECT 1 FROM app.academic_years WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, found.academic_year_id],
    );
    const r = await tx.query<TermRow>(
      `SELECT ${TERM_COLS} FROM app.terms WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    checkVersion(options.expected, row.version, 'Term');
    if (row.status === 'LOCKED') throw conflict('A LOCKED term cannot change.');

    const name = input.name === undefined ? row.name : text(input.name, 'name', 1, 255);
    const startDate =
      input.startDate === undefined ? row.start_date : parseDate(input.startDate, 'startDate');
    const endDate =
      input.endDate === undefined ? row.end_date : parseDate(input.endDate, 'endDate');
    if (endDate <= startDate) throw invalid('endDate must be after startDate.');
    const status = input.status ?? row.status;
    if ((startDate !== row.start_date || endDate !== row.end_date) && row.status !== 'PLANNED') {
      throw conflict('Dates can only change while the term is PLANNED.');
    }
    if (status !== row.status && TERM_NEXT[row.status] !== status) {
      throw conflict(`A term cannot move from ${row.status} to ${status}.`);
    }
    const locking = status === 'LOCKED'; // row.status is never LOCKED here (rejected above)
    const reason = locking || input.reason !== undefined ? parseReason(input.reason) : undefined;

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (name !== row.name) changes.name = { old: row.name, new: name };
    if (startDate !== row.start_date) changes.startDate = { old: row.start_date, new: startDate };
    if (endDate !== row.end_date) changes.endDate = { old: row.end_date, new: endDate };
    if (status !== row.status) changes.status = { old: row.status, new: status };
    if (Object.keys(changes).length === 0) return toTerm(row);

    let updated: TermRow | undefined;
    try {
      const u = await tx.query<TermRow>(
        `UPDATE app.terms
            SET name = $3, start_date = $4::date, end_date = $5::date, status = $6,
                locked_at = CASE WHEN $7::boolean THEN now() ELSE locked_at END,
                locked_by = CASE WHEN $7::boolean THEN $8::uuid ELSE locked_by END
          WHERE organization_id = $1 AND id = $2 AND version = $9 RETURNING ${TERM_COLS}`,
        [ctx.tenantId, row.id, name, startDate, endDate, status, locking, ctx.userId, row.version],
      );
      updated = u.rows[0];
    } catch (err) {
      mapDbError(err, 'The term conflicts with an existing record.');
    }
    if (!updated) throw conflict('Term version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: locking ? 'academic.term.lock' : 'academic.term.update',
        resourceType: 'term',
        resourceId: row.id,
        campusId: row.campus_id,
        riskTier: changes.status ? 2 : 1,
        changes,
        ...(reason !== undefined ? { reasonText: reason } : {}),
      },
      options.meta ?? {},
    );
    return toTerm(updated);
  }
}

// =============================================================================================
// Cohort periods ("this cohort's Nth study period runs in this term")
// =============================================================================================
interface CohortPeriodRow {
  id: string;
  cohort_id: string;
  term_id: string;
  period_no: number;
  is_extension: boolean;
  status: CohortPeriodDto['status'];
  version: number;
  created_at: Date;
  updated_at: Date;
}
const CP_COLS = `id, cohort_id, term_id, period_no, is_extension, status, version, created_at, updated_at`;
const toCp = (r: CohortPeriodRow): CohortPeriodDto => ({
  id: r.id,
  cohortId: r.cohort_id,
  termId: r.term_id,
  periodNo: r.period_no,
  isExtension: r.is_extension,
  status: r.status,
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Scope of a cohort period via its cohort's program department. Missing ⇒ 404. */
async function cohortPeriodScope(tx: TenantTx, ctx: TrustedContext, id: string) {
  const r = await tx.query<{ cohort_id: string; status: string; term_id: string }>(
    `SELECT cohort_id, status, term_id FROM app.cohort_periods WHERE organization_id = $1 AND id = $2`,
    [ctx.tenantId, id],
  );
  const cp = r.rows[0];
  if (!cp) throw resourceNotFound();
  const scope = await cohortScope(tx, ctx, cp.cohort_id);
  return { ...scope, cohortId: cp.cohort_id, termId: cp.term_id, status: cp.status };
}
export { cohortPeriodScope };

export class CohortPeriodService {
  /** Lock order: cohort (share) -> term (share) -> insert (the migration guard re-checks both). */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateCohortPeriodBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Cohort period payload is required.');
    if (!isUuidV7(input.cohortId)) throw invalid('Invalid cohort ID.');
    if (!isUuidV7(input.termId)) throw invalid('Invalid term ID.');
    if (!Number.isInteger(input.periodNo) || input.periodNo < 1 || input.periodNo > 200) {
      throw invalid('periodNo must be an integer between 1 and 200.');
    }
    const cohortId = lower(input.cohortId);
    const termId = lower(input.termId);
    const isExtension = input.isExtension === true;

    await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage');
    const scope = await cohortScope(tx, ctx, cohortId);
    await assertScoped(tx, ctx, 'academic.cohort.manage', {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });

    const cohort = await tx.query<{ status: string; duration_periods: number }>(
      `SELECT c.status, p.duration_periods FROM app.cohorts c
         JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
        WHERE c.organization_id = $1 AND c.id = $2 FOR SHARE OF c`,
      [ctx.tenantId, cohortId],
    );
    const c = cohort.rows[0];
    if (!c) throw resourceNotFound();
    if (c.status !== 'ACTIVE') throw conflict('The cohort is not ACTIVE.');
    if (!isExtension && input.periodNo > c.duration_periods) {
      throw invalid(
        `periodNo exceeds the programme duration (${c.duration_periods}); flag it as an extension.`,
      );
    }
    const term = await tx.query<{ status: string; campus_id: string }>(
      `SELECT status, campus_id FROM app.terms WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, termId],
    );
    const t = term.rows[0];
    if (!t) throw resourceNotFound();
    if (t.campus_id !== scope.campusId) {
      throw conflict("The term belongs to a different campus than the cohort's program.");
    }
    if (t.status !== 'PLANNED' && t.status !== 'ACTIVE') {
      throw conflict('The term must be PLANNED or ACTIVE.');
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.cohort_periods (id, organization_id, cohort_id, term_id, period_no, is_extension)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.tenantId, cohortId, termId, input.periodNo, isExtension],
      );
    } catch (err) {
      mapDbError(err, 'This cohort already has a period for this term or this period number.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.cohort_period.create',
        resourceType: 'cohort_period',
        resourceId: id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes: {
          cohortId: { old: null, new: cohortId },
          termId: { old: null, new: termId },
          periodNo: { old: null, new: input.periodNo },
          isExtension: { old: null, new: isExtension },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListCohortPeriodsQuery = {},
  ): Promise<CohortPeriodDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const scope = await departmentScopeFilter(tx, ctx, [READ_PERMISSION, 'academic.cohort.manage']);
    if (!scope.orgWide && scope.departmentIds.length === 0) return [];
    const params: unknown[] = [ctx.tenantId];
    const where = ['cp.organization_id = $1'];
    if (!scope.orgWide) {
      params.push(scope.departmentIds);
      where.push(`p.department_id = ANY($${params.length}::uuid[])`);
    }
    for (const [key, col] of [
      ['cohortId', 'cp.cohort_id'],
      ['termId', 'cp.term_id'],
      ['status', 'cp.status'],
    ] as const) {
      const v = filter[key];
      if (v !== undefined) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    const r = await tx.query<CohortPeriodRow>(
      `SELECT ${CP_COLS.split(', ')
        .map((c) => `cp.${c}`)
        .join(', ')}
         FROM app.cohort_periods cp
         JOIN app.cohorts c  ON c.organization_id = cp.organization_id AND c.id = cp.cohort_id
         JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
        WHERE ${where.join(' AND ')} ORDER BY cp.cohort_id, cp.period_no`,
      params,
    );
    return r.rows.map(toCp);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateCohortPeriodBody,
    options: UpdateOptions,
  ): Promise<CohortPeriodDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid cohort period ID.');
    if (!input || input.status !== 'CLOSED') throw invalid('status must be CLOSED.');
    await AuthorizationEngine.assert(tx, ctx, 'academic.cohort.manage');
    const scope = await cohortPeriodScope(tx, ctx, lower(id));
    await assertScoped(tx, ctx, 'academic.cohort.manage', {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });
    const r = await tx.query<CohortPeriodRow>(
      `SELECT ${CP_COLS} FROM app.cohort_periods WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    checkVersion(options.expected, row.version, 'Cohort period');
    if (row.status === 'CLOSED') return toCp(row);
    const u = await tx.query<CohortPeriodRow>(
      `UPDATE app.cohort_periods SET status = 'CLOSED'
        WHERE organization_id = $1 AND id = $2 AND version = $3 RETURNING ${CP_COLS}`,
      [ctx.tenantId, row.id, row.version],
    );
    if (!u.rows[0]) throw conflict('Cohort period version mismatch.');
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.cohort_period.close',
        resourceType: 'cohort_period',
        resourceId: row.id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 2,
        changes: { status: { old: 'ACTIVE', new: 'CLOSED' } },
      },
      options.meta ?? {},
    );
    return toCp(u.rows[0]);
  }
}

// =============================================================================================
// Sections
// =============================================================================================
interface SectionRow {
  id: string;
  cohort_period_id: string;
  name: string;
  capacity: number | null;
  status: SectionDto['status'];
  member_count: string | number;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const SECTION_SELECT = `s.id, s.cohort_period_id, s.name, s.capacity, s.status, s.version, s.created_at, s.updated_at,
  (SELECT count(*) FROM app.section_memberships m
    WHERE m.organization_id = s.organization_id AND m.section_id = s.id AND m.valid_to IS NULL) AS member_count`;
const toSection = (r: SectionRow): SectionDto => ({
  id: r.id,
  cohortPeriodId: r.cohort_period_id,
  name: r.name,
  capacity: r.capacity,
  status: r.status,
  memberCount: Number(r.member_count),
  version: r.version,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export class SectionService {
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    input: CreateSectionBody,
    meta: Meta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Section payload is required.');
    if (!isUuidV7(input.cohortPeriodId)) throw invalid('Invalid cohort period ID.');
    const name = text(input.name, 'name', 1, 50);
    const capacity = input.capacity ?? null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000)) {
      throw invalid('capacity must be an integer between 1 and 10000.');
    }
    const cpId = lower(input.cohortPeriodId);
    await AuthorizationEngine.assert(tx, ctx, 'academic.section.manage');
    const scope = await cohortPeriodScope(tx, ctx, cpId);
    await assertScoped(tx, ctx, 'academic.section.manage', {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });
    const cp = await tx.query<{ status: string }>(
      `SELECT status FROM app.cohort_periods WHERE organization_id = $1 AND id = $2 FOR SHARE`,
      [ctx.tenantId, cpId],
    );
    if (!cp.rows[0]) throw resourceNotFound();
    if (cp.rows[0].status !== 'ACTIVE') throw conflict('The cohort period is not ACTIVE.');

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.sections (id, organization_id, cohort_period_id, name, capacity)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.tenantId, cpId, name, capacity],
      );
    } catch (err) {
      mapDbError(err, 'A section with this name already exists in the cohort period.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.section.create',
        resourceType: 'section',
        resourceId: id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes: {
          cohortPeriodId: { old: null, new: cpId },
          name: { old: null, new: name },
          capacity: { old: null, new: capacity },
        },
      },
      meta,
    );
    return id;
  }

  static async list(
    tx: TenantTx,
    ctx: TrustedContext,
    filter: ListSectionsQuery = {},
  ): Promise<SectionDto[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const scope = await departmentScopeFilter(tx, ctx, [
      READ_PERMISSION,
      'academic.section.manage',
    ]);
    if (!scope.orgWide && scope.departmentIds.length === 0) return [];
    const params: unknown[] = [ctx.tenantId];
    const where = ['s.organization_id = $1'];
    if (!scope.orgWide) {
      params.push(scope.departmentIds);
      where.push(`p.department_id = ANY($${params.length}::uuid[])`);
    }
    if (filter.cohortPeriodId) {
      params.push(filter.cohortPeriodId);
      where.push(`s.cohort_period_id = $${params.length}`);
    }
    const r = await tx.query<SectionRow>(
      `SELECT ${SECTION_SELECT}
         FROM app.sections s
         JOIN app.cohort_periods cp ON cp.organization_id = s.organization_id AND cp.id = s.cohort_period_id
         JOIN app.cohorts c  ON c.organization_id = cp.organization_id AND c.id = cp.cohort_id
         JOIN app.programs p ON p.organization_id = c.organization_id AND p.id = c.program_id
        WHERE ${where.join(' AND ')} ORDER BY s.cohort_period_id, s.name`,
      params,
    );
    return r.rows.map(toSection);
  }

  static async getById(tx: TenantTx, ctx: TrustedContext, id: string): Promise<SectionDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid section ID.');
    await AuthorizationEngine.assert(tx, ctx, READ_PERMISSION);
    const r = await tx.query<SectionRow & { cohort_period_id: string }>(
      `SELECT ${SECTION_SELECT} FROM app.sections s WHERE s.organization_id = $1 AND s.id = $2`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    const scope = await cohortPeriodScope(tx, ctx, row.cohort_period_id);
    await assertScoped(tx, ctx, READ_PERMISSION, {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });
    return toSection(row);
  }

  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: UpdateSectionBody,
    options: UpdateOptions,
  ): Promise<SectionDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid section ID.');
    if (!input || typeof input !== 'object') throw invalid('Update input is required.');
    await AuthorizationEngine.assert(tx, ctx, 'academic.section.manage');
    const probe = await tx.query<{ cohort_period_id: string }>(
      `SELECT cohort_period_id FROM app.sections WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await cohortPeriodScope(tx, ctx, probe.rows[0].cohort_period_id);
    await assertScoped(tx, ctx, 'academic.section.manage', {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });

    // The section row lock is also what placements take, so a capacity / deactivation change and a concurrent placement queue.
    const r = await tx.query<SectionRow>(
      `SELECT s.id, s.cohort_period_id, s.name, s.capacity, s.status, s.version, s.created_at, s.updated_at,
              0 AS member_count
         FROM app.sections s WHERE s.organization_id = $1 AND s.id = $2 FOR UPDATE`,
      [ctx.tenantId, lower(id)],
    );
    const row = r.rows[0];
    if (!row) throw resourceNotFound();
    checkVersion(options.expected, row.version, 'Section');

    const name = input.name === undefined ? row.name : text(input.name, 'name', 1, 50);
    const capacity = input.capacity === undefined ? row.capacity : input.capacity;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000)) {
      throw invalid('capacity must be an integer between 1 and 10000.');
    }
    const status = input.status ?? row.status;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (name !== row.name) changes.name = { old: row.name, new: name };
    if (capacity !== row.capacity) changes.capacity = { old: row.capacity, new: capacity };
    if (status !== row.status) changes.status = { old: row.status, new: status };
    if (Object.keys(changes).length === 0) return SectionService.getById(tx, ctx, row.id);

    try {
      const u = await tx.query(
        `UPDATE app.sections SET name = $3, capacity = $4, status = $5
          WHERE organization_id = $1 AND id = $2 AND version = $6`,
        [ctx.tenantId, row.id, name, capacity, status, row.version],
      );
      if (u.rowCount !== 1) throw conflict('Section version mismatch.');
    } catch (err) {
      if (err instanceof AppError) throw err;
      mapDbError(err, 'A section with this name already exists in the cohort period.');
    }
    await recordAudit(
      tx,
      ctx,
      {
        action: 'academic.section.update',
        resourceType: 'section',
        resourceId: row.id,
        campusId: scope.campusId,
        departmentId: scope.departmentId,
        riskTier: 1,
        changes,
      },
      options.meta ?? {},
    );
    return SectionService.getById(tx, ctx, row.id);
  }

  /** Current roster of a section (staff only; students never see rosters). */
  static async roster(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<
    Array<{
      termEnrollmentId: string;
      studentId: string;
      validFrom: string;
      rollNumber: string | null;
    }>
  > {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    if (!isUuidV7(id)) throw invalid('Invalid section ID.');
    await AuthorizationEngine.assert(tx, ctx, 'enrollment.term.read');
    const probe = await tx.query<{ cohort_period_id: string }>(
      `SELECT cohort_period_id FROM app.sections WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, lower(id)],
    );
    if (!probe.rows[0]) throw resourceNotFound();
    const scope = await cohortPeriodScope(tx, ctx, probe.rows[0].cohort_period_id);
    await assertScoped(tx, ctx, 'enrollment.term.read', {
      campus_id: scope.campusId,
      department_id: scope.departmentId,
    });
    const r = await tx.query<{
      term_enrollment_id: string;
      student_id: string;
      valid_from: string;
      roll_number: string | null;
    }>(
      `SELECT m.term_enrollment_id, m.student_id, m.valid_from::text AS valid_from, e.roll_number
         FROM app.section_memberships m
         JOIN app.term_enrollments e ON e.organization_id = m.organization_id AND e.id = m.term_enrollment_id
        WHERE m.organization_id = $1 AND m.section_id = $2 AND m.valid_to IS NULL
        ORDER BY e.roll_number NULLS LAST, m.student_id`,
      [ctx.tenantId, lower(id)],
    );
    return r.rows.map((x) => ({
      termEnrollmentId: x.term_enrollment_id,
      studentId: x.student_id,
      validFrom: x.valid_from,
      rollNumber: x.roll_number,
    }));
  }
}
