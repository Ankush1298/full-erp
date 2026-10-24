import { createHash } from 'node:crypto';
import { AppError } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { StudentGuardianService } from './student-guardian.service.js';

/** Stable warning code shared by the admission response and the import preview (doc 02 §6.2, doc 26 §3.5). */
export const POSSIBLE_DUPLICATE_STUDENT = 'POSSIBLE_DUPLICATE_STUDENT';
/** Fixed text: it never carries a name, a date of birth, a phone number or a reference to the other student. */
export const POSSIBLE_DUPLICATE_MESSAGE =
  'A student with the same name, date of birth and guardian phone number may already exist.';

/**
 * NORMALISATION (owner decision, 2026-10-22): the minimum, nothing else.
 *  - name: trim leading/trailing whitespace, then case-fold. Case folding is `toUpperCase().toLowerCase()` (so "ß" and "SS"
 *    fold alike). NOT done: Unicode normalisation (NFC/NFD), diacritic removal, collapsing inner whitespace, token reordering,
 *    fuzzy similarity. "José" typed with a combining accent and with a precomposed "é" are different names here.
 *  - phone: keep ASCII digits 0-9 only. NOT done: country-code inference, leading-zero removal, non-ASCII digit mapping
 *    ("+91 98765-43210" and "919876543210" match; "09876543210" and "9876543210" do not).
 *  - admission numbers are NOT normalised anywhere: they stay exact and case-sensitive.
 * `users` has a single `display_name` (doc 02's first/middle/last columns do not exist), so the name is that string.
 */
export function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase().toLowerCase() : '';
}
export function normalizePhone(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
}

/** Warning for a row that matches an EARLIER row of the same import file (same rule, same normalisation). */
export const POSSIBLE_DUPLICATE_IN_FILE = 'POSSIBLE_DUPLICATE_IN_FILE';
export const POSSIBLE_DUPLICATE_IN_FILE_MESSAGE =
  'An earlier row of this file has the same name, date of birth and guardian phone number.';

export interface DuplicateProbe {
  name?: string | null;
  /** Strict YYYY-MM-DD (the caller validates); compared by calendar equality. */
  dateOfBirth?: string | null;
  guardianPhone?: string | null;
  /** The account the probe is about: its own student record (if any) is never a candidate. */
  excludeUserId?: string;
}

/**
 * The normalised triple of a probe, or null when ANY part is missing or unusable. The single definition of "usable" for the
 * existing-record check and the within-file check: missing is never equal to missing.
 */
function usableTriple(p: DuplicateProbe): { name: string; phone: string; dob: string } | null {
  const name = normalizeName(p.name);
  const phone = normalizePhone(p.guardianPhone);
  const dob = typeof p.dateOfBirth === 'string' && p.dateOfBirth !== '' ? p.dateOfBirth : '';
  return name !== '' && phone !== '' && dob !== '' ? { name, phone, dob } : null;
}

/**
 * Within-file rule: for each probe (in the order given), the index of the FIRST earlier probe with the same normalised
 * triple, or null. A row is flagged against its group's first row only, so a pair is never reported twice and the result
 * depends only on the order of the probes: equal input yields equal output (and an equal import result hash).
 */
export function firstEarlierMatches(probes: readonly DuplicateProbe[]): (number | null)[] {
  const first = new Map<string, number>();
  return probes.map((p, i) => {
    const t = usableTriple(p);
    if (!t) return null;
    const key = JSON.stringify([t.name, t.dob, t.phone]);
    const seen = first.get(key);
    if (seen === undefined) {
      first.set(key, i);
      return null;
    }
    return seen;
  });
}

interface CandidateRow {
  id: string;
  user_id: string;
  display_name: string;
  dob: string;
}

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

