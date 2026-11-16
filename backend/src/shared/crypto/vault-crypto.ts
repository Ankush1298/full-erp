import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { AppError } from '../errors/http-errors.js';

export interface VaultEnvelope {
  vaultVersion: 1;
  epoch: number;
  scope: string;
  algorithm: 'AES-256-GCM';
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64
  wrappedDek: string; // base64 wrapped DEK
  aadFingerprint: string; // hex sha256
  signature?: string; // base64 signature by device
}

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  tag: string; // base64
  aadFingerprint: string;
}

export interface RecoveryShare {
  index: number;
  data: string; // base64
}

/**
 * Derives AAD string for tamper-resistant envelope binding.
 */
export function buildAad(params: {
  tenantId: string;
  entityType: string;
  entityId: string;
  recordVersion: number;
  epoch: number;
}): Buffer {
  return Buffer.from(
    `${params.tenantId}:${params.entityType}:${params.entityId}:${params.recordVersion}:${params.epoch}`,
    'utf8',
  );
}

/**
 * Computes SHA-256 fingerprint of AAD.
 */
export function hashAad(aad: Buffer): string {
  return createHash('sha256').update(aad).digest('hex');
}

/**
 * AES-256-GCM authenticated encryption with mandatory AAD binding.
 */
export function encryptWithDek(
  plaintext: Buffer | string,
  dek: Buffer,
  aad: Buffer,
): EncryptedPayload {
  if (dek.length !== 32) {
    throw new AppError(500, 'CRYPTO_ERROR', 'DEK must be exactly 32 bytes (256 bits).');
  }

  const iv = randomBytes(12); // 96-bit standard nonce for GCM
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);

  const plainBuf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const encrypted = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    aadFingerprint: hashAad(aad),
  };
}

/**
 * AES-256-GCM authenticated decryption with mandatory AAD validation.
 * Fails closed if ciphertext, tag, or AAD has been tampered with.
 */
export function decryptWithDek(
  payload: { ciphertext: string; iv: string; tag: string },
  dek: Buffer,
  expectedAad: Buffer,
): Buffer {
  if (dek.length !== 32) {
    throw new AppError(500, 'CRYPTO_ERROR', 'DEK must be exactly 32 bytes (256 bits).');
  }

  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(expectedAad);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new AppError(
      400,
      'VAULT_DECRYPTION_FAILED',
      'Tamper detected or invalid key: ciphertext, authentication tag, or AAD validation failed.',
    );
  }
}

/**
 * ECDH P-256 Key Agreement & Key Wrapping.
 * Wraps a Capability Wrapping Key (CWK) or DEK under an authorized device public key.
 */
