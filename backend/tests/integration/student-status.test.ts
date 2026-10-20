import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import {
  ALLOWED_STATUS_TRANSITIONS,
  ENROLMENT_CLOSE_OUTCOME,
  StudentStatusService,
  classifyTransition,
  STATUS_ENROLMENT_NOT_CLOSABLE,
  STATUS_TRANSITION_INVALID,
  STATUS_TRANSITION_UNAVAILABLE,
} from '../../src/modules/students/index.js';
import { StudentProgramService } from '../../src/modules/students/student-program.service.js';
import {
  STUDENT_STATUSES,
  type StudentStatus,
} from '../../src/modules/students/student.schemas.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import type { ExpectedVersion } from '../../src/shared/settings/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery, elevateSession, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// POST /api/v1/students/:id/status (Phase 3b): the service and the HTTP route against the shared disposable integration
// database. Everything commits, so it runs in PRIVATE tenants; every assertion looks at rows these tests created (by id),
// never at tenant-wide counts.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex');
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
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

async function mkCampus(tz = 'Asia/Kolkata'): Promise<string> {
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Test campus', $3, $4)`,
    [id, T.orgId, code('C'), tz],
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
  const email = `ss-${RUN}-${id.slice(-12)}@isolated.test`;
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
async function mkStudent(status: StudentStatus = 'ACTIVE'): Promise<string> {
  const user = await mkUser();
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, DATE '2024-07-01', $5)`,
    [id, T.orgId, user, `SS${RUN}${admissionSeq++}`, status],
  );
  return id;
}
async function enrol(
  student: string,
  s: Structure,
  o: { start?: string; status?: string; end?: string | null } = {},
): Promise<string> {
  const id = uuidv7();
  const status = o.status ?? 'ACTIVE';
  await adminQuery(
    `INSERT INTO app.student_programs
       (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10)`,
    [
      id,
      T.orgId,
      student,
      s.program,
      s.cohort,
      s.campus,
      s.dept,
      o.start ?? '2024-08-01',
      status === 'ACTIVE' ? null : (o.end ?? '2025-06-30'),
      status,
    ],
  );
  return id;
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
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // events are append-only
    for (const t of [
      'student_program_events',
      'student_programs',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

// ---- helpers ----------------------------------------------------------------------------------------------------
interface Over {
  reason?: unknown;
  expected?: ExpectedVersion;
  kind?: 'STAFF' | 'STUDENT';
  tenant?: IsolatedTenant;
  meta?: { ip?: string; requestId?: string };
}
const row = async (student: string) =>
  (
    await adminQuery<{
      status: string;
      version: number;
      status_changed_at: Date;
    }>('SELECT status, version, status_changed_at FROM app.students WHERE id = $1', [student])
  )[0]!;
async function change(user: string, student: string, status: unknown, over: Over = {}) {
  const tenant = over.tenant ?? T;
  const ctx = ctxFor(user, over.kind ?? 'STAFF', tenant);
  const expected: ExpectedVersion = over.expected ?? {
    type: 'version',
    version: (await row(student)).version,
  };
  return db.withTenant(ctx, (tx) =>
    StudentStatusService.change(
      tx,
      ctx,
      student,
      { status, reason: 'reason' in over ? over.reason : 'Status changed after review' },
      { expected, ...(over.meta ? { meta: over.meta } : {}) },
    ),
  );
}
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
const audits = (student: string) =>
  adminQuery<{
    action: string;
    risk_tier: number;
    reason_text: string | null;
    actor_user_id: string;
    campus_id: string | null;
    department_id: string | null;
    changes: Record<string, { old: unknown; new: unknown }> | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT action, risk_tier, reason_text, actor_user_id, campus_id, department_id, changes, metadata
       FROM app.audit_events WHERE subject_student_id = $1 ORDER BY occurred_at, id`,
    [student],
  );
const enrolmentRow = async (id: string) =>
  (
    await adminQuery<{
      status: string;
      end_date: string | null;
      exit_reason: string | null;
      version: number;
    }>(
      `SELECT status, end_date::text AS end_date, exit_reason, version FROM app.student_programs WHERE id = $1`,
      [id],
    )
  )[0]!;
