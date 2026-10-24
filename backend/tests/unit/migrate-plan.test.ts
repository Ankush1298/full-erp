import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMigrateArgs } from '../../tools/db/cli-args.js';
import {
  contractVersions,
  isContractMigration,
  loadMigrations,
  planMigrations,
  type Migration,
} from '../../tools/db/migrate.js';

// The expand/contract gate, as a pure function (no database): see docs/architecture/v3/18-academic-structure-f21.md.
const mig = (version: string, name: string): Migration => ({
  version,
  name,
  sql: `-- ${version}`,
  checksum: `sum-${version}`.padEnd(64, '0'),
});
const M = [
  mig('0001', 'base'),
  mig('0002', 'expand'),
  mig('0003', 'tighten_contract'),
  mig('0004', 'later_feature'),
];
const applied = (...versions: string[]): Map<string, string> =>
  new Map(versions.map((v) => [v, M.find((m) => m.version === v)!.checksum]));
const versions = (ms: readonly Migration[]): string[] => ms.map((m) => m.version);

describe('migration plan: contract gate', () => {
  it('only a name ending in _contract designates a contract migration', () => {
    expect(isContractMigration({ name: 'tighten_contract' })).toBe(true);
    expect(isContractMigration({ name: 'contract_notes' })).toBe(false);
    expect(isContractMigration({ name: 'contracts' })).toBe(false);
  });

  it('by default it runs everything before the contract migration and defers it AND everything after it', () => {
    const plan = planMigrations(M, new Map());
    expect(versions(plan.run)).toEqual(['0001', '0002']);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']); // 0004 must not run ahead of 0003
  });

  it('a deferred contract migration stays deferred on every later ordinary run', () => {
    const plan = planMigrations(M, applied('0001', '0002'));
    expect(plan.alreadyApplied).toEqual(['0001', '0002']);
    expect(plan.run).toEqual([]);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']);
  });

  it('naming the exact version runs it, in order, followed by the later migrations', () => {
    const plan = planMigrations(M, applied('0001', '0002'), ['0003']);
    expect(versions(plan.run)).toEqual(['0003', '0004']);
    expect(plan.deferred).toEqual([]);
  });

  it('the opt-in does not reorder: on an empty ledger (fresh database) earlier migrations still run first, in one pass', () => {
    expect(versions(planMigrations(M, new Map(), ['0003']).run)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
  });

  it('a wrong, malformed, wildcard or non-contract opt-in is an error and authorises nothing', () => {
    for (const bad of ['0004', '0001', '0099', '3', '0003 ', '0003,0004', 'all', '*', '']) {
      expect(() => planMigrations(M, new Map(), [bad]), JSON.stringify(bad)).toThrow(
        /no contract migration with that exact version/,
      );
    }
  });

  it('already-applied contract migrations need no opt-in and are not re-run', () => {
    const plan = planMigrations(M, applied('0001', '0002', '0003', '0004'));
    expect(plan.run).toEqual([]);
    expect(plan.deferred).toEqual([]);
    expect(plan.alreadyApplied).toEqual(['0001', '0002', '0003', '0004']);
  });

  it('checksum drift and a migration missing from source control are errors, even behind a blocked one', () => {
    const drifted = new Map([['0001', 'f'.repeat(64)]]);
    expect(() => planMigrations(M, drifted)).toThrow(/checksum drift/);
    expect(() => planMigrations(M, new Map([['0009', 'x']]))).toThrow(
      /missing from source control/,
    );
  });

  it('the real migration directory designates 0009 and 0019 (and only those) as contract migrations', () => {
    expect(contractVersions()).toEqual(['0009', '0019']);
    const all = loadMigrations();
    const plan = planMigrations(all, new Map());
    expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
    expect(versions(plan.deferred)[0]).toBe('0009');
    expect(versions(plan.deferred).at(-1)).toBe('0036');
    expect(versions(plan.run)).toEqual(all.slice(0, 8).map((m) => m.version));
  });

  it('loadMigrations still enforces contiguous versions regardless of the suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campusos-plan-'));
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1');
    writeFileSync(join(dir, '0003_b_contract.sql'), 'SELECT 1');
    expect(() => loadMigrations(dir)).toThrow(/contiguous/);
  });
});

