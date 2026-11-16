/**
 * Client-Side Vault Cryptographic Engine & Local Academic Processing.
 * In Anesa Zero-Access Vault, sensitive records (marks, medical, disciplinary, PII)
 * are NEVER decrypted on the server. All calculations and decryptions occur locally
 * inside the authorized user's browser/hardware-bound device session.
 */

export interface EncryptedRecordEnvelope {
  ciphertext: string; // Base64
  iv: string; // Base64
  authTag: string; // Base64
  aadContext: Record<string, unknown>;
}

export interface ClientCalculatedStanding {
  institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
  totalMaxMarks: number;
  totalObtainedMarks: number;
  percentage: number;
  letterGrade: string;
  sgpa?: number | undefined;
  totalCredits?: number | undefined;
  verificationDigest: string; // SHA-256 digest of calculated standing
}

export class VaultClientCrypto {
  /**
   * Generates a device-bound ECDH P-256 keypair using standard WebCrypto.
   */
  static async generateDeviceKeyPair(): Promise<{
    publicKeySpki: string;
    privateKeyPkcs8: string;
  }> {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      true,
      ['deriveKey', 'deriveBits'],
    );

    const spkiBuffer = await window.crypto.subtle.exportKey('spki', keyPair.publicKey);
    const pkcs8Buffer = await window.crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

    return {
      publicKeySpki: btoa(String.fromCharCode(...new Uint8Array(spkiBuffer))),
      privateKeyPkcs8: btoa(String.fromCharCode(...new Uint8Array(pkcs8Buffer))),
    };
  }

  /**
   * Computes SHA-256 digest of string data for integrity and audit verification.
   */
  static async computeDigest(data: string): Promise<string> {
    const enc = new TextEncoder().encode(data);
    const hashBuf = await window.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Independent client-side academic calculation and standing determination.
   * Runs locally on the client device after local decryption of component marks.
   */
  static async computeStanding(
    institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY',
    courses: Array<{
      courseId: string;
      maxMarks: number;
      obtainedMarks: number;
      credits?: number;
    }>,
  ): Promise<ClientCalculatedStanding> {
    let totalMax = 0;
    let totalObtained = 0;
    let totalCredits = 0;
    let totalWeightedPoints = 0;

    for (const c of courses) {
      totalMax += c.maxMarks;
      totalObtained += c.obtainedMarks;
      const credits = c.credits ?? 3;
      totalCredits += credits;

      const pct = c.maxMarks > 0 ? (c.obtainedMarks / c.maxMarks) * 100 : 0;
      let gp = 0;
      if (pct >= 90) gp = 10;
      else if (pct >= 80) gp = 9;
      else if (pct >= 70) gp = 8;
      else if (pct >= 60) gp = 7;
      else if (pct >= 50) gp = 6;
      else if (pct >= 40) gp = 5;

      totalWeightedPoints += gp * credits;
    }

    const percentage = totalMax > 0 ? Math.round((totalObtained / totalMax) * 10000) / 100 : 0;

    let letterGrade = 'F';
    if (percentage >= 90) letterGrade = 'A+';
    else if (percentage >= 80) letterGrade = 'A';
    else if (percentage >= 70) letterGrade = 'B';
    else if (percentage >= 60) letterGrade = 'C';
    else if (percentage >= 50) letterGrade = 'D';

    const sgpa =
      institutionType === 'UNIVERSITY' && totalCredits > 0
        ? Math.round((totalWeightedPoints / totalCredits) * 100) / 100
        : undefined;

    const digestPayload = JSON.stringify({
      institutionType,
      totalMax,
      totalObtained,
      percentage,
      letterGrade,
      sgpa,
      coursesCount: courses.length,
    });

    const verificationDigest = await this.computeDigest(digestPayload);

    return {
      institutionType,
      totalMaxMarks: totalMax,
      totalObtainedMarks: totalObtained,
      percentage,
      letterGrade,
      sgpa,
      totalCredits: institutionType !== 'SCHOOL' ? totalCredits : undefined,
      verificationDigest,
    };
  }
}
