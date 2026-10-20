import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import {
  MAX_ACTIVE_GUARDIANS,
  StudentGuardianService,
  type AddStudentGuardianInput,
} from '../../src/modules/students/index.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import type { ExpectedVersion } from '../../src/shared/settings/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Student guardians (migration 0027): the service and the HTTP routes against the shared disposable integration
// database. Everything commits, so it runs in PRIVATE tenants; every assertion looks at rows these tests created (by id),
// never at tenant-wide counts.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 12 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

let T!: IsolatedTenant; // the tenant under test
let OTHER!: IsolatedTenant; // a second private tenant: cross-tenant checks
let PERIOD: string;
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);

interface Structure {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Structure; // the tenant's campus and main department
let sibling!: Structure; // same campus, another department
let other!: Structure; // ANOTHER campus (outside the campus admin's scope)
const extraUsers: Record<string, string> = {};

const ctxFor = (user: string, kind: 'STAFF' | 'STUDENT' = 'STAFF', tenant = T): TrustedContext =>
  issueTrustedContext({ tenantId: tenant.orgId, userId: user, actorKind: kind });

async function mkCampus(): Promise<string> {
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Test campus', $3, 'Asia/Kolkata')`,
    [id, T.orgId, code('C')],
  );
  return id;
}
async function mkStructure(campus: string, dept?: string): Promise<Structure> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'Test dept', $4)`,
      [d, T.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'Test program', $5, 'UG', 8)`,
    [program, T.orgId, d, PERIOD, code('P')],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'Test cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
