/**
 * Explicit exception policy for the database privilege guardrails (doc 48 §5). Anything the guardrail test finds that is not
 * covered by a rule or by an entry here FAILS: a new table, grant or SECURITY DEFINER function can never pass silently. Every
 * entry names why it exists and who answers for it; `review` is the condition that should end the exception. Adding an entry
 * is a security decision (code review by the platform security owner), not a way to make a test green.
 */
export const PLATFORM_SECURITY_OWNER =
  'Platform security owner (project owner designates; open decision)';

export interface Exception {
  readonly reason: string;
  readonly owner: string;
  readonly review: string;
}

/** Tables with no `organization_id` column. Every one must appear here, with the row-level-security state it is allowed to have. */
export interface GlobalTable extends Exception {
  /** `forced` = RLS enabled and forced is required; `none` = global infrastructure deliberately without RLS. */
  readonly rls: 'forced' | 'none';
  /** The ONLY privileges app_runtime may hold on the table (table-level or column-level). */
  readonly runtimePrivileges: readonly ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[];
  /** For `none` tables with column-level INSERT/UPDATE: the exact writable columns. */
  readonly insertColumns?: readonly string[];
  readonly updateColumns?: readonly string[];
}

export const GLOBAL_TABLES: Readonly<Record<string, GlobalTable>> = {
  'app.organizations': {
    reason:
      'The tenant table itself; keyed by id, not organization_id. RLS limits a session to its own row.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never: this is the tenant key.',
    rls: 'forced',
    runtimePrivileges: ['SELECT'],
  },
  'platform.permissions': {
    reason:
      'Global permission catalogue shared by all tenants; read-only reference data (no RLS in the live schema; the runtime role has SELECT only).',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'If tenant-specific permissions are ever introduced.',
    rls: 'none',
    runtimePrivileges: ['SELECT'],
  },
  'platform.identities': {
    reason:
      'Global login identity (one identity can belong to several tenants; sign-in looks it up by e-mail before any tenant is known), so tenant RLS cannot apply. Writes narrowed to columns application changes (0043); table-wide SELECT revoked and replaced by SECURITY DEFINER functions (0048). Minimal column SELECT on (id, email, failed_login_count, locked_until) allows safe lockout updates and ON CONFLICT insert arbitration.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; lookups are bounded by SECURITY DEFINER functions (0048).',
    rls: 'none',
    runtimePrivileges: ['INSERT', 'UPDATE'],
    insertColumns: ['id', 'email', 'password_hash', 'status'],
    updateColumns: ['failed_login_count', 'locked_until'],
  },
  'platform.auth_sessions': {
    reason:
      'Global session registry (tenant_id is a column, lookup key is token hash). Writes narrowed to columns application changes (0043); table-wide SELECT revoked and replaced by SECURITY DEFINER functions (0048). Minimal column SELECT on non-token columns allows safe session assurance updates.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; session lookups are bounded by SECURITY DEFINER functions (0048).',
    rls: 'none',
    runtimePrivileges: ['INSERT', 'UPDATE'],
    insertColumns: ['id', 'identity_id', 'tenant_id', 'token_hash', 'expires_at'],
    updateColumns: ['revoked_at', 'step_up_at', 'auth_strength', 'mfa_verified_at'],
  },
  'platform.schema_migrations': {
    reason: 'Migration ledger owned by the migration role; the runtime role needs no access.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    rls: 'none',
    runtimePrivileges: [],
  },
};

/** Tenant tables where app_runtime may DELETE (RLS still confines it to its tenant). Every other table: no DELETE. */
export const RUNTIME_DELETE_ALLOWED: Readonly<Record<string, Exception>> = {
  'app.curriculum_courses': {
    reason:
      'Curriculum membership rows are removed and re-added by the curriculum service (history is not kept here).',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'If curriculum history becomes a retention requirement.',
  },
  'app.student_guardians': {
    reason:
      'A guardian link is removed by the guardian service (the removal is audited as student_guardian.remove).',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'If link history becomes a retention requirement.',
  },
};

/** SECURITY DEFINER functions: the complete approved set. Each runs as the migration role with a fixed search_path. */
export const SECURITY_DEFINER_FUNCTIONS: Readonly<
  Record<string, Exception & { readonly maxSearchPath: string }>
> = {
  'app.context_ok': {
    reason: 'Reads the transaction-local tenant context for every RLS policy.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.get_identity_memberships': {
    reason:
      'Login: lists the tenants one identity belongs to (id, slug, name only) before a tenant context exists.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'With the identity lookup functions (doc 48 §4.3).',
    maxSearchPath: 'app, platform, pg_temp',
  },
  'platform.lock_invitation': {
    reason: 'Invitation acceptance: finds and locks one usable invitation by token hash.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.complete_invitation': {
    reason: 'Invitation acceptance: consumes the token and activates the membership atomically.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.admin_reset_user_mfa': {
    reason:
      "Administrative MFA reset: removes a user's factors across the identity boundary under audit.",
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.mint_invitation_mfa_ticket': {
    reason:
      'Invitation acceptance: issues a self-service MFA onboarding ticket under RLS without exposing ticket issuance to app_runtime.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.lookup_identity_by_email': {
    reason:
      'Login and password verification: looks up one identity by lowercase email before tenant context exists.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; bounded lookup replacing raw table SELECT.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.lookup_identity_by_id': {
    reason:
      'Session validation and identity status: looks up one identity by id before tenant context exists.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; bounded lookup replacing raw table SELECT.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.lock_identity_by_email': {
    reason:
      'Invitation acceptance concurrency lock: acquires row lock on one identity by lowercase email.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; bounded lock replacing raw table SELECT FOR UPDATE.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.lookup_session_by_token': {
    reason:
      'Session resolution: looks up one authenticated session by token hash before tenant context is loaded.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; bounded session lookup replacing raw table SELECT.',
    maxSearchPath: 'pg_catalog',
  },
  'platform.lookup_session_by_id': {
    reason:
      'Session lookup: looks up one authenticated session by session id before tenant context is loaded.',
    owner: PLATFORM_SECURITY_OWNER,
    review: 'Never; bounded session lookup replacing raw table SELECT.',
    maxSearchPath: 'pg_catalog',
  },
};
