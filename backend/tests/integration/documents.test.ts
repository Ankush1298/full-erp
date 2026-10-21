import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import {
  DocumentService,
  DocumentScanWorker,
  MockMalwareScanner,
} from '../../src/modules/documents/index.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { MemoryStorageDriver, deriveStorageKey } from '../../src/shared/storage/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Documents kernel (migration 0031) against the shared disposable integration database. Everything commits, so it runs
// in PRIVATE tenants; assertions look only at rows these tests created.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 12 }));
const storage = new MemoryStorageDriver();
const svc = new DocumentService(storage);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  storage,
  logger: false,
});

const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25]); // %PDF-1.4
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const newKey = (): string => randomBytes(16).toString('hex');

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
let WORKER_T!: IsolatedTenant;

const ctxFor = (user: string, kind: 'STAFF' | 'STUDENT' = 'STAFF', tenant = T): TrustedContext =>
  issueTrustedContext({ tenantId: tenant.orgId, userId: user, actorKind: kind });

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  [T, OTHER, WORKER_T] = await Promise.all([
    createIsolatedTenant(hash),
    createIsolatedTenant(hash),
    createIsolatedTenant(hash),
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all([T?.cleanup(), OTHER?.cleanup(), WORKER_T?.cleanup()]);
  await app.close();
  await db.close();
});

interface UploadOpts {
  storageClass?: 'GENERAL' | 'SENSITIVE' | 'GENERATED';
  contentType?: string;
  classification?: 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  bytes?: Uint8Array;
  putBytes?: Uint8Array;
  putContentType?: string;
  tenant?: IsolatedTenant;
}

/** initiate -> client PUT -> complete. Returns the fileId (status SCANNING on success). */
async function initiateAndComplete(
  ctx: TrustedContext,
  studentId: string,
  opts: UploadOpts = {},
): Promise<{ fileId: string; complete: { status: string; scanResult: string | null } }> {
  const storageClass = opts.storageClass ?? 'GENERAL';
  const contentType = opts.contentType ?? 'application/pdf';
  const bytes = opts.bytes ?? PDF;
  const init = await db.withTenant(ctx, (tx) =>
    svc.initiateUpload(
      tx,
      ctx,
      {
        storageClass,
        originalName: 'report.pdf',
        contentType,
        sizeBytes: bytes.length,
        sha256: sha(bytes),
        ...(opts.classification ? { classification: opts.classification } : {}),
        link: { entityType: 'student', entityId: studentId, purpose: 'id_proof' },
        ...(storageClass === 'SENSITIVE' ? { reason: 'Uploading identity document' } : {}),
      },
      { idempotencyKey: newKey() },
    ),
  );
  const fileId = (init.body as { data: { fileId: string } }).data.fileId;
  const key = deriveStorageKey(
    (opts.tenant ?? T).orgId,
    storageClass,
    fileId,
    new Date().getUTCFullYear(),
  );
  storage.putObject(storageClass, key, opts.putBytes ?? bytes, opts.putContentType ?? contentType);
  const complete = await db.withTenant(ctx, (tx) => svc.completeUpload(tx, ctx, fileId, {}));
  return { fileId, complete };
}

async function finalize(
  ctx: TrustedContext,
  fileId: string,
  verdict: 'CLEAN' | 'INFECTED',
): Promise<void> {
  await db.withTenant(ctx, (tx) => svc.finalizeScan(tx, ctx, fileId, verdict, {}));
}
async function link(
  ctx: TrustedContext,
  studentId: string,
  fileId: string,
  extra: { visibility?: 'OWNER_VISIBLE' | 'STAFF_ONLY' } = {},
): Promise<string> {
  const r = await db.withTenant(ctx, (tx) =>
    svc.linkToStudent(
      tx,
      ctx,
      studentId,
      { fileId, purpose: 'id_proof', reason: 'Attach identity document', ...extra },
      {},
    ),
  );
  return r.id;
}
const status = async (fileId: string): Promise<string> =>
  (await adminQuery<{ status: string }>('SELECT status FROM app.files WHERE id = $1', [fileId]))[0]!
    .status;
const download = (ctx: TrustedContext, fileId: string) =>
  db.withTenant(ctx, (tx) => svc.downloadUrl(tx, ctx, fileId, {}));
