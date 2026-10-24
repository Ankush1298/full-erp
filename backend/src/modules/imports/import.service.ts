import { createHash } from 'node:crypto';
import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { lockPersonIdentity } from '../../shared/authorization/person-identity.js';
import {
  canonicalJson,
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { invalid, parseReason } from '../people/validation.js';
import { employeeImportAdapter } from '../people/employee-import.adapter.js';
import { normalizePhone } from '../students/student-duplicate.service.js';
import { studentImportAdapter } from '../students/student-import.adapter.js';
import {
  IMPORT_ROWS_PAGE_SIZE,
  IMPORT_ROW_STATUSES,
  MAX_CELL_LENGTH,
  MAX_COLUMNS_PER_ROW,
  MAX_COLUMN_NAME_LENGTH,
  MAX_IMPORT_ROWS,
  MATCHING_ONLY_COLUMNS,
  sortIssues,
  type ImportAdapter,
  type ImportJobStatus,
  type ImportRowStatus,
  type ImportType,
  type MatchingCells,
  type Proposal,
  type RawRow,
  type RowIssue,
} from './import.common.js';
import { buildErrorReport } from './import.csv.js';
import {
  canonicalMatching,
  matchingUnavailable,
  type MatchingBinder,
  type StoredBinding,
} from './import.binding.js';
import type { ImportJobDto, ImportRowDto } from './import.schemas.js';

export const IMPORT_PERMISSION = 'import.job.manage';

const ADAPTERS: Readonly<Record<ImportType, ImportAdapter>> = {
  STUDENT_RECORDS: studentImportAdapter,
  EMPLOYEE_RECORDS: employeeImportAdapter,
};

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/**
 * Import is an ORGANIZATION-scope capability, like the record creation it drives: students and employees have no campus
 * or department before they are enrolled or posted, so a campus- or department-scoped holder could never prove a record
 * inside its scope. Fail closed: held at all (403), then organization scope (403).
 */
async function assertOrganizationScope(
  tx: TenantTx,
  ctx: TrustedContext,
  permission: string,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, permission);
  try {
    await AuthorizationEngine.assert(tx, ctx, permission, { organization_id: ctx.tenantId });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied.');
    }
    throw err;
  }
}

async function authorize(tx: TenantTx, ctx: TrustedContext, adapter: ImportAdapter): Promise<void> {
  AuthorizationEngine.assertStaffActor(ctx);
  await assertOrganizationScope(tx, ctx, IMPORT_PERMISSION);
  // The job can only ever create records the actor may create: refusing early beats a job nobody could commit.
  await assertOrganizationScope(tx, ctx, adapter.createPermission);
}

function requireExactVersion(exp: ExpectedVersion): number {
  if (exp.type !== 'version')
    throw invalid('If-Match must carry the exact version of the import job.');
  return exp.version;
}

// ---- request validation (shape only, no database) --------------------------------------------------------------------

function hasControlCharacters(s: string): boolean {
  return Array.from(s).some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f;
  });
}
/** A lone surrogate survives JSON.stringify but PostgreSQL's jsonb refuses it; the UTF-8 round trip replaces it. */
function isWellFormed(s: string): boolean {
  return Buffer.from(s, 'utf8').toString('utf8') === s;
}

