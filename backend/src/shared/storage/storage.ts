import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { isUuidV7 } from '../ids/uuidv7.js';

/**
 * Storage abstraction for the documents kernel (ADR-010, docs/architecture/v3/03 Part 12).
 *
 * The object store holds bytes only; all metadata lives in app.files / app.file_links. A driver knows how to presign a
 * direct upload, presign a short-lived download, and read back an object's size/checksum for completion verification.
 * It knows NOTHING about tenants, permissions or the lifecycle: key derivation, validation, TTL bounds and the scan
 * lifecycle are enforced by the pure functions here and by the document service, never by the driver.
 */

export const STORAGE_CLASSES = ['GENERAL', 'SENSITIVE', 'GENERATED'] as const;
export type StorageClass = (typeof STORAGE_CLASSES)[number];

export function isStorageClass(value: unknown): value is StorageClass {
  return typeof value === 'string' && (STORAGE_CLASSES as readonly string[]).includes(value);
}

/**
 * Presigned-URL time-to-live bounds (doc 03 §12.4: "default 60-300 s; max 15 min"). A requested TTL is clamped into
 * [MIN, MAX]; a short-lived URL is a security control, never client-controllable without bound.
 */
export const MIN_URL_TTL_SECONDS = 30;
export const MAX_URL_TTL_SECONDS = 900; // 15 minutes, the hard ceiling
export const DEFAULT_UPLOAD_TTL_SECONDS = 300;
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 120;

export function clampTtlSeconds(requested: number | undefined, fallback: number): number {
  const n = requested ?? fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_URL_TTL_SECONDS, Math.max(MIN_URL_TTL_SECONDS, Math.trunc(n)));
}

/** Per-class upload size ceiling (bytes). The database CHECK caps at 100 MiB; the service caps tighter per class. */
const MAX_BYTES_BY_CLASS: Record<StorageClass, number> = {
  GENERAL: 10 * 1024 * 1024,
  SENSITIVE: 20 * 1024 * 1024,
  GENERATED: 20 * 1024 * 1024,
};
export function maxBytesForClass(storageClass: StorageClass): number {
  return MAX_BYTES_BY_CLASS[storageClass];
}

export class StorageKeyError extends Error {}

/**
 * Derives the opaque object key `{organization_id}/{storage_class}/{yyyy}/{file_id}` (doc 03 §12.2): a tenant-scoped
 * namespace with NO filename, student name, admission number or other PII. Both ids MUST be validated UUIDv7 values the
 * server produced — never a client-supplied key or path. Throws on anything else, so a malformed id can never reach the
 * store as a path segment (no traversal, no cross-tenant prefix).
 */
export function deriveStorageKey(
  organizationId: string,
  storageClass: StorageClass,
  fileId: string,
  year: number,
): string {
  if (!isUuidV7(organizationId)) throw new StorageKeyError('organizationId must be a UUIDv7');
  if (!isUuidV7(fileId)) throw new StorageKeyError('fileId must be a UUIDv7');
  if (!isStorageClass(storageClass)) throw new StorageKeyError('invalid storage class');
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new StorageKeyError('year out of range');
  }
  return `${organizationId.toLowerCase()}/${storageClass}/${year}/${fileId.toLowerCase()}`;
}

/**
 * The content types a document may declare, and the magic-byte signature each real object must begin with. Kept small
 * and explicit: an allowlist, never a denylist. A declared type outside this set is refused; a detected type that does
 * not match the declared type is a MIME-confusion attempt and is refused at completion.
 */
const CONTENT_TYPE_SIGNATURES: Record<string, readonly number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};
export const ALLOWED_CONTENT_TYPES: readonly string[] = Object.keys(CONTENT_TYPE_SIGNATURES);

export function isAllowedContentType(value: unknown): value is string {
  return typeof value === 'string' && value in CONTENT_TYPE_SIGNATURES;
}

/** Magic-byte sniff. Returns the detected content type, or null when the bytes match no allowlisted signature. */
export function sniffContentType(bytes: Uint8Array): string | null {
  for (const [type, signatures] of Object.entries(CONTENT_TYPE_SIGNATURES)) {
    for (const sig of signatures) {
      if (bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b)) return type;
    }
  }
  return null;
}

export class FileNameError extends Error {}

/**
 * Normalises an original filename for safe storage and `Content-Disposition`: strips any directory component (defeats
 * path traversal and absolute paths), rejects control characters, trims, and bounds the length to 255. The returned
 * name is metadata only; it is NEVER part of the object key.
 */
export function normalizeFileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FileNameError('filename must be a string');
  // Drop everything up to the last path separator (both kinds), then reject residual control characters.
  const base = raw.replace(/^.*[\\/]/, '').trim();
  if (base.length === 0 || base === '.' || base === '..')
    throw new FileNameError('invalid filename');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(base))
    throw new FileNameError('filename has control characters');
  if (base.length > 255) throw new FileNameError('filename is too long');
  return base;
}

/** A value safe to place in an HTTP header (no CR/LF/control, no quote): used for Content-Disposition filename. */
export function headerSafeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f"\\]/g, '_');
}

export interface PresignUploadInput {
  storageClass: StorageClass;
  key: string;
  contentType: string;
  maxBytes: number;
  ttlSeconds: number;
}
export interface PresignDownloadInput {
  storageClass: StorageClass;
  key: string;
  ttlSeconds: number;
  contentType: string;
  downloadFilename: string;
}
export interface HeadInput {
  storageClass: StorageClass;
  key: string;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client MUST send with the PUT so the signature matches (e.g. Content-Type). */
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}
export interface PresignedDownload {
  url: string;
  expiresAt: string;
}
/** What the store reports about an object at completion time. `sha256`/`contentType` may be null when the backend
 *  does not expose them (e.g. S3 without additional checksums); the service treats a null as "unverifiable". */
