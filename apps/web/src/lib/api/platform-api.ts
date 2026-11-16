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
  fleetMetrics?: {
    totalStudents: number;
    totalUsers: number;
  };
  topActivities?: Array<{
    action: string;
    count: number;
  }>;
  recentAuditAlerts: Array<{
    id: string;
    occurredAt: string;
    action: string;
    resourceType: string;
    riskTier: number;
    actorType: string;
    organizationName?: string;
    reasonText?: string;
  }>;
}

export interface InstitutionItem {
  id: string;
  name: string;
  slug: string;
  institutionType: 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  campusesCount: number;
  adminEmail?: string;
  planName?: string;
  subscriptionStatus?: string;
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
  startsAt?: string;
  expiresAt?: string;
  dependencies: string[];
  targetRoutes: string[];
  requiredCapabilities: string[];
}

export interface SubscriptionConfig {
  planName: string;
  status: 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED';
  billingCycle: 'MONTHLY' | 'ANNUAL' | 'CUSTOM';
  pricingInrPerYear: number;
  maxStudents: number;
  maxFaculty: number;
  startsAt: string;
  renewsAt: string;
  autoRenew: boolean;
  features: string[];
  overrides?: Record<string, unknown>;
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
  metrics?: {
    studentsCount: number;
    usersCount: number;
    facultyCount: number;
  };
  authorities?: Array<unknown> | undefined;
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

async function request<T>(path: string, options: RequestInit = {}, raw = false): Promise<T> {
  const token = getPlatformToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('x-platform-token', token);
  }
  headers.set('Content-Type', 'application/json');

