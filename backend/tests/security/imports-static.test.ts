import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '../../src/shared/authorization/catalog.js';
import { ROLE_CODES, ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';
import { IDEMPOTENCY_TTL_HOURS } from '../../src/shared/idempotency/index.js';

// Static gates for student identifiers and the import framework (migration 0035; no database needed). Text-based, like the
// sibling gates: every SQL statement of the services is a literal, so dynamically built SQL cannot evade them.
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
const get = (path: string): string => files.find((f) => f.path === path)!.text;
const IMPORT_SERVICE = 'src/modules/imports/import.service.ts';
const IDENT_SERVICE = 'src/modules/students/student-identifier.service.ts';
const sql0035 = readFileSync(
  join(repo, 'database/migrations/0035_student_identifiers_and_imports.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

function method(source: string, name: string): string {
  const start = source.indexOf(`static async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf('static async ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('who touches the new tables', () => {
  it('only StudentIdentifierService names app.student_identifiers, and it never deletes', () => {
    const naming = files
      .filter((f) => /app\.student_identifiers\b/.test(f.text))
      .map((f) => f.path);
    expect(naming).toEqual([IDENT_SERVICE]);
    expect(get(IDENT_SERVICE)).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
  });

  it('the identifier service updates exactly issuer, valid_from and valid_to, and inserts one reviewed column list', () => {
    const src = get(IDENT_SERVICE);
    const updates = [
      ...src.matchAll(/UPDATE app\.student_identifiers\b[^`]*?SET ([^`]*?)\s+WHERE/gs),
    ].map((m) => m[1]!.replace(/\s+/g, ' '));
    expect(updates).toEqual(['issuer = $5, valid_from = $6::date, valid_to = $7::date']);
    expect(src.match(/INSERT INTO app\.student_identifiers/g)).toHaveLength(1);
    expect(src).toMatch(
      /\(id, organization_id, student_id, id_type, value, issuer, valid_from, valid_to\)/,
    );
  });

  it('only ImportService names the import tables, and it never deletes', () => {
    const naming = files
      .filter((f) => /app\.import_(jobs|job_rows)\b/.test(f.text))
      .map((f) => f.path);
    expect(naming).toEqual([IMPORT_SERVICE]);
    expect(get(IMPORT_SERVICE)).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
  });

  it('the import module reads and writes no domain table: records are created only through the owning services', () => {
    for (const f of files.filter((x) => x.path.startsWith('src/modules/imports/'))) {
      expect(f.text, f.path).not.toMatch(
        /app\.(students|employees|users|guardians|student_programs|role_assignments|roles|employee_postings)\b/,
      );
      expect(f.text, f.path).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(app|platform)\.(?!import_)/i,
      );
    }
    // ...and the adapters, which sit in the owning modules, contain no write statement at all
    for (const p of [
      'src/modules/students/student-import.adapter.ts',
      'src/modules/people/employee-import.adapter.ts',
    ]) {
      expect(get(p), p).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+app|DELETE\s+FROM|TRUNCATE)\b/i);
    }
    expect(get('src/modules/students/student-import.adapter.ts')).toMatch(
      /StudentService\.insertRecord\(/,
    );
    expect(get('src/modules/people/employee-import.adapter.ts')).toMatch(
      /EmployeeService\.insertRecord\(/,
    );
  });

  it('student and employee rows are still inserted by exactly one service each (the import goes through it)', () => {
    const insertsOf = (table: string): string[] =>
      files
        .filter((f) => new RegExp(`INSERT\\s+INTO\\s+app\\.${table}\\b`, 'i').test(f.text))
        .map((f) => f.path);
    expect(insertsOf('students')).toEqual(['src/modules/students/student.service.ts']);
    expect(insertsOf('employees')).toEqual(['src/modules/people/employee.service.ts']);
  });

  it('student creation and the import path share one write routine (no copy of the checks)', () => {
    const svc = get('src/modules/students/student.service.ts');
    expect(svc).toMatch(/static async insertRecord\(/);
    expect(method(svc, 'create')).toMatch(/StudentService\.insertRecord\(/);
    expect(svc.match(/INSERT\s+INTO\s+app\.students/gi)).toHaveLength(1);
    const emp = get('src/modules/people/employee.service.ts');
    expect(method(emp, 'create')).toMatch(/EmployeeService\.insertRecord\(/);
    expect(emp.match(/INSERT\s+INTO\s+app\.employees/gi)).toHaveLength(1);
  });
});

describe('the commit protocol is pinned in the source', () => {
  const src = get(IMPORT_SERVICE);
  const commit = method(src, 'commit');
  const at = (needle: RegExp): number => commit.search(needle);

  it('order: authorization, then the job lock, then the per-person locks, then revalidation, then the idempotent write', () => {
    const order = [
      /await authorize\(/,
      /loadJob\(tx, ctx, type, id, true\)/,
      /lockPersonIdentity\(/,
      /await evaluate\(/,
      /outcomeHash\(outcomes\)/,
      /runIdempotent\(/,
      /adapter\.create\(/,
      /status: 'COMMITTED'/,
    ].map(at);
    for (const n of order) expect(n).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('account locks are taken in ascending id order (one global order, no deadlock between overlapping imports)', () => {
    expect(commit).toMatch(
      /\]\.sort\(\);\s*for \(const accountId of accounts\) await lockPersonIdentity\(/,
    );
  });

  it('the job lock is FOR UPDATE and every job write is version-guarded', () => {
    expect(src).toMatch(/\$\{lock \? 'FOR UPDATE' : ''\}/);
    expect(src).toMatch(/WHERE organization_id = \$1 AND id = \$2 AND version = \$3/);
    expect(src.match(/UPDATE app\.import_jobs\b/g)).toHaveLength(1);
  });

  it('a stale preview or a new error is answered after the refreshed outcome is stored; only a hash match proceeds', () => {
    expect(commit).toMatch(/hash !== job\.validation_hash/);
    expect(commit).toMatch(/IMPORT_PREVIEW_CHANGED/);
    expect(commit).toMatch(/IMPORT_COMMIT_CONFLICT/);
    expect(commit).toMatch(/if \(job\.version !== expectedVersion \|\| !preChecked\)/);
  });

  it('the validation path cannot write a domain table: evaluate() only reads the import rows and calls the adapter', () => {
    const evaluate = src.slice(
      src.indexOf('async function evaluate('),
      src.indexOf('function summarize('),
    );
    expect(evaluate).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(evaluate).not.toMatch(/lockPersonIdentity|recordAudit|FOR UPDATE/);
    expect(method(src, 'validate')).not.toMatch(/adapter\.create\(|recordAudit/);
  });
});

describe('routes and permissions', () => {
  it('the import routes are exactly the six reviewed ones, all gated by import.job.manage', () => {
    const text = get('src/modules/imports/import.routes.ts');
    const verbs = [...text.matchAll(/app\.(get|post|put|patch|delete)</g)].map((m) => m[1]);
    expect(verbs.sort()).toEqual(['get', 'get', 'get', 'post', 'post', 'post']);
    const paths = [...text.matchAll(/^\s+'(\/[^']*)',$/gm)].map((m) => m[1]);
    expect(paths.sort()).toEqual([
      '/',
      '/:id',
      '/:id/commit',
      '/:id/error-report',
      '/:id/rows',
      '/:id/validate',
    ]);
    expect(text.match(/permission: 'import\.job\.manage'/g)).toHaveLength(6);
    expect(text).toMatch(/parseIfMatch\(/);
    expect(text).not.toMatch(/organizationId|tenantId|req\.body\.rows/);
  });

  it('the identifier routes are GET, POST and PATCH only: there is no delete', () => {
    const text = get('src/modules/students/student-identifier.routes.ts');
    const verbs = [...text.matchAll(/app\.(get|post|put|patch|delete)</g)].map((m) => m[1]);
    expect(verbs.sort()).toEqual(['get', 'patch', 'post']);
    expect(text.match(/permission: 'student\.record\.update'/g)).toHaveLength(2);
    expect(text.match(/permission: 'student\.profile\.read_sensitive'/g)).toHaveLength(1);
  });

  it('the imports are mounted once per record kind, and nowhere else', () => {
    const app = get('src/app.ts');
    expect(app).toMatch(
      /registerStudentImportRoutes, \{\s*prefix: '\/api\/v1\/students\/imports',\s*db: deps\.db,\s*binder:/,
    );
    expect(app).toMatch(/registerEmployeeImportRoutes, \{ prefix: '\/api\/v1\/faculty\/imports'/);
    expect(app.match(/registerStudentImportRoutes|registerEmployeeImportRoutes/g)?.length).toBe(4); // 2 imports + 2 uses
  });

  it('import.job.manage is held by exactly COLLEGE_ADMIN and REGISTRAR; student.record.update by the four record administrators', () => {
    expect(PERMISSION_CODES.has('import.job.manage')).toBe(true);
    const holders = (p: string): string[] => ROLE_CODES.filter((r) => ROLE_MATRIX[r][p]).sort();
    expect(holders('import.job.manage')).toEqual(['COLLEGE_ADMIN', 'REGISTRAR']);
    expect(holders('student.record.update')).toEqual([
      'CAMPUS_ADMIN',
      'COLLEGE_ADMIN',
      'DEPARTMENT_ADMIN',
      'REGISTRAR',
    ]);
    for (const p of ['import.job.manage', 'student.record.update']) {
      for (const r of ROLE_CODES)
        if (ROLE_MATRIX[r][p]) expect(ROLE_MATRIX[r][p], `${r} ${p}`).toBe('GRANTED');
    }
  });

  it('every role that may create students may also read guardians and sensitive profiles (the duplicate-check assumption, doc 26 §3.5.2)', () => {
    // The possible-duplicate check reads guardian phones and dates of birth on behalf of a student.record.create holder, and
    // its acknowledgement fingerprint can identify the matched candidates to an actor who can enumerate student ids. That
    // reveals nothing new ONLY if every such holder could read the same data directly, at the same scope. Tenant roles are
    // seeded and re-synced from ROLE_MATRIX (app_runtime cannot write roles or role_permissions), so the matrix is the
    // invariant the application can enforce; a privileged, out-of-band grant would bypass it (doc 26 §3.5.2).
    const creators = ROLE_CODES.filter((r) => ROLE_MATRIX[r]['student.record.create']);
    expect(creators.length).toBeGreaterThan(0);
    for (const r of creators) {
      const mode = ROLE_MATRIX[r]['student.record.create'];
      for (const p of ['student.guardian.read', 'student.profile.read_sensitive']) {
        expect(ROLE_MATRIX[r][p], `${r} ${p}`).toBe(mode);
      }
    }
  });
});

describe('migration 0035', () => {
  it('forces row security on all three tables and never weakens it', () => {
    for (const t of ['student_identifiers', 'import_jobs', 'import_job_rows']) {
      expect(sql0035).toMatch(new RegExp(`ALTER TABLE app\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql0035).toMatch(new RegExp(`ALTER TABLE app\\.${t} FORCE\\s+ROW LEVEL SECURITY`));
    }
    expect(sql0035).not.toMatch(/\bNO\s+FORCE\b|DISABLE\s+ROW\s+LEVEL\s+SECURITY|BYPASSRLS/i);
  });

  it('grants no DELETE, no TRUNCATE and only column-level UPDATE', () => {
    expect(sql0035).not.toMatch(/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b/i);
    expect(sql0035).not.toMatch(/GRANT\s+UPDATE\s+ON/i);
    const updates = [...sql0035.matchAll(/GRANT UPDATE \(([^)]*)\) ON (app\.\w+)/g)].map(
      (m) => `${m[2]}: ${m[1]!.replace(/\s+/g, ' ')}`,
    );
    expect(updates).toEqual([
      'app.student_identifiers: issuer, valid_from, valid_to',
      'app.import_jobs: status, summary, validation_hash, committed_at',
      'app.import_job_rows: status, normalized, errors, warnings, student_id, employee_id',
    ]);
  });

  it('is an expand-only migration: no backfill, no data change, a bounded lock wait, invoker functions with a pinned search_path', () => {
    expect(sql0035).not.toMatch(
      /\b(UPDATE\s+app\.|DELETE\s+FROM|ALTER\s+TABLE\s+app\.\w+\s+(ADD|DROP|ALTER)\b)/i,
    );
    expect(sql0035).not.toMatch(/INSERT\s+INTO\s+app\./i);
    expect(sql0035).toMatch(/SET LOCAL lock_timeout = '5s'/);
    const fns = [...sql0035.matchAll(/CREATE FUNCTION (app\.\w+)\(\)[\s\S]*?\$\$;?/g)];
    expect(fns.map((m) => m[1])).toEqual([
      'app.student_identifiers_guard',
      'app.import_jobs_guard',
      'app.import_job_rows_guard',
    ]);
    for (const m of fns) {
      expect(m[0]).toMatch(/SET search_path = pg_catalog/);
      expect(m[0]).not.toMatch(/SECURITY DEFINER/i);
      expect(sql0035).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${m[1]}\\(\\) FROM PUBLIC`));
    }
  });

  it('is an ordinary migration, not a gated contract step, and the owner-only policy compares the creator', () => {
    expect(
      readdirSync(join(repo, 'database/migrations')).filter((n) => n.startsWith('0035_')),
    ).toEqual(['0035_student_identifiers_and_imports.sql']);
    expect(sql0035).toMatch(
      /CREATE POLICY import_jobs_owner_only[\s\S]*created_by = app\.current_user_id\(\)/,
    );
    expect(sql0035).toMatch(/CREATE POLICY import_job_rows_owner_only[\s\S]*FROM app\.import_jobs/);
  });
});

describe('possible-duplicate detection and the sensitive matching inputs (migration 0036)', () => {
  const DUP = 'src/modules/students/student-duplicate.service.ts';
  const sql0036 = readFileSync(
    join(repo, 'database/migrations/0036_user_date_of_birth_and_duplicate_matching.sql'),
    'utf8',
  ).replace(/--[^\n]*/g, '');

  it('only the two writers of student records call the matcher, and no route or other module does', () => {
    const callers = files
      .filter((f) => f.path !== DUP && /StudentDuplicateService\b/.test(f.text))
      .map((f) => f.path)
      .filter((p) => p !== 'src/modules/students/index.ts');
    expect(callers.sort()).toEqual([
      'src/modules/students/student-import.adapter.ts',
      'src/modules/students/student.service.ts',
    ]);
    for (const f of files.filter((x) => x.path.endsWith('.routes.ts'))) {
      expect(f.text, f.path).not.toMatch(/StudentDuplicateService/);
    }
  });

  it('the guardian phone reader is called by the matcher only, and the fingerprint binds tenant, actor and account', () => {
    const users = files
      .filter((f) => /phonesForMatching\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      'src/modules/students/student-duplicate.service.ts',
      'src/modules/students/student-guardian.service.ts',
    ]);
    expect(get(DUP)).toMatch(/ctx\.tenantId\}\\n\$\{ctx\.userId\}\\n\$\{probe\.excludeUserId/);
  });

  it('the matcher is read-only, self-authorizing and returns only a fingerprint or null', () => {
    const src = get(DUP);
    expect(src).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+app|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(src).toMatch(/assertStaffActor\(ctx\)/);
    expect(src).toMatch(/assert\(tx, ctx, 'student\.record\.create'\)/);
    expect(src).toMatch(/organization_id: ctx\.tenantId/);
    expect(src).toMatch(/Promise<\(string \| null\)\[\]>/);
    // every statement is tenant-filtered
    for (const sql of src.matchAll(/tx\.query[^`]*`([^`]*)`/gs)) {
      expect(sql[1]).toMatch(/organization_id = \$1/);
    }
    // it does not rely on the guardian permission (the caller only learns that a match exists)
    expect(src).not.toMatch(/student\.guardian\./);
    // the guardian tables are named by the guardian service only; the matcher gets phones from its internal method
    expect(src).not.toMatch(/app\.(student_)?guardians/);
    expect(src).toMatch(/StudentGuardianService\.phonesForMatching\(/);
    expect(get('src/modules/students/student-guardian.service.ts')).toMatch(
      /static async phonesForMatching\(/,
    );
  });

  it('the guardian phone and the date of birth of a request are never written to any table by the application', () => {
    for (const f of files.filter((x) => /guardianPhone|dateOfBirth/.test(x.text))) {
      // no write statement of these files touches a date-of-birth column or a guardian table
      expect(f.text, f.path).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.(guardians|student_guardians|users)\b/i,
      );
      expect(f.text, f.path).not.toMatch(/\b(INSERT\s+INTO|UPDATE)\b[^`]*date_of_birth/is);
    }
    // ...and nothing in src writes users.date_of_birth at all (no writer exists yet: doc 26 §7)
    for (const f of files) {
      expect(f.text, f.path).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE)\s+app\.users\b[^`]*date_of_birth/is,
      );
    }
    // RESUPPLY DESIGN: no import column or statement holds the cells (the earlier match_input column is gone)
    for (const f of files)
      expect(f.text, f.path).not.toMatch(/match_input|scrubMatchInput|SENSITIVE_COLUMNS/);
    const imp = get(IMPORT_SERVICE);
    // the cells reach evaluate through the request-scoped map only, and are bound to the stored rows
    expect(imp).toMatch(/async function bindMatching\(/);
    expect(imp).toMatch(/emails\.get\(rowNo\) !== e\.email\.trim\(\)\.toLowerCase\(\)/);
    expect(imp).toMatch(/matching: ReadonlyMap<number, MatchingCells>/);
    // create refuses the matching-only columns instead of storing or dropping them
    expect(imp).toMatch(/MATCHING_ONLY_COLUMNS as readonly string\[\]\)\.includes\(name\)/);
    expect(method(imp, 'create')).not.toMatch(/matching|dateOfBirth|guardianPhone/);
    // persisted: two presence bits per row, and on a committed job the HMAC binding; never an unkeyed or salted digest
    expect(imp).toMatch(/match_presence = v\.presence/);
    for (const f of files) expect(f.text, f.path).not.toMatch(/argon2\.hash\([^)]*canonical/);
    expect(imp).not.toMatch(/argon2|createHash\([^)]*\)\.update\(canonical/);
    expect(imp).toMatch(/binding: canonical === null \? null : binder!\.bind\(scope, canonical\)/);
  });

  it('the binding is an HMAC-SHA-256 under the dedicated ring only, compared in constant time', () => {
    const src = get('src/modules/imports/import.binding.ts');
    expect(src).toMatch(/createHmac\('sha256', key\)/);
    expect(src).toMatch(/timingSafeEqual\(stored\.mac, expected\)/);
    expect(src).not.toMatch(/argon2|createHash|randomBytes|===\s*expected|\.equals\(/);
    // domain separation and scope: purpose, version, key id, tenant, job
    expect(src).toMatch(
      /\[PURPOSE, `v\$\{FORMAT_VERSION\}`, keyId, scope\.organizationId, scope\.jobId, canonical\]/,
    );
    // a key that is not in the ring fails closed
    expect(src).toMatch(/if \(!key\) throw matchingUnavailable\(\)/);
    // the ring comes only from config.importMatching; no other ring is passed to the binder
    const app = get('src/app.ts');
    expect(app).toMatch(/new MatchingBinder\(config\.importMatching\)/);
    expect(app).not.toMatch(/new MatchingBinder\(config\.(cursor|mfa)\b/);
    const users = files
      .filter((f) => /new MatchingBinder\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual(['src/app.ts']);
    for (const f of files.filter(
      (x) => /import\.binding\.js/.test(x.text) && x.path !== 'src/app.ts',
    )) {
      expect(f.text, f.path).not.toMatch(/CURSOR_KEYS|MFA_ENCRYPTION_KEYS|config\.(cursor|mfa)/);
    }
  });

  it('commit: matching is bound, key-checked and presence-checked before any evaluation, and a replay verifies the HMAC', () => {
    const imp = get(IMPORT_SERVICE);
    const commit = method(imp, 'commit');
    const at = (needle: RegExp): number => commit.search(needle);
    const order = [
      /await bindMatching\(/,
      /assertMatchingValid\(adapter, matching\)/,
      /const canonical = canonicalMatching\(matching\)/,
      /if \(canonical !== null && !binder\) throw matchingUnavailable\(\)/,
      /if \(await presenceDiffers\(tx, ctx, job, matching\)\)/,
      /IMPORT_MATCHING_MISMATCH/,
      /await evaluate\(tx, ctx, adapter, job\.id, matching\)/,
      /runIdempotent\(/,
      /binder!\.bind\(scope, canonical\)/,
      /if \(result\.replayed\) \{/,
      /binder!\.verify\(stored, scope, canonical\)/,
      /'IDEMPOTENCY_KEY_REUSED'/,
      /return \{ kind: 'done', result \}/,
    ].map(at);
    for (const n of order) expect(n).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the idempotency fingerprint of the commit carries no matching data
    expect(commit).toMatch(/request: \{ type, jobId: id, expectedVersion, reason, acknowledged \}/);
    // a bound commit never replays against a request without matching data, and vice versa
    expect(commit).toMatch(/\? stored === null && canonical === null/);
  });

  it('one strict reading of the matching data: commit-time validation, no HTTP coercion, normalised presence, explicit date text', () => {
    const imp = get(IMPORT_SERVICE);
    const fn = (name: string): string => {
      const start = imp.search(new RegExp(`\\n(async )?function ${name}\\(`));
      expect(start, name).toBeGreaterThan(-1);
      const end = imp.slice(start + 1).search(/\n(async )?function |\nexport /);
      return imp.slice(start, end === -1 ? undefined : start + 1 + end);
    };
    // F1: the commit refuses invalid cells with the shared parser before any evaluation (never a terminal FAILED)
    const check = fn('assertMatchingValid');
    expect(check).toMatch(/adapter\.parseMatching\(cells\)\.errors\.length > 0/);
    expect(check).toMatch(/throw invalid\(/);
    // F1: the commit body leaves `matching` untyped, so bindMatching is the single validator of both routes
    expect(get('src/modules/imports/import.schemas.ts')).toMatch(
      /matching: Type\.Optional\(Type\.Unknown\(\)\)/,
    );
    // L1: the acknowledgement is untyped in the schema too, so only a JSON boolean passes the service's strict check
    expect(get('src/modules/imports/import.schemas.ts')).toMatch(
      /acknowledgeWarnings: Type\.Optional\(Type\.Unknown\(\)\)/,
    );
    expect(imp).toMatch(/typeof input\.acknowledgeWarnings !== 'boolean'/);
    // L2: admission's matching-only text fields are untyped in the schema; StudentService.create accepts strings only
    const admission = get('src/modules/students/student.schemas.ts');
    expect(admission).toMatch(/name: Type\.Optional\(Type\.Unknown\(\)\)/);
    expect(admission).toMatch(/guardianPhone: Type\.Optional\(Type\.Unknown\(\)\)/);
    expect(get('src/modules/students/student.service.ts')).toMatch(
      /const text = typeof value === 'string' \? value\.trim\(\) : '';/,
    );
    // F4: a phone without digits is absent, by the matcher's own normalisation
    expect(fn('bindMatching')).toMatch(
      /phoneText !== undefined && normalizePhone\(phoneText\) !== '' \? phoneText : undefined/,
    );
    // F5: the candidate date never depends on the session DateStyle
    const dup = get('src/modules/students/student-duplicate.service.ts');
    expect(dup).toMatch(/to_char\(u\.date_of_birth, 'YYYY-MM-DD'\) AS dob/);
    expect(dup).not.toMatch(/date_of_birth::text/);
  });

  it('the key-retirement rule of the runbook follows the real idempotency lifetime (update both together)', () => {
    const runbook = readFileSync(join(repo, 'docs/runbooks/secrets.md'), 'utf8');
    expect(runbook).toContain(`\`IDEMPOTENCY_TTL_HOURS = ${IDEMPOTENCY_TTL_HOURS}\``);
    expect(runbook).toContain(`interval '${IDEMPOTENCY_TTL_HOURS + 1} hours'`);
  });

  it('within-file matching uses the single triple definition of the matcher and warns once per row, against the first row', () => {
    const dup = get('src/modules/students/student-duplicate.service.ts');
    expect(dup).toMatch(/function usableTriple\(/);
    expect(dup).toMatch(/probes\.map\(usableTriple\)/);
    expect(dup).toMatch(/export function firstEarlierMatches\(/);
    const adapter = get('src/modules/students/student-import.adapter.ts');
    expect(adapter).toMatch(/firstEarlierMatches\(/);
    expect(adapter).toMatch(/POSSIBLE_DUPLICATE_IN_FILE/);
  });

  it('the audit events carry the fact of an acknowledgement, never a value', () => {
    const svc = get('src/modules/students/student.service.ts');
    expect(svc).toMatch(/metadata: \{ duplicateAcknowledgementSupplied: true \}/);
    expect(svc).not.toMatch(/changes:[^}]*(dateOfBirth|guardianPhone)/s);
    expect(get(IMPORT_SERVICE)).toMatch(/duplicateWarningRows: duplicateRows/);
  });

  it('0036 only adds: a nullable date column without default, an index, a check, the presence bits and the HMAC binding columns with their grants', () => {
    const statements = sql0036
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s !== '');
    expect(statements.some((s) => /^(INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/i.test(s))).toBe(false);
    expect(sql0036).toMatch(/ADD COLUMN date_of_birth date,/);
    expect(sql0036).not.toMatch(/date_of_birth\s+date\s+(NOT NULL|DEFAULT)/i);
    expect(sql0036).not.toMatch(/GRANT\s+UPDATE\s*\([^)]*date_of_birth/i);
    expect(sql0036).not.toMatch(/app\.students/);
    expect(sql0036).not.toMatch(/match_input/);
    expect(sql0036).toMatch(
      /ADD COLUMN match_presence smallint NOT NULL DEFAULT 0 CHECK \(match_presence BETWEEN 0 AND 3\)/,
    );
    expect(sql0036).toMatch(
      /GRANT UPDATE \(match_presence\) ON app\.import_job_rows TO app_runtime/,
    );
    expect(statements.filter((s) => /^GRANT\b/i.test(s))).toEqual([
      'GRANT UPDATE (match_presence) ON app.import_job_rows TO app_runtime',
      'GRANT UPDATE (match_binding, match_binding_key_label) ON app.import_jobs TO app_runtime',
    ]);
    // the binding column is a 32-byte MAC with its key id, only on a committed job
    expect(sql0036).toMatch(/ADD COLUMN match_binding bytea,/);
    expect(sql0036).toMatch(/octet_length\(match_binding\) = 32/);
    expect(sql0036).toMatch(/status = 'COMMITTED'/);
  });
});
