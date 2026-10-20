import { describe, expect, it } from 'vitest';
import { runAsMigrator, runStepsAs, type RawCtx, type Step } from '../support/db-harness.js';
import { CTX, FACULTY_A, ORG_A, ORG_B, STAFF_A, USER_A } from '../support/fixtures.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';

// Migration 0030 isolation proofs against the real PostgreSQL server, as app_runtime. Every scenario runs in ONE transaction
// that is always rolled back; the actor is switched inside it with set_config (exactly what Database.withTenant sets), so a
// row written by one user is probed by another user, another actor kind, another tenant and the owner role.

const SEALED = "decode(repeat('ab', 49), 'hex')"; // stand-in ciphertext: the database never sees a real secret here
const as = (c: RawCtx): Step => [
  `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', $3, true)`,
  [c.tenant, c.user, c.kind],
];
const pendingFor = (id: string, org: string, user: string): Step => [
  `INSERT INTO app.user_mfa_factors (id, organization_id, user_id, status, secret_enc, secret_key_label, enroll_session_id, pending_expires_at)
   VALUES ($1, $2, $3, 'PENDING', ${SEALED}, 'k1', $4, now() + interval '10 minutes')`,
  [id, org, user, uuidv7()],
];
const activate = (id: string): Step => [
  `UPDATE app.user_mfa_factors SET status = 'ACTIVE', confirmed_at = now() WHERE id = $1`,
  [id],
];
const codeFor = (id: string, org: string, user: string, hash: string): Step => [
  `INSERT INTO app.user_recovery_codes (id, organization_id, user_id, code_hash) VALUES ($1, $2, $3, $4)`,
  [id, org, user, hash],
];
const hex64 = (c: string): string => c.repeat(64);

