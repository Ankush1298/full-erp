import { Type, type Static } from '@sinclair/typebox';

// --- Institution Types & Statuses ---
export const InstitutionTypeSchema = Type.Union([
  Type.Literal('SCHOOL'),
  Type.Literal('COLLEGE'),
  Type.Literal('UNIVERSITY'),
]);
export type InstitutionType = Static<typeof InstitutionTypeSchema>;

export const InstitutionStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('SUSPENDED'),
  Type.Literal('ARCHIVED'),
]);
export type InstitutionStatus = Static<typeof InstitutionStatusSchema>;

// --- Platform Stats / Dashboard ---
export const PlatformStatsResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    institutions: Type.Object({
      total: Type.Number(),
      active: Type.Number(),
      suspended: Type.Number(),
      archived: Type.Number(),
      schools: Type.Number(),
      colleges: Type.Number(),
      universities: Type.Number(),
    }),
    subscriptions: Type.Object({
      active: Type.Number(),
      trial: Type.Number(),
      expired: Type.Number(),
      overdue: Type.Number(),
    }),
    moduleAdoption: Type.Record(Type.String(), Type.Number()),
    operationalHealth: Type.Object({
      database: Type.String(),
      databaseConnections: Type.Number(),
      storageDriver: Type.String(),
      malwareScanner: Type.String(),
      emailDelivery: Type.String(),
      serverUptimeSeconds: Type.Number(),
    }),
    securityAlertsCount: Type.Number(),
    recentAuditAlerts: Type.Array(
      Type.Object({
        id: Type.String(),
        occurredAt: Type.String(),
        action: Type.String(),
        resourceType: Type.String(),
        riskTier: Type.Number(),
        actorType: Type.String(),
        organizationName: Type.Optional(Type.String()),
        reasonText: Type.Optional(Type.String()),
      }),
    ),
  }),
});
export type PlatformStatsResponse = Static<typeof PlatformStatsResponseSchema>;

// --- Institution Management ---
export const ListInstitutionsQuerySchema = Type.Object({
  search: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
});
export type ListInstitutionsQuery = Static<typeof ListInstitutionsQuerySchema>;

export const InstitutionListItemSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  institutionType: InstitutionTypeSchema,
  status: InstitutionStatusSchema,
  campusesCount: Type.Number(),
  adminEmail: Type.Optional(Type.String()),
  planName: Type.Optional(Type.String()),
  subscriptionStatus: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type InstitutionListItem = Static<typeof InstitutionListItemSchema>;

export const ListInstitutionsResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Array(InstitutionListItemSchema),
  pagination: Type.Object({
    page: Type.Number(),
    limit: Type.Number(),
    total: Type.Number(),
    totalPages: Type.Number(),
  }),
});

export const CreateInstitutionInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  slug: Type.String({ minLength: 3, maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' }),
  institutionType: InstitutionTypeSchema,
  adminEmail: Type.Optional(Type.String({ format: 'email' })),
  adminTitle: Type.Optional(Type.String({ maxLength: 100 })),
  initialPlan: Type.Optional(Type.String()),
  branding: Type.Optional(
    Type.Object({
      primaryColor: Type.Optional(Type.String()),
      logoUrl: Type.Optional(Type.String()),
    }),
  ),
  contact: Type.Optional(
    Type.Object({
      email: Type.Optional(Type.String()),
      phone: Type.Optional(Type.String()),
      address: Type.Optional(Type.String()),
    }),
  ),
});
export type CreateInstitutionInput = Static<typeof CreateInstitutionInputSchema>;

export const UpdateInstitutionInputSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  status: Type.Optional(InstitutionStatusSchema),
  branding: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  contact: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});
export type UpdateInstitutionInput = Static<typeof UpdateInstitutionInputSchema>;

// --- Feature Entitlements ---
export const ModuleKeySchema = Type.Union([
  Type.Literal('students'),
  Type.Literal('academics'),
  Type.Literal('attendance'),
  Type.Literal('homework'),
  Type.Literal('examinations'),
  Type.Literal('finance'),
  Type.Literal('parent_portal'),
  Type.Literal('documents'),
  Type.Literal('imports'),
  Type.Literal('reports'),
  Type.Literal('school_vault'),
  Type.Literal('consents'),
  Type.Literal('notifications'),
  Type.Literal('ai_assistant'),
]);
export type ModuleKey = Static<typeof ModuleKeySchema>;

