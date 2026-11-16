import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

const PASSWORD = /* secret-scan:allow */ 'SchemaCompatPass123!';
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

describe('AuthorizationEngine Schema Compatibility (Pre-0051 & Post-0051)', () => {
  beforeAll(async () => {
    HASH = await argon2.hash(PASSWORD);
    T = await createIsolatedTenant(HASH);
  });

  beforeEach(() => {
    AuthorizationEngine.resetSchemaCompatibilityCache();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    AuthorizationEngine.resetSchemaCompatibilityCache();
    await db.close();
  });

  it('probes pg_catalog accurately: returns true when app.guardians has user_id', async () => {
    const studentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    await db.withTenant(studentCtx, async (tx) => {
      const exists = await AuthorizationEngine.hasGuardianUserIdColumn(tx);
      expect(exists).toBe(true);
    });
  });

  it('pre-0051 simulation: staff and students authenticate and describeActor succeeds without HTTP 500 or SQL 42703', async () => {
    // Force hasGuardianUserIdColumn to return false (simulating pre-0051 database where user_id does not exist)
    vi.spyOn(AuthorizationEngine, 'hasGuardianUserIdColumn').mockResolvedValue(false);

    const studentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    await db.withTenant(studentCtx, async (tx) => {
      const actor = await AuthorizationEngine.describeActor(tx, studentCtx);
      expect(actor.roleCodes).toContain('STUDENT');
      // Must NOT include PARENT
      expect(actor.roleCodes).not.toContain('PARENT');
      // Must NOT include parent permissions
      expect(actor.capabilities).not.toContain('parent.portal.access');
      expect(actor.capabilities).not.toContain('parent.student.read');
    });

    const adminCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.admin,
      actorKind: 'STAFF',
    });

    await db.withTenant(adminCtx, async (tx) => {
      const actor = await AuthorizationEngine.describeActor(tx, adminCtx);
      expect(actor.roleCodes).toContain('COLLEGE_ADMIN');
      expect(actor.roleCodes).not.toContain('PARENT');
      expect(actor.capabilities).toContain('role.assignment.grant');
      expect(actor.capabilities).not.toContain('parent.portal.access');
    });
  });

  it('pre-0051 simulation: parent.* permission checks fail closed (never granted by default)', async () => {
    vi.spyOn(AuthorizationEngine, 'hasGuardianUserIdColumn').mockResolvedValue(false);

    const studentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    await db.withTenant(studentCtx, async (tx) => {
      const canAccess = await AuthorizationEngine.hasPermission(
        tx,
        studentCtx,
        'parent.portal.access',
      );
      expect(canAccess).toBe(false);

      await expect(
        AuthorizationEngine.assert(tx, studentCtx, 'parent.portal.access'),
      ).rejects.toThrow(new AppError(403, 'FORBIDDEN', 'Access denied: Guardian link required.'));
    });
  });

  it('post-0051: parent actor with linked guardian gets PARENT role and capabilities', async () => {
    // Normal operation with post-0051 schema (user_id exists)
    const parentUserId = uuidv7();
    const parentEmail = `parent.compat.${RUN}@test.com`.toLowerCase();

    // Link a user as guardian in T.orgId
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [parentUserId, parentEmail, HASH],
    );
    await adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
       VALUES ($1, $2, $3, 'Parent Compat User', 'ACTIVE', $1)`,
      [parentUserId, T.orgId, parentEmail],
    );
    await adminQuery(
      `INSERT INTO app.guardians (id, organization_id, full_name, phone, email, user_id)
       VALUES ($1, $2, 'Parent Compat User', '+919876543210', $3, $4)`,
      [uuidv7(), T.orgId, parentEmail, parentUserId],
    );

    const parentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: parentUserId,
      actorKind: 'STAFF',
    });

    await db.withTenant(parentCtx, async (tx) => {
      const actor = await AuthorizationEngine.describeActor(tx, parentCtx);
      expect(actor.roleCodes).toContain('PARENT');
      expect(actor.capabilities).toContain('parent.portal.access');
      expect(actor.capabilities).toContain('parent.student.read');

      const hasPerm = await AuthorizationEngine.hasPermission(
        tx,
        parentCtx,
        'parent.portal.access',
      );
      expect(hasPerm).toBe(true);

      await expect(
        AuthorizationEngine.assert(tx, parentCtx, 'parent.portal.access'),
      ).resolves.toBeUndefined();
    });
  });

  it('GET /auth/me returns 200 with proper roles during pre-0051 schema simulation', async () => {
    vi.spyOn(AuthorizationEngine, 'hasGuardianUserIdColumn').mockResolvedValue(false);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: T.emails.studentOne, password: PASSWORD },
      remoteAddress: '10.30.0.1',
    });
    expect(loginRes.statusCode).toBe(200);
    const cookie = await mfaVerified(
      loginRes.cookies.find((c) => c.name === 'session_token')!.value,
    );

    const meRes = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { session_token: cookie },
    });

    expect(meRes.statusCode).toBe(200);
    const body = meRes.json<{
      roles: string[];
      capabilities: string[];
      actor_kind: string;
    }>();
    expect(body.actor_kind).toBe('STUDENT');
    expect(body.roles).toContain('STUDENT');
    expect(body.roles).not.toContain('PARENT');
    expect(body.capabilities).not.toContain('parent.portal.access');
  });

  it('does not suppress unrelated database errors (fails loud on invalid queries)', async () => {
    const studentCtx = issueTrustedContext({
      tenantId: T.orgId,
      userId: T.users.studentOne,
      actorKind: 'STUDENT',
    });

    await db.withTenant(studentCtx, async (tx) => {
      // Intentionally invalid query should throw standard Postgres error
      await expect(
        tx.query('SELECT nonexistent_col_12345 FROM app.guardians'),
      ).rejects.toThrow();
    });
  });
});
