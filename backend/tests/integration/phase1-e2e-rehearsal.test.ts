import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { createTenant } from '../../tools/platform/platform-cli.js';
import { issueFirstAdminBootstrapTicket } from '../../src/shared/authorization/mfa-bootstrap.js';
import {
  DocumentService,
  DocumentScanWorker,
  MockMalwareScanner,
} from '../../src/modules/documents/index.js';
import { MemoryStorageDriver, deriveStorageKey } from '../../src/shared/storage/index.js';
import {
  NotificationService,
  InMemoryEmailProvider,
} from '../../src/modules/notifications/index.js';
import type { NotificationDto } from '../../src/modules/notifications/notification.schemas.js';
import { DeterministicAiProvider } from '../../src/modules/ai/index.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // %PDF-1.4

describe('Phase 1 — ERP Foundation End-to-End Integration Rehearsal', () => {
  const adminUrl = inject('dbAdminUrl');
  const runtimeUrl = inject('dbRuntimeUrl');

  let adminClient: pg.Client;
  let pool: pg.Pool;
  let db: Database;
  let storage: MemoryStorageDriver;
  let emailProvider: InMemoryEmailProvider;
  let app: ReturnType<typeof buildApp>;

  let otherTenant: IsolatedTenant;

  beforeAll(async () => {
    adminClient = new pg.Client({ connectionString: adminUrl });
    await adminClient.connect();

    pool = createPool({ connectionString: runtimeUrl, ssl: false, max: 10 });
    db = new Database(pool);
    storage = new MemoryStorageDriver();
    emailProvider = new InMemoryEmailProvider();

    app = buildApp({
      config: loadConfig({ DATABASE_URL: runtimeUrl, APP_ORIGINS: APP_ORIGIN }),
      db,
      storage,
      notificationEmailProvider: emailProvider,
      aiProvider: new DeterministicAiProvider(),
      logger: false,
    });
    await app.ready();

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    otherTenant = await createIsolatedTenant(passwordHash);
  });

  afterAll(async () => {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await adminClient.end().catch(() => undefined);
    await otherTenant?.cleanup().catch(() => undefined);
  });

  async function login(email: string): Promise<{ cookie: string; csrf: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const sessionToken = res.cookies.find((c) => c.name === 'session_token')?.value;
    expect(sessionToken).toBeDefined();
    return {
      cookie: await mfaVerified(sessionToken!),
      csrf: res.json<{ csrf_token: string }>().csrf_token,
    };
  }

  it('executes full 9-step Phase 1 integration lifecycle cleanly and safely', async () => {
    const runId = Date.now().toString(36);
    const slug = `e2e-${runId}`;
    const adminEmail = `registrar@${slug}.test`;
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

    // -------------------------------------------------------------------------
    // STEP 1: Provision isolated test tenant via platform CLI
    // -------------------------------------------------------------------------
    const tenant = await createTenant(adminClient, {
      name: 'Rehearsal Polytechnic',
      slug,
      adminEmail,
    });

    expect(tenant.id).toBeDefined();
    expect(tenant.slug).toBe(slug);
    expect(tenant.status).toBe('ACTIVE');
    expect(tenant.adminUserId).toBeDefined();

    // -------------------------------------------------------------------------
    // STEP 2: Verify Administrator Invitation / Bootstrap Ticket
    // -------------------------------------------------------------------------
    // 2a. Verify initial admin user was created in INVITED status
    const initialUserRes = await adminClient.query<{ status: string }>(
      `SELECT status FROM app.users WHERE id = $1 AND organization_id = $2`,
      [tenant.adminUserId, tenant.id],
    );
    expect(initialUserRes.rows[0]?.status).toBe('INVITED');

    // 2b. Activate initial admin identity and user record
    await adminClient.query(
      `INSERT INTO platform.identities (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [tenant.adminUserId, adminEmail, passwordHash],
    );
    await adminClient.query(
      `UPDATE app.users
          SET status = 'ACTIVE', identity_id = $1
        WHERE id = $2 AND organization_id = $3`,
      [tenant.adminUserId, tenant.adminUserId, tenant.id],
    );

    // 2c. Issue bootstrap ticket for active administrator
    const exec = {
      query: (sql: string, params?: readonly unknown[]) =>
        adminClient.query(sql, params as unknown[]),
    };
    const bootstrapTicket = await issueFirstAdminBootstrapTicket(exec, {
      organizationId: tenant.id,
      userId: tenant.adminUserId!,
      reason: 'E2E rehearsal operational admin bootstrap',
    });

    expect(bootstrapTicket.ticketId).toBeDefined();
    expect(bootstrapTicket.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(bootstrapTicket.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Verify audit event exists for the bootstrap ticket
    const bootstrapAudit = await adminQuery<{ action: string; risk_tier: number }>(
      `SELECT action, risk_tier FROM app.audit_events
        WHERE organization_id = $1 AND action = 'auth.mfa.bootstrap_ticket_issue'`,
      [tenant.id],
    );
    expect(bootstrapAudit.length).toBe(1);
    expect(bootstrapAudit[0]!.risk_tier).toBe(3);

    // -------------------------------------------------------------------------
    // STEP 3: Setup student user, Authentication & MFA
    // -------------------------------------------------------------------------

    // Create a student user in this tenant
    const studentUserId = uuidv7();
    const studentEmail = `student@${slug}.test`;
    await adminClient.query(
      `INSERT INTO platform.identities (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [studentUserId, studentEmail, passwordHash],
    );
    await adminClient.query(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'E2E Student', 'ACTIVE', $1)`,
      [studentUserId, tenant.id, studentEmail],
    );

    // Log in as College Admin
    const adminSession = await login(adminEmail);
    expect(adminSession.cookie).toBeDefined();

    // -------------------------------------------------------------------------
    // STEP 4: Setup Academic Structures & Student Record
    // -------------------------------------------------------------------------
    // 4a. Create Campus
    const campusRes = await app.inject({
      method: 'POST',
      url: '/api/v1/organization/campuses',
      cookies: { session_token: adminSession.cookie },
      headers: { 'x-csrf-token': adminSession.csrf },
      payload: {
        name: 'Main Campus',
        code: `MC-${runId}`.toUpperCase(),
        timezone: 'Asia/Kolkata',
      },
    });
    expect(campusRes.statusCode).toBe(201);
    const campusId = campusRes.json<{ data: { id: string } }>().data.id;

    // 4b. Create Department
    const deptRes = await app.inject({
      method: 'POST',
      url: '/api/v1/organization/departments',
      cookies: { session_token: adminSession.cookie },
      headers: { 'x-csrf-token': adminSession.csrf },
      payload: {
        campusId,
        name: 'Computer Engineering',
        code: `CS-${runId}`.toUpperCase(),
      },
    });
    expect(deptRes.statusCode).toBe(201);
    const departmentId = deptRes.json<{ data: { id: string } }>().data.id;

    // 4c. Create Period Type
    const periodTypeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/academics/period-types',
      cookies: { session_token: adminSession.cookie },
      headers: { 'x-csrf-token': adminSession.csrf },
      payload: {
        code: `SEM-${runId}`.toUpperCase(),
        label: 'Semester',
        labelPlural: 'Semesters',
      },
    });
    expect(periodTypeRes.statusCode).toBe(201);
    const periodTypeId = periodTypeRes.json<{ data: { id: string } }>().data.id;

    // 4d. Create Program
    const progRes = await app.inject({
      method: 'POST',
      url: '/api/v1/academics/programs',
      cookies: { session_token: adminSession.cookie },
      headers: { 'x-csrf-token': adminSession.csrf },
      payload: {
        departmentId,
        periodTypeId,
        name: 'B.Tech Computer Science',
        code: `CSB-${runId}`.toUpperCase(),
        degreeLevel: 'UNDERGRADUATE',
        durationPeriods: 8,
      },
    });
    expect(progRes.statusCode).toBe(201);

    // 4d. Create Student Record
    const admNumber = `ADM-${runId}`.toUpperCase();
    const studentCreateRes = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      cookies: { session_token: adminSession.cookie },
      headers: {
        'x-csrf-token': adminSession.csrf,
        'idempotency-key': `idem-student-${runId}`,
      },
      payload: {
        userId: studentUserId,
        admissionNumber: admNumber,
        admissionDate: '2026-08-01',
        reason: 'Standard university freshman admission',
      },
    });
    expect(studentCreateRes.statusCode).toBe(201);
    const studentId = studentCreateRes.json<{ data: { id: string } }>().data.id;

    // Verify student lookup by ID
    const studentGetRes = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentId}`,
      cookies: { session_token: adminSession.cookie },
    });
    expect(studentGetRes.statusCode).toBe(200);
    expect(studentGetRes.json<{ data: { admissionNumber: string } }>().data.admissionNumber).toBe(
      admNumber,
    );

    // Assign STUDENT role to the enrolled student (invariant: student record exists)
    const studentRoleRes = await adminClient.query<{ id: string }>(
      `SELECT id FROM app.roles WHERE organization_id = $1 AND code = 'STUDENT'`,
      [tenant.id],
    );
    const studentRoleId = studentRoleRes.rows[0]!.id;

    await adminClient.query(
      `INSERT INTO app.role_assignments
         (id, organization_id, user_id, role_id, scope_type, scope_id, status)
       VALUES ($1, $2, $3, $4, 'ORGANIZATION', NULL, 'ACTIVE')`,
      [uuidv7(), tenant.id, studentUserId, studentRoleId],
    );

    // Log in as student now with verified STUDENT role
    const studentSession = await login(studentEmail);
    expect(studentSession.cookie).toBeDefined();
    const recordConsentRes = await app.inject({
      method: 'POST',
      url: '/api/v1/me/consents',
      cookies: { session_token: studentSession.cookie },
      headers: { 'x-csrf-token': studentSession.csrf },
      payload: {
        consentType: 'DIRECTORY_LISTING',
        policyVersion: '1.0',
        policyText: 'University directory listing policy terms v1.0',
      },
    });
    expect(recordConsentRes.statusCode).toBe(201);
    const consentItem = recordConsentRes.json<{ id: string; status: string }>();
    expect(consentItem.status).toBe('GRANTED');

    // Withdraw consent
    const withdrawConsentRes = await app.inject({
      method: 'POST',
      url: `/api/v1/me/consents/${consentItem.id}/withdraw`,
      cookies: { session_token: studentSession.cookie },
      headers: { 'x-csrf-token': studentSession.csrf },
    });
    expect(withdrawConsentRes.statusCode).toBe(200);
    const withdrawnItem = withdrawConsentRes.json<{ status: string; withdrawnAt: string }>();
    expect(withdrawnItem.status).toBe('WITHDRAWN');
    expect(withdrawnItem.withdrawnAt).toBeDefined();

    // -------------------------------------------------------------------------
    // STEP 6: Document Upload, Completion & Anti-Malware Scan
    // -------------------------------------------------------------------------
    const uploadIdemKey = `idem-upload-${runId}`;
    const pdfSha256 = createHash('sha256').update(PDF_BYTES).digest('hex');

    const initUploadRes = await app.inject({
      method: 'POST',
      url: '/api/v1/documents/uploads',
      cookies: { session_token: studentSession.cookie },
      headers: {
        'x-csrf-token': studentSession.csrf,
        'idempotency-key': uploadIdemKey,
      },
      payload: {
        storageClass: 'GENERAL',
        originalName: 'transcript.pdf',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        sha256: pdfSha256,
        classification: 'CONFIDENTIAL',
        link: {
          entityType: 'student',
          entityId: studentId,
          purpose: 'enrollment_transcript',
        },
      },
    });
    expect(initUploadRes.statusCode).toBe(201);
    const uploadData = initUploadRes.json<{ data: { fileId: string } }>().data;
    const fileId = uploadData.fileId;

    // Simulate file storage by putting bytes into storage driver
    const key = deriveStorageKey(tenant.id, 'GENERAL', fileId, new Date().getUTCFullYear());
    storage.putObject('GENERAL', key, Buffer.from(PDF_BYTES), 'application/pdf');

    // Complete upload
    const completeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/uploads/${fileId}/complete`,
      cookies: { session_token: studentSession.cookie },
      headers: { 'x-csrf-token': studentSession.csrf },
    });
    expect(completeRes.statusCode).toBe(200);

    // Process scan with DocumentScanWorker
    const docSvc = new DocumentService(storage);
    const scanner = new MockMalwareScanner({ verdict: 'CLEAN' });
    const scanWorker = new DocumentScanWorker({
      db,
      documentService: docSvc,
      storage,
      scanner,
    });
    const scanCtx = issueTrustedContext({
      tenantId: tenant.id,
      userId: tenant.adminUserId!,
      actorKind: 'STAFF',
    });

    const scanResult = await scanWorker.processNext(scanCtx);
    expect(scanResult?.outcome).toBe('AVAILABLE');

    // Verify file record is marked CLEAN and AVAILABLE in database
    const fileRows = await adminQuery<{ scan_result: string; status: string }>(
      `SELECT scan_result, status FROM app.files WHERE id = $1 AND organization_id = $2`,
      [fileId, tenant.id],
    );
    expect(fileRows.length).toBe(1);
    expect(fileRows[0]!.scan_result).toBe('CLEAN');
    expect(fileRows[0]!.status).toBe('AVAILABLE');

    // -------------------------------------------------------------------------
    // STEP 7: Notification Dispatch & Inbox Read State
    // -------------------------------------------------------------------------
    const notificationSvc = new NotificationService(emailProvider);
    const staffCtx = issueTrustedContext({
      tenantId: tenant.id,
      userId: tenant.adminUserId!,
      actorKind: 'STAFF',
    });

    const notifResult = await db.withTenant(staffCtx, (tx) =>
      notificationSvc.dispatch(tx, staffCtx, {
        recipientUserId: studentUserId,
        category: 'ANNOUNCEMENT',
        title: 'Rehearsal Complete',
        body: 'Phase 1 integration tests have executed successfully.',
        channels: ['IN_APP', 'EMAIL'],
      }),
    );
    expect(notifResult.notificationId).toBeDefined();

    // Verify student sees it in their notification inbox
    const inboxRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      cookies: { session_token: studentSession.cookie },
    });
    expect(inboxRes.statusCode).toBe(200);
    const notifications = inboxRes.json<NotificationDto[]>();
    const ourNotif = notifications.find((n) => n.id === notifResult.notificationId);
    expect(ourNotif).toBeDefined();
    expect(ourNotif!.readAt).toBeNull();

    // Mark as read
    const markReadRes = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${ourNotif!.id}/read`,
      cookies: { session_token: studentSession.cookie },
      headers: { 'x-csrf-token': studentSession.csrf },
    });
    expect(markReadRes.statusCode).toBe(200);
    expect(markReadRes.json<NotificationDto>().readAt).toBeDefined();

    // -------------------------------------------------------------------------
    // STEP 8: AI Gateway Execution (ADR-013, S-9)
    // -------------------------------------------------------------------------
    const studentCtx = issueTrustedContext({
      tenantId: tenant.id,
      userId: studentUserId,
      actorKind: 'STUDENT',
    });

    const aiResult = await app.aiGateway.executeTool(studentCtx, 'get_my_notifications', {});
    expect(aiResult.isError).toBe(false);
    const rows = aiResult.result as Array<{ id: string; title: string }>;
    expect(rows.some((r) => r.id === notifResult.notificationId)).toBe(true);

    // -------------------------------------------------------------------------
    // STEP 9: Confirm Tenant Isolation & Authorization Boundaries
    // -------------------------------------------------------------------------
    // Log in as a user from OTHER tenant
    const otherSession = await login(otherTenant.emails.admin);

    // Attempt to access this tenant's student record from otherTenant
    const crossTenantStudentRes = await app.inject({
      method: 'GET',
      url: `/api/v1/students/${studentId}`,
      cookies: { session_token: otherSession.cookie },
    });
    // Due to RLS and tenant scoping, this returns 404 (or 403)
    expect([403, 404]).toContain(crossTenantStudentRes.statusCode);

    // Attempt to access this tenant's document download url from otherTenant
    const crossTenantDocRes = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${fileId}/download-url`,
      cookies: { session_token: otherSession.cookie },
    });
    expect([403, 404]).toContain(crossTenantDocRes.statusCode);
  });
});