async function mkUser(role?: { code: string; scope: 'CAMPUS' | 'DEPARTMENT'; id: string }) {
  const id = uuidv7();
  const email = `sg-${RUN}-${id.slice(-12)}@isolated.test`;
  await adminQuery(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'test-hash', 'ACTIVE')`,
    [id, email],
  );
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, $3, 'ACTIVE', $1)`,
    [id, T.orgId, email],
  );
  if (role) {
    await adminQuery(
      `INSERT INTO app.role_assignments (id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id)
       SELECT $1::uuid, $2::uuid, $3::uuid, r.id, $5::text, $6::uuid,
              CASE WHEN $5::text = 'CAMPUS' THEN $6::uuid END, CASE WHEN $5::text = 'DEPARTMENT' THEN $6::uuid END
         FROM app.roles r WHERE r.organization_id = $2::uuid AND r.code = $4`,
      [uuidv7(), T.orgId, id, role.code, role.scope, role.id],
    );
  }
  return id;
}
let admissionSeq = 0;
/** A student in the tenant under test, directly in the database (the harness bypasses the service on purpose). */
async function mkStudent(): Promise<string> {
  const user = await mkUser();
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, DATE '2024-07-01', 'ACTIVE')`,
    [id, T.orgId, user, `SG${RUN}${admissionSeq++}`],
  );
  return id;
}
async function enrol(student: string, s: Structure): Promise<void> {
  await adminQuery(
    `INSERT INTO app.student_programs
       (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, DATE '2024-08-01', 'ACTIVE')`,
    [uuidv7(), T.orgId, student, s.program, s.cohort, s.campus, s.dept],
  );
}

beforeAll(async () => {
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkStructure(T.campusId, T.departmentId);
  sibling = await mkStructure(T.campusId);
  other = await mkStructure(await mkCampus());
  extraUsers.deptAdmin = await mkUser({
    code: 'DEPARTMENT_ADMIN',
    scope: 'DEPARTMENT',
    id: T.departmentId,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    for (const t of ['student_programs', 'cohorts', 'programs', 'period_types']) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
  } finally {
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

// ---- helpers ----------------------------------------------------------------------------------------------------
let gseq = 0;
let kseq = 0;
const newKey = (): string => `k${RUN}${(kseq++).toString(36).padStart(12, '0')}`;
const fresh = (): Record<string, unknown> => {
  const n = gseq++;
  return {
    fullName: `Guardian ${RUN} ${n}`,
    phone: `+9190${RUN.replace(/[a-f]/g, '1')}${String(n).padStart(4, '0')}`,
    relation: 'Mother',
    reason: 'Guardian recorded at admission',
  };
};

interface Over {
  key?: unknown;
  kind?: 'STAFF' | 'STUDENT';
  tenant?: IsolatedTenant;
  meta?: { ip?: string; requestId?: string };
  expected?: ExpectedVersion;
}

async function add(
  user: string,
  student: string,
  input: Record<string, unknown> = {},
  o: Over = {},
) {
  const ctx = ctxFor(user, o.kind ?? 'STAFF', o.tenant ?? T);
  return db.withTenant(ctx, (tx) =>
    StudentGuardianService.add(
      tx,
      ctx,
      student,
      { ...fresh(), ...input } as unknown as AddStudentGuardianInput,
      { idempotencyKey: 'key' in o ? o.key : newKey(), ...(o.meta ? { meta: o.meta } : {}) },
    ),
  );
}
const addId = async (
  user: string,
  student: string,
  input: Record<string, unknown> = {},
  o: Over = {},
): Promise<string> =>
  ((await add(user, student, input, o)).body as { data: { id: string } }).data.id;

const linkRow = async (student: string, guardian: string) =>
  (
    await adminQuery<{
      version: number;
      is_primary: boolean;
      valid_to: string | null;
      valid_from: string;
      can_view_academics: boolean;
      can_receive_notifications: boolean;
      can_give_consent: boolean;
      relation: string;
    }>(
      `SELECT version, is_primary, valid_to::text AS valid_to, valid_from::text AS valid_from,
              can_view_academics, can_receive_notifications, can_give_consent, relation
         FROM app.student_guardians WHERE student_id = $1 AND guardian_id = $2`,
      [student, guardian],
    )
  )[0]!;
const guardianRow = async (id: string) =>
  (
    await adminQuery<{
      full_name: string;
      phone: string;
      email: string | null;
      deleted_at: Date | null;
      version: number;
    }>('SELECT full_name, phone, email, deleted_at, version FROM app.guardians WHERE id = $1', [id])
  )[0];
const linkCount = async (student: string): Promise<number> =>
  Number(
    (
      await adminQuery<{ n: string }>(
        'SELECT count(*) AS n FROM app.student_guardians WHERE student_id = $1',
        [student],
      )
    )[0]!.n,
  );
const guardianCountByPhone = async (phone: string): Promise<number> =>
  Number(
    (
      await adminQuery<{ n: string }>(
        'SELECT count(*) AS n FROM app.guardians WHERE organization_id = $1 AND phone = $2',
        [T.orgId, phone],
      )
    )[0]!.n,
  );

async function upd(
  user: string,
  student: string,
  guardian: string,
  patch: Record<string, unknown>,
  o: Over = {},
) {
  const ctx = ctxFor(user, o.kind ?? 'STAFF', o.tenant ?? T);
  const expected: ExpectedVersion = o.expected ?? {
    type: 'version',
    version: (await linkRow(student, guardian)).version,
  };
  return db.withTenant(ctx, (tx) =>
    StudentGuardianService.update(
      tx,
      ctx,
      student,
      guardian,
      { reason: 'Contact details corrected', ...patch },
      { expected, ...(o.meta ? { meta: o.meta } : {}) },
    ),
  );
}
async function rem(
  user: string,
  student: string,
  guardian: string,
  o: Over & { reason?: unknown } = {},
) {
  const ctx = ctxFor(user, o.kind ?? 'STAFF', o.tenant ?? T);
  const expected: ExpectedVersion = o.expected ?? {
    type: 'version',
    version: (await linkRow(student, guardian)).version,
  };
  return db.withTenant(ctx, (tx) =>
    StudentGuardianService.remove(
      tx,
      ctx,
      student,
      guardian,
      { reason: 'reason' in o ? o.reason : 'Guardian no longer responsible' },
      { expected, ...(o.meta ? { meta: o.meta } : {}) },
    ),
  );
}
const list = (user: string, student: string, kind: 'STAFF' | 'STUDENT' = 'STAFF', tenant = T) => {
  const ctx = ctxFor(user, kind, tenant);
  return db.withTenant(ctx, (tx) => StudentGuardianService.list(tx, ctx, student));
};

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected the call to be refused');
}
const refused = async (p: Promise<unknown>, status: number, errCode?: string): Promise<void> => {
  const e = await failure(p);
  expect(e.statusCode).toBe(status);
  if (errCode) expect(e.code).toBe(errCode);
};
const settle = (p: Promise<unknown>): Promise<number> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : -1),
  );

const audits = (student: string) =>
  adminQuery<{
    action: string;
    resource_type: string;
    resource_id: string;
    risk_tier: number;
    reason_text: string | null;
    actor_user_id: string;
    campus_id: string | null;
    department_id: string | null;
    changes: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    ip: string | null;
  }>(
    `SELECT action, resource_type, resource_id, risk_tier, reason_text, actor_user_id, campus_id, department_id,
            changes, metadata, host(ip) AS ip
       FROM app.audit_events WHERE subject_student_id = $1 AND action LIKE 'student_guardian.%'
      ORDER BY occurred_at, id`,
    [student],
  );
// The calendar date AT A CAMPUS: the service's convention (`now() AT TIME ZONE` the campus's IANA zone). Never the
// database session's CURRENT_DATE, which is the server's (UTC in CI) and differs from the campus date for hours every day.
const campusToday = async (campus: string): Promise<string> =>
  (
    await adminQuery<{ d: string }>(
      'SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM app.campuses WHERE id = $1',
      [campus],
    )
  )[0]!.d;

// ---- add ------------------------------------------------------------------------------------------------------------
describe('add: a guardian and its link, created together', () => {
  it('creates the guardian and the link with safe defaults, and the list shows exactly the reviewed fields', async () => {
    const student = await mkStudent();
    const id = await addId(T.users.admin, student, {
      fullName: '  Asha Verma  ',
      phone: '+91 98765 43210',
      email: 'Asha.Verma@Example.TEST',
      relation: 'Mother',
    });
    const g = await guardianRow(id);
    expect(g).toMatchObject({
      full_name: 'Asha Verma',
      phone: '+91 98765 43210',
      email: 'asha.verma@example.test',
      deleted_at: null,
      version: 1,
    });
    const l = await linkRow(student, id);
    expect(l).toMatchObject({
      version: 1,
      is_primary: false,
      valid_to: null,
      can_view_academics: false,
      can_receive_notifications: false,
      can_give_consent: false,
      relation: 'Mother',
    });
    // contact data is stored ONCE: the link row carries none (CHECK student_guardians_no_copied_contact_ck)
    const raw = await adminQuery<{
      full_name: string | null;
      phone: string | null;
      email: string | null;
    }>(
      'SELECT full_name, phone, email FROM app.student_guardians WHERE student_id = $1 AND guardian_id = $2',
      [student, id],
    );
    expect(raw[0]).toEqual({ full_name: null, phone: null, email: null });

    const rows = await list(T.users.admin, student);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'canGiveConsent',
        'canReceiveNotifications',
        'canViewAcademics',
        'createdAt',
        'email',
        'fullName',
        'id',
        'isPrimary',
        'phone',
        'relation',
        'studentId',
        'updatedAt',
        'validFrom',
        'version',
      ].sort(),
    );
    expect(rows[0]).toMatchObject({ id, studentId: student, fullName: 'Asha Verma', version: 1 });
  });

  it('records the three ADR-020 flags and the primary marker when asked', async () => {
    const student = await mkStudent();
    const id = await addId(T.users.admin, student, {
      isPrimary: true,
      canViewAcademics: true,
      canReceiveNotifications: true,
      canGiveConsent: true,
    });
    expect(await linkRow(student, id)).toMatchObject({
      is_primary: true,
      can_view_academics: true,
      can_receive_notifications: true,
      can_give_consent: true,
    });
  });

  it('audits exactly one tier-2 event in the same transaction, with the reason, placement and request facts, and NO contact data', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const input = fresh();
    const emailValue = `pii.${RUN}@example.test`;
    const id = await addId(
      T.users.admin,
      student,
      { ...input, email: emailValue, canViewAcademics: true },
      { meta: { ip: '203.0.113.9', requestId: uuidv7() } },
    );
    const events = await audits(student);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      action: 'student_guardian.add',
      resource_type: 'student_guardian',
      resource_id: id,
      risk_tier: 2,
      reason_text: input.reason,
      actor_user_id: T.users.admin,
      campus_id: main.campus,
      department_id: main.dept,
      ip: '203.0.113.9',
    });
    expect(Object.keys(e.changes ?? {}).sort()).toEqual([
      'canGiveConsent',
      'canReceiveNotifications',
      'canViewAcademics',
      'isPrimary',
      'relation',
    ]);
    expect(e.changes).toMatchObject({ canViewAcademics: { old: null, new: true } });
    const text = JSON.stringify(e);
    for (const secret of [input.fullName, input.phone, emailValue]) {
      expect(text).not.toContain(secret);
    }
  });

  it('rejects malformed input with 400 and writes nothing', async () => {
    const student = await mkStudent();
    const bad: Record<string, unknown>[] = [
      { fullName: '   ' },
      { fullName: 'x'.repeat(201) },
      { fullName: 'Tab\tName' },
      { fullName: undefined },
      { phone: '123' },
      { phone: 'abcdefgh' },
      { phone: '+91 98765 43210 98765 43210 98765' }, // 33 characters
      { phone: undefined },
      { email: 'not-an-email' },
      { email: '' },
      { relation: '' },
      { relation: '1Mother' },
      { relation: 'Mother; DROP TABLE' },
      { relation: undefined },
      { isPrimary: 'yes' },
      { canViewAcademics: 1 },
      { canReceiveNotifications: 'true' },
      { canGiveConsent: null },
      { reason: undefined },
      { reason: 'abc' },
      { organizationId: T.orgId },
      { userId: uuidv7() },
      { validFrom: '2020-01-01' },
      { isMinor: true },
    ];
    for (const input of bad) {
      await refused(add(T.users.admin, student, input), 400, 'VALIDATION_ERROR');
    }
    await refused(add(T.users.admin, 'not-a-uuid'), 400, 'VALIDATION_ERROR');
    expect(await linkCount(student)).toBe(0);
  });

  it('only one primary guardian per student: the second is 409 and nothing of it (guardian included) is stored', async () => {
    const student = await mkStudent();
    await addId(T.users.admin, student, { isPrimary: true });
    const second = fresh();
    await refused(
      add(T.users.admin, student, { ...second, isPrimary: true }),
      409,
      'STUDENT_GUARDIAN_PRIMARY_EXISTS',
    );
    expect(await linkCount(student)).toBe(1);
    expect(await guardianCountByPhone(String(second.phone))).toBe(0);
    expect(await audits(student)).toHaveLength(1);
  });

  it(`at most ${MAX_ACTIVE_GUARDIANS} active guardians: the next is 409 until one is removed`, async () => {
    const student = await mkStudent();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_GUARDIANS; i++) ids.push(await addId(T.users.admin, student));
    await refused(add(T.users.admin, student), 409, 'STUDENT_GUARDIAN_LIMIT_REACHED');
    expect(await linkCount(student)).toBe(MAX_ACTIVE_GUARDIANS);
    await rem(T.users.admin, student, ids[0]!);
    await addId(T.users.admin, student);
    expect((await list(T.users.admin, student)).length).toBe(MAX_ACTIVE_GUARDIANS);
  });
});

describe('add: idempotency', () => {
  it('Idempotency-Key is required (428) and must be well formed (400), only for an authorized caller', async () => {
    const student = await mkStudent();
    await refused(add(T.users.admin, student, {}, { key: undefined }), 428);
    await refused(add(T.users.admin, student, {}, { key: 'short' }), 400);
    await refused(add(T.users.admin, student, {}, { key: 'has spaces in it........' }), 400);
    // an unauthorized caller learns nothing about the key: the permission answer comes first
    await refused(add(T.users.faculty, student, {}, { key: undefined }), 403);
    expect(await linkCount(student)).toBe(0);
  });

  it('a retry with the same key and request returns the same guardian without a second write; a different request is 422', async () => {
    const student = await mkStudent();
    const key = newKey();
    const input = fresh();
    const first = await add(T.users.admin, student, input, { key });
    const again = await add(T.users.admin, student, input, { key });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.body).toEqual(first.body);
    expect(await linkCount(student)).toBe(1);
    expect(await audits(student)).toHaveLength(1);
    await refused(add(T.users.admin, student, { ...input, phone: '+919999900001' }, { key }), 422);
    expect(await linkCount(student)).toBe(1);
  });

  it('scope comes before the key: an out-of-scope caller gets 404 (never 428/400), and a replay cannot outlive the scope', async () => {
    const inScope = await mkStudent();
    await enrol(inScope, main);
    const outOfScope = await mkStudent();
    await enrol(outOfScope, sibling);
    await refused(add(extraUsers.deptAdmin!, outOfScope, {}, { key: undefined }), 404);
    await refused(add(extraUsers.deptAdmin!, outOfScope, {}, { key: 'short' }), 404);

    const key = newKey();
    const input = fresh();
    const first = await add(extraUsers.deptAdmin!, inScope, input, { key });
    expect(first.replayed).toBe(false);
    // the student leaves the department: the same principal, key and request must now be refused, not replayed
    await adminQuery(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = DATE '2025-06-30'
        WHERE student_id = $1 AND status = 'ACTIVE'`,
      [inScope],
    );
    await refused(add(extraUsers.deptAdmin!, inScope, input, { key }), 404);
    expect(await linkCount(inScope)).toBe(1);
  });

  it('the cached response holds only the new id, never contact data', async () => {
    const student = await mkStudent();
    const key = newKey();
    const input = fresh();
    const r = await add(T.users.admin, student, input, { key });
    const stored = await adminQuery<{ response_body: unknown }>(
      'SELECT response_body FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2',
      [T.orgId, key],
    );
    expect(stored[0]!.response_body).toEqual(r.body);
    const text = JSON.stringify(stored[0]!.response_body);
    expect(text).not.toContain(String(input.fullName));
    expect(text).not.toContain(String(input.phone));
  });
});

