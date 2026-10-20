import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_STRENGTHS, isAuthStrength } from '../../src/shared/tenancy/trusted-context.js';

// Static pins (no database): the production minimum assurance for CRITICAL permissions is PASSWORD_MFA, it is set in
// exactly the two places that define it, nothing in production wiring can lower it, and PASSWORD_MFA is issued ONLY by
// the MFA service after a verified TOTP or recovery code (password re-authentication stays PASSWORD_REAUTH).

const SRC = join(import.meta.dirname, '../../src');
const code = (path: string): string =>
  readFileSync(join(SRC, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('production minimum assurance for CRITICAL permissions', () => {
  it('buildApp and the auth hook both default to PASSWORD_MFA, and no other default exists', () => {
    expect(code('app.ts')).toMatch(
      /minAssuranceForCritical:\s*deps\.minAssuranceForCritical\s*\?\?\s*'PASSWORD_MFA'/,
    );
    expect(code('modules/auth/auth.hook.ts')).toMatch(
      /opts\.minAssuranceForCritical\s*\?\?\s*'PASSWORD_MFA'/,
    );
    for (const file of ['app.ts', 'modules/auth/auth.hook.ts']) {
      expect(code(file), file).not.toMatch(/minAssuranceForCritical\s*\?\?\s*'(?!PASSWORD_MFA')/);
    }
  });

  it('the production entrypoint and configuration cannot override it', () => {
    expect(code('server.ts')).toMatch(/buildApp\(\{\s*config,\s*db:\s*database\s*\}\)/);
    expect(code('server.ts')).not.toMatch(/minAssurance|stepUp|assurance|mfa/i);
    const env = code('config/env.ts');
    expect(env).not.toMatch(/minAssurance|stepUp|assurance|authStrength/i);
    // The configuration may carry the MFA ENCRYPTION keyring and nothing else about MFA: no switch that disables,
    // relaxes or narrows MFA (no MFA_REQUIRED/MFA_ENFORCE/... variable, no required-roles list).
    const mfaVars = [...env.matchAll(/\bMFA_[A-Z_]+/g)].map((m) => m[0]);
    expect(new Set(mfaVars)).toEqual(
      new Set(['MFA_ENCRYPTION_KEYS', 'MFA_ENCRYPTION_ACTIVE_KEY_ID']),
    );
    expect(env).not.toMatch(
      /REQUIRED_ROLES|mfaRequired|mfaEnforce|MFA_(?:DISABLE|ENFORCE|BYPASS|OPTIONAL)/i,
    );
  });

  it('PASSWORD_MFA is issued only by the MFA service; password step-up records PASSWORD_REAUTH', () => {
    expect(code('modules/auth/auth.service.ts')).toMatch(/'PASSWORD_REAUTH'/);
    expect(code('modules/auth/auth.service.ts')).not.toMatch(
      /'PASSWORD_MFA'|recordMfaVerification/,
    );
    expect(code('modules/auth/auth.routes.ts')).not.toMatch(/'PASSWORD_MFA'|recordMfaVerification/);
    // The one statement that writes PASSWORD_MFA / mfa_verified_at is the repository's recordMfaVerification...
    const repoSrc = code('modules/auth/auth.repository.ts');
    expect(repoSrc.match(/auth_strength = 'PASSWORD_MFA'/g)).toHaveLength(1);
    expect(repoSrc.match(/mfa_verified_at = now\(\)/g)).toHaveLength(1);
    // ...and it is called only from the MFA service, only after a verified code (TOTP confirm/challenge, recovery code).
    const svc = code('modules/auth/mfa/mfa.service.ts');
    expect(svc.match(/recordMfaVerification\(/g)).toHaveLength(2);
    for (const file of ['app.ts', 'modules/auth/auth.hook.ts', 'modules/auth/mfa/mfa.routes.ts']) {
      expect(code(file), file).not.toMatch(/recordMfaVerification|mfa_verified_at\s*=/);
    }
  });
});

describe('recognized assurance levels', () => {
  it('are exactly PASSWORD, PASSWORD_REAUTH, PASSWORD_MFA, weakest first', () => {
    expect([...AUTH_STRENGTHS]).toEqual(['PASSWORD', 'PASSWORD_REAUTH', 'PASSWORD_MFA']);
  });

  it('isAuthStrength is an exact, case-sensitive match that rejects inherited property names', () => {
    for (const ok of AUTH_STRENGTHS) expect(isAuthStrength(ok)).toBe(true);
    for (const bad of [
      'password',
      'PASSWORD_mfa',
      ' PASSWORD',
      '',
      null,
      undefined,
      1,
      {},
      ['PASSWORD'],
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isAuthStrength(bad), JSON.stringify(bad) ?? 'undefined').toBe(false);
    }
  });
});
