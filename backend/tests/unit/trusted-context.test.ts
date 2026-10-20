import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors/http-errors.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { isTrustedContext } from '../../src/shared/tenancy/trusted-context.js';

const tenantId = uuidv7();
const userId = uuidv7();

describe('TrustedContext', () => {
  it('is recognised only when produced by the issuer', () => {
    const ctx = issueTrustedContext({ tenantId, userId, actorKind: 'STAFF' });
    expect(isTrustedContext(ctx)).toBe(true);
  });

  it('a structurally identical forged object is NOT trusted (casts do not count)', () => {
    const forged = { tenantId, userId, actorKind: 'STAFF' };
    expect(isTrustedContext(forged)).toBe(false);
    expect(isTrustedContext(JSON.parse(JSON.stringify(forged)))).toBe(false);
    expect(
      isTrustedContext({ ...issueTrustedContext({ tenantId, userId, actorKind: 'STAFF' }) }),
    ).toBe(false);
    expect(isTrustedContext(null)).toBe(false);
    expect(isTrustedContext('x')).toBe(false);
  });

  it('is immutable once issued', () => {
    const ctx = issueTrustedContext({ tenantId, userId, actorKind: 'STUDENT' });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as unknown as { tenantId: string }).tenantId = uuidv7();
    }).toThrow(TypeError);
  });

  it('validates its inputs', () => {
    const bad = [
      { tenantId: 'garbage', userId, actorKind: 'STAFF' },
      { tenantId, userId: '3b241101-e2bb-4255-8caf-4136c566a962', actorKind: 'STAFF' },
      { tenantId, userId, actorKind: 'ADMIN' },
      { tenantId, userId, actorKind: 'staff' },
    ] as const;
    for (const b of bad) {
      expect(() => issueTrustedContext(b as never)).toThrow(AppError);
    }
  });

  it('normalises identifiers to lower case', () => {
    const ctx = issueTrustedContext({
      tenantId: tenantId.toUpperCase(),
      userId,
      actorKind: 'STAFF',
    });
    expect(ctx.tenantId).toBe(tenantId);
  });
});

describe('TrustedContext step-up assurance data (runtime validation, no coercion)', () => {
  const base = { tenantId, userId, actorKind: 'STAFF' } as const;
  const issue = (extra: Record<string, unknown>) => issueTrustedContext({ ...base, ...extra });
  const refusal = (extra: Record<string, unknown>): AppError => {
    try {
      issue(extra);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      return err as AppError;
    }
    throw new Error('expected issueTrustedContext to refuse');
  };

  it('missing assurance data keeps the weakest defaults: no step-up, PASSWORD', () => {
    for (const ctx of [
      issueTrustedContext(base),
      issue({ stepUpAt: undefined, authStrength: undefined }),
      issue({ stepUpAt: null }),
    ]) {
      expect(ctx.stepUpAt).toBeNull();
      expect(ctx.authStrength).toBe('PASSWORD');
    }
  });

  it('accepts a valid Date and exactly the three recognized strengths', () => {
    for (const authStrength of ['PASSWORD', 'PASSWORD_REAUTH', 'PASSWORD_MFA']) {
      const ctx = issue({ stepUpAt: new Date(1_700_000_000_000), authStrength });
      expect(ctx.authStrength).toBe(authStrength);
      expect(ctx.stepUpAt?.getTime()).toBe(1_700_000_000_000);
    }
  });

  it('keeps a private copy of the Date: later changes to the caller object cannot raise assurance', () => {
    const original = new Date(1_700_000_000_000);
    const ctx = issue({ stepUpAt: original, authStrength: 'PASSWORD_MFA' });
    expect(ctx.stepUpAt).not.toBe(original);
    original.setTime(Date.now());
    expect(ctx.stepUpAt?.getTime()).toBe(1_700_000_000_000);
  });

  it('refuses a malformed stepUpAt with INVALID_CONTEXT and never coerces it into a Date', () => {
    const malformed: unknown[] = [
      new Date(Number.NaN),
      '2026-10-20T00:00:00.000Z',
      '',
      1_700_000_000_000,
      0,
      true,
      {},
      [],
      { getTime: () => 1_700_000_000_000 },
      Object.assign(new Date(Number.NaN), { getTime: () => 1_700_000_000_000 }), // own getTime claims a time
    ];
    for (const stepUpAt of malformed) {
      const err = refusal({ stepUpAt, authStrength: 'PASSWORD_MFA' });
      expect([err.statusCode, err.code]).toEqual([500, 'INVALID_CONTEXT']);
    }
  });

  it('reads the Date through the prototype: an own getTime on a real Date cannot change the stored time', () => {
    const lying = Object.assign(new Date(1_700_000_000_000), { getTime: () => Number.NaN });
    expect(issue({ stepUpAt: lying }).stepUpAt?.getTime()).toBe(1_700_000_000_000);
  });

  it('refuses any authStrength that is not exactly PASSWORD, PASSWORD_REAUTH or PASSWORD_MFA', () => {
    const unknown: unknown[] = [
      'ROOT',
      'password',
      'PASSWORD_mfa',
      ' PASSWORD_MFA',
      'PASSWORD_MFA ',
      'PASSWORD_MFA\n',
      '',
      null,
      0,
      false,
      {},
      ['PASSWORD_MFA'],
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ];
    for (const authStrength of unknown) {
      const err = refusal({ stepUpAt: new Date(), authStrength });
      expect([err.statusCode, err.code]).toEqual([500, 'INVALID_CONTEXT']);
    }
  });

  it('the refusal message never echoes the submitted value', () => {
    expect(refusal({ authStrength: 'SUPER_SECRET_LEVEL' }).message).not.toContain('SUPER_SECRET');
    expect(refusal({ stepUpAt: 'SUPER_SECRET_TIME' }).message).not.toContain('SUPER_SECRET');
  });

  it('mfaVerifiedAt: defaults to null, is copied (never aliased) and is validated exactly like stepUpAt', () => {
    expect(issue({}).mfaVerifiedAt).toBeNull();
    expect(issue({ mfaVerifiedAt: null }).mfaVerifiedAt).toBeNull();
    const original = new Date(1_700_000_000_000);
    const ctx = issue({ mfaVerifiedAt: original });
    expect(ctx.mfaVerifiedAt).not.toBe(original);
    original.setTime(0);
    expect(ctx.mfaVerifiedAt?.getTime()).toBe(1_700_000_000_000);
    for (const mfaVerifiedAt of ['2026-01-01', 1_700_000_000_000, new Date(Number.NaN), {}]) {
      expect(refusal({ mfaVerifiedAt }).code).toBe('INVALID_CONTEXT');
    }
    expect(refusal({ mfaVerifiedAt: 'SUPER_SECRET_TIME' }).message).not.toContain('SUPER_SECRET');
  });
});
