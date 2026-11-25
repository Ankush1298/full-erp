export interface PlatformStats {
  institutions: {
    total: number;
    active: number;
    suspended: number;
    archived: number;
    schools: number;
    colleges: number;
    universities: number;
  };
  subscriptions: {
    active: number;
    trial: number;
    expired: number;
    overdue: number;
  };
  moduleAdoption: Record<string, number>;
  operationalHealth: {
    database: string;
    databaseConnections: number;
    storageDriver: string;
    malwareScanner: string;
    emailDelivery: string;
    serverUptimeSeconds: number;
  };
  securityAlertsCount: number;
  fleetMetrics?:
    | {
        totalStudents: number;
        totalUsers: number;
      }
    | undefined;
  topActivities?:
    | Array<{
        action: string;
        count: number;
      }>
    | undefined;
  recentAuditAlerts: Array<{
    id: string;
    occurredAt: string;
    action: string;
    resourceType: string;
    riskTier: number;
    actorType: string;
    organizationName?: string | undefined;
    reasonText?: string | undefined;
  }>;
}

export interface InstitutionItem {
  id: string;
  name: string;
  slug: string;
  institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  campusesCount: number;
  adminEmail?: string | undefined;
  planName?: string | undefined;
  subscriptionStatus?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleEntitlement {
  key: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  isTrial: boolean;
  startsAt?: string | undefined;
  expiresAt?: string | undefined;
  dependencies: string[];
  targetRoutes: string[];
  requiredCapabilities: string[];
}

export interface SubscriptionConfig {
  planId?: string | undefined;
  planName: string;
  status: 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED';
  billingCycle: 'MONTHLY' | 'ANNUAL' | 'CUSTOM';
  pricingInrPerYear?: number | undefined;
  priceInr?: number | undefined;
  maxStudents: number;
  maxFaculty: number;
  startsAt: string;
  renewsAt?: string | undefined;
  renewalDate?: string | undefined;
  expiresAt?: string | undefined;
  autoRenew?: boolean | undefined;
  features?: string[] | undefined;
  overrides?: Record<string, unknown> | undefined;
}

export interface InstitutionDetail {
  id: string;
  name: string;
  slug: string;
  institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  campuses: Array<{
    id: string;
    name: string;
    code: string;
    status: string;
    timezone: string;
  }>;
  subscription: {
    planId?: string | undefined;
    planName: string;
    billingCycle: string;
    status: string;
    priceInr?: number | undefined;
    pricingInrPerYear?: number | undefined;
    startsAt: string;
    expiresAt?: string | undefined;
    renewsAt?: string | undefined;
    renewalDate?: string | undefined;
    maxStudents: number;
    maxFaculty: number;
    autoRenew?: boolean | undefined;
  };
  entitlements: {
    planBundle: string;
    modules: ModuleEntitlement[];
  };
  settings: Record<string, unknown>;
  roles: Array<{
    id: string;
    code: string;
    name: string;
    isSystem: boolean;
    permissionCount: number;
  }>;
  metrics?:
    | {
        studentsCount: number;
        usersCount: number;
        facultyCount: number;
      }
    | undefined;
  authorities?: Array<unknown> | undefined;
  firstAdminOnboarding?: FirstAdminOnboardingInfo | null | undefined;
}

export interface FirstAdminOnboardingInfo {
  userId: string;
  email: string;
  designation: string;
  accountStatus: string;
  activationStatus: 'ACTIVATED' | 'PENDING_ACTIVATION';
  invitationStatus: 'NONE' | 'PENDING' | 'EXPIRED' | 'REVOKED' | 'ACCEPTED';
  invitationExpiresAt?: string | undefined;
  mfaEnrolled: boolean;
  mfaBootstrapEligible: boolean;
  canIssueInvitation: boolean;
  canRevokeInvitation: boolean;
}

export interface PlatformModuleDefinition {
  key: string;
  name: string;
  category: 'CORE' | 'ACADEMIC' | 'OPERATIONS' | 'FINANCE' | 'SECURITY_AI';
  description: string;
  dependencies: string[];
  targetRoutes: string[];
  requiredCapabilities: string[];
}

export interface PlanBundleDefinition {
  id: string;
  name: string;
  description: string;
  tier: string;
  priceInrAnnual: number;
  maxStudents: number;
  maxFaculty: number;
  includedModules: string[];
}

let inMemoryPlatformToken = 'change_me_platform_dev_token';

export function getPlatformToken(): string {
  return inMemoryPlatformToken;
}

export function setPlatformToken(nextToken: string): void {
  inMemoryPlatformToken = nextToken;
}

type UnknownRecord = Record<string, unknown>;

function isObject(val: unknown): val is UnknownRecord {
  return typeof val === 'object' && val !== null;
}

function asString(val: unknown, fallback = ''): string {
  return typeof val === 'string' ? val : typeof val === 'number' ? String(val) : fallback;
}

function asOptionalString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim().length > 0 ? val : undefined;
}

