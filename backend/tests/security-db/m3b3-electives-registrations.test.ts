import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, runAs, type RawCtx } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0039 at the database layer (doc 33): elective_groups, course_registrations and holidays are tenant-isolated
// with FORCED row security, least-privilege (no DELETE anywhere, column-level UPDATE), every foreign key carries the
// organization, course_registrations is student-bearing (a student reads only their own rows, writes none), and the
// guards bind the superuser too. runAs statements run as app_runtime in a transaction that is always rolled back.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
interface World {
  term: string;
  cp: string;
  group: string;
  offering: string;
  enrollment: string;
  student: string;
  registration: string;
  holiday: string;
}
const W = {} as Record<'t' | 'o', World>;
const TABLES = ['elective_groups', 'course_registrations', 'holidays'] as const;
const staff = (t: IsolatedTenant): RawCtx => ({
  tenant: t.orgId,
  user: t.users.admin,
  kind: 'STAFF',
});
const asStudent = (user: string): RawCtx => ({ tenant: T.orgId, user, kind: 'STUDENT' });

async function world(t: IsolatedTenant, tag: string): Promise<World> {
  const id = () => uuidv7();
  const [
    year,
    pt,
    prog,
    cohort,
    term,
    cp,
    course,
    group,
    offering,
    sp,
    enrollment,
    registration,
    holiday,
  ] = Array.from({ length: 13 }, id) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const q = adminQuery;
  await q(
    `INSERT INTO app.academic_years (id, organization_id, label, start_date, end_date) VALUES ($1,$2,$3,'2026-06-01','2027-05-31')`,
    [year, t.orgId, `Y${tag}`],
  );
  await q(
    `INSERT INTO app.period_types (id, organization_id, code, label, label_plural) VALUES ($1,$2,'SEM','Semester','Semesters')`,
    [pt, t.orgId],
  );
  await q(
    `INSERT INTO app.programs (id, organization_id, department_id, period_type_id, name, code, degree_level, duration_periods)
     VALUES ($1,$2,$3,$4,'BTech',$5,'UG',8)`,
    [prog, t.orgId, t.departmentId, pt, `P${tag}`],
  );
  await q(
    `INSERT INTO app.cohorts (id, organization_id, program_id, admission_year, name) VALUES ($1,$2,$3,2026,'C')`,
    [cohort, t.orgId, prog],
  );
  await q(
    `INSERT INTO app.terms (id, organization_id, campus_id, academic_year_id, code, name, start_date, end_date)
     VALUES ($1,$2,$3,$4,'ODD','Odd','2026-07-01','2026-12-31')`,
    [term, t.orgId, t.campusId, year],
  );
  await q(
    `INSERT INTO app.cohort_periods (id, organization_id, cohort_id, term_id, period_no) VALUES ($1,$2,$3,$4,1)`,
    [cp, t.orgId, cohort, term],
  );
  await q(
    `INSERT INTO app.courses (id, organization_id, owning_department_id, code, title, credits, course_type) VALUES ($1,$2,$3,$4,'ML',3,'THEORY')`,
    [course, t.orgId, t.departmentId, `ML${tag}`.slice(0, 20)],
  );
  await q(
    `INSERT INTO app.elective_groups (id, organization_id, cohort_period_id, code, name, min_select, max_select) VALUES ($1,$2,$3,'PE1','PE I',0,1)`,
    [group, t.orgId, cp],
  );
  await q(`UPDATE app.elective_groups SET status = 'OPEN' WHERE id = $1`, [group]);
  await q(
    `INSERT INTO app.course_offerings (id, organization_id, campus_id, department_id, term_id, course_id, cohort_period_id,
       elective_group_id, offering_kind, code_snapshot, title_snapshot, credits_snapshot, tracks_attendance, registration_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ELECTIVE','','',0,true,'ELECTIVE_CHOICE')`,
    [offering, t.orgId, t.campusId, t.departmentId, term, course, cp, group],
  );
  await q(`UPDATE app.course_offerings SET status = 'PUBLISHED' WHERE id = $1`, [offering]);
  const student = t.students.one;
  await q(
    `INSERT INTO app.student_programs (id, organization_id, student_id, program_id, cohort_id, campus_id, department_id, start_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-06-01','ACTIVE')`,
    [sp, t.orgId, student, prog, cohort, t.campusId, t.departmentId],
  );
  await q(
    `INSERT INTO app.term_enrollments (id, organization_id, student_id, student_program_id, cohort_period_id, term_id, period_no)
     VALUES ($1,$2,$3,$4,$5,$6,1)`,
    [enrollment, t.orgId, student, sp, cp, term],
  );
  await q(`UPDATE app.term_enrollments SET status = 'ACTIVE' WHERE id = $1`, [enrollment]);
  await q(
    `INSERT INTO app.course_registrations (id, organization_id, term_enrollment_id, student_id, course_offering_id, valid_from, source)
     VALUES ($1,$2,$3,$4,$5,'2026-07-01','ELECTIVE_CHOICE')`,
    [registration, t.orgId, enrollment, student, offering],
  );
  await q(
    `INSERT INTO app.holidays (id, organization_id, campus_id, holiday_date, name, kind) VALUES ($1,$2,$3,'2026-08-15','Independence Day','HOLIDAY')`,
    [holiday, t.orgId, t.campusId],
  );
  return { term, cp, group, offering, enrollment, student, registration, holiday };
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  W.t = await world(T, `T${T.orgId.slice(-6)}`);
  W.o = await world(OTHER, `O${OTHER.orgId.slice(-6)}`);
}, 120_000);