export interface StoredObject {
  exists: boolean;
  sizeBytes: number;
  sha256: string | null;
  contentType: string | null;
}

export class StorageObjectNotFoundError extends Error {}
export class StorageReadLimitExceededError extends Error {}
export class StorageDriverError extends Error {}

export interface ReadStreamInput {
  storageClass: StorageClass;
  key: string;
}

export interface StorageReadStream {
  stream: NodeJS.ReadableStream;
  contentLength?: number | undefined;
  contentType?: string | null | undefined;
}

/**
 * Creates a metering transform stream that enforces maxBytes while streaming.
 * Destroys the stream with StorageReadLimitExceededError if byte count exceeds maxBytes.
 */
export function createSizeLimitingStream(maxBytes: number): Transform {
  let bytesCount = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesCount += chunk.length;
      if (bytesCount > maxBytes) {
        callback(
          new StorageReadLimitExceededError(
            `Stream exceeded maximum size limit of ${maxBytes} bytes`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

export interface StorageDriver {
  /** A short identifier for logs/audit metadata ("memory", "s3"); never a secret. */
  readonly kind: string;
  presignUpload(input: PresignUploadInput): Promise<PresignedUpload>;
  presignDownload(input: PresignDownloadInput): Promise<PresignedDownload>;
  head(input: HeadInput): Promise<StoredObject>;
  openReadStream(input: ReadStreamInput): Promise<StorageReadStream>;
}

/**
 * Deterministic in-memory driver for tests and local development. Holds bytes in a Map keyed by `class/key`. It never
 * reaches the network, so test and development behaviour is completely separate from the production S3 path (the
 * factory never returns this driver in production). `putObject` simulates the client's direct PUT, enforcing the same
 * size/content-type conditions a presigned PUT would, and records the detected (sniffed) content type for completion.
 */
export class MemoryStorageDriver implements StorageDriver {
  readonly kind = 'memory';
  readonly #objects = new Map<string, { bytes: Uint8Array; sha256: string; contentType: string }>();
  readonly #uploads = new Map<
    string,
    { contentType: string; maxBytes: number; expiresAtMs: number }
  >();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #id(storageClass: StorageClass, key: string): string {
    return `${storageClass}/${key}`;
  }

  presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const id = this.#id(input.storageClass, input.key);
    const expiresAtMs = this.#now() + input.ttlSeconds * 1000;
    this.#uploads.set(id, {
      contentType: input.contentType,
      maxBytes: input.maxBytes,
      expiresAtMs,
    });
    return Promise.resolve({
      url: `memory://upload/${id}`,
      method: 'PUT',
      requiredHeaders: { 'Content-Type': input.contentType },
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  /** Test/dev helper: simulate the client PUT against a presigned upload. Throws like S3 would on a mismatch. */
  putObject(storageClass: StorageClass, key: string, bytes: Uint8Array, contentType: string): void {
    const id = this.#id(storageClass, key);
    const grant = this.#uploads.get(id);
    if (!grant) throw new Error('no presigned upload for this key');
    if (this.#now() > grant.expiresAtMs) throw new Error('presigned upload expired');
    if (contentType !== grant.contentType)
      throw new Error('content-type does not match the presigned PUT');
    if (bytes.length > grant.maxBytes) throw new Error('object exceeds the presigned size limit');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.#objects.set(id, { bytes: Uint8Array.from(bytes), sha256, contentType });
  }

  presignDownload(input: PresignDownloadInput): Promise<PresignedDownload> {
    const expiresAtMs = this.#now() + input.ttlSeconds * 1000;
    const id = this.#id(input.storageClass, input.key);
    const q = new URLSearchParams({
      'response-content-type': input.contentType,
      'response-content-disposition': `attachment; filename="${headerSafeFileName(input.downloadFilename)}"`,
    });
    return Promise.resolve({
      url: `memory://download/${id}?${q.toString()}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }

  head(input: HeadInput): Promise<StoredObject> {
    const obj = this.#objects.get(this.#id(input.storageClass, input.key));
    if (!obj)
      return Promise.resolve({ exists: false, sizeBytes: 0, sha256: null, contentType: null });
    return Promise.resolve({
      exists: true,
      sizeBytes: obj.bytes.length,
      sha256: obj.sha256,
      contentType: sniffContentType(obj.bytes) ?? obj.contentType,
    });
  }

  openReadStream(input: ReadStreamInput): Promise<StorageReadStream> {
    const id = this.#id(input.storageClass, input.key);
    const obj = this.#objects.get(id);
    if (!obj) {
      return Promise.reject(new StorageObjectNotFoundError(`Object not found: ${input.key}`));
    }
    const maxBytes = maxBytesForClass(input.storageClass);
    if (obj.bytes.length > maxBytes) {
      return Promise.reject(
        new StorageReadLimitExceededError(
          `Object size ${obj.bytes.length} exceeds limit ${maxBytes}`,
        ),
      );
    }
    const baseStream = Readable.from([Buffer.from(obj.bytes)]);
    const limitedStream = baseStream.pipe(createSizeLimitingStream(maxBytes));
    return Promise.resolve({
      stream: limitedStream,
      contentLength: obj.bytes.length,
      contentType: obj.contentType,
    });
  }
}
