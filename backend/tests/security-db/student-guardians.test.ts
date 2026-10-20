import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import {
  adminQuery,
  ids,
  runAs,
  runStepsAs,
  type RawCtx,
  type Step,
} from '../support/db-harness.js';
import { GUARDIAN_A, CTX } from '../support/fixtures.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0027 at the database layer: tenant isolation of app.guardians, the student actor's read-only view, the
// tenant-safe composite foreign keys, least-privilege grants, the CHECKs and the row guard. Every statement runs through
// runAs / runStepsAs (one transaction, always rolled back); the rows they look at are committed once, in PRIVATE tenants,
// so the shared fixtures of tenants A and B stay pristine.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const G = {
  one: uuidv7(), // active guardian of T.students.one
  two: uuidv7(), // active PRIMARY guardian of T.students.two
  ended: uuidv7(), // ended guardian of T.students.one
  foreign: uuidv7(), // guardian of OTHER.students.one
};
const L = { one: uuidv7(), two: uuidv7(), ended: uuidv7(), foreign: uuidv7() };

const staffT: RawCtx = { tenant: '', user: '', kind: 'STAFF' };
const studentOne: RawCtx = { tenant: '', user: '', kind: 'STUDENT' };
const staffOther: RawCtx = { tenant: '', user: '', kind: 'STAFF' };

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  Object.assign(staffT, { tenant: T.orgId, user: T.users.admin });
  Object.assign(studentOne, { tenant: T.orgId, user: T.users.studentOne });
  Object.assign(staffOther, { tenant: OTHER.orgId, user: OTHER.users.admin });

  const guardian = (id: string, org: string, name: string, phone: string) =>
    adminQuery(
      'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
      [id, org, name, phone],
    );
  await guardian(G.one, T.orgId, 'Guardian One', '+910000000001');
  await guardian(G.two, T.orgId, 'Guardian Two', '+910000000002');
  await guardian(G.ended, T.orgId, 'Guardian Ended', '+910000000003');
  await guardian(G.foreign, OTHER.orgId, 'Guardian Foreign', '+910000000004');
  const link = (id: string, org: string, student: string, g: string, extra = '', cols = '') =>
    adminQuery(
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation${cols})
       VALUES ($1, $2, $3, $4, 'Mother'${extra})`,
      [id, org, student, g],
    );
  await link(L.one, T.orgId, T.students.one, G.one);
  await link(L.two, T.orgId, T.students.two, G.two, ', true', ', is_primary');
  await link(
    L.ended,
    T.orgId,
    T.students.one,
    G.ended,
    ", DATE '2024-01-01', DATE '2024-02-01'",
    ', valid_from, valid_to',
  );
  await link(L.foreign, OTHER.orgId, OTHER.students.one, G.foreign);
}, 120_000);

afterAll(async () => {
  await T.cleanup();
  await OTHER.cleanup();
});

describe('0027: shape of the new objects', () => {
  it('the two permissions are registered as SENSITIVE', async () => {
    const rows = await adminQuery<{ code: string; sensitivity: string }>(
      `SELECT code, sensitivity FROM platform.permissions WHERE code LIKE 'student.guardian.%' ORDER BY code`,
    );
    expect(rows).toEqual([
      { code: 'student.guardian.manage', sensitivity: 'SENSITIVE' },
      { code: 'student.guardian.read', sensitivity: 'SENSITIVE' },
    ]);
  });

  it('guardians: forced RLS, a tenant-scoped key, no user_id, no DELETE and no TRUNCATE for the runtime role', async () => {
    const [flags] = await adminQuery<{ s: boolean; f: boolean }>(
      `SELECT relrowsecurity s, relforcerowsecurity f FROM pg_class WHERE oid = 'app.guardians'::regclass`,
    );
    expect(flags).toEqual({ s: true, f: true });
    const cols = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'guardians' ORDER BY 1`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at',
      'deleted_at',
      'email',
      'full_name',
      'id',
      'organization_id',
      'phone',
      'updated_at',
      'version',
    ]);
    const [p] = await adminQuery<{ sel: boolean; ins: boolean; del: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'app.guardians', 'SELECT') sel,
              has_table_privilege('app_runtime', 'app.guardians', 'INSERT') ins,
              has_table_privilege('app_runtime', 'app.guardians', 'DELETE') del,
              has_table_privilege('app_runtime', 'app.guardians', 'TRUNCATE') trunc`,
    );
    expect(p).toEqual({ sel: true, ins: true, del: false, trunc: false });
  });

  it('the link references its guardian and its student through TENANT-prefixed composite keys', async () => {
    const defs = await adminQuery<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'app.student_guardians'::regclass AND conname IN
          ('student_guardians_guardian_fk', 'student_guardians_student_fk', 'student_guardians_org_student_guardian_uq')
        ORDER BY conname`,
    );
    expect(defs.map((d) => d.conname)).toEqual([
      'student_guardians_guardian_fk',
      'student_guardians_org_student_guardian_uq',
      'student_guardians_student_fk',
    ]);
    expect(defs[0]!.def).toMatch(
      /FOREIGN KEY \(organization_id, guardian_id\) REFERENCES app\.guardians\(organization_id, id\)/,
    );
    expect(defs[2]!.def).toMatch(
      /FOREIGN KEY \(organization_id, student_id\) REFERENCES app\.students\(organization_id, id\)/,
    );
  });

  it('pre-0027 fixture rows keep their legacy shape (guardian_id NULL) and are untouched', async () => {
    const rows = await adminQuery<{ guardian_id: string | null; full_name: string | null }>(
      'SELECT guardian_id, full_name FROM app.student_guardians WHERE id = $1',
      [GUARDIAN_A],
    );
    expect(rows).toEqual([{ guardian_id: null, full_name: 'Guardian of A' }]);
  });
});

