import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The real CLI, run as a child process, database-free: the environment is scrubbed to PATH and HOME, so there is no
// connection string to read and nothing to connect to. The point is the exit code and message: a migration command
// must never exit 0 without having run, however the file was reached.

const TSX = resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
const CLI = resolve(import.meta.dirname, '../../tools/db/cli.ts');
const scratch = mkdtempSync(join(tmpdir(), 'campusos-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(script: string, args: string[]) {
  const r = spawnSync(TSX, [script, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? scratch },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('tools/db/cli.ts always runs and fails loudly', () => {
  it('migrate without a connection string exits 1 and names the variable (never a silent exit 0)', () => {
    const r = run(CLI, ['migrate']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MIGRATION_DATABASE_URL is not set');
    expect(r.stdout).toBe('');
  });

  it('the same when the file is reached through a symlink with an unrelated name', () => {
    const link = join(scratch, 'run-migrations.ts');
    symlinkSync(CLI, link);
    const r = run(link, ['migrate', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('MIGRATION_DATABASE_URL is not set');
  });

  it('bootstrap without its variables exits 1 as well', () => {
    const r = run(CLI, ['bootstrap']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not set/);
  });

  it('a missing or unknown command prints the usage and exits 1', () => {
    for (const args of [[], ['frobnicate']]) {
      const r = run(CLI, args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr).toContain('usage: cli.ts <bootstrap|migrate>');
    }
  });

  it('malformed flags are refused with the usage BEFORE anything else (no environment is even consulted)', () => {
    for (const args of [
      ['migrate', '--through', '19'],
      ['migrate', '--dry-run=true'],
      ['migrate', '--allow-contract'],
      ['migrate', 'positional'],
      ['migrate', '--through', '0019', '--through', '0020'],
    ]) {
      const r = run(CLI, args);
      expect(r.status, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/usage: migrate|may only be specified once/);
      expect(r.stderr).not.toContain('is not set');
    }
  });
});
