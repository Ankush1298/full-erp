import { cpSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { DEFAULT_MIGRATIONS_DIR, contractVersions, migrate } from '../../tools/db/migrate.js';
import { dropAll, freshDatabase, sql } from '../support/fresh-db.js';

// Migration 0027 on a database that already holds LEGACY student_guardians rows (guardian_id NULL; they exist since 0002):
// the upgrade must succeed, keep every legacy row byte-for-byte, and leave a student with a legacy primary row able to get
// a new-shape primary guardian. Own throw-away database; nothing here touches the shared integration database.

afterAll(dropAll);

describe('0027 applied on top of a database with legacy guardian rows', () => {
  it('keeps legacy primary and non-primary rows untouched, never deletes or demotes them, and frees the new primary slot', async () => {
    const db = await freshDatabase();
    // A database exactly as it is at 0026: every migration but 0027 (one pass on an empty ledger, contract steps allowed)
    const dir = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => Number(x.slice(0, 4)) < 27)) {
      cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(dir, f));
    }
    await migrate({ connectionString: db.migrator, dir, allowContract: contractVersions(dir) });

    const org = uuidv7();
    const ids = { primaryStudent: uuidv7(), otherStudent: uuidv7() };
    await sql(
      db.admin,
      `INSERT INTO app.organizations (id, name, slug) VALUES ($1, 'Legacy org', $2)`,
      [org, `legacy-${org.slice(-12)}`],
    );
    for (const student of Object.values(ids)) {
      const user = uuidv7();
      await sql(
        db.admin,
        `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'x', 'ACTIVE')`,
        [user, `u-${user.slice(-12)}@legacy.test`],
      );
      await sql(
        db.admin,
        `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id) VALUES ($1, $2, $3, 'u', 'ACTIVE', $1)`,
        [user, org, `u-${user.slice(-12)}@legacy.test`],
      );
      await sql(
        db.admin,
        `INSERT INTO app.students (id, organization_id, user_id, admission_number, admission_date, status)
         VALUES ($1, $2, $3, $4, DATE '2024-07-01', 'ACTIVE')`,
        [student, org, user, `L-${student.slice(-10)}`],
      );
    }
    const legacy = [
      { id: uuidv7(), student: ids.primaryStudent, primary: true },
      { id: uuidv7(), student: ids.primaryStudent, primary: false },
      { id: uuidv7(), student: ids.otherStudent, primary: false },
    ];
    for (const l of legacy) {
      await sql(
        db.admin,
        `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, email, relation, is_primary)
         VALUES ($1, $2, $3, 'Legacy contact', '+910000000099', 'old@legacy.test', 'Aunt', $4)`,
        [l.id, org, l.student, l.primary],
      );
    }
    const snapshot = (): Promise<Record<string, unknown>[]> =>
      sql(
        db.admin,
        `SELECT id, student_id, full_name, phone, email, relation, is_primary, version, created_at, updated_at
           FROM app.student_guardians WHERE organization_id = $1 ORDER BY id`,
        [org],
      );
    const before = await snapshot();
    expect(before).toHaveLength(3);

    // apply 0027 (the real directory: the ledger holds 0001-0026, so exactly one migration is pending)
    // the directory WITH 0027 and WITHOUT the later migrations: exactly one migration is pending
    const upTo27 = mkdtempSync(join(tmpdir(), 'campusos-mig-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => Number(x.slice(0, 4)) < 28)) {
      cpSync(join(DEFAULT_MIGRATIONS_DIR, f), join(upTo27, f));
    }
    const r = await migrate({ connectionString: db.migrator, dir: upTo27 });
    expect(r.applied).toEqual(['0027']);

    // every legacy row is exactly as it was: not deleted, not demoted, not touched (same version and timestamps)
    expect(await snapshot()).toEqual(before);
    const shape = await sql<{ guardian_id: string | null; valid_to: string | null }>(
      db.admin,
      'SELECT guardian_id, valid_to::text FROM app.student_guardians WHERE organization_id = $1',
      [org],
    );
    expect(shape.every((x) => x.guardian_id === null && x.valid_to === null)).toBe(true);
    expect(
      await sql(db.admin, 'SELECT 1 FROM app.guardians WHERE organization_id = $1', [org]),
    ).toHaveLength(0); // no backfill

    // the student with a legacy PRIMARY row can get a new-shape primary; a second new-shape primary is still refused
    const g1 = uuidv7();
    const g2 = uuidv7();
    for (const g of [g1, g2]) {
      await sql(
        db.admin,
        `INSERT INTO app.guardians (id, organization_id, full_name, phone) VALUES ($1, $2, 'New', '+910000000088')`,
        [g, org],
      );
    }
    const link = (g: string) =>
      sql(
        db.admin,
        `INSERT INTO app.student_guardians (id, organization_id, student_id, guardian_id, relation, is_primary)
         VALUES ($1, $2, $3, $4, 'Mother', true)`,
        [uuidv7(), org, ids.primaryStudent, g],
      );
    await link(g1);
    await expect(link(g2)).rejects.toMatchObject({
      code: '23505',
      constraint: 'student_guardians_one_primary_link_uq',
    });
    // and the legacy rule still holds: a second LEGACY primary for the same student is refused
    await expect(
      sql(
        db.admin,
        `INSERT INTO app.student_guardians (id, organization_id, student_id, full_name, phone, relation, is_primary)
         VALUES ($1, $2, $3, 'Dup', '+910000000077', 'Aunt', true)`,
        [uuidv7(), org, ids.primaryStudent],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'student_guardians_one_primary_uq' });
    // legacy rows are still exactly as they were
    expect((await snapshot()).filter((row) => before.some((b) => b.id === row.id))).toEqual(before);
  }, 240_000);
});