const expectStatus = async (p: Promise<unknown>, code: number): Promise<AppError> => {
  const err = await p.then(() => undefined).catch((e: unknown) => e);
  expect(err, `expected AppError ${code}`).toBeInstanceOf(AppError);
  expect((err as AppError).statusCode).toBe(code);
  return err as AppError;
};

describe('document lifecycle (service)', () => {
  it('initiate -> complete -> scan CLEAN -> link -> download, with audit at each step', async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId, complete } = await initiateAndComplete(admin, T.students.one, {
      storageClass: 'SENSITIVE',
      classification: 'CONFIDENTIAL',
    });
    expect(complete).toMatchObject({ status: 'SCANNING', scanResult: null });
    expect(await status(fileId)).toBe('SCANNING');

    // Not downloadable before a clean scan (fail closed — the scanner is the documented gap).
    await expectStatus(download(admin, fileId), 404);

    await finalize(admin, fileId, 'CLEAN');
    expect(await status(fileId)).toBe('AVAILABLE');
    const linkId = await link(admin, T.students.one, fileId);
    expect(linkId).toMatch(/^[0-9a-f-]{36}$/);

    const dl = await download(admin, fileId);
    expect(dl.url).toContain('memory://download');
    expect(new Date(dl.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const audits = await adminQuery<{ action: string }>(
      `SELECT action FROM app.audit_events WHERE resource_id = $1 OR subject_student_id = $2 ORDER BY occurred_at`,
      [fileId, T.students.one],
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'file.upload.initiate',
        'file.upload.complete',
        'file.scan.complete',
        'file.link.create',
      ]),
    );
  });

  it('initiate is idempotent: a replay returns the same file and does not create a second row', async () => {
    const admin = ctxFor(T.users.admin);
    const key = newKey();
    const body = {
      storageClass: 'GENERAL' as const,
      originalName: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      sha256: sha(PDF),
      link: { entityType: 'student' as const, entityId: T.students.one, purpose: 'id_proof' },
    };
    const first = await db.withTenant(admin, (tx) =>
      svc.initiateUpload(tx, admin, body, { idempotencyKey: key }),
    );
    const second = await db.withTenant(admin, (tx) =>
      svc.initiateUpload(tx, admin, body, { idempotencyKey: key }),
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    const fid = (first.body as { data: { fileId: string } }).data.fileId;
    expect((second.body as { data: { fileId: string } }).data.fileId).toBe(fid);
  });

  it('complete rejects a size / checksum / MIME mismatch, and a rejected file can never be promoted or linked', async () => {
    const admin = ctxFor(T.users.admin);
    // Declared PDF, but the bytes are a PNG (MIME confusion).
    const bad = await initiateAndComplete(admin, T.students.one, {
      bytes: PDF,
      putBytes: PNG,
      putContentType: 'application/pdf',
    });
    expect(bad.complete.scanResult).toBe('REJECTED');
    await expectStatus(finalize(admin, bad.fileId, 'CLEAN'), 409); // not awaiting a verdict
    await expectStatus(download(admin, bad.fileId), 404);
    await expectStatus(link(admin, T.students.one, bad.fileId), 409); // not AVAILABLE
  });

  it('a second completion is refused (no duplicate completion / replay)', async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await expectStatus(
      db.withTenant(admin, (tx) => svc.completeUpload(tx, admin, fileId, {})),
      409,
    );
  });

  it('INFECTED quarantines; a quarantined file is never downloadable or linkable', async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'INFECTED');
    expect(await status(fileId)).toBe('QUARANTINED');
    await expectStatus(download(admin, fileId), 404);
    await expectStatus(link(admin, T.students.one, fileId), 409);
  });

  it('a duplicate link (same file/entity/purpose) is refused', async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'CLEAN');
    await link(admin, T.students.one, fileId);
    await expectStatus(link(admin, T.students.one, fileId), 409);
  });
});