// ---- list -----------------------------------------------------------------------------------------------------------
describe('list', () => {
  it('shows primary first, then oldest first; ended and soft-deleted guardians never appear', async () => {
    const student = await mkStudent();
    const a = await addId(T.users.admin, student);
    const b = await addId(T.users.admin, student, { isPrimary: true });
    const c = await addId(T.users.admin, student);
    expect((await list(T.users.admin, student)).map((g) => g.id)).toEqual([b, a, c]);
    await rem(T.users.admin, student, a);
    expect((await list(T.users.admin, student)).map((g) => g.id)).toEqual([b, c]);
    // a soft-deleted guardian is hidden even if (against the rules) a link were still open
    await adminQuery('UPDATE app.guardians SET deleted_at = now() WHERE id = $1', [c]);
    expect((await list(T.users.admin, student)).map((g) => g.id)).toEqual([b]);
  });

  it("another student's guardians never appear, and a read writes no audit event", async () => {
    const s1 = await mkStudent();
    const s2 = await mkStudent();
    const g1 = await addId(T.users.admin, s1);
    const g2 = await addId(T.users.admin, s2);
    const before = (await audits(s1)).length;
    expect((await list(T.users.admin, s1)).map((g) => g.id)).toEqual([g1]);
    expect((await list(T.users.admin, s2)).map((g) => g.id)).toEqual([g2]);
    expect((await audits(s1)).length).toBe(before);
  });

  it('a STUDENT reads only their own guardians (SELF); another student, an unknown id and another tenant are the same 404', async () => {
    const mine = await addId(T.users.admin, T.students.one, { relation: 'Father' });
    const theirs = await addId(T.users.admin, T.students.two);
    const own = await list(T.users.studentOne, T.students.one, 'STUDENT');
    expect(own.map((g) => g.id)).toContain(mine);
    expect(own.map((g) => g.id)).not.toContain(theirs);
    const e1 = await failure(list(T.users.studentOne, T.students.two, 'STUDENT'));
    const e2 = await failure(list(T.users.studentOne, uuidv7(), 'STUDENT'));
    expect(e1.statusCode).toBe(404);
    expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
    await refused(list(OTHER.users.admin, T.students.one, 'STAFF', OTHER), 404);
    await rem(T.users.admin, T.students.one, mine); // keep the shared students tidy for later tests
    await rem(T.users.admin, T.students.two, theirs);
  });

  it('a role without student.guardian.read (FACULTY) is 403, whatever the student', async () => {
    const student = await mkStudent();
    await refused(list(T.users.faculty, student), 403);
    await refused(list(T.users.faculty, uuidv7()), 403);
  });

  it('scoped readers: a department HOD reads a student enrolled in the department; every other student, placed elsewhere or UNPLACED, is 404', async () => {
    const inDept = await mkStudent();
    await enrol(inDept, main);
    const inSibling = await mkStudent();
    await enrol(inSibling, sibling);
    const unplaced = await mkStudent();
    await addId(T.users.admin, inDept);
    await addId(T.users.admin, inSibling);
    await addId(T.users.admin, unplaced);
    expect(await list(T.users.hod, inDept)).toHaveLength(1);
    await refused(list(T.users.hod, inSibling), 404);
    await refused(list(T.users.hod, unplaced), 404);
    // the organization-wide administrator reaches all three
    for (const s of [inDept, inSibling, unplaced]) {
      expect(await list(T.users.admin, s)).toHaveLength(1);
    }
  });
});