afterAll(async () => {
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const org of [T.orgId, OTHER.orgId]) {
      for (const tbl of [
        'course_registrations',
        'holidays',
        'course_offerings',
        'elective_groups',
        'term_enrollments',
        'student_programs',
        'cohort_periods',
        'terms',
        'academic_years',
        'courses',
        'cohorts',
        'programs',
        'period_types',
      ]) {
        await c.query(`DELETE FROM app.${tbl} WHERE organization_id = $1`, [org]);
      }
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  await T.cleanup();
  await OTHER.cleanup();
});

describe('0039 catalog: row security, grants and tenant-scoped keys', () => {
  it('row security is enabled AND forced on every new table', async () => {
    const r = await adminQuery<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
        WHERE relnamespace = 'app'::regnamespace AND relname = ANY($1) ORDER BY relname`,
      [[...TABLES]],
    );
    expect(r).toEqual([...TABLES].sort().map((relname) => ({ relname, on: true, forced: true })));
  });

  it('app_runtime: SELECT and INSERT, no DELETE/TRUNCATE, UPDATE only on the mutable columns', async () => {
    for (const t of TABLES) {
      const [p] = await adminQuery<Record<string, boolean>>(
        `SELECT has_table_privilege('app_runtime', $1, 'SELECT') AS s, has_table_privilege('app_runtime', $1, 'INSERT') AS i,
                has_table_privilege('app_runtime', $1, 'DELETE') AS d, has_table_privilege('app_runtime', $1, 'TRUNCATE') AS tr,
                has_table_privilege('app_runtime', $1, 'UPDATE') AS u`,
        [`app.${t}`],
      );
      expect(p, t).toEqual({ s: true, i: true, d: false, tr: false, u: false });
    }
    const cols = await adminQuery<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'app_runtime' AND privilege_type = 'UPDATE' AND table_schema = 'app' AND table_name = ANY($1)
        ORDER BY table_name, column_name`,
      [[...TABLES]],
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'course_registrations.status',
      'course_registrations.valid_to',
      'elective_groups.closes_at',
      'elective_groups.max_select',
      'elective_groups.min_select',
      'elective_groups.name',
      'elective_groups.opens_at',
      'elective_groups.status',
      'holidays.name',
      'holidays.status',
    ]);
  });

  it('every foreign key of the new tables and of course_offerings.elective_group_id starts with organization_id', async () => {
    const fks = await adminQuery<{ conname: string; first: string }>(
      `SELECT c.conname, a.attname AS first FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)
          AND (c.conrelid::regclass::text <> 'app.course_offerings' OR c.conname = 'course_offerings_elective_group_fk')
        ORDER BY 1`,
      [['app.elective_groups', 'app.course_registrations', 'app.holidays', 'app.course_offerings']],
    );
    expect(fks.length).toBe(9);
    expect(fks.filter((f) => f.first !== 'organization_id')).toEqual([]);
  });

  it('every guard function is SECURITY INVOKER with a pinned search_path and not executable by PUBLIC', async () => {
    const r = await adminQuery<{
      proname: string;
      secdef: boolean;
      config: string[] | null;
      pub: boolean;
    }>(
      `SELECT proname, prosecdef AS secdef, proconfig AS config,
              has_function_privilege('public', oid, 'EXECUTE') AS pub
         FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname = ANY($1) ORDER BY proname`,
      [
        [
          'elective_groups_guard',
          'course_offerings_registration_guard',
          'course_registrations_guard',
          'holidays_guard',
          'section_class_teachers_guard',
        ],
      ],
    );
    expect(r).toHaveLength(5);
    for (const f of r) {
      expect(f.secdef, f.proname).toBe(false);
      expect(f.config, f.proname).toEqual(['search_path=pg_catalog']);
      expect(f.pub, f.proname).toBe(false);
    }
  });
});

