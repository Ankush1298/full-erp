/**
 * Usage:
 *   tsx tools/platform/cli.ts tenant:create --name <name> --slug <slug> [--admin-email <email>]
 *   tsx tools/platform/cli.ts tenant:seed --tenant <id|slug>
 *   tsx tools/platform/cli.ts tenant:suspend --tenant <id|slug> [--reason <text>]
 *   tsx tools/platform/cli.ts support:grant --tenant <id|slug> --admin-email <email> [--duration-hours <1-8>]
 */
import pg from 'pg';
import {
  SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE,
  createTenant,
  parseArgs,
  seedTenant,
  suspendTenant,
} from './platform-cli.js';
import {
  assertLocalTokenOutput,
  issueFirstAdminInvitation,
  issueFirstAdminMfaTicket,
  revokeFirstAdminInvitation,
} from './first-admin.js';

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Error: environment variable ${name} is required.`);
    process.exit(1);
  }
  return v;
}

async function main(argv: readonly string[]): Promise<void> {
  let parsed: { command: string; flags: Record<string, string> };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (parsed.command === 'support:grant') {
    // Fail closed BEFORE any database connection or secret is read (doc 48 §2).
    console.error(`Error: ${SUPPORT_GRANTS_NOT_IMPLEMENTED_MESSAGE}`);
    process.exit(1);
  }

  const connectionString =
    process.env['PLATFORM_DATABASE_URL'] ||
    process.env['DATABASE_ADMIN_URL'] ||
    process.env['MIGRATION_DATABASE_URL'] ||
    requiredEnv('DATABASE_ADMIN_URL');

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { command, flags } = parsed;

    if (command === 'tenant:create') {
      const name = flags['name'];
      const slug = flags['slug'];
      const adminEmail = flags['admin-email'];

      if (!name || !slug) {
        console.error('Error: --name and --slug flags are required for tenant:create.');
        process.exit(1);
      }

      const res = await createTenant(client, { name, slug, adminEmail });
      console.log('Tenant provisioned successfully:');
      console.log(`  ID:     ${res.id}`);
      console.log(`  Name:   ${res.name}`);
      console.log(`  Slug:   ${res.slug}`);
      console.log(`  Status: ${res.status}`);
      if (res.adminUserId) {
        console.log(`  Admin User ID: ${res.adminUserId} (${adminEmail})`);
        console.log(
          '  Next: admin:invite --tenant <slug> (the administrator has no invitation yet).',
        );
      }
    } else if (command === 'tenant:seed') {
      const tenant = flags['tenant'];
      if (!tenant) {
        console.error('Error: --tenant <id|slug> is required for tenant:seed.');
        process.exit(1);
      }

      const res = await seedTenant(client, tenant);
      console.log(
        `Tenant roles and permissions successfully re-synced for "${res.name}" (${res.id}).`,
      );
    } else if (command === 'tenant:suspend') {
      const tenant = flags['tenant'];
      const reason = flags['reason'];
      if (!tenant) {
        console.error('Error: --tenant <id|slug> is required for tenant:suspend.');
        process.exit(1);
      }

      const res = await suspendTenant(client, tenant, reason);
      console.log(`Tenant "${res.name}" (${res.id}) has been SUSPENDED.`);
    } else if (command === 'admin:invite') {
      const tenant = flags['tenant'];
      if (!tenant) throw new Error('--tenant is required for admin:invite.');
      assertLocalTokenOutput(connectionString, process.env); // refuse BEFORE issuing anything
      const hours = flags['hours'] ? Number(flags['hours']) : undefined;
      const res = await issueFirstAdminInvitation(client, {
        tenant,
        ...(flags['admin-email'] ? { adminEmail: flags['admin-email'] } : {}),
        ...(hours !== undefined ? { ttlHours: hours } : {}),
        ...(flags['reason'] ? { reason: flags['reason'] } : {}),
      });
      console.log(
        'First-administrator invitation issued (shown once; store nowhere, share only with the administrator):',
      );
      console.log(`  Tenant ID:  ${res.tenantId}`);
      console.log(`  User ID:    ${res.userId}`);
      console.log(
        `  Expires:    ${res.expiresAt}${res.reissued ? '  (an earlier unused invitation was withdrawn)' : ''}`,
      );
      console.log(`  Invitation: ${res.token}`);
    } else if (command === 'admin:invite-revoke') {
      const tenant = flags['tenant'];
      if (!tenant) throw new Error('--tenant is required for admin:invite-revoke.');
      const res = await revokeFirstAdminInvitation(client, {
        tenant,
        ...(flags['reason'] ? { reason: flags['reason'] } : {}),
      });
      console.log(
        `Withdrew ${res.revoked} unused first-administrator invitation(s) for ${res.tenantId}.`,
      );
    } else if (command === 'admin:mfa-ticket') {
      const tenant = flags['tenant'];
      if (!tenant) throw new Error('--tenant is required for admin:mfa-ticket.');
      assertLocalTokenOutput(connectionString, process.env);
      const res = await issueFirstAdminMfaTicket(client, {
        tenant,
        ...(flags['admin-email'] ? { adminEmail: flags['admin-email'] } : {}),
        ...(flags['reason'] ? { reason: flags['reason'] } : {}),
      });
      console.log(
        'One-time MFA enrollment ticket issued (shown once; the administrator pastes it at enrollment):',
      );
      console.log(`  Tenant ID:  ${res.tenantId}`);
      console.log(`  User ID:    ${res.userId}`);
      console.log(`  Expires:    ${res.expiresAt}`);
      console.log(`  Ticket:     ${res.ticket}`);
    } else {
      console.error(`Unknown command: ${command}`);
      console.error(
        'Supported commands: tenant:create, tenant:seed, tenant:suspend, support:grant, admin:invite, admin:invite-revoke, admin:mfa-ticket',
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Only run automatically when executed directly from the command line
if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
