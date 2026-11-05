import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as argon2 from 'argon2';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Task 9 (doc 35 §3, §5):
//  1. Activation integrity: PATCH /academics/terms/:id {status:'ACTIVE'} and POST /academics/terms/:id/activation both
//     go through TermService.update, which refuses an incomplete term with the same 409 SETUP_INCOMPLETE; If-Match,
//     scope, lifecycle, audit and non-activating edits are unchanged; races and retries resolve to one activation.
//  2. The canonical `/faculty` assignment view and "assign offerings" (`04` Part 16) over the existing assignment service.
// College annual (YEAR) and semester (SEMESTER) programmes and a university-style semester programme share one tenant.

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const RUN = randomBytes(3).toString('hex').toUpperCase();
const url = inject('dbRuntimeUrl');
const db = new Database(createPool({ connectionString: url, ssl: false, max: 10 }));
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});
const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const D = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface Session {
  cookie: string;
  csrf: string;
}
let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const s = {} as Record<
  'admin' | 'campusAdmin' | 'hod' | 'faculty' | 'student' | 'registrarOrg' | 'foreign',
  Session
>;
async function login(email: string): Promise<Session> {
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
const call = (
  method: 'GET' | 'POST' | 'PATCH',
  who: Session,
  path: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1${path}`,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { session_token: who.cookie },
    headers: {
      ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'x-csrf-token': who.csrf }),
      ...headers,
    },
  });
type Res = Awaited<ReturnType<typeof call>>;
const dataOf = <X>(r: Res): X => r.json<{ data: X }>().data;
const created = (r: Res): string => {
  expect([200, 201], r.body).toContain(r.statusCode);
  return dataOf<{ id: string }>(r).id;
};
const ok = (r: Res, status = 200) => expect(r.statusCode, r.body).toBe(status);
const ifMatch = (v: number) => ({ 'if-match': `"${v}"` });
const errorOf = (r: Res) =>
  r.json<{ error: { code: string; message: string; details?: Array<{ field: string }> } }>().error;
const viaPatch = (who: Session, term: string, v: number) =>
  call('PATCH', who, `/academics/terms/${term}`, { status: 'ACTIVE' }, ifMatch(v));
const viaPost = (who: Session, term: string, v: number) =>
  call('POST', who, `/academics/terms/${term}/activation`, {}, ifMatch(v));
const termRow = async (id: string) =>
  (
    await adminQuery<{ status: string; version: number }>(
      `SELECT status, version FROM app.terms WHERE id = $1`,
      [id],
    )
  )[0]!;
const activationAudits = async (id: string) =>
  Number(
    (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM app.audit_events WHERE resource_id = $1 AND action = 'academic.term.update'`,
        [id],
      )
    )[0]!.n,
  );

