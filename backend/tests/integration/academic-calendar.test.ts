import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  AcademicYearService,
  CohortPeriodService,
  SectionService,
  TermService,
} from '../../src/modules/academics/calendar.service.js';
import {
  CourseService,
  CurriculumService,
} from '../../src/modules/academics/curriculum.service.js';
import { ProgramService } from '../../src/modules/academics/academic.service.js';
import { StudentProgramService } from '../../src/modules/students/student-program.service.js';
import { StudentStatusService } from '../../src/modules/students/student-status.service.js';
import { PROGRAM_HAS_LIVE_TERM_ENROLLMENTS } from '../../src/modules/students/student-status.js';
import { TermEnrollmentService } from '../../src/modules/students/term-enrollment.service.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import type { ExpectedVersion } from '../../src/shared/settings/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';
import { adminQuery } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Milestone 3 Batch 1 services against the shared disposable integration database. Everything commits, so it runs in a
// private tenant; every assertion looks at rows these tests created (by id), never at tenant-wide counts.

const RUN = randomBytes(3).toString('hex');
const pool = createPool({ connectionString: inject('dbRuntimeUrl'), ssl: false, max: 10 });
const db = new Database(pool);
// A second pool whose application_name lets the race tests recognise (in pg_stat_activity) the backend that is waiting.
const WAITER_APP = `it-m3-waiter-${RUN}`;
const waiterDb = new Database(
  createPool({
    connectionString: inject('dbRuntimeUrl'),
    ssl: false,
    max: 6,
    applicationName: WAITER_APP,
  }),
);

let T!: IsolatedTenant;
let PERIOD!: string;
const extra: Record<string, string> = {};
let seq = 0;
const code = (p: string): string => `${p}${RUN}${(seq++).toString(36)}`.slice(0, 20);
const exp = (version: number): ExpectedVersion => ({ type: 'version', version });
const ANY: ExpectedVersion = { type: 'exists' };

const staff = (user: string): TrustedContext =>
  issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STAFF' });
const student = (user: string): TrustedContext =>
  issueTrustedContext({ tenantId: T.orgId, userId: user, actorKind: 'STUDENT' });
const as = <R>(
  ctx: TrustedContext,
  fn: (tx: Parameters<Parameters<Database['withTenant']>[1]>[0], ctx: TrustedContext) => Promise<R>,
): Promise<R> => db.withTenant(ctx, (tx) => fn(tx, ctx));
const status = (p: Promise<unknown>): Promise<number> =>
  p.then(
    () => 200,
    (e: unknown) => (e instanceof AppError ? e.statusCode : -1),
  );

interface Structure {
  campus: string;
  dept: string;
  program: string;
  cohort: string;
}
let main!: Structure;
let sibling!: Structure; // same campus, another department
let other!: Structure; // another campus

async function mkUser(role?: {
  code: string;
  scope: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
  id: string | null;
}) {
  const id = uuidv7();
  const email = `m3-${RUN}-${id.slice(-12)}@isolated.test`;
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
async function mkStructure(campus: string, dept?: string, duration = 8): Promise<Structure> {
  const d = dept ?? uuidv7();
  if (!dept) {
    await adminQuery(
      `INSERT INTO app.departments (id, organization_id, campus_id, name, code) VALUES ($1, $2, $3, 'M3 dept', $4)`,
      [d, T.orgId, campus, code('D')],
    );
  }
  const program = uuidv7();
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1, $2, $3, $4, 'M3 program', $5, 'UG', $6)`,
    [program, T.orgId, d, PERIOD, code('P'), duration],
  );
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1, $2, $3, 2024, 'M3 cohort')`,
    [cohort, T.orgId, program],
  );
  return { campus, dept: d, program, cohort };
}
let cohortSeq = 0;
/** A NEW cohort of the same program: (cohort, period_no) and (cohort, term) are unique, so every test that builds periods uses its own. */
async function mkCohort(base: Structure = main): Promise<Structure> {
  const cohort = uuidv7();
  await adminQuery(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, intake_code, name)
     VALUES ($1, $2, $3, 2025, $4, 'M3 extra cohort')`,
    [cohort, T.orgId, base.program, `I${RUN}${cohortSeq++}`.slice(0, 10)],
  );
  return { ...base, cohort };
}
let studentSeq = 0;
/** A student with an ACTIVE program enrolment in `s` (inserted as the harness; the services under test start after it). */
async function mkEnrolledStudent(s: Structure = main, studentStatus = 'ACTIVE') {
  // a real student also holds the STUDENT role (its SELF-mode permissions are what let them read their own records)
  const user = await mkUser({ code: 'STUDENT', scope: 'ORGANIZATION', id: null });
  const id = uuidv7();
  await adminQuery(
    `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
     VALUES ($1, $2, $3, $4, '2024-07-01', $5)`,
    [id, T.orgId, user, `M3${RUN}${studentSeq++}`, studentStatus],
  );
  const sp = uuidv7();
  await adminQuery(
    `INSERT INTO app.student_programs (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2024-08-01')`,
    [sp, T.orgId, id, s.program, s.cohort, s.campus, s.dept],
  );
  return { id, user, sp };
}

// ---- calendar builders (as the organization admin) ----------------------------------------------------------------
let yearSeq = 0;
async function mkYear(activate = true): Promise<{ id: string; start: string; end: string }> {
  const n = yearSeq++;
  const start = `${2100 + n}-06-01`;
  const end = `${2101 + n}-05-31`;
  const admin = staff(T.users.admin);
  const id = await as(admin, (tx, c) =>
    AcademicYearService.create(tx, c, { label: code('Y'), startDate: start, endDate: end }),
  );
  if (activate) {
    await as(admin, (tx, c) =>
      AcademicYearService.update(tx, c, id, { status: 'ACTIVE' }, { expected: ANY }),
    );
  }
  return { id, start, end };
}
async function mkTerm(
  year: { id: string; start: string; end: string },
  campus = main.campus,
  activate = false,
): Promise<string> {
  const admin = staff(T.users.admin);
  const id = await as(admin, (tx, c) =>
    TermService.create(tx, c, {
      campusId: campus,
      academicYearId: year.id,
      code: code('T'),
      name: 'Term',
      startDate: year.start,
      endDate: year.end,
    }),
  );
  if (activate) {
    await as(admin, (tx, c) =>
      TermService.update(tx, c, id, { status: 'ACTIVE' }, { expected: ANY }),
    );
  }
  return id;
}
async function mkPeriod(term: string, s: Structure = main, periodNo = 1): Promise<string> {
  return as(staff(T.users.admin), (tx, c) =>
    CohortPeriodService.create(tx, c, { cohortId: s.cohort, termId: term, periodNo }),
  );
}
async function mkSection(period: string, name = code('S'), capacity?: number): Promise<string> {
  return as(staff(T.users.admin), (tx, c) =>
    SectionService.create(tx, c, {
      cohortPeriodId: period,
      name,
      ...(capacity ? { capacity } : {}),
    }),
  );
}
async function enrol(studentId: string, period: string, over: object = {}) {
  return as(staff(T.users.admin), (tx, c) =>
    TermEnrollmentService.create(
      tx,
      c,
      studentId,
      { cohortPeriodId: period, reason: 'Registered for the term', ...over },
      { idempotencyKey: uuidv7() },
    ),
  );
}
const idOf = (r: { body: Record<string, unknown> }): string => (r.body.data as { id: string }).id;
const place = (
  enrollmentId: string,
  studentId: string,
  section: string,
  validFrom: string,
  ctx = staff(T.users.admin),
) =>
  as(ctx, (tx, c) =>
    TermEnrollmentService.placeSection(
      tx,
      c,
      enrollmentId,
      { sectionId: section, validFrom, reason: 'Section allocation' },
      { studentId },
    ),
  );

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  PERIOD = uuidv7();
  await adminQuery(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1, $2, 'SEM', 'Semester', 'Semesters')`,
    [PERIOD, T.orgId],
  );
  main = await mkStructure(T.campusId, T.departmentId);
  sibling = await mkStructure(T.campusId);
  const otherCampus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1, $2, 'Other campus', $3, 'Asia/Kolkata')`,
    [otherCampus, T.orgId, code('OC')],
  );
  other = await mkStructure(otherCampus);
  extra.deptAdmin = await mkUser({
    code: 'DEPARTMENT_ADMIN',
    scope: 'DEPARTMENT',
    id: T.departmentId,
  });
  extra.siblingDeptAdmin = await mkUser({
    code: 'DEPARTMENT_ADMIN',
    scope: 'DEPARTMENT',
    id: sibling.dept,
  });
  extra.otherCampusAdmin = await mkUser({
    code: 'CAMPUS_ADMIN',
    scope: 'CAMPUS',
    id: other.campus,
  });
}, 60_000);