describe('tenant isolation of guardians', () => {
  it('staff see only their own tenant, with no filter in the query', async () => {
    expect(ids(await runAs(staffT, 'SELECT id FROM app.guardians'))).toEqual(
      [G.one, G.two, G.ended].sort(),
    );
    expect(ids(await runAs(staffOther, 'SELECT id FROM app.guardians'))).toEqual([G.foreign]);
    expect(
      (await runAs(staffT, 'SELECT id FROM app.guardians WHERE id = $1', [G.foreign])).rowCount,
    ).toBe(0);
  });

  it('missing, empty or invalid context sees nothing and writes nothing', async () => {
    for (const ctx of [
      {},
      { tenant: T.orgId },
      { tenant: T.orgId, user: T.users.admin },
      { ...staffT, kind: 'GUARDIAN' },
      { ...staffT, kind: 'staff' },
    ]) {
      expect((await runAs(ctx, 'SELECT id FROM app.guardians')).rowCount, JSON.stringify(ctx)).toBe(
        0,
      );
      const ins = await runAs(
        ctx,
        'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
        [uuidv7(), T.orgId, 'X', '+910000000009'],
      );
      expect(ins.error?.code, JSON.stringify(ctx)).toBe('42501');
    }
  });

  it('staff cannot write a guardian of another tenant: insert is refused, update and delete reach nothing', async () => {
    const ins = await runAs(
      staffT,
      'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
      [uuidv7(), OTHER.orgId, 'Forged', '+910000000009'],
    );
    expect(ins.error?.code).toBe('42501');
    const upd = await runAs(
      staffT,
      `UPDATE app.guardians SET full_name = 'Hijacked' WHERE id = $1`,
      [G.foreign],
    );
    expect(upd.error).toBeUndefined();
    expect(upd.rowCount).toBe(0);
    expect(
      (await runAs(staffT, 'DELETE FROM app.guardians WHERE id = $1', [G.foreign])).error?.code,
    ).toBe('42501');
  });
});

