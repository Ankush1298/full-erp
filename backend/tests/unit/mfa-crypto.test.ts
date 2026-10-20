import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from '../../src/config/env.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  MfaSecretBox,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../../src/modules/auth/mfa/mfa-crypto.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

const key = () => randomBytes(32).toString('base64url');
const ring = (active: string, keys: Record<string, string>) => ({
  activeKeyId: active,
  keys: new Map(Object.entries(keys).map(([id, k]) => [id, new Secret(k)])),
});
const binding = () => ({ organizationId: uuidv7(), userId: uuidv7(), factorId: uuidv7() });
const errCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? `${e.statusCode} ${e.code}` : 'non-AppError';
  }
  return undefined;
};

describe('MfaSecretBox (AES-256-GCM, AAD-bound)', () => {
  const k1 = key();
  const k2 = key();
  const box = new MfaSecretBox(ring('k1', { k1 }));
  const plain = randomBytes(20);

  it('round-trips and never stores the plaintext', () => {
    const b = binding();
    const { keyId, sealed } = box.seal(plain, b);
    expect(keyId).toBe('k1');
    expect(sealed).toHaveLength(1 + 12 + 16 + 20);
    expect(sealed[0]).toBe(1);
    expect(sealed.includes(plain)).toBe(false);
    expect(box.open(sealed, keyId, b).equals(plain)).toBe(true);
  });

  it('uses a fresh IV for every seal (same input, different ciphertext)', () => {
    const b = binding();
    const a = box.seal(plain, b).sealed;
    const c = box.seal(plain, b).sealed;
    expect(a.subarray(1, 13).equals(c.subarray(1, 13))).toBe(false);
    expect(a.equals(c)).toBe(false);
  });

  it('a ciphertext moved to another tenant, user, factor or key id does not decrypt', () => {
    const b = binding();
    const { sealed } = box.seal(plain, b);
    for (const other of [
      { ...b, organizationId: uuidv7() },
      { ...b, userId: uuidv7() },
      { ...b, factorId: uuidv7() },
    ]) {
      expect(errCode(() => box.open(sealed, 'k1', other))).toBe('500 MFA_SECRET_UNREADABLE');
    }
    // the same key material under another id is a different binding as well
    const twin = new MfaSecretBox(ring('k1', { k1, alias: k1 }));
    expect(errCode(() => twin.open(sealed, 'alias', b))).toBe('500 MFA_SECRET_UNREADABLE');
  });

  it('any tampering (version byte, IV, tag, body, truncation) fails closed with a generic 500', () => {
    const b = binding();
    const { sealed } = box.seal(plain, b);
    for (const i of [0, 1, 13, 29, sealed.length - 1]) {
      const t = Buffer.from(sealed);
      t[i] = t[i]! ^ 0x01;
      expect(
        errCode(() => box.open(t, 'k1', b)),
        `byte ${i}`,
      ).toBe('500 MFA_SECRET_UNREADABLE');
    }
    expect(errCode(() => box.open(sealed.subarray(0, 29), 'k1', b))).toBe(
      '500 MFA_SECRET_UNREADABLE',
    );
    expect(errCode(() => box.open(Buffer.alloc(0), 'k1', b))).toBe('500 MFA_SECRET_UNREADABLE');
  });

  it('an unknown key id is 503 MFA_UNAVAILABLE (key retired too early), not a decryption attempt', () => {
    const b = binding();
    const { sealed } = box.seal(plain, b);
    expect(errCode(() => box.open(sealed, 'gone', b))).toBe('503 MFA_UNAVAILABLE');
  });

  it('rotation: a new active key seals, the retiring key still opens old data', () => {
    const b = binding();
    const old = box.seal(plain, b);
    const rotated = new MfaSecretBox(ring('k2', { k1, k2 }));
    expect(rotated.open(old.sealed, old.keyId, b).equals(plain)).toBe(true);
    const fresh = rotated.seal(plain, b);
    expect(fresh.keyId).toBe('k2');
    expect(errCode(() => box.open(fresh.sealed, 'k2', b))).toBe('503 MFA_UNAVAILABLE');
  });

  it('refuses a ring with a wrongly sized key or no active key', () => {
    expect(() => new MfaSecretBox(ring('a', { a: randomBytes(16).toString('base64url') }))).toThrow(
      /invalid key/,
    );
    expect(() => new MfaSecretBox(ring('b', { a: k1 }))).toThrow(/no active key/);
  });

  it('error messages and inspection never carry key, plaintext or ciphertext', () => {
    const b = binding();
    const { sealed } = box.seal(plain, b);
    let message = '';
    try {
      box.open(sealed, 'k1', { ...b, userId: uuidv7() });
    } catch (e) {
      message = `${(e as Error).message} ${inspect(e)}`;
    }
    for (const s of [k1, plain.toString('hex'), sealed.toString('hex'), sealed.toString('base64')])
      expect(message).not.toContain(s);
    expect(inspect(box)).not.toContain(k1);
  });
});

describe('recovery codes', () => {
  it('a set is exactly 10 distinct codes of 20 Crockford symbols (100 bits), grouped by five', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(new Set([...generateRecoveryCodes(), ...codes]).size).toBe(20);
  });

  it('normalisation: case, hyphens and spaces ignored; I/L -> 1, O -> 0; anything else refused', () => {
    expect(normaliseRecoveryCode('abcde-fghjk-mnpqr-stvwx')).toBe('ABCDEFGHJKMNPQRSTVWX');
    expect(normaliseRecoveryCode(' ABCDE FGHJK MNPQR STVWX ')).toBe('ABCDEFGHJKMNPQRSTVWX');
    expect(normaliseRecoveryCode('OIL00-00000-00000-00000')).toBe('01100000000000000000');
    for (const bad of [
      '',
      'ABCDE-FGHJK-MNPQR-STVW',
      'ABCDE-FGHJK-MNPQR-STVWXY',
      'ABCDE-FGHJK-MNPQR-STVWU', // U is not in the alphabet
      'ABCDE_FGHJK_MNPQR_STVWX',
      'x'.repeat(65),
      null,
      42,
      {},
    ]) {
      expect(normaliseRecoveryCode(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('hashes are 64 hex chars, depend on tenant and user, and never contain the code', () => {
    const org = uuidv7();
    const user = uuidv7();
    const code = normaliseRecoveryCode(generateRecoveryCodes()[0])!;
    const h = hashRecoveryCode(org, user, code);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(org, user, code)).toBe(h);
    expect(hashRecoveryCode(uuidv7(), user, code)).not.toBe(h);
    expect(hashRecoveryCode(org, uuidv7(), code)).not.toBe(h);
    expect(h).not.toContain(code.toLowerCase());
  });
});
