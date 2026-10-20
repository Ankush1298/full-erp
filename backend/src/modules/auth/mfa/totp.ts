import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 4226 (HOTP) / RFC 6238 (TOTP) with `node:crypto` only. Policy (docs/architecture/v3/23-mfa.md §2):
 * HMAC-SHA1, 6 digits, 30-second time step, T0 = 0, accepted window = the current step and ONE step either side
 * (±30 s of clock skew). SHA-1 is what every authenticator app supports for TOTP; HMAC-SHA1 is not affected by the SHA-1
 * collision attacks. Secrets are 20 random bytes (160 bits, the RFC 4226 §4 recommendation).
 *
 * Pure: no I/O, no clock of its own (the caller passes `nowMs`), no logging.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Steps accepted on each side of the current one. */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
const CODE_RE = /^\d{6}$/;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (what authenticator apps expect in an otpauth URI). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 §5.3: HOTP(K, C) with dynamic truncation. `digits` is 6..8 (8 only for the RFC 6238 test vectors). */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new RangeError('counter');
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) throw new RangeError('digits');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 time step for a Unix time in milliseconds (floor, T0 = 0). */
export function totpStep(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('time');
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Verifies a submitted code. Returns the matched time step (so the caller can record it and refuse a replay), or null.
 * Every candidate step is compared in constant time and the loop never exits early, so timing does not reveal which
 * step matched. Anything that is not exactly six ASCII digits is refused before any HMAC is computed.
 */
export function verifyTotp(secret: Uint8Array, code: unknown, nowMs: number): number | null {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  const current = totpStep(nowMs);
  const submitted = Buffer.from(code, 'ascii');
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), 'ascii');
    if (timingSafeEqual(expected, submitted) && matched === null) matched = step;
  }
  return matched;
}

/**
 * Key URI (the de-facto Google Authenticator format) for a QR code. It CONTAINS THE SECRET: it is returned once, to the
 * enrolling user only, and must never be logged, audited or stored.
 */
export function provisioningUri(secret: Uint8Array, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
