import { useState, useEffect } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import {
  activateExamPolicy,
  archiveExamPolicy,
  createExamPolicy,
  duplicateExamPolicy,
  fetchExamPolicies,
  previewExamPolicyImpact,
  updateExamPolicy,
  type EligibilityPolicyDto,
  type ExamScheduleDto,
  type PolicyPreviewImpactResponse,
  type PolicyScope,
  type PolicyStatus,
  type SaveEligibilityPolicyInput,
} from '../../lib/api/examinations-api';
import type { ApiClient } from '../../lib/api/client';
import { PolicyEditor } from './PolicyEditor';

function policyToInput(p: EligibilityPolicyDto): SaveEligibilityPolicyInput {
  return {
    name: p.name,
    description: p.description ?? undefined,
    scope: p.scope,
    status: p.status,
    min_attendance_percentage: p.min_attendance_percentage,
    check_attendance: p.check_attendance,
    check_fees: p.check_fees,
    attendance_cutoff_days_prior: p.attendance_cutoff_days_prior,
    allow_late_enrolment_review: p.allow_late_enrolment_review,
    attendance_rules: p.attendance_rules,
    fee_rules: p.fee_rules,
    academic_rules: p.academic_rules,
    assessment_rules: p.assessment_rules,
    grading_rules: p.grading_rules,
    approval_rules: p.approval_rules,
  };
}

export interface ExaminationPoliciesTabProps {
  client: ApiClient;
  schedules?: ExamScheduleDto[];
}