const closedEvents = (enrolment: string) =>
  adminQuery<{ to_status: string; effective_date: string; reason: string; actor_user_id: string }>(
    `SELECT to_status, effective_date::text AS effective_date, reason, actor_user_id
       FROM app.student_program_events WHERE student_program_id = $1 AND event_type = 'CLOSED'`,
    [enrolment],
  );
const campusToday = async (campus: string): Promise<string> =>
  (
    await adminQuery<{ d: string }>(
      `SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM app.campuses WHERE id = $1`,
      [campus],
    )
  )[0]!.d;

/** Nothing about the student, its enrolment or the audit trail moved. */
async function expectUntouched(
  student: string,
  before: { status: string; version: number; status_changed_at: Date },
  enrolment?: string,
) {
  const after = await row(student);
  expect(after.status).toBe(before.status);
  expect(after.version).toBe(before.version);
  expect(after.status_changed_at.getTime()).toBe(before.status_changed_at.getTime());
  expect((await audits(student)).filter((a) => a.action === 'student.status.change')).toEqual([]);
  if (enrolment) {
    expect((await enrolmentRow(enrolment)).status).toBe('ACTIVE');
    expect(await closedEvents(enrolment)).toEqual([]);
    expect((await audits(student)).filter((a) => a.action === 'student_program.close')).toEqual([]);
  }
}

// ---- the eleven allowed transitions and their enrolment effects ---------------------------------------------------
const ALLOWED: [StudentStatus, StudentStatus][] = STUDENT_STATUSES.flatMap((f) =>
  ALLOWED_STATUS_TRANSITIONS[f].map((t): [StudentStatus, StudentStatus] => [f, t]),
);

describe("every allowed transition, with an ACTIVE enrolment in the actor's organization scope", () => {
  it('there are exactly eleven', () => {
    expect(ALLOWED).toHaveLength(11);
  });
  for (const [from, to] of ALLOWED) {
    const outcome = ENROLMENT_CLOSE_OUTCOME[to];
    it(`${from} -> ${to}: ${outcome ? `closes the enrolment as ${outcome}` : 'leaves the enrolment ACTIVE'}`, async () => {
      const student = await mkStudent(from);
      const enrolment = await enrol(student, main);
      const before = await row(student);
      const reason = '  Approved by the registrar after review  ';
      const result = await change(T.users.admin, student, to, { reason });

      expect(result.status).toBe(to);
      expect(result.version).toBe(before.version + 1);
      expect(Date.parse(result.statusChangedAt!)).toBeGreaterThan(
        before.status_changed_at.getTime(),
      );
      const stored = await row(student);
      expect(stored.status).toBe(to);
      expect(stored.version).toBe(before.version + 1);

      const trail = await audits(student);
      const statusEvents = trail.filter((a) => a.action === 'student.status.change');
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0]).toMatchObject({
        risk_tier: 2,
        reason_text: 'Approved by the registrar after review',
        actor_user_id: T.users.admin,
        campus_id: main.campus,
        department_id: main.dept,
        changes: { status: { old: from, new: to } },
      });

      const enr = await enrolmentRow(enrolment);
      const closes = trail.filter((a) => a.action === 'student_program.close');
      if (outcome) {
        const today = await campusToday(main.campus);
        expect(enr).toMatchObject({
          status: outcome,
          exit_reason: 'Approved by the registrar after review',
        });
        expect([today, await campusToday(main.campus)]).toContain(enr.end_date);
        expect(await closedEvents(enrolment)).toEqual([
          expect.objectContaining({
            to_status: outcome,
            effective_date: enr.end_date,
            reason: 'Approved by the registrar after review',
            actor_user_id: T.users.admin,
          }),
        ]);
        expect(closes).toHaveLength(1);
        expect(statusEvents[0]!.metadata).toEqual({ closedStudentProgramId: enrolment });
      } else {
        expect(enr.status).toBe('ACTIVE');
        expect(enr.end_date).toBeNull();
        expect(await closedEvents(enrolment)).toEqual([]);
        expect(closes).toEqual([]);
        expect(statusEvents[0]!.metadata).toBeNull();
      }
    });
  }
});

