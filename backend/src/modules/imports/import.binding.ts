import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ImportMatchingConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { canonicalJson } from '../../shared/idempotency/index.js';
import { normalizePhone } from '../students/student-duplicate.service.js';
import type { MatchingCells } from './import.common.js';

/**
 * Binds a COMMITTED import job to the matching data its commit used, so a retry that reuses the commit's Idempotency-Key
 * with materially different matching data is refused and an equivalent retry replays (doc 26 §3.5.4; owner decision
 * 2026-10-23, option (a)).
 *
 * HMAC-SHA-256 under a key of the dedicated IMPORT_MATCHING_KEYS ring (config/env.ts). The key never reaches the database,
 * so the stored MAC cannot be tested against guessed dates of birth or phone numbers by anyone who can only read the
 * database; an unkeyed or salted digest could (§3.5.4 threat analysis). The MAC input is domain-separated by purpose,
 * format version and key ID, and bound to the tenant and the job, so a MAC cannot be replayed onto another job or tenant,
 * and equal data in two jobs yields unrelated MACs (no linking). Comparison is constant-time. Nothing here logs; errors
 * carry no key, value or MAC.
 *
 * Never a fallback: no ring means no binder, and a commit that needs one is refused (`matchingUnavailable`).
 */
const FORMAT_VERSION = 1;
const PURPOSE = 'anesa/import-matching-binding';
const MAC_BYTES = 32;

/**
 * Canonical text of the matching data of one request: per row with any cell, `[rowNo, dateOfBirth | null, digits | null]`,
 * ordered by row number. The row number is the row identity (every entry was already checked against the stored row's
 * e-mail), so the canonical form covers row binding and presence; the phone is reduced to its digits (the matcher's own
 * normalisation), the date is the trimmed text (only strict YYYY-MM-DD validates). Entry order is irrelevant. `null` when
 * the request carried no matching data.
 */
export function canonicalMatching(cells: ReadonlyMap<number, MatchingCells>): string | null {
  const items = [...cells.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([rowNo, c]) => {
      const dob = (c.dateOfBirth ?? '').trim();
      const phone = normalizePhone(c.guardianPhone ?? '');
      return dob === '' && phone === ''
        ? []
        : [[rowNo, dob === '' ? null : dob, phone === '' ? null : phone]];
    });
  return items.length === 0 ? null : canonicalJson(items);
}

export function matchingUnavailable(): AppError {
  return new AppError(
    503,
    'IMPORT_MATCHING_UNAVAILABLE',
    'Imports with date of birth or guardian phone data cannot be committed right now. Contact your administrator.',
  );
}

export interface BindingScope {
  readonly organizationId: string;
  readonly jobId: string;
}

export interface StoredBinding {
  readonly keyId: string;
  readonly mac: Buffer;
}

export class MatchingBinder {
  readonly activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(ring: ImportMatchingConfig) {
    const keys = new Map<string, Buffer>();
    for (const [id, secret] of ring.keys) {
      const key = Buffer.from(secret.reveal(), 'base64url');
      if (key.length !== 32) throw new Error('Import matching keyring contains an invalid key.');
      keys.set(id, key);
    }
    if (!keys.has(ring.activeKeyId)) throw new Error('Import matching keyring has no active key.');
    this.activeKeyId = ring.activeKeyId;
    this.#keys = keys;
  }

  #mac(key: Buffer, keyId: string, scope: BindingScope, canonical: string): Buffer {
    return createHmac('sha256', key)
      .update(
        [PURPOSE, `v${FORMAT_VERSION}`, keyId, scope.organizationId, scope.jobId, canonical].join(
          '\n',
        ),
        'utf8',
      )
      .digest();
  }

  /** The binding of new data: always under the ACTIVE key. */
  bind(scope: BindingScope, canonical: string): StoredBinding {
    const keyId = this.activeKeyId;
    return { keyId, mac: this.#mac(this.#keys.get(keyId)!, keyId, scope, canonical) };
  }

  /**
   * Does the stored binding correspond to this canonical data? Uses the key the binding was made with (active or
   * retiring). A key that is no longer in the ring cannot decide: `matchingUnavailable` (fail closed, never a replay and
   * never a guess).
   */
  verify(stored: StoredBinding, scope: BindingScope, canonical: string): boolean {
    const key = this.#keys.get(stored.keyId);
    if (!key) throw matchingUnavailable();
    const expected = this.#mac(key, stored.keyId, scope, canonical);
    return stored.mac.length === MAC_BYTES && timingSafeEqual(stored.mac, expected);
  }
}
