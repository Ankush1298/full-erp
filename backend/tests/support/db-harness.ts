import { inject } from 'vitest';
import pg from 'pg';

/** Raw context values exactly as a (possibly buggy or hostile) caller could put them in the session. */
export interface RawCtx {
  tenant?: string | null;
  user?: string | null;
  kind?: string | null;
}

export interface Outcome {
  rows: Record<string, unknown>[];
  rowCount: number;
  error?: { code: string | undefined; message: string };
}

export type Step = readonly [sql: string, params?: readonly unknown[]];

async function open(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/**
 * Runs SQL in ONE transaction as a given database role with the given raw context, then ALWAYS rolls
 * back (fixtures stay pristine). Queries are written WITHOUT any tenant filter on purpose: if the
 * database lets the wrong rows through, the assertion fails.
 * Returns the outcome of the LAST step; a failing step is reported as `error` (the tx is aborted).
 */
async function runSteps(url: string, ctx: RawCtx, steps: readonly Step[]): Promise<Outcome> {
  const c = await open(url);
  let last: Outcome = { rows: [], rowCount: 0 };
  try {
    await c.query('BEGIN');
    for (const [key, value] of [
      ['app.tenant_id', ctx.tenant],
      ['app.user_id', ctx.user],
      ['app.actor_kind', ctx.kind],
    ] as const) {
      if (value !== undefined && value !== null) {
        await c.query('SELECT set_config($1, $2, true)', [key, value]);
      }
    }
    for (const [sql, params] of steps) {
      try {
        const r = await c.query(sql, params ? [...params] : []);
        last = { rows: r.rows as Record<string, unknown>[], rowCount: r.rowCount ?? 0 };
      } catch (e) {
        const err = e as { code?: string; message: string };
        return { rows: [], rowCount: 0, error: { code: err.code, message: err.message } };
      }
    }
    return last;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
}

/** As the application runtime role (app_runtime). */
export function runAs(ctx: RawCtx, sql: string, params?: readonly unknown[]): Promise<Outcome> {
  return runSteps(inject('dbRuntimeUrl'), ctx, [params ? [sql, params] : [sql]]);
}
export function runStepsAs(ctx: RawCtx, steps: readonly Step[]): Promise<Outcome> {
  return runSteps(inject('dbRuntimeUrl'), ctx, steps);
}
/** As the migration/owner role (app_migrator). */
export function runAsMigrator(
  ctx: RawCtx,
  sql: string,
  params?: readonly unknown[],
): Promise<Outcome> {
  return runSteps(inject('dbMigratorUrl'), ctx, [params ? [sql, params] : [sql]]);
}

export function runStepsAsMigrator(ctx: RawCtx, steps: readonly Step[]): Promise<Outcome> {
  return runSteps(inject('dbMigratorUrl'), ctx, steps);
}

/** Superuser view (bypasses RLS). Used ONLY to verify what is really stored. */
export async function adminQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const c = await open(inject('dbAdminUrl'));
  try {
    return (await c.query(sql, [...params])).rows as T[];
  } finally {
    await c.end();
  }
}

export async function withRuntimeClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await open(inject('dbRuntimeUrl'));
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export const ids = (o: Outcome, key = 'id'): string[] => o.rows.map((r) => String(r[key])).sort();

/** Full content of tenants A and B (tenant C is reserved for tests that commit). */
export async function snapshot(): Promise<string> {
  const rows = await adminQuery(`
    SELECT k, j FROM (
    SELECT 'org' k, to_jsonb(t) j FROM app.organizations t WHERE t.id IN ('01939a00-0000-7000-8000-000000000a01', '01939a00-0000-7000-8000-000000000b01')
    UNION ALL SELECT 'usr', to_jsonb(t) FROM app.users t WHERE t.organization_id IN ('01939a00-0000-7000-8000-000000000a01', '01939a00-0000-7000-8000-000000000b01')
    UNION ALL SELECT 'stu', to_jsonb(t) FROM app.students t WHERE t.organization_id IN ('01939a00-0000-7000-8000-000000000a01', '01939a00-0000-7000-8000-000000000b01')
    UNION ALL SELECT 'grd', to_jsonb(t) FROM app.student_guardians t WHERE t.organization_id IN ('01939a00-0000-7000-8000-000000000a01', '01939a00-0000-7000-8000-000000000b01')
    ) s ORDER BY k, j::text`);
  return JSON.stringify(rows);
}

/**
 * Test-only helper to establish required step-up assurance on an authenticated session. A PASSWORD_MFA step-up also
 * marks the session MFA-verified, exactly as the real path (POST /auth/mfa/challenge) records both.
 */
export async function elevateSession(
  cookie: string,
  strength: 'PASSWORD_REAUTH' | 'PASSWORD_MFA' = 'PASSWORD_MFA',
): Promise<void> {
  await adminQuery(
    `UPDATE platform.auth_sessions
        SET step_up_at = now(), auth_strength = $1,
            mfa_verified_at = CASE WHEN $3::boolean THEN now() ELSE mfa_verified_at END
      WHERE token_hash = encode(sha256($2::bytea), 'hex')`,
    [strength, cookie, strength === 'PASSWORD_MFA'],
  );
}

/**
 * Test-only: marks a freshly signed-in session as having completed its second factor (what POST /auth/mfa/challenge records
 * after a verified TOTP or recovery code), for tests whose subject is NOT MFA but whose actors hold an MFA-required role
 * (ADR-004). It sets no step-up: CRITICAL routes still need elevateSession. The real enrollment and challenge path, and the
 * restriction of unverified sessions, are tested end to end in tests/integration/mfa.test.ts. Returns the cookie.
 */
export async function mfaVerified<T extends string | undefined>(cookie: T): Promise<T> {
  if (cookie !== undefined) {
    await adminQuery(
      `UPDATE platform.auth_sessions SET mfa_verified_at = now()
        WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [cookie],
    );
  }
  return cookie;
}