  const base = ['', 'api'].join('/');
  const fullPath = `${base}${path}`;
  const res = await fetch(fullPath, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let msg = `HTTP error ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson.message) msg = errJson.message;
    } catch {
      // fallback
    }
    throw new Error(msg);
  }

  const json = await res.json();
  return raw ? json : json.data;
}

const DEFAULT_BUNDLE_SPECS: Record<string, { priceInrAnnual: number; maxStudents: number; maxFaculty: number }> = {
  STARTER_CORE: { priceInrAnnual: 49999, maxStudents: 1000, maxFaculty: 50 },
  ACADEMIC_PLUS: { priceInrAnnual: 240000, maxStudents: 2500, maxFaculty: 150 },
  COMPLETE_ERP: { priceInrAnnual: 149999, maxStudents: 5000, maxFaculty: 250 },
  ENTERPRISE_SUITE: { priceInrAnnual: 960000, maxStudents: 20000, maxFaculty: 1000 },
};

export function normalizePlanBundles(input: unknown): PlanBundleDefinition[] {
  let target = input;
  if (target && typeof target === 'object' && 'data' in target && !Array.isArray(target)) {
    target = (target as { data: unknown }).data;
  }

  if (Array.isArray(target)) {
    return target.map((item: any) => {
      const id = String(item.id || item.key || item.tier || 'CUSTOM');
      const defaults = DEFAULT_BUNDLE_SPECS[id] ?? { priceInrAnnual: 99999, maxStudents: 1000, maxFaculty: 50 };
      return {
        id,
        name: String(item.name || id),
        description: String(item.description || ''),
        tier: String(item.tier || id),
        priceInrAnnual: typeof item.priceInrAnnual === 'number' ? item.priceInrAnnual : (typeof item.priceInr === 'number' ? item.priceInr : defaults.priceInrAnnual),
        maxStudents: typeof item.maxStudents === 'number' ? item.maxStudents : defaults.maxStudents,
        maxFaculty: typeof item.maxFaculty === 'number' ? item.maxFaculty : defaults.maxFaculty,
        includedModules: Array.isArray(item.includedModules)
          ? item.includedModules
          : Array.isArray(item.modules)
          ? item.modules
          : [],
      };
    });
  }

  if (target && typeof target === 'object') {
    return Object.entries(target as Record<string, any>).map(([key, val]) => {
      const defaults = DEFAULT_BUNDLE_SPECS[key] ?? { priceInrAnnual: 99999, maxStudents: 1000, maxFaculty: 50 };
      return {
        id: key,
        name: String(val?.name || key),
        description: String(val?.description || ''),
        tier: key,
        priceInrAnnual: typeof val?.priceInrAnnual === 'number' ? val.priceInrAnnual : (typeof val?.priceInr === 'number' ? val.priceInr : defaults.priceInrAnnual),
        maxStudents: typeof val?.maxStudents === 'number' ? val.maxStudents : defaults.maxStudents,
        maxFaculty: typeof val?.maxFaculty === 'number' ? val.maxFaculty : defaults.maxFaculty,
        includedModules: Array.isArray(val?.modules)
          ? val.modules
          : Array.isArray(val?.includedModules)
          ? val.includedModules
          : [],
      };
    });
  }

  return [];
}

export function normalizeInstitutions(input: unknown): InstitutionItem[] {
  let target = input;
  if (target && typeof target === 'object' && 'data' in target) {
    const inner = (target as { data: unknown }).data;
    if (Array.isArray(inner)) {
      target = inner;
    }
  }

  if (Array.isArray(target)) {
    return target.map((item: any) => ({
      id: String(item.id || ''),
      name: String(item.name || 'Unnamed Institution'),
      slug: String(item.slug || ''),
      institutionType: item.institutionType || item.institution_type || 'SCHOOL',
      status: item.status || 'ACTIVE',
      campusesCount: typeof item.campusesCount === 'number' ? item.campusesCount : (item.campuses_count ?? 0),
      adminEmail: item.adminEmail || item.admin_email,
      planName: item.planName || item.plan_name || 'Standard Plan',
      subscriptionStatus: item.subscriptionStatus || item.subscription_status || 'ACTIVE',
      createdAt: item.createdAt || item.created_at || new Date().toISOString(),
      updatedAt: item.updatedAt || item.updated_at || new Date().toISOString(),
    }));
  }

  return [];
}

export function normalizeModulesCatalog(input: unknown): PlatformModuleDefinition[] {
  let target = input;
  if (target && typeof target === 'object' && 'data' in target && !Array.isArray(target)) {
    target = (target as { data: unknown }).data;
  }

  if (Array.isArray(target)) {
    return target.map((m: any) => ({
      key: String(m.key || ''),
      name: String(m.name || m.key || ''),
      category: m.category || 'CORE',
      description: String(m.description || ''),
      dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
      targetRoutes: Array.isArray(m.targetRoutes) ? m.targetRoutes : (m.target_routes ?? []),
      requiredCapabilities: Array.isArray(m.requiredCapabilities) ? m.requiredCapabilities : (m.required_capabilities ?? []),
    }));
  }

  return [];
}

export function normalizeInstitutionDetail(input: unknown): InstitutionDetail {
  let target: any = input;
  if (target && typeof target === 'object' && 'data' in target && !('id' in target)) {
    target = target.data;
  }
  if (!target || typeof target !== 'object') {
    throw new Error('Invalid institution detail response from Platform API');
  }

  const rawSub = target.subscription || {};
  const rawEnt = target.entitlements || {};
  return {
    id: String(target.id || ''),
    name: String(target.name || ''),
    slug: String(target.slug || ''),
    institutionType: target.institutionType || target.institution_type || 'SCHOOL',
    status: target.status || 'ACTIVE',
    createdAt: target.createdAt || target.created_at || new Date().toISOString(),
    updatedAt: target.updatedAt || target.updated_at || new Date().toISOString(),
    campuses: Array.isArray(target.campuses) ? target.campuses : [],
    subscription: {
      planId: rawSub.planId,
      planName: rawSub.planName || 'Standard Institutional Plan',
      billingCycle: rawSub.billingCycle || 'ANNUAL',
      status: rawSub.status || 'ACTIVE',
      priceInr: rawSub.priceInr ?? rawSub.pricingInrPerYear ?? 0,
      pricingInrPerYear: rawSub.pricingInrPerYear ?? rawSub.priceInr ?? 0,
      startsAt: rawSub.startsAt || new Date().toISOString(),
      expiresAt: rawSub.expiresAt,
      renewsAt: rawSub.renewsAt || rawSub.renewalDate,
      renewalDate: rawSub.renewalDate || rawSub.renewsAt,
      maxStudents: typeof rawSub.maxStudents === 'number' ? rawSub.maxStudents : 5000,
      maxFaculty: typeof rawSub.maxFaculty === 'number' ? rawSub.maxFaculty : 250,
      autoRenew: rawSub.autoRenew ?? true,
    },
    entitlements: {
      planBundle: rawEnt.planBundle || 'COMPLETE_ERP',
      modules: Array.isArray(rawEnt.modules)
        ? rawEnt.modules.map((m: any) => ({
            key: String(m.key || ''),
            name: String(m.name || m.key || ''),
            description: String(m.description || ''),
            category: m.category || 'CORE',
            enabled: Boolean(m.enabled),
            isTrial: Boolean(m.isTrial),
            startsAt: m.startsAt,
            expiresAt: m.expiresAt,
            dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
            targetRoutes: Array.isArray(m.targetRoutes) ? m.targetRoutes : [],
            requiredCapabilities: Array.isArray(m.requiredCapabilities) ? m.requiredCapabilities : [],
          }))
        : [],
    },
    settings: target.settings && typeof target.settings === 'object' ? target.settings : {},
    roles: Array.isArray(target.roles) ? target.roles : [],
    authorities: Array.isArray(target.authorities) ? target.authorities : [],
    metrics: target.metrics,
  };
}

export function normalizePlatformStats(input: unknown): PlatformStats {
  let target: any = input;
  if (target && typeof target === 'object' && 'data' in target && !('institutions' in target)) {
    target = target.data;
  }
  if (!target || typeof target !== 'object') {
    throw new Error('Invalid platform stats response from Platform API');
  }

  return {
    institutions: target.institutions || {
      total: 0,
      active: 0,
      suspended: 0,
      archived: 0,
      schools: 0,
      colleges: 0,
      universities: 0,
    },
    subscriptions: target.subscriptions || {
      active: 0,
      trial: 0,
      expired: 0,
      overdue: 0,
    },
    moduleAdoption: target.moduleAdoption || {},
    operationalHealth: target.operationalHealth || {
      database: 'UNKNOWN',
      databaseConnections: 0,
      storageDriver: 'UNKNOWN',
      malwareScanner: 'UNKNOWN',
      emailDelivery: 'UNKNOWN',
      serverUptimeSeconds: 0,
    },
    securityAlertsCount: typeof target.securityAlertsCount === 'number' ? target.securityAlertsCount : 0,
    fleetMetrics: target.fleetMetrics,
    topActivities: Array.isArray(target.topActivities) ? target.topActivities : [],
    recentAuditAlerts: Array.isArray(target.recentAuditAlerts) ? target.recentAuditAlerts : [],
  };
}

export const platformApi = {
  login: async (operatorToken: string) => {
    const response = await request<{
      success: boolean;
      authenticated: boolean;
      session: { id: string; expiresAt: string; role: string };
    }>('/v1/platform/auth/login', {
      method: 'POST',
      body: JSON.stringify({ operatorToken: operatorToken.trim() }),
    }, true);
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

  getModulesCatalog: () => request<unknown>('/v1/platform/catalog/modules').then(normalizeModulesCatalog),

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
      planId?: string;
      planName?: string;
      status?: 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED';
      billingCycle?: 'MONTHLY' | 'ANNUAL' | 'CUSTOM';
      priceInr?: number;
      pricingInrPerYear?: number;
      maxStudents?: number;
      maxFaculty?: number;
      startsAt?: string;
      expiresAt?: string;
      renewsAt?: string;
      renewalDate?: string;
      autoRenew?: boolean;
      notes?: string;
      reason?: string;
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
};
