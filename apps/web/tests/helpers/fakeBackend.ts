import { vi } from 'vitest';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  credentials: RequestCredentials | undefined;
  body: unknown;
}

export interface MeData {
  tenant_id: string;
  user_id: string;
  actor_kind: 'STUDENT' | 'STAFF';
  display_name: string;
  roles: string[];
  capabilities: string[];
}

export const STUDENT: MeData = {
  tenant_id: 't1',
  user_id: 'u1',
  actor_kind: 'STUDENT',
  display_name: 'Asha Student',
  roles: ['STUDENT'],
  capabilities: [
    'session.read',
    'session.revoke',
    'student.profile.read',
    'student.profile.read_sensitive',
  ],
};
export const STAFF: MeData = {
  tenant_id: 't1',
  user_id: 'u2',
  actor_kind: 'STAFF',
  display_name: 'Hari HOD',
  roles: ['HOD'],
  capabilities: ['session.read', 'session.revoke', 'student.profile.read'],
};
export const ACADEMIC_ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u4',
  actor_kind: 'STAFF',
  display_name: 'Rita Registrar',
  roles: ['REGISTRAR'],
  capabilities: [
    'session.read',
    'session.revoke',
    'org.structure.read',
    'academic.program.read',
    'academic.term.manage',
    'academic.course.manage',
    'academic.section.manage',
    'enrollment.term.read',
    'enrollment.term.manage',
  ],
};
export const OFFERING_ADMIN: MeData = {
  ...ACADEMIC_ADMIN,
  capabilities: [
    ...ACADEMIC_ADMIN.capabilities,
    'academic.offering.manage',
    'academic.faculty.assign',
  ],
};
/** Read-only: a head of department sees academics and enrolments but can change nothing. */
export const ACADEMIC_READER: MeData = {
  ...ACADEMIC_ADMIN,
  user_id: 'u5',
  display_name: 'Hari HOD',
  roles: ['HOD'],
  capabilities: ['session.read', 'academic.program.read', 'enrollment.term.read'],
};

export const ADMIN: MeData = {
  tenant_id: 't1',
  user_id: 'u3',
  actor_kind: 'STAFF',
  display_name: 'Ada Admin',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [
    'session.read',
    'session.revoke',
    'session.revoke_any',
    'student.profile.read',
    'org.settings.read',
    'org.campus.manage',
    'org.department.manage',
    'role.assignment.grant',
    'role.assignment.revoke',
  ],
};

export const USER_ADMIN: MeData = {
  ...ADMIN,
  user_id: 'u3',
  capabilities: [
    ...ADMIN.capabilities,
    'user.account.read',
    'user.account.invite',
    'user.account.suspend',
  ],
};

/** Registrar-like: may import students only. */
export const IMPORT_REGISTRAR: MeData = {
  tenant_id: 't1',
  user_id: 'u5',
  actor_kind: 'STAFF',
  display_name: 'Rita Registrar',
  roles: ['REGISTRAR'],
  capabilities: ['session.read', 'session.revoke', 'import.job.manage', 'student.record.create'],
};
/** Organisation administrator: may import students and employees. */
export const IMPORT_ADMIN: MeData = {
  ...IMPORT_REGISTRAR,
  user_id: 'u6',
  display_name: 'Ada Admin',
  roles: ['COLLEGE_ADMIN'],
  capabilities: [...IMPORT_REGISTRAR.capabilities, 'employee.record.create'],
};

export interface StudentRow {
  id: string;
  admissionNumber: string;
  displayName: string;
  status: string;
  tenant: string;
  visible: boolean;
}
function studentRow(
  id: string,
  admissionNumber: string,
  displayName: string,
  status: string,
): StudentRow {
  return { id, admissionNumber, displayName, status, tenant: 't1', visible: true };
}

const STUDENT_STATUS_VALUES = [
  'ADMITTED',
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'DISCONTINUED',
  'GRADUATED',
  'TRANSFERRED_OUT',
];

type Mode = 'ok' | 'invalid' | 'rate' | 'network' | 'server' | 'badjson' | 'badshape';

