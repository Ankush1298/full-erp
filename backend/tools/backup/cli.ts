import * as path from 'node:path';
import * as fs from 'node:fs';
import { BackupManager } from './backup-manager.js';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const command = argv[0] || 'help';
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const manager = new BackupManager(flags['storage-dir']);

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
Anesa Campus OS - Enterprise Backup & Disaster Recovery CLI
=============================================================
Usage:
  tsx tools/backup/cli.ts <command> [options]

Commands:
  backup:create      Execute full AES-256-GCM encrypted database backup
                     [--db <url>] [--retention-days <days>] [--key <secret>]

  backup:verify      Verify cryptographic integrity & catalog of backup
                     --file <meta-file-path> [--key <secret>]

  backup:restore     Restore encrypted backup into isolated target database
                     --file <file-path> --target <target-db-url> [--key <secret>]

  backup:prune       Prune expired backups per retention policy
                     [--retention-days <days>]

  backup:rehearse    Run automated disaster recovery drill into disposable DB
                     --server-admin <admin-url> --source-db <source-url> [--key <secret>]

  backup:list        List all available backups and verification statuses
`);
    process.exit(0);
  }

  const key = flags['key'] || process.env['BACKUP_ENCRYPTION_KEY'] || 'anesa_campus_os_backup_key_32b_!';

  switch (command) {
    case 'backup:create': {
      const dbUrl = flags['db'] || process.env['DATABASE_ADMIN_URL'] || process.env['PLATFORM_DATABASE_URL'];
      if (!dbUrl) {
        console.error('Error: Database URL is required via --db or DATABASE_ADMIN_URL.');
        process.exit(1);
      }
      const days = flags['retention-days'] ? parseInt(flags['retention-days'], 10) : 30;
      console.log(`[Backup] Initiating AES-256-GCM encrypted backup...`);
      const res = await manager.createBackup({ databaseUrl: dbUrl, encryptionKey: key, retentionDays: days });
      console.log(`[Backup] Completed successfully.`);
      console.log(`  Backup ID:     ${res.metadata.backupId}`);
      console.log(`  Created:       ${res.metadata.createdAt}`);
      console.log(`  Source DB:     ${res.metadata.sourceDatabase}`);
      console.log(`  Ciphertext:    ${res.filePath} (${(res.metadata.integrity.cipherSizeBytes / 1024).toFixed(1)} KB)`);
      console.log(`  SHA-256 Hash:  ${res.metadata.integrity.ciphertextSha256}`);
      console.log(`  Metadata:      ${res.metaPath}`);
      break;
    }

    case 'backup:verify': {
      const file = flags['file'];
      if (!file) {
        console.error('Error: --file <meta-file-path> is required.');
        process.exit(1);
      }
      console.log(`[Verify] Verifying backup artifact integrity for: ${file}`);
      const res = await manager.verifyBackup(file, key);
      if (res.valid) {
        console.log(`[Verify] PASS - Cryptographic integrity and catalog valid.`);
        console.log(`  Backup ID:     ${res.backupId}`);
        console.log(`  Server:        ${res.metadata.serverVersion}`);
        console.log(`  Ledger Head:   ${res.metadata.schemaVersion}`);
        console.log(`  Institutions:  ${res.metadata.institutionCount}`);
      } else {
        console.error(`[Verify] FAIL - Tamper or integrity failure detected:`);
        res.errors.forEach((e) => console.error(`  - ${e}`));
        process.exit(1);
      }
      break;
    }

    case 'backup:restore': {
      const file = flags['file'];
      const target = flags['target'];
      if (!file || !target) {
        console.error('Error: Both --file and --target are required.');
        process.exit(1);
      }
      console.log(`[Restore] Restoring backup to target database...`);
      const res = await manager.restoreBackup({
        backupFile: file,
        targetDatabaseUrl: target,
        encryptionKey: key,
      });
      console.log(`[Restore] PASS - Database restored successfully in ${res.durationMs}ms.`);
      console.log(`  Target DB:     ${res.targetDatabase}`);
      console.log(`  Ledger Head:   ${res.migrationLedgerHead}`);
      console.log(`  Institutions:  ${res.institutionCount}`);
      break;
    }

    case 'backup:prune': {
      const days = flags['retention-days'] ? parseInt(flags['retention-days'], 10) : 30;
      console.log(`[Retention] Pruning backups older than ${days} days...`);
      const res = manager.pruneExpiredBackups(days);
      console.log(`[Retention] Pruning complete: ${res.prunedCount} deleted, ${res.remainingCount} retained.`);
      break;
    }

    case 'backup:rehearse': {
      const serverAdmin = flags['server-admin'];
      const sourceDb = flags['source-db'];
      if (!serverAdmin || !sourceDb) {
        console.error('Error: --server-admin and --source-db are required for DR rehearsal.');
        process.exit(1);
      }
      console.log(`[DR Rehearsal] Executing automated recovery rehearsal...`);
      const report = await manager.runDisasterRecoveryRehearsal({
        serverAdminUrl: serverAdmin,
        sourceDbUrl: sourceDb,
        encryptionKey: key,
      });
      console.log(`[DR Rehearsal] Verdict: ${report.verdict}`);
      console.log(`  Duration:      ${report.durationMs}ms (RTO: ${report.evidence.rtoSeconds}s)`);
      console.log(`  Ledger Check:  ${report.verifications.migrationLedgerPass ? 'PASS' : 'FAIL'} (${report.evidence.ledgerRows} migrations)`);
      console.log(`  RLS Security:  ${report.verifications.rlsEnforcementPass ? 'PASS' : 'FAIL'} (${report.evidence.tablesAudited} tables audited)`);
      console.log(`  Tenant Check:  ${report.verifications.tenantIsolationPass ? 'PASS' : 'FAIL'} (${report.evidence.orgCount} institutions)`);
      console.log(`  Vault Isolation: ${report.verifications.vaultZeroAccessPass ? 'PASS' : 'FAIL'}`);
      console.log(`  Disposable DB Dropped: ${report.disposableDbDropped ? 'YES' : 'NO'}`);
      break;
    }

    case 'backup:list': {
      const dir = flags['storage-dir'] || path.resolve(process.cwd(), '.data/backups');
      if (!fs.existsSync(dir)) {
        console.log(`[Backup] No backups directory at ${dir}`);
        break;
      }
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
      console.log(`[Backup] Total Backups: ${files.length} (directory: ${dir})\n`);
      for (const f of files) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          console.log(`- ${meta.backupId}`);
          console.log(`  Created:      ${meta.createdAt}`);
          console.log(`  Source DB:    ${meta.sourceDatabase}`);
          console.log(`  Status:       ${meta.status}`);
          console.log(`  Size:         ${(meta.integrity.cipherSizeBytes / 1024).toFixed(1)} KB`);
          console.log(`  File:         ${f}\n`);
        } catch {}
      }
      break;
    }

    default:
      console.error(`Unknown command "${command}". Run with --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Error]', (err as Error).message);
  process.exit(1);
});