function parseRows(input: unknown): RawRow[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('Import payload is required.');
  }
  if (Object.keys(input).some((k) => k !== 'rows')) {
    throw invalid('The payload contains an unknown field.');
  }
  const rows = (input as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_IMPORT_ROWS) {
    throw invalid(`rows must hold 1 to ${MAX_IMPORT_ROWS} rows.`);
  }
  return rows.map((row: unknown, index) => {
    const where = `Row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw invalid(`${where} must be an object of text cells.`);
    }
    const entries = Object.entries(row);
    if (entries.length > MAX_COLUMNS_PER_ROW) {
      throw invalid(`${where} has more than ${MAX_COLUMNS_PER_ROW} columns.`);
    }
    for (const [name, cell] of entries) {
      if (
        name.length < 1 ||
        name.length > MAX_COLUMN_NAME_LENGTH ||
        hasControlCharacters(name) ||
        !isWellFormed(name)
      ) {
        throw invalid(
          `${where} has a column name that is empty, longer than ${MAX_COLUMN_NAME_LENGTH} characters or contains control characters.`,
        );
      }
      // Matching-only cells are never stored: they travel with validate and commit, not with the rows (doc 26 §3.5.4).
      if ((MATCHING_ONLY_COLUMNS as readonly string[]).includes(name)) {
        throw invalid(
          `${where} contains a matching-only column. Send those values with the validate and commit requests, not when creating the job.`,
        );
      }
      if (
        typeof cell !== 'string' ||
        cell.length > MAX_CELL_LENGTH ||
        hasControlCharacters(cell) ||
        !isWellFormed(cell)
      ) {
        throw invalid(
          `${where} has a cell that is not text, longer than ${MAX_CELL_LENGTH} characters or contains control characters.`,
        );
      }
    }
    // fromEntries defines own properties, so a column called "__proto__" stays data
    return Object.fromEntries(entries);
  });
}

// ---- rows of the database --------------------------------------------------------------------------------------------

interface JobRow {
  id: string;
  type: ImportType;
  status: ImportJobStatus;
  row_count: number;
  summary: Record<string, number>;
  validation_hash: string | null;
  match_binding: Buffer | null;
  match_binding_key_label: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  committed_at: Date | null;
}
const JOB_COLS = `id, type, status, row_count, summary, validation_hash, match_binding, match_binding_key_label, version, created_at, updated_at, committed_at`;

function toJobDto(r: JobRow): ImportJobDto {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    rowCount: r.row_count,
    summary: r.summary,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    committedAt: r.committed_at ? r.committed_at.toISOString() : null,
  };
}

/** The job of THIS type that the caller created. Another user's job, another tenant's and a missing id are one 404 (RLS + filter). */
async function loadJob(
  tx: TenantTx,
  ctx: TrustedContext,
  type: ImportType,
  jobId: string,
  lock: boolean,
): Promise<JobRow> {
  const res = await tx.query<JobRow>(
    `SELECT ${JOB_COLS} FROM app.import_jobs
      WHERE organization_id = $1 AND id = $2 AND type = $3 ${lock ? 'FOR UPDATE' : ''}`,
    [ctx.tenantId, jobId, type],
  );
  const row = res.rows[0];
  if (!row) throw resourceNotFound();
  return row;
}

function parseJobId(jobId: string): string {
  if (!isUuidV7(jobId)) throw invalid('Invalid import job ID.');
  return jobId.toLowerCase();
}

// ---- request-scoped matching data -------------------------------------------------------------------------------------

/** DOB / phone cells are bounded so a hostile request cannot smuggle bulk data; the values are never echoed in a message. */
const MAX_MATCHING_CELL = 40;
const MATCHING_KEYS = new Set(['rowNo', 'email', 'dateOfBirth', 'guardianPhone']);

function cellText(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (
    typeof v !== 'string' ||
    v.length > MAX_MATCHING_CELL ||
    hasControlCharacters(v) ||
    !isWellFormed(v)
  ) {
    throw invalid('A matching value is not text, is too long or contains control characters.');
  }
  return v.trim() === '' ? undefined : v.trim();
}

/**
 * Validates the `matching` list of a validate or commit request and binds it to the STORED rows: every entry names an
 * existing row number once, and carries the row's stored e-mail (a different file, or a reordered one, is refused with a
 * fixed 409 instead of being matched against the wrong person). The values are held in the returned map for this request
 * only; nothing here writes them anywhere, and no message echoes one.
 *
 * This is the ONLY validator of the list for both routes (the commit body schema leaves `matching` untyped on purpose, so
 * the HTTP layer's type coercion cannot turn `20050304` into text on one route and not on the other).
 *
 * PRESENCE uses the matcher's own normalisation: a phone with no digit (`---`, `( )`) is ABSENT, exactly as for
 * `canonicalMatching` and `StudentDuplicateService`, so the presence bits, the MAC and the duplicate rule agree. An entry
 * whose only cell is such a phone still needs a valid row binding and then contributes nothing.
 */
async function bindMatching(
  tx: TenantTx,
  ctx: TrustedContext,
  adapter: ImportAdapter,
  job: JobRow,
  input: unknown,
): Promise<Map<number, MatchingCells>> {
  const out = new Map<number, MatchingCells>();
  if (input === undefined) return out;
  if (!Array.isArray(input) || input.length > MAX_IMPORT_ROWS) {
    throw invalid(`matching must be a list of at most ${MAX_IMPORT_ROWS} entries.`);
  }
  if (input.length === 0) return out;
  if (!adapter.parseMatching) {
    throw invalid('This import does not take matching data.');
  }
  const stored = await tx.query<{ row_no: number; email: string | null }>(
    `SELECT row_no, lower(btrim(raw->>'email')) AS email FROM app.import_job_rows
      WHERE organization_id = $1 AND job_id = $2`,
    [ctx.tenantId, job.id],
  );
  const emails = new Map(stored.rows.map((r) => [r.row_no, r.email]));
  const seen = new Set<number>();
  for (const item of input as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalid('Every matching entry must be an object.');
    }
    if (Object.keys(item).some((k) => !MATCHING_KEYS.has(k))) {
      throw invalid('A matching entry contains an unknown field.');
    }
    const e = item as Record<string, unknown>;
    if (
      !Number.isInteger(e.rowNo) ||
      (e.rowNo as number) < 1 ||
      (e.rowNo as number) > job.row_count
    ) {
      throw invalid('A matching entry names a row that does not exist in this job.');
    }
    const rowNo = e.rowNo as number;
    if (seen.has(rowNo)) throw invalid('A row appears more than once in the matching list.');
    seen.add(rowNo);
    if (typeof e.email !== 'string') throw invalid('Every matching entry needs the row e-mail.');
    const dateOfBirth = cellText(e.dateOfBirth);
    const phoneText = cellText(e.guardianPhone);
    if (dateOfBirth === undefined && phoneText === undefined) {
      throw invalid('A matching entry must carry a date of birth or a guardian phone.');
    }
    const guardianPhone =
      phoneText !== undefined && normalizePhone(phoneText) !== '' ? phoneText : undefined;
    if (emails.get(rowNo) !== e.email.trim().toLowerCase()) {
      throw new AppError(
        409,
        'IMPORT_MATCHING_MISMATCH',
        'The matching data does not belong to the rows of this import job. Upload the same file again.',
      );
    }
    if (dateOfBirth === undefined && guardianPhone === undefined) continue;
    out.set(rowNo, {
      ...(dateOfBirth === undefined ? {} : { dateOfBirth }),
      ...(guardianPhone === undefined ? {} : { guardianPhone }),
    });
  }
  return out;
}

/**
 * Commit-time strictness: the resupplied cells of a commit must already be valid (the same `adapter.parseMatching` the
 * validation uses). A malformed value is the CLIENT's error, not a change of the world since the preview, so it is refused
 * with a fixed 400 BEFORE any evaluation - it can never turn a validated job into a terminal FAILED one, and the job, the
 * records, the idempotency store and the audit log are untouched. (At validate the same value is a row error in the
 * preview, as before.) No message names the row or echoes the value.
 */
function assertMatchingValid(
  adapter: ImportAdapter,
  matching: ReadonlyMap<number, MatchingCells>,
): void {
  for (const cells of matching.values()) {
    if (!adapter.parseMatching || adapter.parseMatching(cells).errors.length > 0) {
      throw invalid(
        'The matching data is not valid: dates of birth must be real past dates (YYYY-MM-DD) and guardian phones at most 30 characters. Nothing was imported; validate the job again.',
      );
    }
  }
}

/** Which matching cells a row was given: bit 1 date of birth, bit 2 guardian phone. Presence only, never a value. */
function presenceOf(cells: MatchingCells | undefined): number {
  return (cells?.dateOfBirth ? 1 : 0) | (cells?.guardianPhone ? 2 : 0);
}

/** Does the presence of THIS request's matching cells differ, for any row, from the presence stored at the last validation? */
async function presenceDiffers(
  tx: TenantTx,
  ctx: TrustedContext,
  job: JobRow,
  matching: ReadonlyMap<number, MatchingCells>,
): Promise<boolean> {
  const res = await tx.query<{ row_no: number; match_presence: number }>(
    `SELECT row_no, match_presence FROM app.import_job_rows WHERE organization_id = $1 AND job_id = $2`,
    [ctx.tenantId, job.id],
  );
  return res.rows.some((r) => r.match_presence !== presenceOf(matching.get(r.row_no)));
}

/** Closed request body of validate: `{ matching? }` (or none at all). */
function matchingFrom(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'object' || Array.isArray(body))
    throw invalid('The request body must be an object.');
  if (Object.keys(body).some((k) => k !== 'matching')) {
    throw invalid('The payload contains an unknown field.');
  }
  return (body as { matching?: unknown }).matching;
}

// ---- evaluation: the same pure function for validate and for the commit-time revalidation ---------------------------------

interface RowOutcome {
  rowId: string;
  rowNo: number;
  status: 'VALID' | 'INVALID';
  normalized: Proposal | null;
  errors: RowIssue[];
  warnings: RowIssue[];
  presence: number;
}

/**
 * Reads the job's rows in row order and evaluates each one: shape (adapter.parse), the resupplied matching cells
 * (adapter.parseMatching), then the exact-identity and possible-duplicate checks against the current database state and the
 * rest of the file (adapter.check). READ-ONLY: it neither writes nor locks, so a validation can never change a student, an
 * employee, an account or an audit log. Deterministic: the same rows, matching data and database state yield identical
 * outcomes (rows ordered, issues sorted).
 */
async function evaluate(
  tx: TenantTx,
  ctx: TrustedContext,
  adapter: ImportAdapter,
  jobId: string,
  matching: ReadonlyMap<number, MatchingCells>,
): Promise<RowOutcome[]> {
  const rows = await tx.query<{ id: string; row_no: number; raw: RawRow }>(
    `SELECT id, row_no, raw FROM app.import_job_rows WHERE organization_id = $1 AND job_id = $2 ORDER BY row_no`,
    [ctx.tenantId, jobId],
  );
  const parsed = rows.rows.map((row) => {
    const result = adapter.parse(row.raw);
    const cells = matching.get(row.row_no);
    const m = cells && adapter.parseMatching ? adapter.parseMatching(cells) : null;
    const errors = sortIssues([...result.errors, ...(m?.errors ?? [])]);
    // A row whose matching cells are invalid is unreadable, like one whose shape is invalid: no proposal, no check.
    const proposal = m && m.errors.length > 0 ? null : result.proposal;
    return {
      row,
      errors,
      proposal,
      match: { ...(result.match ?? {}), ...(m?.match ?? {}) },
      presence: presenceOf(cells),
    };
  });
  const checked = await adapter.check(
    tx,
    ctx,
    parsed.flatMap((p) =>
      p.proposal ? [{ rowNo: p.row.row_no, proposal: p.proposal, match: p.match }] : [],
    ),
  );
  return parsed.map((p) => {
    const c = checked.get(p.row.row_no);
    const errors = [...p.errors, ...(c?.errors ?? [])];
    return {
      rowId: p.row.id,
      rowNo: p.row.row_no,
      status: errors.length > 0 ? 'INVALID' : 'VALID',
      normalized: c?.proposal ?? p.proposal,
      errors,
      warnings: c?.warnings ?? [],
      presence: p.presence,
    };
  });
}

function summarize(outcomes: readonly RowOutcome[]): Record<string, number> {
  return {
    validRows: outcomes.filter((o) => o.status === 'VALID').length,
    invalidRows: outcomes.filter((o) => o.status === 'INVALID').length,
    rowsWithWarnings: outcomes.filter((o) => o.warnings.length > 0).length,
    errorCount: outcomes.reduce((n, o) => n + o.errors.length, 0),
    warningCount: outcomes.reduce((n, o) => n + o.warnings.length, 0),
  };
}

/** SHA-256 of exactly what the preview shows. A commit applies an outcome only if it still hashes to the stored value. */
function outcomeHash(outcomes: readonly RowOutcome[]): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        outcomes.map((o) => ({
          rowNo: o.rowNo,
          status: o.status,
          normalized: o.normalized,
          errors: o.errors,
          warnings: o.warnings,
        })),
      ),
    )
    .digest('hex');
}

async function persistOutcomes(
  tx: TenantTx,
  ctx: TrustedContext,
  jobId: string,
  outcomes: readonly RowOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;
  await tx.query(
    `UPDATE app.import_job_rows AS t
        SET status = v.status, normalized = v.normalized, errors = v.errors, warnings = v.warnings,
            match_presence = v.presence
       FROM unnest($3::int[], $4::text[], $5::jsonb[], $6::jsonb[], $7::jsonb[], $8::smallint[])
              AS v(row_no, status, normalized, errors, warnings, presence)
      WHERE t.organization_id = $1 AND t.job_id = $2 AND t.row_no = v.row_no`,
    [
      ctx.tenantId,
      jobId,
      outcomes.map((o) => o.rowNo),
      outcomes.map((o) => o.status),
      outcomes.map((o) => (o.normalized === null ? null : JSON.stringify(o.normalized))),
      outcomes.map((o) => JSON.stringify(o.errors)),
      outcomes.map((o) => JSON.stringify(o.warnings)),
      outcomes.map((o) => o.presence),
    ],
  );
}

/** Moves the job (version-guarded) and returns the new row; a stale version is a 409, never a silent overwrite. */
async function updateJob(
  tx: TenantTx,
  ctx: TrustedContext,
  job: JobRow,
  next: {
    status: ImportJobStatus;
    summary: Record<string, number>;
    hash: string | null;
    /** Set only when committing: the HMAC binding of the matching data the commit used (null when it used none). */
    binding?: StoredBinding | null;
  },
): Promise<JobRow> {
  const res = await tx.query<JobRow>(
    `UPDATE app.import_jobs
        SET status = $4, summary = $5::jsonb, validation_hash = $6,
            match_binding = CASE WHEN $4 = 'COMMITTED' THEN $7::bytea ELSE match_binding END,
            match_binding_key_label = CASE WHEN $4 = 'COMMITTED' THEN $8 ELSE match_binding_key_label END,
            committed_at = CASE WHEN $4 = 'COMMITTED' THEN now() ELSE committed_at END
      WHERE organization_id = $1 AND id = $2 AND version = $3
  RETURNING ${JOB_COLS}`,
    [
      ctx.tenantId,
      job.id,
      job.version,
      next.status,
      JSON.stringify(next.summary),
      next.hash,
      next.binding?.mac ?? null,
      next.binding?.keyId ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(409, 'CONFLICT', 'Import job version mismatch.');
  return row;
}

function jobStateError(job: JobRow): AppError {
  if (job.status === 'COMMITTED') {
    return new AppError(409, 'IMPORT_JOB_COMMITTED', 'This import job was already committed.');
  }
  return new AppError(
    409,
    'IMPORT_JOB_STATE',
    `This operation is not available for an import job that is ${job.status}.`,
  );
}

/** A refusal that must be answered AFTER the transaction commits, because the refreshed preview it persisted must survive. */
export type CommitOutcome =
  { kind: 'done'; result: IdempotentResult } | { kind: 'refused'; error: AppError };

/**
 * The import framework (docs/architecture/v3/26-student-identifiers-and-imports-m2b2.md; doc 02 §4.11; doc 04 Part 16):
 * create -> validate -> preview (rows) -> commit, with an error report. It owns app.import_jobs and app.import_job_rows
 * and nothing else: records are created only through the owning services, behind an `ImportAdapter`.
 *
 * AUTHORIZATION: `import.job.manage` AND the create permission of the record kind, both at ORGANIZATION scope, for every
 * operation; staff actors only. A job belongs to the user who created it (database policy): another user of the same
 * tenant, or any user of another tenant, gets the same 404 as for a missing job.
 *
 * VALIDATE never touches a student, employee, account or audit record: it writes only the job's own rows and summary.
 * COMMIT is all-or-nothing in ONE transaction: it locks the job, takes the per-person locks of every account in sorted
 * order, revalidates every row against the CURRENT state, and applies the preview only if the revalidated outcome is
 * byte-identical (same hash). Any difference applies nothing: errors close the job (FAILED, nothing created), anything
 * else refreshes the preview (409 IMPORT_PREVIEW_CHANGED) so the administrator reviews the new outcome. A write-time
 * conflict (a concurrent create) rolls the whole commit back (409 IMPORT_COMMIT_CONFLICT) and leaves the job VALIDATED.
 */
export class ImportService {
  static adapterFor(type: ImportType): ImportAdapter {
    return ADAPTERS[type];
  }

  /** Stores a DRAFT job and its rows (nothing is validated yet), idempotently (`Idempotency-Key`). */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    input: unknown,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    const adapter = ADAPTERS[type];
    const rows = parseRows(input);
    await authorize(tx, ctx, adapter);
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    return runIdempotent(
      tx,
      ctx,
      { key, operation: adapter.createOperation, request: { type, rows } },
      async () => {
        const jobId = uuidv7();
        await tx.query(
          `INSERT INTO app.import_jobs (id, organization_id, type, created_by, row_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [jobId, ctx.tenantId, type, ctx.userId, rows.length],
        );
        await tx.query(
          `INSERT INTO app.import_job_rows (id, organization_id, job_id, row_no, raw)
           SELECT v.id, $1, $2, v.row_no, v.raw
             FROM unnest($3::uuid[], $4::int[], $5::jsonb[]) AS v(id, row_no, raw)`,
          [
            ctx.tenantId,
            jobId,
            rows.map(() => uuidv7()),
            rows.map((_, i) => i + 1),
            rows.map((r) => JSON.stringify(r)),
          ],
        );
        await recordAudit(
          tx,
          ctx,
          {
            action: 'import_job.create',
            resourceType: 'import_job',
            resourceId: jobId,
            riskTier: 1,
            changes: { type: { old: null, new: type }, rowCount: { old: null, new: rows.length } },
          },
          meta,
        );
        return { status: 201, body: { success: true, data: { id: jobId, version: 1 } } };
      },
    );
  }

  /**
   * Re-evaluates every row against the current state and stores the outcome. Repeatable and read-only for every domain
   * table. VALIDATED when no row has an error (warnings allowed), otherwise the job stays DRAFT. DRAFT and VALIDATED jobs only.
   */
  static async validate(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    jobId: string,
    body?: unknown,
  ): Promise<ImportJobDto> {
    ensureTrusted(ctx);
    const id = parseJobId(jobId);
    const matchingInput = matchingFrom(body);
    const adapter = ADAPTERS[type];
    await authorize(tx, ctx, adapter);
    const job = await loadJob(tx, ctx, type, id, true);
    if (job.status !== 'DRAFT' && job.status !== 'VALIDATED') throw jobStateError(job);

    const matching = await bindMatching(tx, ctx, adapter, job, matchingInput);
    const outcomes = await evaluate(tx, ctx, adapter, job.id, matching);
    await persistOutcomes(tx, ctx, job.id, outcomes);
    const summary = summarize(outcomes);
    const next = await updateJob(tx, ctx, job, {
      status: summary.invalidRows === 0 ? 'VALIDATED' : 'DRAFT',
      summary,
      hash: outcomeHash(outcomes),
    });
    return toJobDto(next);
  }

  /** The job, for polling the workflow. No audit on read. */
  static async get(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    jobId: string,
  ): Promise<ImportJobDto> {
    ensureTrusted(ctx);
    const id = parseJobId(jobId);
    await authorize(tx, ctx, ADAPTERS[type]);
    return toJobDto(await loadJob(tx, ctx, type, id, false));
  }

  /** The preview: raw values, the exact proposed change, errors and warnings, by row number (keyset pagination). */
  static async rows(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    jobId: string,
    query: { status?: unknown; afterRowNo?: unknown; limit?: unknown },
  ): Promise<{ data: ImportRowDto[]; nextAfterRowNo: number | null }> {
    ensureTrusted(ctx);
    const id = parseJobId(jobId);
    const status = typeof query.status === 'string' ? query.status : null;
    if (query.status !== undefined && status === null) throw invalid('Invalid row status filter.');
    if (status !== null && !(IMPORT_ROW_STATUSES as readonly string[]).includes(status)) {
      throw invalid('Invalid row status filter.');
    }
    const after = query.afterRowNo === undefined ? 0 : Number(query.afterRowNo);
    const limit = query.limit === undefined ? IMPORT_ROWS_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(after) || after < 0 || after > MAX_IMPORT_ROWS) {
      throw invalid('afterRowNo must be a row number.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > IMPORT_ROWS_PAGE_SIZE) {
      throw invalid(`limit must be 1 to ${IMPORT_ROWS_PAGE_SIZE}.`);
    }
    await authorize(tx, ctx, ADAPTERS[type]);
    const job = await loadJob(tx, ctx, type, id, false);

    const res = await tx.query<{
      row_no: number;
      status: ImportRowStatus;
      raw: RawRow;
      normalized: Record<string, unknown> | null;
      errors: RowIssue[];
      warnings: RowIssue[];
      record_id: string | null;
    }>(
      `SELECT row_no, status, raw, normalized, errors, warnings, COALESCE(student_id, employee_id) AS record_id
         FROM app.import_job_rows
        WHERE organization_id = $1 AND job_id = $2 AND row_no > $3 AND ($4::text IS NULL OR status = $4)
        ORDER BY row_no LIMIT $5`,
      [ctx.tenantId, job.id, after, status, limit + 1],
    );
    const page = res.rows.slice(0, limit);
    return {
      data: page.map((r) => ({
        rowNo: r.row_no,
        status: r.status,
        raw: r.raw,
        normalized: r.normalized,
        errors: r.errors,
        warnings: r.warnings,
        recordId: r.record_id,
      })),
      nextAfterRowNo: res.rows.length > limit ? (page[page.length - 1]?.row_no ?? null) : null,
    };
  }

  /** The error report as CSV (rows with errors or warnings). Available in every state; it carries no submitted values. */
  static async errorReport(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    jobId: string,
  ): Promise<string> {
    ensureTrusted(ctx);
    const id = parseJobId(jobId);
    await authorize(tx, ctx, ADAPTERS[type]);
    const job = await loadJob(tx, ctx, type, id, false);
    const res = await tx.query<{ row_no: number; errors: RowIssue[]; warnings: RowIssue[] }>(
      `SELECT row_no, errors, warnings FROM app.import_job_rows
        WHERE organization_id = $1 AND job_id = $2
          AND (jsonb_array_length(errors) > 0 OR jsonb_array_length(warnings) > 0)
        ORDER BY row_no`,
      [ctx.tenantId, job.id],
    );
    return buildErrorReport(
      res.rows.map((r) => ({ rowNo: r.row_no, errors: r.errors, warnings: r.warnings })),
    );
  }

  /**
   * Applies a VALIDATED job. `If-Match` carries the exact job version the administrator previewed. See the class comment
   * for the commit protocol. Returns `refused` (to be answered after the transaction commits) when the preview is stale.
   */
  static async commit(
    tx: TenantTx,
    ctx: TrustedContext,
    type: ImportType,
    jobId: string,
    input: { reason: unknown; acknowledgeWarnings?: unknown; matching?: unknown },
    options: {
      expected: ExpectedVersion;
      idempotencyKey: unknown;
      meta?: AuditRequestMeta;
      /** From the IMPORT_MATCHING_KEYS ring; absent = a commit carrying matching data is refused (503), never unbound. */
      binder?: MatchingBinder;
    },
  ): Promise<CommitOutcome> {
    ensureTrusted(ctx);
    const id = parseJobId(jobId);
    if (!input || typeof input !== 'object') throw invalid('Commit payload is required.');
    if (
      Object.keys(input).some(
        (k) => k !== 'reason' && k !== 'acknowledgeWarnings' && k !== 'matching',
      )
    ) {
      throw invalid('The payload contains an unknown field.');
    }
    const reason = parseReason(input.reason);
    if (input.acknowledgeWarnings !== undefined && typeof input.acknowledgeWarnings !== 'boolean') {
      throw invalid('acknowledgeWarnings must be true or false.');
    }
    const acknowledged = input.acknowledgeWarnings === true;
    const expectedVersion = requireExactVersion(options.expected);
    const adapter = ADAPTERS[type];
    await authorize(tx, ctx, adapter);
    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    // Serialises every commit, validation and retry of this job. Taken BEFORE the idempotency claim, so a retry with the
    // same key waits here and then replays the stored answer.
    const job = await loadJob(tx, ctx, type, id, true);

    // The resupplied matching data of THIS request: bound to the stored rows, held in memory, never written.
    const matching = await bindMatching(tx, ctx, adapter, job, input.matching);
    assertMatchingValid(adapter, matching);
    // FAIL CLOSED: matching data can neither be committed nor compared on a retry without the HMAC key. No fallback to
    // presence-only or to an unkeyed digest; nothing is evaluated, locked or written.
    const canonical = canonicalMatching(matching);
    const binder = options.binder;
    if (canonical !== null && !binder) throw matchingUnavailable();
    const scope = { organizationId: ctx.tenantId, jobId: job.id };

    let preChecked = false;
    if (job.status === 'VALIDATED' && job.version === expectedVersion) {
      // Presence binding: the client must supply, for every row, the same matching cells it supplied at the validation the
      // administrator reviewed. Anything else is refused HERE, before any evaluation, so a commit that omitted or altered
      // the data can neither refresh the stored preview nor slip past the acknowledgement it was shown.
      if (await presenceDiffers(tx, ctx, job, matching)) {
        throw new AppError(
          409,
          'IMPORT_MATCHING_MISMATCH',
          'The matching data differs from the data that was validated. Validate the job again with the same file.',
        );
      }
      const stored = await tx.query<{ normalized: Proposal | null }>(
        `SELECT normalized FROM app.import_job_rows
          WHERE organization_id = $1 AND job_id = $2 AND status = 'VALID' ORDER BY row_no`,
        [ctx.tenantId, job.id],
      );
      // Per-person locks of every account the commit will touch, in ONE global order (ascending id), so two overlapping
      // imports and the single-record writers (which take one person lock first) can never deadlock. Held until the
      // transaction ends, i.e. across the revalidation below and the writes after it.
      const accounts = [
        ...new Set(
          stored.rows.flatMap((r) => (r.normalized ? [adapter.accountIdOf(r.normalized)] : [])),
        ),
      ].sort();
      for (const accountId of accounts) await lockPersonIdentity(tx, ctx.tenantId, accountId);

      // Revalidate against the CURRENT state and compare with what the administrator reviewed.
      const outcomes = await evaluate(tx, ctx, adapter, job.id, matching);
      const summary = summarize(outcomes);
      const hash = outcomeHash(outcomes);
      if (summary.invalidRows !== 0) {
        await persistOutcomes(tx, ctx, job.id, outcomes);
        await updateJob(tx, ctx, job, { status: 'FAILED', summary, hash });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'import_job.fail',
            resourceType: 'import_job',
            resourceId: job.id,
            riskTier: 1,
            changes: { status: { old: 'VALIDATED', new: 'FAILED' } },
          },
          meta,
        );
        return {
          kind: 'refused',
          error: new AppError(
            409,
            'IMPORT_COMMIT_CONFLICT',
            'Rows no longer pass validation. Nothing was imported and this job is closed: download the error report and import again.',
          ),
        };
      }
      if (hash !== job.validation_hash) {
        await persistOutcomes(tx, ctx, job.id, outcomes);
        await updateJob(tx, ctx, job, { status: 'VALIDATED', summary, hash });
        return {
          kind: 'refused',
          error: new AppError(
            409,
            'IMPORT_PREVIEW_CHANGED',
            'The proposed changes differ from the preview you reviewed. Nothing was imported: review the refreshed preview and commit again.',
          ),
        };
      }
      preChecked = true;
    }

    const result = await runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: `POST /api/v1/imports/${type}/:id/commit`,
        request: { type, jobId: id, expectedVersion, reason, acknowledged },
      },
      async () => {
        if (job.status !== 'VALIDATED') throw jobStateError(job);
        if (job.version !== expectedVersion || !preChecked) {
          throw new AppError(409, 'CONFLICT', 'Import job version mismatch.');
        }
        if ((job.summary.rowsWithWarnings ?? 0) > 0 && !acknowledged) {
          throw new AppError(
            409,
            'IMPORT_WARNINGS_UNACKNOWLEDGED',
            'The preview has warnings. Review them and commit with acknowledgeWarnings set to true.',
          );
        }

        const rows = await tx.query<{ id: string; row_no: number; normalized: Proposal }>(
          `SELECT id, row_no, normalized FROM app.import_job_rows
            WHERE organization_id = $1 AND job_id = $2 AND status = 'VALID' ORDER BY row_no`,
          [ctx.tenantId, job.id],
        );
        const dupes = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.import_job_rows
            WHERE organization_id = $1 AND job_id = $2 AND warnings @> $3::jsonb`,
          [ctx.tenantId, job.id, JSON.stringify([{ code: 'POSSIBLE_DUPLICATE_STUDENT' }])],
        );
        const duplicateRows = dupes.rows[0]?.n ?? 0;
        const created: { rowId: string; recordId: string }[] = [];
        for (const row of rows.rows) {
          try {
            created.push({
              rowId: row.id,
              recordId: await adapter.create(tx, ctx, row.normalized, reason, meta),
            });
          } catch (err) {
            // Anything a concurrent writer can cause (duplicate, state change) becomes ONE stable answer for the whole
            // job; the transaction rolls back, so no row of this job is created.
            if (err instanceof AppError && (err.statusCode === 409 || err.statusCode === 404)) {
              throw new AppError(
                409,
                'IMPORT_COMMIT_CONFLICT',
                `Row ${row.row_no} conflicts with a change made since validation. Nothing was imported: validate the job again.`,
              );
            }
            throw err;
          }
        }

        if (type === 'STUDENT_RECORDS') {
          await tx.query(
            `UPDATE app.import_job_rows AS t SET status = 'COMMITTED', student_id = v.record_id
               FROM unnest($3::uuid[], $4::uuid[]) AS v(row_id, record_id)
              WHERE t.organization_id = $1 AND t.job_id = $2 AND t.id = v.row_id`,
            [ctx.tenantId, job.id, created.map((c) => c.rowId), created.map((c) => c.recordId)],
          );
        } else {
          await tx.query(
            `UPDATE app.import_job_rows AS t SET status = 'COMMITTED', employee_id = v.record_id
               FROM unnest($3::uuid[], $4::uuid[]) AS v(row_id, record_id)
              WHERE t.organization_id = $1 AND t.job_id = $2 AND t.id = v.row_id`,
            [ctx.tenantId, job.id, created.map((c) => c.rowId), created.map((c) => c.recordId)],
          );
        }
        const done = await updateJob(tx, ctx, job, {
          status: 'COMMITTED',
          summary: { ...job.summary, createdRows: created.length },
          hash: job.validation_hash,
          binding: canonical === null ? null : binder!.bind(scope, canonical),
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'import_job.commit',
            resourceType: 'import_job',
            resourceId: job.id,
            riskTier: 2,
            reasonText: reason,
            changes: {
              status: { old: 'VALIDATED', new: 'COMMITTED' },
              createdRows: { old: null, new: created.length },
            },
            // Counts only: which rows were warned about, and that the administrator acknowledged them. Never a value.
            metadata: {
              type,
              acknowledgedWarnings: acknowledged,
              rowsWithWarnings: job.summary.rowsWithWarnings ?? 0,
              duplicateWarningRows: duplicateRows,
              matchingRowsSupplied: matching.size,
            },
          },
          meta,
        );
        return {
          status: 200,
          body: {
            success: true,
            data: {
              id: job.id,
              status: 'COMMITTED',
              createdRows: created.length,
              version: done.version,
            },
          },
        };
      },
    );
    // An idempotent REPLAY must be a replay of the same request. The fingerprint above covers the reason, the version and the
    // acknowledgement; the matching data (values, presence and row binding, in canonical form) is covered by the HMAC binding
    // stored when the job was committed. Equivalent data replays; anything else is the established key-reuse error. With
    // matching data on either side the key is required (checked above, or `verify` refuses a retired key).
    if (result.replayed) {
      const stored =
        job.match_binding && job.match_binding_key_label
          ? { keyId: job.match_binding_key_label, mac: job.match_binding }
          : null;
      const same =
        stored === null || canonical === null
          ? stored === null && canonical === null
          : binder!.verify(stored, scope, canonical);
      if (!same) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
        );
      }
    }
    return { kind: 'done', result };
  }
}
