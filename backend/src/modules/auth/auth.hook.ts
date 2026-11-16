import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { AuthService } from './auth.service.js';
import {
  isAuthStrength,
  type AuthStrength,
  type TrustedContext,
} from '../../shared/tenancy/trusted-context.js';
import { AppError, scopeNotFound } from '../../shared/errors/http-errors.js';
import { AuthorizationEngine, type ResourceScope } from '../../shared/authorization/engine.js';
import { PERMISSION_CATALOG, type Sensitivity } from '../../shared/authorization/catalog.js';
import type { Database } from '../../shared/database/index.js';
import { auditAuthorizationDenial } from '../../shared/audit/index.js';
import { assertCsrfToken, assertOrigin, isUnsafeMethod } from './csrf.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { isMfaRequired, MFA_EXEMPT_PERMISSIONS } from '../../shared/authorization/mfa-policy.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TrustedContext;
  }
  interface FastifyContextConfig {
    permission?: string | readonly string[];
    extractScope?: (req: FastifyRequest) => ResourceScope | undefined;
  }
}

export interface AuthPluginOptions {
  authService: AuthService;
  db: Database;
  /** Exact browser origins allowed for state-changing requests (empty = same host only). */
  allowedOrigins: readonly string[];
  /** Minimum assurance required for CRITICAL permissions. Defaults to 'PASSWORD_MFA'. */
  minAssuranceForCritical?: AuthStrength | undefined;
  /** Maximum lifetime of step-up verification in milliseconds. Defaults to 600_000 (10 minutes). */
  stepUpMaxAgeMs?: number | undefined;
  /** Clock function. Defaults to Date.now. */
  now?: (() => number) | undefined;
}

const PERMISSION_SENSITIVITY = new Map<string, Sensitivity>(
  PERMISSION_CATALOG.map((p) => [p.code, p.sensitivity]),
);

const ASSURANCE_RANK: Record<AuthStrength, number> = {
  PASSWORD: 1,
  PASSWORD_REAUTH: 2,
  PASSWORD_MFA: 3,
};

/** Allowed clock skew between the database-written `step_up_at` and this process's clock. */
const STEP_UP_CLOCK_SKEW_MS = 5_000;

interface RouteModuleMapping {
  prefix: string;
  moduleKey: string;
  name: string;
}

const ROUTE_TO_MODULE_MAP: readonly RouteModuleMapping[] = [
  { prefix: '/api/v1/academics', moduleKey: 'academics', name: 'Academics & Cohort Management' },
  { prefix: '/api/v1/attendance', moduleKey: 'attendance', name: 'Attendance & Class Tracking' },
  { prefix: '/api/v1/examinations', moduleKey: 'examinations', name: 'Examinations, Marks & Report Cards' },
  { prefix: '/api/v1/homework', moduleKey: 'homework', name: 'Homework & Assignment Workflow' },
  { prefix: '/api/v1/finance', moduleKey: 'finance', name: 'Fees & Finance Ledger' },
  { prefix: '/api/v1/parent', moduleKey: 'parent_portal', name: 'Parent / Guardian Portal' },
  { prefix: '/api/v1/vault', moduleKey: 'school_vault', name: 'School Vault Zero-Access Enclave' },
  { prefix: '/api/v1/documents', moduleKey: 'documents', name: 'Document Center & Storage' },
  { prefix: '/api/v1/reporting', moduleKey: 'reports', name: 'Institutional Analytics & Reports' },
  { prefix: '/api/v1/students/imports', moduleKey: 'imports', name: 'Bulk Data Imports' },
  { prefix: '/api/v1/faculty/imports', moduleKey: 'imports', name: 'Bulk Data Imports' },
  { prefix: '/api/v1/consent', moduleKey: 'consents', name: 'Institutional Consent & Policy Management' },
  { prefix: '/api/v1/notifications', moduleKey: 'notifications', name: 'Omnichannel Notifications & Dispatch' },
];

/**
 * Is the session's step-up assurance sufficient for a CRITICAL action? FAIL CLOSED: every input is re-validated here
 * (defence in depth behind issueTrustedContext), and anything missing, malformed, unrecognized or out of range is a
 * plain `false`; denial never depends on an `undefined`/`NaN` comparison happening to come out false.
 */