// ---- manage authorization -------------------------------------------------------------------------------------------
describe('authorization and scope for add, update and remove (nothing is written on a refusal)', () => {
  it('a STUDENT actor, including the student themself, is 403 for every write', async () => {
    const student = T.students.one;
    const g = await addId(T.users.admin, student);
    const before = await linkRow(student, g);
    await refused(add(T.users.studentOne, student, {}, { kind: 'STUDENT' }), 403);
    await refused(
      upd(T.users.studentOne, student, g, { canGiveConsent: true }, { kind: 'STUDENT' }),
      403,
    );
    await refused(rem(T.users.studentOne, student, g, { kind: 'STUDENT' }), 403);
    expect(await linkRow(student, g)).toEqual(before);
    await rem(T.users.admin, student, g);
  });

  it('roles without student.guardian.manage (HOD, FACULTY) are 403', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const g = await addId(T.users.admin, student);
    for (const user of [T.users.hod, T.users.faculty]) {
      await refused(add(user, student), 403);
      await refused(upd(user, student, g, { relation: 'Aunt' }), 403);
      await refused(rem(user, student, g), 403);
    }
    expect(await linkCount(student)).toBe(1);
    expect((await linkRow(student, g)).valid_to).toBeNull();
  });

  it('a department-scoped administrator manages students enrolled in the department only; others, and UNPLACED students, are 404', async () => {
    const mine = await mkStudent();
    await enrol(mine, main);
    const sib = await mkStudent();
    await enrol(sib, sibling);
    const unplaced = await mkStudent();
    await addId(extraUsers.deptAdmin!, mine);
    await refused(add(extraUsers.deptAdmin!, sib), 404);
    await refused(add(extraUsers.deptAdmin!, unplaced), 404);
    const g = await addId(T.users.admin, sib);
    await refused(upd(extraUsers.deptAdmin!, sib, g, { relation: 'Aunt' }), 404);
    await refused(rem(extraUsers.deptAdmin!, sib, g), 404);
    expect(await linkCount(sib)).toBe(1);
    expect(await linkCount(unplaced)).toBe(0);
  });

  it('a campus-scoped actor (CAMPUS_ADMIN, campus REGISTRAR) manages students of their campus, any department; ANOTHER campus is 404', async () => {
    for (const user of [T.users.campusAdmin, T.users.registrarCampus]) {
      for (const s of [main, sibling]) {
        const student = await mkStudent();
        await enrol(student, s);
        await addId(user, student);
      }
      const away = await mkStudent();
      await enrol(away, other);
      await refused(add(user, away), 404);
      expect(await linkCount(away)).toBe(0);
    }
  });

  it('the organization-wide administrator and registrar reach any student of the tenant, placed or not', async () => {
    const student = await mkStudent();
    await addId(T.users.admin, student);
    await addId(T.users.registrarOrg, student);
    expect(await linkCount(student)).toBe(2);
  });

  it("another tenant's administrator gets 404 for a student, a guardian and an unknown id alike, and writes nothing", async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const before = await linkRow(student, g);
    const e1 = await failure(add(OTHER.users.admin, student, {}, { tenant: OTHER }));
    const e2 = await failure(add(OTHER.users.admin, uuidv7(), {}, { tenant: OTHER }));
    expect([e1.statusCode, e1.code, e1.message]).toEqual([e2.statusCode, e2.code, e2.message]);
    await refused(
      upd(
        OTHER.users.admin,
        student,
        g,
        { relation: 'Aunt' },
        { tenant: OTHER, expected: { type: 'version', version: before.version } },
      ),
      404,
    );
    await refused(
      rem(OTHER.users.admin, student, g, {
        tenant: OTHER,
        expected: { type: 'version', version: before.version },
      }),
      404,
    );
    expect(await linkRow(student, g)).toEqual(before);
  });

  it("a guardian addressed through the WRONG student is 404 (the path's student must own the link)", async () => {
    const s1 = await mkStudent();
    const s2 = await mkStudent();
    const g = await addId(T.users.admin, s1);
    const v = (await linkRow(s1, g)).version;
    const expected: ExpectedVersion = { type: 'version', version: v };
    await refused(upd(T.users.admin, s2, g, { relation: 'Aunt' }, { expected }), 404);
    await refused(rem(T.users.admin, s2, g, { expected }), 404);
    expect((await linkRow(s1, g)).version).toBe(v);
  });
});

