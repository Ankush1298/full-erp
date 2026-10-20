import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { adminQuery, ids, runAs, runStepsAs, type RawCtx } from '../support/db-harness.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';

// Migration 0028 at the database layer: the invite_tokens table (RLS, grants, keys, CHECKs), the two SECURITY DEFINER
// functions that consume an invitation with NO session and NO tenant context, and the guard that keeps the runtime role out
// of the INVITED state. Statements run through runAs / runStepsAs (one transaction, always rolled back); the rows they
// look at are committed once in PRIVATE tenants, so the shared fixtures stay pristine.

let T!: IsolatedTenant;
let OTHER!: IsolatedTenant;
const hex = (): string => randomBytes(32).toString('hex');
const H = {
  valid: hex(),
  expired: hex(),
  used: hex(),
  revoked: hex(),
  other: hex(),
  forStatus: hex(),
};
const U = { invited: uuidv7(), withdrawn: uuidv7(), otherInvited: uuidv7() };
const IDENT = { ok: uuidv7(), wrongEmail: uuidv7(), disabled: uuidv7() };
const EMAIL = {
  invited: `inv-a.${hex().slice(0, 8)}@db.test`,
  withdrawn: `inv-b.${hex().slice(0, 8)}@db.test`,
};
const T_STAFF: RawCtx = { tenant: '', user: '', kind: 'STAFF' };
const T_STUDENT: RawCtx = { tenant: '', user: '', kind: 'STUDENT' };
const OTHER_STAFF: RawCtx = { tenant: '', user: '', kind: 'STAFF' };

beforeAll(async () => {
  T = await createIsolatedTenant('test-hash');
  OTHER = await createIsolatedTenant('test-hash');
  Object.assign(T_STAFF, { tenant: T.orgId, user: T.users.admin });
  Object.assign(T_STUDENT, { tenant: T.orgId, user: T.users.studentOne });
  Object.assign(OTHER_STAFF, { tenant: OTHER.orgId, user: OTHER.users.admin });

  const user = (id: string, org: string, address: string) =>
    adminQuery(
      `INSERT INTO app.users (id, organization_id, email, display_name, status) VALUES ($1, $2, $3, 'Invitee', 'INVITED')`,
      [id, org, address],
    );
  await user(U.invited, T.orgId, EMAIL.invited);
  await user(U.withdrawn, T.orgId, EMAIL.withdrawn);
  await user(U.otherInvited, OTHER.orgId, `inv-c.${hex().slice(0, 8)}@db.test`);
  for (const [id, address, status] of [
    [IDENT.ok, EMAIL.invited, 'ACTIVE'],
    [IDENT.wrongEmail, `someone.${hex().slice(0, 8)}@db.test`, 'ACTIVE'],
    [IDENT.disabled, `disabled.${hex().slice(0, 8)}@db.test`, 'DISABLED'],
  ] as const) {
    await adminQuery(
      `INSERT INTO platform.identities (id, email, password_hash, status) VALUES ($1, $2, 'x', $3)`,
      [id, address, status],
    );
  }
  const token = (hash: string, org: string, user: string, creator: string, extra = '') =>
    adminQuery(
      `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, created_at, expires_at${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() - interval '2 days', ${
         extra.startsWith('used_at')
           ? "now() + interval '1 day', now()"
           : extra.startsWith('revoked_at')
             ? "now() + interval '1 day', now()"
             : "now() + interval '1 day'"
       })`,
      [uuidv7(), org, user, hash, creator],
    );
  await token(H.valid, T.orgId, U.invited, T.users.admin);
  await token(H.used, T.orgId, U.invited, T.users.admin, 'used_at=now()');
  await token(H.revoked, T.orgId, U.invited, T.users.admin, 'revoked_at=now()');
  await adminQuery(
    `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() - interval '3 days', now() - interval '1 day')`,
    [uuidv7(), T.orgId, U.withdrawn, H.expired, T.users.admin],
  );
  await token(H.other, OTHER.orgId, U.otherInvited, OTHER.users.admin);
}, 120_000);

