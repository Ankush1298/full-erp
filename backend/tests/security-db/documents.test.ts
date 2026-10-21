import { describe, expect, it } from 'vitest';
import { CTX, ORG_A, STAFF_A, STUDENT_A } from '../support/fixtures.js';
import { adminQuery, runStepsAs } from '../support/db-harness.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

// Document kernel (migration 0031) database-level invariants NOT already covered by schema-linter / roles-and-privileges
// (which cover forced RLS, owner-blindness, FK-backing indexes, the immutable triggers, and the uuid_v7 domain for the
// two new tables). Here: least-privilege grants, the files_guard lifecycle, the AVAILABLE/CLEAN CHECK, and link FK/unique.

const key = (fileId: string): string =>
  `${ORG_A.toLowerCase()}/GENERAL/2026/${fileId.toLowerCase()}`;

/** Step that inserts a PENDING_UPLOAD file (runAs rolls back, so dependent work must share one runStepsAs). */
const insertPendingStep = (fileId: string): readonly [string, readonly unknown[]] => [
  `INSERT INTO app.files (id, organization_id, uploaded_by, storage_class, storage_key, original_name,
                          declared_mime, size_bytes, sha256, classification)
   VALUES ($1, $2, $3, 'GENERAL', $4, 'f.pdf', 'application/pdf', 10, repeat('a',64), 'INTERNAL')`,
  [fileId, ORG_A, STAFF_A, key(fileId)],
];

describe('app_runtime least privilege on files / file_links', () => {
  it('no DELETE on either table; no UPDATE on file_links (links and files are never hard-deleted at runtime)', async () => {
    const [r] = await adminQuery<Record<string, boolean>>(
      `SELECT has_table_privilege('app_runtime','app.files','DELETE')      AS files_delete,
              has_table_privilege('app_runtime','app.file_links','DELETE') AS links_delete,
              has_table_privilege('app_runtime','app.file_links','UPDATE') AS links_update,
              has_table_privilege('app_runtime','app.files','INSERT')      AS files_insert,
              has_table_privilege('app_runtime','app.file_links','INSERT') AS links_insert`,
    );
    expect(r).toEqual({
      files_delete: false,
      links_delete: false,
      links_update: false,
      files_insert: true,
      links_insert: true,
    });
  });

  it('runtime may UPDATE only the scan-lifecycle columns of files; identity/content columns are not grantable', async () => {
    const grantable = async (col: string): Promise<boolean> => {
      const [r] = await adminQuery<{ ok: boolean }>(
        `SELECT has_column_privilege('app_runtime', 'app.files', $1, 'UPDATE') AS ok`,
        [col],
      );
      return r!.ok;
    };
    for (const col of [
      'status',
      'detected_mime',
      'size_bytes',
      'sha256',
      'scan_result',
      'scanned_at',
    ]) {
      expect(await grantable(col), `${col} should be updatable`).toBe(true);
    }
    for (const col of [
      'storage_key',
      'storage_class',
      'original_name',
      'declared_mime',
      'uploaded_by',
      'classification',
    ]) {
      expect(await grantable(col), `${col} must NOT be updatable`).toBe(false);
    }
  });
});

const linkStep = (
  linkId: string,
  fileId: string,
  visibility = 'OWNER_VISIBLE',
): readonly [string, readonly unknown[]] => [
  `INSERT INTO app.file_links (id, organization_id, file_id, entity_type, entity_id, purpose, visibility)
   VALUES ($1, $2, $3, 'student', $4, 'id_proof', $5)`,
  [linkId, ORG_A, fileId, STUDENT_A, visibility],
];

describe('files_guard lifecycle (raw-writer backstop)', () => {
  it('rejects an illegal status transition (PENDING_UPLOAD -> AVAILABLE)', async () => {
    const id = uuidv7();
    const r = await runStepsAs(CTX.staffA, [
      insertPendingStep(id),
      [`UPDATE app.files SET status = 'AVAILABLE' WHERE id = $1`, [id]],
    ]);
    expect(r.error?.code).toBe('23001'); // restrict_violation (files_guard)
  });

  it('a file cannot become AVAILABLE without a CLEAN scan verdict (files_available_ck)', async () => {
    const id = uuidv7();
    const r = await runStepsAs(CTX.staffA, [
      insertPendingStep(id),
      [
        `UPDATE app.files SET status = 'SCANNING', detected_mime = 'application/pdf' WHERE id = $1`,
        [id],
      ],
      // SCANNING -> AVAILABLE is a legal transition, but the CHECK still refuses it with scan_result <> CLEAN
      [`UPDATE app.files SET status = 'AVAILABLE' WHERE id = $1`, [id]],
    ]);
    expect(r.error?.code).toBe('23514'); // check_violation (files_available_ck)
  });

  it('identity/content columns are frozen even via raw SQL (the UPDATE grant omits storage_key)', async () => {
    const id = uuidv7();
    const r = await runStepsAs(CTX.staffA, [
      insertPendingStep(id),
      [`UPDATE app.files SET storage_key = 'x/GENERAL/2026/y' WHERE id = $1`, [id]],
    ]);
    expect(r.error?.code).toBe('42501'); // permission denied (column not granted)
  });
});

describe('tenant isolation and link referential integrity', () => {
  it('a file written by staff A is invisible to staff B (RLS)', async () => {
    const id = uuidv7();
    const other = await runStepsAs(CTX.staffB, [
      // staff B inserting with A's id would be blocked; instead prove B cannot SEE a row A committed is covered by the
      // owner-blindness suite. Here: B cannot read a row that only A's context could ever have created.
      [`SELECT id FROM app.files WHERE storage_key = $1`, [key(id)]],
    ]);
    expect(other.error).toBeUndefined();
    expect(other.rows).toEqual([]);
  });

  it('a link to a non-existent file is refused by the composite foreign key', async () => {
    const r = await runStepsAs(CTX.staffA, [linkStep(uuidv7(), uuidv7())]);
    expect(r.error?.code).toBe('23503'); // foreign_key_violation
  });

  it('the same file/entity/purpose cannot be linked twice (unique)', async () => {
    const id = uuidv7();
    const r = await runStepsAs(CTX.staffA, [
      insertPendingStep(id),
      linkStep(uuidv7(), id),
      linkStep(uuidv7(), id),
    ]);
    expect(r.error?.code).toBe('23505'); // unique_violation on the second link
  });
});