describe('a closing transition without an ACTIVE enrolment', () => {
  it('proceeds for an organization-scoped actor (unplaced student): no closure, no program audit, no campus on the audit record', async () => {
    const student = await mkStudent('ACTIVE');
    await change(T.users.admin, student, 'GRADUATED');
    expect((await row(student)).status).toBe('GRADUATED');
    const trail = await audits(student);
    expect(trail.map((a) => a.action)).toEqual(['student.status.change']);
    expect(trail[0]).toMatchObject({ campus_id: null, department_id: null });
  });

  it('proceeds for a student whose enrolments are all closed', async () => {
    const student = await mkStudent('ON_LEAVE');
    const closed = await enrol(student, main, { status: 'COMPLETED' });
    await change(T.users.registrarOrg, student, 'DISCONTINUED');
    expect((await row(student)).status).toBe('DISCONTINUED');
    expect((await enrolmentRow(closed)).status).toBe('COMPLETED'); // untouched
  });
});

// ---- all 49 pairs through the service ------------------------------------------------------------------------------
describe('all 49 pairs through the service (no enrolment; organization-scoped administrator)', () => {
  for (const from of STUDENT_STATUSES) {
    for (const to of STUDENT_STATUSES) {
      const verdict = classifyTransition(from, to);
      it(`${from} -> ${to}: ${verdict}`, async () => {
        const student = await mkStudent(from);
        const before = await row(student);
        if (verdict === 'ALLOWED') {
          const r = await change(T.users.admin, student, to);
          expect(r.status).toBe(to);
          expect(
            (await audits(student)).filter((a) => a.action === 'student.status.change'),
          ).toHaveLength(1);
        } else {
          await refused(
            change(T.users.admin, student, to),
            409,
            verdict === 'DEFERRED' ? STATUS_TRANSITION_UNAVAILABLE : STATUS_TRANSITION_INVALID,
          );
          await expectUntouched(student, before);
        }
      });
    }
  }
});

// ---- authorization, scope, tenancy ----------------------------------------------------------------------------------
describe('authorization and scope (nothing is written on a refusal)', () => {
  it('a STUDENT actor, including the student themself, is refused with 403', async () => {
    const before = await row(T.students.one);
    await refused(change(T.users.studentOne, T.students.one, 'ON_LEAVE', { kind: 'STUDENT' }), 403);
    await refused(change(T.users.studentTwo, T.students.one, 'ON_LEAVE', { kind: 'STUDENT' }), 403);
    await expectUntouched(T.students.one, before);
  });

  it('roles without student.status.change (HOD, FACULTY, DEPARTMENT_ADMIN) are refused with 403', async () => {
    const student = await mkStudent('ACTIVE');
    const enrolment = await enrol(student, main);
    const before = await row(student);
    for (const user of [T.users.hod, T.users.faculty, extraUsers.deptAdmin!]) {
      await refused(change(user, student, 'ON_LEAVE'), 403);
    }
    await expectUntouched(student, before, enrolment);
  });

  it('a campus-scoped actor (CAMPUS_ADMIN, campus REGISTRAR) acts on students enrolled in their campus, whatever the department', async () => {
    for (const [user, s] of [
      [T.users.campusAdmin, main],
      [T.users.campusAdmin, sibling],
      [T.users.registrarCampus, main],
      [T.users.registrarCampus, sibling],
    ] as const) {
      const student = await mkStudent('ACTIVE');
      const enrolment = await enrol(student, s);
      await change(user, student, 'DISCONTINUED');
      expect((await row(student)).status).toBe('DISCONTINUED');
      expect((await enrolmentRow(enrolment)).status).toBe('DISCONTINUED');
    }
  });

  it('a campus-scoped actor gets the same 404 for a student enrolled in ANOTHER campus', async () => {
    const student = await mkStudent('ACTIVE');
    const enrolment = await enrol(student, other);
    const before = await row(student);
    await refused(change(T.users.campusAdmin, student, 'ON_LEAVE'), 404);
    await refused(change(T.users.registrarCampus, student, 'ON_LEAVE'), 404);
    await expectUntouched(student, before, enrolment);
  });

  it('a campus-scoped actor cannot act on an UNPLACED student or a student with only closed enrolments (scope is never inferred): 404', async () => {
    const unplaced = await mkStudent('ACTIVE');
    const closedOnly = await mkStudent('ACTIVE');
    await enrol(closedOnly, main, { status: 'COMPLETED' });
    for (const student of [unplaced, closedOnly]) {
      const before = await row(student);
      await refused(change(T.users.campusAdmin, student, 'ON_LEAVE'), 404);
      await refused(change(T.users.registrarCampus, student, 'ON_LEAVE'), 404);
      await expectUntouched(student, before);
    }
  });

  it('an organization-scoped actor (COLLEGE_ADMIN, organization REGISTRAR) acts on placed and unplaced students alike', async () => {
    for (const user of [T.users.admin, T.users.registrarOrg]) {
      const unplaced = await mkStudent('ACTIVE');
      const placed = await mkStudent('ACTIVE');
      await enrol(placed, other);
      await change(user, unplaced, 'ON_LEAVE');
      await change(user, placed, 'ON_LEAVE');
      expect((await row(unplaced)).status).toBe('ON_LEAVE');
      expect((await row(placed)).status).toBe('ON_LEAVE');
    }
  });

  it('a student of ANOTHER tenant, a missing id and an id of a different tenant are all the same 404', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    const otherAdmin = OTHER.users.admin;
    const e1 = await failure(
      change(otherAdmin, student, 'ON_LEAVE', {
        tenant: OTHER,
        expected: { type: 'version', version: 1 },
      }),
    );
    const e2 = await failure(
      change(T.users.admin, uuidv7(), 'ON_LEAVE', { expected: { type: 'version', version: 1 } }),
    );
    expect([e1.statusCode, e2.statusCode]).toEqual([404, 404]);
    expect([e1.code, e1.message]).toEqual([e2.code, e2.message]);
    await expectUntouched(student, before);
    // and the other tenant's own student is unaffected by this tenant's administrator
    const theirs = OTHER.students.one;
    const theirBefore = (
      await adminQuery<{ status: string; version: number }>(
        'SELECT status, version FROM app.students WHERE id = $1',
        [theirs],
      )
    )[0]!;
    await refused(
      change(T.users.admin, theirs, 'ON_LEAVE', {
        expected: { type: 'version', version: theirBefore.version },
      }),
      404,
    );
    expect(
      (
        await adminQuery<{ status: string }>('SELECT status FROM app.students WHERE id = $1', [
          theirs,
        ])
      )[0]!.status,
    ).toBe(theirBefore.status);
  });
});