// ---- update ---------------------------------------------------------------------------------------------------------
describe('update', () => {
  it('changes contact data and the link attributes; the version is the link version and bumps once per change', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student, { email: 'old@example.test' });
    const r = await upd(T.users.admin, student, g, {
      fullName: 'New Name',
      phone: '+91 90000 00000',
      email: null,
      relation: 'Guardian',
      canViewAcademics: true,
      canReceiveNotifications: true,
      canGiveConsent: true,
    });
    expect(r).toMatchObject({
      id: g,
      fullName: 'New Name',
      phone: '+91 90000 00000',
      email: null,
      relation: 'Guardian',
      canViewAcademics: true,
      canReceiveNotifications: true,
      canGiveConsent: true,
      version: 2,
    });
    expect((await guardianRow(g))!.version).toBe(2);
    expect((await linkRow(student, g)).version).toBe(2);
  });

  it('a contact-only change still bumps the link version (the ETag of the whole resource)', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const r = await upd(T.users.admin, student, g, { phone: '+91 91111 11111' });
    expect(r.version).toBe(2);
    expect((await linkRow(student, g)).version).toBe(2);
  });

  it('audits field names and non-contact values; contact fields are named as changed, never valued', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    await upd(T.users.admin, student, g, {
      fullName: `Renamed ${RUN}`,
      phone: '+91 92222 22222',
      canGiveConsent: true,
    });
    const events = (await audits(student)).filter((e) => e.action === 'student_guardian.update');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      risk_tier: 2,
      resource_id: g,
      reason_text: 'Contact details corrected',
    });
    expect(events[0]!.changes).toEqual({
      canGiveConsent: { old: false, new: true },
      fullName: { changed: true },
      phone: { changed: true },
    });
    const text = JSON.stringify(events[0]);
    expect(text).not.toContain(`Renamed ${RUN}`);
    expect(text).not.toContain('92222');
  });

  it('If-Match must carry the exact version: other expectations are 400; a stale version is 409; nothing changes', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const before = await linkRow(student, g);
    for (const expected of [
      { type: 'exists' } as const,
      { type: 'initial' } as const,
    ] as ExpectedVersion[]) {
      await refused(upd(T.users.admin, student, g, { relation: 'Aunt' }, { expected }), 400);
    }
    await refused(
      upd(
        T.users.admin,
        student,
        g,
        { relation: 'Aunt' },
        { expected: { type: 'version', version: before.version + 3 } },
      ),
      409,
      'CONFLICT',
    );
    expect(await linkRow(student, g)).toEqual(before);
  });

  it('an empty change (every value equals the stored one) is answered without a write, a version bump or an audit event', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student, { relation: 'Mother', canViewAcademics: true });
    const before = await linkRow(student, g);
    const events = (await audits(student)).length;
    const r = await upd(T.users.admin, student, g, { relation: 'Mother', canViewAcademics: true });
    expect(r.version).toBe(before.version);
    expect(await linkRow(student, g)).toEqual(before);
    expect((await audits(student)).length).toBe(events);
  });

  it('a request that names no field to change is 400; unknown fields are 400', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    await refused(upd(T.users.admin, student, g, {}), 400, 'VALIDATION_ERROR');
    await refused(
      upd(T.users.admin, student, g, { organizationId: T.orgId }),
      400,
      'VALIDATION_ERROR',
    );
    await refused(
      upd(T.users.admin, student, g, { validTo: '2030-01-01' }),
      400,
      'VALIDATION_ERROR',
    );
    await refused(
      upd(T.users.admin, student, g, { relation: 'Aunt', reason: 'no' }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('promoting a second primary is 409 and changes nothing; demote first, then it works', async () => {
    const student = await mkStudent();
    const a = await addId(T.users.admin, student, { isPrimary: true });
    const b = await addId(T.users.admin, student);
    const beforeB = await linkRow(student, b);
    await refused(
      upd(T.users.admin, student, b, { isPrimary: true }),
      409,
      'STUDENT_GUARDIAN_PRIMARY_EXISTS',
    );
    expect(await linkRow(student, b)).toEqual(beforeB);
    await upd(T.users.admin, student, a, { isPrimary: false });
    await upd(T.users.admin, student, b, { isPrimary: true });
    expect((await linkRow(student, b)).is_primary).toBe(true);
    expect((await linkRow(student, a)).is_primary).toBe(false);
  });

  it('an ended guardian cannot be updated (404, terminal)', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    await rem(T.users.admin, student, g);
    await refused(
      upd(
        T.users.admin,
        student,
        g,
        { relation: 'Aunt' },
        { expected: { type: 'version', version: 2 } },
      ),
      404,
    );
  });
});

// ---- remove ---------------------------------------------------------------------------------------------------------
describe('remove (end-dating, never a delete)', () => {
  it('ends the link today, frees the primary slot, soft-deletes the guardian, keeps both rows and audits once', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const g = await addId(T.users.admin, student, { isPrimary: true });
    const before = await campusToday(main.campus);
    await rem(T.users.admin, student, g);
    const after = await campusToday(main.campus);
    const l = await linkRow(student, g);
    // "today" is the enrolment CAMPUS's date. The service reads the clock once, between the two readings, so the stored
    // date is one of them (they differ only if campus-local midnight passed during the call).
    expect([before, after]).toContain(l.valid_to);
    expect(l.is_primary).toBe(false);
    expect((await guardianRow(g))!.deleted_at).not.toBeNull();
    expect(await list(T.users.admin, student)).toEqual([]);
    const events = (await audits(student)).filter((e) => e.action === 'student_guardian.remove');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      risk_tier: 2,
      resource_id: g,
      campus_id: main.campus,
      department_id: main.dept,
      reason_text: 'Guardian no longer responsible',
    });
    expect(events[0]!.changes).toEqual({
      validTo: { old: null, new: l.valid_to },
      isPrimary: { old: true, new: false },
    });
  });

  it('the primary slot can be reused after the primary guardian is removed', async () => {
    const student = await mkStudent();
    const a = await addId(T.users.admin, student, { isPrimary: true });
    await rem(T.users.admin, student, a);
    const b = await addId(T.users.admin, student, { isPrimary: true });
    expect((await linkRow(student, b)).is_primary).toBe(true);
  });

  it('needs the exact version (400 otherwise, 409 when stale) and a reason; a second remove is 404', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const v = (await linkRow(student, g)).version;
    await refused(rem(T.users.admin, student, g, { expected: { type: 'exists' } }), 400);
    await refused(
      rem(T.users.admin, student, g, { expected: { type: 'version', version: v + 1 } }),
      409,
      'CONFLICT',
    );
    await refused(rem(T.users.admin, student, g, { reason: 'abc' }), 400);
    await refused(rem(T.users.admin, student, g, { reason: undefined }), 400);
    expect((await linkRow(student, g)).valid_to).toBeNull();
    await rem(T.users.admin, student, g);
    await refused(
      rem(T.users.admin, student, g, { expected: { type: 'version', version: v } }),
      404,
    );
  });
});

// ---- atomicity ------------------------------------------------------------------------------------------------------
describe('atomicity: a failed audit write leaves no change', () => {
  const bad = { requestId: 'not-a-uuid' }; // recordAudit refuses it AFTER the business write

  it('add: no guardian, no link, and the idempotency key is not consumed', async () => {
    const student = await mkStudent();
    const key = newKey();
    const input = fresh();
    await refused(add(T.users.admin, student, input, { key, meta: bad }), 500, 'AUDIT_INVALID');
    expect(await linkCount(student)).toBe(0);
    expect(await guardianCountByPhone(String(input.phone))).toBe(0);
    const keys = await adminQuery(
      'SELECT 1 FROM app.idempotency_keys WHERE organization_id = $1 AND key = $2',
      [T.orgId, key],
    );
    expect(keys).toHaveLength(0);
    // the same key then works
    await add(T.users.admin, student, input, { key });
    expect(await linkCount(student)).toBe(1);
  });

  it('update and remove: contact data, link and soft-delete marker are all unchanged', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const gBefore = await guardianRow(g);
    const lBefore = await linkRow(student, g);
    await refused(
      upd(
        T.users.admin,
        student,
        g,
        { fullName: 'Other Name', canGiveConsent: true },
        { meta: bad },
      ),
      500,
      'AUDIT_INVALID',
    );
    await refused(rem(T.users.admin, student, g, { meta: bad }), 500, 'AUDIT_INVALID');
    expect(await guardianRow(g)).toEqual(gBefore);
    expect(await linkRow(student, g)).toEqual(lBefore);
  });
});

