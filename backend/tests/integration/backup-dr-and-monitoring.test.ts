import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as argon2 from 'argon2';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import {
  assertDisposableTestDatabase,
  FORBIDDEN_PERSISTENT_DB_NAMES,
} from '../../src/shared/database/test-guard.js';
import { BackupManager } from '../../tools/backup/backup-manager.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { mfaVerified } from '../support/db-harness.js';

describe('Enterprise Backup, Disaster Recovery & Monitoring Suite (P0)', () => {
  const adminUrl = inject('dbAdminUrl');
  const runtimeUrl = inject('dbRuntimeUrl');
  const serverAdminUrl = inject('serverAdminUrl');

  if (!adminUrl || !runtimeUrl || !serverAdminUrl) {
    throw new Error('Test requires disposable test database from Vitest globalSetup');
  }

  assertDisposableTestDatabase(adminUrl, 'backup-dr-and-monitoring.test.ts (admin)');
  assertDisposableTestDatabase(runtimeUrl, 'backup-dr-and-monitoring.test.ts (runtime)');

  const testKey = 'test-aes256-master-key-must-be-secure-32chars!';
  let tempStorageDir: string;
  let manager: BackupManager;

  const erpPool = createPool({ connectionString: runtimeUrl, ssl: false, max: 5 });
  const erpDb = new Database(erpPool);
  let app: ReturnType<typeof buildApp>;

  let tenant: IsolatedTenant;
  let adminCookie: string;

  beforeAll(async () => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusos-backup-test-'));
    manager = new BackupManager(tempStorageDir);

    app = buildApp({
      config: loadConfig({ DATABASE_URL: runtimeUrl, APP_ORIGINS: 'https://app.campus.test' }),
      db: erpDb,
      logger: false,
    });

    const password = 'AdminPassword123!'; // secret-scan:allow test fixture
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    tenant = await createIsolatedTenant(passwordHash);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        host: 'app.campus.test',
        origin: 'https://app.campus.test',
      },
      payload: {
        email: tenant.emails.admin,
        password,
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie || '';
    const match = /session_token=([^;]+)/.exec(cookieStr);
    expect(match).toBeTruthy();
    adminCookie = await mfaVerified(match![1]!);
  });

  afterAll(async () => {
    await erpPool.end();
    if (tempStorageDir && fs.existsSync(tempStorageDir)) {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    }
  });

  describe('1. Safety Guards: Strict Prevention of Mutation to Protected Databases', () => {
    it('refuses to restore into campusos_demo or any protected persistent database', async () => {
      for (const forbidden of FORBIDDEN_PERSISTENT_DB_NAMES) {
        const dummyUrl = `postgresql://postgres:secret@localhost:54329/${forbidden}`;
        await expect(
          manager.restoreBackup({
            backupFile: '/tmp/fake-backup.dump.enc',
            targetDatabaseUrl: dummyUrl,
            encryptionKey: testKey,
          }),
        ).rejects.toThrow(/PERSISTENT_DB_MUTATION_BLOCKED/);
      }
    });

    it('refuses restore on non-disposable arbitrary database names', async () => {
      const prodUrl = 'postgresql://postgres:secret@localhost:54329/production_school_records';
      await expect(
        manager.restoreBackup({
          backupFile: '/tmp/fake-backup.dump.enc',
          targetDatabaseUrl: prodUrl,
          encryptionKey: testKey,
        }),
      ).rejects.toThrow(
        /PERSISTENT_DB_MUTATION_BLOCKED.*not a recognized disposable test database/,
      );
    });
  });

  describe('2. Encrypted Backup Creation & Metadata Generation', () => {
    it('creates an AES-256-GCM encrypted backup with valid checksums and metadata', async () => {
      const backupResult = await manager.createBackup({
        databaseUrl: adminUrl,
        encryptionKey: testKey,
        storageDir: tempStorageDir,
        retentionDays: 14,
      });

      expect(fs.existsSync(backupResult.filePath)).toBe(true);
      expect(fs.existsSync(backupResult.metaPath)).toBe(true);

      // Verify file is encrypted ciphertext (does not start with pg_dump 'PGDMP' magic header)
      const cipherBytes = fs.readFileSync(backupResult.filePath);
      const magic = cipherBytes.subarray(0, 5).toString('ascii');
      expect(magic).not.toBe('PGDMP');

      // Verify metadata schema & values
      const meta = backupResult.metadata;
      expect(meta.status).toBe('COMPLETED');
      expect(meta.encryption.algorithm).toBe('aes-256-gcm');
      expect(meta.encryption.ivHex).toHaveLength(24); // 12 bytes = 24 hex
      expect(meta.encryption.authTagHex).toHaveLength(32); // 16 bytes = 32 hex
      expect(meta.retention.retentionDays).toBe(14);
      expect(meta.institutionCount).toBeGreaterThanOrEqual(1);
      expect(meta.integrity.plaintextSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(meta.integrity.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('3. Cryptographic Verification & Tamper Detection', () => {
    it('successfully verifies an untampered encrypted backup', async () => {
      const backups = manager.listBackups();
      expect(backups.length).toBeGreaterThan(0);
      const latest = backups[0]!;

      const verifyRes = await manager.verifyBackup(latest.metaPath, testKey);
      expect(verifyRes.valid).toBe(true);
      expect(verifyRes.integrityVerified).toBe(true);
      expect(verifyRes.catalogCheck).toBe(true);
      expect(verifyRes.errors).toHaveLength(0);
    });

    it('detects tampering and rejects corrupted ciphertext with auth tag failure', async () => {
      // Create a separate backup specifically to test tampering
      const backupResult = await manager.createBackup({
        databaseUrl: adminUrl,
        encryptionKey: testKey,
        storageDir: tempStorageDir,
      });

      // Tamper with one byte in the ciphertext
      const cipherData = fs.readFileSync(backupResult.filePath);
      cipherData[50] = cipherData[50]! ^ 0xff; // flip bits of byte 50
      fs.writeFileSync(backupResult.filePath, cipherData);

      const verifyRes = await manager.verifyBackup(backupResult.metaPath, testKey);
      expect(verifyRes.valid).toBe(false);
      expect(verifyRes.integrityVerified).toBe(false);
      expect(verifyRes.errors.length).toBeGreaterThan(0);
    });

    it('rejects verification if supplied with the wrong decryption key', async () => {
      const backupResult = await manager.createBackup({
        databaseUrl: adminUrl,
        encryptionKey: testKey,
        storageDir: tempStorageDir,
      });

      const wrongKey = 'wrong-key-completely-different-32chars!';
      const verifyRes = await manager.verifyBackup(backupResult.metaPath, wrongKey);
      expect(verifyRes.valid).toBe(false);
      expect(
        verifyRes.errors.some(
          (e) => e.includes('keyId mismatch') || e.includes('Unsupported state'),
        ),
      ).toBe(true);
    });
  });

  describe('4. Retention Policy Pruning', () => {
    it('prunes expired backups while retaining recent ones', () => {
      // Create a mock old backup
      const oldMetaPath = path.join(tempStorageDir, 'backup-old-test.meta.json');
      const oldDumpPath = path.join(tempStorageDir, 'backup-old-test.dump.enc');

      const oldMetadata = {
        backupId: '018f0000-0000-7000-8000-000000000001',
        createdAt: new Date(Date.now() - 40 * 86400000).toISOString(), // 40 days old
        sourceDatabase: 'test_db',
        sourceHost: 'localhost',
        sourcePort: 5432,
        serverVersion: '16.0',
        schemaVersion: '0055',
        institutionCount: 1,
        encryption: {
          algorithm: 'aes-256-gcm',
          ivHex: '00'.repeat(12),
          authTagHex: '00'.repeat(16),
          keyId: 'fakekeyid',
        },
        integrity: {
          plaintextSha256: 'aa'.repeat(32),
          ciphertextSha256: 'bb'.repeat(32),
          sizeBytes: 100,
          cipherSizeBytes: 100,
        },
        retention: {
          retentionDays: 30,
          expiresAt: new Date(Date.now() - 10 * 86400000).toISOString(),
        },
        status: 'COMPLETED' as const,
      };

      fs.writeFileSync(oldMetaPath, JSON.stringify(oldMetadata, null, 2));
      fs.writeFileSync(oldDumpPath, 'mock-ciphertext');

      // Now prune with 30-day retention
      const pruneRes = manager.pruneExpiredBackups(30);
      expect(pruneRes.prunedCount).toBeGreaterThanOrEqual(1);
      expect(pruneRes.prunedIds).toContain(oldMetadata.backupId);

      // Verify files deleted
      expect(fs.existsSync(oldMetaPath)).toBe(false);
      expect(fs.existsSync(oldDumpPath)).toBe(false);
    });
  });

  describe('5. Disaster Recovery Rehearsal Workflow', () => {
    it('executes a full end-to-end automated DR rehearsal with verification proofs', async () => {
      const report = await manager.runDisasterRecoveryRehearsal({
        serverAdminUrl,
        sourceDbUrl: adminUrl,
        encryptionKey: testKey,
        storageDir: tempStorageDir,
      });

      expect(report.verdict).toBe('PASS');
      expect(report.disposableDbDropped).toBe(true);
      expect(report.verifications.backupIntegrityPass).toBe(true);
      expect(report.verifications.restoreExecutedPass).toBe(true);
      expect(report.verifications.migrationLedgerPass).toBe(true);
      expect(report.verifications.migrationHead).toBe('0055');
      expect(report.verifications.rlsEnforcementPass).toBe(true);
      expect(report.verifications.unprotectedTablesCount).toBe(0);
      expect(report.verifications.tenantIsolationPass).toBe(true);
      expect(report.verifications.vaultZeroAccessPass).toBe(true);
      expect(report.evidence.tablesAudited).toBeGreaterThan(40);
      expect(report.evidence.rtoSeconds).toBeLessThan(120);
    }, 60_000);
  });

  describe('6. Operational Health & Telemetry Endpoints', () => {
    it('GET /api/v1/monitoring/health returns 200 with live cluster health status', async () => {
      // Unauthenticated request should be rejected (401)
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/monitoring/health',
        headers: { host: 'app.campus.test' },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Authenticated with admin credentials
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/monitoring/health',
        headers: { host: 'app.campus.test' },
        cookies: {
          session_token: adminCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        database: string;
        backups: string;
        storage: string;
        uptimeSeconds: number;
      }>();
      expect(body.status).toMatch(/^(HEALTHY|DEGRADED)$/);
      expect(body.database).toBe('CONNECTED');
      expect(body.backups).toMatch(/^(FRESH|WARNING|STALE|NONE)$/);
      expect(body.storage).toMatch(/^(HEALTHY|WARNING|CRITICAL)$/);
      expect(typeof body.uptimeSeconds).toBe('number');
    });

    it('GET /api/v1/monitoring/telemetry requires org.settings.read permission', async () => {
      // Unauthenticated request should be rejected (401)
      const unauthRes = await app.inject({
        method: 'GET',
        url: '/api/v1/monitoring/telemetry',
        headers: { host: 'app.campus.test' },
      });
      expect(unauthRes.statusCode).toBe(401);

      // Authenticated with admin credentials holding org.settings.read
      const authRes = await app.inject({
        method: 'GET',
        url: '/api/v1/monitoring/telemetry',
        headers: {
          host: 'app.campus.test',
        },
        cookies: {
          session_token: adminCookie,
        },
      });

      expect(authRes.statusCode).toBe(200);
      const body = authRes.json<{
        success: boolean;
        data: {
          database: { connected: boolean; latencyMs: number };
          storage: { documentStoreReady: boolean };
          api: { memoryMb: { heapUsed: number } };
          security: { rlsEnforcedGlobally: boolean };
        };
      }>();
      expect(body.success).toBe(true);
      expect(body.data.database.connected).toBe(true);
      expect(typeof body.data.database.latencyMs).toBe('number');
      expect(body.data.storage.documentStoreReady).toBe(true);
      expect(body.data.api.memoryMb.heapUsed).toBeGreaterThan(0);
      expect(body.data.security.rlsEnforcedGlobally).toBe(true);
    });
  });
});
