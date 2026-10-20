import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Database } from '../database/index.js';
import { isTrustedContext, type AuthStrength } from '../tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from './record.js';

export interface DenialAuditParams {
  readonly permission?: string | readonly string[] | undefined;
  readonly reason: 'PERMISSION_DENIED' | 'OUT_OF_SCOPE' | 'STEP_UP_REQUIRED' | 'MFA_REQUIRED';
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly requiredAssurance?: AuthStrength | undefined;
  readonly currentAssurance?: AuthStrength | undefined;
}

/**
 * Centrally records an authorization denial audit event for an authenticated request.
 *
 * Security & Reliability Invariants:
 * 1. Actor, tenant, and session facts come strictly from the server-side TrustedContext;
 *    the caller or client cannot forge or tamper with audit actor or tenant.
 * 2. Risk tier is pinned to 2 (sensitive/critical decision, per doc 06 §1 line 40).
 * 3. Idempotent per request: uses request._denialAuditRecorded to avoid duplicate audit
 *    records if a request flows through multiple denial handlers.
 * 4. Safe metadata only: no credentials, passwords, session tokens, invitation tokens,
 *    guardian contact info, or PII.
 * 5. Hidden-resource 404s: resource existence is never revealed in metadata or error responses.
 * 6. Transaction & failure semantics: writes inside an isolated tenant transaction that commits.
 *    If persistence fails, the failure is logged to request.log.error and does not convert
 *    the denial into a 500 error or leak database state.
 */
export async function auditAuthorizationDenial(
  db: Database,
  request: FastifyRequest,
  params: DenialAuditParams,
): Promise<void> {
  const reqAny = request as unknown as { _denialAuditRecorded?: boolean };
  if (reqAny._denialAuditRecorded) {
    return;
  }

  const ctx = request.tenantContext;
  if (!ctx || !isTrustedContext(ctx)) {
    // Unauthenticated requests cannot be audited in tenant-partitioned app.audit_events (RLS requires verified tenant/actor).
    return;
  }

  reqAny._denialAuditRecorded = true;

  const perms = params.permission
    ? Array.isArray(params.permission)
      ? params.permission
      : [params.permission]
    : [];

  const meta: AuditRequestMeta = {
    ...(request.id !== undefined ? { requestId: request.id } : {}),
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    // With TRUST_PROXY=true, request.ip is taken from the client-supplied X-Forwarded-For and need not be an address.
    // recordAudit rejects a non-address (AUDIT_INVALID) and this function swallows write failures, so passing it
    // through would let a caller suppress the audit of their own denial with a malformed header. Omit it instead.
    ...(typeof request.ip === 'string' && isIP(request.ip) !== 0 ? { ip: request.ip } : {}),
    ...(typeof request.headers['user-agent'] === 'string'
      ? { userAgent: request.headers['user-agent'] }
      : {}),
  };

  const action = 'auth.authorization_denied';
  const resourceType = params.resourceType ?? 'authorization';

  const metadata: Record<string, unknown> = {
    permission: perms.length === 1 ? perms[0] : perms,
    reason: params.reason,
    outcome: 'DENIED',
    method: request.method,
    route: request.routeOptions?.url ?? request.url.split('?')[0],
    ...(params.requiredAssurance ? { requiredAssurance: params.requiredAssurance } : {}),
    ...(params.currentAssurance ? { currentAssurance: params.currentAssurance } : {}),
  };

  try {
    await db.withTenant(ctx, async (tx) => {
      await recordAudit(
        tx,
        ctx,
        {
          action,
          resourceType,
          ...(params.resourceId !== undefined ? { resourceId: params.resourceId } : {}),
          riskTier: 2,
          reasonCode: params.reason,
          metadata,
        },
        meta,
      );
    });
  } catch (err) {
    request.log?.error({ err }, 'Failed to persist authorization denial audit event');
  }
}
