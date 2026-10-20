import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerHardening } from './shared/http/hardening.js';
import { loggerOptions, type AppLoggerOptions } from './shared/logging/logger-options.js';
import fastifyCookie from '@fastify/cookie';
import authHook from './modules/auth/auth.hook.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { LoginRateLimiter } from './modules/auth/login-limiter.js';
import { AuthService } from './modules/auth/auth.service.js';
import { AuthRepository } from './modules/auth/auth.repository.js';
import { registerOrganizationRoutes } from './modules/organization/organization.routes.js';
import { registerAcademicsRoutes } from './modules/academics/academic.routes.js';
import { registerPeopleRoutes } from './modules/people/employee.routes.js';
import { registerStudentRoutes } from './modules/students/student.routes.js';
import { registerStudentGuardianRoutes } from './modules/students/student-guardian.routes.js';
import { registerUserRoutes } from './modules/users/user.routes.js';
import {
  DisabledInvitationMailer,
  type InvitationMailer,
} from './shared/email/invitation-mailer.js';
import {
  createDirectoryLimiter,
  registerStudentDirectoryRoutes,
} from './modules/students/student-directory.routes.js';
import { FixedWindowLimiter } from './shared/http/fixed-window-limiter.js';
import { createCursorCodec, type CursorCodec } from './shared/pagination/index.js';
import type { Database } from './shared/database/index.js';
import { PERMISSION_CODES } from './shared/authorization/catalog.js';
import type { AuthStrength } from './shared/tenancy/trusted-context.js';
import { MfaService } from './modules/auth/mfa/mfa.service.js';
import { registerMfaRoutes } from './modules/auth/mfa/mfa.routes.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as intentionally unauthenticated. Every other route will require a permission (Slice 3). */
    public?: boolean;
    permission?: string | readonly string[];
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Database;
  /** Tests may pass `false` to silence logs or a custom pino-compatible stream via logger options. */
  logger?: AppLoggerOptions | false;
  /** Tests inject a limiter with a fake clock; production uses the default. */
  loginLimiter?: LoginRateLimiter;
  /** Tests inject a limiter with a fake clock for the student directory; production uses the default. */
  directoryLimiter?: FixedWindowLimiter;
  /** Tests may pin the cursor clock; production builds the codec from `config.cursor` with the system clock. */
  cursorCodec?: CursorCodec;
  /**
   * Delivers invitation tokens. Default: a mailer that sends nothing and fails closed (no provider is approved). Tests and
   * local development inject InMemoryInvitationMailer; production needs a reviewed provider.
   */
  invitationMailer?: InvitationMailer;
  /** Tests inject limiters with a fake clock; production uses the defaults. */
  inviteLimiter?: FixedWindowLimiter;
  acceptInviteLimiter?: FixedWindowLimiter;
  /** Tests inject a limiter with a fake clock for step-up; production uses the default. */
  stepUpLimiter?: FixedWindowLimiter;
  /** Minimum assurance required for CRITICAL permissions. Defaults to 'PASSWORD_MFA'. */
  minAssuranceForCritical?: AuthStrength;
  /** Maximum age of step-up verification in ms. Defaults to 600_000 (10 minutes). */
  stepUpMaxAgeMs?: number;
  /** Clock source for step-up verification and TOTP time steps. Defaults to Date.now. */
  stepUpClock?: () => number;
  /** Tests inject a limiter with a fake clock for MFA code attempts; production uses the default. */
  mfaLimiter?: FixedWindowLimiter;
  /** Clock for TOTP time steps only. Defaults to stepUpClock, then Date.now. */
  totpClock?: () => number;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({
    logger: deps.logger ?? loggerOptions(config.logLevel),
    // Never trust a client-supplied request id.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // Route coverage (06 §2 step 5, 10 §4.1): every route is either on the explicit public allowlist
  // or names catalogued permission(s) from the central catalog. Violations fail at boot, not at runtime.
  app.addHook('onRoute', (route) => {
    const cfg = route.config as
      { public?: boolean; permission?: string | readonly string[] } | undefined;
    if (cfg?.public === true) return;
    if (!cfg?.permission) {
      throw new Error(`Route ${route.method.toString()} ${route.url} has no catalogued permission`);
    }
    const permVal = cfg.permission;
    const perms: readonly string[] = typeof permVal === 'string' ? [permVal] : permVal;
    if (perms.length === 0) {
      throw new Error(`Route ${route.method.toString()} ${route.url} has no catalogued permission`);
    }
    for (const p of perms) {
      if (!PERMISSION_CODES.has(p)) {
        throw new Error(
          `Route ${route.method.toString()} ${route.url} has no catalogued permission: ${p}`,
        );
      }
    }
  });

  registerHardening(app, { production: config.env === 'production' });

  // No `secret`: the session cookie is an opaque random token looked up by its SHA-256 hash, so
  // cookie signing would add nothing. (A placeholder secret would only pretend to.)
  app.register(fastifyCookie);

  const authRepository = new AuthRepository();
  const authService = new AuthService(deps.db, authRepository, deps.stepUpMaxAgeMs);

  // Register auth hook to protect routes
  app.register(authHook, {
    authService,
    db: deps.db,
    allowedOrigins: config.allowedOrigins,
    minAssuranceForCritical: deps.minAssuranceForCritical ?? 'PASSWORD_MFA',
    stepUpMaxAgeMs: deps.stepUpMaxAgeMs,
    now: deps.stepUpClock,
  });

  // No MFA keyring (only possible outside production; config/env.ts refuses it there): enrollment and TOTP verification
  // answer 503 MFA_UNAVAILABLE. Nothing falls back to plaintext or another key.
  const mfaService = new MfaService(
    deps.db,
    config.mfa,
    deps.stepUpMaxAgeMs ?? 600_000,
    deps.stepUpClock,
    deps.totpClock ?? deps.stepUpClock,
  );

  registerHealthRoutes(app, { db: deps.db });
  registerAuthRoutes(app, {
    authService,
    loginLimiter: deps.loginLimiter ?? new LoginRateLimiter(),
    acceptLimiter:
      deps.acceptInviteLimiter ??
      new FixedWindowLimiter({ limit: 20, windowMs: 15 * 60_000, maxKeys: 10_000 }),
    stepUpLimiter: deps.stepUpLimiter,
  });
  registerMfaRoutes(app, {
    mfaService,
    limiter:
      deps.mfaLimiter ??
      new FixedWindowLimiter({ limit: 5, windowMs: 15 * 60_000, maxKeys: 10_000 }),
  });
  app.register(registerUserRoutes, {
    prefix: '/api/v1',
    db: deps.db,
    mailer: deps.invitationMailer ?? new DisabledInvitationMailer(),
    inviteLimiter:
      deps.inviteLimiter ??
      new FixedWindowLimiter({ limit: 30, windowMs: 60 * 60_000, maxKeys: 10_000 }),
  });
  app.register(registerOrganizationRoutes, { prefix: '/api/v1/organization', db: deps.db });
  app.register(registerAcademicsRoutes, { prefix: '/api/v1/academics', db: deps.db });
  app.register(registerPeopleRoutes, { prefix: '/api/v1/faculty', db: deps.db });
  app.register(registerStudentRoutes, { prefix: '/api/v1/students', db: deps.db });
  app.register(registerStudentGuardianRoutes, { prefix: '/api/v1/students', db: deps.db });
  // The paginated directory exists only with BOTH valid cursor keys (CURSOR_KEYS + CURSOR_ACTIVE_KEY_ID) AND explicit
  // activation (STUDENT_DIRECTORY_LIST_ENABLED=true). Otherwise the plugin is not registered; what an unregistered path
  // answers is whatever the remaining routes answer (see tests/unit/student-directory-activation.test.ts).
  // The flag does not detect or guarantee a single instance; its rate limiter is per process.
  if (config.studentDirectoryListEnabled && config.cursor) {
    app.register(registerStudentDirectoryRoutes, {
      prefix: '/api/v1/students',
      db: deps.db,
      codec: deps.cursorCodec ?? createCursorCodec(config.cursor),
      activeKeyId: config.cursor.activeKeyId,
      limiter: deps.directoryLimiter ?? createDirectoryLimiter(),
    });
  }

  return app;
}
