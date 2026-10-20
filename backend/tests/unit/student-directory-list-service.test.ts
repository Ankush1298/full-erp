import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_LIST_PERMISSION,
  DIRECTORY_LIST_ROUTE_ID,
  StudentDirectoryListService,
  type DirectoryListOptions,
} from '../../src/modules/students/student-directory-list.service.js';
import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { createCursorCodec } from '../../src/shared/pagination/index.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { registerIssued } from '../../src/shared/tenancy/context-registry.js';
import type { TrustedContext } from '../../src/shared/tenancy/trusted-context.js';

// Service-level tests on a scripted transaction: no database. The scripted directory query emulates only what the SQL
// states (status filter, admission_number > after, ORDER BY admission_number, LIMIT) over static ASCII fixtures, so these
// tests prove the PARAMETERS the service sends (scope, filter, position, limit + 1), the cursor and audit behaviour, and
// the page assembly. They do NOT prove the SQL itself: the scope/exclusion semantics need the database-backed
// integration test (tests/integration/student-directory-list.test.ts), which is pending a separately authorised run.

interface Grant {
  scope_mode: string;
  scope_type: string;
  scope_id: string | null;
}
interface Fixture {
  id: string;
  admission_number: string;
  display_name: string;
  status: string;
}
const FIXTURES: Fixture[] = ['A001', 'A002', 'A003', 'A004', 'A005'].map((n, i) => ({
  id: uuidv7(),
  admission_number: n,
  display_name: `Student Name ${i + 1}`,
  status: i % 2 === 0 ? 'ACTIVE' : 'ON_LEAVE',
}));

const ORG: Grant[] = [{ scope_mode: 'GRANTED', scope_type: 'ORGANIZATION', scope_id: null }];

function script(grants: Grant[] = ORG, opts: { auditFails?: boolean; rows?: Fixture[] } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (sql.includes('role_permissions')) return rows(grants);
      if (sql.includes('INSERT INTO app.audit_events')) {
        if (opts.auditFails) return Promise.reject(new Error('audit insert failed'));
        return rows([]);
      }
      if (sql.includes('FROM app.students')) {
        const [, status, after, , , , limit] = params as [
          string,
          string | null,
          string | null,
          boolean,
          string[],
          string[],
          number,
        ];
        const hit = (opts.rows ?? FIXTURES)
          .filter((f) => status === null || f.status === status)
          .filter((f) => after === null || f.admission_number > after)
          .sort((a, b) => (a.admission_number < b.admission_number ? -1 : 1))
          .slice(0, limit);
        return rows(hit);
      }
      return rows([]);
    },
  };
  const directoryCalls = () => calls.filter((c) => c.sql.includes('FROM app.students'));
  const auditCalls = () => calls.filter((c) => c.sql.includes('INSERT INTO app.audit_events'));
  return { tx, calls, directoryCalls, auditCalls };
}

const staff = (tenantId = uuidv7(), userId = uuidv7()) =>
  issueTrustedContext({ tenantId, userId, actorKind: 'STAFF' });

