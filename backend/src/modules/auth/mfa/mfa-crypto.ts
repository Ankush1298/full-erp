import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { AppError } from '../../../shared/errors/http-errors.js';
import type { KeyRingConfig } from '../../../config/env.js';

/**
 * Encryption of TOTP secrets at rest and recovery-code hashing (docs/architecture/v3/23-mfa.md §3, §5).
 *
 * Secret box: AES-256-GCM (authenticated encryption from node:crypto), a fresh random 96-bit IV per seal, 128-bit tag.
 * Stored layout: [1 byte format version = 1][12 bytes IV][16 bytes tag][ciphertext]. The key ID is stored in its own
 * column (secret_key_label) so rotation progress can be measured; it is ALSO bound into the AAD together with the purpose,
 * the format version, the tenant, the user and the factor id, so a ciphertext copied to another row, another user, another
 * tenant or another purpose fails authentication instead of decrypting.
 *
 * Keys come only from the dedicated MFA_ENCRYPTION_KEYS ring (config/env.ts): never a fallback, never a hard-coded or
 * derived key, never the cursor keys. Nothing here logs; errors carry no key, plaintext or ciphertext.
 */
const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PURPOSE = 'anesa/mfa-totp-secret';

export interface SecretBinding {
  readonly organizationId: string;
  readonly userId: string;
  readonly factorId: string;
}

function aad(keyId: string, b: SecretBinding): Buffer {
  return Buffer.from(
    [PURPOSE, `v${FORMAT_VERSION}`, keyId, b.organizationId, b.userId, b.factorId].join('\n'),
    'utf8',
  );
}

export function mfaUnavailable(): AppError {
  return new AppError(
    503,
    'MFA_UNAVAILABLE',
    'Multi-factor authentication is not available. Contact your administrator.',
  );
}

function unreadable(): AppError {
  // A stored secret that does not authenticate is an integrity problem, not a user error: generic 500, no detail.
  return new AppError(500, 'MFA_SECRET_UNREADABLE', 'The second factor could not be verified.');
}

export class MfaSecretBox {
  readonly activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(ring: KeyRingConfig) {
    const keys = new Map<string, Buffer>();
    for (const [id, secret] of ring.keys) {
      const key = Buffer.from(secret.reveal(), 'base64url');
      if (key.length !== 32) throw new Error('MFA keyring contains an invalid key.');
      keys.set(id, key);
    }
    if (!keys.has(ring.activeKeyId)) throw new Error('MFA keyring has no active key.');
    this.activeKeyId = ring.activeKeyId;
    this.#keys = keys;
  }

  seal(plaintext: Uint8Array, binding: SecretBinding): { keyId: string; sealed: Buffer } {
    const keyId = this.activeKeyId;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#keys.get(keyId)!, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad(keyId, binding));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      keyId,
      sealed: Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]),
    };
  }

  /** Throws 503 MFA_UNAVAILABLE when the key is not configured (retired too early), 500 when the data does not authenticate. */
  open(sealed: Uint8Array, keyId: string, binding: SecretBinding): Buffer {
    const key = this.#keys.get(keyId);
    if (!key) throw mfaUnavailable();
    const buf = Buffer.from(sealed);
    if (buf.length <= 1 + IV_BYTES + TAG_BYTES || buf[0] !== FORMAT_VERSION) throw unreadable();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(keyId, binding));
      decipher.setAuthTag(buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(buf.subarray(1 + IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw unreadable();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32 (no I, L, O, U): 20 symbols x 5 bits = 100 bits of entropy per code. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_SYMBOLS = 20;
const NORMALISED_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{20}$/;

/** Ten fresh codes, display format `XXXXX-XXXXX-XXXXX-XXXXX`. Shown to the user once; only hashes are stored. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let s = '';
    for (let i = 0; i < CODE_SYMBOLS; i++) s += CROCKFORD[randomInt(32)];
    return s.match(/.{5}/g)!.join('-');
  });
}

/**
 * Canonical form of user input: case-insensitive, hyphens and spaces ignored, Crockford's confusables mapped (I/L -> 1,
 * O -> 0). Null for anything that cannot be a code (wrong length or alphabet), so no hash is computed for garbage.
 */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return NORMALISED_RE.test(s) ? s : null;
}

/**
 * Stored form: SHA-256 over a purpose/version prefix, the tenant, the user and the normalised code (hex). A fast hash is
 * appropriate HERE because each code carries 100 random bits (offline guessing is infeasible, unlike passwords); the
 * tenant/user salt makes every hash unique to its owner, so a hash can never match another user's row.
 */
export function hashRecoveryCode(
  organizationId: string,
  userId: string,
  normalised: string,
): string {
  return createHash('sha256')
    .update(['anesa/mfa-recovery-code', 'v1', organizationId, userId, normalised].join('\n'))
    .digest('hex');
}
