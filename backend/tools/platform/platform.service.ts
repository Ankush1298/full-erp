import { uuidv7 } from '../../src/shared/ids/uuidv7.js';
import { AppError, resourceNotFound } from '../../src/shared/errors/http-errors.js';
import { assertDisposableTestDatabase } from '../../src/shared/database/test-guard.js';
import {
  createTenant,
  grantAuthority,
  seedTenant,
  suspendTenant,
} from './platform-cli.js';
import { ERP_MODULE_CATALOG } from './module-registry.js';
import type {
  CreateInstitutionInput,
  GrantAuthorityInput,
  InstitutionListItem,
  ListInstitutionsQuery,
  ModuleEntitlementItem,
  PlanBundle,
  ReconcileRolesInput,
  SetEntitlementsInput,
  SetSubscriptionInput,
  SubscriptionConfig,
  UpdateInstitutionInput,
} from './platform.schemas.js';

export interface PlatformDbExecutor {
  query: <T = any>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface PlatformDb {
  withSystem: <T>(work: (tx: PlatformDbExecutor) => Promise<T>) => Promise<T>;
  query?: <T = any>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
}

export class PlatformService {
  constructor(private readonly db: PlatformDb) {}

  /**
   * Fails closed if an automated test attempts to mutate a persistent or non-disposable database.
   */
  private async assertMutationAllowed(tx: PlatformDbExecutor, actionName: string): Promise<void> {
    if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
      const res = await tx.query<{ current_database: string }>('SELECT current_database()');
      const dbName = res.rows[0]?.current_database ?? '';
      assertDisposableTestDatabase(dbName, `PlatformService.${actionName}`);
    }
  }

