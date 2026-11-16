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
  grantAuthority,
  parseArgs,
  seedTenant,
  suspendTenant,
} from './platform-cli.js';
import {
  assertLocalTokenOutput,
  issueFirstAdminInvitation,
  issueFirstAdminMfaTicket,
  issueStaffInvitationLink,
  revokeFirstAdminInvitation,
} from './first-admin.js';

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
    (() => {
      console.error(
        'Error: PLATFORM_DATABASE_URL is required. Silent fallback to DATABASE_ADMIN_URL or superuser privileges is disabled for platform isolation (doc 48 §1.3).',
      );
      process.exit(1);
    })();

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const { command, flags } = parsed;

    if (command === 'tenant:create') {
      const name = flags['name'];
      const slug = flags['slug'];
      const adminEmail = flags['admin-email'];
      const rawType = flags['type'] || flags['institution-type'];
      const adminTitle = flags['admin-title'];

      if (!name || !slug) {
        console.error('Error: --name and --slug flags are required for tenant:create.');
        process.exit(1);
      }

      const res = await createTenant(client, {
        name,
        slug,
        adminEmail,
        ...(rawType ? { institutionType: rawType.toUpperCase() as any } : {}),
        ...(adminTitle ? { adminTitle } : {}),
      });
      console.log('Tenant provisioned successfully:');
      console.log(`  ID:     ${res.id}`);
      console.log(`  Name:   ${res.name}`);
      console.log(`  Slug:   ${res.slug}`);
      console.log(`  Type:   ${res.institutionType}`);
      console.log(`  Status: ${res.status}`);
      if (res.adminUserId) {
        console.log(`  Admin User ID: ${res.adminUserId} (${adminEmail})`);
        console.log(`  Admin Title:   ${res.adminTitle || 'Administrator'}`);
        console.log(
          '  Next: admin:invite --tenant <slug> (the administrator has no invitation yet).',
        );
      }
    } else if (command === 'tenant:seed' || command === 'tenant:reconcile') {
      const tenant = flags['tenant'];
      if (!tenant) {
        console.error(`Error: --tenant <id|slug> is required for ${command}.`);
        process.exit(1);
      }
      const dryRun = flags['dry-run'] === 'true';
      const allowCritical = flags['allow-critical'] === 'true';

      const res = await seedTenant(client, tenant, { dryRun, allowCritical });
      if (res.dryRun && res.plan) {
        console.log(`[DRY-RUN] Reconciliation Plan for "${res.name}" (${res.id}):`);
        console.log(`  Already Present Grants:    ${res.plan.alreadyPresentCount}`);
        console.log(`  Proposed Additions:        ${res.plan.proposedAdditions.length}`);
        console.log(`  Skipped Critical Grants:   ${res.plan.skippedCritical.length}`);
        console.log(`  Preserved Custom Grants:   ${res.plan.preservedCustomizations.length}`);
        console.log(`  Explicit Denials Honored:  ${res.plan.explicitDenials.length}`);
        if (res.plan.proposedAdditions.length > 0) {
          console.log('\n  Proposed Additions:');
          for (const a of res.plan.proposedAdditions) {
            console.log(`    + [${a.roleCode}] ${a.permissionCode} (${a.scopeMode})${a.isCritical ? ' [CRITICAL]' : ''}`);
          }
        }
        if (res.plan.skippedCritical.length > 0) {
          console.log('\n  Skipped Critical Capabilities (require --allow-critical to grant):');
          for (const s of res.plan.skippedCritical) {
            console.log(`    * [${s.roleCode}] ${s.permissionCode}: ${s.reason}`);
          }
        }
        if (res.plan.preservedCustomizations.length > 0) {
          console.log('\n  Preserved Custom Grants (will not be deleted):');
          for (const p of res.plan.preservedCustomizations) {
            console.log(`    = [${p.roleCode}] ${p.permissionCode} (${p.scopeMode})`);
          }
        }
      } else {
        console.log(
          `Tenant roles and permissions successfully reconciled for "${res.name}" (${res.id}).`,
        );
        if (res.reconciliation) {
          console.log(`  Added Grants:            ${res.reconciliation.addedGrants.length}`);
          console.log(`  Preserved Custom Grants: ${res.reconciliation.preservedCustomGrants.length}`);
          console.log(`  Skipped Critical Grants: ${res.reconciliation.skippedCriticalCount}`);
        }
      }
    } else if (command === 'tenant:suspend') {
      const tenant = flags['tenant'];
      const reason = flags['reason'];
      if (!tenant) {
        console.error('Error: --tenant <id|slug> is required for tenant:suspend.');
        process.exit(1);
      }

      const res = await suspendTenant(client, tenant, reason);
      console.log(`Tenant "${res.name}" (${res.id}) has been SUSPENDED.`);
    } else if (command === 'authority:grant') {
      const tenant = flags['tenant'];
      const authority = flags['authority'] as any;
      const role = flags['role'] || 'COLLEGE_ADMIN';
      const approvedBy = flags['approved-by'];
      const justification = flags['justification'];

      if (!tenant || !authority || !approvedBy || !justification) {
        console.error(
          'Error: --tenant <id|slug>, --authority <SECURITY_AUTHORITY|FINANCIAL_GATEWAY_AUTHORITY>, --approved-by <user_id>, and --justification <reason> are required.',
        );
        process.exit(1);
      }

      const res = await grantAuthority(client, {
        tenant,
        authority,
        roleCode: role,
        approvedBy,
        justification,
      });

      console.log(`Authority "${res.authority}" successfully granted for "${res.name}":`);
      console.log(`  Role:           ${res.roleCode}`);
      console.log(`  Approved By:    ${res.approvedBy}`);
      console.log(`  Justification:  ${res.justification}`);
      console.log(`  Granted Perms:  ${res.grantedPermissions.join(', ')}`);
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
    } else if (command === 'staff:invite-link') {
      const tenant = flags['tenant'];
      if (!tenant) throw new Error('--tenant is required for staff:invite-link.');
      const email = flags['email'];
      if (!email) throw new Error('--email is required for staff:invite-link.');
      assertLocalTokenOutput(connectionString, process.env);
      const hours = flags['hours'] ? Number(flags['hours']) : undefined;
      const res = await issueStaffInvitationLink(client, {
        tenant,
        email,
        ...(hours !== undefined ? { ttlHours: hours } : {}),
        ...(flags['reason'] ? { reason: flags['reason'] } : {}),
      });
      console.log('Staff activation link (shown once; share directly with staff member):');
      console.log(`  Tenant ID:   ${res.tenantId}`);
      console.log(`  User ID:     ${res.userId}`);
      console.log(`  Name:        ${res.displayName}`);
      console.log(`  Email:       ${res.email}`);
      console.log(
        `  Expires:     ${res.expiresAt}${res.reissued ? '  (an earlier unused invitation was withdrawn)' : ''}`,
      );
      console.log(`  Accept Link: ${res.acceptUrl}`);
    } else {
      console.error(`Unknown command: ${command}`);
      console.error(
        'Supported commands: tenant:create, tenant:seed, tenant:suspend, support:grant, admin:invite, admin:invite-revoke, admin:mfa-ticket, staff:invite-link',
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