function makeCodec(clock: { ms: number } = { ms: Date.now() }) {
  const key = randomBytes(32).toString('base64url');
  const codec = createCursorCodec(
    { activeKeyId: 'k1', keys: new Map([['k1', { reveal: () => key }]]) },
    { now: () => clock.ms },
  );
  return { codec, clock };
}
const opts = (codec: DirectoryListOptions['codec']): DirectoryListOptions => ({
  codec,
  activeKeyId: 'k1',
  meta: { ip: '203.0.113.7', requestId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' },
});
const list = (
  tx: unknown,
  ctx: TrustedContext,
  input: Parameters<typeof StudentDirectoryListService.list>[2],
  o: DirectoryListOptions,
) => StudentDirectoryListService.list(tx as never, ctx, input, o);

describe('StudentDirectoryListService: authorization chain', () => {
  it('refuses STUDENT and unknown actor kinds with 403 before any statement', async () => {
    const { codec } = makeCodec();
    const s = script();
    const student = issueTrustedContext({
      tenantId: uuidv7(),
      userId: uuidv7(),
      actorKind: 'STUDENT',
    });
    await expect(list(s.tx, student, {}, opts(codec))).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    const forged = Object.freeze({
      tenantId: uuidv7(),
      userId: uuidv7(),
      actorKind: 'AI',
    }) as unknown as TrustedContext;
    registerIssued(forged);
    await expect(list(s.tx, forged, {}, opts(codec))).rejects.toMatchObject({ statusCode: 403 });
    expect(s.calls).toEqual([]);
  });

  it('refuses an untrusted context with 500 before any statement', async () => {
    const { codec } = makeCodec();
    const s = script();
    const fake = { tenantId: uuidv7(), userId: uuidv7(), actorKind: 'STAFF' } as TrustedContext;
    await expect(list(s.tx, fake, {}, opts(codec))).rejects.toMatchObject({
      statusCode: 500,
      code: 'UNTRUSTED_CONTEXT',
    });
    expect(s.calls).toEqual([]);
  });

  it('a caller without the permission gets 403 and no directory query and no audit event run', async () => {
    const { codec } = makeCodec();
    const s = script([]);
    await expect(list(s.tx, staff(), {}, opts(codec))).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(s.directoryCalls()).toHaveLength(0);
    expect(s.auditCalls()).toHaveLength(0);
  });

  it('loads grants for student.directory.list only (independent of student.directory.search)', async () => {
    const { codec } = makeCodec();
    const s = script();
    await list(s.tx, staff(), {}, opts(codec));
    const grantCalls = s.calls.filter((c) => c.sql.includes('role_permissions'));
    expect(grantCalls.length).toBeGreaterThan(0);
    for (const c of grantCalls) expect(c.params[2]).toBe(DIRECTORY_LIST_PERMISSION);
    expect(DIRECTORY_LIST_PERMISSION).toBe('student.directory.list');
  });
});

describe('StudentDirectoryListService: scope comes only from GRANTED assignments', () => {
  const dept = uuidv7();
  const campus = uuidv7();
  const cases: {
    name: string;
    grants: Grant[];
    org: boolean;
    campuses: string[];
    depts: string[];
  }[] = [
    {
      name: 'organization-wide holder (COLLEGE_ADMIN, org REGISTRAR)',
      grants: ORG,
      org: true,
      campuses: [],
      depts: [],
    },
    {
      name: 'campus-scoped holder (CAMPUS_ADMIN, campus REGISTRAR) is NOT org-wide',
      grants: [{ scope_mode: 'GRANTED', scope_type: 'CAMPUS', scope_id: campus }],
      org: false,
      campuses: [campus],
      depts: [],
    },
    {
      name: 'department-scoped holder (HOD, DEPARTMENT_ADMIN): department only, no campus or org fallback',
      grants: [{ scope_mode: 'GRANTED', scope_type: 'DEPARTMENT', scope_id: dept }],
      org: false,
      campuses: [],
      depts: [dept],
    },
    {
      name: 'SELF and ASSIGNED grants never widen the scope',
      grants: [
        { scope_mode: 'SELF', scope_type: 'ORGANIZATION', scope_id: null },
        { scope_mode: 'ASSIGNED', scope_type: 'ORGANIZATION', scope_id: null },
      ],
      org: false,
      campuses: [],
      depts: [],
    },
    {
      name: 'a campus grant without an id contributes nothing',
      grants: [{ scope_mode: 'GRANTED', scope_type: 'CAMPUS', scope_id: null }],
      org: false,
      campuses: [],
      depts: [],
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { codec } = makeCodec();
      const s = script(c.grants);
      const ctx = staff();
      await list(s.tx, ctx, {}, opts(codec));
      const [call] = s.directoryCalls();
      expect(call?.params.slice(0, 1)).toEqual([ctx.tenantId]);
      expect(call?.params.slice(3, 6)).toEqual([c.org, c.campuses, c.depts]);
    });
  }

  it('the directory statement requires an ACTIVE enrolment inside the scope and never lists unplaced or closed-only students', async () => {
    const { codec } = makeCodec();
    const s = script();
    await list(s.tx, staff(), {}, opts(codec));
    const sql = s.directoryCalls()[0]!.sql;
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM app\.student_programs sp/);
    expect(sql).toMatch(/sp\.status = 'ACTIVE'/);
    expect(sql).toMatch(
      /\$4::boolean OR sp\.campus_id = ANY\(\$5::uuid\[\]\) OR sp\.department_id = ANY\(\$6::uuid\[\]\)/,
    );
    expect(sql).not.toMatch(/NOT EXISTS/); // the lookup's "unplaced is findable" branch does not exist here
  });
});

