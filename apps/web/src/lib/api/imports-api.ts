import { z } from 'zod';
import type { ApiClient } from './client';

/** Typed access to the Milestone 2 import framework (/students/imports, /faculty/imports). */

export type ImportKind = 'students' | 'faculty';

export const ImportJobSchema = z.object({
  id: z.string(),
  type: z.enum(['STUDENT_RECORDS', 'EMPLOYEE_RECORDS']),
  status: z.enum(['DRAFT', 'VALIDATED', 'COMMITTED', 'FAILED']),
  rowCount: z.number(),
  summary: z.object({
    validRows: z.number().optional(),
    invalidRows: z.number().optional(),
    rowsWithWarnings: z.number().optional(),
    errorCount: z.number().optional(),
    warningCount: z.number().optional(),
    createdRows: z.number().optional(),
  }),
  version: z.number(),
  committedAt: z.string().nullable(),
});
export type ImportJob = z.infer<typeof ImportJobSchema>;

const IssueSchema = z.object({
  code: z.string(),
  field: z.string().optional(),
  relatedRow: z.number().optional(),
});
export type ImportIssue = z.infer<typeof IssueSchema>;

export const ImportRowSchema = z.object({
  rowNo: z.number(),
  status: z.enum(['PENDING', 'VALID', 'INVALID', 'COMMITTED']),
  raw: z.record(z.string(), z.string()),
  normalized: z.record(z.string(), z.unknown()).nullable(),
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

const Created = z.object({
  success: z.boolean(),
  data: z.object({ id: z.string(), version: z.number() }),
});
const OneJob = z.object({ success: z.boolean(), data: ImportJobSchema });
const Rows = z.object({
  success: z.boolean(),
  data: z.array(ImportRowSchema),
  page: z.object({ nextAfterRowNo: z.number().nullable() }),
});
const Committed = z.object({
  success: z.boolean(),
  data: z.object({
    id: z.string(),
    status: z.literal('COMMITTED'),
    createdRows: z.number(),
    version: z.number(),
  }),
});

const root = (kind: ImportKind): string => `/${kind}/imports`;
const at = (kind: ImportKind, id: string): string => `${root(kind)}/${encodeURIComponent(id)}`;

/** One resupplied matching entry: the row it belongs to (number and e-mail) and the matching-only cells. Never stored by the server. */
export interface MatchingEntry {
  rowNo: number;
  email: string;
  dateOfBirth?: string;
  guardianPhone?: string;
}

const MATCHING_COLUMNS = ['dateOfBirth', 'guardianPhone'] as const;

/**
 * Separates the matching-only columns from the rows (doc 26 §3.5.4): the rows are created without them, and the entries
 * are sent again with every validate and commit. Pure; the values live in the page's in-memory CSV text only.
 */
export function splitMatching(rows: Record<string, string>[]): {
  rows: Record<string, string>[];
  matching: MatchingEntry[];
} {
  const matching: MatchingEntry[] = [];
  const kept = rows.map((row, i) => {
    const rest: Record<string, string> = {};
    const cells: Partial<Record<(typeof MATCHING_COLUMNS)[number], string>> = {};
    for (const [k, v] of Object.entries(row)) {
      if ((MATCHING_COLUMNS as readonly string[]).includes(k)) {
        if (v.trim() !== '') cells[k as (typeof MATCHING_COLUMNS)[number]] = v.trim();
      } else rest[k] = v;
    }
    if (cells.dateOfBirth !== undefined || cells.guardianPhone !== undefined) {
      matching.push({ rowNo: i + 1, email: (row.email ?? '').trim(), ...cells });
    }
    return rest;
  });
  return { rows: kept, matching };
}

export const createImport = (
  c: ApiClient,
  kind: ImportKind,
  rows: Record<string, string>[],
  idempotencyKey: string,
) =>
  c.post(root(kind), {
    schema: Created,
    body: { rows },
    headers: { 'Idempotency-Key': idempotencyKey },
  });

export const validateImport = (
  c: ApiClient,
  kind: ImportKind,
  id: string,
  matching: MatchingEntry[] = [],
) =>
  c
    .post(`${at(kind, id)}/validate`, {
      schema: OneJob,
      ...(matching.length > 0 ? { body: { matching } } : {}),
    })
    .then((r) => r.data);

export const fetchImport = (c: ApiClient, kind: ImportKind, id: string) =>
  c.get(at(kind, id), { schema: OneJob }).then((r) => r.data);

export const fetchImportRows = (
  c: ApiClient,
  kind: ImportKind,
  id: string,
  afterRowNo: number,
  status?: 'INVALID',
) =>
  c.get(
    `${at(kind, id)}/rows?limit=100&afterRowNo=${afterRowNo}${status ? `&status=${status}` : ''}`,
    { schema: Rows },
  );

export const commitImport = (
  c: ApiClient,
  kind: ImportKind,
  job: ImportJob,
  body: { reason: string; acknowledgeWarnings: boolean; matching?: MatchingEntry[] },
  idempotencyKey: string,
) =>
  c
    .post(`${at(kind, job.id)}/commit`, {
      schema: Committed,
      body,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${job.version}"` },
    })
    .then((r) => r.data);

/** Same-origin URL of the error report (a cookie-authenticated GET the browser downloads). */
export const errorReportPath = (kind: ImportKind, id: string): string =>
  `${at(kind, id)}/error-report`;