describe('app.user_mfa_factors: self only, for every actor kind', () => {
  it('a user creates only their OWN factor, only as PENDING, only in their own tenant', async () => {
    expect(
      (await runStepsAs(CTX.staffA, [pendingFor(uuidv7(), ORG_A, STAFF_A)])).error,
    ).toBeUndefined();
    expect(
      (await runStepsAs(CTX.studentA, [pendingFor(uuidv7(), ORG_A, USER_A)])).error,
    ).toBeUndefined();
    // for another user (an administrator for a member included)
    expect(
      (await runStepsAs(CTX.staffA, [pendingFor(uuidv7(), ORG_A, FACULTY_A)])).error?.code,
    ).toBe('42501');
    // in another tenant
    expect((await runStepsAs(CTX.staffA, [pendingFor(uuidv7(), ORG_B, STAFF_A)])).error?.code).toBe(
      '42501',
    );
    // directly ACTIVE (skipping confirmation)
    const direct = await runStepsAs(CTX.staffA, [
      [
        `INSERT INTO app.user_mfa_factors (id, organization_id, user_id, status, secret_enc, secret_key_label, confirmed_at)
         VALUES ($1, $2, $3, 'ACTIVE', ${SEALED}, 'k1', now())`,
        [uuidv7(), ORG_A, STAFF_A],
      ],
    ]);
    expect(direct.error?.code).toBe('42501');
  });

  it('nobody else sees or changes it: another user, a student, an administrator, another tenant, the owner role', async () => {
    const id = uuidv7();
    const probes: [string, RawCtx][] = [
      ['other staff', CTX.facultyA],
      ['admin', CTX.campusAdminA],
      ['student', CTX.studentA],
      ['other tenant', CTX.staffB],
    ];
    for (const [who, ctx] of probes) {
      const seen = await runStepsAs(CTX.staffA, [
        pendingFor(id, ORG_A, STAFF_A),
        as(ctx),
        ['SELECT id, secret_enc FROM app.user_mfa_factors WHERE id = $1', [id]],
      ]);
      expect(seen.error, who).toBeUndefined();
      expect(seen.rowCount, who).toBe(0);
      const changed = await runStepsAs(CTX.staffA, [
        pendingFor(id, ORG_A, STAFF_A),
        as(ctx),
        [
          `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'CANCELLED' WHERE id = $1`,
          [id],
        ],
      ]);
      expect(changed.rowCount, who).toBe(0);
    }
    // the owner role on its own session is admitted by none of the probe policies
    const owner = await runAsMigrator(
      CTX.staffA,
      'SELECT count(*)::int AS n FROM app.user_mfa_factors',
    );
    expect(owner.rows[0]).toEqual({ n: 0 });
  });

  it('column privileges: no DELETE, owner/tenant/type/creation facts never change', async () => {
    const id = uuidv7();
    for (const sql of [
      'DELETE FROM app.user_mfa_factors WHERE id = $1',
      `UPDATE app.user_mfa_factors SET user_id = '${FACULTY_A}' WHERE id = $1`,
      `UPDATE app.user_mfa_factors SET organization_id = '${ORG_B}' WHERE id = $1`,
      `UPDATE app.user_mfa_factors SET pending_expires_at = now() + interval '1 year' WHERE id = $1`,
      `UPDATE app.user_mfa_factors SET enroll_session_id = '${uuidv7()}' WHERE id = $1`,
    ]) {
      const r = await runStepsAs(CTX.staffA, [pendingFor(id, ORG_A, STAFF_A), [sql, [id]]]);
      expect(r.error?.code, sql).toBe('42501');
    }
  });

  it('lifecycle guard: REVOKED is terminal, ACTIVE never returns to PENDING, last_used_step never decreases', async () => {
    const id = uuidv7();
    const base = [pendingFor(id, ORG_A, STAFF_A), activate(id)];
    const back = await runStepsAs(CTX.staffA, [
      ...base,
      [`UPDATE app.user_mfa_factors SET status = 'PENDING' WHERE id = $1`, [id]],
    ]);
    expect(back.error?.code).toBe('23001'); // restrict_violation from the guard, before any CHECK
    expect(back.error?.message).toMatch(/cannot return to PENDING/);
    const steps = await runStepsAs(CTX.staffA, [
      ...base,
      [`UPDATE app.user_mfa_factors SET last_used_step = 100 WHERE id = $1`, [id]],
      [`UPDATE app.user_mfa_factors SET last_used_step = 99 WHERE id = $1`, [id]],
    ]);
    expect(steps.error?.message).toMatch(/last_used_step never decreases/);
    const revoked = await runStepsAs(CTX.staffA, [
      ...base,
      [
        `UPDATE app.user_mfa_factors SET status = 'REVOKED', revoked_at = now(), revoked_reason = 'DISABLED' WHERE id = $1`,
        [id],
      ],
      [
        `UPDATE app.user_mfa_factors SET status = 'ACTIVE', revoked_at = NULL, revoked_reason = NULL WHERE id = $1`,
        [id],
      ],
    ]);
    expect(revoked.error?.message).toMatch(/revoked MFA factor cannot change/);
  });

  it('one PENDING and one ACTIVE factor per user, enforced by the database', async () => {
    const a = uuidv7();
    const b = uuidv7();
    const twoPending = await runStepsAs(CTX.staffA, [
      pendingFor(a, ORG_A, STAFF_A),
      pendingFor(b, ORG_A, STAFF_A),
    ]);
    expect(twoPending.error?.code).toBe('23505');
    const twoActive = await runStepsAs(CTX.staffA, [
      pendingFor(a, ORG_A, STAFF_A),
      activate(a),
      pendingFor(b, ORG_A, STAFF_A),
      activate(b),
    ]);
    expect(twoActive.error?.code).toBe('23505');
  });
});

