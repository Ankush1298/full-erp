// Public surface of the storage layer.
export {
  ALLOWED_CONTENT_TYPES,
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  DEFAULT_UPLOAD_TTL_SECONDS,
  MAX_URL_TTL_SECONDS,
  MIN_URL_TTL_SECONDS,
  MemoryStorageDriver,
  STORAGE_CLASSES,
  StorageKeyError,
  FileNameError,
  StorageObjectNotFoundError,
  StorageReadLimitExceededError,
  StorageDriverError,
  clampTtlSeconds,
  createSizeLimitingStream,
  deriveStorageKey,
  headerSafeFileName,
  isAllowedContentType,
  isStorageClass,
  maxBytesForClass,
  normalizeFileName,
  sniffContentType,
} from './storage.js';
export type {
  HeadInput,
  PresignDownloadInput,
  PresignUploadInput,
  PresignedDownload,
  PresignedUpload,
  ReadStreamInput,
  StorageClass,
  StorageDriver,
  StorageReadStream,
  StoredObject,
} from './storage.js';
export { S3StorageDriver, type S3BucketConfig } from './s3-driver.js';

import type { StorageConfig } from '../../config/env.js';
import { S3StorageDriver } from './s3-driver.js';
import type { StorageDriver } from './storage.js';

/** Builds the production driver from configuration. Only S3 is a production driver; the in-memory driver is test/dev
 *  only and is injected explicitly (never produced here), so production can never silently fall back to it. */
export function createStorageDriver(config: StorageConfig): StorageDriver {
  return new S3StorageDriver({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
    buckets: config.buckets,
  });
}
