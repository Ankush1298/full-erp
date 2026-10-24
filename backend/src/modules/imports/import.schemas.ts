import { Type, type Static } from '@sinclair/typebox';
import {
  IMPORT_JOB_STATUSES,
  IMPORT_ROW_STATUSES,
  IMPORT_ROWS_PAGE_SIZE,
  IMPORT_TYPES,
  MAX_CELL_LENGTH,
  MAX_COLUMNS_PER_ROW,
  MAX_IMPORT_ROWS,
} from './import.common.js';

/**
 * HTTP contract of the import framework (docs/architecture/v3/26-student-identifiers-and-imports-m2b2.md). Every body is
 * closed (`additionalProperties: false`). A row is a flat object of text cells; the service re-validates it (column-name
 * length, count, cell length) so the bounds also hold for direct callers. No tenant, user, status or version field can be
 * supplied.
 */
const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
const UuidV7 = Type.String({ pattern: UUID_V7_PATTERN });

export const ImportJobParamsSchema = Type.Object({ id: UuidV7 }, { additionalProperties: false });
export type ImportJobParams = Static<typeof ImportJobParamsSchema>;

const RowSchema = Type.Record(Type.String(), Type.String({ maxLength: MAX_CELL_LENGTH }), {
  maxProperties: MAX_COLUMNS_PER_ROW,
});

export const CreateImportBodySchema = Type.Object(
  { rows: Type.Array(RowSchema, { minItems: 1, maxItems: MAX_IMPORT_ROWS }) },
  { additionalProperties: false },
);
export type CreateImportBody = Static<typeof CreateImportBodySchema>;

/** `reason` is the A2 reason stored on every audit event the commit writes; `acknowledgeWarnings` confirms the preview's warnings. */
export const CommitImportBodySchema = Type.Object(
  {
    reason: Type.String({ minLength: 5, maxLength: 500 }),
    /**
     * Deliberately UNTYPED here, like `matching`: the HTTP layer's type coercion would turn `"true"` or `1` into `true`. The
     * service accepts a JSON boolean only (400 otherwise, before any database access); omitted means not acknowledged.
     */
    acknowledgeWarnings: Type.Optional(Type.Unknown()),
    /**
     * The resupplied, matching-only cells (doc 26 §3.5.4): `[{ rowNo, email, dateOfBirth?, guardianPhone? }]`, never stored.
     * Deliberately UNTYPED here: the HTTP layer coerces scalar types (`20050304` -> "20050304"), and the validate route has
     * no body schema, so the service's `bindMatching` is the single, strict validator of this list for both routes.
     */
    matching: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export type CommitImportBody = Static<typeof CommitImportBodySchema>;

export const ListImportRowsQuerySchema = Type.Object(
  {
    status: Type.Optional(Type.Union(IMPORT_ROW_STATUSES.map((s) => Type.Literal(s)))),
    afterRowNo: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_IMPORT_ROWS })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: IMPORT_ROWS_PAGE_SIZE })),
  },
  { additionalProperties: false },
);
export type ListImportRowsQuery = Static<typeof ListImportRowsQuerySchema>;

const IssueSchema = Type.Object(
  {
    code: Type.String(),
    field: Type.Optional(Type.String()),
    message: Type.String(),
    relatedRow: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ImportJobSchema = Type.Object(
  {
    id: UuidV7,
    type: Type.Union(IMPORT_TYPES.map((t) => Type.Literal(t))),
    status: Type.Union(IMPORT_JOB_STATUSES.map((s) => Type.Literal(s))),
    rowCount: Type.Integer({ minimum: 1 }),
    summary: Type.Object(
      {
        validRows: Type.Optional(Type.Integer({ minimum: 0 })),
        invalidRows: Type.Optional(Type.Integer({ minimum: 0 })),
        rowsWithWarnings: Type.Optional(Type.Integer({ minimum: 0 })),
        errorCount: Type.Optional(Type.Integer({ minimum: 0 })),
        warningCount: Type.Optional(Type.Integer({ minimum: 0 })),
        createdRows: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    version: Type.Integer({ minimum: 1 }),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    committedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportJobDto = Static<typeof ImportJobSchema>;

export const ImportRowSchema = Type.Object(
  {
    rowNo: Type.Integer({ minimum: 1 }),
    status: Type.Union(IMPORT_ROW_STATUSES.map((s) => Type.Literal(s))),
    raw: Type.Record(Type.String(), Type.String()),
    normalized: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    errors: Type.Array(IssueSchema),
    warnings: Type.Array(IssueSchema),
    recordId: Type.Union([UuidV7, Type.Null()]),
  },
  { additionalProperties: false },
);
export type ImportRowDto = Static<typeof ImportRowSchema>;

export const CreateImportResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      { id: UuidV7, version: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const GetImportResponseSchema = Type.Object(
  { success: Type.Literal(true), data: ImportJobSchema },
  { additionalProperties: false },
);
export const ListImportRowsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(ImportRowSchema),
    page: Type.Object(
      { nextAfterRowNo: Type.Union([Type.Integer(), Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const CommitImportResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        id: UuidV7,
        status: Type.Literal('COMMITTED'),
        createdRows: Type.Integer({ minimum: 0 }),
        version: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
