import { describe, expect, inject, it } from 'vitest';
import { adminQuery, runAs } from '../support/db-harness.js';
import { CTX, ORG_A } from '../support/fixtures.js';
import {
  GLOBAL_TABLES,
  RUNTIME_DELETE_ALLOWED,
  SECURITY_DEFINER_FUNCTIONS,
} from '../support/privilege-policy.js';

// Database security guardrails (doc 48 §5). They enumerate the live catalog of the disposable database, so a table, grant or
// function added by a later migration is judged by rule: it either satisfies the rule or must be added, with a reason and an
// owner, to tests/support/privilege-policy.ts. Nothing here counts tables or compares migration file names.

const RT = 'app_runtime';
const MIG = 'app_migrator';

type TableRow = {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  forced: boolean;
  owner: string;
  hasOrg: boolean;
  isPartition: boolean;
};
async function tables(): Promise<TableRow[]> {
  return adminQuery<TableRow>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            pg_get_userbyid(c.relowner) AS owner, c.relispartition AS "isPartition",
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped) AS "hasOrg"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('app', 'platform') AND c.relkind IN ('r', 'p') ORDER BY 1, 2`,
  );
}
const fq = (t: Pick<TableRow, 'schema' | 'name'>): string => `${t.schema}.${t.name}`;
const q = (t: Pick<TableRow, 'schema' | 'name'>): string => `"${t.schema}"."${t.name}"`;
const top = async () => (await tables()).filter((t) => !t.isPartition);
let privCache: Map<string, string[]> | undefined;
/** One catalog query for every table (each adminQuery opens a connection; per-table queries made this suite slow). */
async function runtimePrivileges(t: Pick<TableRow, 'schema' | 'name'>): Promise<string[]> {
  if (!privCache) {
    const rows = await adminQuery<{ t: string; p: string }>(
      `SELECT n.nspname || '.' || c.relname AS t, p.priv AS p
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
        WHERE n.nspname IN ('app','platform') AND c.relkind IN ('r','p') AND has_table_privilege($1, c.oid, p.priv)`,
      [RT],
    );
    privCache = new Map();
    for (const r of rows) privCache.set(r.t, [...(privCache.get(r.t) ?? []), r.p]);
  }
  return privCache.get(fq(t)) ?? [];
}

describe('roles: no unexpected superuser, BYPASSRLS or inheritance', () => {
  it('the application and migration roles are plain, non-inheriting login roles', async () => {
    const roles = await adminQuery<Record<string, boolean>>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolinherit
         FROM pg_roles WHERE rolname IN ($1, $2)`,
      [RT, MIG],
    );
    expect(roles).toHaveLength(2);
    for (const r of roles) {
      expect(r['rolsuper'], `${String(r['rolname'])} superuser`).toBe(false);
      expect(r['rolbypassrls'], `${String(r['rolname'])} BYPASSRLS`).toBe(false);
      expect(r['rolcreaterole']).toBe(false);
      expect(r['rolcreatedb']).toBe(false);
      expect(r['rolreplication']).toBe(false);
      expect(r['rolinherit'], `${String(r['rolname'])} must be NOINHERIT`).toBe(false);
    }
  });

  it('neither role is a member of any role, and the two cannot reach each other', async () => {
    const m = await adminQuery(
      `SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member FROM pg_auth_members
        WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ($1, $2))`,
      [RT, MIG],
    );
    expect(m).toEqual([]);
  });

  it('exactly one other login role may be superuser/BYPASSRLS in the cluster: the provisioning role the harness connects with', async () => {
    const adminName = decodeURIComponent(new URL(inject('dbAdminUrl')).username);
    const privileged = await adminQuery<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE (rolsuper OR rolbypassrls) AND rolname NOT LIKE 'pg\\_%' ORDER BY 1`,
    );
    expect(privileged.map((r) => r.rolname)).toEqual([adminName]);
  });

  it('neither role can create objects: no CREATE on the database, on app, platform or public, and PUBLIC has no schema access', async () => {
    for (const role of [RT, MIG]) {
      const db = await adminQuery<{ c: boolean; t: boolean }>(
        `SELECT has_database_privilege($1, current_database(), 'CREATE') AS c, has_database_privilege($1, current_database(), 'TEMP') AS t`,
        [role],
      );
      expect(db[0]!.c, `${role} CREATE on database`).toBe(false);
    }
    const sch = await adminQuery<{ s: string; ok: boolean }>(
      `SELECT s, has_schema_privilege($1, s, 'CREATE') AS ok FROM unnest(ARRAY['app','platform','public']) AS s`,
      [RT],
    );
    expect(sch.filter((r) => r.ok)).toEqual([]);
    const pub = await adminQuery<{ s: string }>(
      `SELECT n.nspname AS s FROM pg_namespace n WHERE n.nspname IN ('app','platform')
         AND (has_schema_privilege('public', n.oid, 'USAGE') OR has_schema_privilege('public', n.oid, 'CREATE'))`,
    );
    expect(pub).toEqual([]);
  });
});

describe('table classification: every table is judged, none is ignored', () => {
  it('every table is either tenant-owned (organization_id) or listed in the global-table policy, and no policy entry is stale', async () => {
    const all = await top();
    const global = all.filter((t) => !t.hasOrg);
    const unlisted = global.filter((t) => GLOBAL_TABLES[fq(t)] === undefined).map(fq);
    expect(unlisted, 'tables with no organization_id and no documented exception').toEqual([]);
    const stale = Object.keys(GLOBAL_TABLES).filter((k) => {
      const t = all.find((x) => fq(x) === k);
      return t === undefined || t.hasOrg;
    });
    expect(stale, 'exception entries for tables that do not exist or became tenant-owned').toEqual(
      [],
    );
    for (const [name, e] of Object.entries(GLOBAL_TABLES)) {
      expect(e.reason.length, name).toBeGreaterThan(30);
      expect(e.owner.length, name).toBeGreaterThan(5);
      expect(e.review.length, name).toBeGreaterThan(4);
    }
  });

  it('every tenant-owned table has RLS enabled AND forced, and every partition of one does too', async () => {
    const all = await tables();
    const tenant = all.filter((t) => t.hasOrg);
    expect(tenant.length).toBeGreaterThan(40);
    expect(
      tenant.filter((t) => !t.rls || !t.forced).map(fq),
      'tenant tables without forced RLS',
    ).toEqual([]);
  });

  it('global tables have exactly the RLS state their exception declares', async () => {
    const all = await top();
    for (const [name, e] of Object.entries(GLOBAL_TABLES)) {
      const t = all.find((x) => fq(x) === name)!;
      if (e.rls === 'forced') expect([t.rls, t.forced], name).toEqual([true, true]);
      else expect([t.rls, t.forced], name).toEqual([false, false]);
    }
  });

  it('all application tables are owned by the migration role, never by the runtime role or a superuser', async () => {
    const all = await tables();
    expect(all.filter((t) => t.owner !== MIG).map((t) => `${fq(t)}:${t.owner}`)).toEqual([]);
  });
});

describe(
  'tenant policies: every command the runtime role can issue is tenant-confined',
  { timeout: 120_000 },
  () => {
    it('for each tenant table and each privilege app_runtime holds, a permissive policy for that command names the tenant context', async () => {
      const all = (await top()).filter((t) => t.hasOrg || GLOBAL_TABLES[fq(t)]?.rls === 'forced');
      const problems: string[] = [];
      const allPolicies = await adminQuery<{
        t: string;
        cmd: string;
        qual: string | null;
        chk: string | null;
        permissive: boolean;
      }>(
        `SELECT n.nspname || '.' || c.relname AS t, p.polcmd AS cmd, pg_get_expr(p.polqual, p.polrelid) AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS chk, p.polpermissive AS permissive
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE 0 = ANY (p.polroles) OR (SELECT oid FROM pg_roles WHERE rolname = $1) = ANY (p.polroles)`,
        [RT],
      );
      for (const t of all) {
        const privs = await runtimePrivileges(t);
        const policies = allPolicies.filter((p) => p.t === fq(t));
        const covers = (cmd: 'r' | 'a' | 'w' | 'd', field: 'qual' | 'chk'): boolean =>
          policies.some(
            (p) =>
              p.permissive &&
              (p.cmd === cmd || p.cmd === '*') &&
              /current_tenant_id|tenant_id\(\)/.test(String(p[field])),
          );
        if (privs.includes('SELECT') && !covers('r', 'qual')) problems.push(`${fq(t)} SELECT`);
        if (privs.includes('INSERT') && !covers('a', 'chk')) problems.push(`${fq(t)} INSERT`);
        if (privs.includes('UPDATE') && !(covers('w', 'qual') && covers('w', 'chk')))
          problems.push(`${fq(t)} UPDATE`);
        if (privs.includes('DELETE') && !covers('d', 'qual')) problems.push(`${fq(t)} DELETE`);
      }
      expect(problems).toEqual([]);
    });

    it('a session of tenant A sees no row of any other tenant in any table it can read (checked on every table, with real rows present)', async () => {
      const all = (await top()).filter((t) => t.hasOrg || fq(t) === 'app.organizations');
      let nonVacuous = 0;
      const leaks: string[] = [];
      for (const t of all) {
        const privs = await runtimePrivileges(t);
        if (!privs.includes('SELECT')) continue; // e.g. audit_events: INSERT-only for the runtime role
        const col = t.hasOrg ? 'organization_id' : 'id';
        const foreign = await adminQuery<{ n: string }>(
          `SELECT count(*) AS n FROM ${q(t)} WHERE ${col} <> $1`,
          [ORG_A],
        );
        const seen = await runAs(
          CTX.staffA,
          `SELECT count(*)::int AS n FROM ${q(t)} WHERE ${col} <> $1`,
          [ORG_A],
        );
        if (seen.error) {
          leaks.push(`${fq(t)} errored: ${seen.error.code}`);
          continue;
        }
        if (Number(foreign[0]!.n) > 0) nonVacuous++;
        if (Number(seen.rows[0]!['n']) !== 0) leaks.push(fq(t));
      }
      expect(leaks).toEqual([]);
      expect(
        nonVacuous,
        "the check must run against tables that really hold other tenants' rows",
      ).toBeGreaterThan(5);
    });

    it('with no tenant context at all, the runtime role sees no tenant row', async () => {
      const all = (await top()).filter((t) => t.hasOrg);
      const leaks: string[] = [];
      for (const t of all) {
        if (!(await runtimePrivileges(t)).includes('SELECT')) continue;
        const r = await runAs({}, `SELECT count(*)::int AS n FROM ${q(t)}`);
        if (!r.error && Number(r.rows[0]!['n']) !== 0) leaks.push(fq(t));
      }
      expect(leaks).toEqual([]);
    });
  },
);

describe(
  'grants: nothing unexpected for the application role or anyone else',
  { timeout: 120_000 },
  () => {
    it('app_runtime never holds TRUNCATE, REFERENCES or TRIGGER, and DELETE only where a documented exception allows it', async () => {
      const all = await top();
      const bad: string[] = [];
      for (const t of all) {
        const privs = await runtimePrivileges(t);
        for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER'])
          if (privs.includes(p)) bad.push(`${fq(t)} ${p}`);
        if (privs.includes('DELETE') && RUNTIME_DELETE_ALLOWED[fq(t)] === undefined)
          bad.push(`${fq(t)} DELETE`);
      }
      expect(bad).toEqual([]);
      const stale = Object.keys(RUNTIME_DELETE_ALLOWED).filter(
        (k) => !all.some((t) => fq(t) === k),
      );
      expect(stale, 'stale DELETE exceptions').toEqual([]);
      for (const [name, e] of Object.entries(RUNTIME_DELETE_ALLOWED))
        expect(e.reason.length, name).toBeGreaterThan(30);
    });

    it('global tables grant the runtime role exactly the privileges their exception allows', async () => {
      const all = await top();
      for (const [name, e] of Object.entries(GLOBAL_TABLES)) {
        const t = all.find((x) => fq(x) === name)!;
        // Table-level privileges only here; column-level write grants are checked below.
        const rows = await adminQuery<{ p: string }>(
          `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = $1 AND table_schema = $2 AND table_name = $3`,
          [RT, t.schema, t.name],
        );
        const tableLevel = rows
          .map((r) => r.p)
          .filter((p) => !['INSERT', 'UPDATE'].includes(p) || e.insertColumns === undefined);
        const allowed = new Set<string>(e.runtimePrivileges);
        expect(
          tableLevel.filter((p) => !allowed.has(p)),
          `${name} table-level`,
        ).toEqual([]);
      }
    });

    it('no role other than the owner and app_runtime holds any privilege on application tables (PUBLIC included)', async () => {
      const g = await adminQuery<{ grantee: string; t: string }>(
        `SELECT DISTINCT grantee, table_schema || '.' || table_name AS t FROM information_schema.role_table_grants
        WHERE table_schema IN ('app', 'platform') AND grantee NOT IN ($1, $2, 'postgres')`,
        [RT, MIG],
      );
      const admin = decodeURIComponent(new URL(inject('dbAdminUrl')).username);
      expect(g.filter((r) => r.grantee !== admin)).toEqual([]);
    });
  },
);

describe('identity and session tables: least privilege that keeps sign-in working', () => {
  const cols = async (table: string, priv: 'INSERT' | 'UPDATE' | 'SELECT'): Promise<string[]> => {
    const rows = await adminQuery<{ a: string; ok: boolean }>(
      `SELECT a.attname AS a, has_column_privilege($1, c.oid, a.attnum, $2) AS ok
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'platform' AND c.relname = $3 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [RT, priv, table],
    );
    return rows.filter((r) => r.ok).map((r) => r.a);
  };

  it('writable columns are exactly the documented ones', async () => {
    for (const table of ['identities', 'auth_sessions']) {
      const e = GLOBAL_TABLES[`platform.${table}`]!;
      expect((await cols(table, 'INSERT')).sort(), `${table} insert`).toEqual(
        [...e.insertColumns!].sort(),
      );
      expect((await cols(table, 'UPDATE')).sort(), `${table} update`).toEqual(
        [...e.updateColumns!].sort(),
      );
    }
  });

  it('the runtime role cannot delete identities or sessions, change a password hash, e-mail, status or id, or re-point a session', async () => {
    const id = (await adminQuery<{ id: string }>(`SELECT id FROM platform.identities LIMIT 1`))[0]!
      .id;
    const sid = (
      await adminQuery<{ id: string }>(`SELECT id FROM platform.auth_sessions LIMIT 1`)
    )[0]?.id;
    const attempts: Array<[string, string, unknown[]]> = [
      ['delete identity', `DELETE FROM platform.identities WHERE id = $1`, [id]],
      [
        'set password hash',
        `UPDATE platform.identities SET password_hash = 'x' WHERE id = $1`,
        [id],
      ],
      ['set e-mail', `UPDATE platform.identities SET email = 'x@y.test' WHERE id = $1`, [id]],
      ['set status', `UPDATE platform.identities SET status = 'ACTIVE' WHERE id = $1`, [id]],
      ['truncate sessions', `TRUNCATE platform.auth_sessions`, []],
    ];
    if (sid) {
      attempts.push(
        ['delete session', `DELETE FROM platform.auth_sessions WHERE id = $1`, [sid]],
        [
          're-point session identity',
          `UPDATE platform.auth_sessions SET identity_id = $2 WHERE id = $1`,
          [sid, id],
        ],
        [
          're-point session tenant',
          `UPDATE platform.auth_sessions SET tenant_id = $2 WHERE id = $1`,
          [sid, ORG_A],
        ],
        [
          'extend session',
          `UPDATE platform.auth_sessions SET expires_at = now() + interval '1 year' WHERE id = $1`,
          [sid],
        ],
        [
          'replace token hash',
          `UPDATE platform.auth_sessions SET token_hash = 'x' WHERE id = $1`,
          [sid],
        ],
      );
    }
    for (const [label, sql, params] of attempts) {
      const r = await runAs(CTX.staffA, sql, params);
      expect(r.error?.code, label).toBe('42501'); // insufficient_privilege
    }
  });

  it('the operations sign-in needs are still permitted (lockout counters, revoking a session, assurance columns)', async () => {
    const id = (await adminQuery<{ id: string }>(`SELECT id FROM platform.identities LIMIT 1`))[0]!
      .id;
    const ok = await runAs(
      CTX.staffA,
      `UPDATE platform.identities SET failed_login_count = failed_login_count, locked_until = locked_until WHERE id = $1`,
      [id],
    );
    expect(ok.error).toBeUndefined();
    const s = await runAs(
      CTX.staffA,
      `UPDATE platform.auth_sessions SET revoked_at = revoked_at, step_up_at = step_up_at, auth_strength = auth_strength, mfa_verified_at = mfa_verified_at WHERE false`,
    );
    expect(s.error).toBeUndefined();
  });
});

