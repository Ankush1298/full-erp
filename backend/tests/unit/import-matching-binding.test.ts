import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Secret, type ImportMatchingConfig } from '../../src/config/env.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import {
  canonicalMatching,
  MatchingBinder,
  type BindingScope,
} from '../../src/modules/imports/import.binding.js';
import type { MatchingCells } from '../../src/modules/imports/import.common.js';

// Generated at run time; not real credentials.
const k1 = randomBytes(32).toString('base64url');
const k2 = randomBytes(32).toString('base64url');
const ring = (active: string, entries: Record<string, string>): ImportMatchingConfig => ({
  activeKeyId: active,
  keys: new Map(Object.entries(entries).map(([id, k]) => [id, new Secret(k)])),
});
const scope: BindingScope = {
  organizationId: '0190a000-0000-7000-8000-000000000001',
  jobId: '0190a000-0000-7000-8000-000000000002',
};
const cells = (entries: [number, MatchingCells][]) => new Map(entries);
const DOB = '2005-03-04';
const PHONE = '919876543210';

describe('canonical matching data', () => {
  it('is null without matching data and independent of entry order and phone formatting', () => {
    expect(canonicalMatching(cells([]))).toBeNull();
    expect(canonicalMatching(cells([[1, { dateOfBirth: '  ', guardianPhone: '--' }]]))).toBeNull();
    const a = canonicalMatching(
      cells([
        [2, { dateOfBirth: DOB }],
        [1, { guardianPhone: `+91 98765-43210` }],
      ]),
    );
    const b = canonicalMatching(
      cells([
        [1, { guardianPhone: PHONE }],
        [2, { dateOfBirth: ` ${DOB} ` }],
      ]),
    );
    expect(a).toBe(b);
    expect(a).toBe(
      JSON.stringify([
        [1, null, PHONE],
        [2, DOB, null],
      ]),
    );
  });

  it('distinguishes values, presence and the row a value belongs to', () => {
    const base = canonicalMatching(cells([[1, { dateOfBirth: DOB, guardianPhone: PHONE }]]));
    const variants = [
      cells([[1, { dateOfBirth: '2005-03-05', guardianPhone: PHONE }]]), // other date, same presence
      cells([[1, { dateOfBirth: DOB, guardianPhone: `${PHONE}0` }]]), // other phone, same presence
      cells([[1, { dateOfBirth: DOB }]]), // phone dropped
      cells([[2, { dateOfBirth: DOB, guardianPhone: PHONE }]]), // moved to another row
      cells([[1, { dateOfBirth: PHONE, guardianPhone: DOB }]]), // swapped fields
    ];
    for (const v of variants) expect(canonicalMatching(v)).not.toBe(base);
  });
});

describe('MatchingBinder (HMAC-SHA-256, dedicated ring)', () => {
  const canonical = canonicalMatching(cells([[1, { dateOfBirth: DOB, guardianPhone: PHONE }]]))!;

  it('binds under the active key, verifies equivalent data and refuses different data', () => {
    const binder = new MatchingBinder(ring('a', { a: k1 }));
    const stored = binder.bind(scope, canonical);
    expect(stored.keyId).toBe('a');
    expect(stored.mac).toHaveLength(32);
    expect(binder.verify(stored, scope, canonical)).toBe(true);
    const other = canonicalMatching(
      cells([[1, { dateOfBirth: '2005-03-05', guardianPhone: PHONE }]]),
    )!;
    expect(binder.verify(stored, scope, other)).toBe(false);
    // deterministic: the same key, scope and data give the same MAC (so an equivalent retry can be recognised)
    expect(binder.bind(scope, canonical).mac.equals(stored.mac)).toBe(true);
  });

  it('is keyed and scoped: no unkeyed digest, another key, tenant or job gives an unrelated MAC', () => {
    const binder = new MatchingBinder(ring('a', { a: k1 }));
    const { mac } = binder.bind(scope, canonical);
    for (const algo of ['sha256', 'sha1', 'md5']) {
      for (const guess of [canonical, `${DOB}${PHONE}`, `${DOB}|${PHONE}`, DOB, PHONE]) {
        expect(mac.equals(createHash(algo).update(guess).digest())).toBe(false);
      }
    }
    // a key-only HMAC of the bare data (no purpose/version/scope) is not the stored value either
    expect(
      mac.equals(createHmac('sha256', Buffer.from(k1, 'base64url')).update(canonical).digest()),
    ).toBe(false);
    const otherKey = new MatchingBinder(ring('a', { a: k2 })).bind(scope, canonical).mac;
    expect(otherKey.equals(mac)).toBe(false);
    expect(
      binder.verify(
        { keyId: 'a', mac },
        { ...scope, jobId: '0190a000-0000-7000-8000-000000000003' },
        canonical,
      ),
    ).toBe(false);
    expect(
      binder.verify(
        { keyId: 'a', mac },
        { ...scope, organizationId: '0190a000-0000-7000-8000-000000000009' },
        canonical,
      ),
    ).toBe(false);
  });

  it('rotation: new bindings use the new active key, retiring keys still verify, a removed key fails closed (503)', () => {
    const before = new MatchingBinder(ring('old', { old: k1 })).bind(scope, canonical);
    const rotated = new MatchingBinder(ring('new', { old: k1, new: k2 }));
    expect(rotated.verify(before, scope, canonical)).toBe(true);
    expect(rotated.bind(scope, canonical).keyId).toBe('new');
    const removed = new MatchingBinder(ring('new', { new: k2 }));
    let err: unknown;
    try {
      removed.verify(before, scope, canonical);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe('IMPORT_MATCHING_UNAVAILABLE');
    // a key ID cannot be relabelled: a MAC made with one key does not verify under another key's ID
    expect(rotated.verify({ keyId: 'new', mac: before.mac }, scope, canonical)).toBe(false);
  });

  it('refuses a truncated or wrong-length MAC without throwing, and an invalid ring at construction', () => {
    const binder = new MatchingBinder(ring('a', { a: k1 }));
    const { mac } = binder.bind(scope, canonical);
    expect(binder.verify({ keyId: 'a', mac: mac.subarray(0, 16) }, scope, canonical)).toBe(false);
    expect(binder.verify({ keyId: 'a', mac: Buffer.alloc(0) }, scope, canonical)).toBe(false);
    expect(
      () => new MatchingBinder(ring('a', { a: randomBytes(16).toString('base64url') })),
    ).toThrow(/invalid key/);
    expect(() => new MatchingBinder(ring('b', { a: k1 }))).toThrow(/no active key/);
  });

  it('never exposes key material when printed', () => {
    const binder = new MatchingBinder(ring('a', { a: k1 }));
    expect(JSON.stringify(binder)).not.toContain(k1);
    expect(Object.keys(binder)).toEqual(['activeKeyId']); // the keys are a private field
  });
});