describe('StudentDirectoryListService: input validation (before any statement)', () => {
  const bad: [string, Parameters<typeof StudentDirectoryListService.list>[2]][] = [
    ['unknown status', { status: 'ENROLLED' }],
    ['lower-case status', { status: 'active' }],
    ['non-string status', { status: 1 }],
    ['limit 0', { limit: 0 }],
    ['limit 101', { limit: 101 }],
    ['fractional limit', { limit: 2.5 }],
    ['string limit', { limit: '5' }],
    ['non-string cursor', { cursor: 5 }],
  ];
  for (const [name, input] of bad) {
    it(`rejects ${name} with 400 and runs nothing`, async () => {
      const { codec } = makeCodec();
      const s = script();
      await expect(list(s.tx, staff(), input, opts(codec))).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(s.calls).toEqual([]);
    });
  }

  it('accepts every defined student status', async () => {
    const { codec } = makeCodec();
    for (const status of [
      'ADMITTED',
      'ACTIVE',
      'ON_LEAVE',
      'SUSPENDED',
      'DISCONTINUED',
      'GRADUATED',
      'TRANSFERRED_OUT',
    ]) {
      const s = script();
      await list(s.tx, staff(), { status }, opts(codec));
      expect(s.directoryCalls()[0]!.params[1]).toBe(status);
    }
  });
});

describe('StudentDirectoryListService: pages', () => {
  it('first page: default limit 25, limit + 1 requested, no cursor, hasActiveEnrolment true, five-field entries', async () => {
    const { codec } = makeCodec();
    const s = script();
    const page = await list(s.tx, staff(), {}, opts(codec));
    const [call] = s.directoryCalls();
    expect(call?.params[2]).toBeNull(); // no position
    expect(call?.params[6]).toBe(26);
    expect(page.items.map((i) => i.admissionNumber)).toEqual([
      'A001',
      'A002',
      'A003',
      'A004',
      'A005',
    ]);
    expect(page.nextCursor).toBeNull();
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['admissionNumber', 'displayName', 'hasActiveEnrolment', 'id', 'status'].sort(),
      );
      expect(item.hasActiveEnrolment).toBe(true);
    }
  });

  it('a full page with more rows behind it returns exactly `limit` rows and a cursor; the last page has none', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const first = await list(script().tx, ctx, { limit: 2 }, opts(codec));
    expect(first.items.map((i) => i.admissionNumber)).toEqual(['A001', 'A002']);
    expect(first.nextCursor).not.toBeNull();
    const exactly = await list(script().tx, ctx, { limit: 5 }, opts(codec));
    expect(exactly.items).toHaveLength(5);
    expect(exactly.nextCursor).toBeNull(); // exactly `limit` rows left: limit + 1 found none
  });

  it('walks a static multi-page fixture with no duplicates and no gaps', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(
        script().tx,
        ctx,
        { limit: 2, ...(cursor ? { cursor } : {}) },
        opts(codec),
      );
      seen.push(...page.items.map((i) => i.admissionNumber));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(['A001', 'A002', 'A003', 'A004', 'A005']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('the status filter is sent as a parameter and applied; a walk under a filter stays under it', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const p1 = await list(script().tx, ctx, { status: 'ACTIVE', limit: 2 }, opts(codec));
    expect(p1.items.map((i) => i.admissionNumber)).toEqual(['A001', 'A003']);
    const p2 = await list(
      script().tx,
      ctx,
      { status: 'ACTIVE', limit: 2, cursor: p1.nextCursor! },
      opts(codec),
    );
    expect(p2.items.map((i) => i.admissionNumber)).toEqual(['A005']);
    expect(p2.nextCursor).toBeNull();
  });

  it('an empty result is an empty page with no cursor (and is still audited)', async () => {
    const { codec } = makeCodec();
    const s = script(ORG, { rows: [] });
    const page = await list(s.tx, staff(), {}, opts(codec));
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(s.auditCalls()).toHaveLength(1);
  });

  it('the cursor position is sent as a parameter, never interpolated into the SQL', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const first = await list(script().tx, ctx, { limit: 2 }, opts(codec));
    const s = script();
    await list(s.tx, ctx, { limit: 2, cursor: first.nextCursor! }, opts(codec));
    const [call] = s.directoryCalls();
    expect(call?.params[2]).toBe('A002');
    expect(call?.sql).not.toContain('A002');
    expect(call?.sql).not.toContain(first.nextCursor!);
  });
});