async function request<T>(path: string, options: RequestInit = {}, raw = false): Promise<T> {
  const token = getPlatformToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('x-platform-token', token);
  }
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const base = ['', 'api'].join('/');
  const fullPath = `${base}${path}`;
  const res = await fetch(fullPath, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let msg = `HTTP error ${res.status}`;
    try {
      const errJson = (await res.json()) as { message?: string };
      if (errJson && typeof errJson.message === 'string') msg = errJson.message;
    } catch {
      // fallback
    }
    throw new Error(msg);
  }

  const json = (await res.json()) as { data?: T } | T;
  if (raw) return json as T;
  if (isObject(json) && 'data' in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

const DEFAULT_BUNDLE_SPECS: Record<
  string,
  { priceInrAnnual: number; maxStudents: number; maxFaculty: number }
> = {
  STARTER_CORE: { priceInrAnnual: 49999, maxStudents: 1000, maxFaculty: 50 },
  ACADEMIC_PLUS: { priceInrAnnual: 240000, maxStudents: 2500, maxFaculty: 150 },
  COMPLETE_ERP: { priceInrAnnual: 149999, maxStudents: 5000, maxFaculty: 250 },
  ENTERPRISE_SUITE: { priceInrAnnual: 960000, maxStudents: 20000, maxFaculty: 1000 },
};

export function normalizePlanBundles(input: unknown): PlanBundleDefinition[] {
  let target = input;
  if (isObject(target) && 'data' in target && !Array.isArray(target)) {
    target = target['data'];
  }

  if (Array.isArray(target)) {
    return target.map((raw) => {
      const item = isObject(raw) ? raw : {};
      const id = asString(item['id'] ?? item['key'] ?? item['tier'], 'CUSTOM');
      const defaults = DEFAULT_BUNDLE_SPECS[id] ?? {
        priceInrAnnual: 99999,
        maxStudents: 1000,
        maxFaculty: 50,
      };
      const rawPrice =
        typeof item['priceInrAnnual'] === 'number'
          ? item['priceInrAnnual']
          : typeof item['priceInr'] === 'number'
            ? item['priceInr']
            : defaults.priceInrAnnual;
      const rawStudents =
        typeof item['maxStudents'] === 'number' ? item['maxStudents'] : defaults.maxStudents;
      const rawFaculty =
        typeof item['maxFaculty'] === 'number' ? item['maxFaculty'] : defaults.maxFaculty;
      const rawModules = Array.isArray(item['includedModules'])
        ? item['includedModules']
        : Array.isArray(item['modules'])
          ? item['modules']
          : [];
      return {
        id,
        name: asString(item['name'], id),
        description: asString(item['description']),
        tier: asString(item['tier'], id),
        priceInrAnnual: rawPrice,
        maxStudents: rawStudents,
        maxFaculty: rawFaculty,
        includedModules: rawModules.map((m) => asString(m)),
      };
    });
  }

  if (isObject(target)) {
    return Object.entries(target).map(([key, rawVal]) => {
      const val = isObject(rawVal) ? rawVal : {};
      const defaults = DEFAULT_BUNDLE_SPECS[key] ?? {
        priceInrAnnual: 99999,
        maxStudents: 1000,
        maxFaculty: 50,
      };
      const rawPrice =
        typeof val['priceInrAnnual'] === 'number'
          ? val['priceInrAnnual']
          : typeof val['priceInr'] === 'number'
            ? val['priceInr']
            : defaults.priceInrAnnual;
      const rawStudents =
        typeof val['maxStudents'] === 'number' ? val['maxStudents'] : defaults.maxStudents;
      const rawFaculty =
        typeof val['maxFaculty'] === 'number' ? val['maxFaculty'] : defaults.maxFaculty;
      const rawModules = Array.isArray(val['modules'])
        ? val['modules']
        : Array.isArray(val['includedModules'])
          ? val['includedModules']
          : [];
      return {
        id: key,
        name: asString(val['name'], key),
        description: asString(val['description']),
        tier: key,
        priceInrAnnual: rawPrice,
        maxStudents: rawStudents,
        maxFaculty: rawFaculty,
        includedModules: rawModules.map((m) => asString(m)),
      };
    });
  }

  return [];
}

export function normalizeInstitutions(input: unknown): InstitutionItem[] {
  let target = input;
  if (isObject(target) && 'data' in target) {
    const inner = target['data'];
    if (Array.isArray(inner)) {
      target = inner;
    }
  }

  if (Array.isArray(target)) {
    return target.map((raw) => {
      const item = isObject(raw) ? raw : {};
      const campusesCount =
        typeof item['campusesCount'] === 'number'
          ? item['campusesCount']
          : typeof item['campuses_count'] === 'number'
            ? item['campuses_count']
            : 0;
      const instType = (item['institutionType'] ?? item['institution_type']) as
        'SCHOOL' | 'COLLEGE' | 'UNIVERSITY' | undefined;
      const status =
        (item['status'] as 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | undefined) ?? 'ACTIVE';
      return {
        id: asString(item['id']),
        name: asString(item['name'], 'Unnamed Institution'),
        slug: asString(item['slug']),
        institutionType: instType ?? 'SCHOOL',
        status,
        campusesCount,
        ...(asOptionalString(item['adminEmail'] ?? item['admin_email'])
          ? { adminEmail: asOptionalString(item['adminEmail'] ?? item['admin_email']) }
          : {}),
        planName: asString(item['planName'] ?? item['plan_name'], 'Standard Plan'),
        subscriptionStatus: asString(
          item['subscriptionStatus'] ?? item['subscription_status'],
          'ACTIVE',
        ),
        createdAt: asString(item['createdAt'] ?? item['created_at'], new Date().toISOString()),
        updatedAt: asString(item['updatedAt'] ?? item['updated_at'], new Date().toISOString()),
      };
    });
  }

  return [];
}

export function normalizeModulesCatalog(input: unknown): PlatformModuleDefinition[] {
  let target = input;
  if (isObject(target) && 'data' in target && !Array.isArray(target)) {
    target = target['data'];
  }

  if (Array.isArray(target)) {
    return target.map((raw) => {
      const m = isObject(raw) ? raw : {};
      const rawDeps = Array.isArray(m['dependencies']) ? m['dependencies'] : [];
      const rawRoutes = Array.isArray(m['targetRoutes'])
        ? m['targetRoutes']
        : Array.isArray(m['target_routes'])
          ? m['target_routes']
          : [];
      const rawCaps = Array.isArray(m['requiredCapabilities'])
        ? m['requiredCapabilities']
        : Array.isArray(m['required_capabilities'])
          ? m['required_capabilities']
          : [];
      return {
        key: asString(m['key']),
        name: asString(m['name'] ?? m['key']),
        category: (m['category'] as PlatformModuleDefinition['category']) || 'CORE',
        description: asString(m['description']),
        dependencies: rawDeps.map((d) => asString(d)),
        targetRoutes: rawRoutes.map((r) => asString(r)),
        requiredCapabilities: rawCaps.map((c) => asString(c)),
      };
    });
  }

  return [];
}

export function normalizeInstitutionDetail(input: unknown): InstitutionDetail {
  let target = input;
  if (isObject(target) && 'data' in target && !('id' in target)) {
    target = target['data'];
  }
  if (!isObject(target)) {
    throw new Error('Invalid institution detail response from Platform API');
  }

  const rawSub = isObject(target['subscription']) ? target['subscription'] : {};
  const rawEnt = isObject(target['entitlements']) ? target['entitlements'] : {};
  const instType = (target['institutionType'] ?? target['institution_type']) as
    'SCHOOL' | 'COLLEGE' | 'UNIVERSITY' | undefined;
  const status = (target['status'] as 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' | undefined) ?? 'ACTIVE';

  const modulesRaw = Array.isArray(rawEnt['modules']) ? rawEnt['modules'] : [];
  const modules: ModuleEntitlement[] = modulesRaw.map((rawM) => {
    const m = isObject(rawM) ? rawM : {};
    const rawDeps = Array.isArray(m['dependencies']) ? m['dependencies'] : [];
    const rawRoutes = Array.isArray(m['targetRoutes']) ? m['targetRoutes'] : [];
    const rawCaps = Array.isArray(m['requiredCapabilities']) ? m['requiredCapabilities'] : [];
    return {
      key: asString(m['key']),
      name: asString(m['name'] ?? m['key']),
      description: asString(m['description']),
      category: (m['category'] as string | undefined) ?? 'CORE',
      enabled: Boolean(m['enabled']),
      isTrial: Boolean(m['isTrial']),
      ...(asOptionalString(m['startsAt']) ? { startsAt: asOptionalString(m['startsAt']) } : {}),
      ...(asOptionalString(m['expiresAt']) ? { expiresAt: asOptionalString(m['expiresAt']) } : {}),
      dependencies: rawDeps.map((d) => asString(d)),
      targetRoutes: rawRoutes.map((r) => asString(r)),
      requiredCapabilities: rawCaps.map((c) => asString(c)),
    };
  });

  const price =
    typeof rawSub['priceInr'] === 'number'
      ? rawSub['priceInr']
      : typeof rawSub['pricingInrPerYear'] === 'number'
        ? rawSub['pricingInrPerYear']
        : 0;

  return {
    id: asString(target['id']),
    name: asString(target['name']),
    slug: asString(target['slug']),
    institutionType: instType ?? 'SCHOOL',
    status,
    createdAt: asString(target['createdAt'] ?? target['created_at'], new Date().toISOString()),
    updatedAt: asString(target['updatedAt'] ?? target['updated_at'], new Date().toISOString()),
    campuses: Array.isArray(target['campuses'])
      ? (target['campuses'] as InstitutionDetail['campuses'])
      : [],
    subscription: {
      planId: asOptionalString(rawSub['planId']),
      planName: asString(rawSub['planName'], 'Standard Institutional Plan'),
      billingCycle:
        (rawSub['billingCycle'] as SubscriptionConfig['billingCycle'] | undefined) ?? 'ANNUAL',
      status: (rawSub['status'] as SubscriptionConfig['status'] | undefined) ?? 'ACTIVE',
      priceInr: price,
      pricingInrPerYear: price,
      startsAt: asString(rawSub['startsAt'], new Date().toISOString()),
      expiresAt: asOptionalString(rawSub['expiresAt']),
      renewsAt: asOptionalString(rawSub['renewsAt'] ?? rawSub['renewalDate']),
      renewalDate: asOptionalString(rawSub['renewalDate'] ?? rawSub['renewsAt']),
      maxStudents: typeof rawSub['maxStudents'] === 'number' ? rawSub['maxStudents'] : 5000,
      maxFaculty: typeof rawSub['maxFaculty'] === 'number' ? rawSub['maxFaculty'] : 250,
      autoRenew: typeof rawSub['autoRenew'] === 'boolean' ? rawSub['autoRenew'] : true,
    },
    entitlements: {
      planBundle: asString(rawEnt['planBundle'], 'COMPLETE_ERP'),
      modules,
    },
    settings: isObject(target['settings']) ? target['settings'] : {},
    roles: Array.isArray(target['roles']) ? (target['roles'] as InstitutionDetail['roles']) : [],
    authorities: Array.isArray(target['authorities'])
      ? (target['authorities'] as InstitutionDetail['authorities'])
      : [],
    ...(isObject(target['metrics'])
      ? { metrics: target['metrics'] as unknown as InstitutionDetail['metrics'] }
      : {}),
    firstAdminOnboarding: isObject(target['firstAdminOnboarding'])
      ? (target['firstAdminOnboarding'] as unknown as FirstAdminOnboardingInfo)
      : null,
  };
}

export function normalizePlatformStats(input: unknown): PlatformStats {
  let target = input;
  if (isObject(target) && 'data' in target && !('institutions' in target)) {
    target = target['data'];
  }
  if (!isObject(target)) {
    throw new Error('Invalid platform stats response from Platform API');
  }

  const rawInst = isObject(target['institutions']) ? target['institutions'] : {};
  const rawSub = isObject(target['subscriptions']) ? target['subscriptions'] : {};
  const rawHealth = isObject(target['operationalHealth']) ? target['operationalHealth'] : {};

  return {
    institutions: {
      total: typeof rawInst['total'] === 'number' ? rawInst['total'] : 0,
      active: typeof rawInst['active'] === 'number' ? rawInst['active'] : 0,
      suspended: typeof rawInst['suspended'] === 'number' ? rawInst['suspended'] : 0,
      archived: typeof rawInst['archived'] === 'number' ? rawInst['archived'] : 0,
      schools: typeof rawInst['schools'] === 'number' ? rawInst['schools'] : 0,
      colleges: typeof rawInst['colleges'] === 'number' ? rawInst['colleges'] : 0,
      universities: typeof rawInst['universities'] === 'number' ? rawInst['universities'] : 0,
    },
    subscriptions: {
      active: typeof rawSub['active'] === 'number' ? rawSub['active'] : 0,
      trial: typeof rawSub['trial'] === 'number' ? rawSub['trial'] : 0,
      expired: typeof rawSub['expired'] === 'number' ? rawSub['expired'] : 0,
      overdue: typeof rawSub['overdue'] === 'number' ? rawSub['overdue'] : 0,
    },
    moduleAdoption: isObject(target['moduleAdoption'])
      ? (target['moduleAdoption'] as Record<string, number>)
      : {},
    operationalHealth: {
      database: asString(rawHealth['database'], 'UNKNOWN'),
      databaseConnections:
        typeof rawHealth['databaseConnections'] === 'number' ? rawHealth['databaseConnections'] : 0,
      storageDriver: asString(rawHealth['storageDriver'], 'UNKNOWN'),
      malwareScanner: asString(rawHealth['malwareScanner'], 'UNKNOWN'),
      emailDelivery: asString(rawHealth['emailDelivery'], 'UNKNOWN'),
      serverUptimeSeconds:
        typeof rawHealth['serverUptimeSeconds'] === 'number' ? rawHealth['serverUptimeSeconds'] : 0,
    },
    securityAlertsCount:
      typeof target['securityAlertsCount'] === 'number' ? target['securityAlertsCount'] : 0,
    ...(isObject(target['fleetMetrics'])
      ? {
          fleetMetrics: {
            totalStudents:
              typeof target['fleetMetrics']['totalStudents'] === 'number'
                ? target['fleetMetrics']['totalStudents']
                : 0,
            totalUsers:
              typeof target['fleetMetrics']['totalUsers'] === 'number'
                ? target['fleetMetrics']['totalUsers']
                : 0,
          },
        }
      : {}),
    topActivities: Array.isArray(target['topActivities'])
      ? (target['topActivities'] as PlatformStats['topActivities'])
      : [],
    recentAuditAlerts: Array.isArray(target['recentAuditAlerts'])
      ? (target['recentAuditAlerts'] as PlatformStats['recentAuditAlerts'])
      : [],
  };
}

export const platformApi = {
  login: async (operatorToken: string) => {
    const response = await request<{
      success: boolean;
      authenticated: boolean;
      session: { id: string; expiresAt: string; role: string };
    }>(
      '/v1/platform/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ operatorToken: operatorToken.trim() }),
      },
      true,
    );
    return response.session;
  },

  getMe: async () => {
    return request<{ role: string; authMethod: string }>('/v1/platform/auth/me');
  },

  logout: async () => {
    setPlatformToken('');
    return request<{ message: string }>('/v1/platform/auth/logout', {
      method: 'POST',
    });
  },

  getStats: () => request<unknown>('/v1/platform/stats').then(normalizePlatformStats),

  getModulesCatalog: () =>
    request<unknown>('/v1/platform/catalog/modules').then(normalizeModulesCatalog),

  getPlanBundles: () => request<unknown>('/v1/platform/catalog/bundles').then(normalizePlanBundles),

  getAuditEvents: (limit = 50) =>
    request<
      Array<{
        id: string;
        occurredAt: string;
        action: string;
        resourceType: string;
        riskTier: number;
        actorType: string;
        organizationName?: string;
        reasonText?: string;
      }>
    >(`/v1/platform/audit?limit=${limit}`).then((res) => (Array.isArray(res) ? res : [])),

  listInstitutions: (params?: {
    search?: string | undefined;
    type?: string | undefined;
    status?: string | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  }) => {
    const q = new URLSearchParams();
    if (params?.search) q.set('search', params.search);
    if (params?.type) q.set('type', params.type);
    if (params?.status) q.set('status', params.status);
    if (params?.page) q.set('page', String(params.page));
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    const queryStr = qs ? `?${qs}` : '';
    return request<unknown>(`/v1/platform/institutions${queryStr}`).then(normalizeInstitutions);
  },

  getInstitutions: (params?: {
    search?: string | undefined;
    type?: string | undefined;
    status?: string | undefined;
    page?: number | undefined;
    limit?: number | undefined;
  }) => {
    return platformApi.listInstitutions(params);
  },

  getInstitution: (id: string) =>
    request<unknown>(`/v1/platform/institutions/${id}`).then(normalizeInstitutionDetail),

  createInstitution: (data: {
    name: string;
    slug: string;
    institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
    adminEmail?: string | undefined;
    adminTitle?: string | undefined;
    initialPlan?: string | undefined;
    branding?: { primaryColor?: string | undefined; logoUrl?: string | undefined } | undefined;
  }) =>
    request<InstitutionItem>('/v1/platform/institutions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateInstitution: (
    id: string,
    data: {
      name?: string;
      institutionType?: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
      status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
      branding?: { primaryColor?: string; logoUrl?: string };
      configuration?: Record<string, unknown>;
    },
  ) =>
    request<InstitutionDetail>(`/v1/platform/institutions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  suspendInstitution: (id: string) =>
    request<{ id: string; status: string }>(`/v1/platform/institutions/${id}/suspend`, {
      method: 'POST',
    }),

  reactivateInstitution: (id: string) =>
    request<{ id: string; status: string }>(`/v1/platform/institutions/${id}/reactivate`, {
      method: 'POST',
    }),

  setEntitlements: (
    id: string,
    data: {
      planBundle?: string | undefined;
      modules: Array<{
        key: string;
        enabled: boolean;
        isTrial?: boolean | undefined;
        expiresAt?: string | undefined;
      }>;
    },
  ) =>
    request<{ planBundle: string; modules: ModuleEntitlement[] }>(
      `/v1/platform/institutions/${id}/entitlements`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      },
    ),

  setSubscription: (
    id: string,
    data: {
      planId?: string | undefined;
      planName?: string | undefined;
      status?: ('ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED') | undefined;
      billingCycle?: ('MONTHLY' | 'ANNUAL' | 'CUSTOM') | undefined;
      priceInr?: number | undefined;
      pricingInrPerYear?: number | undefined;
      maxStudents?: number | undefined;
      maxFaculty?: number | undefined;
      startsAt?: string | undefined;
      expiresAt?: string | undefined;
      renewsAt?: string | undefined;
      renewalDate?: string | undefined;
      autoRenew?: boolean | undefined;
      notes?: string | undefined;
      reason?: string | undefined;
    },
  ) =>
    request<SubscriptionConfig>(`/v1/platform/institutions/${id}/subscription`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  reconcileRoles: (
    id: string,
    data?: {
      dryRun?: boolean;
      force?: boolean;
    },
  ) =>
    request<{
      applied: boolean;
      createdRoles: string[];
      grantedPermissions: number;
      deniedProtected: number;
    }>(`/v1/platform/institutions/${id}/roles/reconcile`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  grantCriticalAuthority: (
    id: string,
    data: {
      authority: string;
      targetUserEmail: string;
      justification: string;
      approvedBy: string;
    },
  ) =>
    request<{
      authority: string;
      grantedTo: string;
      grantedPermissionsCount: number;
    }>(`/v1/platform/institutions/${id}/authorities/grant`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  issueFirstAdminInvitation: (
    id: string,
    data?: {
      ttlHours?: number | undefined;
      reason?: string | undefined;
      sendEmail?: boolean | undefined;
    },
  ) =>
    request<{
      tenantId: string;
      userId: string;
      invitationId: string;
      expiresAt: string;
      reissued: boolean;
      token: string;
      acceptUrl: string;
      emailDelivery: 'SENT' | 'NOT_CONFIGURED' | 'FAILED' | 'SKIPPED';
    }>(`/v1/platform/institutions/${id}/first-admin/invite`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),

  revokeFirstAdminInvitation: (id: string, data?: { reason?: string | undefined }) =>
    request<{ tenantId: string; revoked: number }>(
      `/v1/platform/institutions/${id}/first-admin/invite/revoke`,
      {
        method: 'POST',
        body: JSON.stringify(data || {}),
      },
    ),

  issueFirstAdminMfaTicket: (id: string, data?: { reason?: string | undefined }) =>
    request<{
      tenantId: string;
      userId: string;
      ticketId: string;
      ticket: string;
      expiresAt: string;
    }>(`/v1/platform/institutions/${id}/first-admin/mfa-ticket`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    }),
};
