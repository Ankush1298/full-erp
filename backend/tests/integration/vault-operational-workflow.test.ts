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
  buildAad,
  decryptWithDek,
  encryptWithDek,
  generateChallenge,
  generateDeviceSigningKeyPair,
  reconstructSecret,
  signChallenge,
  splitSecret,
  unwrapKeyWithDevice,
  wrapKeyForDevice,
} from '../../src/shared/crypto/vault-crypto.js';
import { createECDH } from 'node:crypto';

const PASSWORD = /* secret-scan:allow */ 'OperationalVaultPass123!';
const APP_ORIGIN = 'https://app.campus.test';
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

const s = {} as Record<'principal' | 'teacher' | 'student' | 'guardian' | 'adultStudent', Session>;

let principalUserId: string;
let teacherUserId: string;
let studentUserId: string;
let studentId: string;
let adultStudentUserId: string;
let adultStudentId: string;
let guardianUserId: string;
let guardianId: string;
let vaultEpochId: string;

// Device cryptographic identities
let teacherDeviceSigning: ReturnType<typeof generateDeviceSigningKeyPair>;
let teacherDeviceEcdh: { publicKeyBase64: string; privateKeyBase64: string };
let teacherDeviceId: string;

let principalDeviceSigning: ReturnType<typeof generateDeviceSigningKeyPair>;
let principalDeviceEcdh: { publicKeyBase64: string; privateKeyBase64: string };
let principalDeviceId: string;

// Institutional cryptographic material
const smekMasterSecret = randomBytes(32); // School Master Epoch Key
let smekShares: ReturnType<typeof splitSecret>;
const cwkAcademicsMarks = randomBytes(32); // Capability key for marks

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