afterAll(async () => {
  await T.cleanup();
  await OTHER.cleanup();
});

const lock = (hash: string) =>
  runAs({}, 'SELECT organization_id, user_id, email FROM platform.lock_invitation($1)', [hash]);

describe('app.invite_tokens: shape, tenant isolation, least privilege', () => {
  it('stores only a hash: there is no column that could hold a token, and the hash is 64 lower-case hex characters', async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'invite_tokens' ORDER BY 1`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'created_at',
      'created_by',
      'expires_at',
      'id',
      'organization_id',
      'purpose',
      'revoked_at',
      'token_hash',
      'used_at',
      'user_id',
    ]);
    const bad = await runAs(
      T_STAFF,
      `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', 'NOT-A-HASH', $4, now() + interval '1 day')`,
      [uuidv7(), T.orgId, U.invited, T.users.admin],
    );
    expect(bad.error?.code).toBe('23514');
    const dup = await runAs(
      T_STAFF,
      `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() + interval '1 day')`,
      [uuidv7(), T.orgId, U.invited, H.valid, T.users.admin],
    );
    expect(dup.error?.code).toBe('23505');
  });

  it('tenant isolation: each tenant sees only its own rows, with no filter in the query; no context sees nothing', async () => {
    const mine = ids(await runAs(T_STAFF, 'SELECT id FROM app.invite_tokens'));
    const theirs = ids(await runAs(OTHER_STAFF, 'SELECT id FROM app.invite_tokens'));
    expect(mine).toHaveLength(4);
    expect(theirs).toHaveLength(1);
    expect(mine.some((i) => theirs.includes(i))).toBe(false);
    for (const ctx of [{}, { tenant: T.orgId }, { ...T_STAFF, kind: 'GUARDIAN' }]) {
      expect((await runAs(ctx, 'SELECT id FROM app.invite_tokens')).rowCount).toBe(0);
    }
  });

  it('STAFF only: a STUDENT session sees nothing and cannot create a token; the creator must be the session user', async () => {
    expect((await runAs(T_STUDENT, 'SELECT id FROM app.invite_tokens')).rowCount).toBe(0);
    const insert = (ctx: RawCtx, creator: string, user = U.invited, org = T.orgId) =>
      runAs(
        ctx,
        `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, expires_at)
         VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() + interval '1 day')`,
        [uuidv7(), org, user, hex(), creator],
      );
    expect((await insert(T_STUDENT, T.users.studentOne)).error?.code).toBe('42501');
    expect((await insert(T_STAFF, T.users.faculty)).error?.code).toBe('42501'); // forged authorship
    expect((await insert(T_STAFF, T.users.admin)).error).toBeUndefined();
    // cross-tenant: a token for the other tenant's user, or in the other tenant, cannot exist
    expect((await insert(T_STAFF, T.users.admin, U.otherInvited)).error?.code).toBe('23503');
    expect((await insert(T_STAFF, T.users.admin, U.invited, OTHER.orgId)).error?.code).toBe(
      '42501',
    );
  });

  it('the runtime role can withdraw a token (revoked_at) and nothing else: no used_at, no hash/user change, no delete', async () => {
    const id = ids(
      await runAs(T_STAFF, `SELECT id FROM app.invite_tokens WHERE token_hash = $1`, [H.valid]),
    )[0]!;
    const upd = (sql: string) => runAs(T_STAFF, sql, [id]);
    expect(
      (await upd('UPDATE app.invite_tokens SET revoked_at = now() WHERE id = $1')).rowCount,
    ).toBe(1);
    for (const sql of [
      'UPDATE app.invite_tokens SET used_at = now() WHERE id = $1',
      `UPDATE app.invite_tokens SET token_hash = '${hex()}' WHERE id = $1`,
      `UPDATE app.invite_tokens SET user_id = '${U.withdrawn}' WHERE id = $1`,
      `UPDATE app.invite_tokens SET expires_at = now() + interval '99 days' WHERE id = $1`,
      'DELETE FROM app.invite_tokens WHERE id = $1',
    ]) {
      expect((await upd(sql)).error?.code, sql).toBe('42501');
    }
    // another tenant's token cannot be withdrawn: the row is invisible
    const foreign = ids(await runAs(OTHER_STAFF, 'SELECT id FROM app.invite_tokens'))[0]!;
    expect(
      (
        await runAs(T_STAFF, 'UPDATE app.invite_tokens SET revoked_at = now() WHERE id = $1', [
          foreign,
        ])
      ).rowCount,
    ).toBe(0);
  });
});

