import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { InvitationMailer } from '../../src/shared/email/invitation-mailer.js';
import { OnboardingError } from './first-admin.js';
import { PlatformService, type PlatformDb } from './platform.service.js';
import { ERP_MODULE_CATALOG, STANDARD_PLAN_BUNDLES } from './module-registry.js';
import type {
  CreateInstitutionInput,
  GrantAuthorityInput,
  ListInstitutionsQuery,
  ReconcileRolesInput,
  SetEntitlementsInput,
  SetSubscriptionInput,
  UpdateInstitutionInput,
} from './platform.schemas.js';

export interface PlatformRoutesOptions {
  db: PlatformDb;
  appOrigin?: string | undefined;
  invitationMailer?: InvitationMailer | undefined;
}

function mapOnboardingError(err: unknown): never {
  if (err instanceof OnboardingError) {
    const status =
      err.code === 'TENANT_NOT_FOUND'
        ? 404
        : err.code === 'INVALID_TTL' || err.code === 'TENANT_REQUIRED'
          ? 400
          : 409;
    throw new AppError(status, err.code, err.message);
  }
  throw err;
}

const DEFAULT_PLATFORM_KEY = 'change_me_platform_dev_token';

export interface PlatformSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  lastActivityAt: Date;
  role: 'OPERATOR';
  mfaVerified: boolean;
}

export class PlatformSessionStore {
  readonly #sessions = new Map<string, PlatformSession>();
  readonly #sessionTtlMs = 8 * 60 * 60 * 1000; // 8 hours
  readonly #idleTimeoutMs = 60 * 60 * 1000; // 60 minutes idle

  createSession(options?: { mfaVerified?: boolean }): PlatformSession {
    const id = `psess_${crypto.randomBytes(32).toString('hex')}`;
    const now = new Date();
    const session: PlatformSession = {
      id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#sessionTtlMs),
      lastActivityAt: now,
      role: 'OPERATOR',
      mfaVerified: options?.mfaVerified ?? true,
    };
    this.#sessions.set(id, session);
    return session;
  }

  validateSession(id: string | undefined): PlatformSession | null {
    if (!id) return null;
    const session = this.#sessions.get(id);
    if (!session) return null;

    const now = new Date();
    if (now > session.expiresAt) {
      this.#sessions.delete(id);
      return null;
    }

    if (now.getTime() - session.lastActivityAt.getTime() > this.#idleTimeoutMs) {
      this.#sessions.delete(id);
      return null;
    }

    session.lastActivityAt = now;
    return session;
  }

  revokeSession(id: string): void {
    this.#sessions.delete(id);
  }
}

export const platformSessionStore = new PlatformSessionStore();

export function verifyPlatformAuth(req: FastifyRequest): PlatformSession | { role: 'OPERATOR' } {
  // 1. Check HttpOnly cookie
  const reqWithCookies = req as FastifyRequest & { cookies?: Record<string, string | undefined> };
  const cookieSessionId = reqWithCookies.cookies?.['campusos_platform_session'];
  if (cookieSessionId) {
    const session = platformSessionStore.validateSession(cookieSessionId);
    if (session) return session;
  }

  // 2. Check header x-platform-session
  const sessionHeader = req.headers['x-platform-session'];
  if (typeof sessionHeader === 'string') {
    const session = platformSessionStore.validateSession(sessionHeader);
    if (session) return session;
  }

  // 3. Check legacy / token headers: x-platform-token or Authorization: Bearer ...
  const customHeader = req.headers['x-platform-token'];
  const authHeader = req.headers['authorization'];
  let bearerToken: string | undefined;

  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const token = typeof customHeader === 'string' ? customHeader : bearerToken;
  const expectedKey = process.env['PLATFORM_ADMIN_TOKEN'] || DEFAULT_PLATFORM_KEY;

  if (token && token === expectedKey) {
    return { role: 'OPERATOR' };
  }

  throw new AppError(401, 'UNAUTHORIZED', 'Invalid or missing platform operator credentials');
}

