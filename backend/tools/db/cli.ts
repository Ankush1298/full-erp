/**
 * Usage: tsx tools/db/cli.ts bootstrap
 *        tsx tools/db/cli.ts migrate [--allow-contract <NNNN>]... [--through <NNNN>] [--dry-run]
 *
 * Contract migrations (`*_contract.sql`) are deferred unless their EXACT version is named with
 * --allow-contract. There is deliberately no environment variable and no wildcard for this: a value left in
 * .env must never authorise a schema-tightening migration. See docs/architecture/v3/18-academic-structure-f21.md.
 */
import { bootstrapDatabase } from './bootstrap.js';
import { parseMigrateArgs, type MigrateCliOptions } from './cli-args.js';
import { migrate } from './migrate.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return v;
}

function passwordOf(url: string): string {
  return decodeURIComponent(new URL(url).password);
}

async function main(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];
  if (cmd === 'bootstrap') {
    await bootstrapDatabase({
      adminUrl: required('DATABASE_ADMIN_URL'),
      runtimePassword: passwordOf(required('DATABASE_URL')),
      migratorPassword: passwordOf(required('MIGRATION_DATABASE_URL')),
    });
    console.log('bootstrap: roles and schemas ready');
  } else if (cmd === 'migrate') {
    let parsed: MigrateCliOptions;
    try {
      parsed = parseMigrateArgs(argv.slice(1));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    const r = await migrate({
      connectionString: required('MIGRATION_DATABASE_URL'),
      allowContract: parsed.allowContract,
      ...(parsed.through !== undefined ? { through: parsed.through } : {}),
      ...(parsed.dryRun ? { dryRun: true } : {}),
    });

    if (r.dryRun) {
      const ledgerHead =
        r.alreadyApplied.length > 0 ? r.alreadyApplied.at(-1)! : 'none (empty ledger)';
      console.log(
        'migrate (DRY RUN): connected to database (read-only ledger inspection; NO changes made)',
      );
      console.log(`migrate (DRY RUN): current ledger head: ${ledgerHead}`);
      console.log(
        `migrate (DRY RUN): planned to run [${r.planned && r.planned.length > 0 ? r.planned.join(', ') : 'none'}]`,
      );
      if (r.deferred.length > 0) {
        if (r.blockedBy) {
          console.warn(
            `migrate (DRY RUN): DEFERRED [${r.deferred.join(', ')}]: contract migration ${r.blockedBy} needs explicit authorisation ` +
              `(--allow-contract ${r.blockedBy}) AFTER every writer has been upgraded and legacy writers drained. Nothing after it was planned.`,
          );
        } else if (r.deferredByThrough) {
          console.log(
            `migrate (DRY RUN): DEFERRED [${r.deferred.join(', ')}]: upper bound --through ${r.deferredByThrough} reached. Later migrations were not planned.`,
          );
        } else {
          console.log(`migrate (DRY RUN): DEFERRED [${r.deferred.join(', ')}]`);
        }
      }
      console.log(
        'migrate (DRY RUN): Precondition note: A dry run checks ledger contiguity and phase boundaries only; ' +
          'it cannot verify whether application deployments, backfills, or writer drains have occurred in production.',
      );
    } else {
      console.log(
        `migrate: applied [${r.applied.join(', ')}], already applied [${r.alreadyApplied.join(', ')}]`,
      );
      if (r.deferred.length > 0) {
        if (r.blockedBy) {
          console.warn(
            `migrate: DEFERRED [${r.deferred.join(', ')}]: contract migration ${r.blockedBy} needs explicit authorisation ` +
              `(--allow-contract ${r.blockedBy}) AFTER every writer has been upgraded. Nothing after it was applied.`,
          );
        } else if (r.deferredByThrough) {
          console.log(
            `migrate: DEFERRED [${r.deferred.join(', ')}]: upper bound --through ${r.deferredByThrough} reached. Later migrations were not applied.`,
          );
        } else {
          console.log(`migrate: DEFERRED [${r.deferred.join(', ')}]`);
        }
      }
    }
  } else {
    console.error('usage: cli.ts <bootstrap|migrate>');
    process.exit(1);
  }
}

// Unconditional, however this file was reached (relative path, symlink, wrapper): a migration command that can exit 0
// without having run is worse than one that fails. Nothing imports this file; the parser is in cli-args.ts.
await main(process.argv.slice(2));
