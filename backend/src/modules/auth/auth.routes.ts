import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from './auth.service.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { csrfTokenFor } from './csrf.js';
import { hashToken } from './auth.repository.js';
import type { LoginRateLimiter } from './login-limiter.js';
import { FixedWindowLimiter } from '../../shared/http/fixed-window-limiter.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { INVITE_TOKEN_PATTERN, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './auth.service.js';
import { SESSION_COOKIE, SESSION_COOKIE_ATTRS, SESSION_MAX_AGE_SECONDS } from './session-cookie.js';

interface LoginBody {
  email: string;
  password?: string;
  tenant?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  opts: {
    authService?: AuthService | undefined;
    loginLimiter?: LoginRateLimiter | undefined;
    /** Per-IP and per-token request budget for accept-invite (single process, see FixedWindowLimiter). */
    acceptLimiter?: FixedWindowLimiter | undefined;
    /** Per-IP and per-session request budget for step-up (single process, see FixedWindowLimiter). */
    stepUpLimiter?: FixedWindowLimiter | undefined;
  } = {},
): void {
  // If not provided, construct defaults. This assumes `app.db` doesn't exist, we usually pass `db` to modules or get it from some global context, but we can just use `app.db` if we decorate it, or we construct the service inside `buildApp`.
  // Actually, standard practice in this repo seems to be passing dependencies via options.
  const authService = opts.authService;
  const stepUpLimiter =
    opts.stepUpLimiter ??
    new FixedWindowLimiter({ limit: 5, windowMs: 15 * 60_000, maxKeys: 10_000 });

  app.post(
    '/auth/login',
    {
      config: { public: true },
      schema: {
        body: Type.Object({
          email: Type.String({ format: 'email' }),
          password: Type.String(),
          tenant: Type.Optional(Type.String()),
        }),
      },
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const { email, password, tenant } = request.body as LoginBody;

      // Per-IP / per-(IP, account) budget, checked BEFORE any password work and independent of
      // whether the account exists. request.ip honours X-Forwarded-For only when TRUST_PROXY is set.
      const limiter = opts.loginLimiter;
      const wait = limiter?.check(request.ip, email) ?? 0;
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.');
      }

      let result;
      try {
        result = await authService.login(email, password ?? '', tenant);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 401)
          limiter?.recordFailure(request.ip, email);
        throw err;
      }
      limiter?.recordSuccess(request.ip, email);

      reply.cookie(SESSION_COOKIE, result.sessionToken, {
        ...SESSION_COOKIE_ATTRS,
        maxAge: SESSION_MAX_AGE_SECONDS,
      });

      return reply.send({
        success: true,
        tenant_id: result.tenantId,
        csrf_token: csrfTokenFor(result.sessionToken),
      });
    },
  );

  // Public (no session exists yet), CSRF Origin-checked like every unsafe request. The body carries ONLY the token and a
  // password: no tenant, user, role or scope field is accepted (additionalProperties: false).
  app.post(
    '/auth/accept-invite',
    {
      config: { public: true },
      schema: {
        body: Type.Object(
          {
            token: Type.String({ pattern: INVITE_TOKEN_PATTERN }),
            password: Type.String({
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const { token, password } = request.body as { token: string; password: string };

      // Budget BEFORE any work: per client IP, and per token string (so one captured token cannot be hammered).
      const limiter = opts.acceptLimiter;
      const wait = Math.max(
        limiter?.take(`ip:${request.ip}`) ?? 0,
        limiter?.take(`t:${hashToken(token)}`) ?? 0,
      );
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.');
      }

      const meta: AuditRequestMeta = { ip: request.ip, requestId: request.id };
      const ua = request.headers['user-agent'];
      if (typeof ua === 'string') meta.userAgent = ua;
      await authService.acceptInvitation(token, password, meta);
      return reply.send({ success: true });
    },
  );

  app.post(
    '/auth/logout',
    {
      config: { public: true }, // We can still call this without a 401 if they are already logged out
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const token = request.cookies[SESSION_COOKIE];
      if (token) {
        await authService.logout(token);
      }
      reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_ATTRS);
      return reply.send({ success: true });
    },
  );

  app.get(
    '/auth/me',
    {
      // The caller's own session only: the identity is the authenticated one, there is no target id.
      config: { permission: 'session.read' },
    },
    async (request, reply) => {
      // This route requires authentication. Fastify hooks will run and attach the context to request.tenantContext.
      // See auth.hook.ts for how we attach this.
      const ctx = request.tenantContext;
      if (!ctx) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }

      // display_name / roles / capabilities: for rendering menus only; every action is re-checked
      // server-side. Spread so no route code ever inspects role names.
      if (!authService) throw new Error('authService not provided');
      const profile = await authService.describe(ctx);
      return reply.send({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        actor_kind: ctx.actorKind,
        ...profile,
        csrf_token: csrfTokenFor(request.cookies[SESSION_COOKIE] ?? ''),
      });
    },
  );

  // Authenticated (permission: session.read; NORMAL sensitivity so step-up itself is not required).
  // Elevates the current session's authStrength to PASSWORD_REAUTH.
  app.post(
    '/auth/step-up',
    {
      config: { permission: 'session.read' },
      schema: {
        body: Type.Object(
          {
            password: Type.String({
              minLength: MIN_PASSWORD_LENGTH,
              maxLength: MAX_PASSWORD_LENGTH,
            }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (!authService) throw new Error('authService not provided');
      const ctx = request.tenantContext;
      if (!ctx || !ctx.sessionId) {
        throw new AppError(401, 'UNAUTHORIZED', 'Session required');
      }

      const { password } = request.body as { password: string };

      // Budget BEFORE any work: per IP and per sessionId
      const wait = Math.max(
        stepUpLimiter.take(`ip:${request.ip}`),
        stepUpLimiter.take(`s:${ctx.sessionId}`),
      );
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.');
      }

      const meta: AuditRequestMeta = {
        ip: request.ip,
        requestId: request.id,
        sessionId: ctx.sessionId,
      };
      const ua = request.headers['user-agent'];
      if (typeof ua === 'string') meta.userAgent = ua;

      const result = await authService.stepUp(ctx, password, meta);
      return reply.send({ success: true, data: result });
    },
  );
}
