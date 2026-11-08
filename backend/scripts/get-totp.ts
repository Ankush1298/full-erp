/**
 * Smart Campus OS - TOTP Generator CLI
 *
 * Generates the current 6-digit TOTP verification code for any of the MFA accounts.
 *
 * Usage:
 *   pnpm --filter @campusos/backend exec tsx scripts/get-totp.ts
 *   pnpm --filter @campusos/backend exec tsx scripts/get-totp.ts college_admin@dev.local
 */
import crypto from 'node:crypto';
import pg from 'pg';
import { hotp, totpStep, base32Encode } from '../src/modules/auth/mfa/totp.js';

const ROLES = [
  'college_admin@dev.local',
  'campus_admin@dev.local',
  'registrar@dev.local',
  'hod@dev.local',
  'dept_admin@dev.local',
];

async function main() {
  const target = process.argv[2]?.trim().toLowerCase();

  const rawAdminUrl = process.env['DATABASE_ADMIN_URL'];
  let organizationId = '01a1b13c-fd07-7576-97b0-88d28b8beedb';
  if (rawAdminUrl) {
    try {
      const client = new pg.Client({ connectionString: rawAdminUrl });
      await client.connect();
      const orgRes = await client.query<{ id: string }>(
        `SELECT id FROM app.organizations WHERE slug = 'dev-campus'`,
      );
      if (orgRes.rows[0]) organizationId = orgRes.rows[0].id;
      await client.end();
    } catch {
      // fallback to known dev org id
    }
  }

  const list = target ? [target] : ROLES;
  console.log('\n=== Current MFA TOTP Verification Codes (Valid for 30s) ===\n');

  for (const email of list) {
    const rawSeed = crypto
      .createHash('sha256')
      .update(`anesa-dev-seed:${organizationId}:${email}`)
      .digest()
      .subarray(0, 20);

    const step = totpStep(Date.now());
    const code = hotp(rawSeed, step);
    const base32 = base32Encode(rawSeed);

    console.log(`Account: ${email}`);
    console.log(`  Current TOTP Code:  [ ${code} ]`);
    console.log(`  TOTP Secret (Base32): ${base32}\n`);
  }
}

void main();