describe('platform.lock_invitation (no session, no tenant context)', () => {
  it('finds exactly a usable invitation: unused, not withdrawn, not expired, membership still INVITED', async () => {
    const ok = await lock(H.valid);
    expect(ok.rows).toEqual([
      { organization_id: T.orgId, user_id: U.invited, email: EMAIL.invited },
    ]);
    for (const hash of [H.used, H.revoked, H.expired, hex(), 'not-hex']) {
      expect((await lock(hash)).rowCount, hash).toBe(0);
    }
    // another tenant's token returns ITS tenant, never ours
    expect((await lock(H.other)).rows[0]).toMatchObject({ organization_id: OTHER.orgId });
  });

  it('a membership that is no longer INVITED makes its token unusable', async () => {
    const r = await runStepsAs({}, [
      ['SELECT 1'],
      [`SELECT count(*)::int AS n FROM platform.lock_invitation($1)`, [H.valid]],
    ]);
    expect(r.rows[0]).toEqual({ n: 1 });
    await adminQuery(`UPDATE app.users SET status = 'SUSPENDED' WHERE id = $1`, [U.invited]);
    try {
      expect((await lock(H.valid)).rowCount).toBe(0);
    } finally {
      await adminQuery(`UPDATE app.users SET status = 'INVITED' WHERE id = $1`, [U.invited]);
    }
  });

  it('is executable by the runtime role only, runs as the owner, and has a pinned search_path', async () => {
    const rows = await adminQuery<{
      proname: string;
      prosecdef: boolean;
      cfg: string | null;
      pub: boolean;
      rt: boolean;
    }>(
      `SELECT proname, prosecdef, proconfig::text AS cfg,
              has_function_privilege('public', oid, 'EXECUTE') AS pub,
              has_function_privilege('app_runtime', oid, 'EXECUTE') AS rt
         FROM pg_proc WHERE proname IN ('lock_invitation', 'complete_invitation') ORDER BY 1`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['complete_invitation', 'lock_invitation']);
    for (const r of rows) {
      expect(r).toMatchObject({ prosecdef: true, pub: false, rt: true });
      expect(r.cfg).toContain('search_path=pg_catalog');
    }
  });
});