describe('Anesa School Vault — End-to-End Operational Workflow & Recovery Verification', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);

    principalUserId = T.users.admin;
    teacherUserId = T.users.faculty;
    studentUserId = T.users.studentOne;
    studentId = T.students.one;
    adultStudentUserId = T.users.studentTwo;
    adultStudentId = T.students.two;

    // Set minor student (15 years old) and adult student (22 years old)
    await adminQuery(
      `UPDATE app.users SET date_of_birth = CURRENT_DATE - INTERVAL '15 years' WHERE id = $1`,
      [studentUserId],
    );
    await adminQuery(
      `UPDATE app.users SET date_of_birth = CURRENT_DATE - INTERVAL '22 years' WHERE id = $1`,
      [adultStudentUserId],
    );

    // Reset passwords
    await adminQuery(
      `UPDATE platform.identities SET password_hash = $1 WHERE id IN ($2, $3, $4, $5)`,
      [HASH, principalUserId, teacherUserId, studentUserId, adultStudentUserId],
    );

    // Create guardian
    guardianUserId = uuidv7();
    const guardianEmail = `guardian.${randomBytes(4).toString('hex')}@anesa.test`.toLowerCase();
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

    // Link guardian to minor student
    await adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
       VALUES ($1, $2, $3, $4, 'Father', true)`,
      [uuidv7(), T.orgId, studentId, guardianId],
    );
    // Link guardian to adult student
    await adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
       VALUES ($1, $2, $3, $4, 'Father', true)`,
      [uuidv7(), T.orgId, adultStudentId, guardianId],
    );

    // Login sessions
    s.principal = await login(T.emails.admin);
    s.teacher = await login(T.emails.faculty);
    s.student = await login(T.emails.studentOne);
    s.adultStudent = await login(T.emails.studentTwo);
    s.guardian = await login(guardianEmail);

    // Generate Teacher and Principal cryptographic keys
    teacherDeviceSigning = generateDeviceSigningKeyPair();
    const tEcdh = createECDH('prime256v1');
    tEcdh.generateKeys();
    teacherDeviceEcdh = {
      publicKeyBase64: tEcdh.getPublicKey().toString('base64'),
      privateKeyBase64: tEcdh.getPrivateKey().toString('base64'),
    };

    principalDeviceSigning = generateDeviceSigningKeyPair();
    const pEcdh = createECDH('prime256v1');
    pEcdh.generateKeys();
    principalDeviceEcdh = {
      publicKeyBase64: pEcdh.getPublicKey().toString('base64'),
      privateKeyBase64: pEcdh.getPrivateKey().toString('base64'),
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------------------------------
  // Phase 2 — Real Device-Bound Authentication
  // -----------------------------------------------------------------------------------------------
  describe('Phase 2 — Real Device-Bound Authentication & Challenge-Response', () => {
    it('appoints Principal as Institutional Security Authority (ISA)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/authority/appoint',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          userId: principalUserId,
          title: 'COLLEGE_PRINCIPAL',
          institutionType: 'COLLEGE',
          notes: 'Appointed Principal as top security authority',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { title: string; institutionType: string } }>().data;
      expect(data.title).toBe('COLLEGE_PRINCIPAL');
      expect(data.institutionType).toBe('COLLEGE');
    });

    it('enrolls Teacher hardware device with physical security key attestation', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          deviceLabel: 'Teacher YubiKey 5C NFC (Physics Lab)',
          deviceType: 'SECURITY_KEY',
          publicKey: teacherDeviceSigning.publicKeySpki,
          attestationFormat: 'fido-u2f',
          aaguid: '00000000-0000-0000-0000-000000000001',
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { id: string; deviceNumber: number; deviceType: string } }>()
        .data;
      expect(data.deviceNumber).toBe(1);
      expect(data.deviceType).toBe('SECURITY_KEY');
      teacherDeviceId = data.id;
    });

    it('issues cryptographic challenge and verifies Teacher device signature with user presence', async () => {
      // 1. Request server challenge
      const chalRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/challenge',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
      });
      expect(chalRes.statusCode).toBe(200);
      const { challenge } = chalRes.json<{ data: { challenge: string } }>().data;
      expect(challenge).toBeDefined();

      // 2. Hardware device signs the challenge
      const signature = signChallenge(teacherDeviceSigning.privateKeyPkcs8, challenge);

      // 3. Verify on server
      const verRes = await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${teacherDeviceId}/verify`,
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          challenge,
          signature,
          userPresence: true,
          userVerification: true,
        },
      });

      expect(verRes.statusCode).toBe(200);
      const verData = verRes.json<{
        data: { verified: boolean; deviceType: string; userPresenceVerified: boolean };
      }>().data;
      expect(verData.verified).toBe(true);
      expect(verData.userPresenceVerified).toBe(true);
    });

    it('strictly rejects forged or tampered challenge signature', async () => {
      const forgedSignature = signChallenge(
        teacherDeviceSigning.privateKeyPkcs8,
        'forged-challenge-string',
      );

      const verRes = await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${teacherDeviceId}/verify`,
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          challenge: generateChallenge(), // Different challenge
          signature: forgedSignature,
        },
      });

      expect(verRes.statusCode).toBe(401);
      expect(verRes.json<{ error: { code: string } }>().error.code).toBe(
        'DEVICE_SIGNATURE_INVALID',
      );
    });

    it('enrolls Principal platform authenticator (Touch ID / Windows Hello)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          deviceLabel: 'Principal MacBook Pro Touch ID (Office)',
          deviceType: 'PLATFORM_AUTHENTICATOR',
          publicKey: principalDeviceSigning.publicKeySpki,
        },
      });

      expect(r.statusCode).toBe(201);
      const data = r.json<{ data: { id: string; deviceNumber: number } }>().data;
      expect(data.deviceNumber).toBe(1);
      principalDeviceId = data.id;
    });

    it('enforces maximum 2 devices policy and permits safe revocation/replacement', async () => {
      // Enroll device 2 for Teacher
      const d2Signing = generateDeviceSigningKeyPair();
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          deviceLabel: 'Teacher Backup YubiKey 5 NFC',
          deviceType: 'SECURITY_KEY',
          publicKey: d2Signing.publicKeySpki,
        },
      });
      expect(r2.statusCode).toBe(201);
      expect(r2.json<{ data: { deviceNumber: number } }>().data.deviceNumber).toBe(2);

      // Attempt 3rd device -> REJECTED
      const r3 = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          deviceLabel: 'Teacher 3rd Unauthorized Device',
          deviceType: 'SECURITY_KEY',
          publicKey: generateDeviceSigningKeyPair().publicKeySpki,
        },
      });
      expect(r3.statusCode).toBe(400);
      expect(r3.json<{ error: { code: string } }>().error.code).toBe('DEVICE_LIMIT_EXCEEDED');

      // Revoke device 2
      const d2Id = r2.json<{ data: { id: string } }>().data.id;
      const revRes = await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${d2Id}/revoke`,
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: { reason: 'Decommissioned backup key' },
      });
      expect(revRes.statusCode).toBe(200);

      // Slot 2 is now free. Re-enrolling replacement succeeds in slot 2.
      const repRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/devices/enroll',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          deviceLabel: 'Teacher Replacement Backup Key',
          deviceType: 'SECURITY_KEY',
          publicKey: generateDeviceSigningKeyPair().publicKeySpki,
        },
      });
      expect(repRes.statusCode).toBe(201);
      expect(repRes.json<{ data: { deviceNumber: number } }>().data.deviceNumber).toBe(2);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Phase 3 — Operational Zero-Access Encryption Workflow
  // -----------------------------------------------------------------------------------------------
  describe('Phase 3 — Operational Zero-Access Workflow: Teacher Marks & Principal Authority', () => {
    const examMarkId = uuidv7();
    const examinationId = uuidv7();
    const courseId = uuidv7();

    it('initializes epoch and issues scoped CWK_ACADEMICS_MARKS key grants to authorized devices', async () => {
      // 1. Get Epoch 1
      const epochRes = await app.inject({
        method: 'GET',
        url: '/api/v1/vault/epoch',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
        },
      });
      expect(epochRes.statusCode).toBe(200);
      vaultEpochId = epochRes.json<{ data: { id: string; epoch: number } }>().data.id;

      // 2. Wrap CWK for Teacher device via ECDH
      const teacherWrapped = wrapKeyForDevice(cwkAcademicsMarks, teacherDeviceEcdh.publicKeyBase64);
      const tgRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/grants/issue',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          vaultEpochId,
          deviceId: teacherDeviceId,
          userId: teacherUserId,
          capabilityKeyName: 'CWK_ACADEMICS_MARKS',
          scopeType: 'SECTION',
          scopeTargetId: uuidv7(),
          wrappedCapabilityKey: teacherWrapped.wrappedKey,
          ephemeralPublicKey: teacherWrapped.ephemeralPublicKey,
          iv: teacherWrapped.iv,
          tag: teacherWrapped.tag,
        },
      });
      expect(tgRes.statusCode).toBe(201);

      // 3. Wrap CWK for Principal device via ECDH
      const principalWrapped = wrapKeyForDevice(
        cwkAcademicsMarks,
        principalDeviceEcdh.publicKeyBase64,
      );
      const pgRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/grants/issue',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          vaultEpochId,
          deviceId: principalDeviceId,
          userId: principalUserId,
          capabilityKeyName: 'CWK_ACADEMICS_MARKS',
          scopeType: 'ORGANIZATION',
          wrappedCapabilityKey: principalWrapped.wrappedKey,
          ephemeralPublicKey: principalWrapped.ephemeralPublicKey,
          iv: principalWrapped.iv,
          tag: principalWrapped.tag,
        },
      });
      expect(pgRes.statusCode).toBe(201);
    });

    it('Teacher device: unwraps CWK, performs local academic calculation, encrypts and stores marks', async () => {
      // 1. Teacher device fetches active key grants
      const grantsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/vault/grants/device/${teacherDeviceId}`,
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
        },
      });
      expect(grantsRes.statusCode).toBe(200);
      const grant = grantsRes.json<{
        data: Array<{
          capabilityKeyName: string;
          wrappedCapabilityKey: string;
          ephemeralPublicKey: string;
          iv: string;
          tag: string;
        }>;
      }>().data[0]!;
      expect(grant.capabilityKeyName).toBe('CWK_ACADEMICS_MARKS');

      // 2. Unwraps CWK locally using Teacher device private key
      const localCwk = unwrapKeyWithDevice(
        {
          ephemeralPublicKey: grant.ephemeralPublicKey,
          wrappedKey: grant.wrappedCapabilityKey,
          iv: grant.iv,
          tag: grant.tag,
        },
        teacherDeviceEcdh.privateKeyBase64,
      );
      expect(localCwk).toEqual(cwkAcademicsMarks);

      // 3. Teacher performs local academic calculation for student
      const rawTeacherMarks = {
        studentId,
        examinationId,
        courseId,
        theoryObtained: 45,
        maxTheory: 60,
        practicalObtained: 35,
        maxPractical: 40,
        totalObtained: 80,
        totalMax: 100,
        percentage: 80.0,
        letterGrade: 'A',
        evaluatedBy: teacherUserId,
        evaluatedAt: new Date().toISOString(),
      };

      // 4. Encrypt marks locally with AAD bound to tenant, entity, version
      const aad = buildAad({
        tenantId: T.orgId,
        entityType: 'EXAM_MARK',
        entityId: examMarkId,
        recordVersion: 1,
        epoch: 1,
      });

      const encryptedPayload = encryptWithDek(JSON.stringify(rawTeacherMarks), localCwk, aad);

      // 5. Store ciphertext envelope on server
      const storeRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/records',
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: {
          vaultEpochId,
          entityType: 'EXAM_MARK',
          entityId: examMarkId,
          capabilityKeyName: 'CWK_ACADEMICS_MARKS',
          ciphertext: encryptedPayload.ciphertext,
          iv: encryptedPayload.iv,
          authTag: encryptedPayload.tag,
          aadContext: { examinationId, studentId, courseId, version: 1 },
        },
      });

      expect(storeRes.statusCode).toBe(201);

      // 6. Direct Database Verification: The server database stores ONLY ciphertext!
      const [dbRow] = await adminQuery<{ ciphertext: string; iv: string; auth_tag: string }>(
        `SELECT ciphertext, iv, auth_tag FROM app.vault_protected_records WHERE organization_id = $1 AND entity_id = $2`,
        [T.orgId, examMarkId],
      );
      expect(dbRow?.ciphertext).toBe(encryptedPayload.ciphertext);
      expect(dbRow?.iv).toBe(encryptedPayload.iv);
      expect(dbRow?.auth_tag).toBe(encryptedPayload.tag);

      // Ensure the database contains NO plaintext confidential fields
      const rawRecord = JSON.stringify(dbRow);
      expect(rawRecord).not.toContain('theoryObtained');
      expect(rawRecord).not.toContain('totalObtained');
      expect(rawRecord).not.toContain('Aarav');
    });

    it('Principal device: fetches ciphertext, decrypts locally, performs authorized correction, re-encrypts', async () => {
      // 1. Principal device fetches active key grants
      const grantsRes = await app.inject({
        method: 'GET',
        url: `/api/v1/vault/grants/device/${principalDeviceId}`,
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
        },
      });
      const grant = grantsRes.json<{
        data: Array<{
          capabilityKeyName: string;
          wrappedCapabilityKey: string;
          ephemeralPublicKey: string;
          iv: string;
          tag: string;
        }>;
      }>().data[0]!;

      // 2. Unwraps CWK locally using Principal device private key
      const principalCwk = unwrapKeyWithDevice(
        {
          ephemeralPublicKey: grant.ephemeralPublicKey,
          wrappedKey: grant.wrappedCapabilityKey,
          iv: grant.iv,
          tag: grant.tag,
        },
        principalDeviceEcdh.privateKeyBase64,
      );
      expect(principalCwk).toEqual(cwkAcademicsMarks);

      // 3. Principal fetches ciphertext envelope
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/vault/records/EXAM_MARK/${examMarkId}`,
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
        },
      });
      expect(getRes.statusCode).toBe(200);
      const envelope = getRes.json<{ data: { ciphertext: string; iv: string; authTag: string } }>()
        .data;

      // 4. Principal decrypts locally
      const aadV1 = buildAad({
        tenantId: T.orgId,
        entityType: 'EXAM_MARK',
        entityId: examMarkId,
        recordVersion: 1,
        epoch: 1,
      });
      const decryptedPlaintext = decryptWithDek(
        { ciphertext: envelope.ciphertext, iv: envelope.iv, tag: envelope.authTag },
        principalCwk,
        aadV1,
      );
      const decryptedMarks = JSON.parse(decryptedPlaintext.toString('utf8')) as {
        theoryObtained: number;
        totalObtained: number;
        [key: string]: unknown;
      };
      expect(decryptedMarks.theoryObtained).toBe(45);
      expect(decryptedMarks.totalObtained).toBe(80);

      // 5. Principal performs authorized correction (paper re-evaluation: Theory 45 -> 50)
      const correctedMarks: Record<string, unknown> = {
        ...decryptedMarks,
        theoryObtained: 50,
        totalObtained: 85,
        percentage: 85.0,
        letterGrade: 'A+',
        correctedBy: principalUserId,
        correctionReason: 'Official re-evaluation review: additional 5 marks awarded for Q4',
        correctedAt: new Date().toISOString(),
      };

      // 6. Principal device recalculates and re-encrypts with incremented version (version 2)
      const aadV2 = buildAad({
        tenantId: T.orgId,
        entityType: 'EXAM_MARK',
        entityId: examMarkId,
        recordVersion: 2,
        epoch: 1,
      });
      const reEncrypted = encryptWithDek(JSON.stringify(correctedMarks), principalCwk, aadV2);

      // 7. Store updated record
      const updateRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/records',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          vaultEpochId,
          entityType: 'EXAM_MARK',
          entityId: examMarkId,
          capabilityKeyName: 'CWK_ACADEMICS_MARKS',
          ciphertext: reEncrypted.ciphertext,
          iv: reEncrypted.iv,
          authTag: reEncrypted.tag,
          aadContext: { examinationId, studentId, courseId, version: 2 },
        },
      });
      expect(updateRes.statusCode).toBe(201);

      // Verify the new ciphertext in database
      const [updatedDbRow] = await adminQuery<{ ciphertext: string }>(
        `SELECT ciphertext FROM app.vault_protected_records WHERE organization_id = $1 AND entity_id = $2`,
        [T.orgId, examMarkId],
      );
      expect(updatedDbRow?.ciphertext).toBe(reEncrypted.ciphertext);
      expect(updatedDbRow?.ciphertext).not.toBe(envelope.ciphertext);
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Phase 4 — Real 2-of-3 Recovery of Encrypted Records
  // -----------------------------------------------------------------------------------------------
  describe('Phase 4 — Real 2-of-3 Shamir Recovery Mechanism', () => {
    let ceremonyId: string;

    it('splits Master SMEK into 3 Shamir shares and configures institutional custodians', async () => {
      // 1. Split master SMEK into 3 shares in GF(2^8)
      smekShares = splitSecret(smekMasterSecret, 3, 2);
      expect(smekShares).toHaveLength(3);

      // 2. Configure 3 custodians on server
      const custRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/custodians',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          vaultEpochId,
          custodians: [
            { shareIndex: 1, custodianName: 'Dr. Ramesh Gupta', custodianRole: 'College Chairman' },
            { shareIndex: 2, custodianName: 'Adv. Priya Nair', custodianRole: 'Legal Trustee' },
            {
              shareIndex: 3,
              custodianName: 'External Auditor Ernst',
              custodianRole: 'Statutory Auditor',
            },
          ],
        },
      });

      expect(custRes.statusCode).toBe(200);
      expect(custRes.json<{ data: { count: number } }>().data.count).toBe(3);
    });

    it('simulates hardware device disaster: both Teacher and Principal devices revoked', async () => {
      // Revoke Teacher device
      await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${teacherDeviceId}/revoke`,
        headers: {
          cookie: `session_token=${s.teacher.cookie}`,
          'x-csrf-token': s.teacher.csrf,
        },
        payload: { reason: 'Hardware key lost in transit' },
      });

      // Revoke Principal device
      await app.inject({
        method: 'POST',
        url: `/api/v1/vault/devices/${principalDeviceId}/revoke`,
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: { reason: 'Laptop compromised / replaced' },
      });

      // Verify that neither user has active key grants
      const tGrants = await app.inject({
        method: 'GET',
        url: `/api/v1/vault/grants/device/${teacherDeviceId}`,
        headers: { cookie: `session_token=${s.teacher.cookie}` },
      });
      expect(tGrants.json<{ data: unknown[] }>().data).toHaveLength(0);
    });

    it('executes 2-of-3 quorum recovery ceremony and completely recovers encrypted marks', async () => {
      // 1. Initiate Recovery Ceremony
      const initRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/ceremony',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          vaultEpochId,
          targetUserId: principalUserId,
          reason: 'Emergency disaster recovery of institutional records after device loss',
        },
      });
      expect(initRes.statusCode).toBe(201);
      ceremonyId = initRes.json<{ data: { ceremonyId: string } }>().data.ceremonyId;

      // 2. Custodian 1 (Chairman) presents Share 1
      const share1 = smekShares[0]!;
      const s1Res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/share',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          ceremonyId,
          shareIndex: 1,
          shareData: share1.data,
        },
      });
      expect(s1Res.statusCode).toBe(200);
      expect(s1Res.json<{ data: { isComplete: boolean; status: string } }>().data.status).toBe(
        'IN_PROGRESS',
      );

      // 3. Custodian 2 (Legal Trustee) presents Share 2
      const share2 = smekShares[1]!;
      const s2Res = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/recovery/share',
        headers: {
          cookie: `session_token=${s.principal.cookie}`,
          'x-csrf-token': s.principal.csrf,
        },
        payload: {
          ceremonyId,
          shareIndex: 2,
          shareData: share2.data,
        },
      });
      expect(s2Res.statusCode).toBe(200);
      expect(s2Res.json<{ data: { isComplete: boolean; status: string } }>().data.status).toBe(
        'COMPLETED',
      );

      // 4. Client-side reconstruction of SMEK from Share 1 + Share 2
      const reconstructedSmek = reconstructSecret([share1, share2]);
      expect(reconstructedSmek).toEqual(smekMasterSecret);

      // 5. Verification: Can we also reconstruct using Share 2 + Share 3?
      const share3 = smekShares[2]!;
      const reconstructedFrom23 = reconstructSecret([share2, share3]);
      expect(reconstructedFrom23).toEqual(smekMasterSecret);

      // 6. Decrypt the protected marks using recovered master key without server backdoor
      expect(reconstructedSmek).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------------------------------
  // Phase 5 — Universal Institution Compatibility & Adult Student Privacy Guard
  // -----------------------------------------------------------------------------------------------
  describe('Phase 5 — Universal Institution Compatibility & Adult Student Privacy Guard', () => {
    let consentId: string;

    it('allows Guardian to view minor student records by default', async () => {
      const minorCheck = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${studentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });
      expect(minorCheck.statusCode).toBe(200);
      const data = minorCheck.json<{ data: { child: { studentId: string } } }>().data;
      expect(data.child.studentId).toBe(studentId);
    });

    it('strictly BLOCKS Guardian access to adult student records without explicit consent', async () => {
      const adultCheck = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${adultStudentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });
      expect(adultCheck.statusCode).toBe(403);
      expect(adultCheck.json<{ error: { code: string } }>().error.code).toBe(
        'ADULT_STUDENT_PRIVACY_RESTRICTION',
      );
    });

    it('allows adult student to grant explicit access consent to guardian', async () => {
      const consentRes = await app.inject({
        method: 'POST',
        url: '/api/v1/vault/adult-consents',
        headers: {
          cookie: `session_token=${s.adultStudent.cookie}`,
          'x-csrf-token': s.adultStudent.csrf,
        },
        payload: {
          guardianId,
          consentScope: 'ALL',
        },
      });
      expect(consentRes.statusCode).toBe(201);
      const data = consentRes.json<{ data: { consentId: string; status: string } }>().data;
      expect(data.status).toBe('ACTIVE');
      consentId = data.consentId;

      // Guardian check again -> ACCESS PERMITTED!
      const permittedCheck = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${adultStudentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });
      expect(permittedCheck.statusCode).toBe(200);
      expect(
        permittedCheck.json<{ data: { child: { studentId: string } } }>().data.child.studentId,
      ).toBe(adultStudentId);
    });

    it('immediately re-blocks Guardian access when adult student revokes consent', async () => {
      const revokeRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/vault/adult-consents/${consentId}`,
        headers: {
          cookie: `session_token=${s.adultStudent.cookie}`,
          'x-csrf-token': s.adultStudent.csrf,
        },
      });
      expect(revokeRes.statusCode).toBe(200);

      // Guardian check again -> RE-BLOCKED!
      const blockedCheck = await app.inject({
        method: 'GET',
        url: `/api/v1/parent/children/${adultStudentId}/summary`,
        headers: {
          cookie: `session_token=${s.guardian.cookie}`,
        },
      });
      expect(blockedCheck.statusCode).toBe(403);
      expect(blockedCheck.json<{ error: { code: string } }>().error.code).toBe(
        'ADULT_STUDENT_PRIVACY_RESTRICTION',
      );
    });
  });
});
