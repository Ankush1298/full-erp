import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router';
import {
  platformApi,
  type InstitutionDetail,
  type ModuleEntitlement,
  type SubscriptionConfig,
} from '../../lib/api/platform-api';

type Tab = 'overview' | 'entitlements' | 'subscription' | 'roles' | 'authorities' | 'policies';

export const PlatformInstitutionDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<InstitutionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // Entitlement Editor State
  const [modulesState, setModulesState] = useState<ModuleEntitlement[]>([]);
  const [selectedBundle, setSelectedBundle] = useState<string>('COMPLETE_ERP');
  const [savingEntitlements, setSavingEntitlements] = useState(false);
  const [entitlementsSaved, setEntitlementsSaved] = useState(false);
  const [entitlementDiff, setEntitlementDiff] = useState<string[]>([]);

  // Subscription Editor State
  const [subForm, setSubForm] = useState<Partial<SubscriptionConfig>>({});
  const [savingSub, setSavingSub] = useState(false);
  const [subSaved, setSubSaved] = useState(false);

  // Authority Delegation State
  const [authorityType, setAuthorityType] = useState('SECURITY_AUTHORITY');
  const [targetEmail, setTargetEmail] = useState('');
  const [justification, setJustification] = useState('');
  const [approvedBy, setApprovedBy] = useState('Anesa Platform Ops');
  const [grantingAuth, setGrantingAuth] = useState(false);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  // Reconciliation State
  const [reconciling, setReconciling] = useState(false);
  const [reconcileModalOpen, setReconcileModalOpen] = useState(false);
  const [roleSearchQuery, setRoleSearchQuery] = useState('');
  const [roleScopeFilter, setRoleScopeFilter] = useState('ALL');
  const [reconcileResult, setReconcileResult] = useState<{
    applied: boolean;
    createdRoles: string[];
    grantedPermissions: number;
    deniedProtected: number;
  } | null>(null);

  const getRoleScope = (code: string) => {
    switch (code) {
      case 'COLLEGE_ADMIN':
      case 'REGISTRAR':
      case 'EXAM_OFFICER':
      case 'FINANCE_OFFICER':
        return 'ORGANIZATION';
      case 'HOD':
        return 'DEPARTMENT';
      case 'FACULTY':
        return 'ASSIGNED';
      case 'STUDENT':
      case 'PARENT':
        return 'SELF';
      default:
        return 'ORGANIZATION';
    }
  };

  const getHumanRoleTitle = (code: string, instType: string, defaultName: string) => {
    switch (code) {
      case 'COLLEGE_ADMIN':
        return instType === 'SCHOOL'
          ? 'Principal / Headmaster'
          : instType === 'UNIVERSITY'
          ? 'Vice Chancellor / President'
          : 'Director / Dean';
      case 'REGISTRAR':
        return instType === 'SCHOOL'
          ? 'Vice Principal / Academic In-Charge'
          : instType === 'UNIVERSITY'
          ? 'University Registrar'
          : 'Registrar';
      case 'HOD':
        return instType === 'SCHOOL'
          ? 'Subject Coordinator / Department Head'
          : instType === 'UNIVERSITY'
          ? 'Dean of Faculty / Chair'
          : 'Head of Department (HOD)';
      case 'FACULTY':
        return instType === 'SCHOOL'
          ? 'Class Teacher / Subject Teacher'
          : instType === 'UNIVERSITY'
          ? 'Faculty Fellow / Lecturer'
          : 'Professor / Assistant Professor';
      case 'EXAM_OFFICER':
        return instType === 'SCHOOL'
          ? 'Exam Coordinator'
          : instType === 'UNIVERSITY'
          ? 'Controller of Examinations'
          : 'Controller of Examinations (COE)';
      case 'FINANCE_OFFICER':
        return instType === 'SCHOOL'
          ? 'Bursar / Accounts Officer'
          : instType === 'UNIVERSITY'
          ? 'Comptroller / Finance Director'
          : 'Finance Officer';
      case 'STUDENT':
        return instType === 'SCHOOL'
          ? 'Enrolled Pupil / Student'
          : instType === 'UNIVERSITY'
          ? 'University Candidate / Scholar'
          : 'Undergraduate / Postgraduate Scholar';
      case 'PARENT':
        return instType === 'SCHOOL'
          ? 'Parent / Primary Guardian'
          : instType === 'UNIVERSITY'
          ? 'Guardian (Optional)'
          : 'Guardian / Sponsor';
      default:
        return defaultName;
    }
  };

  const fetchDetail = () => {
    if (!id) return;
    setLoading(true);
    platformApi
      .getInstitution(id)
      .then((data) => {
        setDetail(data);
        setModulesState(data.entitlements.modules);
        setSelectedBundle(data.entitlements.planBundle);
        setSubForm(data.subscription as any);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchDetail();
  }, [id]);

  if (loading) {
    return (
      <div className="platform-loading-container" aria-live="polite">
        <div className="platform-spinner" />
        <p>Loading institution operational parameters...</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="platform-error-container" role="alert">
        <h2>Failed to load institution details</h2>
        <p className="error-text">{error || 'Institution record not found'}</p>
        <Link to="/platform/institutions" className="platform-btn platform-btn-secondary">
          ← Back to Directory
        </Link>
      </div>
    );
  }

  // Toggle Module in Entitlements
  const handleToggleModule = (modKey: string) => {
    const updated = modulesState.map((m) => {
      if (m.key === modKey) {
        return { ...m, enabled: !m.enabled };
      }
      return m;
    });

    // Check dependency violations
    const disabledMod = updated.find((m) => m.key === modKey && !m.enabled);
    if (disabledMod) {
      // If a module is disabled, disable anything that depends on it
      updated.forEach((m) => {
        if (m.dependencies.includes(modKey)) {
          m.enabled = false;
        }
      });
    }

    setModulesState(updated);
    setSelectedBundle('CUSTOM');

    // Compute diff
    const diffs: string[] = [];
    detail.entitlements.modules.forEach((orig) => {
      const cur = updated.find((m) => m.key === orig.key);
      if (cur && cur.enabled !== orig.enabled) {
        diffs.push(`${cur.name}: ${orig.enabled ? 'ENABLED' : 'DISABLED'} → ${cur.enabled ? 'ENABLED' : 'DISABLED'}`);
      }
    });
    setEntitlementDiff(diffs);
  };

  // Apply Plan Bundle preset
  const handleApplyBundle = (bundle: string) => {
    setSelectedBundle(bundle);
    let allowedKeys: string[] = [];
    if (bundle === 'STARTER_CORE') allowedKeys = ['students', 'academics', 'attendance', 'reports'];
    else if (bundle === 'ACADEMIC_PLUS')
      allowedKeys = ['students', 'academics', 'attendance', 'homework', 'examinations', 'reports', 'notifications'];
    else if (bundle === 'COMPLETE_ERP' || bundle === 'ENTERPRISE_SUITE')
      allowedKeys = modulesState.map((m) => m.key);

    const updated = modulesState.map((m) => ({
      ...m,
      enabled: allowedKeys.includes(m.key),
    }));
    setModulesState(updated);

    const diffs: string[] = [];
    detail.entitlements.modules.forEach((orig) => {
      const cur = updated.find((m) => m.key === orig.key);
      if (cur && cur.enabled !== orig.enabled) {
        diffs.push(`${cur.name}: ${orig.enabled ? 'ENABLED' : 'DISABLED'} → ${cur.enabled ? 'ENABLED' : 'DISABLED'}`);
      }
    });
    setEntitlementDiff(diffs);
  };

  // Save Entitlements
  const handleSaveEntitlements = async () => {
    if (!id) return;
    setSavingEntitlements(true);
    try {
      await platformApi.setEntitlements(id, {
        planBundle: selectedBundle,
        modules: modulesState.map((m) => ({
          key: m.key,
          enabled: m.enabled,
          isTrial: m.isTrial,
          expiresAt: m.expiresAt,
        })),
      });
      setEntitlementsSaved(true);
      setEntitlementDiff([]);
      setTimeout(() => setEntitlementsSaved(false), 3000);
      fetchDetail();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSavingEntitlements(false);
    }
  };

  // Save Subscription
  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSavingSub(true);
    try {
      await platformApi.setSubscription(id, subForm);
      setSubSaved(true);
      setTimeout(() => setSubSaved(false), 3000);
      fetchDetail();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSavingSub(false);
    }
  };

  // Reconcile Roles (Opens Guarded Confirmation Dialog)
  const handleOpenReconcileModal = () => {
    setReconcileModalOpen(true);
  };

  const handleConfirmReconcileRoles = async () => {
    if (!id) return;
    setReconciling(true);
    setReconcileModalOpen(false);
    try {
      const res = await platformApi.reconcileRoles(id, { force: false });
      setReconcileResult(res);
      fetchDetail();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setReconciling(false);
    }
  };

  // Grant Critical Authority
  const handleGrantAuthority = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setGrantingAuth(true);
    setAuthSuccess(null);
    try {
      const res = await platformApi.grantCriticalAuthority(id, {
        authority: authorityType,
        targetUserEmail: targetEmail.trim(),
        justification: justification.trim(),
        approvedBy: approvedBy.trim(),
      });
      setAuthSuccess(`Successfully assigned ${res.authority} to ${res.grantedTo} (${res.grantedPermissionsCount} capabilities granted).`);
      setTargetEmail('');
      setJustification('');
      fetchDetail();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setGrantingAuth(false);
    }
  };

  return (
    <div className="platform-page">
      {/* Back button & Breadcrumb */}
      <div className="breadcrumb-bar">
        <Link to="/platform/institutions" className="breadcrumb-link">
          ← Institutions Directory
        </Link>
        <span className="breadcrumb-sep">/</span>
        <span className="breadcrumb-current">{detail.name}</span>
      </div>

      {/* Institution Banner Card */}
      <div className="institution-detail-header-card">
        <div className="inst-header-left">
          <div className="inst-avatar-large">
            {detail.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="inst-title-row">
              <h2 className="inst-display-name">{detail.name}</h2>
              <span className={`status-badge status-${detail.status.toLowerCase()}`}>
                {detail.status}
              </span>
              <span className={`type-badge type-badge-${detail.institutionType.toLowerCase()}`}>
                {detail.institutionType}
              </span>
            </div>
            <div className="inst-meta-row">
              <span className="inst-slug-tag">Code: /{detail.slug}</span>
              <span className="inst-id-tag">UUID: {detail.id}</span>
              <span className="inst-date">Provisioned: {new Date(detail.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        <div className="inst-header-right">
          <div className="header-metric">
            <span className="metric-label">Campuses</span>
            <span className="metric-value">{detail.campuses.length}</span>
          </div>
          <div className="header-metric">
            <span className="metric-label">Active Modules</span>
            <span className="metric-value">
              {detail.entitlements.modules.filter((m) => m.enabled).length} / 14
            </span>
          </div>
          <div className="header-metric">
            <span className="metric-label">Total Role Grants</span>
            <span className="metric-value">
              {detail.roles.reduce((acc, r) => acc + r.permissionCount, 0)}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <nav className="platform-tabs-nav" aria-label="Institution sub-sections">
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview & Campuses
        </button>
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'entitlements' ? 'active' : ''}`}
          onClick={() => setActiveTab('entitlements')}
        >
          Module Entitlements ({detail.entitlements.modules.filter((m) => m.enabled).length}/14)
        </button>
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'subscription' ? 'active' : ''}`}
          onClick={() => setActiveTab('subscription')}
        >
          SaaS Subscription & Limits
        </button>
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'roles' ? 'active' : ''}`}
          onClick={() => setActiveTab('roles')}
        >
          Roles & Permissions Matrix
        </button>
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'authorities' ? 'active' : ''}`}
          onClick={() => setActiveTab('authorities')}
        >
          Sensitive Authorities
        </button>
        <button
          type="button"
          className={`platform-tab-btn ${activeTab === 'policies' ? 'active' : ''}`}
          onClick={() => setActiveTab('policies')}
        >
          Institutional Configuration
        </button>
      </nav>

      {/* TAB CONTENT: Overview */}
      {activeTab === 'overview' && (
        <div className="tab-pane">
          <div className="platform-grid-2">
            <div className="platform-card">
              <h3 className="card-title">Campus & Physical Locations</h3>
              <p className="card-subtitle">Constituent academic campuses operating under this institution</p>
              <div className="campuses-list mt-4">
                {detail.campuses.map((c) => (
                  <div key={c.id} className="campus-item-card">
                    <div className="campus-info">
                      <span className="campus-name font-semibold">{c.name}</span>
                      <span className="campus-meta text-muted">
                        Code: <code>{c.code}</code> • Timezone: {c.timezone}
                      </span>
                    </div>
                    {c.code === 'MAIN' && <span className="main-campus-badge">Main Campus</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="platform-card">
              <h3 className="card-title">Tenant Realm Security & Trust Boundary</h3>
              <p className="card-subtitle">Enforced architectural boundaries for this tenant</p>
              <div className="security-boundary-list mt-4">
                <div className="boundary-item">
                  <span className="boundary-status">Enforced</span>
                  <span className="boundary-title">PostgreSQL Row-Level Security</span>
                  <p className="boundary-desc">
                    All student, attendance, grade, and fee queries enforce <code>app.current_tenant_id() = '{detail.id}'</code>.
                  </p>
                </div>
                <div className="boundary-item">
                  <span className="boundary-status">Enforced</span>
                  <span className="boundary-title">Zero-Access Secret Isolation</span>
                  <p className="boundary-desc">
                    School Vault zero-access envelopes are locked by institution recovery threshold keyrings; platform operators have zero access to plain text credentials.
                  </p>
                </div>
                <div className="boundary-item">
                  <span className="boundary-status">Enforced</span>
                  <span className="boundary-title">Immutable Audit Trail</span>
                  <p className="boundary-desc">
                    Security decisions, privilege escalations, and authorization rejections are hashed and append-only.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT: Module Entitlements */}
      {activeTab === 'entitlements' && (
        <div className="tab-pane">
          <div className="platform-card">
            <div className="entitlements-header-row">
              <div>
                <h3 className="card-title">ERP Module Entitlements & Marketplace</h3>
                <p className="card-subtitle">
                  Activate, trial, or suspend specific ERP functionality for this institution. Server-side fail-closed checks deny access to unentitled modules.
                </p>
              </div>

              <div className="bundle-selector-group">
                <label htmlFor="bundle-select" className="text-sm font-semibold">
                  Plan Bundle:
                </label>
                <select
                  id="bundle-select"
                  value={selectedBundle}
                  onChange={(e) => handleApplyBundle(e.target.value)}
                  className="platform-select"
                >
                  <option value="STARTER_CORE">Starter Core (4 Modules)</option>
                  <option value="ACADEMIC_PLUS">Academic Plus (7 Modules)</option>
                  <option value="COMPLETE_ERP">Complete ERP (All 14 Modules)</option>
                  <option value="ENTERPRISE_SUITE">Enterprise Suite</option>
                  <option value="CUSTOM">Custom Entitlements</option>
                </select>
              </div>
            </div>

            {/* Diff Preview before saving */}
            {entitlementDiff.length > 0 && (
              <div className="diff-preview-banner">
                <strong>Pending Entitlement Changes ({entitlementDiff.length}):</strong>
                <ul>
                  {entitlementDiff.map((d, idx) => (
                    <li key={idx}>{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {entitlementsSaved && (
              <div className="success-banner" role="status">
                Entitlements successfully updated and committed to <code>app.organization_settings</code>.
              </div>
            )}

            {/* Modules Grid */}
            <div className="modules-management-grid mt-6">
              {modulesState.map((mod) => (
                <div
                  key={mod.key}
                  className={`module-manage-card ${mod.enabled ? 'is-enabled' : 'is-disabled'}`}
                >
                  <div className="module-card-top">
                    <div className="module-title-group">
                      <span className="category-pill">{mod.category}</span>
                      <h4 className="module-name">{mod.name}</h4>
                    </div>

                    <label className="switch-toggle" aria-label={`Toggle ${mod.name}`}>
                      <input
                        type="checkbox"
                        checked={mod.enabled}
                        onChange={() => handleToggleModule(mod.key)}
                      />
                      <span className="slider round" />
                    </label>
                  </div>

                  <p className="module-desc-text">{mod.description}</p>

                  <div className="module-meta-footer">
                    <div className="module-routes">
                      <strong>Routes:</strong> <code>{mod.targetRoutes.join(', ')}</code>
                    </div>
                    {mod.dependencies.length > 0 && (
                      <div className="module-deps">
                        <strong>Requires:</strong> {mod.dependencies.join(', ')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="card-actions-footer mt-6">
              <button
                type="button"
                className="platform-btn platform-btn-primary"
                disabled={savingEntitlements || entitlementDiff.length === 0}
                onClick={handleSaveEntitlements}
              >
                {savingEntitlements ? 'Saving Entitlements...' : 'Save & Enforce Entitlements'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB CONTENT: Subscription & Limits */}
      {activeTab === 'subscription' && (
        <div className="tab-pane">
          <div className="platform-card">
            <h3 className="card-title">SaaS Subscription & Tenant Resource Quotas</h3>
            <p className="card-subtitle">
              SaaS contract billing terms, annual pricing (INR), and institutional capacity limits.
            </p>

            {subSaved && (
              <div className="success-banner mt-4" role="status">
                Subscription parameters successfully saved.
              </div>
            )}

            <form onSubmit={handleSaveSubscription} className="mt-6">
              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="sub-plan">SaaS Plan Tier</label>
                  <input
                    id="sub-plan"
                    type="text"
                    value={subForm.planName || ''}
                    onChange={(e) => setSubForm({ ...subForm, planName: e.target.value })}
                    className="platform-input"
                    required
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="sub-status">Subscription Status</label>
                  <select
                    id="sub-status"
                    value={subForm.status || 'ACTIVE'}
                    onChange={(e) =>
                      setSubForm({ ...subForm, status: e.target.value as any })
                    }
                    className="platform-select"
                  >
                    <option value="ACTIVE">Active (In Good Standing)</option>
                    <option value="TRIAL">Trial Period</option>
                    <option value="EXPIRED">Expired</option>
                    <option value="SUSPENDED">Suspended for Non-Payment</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="sub-price">Annual Contract Value (INR ₹)</label>
                  <input
                    id="sub-price"
                    type="number"
                    value={subForm.pricingInrPerYear || 0}
                    onChange={(e) =>
                      setSubForm({ ...subForm, pricingInrPerYear: parseInt(e.target.value, 10) })
                    }
                    className="platform-input"
                    min="0"
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="sub-cycle">Billing Frequency</label>
                  <select
                    id="sub-cycle"
                    value={subForm.billingCycle || 'ANNUAL'}
                    onChange={(e) =>
                      setSubForm({ ...subForm, billingCycle: e.target.value as any })
                    }
                    className="platform-select"
                  >
                    <option value="ANNUAL">Annual (Prepaid)</option>
                    <option value="MONTHLY">Monthly Recurring</option>
                    <option value="CUSTOM">Custom Multi-Year Enterprise</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="sub-max-students">Student Enrolment Limit</label>
                  <input
                    id="sub-max-students"
                    type="number"
                    value={subForm.maxStudents || 2500}
                    onChange={(e) =>
                      setSubForm({ ...subForm, maxStudents: parseInt(e.target.value, 10) })
                    }
                    className="platform-input"
                    min="50"
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="sub-max-faculty">Faculty / Employee Seat Limit</label>
                  <input
                    id="sub-max-faculty"
                    type="number"
                    value={subForm.maxFaculty || 250}
                    onChange={(e) =>
                      setSubForm({ ...subForm, maxFaculty: parseInt(e.target.value, 10) })
                    }
                    className="platform-input"
                    min="5"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="sub-renewal">Renewal Date</label>
                  <input
                    id="sub-renewal"
                    type="date"
                    value={subForm.renewsAt ? subForm.renewsAt.slice(0, 10) : ''}
                    onChange={(e) =>
                      setSubForm({
                        ...subForm,
                        renewsAt: new Date(e.target.value).toISOString(),
                      })
                    }
                    className="platform-input"
                  />
                </div>

                <div className="form-group flex-1 flex-center-vertically">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={subForm.autoRenew ?? true}
                      onChange={(e) =>
                        setSubForm({ ...subForm, autoRenew: e.target.checked })
                      }
                    />
                    <span>Automatic Annual Contract Renewal</span>
                  </label>
                </div>
              </div>

              <div className="card-actions-footer">
                <button
                  type="submit"
                  disabled={savingSub}
                  className="platform-btn platform-btn-primary"
                >
                  {savingSub ? 'Updating Subscription...' : 'Save Subscription Terms'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB CONTENT: Roles & Permissions Matrix */}
      {activeTab === 'roles' && (
        <div className="tab-pane">
          <div className="platform-card">
            <div className="flex-between-center">
              <div>
                <h3 className="card-title">Universal Role & Capability Grants</h3>
                <p className="card-subtitle">
                  Inspect the institution's effective roles and capability grants. Reconcile missing canonical permissions without altering custom grants or institution policies.
                </p>
              </div>
              <button
                type="button"
                className="platform-btn platform-btn-secondary"
                disabled={reconciling}
                onClick={handleOpenReconcileModal}
              >
                {reconciling ? 'Reconciling...' : 'Reconcile Missing Canonical Roles'}
              </button>
            </div>

            {/* Reconciliation Success Summary */}
            {reconcileResult && (
              <div className="info-callout mt-4">
                <strong>Reconciliation Summary:</strong> {reconcileResult.grantedPermissions} permissions granted,{' '}
                {reconcileResult.createdRoles.length} missing roles created, {reconcileResult.deniedProtected} explicitly denied permissions safely respected.
              </div>
            )}

            {/* Search and Scope Filters */}
            <div className="matrix-controls-row mt-6">
              <div className="search-field flex-1">
                <input
                  type="text"
                  placeholder="Filter roles by code or title..."
                  value={roleSearchQuery}
                  onChange={(e) => setRoleSearchQuery(e.target.value)}
                  className="platform-input text-sm"
                />
              </div>
              <div className="scope-pills-filter">
                {['ALL', 'ORGANIZATION', 'CAMPUS', 'DEPARTMENT', 'ASSIGNED', 'SELF'].map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    className={`filter-pill-btn ${roleScopeFilter === sc ? 'active' : ''}`}
                    onClick={() => setRoleScopeFilter(sc)}
                  >
                    {sc}
                  </button>
                ))}
              </div>
            </div>

            {/* Roles Summary Cards Grid */}
            <div className="roles-summary-grid mt-6">
              {detail.roles
                .filter((r) => {
                  const scope = getRoleScope(r.code);
                  const matchesScope = roleScopeFilter === 'ALL' || scope === roleScopeFilter;
                  const humanTitle = getHumanRoleTitle(r.code, detail.institutionType, r.name);
                  const matchesSearch =
                    roleSearchQuery === '' ||
                    r.code.toLowerCase().includes(roleSearchQuery.toLowerCase()) ||
                    humanTitle.toLowerCase().includes(roleSearchQuery.toLowerCase()) ||
                    r.name.toLowerCase().includes(roleSearchQuery.toLowerCase());
                  return matchesScope && matchesSearch;
                })
                .map((r) => {
                  const scope = getRoleScope(r.code);
                  const humanTitle = getHumanRoleTitle(r.code, detail.institutionType, r.name);
                  return (
                    <div key={r.code} className="role-summary-card">
                      <div className="role-top">
                        <span className="role-code-badge font-mono">{r.code}</span>
                        <div className="flex-center gap-1">
                          <span className={`scope-badge scope-${scope.toLowerCase()}`}>
                            {scope}
                          </span>
                          {r.isSystem ? (
                            <span className="system-tag">Canonical</span>
                          ) : (
                            <span className="custom-tag">Custom</span>
                          )}
                        </div>
                      </div>
                      <div className="role-name">{humanTitle}</div>
                      <div className="text-xs text-slate-500 font-medium mb-2">{r.name}</div>
                      <div className="role-grants-count">
                        <strong>{r.permissionCount}</strong> capabilities granted
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>

          {/* Guarded Reconciliation Modal */}
          {reconcileModalOpen && (
            <div className="guarded-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reconcile-modal-title">
              <div className="guarded-modal-card">
                <div className="guarded-modal-header">
                  <h3 id="reconcile-modal-title">Guarded Canonical Role Reconciliation</h3>
                  <p className="text-xs text-slate-500">
                    Target: <strong>{detail.name}</strong> ({detail.slug})
                  </p>
                </div>
                <div className="guarded-modal-body">
                  <p className="text-sm text-slate-700">
                    This procedure scans all 8 canonical institution role templates and safely populates any missing baseline permissions for this tenant.
                  </p>
                  <div className="guarded-guarantee-list">
                    <strong>Guarded Execution Guarantees:</strong>
                    <ul className="mt-1 list-disc pl-4 space-y-1">
                      <li><strong>Zero Deletions:</strong> No existing role assignments or custom grants will be dropped.</li>
                      <li><strong>Explicit Denies Preserved:</strong> Capabilities explicitly denied (<code>explicitly_denied: true</code>) remain permanently enforced.</li>
                      <li><strong>Multi-Campus Safe:</strong> Organization and Campus scopes are preserved without data leakage.</li>
                      <li><strong>Audited:</strong> Logs an immutable record to <code>app.audit_events</code> under <code>platform.roles.reconcile</code>.</li>
                    </ul>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    Are you sure you want to proceed with non-destructive canonical reconciliation?
                  </p>
                </div>
                <div className="guarded-modal-footer">
                  <button
                    type="button"
                    className="platform-btn platform-btn-secondary"
                    onClick={() => setReconcileModalOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="platform-btn platform-btn-primary"
                    disabled={reconciling}
                    onClick={handleConfirmReconcileRoles}
                  >
                    {reconciling ? 'Reconciling...' : 'Confirm & Execute Reconciliation'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB CONTENT: Sensitive Authorities */}
      {activeTab === 'authorities' && (
        <div className="tab-pane">
          <div className="platform-card">
            <h3 className="card-title">Controlled Critical Authority Delegation</h3>
            <p className="card-subtitle">
              Delegating sensitive authority (such as Financial Gateway Administration or Security Device Authority) requires strict verification, two-person authorization, and immutable audit logs.
            </p>

            {authSuccess && (
              <div className="success-banner mt-4" role="status">
                {authSuccess}
              </div>
            )}

            <form onSubmit={handleGrantAuthority} className="mt-6">
              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="auth-type">Authority Type *</label>
                  <select
                    id="auth-type"
                    value={authorityType}
                    onChange={(e) => setAuthorityType(e.target.value)}
                    className="platform-select"
                  >
                    <option value="SECURITY_AUTHORITY">
                      SECURITY_AUTHORITY (Vault Recovery, Device Administration, Security Center)
                    </option>
                    <option value="FINANCIAL_GATEWAY_AUTHORITY">
                      FINANCIAL_GATEWAY_AUTHORITY (Payment Gateway Credentials, Refund Initiation)
                    </option>
                  </select>
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="auth-email">Appointed Executive Email *</label>
                  <input
                    id="auth-email"
                    type="email"
                    value={targetEmail}
                    onChange={(e) => setTargetEmail(e.target.value)}
                    placeholder="e.g. finance-officer@institution.edu"
                    className="platform-input"
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="auth-justification">Business & Security Justification *</label>
                  <textarea
                    id="auth-justification"
                    rows={3}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Document institutional board resolution or executive authorization..."
                    className="platform-textarea"
                    required
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="auth-approved-by">Authorizing Operator *</label>
                  <input
                    id="auth-approved-by"
                    type="text"
                    value={approvedBy}
                    onChange={(e) => setApprovedBy(e.target.value)}
                    className="platform-input"
                    required
                  />
                  <span className="input-hint">Name/ID of the platform operator authorizing this action</span>
                </div>
              </div>

              <div className="card-actions-footer">
                <button
                  type="submit"
                  disabled={grantingAuth || !targetEmail || !justification}
                  className="platform-btn platform-btn-danger"
                >
                  {grantingAuth ? 'Authorizing...' : 'Authorize Critical Authority'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB CONTENT: Institutional Configuration */}
      {activeTab === 'policies' && (
        <div className="tab-pane">
          <div className="platform-card">
            <h3 className="card-title">Tenant Organization Settings & Configuration</h3>
            <p className="card-subtitle">
              Low-level tenant configurations stored securely in <code>app.organization_settings</code>.
            </p>

            <div className="settings-inspector mt-6">
              <pre className="json-code-box">
                {JSON.stringify(detail.settings, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
