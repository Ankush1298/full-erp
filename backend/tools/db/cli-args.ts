/**
 * Argument parsing for `tsx tools/db/cli.ts migrate`. Pure (no I/O, no environment), so it can be unit-tested by
 * importing it. It lives apart from cli.ts on purpose: cli.ts runs unconditionally when loaded, so that no way of
 * invoking it can ever turn into a silent no-op that exits 0 without having migrated anything.
 */

export interface MigrateCliOptions {
  allowContract: string[];
  through?: string | undefined;
  dryRun: boolean;
}

const USAGE =
  'usage: migrate [--allow-contract <exact 4-digit version>]... [--through <exact 4-digit version>] [--dry-run]';

export function parseMigrateArgs(args: readonly string[]): MigrateCliOptions {
  let through: string | undefined;
  let dryRun = false;
  const allowContract: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--allow-contract' || arg.startsWith('--allow-contract=')) {
      const value =
        arg === '--allow-contract' ? args[++i] : /^--allow-contract=(.*)$/.exec(arg)?.[1];
      if (value === undefined || !/^\d{4}$/.test(value)) {
        throw new Error(USAGE);
      }
      allowContract.push(value);
    } else if (arg === '--through' || arg.startsWith('--through=')) {
      const value = arg === '--through' ? args[++i] : /^--through=(.*)$/.exec(arg)?.[1];
      if (value === undefined || !/^\d{4}$/.test(value)) {
        throw new Error(USAGE);
      }
      if (through !== undefined) {
        throw new Error('--through may only be specified once');
      }
      through = value;
    } else if (arg === '--dry-run') {
      if (dryRun) {
        throw new Error('--dry-run may only be specified once');
      }
      dryRun = true;
    } else {
      throw new Error(USAGE);
    }
  }

  return {
    allowContract,
    ...(through !== undefined ? { through } : {}),
    dryRun,
  };
}