export function ExaminationPoliciesTab({ client, schedules = [] }: ExaminationPoliciesTabProps) {
  const [policies, setPolicies] = useState<EligibilityPolicyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filter state
  const [scopeFilter, setScopeFilter] = useState<'ALL' | PolicyScope>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | PolicyStatus>('ALL');

  // Edit / Create state
  const [isCreating, setIsCreating] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<EligibilityPolicyDto | null>(null);

  // Impact Simulation state
  const [simulationResult, setSimulationResult] = useState<PolicyPreviewImpactResponse | null>(null);
  const [simulatingScheduleId, setSimulatingScheduleId] = useState<string>(schedules[0]?.id ?? '');
  const [showSimModal, setShowSimModal] = useState(false);

  useEffect(() => {
    void loadPolicies();
  }, [client]);

  async function loadPolicies() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchExamPolicies(client);
      setPolicies(list);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load examination policies.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatePolicy(data: SaveEligibilityPolicyInput) {
    setError(null);
    setSuccess(null);
    try {
      const created = await createExamPolicy(client, data);
      setSuccess(`Policy "${created.name}" created successfully.`);
      setIsCreating(false);
      void loadPolicies();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create policy.');
    }
  }

  async function handleUpdatePolicy(data: SaveEligibilityPolicyInput) {
    if (!editingPolicy) return;
    setError(null);
    setSuccess(null);
    try {
      const updated = await updateExamPolicy(client, editingPolicy.id, data);
      setSuccess(`Policy "${updated.name}" updated successfully.`);
      setEditingPolicy(null);
      void loadPolicies();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update policy.');
    }
  }

  async function handleDuplicatePolicy(p: EligibilityPolicyDto) {
    setError(null);
    setSuccess(null);
    try {
      const duplicated = await duplicateExamPolicy(client, p.id, { name: `${p.name} (Copy)` });
      setSuccess(`Duplicated policy as "${duplicated.name}".`);
      void loadPolicies();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to duplicate policy.');
    }
  }

  async function handleActivatePolicy(p: EligibilityPolicyDto) {
    setError(null);
    setSuccess(null);
    try {
      await activateExamPolicy(client, p.id);
      setSuccess(`Policy "${p.name}" activated.`);
      void loadPolicies();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to activate policy.');
    }
  }

  async function handleArchivePolicy(p: EligibilityPolicyDto) {
    if (!confirm(`Are you sure you want to archive policy "${p.name}"?`)) return;
    setError(null);
    setSuccess(null);
    try {
      await archiveExamPolicy(client, p.id);
      setSuccess(`Policy "${p.name}" archived.`);
      void loadPolicies();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to archive policy.');
    }
  }

  async function handleSimulateImpact(policyData: SaveEligibilityPolicyInput) {
    const schedId = simulatingScheduleId || schedules[0]?.id;
    if (!schedId) {
      setError('Please select an active examination schedule to simulate candidate policy impact.');
      return;
    }
    setError(null);
    try {
      const sim = await previewExamPolicyImpact(client, {
        schedule_id: schedId,
        policy: policyData,
      });
      setSimulationResult(sim);
      setShowSimModal(true);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to run policy impact simulation.');
    }
  }

  const filteredPolicies = policies.filter((p) => {
    if (scopeFilter !== 'ALL' && (p.scope ?? 'INSTITUTION') !== scopeFilter) return false;
    if (statusFilter !== 'ALL' && (p.status ?? 'ACTIVE') !== statusFilter) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Context & Guidance Banner with Visual Precedence Flow */}
      <div className="p-5 rounded-xl bg-surface border border-border shadow-xs space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold text-foreground">
              Institutional Examination Policies & Rule Sets
            </h2>
            <p className="text-xs text-muted max-w-2xl leading-relaxed mt-0.5">
              Configure multi-tier examination eligibility rules, grading scales, assessment
              component splits, and publication workflows across your institution.
            </p>
          </div>
          {!isCreating && !editingPolicy && (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setIsCreating(true);
                setEditingPolicy(null);
              }}
            >
              + Create New Policy
            </Button>
          )}
        </div>

        {/* Visual 4-Step Precedence Flow */}
        <div className="pt-3 border-t border-border">
          <div className="text-xs font-semibold text-foreground mb-2.5 flex items-center gap-1.5">
            <span>Policy Precedence Hierarchy:</span>
            <span className="text-muted font-normal text-[11px]">
              (higher tiers override lower tiers when evaluating candidate eligibility)
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <div className="p-3 rounded-lg border-2 border-brand-500 bg-brand-50/50 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-brand-800">
                  1. Schedule Paper Override
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-brand-600 text-white uppercase tracking-wider">
                  Top Priority
                </span>
              </div>
              <p className="text-[11px] text-brand-900 leading-snug">
                Overrides configured directly on a specific scheduled course paper.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-surface-muted/40 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-foreground">
                  2. Examination Policy
                </span>
                <span className="text-[10px] font-semibold text-muted">Tier 2</span>
              </div>
              <p className="text-[11px] text-muted leading-snug">
                Applies across all papers under a term examination instance.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-surface-muted/40 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-foreground">
                  3. Campus Policy
                </span>
                <span className="text-[10px] font-semibold text-muted">Tier 3</span>
              </div>
              <p className="text-[11px] text-muted leading-snug">
                Campus-wide rules applied to all examinations at the location.
              </p>
            </div>

            <div className="p-3 rounded-lg border border-border bg-surface-muted/40 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-foreground">
                  4. Institution Baseline Default
                </span>
                <span className="text-[10px] font-semibold text-muted">Fallback</span>
              </div>
              <p className="text-[11px] text-muted leading-snug">
                Universal baseline rules defined across the entire institution.
              </p>
            </div>
          </div>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}

      {/* Editor view (Creating or Editing) */}
      {(isCreating || editingPolicy) && (
        <PolicyEditor
          title={isCreating ? 'Create Examination Policy Template' : `Edit Policy: ${editingPolicy?.name}`}
          subtitle="Configure attendance thresholds, fee rules, assessment components, and grading scales."
          initialPolicy={editingPolicy ? policyToInput(editingPolicy) : undefined}
          onSave={isCreating ? handleCreatePolicy : handleUpdatePolicy}
          onCancel={() => {
            setIsCreating(false);
            setEditingPolicy(null);
          }}
          onSimulateImpact={handleSimulateImpact}
        />
      )}

      {/* List view */}
      {!isCreating && !editingPolicy && (
        <div className="card p-6 space-y-5">
          {/* Filters Toolbar */}
          <div className="flex items-center justify-between flex-wrap gap-4 border-b border-border pb-4 bg-surface-muted/20 p-3 rounded-lg">
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <div className="flex items-center gap-2">
                <label htmlFor="policy-scope-filter" className="font-semibold text-foreground">
                  Scope:
                </label>
                <select
                  id="policy-scope-filter"
                  value={scopeFilter}
                  onChange={(e) => setScopeFilter(e.target.value as any)}
                  className="h-9 px-3 rounded-md border border-input bg-surface text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="ALL">All Scopes</option>
                  <option value="INSTITUTION">Institution</option>
                  <option value="CAMPUS">Campus</option>
                  <option value="EXAMINATION">Examination</option>
                  <option value="SCHEDULE">Schedule</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="policy-status-filter" className="font-semibold text-foreground">
                  Status:
                </label>
                <select
                  id="policy-status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as any)}
                  className="h-9 px-3 rounded-md border border-input bg-surface text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ACTIVE">Active</option>
                  <option value="DRAFT">Draft</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>

              {schedules.length > 0 && (
                <div className="flex items-center gap-2">
                  <label htmlFor="simulate-paper-select" className="font-semibold text-foreground">
                    Simulate Paper:
                  </label>
                  <select
                    id="simulate-paper-select"
                    value={simulatingScheduleId}
                    onChange={(e) => setSimulatingScheduleId(e.target.value)}
                    className="h-9 px-3 rounded-md border border-input bg-surface text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {schedules.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.course_code ? `${s.course_code} - ` : ''}
                        {s.course_title ?? s.exam_date}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="text-xs font-medium text-muted">
              Showing {filteredPolicies.length} policy configuration{filteredPolicies.length !== 1 ? 's' : ''}
            </div>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center items-center">
              <Spinner />
            </div>
          ) : filteredPolicies.length === 0 ? (
            <div className="text-center py-12 space-y-3 bg-surface-muted/20 rounded-xl border border-dashed border-border p-8">
              <p className="text-sm font-medium text-muted">No examination policies found matching the filter criteria.</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setIsCreating(true);
                }}
              >
                Create Policy
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {filteredPolicies.map((pol) => {
                const isPolActive = (pol.status ?? 'ACTIVE') === 'ACTIVE';
                const isPolArchived = pol.status === 'ARCHIVED';

                return (
                  <div
                    key={pol.id}
                    className="border border-border rounded-xl p-5 bg-surface hover:shadow-md hover:border-brand-300 transition-all flex flex-col justify-between space-y-4"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <h3 className="text-sm font-bold text-foreground leading-snug">{pol.name}</h3>
                          {pol.description && (
                            <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                              {pol.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-md bg-surface-muted text-foreground border border-border">
                            {pol.scope ?? 'INSTITUTION'}
                          </span>
                          <span
                            className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-md ${
                              isPolActive
                                ? 'bg-emerald-100 text-emerald-800'
                                : isPolArchived
                                  ? 'bg-neutral-200 text-neutral-700'
                                  : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {pol.status ?? 'ACTIVE'}
                          </span>
                        </div>
                      </div>

                      {/* Rule Highlights */}
                      <div className="grid grid-cols-2 gap-2 text-xs pt-3 border-t border-border">
                        <div className="bg-surface-muted/40 p-2.5 rounded-lg border border-border/50">
                          <span className="text-muted block text-[10px] uppercase font-medium mb-0.5">Attendance</span>
                          <span className="font-semibold text-foreground">
                            {pol.check_attendance ? `${pol.min_attendance_percentage}% Min` : 'Waived'}
                          </span>
                        </div>
                        <div className="bg-surface-muted/40 p-2.5 rounded-lg border border-border/50">
                          <span className="text-muted block text-[10px] uppercase font-medium mb-0.5">Fee Clearance</span>
                          <span className="font-semibold text-foreground">
                            {pol.check_fees ? 'Required' : 'Waived'}
                          </span>
                        </div>
                        <div className="bg-surface-muted/40 p-2.5 rounded-lg border border-border/50">
                          <span className="text-muted block text-[10px] uppercase font-medium mb-0.5">Grading Scale</span>
                          <span className="font-semibold text-foreground">
                            {pol.grading_rules?.grading_system ?? 'PERCENTAGE'}
                          </span>
                        </div>
                        <div className="bg-surface-muted/40 p-2.5 rounded-lg border border-border/50">
                          <span className="text-muted block text-[10px] uppercase font-medium mb-0.5">Components</span>
                          <span className="font-semibold text-foreground">
                            {pol.assessment_rules?.components?.length
                              ? `${pol.assessment_rules.components.length} Split`
                              : 'Standard'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center justify-between pt-3 border-t border-border text-xs gap-2">
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => setEditingPolicy(pol)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => void handleDuplicatePolicy(pol)}
                        >
                          Duplicate
                        </Button>
                      </div>

                      <div className="flex items-center gap-3">
                        {!isPolActive && !isPolArchived && (
                          <button
                            type="button"
                            onClick={() => void handleActivatePolicy(pol)}
                            className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 underline focus:outline-none"
                          >
                            Activate
                          </button>
                        )}
                        {!isPolArchived && (
                          <button
                            type="button"
                            onClick={() => void handleArchivePolicy(pol)}
                            className="text-xs font-medium text-neutral-500 hover:text-red-600 focus:outline-none"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Impact Simulation Modal */}
      {showSimModal && simulationResult && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(34, 26, 54, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            className="modal-card"
            style={{
              backgroundColor: 'var(--color-surface, #ffffff)',
              borderRadius: '0.5rem',
              padding: '1.5rem',
              maxWidth: '48rem',
              width: '100%',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sim-dialog-title"
          >
            <div className="flex items-center justify-between mb-4 border-b border-border pb-3">
              <div>
                <h3 id="sim-dialog-title" className="text-lg font-bold text-foreground">
                  Policy Impact Simulation
                </h3>
                <p className="text-xs text-muted">
                  Simulated candidate eligibility based on current class session and fee ledger records.
                </p>
              </div>
              <Button type="button" variant="secondary" onClick={() => setShowSimModal(false)}>
                Close
              </Button>
            </div>

            <div className="grid grid-cols-4 gap-3 mb-6">
              <div className="p-3 rounded bg-surface-muted/40 border border-border text-center">
                <span className="text-[10px] uppercase text-muted block font-semibold">Total</span>
                <span className="text-xl font-bold text-foreground">
                  {simulationResult.total_enrolled}
                </span>
              </div>
              <div className="p-3 rounded bg-emerald-50 border border-emerald-200 text-center">
                <span className="text-[10px] uppercase text-emerald-800 block font-semibold">Eligible</span>
                <span className="text-xl font-bold text-emerald-700">
                  {simulationResult.simulated_eligible}
                </span>
              </div>
              <div className="p-3 rounded bg-amber-50 border border-amber-200 text-center">
                <span className="text-[10px] uppercase text-amber-800 block font-semibold">Needs Review</span>
                <span className="text-xl font-bold text-amber-700">
                  {simulationResult.simulated_needs_review}
                </span>
              </div>
              <div className="p-3 rounded bg-red-50 border border-red-200 text-center">
                <span className="text-[10px] uppercase text-red-800 block font-semibold">Disqualified</span>
                <span className="text-xl font-bold text-red-700">
                  {simulationResult.simulated_not_eligible}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <h5 className="text-xs font-bold uppercase tracking-wider text-muted">
                Candidate Breakdown ({simulationResult.sample_results.length})
              </h5>
              <div className="overflow-x-auto border border-border rounded-lg max-h-64 overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-surface-muted/50 text-muted uppercase font-semibold sticky top-0">
                    <tr>
                      <th className="p-2">Student</th>
                      <th className="p-2">Evaluation</th>
                      <th className="p-2">Attendance %</th>
                      <th className="p-2">Reasons / Rule Evaluation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {simulationResult.sample_results.map((c) => (
                      <tr key={c.candidate_id}>
                        <td className="p-2 font-medium text-foreground">
                          {c.student_name}
                          <span className="text-[10px] text-muted block">{c.admission_number}</span>
                        </td>
                        <td className="p-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              c.evaluation_status === 'ELIGIBLE'
                                ? 'bg-emerald-100 text-emerald-800'
                                : c.evaluation_status === 'NEEDS_REVIEW'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {c.evaluation_status}
                          </span>
                        </td>
                        <td className="p-2 font-mono">
                          {c.evidence_summary?.attendance_percentage != null
                            ? `${c.evidence_summary.attendance_percentage}%`
                            : 'N/A'}
                        </td>
                        <td className="p-2 text-muted">
                          {c.reasons?.join('; ') || 'Criteria met'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