describe('platform.complete_invitation (single use, atomic, no escalation)', () => {
  const complete = (hash: string, identity: string) =>
    [`SELECT * FROM platform.complete_invitation($1, $2)`, [hash, identity]] as const;

  it('consumes the token and activates the membership, then sets the transaction-local context from the invitation row only', async () => {
    const r = await runStepsAs({}, [
      [`SELECT * FROM platform.lock_invitation($1)`, [H.valid]],
      complete(H.valid, IDENT.ok),
      [
        `SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.user_id', true) AS usr,
                current_setting('app.actor_kind', true) AS kind,
                (SELECT status FROM app.users WHERE id = $1) AS status,
                (SELECT identity_id FROM app.users WHERE id = $1) AS identity,
                (SELECT count(*)::int FROM app.invite_tokens WHERE user_id = $1 AND used_at IS NOT NULL AND token_hash = $2) AS used`,
        [U.invited, H.valid],
      ],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toEqual({
      tenant: T.orgId,
      usr: U.invited,
      kind: 'STAFF',
      status: 'ACTIVE',
      identity: IDENT.ok,
      used: 1,
    });
  });

  it('a second completion of the same token fails (single use) and so does every unusable token', async () => {
    const twice = await runStepsAs({}, [complete(H.valid, IDENT.ok), complete(H.valid, IDENT.ok)]);
    expect(twice.error?.code).toBe('P0002');
    for (const hash of [H.used, H.revoked, H.expired, hex()]) {
      const r = await runStepsAs({}, [complete(hash, IDENT.ok)]);
      expect(r.error?.code, hash).toBe('P0002');
    }
  });

  it("refuses an identity that is not an ACTIVE identity with the membership's own e-mail (no cross-binding, no disabled account)", async () => {
    for (const identity of [IDENT.wrongEmail, IDENT.disabled, uuidv7()]) {
      const r = await runStepsAs({}, [complete(H.valid, identity)]);
      expect(r.error?.code, identity).toBe('P0002');
    }
    // and nothing was committed by those attempts
    expect((await lock(H.valid)).rowCount).toBe(1);
  });

  it('withdraws every other outstanding token of the same membership', async () => {
    const extra = hex();
    await adminQuery(
      `INSERT INTO app.invite_tokens (id, organization_id, user_id, purpose, token_hash, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, 'ACCOUNT_INVITE', $4, $5, now() - interval '1 day', now() + interval '1 day')`,
      [uuidv7(), T.orgId, U.invited, extra, T.users.admin],
    );
    try {
      const r = await runStepsAs({}, [
        complete(H.valid, IDENT.ok),
        [
          `SELECT revoked_at IS NOT NULL AS revoked FROM app.invite_tokens WHERE token_hash = $1`,
          [extra],
        ],
      ]);
      expect(r.rows[0]).toEqual({ revoked: true });
    } finally {
      await adminQuery('DELETE FROM app.invite_tokens WHERE token_hash = $1', [extra]);
    }
  });
});

describe('the runtime role cannot leave or enter INVITED, or bind an identity, by itself', () => {
  it('UPDATE status INVITED -> ACTIVE and ACTIVE -> INVITED are refused (23001); ACTIVE <-> SUSPENDED is allowed', async () => {
    const up = await runAs(T_STAFF, `UPDATE app.users SET status = 'ACTIVE' WHERE id = $1`, [
      U.invited,
    ]);
    expect(up.error?.code).toBe('23001');
    const down = await runAs(T_STAFF, `UPDATE app.users SET status = 'INVITED' WHERE id = $1`, [
      T.users.faculty,
    ]);
    expect(down.error?.code).toBe('23001');
    const ok = await runStepsAs(T_STAFF, [
      [`UPDATE app.users SET status = 'SUSPENDED' WHERE id = $1`, [T.users.faculty]],
      [`UPDATE app.users SET status = 'ACTIVE' WHERE id = $1`, [T.users.faculty]],
    ]);
    expect(ok.error).toBeUndefined();
  });

  it('identity_id is not writable by the runtime role, and an INVITED row is invisible to a different tenant', async () => {
    const bind = await runAs(T_STAFF, `UPDATE app.users SET identity_id = $2 WHERE id = $1`, [
      U.invited,
      IDENT.ok,
    ]);
    expect(bind.error?.code).toBe('42501');
    expect(
      (await runAs(OTHER_STAFF, 'SELECT id FROM app.users WHERE id = $1', [U.invited])).rowCount,
    ).toBe(0);
  });

  it('only the three intended app_migrator policies exist for this migration (exact list)', async () => {
    const rows = await adminQuery<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'app' AND roles::text = '{app_migrator}'
          AND policyname IN ('invite_tokens_acceptance_select', 'invite_tokens_acceptance_update', 'users_invitation_activation') ORDER BY 1`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      'invite_tokens_acceptance_select',
      'invite_tokens_acceptance_update',
      'users_invitation_activation',
    ]);
  });
});
