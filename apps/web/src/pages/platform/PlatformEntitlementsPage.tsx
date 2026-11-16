import React, { useEffect, useState } from 'react';
import {
  platformApi,
  type InstitutionItem,
  type InstitutionDetail,
  type PlatformModuleDefinition,
} from '../../lib/api/platform-api';

function getModuleIcon(key: string): React.ReactNode {
  switch (key) {
    case 'students':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case 'academics':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
      );
    case 'attendance':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
          <line x1="16" x2="16" y1="2" y2="6" />
          <line x1="8" x2="8" y1="2" y2="6" />
          <line x1="3" x2="21" y1="10" y2="10" />
          <path d="m9 16 2 2 4-4" />
        </svg>
      );
    case 'homework':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
          <path d="M6 6h10" />
          <path d="M6 10h10" />
          <path d="M6 14h6" />
        </svg>
      );
    case 'examinations':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="m9 15 2 2 4-4" />
        </svg>
      );
    case 'finance':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <line x1="2" x2="22" y1="10" y2="10" />
        </svg>
      );
    case 'parent_portal':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case 'school_vault':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      );
    case 'documents':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case 'reports':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" x2="12" y1="20" y2="10" />
          <line x1="18" x2="18" y1="20" y2="4" />
          <line x1="6" x2="6" y1="20" y2="16" />
        </svg>
      );
    case 'imports':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" x2="12" y1="3" y2="15" />
        </svg>
      );
    case 'consents':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'notifications':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case 'ai_assistant':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
        </svg>
      );
  }
}