afterAll(async () => {
  await db.close();
  await waiterDb.close();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica'); // history rows are guarded; the tenant is going away
    for (const t of [
      'section_memberships',
      'term_enrollments',
      'sections',
      'cohort_periods',
      'curriculum_courses',
      'courses',
      'terms',
      'academic_years',
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
});

// =================================================================================================================
// Workstream A: academic years
// =================================================================================================================
describe('AcademicYearService', () => {
  it('creates a PLANNED year, audits it, lists it and rejects a duplicate label and an overlapping range', async () => {
    const y = await mkYear(false);
    const row = await as(staff(T.users.admin), (tx, c) => AcademicYearService.getById(tx, c, y.id));
    expect(row).toMatchObject({
      status: 'PLANNED',
      startDate: y.start,
      endDate: y.end,
      version: 1,
    });
    const audit = await adminQuery(
      `SELECT action FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [T.orgId, y.id],
    );
    expect(audit.map((a) => a.action)).toContain('academic.year.create');

    const admin = staff(T.users.admin);
    await expect(
      as(admin, (tx, c) =>
        AcademicYearService.create(tx, c, {
          label: row.label,
          startDate: '2190-01-01',
          endDate: '2190-12-31',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      as(admin, (tx, c) =>
        AcademicYearService.create(tx, c, {
          label: code('OV'),
          startDate: y.start,
          endDate: y.end,
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await as(admin, (tx, c) => AcademicYearService.list(tx, c, { status: 'PLANNED' }))).some(
        (x) => x.id === y.id,
      ),
    ).toBe(true);
  });

  it('serialises two simultaneous overlapping creates: exactly one wins', async () => {
    const admin = staff(T.users.admin);
    const make = (label: string, s: string, e: string) =>
      status(
        as(admin, (tx, c) =>
          AcademicYearService.create(tx, c, { label, startDate: s, endDate: e }),
        ),
      );
    // a dedicated range far from the sequential years the other tests create
    const results = await Promise.all([
      make(code('R1'), '2190-01-01', '2190-12-31'),
      make(code('R2'), '2190-06-01', '2191-03-31'),
    ]);
    expect([...results].sort()).toEqual([200, 409]);
  });

  it('is organization-wide: campus admin, department admin, faculty, student and role-less users are refused', async () => {
    const body = { label: code('F'), startDate: '2199-01-01', endDate: '2199-02-01' };
    for (const [who, ctx, expected] of [
      ['campus admin', staff(T.users.campusAdmin), 403],
      ['department admin', staff(extra.deptAdmin!), 403],
      ['faculty', staff(T.users.faculty), 403],
      ['hod', staff(T.users.hod), 403],
      ['student', student(T.users.studentOne), 403],
    ] as const) {
      expect(await status(as(ctx, (tx, c) => AcademicYearService.create(tx, c, body))), who).toBe(
        expected,
      );
    }
    // org-scoped registrar may manage the calendar
    expect(
      await status(
        as(staff(T.users.registrarOrg), (tx, c) => AcademicYearService.create(tx, c, body)),
      ),
    ).toBe(200);
  });

  it('validates input (dates, label) with 400', async () => {
    const admin = staff(T.users.admin);
    for (const bad of [
      { label: '', startDate: '2198-01-01', endDate: '2198-06-01' },
      { label: 'x', startDate: '2198-13-01', endDate: '2198-06-01' },
      { label: 'x', startDate: '2198-06-01', endDate: '2198-01-01' },
      { label: 'x', startDate: '2198-06-01', endDate: '2198-06-01' },
    ]) {
      expect(await status(as(admin, (tx, c) => AcademicYearService.create(tx, c, bad)))).toBe(400);
    }
  });

  it('follows PLANNED -> ACTIVE -> CLOSED only; dates are editable only while PLANNED; stale versions and no-ops', async () => {
    const admin = staff(T.users.admin);
    const y = await mkYear(false);
    const upd = (body: object, e: ExpectedVersion) =>
      as(admin, (tx, c) => AcademicYearService.update(tx, c, y.id, body, { expected: e }));
    // skipping a state is refused
    await expect(upd({ status: 'CLOSED' }, exp(1))).rejects.toMatchObject({ statusCode: 409 });
    // a stale version is refused before anything changes
    await expect(upd({ status: 'ACTIVE' }, exp(99))).rejects.toMatchObject({ statusCode: 409 });
    // dates change while PLANNED
    const moved = await upd({ endDate: `${y.end.slice(0, 4)}-03-31` }, exp(1)); // shorten: never touches a neighbour
    expect(moved.version).toBe(2);
    // a no-op neither bumps the version nor audits
    const same = await upd({ endDate: moved.endDate }, exp(2));
    expect(same.version).toBe(2);
    const active = await upd({ status: 'ACTIVE' }, exp(2));
    expect(active.status).toBe('ACTIVE');
    await expect(upd({ endDate: `${y.end.slice(0, 4)}-02-28` }, exp(3))).rejects.toMatchObject({
      statusCode: 409,
    });
    const closed = await upd({ status: 'CLOSED' }, exp(3));
    expect(closed.status).toBe('CLOSED');
    await expect(upd({ status: 'ACTIVE' }, exp(4))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses to close a year that still has PLANNED or ACTIVE terms, and accepts it once they are closed', async () => {
    const admin = staff(T.users.admin);
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    await expect(
      as(admin, (tx, c) =>
        AcademicYearService.update(tx, c, y.id, { status: 'CLOSED' }, { expected: ANY }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await as(admin, (tx, c) =>
      TermService.update(tx, c, term, { status: 'CLOSED' }, { expected: ANY }),
    );
    await expect(
      as(admin, (tx, c) =>
        AcademicYearService.update(tx, c, y.id, { status: 'CLOSED' }, { expected: ANY }),
      ),
    ).resolves.toMatchObject({ status: 'CLOSED' });
  });

  it('a student may read academic years (academic.program.read) but never write them', async () => {
    const list = await as(student(T.users.studentOne), (tx, c) => AcademicYearService.list(tx, c));
    expect(Array.isArray(list)).toBe(true);
    // direct runtime-role writes by a STUDENT session are refused by row security (see the database tests below)
  });
});

// =================================================================================================================
// Workstream A: terms
// =================================================================================================================
describe('TermService', () => {
  it('creates a term inside its year, rejects dates outside the year, duplicates and unknown references', async () => {
    const y = await mkYear(true);
    const admin = staff(T.users.admin);
    const base = {
      campusId: main.campus,
      academicYearId: y.id,
      code: code('TT'),
      name: 'Odd',
      startDate: y.start,
      endDate: y.end,
    };
    const id = await as(admin, (tx, c) => TermService.create(tx, c, base));
    const term = await as(admin, (tx, c) => TermService.getById(tx, c, id));
    expect(term).toMatchObject({ status: 'PLANNED', lockedAt: null, lockedBy: null, version: 1 });
    expect(await status(as(admin, (tx, c) => TermService.create(tx, c, base)))).toBe(409);
    expect(
      await status(
        as(admin, (tx, c) =>
          TermService.create(tx, c, { ...base, code: code('TO'), endDate: `${2300}-01-01` }),
        ),
      ),
    ).toBe(400);
    expect(
      await status(
        as(admin, (tx, c) =>
          TermService.create(tx, c, { ...base, code: code('TU'), campusId: uuidv7() }),
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        as(admin, (tx, c) =>
          TermService.create(tx, c, { ...base, code: code('TY'), academicYearId: uuidv7() }),
        ),
      ),
    ).toBe(404);
  });

  it('is campus-scoped: the campus admin manages own campus terms, another campus admin gets 404, department roles 403', async () => {
    const y = await mkYear(true);
    const mk = (ctx: TrustedContext, campus: string) =>
      as(ctx, (tx, c) =>
        TermService.create(tx, c, {
          campusId: campus,
          academicYearId: y.id,
          code: code('SC'),
          name: 'Scoped',
          startDate: y.start,
          endDate: y.end,
        }),
      );
    expect(await status(mk(staff(T.users.campusAdmin), main.campus))).toBe(200);
    expect(await status(mk(staff(T.users.campusAdmin), other.campus))).toBe(404);
    expect(await status(mk(staff(extra.otherCampusAdmin!), main.campus))).toBe(404);
    expect(await status(mk(staff(extra.otherCampusAdmin!), other.campus))).toBe(200);
    expect(await status(mk(staff(extra.deptAdmin!), main.campus))).toBe(403);
    expect(await status(mk(staff(T.users.faculty), main.campus))).toBe(403);
    // reads are scoped too: the other campus admin cannot read a main-campus term
    const t = await mkTerm(y, main.campus);
    expect(
      await status(as(staff(extra.otherCampusAdmin!), (tx, c) => TermService.getById(tx, c, t))),
    ).toBe(404);
  });

  it('walks PLANNED -> ACTIVE -> CLOSED -> LOCKED; LOCK needs a reason and stamps who/when; a LOCKED term is frozen', async () => {
    const admin = staff(T.users.admin);
    const y = await mkYear(true);
    const t = await mkTerm(y);
    const upd = (body: object) =>
      as(admin, (tx, c) => TermService.update(tx, c, t, body, { expected: ANY }));
    await expect(upd({ status: 'CLOSED' })).rejects.toMatchObject({ statusCode: 409 }); // cannot skip ACTIVE
    expect((await upd({ status: 'ACTIVE' })).status).toBe('ACTIVE');
    await expect(upd({ startDate: y.start })).resolves.toBeTruthy(); // no-op is fine
    await expect(upd({ startDate: `${2100}-01-01` })).rejects.toMatchObject({ statusCode: 409 }); // dates frozen after PLANNED
    expect((await upd({ status: 'CLOSED' })).status).toBe('CLOSED');
    await expect(upd({ status: 'LOCKED' })).rejects.toMatchObject({ statusCode: 400 }); // reason mandatory (A2)
    const locked = await upd({ status: 'LOCKED', reason: 'Results published for the term' });
    expect(locked.status).toBe('LOCKED');
    expect(locked.lockedBy).toBe(T.users.admin);
    expect(locked.lockedAt).not.toBeNull();
    await expect(upd({ name: 'Renamed' })).rejects.toMatchObject({ statusCode: 409 });
    const audit = await adminQuery(
      `SELECT action, risk_tier, reason_text FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'academic.term.lock'`,
      [T.orgId, t],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ risk_tier: 2, reason_text: 'Results published for the term' });
  });

  it('a term can only become ACTIVE inside an ACTIVE year, and cannot be added to a CLOSED year', async () => {
    const admin = staff(T.users.admin);
    const planned = await mkYear(false);
    const t = await mkTerm(planned);
    await expect(
      as(admin, (tx, c) => TermService.update(tx, c, t, { status: 'ACTIVE' }, { expected: ANY })),
    ).rejects.toMatchObject({ statusCode: 409 });
    const closedYear = await mkYear(true);
    await as(admin, (tx, c) =>
      AcademicYearService.update(tx, c, closedYear.id, { status: 'CLOSED' }, { expected: ANY }),
    );
    expect(await status(mkTerm(closedYear).then(() => undefined))).not.toBe(200);
  });
});

// =================================================================================================================
// Workstream A: courses and curriculum
// =================================================================================================================
describe('CourseService and CurriculumService', () => {
  const newCourse = (ctx: TrustedContext, over: object = {}) =>
    as(ctx, (tx, c) =>
      CourseService.create(tx, c, {
        code: code('CS'),
        title: 'Algorithms',
        credits: 3.5,
        courseType: 'THEORY',
        owningDepartmentId: T.departmentId,
        ...over,
      }),
    );

  it('creates, reads, updates with If-Match and rejects duplicate codes and bad credits', async () => {
    const admin = staff(T.users.admin);
    const codeA = code('CD');
    const id = await newCourse(admin, { code: codeA });
    const course = await as(admin, (tx, c) => CourseService.getById(tx, c, id));
    expect(course).toMatchObject({
      code: codeA,
      credits: 3.5,
      tracksAttendance: true,
      status: 'ACTIVE',
      version: 1,
    });
    expect(await status(newCourse(admin, { code: codeA }))).toBe(409);
    for (const credits of [-1, 100, 2.25, Number.NaN]) {
      expect(await status(newCourse(admin, { credits }))).toBe(400);
    }
    const upd = await as(admin, (tx, c) =>
      CourseService.update(tx, c, id, { title: 'Algorithms II', credits: 4 }, { expected: exp(1) }),
    );
    expect(upd).toMatchObject({ title: 'Algorithms II', credits: 4, version: 2 });
    await expect(
      as(admin, (tx, c) =>
        CourseService.update(tx, c, id, { title: 'Stale' }, { expected: exp(1) }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('scopes courses by owning department: a department admin manages own, not a sibling department or the org-wide catalogue', async () => {
    expect(await status(newCourse(staff(extra.deptAdmin!)))).toBe(200);
    expect(await status(newCourse(staff(extra.siblingDeptAdmin!)))).toBe(404);
    expect(
      await status(newCourse(staff(extra.deptAdmin!), { owningDepartmentId: undefined })),
    ).toBe(403);
    expect(await status(newCourse(staff(T.users.admin), { owningDepartmentId: undefined }))).toBe(
      200,
    );
    expect(await status(newCourse(staff(T.users.hod)))).toBe(403);
    expect(await status(newCourse(staff(T.users.faculty)))).toBe(403);
    const id = await newCourse(staff(T.users.admin));
    expect(
      await status(as(staff(extra.siblingDeptAdmin!), (tx, c) => CourseService.getById(tx, c, id))),
    ).toBe(404);
  });

  it('prescribes courses per program period with validation, scope and uniqueness; deleting a prescribed course is refused', async () => {
    const admin = staff(T.users.admin);
    const course = await newCourse(admin);
    const mk = (ctx: TrustedContext, over: object = {}) =>
      as(ctx, (tx, c) =>
        CurriculumService.create(tx, c, {
          programId: main.program,
          courseId: course,
          regulation: 'R2024',
          periodNo: 1,
          category: 'CORE',
          ...over,
        }),
      );
    const id = await mk(admin);
    expect(await status(mk(admin))).toBe(409); // same program/regulation/period/course
    expect(await status(mk(admin, { periodNo: 9 }))).toBe(400); // beyond duration_periods = 8
    expect(await status(mk(admin, { periodNo: 2, electiveGroupCode: 'EG1' }))).toBe(400); // only ELECTIVE has a basket
    expect(
      await status(mk(admin, { periodNo: 2, category: 'ELECTIVE', electiveGroupCode: 'EG1' })),
    ).toBe(200);
    expect(await status(mk(staff(extra.siblingDeptAdmin!), { periodNo: 3 }))).toBe(404);
    expect(await status(mk(staff(T.users.faculty), { periodNo: 3 }))).toBe(403);

    const list = await as(admin, (tx, c) =>
      CurriculumService.list(tx, c, { programId: main.program, regulation: 'R2024' }),
    );
    expect(list.map((x) => x.periodNo).sort()).toEqual([1, 2]);

    await expect(
      as(admin, (tx, c) => CourseService.remove(tx, c, course, { expected: ANY })),
    ).rejects.toMatchObject({ statusCode: 409 });
    await as(admin, (tx, c) =>
      CurriculumService.update(tx, c, id, { category: 'LAB' }, { expected: exp(1) }),
    );
    const entries = await as(admin, (tx, c) =>
      CurriculumService.list(tx, c, { programId: main.program }),
    );
    for (const e of entries.filter((x) => x.courseId === course)) {
      await as(admin, (tx, c) => CurriculumService.remove(tx, c, e.id, { expected: ANY }));
    }
    await as(admin, (tx, c) => CourseService.remove(tx, c, course, { expected: ANY }));
    expect(await status(as(admin, (tx, c) => CourseService.getById(tx, c, course)))).toBe(404);
    // the code is free again (partial unique index on live rows)
  });

  it('refuses an inactive course in a new curriculum entry, but keeps inactive courses already prescribed', async () => {
    const admin = staff(T.users.admin);
    const course = await newCourse(admin);
    await as(admin, (tx, c) =>
      CourseService.update(tx, c, course, { status: 'INACTIVE' }, { expected: ANY }),
    );
    expect(
      await status(
        as(admin, (tx, c) =>
          CurriculumService.create(tx, c, {
            programId: main.program,
            courseId: course,
            regulation: 'R2024',
            periodNo: 4,
            category: 'CORE',
          }),
        ),
      ),
    ).toBe(409);
  });
});

// =================================================================================================================
// Workstream B: cohort periods and sections
// =================================================================================================================
describe('CohortPeriodService and SectionService', () => {
  it('creates a cohort period in the same campus, rejects bad numbers, other campuses, duplicates; extension flag allows extra periods', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y);
    const c1 = await mkCohort();
    const admin = staff(T.users.admin);
    const mk = (s: Structure, termId: string, periodNo: number, isExtension?: boolean) =>
      as(admin, (tx, c) =>
        CohortPeriodService.create(tx, c, {
          cohortId: s.cohort,
          termId,
          periodNo,
          ...(isExtension !== undefined ? { isExtension } : {}),
        }),
      );
    const a = await mk(c1, term, 1);
    expect(await status(mk(c1, term, 2))).toBe(409); // cohort already runs a period in this term
    expect(await status(mk(other, term, 1))).toBe(409); // the term belongs to a different campus
    const term2 = await mkTerm(y);
    expect(await status(mk(c1, term2, 9))).toBe(400); // beyond duration without the extension flag
    expect(await status(mk(c1, term2, 9, true))).toBe(200);
    expect(await status(mk(c1, term2, 1))).toBe(409); // period number 1 already used
    const closed = await as(admin, (tx, c) =>
      CohortPeriodService.update(tx, c, a, { status: 'CLOSED' }, { expected: ANY }),
    );
    expect(closed.status).toBe('CLOSED');
    expect(await status(mkSection(a))).toBe(409); // a CLOSED cohort period takes no new sections
  });

  it('scopes cohort periods and sections through the program department; locked and closed terms refuse new periods', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y);
    const c2 = await mkCohort();
    const siblingCohort = await mkCohort(sibling);
    expect(
      await status(
        as(staff(extra.siblingDeptAdmin!), (tx, c) =>
          CohortPeriodService.create(tx, c, { cohortId: c2.cohort, termId: term, periodNo: 1 }),
        ),
      ),
    ).toBe(404);
    const p = await mkPeriod(term, c2);
    expect(await status(mkSection(p).then(() => undefined))).toBe(200);
    expect(
      await status(
        as(staff(extra.siblingDeptAdmin!), (tx, c) =>
          SectionService.create(tx, c, { cohortPeriodId: p, name: 'X' }),
        ),
      ),
    ).toBe(404);
    expect(
      await status(
        as(staff(T.users.faculty), (tx, c) =>
          SectionService.create(tx, c, { cohortPeriodId: p, name: 'X' }),
        ),
      ),
    ).toBe(403);
    const admin = staff(T.users.admin);
    const y2 = await mkYear(true);
    const t2 = await mkTerm(y2, main.campus, true);
    await as(admin, (tx, c) =>
      TermService.update(tx, c, t2, { status: 'CLOSED' }, { expected: ANY }),
    );
    expect(
      await status(
        as(admin, (tx, c) =>
          CohortPeriodService.create(tx, c, {
            cohortId: siblingCohort.cohort,
            termId: t2,
            periodNo: 1,
          }),
        ),
      ),
    ).toBe(409);
  });

  it('sections: unique names, capacity and deactivation respect the live roster', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const c3 = await mkCohort();
    const period = await mkPeriod(term, c3);
    const admin = staff(T.users.admin);
    const name = code('SEC');
    const sec = await mkSection(period, name, 2);
    expect(await status(mkSection(period, name))).toBe(409);
    expect(
      await status(
        as(admin, (tx, c) =>
          SectionService.create(tx, c, { cohortPeriodId: period, name: 'Z', capacity: 0 }),
        ),
      ),
    ).toBe(400);

    const s1 = await mkEnrolledStudent(c3);
    const s2 = await mkEnrolledStudent(c3);
    const e1 = idOf(await enrol(s1.id, period));
    const e2 = idOf(await enrol(s2.id, period));
    await place(e1, s1.id, sec, y.start);
    await place(e2, s2.id, sec, y.start);

    const full = await as(admin, (tx, c) => SectionService.getById(tx, c, sec));
    expect(full.memberCount).toBe(2);
    await expect(
      as(admin, (tx, c) =>
        SectionService.update(tx, c, sec, { capacity: 1 }, { expected: exp(full.version) }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      as(admin, (tx, c) =>
        SectionService.update(tx, c, sec, { status: 'INACTIVE' }, { expected: exp(full.version) }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const grown = await as(admin, (tx, c) =>
      SectionService.update(
        tx,
        c,
        sec,
        { capacity: 30, name: 'Renamed ' + name },
        { expected: exp(full.version) },
      ),
    );
    expect(grown).toMatchObject({ capacity: 30, memberCount: 2 });
    const roster = await as(admin, (tx, c) => SectionService.roster(tx, c, sec));
    expect(roster.map((r) => r.studentId).sort()).toEqual([s1.id, s2.id].sort());
    // a student never sees a roster
    expect(await status(as(student(s1.user), (tx, c) => SectionService.roster(tx, c, sec)))).toBe(
      403,
    );
  });
});

// =================================================================================================================
// Workstream B: term enrolments and section placement
// =================================================================================================================
describe('TermEnrollmentService', () => {
  let period!: string;
  let coh!: Structure;
  let term!: string;
  let yearInfo!: { id: string; start: string; end: string };
  beforeAll(async () => {
    yearInfo = await mkYear(true);
    term = await mkTerm(yearInfo, main.campus, true);
    coh = await mkCohort();
    period = await mkPeriod(term, coh);
  });

  it('enrols a student REGISTERED, copies period_no and term from the cohort period, audits, and replays by Idempotency-Key', async () => {
    const s = await mkEnrolledStudent(coh);
    const key = uuidv7();
    const admin = staff(T.users.admin);
    const call = () =>
      as(admin, (tx, c) =>
        TermEnrollmentService.create(
          tx,
          c,
          s.id,
          { cohortPeriodId: period, rollNumber: `R${seq++}`, reason: 'Registered for the term' },
          { idempotencyKey: key },
        ),
      );
    // the same key and the same (normalised) request: replay, not a second row
    const roll = `RL${RUN}${seq++}`;
    const first = await as(admin, (tx, c) =>
      TermEnrollmentService.create(
        tx,
        c,
        s.id,
        { cohortPeriodId: period, rollNumber: roll, reason: 'Registered for the term' },
        { idempotencyKey: key },
      ),
    );
    const second = await as(admin, (tx, c) =>
      TermEnrollmentService.create(
        tx,
        c,
        s.id,
        { cohortPeriodId: period, rollNumber: roll, reason: 'Registered for the term' },
        { idempotencyKey: key },
      ),
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(idOf(second)).toBe(idOf(first));
    expect(await status(call())).toBe(422); // same key, different request
    const e = await as(admin, (tx, c) => TermEnrollmentService.getById(tx, c, idOf(first), s.id));
    expect(e).toMatchObject({
      status: 'REGISTERED',
      termId: term,
      periodNo: 1,
      studentProgramId: s.sp,
      rollNumber: roll,
      currentSection: null,
      version: 1,
    });
    const audit = await adminQuery(
      `SELECT risk_tier, reason_text FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'enrollment.term.create'`,
      [T.orgId, e.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ risk_tier: 2, reason_text: 'Registered for the term' });
  });

  it('refuses duplicate, contradictory and ineligible enrolments', async () => {
    const s = await mkEnrolledStudent(coh);
    await enrol(s.id, period);
    await expect(enrol(s.id, period)).rejects.toMatchObject({ statusCode: 409 }); // same cohort period twice
    // a cohort period of ANOTHER cohort (the sibling department's) does not match this student's program enrolment
    const foreign = await mkPeriod(term, await mkCohort(sibling));
    await expect(enrol(s.id, foreign)).rejects.toMatchObject({ statusCode: 409 });
    // roll numbers are unique within a cohort period
    const t1 = await mkEnrolledStudent(coh);
    const t2 = await mkEnrolledStudent(coh);
    await enrol(t1.id, period, { rollNumber: `U${RUN}${seq}` });
    await expect(enrol(t2.id, period, { rollNumber: `U${RUN}${seq}` })).rejects.toMatchObject({
      statusCode: 409,
    });
    // suspended / graduated students and students without an ACTIVE program cannot be enrolled
    const susp = await mkEnrolledStudent(coh, 'SUSPENDED');
    await expect(enrol(susp.id, period)).rejects.toMatchObject({ statusCode: 409 });
    const noProgram = await mkUser();
    const orphan = uuidv7();
    await adminQuery(
      `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status) VALUES ($1, $2, $3, $4, '2024-07-01', 'ACTIVE')`,
      [orphan, T.orgId, noProgram, `NP${RUN}${studentSeq++}`],
    );
    await expect(enrol(orphan, period)).rejects.toMatchObject({ statusCode: 409 });
    // unknown student / cohort period
    await expect(enrol(uuidv7(), period)).rejects.toMatchObject({ statusCode: 404 });
    await expect(enrol(t1.id, uuidv7())).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serialises simultaneous enrolments of one student in one cohort period: exactly one is created', async () => {
    const s = await mkEnrolledStudent(coh);
    const results = await Promise.all([status(enrol(s.id, period)), status(enrol(s.id, period))]);
    expect([...results].sort()).toEqual([200, 409]);
    const rows = await adminQuery(
      `SELECT 1 FROM app.term_enrollments WHERE organization_id = $1 AND student_id = $2`,
      [T.orgId, s.id],
    );
    expect(rows).toHaveLength(1);
  });

  it('follows the status machine; terminal states are final; roll number edits need a reason and If-Match', async () => {
    const s = await mkEnrolledStudent(coh);
    const id = idOf(await enrol(s.id, period));
    const admin = staff(T.users.admin);
    const upd = (body: object, e: ExpectedVersion) =>
      as(admin, (tx, c) =>
        TermEnrollmentService.update(
          tx,
          c,
          id,
          { reason: 'Registrar decision', ...body },
          { expected: e, studentId: s.id },
        ),
      );
    await expect(upd({ status: 'PROMOTED' }, exp(1))).rejects.toMatchObject({ statusCode: 409 }); // REGISTERED -> PROMOTED
    await expect(upd({ status: 'ACTIVE' }, exp(7))).rejects.toMatchObject({ statusCode: 409 }); // stale
    expect((await upd({ status: 'ACTIVE' }, exp(1))).status).toBe('ACTIVE');
    expect((await upd({ status: 'ON_LEAVE' }, exp(2))).status).toBe('ON_LEAVE');
    expect((await upd({ status: 'ACTIVE' }, exp(3))).status).toBe('ACTIVE');
    const roll = await upd({ rollNumber: `NR${RUN}${seq++}` }, exp(4));
    expect(roll.version).toBe(5);
    expect((await upd({ status: 'COMPLETED' }, exp(5))).status).toBe('COMPLETED');
    await expect(upd({ status: 'ACTIVE' }, exp(6))).rejects.toMatchObject({ statusCode: 409 });
    expect(await status(upd({ rollNumber: null }, exp(6)))).toBe(409);
    const audit = await adminQuery(
      `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action = 'enrollment.term.update'`,
      [T.orgId, id],
    );
    expect(audit.length).toBe(5);
  });

  it('places, moves (closing the old membership the day before) and refuses same-section, wrong-period and terminal placements', async () => {
    const s = await mkEnrolledStudent(coh);
    const id = idOf(await enrol(s.id, period));
    const a = await mkSection(period);
    const b = await mkSection(period);
    const y2 = await mkYear(true);
    const t2 = await mkTerm(y2, main.campus, true);
    const p2 = await mkPeriod(t2, await mkCohort(sibling));
    const wrong = await mkSection(p2); // a section of ANOTHER cohort period

    const placed = await place(id, s.id, a, yearInfo.start);
    expect(placed.currentSection).toMatchObject({ sectionId: a, validFrom: yearInfo.start });
    await expect(place(id, s.id, a, '2101-07-01')).rejects.toMatchObject({ statusCode: 409 }); // already there
    await expect(place(id, s.id, wrong, '2101-07-01')).rejects.toMatchObject({ statusCode: 404 });
    await expect(place(id, s.id, b, yearInfo.start)).rejects.toMatchObject({ statusCode: 400 }); // not after the open one
    await expect(place(id, s.id, b, '2300-01-01')).rejects.toBeTruthy(); // outside the term
    const moved = await place(id, s.id, b, `${Number(yearInfo.start.slice(0, 4))}-07-10`);
    expect(moved.currentSection?.sectionId).toBe(b);
    const history = await adminQuery(
      `SELECT section_id, valid_from::text AS valid_from, valid_to::text AS valid_to FROM app.section_memberships
        WHERE organization_id = $1 AND term_enrollment_id = $2 ORDER BY valid_from`,
      [T.orgId, id],
    );
    expect(history).toEqual([
      {
        section_id: a,
        valid_from: yearInfo.start,
        valid_to: `${Number(yearInfo.start.slice(0, 4))}-07-09`,
      },
      { section_id: b, valid_from: `${Number(yearInfo.start.slice(0, 4))}-07-10`, valid_to: null },
    ]);

    // withdrawing closes the open membership in the same transaction, and the enrolment is final afterwards
    const admin = staff(T.users.admin);
    const w = await as(admin, (tx, c) =>
      TermEnrollmentService.update(
        tx,
        c,
        id,
        { status: 'WITHDRAWN', reason: 'Student withdrew' },
        { expected: ANY, studentId: s.id },
      ),
    );
    expect(w.currentSection).toBeNull();
    const open = await adminQuery(
      `SELECT 1 FROM app.section_memberships WHERE organization_id = $1 AND term_enrollment_id = $2 AND valid_to IS NULL`,
      [T.orgId, id],
    );
    expect(open).toHaveLength(0);
    await expect(place(id, s.id, a, '2101-08-01')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps a section within capacity under simultaneous placements and rolls a refused placement back completely', async () => {
    const sec = await mkSection(period, code('CAP'), 1);
    const s1 = await mkEnrolledStudent(coh);
    const s2 = await mkEnrolledStudent(coh);
    const e1 = idOf(await enrol(s1.id, period));
    const e2 = idOf(await enrol(s2.id, period));
    const results = await Promise.all([
      status(place(e1, s1.id, sec, yearInfo.start)),
      status(place(e2, s2.id, sec, yearInfo.start)),
    ]);
    expect([...results].sort()).toEqual([200, 409]);
    const members = await adminQuery(
      `SELECT 1 FROM app.section_memberships WHERE organization_id = $1 AND section_id = $2 AND valid_to IS NULL`,
      [T.orgId, sec],
    );
    expect(members).toHaveLength(1);
    // the loser left neither a membership nor an audit event for its enrolment
    const loser = results[0] === 409 ? e1 : e2;
    expect(
      await adminQuery(
        `SELECT 1 FROM app.section_memberships WHERE organization_id = $1 AND term_enrollment_id = $2`,
        [T.orgId, loser],
      ),
    ).toHaveLength(0);
    expect(
      await adminQuery(
        `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND resource_id = $2 AND action LIKE 'enrollment.section.%'`,
        [T.orgId, loser],
      ),
    ).toHaveLength(0);
  });

  it('a program enrolment with live term enrolments cannot be closed; it can once they are withdrawn', async () => {
    const s = await mkEnrolledStudent(coh);
    const id = idOf(await enrol(s.id, period));
    const admin = staff(T.users.admin);
    const close = () =>
      as(admin, (tx, c) =>
        StudentProgramService.close(
          tx,
          c,
          s.sp,
          { outcome: 'COMPLETED', endDate: '2024-09-01', reason: 'Program completed' },
          { expected: ANY, studentId: s.id },
        ),
      );
    await expect(close()).rejects.toMatchObject({ statusCode: 409 });
    // the database enforces the same rule for any writer
    await expect(
      adminQuery(
        `UPDATE app.student_programs SET status = 'COMPLETED', end_date = '2024-09-01' WHERE id = $1`,
        [s.sp],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await as(admin, (tx, c) =>
      TermEnrollmentService.update(
        tx,
        c,
        id,
        { status: 'WITHDRAWN', reason: 'Student withdrew' },
        { expected: ANY, studentId: s.id },
      ),
    );
    await expect(close()).resolves.toBeTruthy();
  });

  it('enforces scope and authorization: 403 without the permission, 404 out of scope, students only read their own', async () => {
    const s = await mkEnrolledStudent(coh);
    const id = idOf(await enrol(s.id, period));
    const read = (ctx: TrustedContext, studentId = s.id, enrollment = id) =>
      as(ctx, (tx, c) => TermEnrollmentService.getById(tx, c, enrollment, studentId));
    // HOD of the department reads; faculty hold no enrolment permission; another department / campus see nothing
    expect(await status(read(staff(T.users.hod)))).toBe(200);
    expect(await status(read(staff(T.users.campusAdmin)))).toBe(200);
    expect(await status(read(staff(T.users.faculty)))).toBe(403);
    expect(await status(read(staff(extra.siblingDeptAdmin!)))).toBe(404);
    expect(await status(read(staff(extra.otherCampusAdmin!)))).toBe(404);
    // the owning student reads; another student gets the same 404 as a missing record
    expect(await status(read(student(s.user)))).toBe(200);
    expect(await status(read(student(T.users.studentTwo)))).toBe(404);
    // path/owner mismatch is "not found under that student"
    expect(await status(read(staff(T.users.admin), T.students.one))).toBe(404);
    // writes: staff only, and only with the manage permission in scope
    const create = (ctx: TrustedContext) =>
      as(ctx, (tx, c) =>
        TermEnrollmentService.create(
          tx,
          c,
          s.id,
          { cohortPeriodId: period, reason: 'Registered' },
          { idempotencyKey: uuidv7() },
        ),
      );
    expect(await status(create(student(s.user)))).toBe(403);
    expect(await status(create(staff(T.users.hod)))).toBe(403);
    expect(await status(create(staff(extra.siblingDeptAdmin!)))).toBe(404);
    expect(await status(create(staff(extra.otherCampusAdmin!)))).toBe(404);
    // listing: a student sees only their own enrolments; an out-of-scope staff member gets 404 for the student
    const mine = await as(student(s.user), (tx, c) =>
      TermEnrollmentService.listForStudent(tx, c, s.id),
    );
    expect(mine.map((e) => e.id)).toEqual([id]);
    expect(
      await status(
        as(student(s.user), (tx, c) => TermEnrollmentService.listForStudent(tx, c, T.students.one)),
      ),
    ).toBe(404);
    expect(
      await status(
        as(staff(extra.otherCampusAdmin!), (tx, c) =>
          TermEnrollmentService.listForStudent(tx, c, s.id),
        ),
      ),
    ).toBe(404);
  });
});

// =================================================================================================================
// Database-level invariants (any writer, including privileged ones that bypass the services)
// =================================================================================================================
describe('database constraints and row security', () => {
  it('the runtime role cannot write term enrolments as a STUDENT actor, and a student session sees only own rows', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const cd = await mkCohort();
    const period = await mkPeriod(term, cd);
    const s = await mkEnrolledStudent(cd);
    const other = await mkEnrolledStudent(cd);
    const id = idOf(await enrol(s.id, period));
    idOf(await enrol(other.id, period));
    await expect(
      db.withTenant(student(s.user), (tx) =>
        tx.query(
          `INSERT INTO app.term_enrollments (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [uuidv7(), T.orgId, s.id, s.sp, period, term],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const rows = await db.withTenant(student(s.user), (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM app.term_enrollments WHERE cohort_period_id = $1`, [
        period,
      ]),
    );
    expect(rows.rows.map((r) => r.id)).toEqual([id]);
    // a STUDENT session cannot read a membership row of another student either
    const mem = await db.withTenant(student(s.user), (tx) =>
      tx.query(`SELECT 1 FROM app.section_memberships WHERE cohort_period_id = $1`, [period]),
    );
    expect(mem.rows).toHaveLength(0);
  });

  it('overlapping memberships, cross-period sections and edits to closed history are refused for every writer', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const ce = await mkCohort();
    const period = await mkPeriod(term, ce);
    const otherPeriod = await mkPeriod(await mkTerm(y, main.campus, true), await mkCohort(sibling));
    const a = await mkSection(period);
    const b = await mkSection(period);
    const foreign = await mkSection(otherPeriod);
    const s = await mkEnrolledStudent(ce);
    const e = idOf(await enrol(s.id, period));
    const insert = (section: string, from: string, to: string | null, cp = period) =>
      adminQuery(
        `INSERT INTO app.section_memberships (id, organization_id, term_enrollment_id, student_id, cohort_period_id, section_id, valid_from, valid_to, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9)`,
        [uuidv7(), T.orgId, e, s.id, cp, section, from, to, T.users.admin],
      );
    await expect(insert(foreign, y.start, null)).rejects.toMatchObject({ code: '23503' }); // section of another period
    await insert(a, y.start, `${y.start.slice(0, 4)}-07-31`);
    await expect(insert(b, `${y.start.slice(0, 4)}-07-15`, null)).rejects.toMatchObject({
      code: '23P01',
    }); // overlap
    await insert(b, `${y.start.slice(0, 4)}-08-01`, null);
    await expect(insert(a, `${y.start.slice(0, 4)}-09-01`, null)).rejects.toBeTruthy(); // a second OPEN row (unique index)
    await expect(
      adminQuery(
        `UPDATE app.section_memberships SET valid_to = NULL WHERE term_enrollment_id = $1 AND valid_to IS NOT NULL`,
        [e],
      ),
    ).rejects.toMatchObject({ code: '23001' }); // closed history is terminal
  });

  it('a LOCKED term freezes its enrolments; cohort periods cannot be added to a non-open term', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const cf = await mkCohort();
    const period = await mkPeriod(term, cf);
    const s = await mkEnrolledStudent(cf);
    const e = idOf(await enrol(s.id, period));
    const admin = staff(T.users.admin);
    await as(admin, (tx, c) =>
      TermService.update(tx, c, term, { status: 'CLOSED' }, { expected: ANY }),
    );
    await as(admin, (tx, c) =>
      TermService.update(
        tx,
        c,
        term,
        { status: 'LOCKED', reason: 'Term finished and audited' },
        { expected: ANY },
      ),
    );
    await expect(
      adminQuery(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [e]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      adminQuery(`UPDATE app.terms SET name = 'x' WHERE id = $1`, [term]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      adminQuery(
        `INSERT INTO app.cohort_periods (id, organization_id, cohort_id, term_id, period_no) VALUES ($1, $2, $3, $4, 2)`,
        [uuidv7(), T.orgId, cf.cohort, term],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it("cross-tenant references are impossible: composite foreign keys reject another tenant's parents", async () => {
    const y = await mkYear(true);
    await expect(
      adminQuery(
        `INSERT INTO app.terms (id, organization_id, campus_id, academic_year_id, code, name, start_date, end_date)
         VALUES ($1, $2, $3, $4, 'X', 'X', $5::date, $6::date)`,
        [uuidv7(), T.orgId, uuidv7(), y.id, y.start, y.end],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

// =================================================================================================================
// Medium-finding remediations (review of Milestone 3 Batch 1): M1 duration, M2 capacity, M3 final status, M4 code
// =================================================================================================================
type Tx = Parameters<Parameters<Database['withTenant']>[1]>[0];

describe('M1: a program duration cannot shrink below a period in use', () => {
  const adminUpdate = (program: string, durationPeriods: number) =>
    as(staff(T.users.admin), (tx, c) => ProgramService.update(tx, c, program, { durationPeriods }));
  const durationOf = async (program: string) =>
    (
      await adminQuery<{ d: number }>(
        'SELECT duration_periods AS d FROM app.programs WHERE id = $1',
        [program],
      )
    )[0]?.d;

  it('curriculum entries: the service answers 409, direct SQL is refused by the trigger, and the exact highest period is allowed', async () => {
    const st = await mkStructure(T.campusId, T.departmentId, 8);
    const admin = staff(T.users.admin);
    const course = await as(admin, (tx, c) =>
      CourseService.create(tx, c, {
        code: code('M1'),
        title: 'M1',
        credits: 2,
        courseType: 'THEORY',
      }),
    );
    await as(admin, (tx, c) =>
      CurriculumService.create(tx, c, {
        programId: st.program,
        courseId: course,
        regulation: 'R1',
        periodNo: 6,
        category: 'CORE',
      }),
    );
    await expect(adminUpdate(st.program, 5)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      adminQuery('UPDATE app.programs SET duration_periods = 5 WHERE id = $1', [st.program]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await durationOf(st.program)).toBe(8);
    await adminUpdate(st.program, 6);
    expect(await durationOf(st.program)).toBe(6);
    // a larger duration, and any change that keeps the duration, are unaffected
    await adminUpdate(st.program, 9);
    expect(await durationOf(st.program)).toBe(9);
  });

  it('cohort periods: regular periods block a shrink, extension periods do not, and direct SQL is refused too', async () => {
    const st = await mkStructure(T.campusId, T.departmentId, 8);
    const coh = await mkCohort(st);
    const y = await mkYear(true);
    const t1 = await mkTerm(y);
    const t2 = await mkTerm(y);
    const admin = staff(T.users.admin);
    await mkPeriod(t1, coh, 7);
    await as(admin, (tx, c) =>
      CohortPeriodService.create(tx, c, {
        cohortId: coh.cohort,
        termId: t2,
        periodNo: 9,
        isExtension: true,
      }),
    );
    await expect(adminUpdate(st.program, 6)).rejects.toMatchObject({ statusCode: 409 }); // period 7 is regular
    await expect(
      adminQuery('UPDATE app.programs SET duration_periods = 6 WHERE id = $1', [st.program]),
    ).rejects.toMatchObject({ code: '23514' });
    await adminUpdate(st.program, 7); // the extension period 9 does not count
    expect(await durationOf(st.program)).toBe(7);
    // the runtime role keeps its column grant (UPDATE duration_periods only through the service above)
    const grants = await adminQuery(
      `SELECT 1 FROM information_schema.column_privileges
        WHERE grantee = 'app_runtime' AND table_schema = 'app' AND table_name = 'programs'
          AND column_name = 'duration_periods' AND privilege_type = 'UPDATE'`,
    );
    expect(grants).toHaveLength(1);
  });
});

describe('M2 and M3: capacity and final statuses hold for direct writers', () => {
  let year!: { id: string; start: string; end: string };
  let period!: string;
  let coh!: Structure;
  beforeAll(async () => {
    year = await mkYear(true);
    const term = await mkTerm(year, main.campus, true);
    coh = await mkCohort();
    period = await mkPeriod(term, coh);
  });
  const insertMembership = (enrollment: string, studentId: string, section: string, from: string) =>
    adminQuery(
      `INSERT INTO app.section_memberships (id, organization_id, term_enrollment_id, student_id, cohort_period_id, section_id, valid_from, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
      [uuidv7(), T.orgId, enrollment, studentId, period, section, from, T.users.admin],
    );
  const newEnrolment = async () => {
    const s = await mkEnrolledStudent(coh);
    return { s, e: idOf(await enrol(s.id, period)) };
  };
  const yr = (): string => year.start.slice(0, 4);

  it('M2: the database refuses the seat beyond capacity; closed memberships free it; simultaneous direct inserts cannot exceed it', async () => {
    const sec = await mkSection(period, code('CAP'), 1);
    const a = await newEnrolment();
    const b = await newEnrolment();
    const c = await newEnrolment();
    await insertMembership(a.e, a.s.id, sec, `${yr()}-07-01`);
    await expect(insertMembership(b.e, b.s.id, sec, `${yr()}-07-01`)).rejects.toMatchObject({
      code: '23514',
    });
    // closing the first membership frees the seat for any writer
    await adminQuery(
      `UPDATE app.section_memberships SET valid_to = valid_from WHERE term_enrollment_id = $1`,
      [a.e],
    );
    await insertMembership(b.e, b.s.id, sec, `${yr()}-07-02`);
    // one seat, two simultaneous direct inserts into a second capacity-1 section: exactly one lands
    const sec2 = await mkSection(period, code('CAP'), 1);
    const results = await Promise.allSettled([
      insertMembership(a.e, a.s.id, sec2, `${yr()}-08-01`),
      insertMembership(c.e, c.s.id, sec2, `${yr()}-08-01`),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const open = await adminQuery(
      `SELECT 1 FROM app.section_memberships WHERE organization_id = $1 AND section_id = $2 AND valid_to IS NULL`,
      [T.orgId, sec2],
    );
    expect(open).toHaveLength(1);
  });

  const FINALS = ['WITHDRAWN', 'PROMOTED', 'COMPLETED'] as const;
  for (const target of FINALS) {
    for (const via of ['service', 'direct SQL'] as const) {
      it(`M3: ${target} through ${via} leaves no open membership (closed on its start date for a future-dated placement)`, async () => {
        const sec = await mkSection(period, code('FIN'));
        const { s, e } = await newEnrolment();
        const admin = staff(T.users.admin);
        const move = (to: string) =>
          via === 'service'
            ? as(admin, (tx, c) =>
                TermEnrollmentService.update(
                  tx,
                  c,
                  e,
                  { status: to as never, reason: 'Registrar decision' },
                  { expected: ANY, studentId: s.id },
                ),
              )
            : adminQuery('UPDATE app.term_enrollments SET status = $2 WHERE id = $1', [e, to]);
        await place(e, s.id, sec, year.start);
        if (target !== 'WITHDRAWN') await move('ACTIVE');
        await move(target);
        expect(
          await adminQuery(
            `SELECT 1 FROM app.section_memberships WHERE term_enrollment_id = $1 AND valid_to IS NULL`,
            [e],
          ),
        ).toHaveLength(0);
        const rows = await adminQuery<{ valid_from: string; valid_to: string }>(
          `SELECT valid_from::text AS valid_from, valid_to::text AS valid_to FROM app.section_memberships WHERE term_enrollment_id = $1`,
          [e],
        );
        expect(rows).toEqual([{ valid_from: year.start, valid_to: year.start }]);
      });
    }
  }

  it('M3: a placement that started in the past is closed on the campus-local date of the status change', async () => {
    const admin = staff(T.users.admin);
    const y = await as(admin, (tx, c) =>
      AcademicYearService.create(tx, c, {
        label: code('PAST'),
        startDate: '2020-06-01',
        endDate: '2021-05-31',
      }),
    );
    await as(admin, (tx, c) =>
      AcademicYearService.update(tx, c, y, { status: 'ACTIVE' }, { expected: ANY }),
    );
    const term = await mkTerm({ id: y, start: '2020-06-01', end: '2021-05-31' }, main.campus, true);
    const c2 = await mkCohort();
    const p2 = await mkPeriod(term, c2);
    const sec = await mkSection(p2);
    const s = await mkEnrolledStudent(c2);
    const e = idOf(await enrol(s.id, p2));
    await place(e, s.id, sec, '2020-07-01');
    await adminQuery(`UPDATE app.term_enrollments SET status = 'WITHDRAWN' WHERE id = $1`, [e]);
    const [today] = await adminQuery<{ d: string }>(
      `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`,
    );
    const [m] = await adminQuery<{ valid_to: string }>(
      `SELECT valid_to::text AS valid_to FROM app.section_memberships WHERE term_enrollment_id = $1`,
      [e],
    );
    expect(m?.valid_to).toBe(today?.d);
  });
});

describe('M4: closing a program (or graduating / discontinuing) with live term enrolments', () => {
  it('is refused with STUDENT_PROGRAM_HAS_LIVE_TERM_ENROLLMENTS, writes nothing and audits nothing; works after withdrawal', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const coh = await mkCohort();
    const period = await mkPeriod(term, coh);
    const s = await mkEnrolledStudent(coh);
    const e = idOf(await enrol(s.id, period));
    const admin = staff(T.users.admin);
    const version = async () =>
      (
        await adminQuery<{ v: number; st: string }>(
          `SELECT version AS v, status AS st FROM app.students WHERE id = $1`,
          [s.id],
        )
      )[0]!;
    const before = await version();
    const audits = async () =>
      (
        await adminQuery(
          `SELECT 1 FROM app.audit_events WHERE organization_id = $1 AND subject_student_id = $2
              AND action IN ('student.status.change', 'student_program.close')`,
          [T.orgId, s.id],
        )
      ).length;

    for (const target of ['GRADUATED', 'DISCONTINUED'] as const) {
      await expect(
        as(admin, (tx, c) =>
          StudentStatusService.change(
            tx,
            c,
            s.id,
            { status: target, reason: 'Programme finished' },
            { expected: exp(before.v) },
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: PROGRAM_HAS_LIVE_TERM_ENROLLMENTS });
    }
    await expect(
      as(admin, (tx, c) =>
        StudentProgramService.close(
          tx,
          c,
          s.sp,
          { outcome: 'COMPLETED', endDate: '2024-09-01', reason: 'Program completed' },
          { expected: ANY, studentId: s.id },
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: PROGRAM_HAS_LIVE_TERM_ENROLLMENTS });
    expect(await version()).toEqual(before); // student untouched
    const [sp] = await adminQuery<{ status: string }>(
      'SELECT status FROM app.student_programs WHERE id = $1',
      [s.sp],
    );
    expect(sp?.status).toBe('ACTIVE');
    expect(await audits()).toBe(0);

    await as(admin, (tx, c) =>
      TermEnrollmentService.update(
        tx,
        c,
        e,
        { status: 'WITHDRAWN', reason: 'Student withdrew' },
        { expected: ANY, studentId: s.id },
      ),
    );
    await as(admin, (tx, c) =>
      StudentStatusService.change(
        tx,
        c,
        s.id,
        { status: 'GRADUATED', reason: 'Programme finished' },
        { expected: exp(before.v) },
      ),
    );
    expect((await version()).st).toBe('GRADUATED');
    expect(await audits()).toBeGreaterThan(0);
  });
});

// =================================================================================================================
// M5: real overlapping transactions, ordered with the pg_stat_activity lock-wait helper (no sleeps decide the order)
// =================================================================================================================
const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};
async function waitUntilBlocked(like: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await adminQuery(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = $2
          AND wait_event_type = 'Lock' AND query LIKE $1`,
      [like, WAITER_APP],
    );
    if (r.length > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`no backend ever blocked on a statement like ${like}`);
}
type Settled = { ok: true } | { ok: false; e: unknown };
const settle = (p: Promise<unknown>): Promise<Settled> =>
  p.then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, e }),
  );
/**
 * The HOLDER does its work inside an open transaction and pauses before commit. The WAITER (separate pool) then starts;
 * the test waits until PostgreSQL reports it blocked on a statement matching `like`, and only then lets the holder commit.
 */
async function race(
  holder: (tx: Tx, ctx: TrustedContext) => Promise<unknown>,
  waiter: (tx: Tx, ctx: TrustedContext) => Promise<unknown>,
  like: string,
): Promise<{ holder: Settled; waiter: Settled }> {
  const admin = staff(T.users.admin);
  const reached = gate();
  const release = gate();
  const h = settle(
    db.withTenant(admin, async (tx) => {
      await holder(tx, admin);
      reached.open();
      await release.wait;
    }),
  );
  // the holder failing before it reached the gate must fail the test instead of hanging it
  await Promise.race([
    reached.wait,
    h.then((r) => {
      if (!r.ok)
        throw r.e instanceof Error ? r.e : new Error('holder failed before reaching the gate');
    }),
  ]);
  const w = settle(waiterDb.withTenant(admin, (tx) => waiter(tx, admin)));
  await waitUntilBlocked(like);
  release.open();
  return { holder: await h, waiter: await w };
}
const code409 = (r: Settled, c?: string) => {
  expect(r.ok).toBe(false);
  const e = (r as { e: unknown }).e;
  expect(e).toBeInstanceOf(AppError);
  expect((e as AppError).statusCode).toBe(409);
  if (c) expect((e as AppError).code).toBe(c);
};

describe('M5: races that must resolve to one valid state', () => {
  it('program closure versus term-enrolment creation (both orders)', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const coh = await mkCohort();
    const period = await mkPeriod(term, coh);
    const closeOf = (sp: string, st: string) => (tx: Tx, c: TrustedContext) =>
      StudentProgramService.close(
        tx,
        c,
        sp,
        { outcome: 'COMPLETED', endDate: '2024-09-01', reason: 'Program completed' },
        { expected: ANY, studentId: st },
      );
    const enrolOf = (st: string) => (tx: Tx, c: TrustedContext) =>
      TermEnrollmentService.create(
        tx,
        c,
        st,
        { cohortPeriodId: period, reason: 'Registered for the term' },
        { idempotencyKey: uuidv7() },
      );

    // (a) the enrolment commits first: the close waits for its row lock, then sees the live enrolment
    const a = await mkEnrolledStudent(coh);
    const ra = await race(
      enrolOf(a.id),
      closeOf(a.sp, a.id),
      'SELECT id, student_id, program_id%FROM app.student_programs%FOR NO KEY UPDATE',
    );
    expect(ra.holder.ok).toBe(true);
    code409(ra.waiter, PROGRAM_HAS_LIVE_TERM_ENROLLMENTS);
    expect(
      (
        await adminQuery<{ status: string }>(
          'SELECT status FROM app.student_programs WHERE id = $1',
          [a.sp],
        )
      )[0]?.status,
    ).toBe('ACTIVE');
    expect(
      await adminQuery(
        `SELECT 1 FROM app.term_enrollments WHERE student_id = $1 AND status = 'REGISTERED'`,
        [a.id],
      ),
    ).toHaveLength(1);

    // (b) the close commits first: the enrolment waits for the program row, then finds no ACTIVE program
    const b = await mkEnrolledStudent(coh);
    const rb = await race(
      closeOf(b.sp, b.id),
      enrolOf(b.id),
      'SELECT id, cohort_id FROM app.student_programs%FOR SHARE',
    );
    expect(rb.holder.ok).toBe(true);
    code409(rb.waiter);
    expect(
      (
        await adminQuery<{ status: string }>(
          'SELECT status FROM app.student_programs WHERE id = $1',
          [b.sp],
        )
      )[0]?.status,
    ).toBe('COMPLETED');
    expect(
      await adminQuery('SELECT 1 FROM app.term_enrollments WHERE student_id = $1', [b.id]),
    ).toHaveLength(0);
  });

  it('academic-year closure versus term creation (both orders)', async () => {
    const admin = staff(T.users.admin);
    const closeYear = (id: string) => (tx: Tx, c: TrustedContext) =>
      AcademicYearService.update(tx, c, id, { status: 'CLOSED' }, { expected: ANY });
    const addTerm =
      (y: { id: string; start: string; end: string }) => (tx: Tx, c: TrustedContext) =>
        TermService.create(tx, c, {
          campusId: main.campus,
          academicYearId: y.id,
          code: code('RT'),
          name: 'Race term',
          startDate: y.start,
          endDate: y.end,
        });
    const termsOf = async (id: string) =>
      (await adminQuery('SELECT 1 FROM app.terms WHERE academic_year_id = $1', [id])).length;
    const statusOf = async (id: string) =>
      (
        await adminQuery<{ status: string }>(
          'SELECT status FROM app.academic_years WHERE id = $1',
          [id],
        )
      )[0]?.status;

    // (a) the year closes first: term creation waits on the year row, then refuses a CLOSED year
    const ya = await mkYear(true);
    const ra = await race(
      closeYear(ya.id),
      addTerm(ya),
      'SELECT status, start_date%FROM app.academic_years%FOR SHARE',
    );
    expect(ra.holder.ok).toBe(true);
    code409(ra.waiter);
    expect(await statusOf(ya.id)).toBe('CLOSED');
    expect(await termsOf(ya.id)).toBe(0);

    // (b) the term is created first: the close waits, then the guard sees the PLANNED term
    const yb = await mkYear(true);
    const rb = await race(
      addTerm(yb),
      closeYear(yb.id),
      'SELECT id, label, start_date%FOR NO KEY UPDATE',
    );
    expect(rb.holder.ok).toBe(true);
    code409(rb.waiter);
    expect(await statusOf(yb.id)).toBe('ACTIVE');
    expect(await termsOf(yb.id)).toBe(1);
    expect(admin).toBeDefined();
  });

  it('section deactivation / capacity change versus student placement (both orders)', async () => {
    const y = await mkYear(true);
    const term = await mkTerm(y, main.campus, true);
    const coh = await mkCohort();
    const period = await mkPeriod(term, coh);
    const patch = (section: string, version: number, body: object) => (tx: Tx, c: TrustedContext) =>
      SectionService.update(tx, c, section, body, { expected: exp(version) });
    const placeOf = (e: string, st: string, section: string) => (tx: Tx, c: TrustedContext) =>
      TermEnrollmentService.placeSection(
        tx,
        c,
        e,
        { sectionId: section, validFrom: y.start, reason: 'Section allocation' },
        { studentId: st },
      );
    const open = async (section: string) =>
      (
        await adminQuery(
          'SELECT 1 FROM app.section_memberships WHERE section_id = $1 AND valid_to IS NULL',
          [section],
        )
      ).length;
    const fresh = async (capacity: number | undefined, seated: number) => {
      const sec = await mkSection(period, code('RS'), capacity);
      for (let i = 0; i < seated; i++) {
        const x = await mkEnrolledStudent(coh);
        await place(idOf(await enrol(x.id, period)), x.id, sec, y.start);
      }
      const version = (
        await adminQuery<{ v: number }>('SELECT version AS v FROM app.sections WHERE id = $1', [
          sec,
        ])
      )[0]!.v;
      const joiner = await mkEnrolledStudent(coh);
      return { sec, version, joiner, e: idOf(await enrol(joiner.id, period)) };
    };

    // (a) the placement commits first; the PATCH then sees a populated section (deactivation, and capacity below the roster)
    for (const body of [{ status: 'INACTIVE' }, { capacity: 1 }]) {
      const f = await fresh(2, 1);
      const r = await race(
        placeOf(f.e, f.joiner.id, f.sec),
        patch(f.sec, f.version, body),
        'SELECT s.id, s.cohort_period_id, s.name%FOR UPDATE',
      );
      expect(r.holder.ok, JSON.stringify(body)).toBe(true);
      code409(r.waiter);
      expect(await open(f.sec)).toBe(2);
      expect(
        (
          await adminQuery<{ status: string; capacity: number }>(
            'SELECT status, capacity FROM app.sections WHERE id = $1',
            [f.sec],
          )
        )[0],
      ).toEqual({ status: 'ACTIVE', capacity: 2 });
    }

    // (b) the deactivation commits first; the placement waits on the section row, then refuses an INACTIVE section
    const g = await fresh(undefined, 0);
    const rb = await race(
      patch(g.sec, g.version, { status: 'INACTIVE' }),
      placeOf(g.e, g.joiner.id, g.sec),
      'SELECT status, capacity, name FROM app.sections%FOR UPDATE',
    );
    expect(rb.holder.ok).toBe(true);
    code409(rb.waiter);
    expect(await open(g.sec)).toBe(0);
    expect(
      (
        await adminQuery<{ status: string }>('SELECT status FROM app.sections WHERE id = $1', [
          g.sec,
        ])
      )[0]?.status,
    ).toBe('INACTIVE');
  });
});
