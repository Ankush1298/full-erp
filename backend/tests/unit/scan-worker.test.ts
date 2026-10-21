import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Database, TenantTx } from '../../src/shared/database/index.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  MemoryStorageDriver,
  StorageReadLimitExceededError,
  type StorageDriver,
} from '../../src/shared/storage/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type {
  DocumentService,
  ScannableFile,
} from '../../src/modules/documents/document.service.js';
import { DocumentScanWorker } from '../../src/modules/documents/scan-worker.js';
import { MockMalwareScanner } from '../../src/modules/documents/scanner.js';

const PDF = Buffer.from('%PDF-1.4 sample content');
const sha256Of = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('DocumentScanWorker (unit)', () => {
  const orgId = uuidv7();
  const userId = uuidv7();
  const ctx = issueTrustedContext({ tenantId: orgId, userId, actorKind: 'STAFF' });
  const mockTx = {} as TenantTx;

  async function setupFixture(fileBytes: Buffer = PDF) {
    const fileId = uuidv7();
    const storageKey = `${orgId}/GENERAL/2026/${fileId}`;
    const storage = new MemoryStorageDriver();

    // Presign and put object into storage
    await storage.presignUpload({
      storageClass: 'GENERAL',
      key: storageKey,
      contentType: 'application/pdf',
      maxBytes: 10 * 1024 * 1024,
      ttlSeconds: 60,
    });
    storage.putObject('GENERAL', storageKey, fileBytes, 'application/pdf');

    const file: ScannableFile = {
      id: fileId,
      organizationId: orgId,
      storageClass: 'GENERAL',
      storageKey,
      originalName: 'test.pdf',
      declaredMime: 'application/pdf',
      detectedMime: 'application/pdf',
      sizeBytes: fileBytes.length,
      sha256: sha256Of(fileBytes),
    };

    const finalizeScanMock = vi.fn().mockResolvedValue({ id: fileId, status: 'AVAILABLE' });
    const claimNextScanningFileMock = vi.fn();

    const mockDocService = {
      finalizeScan: finalizeScanMock,
      claimNextScanningFile: claimNextScanningFileMock,
    } as unknown as DocumentService;

    const mockDb = {
      withTenant: vi
        .fn()
        .mockImplementation((_ctx: unknown, fn: (tx: TenantTx) => unknown): unknown => fn(mockTx)),
    } as unknown as Database;

    return {
      fileId,
      storageKey,
      storage,
      file,
      mockDocService,
      finalizeScanMock,
      claimNextScanningFileMock,
      mockDb,
    };
  }

  it('promotes file to AVAILABLE when content integrity and scanner are CLEAN', async () => {
    const { storage, file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result).toEqual({ outcome: 'AVAILABLE', fileId: file.id });
    expect(finalizeScanMock).toHaveBeenCalledWith(mockTx, ctx, file.id, 'CLEAN');
  });

  it('quarantines file as INFECTED when scanner detects malware', async () => {
    const { storage, file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    const scanner = new MockMalwareScanner({
      verdict: 'INFECTED',
      details: 'Win.Test.EICAR_HDB-1',
    });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result).toEqual({
      outcome: 'INFECTED',
      fileId: file.id,
      threat: 'Win.Test.EICAR_HDB-1',
    });
    expect(finalizeScanMock).toHaveBeenCalledWith(mockTx, ctx, file.id, 'INFECTED', {
      details: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('quarantines file as REJECTED when actual size does not match declared sizeBytes', async () => {
    const { storage, file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    // Tamper with expected sizeBytes metadata
    file.sizeBytes = file.sizeBytes + 10;

    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result.outcome).toBe('REJECTED');
    expect(finalizeScanMock).toHaveBeenCalledWith(
      mockTx,
      ctx,
      file.id,
      'REJECTED',
      expect.any(Object),
    );
    expect((finalizeScanMock.mock.calls[0]?.[4] as { details?: string })?.details).toContain(
      'Size mismatch',
    );
  });

  it('quarantines file as REJECTED when actual SHA-256 digest does not match declared sha256', async () => {
    const { storage, file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    // Tamper with expected sha256
    file.sha256 = '0'.repeat(64);

    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result.outcome).toBe('REJECTED');
    expect(finalizeScanMock).toHaveBeenCalledWith(
      mockTx,
      ctx,
      file.id,
      'REJECTED',
      expect.any(Object),
    );
    expect((finalizeScanMock.mock.calls[0]?.[4] as { details?: string })?.details).toContain(
      'SHA-256 digest mismatch',
    );
  });

  it('quarantines file as REJECTED when object is missing in storage', async () => {
    const { file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    const emptyStorage = new MemoryStorageDriver();
    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage: emptyStorage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result).toEqual({
      outcome: 'REJECTED',
      fileId: file.id,
      reason: 'Object missing from storage',
    });
    expect(finalizeScanMock).toHaveBeenCalledWith(
      mockTx,
      ctx,
      file.id,
      'REJECTED',
      expect.any(Object),
    );
    expect((finalizeScanMock.mock.calls[0]?.[4] as { details?: string })?.details).toContain(
      'missing',
    );
  });

  it('quarantines file as REJECTED when storage stream exceeds storage class limit', async () => {
    const { file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    const mockStorage = {
      openReadStream: vi.fn().mockRejectedValue(new StorageReadLimitExceededError('Size exceeded')),
    } as unknown as StorageDriver;

    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage: mockStorage,
      scanner,
    });

    const result = await worker.processFile(mockTx, ctx, file);

    expect(result).toEqual({
      outcome: 'REJECTED',
      fileId: file.id,
      reason: 'Size limit exceeded',
    });
    expect(finalizeScanMock).toHaveBeenCalledWith(
      mockTx,
      ctx,
      file.id,
      'REJECTED',
      expect.any(Object),
    );
    expect((finalizeScanMock.mock.calls[0]?.[4] as { details?: string })?.details).toContain(
      'size limit',
    );
  });

  it('keeps file in SCANNING on transient error and marks ERROR when retries exhausted', async () => {
    const { storage, file, mockDocService, finalizeScanMock, mockDb } = await setupFixture();
    const scanner = new MockMalwareScanner({
      verdict: 'INDETERMINATE',
      details: 'Connection timeout',
    });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
      maxRetries: 3,
    });

    // Attempt 1: RETRY_PENDING, does NOT finalize
    const res1 = await worker.processFile(mockTx, ctx, file);
    expect(res1).toEqual({
      outcome: 'RETRY_PENDING',
      fileId: file.id,
      attempts: 1,
      error: 'Connection timeout',
    });
    expect(finalizeScanMock).not.toHaveBeenCalled();

    // Attempt 2: RETRY_PENDING, does NOT finalize
    const res2 = await worker.processFile(mockTx, ctx, file);
    expect(res2).toEqual({
      outcome: 'RETRY_PENDING',
      fileId: file.id,
      attempts: 2,
      error: 'Connection timeout',
    });
    expect(finalizeScanMock).not.toHaveBeenCalled();

    // Attempt 3: Max retries exhausted -> finalizes with ERROR
    const res3 = await worker.processFile(mockTx, ctx, file);
    expect(res3).toEqual({
      outcome: 'ERROR',
      fileId: file.id,
      error: 'Connection timeout',
    });
    expect(finalizeScanMock).toHaveBeenCalledWith(
      mockTx,
      ctx,
      file.id,
      'ERROR',
      expect.any(Object),
    );
    expect((finalizeScanMock.mock.calls[0]?.[4] as { details?: string })?.details).toContain(
      '3 attempts',
    );
  });

  it('processNext returns null when no SCANNING files are eligible', async () => {
    const { storage, mockDocService, claimNextScanningFileMock, mockDb } = await setupFixture();
    claimNextScanningFileMock.mockResolvedValue(null);

    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const result = await worker.processNext(ctx);
    expect(result).toBeNull();
    expect(claimNextScanningFileMock).toHaveBeenCalledWith(mockTx, ctx);
  });

  it('processBatch processes available files up to limit', async () => {
    const { storage, file, mockDocService, claimNextScanningFileMock, mockDb } =
      await setupFixture();
    claimNextScanningFileMock
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce({ ...file, id: uuidv7() })
      .mockResolvedValueOnce(null);

    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const worker = new DocumentScanWorker({
      db: mockDb,
      documentService: mockDocService,
      storage,
      scanner,
    });

    const results = await worker.processBatch(ctx, 5);
    expect(results).toHaveLength(2);
    expect(results[0]?.outcome).toBe('AVAILABLE');
    expect(results[1]?.outcome).toBe('AVAILABLE');
  });
});
