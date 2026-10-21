import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/env.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_URL_TTL_SECONDS,
  MIN_URL_TTL_SECONDS,
  MemoryStorageDriver,
  S3StorageDriver,
  StorageObjectNotFoundError,
  StorageReadLimitExceededError,
  StorageDriverError,
  clampTtlSeconds,
  createSizeLimitingStream,
  deriveStorageKey,
  isAllowedContentType,
  isStorageClass,
  maxBytesForClass,
  normalizeFileName,
  sniffContentType,
} from '../../src/shared/storage/index.js';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // %PDF-1
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe('deriveStorageKey', () => {
  const org = uuidv7();
  const file = uuidv7();

  it('is {org}/{class}/{yyyy}/{file}, lower-cased, matching the migration CHECK', () => {
    const key = deriveStorageKey(org, 'SENSITIVE', file, 2026);
    expect(key).toBe(`${org.toLowerCase()}/SENSITIVE/2026/${file.toLowerCase()}`);
    // the pattern the 0031 storage_key CHECK enforces
    const re =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(GENERAL|SENSITIVE|GENERATED)\/[0-9]{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(re.test(key)).toBe(true);
  });

  it('carries no PII: only the two UUIDs, the class and the year', () => {
    const key = deriveStorageKey(org, 'GENERAL', file, 2026);
    // apart from the storage-class word, the key is only hex (a-f), slashes and digits: no filename/name/number words
    expect(key.replace(/GENERAL|SENSITIVE|GENERATED/g, '')).not.toMatch(/[g-z]/i);
  });

  it('rejects a non-UUIDv7 org or file, and a bad year (no traversal, no client key)', () => {
    expect(() => deriveStorageKey('../etc', 'GENERAL', file, 2026)).toThrow();
    expect(() => deriveStorageKey(org, 'GENERAL', 'not-a-uuid', 2026)).toThrow();
    expect(() => deriveStorageKey(org, 'GENERAL', file, 1999)).toThrow();
    // a v4 UUID (wrong version) is refused
    expect(() =>
      deriveStorageKey('00000000-0000-4000-8000-000000000000', 'GENERAL', file, 2026),
    ).toThrow();
  });
});

describe('clampTtlSeconds (presigned-URL bounds, doc 03 §12.4)', () => {
  it('clamps into [MIN, MAX] and falls back on a non-finite value', () => {
    expect(clampTtlSeconds(5, 120)).toBe(MIN_URL_TTL_SECONDS);
    expect(clampTtlSeconds(100000, 120)).toBe(MAX_URL_TTL_SECONDS);
    expect(clampTtlSeconds(300, 120)).toBe(300);
    expect(clampTtlSeconds(undefined, 120)).toBe(120);
    expect(clampTtlSeconds(Number.NaN, 120)).toBe(120);
    expect(clampTtlSeconds(Infinity, 120)).toBe(120);
  });
});

describe('normalizeFileName', () => {
  it('strips any directory component (path traversal) and keeps the basename', () => {
    expect(normalizeFileName('report.pdf')).toBe('report.pdf');
    expect(normalizeFileName('../../etc/passwd')).toBe('passwd');
    expect(normalizeFileName('C:\\Windows\\secret.pdf')).toBe('secret.pdf');
    expect(normalizeFileName('a/b/c/x.png')).toBe('x.png');
  });
  it('rejects empty, dot, and control characters', () => {
    expect(() => normalizeFileName('')).toThrow();
    expect(() => normalizeFileName('..')).toThrow();
    expect(() => normalizeFileName('a\nb.pdf')).toThrow();
    expect(() => normalizeFileName(42)).toThrow();
    expect(() => normalizeFileName('x'.repeat(256))).toThrow();
  });
});

describe('content-type allowlist and magic-byte sniff', () => {
  it('only the three allowlisted types are accepted', () => {
    expect([...ALLOWED_CONTENT_TYPES].sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
    ]);
    expect(isAllowedContentType('application/pdf')).toBe(true);
    expect(isAllowedContentType('text/html')).toBe(false);
    expect(isAllowedContentType('application/x-msdownload')).toBe(false);
  });
  it('sniffs by signature, not by declared type (defeats MIME confusion)', () => {
    expect(sniffContentType(PDF)).toBe('application/pdf');
    expect(sniffContentType(PNG)).toBe('image/png');
    expect(sniffContentType(JPEG)).toBe('image/jpeg');
    expect(sniffContentType(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull(); // <html
    expect(sniffContentType(new Uint8Array([]))).toBeNull();
  });
  it('isStorageClass / maxBytesForClass', () => {
    expect(isStorageClass('SENSITIVE')).toBe(true);
    expect(isStorageClass('OTHER')).toBe(false);
    expect(maxBytesForClass('GENERAL')).toBeLessThan(maxBytesForClass('SENSITIVE'));
    expect(maxBytesForClass('SENSITIVE')).toBeLessThanOrEqual(104857600);
  });
});

describe('MemoryStorageDriver', () => {
  const org = uuidv7();
  const key = deriveStorageKey(org, 'GENERAL', uuidv7(), 2026);

  it('enforces the presigned content-type, size and expiry at PUT, and heads back verified metadata', async () => {
    let now = 1_000_000;
    const d = new MemoryStorageDriver(() => now);
    const grant = await d.presignUpload({
      storageClass: 'GENERAL',
      key,
      contentType: 'application/pdf',
      maxBytes: 10,
      ttlSeconds: 60,
    });
    expect(grant.method).toBe('PUT');
    expect(grant.requiredHeaders['Content-Type']).toBe('application/pdf');

    expect(() => d.putObject('GENERAL', key, PDF, 'image/png')).toThrow(/content-type/);
    expect(() => d.putObject('GENERAL', key, new Uint8Array(11), 'application/pdf')).toThrow(
      /size/,
    );
    d.putObject('GENERAL', key, PDF, 'application/pdf');

    const head = await d.head({ storageClass: 'GENERAL', key });
    expect(head.exists).toBe(true);
    expect(head.sizeBytes).toBe(PDF.length);
    expect(head.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    expect(head.contentType).toBe('application/pdf'); // sniffed

    now += 61_000; // the grant has expired
    await expect(
      Promise.resolve().then(() => d.putObject('GENERAL', key, PDF, 'application/pdf')),
    ).rejects.toThrow(/expired/);
  });

  it('head of an absent object reports exists:false', async () => {
    const d = new MemoryStorageDriver();
    expect(await d.head({ storageClass: 'GENERAL', key: 'absent/GENERAL/2026/x' })).toEqual({
      exists: false,
      sizeBytes: 0,
      sha256: null,
      contentType: null,
    });
  });

  it('download URL fixes response-content-type and forces an attachment', async () => {
    const d = new MemoryStorageDriver();
    const dl = await d.presignDownload({
      storageClass: 'GENERAL',
      key,
      ttlSeconds: 120,
      contentType: 'application/pdf',
      downloadFilename: 'my "file".pdf',
    });
    expect(dl.url).toContain('response-content-type=application%2Fpdf');
    expect(dl.url).toContain('attachment');
    expect(dl.url).not.toContain('"'); // the quote in the filename is neutralised
  });

  it('openReadStream streams bytes back and reports accurate metadata', async () => {
    const d = new MemoryStorageDriver();
    await d.presignUpload({
      storageClass: 'GENERAL',
      key,
      contentType: 'application/pdf',
      maxBytes: 100,
      ttlSeconds: 60,
    });
    d.putObject('GENERAL', key, PDF, 'application/pdf');

    const result = await d.openReadStream({ storageClass: 'GENERAL', key });
    expect(result.contentLength).toBe(PDF.length);
    expect(result.contentType).toBe('application/pdf');

    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }
    const combined = Buffer.concat(chunks);
    expect(combined).toEqual(Buffer.from(PDF));
  });

  it('openReadStream throws StorageObjectNotFoundError on absent object', async () => {
    const d = new MemoryStorageDriver();
    await expect(
      d.openReadStream({ storageClass: 'GENERAL', key: 'non-existent-key' }),
    ).rejects.toThrow(StorageObjectNotFoundError);
  });

  it('createSizeLimitingStream destroys stream when byte limit is exceeded', async () => {
    const limitStream = createSizeLimitingStream(5);
    const writePromise = new Promise<void>((resolve, reject) => {
      limitStream.on('error', reject);
      limitStream.on('finish', resolve);
      limitStream.write(Buffer.from('1234'));
      limitStream.write(Buffer.from('5678')); // Exceeds 5 bytes
      limitStream.end();
    });
    await expect(writePromise).rejects.toThrow(StorageReadLimitExceededError);
  });
});

describe('S3StorageDriver SigV4 presigning (offline, deterministic)', () => {
  const cfg = {
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    accessKeyId: new Secret('AKIAEXAMPLE'),
    secretAccessKey: new Secret('secretkeyexamplevalue'),
    forcePathStyle: true,
    buckets: { GENERAL: 'general', SENSITIVE: 'sensitive', GENERATED: 'generated' } as const,
  };
  const key =
    'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/SENSITIVE/2026/bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

  it('presigned PUT: private bucket in the path, signed content-type, bounded expiry, stable signature', async () => {
    const d = new S3StorageDriver(cfg, () => 1_700_000_000_000);
    const a = await d.presignUpload({
      storageClass: 'SENSITIVE',
      key,
      contentType: 'application/pdf',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    expect(a.url).toContain('https://s3.eu-west-1.amazonaws.com/sensitive/');
    expect(a.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    expect(a.url).toContain('X-Amz-Expires=300');
    expect(a.url).toContain('X-Amz-SignedHeaders=content-type%3Bhost');
    expect(a.requiredHeaders['Content-Type']).toBe('application/pdf');
    // deterministic for the same clock/key/secret
    const b = await d.presignUpload({
      storageClass: 'SENSITIVE',
      key,
      contentType: 'application/pdf',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    expect(b.url).toBe(a.url);
    // a different content type changes the signature (it is a signed header)
    const c = await d.presignUpload({
      storageClass: 'SENSITIVE',
      key,
      contentType: 'image/png',
      maxBytes: 100,
      ttlSeconds: 300,
    });
    expect(c.url).not.toBe(a.url);
  });

  it('presigned GET fixes the response disposition/type and never emits a permanent URL', async () => {
    const d = new S3StorageDriver(cfg, () => 1_700_000_000_000);
    const dl = await d.presignDownload({
      storageClass: 'SENSITIVE',
      key,
      ttlSeconds: 120,
      contentType: 'application/pdf',
      downloadFilename: 'id.pdf',
    });
    expect(dl.url).toContain('response-content-disposition=');
    expect(dl.url).toContain('X-Amz-Expires=120');
    expect(dl.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    expect(new Date(dl.expiresAt).getTime()).toBe(1_700_000_000_000 + 120_000);
  });

  it('openReadStream signs GET and handles 404 as StorageObjectNotFoundError', async () => {
    const d = new S3StorageDriver(cfg, () => 1_700_000_000_000);
    // Mock global fetch for this test
    const originalFetch = globalThis.fetch;
    try {
      let interceptedUrl = '';
      let interceptedMethod = '';
      let interceptedHeaders: Headers | undefined;

      globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        interceptedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        interceptedMethod = init?.method ?? 'GET';
        interceptedHeaders = new Headers(init?.headers);
        return Promise.resolve(new Response('Not Found', { status: 404 }));
      };

      await expect(d.openReadStream({ storageClass: 'SENSITIVE', key })).rejects.toThrow(
        StorageObjectNotFoundError,
      );

      expect(interceptedMethod).toBe('GET');
      expect(interceptedUrl).toContain('https://s3.eu-west-1.amazonaws.com/sensitive/');
      expect(interceptedHeaders?.get('Authorization')).toMatch(/AWS4-HMAC-SHA256/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('openReadStream throws StorageReadLimitExceededError when Content-Length exceeds storage class limit', async () => {
    const d = new S3StorageDriver(cfg, () => 1_700_000_000_000);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => {
        return Promise.resolve(
          new Response('Large object', {
            status: 200,
            headers: {
              'content-length': String(50 * 1024 * 1024), // 50 MiB > 20 MiB limit for SENSITIVE
            },
          }),
        );
      };

      await expect(d.openReadStream({ storageClass: 'SENSITIVE', key })).rejects.toThrow(
        StorageReadLimitExceededError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('openReadStream throws StorageDriverError on non-ok status', async () => {
    const d = new S3StorageDriver(cfg, () => 1_700_000_000_000);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = () => {
        return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
      };

      await expect(d.openReadStream({ storageClass: 'SENSITIVE', key })).rejects.toThrow(
        StorageDriverError,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