describe('StudentDirectoryListService: cursor binding and uniform failure', () => {
  const issued = async (ctx: TrustedContext, input = {}) => {
    const { codec, clock } = makeCodec();
    const first = await list(script().tx, ctx, { limit: 2, ...input }, opts(codec));
    return { codec, clock, cursor: first.nextCursor! };
  };
  const expectInvalid = async (
    codec: DirectoryListOptions['codec'],
    ctx: TrustedContext,
    input: Parameters<typeof StudentDirectoryListService.list>[2],
  ) => {
    const s = script();
    await expect(list(s.tx, ctx, input, opts(codec))).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_CURSOR',
      message: 'The cursor is invalid or has expired.',
    });
    expect(s.directoryCalls()).toHaveLength(0); // never reaches the directory query
    expect(s.auditCalls()).toHaveLength(0); // and a failed request is not audited as a success
  };

  it('accepts a fresh cursor of the same tenant, user, route and filter', async () => {
    const ctx = staff();
    const { codec, cursor } = await issued(ctx, { status: 'ACTIVE' });
    const page = await list(script().tx, ctx, { limit: 2, status: 'ACTIVE', cursor }, opts(codec));
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('rejects a cursor of another tenant, another user, another filter (changed or dropped or added)', async () => {
    const ctx = staff();
    const { codec, cursor } = await issued(ctx, { status: 'ACTIVE' });
    await expectInvalid(codec, staff(uuidv7(), ctx.userId), { status: 'ACTIVE', cursor }); // wrong tenant
    await expectInvalid(codec, staff(ctx.tenantId, uuidv7()), { status: 'ACTIVE', cursor }); // wrong user
    await expectInvalid(codec, ctx, { status: 'ON_LEAVE', cursor }); // changed filter
    await expectInvalid(codec, ctx, { cursor }); // dropped filter
    const plain = await issued(ctx);
    await expectInvalid(plain.codec, ctx, { status: 'ACTIVE', cursor: plain.cursor }); // added filter
  });

  it('rejects a cursor issued for another route', async () => {
    const ctx = staff();
    const { codec } = makeCodec();
    const other = codec.encode({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      routeId: 'employee.list',
      filterHash: 'a'.repeat(64),
      lastAdmissionNumber: 'A002',
    });
    expect(DIRECTORY_LIST_ROUTE_ID).not.toBe('employee.list');
    await expectInvalid(codec, ctx, { cursor: other });
  });

  it('rejects an expired cursor but accepts one just inside the lifetime', async () => {
    const ctx = staff();
    const { codec, clock, cursor } = await issued(ctx);
    clock.ms += 599_000;
    await expect(list(script().tx, ctx, { limit: 2, cursor }, opts(codec))).resolves.toBeDefined();
    clock.ms += 2_000; // 601 s after issue
    await expectInvalid(codec, ctx, { limit: 2, cursor });
  });

  it('rejects tampered, malformed, empty, oversized and foreign-key cursors with the same answer', async () => {
    const ctx = staff();
    const { codec, cursor } = await issued(ctx);
    const mid = Math.floor(cursor.length / 2);
    const flipped =
      cursor.slice(0, mid) + (cursor[mid] === 'A' ? 'B' : 'A') + cursor.slice(mid + 1);
    const foreign = (await issued(ctx)).cursor; // same shape, different key
    for (const bad of [
      flipped,
      cursor.slice(0, -2),
      `${cursor}A`,
      'not-a-cursor',
      '',
      '%%%',
      'x'.repeat(2000),
      foreign,
    ]) {
      await expectInvalid(codec, ctx, { cursor: bad });
    }
  });
});

