import { wasIssued } from './context-registry.js';

declare const trustedBrand: unique symbol;

export type ActorKind = 'STUDENT' | 'STAFF';

/** The ONLY recognized session assurance levels (weakest first); anything else is malformed and never trusted. */
export const AUTH_STRENGTHS = ['PASSWORD', 'PASSWORD_REAUTH', 'PASSWORD_MFA'] as const;

export type AuthStrength = (typeof AUTH_STRENGTHS)[number];

/** Runtime check for untrusted-shaped data (a database row, a configuration value): exact, case-sensitive match. */
export function isAuthStrength(value: unknown): value is AuthStrength {
  return typeof value === 'string' && (AUTH_STRENGTHS as readonly string[]).includes(value);
}

/**
 * The only thing the database layer accepts as "who is asking and for which tenant".
 * It is created by `issueTrustedContext` (see issue-trusted-context.ts) after the request has been
 * authenticated and its tenant membership resolved. It never carries client-supplied values.
 */
export interface TrustedContext {
  readonly [trustedBrand]: true;
  readonly tenantId: string;
  readonly userId: string;
  readonly actorKind: ActorKind;
  readonly sessionId?: string | undefined;
  readonly stepUpAt: Date | null;
  readonly authStrength: AuthStrength;
  /**
   * When this session last completed a second-factor verification (TOTP or recovery code), from
   * platform.auth_sessions.mfa_verified_at. Null = never. Only the MFA service writes the column.
   */
  readonly mfaVerifiedAt: Date | null;
}

/** Runtime check: true only for objects produced by the trusted issuer (casts do not count). */
export function isTrustedContext(value: unknown): value is TrustedContext {
  return wasIssued(value);
}
