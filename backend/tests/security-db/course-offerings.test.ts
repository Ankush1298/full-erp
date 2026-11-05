import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, runAs, type RawCtx } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0037 at the database layer (doc 31): tenant isolation and forced row security, staff-only writes, staff-only
// faculty assignments, server-derived offering scope and snapshots, least-privilege grants (no DELETE, identity columns
// not updatable) and the guards that bind every writer, the superuser included. runAs statements run as app_runtime in a
// transaction that is always rolled back; the fixtures are committed once in PRIVATE tenants.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
interface World {
  term: string;
  cp: string;
  section: string;
  course: string;
  offering: string;
  assignment: string;
  slot: string;
  employee: string;
}
const W = {} as Record<'t' | 'o', World>;
let otherCampus = '';

const staff = (t: IsolatedTenant): RawCtx => ({
  tenant: t.orgId,
  user: t.users.admin,
  kind: 'STAFF',
});
const student = (): RawCtx => ({ tenant: T.orgId, user: T.users.studentOne, kind: 'STUDENT' });

async function world(t: IsolatedTenant, tag: string): Promise<World> {
  const q = (sql: string, p: unknown[]) => adminQuery(sql, p);
  const [year, pt, prog, cohort, term, cp, section, course] = [
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
  ];
  const [offering, user, employee, assignment, room, slot] = [
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
    uuidv7(),
  ];
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
     VALUES ($1,$2,$3,$4,'Prog',$5,'UG',8)`,
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
    `INSERT INTO app.sections (id, organization_id, cohort_period_id, name) VALUES ($1,$2,$3,'A')`,
    [section, t.orgId, cp],
  );
  await q(
    `INSERT INTO app.courses (id, organization_id, owning_department_id, code, title, credits, course_type)
     VALUES ($1,$2,$3,$4,'Data Structures',4,'THEORY')`,
    [course, t.orgId, t.departmentId, `CS${tag}`],
  );
  await q(
    `INSERT INTO app.course_offerings (id, organization_id, campus_id, department_id, term_id, course_id, cohort_period_id,
        section_id, offering_kind, code_snapshot, title_snapshot, credits_snapshot, tracks_attendance, registration_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CORE','','',0,true,'AUTO_FROM_SECTION')`,
    [offering, t.orgId, t.campusId, t.departmentId, term, course, cp, section],
  );
  await q(
    `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1,$2,'x','ACTIVE')`,
    [user, `sdb-${user}@isolated.test`],
  );
  await q(
    `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1,$2,$3,'T','ACTIVE',$1)`,
    [user, t.orgId, `sdb-${user}@isolated.test`],
  );
  await q(
    `INSERT INTO app.employees (id, organization_id, user_id, employee_code, employee_type, joining_date) VALUES ($1,$2,$3,$4,'FACULTY','2025-01-01')`,
    [employee, t.orgId, user, `E${tag}`],
  );
  await q(
    `INSERT INTO app.faculty_assignments (id, organization_id, course_offering_id, employee_id, role, valid_from)
     VALUES ($1,$2,$3,$4,'PRIMARY','2026-07-01')`,
    [assignment, t.orgId, offering, employee],
  );
  await q(
    `INSERT INTO app.rooms (id, organization_id, campus_id, code, kind) VALUES ($1,$2,$3,$4,'CLASSROOM')`,
    [room, t.orgId, t.campusId, `R${tag}`],
  );
  await q(
    `INSERT INTO app.timetable_slots (id, organization_id, course_offering_id, room_id, faculty_assignment_id, weekday,
        start_time, end_time, effective_from)
     VALUES ($1,$2,$3,$4,$5,1,'09:00','10:00','2026-07-01')`,
    [slot, t.orgId, offering, room, assignment],
  );
  return { term, cp, section, course, offering, assignment, slot, employee };
}

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  W.t = await world(T, `T${T.orgId.slice(-6)}`);
  W.o = await world(OTHER, `O${OTHER.orgId.slice(-6)}`);
  otherCampus = uuidv7();
  await adminQuery(
    `INSERT INTO app.campuses (id, organization_id, name, code, timezone) VALUES ($1,$2,'Elsewhere',$3,'Asia/Kolkata')`,
    [otherCampus, T.orgId, `X${T.orgId.slice(-6)}`],
  );
}, 120_000);