// PHASE BOUNDARY (F2.11): on an existing database the contract migration must be the first thing an invocation
// applies. The ledger is the only input, so these tests prove the planner's decision, not that the application was
// deployed or the writers drained (that remains the operator's responsibility).
describe('migration plan: phase boundary', () => {
  const REFUSED = /cannot run in the same invocation as pending/;

  it('refuses the contract migration while an earlier migration is pending on an existing database', () => {
    // 0001 applied; 0002 (expand) pending; naming 0003 must not also apply 0002
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(REFUSED);
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(/pending 0002\./);
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(/Nothing was applied/);
  });

  it('the refusal tells the operator the two-step order and keeps the exact-version confirmation', () => {
    expect(() => planMigrations(M, applied('0001'), ['0003'])).toThrow(
      /pnpm db:migrate`.*then run `pnpm db:migrate --allow-contract 0003`/s,
    );
  });

  it('the ordinary run on the same ledger applies only the expand migration and still defers the rest', () => {
    const plan = planMigrations(M, applied('0001'));
    expect(versions(plan.run)).toEqual(['0002']);
    expect(versions(plan.deferred)).toEqual(['0003', '0004']);
  });

  it('allows the contract migration once everything before it is applied (and later ones follow)', () => {
    const plan = planMigrations(M, applied('0001', '0002'), ['0003']);
    expect(versions(plan.run)).toEqual(['0003', '0004']);
  });

  it('naming an already-applied contract migration is a harmless no-op', () => {
    const plan = planMigrations(M, applied('0001', '0002', '0003', '0004'), ['0003']);
    expect(plan.run).toEqual([]);
    expect(plan.deferred).toEqual([]);
  });

  it('an empty ledger (brand-new database) may be built in one pass', () => {
    expect(versions(planMigrations(M, new Map(), ['0003']).run)).toEqual([
      '0001',
      '0002',
      '0003',
      '0004',
    ]);
  });

  it('every contract migration needs its own invocation: a second one behind other work is refused', () => {
    const two = [
      mig('0001', 'base'),
      mig('0002', 'first_contract'),
      mig('0003', 'expand_again'),
      mig('0004', 'second_contract'),
    ];
    const done = new Map([['0001', two[0]!.checksum]]);
    // 0002 is first (allowed) but 0004 follows 0002 and 0003 in the same invocation
    expect(() => planMigrations(two, done, ['0002', '0004'])).toThrow(REFUSED);
    // separate invocations are fine
    const d3 = new Map(two.slice(0, 3).map((m) => [m.version, m.checksum]));
    expect(versions(planMigrations(two, done, ['0002']).run)).toEqual(['0002', '0003']);
    expect(versions(planMigrations(two, d3, ['0004']).run)).toEqual(['0004']);
  });

  it('a ledger that is not a contiguous prefix is refused before anything is planned', () => {
    // 0003 recorded but 0002 missing: out-of-order, cannot be produced by the runner
    expect(() => planMigrations(M, applied('0001', '0003'))).toThrow(/not a contiguous prefix/);
    expect(() => planMigrations(M, applied('0003'), ['0003'])).toThrow(/not a contiguous prefix/);
    expect(() => planMigrations(M, applied('0002'))).toThrow(/0002 is recorded but 0001 is not/);
  });

  describe('against the real migrations 0007 / 0008 / 0009', () => {
    const all = loadMigrations();
    const upTo = (n: number): Map<string, string> =>
      new Map(all.filter((m) => Number(m.version) <= n).map((m) => [m.version, m.checksum]));

    it('ledger at 0007: the ordinary run applies 0008 and defers 0009 and everything after it', () => {
      const plan = planMigrations(all, upTo(7));
      expect(versions(plan.run)).toEqual(['0008']);
      expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
    });

    it('ledger at 0007: --allow-contract 0009 is REFUSED, so 0008 and 0009 are not run in one invocation', () => {
      expect(() => planMigrations(all, upTo(7), ['0009'])).toThrow(REFUSED);
      expect(() => planMigrations(all, upTo(7), ['0009'])).toThrow(/pending 0008\./);
    });

    it('ledger anywhere before 0008: --allow-contract 0009 is refused, whatever else is pending', () => {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        expect(() => planMigrations(all, upTo(n), ['0009']), `ledger at 000${n}`).toThrow(REFUSED);
      }
    });

    it('ledger at 0008: --allow-contract 0009 runs 0009 through 0018 and defers 0019 to 0030; without the flag everything stays deferred', () => {
      const plan = planMigrations(all, upTo(8), ['0009']);
      expect(versions(plan.run)).toEqual(all.slice(8, 18).map((m) => m.version)); // 0009 .. 0018
      expect(versions(plan.run).at(-1)).toBe('0018');
      expect(versions(plan.deferred)).toEqual([
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
        '0030',
        '0031',
        '0032',
        '0033',
        '0034',
        '0035',
        '0036',
      ]);
      const ordinary = planMigrations(all, upTo(8));
      expect(ordinary.run).toEqual([]);
      expect(versions(ordinary.deferred)).toEqual(all.slice(8).map((m) => m.version));
    });

    it('ledger at 0008: naming both contract versions is REFUSED (0019 would not be the first migration applied)', () => {
      expect(() => planMigrations(all, upTo(8), ['0009', '0019'])).toThrow(REFUSED);
      expect(() => planMigrations(all, upTo(8), ['0009', '0019'])).toThrow(
        /Contract migration 0019_\w+ cannot run in the same invocation as pending 0009/,
      );
    });

    it('ledger at 0009: runs pending ordinary migrations 0010 through 0018 and defers 0019 to 0030', () => {
      for (const allow of [[], ['0009']]) {
        const plan = planMigrations(all, upTo(9), allow);
        expect(versions(plan.run)).toEqual(all.slice(9, 18).map((m) => m.version)); // 0010 .. 0018
        expect(versions(plan.deferred)).toEqual([
          '0019',
          '0020',
          '0021',
          '0022',
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
      }
    });

    it('ledger at 0018: 0019 to 0030 are deferred by default; naming 0019 runs 0019 FIRST and then 0020 to 0030; 0019 cannot join 0010-0018', () => {
      const at18 = upTo(18);
      const ordinary = planMigrations(all, at18);
      expect(ordinary.run).toEqual([]);
      expect(versions(ordinary.deferred)).toEqual([
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
        '0030',
        '0031',
        '0032',
        '0033',
        '0034',
        '0035',
        '0036',
      ]);
      expect(planMigrations(all, at18, ['0019']).deferred).toEqual([]);
      expect(versions(planMigrations(all, at18, ['0019']).run)).toEqual([
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
        '0030',
        '0031',
        '0032',
        '0033',
        '0034',
        '0035',
        '0036',
      ]);
      expect(() => planMigrations(all, upTo(9), ['0019'])).toThrow(REFUSED);
      expect(() => planMigrations(all, upTo(9), ['0019'])).toThrow(/pending 0010, /);
    });

    it('ledger at 0019: 0020 to 0030 run by themselves (none is a contract migration, so no opt-in is needed); ledger at 0030: nothing to do', () => {
      for (const allow of [[], ['0009'], ['0009', '0019']]) {
        const plan = planMigrations(all, upTo(19), allow);
        expect(versions(plan.run)).toEqual([
          '0020',
          '0021',
          '0022',
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(plan.deferred).toEqual([]);
        const at20 = planMigrations(all, upTo(20), allow);
        expect(versions(at20.run)).toEqual([
          '0021',
          '0022',
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at20.deferred).toEqual([]);
        const at21 = planMigrations(all, upTo(21), allow);
        expect(versions(at21.run)).toEqual([
          '0022',
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at21.deferred).toEqual([]);
        const at22 = planMigrations(all, upTo(22), allow);
        expect(versions(at22.run)).toEqual([
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at22.deferred).toEqual([]);
        const at23 = planMigrations(all, upTo(23), allow);
        expect(versions(at23.run)).toEqual([
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at23.deferred).toEqual([]);
        const at24 = planMigrations(all, upTo(24), allow);
        expect(versions(at24.run)).toEqual([
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at24.deferred).toEqual([]);
        const at25 = planMigrations(all, upTo(25), allow);
        expect(versions(at25.run)).toEqual([
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at25.deferred).toEqual([]);
        const at26 = planMigrations(all, upTo(26), allow);
        expect(versions(at26.run)).toEqual([
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at26.deferred).toEqual([]);
        const at27 = planMigrations(all, upTo(27), allow);
        expect(versions(at27.run)).toEqual([
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at27.deferred).toEqual([]);
        const at28 = planMigrations(all, upTo(28), allow);
        expect(versions(at28.run)).toEqual([
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at28.deferred).toEqual([]);
        const at29 = planMigrations(all, upTo(29), allow);
        expect(versions(at29.run)).toEqual([
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(at29.deferred).toEqual([]);
        const at30 = planMigrations(all, upTo(30), allow);
        expect(versions(at30.run)).toEqual(['0031', '0032', '0033', '0034', '0035', '0036']);
        expect(at30.deferred).toEqual([]);
        const at31 = planMigrations(all, upTo(31), allow);
        expect(versions(at31.run)).toEqual(['0032', '0033', '0034', '0035', '0036']);
        expect(at31.deferred).toEqual([]);
        const at32 = planMigrations(all, upTo(32), allow);
        expect(versions(at32.run)).toEqual(['0033', '0034', '0035', '0036']);
        expect(at32.deferred).toEqual([]);
        const at33 = planMigrations(all, upTo(33), allow);
        expect(versions(at33.run)).toEqual(['0034', '0035', '0036']);
        expect(at33.deferred).toEqual([]);
        const at34 = planMigrations(all, upTo(34), allow);
        expect(versions(at34.run)).toEqual(['0035', '0036']);
        expect(at34.deferred).toEqual([]);
        const at35 = planMigrations(all, upTo(35), allow);
        expect(versions(at35.run)).toEqual(['0036']);
        expect(at35.deferred).toEqual([]);
        const done = planMigrations(all, upTo(36), allow);
        expect(done.run).toEqual([]);
        expect(done.deferred).toEqual([]);
      }
    });

    it('0020 (person-identity backstop) and 0021 (student programs) are NOT contract migrations but are deferred behind 0019', () => {
      expect(contractVersions()).not.toContain('0020');
      expect(contractVersions()).not.toContain('0021');
      expect(contractVersions()).not.toContain('0022');
      expect(contractVersions()).not.toContain('0023');
      expect(contractVersions()).not.toContain('0024');
      expect(contractVersions()).not.toContain('0025');
      expect(contractVersions()).not.toContain('0026');
      expect(contractVersions()).not.toContain('0027');
      expect(contractVersions()).not.toContain('0028');
      expect(contractVersions()).not.toContain('0029');
      expect(contractVersions()).not.toContain('0030');
      // 0018 applied, 0019 not: even an ordinary run and --allow-contract 0009 leave 0020 and 0021 deferred (blockedBy 0019)
      for (const allow of [[], ['0009']]) {
        const plan = planMigrations(all, upTo(18), allow);
        expect(versions(plan.deferred)).toEqual([
          '0019',
          '0020',
          '0021',
          '0022',
          '0023',
          '0024',
          '0025',
          '0026',
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(versions(plan.run)).not.toContain('0020');
        expect(versions(plan.run)).not.toContain('0021');
        expect(versions(plan.run)).not.toContain('0022');
        expect(versions(plan.run)).not.toContain('0023');
        expect(versions(plan.run)).not.toContain('0024');
        expect(versions(plan.run)).not.toContain('0025');
        expect(versions(plan.run)).not.toContain('0026');
        expect(versions(plan.run)).not.toContain('0027');
        expect(versions(plan.run)).not.toContain('0028');
        expect(versions(plan.run)).not.toContain('0029');
        expect(versions(plan.run)).not.toContain('0030');
      }
      // never before 0019 is applied, whatever is named
      for (const v of [
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
        '0030',
        '0031',
        '0032',
        '0033',
        '0034',
        '0035',
        '0036',
      ]) {
        expect(() => planMigrations(all, upTo(18), [v])).toThrow(
          /no contract migration with that exact version/,
        );
      }
    });

    it('empty ledger: a brand-new database is built in one pass; 0019 (and with it 0020 to 0030) are built only when 0019 is named too', () => {
      const withoutBackstop = planMigrations(all, new Map(), ['0009']);
      expect(versions(withoutBackstop.run)).toEqual(all.slice(0, 18).map((m) => m.version));
      expect(versions(withoutBackstop.deferred)).toEqual([
        '0019',
        '0020',
        '0021',
        '0022',
        '0023',
        '0024',
        '0025',
        '0026',
        '0027',
        '0028',
        '0029',
        '0030',
        '0031',
        '0032',
        '0033',
        '0034',
        '0035',
        '0036',
      ]);
      expect(versions(planMigrations(all, new Map(), ['0009', '0019']).run)).toEqual(
        all.map((m) => m.version),
      );
    });

    it('inconsistent ledgers are refused: 0009 without 0008, a gap, or a version missing from source control', () => {
      const without0008 = upTo(9);
      without0008.delete('0008');
      expect(() => planMigrations(all, without0008, ['0009'])).toThrow(/not a contiguous prefix/);
      const gap = upTo(7);
      gap.delete('0004');
      expect(() => planMigrations(all, gap)).toThrow(/not a contiguous prefix/);
      expect(() => planMigrations(all, new Map([...upTo(36), ['0037', 'x']]))).toThrow(
        /missing from source control/,
      );
    });

    it('a changed checksum is still reported as drift, not as a phase problem', () => {
      const drifted = upTo(8);
      drifted.set('0008', 'f'.repeat(64));
      expect(() => planMigrations(all, drifted, ['0009'])).toThrow(/checksum drift/);
    });
  });

  describe('migration plan: explicit upper bound (through)', () => {
    const all = loadMigrations();
    const upTo = (n: number): Map<string, string> =>
      new Map(all.filter((m) => Number(m.version) <= n).map((m) => [m.version, m.checksum]));

    it('rejects malformed through arguments', () => {
      for (const bad of ['19', '0019 ', '0019,0020', 'abc', '', ' 0019']) {
        expect(() => planMigrations(all, new Map(), [], bad)).toThrow(
          /must be an exact 4-digit version/,
        );
      }
    });

    it('rejects unknown migration versions in through', () => {
      for (const unknown of ['0000', '0037', '0099', '9999']) {
        expect(() => planMigrations(all, new Map(), [], unknown)).toThrow(
          /no migration with that exact version/,
        );
      }
    });

    describe('ledger at 0007', () => {
      it('with --through 0019 alone: applies 0008 and defers 0009 through 0030 (blocked by contract gate 0009)', () => {
        const plan = planMigrations(all, upTo(7), [], '0019');
        expect(versions(plan.run)).toEqual(['0008']);
        expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
        expect(plan.blockedBy).toBe('0009');
      });

      it('with --through 0008: applies 0008 and defers 0009 through 0030 (deferred by upper bound 0008)', () => {
        const plan = planMigrations(all, upTo(7), [], '0008');
        expect(versions(plan.run)).toEqual(['0008']);
        expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
        expect(plan.deferredByThrough).toBe('0008');
      });

      it('combinations: --through 0019 with --allow-contract 0009 is REFUSED by phase boundary', () => {
        expect(() => planMigrations(all, upTo(7), ['0009'], '0019')).toThrow(
          /Contract migration 0009_\w+ cannot run in the same invocation as pending 0008/,
        );
      });

      it('combinations: --through 0019 with --allow-contract 0009, 0019 is REFUSED by phase boundary', () => {
        expect(() => planMigrations(all, upTo(7), ['0009', '0019'], '0019')).toThrow(
          /Contract migration 0009_\w+ cannot run in the same invocation as pending 0008/,
        );
      });

      it('combinations: --through 0019 with --allow-contract 0019 alone stops at contract 0009', () => {
        const plan = planMigrations(all, upTo(7), ['0019'], '0019');
        expect(versions(plan.run)).toEqual(['0008']);
        expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
        expect(plan.blockedBy).toBe('0009');
      });
    });

    describe('ledger at 0008', () => {
      it('with --through 0019 alone: 0009 is a contract migration so nothing runs and 0009..0030 are deferred', () => {
        const plan = planMigrations(all, upTo(8), [], '0019');
        expect(plan.run).toEqual([]);
        expect(versions(plan.deferred)).toEqual(all.slice(8).map((m) => m.version));
        expect(plan.blockedBy).toBe('0009');
      });

      it('combinations: --through 0019 with --allow-contract 0009 applies 0009..0018 and defers 0019..0030 at contract 0019', () => {
        const plan = planMigrations(all, upTo(8), ['0009'], '0019');
        expect(versions(plan.run)).toEqual(all.slice(8, 18).map((m) => m.version)); // 0009..0018
        expect(versions(plan.deferred)).toEqual(all.slice(18).map((m) => m.version)); // 0019..0030
        expect(plan.blockedBy).toBe('0019');
      });

      it('combinations: --through 0014 with --allow-contract 0009 applies 0009..0014 and defers 0015..0030 by upper bound', () => {
        const plan = planMigrations(all, upTo(8), ['0009'], '0014');
        expect(versions(plan.run)).toEqual(all.slice(8, 14).map((m) => m.version)); // 0009..0014
        expect(versions(plan.deferred)).toEqual(all.slice(14).map((m) => m.version)); // 0015..0030
        expect(plan.deferredByThrough).toBe('0014');
      });

      it('combinations: --through 0019 with --allow-contract 0009 and 0019 is REFUSED by phase boundary (0019 not first)', () => {
        expect(() => planMigrations(all, upTo(8), ['0009', '0019'], '0019')).toThrow(
          /Contract migration 0019_\w+ cannot run in the same invocation as pending 0009/,
        );
      });
    });

    describe('ledger at 0018', () => {
      it('with --through 0019 alone: 0019 is contract and stays deferred without --allow-contract 0019', () => {
        const plan = planMigrations(all, upTo(18), [], '0019');
        expect(plan.run).toEqual([]);
        expect(versions(plan.deferred)).toEqual(all.slice(18).map((m) => m.version));
        expect(plan.blockedBy).toBe('0019');
      });

      it('combinations: --through 0019 with --allow-contract 0019 applies EXACTLY 0019 and defers 0020 through 0030', () => {
        const plan = planMigrations(all, upTo(18), ['0019'], '0019');
        expect(versions(plan.run)).toEqual(['0019']);
        expect(versions(plan.deferred)).toEqual(all.slice(19).map((m) => m.version)); // 0020..0030
        expect(plan.deferredByThrough).toBe('0019');
      });

      it('without --through: --allow-contract 0019 applies 0019 AND ALL later migrations through 0030', () => {
        const plan = planMigrations(all, upTo(18), ['0019']);
        expect(versions(plan.run)).toEqual(all.slice(18).map((m) => m.version)); // 0019..0030
        expect(plan.deferred).toEqual([]);
      });

      it('combinations: --through 0026 with --allow-contract 0019 applies 0019..0026 and defers 0027..0030', () => {
        const plan = planMigrations(all, upTo(18), ['0019'], '0026');
        expect(versions(plan.run)).toEqual(all.slice(18, 26).map((m) => m.version)); // 0019..0026
        expect(versions(plan.deferred)).toEqual([
          '0027',
          '0028',
          '0029',
          '0030',
          '0031',
          '0032',
          '0033',
          '0034',
          '0035',
          '0036',
        ]);
        expect(plan.deferredByThrough).toBe('0026');
      });
    });

    describe('ledger at 0019', () => {
      it('with --through 0019: 0019 already applied, so nothing runs and 0020..0030 are deferred', () => {
        const plan = planMigrations(all, upTo(19), [], '0019');
        expect(plan.run).toEqual([]);
        expect(versions(plan.deferred)).toEqual(all.slice(19).map((m) => m.version));
        expect(plan.deferredByThrough).toBe('0019');
      });

      it('with --through 0019 and --allow-contract 0019: already applied, nothing runs and 0020..0030 deferred', () => {
        const plan = planMigrations(all, upTo(19), ['0019'], '0019');
        expect(plan.run).toEqual([]);
        expect(versions(plan.deferred)).toEqual(all.slice(19).map((m) => m.version));
        expect(plan.deferredByThrough).toBe('0019');
      });

      it('with --through 0020: applies only 0020 and defers 0021..0030', () => {
        const plan = planMigrations(all, upTo(19), [], '0020');
        expect(versions(plan.run)).toEqual(['0020']);
        expect(versions(plan.deferred)).toEqual(all.slice(20).map((m) => m.version));
        expect(plan.deferredByThrough).toBe('0020');
      });

      it('without --through: ordinary run applies 0020 through 0030', () => {
        const plan = planMigrations(all, upTo(19));
        expect(versions(plan.run)).toEqual(all.slice(19).map((m) => m.version));
        expect(plan.deferred).toEqual([]);
      });
    });

    describe('invalid ordering and ledger violations', () => {
      it('rejects a through upper bound that is strictly earlier than the current ledger at 0019', () => {
        expect(() => planMigrations(all, upTo(19), [], '0018')).toThrow(
          /database ledger is already at 0019 \(cannot specify an upper bound earlier than the current ledger\)/,
        );
        expect(() => planMigrations(all, upTo(19), [], '0007')).toThrow(
          /database ledger is already at 0019 \(cannot specify an upper bound earlier than the current ledger\)/,
        );
      });

      it('rejects a through upper bound that is strictly earlier than the current ledger at 0018 or 0008', () => {
        expect(() => planMigrations(all, upTo(18), [], '0017')).toThrow(
          /database ledger is already at 0018 \(cannot specify an upper bound earlier than the current ledger\)/,
        );
        expect(() => planMigrations(all, upTo(8), [], '0007')).toThrow(
          /database ledger is already at 0008 \(cannot specify an upper bound earlier than the current ledger\)/,
        );
      });

      it('contract phase boundary ordering is preserved even with through set', () => {
        // ledger at 0007: naming contract 0009 cannot jump over pending 0008
        expect(() => planMigrations(all, upTo(7), ['0009'], '0018')).toThrow(
          /cannot run in the same invocation as pending 0008/,
        );
        // ledger at 0008: naming contract 0019 cannot jump over pending 0009
        expect(() => planMigrations(all, upTo(8), ['0009', '0019'], '0020')).toThrow(
          /cannot run in the same invocation as pending 0009/,
        );
      });
    });
  });

  describe('parseMigrateArgs CLI argument parser', () => {
    it('parses empty args as default options', () => {
      expect(parseMigrateArgs([])).toEqual({
        allowContract: [],
        dryRun: false,
      });
    });

    it('parses --through 0019 (space separated)', () => {
      expect(parseMigrateArgs(['--through', '0019'])).toEqual({
        allowContract: [],
        through: '0019',
        dryRun: false,
      });
    });

    it('parses --through=0019 (equals separated)', () => {
      expect(parseMigrateArgs(['--through=0019'])).toEqual({
        allowContract: [],
        through: '0019',
        dryRun: false,
      });
    });

    it('parses --dry-run', () => {
      expect(parseMigrateArgs(['--dry-run'])).toEqual({
        allowContract: [],
        dryRun: true,
      });
    });

    it('parses combined --allow-contract, --through, and --dry-run flags', () => {
      expect(
        parseMigrateArgs(['--allow-contract', '0019', '--through', '0019', '--dry-run']),
      ).toEqual({
        allowContract: ['0019'],
        through: '0019',
        dryRun: true,
      });
      expect(
        parseMigrateArgs([
          '--dry-run',
          '--allow-contract=0009',
          '--allow-contract=0019',
          '--through=0026',
        ]),
      ).toEqual({
        allowContract: ['0009', '0019'],
        through: '0026',
        dryRun: true,
      });
    });

    it('rejects duplicate --through flag', () => {
      expect(() => parseMigrateArgs(['--through', '0019', '--through', '0020'])).toThrow(
        '--through may only be specified once',
      );
      expect(() => parseMigrateArgs(['--through=0019', '--through=0019'])).toThrow(
        '--through may only be specified once',
      );
    });

    it('rejects duplicate --dry-run flag', () => {
      expect(() => parseMigrateArgs(['--dry-run', '--dry-run'])).toThrow(
        '--dry-run may only be specified once',
      );
    });

    it('rejects malformed versions for --through and --allow-contract', () => {
      const USAGE = /usage: migrate/;
      expect(() => parseMigrateArgs(['--through', '19'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--through', 'abc'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--through=00019'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--allow-contract', '19'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--allow-contract=abc'])).toThrow(USAGE);
    });

    it('rejects missing values for --through and --allow-contract', () => {
      const USAGE = /usage: migrate/;
      expect(() => parseMigrateArgs(['--through'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--allow-contract'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--through='])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--allow-contract='])).toThrow(USAGE);
    });

    it('rejects unknown flags and positional arguments', () => {
      const USAGE = /usage: migrate/;
      expect(() => parseMigrateArgs(['--unknown'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['--dry-run=true'])).toThrow(USAGE);
      expect(() => parseMigrateArgs(['positional'])).toThrow(USAGE);
    });
  });
});