// ---- request shape, version, reason ---------------------------------------------------------------------------------
describe('request validation and optimistic concurrency', () => {
  it('rejects a stale version with 409 CONFLICT and changes nothing; the current version succeeds', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    await refused(
      change(T.users.admin, student, 'ON_LEAVE', {
        expected: { type: 'version', version: before.version + 1 },
      }),
      409,
      'CONFLICT',
    );
    await refused(
      change(T.users.admin, student, 'ON_LEAVE', {
        expected: { type: 'version', version: before.version - 1 },
      }),
      409,
      'CONFLICT',
    );
    await expectUntouched(student, before);
    await change(T.users.admin, student, 'ON_LEAVE', {
      expected: { type: 'version', version: before.version },
    });
  });

  it('accepts only an exact version: "*", an initial-state or unconditional expectation is 400 (no query, no change)', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    for (const expected of [
      { type: 'exists' },
      { type: 'initial' },
      { type: 'unconditional' },
    ] as ExpectedVersion[]) {
      await refused(change(T.users.admin, student, 'ON_LEAVE', { expected }), 400);
    }
    await expectUntouched(student, before);
  });

  it('validates status, reason and id before touching the database', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    for (const status of ['ARCHIVED', 'active', '', null, 7, undefined]) {
      await refused(change(T.users.admin, student, status), 400);
    }
    for (const reason of ['', '    ', 'abcd', 'x'.repeat(501), null, 12]) {
      await refused(change(T.users.admin, student, 'ON_LEAVE', { reason }), 400);
    }
    await refused(
      change(T.users.admin, 'not-a-uuid', 'ON_LEAVE', {
        expected: { type: 'version', version: 1 },
      }),
      400,
    );
    await expectUntouched(student, before);
    const ok = await change(T.users.admin, student, 'ON_LEAVE', { reason: 'abcde' }); // 5 characters is enough
    expect(ok.status).toBe('ON_LEAVE');
    const ok500 = await change(T.users.admin, student, 'ACTIVE', { reason: 'y'.repeat(500) });
    expect(ok500.status).toBe('ACTIVE');
  });

  it('a transition into TRANSFERRED_OUT answers the stable UNAVAILABLE conflict from every non-terminal status, and nothing changes', async () => {
    for (const from of ['ACTIVE', 'ON_LEAVE', 'SUSPENDED'] as const) {
      const student = await mkStudent(from);
      const enrolment = await enrol(student, main);
      const before = await row(student);
      const e = await failure(change(T.users.admin, student, 'TRANSFERRED_OUT'));
      expect(e.statusCode).toBe(409);
      expect(e.code).toBe('STUDENT_STATUS_TRANSITION_UNAVAILABLE');
      await expectUntouched(student, before, enrolment);
    }
  });
});