export const PlatformEntitlementsPage: React.FC = () => {
  const [catalogModules, setCatalogModules] = useState<PlatformModuleDefinition[]>([]);
  const [institutions, setInstitutions] = useState<InstitutionItem[]>([]);
  const [selectedInstId, setSelectedInstId] = useState<string>('');
  const [selectedInstDetail, setSelectedInstDetail] = useState<InstitutionDetail | null>(null);

  const [loading, setLoading] = useState(true);
  const [instLoading, setInstLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Active view: 'INSTITUTION' (manage tenant) or 'CATALOG' (full catalog view)
  const [activeView, setActiveView] = useState<'INSTITUTION' | 'CATALOG'>('INSTITUTION');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  // Search and filter for tenant entitlements workbench
  const [tenantSearch, setTenantSearch] = useState<string>('');
  const [tenantCategoryFilter, setTenantCategoryFilter] = useState<string>('ALL');

  // Confirmation modal state
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);

  // Institution modules state for editing
  const [modulesState, setModulesState] = useState<
    Array<{
      key: string;
      name: string;
      category: string;
      description: string;
      enabled: boolean;
      isTrial: boolean;
      expiresAt?: string | undefined;
      dependencies: string[];
      targetRoutes: string[];
    }>
  >([]);
  const [selectedBundle, setSelectedBundle] = useState<string>('COMPLETE_ERP');
  const [initialModuleState, setInitialModuleState] = useState<Record<string, boolean>>({});

  // Initial load: catalog + institutions list
  useEffect(() => {
    Promise.all([platformApi.getModulesCatalog(), platformApi.getInstitutions()])
      .then(([mods, insts]) => {
        setCatalogModules(mods);
        setInstitutions(insts);
        const initMods = mods.map((catMod) => ({
          key: catMod.key,
          name: catMod.name,
          category: catMod.category,
          description: catMod.description,
          enabled: true,
          isTrial: false,
          dependencies: catMod.dependencies,
          targetRoutes: catMod.targetRoutes,
        }));
        setModulesState(initMods);
        if (insts.length > 0) {
          setSelectedInstId(insts[0]!.id);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  // When selected institution changes, load its details
  useEffect(() => {
    if (!selectedInstId) return;
    setInstLoading(true);
    setActionSuccess(null);
    setActionError(null);

    platformApi
      .getInstitution(selectedInstId)
      .then((detail) => {
        setSelectedInstDetail(detail);
        setSelectedBundle(detail.entitlements.planBundle || 'COMPLETE_ERP');

        // Merge catalog with institution entitlement status
        const merged = catalogModules.map((catMod) => {
          const instMod = detail.entitlements.modules.find((m) => m.key === catMod.key);
          return {
            key: catMod.key,
            name: catMod.name,
            category: catMod.category,
            description: catMod.description,
            enabled: instMod?.enabled ?? true,
            isTrial: instMod?.isTrial ?? false,
            expiresAt: instMod?.expiresAt,
            dependencies: catMod.dependencies,
            targetRoutes: catMod.targetRoutes,
          };
        });

        setModulesState(merged);
        const initialMap: Record<string, boolean> = {};
        merged.forEach((m) => {
          initialMap[m.key] = m.enabled;
        });
        setInitialModuleState(initialMap);
        setInstLoading(false);
      })
      .catch((err) => {
        setActionError(`Failed to load institution entitlements: ${err.message}`);
        setInstLoading(false);
      });
  }, [selectedInstId, catalogModules]);

  const handleToggleModule = (key: string) => {
    setModulesState((prev) =>
      prev.map((m) => {
        if (m.key !== key) return m;
        return { ...m, enabled: !m.enabled };
      })
    );
  };

  const handleToggleTrial = (key: string) => {
    setModulesState((prev) =>
      prev.map((m) => {
        if (m.key !== key) return m;
        const nextTrial = !m.isTrial;
        return {
          ...m,
          isTrial: nextTrial,
          expiresAt: nextTrial
            ? m.expiresAt || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().split('T')[0]
            : undefined,
        };
      })
    );
  };

  const handleSetTrialExpiry = (key: string, date: string) => {
    setModulesState((prev) =>
      prev.map((m) => {
        if (m.key !== key) return m;
        return { ...m, expiresAt: date };
      })
    );
  };

  const handleApplyBundle = (bundle: string) => {
    setSelectedBundle(bundle);
    const STARTER_KEYS = ['students', 'academics', 'attendance', 'documents'];
    const ACADEMIC_KEYS = [
      'students',
      'academics',
      'attendance',
      'documents',
      'timetable',
      'examination',
      'homework',
      'calendar',
    ];

    setModulesState((prev) =>
      prev.map((m) => {
        let shouldEnable = true;
        if (bundle === 'STARTER_CORE') {
          shouldEnable = STARTER_KEYS.includes(m.key);
        } else if (bundle === 'ACADEMIC_PLUS') {
          shouldEnable = ACADEMIC_KEYS.includes(m.key);
        } else if (bundle === 'COMPLETE_ERP' || bundle === 'ENTERPRISE_SUITE') {
          shouldEnable = true;
        }
        return { ...m, enabled: shouldEnable };
      })
    );
  };

  const handleRevertChanges = () => {
    if (!selectedInstDetail) return;
    const reverted = catalogModules.map((catMod) => {
      const instMod = selectedInstDetail.entitlements.modules.find((m) => m.key === catMod.key);
      return {
        key: catMod.key,
        name: catMod.name,
        category: catMod.category,
        description: catMod.description,
        enabled: instMod?.enabled ?? true,
        isTrial: instMod?.isTrial ?? false,
        expiresAt: instMod?.expiresAt,
        dependencies: catMod.dependencies,
        targetRoutes: catMod.targetRoutes,
      };
    });
    setModulesState(reverted);
    setActionSuccess('Reverted changes to current institution baseline.');
    setActionError(null);
  };

  const handleConfirmSave = () => {
    setShowConfirmModal(false);
    executeSave();
  };

  const executeSave = async () => {
    if (!selectedInstId) return;
    setSaving(true);
    setActionSuccess(null);
    setActionError(null);

    try {
      const payload = {
        planBundle: selectedBundle,
        modules: modulesState.map((m) => ({
          key: m.key,
          enabled: m.enabled,
          isTrial: m.isTrial,
          expiresAt: m.expiresAt,
        })),
      };

      await platformApi.setEntitlements(selectedInstId, payload);
      setActionSuccess(
        `Entitlements saved and enforced for ${selectedInstDetail?.name}. Server-side fail-closed authorization is active (403 MODULE_NOT_ENTITLED for disabled modules).`
      );

      // Update initial state baseline
      const newInit: Record<string, boolean> = {};
      modulesState.forEach((m) => {
        newInit[m.key] = m.enabled;
      });
      setInitialModuleState(newInit);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionError(`Failed to save entitlements: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  // Compute diff against initially loaded state
  const pendingChanges = modulesState.filter(
    (m) => (initialModuleState[m.key] ?? true) !== m.enabled
  );

  // Compute broken dependencies among enabled modules
  const brokenDependencies = modulesState
    .filter((m) => m.enabled)
    .flatMap((m) =>
      m.dependencies
        .filter((depKey) => {
          const dep = modulesState.find((other) => other.key === depKey);
          return dep && !dep.enabled;
        })
        .map((depKey) => ({
          moduleKey: m.key,
          moduleName: m.name,
          missingKey: depKey,
          missingName: catalogModules.find((c) => c.key === depKey)?.name || depKey,
        }))
    );

  const categories = ['ALL', 'CORE', 'ACADEMIC', 'OPERATIONS', 'FINANCE', 'SECURITY_AI'];

  const filteredCatalog =
    categoryFilter === 'ALL'
      ? catalogModules
      : catalogModules.filter((m) => m.category === categoryFilter);

  const visibleModules = modulesState.filter((m) => {
    const matchesCategory =
      tenantCategoryFilter === 'ALL' || m.category === tenantCategoryFilter;
    const matchesSearch =
      !tenantSearch.trim() ||
      m.name.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      m.key.toLowerCase().includes(tenantSearch.toLowerCase()) ||
      m.description.toLowerCase().includes(tenantSearch.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const isDisablingCoreModules = pendingChanges.some(
    (m) => !m.enabled && (m.key === 'students' || m.key === 'academics')
  );

  const totalCount = modulesState.length;
  const activeCount = modulesState.filter((m) => m.enabled && !m.isTrial).length;
  const trialCount = modulesState.filter((m) => m.enabled && m.isTrial).length;
  const disabledCount = modulesState.filter((m) => !m.enabled).length;

  if (loading) {
    return (
      <div className="platform-loading-container" aria-live="polite">
        <div className="platform-spinner" />
        <p>Loading ERP module catalog & institution entitlements...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="platform-error-container" role="alert">
        <h2>Unable to load ERP module registry</h2>
        <p className="error-text">{error}</p>
      </div>
    );
  }

  return (
    <div className="platform-page">
      {/* Standard Anesa Page Header */}
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">ERP Module Marketplace & Capability Catalog</h2>
          <p className="platform-page-desc">
            Manage purchased, enabled, and trialed ERP modules per tenant. Server-side fail-closed gates enforce <code>403 MODULE_NOT_ENTITLED</code> on unpurchased routes.
          </p>
        </div>

        {/* View Switcher Pills */}
        <div className="filter-pill-group">
          <button
            type="button"
            className={`filter-pill-btn ${activeView === 'INSTITUTION' ? 'active' : ''}`}
            onClick={() => setActiveView('INSTITUTION')}
          >
            Tenant Entitlements
          </button>
          <button
            type="button"
            className={`filter-pill-btn ${activeView === 'CATALOG' ? 'active' : ''}`}
            onClick={() => setActiveView('CATALOG')}
          >
            Full Catalog & Spec
          </button>
        </div>
      </div>

      {activeView === 'INSTITUTION' ? (
        <div className="entitlements-management-layout">
          {/* Tenant Selector & Bundle Controls Bar */}
          <div className="platform-card">
            <div className="tenant-selector-bar">
              <div className="selector-field">
                <label htmlFor="inst-select" className="text-sm font-semibold">
                  Select Target Institution:
                </label>
                <select
                  id="inst-select"
                  value={selectedInstId}
                  onChange={(e) => setSelectedInstId(e.target.value)}
                  className="platform-select font-medium"
                >
                  {institutions.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name} ({inst.institutionType}) — {inst.slug}
                    </option>
                  ))}
                </select>
              </div>

              <div className="selector-field">
                <label className="text-sm font-semibold">
                  Quick Preset Bundle:
                </label>
                <div className="bundle-quick-actions">
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary text-xs"
                    onClick={() => handleApplyBundle('STARTER_CORE')}
                  >
                    Starter Core (4)
                  </button>
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary text-xs"
                    onClick={() => handleApplyBundle('ACADEMIC_PLUS')}
                  >
                    Academic Plus (8)
                  </button>
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary text-xs"
                    onClick={() => handleApplyBundle('COMPLETE_ERP')}
                  >
                    Complete ERP (All 14)
                  </button>
                </div>
              </div>
            </div>

            {/* Institution Status Indicator */}
            {selectedInstDetail && (
              <div className="tenant-meta-summary mt-4">
                <span className="tenant-meta-pill">
                  Status: <strong>{selectedInstDetail.status}</strong>
                </span>
                <span className="tenant-meta-pill">
                  Type: <strong>{selectedInstDetail.institutionType}</strong>
                </span>
                <span className="tenant-meta-pill">
                  Current Bundle: <strong>{selectedBundle}</strong>
                </span>
                <span className="tenant-meta-pill">
                  Enabled Modules:{' '}
                  <strong>
                    {modulesState.filter((m) => m.enabled).length} / {modulesState.length}
                  </strong>
                </span>
              </div>
            )}
          </div>

          {/* Module Summary KPI Stat Cards (Matching Anesa StatCard Pattern) */}
          <div className="platform-stat-grid mt-4">
            <div className="stat-card stat-card--purple">
              <div className="stat-card-header">
                <span className="stat-card-label">Total Catalog Modules</span>
              </div>
              <div className="stat-card-body">
                <span className="stat-card-value">{totalCount}</span>
                <span className="stat-card-helper">Standard Anesa ERP Registry</span>
              </div>
            </div>

            <div className="stat-card stat-card--emerald">
              <div className="stat-card-header">
                <span className="stat-card-label">Active & Enforced</span>
              </div>
              <div className="stat-card-body">
                <span className="stat-card-value">{activeCount}</span>
                <span className="stat-card-helper">Full Operational Access</span>
              </div>
            </div>

            <div className="stat-card stat-card--amber">
              <div className="stat-card-header">
                <span className="stat-card-label">Trial Evaluation</span>
              </div>
              <div className="stat-card-body">
                <span className="stat-card-value">{trialCount}</span>
                <span className="stat-card-helper">Expiring Evaluation Mode</span>
              </div>
            </div>

            <div className="stat-card stat-card--coral">
              <div className="stat-card-header">
                <span className="stat-card-label">Disabled (Fail-Closed)</span>
              </div>
              <div className="stat-card-body">
                <span className="stat-card-value">{disabledCount}</span>
                <span className="stat-card-helper">HTTP 403 Enforced</span>
              </div>
            </div>
          </div>

          {/* Real-time Feedback Banners */}
          {actionSuccess && (
            <div className="success-banner mt-4" role="status">
              {actionSuccess}
            </div>
          )}

          {actionError && (
            <div className="platform-error-banner mt-4" role="alert">
              {actionError}
            </div>
          )}

          {/* Broken Dependencies Warning Banner */}
          {brokenDependencies.length > 0 && (
            <div className="dependency-alert-banner mt-4" role="alert">
              <div className="alert-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" x2="12" y1="9" y2="13" />
                  <line x1="12" x2="12.01" y1="17" y2="17" />
                </svg>
              </div>
              <div className="alert-content">
                <strong>Module Dependency Inconsistencies Detected ({brokenDependencies.length}):</strong>
                <ul className="dep-warnings-list mt-1">
                  {brokenDependencies.map((dep, idx) => (
                    <li key={`${dep.moduleKey}-${dep.missingKey}-${idx}`}>
                      <strong>{dep.moduleName}</strong> requires <code>{dep.missingName}</code>, which is currently disabled.
                    </li>
                  ))}
                </ul>
                <p className="dep-advice text-xs mt-1">
                  Users accessing routes dependent on disabled modules will receive <code>403 MODULE_NOT_ENTITLED</code>.
                </p>
              </div>
            </div>
          )}

          {/* Pending Changes Preview */}
          {pendingChanges.length > 0 && (
            <div className="diff-preview-banner mt-4">
              <strong>Pending Entitlement Changes ({pendingChanges.length}):</strong>
              <ul className="mt-2 text-sm">
                {pendingChanges.map((m) => (
                  <li key={m.key}>
                    <strong>{m.name}</strong> ({m.key}):{' '}
                    <span className={m.enabled ? 'text-green-700 font-bold' : 'text-red-700 font-bold'}>
                      {m.enabled ? 'ENABLED' : 'DISABLED (FAIL-CLOSED)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Tenant Modules Search and Category Filter Bar */}
          <div className="tenant-modules-toolbar mt-4">
            <div className="tenant-search-wrap">
              <span className="search-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" x2="16.65" y1="21" y2="16.65" />
                </svg>
              </span>
              <input
                type="search"
                className="tenant-module-search"
                placeholder="Search tenant modules..."
                value={tenantSearch}
                onChange={(e) => setTenantSearch(e.target.value)}
                aria-label="Filter tenant modules"
              />
            </div>

            <div className="tenant-category-pills">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`category-filter-btn ${tenantCategoryFilter === cat ? 'active' : ''}`}
                  onClick={() => setTenantCategoryFilter(cat)}
                >
                  {cat.replace('_', ' / ')}
                </button>
              ))}
            </div>
          </div>

          {/* Modules Toggle Grid */}
          {instLoading ? (
            <div className="platform-loading-container mt-6">
              <div className="platform-spinner" />
              <p>Loading tenant modules...</p>
            </div>
          ) : (
            <>
              <div className="modules-management-grid mt-4">
                {visibleModules.map((mod) => {
                  const hasMissingDep = brokenDependencies.some((d) => d.moduleKey === mod.key);
                  return (
                    <div
                      key={mod.key}
                      className={`module-manage-card ${mod.enabled ? 'is-enabled' : 'is-disabled'} ${
                        mod.isTrial ? 'is-trial' : ''
                      }`}
                    >
                      <div className="module-card-top">
                        <div className="module-title-group">
                          <div className="module-avatar-icon" aria-hidden="true">
                            {getModuleIcon(mod.key)}
                          </div>
                          <div className="module-title-meta">
                            <span className={`cat-pill cat-${mod.category.toLowerCase()}`}>
                              {mod.category}
                            </span>
                            <h4 className="module-name">{mod.name}</h4>
                          </div>
                        </div>

                        <div className="flex-center">
                          <label className="switch-toggle" aria-label={`Toggle ${mod.name}`}>
                            <input
                              type="checkbox"
                              checked={mod.enabled}
                              onChange={() => handleToggleModule(mod.key)}
                            />
                            <span className="slider round" />
                          </label>
                        </div>
                      </div>

                      <p className="module-desc-text">{mod.description}</p>

                      {/* Status Badges */}
                      <div className="module-status-row">
                        {mod.enabled ? (
                          mod.isTrial ? (
                            <span className="module-status-badge badge-trial">Trial Evaluation</span>
                          ) : (
                            <span className="module-status-badge badge-active">Active / Enforced</span>
                          )
                        ) : (
                          <span className="module-status-badge badge-disabled">Disabled (Fail-Closed)</span>
                        )}

                        {hasMissingDep && (
                          <span className="module-status-badge badge-warning" title="Prerequisites disabled">
                            Dep Warning
                          </span>
                        )}
                      </div>

                      {/* Trial Toggle & Expiration Date */}
                      <div className="module-trial-row">
                        <label className="trial-checkbox-label">
                          <input
                            type="checkbox"
                            checked={mod.isTrial}
                            disabled={!mod.enabled}
                            onChange={() => handleToggleTrial(mod.key)}
                          />
                          <span>Trial Mode</span>
                        </label>

                        {mod.isTrial && mod.enabled && (
                          <div className="trial-date-picker-wrap">
                            <label htmlFor={`trial-date-${mod.key}`} className="trial-date-label">
                              Expiry:
                            </label>
                            <input
                              id={`trial-date-${mod.key}`}
                              type="date"
                              className="trial-date-input"
                              value={mod.expiresAt ? mod.expiresAt.split('T')[0] : ''}
                              onChange={(e) => handleSetTrialExpiry(mod.key, e.target.value)}
                              aria-label={`Trial expiration date for ${mod.name}`}
                            />
                          </div>
                        )}
                      </div>

                      {/* Expandable Technical Specification & Routes (Uncluttered) */}
                      <details className="module-details-accordion">
                        <summary>Technical Details & Route Gateways</summary>
                        <div className="module-details-content">
                          <div className="module-routes">
                            <strong>Routes:</strong> <code>{mod.targetRoutes.join(', ')}</code>
                          </div>
                          {mod.dependencies.length > 0 && (
                            <div className="module-deps">
                              <strong>Requires:</strong> {mod.dependencies.join(', ')}
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>

              {visibleModules.length === 0 && (
                <div className="empty-catalog-box mt-6">
                  <p>No modules match &quot;{tenantSearch}&quot; in category &quot;{tenantCategoryFilter}&quot;.</p>
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary mt-2"
                    onClick={() => {
                      setTenantSearch('');
                      setTenantCategoryFilter('ALL');
                    }}
                  >
                    Reset Filters
                  </button>
                </div>
              )}

              {/* Save & Revert Footer Bar */}
              <div className="entitlements-footer-bar mt-6">
                <div className="footer-info">
                  <span>
                    <strong>{modulesState.filter((m) => m.enabled).length}</strong> of {modulesState.length} modules active.
                  </span>
                  <span className="footer-subinfo">
                    Unsaved changes:{' '}
                    <strong>{pendingChanges.length > 0 ? pendingChanges.length : 'None'}</strong>
                  </span>
                </div>
                <div className="footer-actions flex-center gap-3">
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary"
                    disabled={saving || pendingChanges.length === 0}
                    onClick={handleRevertChanges}
                  >
                    Revert Changes
                  </button>
                  <button
                    type="button"
                    className="platform-btn platform-btn-primary"
                    disabled={saving || pendingChanges.length === 0}
                    onClick={() => {
                      if (pendingChanges.length > 0) {
                        setShowConfirmModal(true);
                      }
                    }}
                  >
                    {saving ? 'Enforcing & Saving...' : 'Save & Enforce Entitlements'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* High-Impact Confirmation Modal */}
          {showConfirmModal && (
            <div className="guarded-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
              <div className="guarded-modal-card">
                <div className="guarded-modal-header">
                  <h3 id="confirm-modal-title">Confirm Entitlement Policy Updates</h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Target: <strong>{selectedInstDetail?.name}</strong> ({selectedInstDetail?.slug})
                  </p>
                </div>
                <div className="guarded-modal-body">
                  {isDisablingCoreModules && (
                    <div className="dependency-alert-banner mb-3" role="alert">
                      <div className="alert-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                          <line x1="12" x2="12" y1="9" y2="13" />
                          <line x1="12" x2="12.01" y1="17" y2="17" />
                        </svg>
                      </div>
                      <div className="alert-content">
                        <strong>Critical Core Module Deactivation:</strong>
                        <p className="text-xs mt-1">
                          You are disabling core modules (such as Students or Academics). This will immediately lock out faculty and administrative users from primary workflows.
                        </p>
                      </div>
                    </div>
                  )}

                  <p className="text-sm font-semibold mb-2">
                    The following changes ({pendingChanges.length}) will take immediate effect:
                  </p>
                  <ul className="text-xs space-y-1 max-h-48 overflow-y-auto border p-2 rounded bg-gray-50">
                    {pendingChanges.map((m) => (
                      <li key={m.key} className="flex justify-between py-1 border-b last:border-0">
                        <span className="font-medium">{m.name}</span>
                        <span className={m.enabled ? 'text-green-700 font-bold' : 'text-red-700 font-bold'}>
                          {m.enabled ? '→ ENABLING' : '→ DISABLING (403 Fail-Closed)'}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <div className="guarded-guarantee-list mt-3">
                    <strong>Zero-Downtime Multi-Tenant Guarantee:</strong>
                    <br />
                    • Changes apply immediately at the API middleware layer without restarting services.
                    <br />
                    • Existing persistent databases and records remain intact.
                  </div>
                </div>
                <div className="guarded-modal-footer">
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary"
                    onClick={() => setShowConfirmModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="platform-btn platform-btn-primary"
                    onClick={handleConfirmSave}
                  >
                    Confirm & Enforce Changes
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Full Catalog & Specifications View */
        <div className="catalog-view">
          <div className="category-pills-row">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`category-filter-btn ${categoryFilter === cat ? 'active' : ''}`}
                onClick={() => setCategoryFilter(cat)}
              >
                {cat.replace('_', ' / ')}
              </button>
            ))}
          </div>

          <div className="modules-catalog-grid mt-4">
            {filteredCatalog.map((mod) => (
              <div key={mod.key} className="catalog-module-card">
                <div className="card-top">
                  <span className={`cat-pill cat-${mod.category.toLowerCase()}`}>{mod.category}</span>
                  <code className="module-key-code">{mod.key}</code>
                </div>
                <div className="flex items-center gap-3">
                  <div className="module-avatar-icon" aria-hidden="true">
                    {getModuleIcon(mod.key)}
                  </div>
                  <h3 className="module-name">{mod.name}</h3>
                </div>
                <p className="module-desc-text">{mod.description}</p>

                <div className="module-specs">
                  <div className="spec-row">
                    <span className="spec-label">Target Routes:</span>
                    <span className="spec-value">
                      {mod.targetRoutes.map((r) => (
                        <code key={r} className="route-tag">
                          {r}
                        </code>
                      ))}
                    </span>
                  </div>

                  {mod.dependencies.length > 0 && (
                    <div className="spec-row">
                      <span className="spec-label">Dependencies:</span>
                      <span className="spec-value">
                        {mod.dependencies.map((d) => (
                          <span key={d} className="dep-pill">
                            {d}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}

                  <div className="spec-row">
                    <span className="spec-label">Capabilities:</span>
                    <div className="spec-value">
                      {mod.requiredCapabilities.map((cap) => (
                        <code key={cap} className="cap-tag">
                          {cap}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
