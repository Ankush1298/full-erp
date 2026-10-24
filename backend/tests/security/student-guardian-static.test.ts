import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '../../src/shared/authorization/catalog.js';
import { ROLE_CODES, ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';

// Static gates for student guardians (migration 0027; no database needed). Text-based, like the sibling gates: SQL built
// dynamically could evade them, which is why every statement of the service is a literal.
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
const SERVICE = 'src/modules/students/student-guardian.service.ts';
const ROUTES = 'src/modules/students/student-guardian.routes.ts';
const SCHEMAS = 'src/modules/students/student-guardian.schemas.ts';
const get = (path: string): string => files.find((f) => f.path === path)!.text;
const sql0027 = readFileSync(join(repo, 'database/migrations/0027_student_guardians.sql'), 'utf8');
const code0027 = sql0027.replace(/--[^\n]*/g, '');

/** The body of `static async <name>(` up to the next `static async` (or the end of the class). */
function method(source: string, name: string): string {
  const start = source.indexOf(`static async ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf('static async ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

// Files that know a guardian only as the MATCHING-ONLY input `guardianPhone` of the possible-duplicate check (doc 26 §3.5).
// They never read a guardian field (tests/security/imports-static.test.ts pins that no SQL of theirs names a guardian table).
const MATCHING_ONLY = [
  'src/modules/students/student-duplicate.service.ts',
  'src/modules/students/student-import.adapter.ts',
  'src/modules/students/student.schemas.ts',
  'src/modules/students/student.service.ts',
];

describe('only StudentGuardianService touches the guardian tables', () => {
  it('no other source file names app.guardians or app.student_guardians, so no other endpoint can expose guardian data', () => {
    const naming = files
      .filter((f) => /app\.(student_)?guardians\b/.test(f.text))
      .map((f) => f.path);
    expect(naming).toEqual([SERVICE]);
  });

  it('no student, directory, enrolment or status module reads or serves a guardian field', () => {
    for (const f of files) {
      // index.ts only re-exports the guardian module; every other file of the students module must not know guardians
      if (
        !f.path.startsWith('src/modules/students/') ||
        f.path.includes('student-guardian.') ||
        f.path.endsWith('/index.ts') ||
        MATCHING_ONLY.includes(f.path)
      ) {
        continue;
      }
      expect(f.text, f.path).not.toMatch(/guardian/i);
    }
  });

  it('the service never deletes or truncates, and writes only the reviewed columns', () => {
    const src = get(SERVICE);
    expect(src).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE)\b/i);
    expect(
      src.match(/INSERT INTO app\.guardians \(id, organization_id, full_name, phone, email\)/g),
    ).toHaveLength(1);
    expect(src.match(/INSERT INTO app\.student_guardians/g)).toHaveLength(1);
    // guardians: contact data in one statement, the soft-delete marker in the other, nothing else
    const guardianUpdates = [
      ...src.matchAll(/UPDATE app\.guardians\b[^`]*?SET ([^`]*?)\s+WHERE/gs),
    ].map((m) => m[1]!.replace(/\s+/g, ' '));
    expect(guardianUpdates).toEqual([
      'full_name = $3, phone = $4, email = $5',
      'deleted_at = now()',
    ]);
    // links: attributes in one statement, the end date in the other; never the identity columns
    const linkUpdates = [
      ...src.matchAll(/UPDATE app\.student_guardians\b[^`]*?SET ([^`]*?)\s+WHERE/gs),
    ].map((m) => m[1]!.replace(/\s+/g, ' '));
    expect(linkUpdates).toEqual([
      'relation = $5, is_primary = $6, can_view_academics = $7, can_receive_notifications = $8, can_give_consent = $9',
      'valid_to = GREATEST($5::date, valid_from), is_primary = false',
    ]);
    for (const set of linkUpdates)
      expect(set).not.toMatch(/\b(student_id|guardian_id|valid_from|organization_id|id)\s*=/);
  });

  it('every read and write of a guardian is bound to the tenant and, for a link, to the student of the path', () => {
    const src = get(SERVICE);
    for (const m of src.matchAll(
      /(?:UPDATE app\.(?:student_)?guardians|FROM app\.student_guardians)[^`]*?WHERE[^`]*/gs,
    )) {
      expect(m[0], m[0]).toMatch(/organization_id = \$1/);
    }
    expect(src).toMatch(
      /sg\.organization_id = \$1 AND sg\.student_id = \$2 AND sg\.valid_to IS NULL AND g\.deleted_at IS NULL/,
    );
  });
});

describe('the service orders its steps: shape, actor and permission, scope, version, write, audit last', () => {
  for (const name of ['add', 'update', 'remove'] as const) {
    it(`${name}: staff actor and permission come before any statement; the audit event is the last write`, () => {
      const body = method(get(SERVICE), name);
      const staff = body.indexOf('assertStaffActor');
      const perm = body.indexOf('AuthorizationEngine.assert(tx, ctx, GUARDIAN_MANAGE_PERMISSION)');
      const firstQuery = body.search(/tx\.query|lockStudentAndProveScope|runIdempotent/);
      const audit = body.indexOf('recordAudit(');
      expect(staff, 'assertStaffActor').toBeGreaterThan(-1);
      expect(perm, 'permission').toBeGreaterThan(staff);
      expect(firstQuery, 'first statement').toBeGreaterThan(perm);
      expect(audit, 'audit').toBeGreaterThan(-1);
      const lastWrite = Math.max(body.lastIndexOf('INSERT INTO'), body.lastIndexOf('UPDATE app.'));
      expect(audit).toBeGreaterThan(lastWrite);
      expect(body.match(/recordAudit\(/g)).toHaveLength(1);
    });
  }

  it('add: the Idempotency-Key is parsed only after the permission, update and remove demand the exact version', () => {
    const add = method(get(SERVICE), 'add');
    expect(add.indexOf('parseIdempotencyKey')).toBeGreaterThan(
      add.indexOf('GUARDIAN_MANAGE_PERMISSION'),
    );
    for (const name of ['update', 'remove'] as const) {
      expect(method(get(SERVICE), name)).toMatch(/requireExactVersion\(options\.expected\)/);
    }
  });

  it('every write takes the student row first (FOR NO KEY UPDATE), then the link and guardian rows: one lock order', () => {
    const src = get(SERVICE);
    expect(src).toMatch(
      /SELECT id FROM app\.students WHERE organization_id = \$1 AND id = \$2 FOR NO KEY UPDATE/,
    );
    expect(src).toMatch(/FOR NO KEY UPDATE OF sg, g/);
    for (const name of ['update', 'remove'] as const) {
      const body = method(src, name);
      expect(body.indexOf('lockStudentAndProveScope')).toBeGreaterThan(-1);
      expect(body.indexOf('lockStudentAndProveScope')).toBeLessThan(body.indexOf('lockActiveLink'));
    }
  });

  it('scope is the persisted placement only and never inferred from a role name or an actor kind', () => {
    const src = get(SERVICE);
    expect(src).toMatch(/lockActiveEnrolment\(tx, ctx\.tenantId, studentId\)/);
    expect(src).toMatch(/readActiveEnrolment\(tx, ctx\.tenantId, sid\)/); // add(): the unlocked pre-claim proof only
    expect(src).not.toMatch(
      /\b(COLLEGE_ADMIN|REGISTRAR|CAMPUS_ADMIN|DEPARTMENT_ADMIN|HOD|FACULTY|ROLE_CODES|ROLE_MATRIX)\b|actorKind/,
    );
  });

  it('the audit events carry no contact data: names of changed contact fields only', () => {
    const src = get(SERVICE);
    expect(src).not.toMatch(
      /\{\s*old:[^}]*new:\s*(fullName|phone|email|next\.(fullName|phone|email))\b/,
    );
    expect(src).toMatch(/fullName: \{ changed: true \}/);
    expect(src.match(/riskTier: 2/g)).toHaveLength(3);
    expect(src.match(/reasonText: reason/g)).toHaveLength(3);
  });
});

describe('routes and schemas', () => {
  it('every route is gated by a catalogued guardian permission and uses the tenant context from the session', () => {
    const src = get(ROUTES);
    const used = [...src.matchAll(/permission:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(used.sort()).toEqual([
      'student.guardian.manage',
      'student.guardian.manage',
      'student.guardian.manage',
      'student.guardian.read',
    ]);
    for (const p of used) expect(PERMISSION_CODES.has(p), p).toBe(true);
    expect(src.match(/req\.tenantContext/g)).toHaveLength(4);
    expect(src).not.toMatch(/organizationId|tenantId|req\.query|req\.headers\[['"](x-|host)/i);
  });

  it('PATCH and DELETE parse If-Match with the shared parser; POST hands the raw Idempotency-Key to the service', () => {
    const src = get(ROUTES);
    expect(src.match(/parseIfMatch\(/g)).toHaveLength(2);
    expect(src).toMatch(/req\.headers\['idempotency-key'\]/);
    expect(src).not.toMatch(/parseIdempotencyKey/);
  });

  it('every request body is closed, and none accepts a tenant, student, guardian, user, date or minor-status field', () => {
    const src = get(SCHEMAS);
    const bodies = src.match(/export const \w+BodySchema = Type\.Object\([\s\S]*?\n\);/g) ?? [];
    expect(bodies).toHaveLength(3);
    for (const b of bodies) {
      expect(b).toMatch(/additionalProperties: false/);
      expect(b).not.toMatch(
        /\b(organizationId|organization_id|tenantId|studentId|guardianId|userId|validFrom|validTo|isMinor|isEmergencyContact|isLegalGuardian)\b/,
      );
    }
    for (const b of bodies) expect(b).toMatch(/reason: ReasonSchema/);
  });
});

describe('authorization matrix: no invented permissions, no new role', () => {
  const holders = (perm: string): Record<string, string> =>
    Object.fromEntries(
      ROLE_CODES.flatMap((r) => (ROLE_MATRIX[r][perm] ? [[r, ROLE_MATRIX[r][perm]]] : [])),
    );

  it('read: the student reads their own (SELF); HOD, DEPARTMENT_ADMIN, CAMPUS_ADMIN, COLLEGE_ADMIN and REGISTRAR within scope (doc 10 row 30)', () => {
    expect(holders('student.guardian.read')).toEqual({
      STUDENT: 'SELF',
      HOD: 'GRANTED',
      DEPARTMENT_ADMIN: 'GRANTED',
      CAMPUS_ADMIN: 'GRANTED',
      COLLEGE_ADMIN: 'GRANTED',
      REGISTRAR: 'GRANTED',
    });
  });

  it('manage: the four administrative roles only, never the student, HOD, FACULTY or STAFF (doc 10 row 31)', () => {
    expect(holders('student.guardian.manage')).toEqual({
      DEPARTMENT_ADMIN: 'GRANTED',
      CAMPUS_ADMIN: 'GRANTED',
      COLLEGE_ADMIN: 'GRANTED',
      REGISTRAR: 'GRANTED',
    });
  });

  it('there is no GUARDIAN role and no guardian permission beyond read and manage', () => {
    expect(ROLE_CODES as readonly string[]).not.toContain('GUARDIAN');
    expect([...PERMISSION_CODES].filter((c) => /guardian/i.test(c)).sort()).toEqual([
      'student.guardian.manage',
      'student.guardian.read',
    ]);
  });
});

describe('migration 0027 pins its decisions', () => {
  it('guardians is forced-RLS and tenant-keyed; links are never deletable; nothing is dropped or deleted', () => {
    expect(code0027).toMatch(/ALTER TABLE app\.guardians FORCE\s+ROW LEVEL SECURITY/);
    expect(code0027).toMatch(/guardians_org_id_uq UNIQUE \(organization_id, id\)/);
    expect(code0027).toMatch(
      /student_guardians_guardian_fk FOREIGN KEY \(organization_id, guardian_id\)/,
    );
    expect(code0027).toMatch(
      /student_guardians_link_no_delete[\s\S]*?FOR DELETE[\s\S]*?USING \(guardian_id IS NULL\)/,
    );
    // The only DROPs: DROP NOT NULL (two legacy contact columns) and the ONE index that is split into a legacy-only and a
    // new-shape primary slot. No table, column, constraint, policy, trigger or other index is dropped.
    expect(
      [...code0027.matchAll(/\bDROP\s+\w+(?:\s+app\.\w+)?/gi)].map((m) =>
        m[0].replace(/\s+/g, ' '),
      ),
    ).toEqual(['DROP NOT', 'DROP NOT', 'DROP INDEX app.student_guardians_one_primary_uq']);
    expect(code0027).toMatch(
      /CREATE UNIQUE INDEX student_guardians_one_primary_uq\s+ON app\.student_guardians \(student_id\) WHERE is_primary AND guardian_id IS NULL/,
    );
    expect(code0027).toMatch(
      /CREATE UNIQUE INDEX student_guardians_one_primary_link_uq\s+ON app\.student_guardians \(organization_id, student_id\) WHERE is_primary AND guardian_id IS NOT NULL/,
    );
    expect(code0027).not.toMatch(/\bCURRENT_DATE\b/); // dates are never the session's
    expect(code0027).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|NO\s+FORCE|DISABLE ROW LEVEL/i);
  });

  it('deliberately absent: a backfill, guardian login, emergency-contact and legal-guardian attributes', () => {
    expect(code0027).not.toMatch(/INSERT INTO app\.guardians|UPDATE app\./i); // no backfill: both tables are forced-RLS
    // the guardian table has no user_id (the policies read students.user_id, which is a different column)
    const table = /CREATE TABLE app\.guardians \([\s\S]*?\n\);/.exec(code0027)?.[0] ?? '';
    expect(table).toMatch(/full_name/);
    expect(table).not.toMatch(/\buser_id\b/);
    expect(code0027).not.toMatch(/is_emergency_contact|is_legal_guardian/);
  });

  it('the runtime role is granted exactly the columns the service writes', () => {
    expect(code0027).toMatch(/GRANT SELECT, INSERT ON app\.guardians TO app_runtime/);
    expect(code0027).toMatch(
      /GRANT UPDATE \(full_name, phone, email, deleted_at\) ON app\.guardians TO app_runtime/,
    );
    expect(code0027).toMatch(
      /GRANT UPDATE \(can_give_consent, can_view_academics, can_receive_notifications, valid_to\)\s+ON app\.student_guardians TO app_runtime/,
    );
    expect(code0027).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
  });
});
