import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';

/**
 * Shared vocabulary of the import framework (docs/architecture/v3/02 §4.11, 26-student-identifiers-and-imports-m2b2.md).
 * A LEAF file: the entity adapters (students, people) import it at runtime, so it must not import the import service.
 */

/** The record kinds an import can create. Names the RECORD, not a role (the faculty import creates employee records). */
export const IMPORT_TYPES = ['STUDENT_RECORDS', 'EMPLOYEE_RECORDS'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const IMPORT_JOB_STATUSES = ['DRAFT', 'VALIDATED', 'COMMITTED', 'FAILED'] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];
export const IMPORT_ROW_STATUSES = ['PENDING', 'VALID', 'INVALID', 'COMMITTED'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/**
 * Technical bounds chosen for this implementation (the documents state none; recorded in doc 26 §5). The row cap also
 * lives in the database (CHECK on import_jobs.row_count); the platform body limit (1 MiB) bounds the request.
 */
export const MAX_IMPORT_ROWS = 1000;
export const MAX_COLUMNS_PER_ROW = 12;
export const MAX_COLUMN_NAME_LENGTH = 40;
export const MAX_CELL_LENGTH = 200;
/** Page size of the row preview. */
export const IMPORT_ROWS_PAGE_SIZE = 100;

/**
 * Columns that carry SENSITIVE matching-only inputs (doc 26 §3.5). They are never stored: a create request that names one
 * is refused, and the client resupplies the values (as `matching` entries, not as cells) on every validate and commit.
 */
export const MATCHING_ONLY_COLUMNS = ['dateOfBirth', 'guardianPhone'] as const;

/** One submitted row exactly as received: column name to text (a CSV cell is always text). */
export type RawRow = Readonly<Record<string, string>>;

/**
 * A stable, machine-readable problem with one row. `message` is fixed text per code: it never echoes a submitted value, so
 * an error report cannot carry data the reader did not already send, and the same input always yields the same issues.
 */
export interface RowIssue {
  code: string;
  field?: string;
  message: string;
  /** The first row of the file that already uses the same value (DUPLICATE_IN_FILE). */
  relatedRow?: number;
}

export function issue(
  code: string,
  message: string,
  field?: string,
  relatedRow?: number,
): RowIssue {
  return {
    code,
    message,
    ...(field === undefined ? {} : { field }),
    ...(relatedRow === undefined ? {} : { relatedRow }),
  };
}

/** Deterministic order: by field, then code, then related row. Equal input => byte-equal output. */
export function sortIssues(issues: readonly RowIssue[]): RowIssue[] {
  const key = (i: RowIssue): string => `${i.field ?? ''}\u0000${i.code}\u0000${i.relatedRow ?? 0}`;
  return [...issues].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The exact change a commit would apply for one row (`normalized` in the preview). */
export type Proposal = Record<string, string | number | boolean | null>;

/** Matching-only inputs of the possible-duplicate check. Never part of the proposal, so never previewed or hashed. */
export interface MatchInput {
  name?: string;
  dateOfBirth?: string;
  guardianPhone?: string;
}
/** The request-scoped, resupplied matching cells of one row. They live in request memory only. */
export interface MatchingCells {
  dateOfBirth?: string;
  guardianPhone?: string;
}
/** One entry of the `matching` list of a validate or commit request: the row it belongs to and the row's stored e-mail. */
export interface MatchingEntry extends MatchingCells {
  rowNo: number;
  email: string;
}
export interface ParseResult {
  /** Present only when every field parsed; carries normalised values and NO database-derived facts. */
  proposal: Proposal | null;
  errors: RowIssue[];
  /** Matching input taken from the STORED row (the name). The sensitive cells arrive separately (`parseMatching`). */
  match?: MatchInput;
}
export interface CheckInputRow {
  rowNo: number;
  proposal: Proposal;
  match?: MatchInput;
}
export interface CheckResult {
  /** The parsed proposal enriched with database-derived facts (the resolved account id). */
  proposal: Proposal;
  errors: RowIssue[];
  warnings: RowIssue[];
}

/**
 * What the import framework needs from a record kind. Implemented by the module that OWNS the records (students,
 * people): the framework never reads or writes their tables.
 */
export interface ImportAdapter {
  readonly type: ImportType;
  /** Required at ORGANIZATION scope, in addition to import.job.manage, to create, validate and commit a job of this type. */
  readonly createPermission: string;
  /** Operation name of the job-creation request, part of the idempotency fingerprint. */
  readonly createOperation: string;
  /** Shape validation and normalisation. No database access. */
  parse(raw: RawRow): ParseResult;
  /**
   * Validates the resupplied matching cells of one row (strict date of birth, bounded phone) and returns the normalised
   * values plus fixed-text issues that never echo a value. Absent: the record kind takes no matching data.
   */
  parseMatching?(cells: MatchingCells): { match: MatchInput; errors: RowIssue[] };
  /**
   * READ-ONLY checks against the current database state and against the other rows of the same file (exact identity
   * rules only: no fuzzy matching). Must not take locks and must not write.
   */
  check(
    tx: TenantTx,
    ctx: TrustedContext,
    rows: readonly CheckInputRow[],
  ): Promise<Map<number, CheckResult>>;
  /** The account the row would turn into a person record: the key of the per-person lock. */
  accountIdOf(proposal: Proposal): string;
  /**
   * Creates ONE record through the owning service (its own checks, audit and uniqueness apply). The caller already holds
   * the per-person lock and has proven the permission at ORGANIZATION scope. Returns the new record's id.
   */
  create(
    tx: TenantTx,
    ctx: TrustedContext,
    proposal: Proposal,
    reason: string,
    meta: AuditRequestMeta,
  ): Promise<string>;
}

/** Marks the second and later occurrences of a value inside one file (the first occurrence stays valid). */
export class FileDuplicates {
  readonly #first = new Map<string, number>();
  /** Row number of the first row that used `value` for `field`, or undefined when this row is that first one. */
  seen(field: string, value: string, rowNo: number): number | undefined {
    const k = `${field}\u0000${value}`;
    const first = this.#first.get(k);
    if (first === undefined) {
      this.#first.set(k, rowNo);
      return undefined;
    }
    return first;
  }
}

/** The UTC calendar date; the only "today" the import warnings use (the tenant has no timezone of its own). */
export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
