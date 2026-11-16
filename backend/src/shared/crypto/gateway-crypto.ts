import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppError } from '../errors/http-errors.js';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PURPOSE = 'anesa/payment-gateway-credentials';

function getMasterKey(): Buffer {
  const envKey = process.env.GATEWAY_ENCRYPTION_KEY || process.env.APP_SECRET;
  if (envKey && envKey.trim().length > 0) {
    const trimmed = envKey.trim();
    if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) {
      return Buffer.from(trimmed, 'hex');
    }
    // Hash to 32 bytes
    return createHash('sha256').update(trimmed, 'utf8').digest();
  }
  // Deterministic local development / test fallback key
  return createHash('sha256').update('anesa-local-dev-gateway-key-32bytes-secret', 'utf8').digest();
}

function computeAad(organizationId: string): Buffer {
  return Buffer.from(`${PURPOSE}:v${FORMAT_VERSION}:${organizationId}`, 'utf8');
}

/**
 * Encrypts sensitive gateway credentials (key_secret, salt_key, webhook_secret)
 * with AES-256-GCM, fresh 96-bit random IV, and tenant AAD binding.
 */
export function encryptGatewayCredentials(
  data: Record<string, unknown> | string,
  organizationId: string,
): string {
  const masterKey = getMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv, {
    authTagLength: TAG_BYTES,
  });

  cipher.setAAD(computeAad(organizationId));
  const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wire format: version (1 byte) + IV (12 bytes) + tag (16 bytes) + ciphertext
  const sealed = Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, tag, ciphertext]);
  return sealed.toString('base64');
}

/**
 * Decrypts AES-256-GCM sealed gateway credentials. Verifies tenant AAD and tag.
 */
export function decryptGatewayCredentials<T = Record<string, unknown>>(
  sealedBase64: string,
  organizationId: string,
): T {
  try {
    const raw = Buffer.from(sealedBase64, 'base64');
    if (raw.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new Error('Encrypted payload too short');
    }
    const version = raw[0];
    if (version !== FORMAT_VERSION) {
      throw new Error(`Unsupported cipher version: ${version}`);
    }

    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(1 + IV_BYTES + TAG_BYTES);

    const masterKey = getMasterKey();
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(computeAad(organizationId));
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

    try {
      return JSON.parse(decrypted) as T;
    } catch {
      return decrypted as unknown as T;
    }
  } catch (err) {
    throw new AppError(
      500,
      'GATEWAY_CREDENTIALS_UNREADABLE',
      'Failed to authenticate and decrypt stored gateway credentials.',
    );
  }
}

/**
 * Masks sensitive keys / merchant IDs for safe API and UI responses.
 * E.g., 'rzp_test_1234567890abcdef' -> 'rzp_test_••••••••cdef'
 * 'mysecretkey12345' -> '••••••••2345'
 */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret || secret.trim().length === 0) return '';
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return '••••••••';
  }
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••••••${suffix}`;
}

/**
 * Constant-time comparison of two strings/buffers to prevent timing attacks.
 */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const bufA = typeof a === 'string' ? Buffer.from(a) : a;
  const bufB = typeof b === 'string' ? Buffer.from(b) : b;
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
