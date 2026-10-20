import { describe, expect, it } from 'vitest';
import {
  base32Encode,
  generateTotpSecret,
  hotp,
  provisioningUri,
  TOTP_PERIOD_SECONDS,
  totpStep,
  verifyTotp,
} from '../../src/modules/auth/mfa/totp.js';

// RFC 4226 Appendix D and RFC 6238 Appendix B use the ASCII secret "12345678901234567890" (HMAC-SHA1).
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (step: number, offsetMs = 0) => step * TOTP_PERIOD_SECONDS * 1000 + offsetMs;

describe('HOTP (RFC 4226 Appendix D)', () => {
  it('matches all ten published 6-digit values', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((v, counter) => expect(hotp(RFC_SECRET, counter), `C=${counter}`).toBe(v));
  });

  it('refuses invalid counters and digit counts', () => {
    for (const c of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => hotp(RFC_SECRET, c)).toThrow(RangeError);
    for (const d of [0, 5, 9, 6.5]) expect(() => hotp(RFC_SECRET, 0, d)).toThrow(RangeError);
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('T=%i -> %s', (unixSeconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(unixSeconds * 1000), 8)).toBe(code);
  });
});

describe('verifyTotp: policy (6 digits, 30 s, +/- 1 step)', () => {
  const step = 50_000_000;
  const code = (s: number) => hotp(RFC_SECRET, s);

  it('accepts the current step and returns it', () => {
    expect(verifyTotp(RFC_SECRET, code(step), at(step))).toBe(step);
    expect(verifyTotp(RFC_SECRET, code(step), at(step, 29_999))).toBe(step);
  });

  it('time-step boundaries: the last millisecond of a step and the first of the next', () => {
    expect(totpStep(at(step, 29_999))).toBe(step);
    expect(totpStep(at(step + 1))).toBe(step + 1);
  });

  it('tolerates exactly one step of clock skew either way, and not two', () => {
    expect(verifyTotp(RFC_SECRET, code(step - 1), at(step))).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, code(step + 1), at(step))).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, code(step - 2), at(step))).toBeNull();
    expect(verifyTotp(RFC_SECRET, code(step + 2), at(step))).toBeNull();
    // a code that just expired is still accepted for the following 30 s, then never again
    expect(verifyTotp(RFC_SECRET, code(step), at(step + 1, 29_999))).toBe(step);
    expect(verifyTotp(RFC_SECRET, code(step), at(step + 2))).toBeNull();
  });

  it('refuses a wrong code and a code for another secret', () => {
    const wrong = String((Number(code(step)) + 1) % 1_000_000).padStart(6, '0');
    const near = [code(step - 1), code(step), code(step + 1)];
    if (!near.includes(wrong)) expect(verifyTotp(RFC_SECRET, wrong, at(step))).toBeNull();
    expect(verifyTotp(generateTotpSecret(), code(step), at(step))).toBeNull();
  });

  it('refuses malformed input without computing anything', () => {
    for (const bad of [
      '',
      '12345',
      '1234567',
      ' 123456',
      '123456 ',
      '12 456',
      'abcdef',
      '١٢٣٤٥٦', // Arabic-Indic digits are not ASCII digits
      '12345\n',
      null,
      undefined,
      123456,
      ['123456'],
      {},
    ]) {
      expect(verifyTotp(RFC_SECRET, bad, at(step)), JSON.stringify(bad) ?? 'undefined').toBeNull();
    }
  });

  it('refuses a negative or non-finite clock', () => {
    expect(() => verifyTotp(RFC_SECRET, '123456', -1)).toThrow(RangeError);
    expect(() => verifyTotp(RFC_SECRET, '123456', Number.NaN)).toThrow(RangeError);
  });

  it('at time zero only steps 0 and 1 are candidates (no negative counter)', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 0), 0)).toBe(0);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 1), 0)).toBe(1);
  });
});

describe('secrets and provisioning URI', () => {
  it('generates 160-bit secrets that differ every time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toHaveLength(20);
    expect(a.equals(b)).toBe(false);
  });

  it('base32 follows RFC 4648 (test vectors, unpadded)', () => {
    const v: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, enc] of v) expect(base32Encode(Buffer.from(plain))).toBe(enc);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('builds an otpauth URI with the documented parameters and an encoded label', () => {
    const uri = new URL(provisioningUri(RFC_SECRET, 'Anesa', 'a.b+c@example.edu'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Anesa:a.b+c@example.edu');
    expect(uri.searchParams.get('secret')).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri.searchParams.get('issuer')).toBe('Anesa');
    expect(uri.searchParams.get('algorithm')).toBe('SHA1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });
});