afterAll(async () => {
  await T.cleanup();
  await OTHER.cleanup();
  const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const tbl of [
      'rooms',
      'sections',
      'cohort_periods',
      'terms',
      'academic_years',
      'courses',
      'cohorts',
      'programs',
      'period_types',
    ]) {
      await c.query(`DELETE FROM app.${tbl} WHERE organization_id = ANY($1::uuid[])`, [
        [T.orgId, OTHER.orgId],
      ]);
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
});

describe('tenant isolation (forced RLS)', () => {
  it.each([
    ['course_offerings', 'offering'],
    ['faculty_assignments', 'assignment'],
    ['timetable_slots', 'slot'],
  ] as const)("another tenant's staff sees none of %s", async (table, key) => {
    const r = await runAs(staff(OTHER), `SELECT id FROM app.${table} WHERE id = $1`, [W.t[key]]);
    expect(r.error).toBeUndefined();
    expect(r.rowCount).toBe(0);
    const own = await runAs(staff(T), `SELECT id FROM app.${table} WHERE id = $1`, [W.t[key]]);
    expect(own.rowCount).toBe(1);
  });

  it("a row cannot be written into another tenant, nor point at another tenant's rows", async () => {
    const into = await runAs(
      staff(OTHER),
      `INSERT INTO app.timetable_slots (id, organization_id, course_offering_id, weekday, start_time, end_time, effective_from)
       VALUES ($1,$2,$3,2,'09:00','10:00','2026-07-01')`,
      [uuidv7(), T.orgId, W.t.offering],
    );
    expect(into.error?.code).toBe('42501');
    // OTHER's offering, T's employee: the composite foreign key cannot match across tenants
    const cross = await runAs(
      staff(OTHER),
      `INSERT INTO app.faculty_assignments (id, organization_id, course_offering_id, employee_id, role, valid_from)
       VALUES ($1,$2,$3,$4,'CO_INSTRUCTOR','2026-07-01')`,
      [uuidv7(), OTHER.orgId, W.o.offering, W.t.employee],
    );
    expect(cross.error?.code).toBe('23503');
  });
});

describe('actor kinds', () => {
  it('a student reads offerings and slots but no faculty assignment', async () => {
    expect(
      (await runAs(student(), 'SELECT id FROM app.course_offerings WHERE id = $1', [W.t.offering]))
        .rowCount,
    ).toBe(1);
    expect(
      (await runAs(student(), 'SELECT id FROM app.timetable_slots WHERE id = $1', [W.t.slot]))
        .rowCount,
    ).toBe(1);
    expect((await runAs(student(), 'SELECT id FROM app.faculty_assignments')).rowCount).toBe(0);
  });

  it('a student can write none of the three tables', async () => {
    const tries = [
      [`UPDATE app.course_offerings SET capacity = 5 WHERE id = $1`, [W.t.offering]],
      [`UPDATE app.timetable_slots SET effective_to = '2026-08-01' WHERE id = $1`, [W.t.slot]],
      [
        `INSERT INTO app.timetable_slots (id, organization_id, course_offering_id, weekday, start_time, end_time, effective_from)
         VALUES ($1,$2,$3,3,'09:00','10:00','2026-07-01')`,
        [uuidv7(), T.orgId, W.t.offering],
      ],
    ] as const;
    for (const [sql, p] of tries) {
      const r = await runAs(student(), sql, p);
      expect(r.error?.code === '42501' || r.rowCount === 0, sql).toBe(true);
    }
  });
});

describe('scope and snapshots are derived by the database for every writer', () => {
  it('a supplied campus, department and snapshot are overwritten from the term, programme and course', async () => {
    const r = await runAs(
      staff(T),
      `INSERT INTO app.course_offerings (id, organization_id, campus_id, department_id, term_id, course_id, cohort_period_id,
          offering_kind, group_label, code_snapshot, title_snapshot, credits_snapshot, tracks_attendance, registration_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'LAB_GROUP','G1','FAKE','Forged title',99,false,'ADMIN_ASSIGNED')
       RETURNING campus_id, department_id, title_snapshot, credits_snapshot::text AS credits, tracks_attendance`,
      [uuidv7(), T.orgId, otherCampus, OTHER.departmentId, W.t.term, W.t.course, W.t.cp],
    );
    // OTHER's department does not exist in T: the FK would refuse it - unless the guard replaced it first.
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual({
      campus_id: T.campusId,
      department_id: T.departmentId,
      title_snapshot: 'Data Structures',
      credits: '4.0',
      tracks_attendance: true,
    });
  });

  it('a cohort period of another term and a section of another cohort period are refused by composite keys', async () => {
    const r = await runAs(
      staff(T),
      `INSERT INTO app.course_offerings (id, organization_id, campus_id, department_id, term_id, course_id, cohort_period_id,
          section_id, offering_kind, code_snapshot, title_snapshot, credits_snapshot, tracks_attendance, registration_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CORE','','',0,true,'MANUAL')`,
      [uuidv7(), T.orgId, T.campusId, T.departmentId, W.t.term, W.t.course, W.t.cp, W.o.section],
    );
    expect(r.error?.code).toBe('23503');
  });
});

