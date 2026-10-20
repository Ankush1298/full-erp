import type { TenantTx } from '../database/tenant-tx.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { GRANT_RULES, isRoleCode, type RoleCode } from './role-matrix.js';

/**
 * ADR-004: TOTP MFA is mandatory for admin-class roles, default HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and
 * REGISTRAR. ADR-004 calls this "configurable (`security.mfa_required_roles`)"; that tenant setting is NOT built (no
 * registry key exists), so the documented default is the policy for every tenant. A future setting may only ADD roles.
 */
export const MFA_REQUIRED_ROLES = [
  'HOD',
  'DEPARTMENT_ADMIN',
  'CAMPUS_ADMIN',
  'COLLEGE_ADMIN',
  'REGISTRAR',
] as const satisfies readonly RoleCode[];

/**
 * What a session of an MFA-required user may still do before it has completed a second factor: see its own session and
 * manage (enroll / verify) its own MFA. Nothing else: doc 09 §8 "cannot obtain a session with admin capabilities without
 * MFA". A route qualifies only when EVERY permission it names is in this set.
 */
export const MFA_EXEMPT_PERMISSIONS: ReadonlySet<string> = new Set([
  'session.read',
  'session.revoke',
  'auth.mfa.manage',
]);

/** Role codes of the user's EFFECTIVE assignments (ACTIVE, started, not ended: the rule of every authorization decision). */
export async function effectiveRoleCodes(
  tx: TenantTx,
  organizationId: string,
  userId: string,
): Promise<string[]> {
  const res = await tx.query<{ code: string }>(
    `SELECT DISTINCT r.code FROM app.role_assignments ra
       JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
      WHERE ra.organization_id = $1 AND ra.user_id = $2 AND ra.status = 'ACTIVE'
        AND ra.valid_from <= now() AND (ra.valid_until IS NULL OR ra.valid_until > now())
      ORDER BY r.code`,
    [organizationId, userId],
  );
  return res.rows.map((r) => r.code);
}

/**
 * Does the user CURRENTLY hold an effective MFA-required role? Evaluated per request, so a role granted or revoked takes
 * effect on the next request without any session change.
 */
export async function isMfaRequired(
  tx: TenantTx,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const required: readonly string[] = MFA_REQUIRED_ROLES;
  return (await effectiveRoleCodes(tx, organizationId, userId)).some((c) => required.includes(c));
}

/**
 * Privilege-escalation guard for acting on another user's credentials (MFA reset): the actor must be allowed, by the grant
 * rules (doc 06 §5), to grant EVERY role the target currently holds. A campus administrator therefore can never reset a
 * college administrator. Unknown role codes on the target fail closed.
 */
export async function mayActOnAllRolesOf(
  tx: TenantTx,
  ctx: TrustedContext,
  targetUserId: string,
): Promise<boolean> {
  if (!isTrustedContext(ctx)) return false;
  const grantable = new Set<string>(
    (await effectiveRoleCodes(tx, ctx.tenantId, ctx.userId)).flatMap((r) =>
      isRoleCode(r) ? (GRANT_RULES[r] ?? []) : [],
    ),
  );
  return (await effectiveRoleCodes(tx, ctx.tenantId, targetUserId)).every((r) => grantable.has(r));
}

/**
 * Checks if ANY user holding an MFA-required role in the tenant already has an active, verified MFA factor.
 * When true, operational first-administrator bootstrap is permanently closed for this tenant.
 */
export async function hasActiveVerifiedAdminMfa(
  tx: TenantTx,
  organizationId: string,
): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM app.user_mfa_factors f
       JOIN app.role_assignments ra ON ra.organization_id = f.organization_id AND ra.user_id = f.user_id
       JOIN app.roles r ON r.organization_id = ra.organization_id AND r.id = ra.role_id
      WHERE f.organization_id = $1
        AND f.status = 'ACTIVE'
        AND f.verified_enrollment IS TRUE
        AND r.code = ANY($2::text[])`,
    [organizationId, MFA_REQUIRED_ROLES as readonly string[]],
  );
  return (res.rowCount ?? 0) > 0;
}