describe('authorization and isolation (service)', () => {
  it('a student uploads and downloads their OWN document (SELF)', async () => {
    const student = ctxFor(T.users.studentOne, 'STUDENT');
    const { fileId } = await initiateAndComplete(student, T.students.one);
    await finalize(ctxFor(T.users.admin), fileId, 'CLEAN'); // the "worker" promotes
    await link(ctxFor(T.users.admin), T.students.one, fileId);
    const dl = await download(student, fileId);
    expect(dl.url).toContain('memory://download');
  });

  it("student B cannot download student A's document; knowing the UUID is not enough", async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'CLEAN');
    await link(admin, T.students.one, fileId);
    await expectStatus(download(ctxFor(T.users.studentTwo, 'STUDENT'), fileId), 404);
  });

  it('an unlinked clean file is readable by its uploader only (orphan rule)', async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'CLEAN');
    // not linked yet: the uploader (admin) can read it, another admin-scope holder cannot prove a link
    expect((await download(admin, fileId)).url).toContain('memory://download');
    await expectStatus(download(ctxFor(T.users.studentTwo, 'STUDENT'), fileId), 404);
  });

  it('RESTRICTED downloads need document.read_restricted and are audited', async () => {
    const admin = ctxFor(T.users.admin); // COLLEGE_ADMIN holds document.read_restricted
    const { fileId } = await initiateAndComplete(admin, T.students.one, {
      storageClass: 'SENSITIVE',
      classification: 'RESTRICTED',
    });
    await finalize(admin, fileId, 'CLEAN');
    await link(admin, T.students.one, fileId, { visibility: 'STAFF_ONLY' });

    // campusAdmin holds document.read but NOT document.read_restricted -> 404
    await expectStatus(download(ctxFor(T.users.campusAdmin), fileId), 404);
    const before = await restrictedReads(fileId);
    const dl = await download(admin, fileId);
    expect(dl.url).toContain('memory://download');
    expect(await restrictedReads(fileId)).toBe(before + 1);
  });

  it('a STAFF_ONLY link is never satisfied by the student owner', async () => {
    const admin = ctxFor(T.users.admin);
    // admin uploads (so the student is not the uploader), links STAFF_ONLY to studentOne
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'CLEAN');
    await link(admin, T.students.one, fileId, { visibility: 'STAFF_ONLY' });
    await expectStatus(download(ctxFor(T.users.studentOne, 'STUDENT'), fileId), 404); // owner, STAFF_ONLY
    expect((await download(admin, fileId)).url).toContain('memory://download'); // staff ok
  });

  it("cross-tenant: another tenant cannot complete, link, or download this tenant's file", async () => {
    const admin = ctxFor(T.users.admin);
    const { fileId } = await initiateAndComplete(admin, T.students.one);
    await finalize(admin, fileId, 'CLEAN');
    await link(admin, T.students.one, fileId);
    const otherAdmin = ctxFor(OTHER.users.admin, 'STAFF', OTHER);
    await expectStatus(download(otherAdmin, fileId), 404);
    await expectStatus(
      db.withTenant(otherAdmin, (tx) => svc.completeUpload(tx, otherAdmin, fileId, {})),
      404,
    );
    await expectStatus(link(otherAdmin, OTHER.students.one, fileId), 404); // the file is not in OTHER's tenant
  });

  it('initiate against a student of another tenant is a 404', async () => {
    const admin = ctxFor(T.users.admin);
    await expectStatus(
      db.withTenant(admin, (tx) =>
        svc.initiateUpload(
          tx,
          admin,
          {
            storageClass: 'GENERAL',
            originalName: 'x.pdf',
            contentType: 'application/pdf',
            sizeBytes: PDF.length,
            sha256: sha(PDF),
            link: { entityType: 'student', entityId: OTHER.students.one, purpose: 'id_proof' },
          },
          { idempotencyKey: newKey() },
        ),
      ),
      404,
    );
  });
});

