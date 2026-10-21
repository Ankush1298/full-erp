import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Database, TenantTx } from '../../shared/database/index.js';
import type { StorageDriver } from '../../shared/storage/index.js';
import {
  StorageObjectNotFoundError,
  StorageReadLimitExceededError,
  maxBytesForClass,
} from '../../shared/storage/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type { DocumentService, ScannableFile } from './document.service.js';
import type { MalwareScanner } from './scanner.js';

export interface DocumentScanWorkerOptions {
  readonly db: Database;
  readonly documentService: DocumentService;
  readonly storage: StorageDriver;
  readonly scanner: MalwareScanner;
  readonly maxRetries?: number;
}

export type ScanWorkerOutcome =
  | { readonly outcome: 'AVAILABLE'; readonly fileId: string }
  | { readonly outcome: 'INFECTED'; readonly fileId: string; readonly threat: string }
  | { readonly outcome: 'REJECTED'; readonly fileId: string; readonly reason: string }
  | {
      readonly outcome: 'RETRY_PENDING';
      readonly fileId: string;
      readonly attempts: number;
      readonly error: string;
    }
  | { readonly outcome: 'ERROR'; readonly fileId: string; readonly error: string };

/**
 * Background worker that safely scans and verifies files in SCANNING status.
 *
 * Requirements enforced:
 * 1. Safe row claiming using `FOR UPDATE SKIP LOCKED` inside `withTenant`.
 * 2. Server-side streaming read with size limits enforced at the storage layer.
 * 3. Independent calculation of actual byte count and SHA-256 digest during stream.
 * 4. Verification that actual byte count and digest match immutable expected metadata.
 * 5. Malware detection via the injected `MalwareScanner`.
 * 6. Forward-only state transition: promotes to AVAILABLE only on clean scan + matching digest/size;
 *    quarantines on malware (INFECTED) or integrity mismatch (REJECTED).
 * 7. Bounded retry behavior for transient errors; files remain non-downloadable while in SCANNING.
 */
export class DocumentScanWorker {
  readonly #db: Database;
  readonly #documentService: DocumentService;
  readonly #storage: StorageDriver;
  readonly #scanner: MalwareScanner;
  readonly #maxRetries: number;
  readonly #retryCounts = new Map<string, number>();

