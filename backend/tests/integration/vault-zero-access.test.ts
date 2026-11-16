import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import {
  encryptWithDek,
  decryptWithDek,
  buildAad,
  splitSecret,
  reconstructSecret,
} from '../../src/shared/crypto/vault-crypto.js';

const PASSWORD = /* secret-scan:allow */ 'VaultSecurePass123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant;
let HASH = '';

interface Session {
  cookie: string;
  csrf: string;
}

const s = {} as Record<'admin' | 'staff' | 'student' | 'guardian', Session>;

let adminUserId: string;
let staffUserId: string;
let studentUserId: string;
let studentId: string;
let guardianUserId: string;
let guardianId: string;
let vaultEpochId: string;

async function login(email: string, elevate = true): Promise<Session> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(r.statusCode, email).toBe(200);
  const cookie = await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value);
  if (elevate) await elevateSession(cookie);
  return {
    cookie,
    csrf: r.json<{ csrf_token: string }>().csrf_token,
  };
}

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const cols = ['id', 'organization_id', ...Object.keys(row).filter((k) => k !== 'id')];
  const vals = [
    id,
    T.orgId,
    ...Object.entries(row)
      .filter(([k]) => k !== 'id')
      .map(([, v]) => v),
  ];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    vals,
  );
  return id;
}

