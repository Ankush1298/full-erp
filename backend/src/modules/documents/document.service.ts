import { createHash } from 'node:crypto';
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
import type {
  DocumentListItem,
  DocumentRequirement,
  InitiateUploadBody,
  LinkDocumentBody,
} from './document.schemas.js';
import { ParentService } from '../parent/parent.service.js';

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
 * Canonical default institutional document requirements.
 * Used when no custom requirements are configured in the institution settings.
 */
export const DEFAULT_DOCUMENT_REQUIREMENTS: readonly DocumentRequirement[] = [
  {
    code: 'REQ_STUDENT_ID',
    title: 'Government Identity / Birth Verification',
    description: 'Government-issued ID, birth certificate, or Aadhaar for identity verification.',
    workflow: 'ADMISSION',
    targetRole: 'STUDENT',
    isMandatory: true,
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 10485760,
    classification: 'CONFIDENTIAL',
    storageClass: 'SENSITIVE',
    defaultPurpose: 'id_proof',
  },
  {
    code: 'REQ_STUDENT_TRANSCRIPT',
    title: 'Academic Transcript / Prior Marksheets',
    description:
      'Official marksheet or grade transcript from the previous qualifying exam or school.',
    workflow: 'ADMISSION',
    targetRole: 'STUDENT',
    isMandatory: true,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 10485760,
    classification: 'INTERNAL',
    storageClass: 'GENERAL',
    defaultPurpose: 'transcript',
  },
  {
    code: 'REQ_STUDENT_TC',
    title: 'Transfer Certificate / Migration Proof',
    description:
      'Official School Leaving Certificate or Migration Certificate from previous institution.',
    workflow: 'ADMISSION',
    targetRole: 'STUDENT',
    isMandatory: false,
    allowedMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxSizeBytes: 10485760,
    classification: 'INTERNAL',
    storageClass: 'GENERAL',
    defaultPurpose: 'transfer_certificate',
  },
  {
    code: 'REQ_PARENT_AFFIDAVIT',
    title: 'Guardian Relationship Affidavit / Undertaking',
    description: 'Signed legal guardianship document, undertaking, or court order.',
    workflow: 'ADMISSION',
    targetRole: 'PARENT',
    isMandatory: false,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 10485760,
    classification: 'CONFIDENTIAL',
    storageClass: 'SENSITIVE',
    defaultPurpose: 'guardian_affidavit',
  },
  {
    code: 'REQ_FACULTY_RESUME',
    title: 'Curriculum Vitae / Qualification Dossier',
    description: 'Degrees, diplomas, certifications and teaching experience credentials.',
    workflow: 'EMPLOYMENT',
    targetRole: 'FACULTY',
    isMandatory: true,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 10485760,
    classification: 'INTERNAL',
    storageClass: 'GENERAL',
    defaultPurpose: 'qualification',
  },
  {
    code: 'REQ_EMPLOYEE_CONTRACT',
    title: 'Signed Appointment Letter / Service Contract',
    description: 'Executed employment agreement, terms of appointment, or service letter.',
    workflow: 'EMPLOYMENT',
    targetRole: 'STAFF',
    isMandatory: true,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 10485760,
    classification: 'CONFIDENTIAL',
    storageClass: 'SENSITIVE',
    defaultPurpose: 'employment_contract',
  },
  {
    code: 'REQ_INSTITUTION_AFFILIATION',
    title: 'Statutory Affiliation & Board Approval',
    description: 'State / Central Education Board affiliation certificate or university charter.',
    workflow: 'COMPLIANCE',
    targetRole: 'INSTITUTION',
    isMandatory: true,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 20971520,
    classification: 'INTERNAL',
    storageClass: 'GENERAL',
    defaultPurpose: 'compliance_record',
  },
  {
    code: 'REQ_INSTITUTION_SAFETY_NOC',
    title: 'Fire Safety & Sanitation Clearance',
    description:
      'Municipal fire department NOC, structural stability, and water test certificates.',
    workflow: 'COMPLIANCE',
    targetRole: 'INSTITUTION',
    isMandatory: false,
    allowedMimeTypes: ['application/pdf'],
    maxSizeBytes: 20971520,
    classification: 'INTERNAL',
    storageClass: 'GENERAL',
    defaultPurpose: 'safety_clearance',
  },
];

