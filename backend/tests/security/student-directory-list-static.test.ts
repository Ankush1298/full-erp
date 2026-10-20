import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Static gates for the paginated student directory (no database needed). Text-based, like the sibling gates: dynamically
// built SQL could evade them, which is why the service is pinned to exactly one literal statement.
const backend = resolve(import.meta.dirname, '../..');
const repo = resolve(backend, '..');
const read = (p: string): string => readFileSync(join(backend, p), 'utf8');
const code = (p: string): string =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

const SERVICE = 'src/modules/students/student-directory-list.service.ts';
const ROUTES = 'src/modules/students/student-directory.routes.ts';

describe('the list service is a separate, read-only, single-statement, grant-scoped query', () => {
  it('does not touch the pinned lookup: it is its own file and the lookup keeps its single exact statement', () => {
    expect(SERVICE).not.toBe('src/modules/students/student-directory.service.ts');
    const lookup = code('src/modules/students/student-directory.service.ts');
    expect(lookup).not.toMatch(/student\.directory\.list|cursor/i);
    expect(lookup.match(/tx\.query</g)).toHaveLength(1);
  });

  it('reads only: exactly one statement, ordered by admission_number ASC with a keyset predicate and LIMIT, no name matching, no OFFSET, no collation override, no count', () => {
    const src = code(SERVICE);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO|FROM)?\s*app\./i);
    expect(src.match(/tx\.query</g)).toHaveLength(1);
    expect(src).toMatch(/ORDER BY s\.admission_number ASC/);
    expect(src).toMatch(/s\.admission_number > \$3::text/);
    expect(src).toMatch(/LIMIT \$7/);
    expect(src).toMatch(/limit \+ 1/);
    expect(src).not.toMatch(/\bI?LIKE\b|similarity|pg_trgm|to_tsvector|OFFSET\b/i);
    expect(src).not.toMatch(/COLLATE|lower\(|upper\(|unaccent|COUNT\(/i); // existing database collation only; no totals
    expect(src).not.toMatch(/\bFOR (UPDATE|SHARE|NO KEY UPDATE)\b/);
  });

  it('lists only ACTIVE enrolments inside the grants: no unplaced or closed-only branch, scope from loadGrants, never from the request', () => {
    const src = code(SERVICE);
    expect(src).toMatch(/AND EXISTS \(SELECT 1 FROM app\.student_programs sp/);
    expect(src).toMatch(/sp\.status = 'ACTIVE'/);
    expect(src).not.toMatch(/NOT EXISTS/);
    expect(src).toMatch(
      /\$4::boolean OR sp\.campus_id = ANY\(\$5::uuid\[\]\) OR sp\.department_id = ANY\(\$6::uuid\[\]\)/,
    );
    expect(src).toMatch(/AuthorizationEngine\.loadGrants\(tx, ctx, DIRECTORY_LIST_PERMISSION\)/);
    expect(src).toMatch(/AuthorizationEngine\.assert\(tx, ctx, DIRECTORY_LIST_PERMISSION\)/);
    expect(src).toMatch(/g\.scope_mode === 'GRANTED'/);
    // staff actor guard precedes every statement
    expect(src.indexOf('assertStaffActor')).toBeGreaterThan(-1);
    expect(src.indexOf('assertStaffActor')).toBeLessThan(src.indexOf('tx.query<'));
    expect(src.indexOf('assertStaffActor')).toBeLessThan(
      src.indexOf('AuthorizationEngine.assert('),
    );
  });

  it('never infers scope from a role name and never uses the lookup permission', () => {
    const src = code(SERVICE);
    expect(src).not.toMatch(
      /\b(COLLEGE_ADMIN|REGISTRAR|CAMPUS_ADMIN|DEPARTMENT_ADMIN|HOD|ROLE_CODES|ROLE_MATRIX)\b/,
    );
    expect(src).not.toMatch(/student\.directory\.search|DIRECTORY_SEARCH_PERMISSION/);
  });

  it('the cursor is checked before the query, the position is a parameter, and the filter hash binds the normalised status', () => {
    const src = code(SERVICE);
    expect(src.indexOf('options.codec.decode(')).toBeGreaterThan(-1);
    expect(src.indexOf('options.codec.decode(')).toBeLessThan(src.indexOf('tx.query<'));
    expect(src).toMatch(/requestFingerprint\(DIRECTORY_LIST_ROUTE_ID, \{ status \}\)/);
    expect(src).toMatch(
      /tenantId: ctx\.tenantId,\s*userId: ctx\.userId,\s*routeId: DIRECTORY_LIST_ROUTE_ID/,
    );
    // the position never reaches the SQL text
    expect(src.match(/`SELECT[\s\S]*?`/)?.[0]).not.toMatch(/\$\{/);
  });

  it('audits every successful page: tier 1, action student.directory.list, after the read, only the approved metadata keys', () => {
    const src = code(SERVICE);
    expect(src.match(/recordAudit\(/g)).toHaveLength(1);
    expect(src).toMatch(/action: 'student\.directory\.list'/);
    expect(src).toMatch(/riskTier: 1/);
    expect(src.indexOf('tx.query<')).toBeLessThan(src.indexOf('recordAudit('));
    const meta = /metadata: \{([\s\S]*?)\n\s{8}\},/.exec(src)?.[1] ?? '';
    expect(meta.match(/^\s{10}(\w+)[:,]/gm)?.map((l) => l.trim().slice(0, -1))).toEqual([
      'route',
      'status',
      'limit',
      'returned',
      'cursorPresent',
      'issuedKeyId',
    ]);
    // no cursor text, position, id or name inside the audit call
    const call = src.slice(
      src.indexOf('recordAudit('),
      src.indexOf('return {', src.indexOf('recordAudit(')),
    );
    // (the one allowed mention: whether a next page exists decides issuedKeyId; the cursor text itself is never passed)
    const withoutAllowed = call.replace(
      'issuedKeyId: nextCursor === null ? null : options.activeKeyId',
      '',
    );
    expect(withoutAllowed).not.toMatch(
      /nextCursor|admission_number|display_name|\.id\b|after\b|cursor,|cursor\)/,
    );
    // the event is never swallowed
    expect(src).not.toMatch(/recordAudit\([^;]*\)\.catch|try\s*\{[^}]*recordAudit/);
  });

  it('nothing in the service or the routes logs', () => {
    for (const f of [SERVICE, ROUTES]) expect(code(f)).not.toMatch(/\blog\.|console\.|logger\./);
  });
});

describe('the route is one GET, gated by the new permission, rate limited, and registered only with cursor configuration', () => {
  it('exposes exactly GET /directory with student.directory.list and no other verb', () => {
    const src = code(ROUTES);
    expect([...src.matchAll(/app\.(get|post|put|patch|delete)</g)].map((m) => m[1])).toEqual([
      'get',
    ]);
    expect([...src.matchAll(/^\s+'(\/[^']*)',$/gm)].map((m) => m[1])).toEqual(['/directory']);
    expect(src).toMatch(/permission: 'student\.directory\.list'/);
    expect(src).not.toMatch(/student\.directory\.search/);
  });

  it('counts the caller, never the request, before opening the transaction, and answers 429 with Retry-After', () => {
    const src = code(ROUTES);
    expect(src).toMatch(/limiter\.take\(`\$\{ctx\.tenantId\}:\$\{ctx\.userId\}`\)/);
    expect(src.indexOf('limiter.take(')).toBeLessThan(src.indexOf('withTenant('));
    expect(src).toMatch(/'retry-after'/);
    expect(src).toMatch(/429, 'TOO_MANY_REQUESTS'/);
    expect(src).not.toMatch(/LoginRateLimiter/);
  });

  it('is registered by buildApp only inside `if (config.studentDirectoryListEnabled && config.cursor)`, and the lookup routes file does not know about it', () => {
    const app = code('src/app.ts');
    const at = app.indexOf('registerStudentDirectoryRoutes, {');
    expect(at).toBeGreaterThan(-1);
    const guard = app.lastIndexOf('if (config.studentDirectoryListEnabled && config.cursor)', at);
    expect(guard).toBeGreaterThan(-1);
    expect(app.slice(guard, at)).not.toMatch(/\}\s*\n\s*(app\.register|registerHealth)/); // same block
    expect(app.match(/registerStudentDirectoryRoutes/g)).toHaveLength(2); // import + the one guarded call
    const lookupRoutes = code('src/modules/students/student.routes.ts');
    expect(lookupRoutes).not.toMatch(/directory'|cursor|StudentDirectoryListService/i);
  });

  it('the limiter is not the login limiter and states its single-instance limit', () => {
    const lim = read('src/shared/http/fixed-window-limiter.ts');
    expect(lim).toMatch(/SINGLE INSTANCE ONLY/);
    expect(lim).toMatch(/must not be described as protecting a multi-instance/);
    expect(lim).not.toMatch(/LoginRateLimiter\s*\{|class LoginRateLimiter/);
    expect(read(ROUTES)).toMatch(/SINGLE INSTANCE ONLY/);
  });
});

describe('migration 0024 only registers the permission', () => {
  const sql = readFileSync(
    join(repo, 'database/migrations/0024_student_directory_list_permission.sql'),
    'utf8',
  );
  const executable = sql.replace(/--[^\n]*/g, '');

  it('is not a contract migration, documents the seeding order and the rollout gate, and upserts exactly one row', () => {
    expect(sql).toMatch(/ROLLOUT:/);
    expect(sql).toMatch(/runs only after 0019/);
    expect(sql).toMatch(/seedTenantRoles/);
    expect(executable).toMatch(/INSERT INTO platform\.permissions/);
    expect(executable).toMatch(
      /ON CONFLICT \(code\) DO UPDATE SET sensitivity = EXCLUDED\.sensitivity/,
    );
    expect(executable.match(/'student\.[a-z_.]+', '[A-Z]+'/g)).toEqual([
      "'student.directory.list', 'SENSITIVE'",
    ]);
    expect(executable.replace(/DO UPDATE SET/, '')).not.toMatch(
      /\b(CREATE|ALTER|DROP|GRANT|DELETE|UPDATE)\b/i,
    );
    expect(executable).not.toMatch(/role_permissions/);
  });
});

describe('documentation matches the shipped behaviour', () => {
  const doc21 = readFileSync(join(repo, 'docs/architecture/v3/21-students.md'), 'utf8');
  const secrets = readFileSync(join(repo, 'docs/runbooks/secrets.md'), 'utf8');

  it('doc 21 documents the endpoint, the scope, the audit, the limiter, the non-snapshot caveat and no longer says "no listing" without qualification', () => {
    expect(doc21).toMatch(/GET \/api\/v1\/students\/directory/);
    expect(doc21).toMatch(/student\.directory\.list/);
    expect(doc21).toMatch(/not a snapshot/i);
    expect(doc21).toMatch(/30 requests per user per 60 seconds/);
    expect(doc21).toMatch(/single[- ]instance/i);
    expect(doc21).toMatch(/student\.directory\.list.*tier 1|tier 1.*student\.directory\.list/s);
    expect(doc21).not.toMatch(/\bno listing, no name search, no pagination\b/i);
  });

  it('the secrets runbook covers cursor-key generation, separation, rotation, lifetime plus skew, compromise and the open provider question', () => {
    expect(secrets).toMatch(/CURSOR_KEYS/);
    expect(secrets).toMatch(/CURSOR_ACTIVE_KEY_ID/);
    expect(secrets).toMatch(/32 (cryptographically random )?bytes/);
    expect(secrets).toMatch(/base64url/);
    expect(secrets).toMatch(/600/);
    expect(secrets).toMatch(/30[- ]second/);
    expect(secrets).toMatch(/per environment|each environment|separate keys/i);
    expect(secrets).toMatch(/compromise/i);
    expect(secrets).toMatch(/operator confirmation/i);
    expect(secrets).not.toMatch(
      /\b(AWS Secrets Manager|HashiCorp Vault|Azure Key Vault|GCP Secret Manager|Doppler)\b/i,
    );
  });

  it('doc 10 lists the permission as row 25a with the same grants as row 25', () => {
    const doc10 = readFileSync(
      join(repo, 'docs/architecture/v3/10-milestone-1-permission-catalog.md'),
      'utf8',
    );
    const row = (code: string): string =>
      doc10.split('\n').find((l) => l.includes(`\`${code}\``) && /^\|\s*\d/.test(l))!;
    const cells = (l: string): string[] =>
      l
        .split('|')
        .map((c) => c.trim())
        .slice(3, 12);
    expect(row('student.directory.list')).toBeDefined();
    expect(cells(row('student.directory.list'))).toEqual(cells(row('student.directory.search')));
  });
});