beforeAll(async () => {
  HASH = await argon2.hash(PASSWORD);
  T = await createIsolatedTenant(HASH);

  adminUserId = T.users.admin;
  staffUserId = T.users.faculty;
  studentUserId = T.users.studentOne;
  studentId = T.students.one;

  // Set student date of birth to 20 years ago (adult student)
  await adminQuery(
    `UPDATE app.users SET date_of_birth = '2004-01-15' WHERE id = $1`,
    [studentUserId],
  );

  // Reset passwords
  await adminQuery(
    `UPDATE platform.identities SET password_hash = $1 WHERE id IN ($2, $3, $4)`,
    [HASH, adminUserId, staffUserId, studentUserId],
  );

  // Create guardian
  guardianUserId = uuidv7();
  const guardianEmail = `guardian.${RUN}@anesa.test`.toLowerCase();
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [guardianUserId, guardianEmail, HASH],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
     VALUES ($1, $2, $3, 'Sunil Verma', 'ACTIVE', $1)`,
    [guardianUserId, T.orgId, guardianEmail],
  );
  guardianId = uuidv7();
  await adminQuery(
    `INSERT INTO app.guardians (id, organization_id, user_id, full_name, phone)
     VALUES ($1, $2, $3, 'Sunil Verma', '+919876543210')`,
    [guardianId, T.orgId, guardianUserId],
  );
  await adminQuery(
    `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
     VALUES ($1, $2, $3, $4, 'Father', true)`,
    [uuidv7(), T.orgId, studentId, guardianId],
  );

  // Login users
  s.admin = await login(T.emails.admin);
  s.staff = await login(T.emails.faculty);
  s.student = await login(T.emails.studentOne);
  s.guardian = await login(guardianEmail);

  // Epoch 1 is initialized
  const epRes = await app.inject({
    method: 'GET',
    url: '/api/v1/vault/epoch',
    headers: {
      cookie: `session_token=${s.admin.cookie}`,
    },
  });
  expect(epRes.statusCode).toBe(200);
  vaultEpochId = epRes.json<{ data: { id: string } }>().data.id;
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe('Anesa School Vault — Zero-Access Cryptographic Architecture & Universal Institution Compatibility', () => {
  // -----------------------------------------------------------------------------------------------
  // 1. Institutional Security Authority (ISA)
  // -----------------------------------------------------------------------------------------------
  describe('Institutional Security Authority (ISA)', () => {
    it('allows college admin to appoint an Institutional Security Authority', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/authority/appoint',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          title: 'COLLEGE_PRINCIPAL',
          userId: adminUserId,
          institutionType: 'COLLEGE',
          notes: 'Appointed pursuant to University Senate Resolution #42',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { title: string; institutionType: string } }>().data;
      expect(data.title).toBe('COLLEGE_PRINCIPAL');
      expect(data.institutionType).toBe('COLLEGE');
    });

    it('retrieves the active Institutional Security Authority', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/authority',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
        },
      });

      expect(r.statusCode).toBe(200);
      const isa = r.json<{ data: { title: string; institution_type: string; status: string } }>().data;
      expect(isa.title).toBe('COLLEGE_PRINCIPAL');
      expect(isa.institution_type).toBe('COLLEGE');
      expect(isa.status).toBe('ACTIVE');
    });

    it('rejects unprivileged staff from appointing security authority (negative check)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/authority/appoint',
        headers: {
          cookie: `session_token=${s.staff.cookie}`,
          'x-csrf-token': s.staff.csrf,
        },
        payload: {
          title: 'COLLEGE_PRINCIPAL',
          userId: staffUserId,
          institutionType: 'COLLEGE',
        },
      });

      expect(r.statusCode).toBe(403);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // 2. Hardware Authenticator Device Cap (Max 2 Devices Policy)
  // -----------------------------------------------------------------------------------------------
  describe('Device-Bound Access & Max 2 Devices Policy', () => {
    let dev1Id: string;

    it('enrolls primary hardware authenticator (device slot 1)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          deviceLabel: 'Admin MacBook Pro Touch ID',
          deviceType: 'PLATFORM_AUTHENTICATOR',
          publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA11111111',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { id: string; deviceNumber: number; status: string } }>().data;
      expect(data.deviceNumber).toBe(1);
      expect(data.status).toBe('ACTIVE');
      dev1Id = data.id;
    });

    it('enrolls secondary hardware authenticator (device slot 2)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          deviceLabel: 'Admin YubiKey 5C NFC',
          deviceType: 'SECURITY_KEY',
          publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA22222222',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { id: string; deviceNumber: number } }>().data;
      expect(data.deviceNumber).toBe(2);
    });

    it('strictly REJECTS 3rd active device enrollment via API (DEVICE_LIMIT_EXCEEDED)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          deviceLabel: 'Unauthorized 3rd Device iPad',
          deviceType: 'PLATFORM_AUTHENTICATOR',
          publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA33333333',
        },
      });

      expect(r.statusCode).toBe(400);
      const body = r.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('DEVICE_LIMIT_EXCEEDED');
    });

    it('enforces device limit invariant at PostgreSQL trigger level against direct insert bypass', async () => {
      // Attempt to bypass API and insert directly as app_runtime
      await expect(
        insert('user_vault_devices', {
          user_id: adminUserId,
          device_number: 3,
          device_label: 'Database Bypass 3rd Device',
          device_type: 'PLATFORM_AUTHENTICATOR',
          status: 'ACTIVE',
          public_key: 'MOCK_KEY_BYPASS_ATTEMPT',
        }),
      ).rejects.toThrow(/DEVICE_LIMIT_EXCEEDED|device_number_check/);
    });

    it('allows replacement enrollment after revoking an existing device', async () => {
      // Revoke device 1
      const revRes = await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${dev1Id}/revoke`,
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: { reason: 'Lost laptop authenticator' },
      });
      expect(revRes.statusCode).toBe(200);

      // Now active devices count = 1. Enrolling replacement should succeed and take slot 1
      const repRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          deviceLabel: 'Replacement MacBook Air Touch ID',
          deviceType: 'PLATFORM_AUTHENTICATOR',
          publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA44444444',
        },
      });

      expect(repRes.statusCode).toBe(201);
      const data = repRes.json<{ data: { deviceNumber: number } }>().data;
      expect(data.deviceNumber).toBe(1);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // 3. True Zero-Access Protected Records (Server Cannot Decrypt)
  // -----------------------------------------------------------------------------------------------
  describe('Zero-Access Protected Records & Cryptographic Verification', () => {
    const rawPlaintext = JSON.stringify({
      studentId: 'st_confidential_01',
      medicalCondition: 'Severe peanut allergy requiring EpiPen',
      disciplinaryNote: 'Exemplary conduct award 2026',
      finalScore: 98.5,
    });

    const dek = randomBytes(32);
    const aad = buildAad({
      tenantId: '01900000-0000-7000-8000-000000000001',
      entityType: 'STUDENT_RECORD',
      entityId: '01900000-0000-7000-8000-000000000099',
      recordVersion: 1,
      epoch: 1,
    });

    it('stores locally encrypted record on server without revealing plaintext', async () => {
      // Local client-side encryption
      const encrypted = encryptWithDek(rawPlaintext, dek, aad);

      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/records',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          vaultEpochId,
          entityType: 'STUDENT_RECORD',
          entityId: '01900000-0000-7000-8000-000000000099',
          capabilityKeyName: 'CWK_STUDENTS_PII',
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.tag,
          aadContext: {
            tenantId: '01900000-0000-7000-8000-000000000001',
            entityType: 'STUDENT_RECORD',
            entityId: '01900000-0000-7000-8000-000000000099',
            recordVersion: 1,
            epoch: 1,
          },
        },
      });

      expect(r.statusCode).toBe(201);

      // Verify the server holds ONLY encrypted ciphertext, zero plaintext
      const dbRow = await adminQuery<{ ciphertext: string }>(
        `SELECT ciphertext FROM app.vault_protected_records
          WHERE organization_id = $1 AND entity_id = '01900000-0000-7000-8000-000000000099'`,
        [T.orgId],
      );
      expect(dbRow[0]?.ciphertext).toBe(encrypted.ciphertext);
      expect(dbRow[0]?.ciphertext).not.toContain('peanut allergy');
      expect(dbRow[0]?.ciphertext).not.toContain('Exemplary');
    });

    it('retrieves ciphertext envelope and client decrypts locally', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/records/STUDENT_RECORD/01900000-0000-7000-8000-000000000099',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
        },
      });

      expect(r.statusCode).toBe(200);
      const envelope = r.json<{ data: { ciphertext: string; iv: string; authTag: string } }>().data;

      // Local decryption on client
      const decrypted = decryptWithDek(
        { ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.authTag },
        dek,
        aad,
      ).toString('utf8');
      expect(decrypted).toBe(rawPlaintext);
      expect(JSON.parse(decrypted).medicalCondition).toBe('Severe peanut allergy requiring EpiPen');
    });

    it('detects tampering: corrupted ciphertext fails local decryption with authentication tag mismatch', () => {
      const encrypted = encryptWithDek(rawPlaintext, dek, aad);
      const corruptedBuf = Buffer.from(encrypted.ciphertext, 'base64');
      corruptedBuf[0] = (corruptedBuf[0] ?? 0) ^ 0x01; // Tamper with 1 bit
      const tampered = { ...encrypted, ciphertext: corruptedBuf.toString('base64') };

      expect(() => decryptWithDek(tampered, dek, aad)).toThrowError(
        expect.objectContaining({ code: 'VAULT_DECRYPTION_FAILED' }),
      );
    });
  });

  // -----------------------------------------------------------------------------------------------
  // 4. 2-of-3 Recovery Quorum (Zero Backdoor Architecture)
  // -----------------------------------------------------------------------------------------------
  describe('2-of-3 Shamir Recovery Quorum Ceremony', () => {
    let ceremonyId: string;
    const mockSmek = randomBytes(32);
    const shares = splitSecret(mockSmek, 3, 2);

    it('configures 3 institutional recovery custodians for the epoch', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/custodians',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          vaultEpochId,
          custodians: [
            { custodianName: 'Board of Trustees Chair', custodianRole: 'Institutional Oversight', shareIndex: 1 },
            { custodianName: 'Senior Legal Counsel', custodianRole: 'Legal Custodian', shareIndex: 2 },
            { custodianName: 'Institutional Registrar', custodianRole: 'Academic Operations', shareIndex: 3 },
          ],
        },
      });

      expect(r.statusCode).toBe(200);
      expect(r.json<{ data: { count: number } }>().data.count).toBe(3);
    });

    it('initiates 2-of-3 recovery ceremony', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/ceremony',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          vaultEpochId,
          targetUserId: adminUserId,
          reason: 'Emergency cryptographic recovery drill',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { ceremonyId: string; status: string; requiredShares: number } }>().data;
      expect(data.status).toBe('IN_PROGRESS');
      expect(data.requiredShares).toBe(2);
      ceremonyId = data.ceremonyId;
    });

    it('presents share 1: ceremony remains IN_PROGRESS', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/share',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          ceremonyId,
          shareIndex: shares[0]!.index,
          shareData: shares[0]!.data,
        },
      });

      expect(r.statusCode).toBe(200);
      const data = r.json<{ data: { sharesPresented: number; isComplete: boolean; status: string } }>().data;
      expect(data.sharesPresented).toBe(1);
      expect(data.isComplete).toBe(false);
      expect(data.status).toBe('IN_PROGRESS');
    });

    it('rejects presenting duplicate share 1 from same custodian (DUPLICATE_SHARE)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/share',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          ceremonyId,
          shareIndex: shares[0]!.index,
          shareData: shares[0]!.data,
        },
      });

      expect(r.statusCode).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('DUPLICATE_SHARE');
    });

    it('presents share 2: ceremony reaches 2-of-3 quorum and completes (COMPLETED)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/share',
        headers: {
          cookie: `session_token=${s.admin.cookie}`,
          'x-csrf-token': s.admin.csrf,
        },
        payload: {
          ceremonyId,
          shareIndex: shares[1]!.index,
          shareData: shares[1]!.data,
        },
      });

      expect(r.statusCode).toBe(200);
      const data = r.json<{ data: { sharesPresented: number; isComplete: boolean; status: string } }>().data;
      expect(data.sharesPresented).toBe(2);
      expect(data.isComplete).toBe(true);
      expect(data.status).toBe('COMPLETED');

      // Local reconstruction on authorized client verifies exact key recovery
      const recoveredKey = reconstructSecret([shares[0]!, shares[1]!]);
      expect(recoveredKey).toEqual(mockSmek);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // 5. Adult Student Privacy Protection (Higher Ed / Universal Compatibility)
  // -----------------------------------------------------------------------------------------------
  describe('Adult Student Privacy Guard (College / University)', () => {
    let consentId: string;

    it('blocks guardian access to adult student records without explicit student consent', async () => {
      // In COLLEGE organization, student age >= 18 requires consent
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${studentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });

      expect(r.statusCode).toBe(403);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('ADULT_STUDENT_PRIVACY_RESTRICTION');
    });

    it('allows adult student to grant explicit access consent to guardian', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/adult-consents',
        headers: {
          cookie: `session_token=${s.student.cookie}`,
          'x-csrf-token': s.student.csrf,
        },
        payload: {
          guardianId,
          consentScope: 'ALL',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { consentId: string; status: string } }>().data;
      expect(data.status).toBe('ACTIVE');
      consentId = data.consentId;
    });

    it('permits guardian access to adult student records once valid consent is granted', async () => {
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${studentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });

      expect(r.statusCode).toBe(200);
      const summary = r.json<{ data: { child: { studentId: string } } }>().data;
      expect(summary.child.studentId).toBe(studentId);
    });

    it('immediately re-blocks guardian when adult student revokes consent', async () => {
      const revRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/vault/adult-consents/${consentId}`,
        headers: {
          cookie: `session_token=${s.student.cookie}`,
          'x-csrf-token': s.student.csrf,
        },
      });
      expect(revRes.statusCode).toBe(200);

      // Attempt guardian access again -> immediately blocked
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${studentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });

      expect(r.statusCode).toBe(403);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('ADULT_STUDENT_PRIVACY_RESTRICTION');
    });
  });
});