/** A stand-in for the real backend, implementing the documented contracts including CSRF enforcement. */
export function createFakeBackend(
  init: { me?: MeData; session?: boolean; maxCalls?: number } = {},
) {
  const state = {
    session: init.session ?? false,
    me: init.me ?? STUDENT,
    csrf: 'csrf-0123456789abcdef-token',
    loginMode: 'ok' as Mode,
    meMode: 'ok' as Mode | 'noaccess',
    logoutMode: 'ok' as Mode,
    acceptInviteMode: 'ok' as Mode,
    calls: [] as Call[],
    imports: {
      jobs: new Map<string, Record<string, unknown>>(),
      byKey: new Map<string, string>(),
      /** What the next commit does: succeed, report a changed preview, or report a conflict. */
      commitMode: 'ok' as 'ok' | 'changed' | 'conflict',
    },
    academics: {
      years: [
        {
          id: 'y1',
          label: '2026-27',
          startDate: '2026-06-01',
          endDate: '2027-05-31',
          status: 'PLANNED',
          version: 1,
        },
      ] as Array<Record<string, unknown>>,
      terms: [
        {
          id: 't1',
          campusId: 'camp-1',
          academicYearId: 'y1',
          code: 'ODD',
          name: 'Odd semester',
          startDate: '2026-06-01',
          endDate: '2026-12-31',
          status: 'PLANNED',
          version: 1,
        },
      ] as Array<Record<string, unknown>>,
      courses: [] as Array<Record<string, unknown>>,
      periods: [
        {
          id: 'cp1',
          cohortId: 'co1',
          termId: 't1',
          periodNo: 1,
          isExtension: false,
          status: 'ACTIVE',
          version: 1,
        },
      ] as Array<Record<string, unknown>>,
      sections: [] as Array<Record<string, unknown>>,
      enrollments: {} as Record<string, Array<Record<string, unknown>>>,
      /** Milestone 3 Batch 2 (doc 31): offerings by term, slots and staff-only assignments by offering. */
      offerings: [] as Array<Record<string, unknown>>,
      slots: {} as Record<string, Array<Record<string, unknown>>>,
      assignments: {} as Record<string, Array<Record<string, unknown>>>,
      /** doc 32: staff-only class-teacher rows by section */
      classTeachers: {} as Record<string, Array<Record<string, unknown>>>,
      offeringsMode: 'ok' as 'ok' | 'server',
      /** how GET /academics/terms and GET /students/:id/term-enrollments answer */
      termsMode: 'ok' as 'ok' | 'server',
      enrollmentsMode: 'ok' as 'ok' | 'server',
      /** When set, the next write answers with this status (e.g. 409) and the matching code. */
      failNext: null as null | { status: number; code: string },
      /** doc 33: elective groups by cohort period, registrations, holidays, terminology, setup checklist */
      electiveGroups: {} as Record<string, Array<Record<string, unknown>>>,
      registrations: [] as Array<Record<string, unknown>>,
      holidays: [] as Array<Record<string, unknown>>,
      /** a campus-scoped administrator: organization-wide holiday writes and the checklist answer 403 */
      campusScopedOnly: false,
      terminology: null as null | Record<string, string>,
      terminologyMode: 'ok' as 'ok' | 'server',
      checklist: { complete: false, items: [] as Array<Record<string, unknown>> },
      /** Task 8 (doc 35): the wizard document GET /academics/setup-wizard answers, period types, per-cohort labels */
      wizard: null as null | Record<string, unknown>,
      periodTypes: [] as Array<Record<string, unknown>>,
      byCohort: {} as Record<string, string>,
      /** the stored terminology setting's version (null = no row: If-Match "0") */
      terminologyVersion: null as null | number,
      campusCodes: ['MAIN'] as string[],
    },
    mfa: {
      enrolled: false,
      required: false,
      sessionVerified: false,
      confirmedAt: null as string | null,
      lastUsedAt: null as string | null,
      pendingEnrollment: false,
      unusedRecoveryCodes: 0,
      failChallenge: false,
      failVerify: false,
    },
    /** Role administration (/access): users, roles and assignments of one tenant, with the real routes' error behaviour. */
    access: {
      users: [
        {
          id: 'user-fiona',
          email: 'fiona.faculty@college.test',
          displayName: 'Fiona Faculty',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-10-01T09:00:00.000Z',
        },
        {
          id: 'user-sam',
          email: 'sam.staff@college.test',
          displayName: 'Sam Staff',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-10-02T09:00:00.000Z',
        },
        {
          id: 'user-nobody',
          email: 'nobody@college.test',
          displayName: 'Nobody Yet',
          status: 'ACTIVE',
          version: 1,
          createdAt: '2026-10-03T09:00:00.000Z',
        },
      ] as Array<Record<string, unknown>>,
      pageSize: 50,
      roles: [
        {
          id: 'role-faculty',
          code: 'FACULTY',
          name: 'FACULTY',
          allowedScopeTypes: ['ORGANIZATION', 'CAMPUS', 'DEPARTMENT'],
          permissionCount: 12,
          criticalPermissionCount: 0,
          grantable: true,
        },
        {
          id: 'role-hod',
          code: 'HOD',
          name: 'HOD',
          allowedScopeTypes: ['DEPARTMENT'],
          permissionCount: 20,
          criticalPermissionCount: 0,
          grantable: true,
        },
        {
          id: 'role-admin',
          code: 'COLLEGE_ADMIN',
          name: 'COLLEGE_ADMIN',
          allowedScopeTypes: ['ORGANIZATION'],
          permissionCount: 60,
          criticalPermissionCount: 6,
          grantable: true,
        },
        {
          id: 'role-student',
          code: 'STUDENT',
          name: 'STUDENT',
          allowedScopeTypes: ['ORGANIZATION'],
          permissionCount: 8,
          criticalPermissionCount: 0,
          grantable: false,
        },
      ] as Array<Record<string, unknown>>,
      assignments: {
        'user-fiona': [
          {
            id: 'asg-1',
            roleId: 'role-faculty',
            roleCode: 'FACULTY',
            scopeType: 'ORGANIZATION',
            scopeId: null,
            scopeName: null,
            state: 'EFFECTIVE',
            validFrom: '2026-10-01T09:00:00.000Z',
            validUntil: '2030-01-01T00:00:00.000Z',
            version: 1,
            createdAt: '2026-10-01T09:00:00.000Z',
          },
          {
            id: 'asg-2',
            roleId: 'role-hod',
            roleCode: 'HOD',
            scopeType: 'DEPARTMENT',
            scopeId: 'dept-1',
            scopeName: 'Computer Science',
            state: 'REVOKED',
            validFrom: '2026-09-01T09:00:00.000Z',
            validUntil: null,
            version: 2,
            createdAt: '2026-09-01T09:00:00.000Z',
          },
        ],
        'user-sam': [
          {
            id: 'asg-3',
            roleId: 'role-admin',
            roleCode: 'COLLEGE_ADMIN',
            scopeType: 'ORGANIZATION',
            scopeId: null,
            scopeName: null,
            state: 'EFFECTIVE',
            validFrom: '2026-09-01T09:00:00.000Z',
            validUntil: null,
            version: 1,
            createdAt: '2026-09-01T09:00:00.000Z',
          },
        ],
      } as Record<string, Array<Record<string, unknown>>>,
      /** how the user list answers: normal, 403 (not an organization-level administrator), 500 */
      listMode: 'ok' as 'ok' | 'forbidden' | 'server',
      /** the next mutation answers with this status and code (then clears) */
      failNext: null as null | { status: number; code: string },
      seq: 100,
    },
    /**
     * Student records (GET /students/directory, /students?admissionNumber=, /students/:id, /students/:id/identifiers),
     * modelling the real routes' authorization and tenant rules: every row carries its tenant, and a row of another tenant
     * or outside the caller's scope (`visible: false`) answers exactly like a missing one (404), never 403.
     */
    students: {
      /** false = server without cursor keys or STUDENT_DIRECTORY_LIST_ENABLED: the path is read as a bad id (400). */
      directoryEnabled: true,
      /** how the directory answers, once per request: normal, 500, 429 with Retry-After, network failure */
      directoryMode: 'ok' as 'ok' | 'server' | 'rate' | 'network' | 'forbidden' | 'badrequest',
      /** the next cursor request answers 400 INVALID_CURSOR (expired / tampered) */
      expireCursor: false,
      pageSize: 2,
      profileMode: 'ok' as 'ok' | 'server' | 'forbidden',
      identifiersMode: 'ok' as 'ok' | 'server',
      timelineMode: 'ok' as 'ok' | 'server' | 'forbidden',
      timelines: {} as Record<string, unknown>,
      records: [
        studentRow('01900000-0000-7000-8000-000000000001', 'ADM-001', 'Asha Rao', 'ACTIVE'),
        studentRow('01900000-0000-7000-8000-000000000002', 'ADM-002', 'Bala Iyer', 'ACTIVE'),
        studentRow('01900000-0000-7000-8000-000000000003', 'ADM-003', 'Chitra Nair', 'ON_LEAVE'),
        // outside the caller's scope: never listed, 404 on read
        {
          ...studentRow(
            '01900000-0000-7000-8000-000000000004',
            'ADM-004',
            'Hidden Scope',
            'ACTIVE',
          ),
          visible: false,
        },
        // another tenant's record: never listed, 404 on read
        {
          ...studentRow(
            '01900000-0000-7000-8000-000000000009',
            'ADM-009',
            'Other Tenant',
            'ACTIVE',
          ),
          tenant: 't2',
        },
      ] as StudentRow[],
      identifiers: {
        '01900000-0000-7000-8000-000000000001': [
          {
            id: 'sid-1',
            studentId: '01900000-0000-7000-8000-000000000001',
            idType: 'UNIVERSITY_PRN',
            value: 'PRN-2026-0001',
            issuer: 'State University',
            validFrom: '2026-06-01',
            validTo: null,
            version: 1,
            createdAt: '2026-06-01T09:00:00.000Z',
            updatedAt: '2026-06-01T09:00:00.000Z',
          },
        ],
      } as Record<string, Array<Record<string, unknown>>>,
    },
    users: {
      inviteDelivery: 'FAILED' as 'SENT' | 'FAILED' | 'NOT_ATTEMPTED',
      failInvite: null as null | { status: number; code: string },
      failSuspend: null as null | { status: number; code: string },
      failReactivate: null as null | { status: number; code: string },
      lastAdminId: 'u3' as string | null,
    },
    /**
     * Models the backend's step-up policy (auth.hook / mfa.service): the session has a strength, and when `enforce` is on
     * the guarded MFA routes refuse with 403 STEP_UP_REQUIRED unless it is high enough (regenerate/disable need
     * PASSWORD_MFA, the first enrollment PASSWORD_REAUTH). POST /auth/step-up grants PASSWORD_REAUTH and never downgrades;
     * POST /auth/mfa/challenge grants PASSWORD_MFA. Off by default, so existing tests are unaffected.
     */
    stepUp: {
      enforce: false,
      strength: 'PASSWORD' as 'PASSWORD' | 'PASSWORD_REAUTH' | 'PASSWORD_MFA',
      passwordFails: false,
      /** how /auth/step-up answers: normal, 500, 429 with Retry-After, or a dead session (401 UNAUTHORIZED). */
      passwordMode: 'ok' as 'ok' | 'server' | 'rate' | 'expired',
      challengeMode: 'ok' as 'ok' | 'server' | 'expired',
      /** the challenge answers 200 but reports only PASSWORD_REAUTH (a weak grant that must not be accepted). */
      weakChallenge: false,
    },
  };

  const STRENGTH_RANK = { PASSWORD: 1, PASSWORD_REAUTH: 2, PASSWORD_MFA: 3 } as const;
  const stepUpRefusal = (needed: 'PASSWORD_REAUTH' | 'PASSWORD_MFA'): Response | null =>
    state.stepUp.enforce && STRENGTH_RANK[state.stepUp.strength] < STRENGTH_RANK[needed]
      ? err(403, 'STEP_UP_REQUIRED')
      : null;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const err = (status: number, code: string, headers: Record<string, string> = {}): Response =>
    json(
      status,
      { error: { code, message: 'server text that must never be shown', requestId: 'req-1' } },
      headers,
    );

  const fetchMock = vi.fn((input: RequestInfo | URL, reqInit?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(handle(url, reqInit));
  });

  const handle = (url: string, reqInit?: RequestInit): Response => {
    if (init.maxCalls !== undefined && state.calls.length >= init.maxCalls) {
      throw new Error(
        `fakeBackend: exceeded call limit (${init.maxCalls}), possible infinite retry loop`,
      );
    }
    const method = (reqInit?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((reqInit?.headers ?? {}) as Record<string, string>))
      headers[k.toLowerCase()] = v;
    // The real wire contract (docs/deployment/frontend.md): `/api/v1/...` is the versioned API, `/api/auth/...` and
    // `/api/me/mfa...` are the unversioned session/MFA routes. Handlers below are keyed by the path without that
    // prefix; anything else (e.g. `/api/academics/...` without `/v1`) is a route the backend does not have.
    const versioned = /^\/api\/v1(\/.*)$/.exec(url)?.[1];
    const unversioned = /^\/api(\/(?:auth\/|me\/mfa(?:[/?]|$)).*)$/.exec(url)?.[1];
    const path =
      versioned !== undefined && !/^\/(?:auth\/|me\/mfa(?:[/?]|$))/.test(versioned)
        ? versioned
        : unversioned;
    if (path === undefined) {
      state.calls.push({
        method,
        path: url,
        headers,
        credentials: reqInit?.credentials,
        body: undefined,
      });
      return json(404, {
        error: { code: 'RESOURCE_NOT_FOUND', message: 'no such route', requestId: 'req-1' },
      });
    }
    state.calls.push({
      method,
      path,
      headers,
      credentials: reqInit?.credentials,
      body: typeof reqInit?.body === 'string' ? (JSON.parse(reqInit.body) as unknown) : undefined,
    });

    if (path === '/auth/login' && method === 'POST') {
      switch (state.loginMode) {
        case 'network':
          throw new TypeError('Failed to fetch');
        case 'invalid':
          return err(401, 'INVALID_CREDENTIALS');
        case 'rate':
          return err(429, 'TOO_MANY_REQUESTS', { 'retry-after': '120' });
        case 'server':
          return err(500, 'INTERNAL_ERROR');
        case 'badjson':
          return new Response('<html>oops</html>', { status: 200 });
        case 'badshape':
          return json(200, { success: true });
        case 'ok':
          state.session = true;
          return json(200, {
            success: true,
            tenant_id: state.me.tenant_id,
            csrf_token: state.csrf,
          });
      }
    }
    if (path === '/auth/me' && method === 'GET') {
      if (state.meMode === 'network') throw new TypeError('Failed to fetch');
      if (state.meMode === 'server') return err(500, 'INTERNAL_ERROR');
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (state.meMode === 'noaccess') return err(403, 'FORBIDDEN');
      return json(200, { ...state.me, csrf_token: state.csrf, extra_unknown_field: 'dropped' });
    }
    if (path === '/auth/logout' && method === 'POST') {
      if (state.logoutMode === 'network') throw new TypeError('Failed to fetch');
      if (state.logoutMode === 'server') return err(500, 'INTERNAL_ERROR');
      state.session = false;
      return json(200, { success: true });
    }
    if (path === '/auth/accept-invite' && method === 'POST') {
      const body = state.calls[state.calls.length - 1]?.body as Record<string, unknown> | undefined;
      const token = body?.['token'];
      const password = body?.['password'];
      switch (state.acceptInviteMode) {
        case 'network':
          throw new TypeError('Failed to fetch');
        case 'invalid':
          return err(400, 'INVALID_INVITATION');
        case 'rate':
          return err(429, 'TOO_MANY_REQUESTS', { 'retry-after': '120' });
        case 'server':
          return err(500, 'INTERNAL_ERROR');
        case 'badjson':
          return new Response('<html>oops</html>', { status: 200 });
        case 'badshape':
          return json(200, { unexpected: true });
        case 'ok':
          if (
            typeof token !== 'string' ||
            !token ||
            typeof password !== 'string' ||
            password.length < 12 ||
            password.length > 128
          ) {
            return err(400, 'INVALID_INVITATION');
          }
          return json(200, { success: true });
      }
    }

    if (path === '/t/mutate' && method !== 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, { success: true });
    }
    // ---- role administration (mirrors backend/src/modules/users routes) ----
    const accessUrl = new URL(path, 'http://x');
    if (accessUrl.pathname === '/users' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (state.access.listMode === 'forbidden') return err(403, 'FORBIDDEN');
      if (state.access.listMode === 'server') return err(500, 'INTERNAL_ERROR');
      const statusParam = accessUrl.searchParams.get('status');
      let filtered = state.access.users;
      if (statusParam && statusParam !== 'ALL') {
        filtered = filtered.filter((u) => u['status'] === statusParam);
      }
      const after = accessUrl.searchParams.get('afterId');
      const start = after ? filtered.findIndex((u) => u['id'] === after) + 1 : 0;
      const requestedLimit = Number(accessUrl.searchParams.get('limit')) || state.access.pageSize;
      const limitParam = Math.min(requestedLimit, state.access.pageSize);
      const page = filtered.slice(start, start + limitParam);
      const more = start + limitParam < filtered.length;
      return json(200, {
        success: true,
        data: page,
        page: { nextAfterId: more ? (page[page.length - 1]?.['id'] ?? null) : null },
      });
    }
    if (accessUrl.pathname === '/users/invite' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      if (state.users?.failInvite) {
        const fail = state.users.failInvite;
        state.users.failInvite = null;
        return err(fail.status, fail.code);
      }
      const body = (
        typeof reqInit?.body === 'string' ? (JSON.parse(reqInit.body) as unknown) : {}
      ) as Record<string, unknown>;
      const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
      if (reason.length < 5) return err(400, 'VALIDATION_ERROR');
      const email = typeof body['email'] === 'string' ? body['email'].trim() : '';
      const existing = state.access.users.find((u) => u['email'] === email);
      if (existing && existing['status'] !== 'INVITED') {
        return err(409, 'CONFLICT');
      }
      const userId = existing ? (existing['id'] as string) : `user-inv-${state.access.seq++}`;
      if (!existing) {
        state.access.users.push({
          id: userId,
          email,
          displayName: body['displayName'] ?? email,
          status: 'INVITED',
          version: 1,
          createdAt: new Date().toISOString(),
        });
      }
      return json(201, {
        success: true,
        data: {
          userId,
          invitationId: `inv-${state.access.seq++}`,
          expiresAt: '2026-11-01T09:00:00.000Z',
          delivery: state.users.inviteDelivery,
        },
      });
    }
    if (accessUrl.pathname === '/roles' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (state.access.listMode === 'forbidden') return err(403, 'FORBIDDEN');
      return json(200, { success: true, data: state.access.roles });
    }
    const assignList = /^\/users\/([^/]+)\/role-assignments$/.exec(accessUrl.pathname);
    if (assignList && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      const id = decodeURIComponent(assignList[1]!);
      if (!state.access.users.some((u) => u['id'] === id)) return err(404, 'NOT_FOUND');
      return json(200, { success: true, data: state.access.assignments[id] ?? [] });
    }
    const accessMutation = (): Response | null => {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      const refused = stepUpRefusal('PASSWORD_MFA');
      if (refused) return refused;
      const fail = state.access.failNext;
      if (fail) {
        state.access.failNext = null;
        return err(fail.status, fail.code);
      }
      return null;
    };
    if (assignList && method === 'POST') {
      const early = accessMutation();
      if (early) return early;
      const userId = decodeURIComponent(assignList[1]!);
      const body = (
        typeof reqInit?.body === 'string' ? (JSON.parse(reqInit.body) as unknown) : {}
      ) as Record<string, unknown>;
      const role = state.access.roles.find((r) => r['id'] === body['roleId']);
      const list = (state.access.assignments[userId] ??= []);
      if (!role) return err(404, 'NOT_FOUND');
      if (
        list.some(
          (a) =>
            a['roleId'] === role['id'] &&
            a['state'] === 'EFFECTIVE' &&
            a['scopeId'] === (body['scopeId'] ?? null),
        )
      ) {
        return err(409, 'CONFLICT');
      }
      const id = `asg-${state.access.seq++}`;
      list.unshift({
        id,
        roleId: role['id'],
        roleCode: role['code'],
        scopeType: body['scopeType'],
        scopeId: body['scopeId'] ?? null,
        scopeName:
          body['scopeId'] === 'dept-1'
            ? 'Computer Science'
            : body['scopeId'] === 'camp-1'
              ? 'Main Campus'
              : null,
        state: 'EFFECTIVE',
        validFrom: '2026-10-25T09:00:00.000Z',
        validUntil: body['validUntil'] ?? null,
        version: 1,
        createdAt: '2026-10-25T09:00:00.000Z',
      });
      return json(201, { success: true, data: { id } });
    }
    const assignOne = /^\/role-assignments\/([^/]+)(\/revoke)?$/.exec(accessUrl.pathname);
    if (assignOne && (method === 'POST' || method === 'PATCH')) {
      const early = accessMutation();
      if (early) return early;
      const target = Object.values(state.access.assignments)
        .flat()
        .find((a) => a['id'] === decodeURIComponent(assignOne[1]!));
      if (!target) return err(404, 'NOT_FOUND');
      const body = (
        typeof reqInit?.body === 'string' ? (JSON.parse(reqInit.body) as unknown) : {}
      ) as Record<string, unknown>;
      if (method === 'POST' && assignOne[2]) {
        target['state'] = 'REVOKED';
        target['version'] = (target['version'] as number) + 1;
        return json(200, { success: true });
      }
      if (method === 'PATCH' && !assignOne[2]) {
        if (headers['if-match'] !== `"${String(target['version'])}"`) return err(409, 'CONFLICT');
        target['validUntil'] = body['validUntil'] ?? null;
        target['version'] = (target['version'] as number) + 1;
        return json(200, {
          success: true,
          data: { id: target['id'], validUntil: target['validUntil'], version: target['version'] },
        });
      }
    }
    const userAction = /^\/users\/([^/]+)\/(suspend|reactivate)$/.exec(accessUrl.pathname);
    if (userAction && method === 'POST') {
      const early = accessMutation();
      if (early) return early;
      const id = decodeURIComponent(userAction[1]!);
      const action = userAction[2]!;
      if (action === 'suspend' && state.session && state.me?.user_id === id) {
        return err(403, 'FORBIDDEN');
      }
      const target = state.access.users.find((u) => u['id'] === id);
      if (!target) return err(404, 'NOT_FOUND');
      if (action === 'suspend' && (state.users?.lastAdminId === id || target['isLastAdmin'])) {
        return err(409, 'LAST_ADMINISTRATOR');
      }
      const ifMatch = headers['if-match'];
      if (ifMatch !== `"${String(target['version'])}"`) {
        return err(409, 'CONFLICT');
      }
      if (action === 'suspend' && target['status'] !== 'ACTIVE') {
        return err(409, 'USER_STATUS_TRANSITION_INVALID');
      }
      if (action === 'reactivate' && target['status'] !== 'SUSPENDED') {
        return err(409, 'USER_STATUS_TRANSITION_INVALID');
      }
      if (action === 'suspend' && state.users?.failSuspend) {
        const fail = state.users.failSuspend;
        state.users.failSuspend = null;
        return err(fail.status, fail.code);
      }
      if (action === 'reactivate' && state.users?.failReactivate) {
        const fail = state.users.failReactivate;
        state.users.failReactivate = null;
        return err(fail.status, fail.code);
      }
      target['status'] = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      target['version'] = (target['version'] as number) + 1;
      return json(200, { success: true, data: target }, { ETag: `"${String(target['version'])}"` });
    }
    const userDetail = /^\/users\/([^/]+)$/.exec(accessUrl.pathname);
    if (userDetail && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (state.access.listMode === 'forbidden') return err(403, 'FORBIDDEN');
      const id = decodeURIComponent(userDetail[1]!);
      if (id !== 'invite') {
        const target = state.access.users.find((u) => u['id'] === id);
        if (!target) return err(404, 'NOT_FOUND');
        return json(
          200,
          { success: true, data: target },
          { ETag: `"${String(target['version'])}"` },
        );
      }
    }
    if (path === '/me/mfa' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, { success: true, data: { ...state.mfa } });
    }
    if (path === '/auth/step-up' && method === 'POST') {
      if (!state.session || state.stepUp.passwordMode === 'expired')
        return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      if (state.stepUp.passwordMode === 'server') return err(500, 'INTERNAL_ERROR');
      if (state.stepUp.passwordMode === 'rate')
        return err(429, 'TOO_MANY_REQUESTS', { 'retry-after': '30' });
      if (state.stepUp.passwordFails) return err(401, 'INVALID_CREDENTIALS');
      if (STRENGTH_RANK[state.stepUp.strength] < STRENGTH_RANK.PASSWORD_REAUTH) {
        state.stepUp.strength = 'PASSWORD_REAUTH';
      }
      return json(200, {
        success: true,
        data: { steppedUp: true, authStrength: state.stepUp.strength, maxAgeSeconds: 600 },
      });
    }
    if (path === '/me/mfa/totp/enroll' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      const refused = stepUpRefusal('PASSWORD_REAUTH');
      if (refused) return refused;
      state.mfa.pendingEnrollment = true;
      return json(201, {
        success: true,
        data: {
          factorId: 'f1',
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Campus:user?secret=JBSWY3DPEHPK3PXP',
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          expiresInSeconds: 900,
        },
      });
    }
    if (path === '/me/mfa/totp/enroll' && method === 'DELETE') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      state.mfa.pendingEnrollment = false;
      return json(200, { success: true });
    }
    if (path === '/me/mfa/totp/verify' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      if (state.mfa.failVerify) return err(401, 'INVALID_CREDENTIALS');
      state.mfa.enrolled = true;
      state.mfa.sessionVerified = true;
      state.mfa.pendingEnrollment = false;
      state.mfa.confirmedAt = '2026-10-20T12:00:00.000Z';
      state.mfa.unusedRecoveryCodes = 10;
      return json(200, {
        success: true,
        data: {
          recoveryCodes: [
            '1111-2222-33',
            '4444-5555-66',
            '7777-8888-99',
            '0000-1111-22',
            '3333-4444-55',
            '6666-7777-88',
            '9999-0000-11',
            '2222-3333-44',
            '5555-6666-77',
            '8888-9999-00',
          ],
          step: { authStrength: 'PASSWORD_MFA' },
        },
      });
    }
    if (path === '/auth/mfa/challenge' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      if (state.stepUp.challengeMode === 'expired') return err(401, 'UNAUTHORIZED');
      if (state.stepUp.challengeMode === 'server') return err(500, 'INTERNAL_ERROR');
      if (state.mfa.failChallenge) return err(401, 'INVALID_CREDENTIALS');
      if (state.stepUp.weakChallenge) {
        return json(200, {
          success: true,
          data: { authStrength: 'PASSWORD_REAUTH', method: 'TOTP' },
        });
      }
      state.mfa.sessionVerified = true;
      state.stepUp.strength = 'PASSWORD_MFA';
      return json(200, {
        success: true,
        data: { authStrength: 'PASSWORD_MFA', method: 'TOTP' },
      });
    }
    if (path === '/me/mfa/recovery-codes/regenerate' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      const refused = stepUpRefusal('PASSWORD_MFA');
      if (refused) return refused;
      state.mfa.unusedRecoveryCodes = 10;
      return json(200, {
        success: true,
        data: {
          recoveryCodes: [
            'aaaa-bbbb-cc',
            'dddd-eeee-ff',
            'gggg-hhhh-ii',
            'jjjj-kkkk-ll',
            'mmmm-nnnn-oo',
            'pppp-qqqq-rr',
            'ssss-tttt-uu',
            'vvvv-wwww-xx',
            'yyyy-zzzz-00',
            '1111-3333-55',
          ],
        },
      });
    }
    if (path === '/me/mfa/totp' && method === 'DELETE') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      const refused = stepUpRefusal('PASSWORD_MFA');
      if (refused) return refused;
      state.mfa.enrolled = false;
      state.mfa.sessionVerified = false;
      state.mfa.confirmedAt = null;
      state.mfa.unusedRecoveryCodes = 0;
      return json(200, { success: true });
    }
    if (path.startsWith('/notifications') && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, {
        data: [
          {
            id: 'notif-1',
            category: 'ANNOUNCEMENT',
            title: 'Campus Orientation',
            body: 'Orientation will be held in Hall A.',
            read_at: null,
            created_at: '2026-10-15T10:00:00Z',
          },
        ],
        pagination: { limit: 20, has_more: false },
      });
    }
    if (path === '/notifications/read-all' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, { count: 1 });
    }
    if (path.startsWith('/notifications/') && path.endsWith('/read') && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, {
        id: 'notif-1',
        category: 'ANNOUNCEMENT',
        title: 'Campus Orientation',
        body: 'Orientation will be held in Hall A.',
        read_at: '2026-10-15T12:00:00Z',
      });
    }
    if (path === '/me/consents' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, {
        data: [
          {
            id: 'consent-1',
            consent_type: 'DATA_PROCESSING',
            policy_version: 'v1.0',
            status: 'GRANTED',
            granted_at: '2026-10-10T08:00:00Z',
          },
        ],
        pagination: { limit: 20, has_more: false },
      });
    }
    if (path.startsWith('/me/consents/') && path.endsWith('/withdraw') && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, {
        success: true,
        data: {
          id: 'consent-1',
          consent_type: 'DATA_PROCESSING',
          policy_version: 'v1.0',
          status: 'WITHDRAWN',
          granted_at: '2026-10-10T08:00:00Z',
          withdrawn_at: '2026-10-15T10:00:00Z',
        },
      });
    }
    if (path === '/organization/settings' && method === 'GET') {
      const a = state.academics;
      return json(200, {
        success: true,
        data: [
          {
            key: 'terminology',
            value: a.terminology,
            isDefault: a.terminologyVersion === null,
            version: a.terminologyVersion,
            updatedAt: null,
          },
        ],
      });
    }
    if (path === '/organization/settings/terminology' && method === 'PUT') {
      const a = state.academics;
      const refused = stepUpRefusal('PASSWORD_MFA');
      if (refused) return refused;
      if (headers['if-match'] !== `"${a.terminologyVersion ?? 0}"`) return err(409, 'CONFLICT');
      if (state.academics.failNext) {
        const f = state.academics.failNext;
        state.academics.failNext = null;
        return err(f.status, f.code);
      }
      const body = (state.calls.at(-1)?.body ?? {}) as { value: Record<string, string> };
      a.terminology = body.value;
      a.terminologyVersion = (a.terminologyVersion ?? 0) + 1;
      return json(200, {
        success: true,
        data: {
          key: 'terminology',
          value: body.value,
          isDefault: false,
          version: a.terminologyVersion,
          updatedAt: null,
        },
      });
    }
    if (path === '/organization/campuses' && method === 'POST') {
      const code = String((state.calls.at(-1)?.body as { code?: string } | undefined)?.code);
      if (state.academics.campusCodes.includes(code)) return err(409, 'CONFLICT');
      state.academics.campusCodes.push(code);
      return json(201, {
        success: true,
        data: { id: `camp-${state.academics.campusCodes.length}` },
      });
    }
    if (path === '/organization/campuses' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, {
        success: true,
        data: [
          {
            id: 'camp-1',
            name: 'Main Campus',
            code: 'MAIN',
            timezone: 'Asia/Kolkata',
            status: 'ACTIVE',
          },
        ],
      });
    }
    if (path === '/organization/departments' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, {
        success: true,
        data: [
          {
            id: 'dept-1',
            campus_id: 'camp-1',
            name: 'Computer Science',
            code: 'CS',
            status: 'ACTIVE',
          },
        ],
      });
    }
    if (/^\/organization\/campuses\/[^/]+\/rooms$/.test(path)) {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (method === 'GET') {
        return json(200, {
          success: true,
          data: [
            {
              id: 'room-1',
              campusId: 'camp-1',
              code: 'LH-101',
              kind: 'Lecture hall',
              name: 'Lecture Hall 1',
              capacity: 60,
            },
            {
              id: 'room-2',
              campusId: 'camp-1',
              code: 'LAB-2',
              kind: 'Lab',
              name: null,
              capacity: null,
            },
          ],
        });
      }
      if (method === 'POST') {
        if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
        return json(201, {
          success: true,
          data: { id: 'room-new-1' },
        });
      }
    }
    const imp =
      /^\/(students|faculty)\/imports(?:\/([^/?]+)(?:\/(validate|rows|commit))?)?(?:\?.*)?$/.exec(
        path,
      );
    if (imp) {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      const kindName = imp[1] as 'students' | 'faculty';
      const jobs = state.imports.jobs;
      const bodyIn =
        typeof reqInit?.body === 'string'
          ? (JSON.parse(reqInit.body) as Record<string, unknown>)
          : {};
      if (method !== 'GET' && headers['x-csrf-token'] !== state.csrf)
        return err(403, 'CSRF_REJECTED');
      const dto = (j: Record<string, unknown>) => ({
        id: j.id,
        type: j.type,
        status: j.status,
        rowCount: (j.rows as unknown[]).length,
        summary: j.summary,
        version: j.version,
        createdAt: '2026-10-22T00:00:00.000Z',
        updatedAt: '2026-10-22T00:00:00.000Z',
        committedAt: j.status === 'COMMITTED' ? '2026-10-22T01:00:00.000Z' : null,
      });
      const evaluate = (j: Record<string, unknown>) => {
        const rows = j.rows as Array<Record<string, unknown>>;
        let errorCount = 0;
        let warningCount = 0;
        for (const r of rows) {
          const raw = r.raw as Record<string, string>;
          const errors: Array<{ code: string; field?: string }> = [];
          const warnings: Array<{ code: string; field?: string }> = [];
          if (!raw.email?.includes('@')) errors.push({ code: 'INVALID_EMAIL', field: 'email' });
          else if (raw.email.startsWith('taken'))
            errors.push({ code: 'ACCOUNT_HAS_STUDENT_RECORD', field: 'email' });
          const date = raw.admissionDate ?? raw.joiningDate ?? '';
          if (date.startsWith('2199'))
            warnings.push({
              code: 'FUTURE_DATE',
              field: raw.admissionDate ? 'admissionDate' : 'joiningDate',
            });
          if (raw.name === 'Possible Duplicate')
            warnings.push({ code: 'POSSIBLE_DUPLICATE_STUDENT' });
          r.errors = errors;
          r.warnings = warnings;
          r.status = errors.length ? 'INVALID' : 'VALID';
          r.normalized = errors.length
            ? null
            : j.type === 'STUDENT_RECORDS'
              ? {
                  action: 'CREATE_STUDENT_RECORD',
                  email: raw.email,
                  admissionNumber: raw.admissionNumber,
                  admissionDate: raw.admissionDate,
                  initialStatus: 'ADMITTED',
                }
              : {
                  action: 'CREATE_EMPLOYEE_RECORD',
                  email: raw.email,
                  employeeCode: raw.employeeCode,
                  employeeType: raw.employeeType,
                  joiningDate: raw.joiningDate,
                  initialStatus: 'ACTIVE',
                };
          errorCount += errors.length;
          warningCount += warnings.length;
        }
        j.summary = {
          validRows: rows.filter((r) => r.status === 'VALID').length,
          invalidRows: rows.filter((r) => r.status === 'INVALID').length,
          rowsWithWarnings: rows.filter((r) => (r.warnings as unknown[]).length > 0).length,
          errorCount,
          warningCount,
        };
        j.status = errorCount === 0 ? 'VALIDATED' : 'DRAFT';
        j.version = (j.version as number) + 1;
      };
      if (!imp[2]) {
        if (method === 'POST') {
          const key = headers['idempotency-key'];
          if (!key) return err(428, 'IDEMPOTENCY_KEY_REQUIRED');
          const existing = state.imports.byKey.get(key);
          if (existing) return json(201, { success: true, data: { id: existing, version: 1 } });
          const id = `job-${jobs.size + 1}`;
          const rows = (bodyIn.rows as Array<Record<string, string>>).map((raw, i) => ({
            rowNo: i + 1,
            status: 'PENDING',
            raw,
            normalized: null,
            errors: [],
            warnings: [],
            recordId: null,
          }));
          jobs.set(id, {
            id,
            type: kindName === 'students' ? 'STUDENT_RECORDS' : 'EMPLOYEE_RECORDS',
            status: 'DRAFT',
            version: 1,
            summary: {},
            rows,
          });
          state.imports.byKey.set(key, id);
          return json(201, { success: true, data: { id, version: 1 } });
        }
      } else {
        const job = jobs.get(imp[2]);
        if (!job) return err(404, 'RESOURCE_NOT_FOUND');
        if (!imp[3] && method === 'GET') return json(200, { success: true, data: dto(job) });
        if (imp[3] === 'validate' && method === 'POST') {
          evaluate(job);
          return json(200, { success: true, data: dto(job) });
        }
        if (imp[3] === 'rows' && method === 'GET') {
          const q = new URL(path, 'http://x').searchParams;
          const after = Number(q.get('afterRowNo') ?? 0);
          const limit = Number(q.get('limit') ?? 100);
          const rows = (job.rows as Array<Record<string, unknown>>).filter(
            (r) => (r.rowNo as number) > after,
          );
          const page = rows.slice(0, limit);
          return json(200, {
            success: true,
            data: page,
            page: {
              nextAfterRowNo: rows.length > limit ? (page[page.length - 1]?.rowNo ?? null) : null,
            },
          });
        }
        if (imp[3] === 'commit' && method === 'POST') {
          if (!headers['idempotency-key']) return err(428, 'IDEMPOTENCY_KEY_REQUIRED');
          if (headers['if-match'] !== `"${job.version as number}"`) return err(409, 'CONFLICT');
          if (job.status !== 'VALIDATED') return err(409, 'IMPORT_JOB_STATE');
          const summary = job.summary as Record<string, number>;
          if ((summary.rowsWithWarnings ?? 0) > 0 && bodyIn.acknowledgeWarnings !== true)
            return err(409, 'IMPORT_WARNINGS_UNACKNOWLEDGED');
          if (state.imports.commitMode === 'changed') {
            state.imports.commitMode = 'ok';
            job.version = (job.version as number) + 1;
            return err(409, 'IMPORT_PREVIEW_CHANGED');
          }
          if (state.imports.commitMode === 'conflict') {
            state.imports.commitMode = 'ok';
            job.status = 'FAILED';
            job.version = (job.version as number) + 1;
            return err(409, 'IMPORT_COMMIT_CONFLICT');
          }
          job.status = 'COMMITTED';
          job.version = (job.version as number) + 1;
          const created = (job.rows as unknown[]).length;
          job.summary = { ...summary, createdRows: created };
          return json(200, {
            success: true,
            data: { id: job.id, status: 'COMMITTED', createdRows: created, version: job.version },
          });
        }
      }
    }
    const studentUrl = new URL(path, 'http://x');
    if (
      method === 'GET' &&
      /^\/students(?:\/[^/]+(?:\/(?:identifiers|timeline))?)?$/.test(studentUrl.pathname) &&
      studentUrl.pathname !== '/students/imports'
    ) {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      const st = state.students;
      const caps = state.me.capabilities;
      // Only rows of the caller's tenant and inside its scope exist for this caller.
      const mine = st.records.filter((r) => r.tenant === state.me.tenant_id && r.visible);
      const entry = (r: StudentRow) => ({
        id: r.id,
        admissionNumber: r.admissionNumber,
        displayName: r.displayName,
        status: r.status,
        hasActiveEnrolment: true,
      });
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const segs = studentUrl.pathname.split('/').filter(Boolean);
      const q = studentUrl.searchParams;

      if (segs[1] === 'directory' && segs.length === 2) {
        // Unregistered route: read as GET /students/:id with a malformed id, before any permission check.
        // Real answer (observed against buildApp): 400 BAD_REQUEST, the same as any schema failure; there is no
        // feature-disabled code.
        if (!st.directoryEnabled) return err(400, 'BAD_REQUEST');
        // Schema validation of the query runs before the permission gate (Fastify), as on the real route.
        const qs = [...q.keys()];
        const lim = q.get('limit');
        const qStatus = q.get('status');
        if (
          st.directoryMode === 'badrequest' ||
          qs.some((k) => !['limit', 'status', 'cursor'].includes(k)) ||
          (lim !== null && !(/^\d+$/.test(lim) && Number(lim) >= 1 && Number(lim) <= 100)) ||
          (qStatus !== null && !STUDENT_STATUS_VALUES.includes(qStatus))
        )
          return err(400, 'BAD_REQUEST');
        if (!caps.includes('student.directory.list')) return err(403, 'FORBIDDEN');
        if (st.directoryMode === 'forbidden') return err(403, 'FORBIDDEN');
        if (st.directoryMode === 'network') throw new TypeError('Failed to fetch');
        if (st.directoryMode === 'server') return err(500, 'INTERNAL_ERROR');
        if (st.directoryMode === 'rate')
          return err(429, 'TOO_MANY_REQUESTS', { 'retry-after': '30' });
        const status = q.get('status');
        const cursor = q.get('cursor');
        let start = 0;
        if (cursor !== null) {
          // The cursor is bound to the user and the status filter, like the real codec.
          const m = /^cur:([^:]+):([^:]*):(\d+)$/.exec(cursor);
          if (st.expireCursor || !m || m[1] !== state.me.user_id || m[2] !== (status ?? ''))
            return err(400, 'INVALID_CURSOR');
          start = Number(m[3]);
        }
        const filtered = mine.filter((r) => !status || r.status === status);
        const page = filtered.slice(start, start + st.pageSize);
        const next = start + st.pageSize;
        return json(200, {
          success: true,
          data: page.map(entry),
          page: {
            nextCursor:
              next < filtered.length ? `cur:${state.me.user_id}:${status ?? ''}:${next}` : null,
          },
        });
      }
      if (segs.length === 1) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(q.get('admissionNumber') ?? ''))
          return err(400, 'BAD_REQUEST');
        if (!caps.includes('student.directory.search')) return err(403, 'FORBIDDEN');
        const found = mine.find((r) => r.admissionNumber === q.get('admissionNumber'));
        return found
          ? json(200, { success: true, data: entry(found) })
          : err(404, 'RESOURCE_NOT_FOUND');
      }
      const id = segs[1] as string;
      if (!UUID.test(id)) return err(400, 'BAD_REQUEST');
      if (segs.length === 2) {
        if (!caps.includes('student.profile.read')) return err(403, 'FORBIDDEN');
        if (st.profileMode === 'forbidden') return err(403, 'FORBIDDEN');
        if (st.profileMode === 'server') return err(500, 'INTERNAL_ERROR');
        const r = mine.find((x) => x.id === id);
        if (!r) return err(404, 'RESOURCE_NOT_FOUND');
        return json(
          200,
          {
            success: true,
            data: {
              id: r.id,
              organizationId: '01900000-0000-7000-8000-0000000000aa',
              userId: '01900000-0000-7000-8000-0000000000bb',
              admissionNumber: r.admissionNumber,
              admissionDate: '2026-06-01',
              status: r.status,
              statusChangedAt: '2026-06-02T10:00:00.000Z',
              version: 1,
              createdAt: '2026-06-01T09:00:00.000Z',
              updatedAt: '2026-06-02T10:00:00.000Z',
            },
          },
          { ETag: '"1"' },
        );
      }
      if (segs[2] === 'timeline') {
        if (!caps.includes('student.profile.read')) return err(403, 'FORBIDDEN');
        if (st.timelineMode === 'forbidden') return err(403, 'FORBIDDEN');
        if (st.timelineMode === 'server') return err(500, 'INTERNAL_ERROR');
        const r = mine.find((x) => x.id === id);
        if (!r) return err(404, 'RESOURCE_NOT_FOUND');
        const today = '2026-11-02';
        const asOf = q.get('asOf') ?? today;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > today) return err(400, 'VALIDATION_ERROR');
        const custom = st.timelines[id] as Record<string, unknown> | undefined;
        if (custom) return json(200, { success: true, data: { ...custom, asOfDate: asOf, today } });
        return json(200, { success: true, data: fakeTimeline(id, r.admissionNumber, asOf, today) });
      }
      if (!caps.includes('student.profile.read_sensitive')) return err(403, 'FORBIDDEN');
      if (st.identifiersMode === 'server') return err(500, 'INTERNAL_ERROR');
      if (!mine.some((x) => x.id === id)) return err(404, 'RESOURCE_NOT_FOUND');
      return json(200, { success: true, data: st.identifiers[id] ?? [] });
    }
    if (path.startsWith('/academics/') || /^\/students\/[^/]+\/term-enrollments/.test(path)) {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      const a = state.academics;
      const reqBody =
        typeof reqInit?.body === 'string'
          ? (JSON.parse(reqInit.body) as Record<string, unknown>)
          : {};
      if (method !== 'GET') {
        if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
        if (a.failNext) {
          const f = a.failNext;
          a.failNext = null;
          return err(f.status, f.code);
        }
      }
      const list = (data: unknown) => json(200, { success: true, data });
      const created = (arr: Array<Record<string, unknown>>, row: Record<string, unknown>) => {
        const id = `${typeof row.kind === 'string' ? row.kind : 'x'}-${arr.length + 1}`;
        arr.push({ ...row, id, version: 1 });
        return json(201, { success: true, data: { id } });
      };
      // ---- doc 33 (Batch 3): the real guard's rules, reduced to what the page can trigger --------------------------
      const ifMatchOk = (row: Record<string, unknown>) =>
        headers['if-match'] === `"${String(row.version)}"`;
      const bump = (row: Record<string, unknown>, patch: Record<string, unknown>) => {
        Object.assign(row, patch, { version: Number(row.version) + 1 });
        return json(200, { success: true, data: row }, { ETag: `"${String(row.version)}"` });
      };
      if (path === '/academics/terminology') {
        if (a.terminologyMode === 'server') return err(500, 'INTERNAL_ERROR');
        const labels = {
          program: 'Programme',
          cohort: 'Batch',
          period: 'Semester',
          section: 'Section',
          term: 'Term',
          course: 'Course',
          ...(a.terminology ?? {}),
        };
        const own = (a.terminology ?? {}) as Record<string, unknown>;
        const pt = (own.periodTypes ?? {}) as Record<string, string>;
        return json(200, {
          success: true,
          data: {
            labels: Object.fromEntries(Object.entries(labels).filter(([k]) => k !== 'periodTypes')),
            customised: Object.keys(own).filter((k) => k !== 'periodTypes'),
            periodTypes: a.periodTypes.map((t) => ({
              ...t,
              label: pt[String(t.code)] ?? labels.period,
              customised: pt[String(t.code)] !== undefined,
            })),
            byCohort: a.byCohort,
          },
        });
      }
      if (path === '/academics/setup-wizard') {
        if (a.campusScopedOnly) return err(403, 'FORBIDDEN');
        return json(200, { success: true, data: a.wizard });
      }
      const act = /^\/academics\/terms\/([^/]+)\/activation$/.exec(path);
      if (act && method === 'POST') {
        const terms = (a.wizard?.terms ?? []) as Array<Record<string, unknown>>;
        const t = terms.find((x) => x.id === act[1]);
        if (!t) return err(404, 'RESOURCE_NOT_FOUND');
        if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
        if (!ifMatchOk(t)) return err(409, 'CONFLICT');
        if (!t.activatable) return err(409, 'SETUP_INCOMPLETE');
        Object.assign(t, { status: 'ACTIVE', activatable: false });
        return bump(t, {});
      }
      if (path === '/academics/setup-checklist') {
        if (a.campusScopedOnly) return err(403, 'FORBIDDEN');
        return json(200, { success: true, data: a.checklist });
      }
      const eg = /^\/academics\/cohort-periods\/([^/]+)\/elective-groups$/.exec(path);
      if (eg) {
        const rows = (a.electiveGroups[eg[1]!] ??= []);
        if (method === 'GET') return list(rows);
        return created(rows, {
          opensAt: null,
          closesAt: null,
          ...reqBody,
          reason: undefined,
          cohortPeriodId: eg[1],
          status: 'PLANNED',
          kind: 'g',
        });
      }
      const egPatch = /^\/academics\/elective-groups\/([^/]+)$/.exec(path);
      if (egPatch && method === 'PATCH') {
        const g = Object.values(a.electiveGroups)
          .flat()
          .find((x) => x.id === egPatch[1]);
        if (!g) return err(404, 'RESOURCE_NOT_FOUND');
        if (!ifMatchOk(g) || g.status === 'CLOSED') return err(409, 'CONFLICT');
        if (reqBody.status === 'CLOSED') {
          const min = Number(reqBody.minSelect ?? g.minSelect);
          const short = Object.values(a.enrollments)
            .flat()
            .filter(
              (e) =>
                e.cohortPeriodId === g.cohortPeriodId &&
                (e.status === 'REGISTERED' || e.status === 'ACTIVE'),
            )
            .some(
              (e) =>
                a.registrations.filter(
                  (r) => r.termEnrollmentId === e.id && r.electiveGroupId === g.id && !r.validTo,
                ).length < min,
            );
          if (short) return err(409, 'CONFLICT');
        }
        const patch = { ...reqBody };
        delete patch.reason;
        return bump(g, patch);
      }
      const regs = /^\/academics\/course-offerings\/([^/]+)\/registrations$/.exec(path);
      if (regs) {
        const o = a.offerings.find((x) => x.id === regs[1]);
        if (!o) return err(404, 'RESOURCE_NOT_FOUND');
        if (method === 'GET')
          return list(a.registrations.filter((r) => r.courseOfferingId === o.id));
        const enrollment = Object.values(a.enrollments)
          .flat()
          .find((e) => e.id === reqBody.termEnrollmentId);
        if (!enrollment) return err(404, 'RESOURCE_NOT_FOUND');
        const live = (r: Record<string, unknown>) => !r.validTo;
        const group = Object.values(a.electiveGroups)
          .flat()
          .find((g) => g.id === o.electiveGroupId);
        if (group) {
          const now = Date.now();
          const inWindow =
            group.status === 'OPEN' &&
            (!group.opensAt || now >= Date.parse(group.opensAt as string)) &&
            (!group.closesAt || now < Date.parse(group.closesAt as string));
          const held = a.registrations.filter(
            (r) =>
              r.termEnrollmentId === enrollment.id && r.electiveGroupId === group.id && live(r),
          ).length;
          if (reqBody.source !== 'ELECTIVE_CHOICE' || !inWindow || held >= Number(group.maxSelect))
            return err(409, 'CONFLICT');
        }
        const taken = a.registrations.filter((r) => r.courseOfferingId === o.id && live(r)).length;
        if (typeof o.capacity === 'number' && taken >= o.capacity) return err(409, 'CONFLICT');
        const id = `r-${a.registrations.length + 1}`;
        a.registrations.push({
          id,
          termEnrollmentId: enrollment.id,
          studentId: enrollment.studentId,
          courseOfferingId: o.id,
          electiveGroupId: o.electiveGroupId ?? null,
          status: reqBody.pendingApproval ? 'PENDING_APPROVAL' : 'REGISTERED',
          validFrom: reqBody.validFrom,
          validTo: null,
          source: reqBody.source,
          registrationKind: 'REGULAR',
          version: 1,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        });
        return json(201, { success: true, data: { id } });
      }
      const enrRegs = /^\/academics\/term-enrollments\/([^/]+)\/course-registrations$/.exec(path);
      if (enrRegs) return list(a.registrations.filter((r) => r.termEnrollmentId === enrRegs[1]));
      const regPatch = /^\/academics\/course-registrations\/([^/]+)$/.exec(path);
      if (regPatch && method === 'PATCH') {
        const r = a.registrations.find((x) => x.id === regPatch[1]);
        if (!r) return err(404, 'RESOURCE_NOT_FOUND');
        if (!ifMatchOk(r) || r.validTo) return err(409, 'CONFLICT');
        return bump(r, { status: reqBody.status, validTo: reqBody.validTo ?? null });
      }
      if (path.startsWith('/academics/holidays')) {
        const lockedOn = (campusId: unknown, date: unknown) =>
          a.terms.some(
            (t) =>
              t.status === 'LOCKED' &&
              (campusId === null || campusId === undefined || t.campusId === campusId) &&
              String(t.startDate) <= String(date) &&
              String(date) <= String(t.endDate),
          );
        if (method === 'GET') {
          const q = new URL(path, 'http://x').searchParams;
          const campus = q.get('campusId');
          return list(
            a.holidays.filter(
              (h) =>
                (!campus || h.campusId === null || h.campusId === campus) &&
                (!q.get('from') || String(h.holidayDate) >= q.get('from')!) &&
                (!q.get('to') || String(h.holidayDate) <= q.get('to')!) &&
                (q.get('includeCancelled') === 'true' || h.status === 'ACTIVE'),
            ),
          );
        }
        const hp = /^\/academics\/holidays\/([^/]+)$/.exec(path);
        if (hp && method === 'PATCH') {
          const h = a.holidays.find((x) => x.id === hp[1]);
          if (!h) return err(404, 'RESOURCE_NOT_FOUND');
          if (h.campusId === null && a.campusScopedOnly) return err(403, 'FORBIDDEN');
          if (!ifMatchOk(h) || h.status === 'CANCELLED' || lockedOn(h.campusId, h.holidayDate))
            return err(409, 'CONFLICT');
          const patch = { ...reqBody };
          delete patch.reason;
          return bump(h, patch);
        }
        const campusId = (reqBody.campusId as string | undefined) ?? null;
        if (campusId === null && a.campusScopedOnly) return err(403, 'FORBIDDEN');
        const dup = a.holidays.some(
          (h) =>
            h.status === 'ACTIVE' &&
            h.campusId === campusId &&
            h.holidayDate === reqBody.holidayDate &&
            String(h.name).toLowerCase() === String(reqBody.name).toLowerCase(),
        );
        if (dup || lockedOn(campusId, reqBody.holidayDate)) return err(409, 'CONFLICT');
        return created(a.holidays, {
          campusId,
          holidayDate: reqBody.holidayDate,
          name: reqBody.name,
          kind: reqBody.kind,
          status: 'ACTIVE',
        });
      }
      if (path === '/academics/academic-years') {
        if (method === 'GET') return list(a.years);
        return created(a.years, { ...reqBody, status: 'PLANNED', kind: 'y' });
      }
      if (path === '/academics/terms') {
        if (method === 'GET' && a.termsMode === 'server') return err(500, 'INTERNAL_ERROR');
        if (method === 'GET') return list(a.terms);
        return created(a.terms, { ...reqBody, status: 'PLANNED', kind: 't' });
      }
      if (path === '/academics/courses') {
        if (method === 'GET') return list(a.courses);
        return created(a.courses, {
          ...reqBody,
          status: 'ACTIVE',
          tracksAttendance: true,
          owningDepartmentId: null,
          kind: 'c',
        });
      }
      if (path === '/academics/cohort-periods') return list(a.periods);
      if (path.startsWith('/academics/course-offerings')) {
        if (method === 'GET') {
          if (a.offeringsMode === 'server') return err(500, 'INTERNAL_ERROR');
          const sub =
            /^\/academics\/course-offerings\/([^/?]+)\/(timetable-slots|faculty-assignments)$/.exec(
              path,
            );
          if (sub) {
            if (!a.offerings.some((o) => o.id === sub[1])) return err(404, 'RESOURCE_NOT_FOUND');
            if (sub[2] === 'timetable-slots') return list(a.slots[sub[1]!] ?? []);
            // staff-only rows (RLS): a student sees an empty list, never an error
            return list(state.me.actor_kind === 'STAFF' ? (a.assignments[sub[1]!] ?? []) : []);
          }
          const termId = new URL(path, 'http://x').searchParams.get('termId');
          return list(a.offerings.filter((o) => !termId || o.termId === termId));
        }
        if (path === '/academics/course-offerings' && method === 'POST') {
          const term = a.terms.find((t) => t.id === reqBody.termId);
          if (!term) return err(404, 'RESOURCE_NOT_FOUND');
          if (term.status === 'LOCKED' || term.status === 'CLOSED') return err(409, 'TERM_LOCKED');
          const course = a.courses.find((c) => c.id === reqBody.courseId);
          const id = `off-${a.offerings.length + 1}`;
          const newOffering = {
            id,
            campusId: term.campusId,
            termId: reqBody.termId,
            courseId: reqBody.courseId,
            cohortPeriodId: reqBody.cohortPeriodId ?? null,
            sectionId: reqBody.sectionId ?? null,
            offeringKind: reqBody.offeringKind ?? 'CORE',
            groupLabel: reqBody.groupLabel ?? null,
            codeSnapshot: course ? String(course.code) : 'CRS',
            titleSnapshot: course ? String(course.title) : 'Course Title',
            creditsSnapshot: course ? `${String(course.credits)}.0` : '3.0',
            tracksAttendance: true,
            registrationPolicy: reqBody.registrationPolicy ?? 'AUTO_FROM_SECTION',
            capacity: typeof reqBody.capacity === 'number' ? reqBody.capacity : null,
            electiveGroupId: reqBody.electiveGroupId ?? null,
            status: 'DRAFT',
            publishedAt: null,
            version: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          };
          a.offerings.push(newOffering);
          return json(201, { success: true, data: { id } });
        }
        const fromSecMatch =
          /^\/academics\/course-offerings\/([^/?]+)\/registrations\/from-section$/.exec(path);
        if (fromSecMatch && method === 'POST') {
          const o = a.offerings.find((x) => x.id === fromSecMatch[1]);
          if (!o) return err(404, 'RESOURCE_NOT_FOUND');
          const term = a.terms.find((t) => t.id === o.termId);
          if (term && (term.status === 'LOCKED' || term.status === 'CLOSED'))
            return err(409, 'TERM_LOCKED');
          if (!o.sectionId) return err(409, 'OFFERING_HAS_NO_SECTION');
          const members = Object.values(a.enrollments)
            .flat()
            .filter(
              (e) =>
                (e.currentSection as { sectionId: string } | null)?.sectionId === o.sectionId &&
                (e.status === 'ACTIVE' || e.status === 'REGISTERED'),
            );
          let createdCount = 0;
          let alreadyRegisteredCount = 0;
          for (const m of members) {
            const live = a.registrations.some(
              (r) => r.courseOfferingId === o.id && r.termEnrollmentId === m.id && !r.validTo,
            );
            if (live) {
              alreadyRegisteredCount++;
            } else {
              const currentLive = a.registrations.filter(
                (r) => r.courseOfferingId === o.id && !r.validTo,
              ).length;
              if (typeof o.capacity === 'number' && currentLive >= o.capacity) {
                return err(409, 'CAPACITY_EXCEEDED');
              }
              const id = `r-${a.registrations.length + 1}`;
              a.registrations.push({
                id,
                termEnrollmentId: m.id,
                studentId: m.studentId,
                courseOfferingId: o.id,
                electiveGroupId: o.electiveGroupId ?? null,
                status: 'REGISTERED',
                validFrom: reqBody.validFrom,
                validTo: null,
                source: 'AUTO_SECTION',
                registrationKind: 'REGULAR',
                version: 1,
                createdAt: '2026-10-01T00:00:00.000Z',
                updatedAt: '2026-10-01T00:00:00.000Z',
              });
              createdCount++;
            }
          }
          return json(200, {
            success: true,
            data: { created: createdCount, alreadyRegistered: alreadyRegisteredCount },
          });
        }
        const faPostMatch = /^\/academics\/course-offerings\/([^/?]+)\/faculty-assignments$/.exec(
          path,
        );
        if (faPostMatch && method === 'POST') {
          const o = a.offerings.find((x) => x.id === faPostMatch[1]);
          if (!o) return err(404, 'RESOURCE_NOT_FOUND');
          const term = a.terms.find((t) => t.id === o.termId);
          if (term && (term.status === 'LOCKED' || term.status === 'CLOSED'))
            return err(409, 'TERM_LOCKED');
          if (
            reqBody.employeeId === 'inactive-emp' ||
            reqBody.employeeId === 'no-posting-emp' ||
            (typeof reqBody.employeeId === 'string' && reqBody.employeeId.includes('unposted'))
          ) {
            return err(409, 'EMPLOYEE_NOT_ELIGIBLE');
          }
          const oId = String(o.id);
          const listFa = (a.assignments[oId] ??= []);
          if (
            reqBody.teachingRole === 'PRIMARY' &&
            listFa.some(
              (fa: Record<string, unknown>) => fa.teachingRole === 'PRIMARY' && !fa.validTo,
            )
          ) {
            return err(409, 'PRIMARY_FACULTY_CONFLICT');
          }
          const id = `fa-${listFa.length + 1}`;
          listFa.push({
            id,
            courseOfferingId: oId,
            employeeId: reqBody.employeeId,
            teachingRole: reqBody.teachingRole,
            validFrom: reqBody.validFrom,
            validTo: reqBody.validTo ?? null,
            version: 1,
          });
          return json(201, { success: true, data: { id } });
        }
        const tsPostMatch = /^\/academics\/course-offerings\/([^/?]+)\/timetable-slots$/.exec(path);
        if (tsPostMatch && method === 'POST') {
          const o = a.offerings.find((x) => x.id === tsPostMatch[1]);
          if (!o) return err(404, 'RESOURCE_NOT_FOUND');
          const term = a.terms.find((t) => t.id === o.termId);
          if (term && (term.status === 'LOCKED' || term.status === 'CLOSED'))
            return err(409, 'TERM_LOCKED');
          const weekday = Number(reqBody.weekday);
          const start = String(reqBody.startTime);
          const end = String(reqBody.endTime);
          const allSlots = Object.values(a.slots).flat();
          const overlap = (s: Record<string, unknown>) =>
            Number(s.weekday) === weekday &&
            !s.effectiveTo &&
            String(s.startTime) < end &&
            start < String(s.endTime);
          if (reqBody.roomId && allSlots.some((s) => s.roomId === reqBody.roomId && overlap(s))) {
            return err(409, 'ROOM_CONFLICT');
          }
          if (
            reqBody.facultyAssignmentId &&
            allSlots.some(
              (s) => s.facultyAssignmentId === reqBody.facultyAssignmentId && overlap(s),
            )
          ) {
            return err(409, 'TEACHER_CONFLICT');
          }
          const oId = String(o.id);
          const listSlots = (a.slots[oId] ??= []);
          const id = `ts-${listSlots.length + 1}`;
          listSlots.push({
            id,
            courseOfferingId: oId,
            roomId: reqBody.roomId ?? null,
            facultyAssignmentId: reqBody.facultyAssignmentId ?? null,
            weekday,
            startTime: start,
            endTime: end,
            effectiveFrom: reqBody.effectiveFrom,
            effectiveTo: reqBody.effectiveTo ?? null,
            version: 1,
          });
          return json(201, { success: true, data: { id } });
        }
        const offPatchMatch = /^\/academics\/course-offerings\/([^/?]+)$/.exec(path);
        if (offPatchMatch && method === 'PATCH') {
          const o = a.offerings.find((x) => x.id === offPatchMatch[1]);
          if (!o) return err(404, 'RESOURCE_NOT_FOUND');
          if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
          if (headers['if-match'] !== `"${String(o.version)}"`) return err(409, 'CONFLICT');
          const term = a.terms.find((t) => t.id === o.termId);
          if (term && (term.status === 'LOCKED' || term.status === 'CLOSED'))
            return err(409, 'TERM_LOCKED');
          if (reqBody.status) {
            // as offering.service.ts: both final states (CLOSED, CANCELLED) require a reason
            if (
              (reqBody.status === 'CANCELLED' || reqBody.status === 'CLOSED') &&
              (typeof reqBody.reason !== 'string' || reqBody.reason.length < 5)
            ) {
              return err(400, 'BAD_REQUEST');
            }
            o.status = reqBody.status;
            if (reqBody.status === 'PUBLISHED') o.publishedAt = '2026-10-01T00:00:00.000Z';
          }
          if ('capacity' in reqBody) {
            o.capacity = typeof reqBody.capacity === 'number' ? reqBody.capacity : null;
          }
          o.version = Number(o.version) + 1;
          return json(200, { success: true, data: o }, { ETag: `"${String(o.version)}"` });
        }
      }
      const faEndMatch = /^\/academics\/faculty-assignments\/([^/?]+)$/.exec(path);
      if (faEndMatch && method === 'PATCH') {
        const row = Object.values(a.assignments)
          .flat()
          .find((r) => r.id === faEndMatch[1]);
        if (!row) return err(404, 'RESOURCE_NOT_FOUND');
        if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
        if (headers['if-match'] !== `"${String(row.version)}"` || row.validTo)
          return err(409, 'CONFLICT');
        row.validTo = reqBody.validTo;
        row.version = Number(row.version) + 1;
        return json(200, { success: true, data: row }, { ETag: `"${String(row.version)}"` });
      }
      const tsEndMatch = /^\/academics\/timetable-slots\/([^/?]+)$/.exec(path);
      if (tsEndMatch && method === 'PATCH') {
        const row = Object.values(a.slots)
          .flat()
          .find((r) => r.id === tsEndMatch[1]);
        if (!row) return err(404, 'RESOURCE_NOT_FOUND');
        if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
        if (headers['if-match'] !== `"${String(row.version)}"` || row.effectiveTo)
          return err(409, 'CONFLICT');
        row.effectiveTo = reqBody.effectiveTo;
        row.version = Number(row.version) + 1;
        return json(200, { success: true, data: row }, { ETag: `"${String(row.version)}"` });
      }
      if (path === '/academics/sections') {
        if (method === 'GET') return list(a.sections);
        return created(a.sections, {
          capacity: null,
          ...reqBody,
          status: 'ACTIVE',
          memberCount: 0,
          kind: 's',
        });
      }
      const patchMatch = /^\/academics\/(academic-years|terms)\/([^/]+)$/.exec(path);
      if (patchMatch && method === 'PATCH') {
        if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
        const arr = patchMatch[1] === 'terms' ? a.terms : a.years;
        const row = arr.find((r) => r.id === patchMatch[2]);
        if (!row) return err(404, 'RESOURCE_NOT_FOUND');
        if (headers['if-match'] !== `"${String(row.version)}"`) return err(409, 'CONFLICT');
        row.status = reqBody.status;
        row.version = Number(row.version) + 1;
        return json(200, { success: true, data: row });
      }
      const ctList = /^\/academics\/sections\/([^/]+)\/class-teachers$/.exec(path);
      if (ctList) {
        if (!a.sections.some((x) => x.id === ctList[1])) return err(404, 'RESOURCE_NOT_FOUND');
        const rows = (a.classTeachers[ctList[1]!] ??= []);
        // staff-only rows (RLS): a student sees an empty list, never an error
        if (method === 'GET') return list(state.me.actor_kind === 'STAFF' ? rows : []);
        if (
          reqBody.classTeacherRole === 'PRIMARY' &&
          rows.some((r) => r.classTeacherRole === 'PRIMARY' && !r.validTo)
        )
          return err(409, 'CONFLICT');
        return created(rows, { ...reqBody, sectionId: ctList[1], validTo: null, kind: 'ct' });
      }
      const ctEnd = /^\/academics\/class-teachers\/([^/]+)$/.exec(path);
      if (ctEnd && method === 'PATCH') {
        if (!headers['if-match']) return err(428, 'PRECONDITION_REQUIRED');
        const row = Object.values(a.classTeachers)
          .flat()
          .find((r) => r.id === ctEnd[1]);
        if (!row) return err(404, 'RESOURCE_NOT_FOUND');
        if (headers['if-match'] !== `"${String(row.version)}"` || row.validTo)
          return err(409, 'CONFLICT');
        row.validTo = reqBody.validTo;
        row.version = Number(row.version) + 1;
        return json(200, { success: true, data: row });
      }
      const rosterMatch = /^\/academics\/sections\/([^/]+)\/members$/.exec(path);
      if (rosterMatch) {
        return list(
          Object.values(a.enrollments)
            .flat()
            .filter(
              (e) =>
                (e.currentSection as { sectionId: string } | null)?.sectionId === rosterMatch[1],
            )
            .map((e) => ({
              termEnrollmentId: e.id,
              studentId: e.studentId,
              validFrom: (e.currentSection as { validFrom: string }).validFrom,
              rollNumber: e.rollNumber ?? null,
            })),
        );
      }
      const enr =
        /^\/students\/([^/]+)\/term-enrollments(?:\/([^/]+)\/(section|progression))?$/.exec(path);
      if (enr) {
        const student = enr[1] as string;
        // a student outside the caller's access is indistinguishable from a missing one
        if (student.startsWith('ffffffff')) return err(404, 'RESOURCE_NOT_FOUND');
        const rows = (a.enrollments[student] ??= []);
        if (!enr[2] && method === 'GET' && a.enrollmentsMode === 'server')
          return err(500, 'INTERNAL_ERROR');
        if (!enr[2] && method === 'GET') return list(rows);
        if (!enr[2] && method === 'POST') {
          if (!headers['idempotency-key']) return err(428, 'IDEMPOTENCY_KEY_REQUIRED');
          const id = `e-${rows.length + 1}`;
          rows.push({
            id,
            studentId: student,
            cohortPeriodId: reqBody.cohortPeriodId,
            termId: 't1',
            periodNo: 1,
            status: 'REGISTERED',
            enrollmentType: 'REGULAR',
            rollNumber: reqBody.rollNumber ?? null,
            currentSection: null,
            version: 1,
          });
          return json(201, { success: true, data: { id } });
        }
        if (enr[3] === 'progression' && method === 'POST') {
          if (!headers['idempotency-key']) return err(428, 'IDEMPOTENCY_KEY_REQUIRED');
          const src = rows.find((r) => r.id === enr[2]);
          if (!src) return err(404, 'RESOURCE_NOT_FOUND');
          const promote = reqBody.decision === 'PROMOTE';
          const ok = promote ? ['ACTIVE'] : ['ACTIVE', 'DETAINED'];
          if (!ok.includes(String(src.status))) return err(409, 'CONFLICT');
          const target = a.periods.find((x) => x.id === reqBody.cohortPeriodId);
          src.status = promote ? 'PROMOTED' : 'COMPLETED';
          src.currentSection = null;
          const id = `e-${rows.length + 1}`;
          rows.push({
            id,
            studentId: student,
            cohortPeriodId: reqBody.cohortPeriodId,
            termId: target?.termId ?? 't2',
            periodNo: target?.periodNo ?? Number(src.periodNo) + (promote ? 1 : 0),
            status: 'REGISTERED',
            enrollmentType: promote ? 'REGULAR' : 'REPEAT',
            rollNumber: null,
            currentSection: null,
            version: 1,
          });
          return json(201, { success: true, data: { id } });
        }
        if (enr[2] && method === 'POST') {
          const row = rows.find((r) => r.id === enr[2]);
          if (!row) return err(404, 'RESOURCE_NOT_FOUND');
          const sec = a.sections.find((s) => s.id === reqBody.sectionId);
          row.currentSection = {
            sectionId: reqBody.sectionId,
            name: sec?.name ?? '?',
            validFrom: reqBody.validFrom,
          };
          return json(200, { success: true, data: row });
        }
      }
    }
    if (path === '/t/missing') return err(404, 'RESOURCE_NOT_FOUND');
    if (path === '/t/forbidden') return err(403, 'FORBIDDEN');
    return err(404, 'RESOURCE_NOT_FOUND');
  };

  return {
    state,
    fetch: fetchMock as unknown as typeof fetch,
    callsTo: (method: string, path: string) =>
      state.calls.filter((c) => c.method === method && c.path === path),
    /** Server-side session end (expiry/revocation) without the client noticing. */
    expireSession: () => {
      state.session = false;
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

/** A school pupil (Grade 5 -> section move -> Grade 6), filtered by `asOf` like the server (doc 34). */
function fakeTimeline(id: string, admissionNumber: string, asOf: string, today: string) {
  const P = { id: '01900000-0000-7000-8000-0000000000a1', name: 'Primary School', code: 'SCH' };
  const T1 = { id: '01900000-0000-7000-8000-0000000000b1', code: 'AY25', name: 'Session 2025-26' };
  const T2 = { id: '01900000-0000-7000-8000-0000000000b2', code: 'AY26', name: 'Session 2026-27' };
  const ev = (
    eventType: string,
    eventDate: string | null,
    description: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `${eventType}:${eventDate ?? 'undated'}`,
    sourceId: '01900000-0000-7000-8000-0000000000e1',
    eventType,
    eventDate,
    temporal: 'HISTORICAL',
    description,
    programme: null,
    cohortName: null,
    term: null,
    periodNo: null,
    periodLabel: null,
    section: null,
    course: null,
    status: null,
    ...extra,
  });
  const g = (term: typeof T1, n: number) => ({
    programme: P,
    cohortName: 'Batch 2019',
    term,
    periodNo: n,
    periodLabel: 'Grade',
  });
  const all = [
    ev('ADMISSION', '2025-04-01', `Admitted (${admissionNumber}).`),
    ev('PROGRAMME_STARTED', '2025-04-01', 'Joined Primary School (Batch 2019) as REGULAR.', {
      programme: P,
      cohortName: 'Batch 2019',
    }),
    ev('TERM_ENROLLED', '2025-04-01', 'Enrolled in Grade 5, Session 2025-26 (REGULAR).', g(T1, 5)),
    ev('SECTION_PLACED', '2025-04-01', 'Placed in section A until 2025-09-30.', {
      ...g(T1, 5),
      section: { id: '01900000-0000-7000-8000-0000000000c1', name: 'A' },
    }),
    ev('SECTION_TRANSFERRED', '2025-10-01', 'Moved to section B.', {
      ...g(T1, 5),
      section: { id: '01900000-0000-7000-8000-0000000000c2', name: 'B' },
    }),
    ev('TERM_ENROLLED', '2026-04-01', 'Enrolled in Grade 6, Session 2026-27 (REGULAR).', g(T2, 6)),
    ev('COURSE_REGISTERED', '2026-04-10', 'Registered for MATH6 Mathematics (REGULAR, MANUAL).', {
      ...g(T2, 6),
      course: {
        offeringId: '01900000-0000-7000-8000-0000000000d1',
        code: 'MATH6',
        title: 'Mathematics',
        credits: '4.0',
      },
      status: 'REGISTERED',
    }),
  ].map((e) => ({
    ...e,
    temporal:
      asOf >= '2026-04-01' && (e.term as { id: string } | null)?.id === T2.id
        ? 'CURRENT'
        : e.temporal,
  }));
  const events = all.filter((e) => e.eventDate! <= asOf);
  const inG6 = asOf >= '2026-04-01';
  const inG5 = asOf >= '2025-04-01' && asOf <= '2026-03-31';
  const admitted = asOf >= '2025-04-01';
  return {
    studentId: id,
    asOfDate: asOf,
    today,
    timezone: 'Asia/Kolkata',
    position: {
      admitted,
      studentStatus: asOf >= '2026-06-02' ? 'ACTIVE' : null,
      programme: admitted
        ? {
            studentProgramId: '01900000-0000-7000-8000-0000000000f1',
            id: P.id,
            name: P.name,
            code: P.code,
            cohortId: '01900000-0000-7000-8000-0000000000f2',
            cohortName: 'Batch 2019',
            entryType: 'REGULAR',
            startDate: '2025-04-01',
            endDate: null,
          }
        : null,
      terms:
        inG5 || inG6
          ? [
              {
                termEnrollmentId: '01900000-0000-7000-8000-0000000000f3',
                term: inG6
                  ? { ...T2, startDate: '2026-04-01', endDate: '2027-03-31' }
                  : { ...T1, startDate: '2025-04-01', endDate: '2026-03-31' },
                periodNo: inG6 ? 6 : 5,
                periodLabel: 'Grade',
                enrollmentType: 'REGULAR',
                recordedStatus: inG6 ? 'ACTIVE' : 'PROMOTED',
                rollNumber: null,
                section: inG6
                  ? null
                  : asOf >= '2025-10-01'
                    ? {
                        id: '01900000-0000-7000-8000-0000000000c2',
                        name: 'B',
                        validFrom: '2025-10-01',
                        validTo: null,
                      }
                    : {
                        id: '01900000-0000-7000-8000-0000000000c1',
                        name: 'A',
                        validFrom: '2025-04-01',
                        validTo: '2025-09-30',
                      },
                registrations:
                  inG6 && asOf >= '2026-04-10'
                    ? [
                        {
                          registrationId: '01900000-0000-7000-8000-0000000000d2',
                          offeringId: '01900000-0000-7000-8000-0000000000d1',
                          code: 'MATH6',
                          title: 'Mathematics',
                          credits: '4.0',
                          registrationKind: 'REGULAR',
                          source: 'MANUAL',
                          validFrom: '2026-04-10',
                          validTo: null,
                          recordedStatus: 'REGISTERED',
                          statusOnDate: 'REGISTERED',
                        },
                      ]
                    : [],
              },
            ]
          : [],
    },
    events,
    undatedOutcomes:
      asOf >= '2025-04-01'
        ? [
            ev(
              'PROMOTED',
              null,
              'Recorded outcome of Grade 5 (Session 2025-26): PROMOTED. The date of this decision is not recorded.',
              {
                ...g(T1, 5),
                temporal: 'UNDATED',
                status: 'PROMOTED',
              },
            ),
          ]
        : [],
    futureEventsExcluded: all.length - events.length,
    limitations: [
      ...(asOf >= '2026-06-02'
        ? []
        : [
            {
              code: 'STATUS_BEFORE_LAST_CHANGE_UNKNOWN',
              message: `Only the latest status change (2026-06-02) is recorded; the status on ${asOf} is unknown.`,
            },
          ]),
      ...(asOf >= '2025-04-01'
        ? [
            {
              code: 'TERM_OUTCOMES_UNDATED',
              message: 'Promotion, detention, completion and withdrawal decisions are not dated.',
            },
          ]
        : []),
    ],
  };
}