describe('app.user_recovery_codes: hashes only, self only, single use', () => {
  it('only well-formed hashes of the caller own codes; nobody else reads them', async () => {
    expect(
      (await runStepsAs(CTX.staffA, [codeFor(uuidv7(), ORG_A, STAFF_A, 'ABCD-EFGH')])).error?.code,
    ).toBe('23514');
    expect(
      (await runStepsAs(CTX.staffA, [codeFor(uuidv7(), ORG_A, FACULTY_A, hex64('a'))])).error?.code,
    ).toBe('42501');
    const id = uuidv7();
    for (const ctx of [CTX.facultyA, CTX.campusAdminA, CTX.studentA, CTX.staffB]) {
      const r = await runStepsAs(CTX.staffA, [
        codeFor(id, ORG_A, STAFF_A, hex64('b')),
        as(ctx),
        ['SELECT code_hash FROM app.user_recovery_codes WHERE id = $1', [id]],
      ]);
      expect(r.rowCount).toBe(0);
    }
  });

  it('a code is consumed once: the second consumption matches nothing, and a used row can never change again', async () => {
    const id = uuidv7();
    const consume: Step = [
      `UPDATE app.user_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [id],
    ];
    const twice = await runStepsAs(CTX.staffA, [
      codeFor(id, ORG_A, STAFF_A, hex64('c')),
      consume,
      consume,
    ]);
    expect(twice.rowCount).toBe(0);
    const reopen = await runStepsAs(CTX.staffA, [
      codeFor(id, ORG_A, STAFF_A, hex64('c')),
      consume,
      [`UPDATE app.user_recovery_codes SET used_at = NULL WHERE id = $1`, [id]],
    ]);
    expect(reopen.error?.message).toMatch(/used or revoked recovery code cannot change/);
    for (const sql of [
      'DELETE FROM app.user_recovery_codes WHERE id = $1',
      `UPDATE app.user_recovery_codes SET code_hash = '${hex64('d')}' WHERE id = $1`,
    ]) {
      const r = await runStepsAs(CTX.staffA, [
        codeFor(id, ORG_A, STAFF_A, hex64('c')),
        [sql, [id]],
      ]);
      expect(r.error?.code, sql).toBe('42501');
    }
  });
});

describe('platform.admin_reset_user_mfa: revoke-only, same tenant, never the caller', () => {
  const setup = (factor: string, code: string): Step[] => [
    as(CTX.facultyA),
    pendingFor(factor, ORG_A, FACULTY_A),
    activate(factor),
    codeFor(code, ORG_A, FACULTY_A, hex64('e')),
  ];

  it('a staff context revokes another user factor and unused codes and learns only the counts', async () => {
    const f = uuidv7();
    const c = uuidv7();
    const r = await runStepsAs(CTX.staffA, [
      ...setup(f, c),
      as(CTX.staffA),
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows).toEqual([{ factors_revoked: 1, codes_revoked: 1 }]);
    const after = await runStepsAs(CTX.staffA, [
      ...setup(f, c),
      as(CTX.staffA),
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
      as(CTX.facultyA),
      ['SELECT status, revoked_reason FROM app.user_mfa_factors WHERE id = $1', [f]],
    ]);
    expect(after.rows).toEqual([{ status: 'REVOKED', revoked_reason: 'ADMIN_RESET' }]);
  });

  it('refuses the caller themself and non-staff contexts; another tenant revokes nothing', async () => {
    const f = uuidv7();
    const c = uuidv7();
    const self = await runStepsAs(CTX.staffA, [
      ...setup(f, c),
      as(CTX.facultyA),
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
    ]);
    expect(self.error?.code).toBe('42501');
    const student = await runStepsAs(CTX.staffA, [
      ...setup(f, c),
      as(CTX.studentA),
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
    ]);
    expect(student.error?.code).toBe('42501');
    const otherTenant = await runStepsAs(CTX.staffA, [
      ...setup(f, c),
      as(CTX.staffB),
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
    ]);
    expect(otherTenant.rows).toEqual([{ factors_revoked: 0, codes_revoked: 0 }]);
    const noContext = await runStepsAs({}, [
      ['SELECT * FROM platform.admin_reset_user_mfa($1)', [FACULTY_A]],
    ]);
    expect(noContext.error?.code).toBe('42501');
  });
});