export function isStepUpSatisfied(
  ctx: TrustedContext,
  minAssurance: unknown,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const stepUpAt: unknown = ctx.stepUpAt;
  if (!(stepUpAt instanceof Date)) return false; // null, undefined, strings, numbers, look-alike objects
  // Through the prototype: an own `getTime` on a Date look-alike must not decide for us.
  const stepUpMs = Date.prototype.getTime.call(stepUpAt);
  if (!Number.isFinite(stepUpMs) || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs)) {
    return false;
  }
  const actual: unknown = ctx.authStrength;
  if (!isAuthStrength(actual) || !isAuthStrength(minAssurance)) return false;
  return (
    stepUpMs <= nowMs + STEP_UP_CLOCK_SKEW_MS && // not from the future beyond the skew tolerance
    nowMs - stepUpMs <= maxAgeMs && // not expired
    ASSURANCE_RANK[actual] >= ASSURANCE_RANK[minAssurance]
  );
}

/** Has THIS session completed a second factor (TOTP or recovery code)? Fail closed on anything but a sane past Date. */
export function hasSessionMfa(ctx: TrustedContext, nowMs: number): boolean {
  const at: unknown = ctx.mfaVerifiedAt;
  if (!(at instanceof Date)) return false;
  const ms = Date.prototype.getTime.call(at);
  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms <= nowMs + STEP_UP_CLOCK_SKEW_MS;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  await Promise.resolve();
  app.decorateRequest('tenantContext', undefined);

  // 0. CSRF origin check: every state-changing request, public routes (login/logout) included.
  app.addHook('onRequest', (request, _reply, done) => {
    try {
      if (!request.is404 && isUnsafeMethod(request.method)) {
        assertOrigin(request, opts.allowedOrigins);
      }
      done();
    } catch (err) {
      done(err as Error);
    }
  });

  app.addHook('onRequest', (request, _reply, done) => {
    // 1. Identity & Auth Check
    if (request.routeOptions?.config?.public || request.is404) {
      return done();
    }

    const runAuth = async () => {
      const token = request.cookies[SESSION_COOKIE];
      if (!token) {
        throw new AppError(401, 'UNAUTHORIZED', 'Missing authentication token');
      }

      try {
        const ctx = await opts.authService.validateSession(token);
        request.tenantContext = ctx;
      } catch (err: unknown) {
        if (err instanceof AppError && (err.statusCode === 401 || err.statusCode === 403)) {
          throw err;
        }
        request.log.warn({ err }, 'Session validation failed; rejecting invalid session with 401');
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired session');
      }

      // 1b. CSRF token: required for every authenticated state-changing request.
      if (isUnsafeMethod(request.method)) assertCsrfToken(request, token);
    };

    runAuth()
      .then(() => done())
      .catch((err) => done(err));
  });

  app.addHook('preHandler', async (request, _reply) => {
    // 2. Authorization Check (Slice 3)
    if (request.routeOptions?.config?.public || request.is404) {
      return;
    }

    const ctx = request.tenantContext;
    if (!ctx) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const config = request.routeOptions?.config;
    if (!config || !config.permission) {
      throw new AppError(
        500,
        'INTERNAL_ERROR',
        'Route is missing required permission configuration',
      );
    }

    const scope = config.extractScope ? config.extractScope(request) : undefined;
    const perms = Array.isArray(config.permission)
      ? (config.permission as readonly string[])
      : [config.permission as string];

    for (const perm of perms) {
      if (!PERMISSION_SENSITIVITY.has(perm)) {
        throw new AppError(
          500,
          'INTERNAL_ERROR',
          `Missing sensitivity metadata for permission: ${perm}`,
        );
      }
    }

    // MFA-required roles (ADR-004): until THIS session has completed a second factor, only the exempt routes (own
    // session, own MFA enrollment/verification) are reachable. Checked before the permission itself, so a restricted
    // session learns nothing about what it could do after verification.
    const mfaGated = perms.some((p) => !MFA_EXEMPT_PERMISSIONS.has(p));
    const nowMs = (opts.now ?? Date.now)();

    // We execute the check using the configured permission(s) and scope extractor
    let authorizedPermission: string | undefined;
    await opts.db.withTenant(ctx, async (tx) => {
      // Paid module entitlements check
      const matchedModule = ROUTE_TO_MODULE_MAP.find((m) => request.url.startsWith(m.prefix));
      if (matchedModule) {
        const entRes = await tx.query<{ value: unknown }>(
          "SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'feature.entitlements'",
          [ctx.tenantId],
        );
        if (entRes.rows[0]?.value) {
          const val = entRes.rows[0].value as any;
          let enabled = true;
          if (Array.isArray(val.modules)) {
            const found = val.modules.find((m: any) => m.key === matchedModule.moduleKey);
            if (found && found.enabled === false) {
              enabled = false;
            }
          } else if (val.modules && typeof val.modules === 'object') {
            const found = val.modules[matchedModule.moduleKey];
            if (found && (found.enabled === false || found === false)) {
              enabled = false;
            }
          }
          if (!enabled) {
            throw new AppError(
              403,
              'MODULE_NOT_ENTITLED',
              `Module "${matchedModule.name}" is not included in the institution's current subscription plan. Contact platform administrator to upgrade.`,
            );
          }
        }
      }

      if (
        mfaGated &&
        !hasSessionMfa(ctx, nowMs) &&
        (await isMfaRequired(tx, ctx.tenantId, ctx.userId))
      ) {
        throw new AppError(
          403,
          'MFA_REQUIRED',
          'Multi-factor authentication is required for this account. Enroll or verify a second factor.',
        );
      }
      let authorized = false;
      for (const perm of perms) {
        if (!scope) {
          if (await AuthorizationEngine.hasPermission(tx, ctx, perm)) {
            authorized = true;
            authorizedPermission = perm;
            break;
          }
        } else {
          try {
            await AuthorizationEngine.assert(tx, ctx, perm, scope);
            authorized = true;
            authorizedPermission = perm;
            break;
          } catch {
            // try next permission
          }
        }
      }
      if (!authorized) {
        if (!scope) throw new AppError(403, 'FORBIDDEN', 'Access denied.');
        throw scopeNotFound(perms[0]);
      }
    });

    const isCriticalRoute =
      (authorizedPermission !== undefined &&
        PERMISSION_SENSITIVITY.get(authorizedPermission) === 'CRITICAL') ||
      perms.some((p) => PERMISSION_SENSITIVITY.get(p) === 'CRITICAL');

    if (isCriticalRoute) {
      const minAssurance = opts.minAssuranceForCritical ?? 'PASSWORD_MFA';
      const maxAgeMs = opts.stepUpMaxAgeMs ?? 600_000;

      if (!isStepUpSatisfied(ctx, minAssurance, nowMs, maxAgeMs)) {
        throw new AppError(
          403,
          'STEP_UP_REQUIRED',
          'Step-up authentication required for critical action.',
        );
      }
    }
  });

  // 3. Centralized Authorization-Denial Auditing (D9)
  app.addHook('onError', async (request, _reply, error) => {
    if (!request.tenantContext) return;
    if ((request as unknown as { _denialAuditRecorded?: boolean })._denialAuditRecorded) return;

    if (error instanceof AppError) {
      if (
        error.statusCode === 403 &&
        (error.code === 'FORBIDDEN' ||
          error.code === 'STEP_UP_REQUIRED' ||
          error.code === 'MFA_REQUIRED')
      ) {
        const config = request.routeOptions?.config;
        const perms = config?.permission
          ? Array.isArray(config.permission)
            ? config.permission
            : [config.permission]
          : undefined;
        const reason =
          error.code === 'STEP_UP_REQUIRED' || error.code === 'MFA_REQUIRED'
            ? error.code
            : 'PERMISSION_DENIED';
        await auditAuthorizationDenial(opts.db, request, {
          permission: perms,
          reason,
          requiredAssurance:
            error.code === 'STEP_UP_REQUIRED'
              ? (opts.minAssuranceForCritical ?? 'PASSWORD_MFA')
              : undefined,
          currentAssurance:
            error.code === 'STEP_UP_REQUIRED' ? request.tenantContext?.authStrength : undefined,
        });
      } else if (
        error.statusCode === 404 &&
        (error as unknown as { isScopeDenial?: boolean }).isScopeDenial
      ) {
        const config = request.routeOptions?.config;
        const deniedPerm = (error as unknown as { deniedPermission?: string }).deniedPermission;
        const perms = deniedPerm
          ? [deniedPerm]
          : config?.permission
            ? Array.isArray(config.permission)
              ? config.permission
              : [config.permission]
            : undefined;
        await auditAuthorizationDenial(opts.db, request, {
          permission: perms,
          reason: 'OUT_OF_SCOPE',
        });
      }
    }
  });
};

export default fp(authPlugin, {
  name: 'smart-campus-auth-hook',
  dependencies: ['@fastify/cookie'],
});
