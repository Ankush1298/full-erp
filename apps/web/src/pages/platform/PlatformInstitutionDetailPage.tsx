import React, { useEffect, useState, useCallback } from 'react';
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
  const [entitlementsError, setEntitlementsError] = useState<string | null>(null);
  const [entitlementDiff, setEntitlementDiff] = useState<string[]>([]);

  // First Administrator Onboarding State (raw tokens live only in ephemeral React state)
  const [onboardingBusy, setOnboardingBusy] = useState<
    'invite' | 'email' | 'revoke' | 'mfa' | null
  >(null);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingSuccess, setOnboardingSuccess] = useState<string | null>(null);
  const [issuedInvite, setIssuedInvite] = useState<{
    token: string;
    acceptUrl: string;
    expiresAt: string;
    reissued: boolean;
    emailDelivery: 'SENT' | 'NOT_CONFIGURED' | 'FAILED' | 'SKIPPED';
  } | null>(null);
  const [issuedMfaTicket, setIssuedMfaTicket] = useState<{
    ticket: string;
    expiresAt: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<'link' | 'token' | 'mfa' | null>(null);

  // Subscription Editor State
  const [subForm, setSubForm] = useState<Partial<SubscriptionConfig>>({});
  const [savingSub, setSavingSub] = useState(false);
  const [subSaved, setSubSaved] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  // Authority Delegation State
  const [authorityType, setAuthorityType] = useState('SECURITY_AUTHORITY');
  const [targetEmail, setTargetEmail] = useState('');
  const [justification, setJustification] = useState('');
  const [approvedBy, setApprovedBy] = useState('Anesa Platform Ops');
  const [grantingAuth, setGrantingAuth] = useState(false);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Reconciliation State
  const [reconciling, setReconciling] = useState(false);
  const [reconcileModalOpen, setReconcileModalOpen] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
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

  const fetchDetail = useCallback(() => {
    if (!id) return;
    setLoading(true);
    platformApi
      .getInstitution(id)
      .then((data) => {
        setDetail(data);
        setModulesState(data.entitlements.modules);
        setSelectedBundle(data.entitlements.planBundle);
        const sub = data.subscription;
        if (sub) {
          setSubForm({
            ...sub,
            status: (sub.status as SubscriptionConfig['status']) || 'ACTIVE',
            billingCycle: (sub.billingCycle as SubscriptionConfig['billingCycle']) || 'ANNUAL',
          });
        } else {
          setSubForm({});
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

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
        diffs.push(
          `${cur.name}: ${orig.enabled ? 'ENABLED' : 'DISABLED'} → ${cur.enabled ? 'ENABLED' : 'DISABLED'}`,
        );
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
      allowedKeys = [
        'students',
        'academics',
        'attendance',
        'homework',
        'examinations',
        'reports',
        'notifications',
      ];
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
        diffs.push(
          `${cur.name}: ${orig.enabled ? 'ENABLED' : 'DISABLED'} → ${cur.enabled ? 'ENABLED' : 'DISABLED'}`,
        );
      }
    });
    setEntitlementDiff(diffs);
  };

  // Save Entitlements
  const handleSaveEntitlements = async () => {
    if (!id) return;
    setSavingEntitlements(true);
    setEntitlementsError(null);
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
      setEntitlementsError((err as Error).message || 'Failed to save entitlements.');
    } finally {
      setSavingEntitlements(false);
    }
  };

  // Save Subscription
  const handleSaveSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id) return;
    setSavingSub(true);
    setSubError(null);
    try {
      await platformApi.setSubscription(id, subForm);
      setSubSaved(true);
      setTimeout(() => setSubSaved(false), 3000);
      fetchDetail();
    } catch (err) {
      setSubError((err as Error).message || 'Failed to save subscription.');
    } finally {
      setSavingSub(false);
    }
  };

  // Reconcile Roles (Opens Guarded Confirmation Dialog)
  const handleOpenReconcileModal = () => {
    setReconcileError(null);
    setReconcileModalOpen(true);
  };

  const handleConfirmReconcileRoles = async () => {
    if (!id) return;
    setReconciling(true);
    setReconcileError(null);
    setReconcileModalOpen(false);
    try {
      const res = await platformApi.reconcileRoles(id, { force: false });
      setReconcileResult(res);
      fetchDetail();
    } catch (err) {
      setReconcileError((err as Error).message || 'Failed to reconcile roles.');
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
    setAuthError(null);
    try {
      const res = await platformApi.grantCriticalAuthority(id, {
        authority: authorityType,
        targetUserEmail: targetEmail.trim(),
        justification: justification.trim(),
        approvedBy: approvedBy.trim(),
      });
      setAuthSuccess(
        `Successfully assigned ${res.authority} to ${res.grantedTo} (${res.grantedPermissionsCount} capabilities granted).`,
      );
      setTargetEmail('');
      setJustification('');
      fetchDetail();
    } catch (err) {
      setAuthError((err as Error).message || 'Failed to grant critical authority.');
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
          <div className="inst-avatar-large">{detail.name.slice(0, 2).toUpperCase()}</div>
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
              <span className="inst-date">
                Provisioned: {new Date(detail.createdAt).toLocaleDateString()}
              </span>
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
          {/* First Administrator Onboarding */}
          <div className="platform-card" style={{ marginBottom: '1.5rem' }}>
            <div className="entitlements-header-row">
              <div>
                <h3 className="card-title">First Administrator Onboarding</h3>
                <p className="card-subtitle">
                  Issue, reissue, or revoke the initial institutional administrator activation
                  invitation and one-time MFA bootstrap ticket.
                </p>
              </div>
            </div>

            {onboardingError && (
              <div
                className="platform-callout error-callout"
                role="alert"
                style={{ marginTop: '1rem' }}
              >
                {onboardingError}
              </div>
            )}
            {onboardingSuccess && (
              <div className="success-banner" role="status" style={{ marginTop: '1rem' }}>
                {onboardingSuccess}
              </div>
            )}

            {detail.firstAdminOnboarding ? (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: '1rem',
                    marginTop: '1rem',
                    padding: '1rem',
                    borderRadius: '0.5rem',
                    background: 'var(--bg-subtle, #f8fafc)',
                    border: '1px solid var(--border-subtle, #e2e8f0)',
                  }}
                >
                  <div>
                    <div className="text-sm text-muted">Administrator Email</div>
                    <div className="font-semibold" style={{ wordBreak: 'break-word' }}>
                      {detail.firstAdminOnboarding.email}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted">Designation</div>
                    <div className="font-semibold">{detail.firstAdminOnboarding.designation}</div>
                  </div>
                  <div>
                    <div className="text-sm text-muted">Account Activation</div>
                    <div>
                      <span
                        className={`status-badge ${
                          detail.firstAdminOnboarding.activationStatus === 'ACTIVATED'
                            ? 'status-active'
                            : 'status-pending'
                        }`}
                      >
                        {detail.firstAdminOnboarding.activationStatus === 'ACTIVATED'
                          ? 'Activated'
                          : 'Pending Activation'}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted">Invitation Status</div>
                    <div>
                      <span className="status-badge">
                        {detail.firstAdminOnboarding.invitationStatus}
                      </span>
                      {detail.firstAdminOnboarding.invitationExpiresAt && (
                        <div className="text-sm text-muted" style={{ marginTop: '0.25rem' }}>
                          Expires:{' '}
                          {new Date(
                            detail.firstAdminOnboarding.invitationExpiresAt,
                          ).toLocaleString()}
                        </div>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-muted">MFA Enrollment</div>
                    <div>
                      <span
                        className={`status-badge ${
                          detail.firstAdminOnboarding.mfaEnrolled
                            ? 'status-active'
                            : 'status-pending'
                        }`}
                      >
                        {detail.firstAdminOnboarding.mfaEnrolled ? 'MFA Enrolled' : 'Not Enrolled'}
                      </span>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                    marginTop: '1rem',
                  }}
                >
                  {detail.firstAdminOnboarding.canIssueInvitation && (
                    <>
                      <button
                        type="button"
                        className="platform-btn platform-btn-primary"
                        disabled={onboardingBusy !== null}
                        onClick={() => {
                          void (async () => {
                            setOnboardingBusy('invite');
                            setOnboardingError(null);
                            setOnboardingSuccess(null);
                            setCopiedKey(null);
                            try {
                              const res = await platformApi.issueFirstAdminInvitation(detail.id, {
                                sendEmail: false,
                              });
                              setIssuedInvite({
                                token: res.token,
                                acceptUrl: res.acceptUrl,
                                expiresAt: res.expiresAt,
                                reissued: res.reissued,
                                emailDelivery: res.emailDelivery,
                              });
                              setOnboardingSuccess(
                                res.reissued
                                  ? 'First-administrator invitation reissued. Copy the one-time activation link below.'
                                  : 'First-administrator invitation generated. Copy the one-time activation link below.',
                              );
                              fetchDetail();
                            } catch (err) {
                              setOnboardingError(
                                err instanceof Error
                                  ? err.message
                                  : 'Failed to issue first-administrator invitation',
                              );
                            } finally {
                              setOnboardingBusy(null);
                            }
                          })();
                        }}
                      >
                        {onboardingBusy === 'invite'
                          ? 'Generating...'
                          : detail.firstAdminOnboarding.invitationStatus === 'NONE'
                            ? 'Generate Invitation'
                            : 'Reissue Invitation'}
                      </button>

                      <button
                        type="button"
                        className="platform-btn platform-btn-secondary"
                        disabled={onboardingBusy !== null}
                        onClick={() => {
                          void (async () => {
                            setOnboardingBusy('email');
                            setOnboardingError(null);
                            setOnboardingSuccess(null);
                            setCopiedKey(null);
                            try {
                              const res = await platformApi.issueFirstAdminInvitation(detail.id, {
                                sendEmail: true,
                              });
                              setIssuedInvite({
                                token: res.token,
                                acceptUrl: res.acceptUrl,
                                expiresAt: res.expiresAt,
                                reissued: res.reissued,
                                emailDelivery: res.emailDelivery,
                              });
                              if (res.emailDelivery === 'SENT') {
                                setOnboardingSuccess(
                                  `Invitation email sent to ${detail.firstAdminOnboarding?.email}. One-time activation link is also available below.`,
                                );
                              } else if (res.emailDelivery === 'NOT_CONFIGURED') {
                                setOnboardingSuccess(
                                  'Invitation generated, but SMTP email delivery is not configured on this server. Use the copy-link fallback below.',
                                );
                              } else {
                                setOnboardingSuccess(
                                  'Invitation generated, but email delivery failed. Use the copy-link fallback below.',
                                );
                              }
                              fetchDetail();
                            } catch (err) {
                              setOnboardingError(
                                err instanceof Error
                                  ? err.message
                                  : 'Failed to send first-administrator invitation',
                              );
                            } finally {
                              setOnboardingBusy(null);
                            }
                          })();
                        }}
                      >
                        {onboardingBusy === 'email'
                          ? 'Sending...'
                          : detail.firstAdminOnboarding.invitationStatus === 'NONE'
                            ? 'Send Invitation'
                            : 'Resend Invitation'}
                      </button>
                    </>
                  )}

                  {detail.firstAdminOnboarding.canRevokeInvitation && (
                    <button
                      type="button"
                      className="platform-btn platform-btn-danger"
                      disabled={onboardingBusy !== null}
                      onClick={() => {
                        void (async () => {
                          setOnboardingBusy('revoke');
                          setOnboardingError(null);
                          setOnboardingSuccess(null);
                          try {
                            const res = await platformApi.revokeFirstAdminInvitation(detail.id, {
                              reason: 'Revoked by platform operator via Control Center',
                            });
                            setIssuedInvite(null);
                            setOnboardingSuccess(
                              `Revoked ${res.revoked} unused invitation${res.revoked === 1 ? '' : 's'}.`,
                            );
                            fetchDetail();
                          } catch (err) {
                            setOnboardingError(
                              err instanceof Error
                                ? err.message
                                : 'Failed to revoke first-administrator invitation',
                            );
                          } finally {
                            setOnboardingBusy(null);
                          }
                        })();
                      }}
                    >
                      {onboardingBusy === 'revoke' ? 'Revoking...' : 'Revoke Invitation'}
                    </button>
                  )}

                  {detail.firstAdminOnboarding.mfaBootstrapEligible && (
                    <button
                      type="button"
                      className="platform-btn platform-btn-secondary"
                      disabled={onboardingBusy !== null}
                      onClick={() => {
                        void (async () => {
                          setOnboardingBusy('mfa');
                          setOnboardingError(null);
                          setOnboardingSuccess(null);
                          setCopiedKey(null);
                          try {
                            const res = await platformApi.issueFirstAdminMfaTicket(detail.id, {
                              reason: 'First-admin MFA bootstrap via Platform Control Center',
                            });
                            setIssuedMfaTicket({
                              ticket: res.ticket,
                              expiresAt: res.expiresAt,
                            });
                            setOnboardingSuccess(
                              'One-time MFA bootstrap ticket issued. Share it securely with the administrator.',
                            );
                            fetchDetail();
                          } catch (err) {
                            setOnboardingError(
                              err instanceof Error
                                ? err.message
                                : 'Failed to issue MFA bootstrap ticket',
                            );
                          } finally {
                            setOnboardingBusy(null);
                          }
                        })();
                      }}
                    >
                      {onboardingBusy === 'mfa'
                        ? 'Issuing Ticket...'
                        : 'Issue MFA Bootstrap Ticket'}
                    </button>
                  )}
                </div>

                {issuedInvite && (
                  <div
                    className="platform-callout info-callout"
                    style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem' }}
                  >
                    <div>
                      <strong>One-Time Activation Link</strong> (shown only once in this session;
                      expires {new Date(issuedInvite.expiresAt).toLocaleString()}):
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <code
                        style={{
                          flex: '1 1 320px',
                          padding: '0.45rem 0.6rem',
                          background: '#ffffff',
                          border: '1px solid #cbd5e1',
                          borderRadius: '0.375rem',
                          wordBreak: 'break-all',
                        }}
                      >
                        {issuedInvite.acceptUrl}
                      </code>
                      <button
                        type="button"
                        className="platform-btn platform-btn-secondary"
                        onClick={() => {
                          void navigator.clipboard.writeText(issuedInvite.acceptUrl).then(() => {
                            setCopiedKey('link');
                          });
                        }}
                      >
                        {copiedKey === 'link' ? 'Copied Link' : 'Copy Activation Link'}
                      </button>
                    </div>
                  </div>
                )}

                {issuedMfaTicket && (
                  <div
                    className="platform-callout info-callout"
                    style={{ marginTop: '1rem', display: 'grid', gap: '0.5rem' }}
                  >
                    <div>
                      <strong>One-Time MFA Bootstrap Ticket</strong> (shown only once; expires{' '}
                      {new Date(issuedMfaTicket.expiresAt).toLocaleString()}):
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <code
                        style={{
                          flex: '1 1 240px',
                          padding: '0.45rem 0.6rem',
                          background: '#ffffff',
                          border: '1px solid #cbd5e1',
                          borderRadius: '0.375rem',
                          wordBreak: 'break-all',
                        }}
                      >
                        {issuedMfaTicket.ticket}
                      </code>
                      <button
                        type="button"
                        className="platform-btn platform-btn-secondary"
                        onClick={() => {
                          void navigator.clipboard.writeText(issuedMfaTicket.ticket).then(() => {
                            setCopiedKey('mfa');
                          });
                        }}
                      >
                        {copiedKey === 'mfa' ? 'Copied Ticket' : 'Copy MFA Ticket'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-muted" style={{ marginTop: '1rem' }}>
                No designated first-administrator account was found for this institution.
              </p>
            )}
          </div>

          <div className="platform-grid-2">
            <div className="platform-card">
              <h3 className="card-title">Campus & Physical Locations</h3>
              <p className="card-subtitle">
                Constituent academic campuses operating under this institution
              </p>
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
                    All student, attendance, grade, and fee queries enforce{' '}
                    <code>app.current_tenant_id() = '{detail.id}'</code>.
                  </p>
                </div>
                <div className="boundary-item">
                  <span className="boundary-status">Enforced</span>
                  <span className="boundary-title">Zero-Access Secret Isolation</span>
                  <p className="boundary-desc">
                    School Vault zero-access envelopes are locked by institution recovery threshold
                    keyrings; platform operators have zero access to plain text credentials.
                  </p>
                </div>
                <div className="boundary-item">
                  <span className="boundary-status">Enforced</span>
                  <span className="boundary-title">Immutable Audit Trail</span>
                  <p className="boundary-desc">
                    Security decisions, privilege escalations, and authorization rejections are
                    hashed and append-only.
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
                  Activate, trial, or suspend specific ERP functionality for this institution.
                  Server-side fail-closed checks deny access to unentitled modules.
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

            {entitlementsError && (
              <div className="form-error-alert" role="alert">
                {entitlementsError}
              </div>
            )}

            {entitlementsSaved && (
              <div className="success-banner" role="status">
                Entitlements successfully updated and committed to{' '}
                <code>app.organization_settings</code>.
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
                onClick={() => {
                  void handleSaveEntitlements();
                }}
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

            {subError && (
              <div className="form-error-alert mt-4" role="alert">
                {subError}
              </div>
            )}

            {subSaved && (
              <div className="success-banner mt-4" role="status">
                Subscription parameters successfully saved.
              </div>
            )}

            <form
              onSubmit={(e) => {
                void handleSaveSubscription(e);
              }}
              className="mt-6"
            >
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
                      setSubForm({
                        ...subForm,
                        status: e.target.value as SubscriptionConfig['status'],
                      })
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
                      setSubForm({
                        ...subForm,
                        billingCycle: e.target.value as SubscriptionConfig['billingCycle'],
                      })
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
                      onChange={(e) => setSubForm({ ...subForm, autoRenew: e.target.checked })}
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
                  Inspect the institution's effective roles and capability grants. Reconcile missing
                  canonical permissions without altering custom grants or institution policies.
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

            {reconcileError && (
              <div className="form-error-alert mt-4" role="alert">
                {reconcileError}
              </div>
            )}

            {/* Reconciliation Success Summary */}
            {reconcileResult && (
              <div className="info-callout mt-4">
                <strong>Reconciliation Summary:</strong> {reconcileResult.grantedPermissions}{' '}
                permissions granted, {reconcileResult.createdRoles.length} missing roles created,{' '}
                {reconcileResult.deniedProtected} explicitly denied permissions safely respected.
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
            <div
              className="guarded-modal-overlay"
              role="dialog"
              aria-modal="true"
              aria-labelledby="reconcile-modal-title"
            >
              <div className="guarded-modal-card">
                <div className="guarded-modal-header">
                  <h3 id="reconcile-modal-title">Guarded Canonical Role Reconciliation</h3>
                  <p className="text-xs text-slate-500">
                    Target: <strong>{detail.name}</strong> ({detail.slug})
                  </p>
                </div>
                <div className="guarded-modal-body">
                  <p className="text-sm text-slate-700">
                    This procedure scans all 8 canonical institution role templates and safely
                    populates any missing baseline permissions for this tenant.
                  </p>
                  <div className="guarded-guarantee-list">
                    <strong>Guarded Execution Guarantees:</strong>
                    <ul className="mt-1 list-disc pl-4 space-y-1">
                      <li>
                        <strong>Zero Deletions:</strong> No existing role assignments or custom
                        grants will be dropped.
                      </li>
                      <li>
                        <strong>Explicit Denies Preserved:</strong> Capabilities explicitly denied (
                        <code>explicitly_denied: true</code>) remain permanently enforced.
                      </li>
                      <li>
                        <strong>Multi-Campus Safe:</strong> Organization and Campus scopes are
                        preserved without data leakage.
                      </li>
                      <li>
                        <strong>Audited:</strong> Logs an immutable record to{' '}
                        <code>app.audit_events</code> under <code>platform.roles.reconcile</code>.
                      </li>
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
                    onClick={() => {
                      void handleConfirmReconcileRoles();
                    }}
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
              Delegating sensitive authority (such as Financial Gateway Administration or Security
              Device Authority) requires strict verification, two-person authorization, and
              immutable audit logs.
            </p>

            {authError && (
              <div className="form-error-alert mt-4" role="alert">
                {authError}
              </div>
            )}

            {authSuccess && (
              <div className="success-banner mt-4" role="status">
                {authSuccess}
              </div>
            )}

            <form
              onSubmit={(e) => {
                void handleGrantAuthority(e);
              }}
              className="mt-6"
            >
              <div className="security-callout-banner">
                <svg
                  className="security-callout-icon"
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <strong>High-Privilege Security Delegation:</strong> Appointing an executive to
                  critical authorities grants emergency administrative access. This delegation is
                  recorded in the immutable platform audit ledger with your operator identity.
                </div>
              </div>

              <div className="form-row-2col">
                <div className="form-group">
                  <label htmlFor="auth-type">
                    Authority Type <span className="required-star">*</span>
                  </label>
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

                <div className="form-group">
                  <label htmlFor="auth-email">
                    Appointed Executive Email <span className="required-star">*</span>
                  </label>
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

              <div className="form-group mb-4">
                <label htmlFor="auth-justification">
                  Business & Security Justification <span className="required-star">*</span>
                </label>
                <textarea
                  id="auth-justification"
                  rows={4}
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  placeholder="Document formal institutional board resolution, executive authorization ticket, or emergency change reference..."
                  className="platform-textarea"
                  required
                />
                <span className="input-hint">
                  Provide detailed context for this delegation. This text is committed verbatim to
                  the tamper-evident audit log.
                </span>
              </div>

              <div className="form-group mb-6" style={{ maxWidth: '420px' }}>
                <label htmlFor="auth-approved-by">
                  Authorizing Operator <span className="required-star">*</span>
                </label>
                <input
                  id="auth-approved-by"
                  type="text"
                  value={approvedBy}
                  onChange={(e) => setApprovedBy(e.target.value)}
                  className="platform-input"
                  required
                />
                <span className="input-hint">
                  Name/ID of the platform operator authorizing this action
                </span>
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
              Low-level tenant configurations stored securely in{' '}
              <code>app.organization_settings</code>.
            </p>

            <div className="settings-inspector mt-6">
              <pre className="json-code-box">{JSON.stringify(detail.settings, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