  constructor(options: DocumentScanWorkerOptions) {
    this.#db = options.db;
    this.#documentService = options.documentService;
    this.#storage = options.storage;
    this.#scanner = options.scanner;
    this.#maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Processes a single claimed file within an active tenant transaction.
   * Performs server-side streaming read, content verification (size and SHA-256),
   * and malware scan, transitioning the file forward safely.
   */
  async processFile(
    tx: TenantTx,
    ctx: TrustedContext,
    file: ScannableFile,
  ): Promise<ScanWorkerOutcome> {
    // 1. Open streaming read from storage
    let readStream;
    try {
      readStream = await this.#storage.openReadStream({
        storageClass: file.storageClass,
        key: file.storageKey,
      });
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        await this.#documentService.finalizeScan(tx, ctx, file.id, 'REJECTED', {
          details: 'Uploaded object missing from storage',
        });
        this.#retryCounts.delete(file.id);
        return { outcome: 'REJECTED', fileId: file.id, reason: 'Object missing from storage' };
      }
      if (err instanceof StorageReadLimitExceededError) {
        await this.#documentService.finalizeScan(tx, ctx, file.id, 'REJECTED', {
          details: 'Object exceeds storage class size limit',
        });
        this.#retryCounts.delete(file.id);
        return { outcome: 'REJECTED', fileId: file.id, reason: 'Size limit exceeded' };
      }
      // Transient storage read error: leave in SCANNING for retry
      return this.#handleTransientError(file.id, (err as Error).message);
    }

    // 2. Stream through SHA-256 and byte-counter transform while feeding the malware scanner
    const hash = createHash('sha256');
    let actualBytes = 0;
    const maxClassBytes = maxBytesForClass(file.storageClass);
    let sizeLimitExceeded = false;

    const meteringStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        actualBytes += chunk.length;
        if (actualBytes > maxClassBytes) {
          sizeLimitExceeded = true;
          callback(new StorageReadLimitExceededError('Size limit exceeded during scan stream'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    readStream.stream.pipe(meteringStream);
    meteringStream.resume();

    let scanResult;
    try {
      const streamFinished = finished(meteringStream);
      const scanPromise = this.#scanner.scanStream(meteringStream);
      const [, result] = await Promise.all([streamFinished, scanPromise]);
      scanResult = result;
    } catch (err) {
      if (sizeLimitExceeded || err instanceof StorageReadLimitExceededError) {
        await this.#documentService.finalizeScan(tx, ctx, file.id, 'REJECTED', {
          details: 'Object size exceeded storage class limit during streaming',
        });
        this.#retryCounts.delete(file.id);
        return { outcome: 'REJECTED', fileId: file.id, reason: 'Size limit exceeded' };
      }
      return this.#handleTransientError(file.id, (err as Error).message);
    }

    if (sizeLimitExceeded) {
      await this.#documentService.finalizeScan(tx, ctx, file.id, 'REJECTED', {
        details: 'Object size exceeded storage class limit during streaming',
      });
      this.#retryCounts.delete(file.id);
      return { outcome: 'REJECTED', fileId: file.id, reason: 'Size limit exceeded' };
    }

    // 3. Verify content integrity: actual byte count and SHA-256 digest
    const actualSha256 = hash.digest('hex');
    const sizeOk = actualBytes === file.sizeBytes;
    const shaOk = actualSha256 === file.sha256;

    if (!sizeOk || !shaOk) {
      const reason = !sizeOk
        ? `Size mismatch: declared ${file.sizeBytes} bytes, actual ${actualBytes} bytes`
        : `SHA-256 digest mismatch: declared ${file.sha256}, actual ${actualSha256}`;
      await this.#documentService.finalizeScan(tx, ctx, file.id, 'REJECTED', {
        details: reason,
      });
      this.#retryCounts.delete(file.id);
      return { outcome: 'REJECTED', fileId: file.id, reason };
    }

    // 4. Act on malware scanner verdict
    if (scanResult.verdict === 'INFECTED') {
      const threat = scanResult.details ?? 'Malware signature detected';
      await this.#documentService.finalizeScan(tx, ctx, file.id, 'INFECTED', {
        details: threat,
      });
      this.#retryCounts.delete(file.id);
      return { outcome: 'INFECTED', fileId: file.id, threat };
    }

    if (scanResult.verdict === 'CLEAN') {
      // Both integrity checks passed and scanner returned CLEAN: promote to AVAILABLE
      await this.#documentService.finalizeScan(tx, ctx, file.id, 'CLEAN');
      this.#retryCounts.delete(file.id);
      return { outcome: 'AVAILABLE', fileId: file.id };
    }

    // 5. Indeterminate verdict (scanner error/timeout)
    return this.#handleTransientError(
      file.id,
      scanResult.details ?? 'Scanner returned indeterminate status',
      tx,
      ctx,
    );
  }

  async #handleTransientError(
    fileId: string,
    errorMsg: string,
    tx?: TenantTx,
    ctx?: TrustedContext,
  ): Promise<ScanWorkerOutcome> {
    const attempts = (this.#retryCounts.get(fileId) ?? 0) + 1;
    this.#retryCounts.set(fileId, attempts);

    if (attempts >= this.#maxRetries) {
      // Retries exhausted: quarantine as ERROR if transaction is available
      if (tx && ctx) {
        await this.#documentService.finalizeScan(tx, ctx, fileId, 'ERROR', {
          details: `Scan failed after ${attempts} attempts: ${errorMsg}`,
        });
      }
      this.#retryCounts.delete(fileId);
      return { outcome: 'ERROR', fileId, error: errorMsg };
    }

    // Still within retry bounds: keep in SCANNING (fail closed, non-downloadable)
    return { outcome: 'RETRY_PENDING', fileId, attempts, error: errorMsg };
  }

  /**
   * Claims and processes the next available SCANNING file in the given tenant.
   * Runs inside db.withTenant with row locking (FOR UPDATE SKIP LOCKED).
   * Returns null if no files are pending scan in this tenant.
   */
  async processNext(ctx: TrustedContext): Promise<ScanWorkerOutcome | null> {
    return this.#db.withTenant(ctx, async (tx) => {
      const file = await this.#documentService.claimNextScanningFile(tx, ctx);
      if (!file) return null;
      return this.processFile(tx, ctx, file);
    });
  }

  /**
   * Processes up to `limit` files sequentially for the given tenant.
   */
  async processBatch(ctx: TrustedContext, limit = 10): Promise<ScanWorkerOutcome[]> {
    const outcomes: ScanWorkerOutcome[] = [];
    for (let i = 0; i < limit; i++) {
      const outcome = await this.processNext(ctx);
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }
}