export const registerPlatformRoutes: FastifyPluginAsync<PlatformRoutesOptions> = async (
  app: FastifyInstance,
  opts: PlatformRoutesOptions,
) => {
  await Promise.resolve();
  const platformService = new PlatformService(opts.db, {
    appOrigin: opts.appOrigin,
    invitationMailer: opts.invitationMailer,
  });

  // Guard all non-auth /platform routes with platform operator verification
  app.addHook('preHandler', async (req) => {
    await Promise.resolve();
    const url = req.url.split('?')[0]!;
    if (url.endsWith('/auth/login') || url.endsWith('/auth/me') || url.endsWith('/auth/logout')) {
      return;
    }
    verifyPlatformAuth(req);
  });

  // Auth: Login
  app.post<{ Body: { operatorToken?: string; token?: string; mfaCode?: string } }>(
    '/auth/login',
    { config: { public: true } },
    async (req, reply) => {
      const token = req.body?.operatorToken || req.body?.token;
      const expectedKey = process.env['PLATFORM_ADMIN_TOKEN'] || DEFAULT_PLATFORM_KEY;
      if (!token || token.trim() !== expectedKey) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid operator credential');
      }
      const session = platformSessionStore.createSession({ mfaVerified: true });
      const isProd = process.env['NODE_ENV'] === 'production';
      (
        reply as FastifyReply & {
          setCookie: (name: string, value: string, options?: Record<string, unknown>) => void;
        }
      ).setCookie('campusos_platform_session', session.id, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd,
        maxAge: 28800,
      });
      return {
        success: true,
        authenticated: true,
        session: {
          id: session.id,
          expiresAt: session.expiresAt.toISOString(),
          role: session.role,
        },
      };
    },
  );

  // Auth: Me / Session Status
  app.get('/auth/me', { config: { public: true } }, async (req) => {
    await Promise.resolve();
    try {
      const auth = verifyPlatformAuth(req);
      return {
        success: true,
        authenticated: true,
        operator: {
          role: 'OPERATOR',
          authMethod: 'id' in auth ? 'SESSION_COOKIE' : 'HEADER_KEY',
        },
      };
    } catch {
      return {
        success: false,
        authenticated: false,
      };
    }
  });

  // Auth: Logout
  app.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    await Promise.resolve();
    const reqWithCookies = req as FastifyRequest & { cookies?: Record<string, string | undefined> };
    const cookieSessionId = reqWithCookies.cookies?.['campusos_platform_session'];
    if (cookieSessionId) {
      platformSessionStore.revokeSession(cookieSessionId);
    }
    (
      reply as FastifyReply & {
        clearCookie: (name: string, options?: Record<string, unknown>) => void;
      }
    ).clearCookie('campusos_platform_session', { path: '/' });
    return { success: true, message: 'Platform operator session cleared' };
  });

  // 1. High-level Platform Stats & Health
  app.get(
    '/stats',
    {
      config: { public: true },
    },
    async () => {
      const stats = await platformService.getPlatformStats();
      return { success: true, data: stats };
    },
  );

  // 2. Global Module Catalog & Bundles
  app.get(
    '/catalog/modules',
    {
      config: { public: true },
    },
    async () => {
      await Promise.resolve();
      return { success: true, data: ERP_MODULE_CATALOG };
    },
  );

  app.get(
    '/catalog/bundles',
    {
      config: { public: true },
    },
    async () => {
      await Promise.resolve();
      return { success: true, data: STANDARD_PLAN_BUNDLES };
    },
  );

  // 3. Platform Audit Events
  app.get<{ Querystring: { limit?: string } }>(
    '/audit',
    {
      config: { public: true },
    },
    async (req) => {
      const limit = req.query.limit
        ? Math.min(100, Math.max(1, parseInt(req.query.limit, 10)))
        : 50;
      const events = await platformService.getPlatformAuditEvents(limit);
      return { success: true, data: events };
    },
  );

  // 4. Institutions Directory & Search
  app.get<{ Querystring: ListInstitutionsQuery }>(
    '/institutions',
    {
      config: { public: true },
    },
    async (req) => {
      const result = await platformService.listInstitutions(req.query);
      return { success: true, data: result };
    },
  );

  // 5. Create New Institution
  app.post<{ Body: CreateInstitutionInput }>(
    '/institutions',
    {
      config: { public: true },
    },
    async (req, reply) => {
      const institution = await platformService.createInstitution(req.body);
      reply.status(201);
      return { success: true, data: institution };
    },
  );

  // 6. Institution Detail
  app.get<{ Params: { id: string } }>(
    '/institutions/:id',
    {
      config: { public: true },
    },
    async (req) => {
      const detail = await platformService.getInstitutionDetail(req.params.id);
      return { success: true, data: detail };
    },
  );

  // 7. Update Institution
  app.patch<{ Params: { id: string }; Body: UpdateInstitutionInput }>(
    '/institutions/:id',
    {
      config: { public: true },
    },
    async (req) => {
      const updated = await platformService.updateInstitution(req.params.id, req.body);
      return { success: true, data: updated };
    },
  );

  // 8. Suspend Institution
  app.post<{ Params: { id: string } }>(
    '/institutions/:id/suspend',
    {
      config: { public: true },
    },
    async (req) => {
      const result = await platformService.updateInstitution(req.params.id, {
        status: 'SUSPENDED',
      });
      return { success: true, data: result };
    },
  );

  // 9. Reactivate Institution
  app.post<{ Params: { id: string } }>(
    '/institutions/:id/reactivate',
    {
      config: { public: true },
    },
    async (req) => {
      const result = await platformService.updateInstitution(req.params.id, { status: 'ACTIVE' });
      return { success: true, data: result };
    },
  );

  // 10. Get Institution Entitlements
  app.get<{ Params: { id: string } }>(
    '/institutions/:id/entitlements',
    {
      config: { public: true },
    },
    async (req) => {
      const detail = await platformService.getInstitutionDetail(req.params.id);
      return { success: true, data: detail.entitlements };
    },
  );

  // 11. Set Institution Entitlements
  app.put<{ Params: { id: string }; Body: SetEntitlementsInput }>(
    '/institutions/:id/entitlements',
    {
      config: { public: true },
    },
    async (req) => {
      const updated = await platformService.setEntitlements(req.params.id, req.body);
      return { success: true, data: updated };
    },
  );

  // 12. Get Institution Subscription
  app.get<{ Params: { id: string } }>(
    '/institutions/:id/subscription',
    {
      config: { public: true },
    },
    async (req) => {
      const detail = await platformService.getInstitutionDetail(req.params.id);
      return { success: true, data: detail.subscription };
    },
  );

  // 13. Set Institution Subscription
  app.put<{ Params: { id: string }; Body: SetSubscriptionInput }>(
    '/institutions/:id/subscription',
    {
      config: { public: true },
    },
    async (req) => {
      const updated = await platformService.setSubscription(req.params.id, req.body);
      return { success: true, data: updated };
    },
  );

  // 14. Reconcile Roles
  app.post<{ Params: { id: string }; Body: ReconcileRolesInput }>(
    '/institutions/:id/roles/reconcile',
    {
      config: { public: true },
    },
    async (req) => {
      const result = await platformService.reconcileRoles(req.params.id, req.body);
      return { success: true, data: result };
    },
  );

  // 15. Grant Critical Authority
  app.post<{ Params: { id: string }; Body: GrantAuthorityInput }>(
    '/institutions/:id/authorities/grant',
    {
      config: { public: true },
    },
    async (req) => {
      const result = await platformService.grantCriticalAuthority(req.params.id, req.body);
      return { success: true, data: result };
    },
  );

  // 16. Issue or Reissue First-Administrator Invitation
  app.post<{
    Params: { id: string };
    Body?: { ttlHours?: number; reason?: string; sendEmail?: boolean };
  }>(
    '/institutions/:id/first-admin/invite',
    {
      config: { public: true },
    },
    async (req, reply) => {
      try {
        const result = await platformService.issueFirstAdminInvite(req.params.id, {
          ...(req.body?.ttlHours !== undefined ? { ttlHours: req.body.ttlHours } : {}),
          ...(req.body?.reason ? { reason: req.body.reason } : {}),
          ...(req.body?.sendEmail !== undefined ? { sendEmail: req.body.sendEmail } : {}),
          requestOrigin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
        });
        reply.status(201);
        return { success: true, data: result };
      } catch (err) {
        mapOnboardingError(err);
      }
    },
  );

  // 17. Revoke Unused First-Administrator Invitation
  app.post<{
    Params: { id: string };
    Body?: { reason?: string };
  }>(
    '/institutions/:id/first-admin/invite/revoke',
    {
      config: { public: true },
    },
    async (req) => {
      try {
        const result = await platformService.revokeFirstAdminInvite(req.params.id, {
          ...(req.body?.reason ? { reason: req.body.reason } : {}),
        });
        return { success: true, data: result };
      } catch (err) {
        mapOnboardingError(err);
      }
    },
  );

  // 18. Issue First-Administrator MFA Bootstrap Ticket
  app.post<{
    Params: { id: string };
    Body?: { reason?: string };
  }>(
    '/institutions/:id/first-admin/mfa-ticket',
    {
      config: { public: true },
    },
    async (req, reply) => {
      try {
        const result = await platformService.issueFirstAdminMfaBootstrapTicket(req.params.id, {
          ...(req.body?.reason ? { reason: req.body.reason } : {}),
        });
        reply.status(201);
        return { success: true, data: result };
      } catch (err) {
        mapOnboardingError(err);
      }
    },
  );
};