async function restrictedReads(fileId: string): Promise<number> {
  const rows = await adminQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.audit_events WHERE action = 'file.read' AND resource_id = $1`,
    [fileId],
  );
  return Number(rows[0]!.n);
}

describe('HTTP: /api/v1/documents and /api/v1/students/:id/documents', () => {
  const sessions: Record<string, { cookie: string; csrf: string }> = {};
  async function login(email: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, email).toBe(200);
    return {
      cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
      csrf: r.json<{ csrf_token: string }>().csrf_token,
    };
  }
  beforeAll(async () => {
    sessions.admin = await login(T.emails.admin);
  }, 60_000);

  const call = (
    method: 'GET' | 'POST',
    who: string | null,
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: path,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      cookies: who ? { session_token: sessions[who]!.cookie } : {},
      headers: {
        origin: APP_ORIGIN,
        ...(who ? { 'x-csrf-token': sessions[who]!.csrf } : {}),
        ...headers,
      },
    });

  it('401 without a session; 403 without a CSRF token', async () => {
    expect(
      (await call('POST', null, '/api/v1/documents/uploads', {}, { 'idempotency-key': newKey() }))
        .statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/uploads',
      payload: {},
      cookies: { session_token: sessions.admin!.cookie },
      headers: { origin: APP_ORIGIN, 'idempotency-key': newKey() },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('full happy path over HTTP: initiate -> PUT -> complete -> (scan) -> link -> download-url', async () => {
    const payload = {
      storageClass: 'GENERAL',
      originalName: 'card.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      sha256: sha(PDF),
      link: { entityType: 'student', entityId: T.students.one, purpose: 'id_proof' },
    };
    const init = await call('POST', 'admin', '/api/v1/documents/uploads', payload, {
      'idempotency-key': newKey(),
    });
    expect(init.statusCode).toBe(201);
    const { fileId, upload } = init.json<{
      data: { fileId: string; upload: { url: string; headers: Record<string, string> } };
    }>().data;
    expect(upload.url).toContain('memory://upload');

    storage.putObject(
      'GENERAL',
      deriveStorageKey(T.orgId, 'GENERAL', fileId, new Date().getUTCFullYear()),
      PDF,
      'application/pdf',
    );
    const complete = await call('POST', 'admin', `/api/v1/documents/uploads/${fileId}/complete`);
    expect(complete.statusCode).toBe(200);
    expect(complete.json<{ data: { status: string } }>().data.status).toBe('SCANNING');

    await finalize(ctxFor(T.users.admin), fileId, 'CLEAN'); // the worker seam has no route
    const linked = await call('POST', 'admin', `/api/v1/students/${T.students.one}/documents`, {
      fileId,
      purpose: 'id_proof',
      reason: 'Attach the ID card',
    });
    expect(linked.statusCode).toBe(201);

    const dl = await call('GET', 'admin', `/api/v1/documents/${fileId}/download-url`);
    expect(dl.statusCode).toBe(200);
    expect(dl.json<{ data: { url: string } }>().data.url).toContain('memory://download');
  });

  it('schema validation: an unsupported content type and a stray tenant field are 400', async () => {
    const good = {
      storageClass: 'GENERAL',
      originalName: 'x.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.length,
      sha256: sha(PDF),
      link: { entityType: 'student', entityId: T.students.one, purpose: 'id_proof' },
    };
    expect(
      (
        await call(
          'POST',
          'admin',
          '/api/v1/documents/uploads',
          { ...good, contentType: 'text/html' },
          { 'idempotency-key': newKey() },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          'admin',
          '/api/v1/documents/uploads',
          { ...good, organizationId: T.orgId },
          { 'idempotency-key': newKey() },
        )
      ).statusCode,
    ).toBe(400);
  });
});

describe('DocumentScanWorker (integration with private tenants)', () => {
  it('claims SCANNING file, verifies integrity, scans clean, and promotes to AVAILABLE', async () => {
    const admin = ctxFor(WORKER_T.users.admin, 'STAFF', WORKER_T);
    const { fileId } = await initiateAndComplete(admin, WORKER_T.students.one, {
      tenant: WORKER_T,
    });
    expect(await status(fileId)).toBe('SCANNING');

    // Worker with clean scanner
    const worker = new DocumentScanWorker({
      db,
      documentService: svc,
      storage,
      scanner: new MockMalwareScanner({ verdict: 'CLEAN' }),
    });

    const result = await worker.processNext(admin);
    expect(result).toEqual({ outcome: 'AVAILABLE', fileId });
    expect(await status(fileId)).toBe('AVAILABLE');

    // Can now be linked and downloaded
    const linkId = await link(admin, WORKER_T.students.one, fileId);
    expect(linkId).toBeTruthy();

    const dl = await download(admin, fileId);
    expect(dl.url).toContain('memory://download');
  });

  it('claims SCANNING file, detects malware, and quarantines it safely', async () => {
    const admin = ctxFor(WORKER_T.users.admin, 'STAFF', WORKER_T);
    const { fileId } = await initiateAndComplete(admin, WORKER_T.students.one, {
      tenant: WORKER_T,
    });
    expect(await status(fileId)).toBe('SCANNING');

    const worker = new DocumentScanWorker({
      db,
      documentService: svc,
      storage,
      scanner: new MockMalwareScanner({
        verdict: 'INFECTED',
        details: 'Win.Test.EICAR_HDB-1',
      }),
    });

    const result = await worker.processNext(admin);
    expect(result).toEqual({
      outcome: 'INFECTED',
      fileId,
      threat: 'Win.Test.EICAR_HDB-1',
    });
    expect(await status(fileId)).toBe('QUARANTINED');

    // Quarantined file can never be linked or downloaded
    await expectStatus(link(admin, WORKER_T.students.one, fileId), 409);
    await expectStatus(download(admin, fileId), 404);
  });

  it('rejects file when bytes in storage fail integrity digest verification', async () => {
    const admin = ctxFor(WORKER_T.users.admin, 'STAFF', WORKER_T);
    const { fileId } = await initiateAndComplete(admin, WORKER_T.students.one, {
      tenant: WORKER_T,
    });
    expect(await status(fileId)).toBe('SCANNING');

    // Corrupt the object in storage (same length, different byte content)
    const key = deriveStorageKey(WORKER_T.orgId, 'GENERAL', fileId, new Date().getUTCFullYear());
    const tampered = new Uint8Array(PDF);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    // Replace in memory store
    storage.putObject('GENERAL', key, tampered, 'application/pdf');

    const worker = new DocumentScanWorker({
      db,
      documentService: svc,
      storage,
      scanner: new MockMalwareScanner({ verdict: 'CLEAN' }),
    });

    const result = await worker.processNext(admin);
    expect(result?.outcome).toBe('REJECTED');
    expect(await status(fileId)).toBe('QUARANTINED');

    const row = (
      await adminQuery<{ scan_result: string }>('SELECT scan_result FROM app.files WHERE id = $1', [
        fileId,
      ])
    )[0];
    expect(row?.scan_result).toBe('REJECTED');
  });

  it('enforces tenant isolation: worker for Tenant B cannot claim Tenant A files', async () => {
    const adminA = ctxFor(WORKER_T.users.admin, 'STAFF', WORKER_T);
    const adminB = ctxFor(OTHER.users.admin, 'STAFF', OTHER);

    const { fileId } = await initiateAndComplete(adminA, WORKER_T.students.one, {
      tenant: WORKER_T,
    });
    expect(await status(fileId)).toBe('SCANNING');

    const worker = new DocumentScanWorker({
      db,
      documentService: svc,
      storage,
      scanner: new MockMalwareScanner({ verdict: 'CLEAN' }),
    });

    // Tenant B worker attempts to claim
    const resultB = await worker.processNext(adminB);
    // Tenant B sees no files in its tenant queue
    expect(resultB).toBeNull();
    // Tenant A's file remains safely in SCANNING
    expect(await status(fileId)).toBe('SCANNING');

    // Tenant A worker successfully claims it
    const resultA = await worker.processNext(adminA);
    expect(resultA?.outcome).toBe('AVAILABLE');
    expect(await status(fileId)).toBe('AVAILABLE');
  });

  it('handles concurrency: FOR UPDATE SKIP LOCKED skips rows already claimed', async () => {
    const admin = ctxFor(WORKER_T.users.admin, 'STAFF', WORKER_T);
    const { fileId } = await initiateAndComplete(admin, WORKER_T.students.one, {
      tenant: WORKER_T,
    });

    const worker = new DocumentScanWorker({
      db,
      documentService: svc,
      storage,
      scanner: new MockMalwareScanner({ verdict: 'CLEAN' }),
    });

    // Run two workers concurrently on the single file
    const [res1, res2] = await Promise.all([worker.processNext(admin), worker.processNext(admin)]);

    // Exactly one worker processed the file; the other skipped it and found nothing
    const processed = [res1, res2].filter((r) => r !== null);
    const skipped = [res1, res2].filter((r) => r === null);

    expect(processed).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(processed[0]?.fileId).toBe(fileId);
    expect(await status(fileId)).toBe('AVAILABLE');
  });
});