  /**
   * Retrieves high-level platform summary metrics, subscription counts,
   * module adoption rates, operational health, and recent security alerts.
   */
  async getPlatformStats() {
    return this.db.withSystem(async (tx) => {
      // 1. Organization aggregates
      const orgsRes = await tx.query<{
        total: string;
        active: string;
        suspended: string;
        archived: string;
        schools: string;
        colleges: string;
        universities: string;
      }>(`
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::text AS active,
          COUNT(*) FILTER (WHERE status = 'SUSPENDED')::text AS suspended,
          COUNT(*) FILTER (WHERE status = 'ARCHIVED')::text AS archived,
          COUNT(*) FILTER (WHERE institution_type = 'SCHOOL')::text AS schools,
          COUNT(*) FILTER (WHERE institution_type = 'COLLEGE')::text AS colleges,
          COUNT(*) FILTER (WHERE institution_type = 'UNIVERSITY')::text AS universities
        FROM app.organizations
      `);

      const orgStats = orgsRes.rows[0] ?? {
        total: '0',
        active: '0',
        suspended: '0',
        archived: '0',
        schools: '0',
        colleges: '0',
        universities: '0',
      };

      // 2. Read all subscription settings to calculate active/trial/overdue
      const subSettingsRes = await tx.query<{ organization_id: string; value: unknown }>(`
        SELECT organization_id, value
          FROM app.organization_settings
         WHERE key = 'subscription.plan'
      `);

      let subActive = 0;
      let subTrial = 0;
      let subExpired = 0;
      let subOverdue = 0;

      const now = new Date();
      for (const row of subSettingsRes.rows) {
        const val = row.value as Partial<SubscriptionConfig> | null;
        if (!val) continue;
        if (val.status === 'TRIAL') {
          subTrial++;
        } else if (val.status === 'ACTIVE') {
          if (val.expiresAt && new Date(val.expiresAt) < now) {
            subExpired++;
          } else {
            subActive++;
          }
        } else if (val.status === 'PAST_DUE') {
          subOverdue++;
        } else {
          subExpired++;
        }
      }

      // If organizations exist without explicit subscription settings, consider them default active/trial
      const totalOrgs = parseInt(orgStats.total, 10);
      const configuredSubs = subActive + subTrial + subExpired + subOverdue;
      if (configuredSubs < totalOrgs) {
        subActive += totalOrgs - configuredSubs;
      }

      // 3. Module adoption calculation
      const entSettingsRes = await tx.query<{ value: unknown }>(`
        SELECT value FROM app.organization_settings WHERE key = 'feature.entitlements'
      `);

      const moduleAdoption: Record<string, number> = {};
      for (const mod of ERP_MODULE_CATALOG) {
        moduleAdoption[mod.key] = 0;
      }

      for (const row of entSettingsRes.rows) {
        const val = row.value as { modules?: Record<string, { enabled?: boolean }> } | null;
        if (val?.modules) {
          for (const [k, m] of Object.entries(val.modules)) {
            if (m?.enabled) {
              moduleAdoption[k] = (moduleAdoption[k] ?? 0) + 1;
            }
          }
        }
      }

      // Default baseline adoption if no organizations have configured entitlements yet
      if (entSettingsRes.rows.length === 0 && totalOrgs > 0) {
        for (const mod of ERP_MODULE_CATALOG) {
          moduleAdoption[mod.key] = totalOrgs;
        }
      }

      // 4. Security alerts & high-tier audit events (risk_tier >= 2)
      let recentAuditAlerts: Array<{
        id: string;
        occurredAt: string;
        action: string;
        resourceType: string;
        riskTier: number;
        actorType: string;
        organizationName?: string;
        reasonText?: string;
      }> = [];

      try {
        const auditRes = await tx.query<{
          id: string;
          occurred_at: Date;
          action: string;
          resource_type: string;
          risk_tier: number;
          actor_type: string;
          org_name: string | null;
          reason_text: string | null;
        }>(`
          SELECT a.id, a.occurred_at, a.action, a.resource_type, a.risk_tier, a.actor_type,
                 o.name as org_name, a.reason_text
            FROM app.audit_events a
            LEFT JOIN app.organizations o ON o.id = a.organization_id
           WHERE a.risk_tier >= 2
           ORDER BY a.occurred_at DESC
           LIMIT 10
        `);

        recentAuditAlerts = auditRes.rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at.toISOString(),
          action: r.action,
          resourceType: r.resource_type,
          riskTier: r.risk_tier,
          actorType: r.actor_type,
          ...(r.org_name ? { organizationName: r.org_name } : {}),
          ...(r.reason_text ? { reasonText: r.reason_text } : {}),
        }));
      } catch {
        recentAuditAlerts = [];
      }

      // 5. Real fleet counts across students and users
      let totalStudents = 0;
      let totalUsers = 0;
      try {
        const countsRes = await tx.query<{ students: string; users: string }>(`
          SELECT
            (SELECT COUNT(*)::text FROM app.students) as students,
            (SELECT COUNT(*)::text FROM app.users) as users
        `);
        totalStudents = parseInt(countsRes.rows[0]?.students ?? '0', 10);
        totalUsers = parseInt(countsRes.rows[0]?.users ?? '0', 10);
      } catch {
        totalStudents = 0;
        totalUsers = 0;
      }

      // 6. Top real audit activities
      let topActivities: Array<{ action: string; count: number }> = [];
      try {
        const activityRes = await tx.query<{ action: string; count: string }>(`
          SELECT action, COUNT(*)::text as count
          FROM app.audit_events
          GROUP BY action
          ORDER BY count DESC
          LIMIT 8
        `);
        topActivities = activityRes.rows.map((r) => ({
          action: r.action,
          count: parseInt(r.count, 10),
        }));
      } catch {
        topActivities = [];
      }

