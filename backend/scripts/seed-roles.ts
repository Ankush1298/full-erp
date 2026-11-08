/**
 * Smart Campus OS - Multi-Role Account Provisioning Script
 * 
 * Safely and idempotently provisions accounts for all 8 canonical roles in campusos_dev:
 *  1. COLLEGE_ADMIN
 *  2. CAMPUS_ADMIN
 *  3. REGISTRAR
 *  4. HOD
 *  5. DEPARTMENT_ADMIN
 *  6. FACULTY
 *  7. STAFF
 *  8. STUDENT
 * 
 * Pre-configures TOTP MFA & emergency recovery codes for MFA-required roles,
 * creates necessary campus and department academic structures,
 * links student profile records for the STUDENT role,
 * and records all IDs, emails, plain passwords, and TOTP secrets in .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import * as argon2 from 'argon2';
import { uuidv7 } from '../src/shared/ids/uuidv7.js';
import { seedTenantRoles } from '../src/shared/authorization/seed.js';
import { verifyLocalDevDatabaseUrl, probeLocalDevDatabase } from './dev-seed-core.js';
import { MfaSecretBox, generateRecoveryCodes, hashRecoveryCode, normaliseRecoveryCode } from '../src/modules/auth/mfa/mfa-crypto.js';
import { base32Encode, hotp, totpStep } from '../src/modules/auth/mfa/totp.js';
import { Secret } from '../src/config/env.js';

export interface RoleAccountConfig {
  roleCode: string;
  email: string;
  displayName: string;
  passwordPlain: string;
  scopeType: 'ORGANIZATION' | 'CAMPUS' | 'DEPARTMENT';
  mfaRequired: boolean;
  isStudent?: boolean;
}

export const ROLE_ACCOUNTS: RoleAccountConfig[] = [
  {
    roleCode: 'COLLEGE_ADMIN',
    email: 'college_admin@dev.local',
    displayName: 'College Administrator',
    passwordPlain: 'CollegeAdmin123!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'ORGANIZATION',
    mfaRequired: true,
  },
  {
    roleCode: 'CAMPUS_ADMIN',
    email: 'campus_admin@dev.local',
    displayName: 'Campus Administrator',
    passwordPlain: 'CampusAdmin123!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'CAMPUS',
    mfaRequired: true,
  },
  {
    roleCode: 'REGISTRAR',
    email: 'registrar@dev.local',
    displayName: 'University Registrar',
    passwordPlain: 'Registrar123!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'ORGANIZATION',
    mfaRequired: true,
  },
  {
    roleCode: 'HOD',
    email: 'hod@dev.local',
    displayName: 'Head of Department',
    passwordPlain: 'HeadOfDept123!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'DEPARTMENT',
    mfaRequired: true,
  },
  {
    roleCode: 'DEPARTMENT_ADMIN',
    email: 'dept_admin@dev.local',
    displayName: 'Department Administrator',
    passwordPlain: 'DeptAdmin123!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'DEPARTMENT',
    mfaRequired: true,
  },
  {
    roleCode: 'FACULTY',
    email: 'faculty@dev.local',
    displayName: 'Faculty Professor',
    passwordPlain: 'Faculty12345!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'ORGANIZATION',
    mfaRequired: false,
  },
  {
    roleCode: 'STAFF',
    email: 'staff@dev.local',
    displayName: 'Administrative Staff',
    passwordPlain: 'Staff1234567!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'ORGANIZATION',
    mfaRequired: false,
  },
  {
    roleCode: 'STUDENT',
    email: 'student@dev.local',
    displayName: 'Enrolled Student',
    passwordPlain: 'Student12345!', // secret-scan:allow local-dev seed password; this script refuses non-local databases
    scopeType: 'ORGANIZATION',
    mfaRequired: false,
    isStudent: true,
  },
];

export interface SeededAccountResult {
  roleCode: string;
  email: string;
  displayName: string;
  passwordPlain: string;
  userId: string;
  identityId: string;
  scopeType: string;
  scopeTarget: string;
  mfaRequired: boolean;
  totpSecretBase32?: string | undefined;
  currentTotpCode?: string | undefined;
  sampleRecoveryCode?: string | undefined;
  allRecoveryCodes?: string[] | undefined;
  mfaTicket?: string | undefined;
}

export async function seedAllRoles(): Promise<SeededAccountResult[]> {
  const rawAdminUrl = process.env['DATABASE_ADMIN_URL'];
  if (!rawAdminUrl) {
    throw new Error('DATABASE_ADMIN_URL must be set in environment.');
  }
  verifyLocalDevDatabaseUrl(rawAdminUrl);

  const client = new pg.Client({ connectionString: rawAdminUrl });
  await client.connect();

  try {
    await probeLocalDevDatabase(client);

    // 1. Resolve / Ensure Organization
    const orgRes = await client.query<{ id: string }>(
      `SELECT id FROM app.organizations WHERE slug = 'dev-campus'`,
    );
    let organizationId: string;
    if (orgRes.rows.length === 0) {
      organizationId = uuidv7();
      await client.query(
        `INSERT INTO app.organizations (id, name, slug, status)
         VALUES ($1, 'Dev Campus', 'dev-campus', 'ACTIVE')`,
        [organizationId],
      );
    } else {
      organizationId = orgRes.rows[0]!.id;
    }

    // Ensure tenant roles are seeded
    const exec = {
      query: (text: string, values?: readonly unknown[]) =>
        client.query(text, values ? [...values] : undefined),
    };
    await seedTenantRoles(exec, organizationId);

    // 2. Ensure Campus "Main Campus"
    let campusId: string;
    const campusRes = await client.query<{ id: string }>(
      `SELECT id FROM app.campuses WHERE organization_id = $1 AND code = 'MAIN'`,
      [organizationId],
    );
    if (campusRes.rows.length === 0) {
      campusId = uuidv7();
      await client.query(
        `INSERT INTO app.campuses (id, organization_id, name, code, timezone, address, status)
         VALUES ($1, $2, 'Main Campus', 'MAIN', 'Asia/Kolkata', '{}', 'ACTIVE')`,
        [campusId, organizationId],
      );
    } else {
      campusId = campusRes.rows[0]!.id;
    }

    // 3. Ensure Department "Computer Science & Engineering"
    let departmentId: string;
    const deptRes = await client.query<{ id: string }>(
      `SELECT id FROM app.departments WHERE organization_id = $1 AND code = 'CSE'`,
      [organizationId],
    );
    if (deptRes.rows.length === 0) {
      departmentId = uuidv7();
      await client.query(
        `INSERT INTO app.departments (id, organization_id, campus_id, name, code, kind, status)
         VALUES ($1, $2, $3, 'Computer Science & Engineering', 'CSE', 'ACADEMIC', 'ACTIVE')`,
        [departmentId, organizationId, campusId],
      );
    } else {
      departmentId = deptRes.rows[0]!.id;
    }

    // Fetch existing admin user for ticket creation references
    let adminCreatorUserId: string | null = null;
    const existingAdmin = await client.query<{ id: string }>(
      `SELECT id FROM app.users WHERE organization_id = $1 AND email = 'admin@dev.local'`,
      [organizationId],
    );
    if (existingAdmin.rows.length > 0) {
      adminCreatorUserId = existingAdmin.rows[0]!.id;
    }

    // Set up MFA Secret Box with k1
    const mfaKey = process.env['MFA_ENCRYPTION_KEYS']?.split(':')[1] || 'w8Y3Zc81IS2cHXJ53mERz1fklKbMwfFdPZaatH7nOJ4';
    const activeKeyId = process.env['MFA_ENCRYPTION_ACTIVE_KEY_ID'] || 'k1';
    const ring = {
      keys: new Map([[activeKeyId, new Secret(mfaKey)]]),
      activeKeyId,
    };
    const box = new MfaSecretBox(ring);

    const results: SeededAccountResult[] = [];

    // Also update existing admin@dev.local with known password
    const adminPasswordHash = await argon2.hash('CollegeAdmin123!', { type: argon2.argon2id });
    if (existingAdmin.rows.length > 0) {
      await client.query(
        `UPDATE platform.identities
            SET password_hash = $1, failed_login_count = 0, locked_until = NULL, status = 'ACTIVE'
          WHERE email = 'admin@dev.local'`,
        [adminPasswordHash],
      );
    }

    // Iterate through all 8 role accounts
    for (const acct of ROLE_ACCOUNTS) {
      const cleanEmail = acct.email.trim().toLowerCase();
      const passwordHash = await argon2.hash(acct.passwordPlain, { type: argon2.argon2id });

      // 1. Identity
      let identityId: string;
      const identRes = await client.query<{ id: string }>(
        `SELECT id FROM platform.identities WHERE email = $1`,
        [cleanEmail],
      );
      if (identRes.rows.length === 0) {
        identityId = uuidv7();
        await client.query(
          `INSERT INTO platform.identities (id, email, password_hash, status)
           VALUES ($1, $2, $3, 'ACTIVE')`,
          [identityId, cleanEmail, passwordHash],
        );
      } else {
        identityId = identRes.rows[0]!.id;
        await client.query(
          `UPDATE platform.identities
              SET password_hash = $1, failed_login_count = 0, locked_until = NULL, status = 'ACTIVE'
            WHERE id = $2`,
          [passwordHash, identityId],
        );
      }

      // 2. User
      let userId: string;
      const userRes = await client.query<{ id: string }>(
        `SELECT id FROM app.users WHERE organization_id = $1 AND email = $2`,
        [organizationId, cleanEmail],
      );
      if (userRes.rows.length === 0) {
        userId = uuidv7();
        await client.query(
          `INSERT INTO app.users (id, organization_id, email, display_name, status, identity_id)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5)`,
          [userId, organizationId, cleanEmail, acct.displayName, identityId],
        );
      } else {
        userId = userRes.rows[0]!.id;
        await client.query(
          `UPDATE app.users
              SET identity_id = $1, display_name = $2, status = 'ACTIVE'
            WHERE id = $3`,
          [identityId, acct.displayName, userId],
        );
      }

      // If we didn't have an adminCreatorUserId yet and this is COLLEGE_ADMIN, use this userId
      if (!adminCreatorUserId && acct.roleCode === 'COLLEGE_ADMIN') {
        adminCreatorUserId = userId;
      }

      // 3. Role ID
      const roleRow = await client.query<{ id: string }>(
        `SELECT id FROM app.roles WHERE organization_id = $1 AND code = $2`,
        [organizationId, acct.roleCode],
      );
      if (roleRow.rows.length === 0) {
        throw new Error(`Role ${acct.roleCode} not found in app.roles for organization.`);
      }
      const roleId = roleRow.rows[0]!.id;

      // 4. Student record if applicable
      if (acct.isStudent) {
        const studentRes = await client.query<{ id: string }>(
          `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
          [organizationId, userId],
        );
        if (studentRes.rows.length === 0) {
          const studentId = uuidv7();
          await client.query(
            `INSERT INTO app.students (id, organization_id, user_id, admission_number, status, admission_date, version)
             VALUES ($1, $2, $3, 'STU-2026-0001', 'ACTIVE', CURRENT_DATE, 1)`,
            [studentId, organizationId, userId],
          );
        }
      }

      // 5. Role Assignment
      let scopeId: string | null = null;
      let targetCampusId: string | null = null;
      let targetDeptId: string | null = null;
      let scopeTargetLabel = 'Whole Organization';

      if (acct.scopeType === 'CAMPUS') {
        scopeId = campusId;
        targetCampusId = campusId;
        scopeTargetLabel = 'Main Campus';
      } else if (acct.scopeType === 'DEPARTMENT') {
        scopeId = departmentId;
        targetDeptId = departmentId;
        scopeTargetLabel = 'Computer Science & Engineering';
      }

      // Check existing assignment
      const assignRes = await client.query<{ id: string }>(
        `SELECT id FROM app.role_assignments
          WHERE organization_id = $1 AND user_id = $2 AND role_id = $3`,
        [organizationId, userId, roleId],
      );
      if (assignRes.rows.length === 0) {
        const assignmentId = uuidv7();
        await client.query(
          `INSERT INTO app.role_assignments (
             id, organization_id, user_id, role_id, scope_type, scope_id, campus_id, department_id, status, valid_from
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', now())`,
          [assignmentId, organizationId, userId, roleId, acct.scopeType, scopeId, targetCampusId, targetDeptId],
        );
      } else {
        await client.query(
          `UPDATE app.role_assignments
              SET scope_type = $1, scope_id = $2, campus_id = $3, department_id = $4, status = 'ACTIVE', valid_until = NULL
            WHERE id = $5`,
          [acct.scopeType, scopeId, targetCampusId, targetDeptId, assignRes.rows[0]!.id],
        );
      }

      // 6. MFA Configuration for MFA-required roles
      let totpSecretBase32: string | undefined;
      let currentTotpCode: string | undefined;
      let sampleRecoveryCode: string | undefined;
      let allRecoveryCodes: string[] | undefined;
      let mfaTicketPlain: string | undefined;

      if (acct.mfaRequired) {
        // Deterministic 20-byte seed based on org & email
        const rawSeed = crypto
          .createHash('sha256')
          .update(`anesa-dev-seed:${organizationId}:${cleanEmail}`)
          .digest()
          .subarray(0, 20);
        totpSecretBase32 = base32Encode(rawSeed);
        currentTotpCode = hotp(rawSeed, totpStep(Date.now()));

        // Create an enrollment ticket (single-use, 24-hr ticket)
        const ticketId = uuidv7();
        mfaTicketPlain = crypto.randomBytes(32).toString('hex');
        const codeHash = crypto.createHash('sha256').update(mfaTicketPlain).digest('hex');
        const creatorId = (adminCreatorUserId && adminCreatorUserId !== userId) ? adminCreatorUserId : null;

        // Revoke any previous active ticket for this user
        await client.query(
          `UPDATE app.mfa_enrollment_tickets
              SET revoked_at = now()
            WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
          [organizationId, userId],
        );

        await client.query(
          `INSERT INTO app.mfa_enrollment_tickets (
             id, organization_id, user_id, code_hash, created_by, created_at, expires_at
           ) VALUES ($1, $2, $3, $4, $5, now(), now() + interval '24 hours')`,
          [ticketId, organizationId, userId, codeHash, creatorId],
        );

        // Check if user already has an active factor
        const activeFactorRes = await client.query<{ id: string }>(
          `SELECT id FROM app.user_mfa_factors
            WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
          [organizationId, userId],
        );

        let factorId: string;
        if (activeFactorRes.rows.length === 0) {
          factorId = uuidv7();
          const sealed = box.seal(rawSeed, { organizationId, userId, factorId });
          await client.query(
            `INSERT INTO app.user_mfa_factors (
               id, organization_id, user_id, factor_type, status, secret_enc, secret_key_label,
               confirmed_at, enrollment_ticket_id, verified_enrollment, created_at, updated_at
             ) VALUES ($1, $2, $3, 'TOTP', 'ACTIVE', $4, $5, now(), $6, true, now(), now())`,
            [factorId, organizationId, userId, sealed.sealed, sealed.keyId, ticketId],
          );
        } else {
          factorId = activeFactorRes.rows[0]!.id;
          const sealed = box.seal(rawSeed, { organizationId, userId, factorId });
          await client.query(
            `UPDATE app.user_mfa_factors
                SET secret_enc = $1, secret_key_label = $2, confirmed_at = now(),
                    verified_enrollment = true, updated_at = now()
              WHERE id = $3`,
            [sealed.sealed, sealed.keyId, factorId],
          );
        }

        // Mark ticket used
        await client.query(
          `UPDATE app.mfa_enrollment_tickets SET used_at = now() WHERE id = $1`,
          [ticketId],
        );

        // Generate fresh recovery codes
        allRecoveryCodes = generateRecoveryCodes();
        sampleRecoveryCode = allRecoveryCodes[0];

        // Revoke prior recovery codes
        await client.query(
          `UPDATE app.user_recovery_codes
              SET revoked_at = now()
            WHERE organization_id = $1 AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
          [organizationId, userId],
        );

        // Insert new recovery codes
        for (const code of allRecoveryCodes) {
          const norm = normaliseRecoveryCode(code);
          if (!norm) continue;
          const recoveryHash = hashRecoveryCode(organizationId, userId, norm);
          await client.query(
            `INSERT INTO app.user_recovery_codes (id, organization_id, user_id, code_hash, created_at)
             VALUES ($1, $2, $3, $4, now())`,
            [uuidv7(), organizationId, userId, recoveryHash],
          );
        }
      }

      results.push({
        roleCode: acct.roleCode,
        email: cleanEmail,
        displayName: acct.displayName,
        passwordPlain: acct.passwordPlain,
        userId,
        identityId,
        scopeType: acct.scopeType,
        scopeTarget: scopeTargetLabel,
        mfaRequired: acct.mfaRequired,
        totpSecretBase32,
        currentTotpCode,
        sampleRecoveryCode,
        allRecoveryCodes,
        mfaTicket: mfaTicketPlain,
      });
    }

    return results;
  } finally {
    await client.end();
  }
}

export function updateEnvFile(results: SeededAccountResult[]): void {
  const rootEnvPath = path.resolve(process.cwd(), '../.env');
  const localEnvPath = path.resolve(process.cwd(), '.env');
  const targetPath = fs.existsSync(rootEnvPath) ? rootEnvPath : localEnvPath;

  let content = fs.readFileSync(targetPath, 'utf8');

  // Strip existing SEEDED ROLES block if present
  const markerStart = '# === CANONICAL ROLE ACCOUNTS (DEVELOPMENT) ===';
  const markerEnd = '# === END CANONICAL ROLE ACCOUNTS ===';
  const startIdx = content.indexOf(markerStart);
  if (startIdx !== -1) {
    const endIdx = content.indexOf(markerEnd);
    if (endIdx !== -1) {
      content = content.slice(0, startIdx).trimEnd() + '\n\n' + content.slice(endIdx + markerEnd.length).trimStart();
    }
  }

  // Construct structured section
  const lines: string[] = [
    markerStart,
    '# Auto-generated by backend/scripts/seed-roles.ts',
    '# All 8 canonical roles provisioned in campusos_dev under organization "dev-campus".',
    '# Use these credentials to sign in directly at http://localhost:5173',
    '',
  ];

  for (const acct of results) {
    const prefix = `CAMPUSOS_${acct.roleCode}`;
    lines.push(`# --- ${acct.roleCode} (${acct.displayName}) ---`);
    lines.push(`${prefix}_ID=${acct.userId}`);
    lines.push(`${prefix}_EMAIL=${acct.email}`);
    lines.push(`${prefix}_PASSWORD=${acct.passwordPlain}`);
    lines.push(`${prefix}_ROLE=${acct.roleCode}`);
    lines.push(`${prefix}_SCOPE=${acct.scopeType} (${acct.scopeTarget})`);
    lines.push(`${prefix}_MFA_REQUIRED=${acct.mfaRequired ? 'true' : 'false'}`);
    if (acct.totpSecretBase32) {
      lines.push(`${prefix}_TOTP_SECRET=${acct.totpSecretBase32}`);
    }
    if (acct.sampleRecoveryCode) {
      lines.push(`${prefix}_RECOVERY_CODE_1=${acct.sampleRecoveryCode}`);
      if (acct.allRecoveryCodes && acct.allRecoveryCodes[1]) {
        lines.push(`${prefix}_RECOVERY_CODE_2=${acct.allRecoveryCodes[1]}`);
      }
    }
    lines.push('');
  }

  lines.push(markerEnd);
  lines.push('');

  fs.writeFileSync(targetPath, content.trimEnd() + '\n\n' + lines.join('\n'));
  console.log(`Updated environment configuration at ${targetPath}`);
}

async function main() {
  console.log('=== Smart Campus OS - Provisioning All 8 Canonical Role Accounts ===\n');
  try {
    const results = await seedAllRoles();
    updateEnvFile(results);

    console.log('\n Successfully provisioned all 8 canonical role accounts:\n');
    console.table(
      results.map((r) => ({
        Role: r.roleCode,
        Email: r.email,
        Password: r.passwordPlain,
        Scope: `${r.scopeType} (${r.scopeTarget})`,
        MFA: r.mfaRequired ? 'YES (TOTP)' : 'NO',
        'User ID': r.userId,
      })),
    );

    console.log('\n Credentials and TOTP secrets have been saved to .env!\n');
  } catch (err) {
    console.error('Failed to seed role accounts:', err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
