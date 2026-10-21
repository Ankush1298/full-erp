import { createHash } from 'node:crypto';
import * as net from 'node:net';
import { Readable } from 'node:stream';
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
import { ClamAvScanner, MockMalwareScanner } from '../../src/modules/documents/scanner.js';

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

describe('DocumentScanWorker with a real ClamAvScanner over TCP', () => {
  const orgId = uuidv7();
  const ctx = issueTrustedContext({ tenantId: orgId, userId: uuidv7(), actorKind: 'STAFF' });
  const mockTx = {} as TenantTx;
  // 16 distinct 64 KiB chunks so lost, duplicated or reordered bytes change the digest.
  const BYTES = Buffer.concat(
    Array.from({ length: 16 }, (_, i) => Buffer.alloc(64 * 1024, 0x41 + i)),
  );

  type Mode = 'clean' | 'silent' | 'infected-early';

  // clamd stand-in speaking the real zINSTREAM framing. Records the payload it was given.
  async function withClamd(
    mode: Mode,
    body: (port: number, received: () => Buffer) => Promise<void>,
  ): Promise<void> {
    const sockets = new Set<net.Socket>();
    const payload: Buffer[] = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buf = Buffer.alloc(0);
      let commandSeen = false;
      let answered = false;
      socket.on('data', (data) => {
        buf = Buffer.concat([buf, data]);
        if (!commandSeen) {
          if (buf.length < 10) return;
          commandSeen = buf.subarray(0, 10).toString('utf8') === 'zINSTREAM\0';
          buf = buf.subarray(10);
        }
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            if (mode === 'clean' && !answered) socket.write('stream: OK\0');
            answered = true;
            return;
          }
          if (buf.length < 4 + len) return;
          payload.push(Buffer.from(buf.subarray(4, 4 + len)));
          buf = buf.subarray(4 + len);
          if (mode === 'infected-early' && !answered) {
            answered = true;
            socket.write('stream: Win.Test.EICAR_HDB-1 FOUND\0');
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await body((server.address() as net.AddressInfo).port, () => Buffer.concat(payload));
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async function runWorker(
    port: number,
    opts: { maxBytes?: number; timeoutMs?: number; tamperSize?: boolean } = {},
  ) {
    const fileId = uuidv7();
    const storageKey = `${orgId}/GENERAL/2026/${fileId}`;
    const inner = new MemoryStorageDriver();
    await inner.presignUpload({
      storageClass: 'GENERAL',
      key: storageKey,
      contentType: 'application/pdf',
      maxBytes: 10 * 1024 * 1024,
      ttlSeconds: 60,
    });
    inner.putObject('GENERAL', storageKey, BYTES, 'application/pdf');
    // Adverse scheduling: bytes are available immediately (the source starts flowing on the very
    // next tick, long before the TCP connect completes) and arrive as separate chunks spread over
    // many event-loop turns, some before and some after the connection is established.
    const storage = {
      openReadStream: async (input: Parameters<StorageDriver['openReadStream']>[0]) => {
        const opened = await inner.openReadStream(input);
        return {
          ...opened,
          stream: Readable.from(
            (async function* () {
              for (let o = 0; o < BYTES.length; o += 64 * 1024) {
                yield BYTES.subarray(o, o + 64 * 1024);
                await new Promise((resolve) => setImmediate(resolve));
              }
            })(),
          ),
        };
      },
    } as unknown as StorageDriver;
    const file: ScannableFile = {
      id: fileId,
      organizationId: orgId,
      storageClass: 'GENERAL',
      storageKey,
      originalName: 'big.pdf',
      declaredMime: 'application/pdf',
      detectedMime: 'application/pdf',
      sizeBytes: BYTES.length + (opts.tamperSize ? 10 : 0),
      sha256: sha256Of(BYTES),
    };
    const finalizeScan = vi.fn().mockResolvedValue({});
    const worker = new DocumentScanWorker({
      db: {} as unknown as Database,
      documentService: { finalizeScan } as unknown as DocumentService,
      storage,
      scanner: new ClamAvScanner({
        host: '127.0.0.1',
        port,
        timeoutMs: opts.timeoutMs ?? 5000,
        ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      }),
      maxRetries: 1,
    });
    return { result: await worker.processFile(mockTx, ctx, file), finalizeScan, fileId };
  }

  it('delivers every byte to clamd in order and promotes the file to AVAILABLE on a clean verdict', async () => {
    await withClamd('clean', async (port, received) => {
      const { result, finalizeScan, fileId } = await runWorker(port);

      expect(result).toEqual({ outcome: 'AVAILABLE', fileId });
      expect(finalizeScan).toHaveBeenCalledWith(mockTx, ctx, fileId, 'CLEAN');
      const got = received();
      expect(got.length).toBe(BYTES.length);
      expect(sha256Of(got)).toBe(sha256Of(BYTES));
    });
  });

  it('keeps draining after an early INFECTED answer and persists INFECTED', async () => {
    await withClamd('infected-early', async (port) => {
      const { result, finalizeScan, fileId } = await runWorker(port);

      expect(result).toEqual({ outcome: 'INFECTED', fileId, threat: 'Win.Test.EICAR_HDB-1' });
      expect(finalizeScan).toHaveBeenCalledWith(mockTx, ctx, fileId, 'INFECTED', {
        details: 'Win.Test.EICAR_HDB-1',
      });
    });
  });

  it('drains the stream and persists ERROR when the scanner gives up on the byte limit', async () => {
    await withClamd('silent', async (port) => {
      const { result, finalizeScan, fileId } = await runWorker(port, { maxBytes: 10 });

      expect(result.outcome).toBe('ERROR');
      expect(finalizeScan).toHaveBeenCalledTimes(1);
      expect(finalizeScan).toHaveBeenCalledWith(mockTx, ctx, fileId, 'ERROR', {
        details: expect.stringMatching(/exceeded scan limit/i) as string,
      });
    });
  });

  it('still runs the integrity check and REJECTs a size mismatch after an early scanner result', async () => {
    await withClamd('silent', async (port) => {
      const { result, finalizeScan, fileId } = await runWorker(port, {
        maxBytes: 10,
        tamperSize: true,
      });

      expect(result.outcome).toBe('REJECTED');
      expect(finalizeScan).toHaveBeenCalledWith(mockTx, ctx, fileId, 'REJECTED', {
        details: expect.stringMatching(/Size mismatch/) as string,
      });
    });
  });

  it('persists ERROR (fail closed) when clamd never answers and the scanner times out', async () => {
    await withClamd('silent', async (port) => {
      const { result, finalizeScan, fileId } = await runWorker(port, { timeoutMs: 300 });

      expect(result.outcome).toBe('ERROR');
      expect(finalizeScan).toHaveBeenCalledWith(mockTx, ctx, fileId, 'ERROR', {
        details: expect.stringMatching(/timed out/i) as string,
      });
    });
  });
});