export const ModuleEntitlementItemSchema = Type.Object({
  key: ModuleKeySchema,
  name: Type.String(),
  description: Type.String(),
  category: Type.String(),
  enabled: Type.Boolean(),
  isTrial: Type.Boolean(),
  startsAt: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  dependencies: Type.Array(Type.String()),
  targetRoutes: Type.Array(Type.String()),
  requiredCapabilities: Type.Array(Type.String()),
});
export type ModuleEntitlementItem = Static<typeof ModuleEntitlementItemSchema>;

export const PlanBundleSchema = Type.Union([
  Type.Literal('STARTER_CORE'),
  Type.Literal('ACADEMIC_PLUS'),
  Type.Literal('COMPLETE_ERP'),
  Type.Literal('ENTERPRISE_SUITE'),
  Type.Literal('CUSTOM'),
]);
export type PlanBundle = Static<typeof PlanBundleSchema>;

export const SetEntitlementsInputSchema = Type.Object({
  planBundle: Type.Optional(PlanBundleSchema),
  modules: Type.Record(
    Type.String(),
    Type.Object({
      enabled: Type.Boolean(),
      isTrial: Type.Optional(Type.Boolean()),
      startsAt: Type.Optional(Type.String()),
      expiresAt: Type.Optional(Type.String()),
    }),
  ),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});
export type SetEntitlementsInput = Static<typeof SetEntitlementsInputSchema>;

// --- Subscription Plans & Billing ---
export const BillingCycleSchema = Type.Union([
  Type.Literal('MONTHLY'),
  Type.Literal('QUARTERLY'),
  Type.Literal('ANNUAL'),
  Type.Literal('CUSTOM'),
]);
export type BillingCycle = Static<typeof BillingCycleSchema>;

export const SubscriptionStatusSchema = Type.Union([
  Type.Literal('ACTIVE'),
  Type.Literal('TRIAL'),
  Type.Literal('PAST_DUE'),
  Type.Literal('EXPIRED'),
  Type.Literal('CANCELLED'),
]);
export type SubscriptionStatus = Static<typeof SubscriptionStatusSchema>;

export const SubscriptionConfigSchema = Type.Object({
  planId: Type.String(),
  planName: Type.String(),
  billingCycle: BillingCycleSchema,
  status: SubscriptionStatusSchema,
  priceInr: Type.Number(),
  startsAt: Type.String(),
  expiresAt: Type.String(),
  renewalDate: Type.Optional(Type.String()),
  maxStudents: Type.Number(),
  maxFaculty: Type.Number(),
  notes: Type.Optional(Type.String()),
});
export type SubscriptionConfig = Static<typeof SubscriptionConfigSchema>;

export const SetSubscriptionInputSchema = Type.Object({
  planId: Type.String(),
  planName: Type.String(),
  billingCycle: BillingCycleSchema,
  status: SubscriptionStatusSchema,
  priceInr: Type.Number({ minimum: 0 }),
  startsAt: Type.String(),
  expiresAt: Type.String(),
  maxStudents: Type.Number({ minimum: 1 }),
  maxFaculty: Type.Number({ minimum: 1 }),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});
export type SetSubscriptionInput = Static<typeof SetSubscriptionInputSchema>;

// --- Roles & Authority Delegation ---
export const AuthorityTypeSchema = Type.Union([
  Type.Literal('SECURITY_AUTHORITY'),
  Type.Literal('FINANCIAL_GATEWAY_AUTHORITY'),
]);
export type AuthorityType = Static<typeof AuthorityTypeSchema>;

export const GrantAuthorityInputSchema = Type.Object({
  authority: AuthorityTypeSchema,
  roleCode: Type.Optional(Type.String({ default: 'COLLEGE_ADMIN' })),
  approvedBy: Type.String({ minLength: 1, maxLength: 255 }),
  justification: Type.String({ minLength: 5, maxLength: 1000 }),
});
export type GrantAuthorityInput = Static<typeof GrantAuthorityInputSchema>;

export const ReconcileRolesInputSchema = Type.Object({
  dryRun: Type.Optional(Type.Boolean({ default: true })),
  allowCritical: Type.Optional(Type.Boolean({ default: false })),
  purgeOrphanGrants: Type.Optional(Type.Boolean({ default: false })),
});
export type ReconcileRolesInput = Static<typeof ReconcileRolesInputSchema>;
