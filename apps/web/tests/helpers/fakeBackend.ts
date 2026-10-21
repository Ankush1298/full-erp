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
    calls: [] as Call[],
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
  };

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
    const path = url.replace(/^\/api/, '');
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
    if (path === '/t/mutate' && method !== 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
      return json(200, { success: true });
    }
    if (path === '/me/mfa' && method === 'GET') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      return json(200, { success: true, data: { ...state.mfa } });
    }
    if (path === '/me/mfa/totp/enroll' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
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
      if (state.mfa.failChallenge) return err(401, 'INVALID_CREDENTIALS');
      state.mfa.sessionVerified = true;
      return json(200, {
        success: true,
        data: { authStrength: 'PASSWORD_MFA', method: 'TOTP' },
      });
    }
    if (path === '/me/mfa/recovery-codes/regenerate' && method === 'POST') {
      if (!state.session) return err(401, 'UNAUTHORIZED');
      if (headers['x-csrf-token'] !== state.csrf) return err(403, 'CSRF_REJECTED');
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