describe('0039 behaviour under app_runtime', () => {
  it("another tenant's staff sees none of the rows; own staff sees them", async () => {
    for (const [t, col] of [
      ['elective_groups', 'group'],
      ['course_registrations', 'registration'],
      ['holidays', 'holiday'],
    ] as const) {
      const sql = `SELECT id FROM app.${t} WHERE id = $1`;
      expect((await runAs(staff(OTHER), sql, [W.t[col]])).rowCount, t).toBe(0);
      expect((await runAs(staff(T), sql, [W.t[col]])).rowCount, t).toBe(1);
    }
  });

  it("no row can be written into another tenant or point at another tenant's offering or enrolment", async () => {
    const intoOther = await runAs(
      staff(T),
      `INSERT INTO app.holidays (id, organization_id, holiday_date, name, kind) VALUES ($1,$2,'2026-09-01','X','HOLIDAY')`,
      [uuidv7(), OTHER.orgId],
    );
    expect(intoOther.error?.code).toBe('42501');
    const crossRef = await runAs(
      staff(T),
      `INSERT INTO app.course_registrations (id, organization_id, term_enrollment_id, student_id, course_offering_id, valid_from, source)
       VALUES ($1,$2,$3,$4,$5,'2026-07-01','ELECTIVE_CHOICE')`,
      [uuidv7(), T.orgId, W.t.enrollment, W.t.student, W.o.offering],
    );
    expect(crossRef.error?.code).toBe('23503');
  });

  it('a student reads only their own registrations and writes nothing', async () => {
    const own = await runAs(
      asStudent(T.users.studentOne),
      'SELECT id FROM app.course_registrations',
    );
    expect(own.rows.map((r) => r['id'])).toEqual([W.t.registration]);
    expect(
      (await runAs(asStudent(T.users.studentTwo), 'SELECT id FROM app.course_registrations'))
        .rowCount,
    ).toBe(0);
    const write = await runAs(
      asStudent(T.users.studentOne),
      `UPDATE app.course_registrations SET status = 'DROPPED', valid_to = '2026-07-02' WHERE id = $1`,
      [W.t.registration],
    );
    expect(write.error?.code ?? (write.rowCount === 0 ? 'no-row' : 'updated')).not.toBe('updated');
    for (const sql of [
      `INSERT INTO app.holidays (id, organization_id, holiday_date, name, kind) VALUES ('${uuidv7()}','${T.orgId}','2026-09-01','S','HOLIDAY')`,
      `UPDATE app.elective_groups SET name = 'S' WHERE id = '${W.t.group}'`,
    ]) {
      const r = await runAs(asStudent(T.users.studentOne), sql);
      expect(r.error?.code ?? (r.rowCount === 0 ? 'no-row' : 'written'), sql).not.toBe('written');
    }
  });

  it("no DELETE, even of the own tenant's rows; identity columns are immutable", async () => {
    for (const t of TABLES) {
      expect((await runAs(staff(T), `DELETE FROM app.${t}`)).error?.code, t).toBe('42501');
    }
    expect(
      (
        await runAs(staff(T), `UPDATE app.holidays SET holiday_date = '2026-08-16' WHERE id = $1`, [
          W.t.holiday,
        ])
      ).error?.code,
    ).toBe('42501');
  });
});

describe('0039 guards bind the superuser (historical preservation, effective dates)', () => {
  const expectRefused = async (sql: string, params: unknown[], pattern: RegExp) => {
    await expect(adminQuery(sql, params)).rejects.toThrow(pattern);
  };

  it('a closed registration is terminal; valid_to must lie in the term and not before valid_from', async () => {
    const id = uuidv7();
    await expectRefused(
      `UPDATE app.course_registrations SET status = 'DROPPED', valid_to = '2027-01-15' WHERE id = $1`,
      [W.t.registration],
      /within the term/,
    );
    await expectRefused(
      `UPDATE app.course_registrations SET status = 'DROPPED', valid_to = '2026-06-30' WHERE id = $1`,
      [W.t.registration],
      /course_registrations_dates_ck/,
    );
    await expectRefused(
      `UPDATE app.course_registrations SET status = 'DROPPED' WHERE id = $1`,
      [W.t.registration],
      /course_registrations_open_iff_live_ck/,
    );
    await expectRefused(
      `INSERT INTO app.course_registrations (id, organization_id, term_enrollment_id, student_id, course_offering_id, valid_from, source)
       VALUES ($1,$2,$3,$4,$5,'2026-06-30','ELECTIVE_CHOICE')`,
      [id, T.orgId, W.t.enrollment, W.t.student, W.t.offering],
      /within the term/,
    );
  });

  it('a cancelled holiday is final; a CLOSED group is final; the group of an offering is fixed', async () => {
    const h = uuidv7();
    await adminQuery(
      `INSERT INTO app.holidays (id, organization_id, holiday_date, name, kind) VALUES ($1,$2,'2026-10-02','Gandhi Jayanti','HOLIDAY')`,
      [h, T.orgId],
    );
    await adminQuery(`UPDATE app.holidays SET status = 'CANCELLED' WHERE id = $1`, [h]);
    await expectRefused(`UPDATE app.holidays SET status = 'ACTIVE' WHERE id = $1`, [h], /final/);
    await expectRefused(
      `UPDATE app.course_offerings SET elective_group_id = NULL WHERE id = $1`,
      [W.t.offering],
      /immutable/,
    );
    await expectRefused(
      `UPDATE app.elective_groups SET status = 'PLANNED' WHERE id = $1`,
      [W.t.group],
      /transition/,
    );
  });

  it('the student-bearing table is in the linter list and the guard set is complete', async () => {
    const { n } = (
      await adminQuery<{ n: string }>(
        `SELECT count(*) AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY(ARRAY['app.elective_groups','app.course_registrations','app.holidays']::regclass[])`,
      )
    )[0]!;
    expect(Number(n)).toBe(9); // touch + immutable + guard on each
  });
});
