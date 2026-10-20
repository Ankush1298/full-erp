import { AppError } from '../errors/http-errors.js';
import { isUuidV7 } from '../ids/uuidv7.js';
import { registerIssued } from './context-registry.js';
import {
  isAuthStrength,
  type ActorKind,
  type AuthStrength,
  type TrustedContext,
} from './trusted-context.js';

export interface VerifiedPrincipal {
  /** From the authenticated session record — never from a request body, query, header or URL. */
  readonly tenantId: string;
  readonly userId: string;
  /** Decided by the authorization layer from the user's role assignments (Slice 3). */
  readonly actorKind: ActorKind;
  readonly sessionId?: string | undefined;
  readonly stepUpAt?: Date | null | undefined;
  readonly authStrength?: AuthStrength | undefined;
  readonly mfaVerifiedAt?: Date | null | undefined;
}

/** A database timestamp: null/undefined -> null, a valid Date -> a private copy, anything else -> refused. */
function optionalDate(raw: unknown, name: string): Date | null {
  if (raw === undefined || raw === null) return null;
  // Read the time through the prototype so an own `getTime` on a look-alike cannot answer for the Date.
  const ms = raw instanceof Date ? Date.prototype.getTime.call(raw) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new AppError(
      500,
      'INVALID_CONTEXT',
      `Trusted context ${name} must be null or a valid Date.`,
    );
  }
  return new Date(ms); // the caller's Date object is never aliased into the context
}

/**
 * SECURITY-CRITICAL. Call only from the authentication layer, after the session has been verified
 * and tenant membership resolved server-side. Importing this module from business modules is
 * forbidden by lint (eslint.config.mjs); only src/modules/iam/** and tests may import it.
 *
 * Input is validated, the result is frozen, and it is registered so Database.withTenant() can tell
 * it apart from a forged object.
 */
export function issueTrustedContext(principal: VerifiedPrincipal): TrustedContext {
  if (!isUuidV7(principal.tenantId) || !isUuidV7(principal.userId)) {
    throw new AppError(500, 'INVALID_CONTEXT', 'Trusted context requires UUIDv7 identifiers.');
  }
  if (principal.actorKind !== 'STUDENT' && principal.actorKind !== 'STAFF') {
    throw new AppError(500, 'INVALID_CONTEXT', 'Trusted context requires a known actor kind.');
  }
  if (principal.sessionId !== undefined && !isUuidV7(principal.sessionId)) {
    throw new AppError(500, 'INVALID_CONTEXT', 'Trusted context sessionId must be a UUIDv7.');
  }
  // Assurance data comes from a database row: validate its runtime shape, never coerce it. `undefined` (a session
  // without step-up data) keeps the weakest defaults; every other malformed value is refused outright.
  const stepUpAt = optionalDate(principal.stepUpAt, 'stepUpAt');
  const mfaVerifiedAt = optionalDate(principal.mfaVerifiedAt, 'mfaVerifiedAt');
  const rawStrength: unknown = principal.authStrength;
  let authStrength: AuthStrength = 'PASSWORD';
  if (rawStrength !== undefined) {
    if (!isAuthStrength(rawStrength)) {
      throw new AppError(
        500,
        'INVALID_CONTEXT',
        'Trusted context authStrength must be a recognized assurance level.',
      );
    }
    authStrength = rawStrength;
  }
  const ctx = Object.freeze({
    tenantId: principal.tenantId.toLowerCase(),
    userId: principal.userId.toLowerCase(),
    actorKind: principal.actorKind,
    sessionId: principal.sessionId ? principal.sessionId.toLowerCase() : undefined,
    stepUpAt,
    authStrength,
    mfaVerifiedAt,
  });
  registerIssued(ctx);
  return ctx as unknown as TrustedContext;
}
