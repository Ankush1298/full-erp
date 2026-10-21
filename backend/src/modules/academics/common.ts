import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import { AuthorizationEngine, type ResourceScope } from '../../shared/authorization/engine.js';
import type { TenantTx } from '../../shared/database/index.js';

/** Shared plumbing of the Milestone 3 academic-structure and enrollment services. */

export const invalid = (message: string): AppError =>
  new AppError(400, 'VALIDATION_ERROR', message);
export const conflict = (message: string): AppError => new AppError(409, 'CONFLICT', message);
export const forbidden = (): AppError => new AppError(403, 'FORBIDDEN', 'Access denied.');

export function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/** Trims a required string and enforces its length; the pattern (if any) is checked on the trimmed value. */
export function text(
  value: unknown,
  field: string,
  min: number,
  max: number,
  pattern?: RegExp,
): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min || v.length > max || (pattern && !pattern.test(v))) {
    throw invalid(
      `${field} must be ${min === max ? String(min) : `${min} to ${max}`} characters${pattern ? ' in the allowed format' : ''}.`,
    );
  }
  return v;
}

/** Optimistic concurrency under the row lock: stale or "must not exist" ⇒ 409 (428/400 are raised at the route). */
export function checkVersion(expected: ExpectedVersion, current: number, what: string): void {
  if (
    expected.type === 'initial' ||
    (expected.type === 'version' && expected.version !== current)
  ) {
    throw conflict(`${what} version mismatch.`);
  }
}

/**
 * Organization-wide resources (academic years, tenant-wide courses) are manageable only by an ORGANIZATION-scoped
 * holder: a campus- or department-scoped holder cannot prove an org-wide row is inside its scope. Held at all ⇒ the
 * scoped assert's 404 is reported as 403, as PeriodTypeService does.
 */
export async function assertOrgWide(
  tx: TenantTx,
  ctx: TrustedContext,
  permission: string,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, permission);
  try {
    await AuthorizationEngine.assert(tx, ctx, permission, { organization_id: ctx.tenantId });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw forbidden();
    throw err;
  }
}

/** 403 when the permission is not held at all, then 404 (identical to "missing") when the resource is out of scope. */
export async function assertScoped(
  tx: TenantTx,
  ctx: TrustedContext,
  permission: string,
  scope: ResourceScope,
): Promise<void> {
  await AuthorizationEngine.assert(tx, ctx, permission, {
    ...scope,
    organization_id: ctx.tenantId,
  });
}

const GUARD_SQLSTATES = new Set(['23514', '23P01', '23001']);

/**
 * Maps a database error to the API contract. Our own trigger guards raise plain-English messages (check, exclusion and
 * restrict violations) that are safe to show; PostgreSQL's generic constraint text is replaced. Anything else is rethrown.
 * `unique` is the 409 message for a duplicate business key.
 */
export function mapDbError(err: unknown, unique: string): never {
  const e = err as { code?: string; message?: string };
  if (e.code === '23505') throw conflict(unique);
  if (e.code && GUARD_SQLSTATES.has(e.code)) {
    const msg = e.message ?? '';
    throw conflict(
      msg.startsWith('new row for relation') ? 'The request violates a data constraint.' : msg,
    );
  }
  if (e.code === '23503')
    throw conflict('A referenced record does not exist or is not in a usable state.');
  throw err;
}

/** Dates are selected as text: the pg driver would otherwise build a server-time-zone JS Date and shift the calendar day. */
export const iso = (d: Date): string => d.toISOString();

export function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

/** If-Match is mandatory on every mutation of a versioned resource: 428 missing, 400 malformed or weak. */
export function expectedVersion(req: FastifyRequest): ExpectedVersion {
  const header = req.headers['if-match'];
  return parseIfMatch(typeof header === 'string' ? header : undefined);
}

export function requireContext(req: FastifyRequest): TrustedContext {
  if (!req.tenantContext) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
  return req.tenantContext;
}

export function etag(reply: FastifyReply, version: number): void {
  void reply.header('ETag', `"${version}"`);
}