describe('least privilege: no DELETE, identity columns are not updatable by the runtime', () => {
  it.each([
    ['DELETE FROM app.course_offerings WHERE id = $1', 'offering'],
    ['DELETE FROM app.faculty_assignments WHERE id = $1', 'assignment'],
    ['DELETE FROM app.timetable_slots WHERE id = $1', 'slot'],
    ['UPDATE app.course_offerings SET term_id = term_id WHERE id = $1', 'offering'],
    ['UPDATE app.course_offerings SET title_snapshot = $2 WHERE id = $1', 'offering'],
    ['UPDATE app.faculty_assignments SET employee_id = employee_id WHERE id = $1', 'assignment'],
    ['UPDATE app.faculty_assignments SET role = $2 WHERE id = $1', 'assignment'],
    ['UPDATE app.timetable_slots SET weekday = 2 WHERE id = $1', 'slot'],
    ['UPDATE app.timetable_slots SET room_id = NULL WHERE id = $1', 'slot'],
  ] as const)('%s → 42501', async (sql, key) => {
    const params = sql.includes('$2')
      ? [W.t[key], sql.includes('role') ? 'SUBSTITUTE' : 'x']
      : [W.t[key]];
    expect((await runAs(staff(T), sql, params)).error?.code).toBe('42501');
  });
});

describe('guards bind privileged writers too', () => {
  // adminQuery runs ONE autocommitted statement as the superuser (RLS and grants do not apply to it). Every probe below
  // must be refused by a guard, so nothing is committed; restrict_violation is 23001, exclusion_violation 23P01.
  const superFails = async (sql: string, p: unknown[]): Promise<string | undefined> => {
    try {
      await adminQuery(sql, p);
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code;
    }
  };

  it('identity columns of offerings and assignments are immutable, even for the superuser', async () => {
    expect(
      await superFails(`UPDATE app.course_offerings SET offering_kind = 'ELECTIVE' WHERE id = $1`, [
        W.t.offering,
      ]),
    ).toBe('23001');
    expect(
      await superFails(`UPDATE app.course_offerings SET section_id = NULL WHERE id = $1`, [
        W.t.offering,
      ]),
    ).toBe('23001');
    expect(
      await superFails(`UPDATE app.faculty_assignments SET role = 'SUBSTITUTE' WHERE id = $1`, [
        W.t.assignment,
      ]),
    ).toBe('23001');
    expect(
      await superFails(`UPDATE app.timetable_slots SET weekday = 2 WHERE id = $1`, [W.t.slot]),
    ).toBe('23001');
  });

  it('a second overlapping PRIMARY and a double-booked room are refused for the superuser', async () => {
    expect(
      await superFails(
        `INSERT INTO app.faculty_assignments (id, organization_id, course_offering_id, employee_id, role, valid_from)
         VALUES ($1,$2,$3,$4,'PRIMARY','2026-08-01')`,
        [uuidv7(), T.orgId, W.t.offering, W.t.employee],
      ),
    ).toBe('23P01');
    expect(
      await superFails(
        `INSERT INTO app.timetable_slots (id, organization_id, course_offering_id, room_id, weekday, start_time, end_time, effective_from)
         SELECT $1, organization_id, course_offering_id, room_id, 1, '09:30', '10:30', '2026-09-01' FROM app.timetable_slots WHERE id = $2`,
        [uuidv7(), W.t.slot],
      ),
    ).toBe('23P01');
  });

  it('a snapshot cannot be rewritten outside publication', async () => {
    expect(
      await superFails(
        `UPDATE app.course_offerings SET title_snapshot = 'Rewritten' WHERE id = $1`,
        [W.t.offering],
      ),
    ).toBe('23001');
  });
});