async function insertIn(table: string, row: Record<string, unknown>): Promise<string> {
  const id = (row['id'] as string | undefined) ?? uuidv7();
  const rest = Object.entries(row).filter(([k]) => k !== 'id');
  const cols = ['id', 'organization_id', ...rest.map(([k]) => k)];
  await adminQuery(
    `INSERT INTO app.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [id, T.orgId, ...rest.map(([, v]) => v)],
  );
  return id;
}
async function employee(user: string, dept: string, code: string): Promise<string> {
  const e = await insertIn('employees', {
    user_id: user,
    employee_code: `${code}${RUN}`,
    employee_type: 'FACULTY',
    joining_date: '2020-06-01',
    status: 'ACTIVE',
  });
  await insertIn('employee_postings', {
    employee_id: e,
    department_id: dept,
    valid_from: '2020-06-01',
    is_primary: true,
  });
  return e;
}

const X = {} as Record<
  | 'campus2'
  | 'dept2'
  | 'year'
  | 'plannedYear'
  | 'ptYear'
  | 'ptSem'
  | 'bcom'
  | 'bca'
  | 'mtech'
  | 'emp1'
  | 'emp2'
  | 'course',
  string
>;

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  T = await createIsolatedTenant(hash);
  OTHER = await createIsolatedTenant(hash);
  s.admin = await login(T.emails.admin);
  s.campusAdmin = await login(T.emails.campusAdmin); // CAMPUS_ADMIN of T.campusId
  s.hod = await login(T.emails.hod); // HOD of T.departmentId
  s.faculty = await login(T.emails.faculty);
  s.student = await login(T.emails.studentOne);
  s.registrarOrg = await login(T.emails.registrarOrg);
  s.foreign = await login(OTHER.emails.admin);

  X.campus2 = created(
    await call('POST', s.admin, '/organization/campuses', {
      name: 'Second campus',
      code: `C2${RUN}`,
      timezone: 'Asia/Kolkata',
    }),
  );
  X.dept2 = created(
    await call('POST', s.admin, '/organization/departments', {
      campusId: X.campus2,
      name: 'Second campus school',
      code: `D2${RUN}`,
    }),
  );
  X.year = created(
    await call('POST', s.admin, '/academics/academic-years', {
      label: `AY-${RUN}`,
      startDate: D(5),
      endDate: D(360),
    }),
  );
  ok(
    await call(
      'PATCH',
      s.admin,
      `/academics/academic-years/${X.year}`,
      { status: 'ACTIVE' },
      ifMatch(1),
    ),
  );
  X.plannedYear = created(
    await call('POST', s.admin, '/academics/academic-years', {
      label: `AY2-${RUN}`,
      startDate: D(400),
      endDate: D(700),
    }),
  );
  const pt = async (code: string, label: string) =>
    created(
      await call('POST', s.admin, '/academics/period-types', {
        code,
        label,
        labelPlural: `${label}s`,
      }),
    );
  X.ptYear = await pt('YEAR', 'Year');
  X.ptSem = await pt('SEMESTER', 'Semester');
  const program = async (dept: string, type: string, code: string, n: number, ppy: number) =>
    created(
      await call('POST', s.admin, '/academics/programs', {
        departmentId: dept,
        periodTypeId: type,
        name: code,
        code: `${code}${RUN}`,
        degreeLevel: 'UG',
        durationPeriods: n,
        periodsPerYear: ppy,
      }),
    );
  X.bcom = await program(T.departmentId, X.ptYear, 'BCOM', 3, 1); // college annual
  X.bca = await program(T.departmentId, X.ptSem, 'BCA', 6, 2); // college semester
  X.mtech = await program(X.dept2, X.ptSem, 'MTECH', 4, 2); // university-style semester, second campus
  X.course = created(
    await call('POST', s.admin, '/academics/courses', {
      code: `ACC${RUN}`,
      title: 'Accounting',
      credits: 4,
      courseType: 'THEORY',
      owningDepartmentId: T.departmentId,
    }),
  );
  X.emp1 = await employee(T.users.faculty, T.departmentId, 'E1');
  const other = uuidv7();
  await adminQuery(
    `INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, $3, 'Second teacher', 'ACTIVE')`,
    [other, T.orgId, `t2-${RUN.toLowerCase()}@college.test`],
  );
  X.emp2 = await employee(other, X.dept2, 'E2');
});

afterAll(async () => {
  await app.close();
  await db.close();
  const k = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await k.connect();
  try {
    await k.query('BEGIN');
    await k.query('SET LOCAL session_replication_role = replica');
    for (const t of [
      'faculty_assignments',
      'course_offerings',
      'cohort_periods',
      'terms',
      'academic_years',
      'cohorts',
      'programs',
      'period_types',
      'courses',
    ]) {
      await k.query(`DELETE FROM app.${t} WHERE organization_id = $1`, [T.orgId]);
    }
    await k.query('COMMIT');
  } finally {
    await k.query('ROLLBACK').catch(() => undefined);
    await k.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

/** A PLANNED term on a campus with one ACTIVE cohort period of `program`; optionally a published, staffed offering. */
async function term(opts: {
  program: string;
  campus?: string;
  year?: string;
  code: string;
  offering?: 'none' | 'published' | 'staffed';
  employee?: string;
}): Promise<{ id: string; offering?: string; assignment?: string }> {
  const campus = opts.campus ?? T.campusId;
  const id = created(
    await call('POST', s.admin, '/academics/terms', {
      campusId: campus,
      academicYearId: opts.year ?? X.year,
      code: `${opts.code}-${RUN}`,
      name: opts.code,
      startDate: D(opts.year ? 410 : 10),
      endDate: D(opts.year ? 690 : 350),
    }),
  );
  const cohort = created(
    await call('POST', s.admin, '/academics/cohorts', {
      programId: opts.program,
      admissionYear: 2000 + Math.floor(Math.random() * 190),
      intakeCode: `I${randomBytes(2).toString('hex').toUpperCase()}`,
      name: `${opts.code} intake`,
    }),
  );
  const cp = created(
    await call('POST', s.admin, '/academics/cohort-periods', {
      cohortId: cohort,
      termId: id,
      periodNo: 1,
    }),
  );
  if ((opts.offering ?? 'staffed') === 'none') return { id };
  const offering = created(
    await call('POST', s.admin, '/academics/course-offerings', {
      termId: id,
      courseId: X.course,
      cohortPeriodId: cp,
      offeringKind: 'CORE',
      registrationPolicy: 'MANUAL',
    }),
  );
  ok(
    await call(
      'PATCH',
      s.admin,
      `/academics/course-offerings/${offering}`,
      { status: 'PUBLISHED' },
      ifMatch(1),
    ),
  );
  if (opts.offering === 'published') return { id, offering };
  const assignment = created(
    await call('POST', s.admin, `/academics/course-offerings/${offering}/faculty-assignments`, {
      employeeId: opts.employee ?? X.emp1,
      teachingRole: 'PRIMARY',
      validFrom: opts.year ? D(410) : D(10),
      reason: 'Subject teacher',
    }),
  );
  return { id, offering, assignment };
}

describe('activation integrity: one rule on every path', () => {
  it('PATCH and POST refuse an incomplete term identically; nothing changes', async () => {
    const t = await term({ program: X.bcom, code: 'EMPTY', offering: 'none' });
    const a = await viaPatch(s.admin, t.id, 1);
    const b = await viaPost(s.admin, t.id, 1);
    for (const r of [a, b]) expect(r.statusCode, r.body).toBe(409);
    const ea = errorOf(a);
    const eb = errorOf(b);
    expect(ea.code).toBe('SETUP_INCOMPLETE');
    expect({ ...ea, requestId: undefined }).toEqual({ ...eb, requestId: undefined });
    expect(ea.details!.map((d) => d.field)).toEqual(['NO_PUBLISHED_OFFERING']);
    expect(await termRow(t.id)).toEqual({ status: 'PLANNED', version: 1 });
    expect(await activationAudits(t.id)).toBe(0);
  });

  it('an unstaffed offering blocks both paths; a PLANNED academic year blocks both with its own code', async () => {
    const t = await term({ program: X.bca, code: 'UNSTAFFED', offering: 'published' });
    for (const r of [await viaPatch(s.admin, t.id, 1), await viaPost(s.admin, t.id, 1)]) {
      expect(r.statusCode).toBe(409);
      expect(errorOf(r).details).toEqual([{ field: 'OFFERING_WITHOUT_TEACHER', message: '1' }]);
    }
    const y = await term({ program: X.bca, code: 'NEXTYEAR', year: X.plannedYear });
    for (const r of [await viaPatch(s.admin, y.id, 1), await viaPost(s.admin, y.id, 1)]) {
      expect(r.statusCode).toBe(409);
      expect(errorOf(r).details!.map((d) => d.field)).toEqual(['ACADEMIC_YEAR_NOT_ACTIVE']);
    }
  });

  it('If-Match first: missing 428, stale 409 CONFLICT (not a readiness answer); non-activating edits still work', async () => {
    const t = await term({ program: X.bcom, code: 'EDITS', offering: 'none' });
    expect(
      (await call('PATCH', s.admin, `/academics/terms/${t.id}`, { status: 'ACTIVE' })).statusCode,
    ).toBe(428);
    expect(
      (await call('POST', s.admin, `/academics/terms/${t.id}/activation`, {})).statusCode,
    ).toBe(428);
    for (const r of [await viaPatch(s.admin, t.id, 9), await viaPost(s.admin, t.id, 9)]) {
      expect(r.statusCode).toBe(409);
      expect(errorOf(r).code).toBe('CONFLICT');
    }
    // renaming and re-dating an unready PLANNED term are not activations
    ok(await call('PATCH', s.admin, `/academics/terms/${t.id}`, { name: 'Renamed' }, ifMatch(1)));
    ok(await call('PATCH', s.admin, `/academics/terms/${t.id}`, { endDate: D(340) }, ifMatch(2)));
    expect(await termRow(t.id)).toEqual({ status: 'PLANNED', version: 3 });
  });

  it('a ready college annual term activates via PATCH, a ready semester term via POST; lifecycle continues', async () => {
    const annual = await term({ program: X.bcom, code: 'ANNUAL' });
    const sem = await term({ program: X.bca, code: 'ODDSEM' });
    const a = await viaPatch(s.admin, annual.id, 1);
    expect(a.statusCode, a.body).toBe(200);
    expect(a.headers.etag).toBe('"2"');
    const b = await viaPost(s.campusAdmin, sem.id, 1);
    expect(b.statusCode, b.body).toBe(200);
    expect(dataOf<{ status: string }>(b).status).toBe('ACTIVE');
    // closing and locking an ACTIVE term are untouched by the readiness rule
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/terms/${annual.id}`,
        { status: 'CLOSED' },
        ifMatch(2),
      ),
    );
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/terms/${annual.id}`,
        { status: 'LOCKED', reason: 'Results published' },
        ifMatch(3),
      ),
    );
    for (const r of [await viaPatch(s.admin, annual.id, 4), await viaPost(s.admin, annual.id, 4)]) {
      expect(r.statusCode).toBe(409); // a LOCKED term cannot change
    }
  });

  it('a university-style semester term on the second campus: scope is identical on both paths', async () => {
    const t = await term({ program: X.mtech, campus: X.campus2, code: 'UNISEM', employee: X.emp2 });
    for (const r of [await viaPatch(s.campusAdmin, t.id, 1), await viaPost(s.campusAdmin, t.id, 1)])
      expect(r.statusCode).toBe(404); // campus admin of campus 1
    for (const r of [await viaPatch(s.foreign, t.id, 1), await viaPost(s.foreign, t.id, 1)])
      expect(r.statusCode).toBe(404);
    for (const r of [await viaPatch(s.faculty, t.id, 1), await viaPost(s.faculty, t.id, 1)])
      expect(r.statusCode).toBe(403);
    ok(await viaPost(s.registrarOrg, t.id, 1));
  });

  it('an activation that also moves the dates is checked on the new dates and rolls back', async () => {
    const t = await term({ program: X.bca, code: 'MOVEEND' });
    // the teacher's assignment now ends exactly on the term end (D(350)): ready as the term stands
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/faculty-assignments/${t.assignment}`,
        { validTo: D(350), reason: 'Contract ends with the term' },
        ifMatch(1),
      ),
    );
    const moved = await call(
      'PATCH',
      s.admin,
      `/academics/terms/${t.id}`,
      { status: 'ACTIVE', endDate: D(355) },
      ifMatch(1),
    );
    expect(moved.statusCode, moved.body).toBe(409);
    expect(errorOf(moved).details).toEqual([{ field: 'OFFERING_WITHOUT_TEACHER', message: '1' }]);
    const after = await adminQuery<{ status: string; version: number; end_date: string }>(
      `SELECT status, version, end_date::text FROM app.terms WHERE id = $1`,
      [t.id],
    );
    expect(after[0]).toEqual({ status: 'PLANNED', version: 1, end_date: D(350) });
    expect(await activationAudits(t.id)).toBe(0);
    ok(await viaPatch(s.admin, t.id, 1)); // the same term on its own dates is ready
  });

  it('a retry after activation is a no-op on both paths: one audit row, version unchanged', async () => {
    const t = await term({ program: X.bca, code: 'RETRY' });
    ok(await viaPatch(s.admin, t.id, 1));
    const again = [await viaPatch(s.admin, t.id, 2), await viaPost(s.admin, t.id, 2)];
    for (const r of again) {
      expect(r.statusCode).toBe(200);
      expect(dataOf<{ version: number }>(r).version).toBe(2);
    }
    expect(await activationAudits(t.id)).toBe(1);
  });

  it('concurrent PATCH and POST activations of one version: exactly one wins, one audit row', async () => {
    for (let i = 0; i < 3; i += 1) {
      const t = await term({ program: X.bcom, code: `RACE${i}` });
      const res = await Promise.all([viaPatch(s.admin, t.id, 1), viaPost(s.admin, t.id, 1)]);
      expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(errorOf(res.find((r) => r.statusCode === 409)!).code).toBe('CONFLICT');
      expect(await termRow(t.id)).toEqual({ status: 'ACTIVE', version: 2 });
      expect(await activationAudits(t.id)).toBe(1);
    }
  });

  it('activation racing the cancellation of the only offering ends in a serial outcome', async () => {
    for (let i = 0; i < 3; i += 1) {
      const t = await term({ program: X.bca, code: `CANCEL${i}` });
      const [act, cancel] = await Promise.all([
        i % 2 === 0 ? viaPatch(s.admin, t.id, 1) : viaPost(s.admin, t.id, 1),
        call(
          'PATCH',
          s.admin,
          `/academics/course-offerings/${t.offering}`,
          { status: 'CANCELLED', reason: 'Not enough students' },
          ifMatch(2),
        ),
      ]);
      expect(cancel.statusCode, cancel.body).toBe(200);
      const row = await termRow(t.id);
      if (act.statusCode === 200) {
        expect(row.status).toBe('ACTIVE'); // activation first, then the (legal) cancellation
      } else {
        expect(act.statusCode).toBe(409); // cancellation first: the term is no longer ready
        expect(errorOf(act).details!.map((d) => d.field)).toEqual(['NO_PUBLISHED_OFFERING']);
        expect(row).toEqual({ status: 'PLANNED', version: 1 });
      }
    }
  });

  it('the only SQL writer of app.terms is TermService (no alternate route can skip the rule)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /UPDATE\s+app\.terms\b/.test(readFileSync(p, 'utf8')))
          hits.push(p.slice(p.indexOf('src/')));
      }
    };
    walk(join(import.meta.dirname, '../../src'));
    expect(hits).toEqual(['src/modules/academics/calendar.service.ts']);
  });
});