// ---- atomicity ---------------------------------------------------------------------------------------------------------
describe('atomicity', () => {
  it('a future-dated ACTIVE enrolment cannot be closed: the WHOLE status change is refused (409 NOT_CLOSABLE), no date is invented', async () => {
    for (const to of ['GRADUATED', 'DISCONTINUED'] as const) {
      const student = await mkStudent('ACTIVE');
      const enrolment = await enrol(student, main, { start: '2200-01-01' });
      const before = await row(student);
      await refused(change(T.users.admin, student, to), 409, STATUS_ENROLMENT_NOT_CLOSABLE);
      await expectUntouched(student, before, enrolment);
      expect((await enrolmentRow(enrolment)).end_date).toBeNull();
    }
    // the non-closing targets are not blocked by a future enrolment
    const student = await mkStudent('ACTIVE');
    await enrol(student, main, { start: '2200-01-01' });
    await change(T.users.admin, student, 'ON_LEAVE');
    expect((await row(student)).status).toBe('ON_LEAVE');
  });

  it('a failure AFTER the enrolment was closed (invalid audit request metadata) rolls back the closure, its event and both audit records', async () => {
    const student = await mkStudent('ACTIVE');
    const enrolment = await enrol(student, main);
    const before = await row(student);
    const e = await failure(
      change(T.users.admin, student, 'GRADUATED', { meta: { ip: 'not-an-ip' } }),
    );
    expect(e.code).toBe('AUDIT_INVALID');
    await expectUntouched(student, before, enrolment);
    expect((await enrolmentRow(enrolment)).exit_reason).toBeNull();
    // the same request with valid metadata then succeeds in full
    const ok = await change(T.users.admin, student, 'GRADUATED');
    expect(ok.status).toBe('GRADUATED');
    expect((await enrolmentRow(enrolment)).status).toBe('COMPLETED');
  });

  it('a failure after the student row was updated (no enrolment) rolls the status back as well', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    const e = await failure(
      change(T.users.admin, student, 'SUSPENDED', { meta: { ip: 'not-an-ip' } }),
    );
    expect(e.code).toBe('AUDIT_INVALID');
    await expectUntouched(student, before);
  });
});

// ---- concurrency -------------------------------------------------------------------------------------------------------
const settle = (p: Promise<unknown>): Promise<number> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : -1),
  );

