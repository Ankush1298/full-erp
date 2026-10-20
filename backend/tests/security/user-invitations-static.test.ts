import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for tenant user invitations (migration 0028; no database needed). Text-based, like the sibling gates.
const backend = resolve(import.meta.dirname, '../..');
const repo = resolve(backend, '..');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const files = walk(join(backend, 'src')).map((f) => ({
  path: f.slice(backend.length + 1),
  text: strip(readFileSync(f, 'utf8')),
}));
const get = (p: string): string => files.find((f) => f.path === p)!.text;
const USER_SERVICE = 'src/modules/users/user.service.ts';
const USER_ROUTES = 'src/modules/users/user.routes.ts';
const USER_SCHEMAS = 'src/modules/users/user.schemas.ts';
const AUTH_SERVICE = 'src/modules/auth/auth.service.ts';
const AUTH_ROUTES = 'src/modules/auth/auth.routes.ts';
const MAILER = 'src/shared/email/invitation-mailer.ts';
const sql = readFileSync(join(repo, 'database/migrations/0028_user_invitations.sql'), 'utf8');
const code = sql.replace(/--[^\n]*/g, '');

describe('invitation tokens: hashed at rest, never logged, handed only to the mailer', () => {
  it('only the invitation service writes app.invite_tokens, only the auth service calls the consuming functions, nothing deletes', () => {
    const writers = files
      .filter((f) => /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.invite_tokens/i.test(f.text))
      .map((f) => f.path);
    expect(writers).toEqual([USER_SERVICE]);
    const consumers = files
      .filter((f) => /platform\.(lock|complete)_invitation/.test(f.text))
      .map((f) => f.path);
    expect(consumers).toEqual([AUTH_SERVICE]);
    for (const f of files)
      expect(f.text, f.path).not.toMatch(/DELETE\s+FROM\s+app\.invite_tokens/i);
  });

  it('the token is random (32 bytes), and the ONLY value stored or queried is its SHA-256 hash', () => {
    const svc = get(USER_SERVICE);
    expect(svc).toMatch(/randomBytes\(32\)\.toString\('base64url'\)/);
    expect(svc).toMatch(/hashToken\(rawToken\)/);
    // rawToken appears only where it is generated, hashed, or wrapped for the mailer
    const uses = [...svc.matchAll(/\brawToken\b/g)].length;
    expect(uses).toBe(3);
    expect(svc).toMatch(/new InvitationMail\([^)]*rawToken/s);
    const auth = get(AUTH_SERVICE);
    expect(auth).toMatch(/const tokenHash = hashToken\(token\)/);
    // the acceptance code passes the hash, never the token, to SQL
    expect(auth).not.toMatch(/lock_invitation\(\$1\)',\s*\[\s*token\b/);
    expect(auth).not.toMatch(/complete_invitation\(\$1, \$2\)',\s*\[\s*token\b/);
  });

  it('no source file logs a token or reads the mail token except the mailer module', () => {
    for (const f of files) {
      expect(f.text, f.path).not.toMatch(
        /\blog(?:ger)?\.(?:info|warn|error|debug|trace|fatal)\([^)]*token/i,
      );
      if (f.path !== MAILER) expect(f.text, f.path).not.toMatch(/revealToken\(/);
    }
    expect(get(MAILER)).toMatch(/toJSON\(\)/);
    expect(get(MAILER)).toMatch(/inspect\.custom/);
    // the delivery-failure log carries the error NAME only (a provider message could echo the body)
    expect(get(USER_ROUTES)).toMatch(/errorName: err instanceof Error \? err\.name/);
    expect(get(USER_ROUTES)).not.toMatch(/log\.\w+\(\s*\{\s*err\b/);
  });

  it('the default mailer sends nothing and fails closed; the in-memory one is the only other implementation', () => {
    const m = get(MAILER);
    expect(m).toMatch(
      /class DisabledInvitationMailer[\s\S]*?Promise\.reject\(new MailerNotConfiguredError\(\)\)/,
    );
    expect([...m.matchAll(/implements InvitationMailer/g)]).toHaveLength(2);
    expect(get('src/app.ts')).toMatch(
      /deps\.invitationMailer \?\? new DisabledInvitationMailer\(\)/,
    );
    expect(m).not.toMatch(/process\.env|createTransport|smtp|fetch\(/i);
  });
});

describe('closed request bodies: an invitation names a person, acceptance names a token and a password', () => {
  const body = (src: string, name: string): string =>
    new RegExp(`export const ${name} = Type\\.Object\\([\\s\\S]*?\\n\\);`).exec(src)?.[0] ?? '';

  it('the invite body has no role, scope, status, tenant, identity or token field; every body is additionalProperties: false', () => {
    const invite = body(get(USER_SCHEMAS), 'InviteUserBodySchema');
    expect(invite).toMatch(/email:[\s\S]*displayName:[\s\S]*reason:/);
    expect(invite).not.toMatch(
      /\b(role|roleId|scope|scopeType|scopeId|status|organizationId|tenantId|identityId|token|userId)\b/,
    );
    for (const name of [
      'InviteUserBodySchema',
      'UserStatusChangeBodySchema',
      'GrantRoleBodySchema',
      'RevokeRoleBodySchema',
    ]) {
      expect(body(get(USER_SCHEMAS), name), name).toMatch(/additionalProperties: false/);
    }
    const accept = /'\/auth\/accept-invite'[\s\S]*?\n {2}\);/.exec(get(AUTH_ROUTES))?.[0] ?? '';
    expect(accept).toMatch(/token: Type\.String/); // secret-scan:allow
    expect(accept).toMatch(/password: Type\.String/); // secret-scan:allow
    expect(accept).toMatch(/additionalProperties: false/);
    expect(accept).not.toMatch(/\b(tenant|role|scope|organization|userId|identityId)\b/);
  });

  it('accept-invite is the one new public route, spends the rate-limit budget before any work, and the service is the only thing it calls', () => {
    const r = /'\/auth\/accept-invite'[\s\S]*?\n {2}\);/.exec(get(AUTH_ROUTES))?.[0] ?? '';
    expect(r).toMatch(/config: \{ public: true \}/);
    expect(r.indexOf('limiter')).toBeGreaterThan(-1);
    expect(r.indexOf('take(')).toBeLessThan(r.indexOf('acceptInvitation('));
    expect(r).toMatch(/hashToken\(token\)/); // the per-token budget is keyed by the hash, never the raw token
  });
});

describe('the services keep their order and their limits', () => {
  it('invite: staff actor and organization-scoped permission come before the Idempotency-Key and every statement', () => {
    const body = get(USER_SERVICE).slice(
      get(USER_SERVICE).indexOf('static async invite('),
      get(USER_SERVICE).indexOf('static async suspend('),
    );
    const staff = body.indexOf('assertStaffActor');
    const scope = body.indexOf('assertOrganizationScope');
    const key = body.indexOf('parseIdempotencyKey');
    const firstQuery = body.indexOf('tx.query');
    expect(staff).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(staff);
    expect(key).toBeGreaterThan(scope);
    expect(firstQuery).toBeGreaterThan(key);
    // a per-(tenant, e-mail) lock serialises concurrent invitations of one address
    expect(body).toMatch(/pg_advisory_xact_lock[\s\S]*app\.user_invite:/);
  });

  it('every mutation audits at tier 2 with a reason and the audit event carries no e-mail, name or token', () => {
    const svc = get(USER_SERVICE);
    expect([...svc.matchAll(/riskTier: 2/g)]).toHaveLength(3);
    expect([...svc.matchAll(/reasonText: reason/g)]).toHaveLength(3);
    for (const m of svc.matchAll(/recordAudit\([\s\S]*?\n {6,10}\);/g)) {
      expect(m[0]).not.toMatch(/\b(email|displayName|rawToken|token)\b(?!:)/);
    }
    expect(svc).toMatch(/user\.suspend/);
    expect(svc).toMatch(/revokeMembershipSessions/);
  });

  it('role assignment goes only through RoleAssignmentService: no module writes role_assignments', () => {
    expect(get(USER_SERVICE)).toMatch(/RoleAssignmentService\.grant\(/);
    expect(get(USER_ROUTES)).toMatch(/RoleAssignmentService\.revoke\(/);
    for (const f of files.filter(
      (x) => x.path.startsWith('src/modules/users/') || x.path === AUTH_SERVICE,
    )) {
      expect(f.text, f.path).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.role_assignments/i,
      );
    }
  });

  it('the user routes are gated by catalogued permissions and take the tenant only from the session', () => {
    const routes = get(USER_ROUTES);
    const used = [...routes.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(used).toEqual([
      'role.assignment.grant',
      'role.assignment.revoke',
      'user.account.invite',
      'user.account.read',
      'user.account.suspend',
    ]);
    // the tenant is ctx.tenantId (the session) only; no request field is read for it
    expect(routes).not.toMatch(
      /\breq\.(?:body|query|params|headers)\b[^;]*?(?:organization|tenant)/i,
    );
    expect(routes).not.toMatch(/organizationId/);
  });
});

describe('migration 0028 pins its decisions', () => {
  it('the consuming functions are SECURITY DEFINER with a pinned search_path and not executable by PUBLIC', () => {
    for (const fn of ['platform.lock_invitation', 'platform.complete_invitation']) {
      const m = new RegExp(`CREATE FUNCTION ${fn}\\([\\s\\S]*?\\$\\$;`).exec(code)?.[0] ?? '';
      expect(m, fn).toMatch(/SECURITY DEFINER/);
      expect(m, fn).toMatch(/SET search_path = pg_catalog/);
    }
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*platform\.lock_invitation\(text\)[\s\S]*FROM PUBLIC/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION platform\.lock_invitation\(text\), platform\.complete_invitation\(text, app\.uuid_v7\)\s+TO app_runtime/,
    );
  });

  it('the runtime role is never granted used_at, a token column or delete; no role is granted or created; nothing is dropped', () => {
    expect(code).toMatch(/GRANT UPDATE \(revoked_at\) ON app\.invite_tokens TO app_runtime/);
    expect(code).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
    expect(code).not.toMatch(/GRANT[^;]*used_at/i);
    expect(code).not.toMatch(/\bDROP\b|\bTRUNCATE\b|NO\s+FORCE|DISABLE ROW LEVEL/i);
    expect(code).not.toMatch(/role_assignments|app\.roles|role_permissions/i);
    expect(code).toMatch(/ALTER TABLE app\.invite_tokens FORCE\s+ROW LEVEL SECURITY/);
  });

  it('every app_migrator policy carries the session_user probe and the user activation is limited to INVITED -> ACTIVE', () => {
    for (const m of code.matchAll(
      /CREATE POLICY (\w+) ON [\w.]+ AS PERMISSIVE FOR \w+ TO app_migrator[\s\S]*?;/g,
    )) {
      expect(m[0], m[1]).toMatch(
        /session_user::text = 'app_runtime' AND current_user::text = 'app_migrator'/,
      );
    }
    expect(code).toMatch(
      /users_invitation_activation[\s\S]*status = 'INVITED' AND identity_id IS NULL[\s\S]*status = 'ACTIVE' AND identity_id IS NOT NULL/,
    );
  });
});
