import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import {
  parseIdempotencyKey,
  runIdempotent,
  type IdempotentResult,
} from '../../shared/idempotency/index.js';
import { invalid, parseReason } from '../people/validation.js';
import {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  DEFAULT_UPLOAD_TTL_SECONDS,
  deriveStorageKey,
  isAllowedContentType,
  isStorageClass,
  maxBytesForClass,
  normalizeFileName,
  type StorageClass,
  type StorageDriver,
} from '../../shared/storage/index.js';
import type { InitiateUploadBody, LinkDocumentBody } from './document.schemas.js';

export const INITIATE_UPLOAD_OPERATION = 'POST /api/v1/documents/uploads';

export const CLASSIFICATIONS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const VISIBILITIES = ['OWNER_VISIBLE', 'STAFF_ONLY'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
const PURPOSE_RE = /^[a-z][a-z0-9_]{0,39}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type FinalizeScanVerdict = 'CLEAN' | 'INFECTED' | 'REJECTED' | 'ERROR';

export interface ScannableFile {
  id: string;
  organizationId: string;
  storageClass: StorageClass;
  storageKey: string;
  originalName: string;
  declaredMime: string | null;
  detectedMime: string | null;
  sizeBytes: number;
  sha256: string;
}

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface FileRow {
  id: string;
  uploaded_by: string;
  storage_class: StorageClass;
  storage_key: string;
  original_name: string;
  declared_mime: string | null;
  detected_mime: string | null;
  size_bytes: string | null; // bigint comes back as text
  sha256: string | null;
  status: string;
  classification: Classification;
  scan_result: string | null;
}
const FILE_COLS = `id, uploaded_by, storage_class, storage_key, original_name, declared_mime,
                   detected_mime, size_bytes::text AS size_bytes, sha256, status, classification, scan_result`;

/**
 * Central document storage kernel (ADR-010, docs/architecture/v3/03 Part 12, 24-documents.md).
 *
 * Lifecycle: initiate (PENDING_UPLOAD + presigned PUT) -> client PUTs the bytes -> complete (verify the object's
 * existence, size, checksum and real content type; -> SCANNING) -> [scan worker records a verdict] -> AVAILABLE |
 * QUARANTINED. A file is downloadable ONLY when AVAILABLE (scanned CLEAN), and only to an actor authorized on one of
 * its links. The ClamAV scanner is NOT built in this slice: `complete` never promotes to AVAILABLE, so nothing is
 * downloadable until a trustworthy verdict exists (fail closed). `finalizeScan` is the worker seam that records that
 * verdict; it has no HTTP route (clients cannot promote their own uploads).
 *
 * SCOPE: a student has no campus/department until an enrolment exists, so a CAMPUS/DEPARTMENT-scoped grant can never be
 * proven to contain a student-linked file (inert, like the student module); ORGANIZATION-scoped GRANTED holders and
 * the student themselves (SELF) reach it. The storage driver is injected so test/dev (in-memory) and production (S3)
 * behaviour stay completely separate.
 */
export class DocumentService {
  readonly #storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.#storage = storage;
  }

  /** True if the actor may exercise `permission` on `resource`; false on a 403/404 denial; rethrows anything else. */
  static async #allows(
    tx: TenantTx,
    ctx: TrustedContext,
    permission: string,
    resource?: Parameters<typeof AuthorizationEngine.assert>[3],
  ): Promise<boolean> {
    try {
      await AuthorizationEngine.assert(tx, ctx, permission, resource);
      return true;
    } catch (err) {
      if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 404))
        return false;
      throw err;
    }
  }

  /** Resolves a student in-tenant to {id, userId}, or 404 (missing and other-tenant are indistinguishable). */
  static async #resolveStudent(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<{ id: string; userId: string }> {
    const res = await tx.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM app.students WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, studentId],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    return { id: row.id, userId: row.user_id };
  }

  /**
   * Initiates an upload: authorizes the actor to attach a file to the intended entity, enforces the size/type policy,
   * creates app.files(status=PENDING_UPLOAD) and returns a presigned PUT to a tenant-scoped key. Idempotent
   * (Idempotency-Key). The link row is NOT created here (it is created by linkToStudent, once the file is CLEAN).
   */
  async initiateUpload(
    tx: TenantTx,
    ctx: TrustedContext,
    input: InitiateUploadBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Upload payload is required.');

    // Shape first (no database access): tenant facts are never revealed to an unauthenticated shape error.
    const storageClass = input.storageClass;
    if (!isStorageClass(storageClass)) throw invalid('Invalid storage class.');
    const originalName = normalizeFileName(input.originalName);
    if (!isAllowedContentType(input.contentType)) throw invalid('Unsupported content type.');
    const contentType = input.contentType;
    const maxBytes = maxBytesForClass(storageClass);
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
      throw invalid(`sizeBytes must be between 1 and ${maxBytes} for this storage class.`);
    }
    if (typeof input.sha256 !== 'string' || !SHA256_RE.test(input.sha256)) {
      throw invalid('sha256 must be a 64-character lowercase hex digest.');
    }
    const classification: Classification = input.classification ?? 'INTERNAL';
    if (input.link?.entityType !== 'student' || !isUuidV7(input.link.entityId)) {
      throw invalid('A valid student link is required.');
    }
    const entityId = input.link.entityId.toLowerCase();
    if (!PURPOSE_RE.test(input.link.purpose)) throw invalid('Invalid link purpose.');
    // Uploading a SENSITIVE-class file is a tier-2 audit event (doc 02, Files): a reason is then mandatory.
    const tier2 = storageClass === 'SENSITIVE';
    const reason = tier2 ? parseReason(input.reason) : undefined;

    // Authorization: held at all (403), then the intended student (404 if missing or out of scope).
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');
    const student = await DocumentService.#resolveStudent(tx, ctx, entityId);
    await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
      organization_id: ctx.tenantId,
      student_id: student.id,
      user_id: student.userId,
    });

    const key = parseIdempotencyKey(options.idempotencyKey);
    const meta = options.meta ?? {};

    return runIdempotent(
      tx,
      ctx,
      {
        key,
        operation: INITIATE_UPLOAD_OPERATION,
        request: {
          storageClass,
          originalName,
          contentType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          classification,
          entityId,
          purpose: input.link.purpose,
          reason,
        },
      },
      async () => {
        const id = uuidv7();
        const storageKey = deriveStorageKey(
          ctx.tenantId,
          storageClass,
          id,
          new Date().getUTCFullYear(),
        );
        await tx.query(
          `INSERT INTO app.files
             (id, organization_id, uploaded_by, storage_class, storage_key, original_name, declared_mime,
              size_bytes, sha256, status, classification)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_UPLOAD', $10)`,
          [
            id,
            ctx.tenantId,
            ctx.userId,
            storageClass,
            storageKey,
            originalName,
            contentType,
            input.sizeBytes,
            input.sha256,
            classification,
          ],
        );
        const upload = await this.#storage.presignUpload({
          storageClass,
          key: storageKey,
          contentType,
          maxBytes,
          ttlSeconds: DEFAULT_UPLOAD_TTL_SECONDS,
        });
        await recordAudit(
          tx,
          ctx,
          {
            action: 'file.upload.initiate',
            resourceType: 'file',
            resourceId: id,
            riskTier: tier2 ? 2 : 1,
            ...(reason ? { reasonText: reason } : {}),
            changes: {
              storageClass: { old: null, new: storageClass },
              classification: { old: null, new: classification },
              originalName: { old: null, new: originalName },
            },
            // The signed URL is NEVER audited; only the driver kind is kept.
            metadata: { storageDriver: this.#storage.kind },
          },
          meta,
        );
        return {
          status: 201,
          body: {
            success: true,
            data: {
              fileId: id,
              upload: {
                url: upload.url,
                method: upload.method,
                headers: upload.requiredHeaders,
                expiresAt: upload.expiresAt,
              },
            },
          },
        };
      },
    );
  }

  /**
   * Completes an upload: ONLY the uploader may complete their own PENDING_UPLOAD file (else 404). Verifies the object
   * exists and that its size, checksum (when the backend exposes it) and real (magic-byte) content type match what was
   * declared, then moves the file to SCANNING. It NEVER marks a file CLEAN or AVAILABLE: a trustworthy scan verdict is
   * still required (finalizeScan). A metadata mismatch records a REJECTED verdict, so the file can never be promoted.
   * A second completion finds the file already out of PENDING_UPLOAD and is refused (no duplicate completion).
   */
  async completeUpload(
    tx: TenantTx,
    ctx: TrustedContext,
    fileId: string,
    options: { meta?: AuditRequestMeta },
  ): Promise<{ id: string; status: string; scanResult: string | null }> {
    ensureTrusted(ctx);
    if (!isUuidV7(fileId)) throw invalid('Invalid file ID.');
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');

    const res = await tx.query<FileRow>(
      `SELECT ${FILE_COLS} FROM app.files WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, fileId],
    );
    const file = res.rows[0];
    // Only the uploader may complete their own upload; anyone else gets the same 404 as a missing file.
    if (!file || file.uploaded_by !== ctx.userId) throw resourceNotFound();
    if (file.status !== 'PENDING_UPLOAD') {
      throw new AppError(409, 'CONFLICT', 'This upload has already been completed.');
    }

    const head = await this.#storage.head({
      storageClass: file.storage_class,
      key: file.storage_key,
    });
    if (!head.exists) {
      throw new AppError(409, 'UPLOAD_NOT_FOUND', 'No uploaded object was found for this file.');
    }

    // Verify everything the completion can prove. A null sha256 from the backend is "unverifiable", not "mismatch".
    const sizeOk = head.sizeBytes === Number(file.size_bytes);
    const shaOk = head.sha256 === null || head.sha256 === file.sha256;
    const detected = head.contentType;
    const typeOk =
      detected !== null && isAllowedContentType(detected) && detected === file.declared_mime;
    const verified = sizeOk && shaOk && typeOk;
    const scanResult = verified ? null : 'REJECTED';

    await tx.query(
      `UPDATE app.files
          SET status = 'SCANNING', detected_mime = $3::text, scan_result = $4::text,
              scanned_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END
        WHERE organization_id = $1 AND id = $2 AND status = 'PENDING_UPLOAD'`,
      [ctx.tenantId, fileId, detected, scanResult],
    );

    await recordAudit(
      tx,
      ctx,
      {
        action: 'file.upload.complete',
        resourceType: 'file',
        resourceId: fileId,
        riskTier: file.storage_class === 'SENSITIVE' ? 2 : 1,
        ...(file.storage_class === 'SENSITIVE' ? { reasonText: 'Upload completion' } : {}),
        changes: {
          status: { old: 'PENDING_UPLOAD', new: 'SCANNING' },
          scanResult: { old: null, new: scanResult },
        },
      },
      options.meta ?? {},
    );
    return { id: fileId, status: 'SCANNING', scanResult };
  }

  /**
   * Worker seam to claim the next eligible SCANNING file for this tenant with row locking.
   * Uses FOR UPDATE SKIP LOCKED so concurrent scan workers never process the same file.
   */
  async claimNextScanningFile(tx: TenantTx, ctx: TrustedContext): Promise<ScannableFile | null> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');

    const res = await tx.query<FileRow>(
      `SELECT ${FILE_COLS}
         FROM app.files
        WHERE organization_id = $1
          AND status = 'SCANNING'
          AND scan_result IS NULL
        ORDER BY created_at ASC
        LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      [ctx.tenantId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: ctx.tenantId,
      storageClass: row.storage_class,
      storageKey: row.storage_key,
      originalName: row.original_name,
      declaredMime: row.declared_mime,
      detectedMime: row.detected_mime,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256 as string,
    };
  }

  /**
   * Worker seam for malware scanner and integrity verification: records a scan verdict on a SCANNING file.
   * CLEAN promotes to AVAILABLE (the database CHECK still requires verified size/sha/detected_mime);
   * INFECTED, REJECTED, and ERROR quarantine the file. There is NO HTTP route for this: a client can never
   * mark its own upload clean. Requires the actor to hold document.upload (the scan worker runs with that capability).
   */
  async finalizeScan(
    tx: TenantTx,
    ctx: TrustedContext,
    fileId: string,
    verdict: FinalizeScanVerdict,
    options?: { meta?: AuditRequestMeta; details?: string },
  ): Promise<{ id: string; status: string }> {
    ensureTrusted(ctx);
    if (!isUuidV7(fileId)) throw invalid('Invalid file ID.');
    if (
      verdict !== 'CLEAN' &&
      verdict !== 'INFECTED' &&
      verdict !== 'REJECTED' &&
      verdict !== 'ERROR'
    ) {
      throw invalid('Invalid scan verdict.');
    }
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');

    const res = await tx.query<FileRow>(
      `SELECT ${FILE_COLS} FROM app.files WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, fileId],
    );
    const file = res.rows[0];
    if (!file) throw resourceNotFound();
    if (file.status !== 'SCANNING' || file.scan_result !== null) {
      throw new AppError(409, 'CONFLICT', 'This file is not awaiting a scan verdict.');
    }
    const status = verdict === 'CLEAN' ? 'AVAILABLE' : 'QUARANTINED';
    await tx.query(
      `UPDATE app.files SET status = $3, scan_result = $4, scanned_at = now()
        WHERE organization_id = $1 AND id = $2 AND status = 'SCANNING'`,
      [ctx.tenantId, fileId, status, verdict],
    );
    await recordAudit(
      tx,
      ctx,
      {
        action: 'file.scan.complete',
        resourceType: 'file',
        resourceId: fileId,
        riskTier: 2,
        reasonText: options?.details
          ? `Scan verdict ${verdict}: ${options.details}`
          : `Scan verdict ${verdict}`,
        changes: {
          status: { old: 'SCANNING', new: status },
          scanResult: { old: null, new: verdict },
        },
      },
      options?.meta ?? {},
    );
    return { id: fileId, status };
  }

  /**
   * Links a CLEAN file to a student (POST /api/v1/students/:id/documents). Authorizes the actor on the STUDENT (not the
   * file): knowing a file UUID is never enough. The file must be AVAILABLE (scanned clean) and in-tenant. A duplicate
   * link (same file/entity/purpose) is refused by the unique constraint (no unauthorized relinking / replay).
   */
  async linkToStudent(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: LinkDocumentBody,
    options: { meta?: AuditRequestMeta },
  ): Promise<{ id: string }> {
    ensureTrusted(ctx);
    if (!isUuidV7(studentId)) throw invalid('Invalid student ID.');
    if (!input || typeof input !== 'object') throw invalid('Link payload is required.');
    if (!isUuidV7(input.fileId)) throw invalid('Invalid file ID.');
    if (!PURPOSE_RE.test(input.purpose)) throw invalid('Invalid link purpose.');
    const visibility: Visibility = input.visibility ?? 'OWNER_VISIBLE';
    if (!(VISIBILITIES as readonly string[]).includes(visibility))
      throw invalid('Invalid visibility.');
    const reason = parseReason(input.reason);
    const fileId = input.fileId.toLowerCase();

    // Authorization on the STUDENT resource (doc 03 §12.4). Held at all (403), then scope (404).
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');
    const student = await DocumentService.#resolveStudent(tx, ctx, studentId);
    await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
      organization_id: ctx.tenantId,
      student_id: student.id,
      user_id: student.userId,
    });

    const res = await tx.query<FileRow>(
      `SELECT ${FILE_COLS} FROM app.files WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, fileId],
    );
    const file = res.rows[0];
    if (!file) throw resourceNotFound();
    if (file.status !== 'AVAILABLE') {
      throw new AppError(409, 'CONFLICT', 'Only an available (scanned clean) file can be linked.');
    }

    const linkId = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.file_links (id, organization_id, file_id, entity_type, entity_id, purpose, visibility)
         VALUES ($1, $2, $3, 'student', $4, $5, $6)`,
        [linkId, ctx.tenantId, fileId, student.id, input.purpose, visibility],
      );
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === '23505') {
        throw new AppError(
          409,
          'CONFLICT',
          'This file is already linked to the student for this purpose.',
        );
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'file.link.create',
        resourceType: 'file_link',
        resourceId: linkId,
        subjectStudentId: student.id,
        riskTier: 2,
        reasonText: reason,
        changes: {
          fileId: { old: null, new: fileId },
          entityId: { old: null, new: student.id },
          purpose: { old: null, new: input.purpose },
          visibility: { old: null, new: visibility },
        },
      },
      options.meta ?? {},
    );
    return { id: linkId };
  }

  /**
   * Issues a short-lived presigned GET for a file. The file must be AVAILABLE and in-tenant (pending, scanning,
   * quarantined, rejected, deleted and other-tenant are all the same 404), and the actor must be authorized to read it
   * through at least one of its links (or be the uploader of an orphan file). A RESTRICTED file additionally requires
   * document.read_restricted and writes a `file.read` audit event (doc 03 §12.4).
   */
  async downloadUrl(
    tx: TenantTx,
    ctx: TrustedContext,
    fileId: string,
    options: { meta?: AuditRequestMeta },
  ): Promise<{ url: string; expiresAt: string }> {
    ensureTrusted(ctx);
    if (!isUuidV7(fileId)) throw invalid('Invalid file ID.');
    await AuthorizationEngine.assert(tx, ctx, 'document.read');

    const res = await tx.query<FileRow>(
      `SELECT ${FILE_COLS} FROM app.files WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, fileId],
    );
    const file = res.rows[0];
    // A non-AVAILABLE file is never downloadable, and its existence is not revealed.
    if (!file || file.status !== 'AVAILABLE') throw resourceNotFound();

    const restricted = file.classification === 'RESTRICTED';
    const authorized = await this.#mayRead(tx, ctx, file, restricted);
    if (!authorized) throw resourceNotFound();

    // Fix the response content type to the DETECTED (verified) type, never the client-declared one, and force an
    // attachment download: no inline rendering, no MIME confusion. AVAILABLE guarantees detected_mime is present.
    const contentType = file.detected_mime ?? 'application/octet-stream';
    const link = await this.#storage.presignDownload({
      storageClass: file.storage_class,
      key: file.storage_key,
      ttlSeconds: DEFAULT_DOWNLOAD_TTL_SECONDS,
      contentType,
      downloadFilename: file.original_name,
    });

    if (restricted) {
      await recordAudit(
        tx,
        ctx,
        {
          action: 'file.read',
          resourceType: 'file',
          resourceId: file.id,
          riskTier: 2,
          reasonText: 'Restricted document download',
          metadata: { storageDriver: this.#storage.kind },
        },
        options.meta ?? {},
      );
    }
    return { url: link.url, expiresAt: link.expiresAt };
  }

  /** Link-derived read authorization (doc 03 §12.4). The uploader always reads their own file. */
  async #mayRead(
    tx: TenantTx,
    ctx: TrustedContext,
    file: FileRow,
    restricted: boolean,
  ): Promise<boolean> {
    // A RESTRICTED file requires the read_restricted capability, whichever path authorizes.
    if (restricted && !(await DocumentService.#allows(tx, ctx, 'document.read_restricted'))) {
      return false;
    }
    const readPermission = restricted ? 'document.read_restricted' : 'document.read';

    // Uploader of an (orphan or own) file: always allowed to read it back.
    if (file.uploaded_by === ctx.userId) return true;

    const links = await tx.query<{
      entity_type: string;
      entity_id: string;
      visibility: Visibility;
    }>(
      'SELECT entity_type, entity_id, visibility FROM app.file_links WHERE organization_id = $1 AND file_id = $2',
      [ctx.tenantId, file.id],
    );
    for (const link of links.rows) {
      if (link.entity_type !== 'student') continue; // only student links exist in this slice
      const student = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM app.students WHERE organization_id = $1 AND id = $2',
        [ctx.tenantId, link.entity_id],
      );
      const owner = student.rows[0];
      if (!owner) continue;
      const isOwner = owner.user_id === ctx.userId;
      // STAFF_ONLY links are never satisfied by the student owner's own SELF grant.
      if (link.visibility === 'STAFF_ONLY' && isOwner) continue;
      if (
        await DocumentService.#allows(tx, ctx, readPermission, {
          organization_id: ctx.tenantId,
          student_id: link.entity_id,
          user_id: owner.user_id,
        })
      ) {
        return true;
      }
    }
    return false;
  }
}
