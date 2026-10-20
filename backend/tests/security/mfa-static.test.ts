import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG } from '../../src/shared/authorization/catalog.js';
import { ROLE_CODES, ROLE_MATRIX } from '../../src/shared/authorization/role-matrix.js';

// Static MFA gates (no database). docs/architecture/v3/23-mfa.md.

const SRC = join(import.meta.dirname, '../../src');
const MIGRATIONS = join(import.meta.dirname, '../../../database/migrations');
const strip = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (p: string): string => strip(readFileSync(join(SRC, p), 'utf8'));
const MFA_DIR = 'modules/auth/mfa';
const mfaFiles = readdirSync(join(SRC, MFA_DIR)).map((f) => `${MFA_DIR}/${f}`);
const sql = readFileSync(join(MIGRATIONS, '0030_user_mfa.sql'), 'utf8');
const sqlCode = sql.replace(/--.*$/gm, '');

describe('MFA code: secrets never leave through logs, audit data or other endpoints', () => {
  it('nothing in the MFA module logs (no logger, no console)', () => {
    for (const f of mfaFiles)
      expect(code(f), f).not.toMatch(/\.log\b|console\.|\blog\??\.(?:info|warn|error|debug)/);
  });

  it('audit metadata in the MFA service never names a secret, code, URI or hash field', () => {
    const svc = code(`${MFA_DIR}/mfa.service.ts`);
    const metadataBlocks = [...svc.matchAll(/metadata:\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(metadataBlocks.length).toBeGreaterThan(0);
    for (const b of metadataBlocks)
      expect(b).not.toMatch(/secret|seed|otpauth|uri|recoveryCode|code_hash|hash|sealed/i);
  });

  it('the secret and the provisioning URI are produced only by enrollment start; codes only by confirm/regenerate', () => {
    const svc = code(`${MFA_DIR}/mfa.service.ts`);
    expect(svc.match(/provisioningUri\(/g)).toHaveLength(1);
    expect(svc.match(/base32Encode\(/g)).toHaveLength(1);
    expect(svc.match(/this\.issueRecoveryCodes\(/g)).toHaveLength(2);
    // status() reads no ciphertext and no hash
    const status = svc.slice(svc.indexOf('async status('), svc.indexOf('async startEnrollment('));
    expect(status).not.toMatch(/secret_enc|code_hash/);
  });

  it('responses carrying a secret or codes are marked no-store', () => {
    const routes = code(`${MFA_DIR}/mfa.routes.ts`);
    for (const path of [
      '/me/mfa/totp/enroll',
      '/me/mfa/totp/verify',
      '/me/mfa/recovery-codes/regenerate',
    ]) {
      const start = routes.indexOf(`'${path}'`);
      expect(start, path).toBeGreaterThan(-1);
      expect(routes.slice(start, start + 900), path).toMatch(/noStore\(reply\)/);
    }
  });
});

describe('MFA routes act on the caller only', () => {
  it('no MFA route takes a user id, tenant id or session id from the request', () => {
    const routes = code(`${MFA_DIR}/mfa.routes.ts`);
    expect(routes).not.toMatch(/:id\b|req\.params|req\.query|querystring|params:/);
    // the subject is always the authenticated context
    expect(routes).toMatch(/req\.tenantContext/);
    expect(routes).not.toMatch(/req\.body\s+as\s+\{[^}]*(?:user|tenant|session)/i);
  });

  it('every MFA route requires auth.mfa.manage, and administrative reset and ticket issuance use user.account.reset_mfa', () => {
    const routes = code(`${MFA_DIR}/mfa.routes.ts`);
    expect(routes).toMatch(/const PERMISSION = 'auth\.mfa\.manage'/);
    expect(routes).not.toMatch(/public:\s*true/);
    const users = code('modules/users/user.routes.ts');
    expect(users).toMatch(
      /'\/users\/:id\/mfa\/reset'[\s\S]{0,120}permission: MFA_RESET_PERMISSION/,
    );
    expect(users).toMatch(
      /'\/users\/:id\/mfa\/enrollment-ticket'[\s\S]{0,120}permission: MFA_RESET_PERMISSION/,
    );
  });
});

describe('permissions (doc 10 rows 3a, 10a)', () => {
  it('auth.mfa.manage is NORMAL and SELF for every role; user.account.reset_mfa is CRITICAL for CAMPUS_ADMIN and COLLEGE_ADMIN only', () => {
    expect(PERMISSION_CATALOG).toContainEqual({ code: 'auth.mfa.manage', sensitivity: 'NORMAL' });
    expect(PERMISSION_CATALOG).toContainEqual({
      code: 'user.account.reset_mfa',
      sensitivity: 'CRITICAL',
    });
    for (const r of ROLE_CODES) expect(ROLE_MATRIX[r]['auth.mfa.manage'], r).toBe('SELF');
    expect(ROLE_CODES.filter((r) => ROLE_MATRIX[r]['user.account.reset_mfa'])).toEqual([
      'CAMPUS_ADMIN',
      'COLLEGE_ADMIN',
    ]);
  });
});

describe('migration 0030', () => {
  it('is an ordinary (non-contract) migration, so the runner defers it behind the deferred contract 0019', () => {
    const files = readdirSync(MIGRATIONS);
    expect(files).toContain('0030_user_mfa.sql');
    expect(files.filter((f) => f.startsWith('0030_'))).toEqual(['0030_user_mfa.sql']); // no *_contract twin
    // the deferral itself is pinned against the real directory in tests/unit/migrate-plan.test.ts
  });

  it('forces RLS on both tables and restricts the runtime role to the caller own rows', () => {
    for (const t of ['user_mfa_factors', 'user_recovery_codes']) {
      expect(sqlCode).toMatch(new RegExp(`ALTER TABLE app\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sqlCode).toMatch(new RegExp(`ALTER TABLE app\\.${t} FORCE\\s+ROW LEVEL SECURITY`));
      for (const cmd of ['SELECT', 'INSERT', 'UPDATE']) {
        expect(sqlCode).toMatch(
          new RegExp(
            `CREATE POLICY ${t}_self_${cmd.toLowerCase()} ON app\\.${t} AS RESTRICTIVE FOR ${cmd} TO app_runtime[\\s\\S]{0,80}user_id = app\\.current_user_id\\(\\)`,
          ),
        );
      }
      // tenant-scoped composite foreign key to the membership
      expect(sqlCode).toMatch(
        new RegExp(
          `FOREIGN KEY \\(organization_id, user_id\\)\\s+REFERENCES app\\.users \\(organization_id, id\\)`,
        ),
      );
      expect(sqlCode).not.toMatch(new RegExp(`GRANT[^;]*DELETE[^;]*app\\.${t}`));
      expect(sqlCode).not.toMatch(
        new RegExp(`GRANT UPDATE \\([^)]*\\buser_id\\b[^)]*\\) ON app\\.${t}`),
      );
    }
  });

  it('stores no plaintext secret or code column', () => {
    expect(sqlCode).toMatch(/secret_enc\s+bytea/);
    expect(sqlCode).not.toMatch(/\bsecret\s+text|\bcode\s+text|\bplain/i);
  });

  it('the admin reset function can only revoke, never for the caller, and requires a staff tenant context', () => {
    const fn = sqlCode.slice(sqlCode.indexOf('CREATE FUNCTION platform.admin_reset_user_mfa'));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/SET search_path = pg_catalog/);
    expect(fn).toMatch(/p_user_id = v_actor/);
    expect(fn).toMatch(/app\.current_actor_kind\(\) IS DISTINCT FROM 'STAFF'/);
    expect(fn).not.toMatch(/INSERT|DELETE|secret_enc|code_hash\s*=/);
    expect(fn).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*platform\.admin_reset_user_mfa\(app\.uuid_v7\) FROM PUBLIC/,
    );
  });
});
