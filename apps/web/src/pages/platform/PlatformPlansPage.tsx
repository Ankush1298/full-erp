import React, { useEffect, useState } from 'react';
import {
  platformApi,
  type PlanBundleDefinition,
  type InstitutionItem,
  type InstitutionDetail,
} from '../../lib/api/platform-api';

export const PlatformPlansPage: React.FC = () => {
  const [bundles, setBundles] = useState<PlanBundleDefinition[]>([]);
  const [institutions, setInstitutions] = useState<InstitutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Assignment section state
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');
  const [instDetail, setInstDetail] = useState<InstitutionDetail | null>(null);
  const [instLoading, setInstLoading] = useState(false);

  // Form state
  const [selectedPlanId, setSelectedPlanId] = useState<string>('COMPLETE_ERP');
  const [planName, setPlanName] = useState<string>('Complete Institutional ERP');
  const [billingCycle, setBillingCycle] = useState<'ANNUAL' | 'MONTHLY' | 'CUSTOM'>('ANNUAL');
  const [status, setStatus] = useState<'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED'>('ACTIVE');
  const [priceInr, setPriceInr] = useState<number>(149999);
  const [renewalDate, setRenewalDate] = useState<string>(
    () => new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().split('T')[0]!,
  );
  const [maxStudents, setMaxStudents] = useState<number>(5000);
  const [maxFaculty, setMaxFaculty] = useState<number>(250);
  const [auditReason, setAuditReason] = useState<string>('Annual subscription contract adjustment');

  // Confirmation modal state
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Safe arrays guaranteed at runtime
  const safeBundles = Array.isArray(bundles) ? bundles : [];
  const safeInstitutions = Array.isArray(institutions) ? institutions : [];

  const loadInitialData = () => {
    setLoading(true);
    setError(null);
    Promise.all([platformApi.getPlanBundles(), platformApi.getInstitutions()])
      .then(([bundleData, instData]) => {
        const validatedBundles = Array.isArray(bundleData) ? bundleData : [];
        const validatedInsts = Array.isArray(instData) ? instData : [];
        setBundles(validatedBundles);
        setInstitutions(validatedInsts);
        if (validatedInsts.length > 0) {
          setSelectedOrgId(validatedInsts[0]!.id);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load SaaS plans or institutions');
        setLoading(false);
      });
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  // When selected institution changes, load its existing subscription
  useEffect(() => {
    if (!selectedOrgId) return;
    setInstLoading(true);
    setSuccessBanner(null);
    setErrorBanner(null);

    platformApi
      .getInstitution(selectedOrgId)
      .then((detail) => {
        setInstDetail(detail);
        const sub = detail.subscription;
        if (sub) {
          setSelectedPlanId(sub.planId ?? 'COMPLETE_ERP');
          setPlanName(sub.planName || 'Complete Institutional ERP');
          setBillingCycle((sub.billingCycle as 'ANNUAL' | 'MONTHLY' | 'CUSTOM') || 'ANNUAL');
          setStatus((sub.status as 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED') || 'ACTIVE');
          setPriceInr(sub.pricingInrPerYear ?? sub.priceInr ?? 149999);
          setMaxStudents(sub.maxStudents || 5000);
          setMaxFaculty(sub.maxFaculty || 250);
          if (sub.renewalDate || sub.renewsAt) {
            setRenewalDate((sub.renewalDate || sub.renewsAt || '').split('T')[0]!);
          }
        }
        setInstLoading(false);
      })
      .catch((err: unknown) => {
        setErrorBanner(
          `Failed to load institution details: ${err instanceof Error ? err.message : 'Unknown error'}`,
        );
        setInstLoading(false);
      });
  }, [selectedOrgId]);

  // When operator selects a plan tier from the presets
  const handleSelectPlanTier = (bundle: PlanBundleDefinition) => {
    setSelectedPlanId(bundle.id);
    setPlanName(bundle.name);
    setPriceInr(bundle.priceInrAnnual);
    setMaxStudents(bundle.maxStudents);
    setMaxFaculty(bundle.maxFaculty);
  };

  const handleResetForm = () => {
    if (!instDetail?.subscription) return;
    const sub = instDetail.subscription;
    setSelectedPlanId(sub.planId ?? 'COMPLETE_ERP');
    setPlanName(sub.planName || 'Complete Institutional ERP');
    setBillingCycle((sub.billingCycle as 'ANNUAL' | 'MONTHLY' | 'CUSTOM') || 'ANNUAL');
    setStatus((sub.status as 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED') || 'ACTIVE');
    setPriceInr(sub.pricingInrPerYear ?? sub.priceInr ?? 149999);
    setMaxStudents(sub.maxStudents || 5000);
    setMaxFaculty(sub.maxFaculty || 250);
    if (sub.renewalDate || sub.renewsAt) {
      setRenewalDate((sub.renewalDate || sub.renewsAt || '').split('T')[0]!);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId) return;

    if (priceInr < 0) {
      setErrorBanner('Annual contract rate cannot be negative');
      return;
    }
    if (maxStudents < 1 || maxFaculty < 1) {
      setErrorBanner('Capacity limits must be at least 1 student and 1 faculty member');
      return;
    }
    if (!renewalDate) {
      setErrorBanner('Please select a valid renewal date');
      return;
    }

    setShowConfirmModal(true);
  };

  const handleConfirmSave = async () => {
    if (!selectedOrgId) return;
    setSaving(true);
    setShowConfirmModal(false);
    setSuccessBanner(null);
    setErrorBanner(null);

    try {
      const payload = {
        planId: selectedPlanId,
        planName,
        billingCycle,
        status,
        priceInr,
        pricingInrPerYear: priceInr,
        startsAt: instDetail?.subscription?.startsAt || new Date().toISOString(),
        expiresAt: new Date(renewalDate).toISOString(),
        renewalDate: new Date(renewalDate).toISOString(),
        renewsAt: new Date(renewalDate).toISOString(),
        maxStudents: Number(maxStudents),
        maxFaculty: Number(maxFaculty),
        auditReason: auditReason.trim() || 'Subscription terms adjustment',
      };

      await platformApi.setSubscription(selectedOrgId, payload);
      setSuccessBanner(
        `Subscription plan successfully updated and enforced for ${instDetail?.name}. Status: ${status}, Annual Rate: ₹${priceInr.toLocaleString('en-IN')}.`,
      );

      // Refresh institution detail
      const refreshed = await platformApi.getInstitution(selectedOrgId);
      setInstDetail(refreshed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(`Failed to update subscription: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="platform-loading-container" aria-live="polite">
        <div className="platform-spinner" />
        <p>Loading SaaS pricing architecture & subscriber directory...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="platform-error-container" role="alert">
        <h2>Unable to load SaaS plans catalog</h2>
        <p className="error-text">{error}</p>
        <button
          type="button"
          className="platform-btn platform-btn-primary mt-4"
          onClick={loadInitialData}
        >
          Retry Loading Catalog
        </button>
      </div>
    );
  }

  return (
    <div className="platform-page">
      {/* Standard Anesa Page Header */}
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">SaaS Subscription Plans & Billing Tiers</h2>
          <p className="platform-page-desc">
            Define institutional packaging, configure annual contract tiers (INR), and assign
            subscription plans with enforced capacity limits.
          </p>
        </div>
      </div>

      {/* Subscription Assignment & Management Workbench */}
      <div className="platform-card mb-6">
        <div className="platform-card-header">
          <div>
            <h3 className="card-title">Assign & Manage Tenant Subscription</h3>
            <p className="card-subtitle">
              Allocate official SaaS tiers, customize annual INR pricing, set renewal schedules, and
              configure maximum student/faculty capacity limits.
            </p>
          </div>
        </div>

        {/* Tenant Selector */}
        <div className="tenant-selector-bar mt-4">
          <div className="selector-field">
            <label htmlFor="sub-tenant-select" className="text-sm font-semibold">
              Select Target Institution:
            </label>
            <select
              id="sub-tenant-select"
              value={selectedOrgId}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              className="platform-select font-medium"
            >
              {safeInstitutions.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} ({inst.institutionType}) — {inst.slug}
                </option>
              ))}
            </select>
          </div>

          {instDetail && (
            <div className="tenant-current-badge">
              <span className="text-xs uppercase text-slate-500 font-bold block">
                Current Active Tier
              </span>
              <span className="font-semibold text-slate-800">
                {instDetail.subscription?.planName
                  ? `${instDetail.subscription.planName} Plan`
                  : 'Unassigned'}{' '}
                •{' '}
                <span
                  className={`status-pill status-${(instDetail.subscription?.status || 'ACTIVE').toLowerCase()}`}
                >
                  {instDetail.subscription?.status || 'ACTIVE'}
                </span>
              </span>
            </div>
          )}
        </div>

        {/* Feedback Banners */}
        {successBanner && (
          <div className="success-banner mt-4" role="status">
            {successBanner}
          </div>
        )}
        {errorBanner && (
          <div className="platform-error-banner mt-4" role="alert">
            {errorBanner}
          </div>
        )}

        {/* Subscription Configuration Form */}
        {instLoading ? (
          <div className="platform-loading-container mt-4">
            <div className="platform-spinner" />
            <p>Loading tenant subscription profile...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="subscription-edit-form mt-6">
            <div className="subscription-form-grid">
              {/* Plan Preset Selector */}
              <div className="form-field">
                <label htmlFor="plan-preset-select">Plan Tier Preset:</label>
                <select
                  id="plan-preset-select"
                  value={selectedPlanId}
                  onChange={(e) => {
                    const bundle = safeBundles.find((b) => b.id === e.target.value);
                    if (bundle) handleSelectPlanTier(bundle);
                    else setSelectedPlanId(e.target.value);
                  }}
                  className="platform-select"
                >
                  {safeBundles.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} (₹{b.priceInrAnnual.toLocaleString('en-IN')}/yr)
                    </option>
                  ))}
                  <option value="CUSTOM">Custom Enterprise Plan</option>
                </select>
              </div>

              {/* Plan Name */}
              <div className="form-field">
                <label htmlFor="plan-name-input">Contract Plan Display Name:</label>
                <input
                  id="plan-name-input"
                  type="text"
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                  className="platform-input"
                  required
                />
              </div>

              {/* Subscription Status */}
              <div className="form-field">
                <label htmlFor="status-select">Subscription Status:</label>
                <select
                  id="status-select"
                  value={status}
                  onChange={(e) =>
                    setStatus(e.target.value as 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'SUSPENDED')
                  }
                  className="platform-select"
                >
                  <option value="ACTIVE">ACTIVE — Enforced & In Good Standing</option>
                  <option value="TRIAL">TRIAL — Evaluation Window Active</option>
                  <option value="EXPIRED">EXPIRED — Renewal Overdue</option>
                  <option value="SUSPENDED">SUSPENDED — Locked Administratively</option>
                </select>
              </div>

              {/* Billing Cycle */}
              <div className="form-field">
                <label htmlFor="billing-cycle-select">Billing Cycle:</label>
                <select
                  id="billing-cycle-select"
                  value={billingCycle}
                  onChange={(e) =>
                    setBillingCycle(e.target.value as 'ANNUAL' | 'MONTHLY' | 'CUSTOM')
                  }
                  className="platform-select"
                >
                  <option value="ANNUAL">ANNUAL — Invoiced Yearly</option>
                  <option value="MONTHLY">MONTHLY — Invoiced Monthly</option>
                  <option value="CUSTOM">CUSTOM — Bespoke Institutional Contract</option>
                </select>
              </div>

              {/* Price in INR */}
              <div className="form-field">
                <label htmlFor="price-inr-input">Annual Contract Rate (INR ₹):</label>
                <input
                  id="price-inr-input"
                  type="number"
                  min="0"
                  step="1000"
                  value={priceInr}
                  onChange={(e) => setPriceInr(Number(e.target.value))}
                  className="platform-input font-medium"
                  required
                />
              </div>

              {/* Renewal Date */}
              <div className="form-field">
                <label htmlFor="renewal-date-input">Next Contract Renewal Date:</label>
                <input
                  id="renewal-date-input"
                  type="date"
                  value={renewalDate}
                  onChange={(e) => setRenewalDate(e.target.value)}
                  className="platform-input"
                  required
                />
              </div>

              {/* Max Students Capacity */}
              <div className="form-field">
                <label htmlFor="max-students-input">Enrolled Students Ceiling:</label>
                <input
                  id="max-students-input"
                  type="number"
                  min="1"
                  step="50"
                  value={maxStudents}
                  onChange={(e) => setMaxStudents(Number(e.target.value))}
                  className="platform-input font-medium"
                  required
                />
              </div>

              {/* Max Faculty Capacity */}
              <div className="form-field">
                <label htmlFor="max-faculty-input">Faculty & Staff Accounts Ceiling:</label>
                <input
                  id="max-faculty-input"
                  type="number"
                  min="1"
                  step="10"
                  value={maxFaculty}
                  onChange={(e) => setMaxFaculty(Number(e.target.value))}
                  className="platform-input font-medium"
                  required
                />
              </div>

              {/* Reason / Notes */}
              <div className="form-field">
                <label htmlFor="audit-reason-input">Audit Log Reason:</label>
                <input
                  id="audit-reason-input"
                  type="text"
                  value={auditReason}
                  onChange={(e) => setAuditReason(e.target.value)}
                  className="platform-input"
                  placeholder="Reason for change (recorded in audit_events)"
                />
              </div>
            </div>

            {/* Proposed Changes Preview Box (Responsive Information Grid) */}
            <div className="subscription-preview-card mt-5">
              <div className="preview-card-header">
                <span className="preview-card-title">Proposed Contract Configuration:</span>
                <span className="preview-tenant-name">{instDetail?.name}</span>
              </div>
              <div className="subscription-spec-grid mt-3">
                <div className="spec-card">
                  <span className="spec-label">Plan Tier Edition</span>
                  <span className="spec-value font-bold">{planName} Edition</span>
                </div>
                <div className="spec-card spec-card--highlight">
                  <span className="spec-label">Annual Contract Rate</span>
                  <span className="spec-value font-extrabold text-emerald-800">
                    ₹{priceInr.toLocaleString('en-IN')} / yr
                  </span>
                </div>
                <div className="spec-card">
                  <span className="spec-label">Billing Cycle</span>
                  <span className="spec-value font-semibold">{billingCycle}</span>
                </div>
                <div className="spec-card">
                  <span className="spec-label">Status</span>
                  <span className="spec-value">
                    <span className={`status-pill status-${status.toLowerCase()}`}>{status}</span>
                  </span>
                </div>
                <div className="spec-card">
                  <span className="spec-label">Next Renewal Schedule</span>
                  <span className="spec-value font-mono text-xs">{renewalDate}</span>
                </div>
                <div className="spec-card spec-card--full">
                  <span className="spec-label">Enforced Capacity Ceilings</span>
                  <span className="spec-value font-bold text-slate-800">
                    {maxStudents.toLocaleString()} Students • {maxFaculty.toLocaleString()} Faculty
                    Accounts
                  </span>
                </div>
              </div>
            </div>

            {/* Responsive Submit Actions: Stacks on Mobile, Inline on Desktop */}
            <div className="subscription-form-actions mt-6">
              <button
                type="button"
                className="platform-btn platform-btn-secondary"
                onClick={handleResetForm}
                disabled={saving}
              >
                Reset to Current
              </button>
              <button type="submit" className="platform-btn platform-btn-primary" disabled={saving}>
                {saving ? 'Committing Changes...' : 'Commit & Enforce Subscription'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div
          className="guarded-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-sub-title"
        >
          <div className="guarded-modal-card">
            <div className="guarded-modal-header">
              <h3 id="confirm-sub-title">Confirm Subscription Terms Update</h3>
              <p className="text-xs text-slate-500 mt-1">
                Tenant: <strong>{instDetail?.name}</strong> ({instDetail?.slug})
              </p>
            </div>
            <div className="guarded-modal-body">
              <p className="text-sm">
                You are about to enforce updated contractual terms for{' '}
                <strong>{instDetail?.name}</strong>:
              </p>
              <ul className="text-xs space-y-1.5 mt-3 p-3 bg-slate-50 border rounded">
                <li>
                  • <strong>Plan:</strong> {planName} ({selectedPlanId})
                </li>
                <li>
                  • <strong>Pricing:</strong> ₹{priceInr.toLocaleString('en-IN')} ({billingCycle})
                </li>
                <li>
                  • <strong>Status:</strong> {status}
                </li>
                <li>
                  • <strong>Renewal:</strong> {renewalDate}
                </li>
                <li>
                  • <strong>Student Limit:</strong> {maxStudents.toLocaleString()}
                </li>
                <li>
                  • <strong>Faculty Limit:</strong> {maxFaculty.toLocaleString()}
                </li>
                <li>
                  • <strong>Audit Reason:</strong> {auditReason}
                </li>
              </ul>
              <div className="guarded-guarantee-list">
                <strong>Platform Governance Guarantee:</strong>
                <br />
                • Student and institutional databases are never reset or purged during plan updates.
                <br />• In-flight admissions and term classes continue seamlessly.
              </div>
            </div>
            <div className="guarded-modal-footer">
              <button
                type="button"
                className="platform-btn platform-btn-secondary"
                onClick={() => setShowConfirmModal(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="platform-btn platform-btn-primary"
                onClick={() => {
                  void handleConfirmSave();
                }}
                disabled={saving}
              >
                {saving ? 'Enforcing...' : 'Confirm & Apply Subscription'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Plan Cards Grid: Aligned with Anesa Cards */}
      <div className="platform-card-header mt-8">
        <div>
          <h3 className="card-title">Canonical SaaS Plan Catalog & Feature Bundles</h3>
          <p className="card-subtitle">
            Base packages and standard entitlement bundles available across Anesa Campus OS.
          </p>
        </div>
      </div>

      {safeBundles.length === 0 ? (
        <div className="empty-catalog-box platform-card text-center p-8 mt-4">
          <p className="text-slate-500">No plan bundles currently defined in catalog.</p>
          <button
            type="button"
            className="platform-btn platform-btn-secondary mt-3"
            onClick={loadInitialData}
          >
            Reload Catalog
          </button>
        </div>
      ) : (
        <div className="plans-tiers-grid mt-4">
          {safeBundles.map((bundle) => {
            const isPopular = bundle.id === 'COMPLETE_ERP';
            return (
              <div key={bundle.id} className={`plan-tier-card ${isPopular ? 'is-popular' : ''}`}>
                {isPopular && <div className="popular-badge">RECOMMENDED FOR INSTITUTIONS</div>}

                <div className="plan-tier-header">
                  <span className={`cat-pill cat-${isPopular ? 'core' : 'academic'}`}>
                    {bundle.tier}
                  </span>
                  <h3 className="plan-tier-title">{bundle.name}</h3>
                  <p className="plan-tier-desc">{bundle.description}</p>
                </div>

                <div className="plan-tier-price-box">
                  <span className="price-currency">₹</span>
                  <span className="price-figure">
                    {bundle.priceInrAnnual.toLocaleString('en-IN')}
                  </span>
                  <span className="price-cycle">/ year</span>
                </div>

                <div className="flex flex-col gap-1 text-xs text-slate-600 border-t pt-3 border-slate-100">
                  <div className="flex items-center gap-2">
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                    </svg>
                    <span>
                      Up to <strong>{bundle.maxStudents.toLocaleString()}</strong> Students
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg
                      viewBox="0 0 24 24"
                      width="14"
                      height="14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                      <line x1="16" x2="16" y1="2" y2="6" />
                      <line x1="8" x2="8" y1="2" y2="6" />
                      <line x1="3" x2="21" y1="10" y2="10" />
                    </svg>
                    <span>
                      Up to <strong>{bundle.maxFaculty.toLocaleString()}</strong> Faculty & Staff
                    </span>
                  </div>
                </div>

                <div className="border-t pt-3 border-slate-100">
                  <span className="text-xs font-bold text-slate-700 block mb-2">
                    Included Modules ({bundle.includedModules.length}):
                  </span>
                  <ul className="plan-features-list">
                    {bundle.includedModules.map((mod) => (
                      <li key={mod}>
                        <span className="check-icon">✓</span>
                        <span>{mod.replace('_', ' ').toUpperCase()}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  type="button"
                  className="platform-btn platform-btn-secondary w-full mt-4"
                  onClick={() => handleSelectPlanTier(bundle)}
                >
                  Apply This Tier to Tenant ↑
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
