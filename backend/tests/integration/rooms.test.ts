import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as argon2 from 'argon2';
import type { InjectOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { Database } from '../../src/shared/database/index.js';
import { createPool } from '../../src/shared/database/pool.js';
import { adminQuery, mfaVerified } from '../support/db-harness.js';
import { RoomService } from '../../src/modules/organization/room.service.js';
import { createIsolatedTenant, type IsolatedTenant } from '../support/isolated-tenant.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { CAMPUS_1, CAMPUS_2, ORG_A, ORG_B, STAFF_A, UNKNOWN_V7 } from '../support/fixtures.js';

const PASSWORD = /* secret-scan:allow */ 'CorrectPassword123!';
const APP_ORIGIN = 'https://app.campus.test';
const BASE = '/api/v1/organization';

const LOGINS = {
  orgAdminA: 'staff.a@college-a.test',
  campusAdminA: 'campus.admin.a@college-a.test',
  facultyA: 'faculty.a@college-a.test',
  studentA: 'user.a@college-a.test',
  orgAdminB: 'staff.b@college-b.test',
} as const;

type UserKey = keyof typeof LOGINS;

const url = inject('dbRuntimeUrl');
const pool = createPool({ connectionString: url, ssl: false, max: 4 });
const db = new Database(pool);
const app = buildApp({
  config: loadConfig({ DATABASE_URL: url, APP_ORIGINS: APP_ORIGIN }),
  db,
  logger: false,
});

const sessions = {} as Record<UserKey, { cookie: string; csrf: string }>;

function get(user: UserKey | null, path: string) {
  return app.inject({
    method: 'GET',
    url: path,
    cookies: user ? { session_token: sessions[user].cookie } : {},
  });
}

function send(
  method: 'POST' | 'PATCH',
  user: UserKey | null,
  path: string,
  payload?: InjectOptions['payload'],
  opts: { csrf?: string; ifMatch?: string } = {},
) {
  const csrf = opts.csrf !== undefined ? opts.csrf : user ? sessions[user].csrf : undefined;
  return app.inject({
    method,
    url: path,
    ...(payload !== undefined ? { payload } : {}),
    cookies: user ? { session_token: sessions[user].cookie } : {},
    headers: {
      origin: APP_ORIGIN,
      ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
      ...(opts.ifMatch !== undefined ? { 'if-match': opts.ifMatch } : {}),
    },
  });
}

beforeAll(async () => {
  await app.ready();
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await adminQuery(
    'UPDATE platform.identities SET password_hash = $1 WHERE email = ANY($2::text[])',
    [hash, Object.values(LOGINS)],
  );
  for (const [key, email] of Object.entries(LOGINS) as [UserKey, string][]) {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, email).toBe(200);
    sessions[key] = {
      cookie: await mfaVerified(r.cookies.find((c) => c.name === 'session_token')!.value),
      csrf: r.json<{ csrf_token: string }>().csrf_token,
    };
  }
});

afterAll(async () => {
  await adminQuery('DELETE FROM app.rooms WHERE organization_id = ANY($1::uuid[])', [
    [ORG_A, ORG_B],
  ]);
  await app.close();
  await pool.end().catch(() => undefined);
});

// Canonical room model (docs 01 Room, 02 §4.2 rooms): campus_id, code, kind (required); name, capacity (optional);
// no status, no building/floor, audit class A0 (no audit events). `kind` has no vocabulary in the documents.
const ROOM_KEYS = [
  'campusId',
  'capacity',
  'code',
  'createdAt',
  'id',
  'kind',
  'name',
  'organizationId',
  'updatedAt',
  'version',
];