describe('StudentDirectoryListService: audit', () => {
  it('writes one tier-1 student.directory.list event after the read, with only the approved metadata', async () => {
    const { codec } = makeCodec();
    const s = script();
    const ctx = staff();
    const page = await list(s.tx, ctx, { limit: 2, status: 'ACTIVE' }, opts(codec));
    expect(s.auditCalls()).toHaveLength(1);
    const call = s.auditCalls()[0]!;
    // statement order: read first, audit second, in the one transaction object
    expect(s.calls.indexOf(s.directoryCalls()[0]!)).toBeLessThan(s.calls.indexOf(call));
    const p = call.params;
    expect(p[1]).toBe(ctx.tenantId);
    expect(p[2]).toBe(ctx.userId);
    expect(p[4]).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479'); // request id from the request metadata
    expect(p[5]).toBe('203.0.113.7');
    expect(p[7]).toBe('student.directory.list');
    expect(p[8]).toBe('student_directory');
    expect(p[9]).toBeNull(); // no resource id
    expect(p[10]).toBeNull(); // no subject student
    expect(p[13]).toBe(1); // risk tier
    const metadata = JSON.parse(p[17] as string) as Record<string, unknown>;
    expect(metadata).toEqual({
      route: 'GET /api/v1/students/directory',
      status: 'ACTIVE',
      limit: 2,
      returned: page.items.length,
      cursorPresent: false,
      issuedKeyId: page.nextCursor === null ? null : 'k1',
    });
  });

  it('records the normalised status as null when absent, the cursor-present flag, and no key ID without a next page', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const first = await list(script().tx, ctx, { limit: 2 }, opts(codec));
    const s = script();
    await list(s.tx, ctx, { limit: 5, cursor: first.nextCursor! }, opts(codec));
    const metadata = JSON.parse(s.auditCalls()[0]!.params[17] as string) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      status: null,
      cursorPresent: true,
      issuedKeyId: null,
      returned: 3,
    });
  });

  it('never puts the cursor, an admission number, a student id or a name in the audit event', async () => {
    const { codec } = makeCodec();
    const ctx = staff();
    const first = await list(script().tx, ctx, { limit: 2 }, opts(codec));
    const s = script();
    const second = await list(s.tx, ctx, { limit: 2, cursor: first.nextCursor! }, opts(codec));
    const everything = JSON.stringify(s.auditCalls().map((c) => c.params));
    for (const secret of [
      first.nextCursor!,
      second.nextCursor!,
      ...FIXTURES.flatMap((f) => [f.admission_number, f.id, f.display_name]),
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('fails the request when the audit write fails (nothing is returned as success)', async () => {
    const { codec } = makeCodec();
    const s = script(ORG, { auditFails: true });
    const result = list(s.tx, staff(), {}, opts(codec));
    await expect(result).rejects.toMatchObject({ statusCode: 500, code: 'AUDIT_WRITE_FAILED' });
    expect(s.directoryCalls()).toHaveLength(1); // it did read, then failed closed
  });

  it('a rejected audit event (invalid request metadata) also fails closed', async () => {
    const { codec } = makeCodec();
    const s = script();
    const o = { ...opts(codec), meta: { ip: 'not-an-ip' } };
    await expect(list(s.tx, staff(), {}, o)).rejects.toMatchObject({ code: 'AUDIT_INVALID' });
  });
});

describe('StudentDirectoryListService: an admission number the cursor codec cannot carry', () => {
  // The database only bounds admission_number to 1-50 characters; the codec accepts 1-64 printable ASCII characters. A value
  // written by a seed, import or privileged writer can therefore be listable but not addressable as a cursor position.
  const A = (n: number) => FIXTURES[n - 1] as Fixture;
  const odd = (n: string): Fixture => ({
    id: uuidv7(),
    admission_number: n,
    display_name: 'Odd Number',
    status: 'ACTIVE',
  });

  for (const [name, value] of [
    ['a space', 'A002 x'],
    ['a non-ASCII character', 'A002\u00c9'],
    ['a control character', 'A002\u0001'],
  ] as const) {
    it(`${name} on the LAST row of a page that has a next page: a fixed 500, nothing returned, nothing audited, the value never echoed`, async () => {
      const { codec } = makeCodec();
      // order: A001, <odd>, A003 ... ; limit 2 => page [A001, <odd>] and A003 proves there is more
      const s = script(ORG, { rows: [A(1), odd(value), A(3)] });
      const err = await list(s.tx, staff(), { limit: 2 }, opts(codec)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        statusCode: 500,
        code: 'DIRECTORY_CURSOR_UNAVAILABLE',
        message: 'The next page cannot be addressed. Contact an administrator.',
      });
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(value);
      expect(s.auditCalls()).toHaveLength(0);
    });
  }

  it('the same value is harmless when it is not the last row of the page, or when there is no next page', async () => {
    const { codec } = makeCodec();
    const middle = await list(
      script(ORG, { rows: [A(1), odd('A002 x'), A(3), A(4)] }).tx,
      staff(),
      { limit: 3 },
      opts(codec),
    );
    expect(middle.items.map((i) => i.admissionNumber)).toEqual(['A001', 'A002 x', 'A003']);
    expect(middle.nextCursor).not.toBeNull();
    const lastPage = await list(
      script(ORG, { rows: [A(1), odd('A002 x')] }).tx,
      staff(),
      { limit: 2 },
      opts(codec),
    );
    expect(lastPage.items).toHaveLength(2);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('the codec itself is unchanged: it still refuses such a position', () => {
    const { codec } = makeCodec();
    expect(() =>
      codec.encode({
        tenantId: uuidv7(),
        userId: uuidv7(),
        routeId: DIRECTORY_LIST_ROUTE_ID,
        filterHash: 'a'.repeat(64),
        lastAdmissionNumber: 'A002 x',
      }),
    ).toThrow(/lastAdmissionNumber/);
  });
});
