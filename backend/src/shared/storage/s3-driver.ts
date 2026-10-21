import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Secret } from '../../config/env.js';
import {
  type HeadInput,
  type PresignDownloadInput,
  type PresignUploadInput,
  type PresignedDownload,
  type PresignedUpload,
  type ReadStreamInput,
  type StorageClass,
  type StorageDriver,
  type StorageReadStream,
  type StoredObject,
  StorageDriverError,
  StorageObjectNotFoundError,
  StorageReadLimitExceededError,
  createSizeLimitingStream,
  maxBytesForClass,
} from './storage.js';

/**
 * Production S3-compatible driver (AWS S3 / Cloudflare R2 / MinIO: the endpoint decides). Presigned URLs are signed
 * with AWS Signature Version 4 using Node's crypto only — no AWS SDK dependency. The signing is pure and offline; only
 * `head()` reaches the network (a signed HEAD for completion verification).
 *
 * Credentials live in a Secret (never logged/serialised) and are read only to sign. Buckets are private: the driver
 * never sets any ACL and never produces a permanent or public URL. One private bucket per storage class (doc 03 §12.1),
 * so the `sensitive` bucket can carry the tightest IAM independently.
 */

export interface S3BucketConfig {
  /** Endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com or https://s3.eu-west-1.amazonaws.com. */
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: Secret;
  readonly secretAccessKey: Secret;
  /** MinIO/R2 need path-style (bucket in the path); AWS S3 uses virtual-host style. */
  readonly forcePathStyle: boolean;
  /** Private bucket name per storage class. */
  readonly buckets: Readonly<Record<StorageClass, string>>;
}

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** RFC 3986 encoding AWS requires (encodeURIComponent leaves !*'() unescaped). */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  if (!encodeSlash) out = out.replace(/%2F/g, '/');
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function amzDate(now: Date): { date: string; dateTime: string } {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { date: dateTime.slice(0, 8), dateTime };
}

export class S3StorageDriver implements StorageDriver {
  readonly kind = 's3';
  readonly #cfg: S3BucketConfig;
  readonly #now: () => number;

  constructor(cfg: S3BucketConfig, now: () => number = Date.now) {
    this.#cfg = cfg;
    this.#now = now;
  }

  /** Builds { host, path } for a bucket/key under the configured endpoint and addressing style. */
  #endpointFor(
    storageClass: StorageClass,
    key: string,
  ): { host: string; path: string; origin: string } {
    const bucket = this.#cfg.buckets[storageClass];
    const url = new URL(this.#cfg.endpoint);
    const encodedKey = key
      .split('/')
      .map((s) => uriEncode(s, true))
      .join('/');
    if (this.#cfg.forcePathStyle) {
      return {
        host: url.host,
        path: `/${bucket}/${encodedKey}`,
        origin: `${url.protocol}//${url.host}`,
      };
    }
    return {
      host: `${bucket}.${url.host}`,
      path: `/${encodedKey}`,
      origin: `${url.protocol}//${bucket}.${url.host}`,
    };
  }

  #presign(
    method: 'GET' | 'PUT',
    storageClass: StorageClass,
    key: string,
    ttlSeconds: number,
    extraQuery: Record<string, string>,
    signedHeaderValues: Record<string, string>,
  ): { url: string; expiresAt: string } {
    const { host, path, origin } = this.#endpointFor(storageClass, key);
    const now = new Date(this.#now());
    const { date, dateTime } = amzDate(now);
    const scope = `${date}/${this.#cfg.region}/${SERVICE}/aws4_request`;

    const headers: Record<string, string> = { host, ...signedHeaderValues };
    const signedHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .join(';');

    const query: Record<string, string> = {
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${this.#cfg.accessKeyId.reveal()}/${scope}`,
      'X-Amz-Date': dateTime,
      'X-Amz-Expires': String(ttlSeconds),
      'X-Amz-SignedHeaders': signedHeaders,
      ...extraQuery,
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k] as string, true)}`)
      .join('&');

    const canonicalHeaders = Object.entries(headers)
      .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}:${v}\n`)
      .join('');

    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [
      ALGORITHM,
      dateTime,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signature = createHmac(
      'sha256',
      signingKey(this.#cfg.secretAccessKey.reveal(), date, this.#cfg.region),
    )
      .update(stringToSign)
      .digest('hex');

    return {
      url: `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    };
  }

  presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    // Content-Type is a SIGNED header: the client must send exactly this type or the signature fails, pinning the
    // declared MIME at upload time. Size is additionally verified at completion via head().
    const { url, expiresAt } = this.#presign(
      'PUT',
      input.storageClass,
      input.key,
      input.ttlSeconds,
      {},
      {
        'content-type': input.contentType,
      },
    );
    return Promise.resolve({
      url,
      method: 'PUT',
      requiredHeaders: { 'Content-Type': input.contentType },
      expiresAt,
    });
  }

  presignDownload(input: PresignDownloadInput): Promise<PresignedDownload> {
    // response-* overrides fix the Content-Type and force an attachment download with the original filename, so the
    // browser never renders the object inline (no MIME confusion / inline-rendering attack).
    const { url, expiresAt } = this.#presign(
      'GET',
      input.storageClass,
      input.key,
      input.ttlSeconds,
      {
        'response-content-type': input.contentType,
        // eslint-disable-next-line no-control-regex
        'response-content-disposition': `attachment; filename="${input.downloadFilename.replace(/[\u0000-\u001f\u007f"\\]/g, '_')}"`,
      },
      {},
    );
    return Promise.resolve({ url, expiresAt });
  }

  async head(input: HeadInput): Promise<StoredObject> {
    const { host, path, origin } = this.#endpointFor(input.storageClass, input.key);
    const now = new Date(this.#now());
    const { date, dateTime } = amzDate(now);
    const scope = `${date}/${this.#cfg.region}/${SERVICE}/aws4_request`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${dateTime}\n`;
    const canonicalRequest = ['HEAD', path, '', canonicalHeaders, signedHeaders, EMPTY_SHA256].join(
      '\n',
    );
    const stringToSign = [
      ALGORITHM,
      dateTime,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(this.#cfg.secretAccessKey.reveal(), date, this.#cfg.region),
    )
      .update(stringToSign)
      .digest('hex');
    const authorization =
      `${ALGORITHM} Credential=${this.#cfg.accessKeyId.reveal()}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`${origin}${path}`, {
      method: 'HEAD',
      headers: {
        Authorization: authorization,
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': dateTime,
      },
    });
    if (res.status === 404) return { exists: false, sizeBytes: 0, sha256: null, contentType: null };
    if (!res.ok) throw new Error(`storage head failed: ${res.status}`);
    const len = Number(res.headers.get('content-length'));
    // S3 exposes a SHA-256 only when the object was uploaded with the additional checksum; base64 there, hex here.
    const checksum = res.headers.get('x-amz-checksum-sha256');
    const sha256 = checksum ? Buffer.from(checksum, 'base64').toString('hex') : null;
    return {
      exists: true,
      sizeBytes: Number.isFinite(len) ? len : 0,
      sha256,
      contentType: res.headers.get('content-type'),
    };
  }

  async openReadStream(input: ReadStreamInput): Promise<StorageReadStream> {
    const { host, path, origin } = this.#endpointFor(input.storageClass, input.key);
    const now = new Date(this.#now());
    const { date, dateTime } = amzDate(now);
    const scope = `${date}/${this.#cfg.region}/${SERVICE}/aws4_request`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${dateTime}\n`;
    const canonicalRequest = ['GET', path, '', canonicalHeaders, signedHeaders, EMPTY_SHA256].join(
      '\n',
    );
    const stringToSign = [
      ALGORITHM,
      dateTime,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');
    const signature = createHmac(
      'sha256',
      signingKey(this.#cfg.secretAccessKey.reveal(), date, this.#cfg.region),
    )
      .update(stringToSign)
      .digest('hex');
    const authorization =
      `${ALGORITHM} Credential=${this.#cfg.accessKeyId.reveal()}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const res = await fetch(`${origin}${path}`, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'x-amz-content-sha256': EMPTY_SHA256,
        'x-amz-date': dateTime,
      },
    });

    if (res.status === 404) {
      throw new StorageObjectNotFoundError(`Object not found: ${input.key}`);
    }
    if (!res.ok) {
      throw new StorageDriverError(`storage get failed: ${res.status}`);
    }
    if (!res.body) {
      throw new StorageDriverError('storage get returned empty response body');
    }

    const maxBytes = maxBytesForClass(input.storageClass);
    const lenHeader = res.headers.get('content-length');
    const contentLength = lenHeader ? Number(lenHeader) : undefined;
    if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
      await res.body.cancel();
      throw new StorageReadLimitExceededError(
        `Object size ${contentLength} exceeds limit ${maxBytes}`,
      );
    }

    const nodeStream = Readable.fromWeb(res.body);
    const limitedStream = nodeStream.pipe(createSizeLimitingStream(maxBytes));

    return {
      stream: limitedStream,
      contentLength:
        contentLength !== undefined && Number.isFinite(contentLength) ? contentLength : undefined,
      contentType: res.headers.get('content-type'),
    };
  }
}