describe('concurrency (real concurrent transactions)', () => {
  it('two simultaneous changes from the same version: exactly one wins, one 409, exactly one status audit record', async () => {
    for (let round = 0; round < 4; round++) {
      const student = await mkStudent('ACTIVE');
      const v = (await row(student)).version;
      const expected: ExpectedVersion = { type: 'version', version: v };
      const results = await Promise.all([
        settle(change(T.users.admin, student, 'ON_LEAVE', { expected })),
        settle(change(T.users.registrarOrg, student, 'ON_LEAVE', { expected })),
      ]);
      expect([...results].sort()).toEqual([200, 409]);
      expect((await row(student)).version).toBe(v + 1);
      expect(
        (await audits(student)).filter((a) => a.action === 'student.status.change'),
      ).toHaveLength(1);
    }
  });

  it('two different targets from the same version: one wins, the enrolment is closed once and matches the winner', async () => {
    for (let round = 0; round < 4; round++) {
      const student = await mkStudent('ACTIVE');
      const enrolment = await enrol(student, main);
      const expected: ExpectedVersion = { type: 'version', version: (await row(student)).version };
      const results = await Promise.all([
        settle(change(T.users.admin, student, 'GRADUATED', { expected })),
        settle(change(T.users.admin, student, 'DISCONTINUED', { expected })),
      ]);
      expect([...results].sort()).toEqual([200, 409]);
      const status = (await row(student)).status;
      expect(['GRADUATED', 'DISCONTINUED']).toContain(status);
      const enr = await enrolmentRow(enrolment);
      expect(enr.status).toBe(ENROLMENT_CLOSE_OUTCOME[status as 'GRADUATED' | 'DISCONTINUED']);
      expect(await closedEvents(enrolment)).toHaveLength(1);
      expect(
        (await audits(student)).filter((a) => a.action === 'student.status.change'),
      ).toHaveLength(1);
      expect(
        (await audits(student)).filter((a) => a.action === 'student_program.close'),
      ).toHaveLength(1);
    }
  });

  it('a status change racing the explicit enrolment close never double-closes: one CLOSED event, the student ends GRADUATED', async () => {
    for (let round = 0; round < 4; round++) {
      const student = await mkStudent('ACTIVE');
      const enrolment = await enrol(student, main);
      const enrolmentVersion = (await enrolmentRow(enrolment)).version;
      const ctx = ctxFor(T.users.admin);
      const [statusResult, closeResult] = await Promise.all([
        settle(change(T.users.admin, student, 'GRADUATED')),
        settle(
          db.withTenant(ctx, (tx) =>
            StudentProgramService.close(
              tx,
              ctx,
              enrolment,
              { outcome: 'COMPLETED', endDate: '2024-09-01', reason: 'Closed by the program desk' },
              { expected: { type: 'version', version: enrolmentVersion }, studentId: student },
            ),
          ),
        ),
      ]);
      expect(statusResult).toBe(200);
      expect([200, 409]).toContain(closeResult);
      expect((await row(student)).status).toBe('GRADUATED');
      expect((await enrolmentRow(enrolment)).status).toBe('COMPLETED');
      expect(await closedEvents(enrolment)).toHaveLength(1);
    }
  });
});