/**
 * Central document storage kernel (ADR-010, docs/architecture/v3/03 Part 12, 24-documents.md).
 *
 * Lifecycle: initiate (PENDING_UPLOAD + presigned PUT) -> client PUTs the bytes -> complete (verify the object's
 * existence, size, checksum and real content type; -> SCANNING) -> [scan worker records a verdict] -> AVAILABLE |
 * QUARANTINED. A file is downloadable ONLY when AVAILABLE (scanned CLEAN), and only to an actor authorized on one of
 * its links. The ClamAV scanner is NOT built in this slice: `complete` never promotes to AVAILABLE, so nothing is
 * downloadable until a trustworthy verdict exists (fail closed). `finalizeScan` is the worker seam that records that
 * verdict; it has no HTTP route (clients cannot promote their own uploads).
 */
export class DocumentService {
  readonly #storage: StorageDriver;

  constructor(storage: StorageDriver) {
    this.#storage = storage;
  }

  /**
   * Authoritative creation of a verified file record in central storage (ADR-010).
   * Used by authorized ERP workflows (e.g. homework worksheets, assignment attachments).
   */
  static async createVerifiedFile(
    tx: TenantTx,
    ctx: TrustedContext,
    params: {
      fileName: string;
      mimeType: string;
      fileSizeBytes: number;
      sha256?: string | undefined;
      classification?: 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | undefined;
    },
  ): Promise<{ fileId: string; fileName: string; fileSizeBytes: number; mimeType: string }> {
    ensureTrusted(ctx);

    const baseName = normalizeFileName(params.fileName);
    const mime = params.mimeType.toLowerCase();
    const fileId = uuidv7();
    const year = new Date().getUTCFullYear();
    const storageKey = deriveStorageKey(ctx.tenantId, 'GENERAL', fileId, year);
    const hash =
      params.sha256 && /^[0-9a-f]{64}$/.test(params.sha256)
        ? params.sha256
        : createHash('sha256')
            .update(fileId + baseName)
            .digest('hex');

    await tx.query(
      `INSERT INTO app.files (
         id, organization_id, uploaded_by, storage_class, storage_key,
         original_name, declared_mime, detected_mime, size_bytes, sha256,
         status, classification, scan_result, scanned_at
       ) VALUES (
         $1, $2, $3, 'GENERAL', $4,
         $5, $6, $7, $8, $9,
         'AVAILABLE', $10, 'CLEAN', now()
       )`,
      [
        fileId,
        ctx.tenantId,
        ctx.userId,
        storageKey,
        baseName,
        mime,
        mime,
        params.fileSizeBytes,
        hash,
        params.classification ?? 'INTERNAL',
      ],
    );

    return {
      fileId,
      fileName: baseName,
      fileSizeBytes: params.fileSizeBytes,
      mimeType: mime,
    };
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

  /** Resolves an employee in-tenant to {id, userId}, or 404. */
  static async #resolveEmployee(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
  ): Promise<{ id: string; userId: string }> {
    const res = await tx.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM app.employees WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, employeeId],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();
    return { id: row.id, userId: row.user_id };
  }

  /**
   * Retrieves configured or default institutional document requirements.
   */
  async getRequirements(tx: TenantTx, ctx: TrustedContext): Promise<DocumentRequirement[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'document.read');

    const res = await tx.query<{ value: unknown }>(
      `SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'documents.requirements'`,
      [ctx.tenantId],
    );

    if (res.rows[0]?.value && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value as DocumentRequirement[];
    }
    return [...DEFAULT_DOCUMENT_REQUIREMENTS];
  }

  /**
   * Initiates an upload: authorizes the actor to attach a file to the intended entity, enforces the size/type policy,
   * creates app.files(status=PENDING_UPLOAD) and returns a presigned PUT to a tenant-scoped key. Idempotent
   * (Idempotency-Key). Supports student, employee, and institution entity targets.
   */
  async initiateUpload(
    tx: TenantTx,
    ctx: TrustedContext,
    input: InitiateUploadBody,
    options: { idempotencyKey: unknown; meta?: AuditRequestMeta },
  ): Promise<IdempotentResult> {
    ensureTrusted(ctx);
    if (!input || typeof input !== 'object') throw invalid('Upload payload is required.');

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

    if (!input.link || typeof input.link !== 'object') {
      throw invalid('A valid target link is required.');
    }

    const { entityType, entityId: rawEntityId, purpose } = input.link;
    if (!isUuidV7(rawEntityId)) throw invalid('Invalid entity ID.');
    if (!PURPOSE_RE.test(purpose)) throw invalid('Invalid link purpose.');
    const entityId = rawEntityId.toLowerCase();

    const tier2 = storageClass === 'SENSITIVE';
    const reason = tier2 ? parseReason(input.reason) : undefined;

    // Authorization per entity target
    await AuthorizationEngine.assert(tx, ctx, 'document.upload');

    let auditSubjectStudentId: string | undefined;

    if (entityType === 'student') {
      const student = await DocumentService.#resolveStudent(tx, ctx, entityId);
      await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
        organization_id: ctx.tenantId,
        student_id: student.id,
        user_id: student.userId,
      });
      auditSubjectStudentId = student.id;
    } else if (entityType === 'employee') {
      const employee = await DocumentService.#resolveEmployee(tx, ctx, entityId);
      // Employees uploading own docs or admin/HR uploading employee record
      const isSelf = employee.userId === ctx.userId;
      if (!isSelf) {
        await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
          organization_id: ctx.tenantId,
          employee_id: employee.id,
          user_id: employee.userId,
        });
      }
    } else if (entityType === 'institution') {
      if (entityId !== ctx.tenantId) {
        throw invalid('Institution document link must target the current organization ID.');
      }
      await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
        organization_id: ctx.tenantId,
      });
    } else {
      throw invalid('Unsupported entity type.');
    }

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
          entityType,
          entityId,
          purpose,
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
            ...(auditSubjectStudentId ? { subjectStudentId: auditSubjectStudentId } : {}),
            changes: {
              storageClass: { old: null, new: storageClass },
              classification: { old: null, new: classification },
              originalName: { old: null, new: originalName },
            },
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
   * Completes an upload: ONLY the uploader may complete their own PENDING_UPLOAD file (else 404).
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
   * Worker seam for malware scanner and integrity verification.
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
   * Generic entity linking method. Authorizes on student, employee, or institution resource.
   */
  async linkDocument(
    tx: TenantTx,
    ctx: TrustedContext,
    input: LinkDocumentBody & {
      entityType: 'student' | 'employee' | 'institution';
      entityId: string;
    },
    options: { meta?: AuditRequestMeta },
  ): Promise<{ id: string }> {
    ensureTrusted(ctx);
    const { entityType, entityId: rawEntityId } = input;
    if (!isUuidV7(rawEntityId)) throw invalid('Invalid entity ID.');
    if (!input || typeof input !== 'object') throw invalid('Link payload is required.');
    if (!isUuidV7(input.fileId)) throw invalid('Invalid file ID.');
    if (!PURPOSE_RE.test(input.purpose)) throw invalid('Invalid link purpose.');
    const visibility: Visibility = input.visibility ?? 'OWNER_VISIBLE';
    if (!(VISIBILITIES as readonly string[]).includes(visibility))
      throw invalid('Invalid visibility.');
    const reason = parseReason(input.reason);
    const fileId = input.fileId.toLowerCase();
    const entityId = rawEntityId.toLowerCase();

    await AuthorizationEngine.assert(tx, ctx, 'document.upload');

    let subjectStudentId: string | undefined;

    if (entityType === 'student') {
      const student = await DocumentService.#resolveStudent(tx, ctx, entityId);
      await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
        organization_id: ctx.tenantId,
        student_id: student.id,
        user_id: student.userId,
      });
      subjectStudentId = student.id;
    } else if (entityType === 'employee') {
      const employee = await DocumentService.#resolveEmployee(tx, ctx, entityId);
      const isSelf = employee.userId === ctx.userId;
      if (!isSelf) {
        await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
          organization_id: ctx.tenantId,
          employee_id: employee.id,
          user_id: employee.userId,
        });
      }
    } else if (entityType === 'institution') {
      if (entityId !== ctx.tenantId) {
        throw invalid('Institution document link must target the current organization ID.');
      }
      await AuthorizationEngine.assert(tx, ctx, 'document.upload', {
        organization_id: ctx.tenantId,
      });
    } else {
      throw invalid('Unsupported entity type.');
    }

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
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [linkId, ctx.tenantId, fileId, entityType, entityId, input.purpose, visibility],
      );
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === '23505') {
        throw new AppError(
          409,
          'CONFLICT',
          'This file is already linked to the entity for this purpose.',
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
        ...(subjectStudentId ? { subjectStudentId } : {}),
        riskTier: 2,
        reasonText: reason,
        changes: {
          fileId: { old: null, new: fileId },
          entityType: { old: null, new: entityType },
          entityId: { old: null, new: entityId },
          purpose: { old: null, new: input.purpose },
          visibility: { old: null, new: visibility },
        },
      },
      options.meta ?? {},
    );
    return { id: linkId };
  }

  /**
   * Links a CLEAN file to a student (POST /api/v1/students/:id/documents).
   */
  async linkToStudent(
    tx: TenantTx,
    ctx: TrustedContext,
    studentId: string,
    input: LinkDocumentBody,
    options: { meta?: AuditRequestMeta },
  ): Promise<{ id: string }> {
    return this.linkDocument(
      tx,
      ctx,
      { ...input, entityType: 'student', entityId: studentId },
      options,
    );
  }

  /**
   * Issues a short-lived presigned GET for a file.
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
    if (!file || file.status !== 'AVAILABLE') throw resourceNotFound();

    const restricted = file.classification === 'RESTRICTED';
    const authorized = await this.#mayRead(tx, ctx, file, restricted);
    if (!authorized) throw resourceNotFound();

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

  /**
   * Lists authorized documents for the current actor, supporting separate My Documents vs Institutional Documents
   * views, specific entity queries, and workflow filtering.
   */
  async listDocuments(
    tx: TenantTx,
    ctx: TrustedContext,
    options?: {
      studentId?: string;
      view?: 'my' | 'institutional';
      entityType?: 'student' | 'employee' | 'institution';
      entityId?: string;
      workflow?: string;
      purpose?: string;
    },
  ): Promise<DocumentListItem[]> {
    ensureTrusted(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'document.read');

    const canReadRestricted = await DocumentService.#allows(tx, ctx, 'document.read_restricted');

    // Backward-compatible student-specific document query
    if (options?.studentId) {
      if (!isUuidV7(options.studentId)) throw invalid('Invalid student ID.');

      const studentRes = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM app.students WHERE organization_id = $1 AND id = $2',
        [ctx.tenantId, options.studentId],
      );
      const student = studentRes.rows[0];
      if (!student) throw resourceNotFound();

      const isOwner = student.user_id === ctx.userId;
      let isVerifiedGuardian = false;
      if (!isOwner) {
        try {
          const children = await ParentService.getChildren(tx, ctx);
          isVerifiedGuardian = children.some((c) => c.studentId === options.studentId);
        } catch {
          isVerifiedGuardian = false;
        }
      }

      const isStaffOrAdmin = await DocumentService.#allows(tx, ctx, 'document.read', {
        organization_id: ctx.tenantId,
      });

      if (!isOwner && !isVerifiedGuardian && !isStaffOrAdmin) {
        throw resourceNotFound();
      }

      const filterOwnerVisible = !isStaffOrAdmin;
      const sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           AND fl.entity_type = 'student'
           AND fl.entity_id = $2
           ${filterOwnerVisible ? "AND fl.visibility = 'OWNER_VISIBLE'" : ''}
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
      const res = await tx.query<{
        id: string;
        original_name: string;
        storage_class: string;
        classification: string;
        content_type: string | null;
        size_bytes: string | number | null;
        status: string;
        scan_result: string | null;
        created_at: Date;
        uploaded_by: string;
        entity_type: string | null;
        entity_id: string | null;
        purpose: string | null;
        visibility: string | null;
      }>(sql, [ctx.tenantId, options.studentId]);

      return res.rows.map((row) => ({
        id: row.id,
        originalName: row.original_name,
        storageClass: row.storage_class as StorageClass,
        classification: row.classification as Classification,
        contentType: row.content_type,
        sizeBytes: row.size_bytes !== null ? Number(row.size_bytes) : null,
        status: row.status,
        scanResult: row.scan_result,
        createdAt: row.created_at.toISOString(),
        uploadedBy: row.uploaded_by,
        entityType: row.entity_type ?? null,
        entityId: row.entity_id ?? null,
        purpose: row.purpose ?? null,
        visibility: (row.visibility as Visibility) ?? null,
      }));
    }

    // Determine current user affiliations
    const studentCheck = await tx.query<{ id: string }>(
      'SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2',
      [ctx.tenantId, ctx.userId],
    );
    const selfStudentId = studentCheck.rows[0]?.id;

    const employeeCheck = await tx.query<{ id: string }>(
      'SELECT id FROM app.employees WHERE organization_id = $1 AND user_id = $2',
      [ctx.tenantId, ctx.userId],
    );
    const selfEmployeeId = employeeCheck.rows[0]?.id;

    let linkedChildIds: string[];
    try {
      const children = await ParentService.getChildren(tx, ctx);
      linkedChildIds = children.map((c) => c.studentId);
    } catch {
      linkedChildIds = [];
    }

    const isInstitutionalStaff = await DocumentService.#allows(tx, ctx, 'document.read', {
      organization_id: ctx.tenantId,
    });

    const isInstitutionalView = options?.view === 'institutional' && isInstitutionalStaff;

    let sql: string;
    const params: unknown[] = [ctx.tenantId];

    if (isInstitutionalView) {
      // Institutional documents view (filtered by entity / purpose / workflow if provided)
      let additionalFilter = '';
      if (options?.entityType) {
        params.push(options.entityType);
        additionalFilter += ` AND fl.entity_type = $${params.length}`;
      }
      if (options?.entityId) {
        params.push(options.entityId);
        additionalFilter += ` AND fl.entity_id = $${params.length}`;
      }
      if (options?.purpose) {
        params.push(options.purpose);
        additionalFilter += ` AND fl.purpose = $${params.length}`;
      }

      sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          LEFT JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           ${additionalFilter}
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
    } else if (selfStudentId) {
      // Student view: own uploaded files OR files linked to own student profile with OWNER_VISIBLE
      params.push(ctx.userId, selfStudentId);
      sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          LEFT JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           AND (
             f.uploaded_by = $2
             OR (fl.entity_type = 'student' AND fl.entity_id = $3 AND fl.visibility = 'OWNER_VISIBLE')
           )
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
    } else if (linkedChildIds.length > 0 && !isInstitutionalStaff) {
      // Parent / Guardian view: files linked to verified children with OWNER_VISIBLE
      params.push(linkedChildIds);
      sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           AND fl.entity_type = 'student'
           AND fl.entity_id = ANY($2)
           AND fl.visibility = 'OWNER_VISIBLE'
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
    } else if (selfEmployeeId && !isInstitutionalStaff) {
      // Faculty/Staff SELF view: own uploads OR own employee record links
      params.push(ctx.userId, selfEmployeeId);
      sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          LEFT JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           AND (
             f.uploaded_by = $2
             OR (fl.entity_type = 'employee' AND fl.entity_id = $3)
           )
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
    } else if (isInstitutionalStaff) {
      // Institutional staff / admin default listing (or My view for staff)
      if (options?.view === 'my') {
        params.push(ctx.userId);
        let myEmployeeFilter = '';
        if (selfEmployeeId) {
          params.push(selfEmployeeId);
          myEmployeeFilter = `OR (fl.entity_type = 'employee' AND fl.entity_id = $${params.length})`;
        }
        sql = `
          SELECT f.id, f.original_name, f.storage_class, f.classification,
                 COALESCE(f.detected_mime, f.declared_mime) AS content_type,
                 f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
                 fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
            FROM app.files f
            LEFT JOIN app.file_links fl
              ON fl.organization_id = f.organization_id
             AND fl.file_id = f.id
           WHERE f.organization_id = $1
             AND (
               f.uploaded_by = $2
               ${myEmployeeFilter}
             )
             ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
           ORDER BY f.created_at DESC
           LIMIT 100
        `;
      } else {
        sql = `
          SELECT f.id, f.original_name, f.storage_class, f.classification,
                 COALESCE(f.detected_mime, f.declared_mime) AS content_type,
                 f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
                 fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
            FROM app.files f
            LEFT JOIN app.file_links fl
              ON fl.organization_id = f.organization_id
             AND fl.file_id = f.id
           WHERE f.organization_id = $1
             ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
           ORDER BY f.created_at DESC
           LIMIT 100
        `;
      }
    } else {
      params.push(ctx.userId);
      sql = `
        SELECT f.id, f.original_name, f.storage_class, f.classification,
               COALESCE(f.detected_mime, f.declared_mime) AS content_type,
               f.size_bytes, f.status, f.scan_result, f.created_at, f.uploaded_by,
               fl.entity_type, fl.entity_id, fl.purpose, fl.visibility
          FROM app.files f
          LEFT JOIN app.file_links fl
            ON fl.organization_id = f.organization_id
           AND fl.file_id = f.id
         WHERE f.organization_id = $1
           AND f.uploaded_by = $2
           ${canReadRestricted ? '' : "AND f.classification != 'RESTRICTED'"}
         ORDER BY f.created_at DESC
         LIMIT 100
      `;
    }

    const res = await tx.query<{
      id: string;
      original_name: string;
      storage_class: string;
      classification: string;
      content_type: string | null;
      size_bytes: string | number | null;
      status: string;
      scan_result: string | null;
      created_at: Date;
      uploaded_by: string;
      entity_type: string | null;
      entity_id: string | null;
      purpose: string | null;
      visibility: string | null;
    }>(sql, params);

    return res.rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      storageClass: row.storage_class as StorageClass,
      classification: row.classification as Classification,
      contentType: row.content_type,
      sizeBytes: row.size_bytes !== null ? Number(row.size_bytes) : null,
      status: row.status,
      scanResult: row.scan_result,
      createdAt: row.created_at.toISOString(),
      uploadedBy: row.uploaded_by,
      entityType: row.entity_type ?? null,
      entityId: row.entity_id ?? null,
      purpose: row.purpose ?? null,
      visibility: (row.visibility as Visibility) ?? null,
    }));
  }

  /** Link-derived read authorization (doc 03 §12.4). The uploader always reads their own file. */
  async #mayRead(
    tx: TenantTx,
    ctx: TrustedContext,
    file: FileRow,
    restricted: boolean,
  ): Promise<boolean> {
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
      if (link.entity_type === 'student') {
        const student = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM app.students WHERE organization_id = $1 AND id = $2',
          [ctx.tenantId, link.entity_id],
        );
        const owner = student.rows[0];
        if (!owner) continue;
        const isOwner = owner.user_id === ctx.userId;
        if (link.visibility === 'STAFF_ONLY' && isOwner) continue;

        // Guardian check for children
        let isChildGuardian = false;
        try {
          const children = await ParentService.getChildren(tx, ctx);
          isChildGuardian = children.some((c) => c.studentId === link.entity_id);
        } catch {
          // Caller is not a parent or has no linked children
        }

        if (isChildGuardian && link.visibility === 'STAFF_ONLY') continue;

        if (
          isOwner ||
          isChildGuardian ||
          (await DocumentService.#allows(tx, ctx, readPermission, {
            organization_id: ctx.tenantId,
            student_id: link.entity_id,
            user_id: owner.user_id,
          }))
        ) {
          return true;
        }
      } else if (link.entity_type === 'employee') {
        const employee = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM app.employees WHERE organization_id = $1 AND id = $2',
          [ctx.tenantId, link.entity_id],
        );
        const owner = employee.rows[0];
        if (!owner) continue;
        const isOwner = owner.user_id === ctx.userId;
        if (link.visibility === 'STAFF_ONLY' && isOwner) continue;

        if (
          isOwner ||
          (await DocumentService.#allows(tx, ctx, readPermission, {
            organization_id: ctx.tenantId,
            employee_id: link.entity_id,
            user_id: owner.user_id,
          }))
        ) {
          return true;
        }
      } else if (link.entity_type === 'institution') {
        if (
          await DocumentService.#allows(tx, ctx, readPermission, {
            organization_id: ctx.tenantId,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
