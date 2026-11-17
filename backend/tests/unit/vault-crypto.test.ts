import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAad,
  decryptWithDek,
  encryptWithDek,
  generateChallenge,
  generateDeviceSigningKeyPair,
  hashAad,
  reconstructSecret,
  signChallenge,
  splitSecret,
  unwrapKeyWithDevice,
  verifyDeviceSignature,
  wrapKeyForDevice,
} from '../../src/shared/crypto/vault-crypto.js';
import { createECDH } from 'node:crypto';

describe('Vault Cryptographic Primitives', () => {
  const tenantId = '01900000-0000-7000-8000-000000000001';
  const entityType = 'EXAM_MARK';
  const entityId = '01900000-0000-7000-8000-000000000099';
  const recordVersion = 1;
  const epoch = 1;

  const aad = buildAad({ tenantId, entityType, entityId, recordVersion, epoch });
  const dek = randomBytes(32); // 256-bit AES key
  const plaintext = Buffer.from('Confidential: Final Mark = 95/100, Grade = A+', 'utf8');

  it('encrypts and decrypts with AES-256-GCM and valid AAD', () => {
    const encrypted = encryptWithDek(plaintext, dek, aad);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    expect(encrypted.aadFingerprint).toBe(hashAad(aad));

    const decrypted = decryptWithDek(encrypted, dek, aad);
    expect(decrypted.toString('utf8')).toBe('Confidential: Final Mark = 95/100, Grade = A+');
  });

  it('rejects decryption when ciphertext is tampered with', () => {
    const encrypted = encryptWithDek(plaintext, dek, aad);
    const rawCipher = Buffer.from(encrypted.ciphertext, 'base64');
    rawCipher[0] = (rawCipher[0] ?? 0) ^ 0xff; // Flip bits
    const tampered = { ...encrypted, ciphertext: rawCipher.toString('base64') };

    expect(() => decryptWithDek(tampered, dek, aad)).toThrowError(
      expect.objectContaining({ code: 'VAULT_DECRYPTION_FAILED' }),
    );
  });

  it('rejects decryption when AAD does not match (cross-tenant or cross-entity replay attack)', () => {
    const encrypted = encryptWithDek(plaintext, dek, aad);
    const forgedAad = buildAad({
      tenantId: '01900000-0000-7000-8000-000000000002', // Different tenant
      entityType,
      entityId,
      recordVersion,
      epoch,
    });

    expect(() => decryptWithDek(encrypted, dek, forgedAad)).toThrowError(
      expect.objectContaining({ code: 'VAULT_DECRYPTION_FAILED' }),
    );
  });

  it('wraps and unwraps keys using ECDH P-256 device keypair', () => {
    const deviceEcdh = createECDH('prime256v1');
    deviceEcdh.generateKeys();
    const devPub = deviceEcdh.getPublicKey().toString('base64');
    const devPriv = deviceEcdh.getPrivateKey().toString('base64');

    const keyToWrap = randomBytes(32);
    const wrapped = wrapKeyForDevice(keyToWrap, devPub);

    const unwrapped = unwrapKeyWithDevice(wrapped, devPriv);
    expect(unwrapped).toEqual(keyToWrap);
  });

  describe('Shamir 2-of-3 Recovery Quorum', () => {
    const smek = randomBytes(32); // 256-bit School Master Epoch Key

    it('splits secret into 3 shares and any 2 shares reconstruct the exact secret', () => {
      const shares = splitSecret(smek, 3, 2);
      expect(shares).toHaveLength(3);
      const s1 = shares[0]!;
      const s2 = shares[1]!;
      const s3 = shares[2]!;

      expect(s1.index).toBe(1);
      expect(s2.index).toBe(2);
      expect(s3.index).toBe(3);

      // Reconstruct using (1, 2)
      const r12 = reconstructSecret([s1, s2]);
      expect(r12).toEqual(smek);

      // Reconstruct using (2, 3)
      const r23 = reconstructSecret([s2, s3]);
      expect(r23).toEqual(smek);

      // Reconstruct using (1, 3)
      const r13 = reconstructSecret([s1, s3]);
      expect(r13).toEqual(smek);
    });

    it('rejects reconstruction with fewer than 2 shares', () => {
      const shares = splitSecret(smek, 3, 2);
      const s1 = shares[0]!;
      expect(() => reconstructSecret([s1])).toThrowError(
        expect.objectContaining({ code: 'INSUFFICIENT_SHARES' }),
      );
    });

    it('rejects reconstruction when presenting duplicate shares from the same custodian', () => {
      const shares = splitSecret(smek, 3, 2);
      const s1 = shares[0]!;
      expect(() => reconstructSecret([s1, s1])).toThrowError(
        expect.objectContaining({ code: 'DUPLICATE_SHARES' }),
      );
    });
  });

  describe('WebAuthn / FIDO2 Challenge-Response Verification', () => {
    it('generates a 64-character hex challenge', () => {
      const challenge = generateChallenge();
      expect(challenge).toHaveLength(64);
      expect(/^[0-9a-f]+$/.test(challenge)).toBe(true);
    });

    it('signs and verifies a challenge using hardware device keypair', () => {
      const { publicKeySpki, privateKeyPkcs8 } = generateDeviceSigningKeyPair();
      const challenge = generateChallenge();

      const signature = signChallenge(privateKeyPkcs8, challenge);
      expect(signature).toBeDefined();

      const isValid = verifyDeviceSignature(publicKeySpki, challenge, signature);
      expect(isValid).toBe(true);
    });

    it('rejects verification if challenge is modified or forged', () => {
      const { publicKeySpki, privateKeyPkcs8 } = generateDeviceSigningKeyPair();
      const challenge = generateChallenge();

      const signature = signChallenge(privateKeyPkcs8, challenge);
      const isForgedValid = verifyDeviceSignature(
        publicKeySpki,
        'different-challenge-12345',
        signature,
      );
      expect(isForgedValid).toBe(false);
    });

    it('rejects verification if signed by a different device key', () => {
      const device1 = generateDeviceSigningKeyPair();
      const device2 = generateDeviceSigningKeyPair();
      const challenge = generateChallenge();

      const signature = signChallenge(device2.privateKeyPkcs8, challenge);
      const isValid = verifyDeviceSignature(device1.publicKeySpki, challenge, signature);
      expect(isValid).toBe(false);
    });
  });
});