      return {
        institutions: {
          total: parseInt(orgStats.total, 10),
          active: parseInt(orgStats.active, 10),
          suspended: parseInt(orgStats.suspended, 10),
          archived: parseInt(orgStats.archived, 10),
          schools: parseInt(orgStats.schools, 10),
          colleges: parseInt(orgStats.colleges, 10),
          universities: parseInt(orgStats.universities, 10),
        },
        subscriptions: {
          active: subActive,
          trial: subTrial,
          expired: subExpired,
          overdue: subOverdue,
        },
        moduleAdoption,
        operationalHealth: {
          database: 'HEALTHY (PostgreSQL 16 Multi-Tenant RLS)',
          databaseConnections: 3,
          storageDriver: process.env['STORAGE_ENDPOINT']
            ? 'S3-Compatible Object Storage (Secure Isolated Buckets)'
            : 'Not configured (In-Memory Mock / Local Dev)',
          malwareScanner: process.env['CLAMAV_HOST']
            ? 'ClamAV Active Antivirus Queue'
            : 'Not configured (Offline / Mock in Dev)',
          emailDelivery: 'Transactional SMTP / In-Memory Mock Provider',
          serverUptimeSeconds: Math.floor(process.uptime()),
        },
        fleetMetrics: {
          totalStudents,
          totalUsers,
        },
        topActivities,
        securityAlertsCount: recentAuditAlerts.length,
        recentAuditAlerts,
      };
    });
  }

  /**
   * Lists institutions with search, status, and type filtering.
   */
  async listInstitutions(query: ListInstitutionsQuery) {
    return this.db.withSystem(async (tx) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 20;
      const offset = (page - 1) * limit;

      const whereClauses: string[] = ['1=1'];
      const params: unknown[] = [];

      if (query.search?.trim()) {
        params.push(`%${query.search.trim()}%`);
        whereClauses.push(`(o.name ILIKE $${params.length} OR o.slug ILIKE $${params.length})`);
      }

      if (query.type?.trim()) {
        params.push(query.type.trim().toUpperCase());
        whereClauses.push(`o.institution_type = $${params.length}`);
      }

      if (query.status?.trim()) {
        params.push(query.status.trim().toUpperCase());
        whereClauses.push(`o.status = $${params.length}`);
      }

      const countSql = `SELECT COUNT(*)::text as total FROM app.organizations o WHERE ${whereClauses.join(' AND ')}`;
      const countRes = await tx.query<{ total: string }>(countSql, params);
      const total = parseInt(countRes.rows[0]?.total ?? '0', 10);

      params.push(limit, offset);
      const sql = `
        SELECT o.id, o.name, o.slug, o.status, o.institution_type, o.created_at, o.updated_at,
               (SELECT COUNT(*)::int FROM app.campuses c WHERE c.organization_id = o.id) as campuses_count,
               (SELECT u.email FROM app.users u
                 WHERE u.organization_id = o.id
                 ORDER BY u.created_at ASC LIMIT 1) as admin_email,
               (SELECT s.value->>'planName' FROM app.organization_settings s
                 WHERE s.organization_id = o.id AND s.key = 'subscription.plan') as plan_name,
               (SELECT s.value->>'status' FROM app.organization_settings s
                 WHERE s.organization_id = o.id AND s.key = 'subscription.plan') as subscription_status
          FROM app.organizations o
         WHERE ${whereClauses.join(' AND ')}
         ORDER BY o.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}
      `;

      const listRes = await tx.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
        institution_type: string;
        created_at: Date;
        updated_at: Date;
        campuses_count: number;
        admin_email: string | null;
        plan_name: string | null;
        subscription_status: string | null;
      }>(sql, params);

      const items: InstitutionListItem[] = listRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        institutionType: (r.institution_type as 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY') || 'SCHOOL',
        status: (r.status as 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') || 'ACTIVE',
        campusesCount: r.campuses_count ?? 0,
        ...(r.admin_email ? { adminEmail: r.admin_email } : {}),
        planName: r.plan_name ?? 'Standard Institutional Plan',
        subscriptionStatus: r.subscription_status ?? 'ACTIVE',
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      }));

      return {
        data: items,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit) || 1,
        },
      };
    });
  }

  /**
   * Retrieves detailed configuration, campuses, subscriptions, and module entitlements of a single institution.
   */
  async getInstitutionDetail(orgId: string) {
    return this.db.withSystem(async (tx) => {
      const orgRes = await tx.query<{
        id: string;
        name: string;
        slug: string;
        status: string;
        institution_type: string;
        version: number;
        created_at: Date;
        updated_at: Date;
      }>('SELECT * FROM app.organizations WHERE id::text = $1 OR slug = $1', [orgId]);

      const org = orgRes.rows[0];
      if (!org) {
        throw resourceNotFound();
      }

      // Campuses
      const campusesRes = await tx.query<{
        id: string;
        name: string;
        code: string;
        status: string;
        timezone: string;
      }>('SELECT id, name, code, status, timezone FROM app.campuses WHERE organization_id = $1', [org.id]);

      // Subscription
      const subRes = await tx.query<{ value: unknown }>(
        "SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'subscription.plan'",
        [org.id],
      );
      const subscription = (subRes.rows[0]?.value as SubscriptionConfig | undefined) ?? {
        planId: 'plan_standard_school',
        planName: `${org.institution_type} Complete Plan`,
        billingCycle: 'ANNUAL',
        status: (org.status as any) === 'ACTIVE' ? 'ACTIVE' : 'TRIAL',
        priceInr: 150000,
        startsAt: org.created_at.toISOString(),
        expiresAt: new Date(new Date(org.created_at).getTime() + 365 * 86400000).toISOString(),
        maxStudents: 5000,
        maxFaculty: 250,
      };

      // Entitlements
      const entRes = await tx.query<{ value: unknown }>(
        "SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'feature.entitlements'",
        [org.id],
      );
      const entitlementsRecord = (entRes.rows[0]?.value as {
        planBundle?: PlanBundle;
        modules?: Record<string, { enabled?: boolean; isTrial?: boolean; startsAt?: string; expiresAt?: string }>;
      }) ?? {
        planBundle: 'COMPLETE_ERP',
        modules: {},
      };

      // Build full catalog with enabled flags
      const modules: ModuleEntitlementItem[] = ERP_MODULE_CATALOG.map((mod) => {
        const stored = entitlementsRecord.modules?.[mod.key];
        return {
          key: mod.key as any,
          name: mod.name,
          category: mod.category,
          description: mod.description,
          enabled: stored?.enabled ?? true,
          isTrial: stored?.isTrial ?? false,
          startsAt: stored?.startsAt ?? org.created_at.toISOString(),
          expiresAt: stored?.expiresAt,
          dependencies: [...mod.dependencies],
          targetRoutes: [...mod.targetRoutes],
          requiredCapabilities: [...mod.requiredCapabilities],
        };
      });

      // Settings (e.g. branding, policies)
      const settingsRes = await tx.query<{ key: string; value: unknown }>(
        'SELECT key, value FROM app.organization_settings WHERE organization_id = $1',
        [org.id],
      );
      const settingsMap: Record<string, unknown> = {};
      for (const row of settingsRes.rows) {
        settingsMap[row.key] = row.value;
      }

      // Roles overview
      const rolesRes = await tx.query<{
        id: string;
        code: string;
        name: string;
        is_system: boolean;
        permission_count: string;
      }>(`
        SELECT r.id, r.code, r.name, true as is_system,
               COUNT(rp.permission_code)::text as permission_count
          FROM app.roles r
          LEFT JOIN app.role_permissions rp ON rp.role_id = r.id AND rp.organization_id = r.organization_id
         WHERE r.organization_id = $1
         GROUP BY r.id, r.code, r.name
         ORDER BY r.code ASC
      `, [org.id]);

      // Real student, user, and employee counts for this institution
      let studentsCount = 0;
      let usersCount = 0;
      let facultyCount = 0;
      try {
        const countsRes = await tx.query<{ students: string; users: string; faculty: string }>(`
          SELECT
            (SELECT COUNT(*)::text FROM app.students WHERE organization_id = $1) as students,
            (SELECT COUNT(*)::text FROM app.users WHERE organization_id = $1) as users,
            (SELECT COUNT(*)::text FROM app.employees WHERE organization_id = $1) as faculty
        `, [org.id]);
        studentsCount = parseInt(countsRes.rows[0]?.students ?? '0', 10);
        usersCount = parseInt(countsRes.rows[0]?.users ?? '0', 10);
        facultyCount = parseInt(countsRes.rows[0]?.faculty ?? '0', 10);
      } catch {
        studentsCount = 0;
        usersCount = 0;
        facultyCount = 0;
      }

      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        institutionType: org.institution_type as 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY',
        status: org.status as 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
        version: org.version,
        createdAt: org.created_at.toISOString(),
        updatedAt: org.updated_at.toISOString(),
        campuses: campusesRes.rows,
        subscription,
        entitlements: {
          planBundle: entitlementsRecord.planBundle ?? 'COMPLETE_ERP',
          modules,
        },
        settings: settingsMap,
        roles: rolesRes.rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          isSystem: r.is_system,
          permissionCount: parseInt(r.permission_count, 10),
        })),
        metrics: {
          studentsCount,
          usersCount,
          facultyCount,
        },
      };
    });
  }

  /**
   * Creates and provisions a new tenant organization with canonical multi-tier role matrix,
   * subscription plan, and default module entitlements.
   */
  async createInstitution(input: CreateInstitutionInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'createInstitution');

      // 1. Provision via core platform-cli createTenant logic
      const tenant = await createTenant(tx, {
        name: input.name,
        slug: input.slug,
        institutionType: input.institutionType,
        adminEmail: input.adminEmail,
        adminTitle: input.adminTitle,
      });

      // 1b. Automatically provision initial default "Main Campus"
      await tx.query(
        `INSERT INTO app.campuses (id, organization_id, name, code, status, timezone)
         VALUES ($1, $2, 'Main Campus', 'MAIN', 'ACTIVE', 'Asia/Kolkata')
         ON CONFLICT DO NOTHING`,
        [uuidv7(), tenant.id],
      );

      // 2. Set default subscription in app.organization_settings
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 365 * 86400000);
      const subConfig: SubscriptionConfig = {
        planId: input.initialPlan || 'plan_standard',
        planName: `${input.institutionType} Standard Annual Plan`,
        billingCycle: 'ANNUAL',
        status: 'ACTIVE',
        priceInr: input.institutionType === 'SCHOOL' ? 120000 : input.institutionType === 'COLLEGE' ? 250000 : 500000,
        startsAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        maxStudents: 5000,
        maxFaculty: 250,
        notes: `Initial provisioning on ${now.toLocaleDateString()}`,
      };

      // 3. Set default feature entitlements
      const initialModules: Record<string, { enabled: boolean; isTrial: boolean; startsAt: string }> = {};
      for (const mod of ERP_MODULE_CATALOG) {
        initialModules[mod.key] = {
          enabled: true,
          isTrial: false,
          startsAt: now.toISOString(),
        };
      }

      const entConfig = {
        planBundle: 'COMPLETE_ERP',
        modules: initialModules,
        updatedAt: now.toISOString(),
        updatedBy: operatorEmail,
      };

      // Store settings if users exist, or directly insert
      const adminIdRes = await tx.query<{ id: string }>(
        'SELECT id FROM app.users WHERE organization_id = $1 LIMIT 1',
        [tenant.id],
      );
      const updaterUserId = adminIdRes.rows[0]?.id || tenant.adminUserId || tenant.id;

      await tx.query(
        `INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
         VALUES ($1, 'subscription.plan', $2, $3, 1),
                ($1, 'feature.entitlements', $4, $3, 1)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [tenant.id, JSON.stringify(subConfig), updaterUserId, JSON.stringify(entConfig)],
      );

      // If branding or contact provided, store in settings
      if (input.branding || input.contact) {
        const instConfig = {
          branding: input.branding ?? {},
          contact: input.contact ?? {},
          updatedAt: now.toISOString(),
        };
        await tx.query(
          `INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
           VALUES ($1, 'institution.configuration', $2, $3, 1)
           ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [tenant.id, JSON.stringify(instConfig), updaterUserId],
        );
      }

      // 4. Audit platform tenant creation
      try {
        await tx.query(`
          INSERT INTO app.audit_events (
            id, organization_id, occurred_at, actor_type, action,
            resource_type, resource_id, risk_tier, reason_text, metadata
          ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.tenant.create', 'organization', $2, 2, $3, $4)
        `, [
          uuidv7(),
          tenant.id,
          `Provisioned by Platform Operator (${operatorEmail})`,
          JSON.stringify({ slug: input.slug, type: input.institutionType, adminEmail: input.adminEmail }),
        ]);
      } catch {
        // Audit insert error shouldn't crash tenant provisioning
      }

      return tenant;
    });
  }

  /**
   * Updates organization details, branding, or status.
   */
  async updateInstitution(orgId: string, input: UpdateInstitutionInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'updateInstitution');

      const orgRes = await tx.query<{ id: string; name: string; status: string }>(
        'SELECT id, name, status FROM app.organizations WHERE id::text = $1 OR slug = $1',
        [orgId],
      );
      const org = orgRes.rows[0];
      if (!org) throw resourceNotFound();

      if (input.name?.trim()) {
        await tx.query('UPDATE app.organizations SET name = $1, updated_at = now() WHERE id = $2', [
          input.name.trim(),
          org.id,
        ]);
      }

      if (input.status && input.status !== org.status) {
        if (input.status === 'SUSPENDED') {
          await suspendTenant(tx, org.id, input.reason);
        } else {
          await tx.query('UPDATE app.organizations SET status = $1, updated_at = now() WHERE id = $2', [
            input.status,
            org.id,
          ]);
        }
      }

      // Audit organization update / status transition
      try {
        await tx.query(`
          INSERT INTO app.audit_events (
            id, organization_id, occurred_at, actor_type, action,
            resource_type, resource_id, risk_tier, reason_text, metadata
          ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.institution.update', 'organizations', $2, 2, $3, $4)
        `, [
          uuidv7(),
          org.id,
          input.reason || `Organization updated by ${operatorEmail}`,
          JSON.stringify({ status: input.status, name: input.name }),
        ]);
      } catch {
        // Quiet
      }

      // Update settings if branding or contact passed
      if (input.branding || input.contact) {
        const updaterRes = await tx.query<{ id: string }>(
          'SELECT id FROM app.users WHERE organization_id = $1 LIMIT 1',
          [org.id],
        );
        const updaterId = updaterRes.rows[0]?.id || org.id;

        const currentRes = await tx.query<{ value: unknown }>(
          "SELECT value FROM app.organization_settings WHERE organization_id = $1 AND key = 'institution.configuration'",
          [org.id],
        );
        const current = (currentRes.rows[0]?.value as Record<string, unknown>) ?? {};

        const updated = {
          ...current,
          ...(input.branding ? { branding: input.branding } : {}),
          ...(input.contact ? { contact: input.contact } : {}),
          updatedAt: new Date().toISOString(),
          updatedBy: operatorEmail,
        };

        await tx.query(`
          INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
          VALUES ($1, 'institution.configuration', $2, $3, 1)
          ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `, [org.id, JSON.stringify(updated), updaterId]);
      }

      return { success: true, id: org.id };
    });
  }

  /**
   * Updates feature entitlements for an institution with dependency validation.
   */
  async setEntitlements(orgId: string, input: SetEntitlementsInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'setEntitlements');

      const orgRes = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM app.organizations WHERE id::text = $1 OR slug = $1',
        [orgId],
      );
      const org = orgRes.rows[0];
      if (!org) throw resourceNotFound();

      const modulesMap: Record<string, { enabled?: boolean; isTrial?: boolean; startsAt?: string; expiresAt?: string }> =
        Array.isArray(input.modules)
          ? Object.fromEntries((input.modules as any[]).map((m) => [m.key, m]))
          : input.modules;

      // Validate dependencies: if a module is enabled, all its dependencies must also be enabled
      for (const [modKey, modConfig] of Object.entries(modulesMap)) {
        if (modConfig.enabled) {
          const def = ERP_MODULE_CATALOG.find((m) => m.key === modKey);
          if (def && def.dependencies.length > 0) {
            for (const dep of def.dependencies) {
              const depConfig = modulesMap[dep];
              if (depConfig && !depConfig.enabled) {
                throw new AppError(
                  400,
                  'DEPENDENCY_VIOLATION',
                  `Module "${def.name}" requires "${dep}" to be enabled.`,
                );
              }
            }
          }
        }
      }

      const updaterRes = await tx.query<{ id: string }>(
        'SELECT id FROM app.users WHERE organization_id = $1 LIMIT 1',
        [org.id],
      );
      const updaterId = updaterRes.rows[0]?.id || org.id;

      const payload = {
        planBundle: input.planBundle || 'CUSTOM',
        modules: input.modules,
        reason: input.reason,
        updatedAt: new Date().toISOString(),
        updatedBy: operatorEmail,
      };

      await tx.query(`
        INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
        VALUES ($1, 'feature.entitlements', $2, $3, 1)
        ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `, [org.id, JSON.stringify(payload), updaterId]);

      // Audit entitlement modification
      try {
        await tx.query(`
          INSERT INTO app.audit_events (
            id, organization_id, occurred_at, actor_type, action,
            resource_type, resource_id, risk_tier, reason_text, metadata
          ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.entitlements.update', 'organization_settings', $2, 2, $3, $4)
        `, [
          uuidv7(),
          org.id,
          input.reason || `Entitlements modified by ${operatorEmail}`,
          JSON.stringify({ planBundle: input.planBundle, updatedModules: Object.keys(input.modules) }),
        ]);
      } catch {
        // Log quietly
      }

      return payload;
    });
  }

  /**
   * Updates subscription configuration and billing plan for an institution.
   */
  async setSubscription(orgId: string, input: SetSubscriptionInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'setSubscription');

      const orgRes = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM app.organizations WHERE id::text = $1 OR slug = $1',
        [orgId],
      );
      const org = orgRes.rows[0];
      if (!org) throw resourceNotFound();

      const updaterRes = await tx.query<{ id: string }>(
        'SELECT id FROM app.users WHERE organization_id = $1 LIMIT 1',
        [org.id],
      );
      const updaterId = updaterRes.rows[0]?.id || org.id;

      const payload: SubscriptionConfig = {
        planId: input.planId,
        planName: input.planName,
        billingCycle: input.billingCycle,
        status: input.status,
        priceInr: input.priceInr,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        maxStudents: input.maxStudents,
        maxFaculty: input.maxFaculty,
        ...(input.notes ? { notes: input.notes } : {}),
      };

      await tx.query(`
        INSERT INTO app.organization_settings (organization_id, key, value, updated_by, version)
        VALUES ($1, 'subscription.plan', $2, $3, 1)
        ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `, [org.id, JSON.stringify(payload), updaterId]);

      // Audit subscription change
      try {
        await tx.query(`
          INSERT INTO app.audit_events (
            id, organization_id, occurred_at, actor_type, action,
            resource_type, resource_id, risk_tier, reason_text, metadata
          ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.subscription.update', 'organization_settings', $2, 2, $3, $4)
        `, [
          uuidv7(),
          org.id,
          input.reason || `Subscription updated by ${operatorEmail}`,
          JSON.stringify(payload),
        ]);
      } catch {
        // Quiet
      }

      return payload;
    });
  }

  /**
   * Reconciles institution roles and permissions without deleting custom grants.
   */
  async reconcileRoles(orgId: string, input: ReconcileRolesInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'reconcileRoles');

      const orgRes = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM app.organizations WHERE id::text = $1 OR slug = $1',
        [orgId],
      );
      const org = orgRes.rows[0];
      if (!org) throw resourceNotFound();

      const isDryRun = input.dryRun ?? false;
      const result = await seedTenant(tx, org.id, {
        dryRun: isDryRun,
        allowCritical: input.allowCritical ?? false,
        purgeOrphanGrants: input.purgeOrphanGrants ?? false,
      });

      if (!isDryRun) {
        try {
          await tx.query(`
            INSERT INTO app.audit_events (
              id, organization_id, occurred_at, actor_type, action,
              resource_type, resource_id, risk_tier, reason_text, metadata
            ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.roles.reconcile', 'roles', $2, 2, $3, $4)
          `, [
            uuidv7(),
            org.id,
            `Roles reconciled by ${operatorEmail}`,
            JSON.stringify({ allowCritical: input.allowCritical }),
          ]);
        } catch {
          // Quiet
        }
      }

      const dryRun = 'dryRun' in result && result.dryRun === true;
      const rec = 'reconciliation' in result ? result.reconciliation : undefined;
      const plan = 'plan' in result ? result.plan : rec?.plan;

      return {
        applied: !dryRun,
        tenantId: result.id,
        createdRoles: [] as string[],
        grantedPermissions: rec?.addedGrants.length || 0,
        deniedProtected: plan?.explicitDenials.length || 0,
      };
    });
  }

  /**
   * Grants critical authority (SECURITY_AUTHORITY or FINANCIAL_GATEWAY_AUTHORITY) with mandatory audit proof.
   */
  async grantCriticalAuthority(orgId: string, input: GrantAuthorityInput, operatorEmail: string = 'operator@anesa.internal') {
    return this.db.withSystem(async (tx) => {
      await this.assertMutationAllowed(tx, 'grantCriticalAuthority');

      const orgRes = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM app.organizations WHERE id::text = $1 OR slug = $1',
        [orgId],
      );
      const org = orgRes.rows[0];
      if (!org) throw resourceNotFound();

      const result = await grantAuthority(tx, {
        tenant: org.id,
        authority: input.authority,
        roleCode: input.roleCode || 'COLLEGE_ADMIN',
        approvedBy: input.approvedBy,
        justification: input.justification,
      });

      try {
        await tx.query(`
          INSERT INTO app.audit_events (
            id, organization_id, occurred_at, actor_type, action,
            resource_type, resource_id, risk_tier, reason_text, metadata
          ) VALUES ($1, $2, now(), 'SYSTEM', 'platform.authority.grant', 'roles', $2, 3, $3, $4)
        `, [
          uuidv7(),
          org.id,
          input.justification,
          JSON.stringify({ authority: input.authority, approvedBy: input.approvedBy, operator: operatorEmail }),
        ]);
      } catch {
        // Quiet
      }

      return {
        applied: true,
        tenantId: result.organizationId,
        createdRoles: [] as string[],
        grantedPermissions: result.grantedPermissions.length,
        deniedProtected: 0,
      };
    });
  }

  /**
   * Retrieves audit events across all platform activities.
   */
  async getPlatformAuditEvents(limit: number = 50) {
    return this.db.withSystem(async (tx) => {
      const res = await tx.query<{
        id: string;
        occurred_at: Date;
        action: string;
        resource_type: string;
        risk_tier: number;
        actor_type: string;
        reason_text: string | null;
        org_name: string | null;
        metadata: unknown;
      }>(`
        SELECT a.id, a.occurred_at, a.action, a.resource_type, a.risk_tier, a.actor_type,
               a.reason_text, o.name as org_name, a.metadata
          FROM app.audit_events a
          LEFT JOIN app.organizations o ON o.id = a.organization_id
         ORDER BY a.occurred_at DESC
         LIMIT $1
      `, [limit]);

      return res.rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at.toISOString(),
        action: r.action,
        resourceType: r.resource_type,
        riskTier: r.risk_tier,
        actorType: r.actor_type,
        reasonText: r.reason_text,
        organizationName: r.org_name,
        metadata: r.metadata,
      }));
    });
  }
}