// ---- HTTP --------------------------------------------------------------------------------------------------------------
describe('POST /api/v1/students/:id/status over HTTP', () => {
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
    sessions.student = await login(T.emails.studentOne);
    await elevateSession(sessions.admin.cookie);
    await elevateSession(sessions.campusAdmin.cookie);
  }, 60_000);

  it('ambient session without step-up is refused: 403 STEP_UP_REQUIRED', async () => {
    const student = await mkStudent('ACTIVE');
    const v = (await row(student)).version;
    const ambientAdmin = await login(T.emails.admin);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/students/${student}/status`,
      payload: good,
      cookies: { session_token: ambientAdmin.cookie },
      headers: {
        origin: APP_ORIGIN,
        'x-csrf-token': ambientAdmin.csrf,
        'if-match': `"${v}"`,
      },
    });
    expect(r.statusCode).toBe(403);
    expect(errCode(r)).toBe('STEP_UP_REQUIRED');
  });

  const post = (
    who: string | null,
    student: string,
    payload: unknown,
    headers: Record<string, string> = {},
    csrf?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/students/${student}/status`,
      payload: payload as object,
      cookies: who ? { session_token: sessions[who]!.cookie } : {},
      headers: {
        origin: APP_ORIGIN,
        ...(who ? { 'x-csrf-token': csrf ?? sessions[who]!.csrf } : {}),
        ...headers,
      },
    });
  const good = { status: 'ON_LEAVE', reason: 'Approved leave of absence' };
  const errCode = (r: { json: <T>() => T }): string =>
    r.json<{ error: { code: string } }>().error.code;

  it('200 with the updated record and the new strong ETag; the response carries no extra fields', async () => {
    const student = await mkStudent('ACTIVE');
    const v = (await row(student)).version;
    const r = await post('admin', student, good, { 'if-match': `"${v}"` });
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toBe(`"${v + 1}"`);
    const body = r.json<{ success: boolean; data: Record<string, unknown> }>();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ id: student, status: 'ON_LEAVE', version: v + 1 });
    expect(Object.keys(body.data).sort()).toEqual(
      [
        'admissionDate',
        'admissionNumber',
        'createdAt',
        'id',
        'organizationId',
        'status',
        'statusChangedAt',
        'updatedAt',
        'userId',
        'version',
      ].sort(),
    );
  });

  it('If-Match: missing is 428; weak, "*", "0", "null", garbage and a list are 400; none of them changes anything', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    const missing = await post('admin', student, good);
    expect(missing.statusCode).toBe(428);
    for (const header of [
      `W/"${before.version}"`,
      '*',
      '"0"',
      'null',
      'abc',
      `"${before.version}", "7"`,
      '"-1"',
      '""',
    ]) {
      const r = await post('admin', student, good, { 'if-match': header });
      expect(r.statusCode, header).toBe(400);
    }
    await expectUntouched(student, before);
    const stale = await post('admin', student, good, { 'if-match': `"${before.version + 5}"` });
    expect(stale.statusCode).toBe(409);
    expect(errCode(stale)).toBe('CONFLICT');
  });

  it('body validation: unknown status, unknown or tenant/version fields, short reason, empty body are 400', async () => {
    const student = await mkStudent('ACTIVE');
    const before = await row(student);
    const h = { 'if-match': `"${before.version}"` };
    for (const payload of [
      { status: 'ARCHIVED', reason: 'Valid reason here' },
      { status: 'ON_LEAVE', reason: 'abcd' },
      { status: 'ON_LEAVE' },
      { reason: 'Valid reason here' },
      { ...good, organizationId: T.orgId },
      { ...good, version: before.version },
      { ...good, endDate: '2024-09-01' },
      {},
    ]) {
      const r = await post('admin', student, payload, h);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await expectUntouched(student, before);
    expect((await post('admin', 'not-a-uuid', good, h)).statusCode).toBe(400);
  });

  it('the stable conflict codes appear in the response body', async () => {
    const student = await mkStudent('ACTIVE');
    const v = (await row(student)).version;
    const deferred = await post(
      'admin',
      student,
      { status: 'TRANSFERRED_OUT', reason: 'Left the institution' },
      { 'if-match': `"${v}"` },
    );
    expect(deferred.statusCode).toBe(409);
    expect(errCode(deferred)).toBe('STUDENT_STATUS_TRANSITION_UNAVAILABLE');
    const invalidPair = await post(
      'admin',
      student,
      { status: 'ADMITTED', reason: 'Back to the start' },
      { 'if-match': `"${v}"` },
    );
    expect(invalidPair.statusCode).toBe(409);
    expect(errCode(invalidPair)).toBe('STUDENT_STATUS_TRANSITION_INVALID');
    const future = await mkStudent('ACTIVE');
    await enrol(future, main, { start: '2200-01-01' });
    const fv = (await row(future)).version;
    const notClosable = await post(
      'admin',
      future,
      { status: 'GRADUATED', reason: 'Completed the program' },
      { 'if-match': `"${fv}"` },
    );
    expect(notClosable.statusCode).toBe(409);
    expect(errCode(notClosable)).toBe('STUDENT_STATUS_ENROLMENT_NOT_CLOSABLE');
  });

  it('authentication and authorization: 401 without a session, 403 without CSRF, 403 for a STUDENT session and for HOD, 404 out of scope', async () => {
    const student = await mkStudent('ACTIVE');
    const outside = await mkStudent('ACTIVE');
    await enrol(outside, other);
    const before = await row(student);
    const h = { 'if-match': `"${before.version}"` };
    expect((await post(null, student, good, h)).statusCode).toBe(401);
    expect((await post('admin', student, good, h, 'wrong-token')).statusCode).toBe(403);
    expect((await post('student', student, good, h)).statusCode).toBe(403);
    expect((await post('student', T.students.one, good, h)).statusCode).toBe(403); // not even their own record
    expect((await post('hod', student, good, h)).statusCode).toBe(403);
    expect(
      (
        await post('campusAdmin', outside, good, {
          'if-match': `"${(await row(outside)).version}"`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await post('campusAdmin', student, good, h)).statusCode).toBe(404); // unplaced: campus scope cannot be proven
    await expectUntouched(student, before);
  });
});