describe('SECURITY DEFINER functions: the approved set, safely configured', () => {
  it('every SECURITY DEFINER function in app/platform is approved, owned by the migration role, search_path-pinned and not executable by PUBLIC', async () => {
    const fns = await adminQuery<{
      name: string;
      owner: string;
      cfg: string[] | null;
      pub: boolean;
      rtExec: boolean;
    }>(
      `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS cfg,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege($1, p.oid, 'EXECUTE') AS "rtExec"
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'platform') AND p.prosecdef ORDER BY 1`,
      [RT],
    );
    expect(
      fns.map((f) => f.name).filter((n) => SECURITY_DEFINER_FUNCTIONS[n] === undefined),
      'unapproved SECURITY DEFINER functions',
    ).toEqual([]);
    expect(
      Object.keys(SECURITY_DEFINER_FUNCTIONS).filter((n) => !fns.some((f) => f.name === n)),
      'stale approvals',
    ).toEqual([]);
    for (const f of fns) {
      const approved = SECURITY_DEFINER_FUNCTIONS[f.name]!;
      expect(f.owner, f.name).toBe(MIG);
      expect(f.pub, `${f.name} executable by PUBLIC`).toBe(false);
      const sp = (f.cfg ?? []).find((c) => c.startsWith('search_path='));
      expect(sp, `${f.name} search_path`).toBeDefined();
      expect(sp!.slice('search_path='.length).replace(/"/g, ''), f.name).toBe(
        approved.maxSearchPath,
      );
      expect(sp, `${f.name} must never include public`).not.toMatch(/\bpublic\b/);
      expect(approved.reason.length, f.name).toBeGreaterThan(20);
    }
  });

  it('no application function is executable by PUBLIC (trigger and policy helpers included)', async () => {
    const fns = await adminQuery<{ name: string }>(
      `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('app', 'platform') AND has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1`,
    );
    expect(fns.map((f) => f.name)).toEqual([]);
  });
});
