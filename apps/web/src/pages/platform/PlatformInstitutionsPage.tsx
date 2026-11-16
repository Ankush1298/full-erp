import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { platformApi, type InstitutionItem } from '../../lib/api/platform-api';

export const PlatformInstitutionsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [institutions, setInstitutions] = useState<InstitutionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [typeFilter, setTypeFilter] = useState(searchParams.get('type') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');

  // Provisioning Modal
  const [showModal, setShowModal] = useState(searchParams.get('action') === 'new');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [institutionType, setInstitutionType] = useState<'SCHOOL' | 'COLLEGE' | 'UNIVERSITY'>('SCHOOL');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminTitle, setAdminTitle] = useState('Principal');
  const [initialPlan, setInitialPlan] = useState('COMPLETE_ERP');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Status Action Modal (Suspend/Reactivate)
  const [actionTarget, setActionTarget] = useState<InstitutionItem | null>(null);
  const [actionType, setActionType] = useState<'SUSPEND' | 'REACTIVATE' | null>(null);
  const [processingAction, setProcessingAction] = useState(false);

  const fetchInstitutions = () => {
    setLoading(true);
    platformApi
      .listInstitutions({
        search: search.trim() || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
      })
      .then((data) => {
        setInstitutions(Array.isArray(data) ? data : (data as any).data || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchInstitutions();
  }, [typeFilter, statusFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchInstitutions();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);

    try {
      await platformApi.createInstitution({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        institutionType,
        adminEmail: adminEmail.trim() || undefined,
        adminTitle: adminTitle.trim() || undefined,
        initialPlan,
      });
      setShowModal(false);
      setName('');
      setSlug('');
      setAdminEmail('');
      fetchInstitutions();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleStatusChange = async () => {
    if (!actionTarget || !actionType) return;
    setProcessingAction(true);

    try {
      if (actionType === 'SUSPEND') {
        await platformApi.suspendInstitution(actionTarget.id);
      } else {
        await platformApi.reactivateInstitution(actionTarget.id);
      }
      setActionTarget(null);
      setActionType(null);
      fetchInstitutions();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setProcessingAction(false);
    }
  };

  // Auto-slug generator
  const handleNameChange = (val: string) => {
    setName(val);
    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) {
      const generated = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      setSlug(generated);
    }
  };

  return (
    <div className="platform-page">
      {/* Header */}
      <div className="platform-page-header">
        <div>
          <h2 className="platform-page-title">Institutions Directory</h2>
          <p className="platform-page-desc">
            Manage provisioned Schools, Colleges, and Universities, inspect entitlements, and configure institutional policies.
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="platform-btn platform-btn-primary"
            onClick={() => {
              setShowModal(true);
              setCreateError(null);
            }}
          >
            + Provision New Tenant
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="platform-filter-bar">
        <form onSubmit={handleSearchSubmit} className="search-form">
          <input
            type="search"
            placeholder="Search by institution name or slug..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="platform-search-input"
            aria-label="Search institutions"
          />
          <button type="submit" className="platform-btn platform-btn-secondary">
            Search
          </button>
        </form>

        <div className="filter-group">
          <label htmlFor="filter-type" className="filter-label">
            Type:
          </label>
          <select
            id="filter-type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="platform-select"
          >
            <option value="">All Types</option>
            <option value="SCHOOL">School (K-12)</option>
            <option value="COLLEGE">Higher Education / College</option>
            <option value="UNIVERSITY">University System</option>
          </select>

          <label htmlFor="filter-status" className="filter-label ml-4">
            Status:
          </label>
          <select
            id="filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="platform-select"
          >
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>
      </div>

      {/* Table of Institutions */}
      {loading ? (
        <div className="platform-loading-container" aria-live="polite">
          <div className="platform-spinner" />
          <p>Querying tenant registry...</p>
        </div>
      ) : error ? (
        <div className="platform-error-container" role="alert">
          <p className="error-text">{error}</p>
        </div>
      ) : institutions.length === 0 ? (
        <div className="empty-state-notice">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400 mx-auto mb-2" aria-hidden="true">
            <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
            <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
            <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
          </svg>
          <h3>No institutions match your query</h3>
          <p>Try clearing filters or provision a new institution.</p>
        </div>
      ) : (
        <div className="platform-card p-0">
          <div className="platform-table-container">
            <table className="platform-table" aria-label="Institutions directory">
            <thead>
              <tr>
                <th scope="col">Institution</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Campuses</th>
                <th scope="col">SaaS Plan</th>
                <th scope="col">Provisioned</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {institutions.map((inst) => (
                <tr key={inst.id}>
                  <td>
                    <div className="institution-cell">
                      <Link
                        to={`/platform/institutions/${inst.id}`}
                        className="font-semibold institution-name-link"
                      >
                        {inst.name}
                      </Link>
                      <span className="institution-slug text-muted">/{inst.slug}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`type-badge type-badge-${inst.institutionType.toLowerCase()}`}>
                      {inst.institutionType}
                    </span>
                  </td>
                  <td>
                    <span className={`status-badge status-${inst.status.toLowerCase()}`}>
                      {inst.status}
                    </span>
                  </td>
                  <td>
                    <span className="campuses-count">{inst.campusesCount} Campus</span>
                  </td>
                  <td>
                    <span className="plan-tag">{inst.planName || 'COMPLETE_ERP'}</span>
                  </td>
                  <td className="text-muted">{new Date(inst.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div className="table-actions">
                      <Link
                        to={`/platform/institutions/${inst.id}`}
                        className="action-btn action-manage"
                        title="Configure modules and settings"
                      >
                        Manage
                      </Link>
                      {inst.status === 'ACTIVE' ? (
                        <button
                          type="button"
                          className="action-btn action-suspend"
                          onClick={() => {
                            setActionTarget(inst);
                            setActionType('SUSPEND');
                          }}
                          title="Safely suspend tenant access"
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="action-btn action-reactivate"
                          onClick={() => {
                            setActionTarget(inst);
                            setActionType('REACTIVATE');
                          }}
                          title="Restore tenant access"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Provision New Institution Modal */}
      {showModal && (
        <div className="platform-modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="platform-modal modal-large"
            role="dialog"
            aria-labelledby="provision-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="platform-modal-header">
              <h2 id="provision-modal-title">Provision New Institution Tenant</h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setShowModal(false)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleCreate} className="platform-modal-body">
              {createError && (
                <div className="form-error-alert" role="alert">
                  {createError}
                </div>
              )}

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="inst-name">Institution Legal / Public Name *</label>
                  <input
                    id="inst-name"
                    type="text"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="e.g. St. Xavier International Academy"
                    className="platform-input"
                    required
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="inst-slug">URL Slug / Tenant Code *</label>
                  <input
                    id="inst-slug"
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    placeholder="e.g. st-xavier"
                    className="platform-input font-mono"
                    required
                  />
                  <span className="input-hint">Used for dedicated tenant routing: anesa.io/{slug || 'code'}</span>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="inst-type">Institution Archetype *</label>
                  <select
                    id="inst-type"
                    value={institutionType}
                    onChange={(e) => {
                      const t = e.target.value as 'SCHOOL' | 'COLLEGE' | 'UNIVERSITY';
                      setInstitutionType(t);
                      if (t === 'SCHOOL') setAdminTitle('Principal');
                      else if (t === 'COLLEGE') setAdminTitle('Dean / Director');
                      else setAdminTitle('Vice Chancellor / Registrar');
                    }}
                    className="platform-select"
                  >
                    <option value="SCHOOL">School (K-12, Class 1-12, Sections, Guardians)</option>
                    <option value="COLLEGE">Higher Education (College, Degrees, Semesters)</option>
                    <option value="UNIVERSITY">University (Colleges, Multi-campus System)</option>
                  </select>
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="inst-plan">Initial SaaS Plan Bundle</label>
                  <select
                    id="inst-plan"
                    value={initialPlan}
                    onChange={(e) => setInitialPlan(e.target.value)}
                    className="platform-select"
                  >
                    <option value="STARTER_CORE">Starter Core (₹49,999/yr - Students & Attendance)</option>
                    <option value="ACADEMIC_PLUS">Academic Plus (₹89,999/yr - Homework & Exams)</option>
                    <option value="COMPLETE_ERP">Complete ERP (₹1,49,999/yr - All 14 Modules)</option>
                    <option value="ENTERPRISE_SUITE">Enterprise Suite (Custom Dedicated Cloud)</option>
                  </select>
                </div>
              </div>

              <div className="form-section-heading">Initial Executive / Administrator Contact</div>

              <div className="form-row">
                <div className="form-group flex-1">
                  <label htmlFor="admin-email">First Administrator Work Email</label>
                  <input
                    id="admin-email"
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="e.g. principal@institution.edu"
                    className="platform-input"
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="admin-title">Displayed Role / Executive Title</label>
                  <input
                    id="admin-title"
                    type="text"
                    value={adminTitle}
                    onChange={(e) => setAdminTitle(e.target.value)}
                    className="platform-input"
                  />
                  <span className="input-hint">Descriptive title only; authorization derives strictly from role code.</span>
                </div>
              </div>

              <div className="platform-modal-actions">
                <button
                  type="button"
                  className="platform-btn platform-btn-secondary"
                  onClick={() => setShowModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="platform-btn platform-btn-primary"
                >
                  {creating ? 'Provisioning Tenant Database...' : 'Provision Institution'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Suspend / Reactivate */}
      {actionTarget && actionType && (
        <div className="platform-modal-backdrop" onClick={() => setActionTarget(null)}>
          <div
            className="platform-modal"
            role="dialog"
            aria-labelledby="confirm-action-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="platform-modal-header">
              <h2 id="confirm-action-title">
                {actionType === 'SUSPEND' ? 'Suspend Institution Access' : 'Reactivate Institution'}
              </h2>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActionTarget(null)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>
            <div className="platform-modal-body">
              <p>
                Are you sure you want to {actionType.toLowerCase()}{' '}
                <strong>{actionTarget.name}</strong> (<code>/{actionTarget.slug}</code>)?
              </p>
              {actionType === 'SUSPEND' ? (
                <div className="warning-callout">
                  <strong>Warning:</strong> Suspending this institution will immediately block all
                  faculty, students, and parent portal logins. Data remains strictly preserved and uncorrupted.
                </div>
              ) : (
                <div className="info-callout">
                  Reactivating will immediately restore full portal access according to their active
                  entitlements.
                </div>
              )}
              <div className="platform-modal-actions">
                <button
                  type="button"
                  className="platform-btn platform-btn-secondary"
                  onClick={() => setActionTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={processingAction}
                  className={`platform-btn ${actionType === 'SUSPEND' ? 'platform-btn-danger' : 'platform-btn-primary'}`}
                  onClick={handleStatusChange}
                >
                  {processingAction
                    ? 'Updating...'
                    : actionType === 'SUSPEND'
                    ? 'Confirm Suspension'
                    : 'Confirm Reactivation'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