// ---- concurrency ----------------------------------------------------------------------------------------------------
describe('concurrency (real concurrent transactions)', () => {
  it('two simultaneous primary guardians: exactly one wins, one 409, one primary row', async () => {
    for (let round = 0; round < 3; round++) {
      const student = await mkStudent();
      const results = await Promise.all([
        settle(add(T.users.admin, student, { isPrimary: true })),
        settle(add(T.users.registrarOrg, student, { isPrimary: true })),
      ]);
      expect([...results].sort()).toEqual([200, 409]);
      const primaries = await adminQuery(
        'SELECT 1 FROM app.student_guardians WHERE student_id = $1 AND is_primary',
        [student],
      );
      expect(primaries).toHaveLength(1);
      expect(await linkCount(student)).toBe(1);
    }
  });

  it('simultaneous adds at the cap: only as many as fit succeed, the active count never exceeds the cap', async () => {
    const student = await mkStudent();
    for (let i = 0; i < MAX_ACTIVE_GUARDIANS - 1; i++) await addId(T.users.admin, student);
    const results = await Promise.all([0, 1, 2, 3].map(() => settle(add(T.users.admin, student))));
    expect(results.filter((r) => r === 200)).toHaveLength(1);
    expect(results.filter((r) => r === 409)).toHaveLength(3);
    expect(await linkCount(student)).toBe(MAX_ACTIVE_GUARDIANS);
  });

  it('two simultaneous updates from the same version: one wins, one 409, one audit event', async () => {
    for (let round = 0; round < 3; round++) {
      const student = await mkStudent();
      const g = await addId(T.users.admin, student);
      const expected: ExpectedVersion = { type: 'version', version: 1 };
      const results = await Promise.all([
        settle(upd(T.users.admin, student, g, { relation: 'Aunt' }, { expected })),
        settle(upd(T.users.registrarOrg, student, g, { relation: 'Uncle' }, { expected })),
      ]);
      expect([...results].sort()).toEqual([200, 409]);
      expect((await linkRow(student, g)).version).toBe(2);
      expect(
        (await audits(student)).filter((e) => e.action === 'student_guardian.update'),
      ).toHaveLength(1);
    }
  });

  it('an update racing a remove from the same version: one wins, the other is refused, never both', async () => {
    for (let round = 0; round < 3; round++) {
      const student = await mkStudent();
      const g = await addId(T.users.admin, student);
      const expected: ExpectedVersion = { type: 'version', version: 1 };
      const results = await Promise.all([
        settle(upd(T.users.admin, student, g, { relation: 'Aunt' }, { expected })),
        settle(rem(T.users.registrarOrg, student, g, { expected })),
      ]);
      expect(results.filter((r) => r === 200)).toHaveLength(1);
      expect(results.filter((r) => r !== 200).every((r) => r === 409 || r === 404)).toBe(true);
      const l = await linkRow(student, g);
      // exactly one of the two effects exists
      expect(l.valid_to !== null || l.relation === 'Aunt').toBe(true);
      expect(l.valid_to !== null && l.relation === 'Aunt').toBe(false);
    }
  });
});

// ---- legacy rows (pre-0027, guardian_id NULL) -----------------------------------------------------------------------
describe('legacy student_guardians rows never block, count against or leak into the guardian API', () => {
  async function legacyRow(student: string, primary = false): Promise<string> {
    const id = uuidv7();
    await adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation, is_primary)
       VALUES ($1, $2, $3, 'Legacy Contact', '+910000000777', 'Aunt', $4)`,
      [id, T.orgId, student, primary],
    );
    return id;
  }
  const legacyState = async (id: string) =>
    (
      await adminQuery<{
        is_primary: boolean;
        version: number;
        guardian_id: string | null;
        full_name: string | null;
      }>(
        'SELECT is_primary, version, guardian_id, full_name FROM app.student_guardians WHERE id = $1',
        [id],
      )
    )[0];

  it('a legacy PRIMARY row does not stop the student from getting a primary guardian, and is left exactly as it was', async () => {
    const student = await mkStudent();
    const legacy = await legacyRow(student, true);
    const before = await legacyState(legacy);
    const g = await addId(T.users.admin, student, { isPrimary: true });
    expect((await linkRow(student, g)).is_primary).toBe(true);
    expect(await legacyState(legacy)).toEqual(before); // not deleted, not demoted, not touched
    expect(before).toEqual({
      is_primary: true,
      version: 1,
      guardian_id: null,
      full_name: 'Legacy Contact',
    });
    // the new-shape rule is unchanged: a second NEW primary is still refused
    await refused(
      add(T.users.admin, student, { isPrimary: true }),
      409,
      'STUDENT_GUARDIAN_PRIMARY_EXISTS',
    );
    // the primary slot is manageable: demote, promote another, end the primary; the legacy row stays put throughout
    const h = await addId(T.users.admin, student);
    await upd(T.users.admin, student, g, { isPrimary: false });
    await upd(T.users.admin, student, h, { isPrimary: true });
    await rem(T.users.admin, student, h);
    await addId(T.users.admin, student, { isPrimary: true });
    expect(await legacyState(legacy)).toEqual(before);
  });

  it('legacy rows are invisible: not listed, and addressing one as a guardian is 404 for update and remove', async () => {
    const student = await mkStudent();
    const legacy = await legacyRow(student, true);
    const g = await addId(T.users.admin, student);
    expect((await list(T.users.admin, student)).map((x) => x.id)).toEqual([g]);
    const before = await legacyState(legacy);
    const expected: ExpectedVersion = { type: 'version', version: 1 };
    await refused(upd(T.users.admin, student, legacy, { relation: 'Aunt' }, { expected }), 404);
    await refused(rem(T.users.admin, student, legacy, { expected }), 404);
    expect(await legacyState(legacy)).toEqual(before);
  });

  it(`legacy rows do not consume the ${MAX_ACTIVE_GUARDIANS}-guardian cap`, async () => {
    const student = await mkStudent();
    for (let i = 0; i < MAX_ACTIVE_GUARDIANS; i++) await legacyRow(student);
    for (let i = 0; i < MAX_ACTIVE_GUARDIANS; i++) await addId(T.users.admin, student);
    await refused(add(T.users.admin, student), 409, 'STUDENT_GUARDIAN_LIMIT_REACHED');
    expect((await list(T.users.admin, student)).length).toBe(MAX_ACTIVE_GUARDIANS);
  });
});

// ---- campus-local dates ---------------------------------------------------------------------------------------------
describe('guardian dates follow the campus-local calendar, like enrolments', () => {
  async function campusAt(tz: string): Promise<Structure> {
    const id = uuidv7();
    await adminQuery(
      `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Tz campus', $3, $4)`,
      [id, T.orgId, code('Z'), tz],
    );
    return mkStructure(id);
  }
  const localToday = async (tz: string): Promise<string> =>
    (await adminQuery<{ d: string }>('SELECT (now() AT TIME ZONE $1)::date::text AS d', [tz]))[0]!
      .d;
  const utcToday = (): Promise<string> => localToday('UTC');

  it('valid_from and valid_to are the date of the ENROLMENT campus, not of the database session', async () => {
    const east = await campusAt('Pacific/Kiritimati'); // UTC+14
    const west = await campusAt('Pacific/Pago_Pago'); // UTC-11
    const result: Record<string, { from: string; to: string }> = {};
    for (const [name, s, tz] of [
      ['east', east, 'Pacific/Kiritimati'],
      ['west', west, 'Pacific/Pago_Pago'],
    ] as const) {
      const student = await mkStudent();
      await enrol(student, s);
      const g = await addId(T.users.admin, student);
      const expectedBefore = await localToday(tz);
      const l = await linkRow(student, g);
      await rem(T.users.admin, student, g);
      const ended = await linkRow(student, g);
      const expectedAfter = await localToday(tz);
      expect([expectedBefore, expectedAfter]).toContain(l.valid_from);
      expect([expectedBefore, expectedAfter]).toContain(ended.valid_to);
      result[name] = { from: l.valid_from, to: ended.valid_to! };
    }
    // the two campuses are 25 hours apart: their calendar dates can never be equal, so one date cannot serve both
    expect(result.east!.from).not.toBe(result.west!.from);
    expect(result.east!.to).not.toBe(result.west!.to);
  });

  it('a student with NO active enrolment has no campus: the date is the UTC date, explicitly', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const l = await linkRow(student, g);
    expect([await utcToday()]).toContain(l.valid_from);
    await rem(T.users.admin, student, g);
    expect((await linkRow(student, g)).valid_to).toBe(l.valid_from);
  });

  it('an end date is never earlier than the start date (a start in the "future" of the fallback date)', async () => {
    const student = await mkStudent(); // unplaced: the end date falls back to the UTC date
    const g = uuidv7();
    await adminQuery(
      `INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, 'Ahead', '+910000000555')`,
      [g, T.orgId],
    );
    await adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, valid_from)
       VALUES ($1, $2, $3, $4, 'Mother', (now() AT TIME ZONE 'UTC')::date + 1)`,
      [uuidv7(), T.orgId, student, g],
    );
    const before = await linkRow(student, g);
    await rem(T.users.admin, student, g);
    expect((await linkRow(student, g)).valid_to).toBe(before.valid_from);
  });
});

// ---- scope proof vs a concurrent enrolment close ---------------------------------------------------------------------
describe('the scope proof cannot rely on a placement that a concurrent close is changing', () => {
  async function closeHolding(student: string): Promise<{ commit: () => Promise<void> }> {
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    await c.query('BEGIN');
    await c.query(
      `UPDATE app.student_programs SET status = 'COMPLETED', end_date = DATE '2025-06-30'
        WHERE student_id = $1 AND status = 'ACTIVE'`,
      [student],
    );
    return {
      commit: async () => {
        await c.query('COMMIT');
        await c.end();
      },
    };
  }
  /** True when a guardian transaction is blocked on the enrolment row; false if it finished without waiting. */
  async function waitsOnEnrolment(done: () => boolean): Promise<boolean> {
    for (let i = 0; i < 100; i++) {
      if (done()) return false;
      const rows = await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM app.student_programs%'`,
      );
      if (Number(rows[0]!.n) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it('a campus-scoped add waits for the close, then sees the student unplaced: 404 and nothing written', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const close = await closeHolding(student); // the close has changed the enrolment but not committed yet
    let settled = false;
    const attempt = settle(add(T.users.campusAdmin, student)).finally(() => (settled = true));
    const waited = await waitsOnEnrolment(() => settled);
    await close.commit();
    expect(await attempt).toBe(404);
    expect(waited, 'the guardian write must wait for the enrolment row').toBe(true);
    expect(await linkCount(student)).toBe(0);
    expect(await audits(student)).toEqual([]);
  });

  it('the same holds for remove: a campus-scoped caller cannot end a guardian after the student left their scope', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const g = await addId(T.users.admin, student);
    const expected: ExpectedVersion = { type: 'version', version: 1 };
    const close = await closeHolding(student);
    let settled = false;
    const attempt = settle(rem(T.users.campusAdmin, student, g, { expected })).finally(
      () => (settled = true),
    );
    const waited = await waitsOnEnrolment(() => settled);
    await close.commit();
    expect(await attempt).toBe(404);
    expect(waited).toBe(true);
    expect((await linkRow(student, g)).valid_to).toBeNull();
  });
});