export function wrapKeyForDevice(
  keyToWrap: Buffer,
  devicePublicKeyBase64: string,
): { ephemeralPublicKey: string; wrappedKey: string; iv: string; tag: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();

  const sharedSecret = ecdh.computeSecret(Buffer.from(devicePublicKeyBase64, 'base64'));
  const wrappingKey = createHash('sha256')
    .update(sharedSecret)
    .update(Buffer.from('Anesa-Vault-Wrap-v1', 'utf8'))
    .digest();

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  const wrapped = Buffer.concat([cipher.update(keyToWrap), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ephemeralPublicKey: ecdh.getPublicKey().toString('base64'),
    wrappedKey: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Unwraps a wrapped key using the device private key.
 */
export function unwrapKeyWithDevice(
  wrappedPayload: { ephemeralPublicKey: string; wrappedKey: string; iv: string; tag: string },
  devicePrivateKeyBase64: string,
): Buffer {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(devicePrivateKeyBase64, 'base64'));

  const sharedSecret = ecdh.computeSecret(Buffer.from(wrappedPayload.ephemeralPublicKey, 'base64'));
  const wrappingKey = createHash('sha256')
    .update(sharedSecret)
    .update(Buffer.from('Anesa-Vault-Wrap-v1', 'utf8'))
    .digest();

  const iv = Buffer.from(wrappedPayload.iv, 'base64');
  const tag = Buffer.from(wrappedPayload.tag, 'base64');
  const ciphertext = Buffer.from(wrappedPayload.wrappedKey, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// -------------------------------------------------------------------------------------------------
// Galois Field GF(2^8) Arithmetic for Shamir's Secret Sharing (2-of-3 Quorum)
// Primitive polynomial: x^8 + x^4 + x^3 + x + 1 (0x11b), generator g = 3
// -------------------------------------------------------------------------------------------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

function mulGen3(a: number): number {
  let res = 0;
  let temp = a;
  // Multiply by 3 = (1 + 2)
  for (let bit = 0; bit < 8; bit++) {
    if ((3 >> bit) & 1) res ^= temp;
    temp <<= 1;
    if (temp & 0x100) temp ^= 0x11b;
  }
  return res;
}

(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = mulGen3(x);
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfAdd(a: number, b: number): number {
  return a ^ b;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a]! + GF_LOG[b]!) % 255]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF(2^8)');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a]! - GF_LOG[b]! + 255) % 255]!;
}

/**
 * Shamir's (2, 3) Threshold Secret Sharing scheme.
 * Splits a 256-bit secret (e.g. School Master Epoch Key) into 3 shares such that
 * ANY 2 shares can reconstruct the exact secret, but 1 share reveals 0 information.
 */
export function splitSecret(
  secret: Buffer,
  n = 3,
  k = 2,
): Array<{ index: number; data: string; hash: string }> {
  if (k !== 2 || n !== 3) {
    throw new AppError(500, 'CRYPTO_ERROR', 'Vault supports standard 2-of-3 recovery quorum.');
  }

  const shares: Array<{ index: number; bytes: Uint8Array }> = [];
  for (let i = 1; i <= n; i++) {
    shares.push({ index: i, bytes: new Uint8Array(secret.length) });
  }

  // Polynomial f(x) = secret + a1 * x
  for (let b = 0; b < secret.length; b++) {
    const a0 = secret[b]!;
    const a1 = randomBytes(1)[0]!; // random coefficient in GF(2^8)

    for (let i = 1; i <= n; i++) {
      const x = i;
      const y = gfAdd(a0, gfMul(a1, x));
      shares[i - 1]!.bytes[b] = y;
    }
  }

  return shares.map((s) => {
    const data = Buffer.from(s.bytes).toString('base64');
    const hash = createHash('sha256').update(s.bytes).digest('hex');
    return {
      index: s.index,
      data,
      hash,
    };
  });
}

/**
 * Lagrange polynomial interpolation in GF(2^8) to reconstruct secret at x = 0
 * using any 2 distinct presented shares.
 */
export function reconstructSecret(
  shares: Array<{ index: number; data: string }>,
): Buffer {
  if (shares.length < 2) {
    throw new AppError(
      400,
      'INSUFFICIENT_SHARES',
      'At least 2 recovery shares are required to reconstruct the institutional key.',
    );
  }

  // Deduplicate by index
  const unique = new Map<number, Uint8Array>();
  for (const s of shares) {
    if (s.index < 1 || s.index > 3) {
      throw new AppError(400, 'INVALID_SHARE_INDEX', `Invalid share index: ${s.index}`);
    }
    unique.set(s.index, new Uint8Array(Buffer.from(s.data, 'base64')));
  }

  if (unique.size < 2) {
    throw new AppError(400, 'DUPLICATE_SHARES', 'Presented shares must be from distinct custodians.');
  }

  const entries = Array.from(unique.entries()).slice(0, 2);
  const [x1, y1Bytes] = entries[0]!;
  const [x2, y2Bytes] = entries[1]!;

  if (y1Bytes.length !== y2Bytes.length) {
    throw new AppError(400, 'CORRUPT_SHARES', 'Share lengths mismatch.');
  }

  // Lagrange basis polynomials evaluated at x = 0:
  // l1(0) = (0 - x2) / (x1 - x2) = x2 / (x1 ^ x2)
  // l2(0) = (0 - x1) / (x2 - x1) = x1 / (x1 ^ x2)
  const denom = gfAdd(x1, x2);
  const l1 = gfDiv(x2, denom);
  const l2 = gfDiv(x1, denom);

  const secret = Buffer.alloc(y1Bytes.length);
  for (let b = 0; b < y1Bytes.length; b++) {
    const term1 = gfMul(y1Bytes[b]!, l1);
    const term2 = gfMul(y2Bytes[b]!, l2);
    secret[b] = gfAdd(term1, term2);
  }

  return secret;
}

// -------------------------------------------------------------------------------------------------
// WebAuthn / FIDO2 Challenge-Response & Hardware Attestation Verification Helpers
// -------------------------------------------------------------------------------------------------

/**
 * Generates a cryptographically strong 32-byte challenge for WebAuthn ceremony.
 */
export function generateChallenge(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generates an ECDSA P-256 (prime256v1) keypair for device signing.
 */
export function generateDeviceSigningKeyPair(): {
  publicKeySpki: string;
  privateKeyPkcs8: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKeySpki: publicKey,
    privateKeyPkcs8: privateKey,
  };
}

/**
 * Signs a challenge string using the device's private key (ECDSA with SHA-256).
 */
export function signChallenge(privateKeyPkcs8: string, challenge: string): string {
  const signer = createSign('SHA256');
  signer.update(Buffer.from(challenge, 'utf8'));
  signer.end();
  return signer.sign(privateKeyPkcs8, 'base64');
}

/**
 * Verifies a cryptographic challenge signature against the device's registered public key.
 */
export function verifyDeviceSignature(
  publicKeySpki: string,
  challenge: string,
  signatureBase64: string,
): boolean {
  try {
    let keyObj = publicKeySpki;
    if (!keyObj.includes('BEGIN PUBLIC KEY')) {
      keyObj = `-----BEGIN PUBLIC KEY-----\n${publicKeySpki}\n-----END PUBLIC KEY-----`;
    }
    const verifier = createVerify('SHA256');
    verifier.update(Buffer.from(challenge, 'utf8'));
    verifier.end();
    return verifier.verify(keyObj, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