describe('Rooms Management (Milestone 2 Batch 1)', () => {
  let createdRoomId: string;
  let bareRoomId: string;

  const auditCount = async (ids: string[]): Promise<number> =>
    Number(
      (
        await adminQuery<{ n: string }>(
          `SELECT count(*) AS n FROM app.audit_events
            WHERE organization_id = $1 AND (resource_id = ANY($2::uuid[]) OR resource_type = 'room')`,
          [ORG_A, ids],
        )
      )[0]!.n,
    );

  describe('Room Creation & Validation', () => {
    it('campus admin can create a room with the canonical fields', async () => {
      const res = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'LH-101',
        kind: 'Lecture hall',
        name: 'Lecture Hall 101',
        capacity: 60,
      });

      expect(res.statusCode).toBe(201);
      const json = res.json<{ success: boolean; data: { id: string } }>();
      expect(json.success).toBe(true);
      createdRoomId = json.data.id;
    });

    it('name and capacity are optional (null), kind is required', async () => {
      const res = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'BARE-1',
        kind: 'lab',
      });
      expect(res.statusCode).toBe(201);
      bareRoomId = res.json<{ data: { id: string } }>().data.id;
      const got = await get('campusAdminA', `${BASE}/rooms/${bareRoomId}`);
      expect(got.json<{ data: { name: null; capacity: null; kind: string } }>().data).toMatchObject(
        {
          name: null,
          capacity: null,
          kind: 'lab',
        },
      );

      const missingKind = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'NO-KIND',
      });
      expect(missingKind.statusCode).toBe(400);
    });

    it('kind has no fixed vocabulary: any bounded text is stored as given', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/campuses/${CAMPUS_2}/rooms`, {
        code: 'ODD-KIND',
        kind: 'Seminar hall (north wing)',
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects duplicate room code within the same campus (409 Conflict)', async () => {
      const res = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'LH-101',
        kind: 'Lecture hall',
      });
      expect(res.statusCode).toBe(409);
    });

    it('allows identical room code in a different campus (cross-campus reuse)', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/campuses/${CAMPUS_2}/rooms`, {
        code: 'LH-101',
        kind: 'Lecture hall',
      });
      expect(res.statusCode).toBe(201);
    });

    it('rejects invalid values (400): empty or oversized kind/name, non-positive or non-integer capacity', async () => {
      const bad: Record<string, unknown>[] = [
        { code: 'V-1', kind: '' },
        { code: 'V-2', kind: 'x'.repeat(51) },
        { code: 'V-3', kind: 'lab', name: '' },
        { code: 'V-4', kind: 'lab', name: 'n'.repeat(256) },
        { code: 'V-5', kind: 'lab', capacity: 0 },
        { code: 'V-6', kind: 'lab', capacity: -3 },
        { code: 'V-7', kind: 'lab', capacity: 1.5 },
        { code: 'V-8', kind: 'lab', capacity: null },
        { code: '', kind: 'lab' },
      ];
      for (const payload of bad) {
        const res = await send(
          'POST',
          'campusAdminA',
          `${BASE}/campuses/${CAMPUS_1}/rooms`,
          payload,
        );
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('the extra fields of the first implementation are refused: roomType, building, floor, status, reason', async () => {
      for (const extra of [
        { roomType: 'CLASSROOM' },
        { building: 'A' },
        { floor: '1' },
        { status: 'ACTIVE' },
        { reason: 'Because' },
        { organizationId: ORG_B },
        { campusId: CAMPUS_2 },
      ]) {
        const res = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
          code: 'X-EXTRA',
          kind: 'lab',
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
    });
  });

  describe('Room Retrieval & Listing', () => {
    it('lists rooms for a campus with org.structure.read, exposing exactly the canonical fields', async () => {
      const res = await get('campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`);
      expect(res.statusCode).toBe(200);
      const json = res.json<{ success: boolean; data: Array<Record<string, unknown>> }>();
      expect(json.data.some((r) => r.code === 'LH-101')).toBe(true);
      for (const r of json.data) expect(Object.keys(r).sort()).toEqual(ROOM_KEYS);
    });

    it('filters rooms by kind; the old filters are refused', async () => {
      const res = await get('campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms?kind=lab`);
      expect(res.statusCode).toBe(200);
      const json = res.json<{ data: Array<{ kind: string }> }>();
      expect(json.data.length).toBeGreaterThanOrEqual(1);
      expect(json.data.every((r) => r.kind === 'lab')).toBe(true);
      for (const q of ['status=ACTIVE', 'roomType=LAB', 'building=A']) {
        const bad = await get('campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms?${q}`);
        expect(bad.statusCode, q).toBe(400);
      }
    });

    it('gets a single room by id with ETag header', async () => {
      const res = await get('campusAdminA', `${BASE}/rooms/${createdRoomId}`);
      expect(res.statusCode).toBe(200);
      const json = res.json<{ data: Record<string, unknown> & { version: number } }>();
      expect(Object.keys(json.data).sort()).toEqual(ROOM_KEYS);
      expect(json.data).toMatchObject({ id: createdRoomId, code: 'LH-101', kind: 'Lecture hall' });
      expect(res.headers.etag).toBe(`"${json.data.version}"`);
    });

    it('returns 404 for unknown room id', async () => {
      const res = await get('campusAdminA', `${BASE}/rooms/${UNKNOWN_V7}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('Room Update & Optimistic Concurrency', () => {
    it('updates kind, name and capacity when If-Match matches; null clears the optional fields', async () => {
      const etag = (await get('campusAdminA', `${BASE}/rooms/${createdRoomId}`)).headers
        .etag as string;
      const updateRes = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${createdRoomId}`,
        { name: 'Renovated Lecture Hall 101', capacity: 75, kind: 'Auditorium' },
        { ifMatch: etag },
      );
      expect(updateRes.statusCode).toBe(200);
      expect(
        updateRes.json<{
          data: { name: string; capacity: number; kind: string; version: number };
        }>().data,
      ).toMatchObject({
        name: 'Renovated Lecture Hall 101',
        capacity: 75,
        kind: 'Auditorium',
        version: 2,
      });
      expect(updateRes.headers.etag).toBe('"2"');

      const cleared = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${createdRoomId}`,
        { name: null, capacity: null },
        { ifMatch: '"2"' },
      );
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json<{ data: { name: null; capacity: null } }>().data).toMatchObject({
        name: null,
        capacity: null,
      });
    });

    it('rejects update with 409 Conflict when If-Match is stale, and 428 without If-Match', async () => {
      const stale = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${createdRoomId}`,
        { name: 'Stale Update' },
        { ifMatch: '"1"' },
      );
      expect(stale.statusCode).toBe(409);
      const none = await send('PATCH', 'campusAdminA', `${BASE}/rooms/${createdRoomId}`, {
        name: 'No precondition',
      });
      expect(none.statusCode).toBe(428);
    });

    it('identity and removed fields are not updatable (400); an empty update is 400; a no-op keeps the version', async () => {
      const etag = (await get('campusAdminA', `${BASE}/rooms/${createdRoomId}`)).headers
        .etag as string;
      for (const payload of [
        { code: 'RENAMED' },
        { campusId: CAMPUS_2 },
        { organizationId: ORG_B },
        { status: 'INACTIVE' },
        { status: 'MAINTENANCE' },
        { roomType: 'LAB' },
        { building: 'B' },
        { floor: '2' },
        { reason: 'Because' },
        {},
      ]) {
        const res = await send('PATCH', 'campusAdminA', `${BASE}/rooms/${createdRoomId}`, payload, {
          ifMatch: etag,
        });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      }
      const same = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${createdRoomId}`,
        { kind: 'Auditorium' },
        { ifMatch: etag },
      );
      expect(same.statusCode).toBe(200);
      expect(same.headers.etag).toBe(etag);
    });

    it('the database holds exactly the canonical columns and refuses anything else to the runtime role', async () => {
      const cols = await adminQuery<{ column_name: string; is_nullable: string }>(
        `SELECT column_name::text, is_nullable::text FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'rooms' ORDER BY column_name`,
      );
      expect(cols.map((c) => c.column_name)).toEqual([
        'campus_id',
        'capacity',
        'code',
        'created_at',
        'id',
        'kind',
        'name',
        'organization_id',
        'updated_at',
        'version',
      ]);
      const nullable = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
      expect(nullable).toMatchObject({
        kind: 'NO',
        code: 'NO',
        campus_id: 'NO',
        name: 'YES',
        capacity: 'YES',
      });
      await expect(
        adminQuery(`UPDATE app.rooms SET kind = '' WHERE id = $1`, [createdRoomId]),
      ).rejects.toMatchObject({ code: '23514' });
      // runtime role: code/campus are not updatable, nothing can be deleted
      for (const sql of [
        `UPDATE app.rooms SET code = 'ZZ' WHERE id = $1`,
        `UPDATE app.rooms SET campus_id = '${CAMPUS_2}' WHERE id = $1`,
        `DELETE FROM app.rooms WHERE id = $1`,
      ]) {
        await expect(
          db.withTenant(
            issueTrustedContext({ tenantId: ORG_A, userId: STAFF_A, actorKind: 'STAFF' }),
            (tx) => tx.query(sql, [createdRoomId]),
          ),
        ).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  describe('Authorization & Scoping', () => {
    it('campus admin cannot create rooms in another campus (fails closed 404)', async () => {
      const res = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_2}/rooms`, {
        code: 'LH-C2-FAIL',
        kind: 'Lecture hall',
      });
      expect(res.statusCode).toBe(404);
    });

    it('campus admin cannot update a room of another campus (fails closed 404)', async () => {
      const other = await adminQuery<{ id: string }>(
        `SELECT id FROM app.rooms WHERE organization_id = $1 AND campus_id = $2 LIMIT 1`,
        [ORG_A, CAMPUS_2],
      );
      const res = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${other[0]!.id}`,
        { name: 'Hijack' },
        { ifMatch: '*' },
      );
      expect(res.statusCode).toBe(404);
    });

    it('college admin can create and manage rooms in any campus of the organization', async () => {
      const res = await send('POST', 'orgAdminA', `${BASE}/campuses/${CAMPUS_2}/rooms`, {
        code: 'LH-C2-ADMIN',
        kind: 'Lecture hall',
      });
      expect(res.statusCode).toBe(201);
    });

    it('student cannot create rooms (403 Forbidden)', async () => {
      const res = await send('POST', 'studentA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'STUDENT-ROOM',
        kind: 'Lecture hall',
      });
      expect(res.statusCode).toBe(403);
    });

    it('faculty can read but not manage (org.structure.read vs org.campus.manage)', async () => {
      const read = await get('facultyA', `${BASE}/rooms/${createdRoomId}`);
      expect(read.statusCode).toBe(200);
      const write = await send('POST', 'facultyA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'FAC-ROOM',
        kind: 'lab',
      });
      expect(write.statusCode).toBe(403);
    });

    it('cross-tenant isolation: Org Admin B cannot access Org A rooms (404)', async () => {
      const res = await get('orgAdminB', `${BASE}/rooms/${createdRoomId}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('No audit events (class A0, owner Decision 2)', () => {
    it('creating, updating and failing to write rooms emits no audit event at all', async () => {
      const before = await auditCount([createdRoomId, bareRoomId]);
      const made = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'NOAUDIT-1',
        kind: 'lab',
      });
      expect(made.statusCode).toBe(201);
      const id = made.json<{ data: { id: string } }>().data.id;
      const etag = (await get('campusAdminA', `${BASE}/rooms/${id}`)).headers.etag as string;
      const upd = await send(
        'PATCH',
        'campusAdminA',
        `${BASE}/rooms/${id}`,
        { capacity: 30, name: 'Audit-free' },
        { ifMatch: etag },
      );
      expect(upd.statusCode).toBe(200);
      const dup = await send('POST', 'campusAdminA', `${BASE}/campuses/${CAMPUS_1}/rooms`, {
        code: 'NOAUDIT-1',
        kind: 'lab',
      });
      expect(dup.statusCode).toBe(409);
      expect(await auditCount([id, createdRoomId, bareRoomId])).toBe(before);
    });
  });

  describe('No campus-status rule (the documents impose none on rooms)', () => {
    let T!: IsolatedTenant;
    beforeAll(async () => {
      T = await createIsolatedTenant('test-hash');
    });
    afterAll(async () => {
      await T.cleanup();
    });

    it('a room can be created on an INACTIVE campus; ownership, uniqueness and scope still hold', async () => {
      const admin = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.admin,
        actorKind: 'STAFF',
      });
      const campusAdmin = issueTrustedContext({
        tenantId: T.orgId,
        userId: T.users.campusAdmin,
        actorKind: 'STAFF',
      });
      // the department of the helper tenant is ACTIVE under this campus; deactivate both through the superuser
      await adminQuery(`UPDATE app.departments SET status = 'INACTIVE' WHERE id = $1`, [
        T.departmentId,
      ]);
      await adminQuery(`UPDATE app.campuses SET status = 'INACTIVE' WHERE id = $1`, [T.campusId]);
      const id = await db.withTenant(admin, (tx) =>
        RoomService.create(tx, admin, T.campusId, { code: 'INACT-1', kind: 'lab' }),
      );
      const rows = await adminQuery<{ campus_id: string; organization_id: string }>(
        'SELECT campus_id, organization_id FROM app.rooms WHERE id = $1',
        [id],
      );
      expect(rows[0]).toMatchObject({ campus_id: T.campusId, organization_id: T.orgId });
      // the scoped campus administrator of that campus may create too; the code stays unique per campus
      await expect(
        db.withTenant(campusAdmin, (tx) =>
          RoomService.create(tx, campusAdmin, T.campusId, { code: 'INACT-2', kind: 'lab' }),
        ),
      ).resolves.toBeTruthy();
      await expect(
        db.withTenant(admin, (tx) =>
          RoomService.create(tx, admin, T.campusId, { code: 'INACT-1', kind: 'lab' }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      // another tenant's campus is still not reachable
      await expect(
        db.withTenant(admin, (tx) =>
          RoomService.create(tx, admin, CAMPUS_1, { code: 'X', kind: 'lab' }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      // and the campus is a real owner: an unknown campus id is refused by existence, a row cannot be moved
      await expect(
        adminQuery(`UPDATE app.rooms SET campus_id = $2 WHERE id = $1`, [id, CAMPUS_2]),
      ).rejects.toBeDefined();
    });
  });
});