describe('the student actor', () => {
  it('reads only guardians with an ACTIVE link to their own record', async () => {
    expect(ids(await runAs(studentOne, 'SELECT id FROM app.guardians'))).toEqual([G.one]); // not G.two (another student), not G.ended
    expect(
      (await runAs(studentOne, 'SELECT id FROM app.guardians WHERE id = $1', [G.two])).rowCount,
    ).toBe(0);
    expect(
      (await runAs(studentOne, 'SELECT id FROM app.guardians WHERE id = $1', [G.ended])).rowCount,
    ).toBe(0);
    expect(
      (await runAs(studentOne, 'SELECT id FROM app.guardians WHERE id = $1', [G.foreign])).rowCount,
    ).toBe(0);
  });

  it('can neither create nor change a guardian', async () => {
    const ins = await runAs(
      studentOne,
      'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
      [uuidv7(), T.orgId, 'Impostor', '+910000000008'],
    );
    expect(ins.error?.code).toBe('42501');
    const upd = await runAs(
      studentOne,
      `UPDATE app.guardians SET phone = '+910000009999' WHERE id = $1`,
      [G.one],
    );
    expect(upd.error?.code).toBe('42501');
  });

  it('reads own links but can neither create, change nor delete a new-shape link', async () => {
    expect(
      ids(
        await runAs(
          studentOne,
          'SELECT id FROM app.student_guardians WHERE guardian_id IS NOT NULL',
        ),
      ),
    ).toEqual([L.one, L.ended].sort());
    const ins = await runAs(
      studentOne,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation)
       VALUES ($1, $2, $3, $4, 'Aunt')`,
      [uuidv7(), T.orgId, T.students.one, G.two],
    );
    expect(ins.error?.code).toBe('42501');
    const upd = await runAs(
      studentOne,
      'UPDATE app.student_guardians SET can_give_consent = true WHERE id = $1',
      [L.one],
    );
    expect(upd.error).toBeUndefined();
    expect(upd.rowCount).toBe(0); // the row is not even visible to an UPDATE
    const del = await runAs(studentOne, 'DELETE FROM app.student_guardians WHERE id = $1', [L.one]);
    expect(del.rowCount).toBe(0);
  });
});

describe('links are end-dated, never deleted, and tenant-safe', () => {
  it('even staff cannot delete a new-shape link; a legacy row can still be deleted (unchanged behaviour)', async () => {
    expect(
      (await runAs(staffT, 'DELETE FROM app.student_guardians WHERE id = $1', [L.one])).rowCount,
    ).toBe(0);
    expect(
      (await runAs(CTX.staffA, 'DELETE FROM app.student_guardians WHERE id = $1', [GUARDIAN_A]))
        .rowCount,
    ).toBe(1);
  });

  it('a link cannot reference a guardian of another tenant, nor a student of another tenant', async () => {
    const crossGuardian = await runAs(
      staffT,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation)
       VALUES ($1, $2, $3, $4, 'Aunt')`,
      [uuidv7(), T.orgId, T.students.two, G.foreign],
    );
    expect(crossGuardian.error?.code).toBe('23503');
    const crossStudent = await runAs(
      staffT,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation)
       VALUES ($1, $2, $3, $4, 'Aunt')`,
      [uuidv7(), T.orgId, OTHER.students.one, G.one],
    );
    expect(crossStudent.error?.code).toBe('23503');
  });

  it('one link per (student, guardian); one ACTIVE primary per student', async () => {
    const dup = await runAs(
      staffT,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation)
       VALUES ($1, $2, $3, $4, 'Aunt')`,
      [uuidv7(), T.orgId, T.students.one, G.one],
    );
    expect(dup.error?.code).toBe('23505');
    const g2 = uuidv7();
    const second = await runStepsAs(staffT, [
      [
        'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
        [g2, T.orgId, 'Another', '+910000000010'],
      ],
      [
        `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1, $2, $3, $4, 'Aunt', true)`,
        [uuidv7(), T.orgId, T.students.two, g2],
      ],
    ]);
    expect(second.error?.code).toBe('23505');
  });

  it('CHECKs: contact data is never copied into a new-shape link, a legacy row keeps its contact, dates are ordered, an ended link is not primary', async () => {
    const copied = await runAs(
      staffT,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, full_name, phone)
       VALUES ($1, $2, $3, $4, 'Aunt', 'Copy', '+910000000011')`,
      [uuidv7(), T.orgId, T.students.two, G.ended],
    );
    expect(copied.error?.code).toBe('23514');
    const neither = await runAs(
      staffT,
      `INSERT INTO app.student_guardians (id, organization_id, student_id, relation) VALUES ($1, $2, $3, 'Aunt')`,
      [uuidv7(), T.orgId, T.students.two],
    );
    expect(neither.error?.code).toBe('23514');
    const backwards = await runAs(
      staffT,
      `UPDATE app.student_guardians SET valid_to = DATE '2000-01-01' WHERE id = $1`,
      [L.one],
    );
    expect(backwards.error?.code).toBe('23514');
    const endedPrimary = await runAs(
      staffT,
      'UPDATE app.student_guardians SET valid_to = CURRENT_DATE WHERE id = $1',
      [L.two],
    );
    expect(endedPrimary.error?.code).toBe('23514');
    const ok = await runAs(
      staffT,
      'UPDATE app.student_guardians SET valid_to = CURRENT_DATE, is_primary = false WHERE id = $1',
      [L.two],
    );
    expect(ok.error).toBeUndefined();
    expect(ok.rowCount).toBe(1);
  });
});

describe('the primary slot: legacy rows and new-shape rows each keep their own rule', () => {
  const legacyPrimary = (student: string): Step => [
    `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation, is_primary)
     VALUES ($1, $2, $3, 'Legacy', '+910000000020', 'Aunt', true)`,
    [uuidv7(), T.orgId, student],
  ];
  const guardian = (id: string, phone: string): Step => [
    'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
    [id, T.orgId, 'New', phone],
  ];
  const primaryLink = (student: string, g: string): Step => [
    `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
     VALUES ($1, $2, $3, $4, 'Mother', true)`,
    [uuidv7(), T.orgId, student, g],
  ];

  it('a legacy primary row and a new-shape primary link COEXIST for one student (the legacy row cannot be fixed through the API)', async () => {
    // T.students.one has no primary link of either kind
    const g = uuidv7();
    const r = await runStepsAs(staffT, [
      legacyPrimary(T.students.one),
      guardian(g, '+910000000021'),
      primaryLink(T.students.one, g),
      [
        `SELECT count(*)::int AS n FROM app.student_guardians WHERE student_id = $1 AND is_primary`,
        [T.students.one],
      ],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual({ n: 2 });
  });

  it('two LEGACY primaries are still refused under the original index name; two NEW-shape primaries under the new one', async () => {
    const twoLegacy = await runStepsAs(staffT, [
      legacyPrimary(T.students.one),
      legacyPrimary(T.students.one),
    ]);
    expect(twoLegacy.error?.code).toBe('23505');
    expect(twoLegacy.error?.message).toContain('student_guardians_one_primary_uq');
    const a = uuidv7();
    const b = uuidv7();
    const twoNew = await runStepsAs(staffT, [
      guardian(a, '+910000000022'),
      guardian(b, '+910000000023'),
      primaryLink(T.students.one, a),
      primaryLink(T.students.one, b),
    ]);
    expect(twoNew.error?.code).toBe('23505');
    expect(twoNew.error?.message).toContain('student_guardians_one_primary_link_uq');
  });

  it('exactly these two partial unique indexes exist, with the intended predicates', async () => {
    const rows = await adminQuery<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = 'student_guardians' AND indexname LIKE 'student_guardians_one_primary%'
        ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'student_guardians_one_primary_link_uq',
      'student_guardians_one_primary_uq',
    ]);
    expect(rows[0]!.indexdef).toMatch(
      /\(organization_id, student_id\) WHERE \(is_primary AND \(guardian_id IS NOT NULL\)\)/,
    );
    expect(rows[1]!.indexdef).toMatch(
      /\(student_id\) WHERE \(is_primary AND \(guardian_id IS NULL\)\)/,
    );
  });

  it('the column default of valid_from is the UTC date, not the session date', async () => {
    const [d] = await adminQuery<{ def: string }>(
      `SELECT pg_get_expr(adbin, adrelid) AS def FROM pg_attrdef
        WHERE adrelid = 'app.student_guardians'::regclass
          AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'app.student_guardians'::regclass AND attname = 'valid_from')`,
    );
    expect(d!.def).toMatch(/UTC/);
    expect(d!.def).not.toMatch(/CURRENT_DATE/i);
  });
});

describe('least privilege and the row guard', () => {
  const denied: [string, string, () => unknown[]][] = [
    [
      'guardians.organization_id',
      'UPDATE app.guardians SET organization_id = $2 WHERE id = $1',
      () => [G.one, OTHER.orgId],
    ],
    ['guardians.id', 'UPDATE app.guardians SET id = $2 WHERE id = $1', () => [G.one, uuidv7()]],
    ['guardians.version', 'UPDATE app.guardians SET version = 99 WHERE id = $1', () => [G.one]],
    [
      'links.guardian_id',
      'UPDATE app.student_guardians SET guardian_id = $2 WHERE id = $1',
      () => [L.one, G.two],
    ],
    [
      'links.valid_from',
      `UPDATE app.student_guardians SET valid_from = DATE '2020-01-01' WHERE id = $1`,
      () => [L.one],
    ],
    [
      'links.organization_id',
      'UPDATE app.student_guardians SET organization_id = $2 WHERE id = $1',
      () => [L.one, OTHER.orgId],
    ],
  ];
  it.each(denied)('the runtime role cannot update %s', async (_name, sql, params) => {
    expect((await runAs(staffT, sql, params())).error?.code).toBe('42501');
  });

  it('the row guard: an ended link is terminal, and a link never moves to another student', async () => {
    const terminal = await runAs(
      staffT,
      `UPDATE app.student_guardians SET relation = 'Aunt' WHERE id = $1`,
      [L.ended],
    );
    expect(terminal.error?.code).toBe('23001');
    const moved = await runAs(
      staffT,
      'UPDATE app.student_guardians SET student_id = $2 WHERE id = $1',
      [L.one, T.students.two],
    );
    expect(moved.error?.code).toBe('23001');
  });

  it('a legacy row can never be converted into the new shape, even by a privileged session (guard trigger)', async () => {
    const c = new pg.Client({ connectionString: inject('dbAdminUrl') });
    await c.connect();
    try {
      await c.query('BEGIN');
      const g = uuidv7();
      await c.query(
        'INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, $3, $4)',
        [g, T.orgId, 'x', '+910000000013'],
      );
      const legacy = uuidv7();
      await c.query(
        `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation)
         VALUES ($1, $2, $3, 'Legacy', '+910000000014', 'Aunt')`,
        [legacy, T.orgId, T.students.two],
      );
      const err = await c
        .query(
          `UPDATE app.student_guardians SET guardian_id = $2, full_name = NULL, phone = NULL WHERE id = $1`,
          [legacy, g],
        )
        .then(
          () => undefined,
          (e: { code?: string }) => e.code,
        );
      expect(err).toBe('23001');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });
});
