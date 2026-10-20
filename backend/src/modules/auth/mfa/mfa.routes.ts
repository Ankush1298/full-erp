import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AppError } from '../../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../../shared/audit/index.js';
import type { FixedWindowLimiter } from '../../../shared/http/fixed-window-limiter.js';
import type { TrustedContext } from '../../../shared/tenancy/trusted-context.js';
import type { MfaService } from './mfa.service.js';

/**
 * doc 11 §5.4 "MFA / step-up", next to the existing /auth/step-up (same root-level placement as every other auth route).
 * Every route names `auth.mfa.manage` (NORMAL, SELF for every role), which is one of the permissions a session of an
 * MFA-required user may use BEFORE it has verified a second factor; nothing here takes a user id: the caller is the subject.
 */
const PERMISSION = 'auth.mfa.manage';
const CODE = Type.String({ pattern: '^[0-9]{6}$' });

function meta(req: FastifyRequest): AuditRequestMeta {
  const m: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') m.userAgent = ua;
  if (req.tenantContext?.sessionId) m.sessionId = req.tenantContext.sessionId;
  return m;
}

function caller(req: FastifyRequest): TrustedContext {
  const ctx = req.tenantContext;
  if (!ctx || !ctx.sessionId) throw new AppError(401, 'UNAUTHORIZED', 'Session required');
  return ctx;
}

/** Secrets and recovery codes must never be cached by a browser or an intermediary. */
function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

export function registerMfaRoutes(
  app: FastifyInstance,
  opts: {
    mfaService: MfaService;
    /** Per-IP, per-session and per-user budget for code guesses (verify, challenge). Single process (FixedWindowLimiter). */
    limiter: FixedWindowLimiter;
  },
): void {
  const { mfaService: svc, limiter } = opts;

  const budget = (req: FastifyRequest, reply: FastifyReply, ctx: TrustedContext): void => {
    const wait = Math.max(
      limiter.take(`ip:${req.ip}`),
      limiter.take(`s:${ctx.sessionId}`),
      limiter.take(`u:${ctx.tenantId}:${ctx.userId}`),
    );
    if (wait > 0) {
      void reply.header('retry-after', String(wait));
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Try again later.');
    }
  };

  app.get('/me/mfa', { config: { permission: PERMISSION } }, async (req, reply) => {
    return reply.send({ success: true, data: await svc.status(caller(req)) });
  });

  app.post(
    '/me/mfa/totp/enroll',
    {
      config: { permission: PERMISSION },
      schema: {
        body: Type.Union([
          Type.Object(
            {
              ticket: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ]),
      },
    },
    async (req, reply) => {
      const body = req.body as { ticket?: string } | null | undefined;
      const data = await svc.startEnrollment(caller(req), body ?? undefined, meta(req));
      noStore(reply);
      return reply.status(201).send({ success: true, data });
    },
  );

  app.delete('/me/mfa/totp/enroll', { config: { permission: PERMISSION } }, async (req, reply) => {
    await svc.cancelEnrollment(caller(req), meta(req));
    return reply.send({ success: true });
  });

  app.post(
    '/me/mfa/totp/verify',
    {
      config: { permission: PERMISSION },
      schema: { body: Type.Object({ code: CODE }, { additionalProperties: false }) },
    },
    async (req, reply) => {
      const ctx = caller(req);
      budget(req, reply, ctx);
      const { code } = req.body as { code: string };
      const out = await svc.confirmEnrollment(ctx, code, meta(req));
      noStore(reply);
      return reply.send({ success: true, data: out });
    },
  );

  app.post(
    '/auth/mfa/challenge',
    {
      config: { permission: PERMISSION },
      schema: {
        body: Type.Object(
          {
            code: Type.Optional(CODE),
            recoveryCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const ctx = caller(req);
      budget(req, reply, ctx);
      const body = req.body as { code?: string; recoveryCode?: string };
      const data = await svc.challenge(ctx, body, meta(req));
      return reply.send({ success: true, data });
    },
  );

  app.post(
    '/me/mfa/recovery-codes/regenerate',
    { config: { permission: PERMISSION } },
    async (req, reply) => {
      const data = await svc.regenerateRecoveryCodes(caller(req), meta(req));
      noStore(reply);
      return reply.send({ success: true, data });
    },
  );

  app.delete('/me/mfa/totp', { config: { permission: PERMISSION } }, async (req, reply) => {
    await svc.disable(caller(req), meta(req));
    return reply.send({ success: true });
  });
}
