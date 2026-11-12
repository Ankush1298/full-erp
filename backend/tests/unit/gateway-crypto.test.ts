import { describe, expect, it } from 'vitest';
import {
  encryptGatewayCredentials,
  decryptGatewayCredentials,
  maskSecret,
  safeEqual,
} from '../../src/shared/crypto/gateway-crypto.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

describe('gateway-crypto (AES-256-GCM with tenant AAD binding)', () => {
  const tenantA = uuidv7();
  const tenantB = uuidv7();

  it('successfully encrypts and decrypts string credentials round-trip', () => {
    const plaintext = 'example-live-credential-value-9876543210';
    const encrypted = encryptGatewayCredentials(plaintext, tenantA);

    expect(encrypted).not.toBe(plaintext);
    const decrypted = decryptGatewayCredentials<string>(encrypted, tenantA);
    expect(decrypted).toBe(plaintext);
  });

  it('successfully encrypts and decrypts structured JSON credentials round-trip', () => {
    const creds = {
      secret_key: 'example-sec-key-xyz987',
      webhook_secret: 'example-wh-sec-456',
      salt_index: '2',
    };
    const encrypted = encryptGatewayCredentials(creds, tenantA);
    const decrypted = decryptGatewayCredentials<typeof creds>(encrypted, tenantA);

    expect(decrypted).toEqual(creds);
  });

  it('generates a fresh IV for each encryption (different ciphertexts for same payload)', () => {
    const plaintext = 'example-merchant-secret-token';
    const enc1 = encryptGatewayCredentials(plaintext, tenantA);
    const enc2 = encryptGatewayCredentials(plaintext, tenantA);

    expect(enc1).not.toBe(enc2);
  });

  it('fails decryption when decrypted under a different tenant (AAD mismatch)', () => {
    const plaintext = 'example-gateway-credential-abc123';
    const encrypted = encryptGatewayCredentials(plaintext, tenantA);

    expect(() => decryptGatewayCredentials(encrypted, tenantB)).toThrow(
      /Failed to authenticate and decrypt/,
    );
  });

  it('fails decryption when ciphertext or authentication tag is tampered with', () => {
    const plaintext = 'example-confidential-key';
    const encrypted = encryptGatewayCredentials(plaintext, tenantA);

    const raw = Buffer.from(encrypted, 'base64');
    // Flip one byte in ciphertext
    const lastByte = raw[raw.length - 1];
    if (lastByte !== undefined) {
      raw[raw.length - 1] = lastByte ^ 0xff;
    }
    const tampered = raw.toString('base64');

    expect(() => decryptGatewayCredentials(tampered, tenantA)).toThrow(
      /Failed to authenticate and decrypt/,
    );
  });

  it('fails with truncated encrypted payload', () => {
    expect(() => decryptGatewayCredentials('c2hvcnQ=', tenantA)).toThrow();
  });

  describe('maskSecret', () => {
    it('masks normal length secret preserving first 4 and last 4 characters', () => {
      const masked = maskSecret('rzp_test_1234567890abcdef');
      expect(masked).toBe('rzp_••••••••cdef');
    });

    it('masks short secret safely', () => {
      expect(maskSecret('secret')).toBe('••••••••');
      expect(maskSecret('')).toBe('');
      expect(maskSecret(null)).toBe('');
    });
  });

  describe('safeEqual', () => {
    it('returns true for identical strings/buffers', () => {
      expect(safeEqual('sig_valid_123', 'sig_valid_123')).toBe(true);
      expect(safeEqual(Buffer.from('hello'), Buffer.from('hello'))).toBe(true);
    });

    it('returns false for different lengths or contents', () => {
      expect(safeEqual('sig_1', 'sig_2')).toBe(false);
      expect(safeEqual('sig_short', 'sig_very_long')).toBe(false);
    });
  });
});