describe('/faculty assignment view and assign offerings (canonical Part 16)', () => {
  type Row = {
    id: string;
    courseOfferingId: string;
    employeeId: string;
    teachingRole: string;
    termId: string;
    offeringCode: string;
    offeringStatus: string;
  };
  const view = (who: Session, emp: string, q = '') =>
    call('GET', who, `/faculty/employees/${emp}/assignments${q}`);

  it('the view lists the same rows as the offering routes, with the offering and term (workload view)', async () => {
    const r = await view(s.admin, X.emp1);
    ok(r);
    const rows = dataOf<Row[]>(r);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'courseOfferingId',
        'createdAt',
        'employeeId',
        'id',
        'offeringCode',
        'offeringStatus',
        'offeringTitle',
        'teachingRole',
        'termId',
        'updatedAt',
        'validFrom',
        'validTo',
        'version',
      ].sort(),
    );
    for (const off of new Set(rows.map((x) => x.courseOfferingId))) {
      const viaOffering = dataOf<Array<{ id: string; employeeId: string }>>(
        await call('GET', s.admin, `/academics/course-offerings/${off}/faculty-assignments`),
      )
        .filter((a) => a.employeeId === X.emp1)
        .map((a) => a.id)
        .sort();
      expect(
        rows
          .filter((x) => x.courseOfferingId === off)
          .map((x) => x.id)
          .sort(),
      ).toEqual(viaOffering);
    }
    const one = rows[0]!.termId;
    const filtered = dataOf<Row[]>(await view(s.admin, X.emp1, `?termId=${one}`));
    expect(filtered.every((x) => x.termId === one)).toBe(true);
    expect((await view(s.admin, X.emp1, '?termId=nope')).statusCode).toBe(400);
  });

  it('employee scope applies: SELF, department and campus scope, students and other tenants', async () => {
    ok(await view(s.faculty, X.emp1)); // a teacher's own workload (SELF)
    expect((await view(s.faculty, X.emp2)).statusCode).toBe(404);
    ok(await view(s.hod, X.emp1)); // HOD of the employee's department
    expect((await view(s.hod, X.emp2)).statusCode).toBe(404);
    ok(await view(s.campusAdmin, X.emp1));
    expect((await view(s.campusAdmin, X.emp2)).statusCode).toBe(404);
    expect((await view(s.student, X.emp1)).statusCode).toBe(403);
    expect((await view(s.foreign, X.emp1)).statusCode).toBe(404);
    expect((await view(s.admin, uuidv7())).statusCode).toBe(404);
    expect((await view(s.admin, 'not-an-id')).statusCode).toBe(400);
  });

  it('a row is shown only when the caller could read it on the offering route (department scope)', async () => {
    // another department on the same campus owns a programme; emp1 (posted on this campus) also teaches there
    const dept3 = created(
      await call('POST', s.admin, '/organization/departments', {
        campusId: T.campusId,
        name: 'Science',
        code: `SC${RUN}`,
      }),
    );
    const bsc = created(
      await call('POST', s.admin, '/academics/programs', {
        departmentId: dept3,
        periodTypeId: X.ptSem,
        name: 'BSC',
        code: `BSC${RUN}`,
        degreeLevel: 'UG',
        durationPeriods: 6,
        periodsPerYear: 2,
      }),
    );
    const t = await term({ program: bsc, code: 'SCIENCE' });
    const adminRows = dataOf<Row[]>(await view(s.admin, X.emp1));
    expect(adminRows.map((r) => r.courseOfferingId)).toContain(t.offering);
    // the HOD of emp1's own department sees emp1, but not the Science offering's assignment
    expect(
      (await call('GET', s.hod, `/academics/course-offerings/${t.offering}/faculty-assignments`))
        .statusCode,
    ).toBe(404);
    const hodRows = dataOf<Row[]>(await view(s.hod, X.emp1));
    expect(hodRows.map((r) => r.courseOfferingId)).not.toContain(t.offering);
    expect(hodRows.length).toBe(adminRows.length - 1);
  });

  it('assign offerings through /faculty: same service, rules and audit as the offering route', async () => {
    const t = await term({ program: X.bca, code: 'FACULTYAPI', offering: 'published' });
    const body = {
      courseOfferingId: t.offering,
      teachingRole: 'PRIMARY',
      validFrom: D(10),
      reason: 'Subject teacher',
    };
    expect(
      (await call('POST', s.faculty, `/faculty/employees/${X.emp1}/assignments`, body)).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', s.admin, `/faculty/employees/${X.emp2}/assignments`, body)).statusCode,
    ).toBe(409); // emp2 has no posting on this offering's campus
    const id = created(
      await call('POST', s.admin, `/faculty/employees/${X.emp1}/assignments`, body),
    );
    // one PRIMARY per offering, exactly as POST /course-offerings/:id/faculty-assignments enforces
    expect(
      (await call('POST', s.admin, `/faculty/employees/${X.emp1}/assignments`, body)).statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', s.admin, `/faculty/employees/${X.emp1}/assignments`, {
          ...body,
          courseOfferingId: uuidv7(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', s.foreign, `/faculty/employees/${X.emp1}/assignments`, body)).statusCode,
    ).toBe(404);
    const viaOffering = dataOf<Array<{ id: string }>>(
      await call('GET', s.admin, `/academics/course-offerings/${t.offering}/faculty-assignments`),
    );
    expect(viaOffering.map((a) => a.id)).toEqual([id]);
    const audit = await adminQuery<{ action: string; reason_text: string }>(
      `SELECT action, reason_text FROM app.audit_events WHERE resource_id = $1`,
      [id],
    );
    expect(audit).toEqual([
      { action: 'academic.faculty_assignment.create', reason_text: 'Subject teacher' },
    ]);
    // and the now-staffed term is ready on both paths
    ok(await viaPost(s.admin, t.id, 1));
    // the existing route is unchanged and still ends the assignment
    ok(
      await call(
        'PATCH',
        s.admin,
        `/academics/faculty-assignments/${id}`,
        { validTo: D(200), reason: 'Teacher moved' },
        ifMatch(1),
      ),
    );
  });
});