/**
 * Possible-duplicate detection for student admission and import (doc 02 §6.2; owner decisions in doc 26 §3.5).
 *
 * RULE: a candidate is a possible duplicate only when ALL THREE match: normalised name, date of birth, and normalised
 * guardian phone. A missing or unusable value (empty name, no date of birth, no digit in the phone) on EITHER side means "no
 * match" - missing is never equal to missing. The candidate's name and date of birth are those of its account (`users`), its
 * phones are those of its ACTIVE guardian links (`valid_to IS NULL`, guardian not soft-deleted) plus legacy contact rows.
 * Exact admission-number conflicts are NOT handled here: they are hard errors raised by the insert.
 *
 * PRIVACY: the answer per probe is an opaque FINGERPRINT (SHA-256 of the tenant and the sorted candidate student ids) or
 * null. It identifies the SET of matches (so an acknowledgement can be bound to it) but never a candidate's name, date of
 * birth, phone or id. The probe's own values are used for comparison only: nothing here writes anything, and the guardian
 * phone of a probe is never stored by this service.
 *
 * AUTHORIZATION: self-authorizing. The caller must be a staff actor holding `student.record.create` at ORGANIZATION scope
 * (the permission of the writes this check guards); there is no route to this class. It deliberately does NOT require
 * `student.guardian.read`: the caller learns "a match exists", never a guardian's phone. Residual risk (accepted with the
 * rule): a creator can probe whether a known name + date of birth + phone combination exists. The query is tenant-scoped
 * (RLS plus an explicit filter), so another tenant's records can neither match nor be disclosed.
 */
export class StudentDuplicateService {
  static async find(
    tx: TenantTx,
    ctx: TrustedContext,
    probes: readonly DuplicateProbe[],
  ): Promise<(string | null)[]> {
    ensureTrusted(ctx);
    AuthorizationEngine.assertStaffActor(ctx);
    await AuthorizationEngine.assert(tx, ctx, 'student.record.create');
    try {
      await AuthorizationEngine.assert(tx, ctx, 'student.record.create', {
        organization_id: ctx.tenantId,
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) {
        throw new AppError(403, 'FORBIDDEN', 'Access denied.');
      }
      throw err;
    }

    const usable = probes.map(usableTriple);
    const out: (string | null)[] = probes.map(() => null);
    const dobs = [...new Set(usable.flatMap((u) => (u ? [u.dob] : [])))];
    if (dobs.length === 0) return out;

    // One set-based read for the whole file: candidates are narrowed by date of birth (indexed); name and phone are then
    // compared in code with the same normalisation as the probe, so there is a single definition of "equal". The date is
    // rendered with an EXPLICIT format: `::text` follows the session's DateStyle (e.g. '04/03/2005' under 'SQL, DMY'), which
    // would silently disable every match. The probe side is strict YYYY-MM-DD (`parseDate`), the input cast `$2::date[]` of
    // ISO text is DateStyle-independent, and the 0036 CHECK keeps years in 1900-2200, so `YYYY-MM-DD` is exact.
    const res = await tx.query<CandidateRow>(
      `SELECT s.id, s.user_id, u.display_name, to_char(u.date_of_birth, 'YYYY-MM-DD') AS dob
         FROM app.students AS s
         JOIN app.users AS u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE s.organization_id = $1 AND u.date_of_birth = ANY($2::date[])
        ORDER BY s.id`,
      [ctx.tenantId, dobs],
    );
    // The phones come from the only code that names the guardian tables (a static test pins that).
    const phones = await StudentGuardianService.phonesForMatching(
      tx,
      ctx,
      res.rows.map((r) => r.id),
    );
    const candidates = res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: normalizeName(r.display_name),
      dob: r.dob,
      phones: new Set((phones.get(r.id) ?? []).map(normalizePhone).filter((p) => p !== '')),
    }));

    probes.forEach((probe, i) => {
      const u = usable[i];
      if (!u) return;
      const matches = candidates
        .filter(
          (c) =>
            c.dob === u.dob &&
            c.name === u.name &&
            c.phones.has(u.phone) &&
            c.userId !== probe.excludeUserId,
        )
        .map((c) => c.id);
      if (matches.length > 0) {
        out[i] = createHash('sha256')
          .update(
            `${ctx.tenantId}\n${ctx.userId}\n${probe.excludeUserId ?? ''}\n${matches.join('\n')}`,
          )
          .digest('hex');
      }
    });
    return out;
  }
}

/**
 * The refusal of an admission that has an unacknowledged warning: 409 with the stable code and the fingerprint the client
 * must send back as `duplicateAcknowledgement` once a person has reviewed the warning. Nothing about the candidate.
 */
export function duplicateWarningError(fingerprint: string): AppError {
  return new AppError(409, POSSIBLE_DUPLICATE_STUDENT, POSSIBLE_DUPLICATE_MESSAGE, [
    { field: 'duplicateAcknowledgement', message: fingerprint },
  ]);
}