// ---- HTTP -----------------------------------------------------------------------------------------------------------
describe('HTTP: /api/v1/students/:id/guardians', () => {
  const sessions: Record<string, { cookie: string; csrf: string }> = {};
  async function login(email: string) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, email).toBe(200);
    return {
      cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
      csrf: r.json<{ csrf_token: string }>().csrf_token,
    };
  }
  beforeAll(async () => {
    sessions.admin = await login(T.emails.admin);
    sessions.campusAdmin = await login(T.emails.campusAdmin);
    sessions.hod = await login(T.emails.hod);
    sessions.faculty = await login(T.emails.faculty);
    sessions.student = await login(T.emails.studentOne);
  }, 60_000);

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    who: string | null,
    path: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    csrf?: string,
  ) =>
    app.inject({
      method,
      url: path,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      cookies: who ? { session_token: sessions[who]!.cookie } : {},
      headers: {
        origin: APP_ORIGIN,
        ...(who ? { 'x-csrf-token': csrf ?? sessions[who]!.csrf } : {}),
        ...headers,
      },
    });
  const base = (student: string): string => `/api/v1/students/${student}/guardians`;
  const body = (): Record<string, unknown> => fresh();
  const errCode = (r: { json: <X>() => X }): string =>
    r.json<{ error: { code: string } }>().error.code;

  it('401 without a session; 403 without the CSRF token', async () => {
    const student = await mkStudent();
    expect((await call('GET', null, base(student))).statusCode).toBe(401);
    expect(
      (await call('POST', null, base(student), body(), { 'idempotency-key': newKey() })).statusCode,
    ).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: base(student),
      payload: body(),
      cookies: { session_token: sessions.admin!.cookie },
      headers: { origin: APP_ORIGIN, 'idempotency-key': newKey() },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(await linkCount(student)).toBe(0);
  });

  it('POST 201 returns only the id; GET lists it with the reviewed fields; a replay carries Idempotent-Replayed', async () => {
    const student = await mkStudent();
    const key = newKey();
    const payload = body();
    const r = await call('POST', 'admin', base(student), payload, { 'idempotency-key': key });
    expect(r.statusCode).toBe(201);
    const created = r.json<{ success: boolean; data: Record<string, unknown> }>();
    expect(Object.keys(created.data)).toEqual(['id']);
    expect(r.body).not.toContain(String(payload.phone));
    const replay = await call('POST', 'admin', base(student), payload, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(created);
    const g = await call('GET', 'admin', base(student));
    expect(g.statusCode).toBe(200);
    const rows = g.json<{ data: Record<string, unknown>[] }>().data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: created.data.id,
      fullName: payload.fullName,
      phone: payload.phone,
    });
    for (const forbidden of [
      'organizationId',
      'userId',
      'validTo',
      'deletedAt',
      'organization_id',
    ]) {
      expect(rows[0]).not.toHaveProperty(forbidden);
    }
  });

  it('POST without Idempotency-Key is 428; with a malformed one 400', async () => {
    const student = await mkStudent();
    expect((await call('POST', 'admin', base(student), body())).statusCode).toBe(428);
    expect(
      (await call('POST', 'admin', base(student), body(), { 'idempotency-key': 'short' }))
        .statusCode,
    ).toBe(400);
    expect(await linkCount(student)).toBe(0);
  });

  it('body validation: tenant, student, user, date and minor-status fields, unknown fields, bad values and a missing body are 400', async () => {
    const student = await mkStudent();
    const h = (): Record<string, string> => ({ 'idempotency-key': newKey() });
    for (const extra of [
      { organizationId: T.orgId },
      { organization_id: T.orgId },
      { studentId: student },
      { userId: uuidv7() },
      { validFrom: '2020-01-01' },
      { validTo: '2030-01-01' },
      { isMinor: true },
      { isEmergencyContact: true },
      { isLegalGuardian: true },
      { phone: '1' },
      { relation: '' },
      { fullName: '' },
      { isPrimary: 'maybe' },
    ]) {
      const r = await call('POST', 'admin', base(student), { ...body(), ...extra }, h());
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await call('POST', 'admin', base(student), undefined, h())).statusCode).toBe(400);
    expect(await linkCount(student)).toBe(0);
  });

  it('PATCH: If-Match is mandatory (428), weak/garbage is 400, stale is 409, success returns the record and the new strong ETag', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const url = `${base(student)}/${g}`;
    const patch = { relation: 'Aunt', reason: 'Relationship corrected' };
    expect((await call('PATCH', 'admin', url, patch)).statusCode).toBe(428);
    for (const header of ['W/"1"', '*', '"0"', 'null', 'abc', '"1", "2"']) {
      expect(
        (await call('PATCH', 'admin', url, patch, { 'if-match': header })).statusCode,
        header,
      ).toBe(400);
    }
    const stale = await call('PATCH', 'admin', url, patch, { 'if-match': '"9"' });
    expect(stale.statusCode).toBe(409);
    expect(errCode(stale)).toBe('CONFLICT');
    const ok = await call('PATCH', 'admin', url, patch, { 'if-match': '"1"' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"2"');
    expect(ok.json<{ data: Record<string, unknown> }>().data).toMatchObject({
      id: g,
      relation: 'Aunt',
      version: 2,
    });
    // a body carrying only the reason names nothing to change
    expect(
      (await call('PATCH', 'admin', url, { reason: 'Nothing to change' }, { 'if-match': '"2"' }))
        .statusCode,
    ).toBe(400);
  });

  it('DELETE: needs If-Match and a JSON body with a reason; success is 200 and the guardian leaves the list; a second DELETE is 404', async () => {
    const student = await mkStudent();
    const g = await addId(T.users.admin, student);
    const url = `${base(student)}/${g}`;
    expect(
      (await call('DELETE', 'admin', url, { reason: 'Guardian no longer responsible' })).statusCode,
    ).toBe(428);
    expect((await call('DELETE', 'admin', url, undefined, { 'if-match': '"1"' })).statusCode).toBe(
      400,
    );
    expect(
      (await call('DELETE', 'admin', url, { reason: 'abc' }, { 'if-match': '"1"' })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'DELETE',
          'admin',
          url,
          { reason: 'Valid reason', extra: 1 },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(400);
    const ok = await call(
      'DELETE',
      'admin',
      url,
      { reason: 'Guardian no longer responsible' },
      { 'if-match': '"1"' },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ success: true });
    expect((await call('GET', 'admin', base(student))).json<{ data: unknown[] }>().data).toEqual(
      [],
    );
    expect(
      (
        await call(
          'DELETE',
          'admin',
          url,
          { reason: 'Guardian no longer responsible' },
          { 'if-match': '"2"' },
        )
      ).statusCode,
    ).toBe(404);
  });

  it('roles and scope over HTTP: FACULTY 403 on every route; HOD may read in scope but not write; the student reads only their own', async () => {
    const student = await mkStudent();
    await enrol(student, main);
    const g = await addId(T.users.admin, student);
    const url = `${base(student)}/${g}`;
    expect((await call('GET', 'faculty', base(student))).statusCode).toBe(403);
    expect(
      (await call('POST', 'faculty', base(student), body(), { 'idempotency-key': newKey() }))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', 'hod', base(student))).statusCode).toBe(200);
    expect(
      (await call('POST', 'hod', base(student), body(), { 'idempotency-key': newKey() }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'PATCH',
          'hod',
          url,
          { relation: 'Aunt', reason: 'Relationship corrected' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'DELETE',
          'hod',
          url,
          { reason: 'Guardian no longer responsible' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(403);

    const mine = await addId(T.users.admin, T.students.one);
    const own = await call('GET', 'student', base(T.students.one));
    expect(own.statusCode).toBe(200);
    expect(own.json<{ data: { id: string }[] }>().data.map((x) => x.id)).toContain(mine);
    const notMine = await call('GET', 'student', base(T.students.two));
    expect(notMine.statusCode).toBe(404);
    expect((await call('GET', 'student', base(student))).statusCode).toBe(404);
    expect(
      (await call('POST', 'student', base(T.students.one), body(), { 'idempotency-key': newKey() }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'PATCH',
          'student',
          `${base(T.students.one)}/${mine}`,
          { canGiveConsent: true, reason: 'Student change' },
          { 'if-match': '"1"' },
        )
      ).statusCode,
    ).toBe(403);
    await rem(T.users.admin, T.students.one, mine);
  });

  it('a campus-scoped administrator is 404 (not 403) for a student of another campus; a malformed id is 400', async () => {
    const away = await mkStudent();
    await enrol(away, other);
    expect((await call('GET', 'campusAdmin', base(away))).statusCode).toBe(404);
    expect(
      (await call('POST', 'campusAdmin', base(away), body(), { 'idempotency-key': newKey() }))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', 'admin', '/api/v1/students/not-a-uuid/guardians')).statusCode).toBe(
      400,
    );
    expect((await call('GET', 'admin', `${base(uuidv7())}`)).statusCode).toBe(404);
  });

  it('guardian data is served ONLY by this route: the student record, the admission-number lookup and the status response carry none', async () => {
    const student = await mkStudent();
    const input = body();
    await addId(T.users.admin, student, { ...input, email: `leak.${RUN}@example.test` });
    const profile = await call('GET', 'admin', `/api/v1/students/${student}`);
    expect(profile.statusCode).toBe(200);
    const lookup = await call(
      'GET',
      'admin',
      `/api/v1/students?admissionNumber=${
        (
          await adminQuery<{ a: string }>(
            'SELECT admission_number AS a FROM app.students WHERE id = $1',
            [student],
          )
        )[0]!.a
      }`,
    );
    expect(lookup.statusCode).toBe(200);
    for (const res of [profile, lookup]) {
      expect(res.body).not.toContain(String(input.fullName));
      expect(res.body).not.toContain(String(input.phone));
      expect(res.body).not.toContain(`leak.${RUN}`);
      expect(res.body.toLowerCase()).not.toContain('guardian');
    }
  });
});
