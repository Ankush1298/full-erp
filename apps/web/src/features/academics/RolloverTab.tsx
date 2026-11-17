import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { TextField } from '../../components/ui/TextField';
import type { ApiClient } from '../../lib/api/client';
import {
  fetchPromotionPolicy,
  updatePromotionPolicy,
  generateRolloverPreview,
  updateRolloverExceptions,
  executeRollover,
  fetchRolloverBatches,
  fetchTerms,
  type PromotionPolicy,
  type RolloverBatch,
  type RolloverBatchSummary,
  type RolloverStudentEvaluation,
  type Term,
} from '../../lib/api/academics-api';

export function RolloverTab({ client, canManage }: { client: ApiClient; canManage: boolean }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Policy State
  const [policy, setPolicy] = useState<PromotionPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyEditing, setPolicyEditing] = useState(false);
  const [policyForm, setPolicyForm] = useState<Partial<PromotionPolicy>>({});

  // Terms State
  const [terms, setTerms] = useState<Term[]>([]);
  const [sourceTermId, setSourceTermId] = useState('');
  const [targetTermId, setTargetTermId] = useState('');

  // Active Batch & History State
  const [currentBatch, setCurrentBatch] = useState<RolloverBatch | null>(null);
  const [batches, setBatches] = useState<RolloverBatchSummary[]>([]);
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [savingExceptions, setSavingExceptions] = useState(false);

  // Filter in student table
  const [outcomeFilter, setOutcomeFilter] = useState<
    'ALL' | 'PROMOTED' | 'RETAINED' | 'PENDING_REVIEW' | 'GRADUATED'
  >('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Load initial data
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([fetchPromotionPolicy(client), fetchTerms(client), fetchRolloverBatches(client)])
      .then(([pol, termList, batchList]) => {
        if (!active) return;
        setPolicy(pol);
        setPolicyForm(pol);
        setTerms(termList);
        setBatches(batchList);

        // Preselect active term as source and first planned term as target
        const activeTerm = termList.find((t) => t.status === 'ACTIVE');
        const plannedTerm = termList.find((t) => t.status === 'PLANNED');
        if (activeTerm) setSourceTermId(activeTerm.id);
        if (plannedTerm) setTargetTermId(plannedTerm.id);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Failed to load rollover data.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client]);

  const handleSavePolicy = async () => {
    if (!canManage) return;
    setSavingPolicy(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await updatePromotionPolicy(client, policyForm);
      setPolicy(updated);
      setPolicyEditing(false);
      setSuccess('Academic promotion and rollover policy saved successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save promotion policy.');
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleGeneratePreview = async () => {
    if (!sourceTermId || !targetTermId) {
      setError('Please select both a source academic session and a target academic session.');
      return;
    }
    setGeneratingPreview(true);
    setError(null);
    setSuccess(null);
    try {
      const batch = await generateRolloverPreview(client, {
        sourceTermId,
        targetTermId,
      });
      setCurrentBatch(batch);
      setSuccess(
        `Generated promotion preview with ${batch.summary.totalStudents} student evaluations.`,
      );
      const batchList = await fetchRolloverBatches(client);
      setBatches(batchList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate promotion preview.');
    } finally {
      setGeneratingPreview(false);
    }
  };

  const handleOverrideStudent = (
    studentId: string,
    outcome: 'PROMOTED' | 'RETAINED' | 'PENDING_REVIEW' | 'GRADUATED',
    reason: string,
  ) => {
    if (!currentBatch) return;
    const updatedStudents = currentBatch.students.map((s) => {
      if (s.studentId === studentId) {
        return {
          ...s,
          finalOutcome: outcome,
          overrideReason: reason,
        };
      }
      return s;
    });

    const newSummary = {
      totalStudents: updatedStudents.length,
      promoted: updatedStudents.filter((s) => s.finalOutcome === 'PROMOTED').length,
      retained: updatedStudents.filter((s) => s.finalOutcome === 'RETAINED').length,
      pendingReview: updatedStudents.filter((s) => s.finalOutcome === 'PENDING_REVIEW').length,
      graduated: updatedStudents.filter((s) => s.finalOutcome === 'GRADUATED').length,
    };

    setCurrentBatch({
      ...currentBatch,
      summary: newSummary,
      students: updatedStudents,
    });
  };

  const handleSaveExceptions = async () => {
    if (!currentBatch || !canManage) return;
    const modified = currentBatch.students.filter((s) => s.finalOutcome !== s.recommendedOutcome);

    // Verify all modified students have reason
    const invalidReason = modified.find(
      (s) => !s.overrideReason || s.overrideReason.trim().length < 5,
    );
    if (invalidReason) {
      setError(
        `Student ${invalidReason.fullName} requires an explicit override reason (minimum 5 characters).`,
      );
      return;
    }

    setSavingExceptions(true);
    setError(null);
    setSuccess(null);
    try {
      const exceptions = modified.map((s) => {
        const item: {
          studentId: string;
          outcome: 'PROMOTED' | 'RETAINED' | 'PENDING_REVIEW' | 'GRADUATED';
          reason: string;
          targetCohortPeriodId?: string;
          targetSectionId?: string;
        } = {
          studentId: s.studentId,
          outcome: s.finalOutcome,
          reason: s.overrideReason!,
        };
        if (s.targetCohortPeriodId) item.targetCohortPeriodId = s.targetCohortPeriodId;
        if (s.targetSectionId) item.targetSectionId = s.targetSectionId;
        return item;
      });

      const updated = await updateRolloverExceptions(client, currentBatch.batchId, exceptions);
      setCurrentBatch(updated);
      setSuccess(
        exceptions.length > 0
          ? `Approved ${exceptions.length} override exception(s). Batch status is now APPROVED.`
          : 'Preview approved by Principal. Batch status is now APPROVED.',
      );
      const batchList = await fetchRolloverBatches(client);
      setBatches(batchList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save student overrides.');
    } finally {
      setSavingExceptions(false);
    }
  };

  const handleExecuteRollover = async () => {
    if (!currentBatch || !canManage) return;
    if (currentBatch.status !== 'APPROVED' && currentBatch.policy.mode === 'PRINCIPAL_APPROVAL') {
      setError('Rollover batch requires Principal Approval before execution.');
      return;
    }

    const confirmed = window.confirm(
      `Confirm execution of Academic Session Rollover from ${currentBatch.sourceTerm.name} to ${currentBatch.targetTerm.name}?\n\n` +
        `• ${currentBatch.summary.promoted} student(s) will be PROMOTED\n` +
        `• ${currentBatch.summary.retained} student(s) will be RETAINED\n` +
        `• ${currentBatch.summary.graduated} student(s) will GRADUATE\n` +
        `• ${currentBatch.summary.pendingReview} student(s) in review will be SKIPPED\n\n` +
        `This action updates academic year enrollment records and cannot be undone.`,
    );
    if (!confirmed) return;

    setExecuting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await executeRollover(client, currentBatch.batchId, {
        confirmPendingReviewHandling: 'SKIP',
        notifyGuardians: currentBatch.policy.notifyGuardians,
      });

      setSuccess(
        `Session Rollover successfully executed! Promoted: ${res.promotedCount}, ` +
          `Retained: ${res.retainedCount}, Graduated: ${res.graduatedCount}, Skipped: ${res.skippedCount}.`,
      );

      // Refresh current batch
      setCurrentBatch({
        ...currentBatch,
        status: 'EXECUTED',
        executedAt: res.executedAt,
      });

      const batchList = await fetchRolloverBatches(client);
      setBatches(batchList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute session rollover.');
    } finally {
      setExecuting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
        <Spinner label="Loading academic promotion policies and session rollover status..." />
      </div>
    );
  }

  const modifiedCount =
    currentBatch?.students.filter((s) => s.finalOutcome !== s.recommendedOutcome).length ?? 0;

  // Filter students in current batch
  const filteredStudents =
    currentBatch?.students.filter((s) => {
      if (outcomeFilter !== 'ALL' && s.finalOutcome !== outcomeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = s.fullName.toLowerCase().includes(q);
        const matchAdm = s.admissionNumber.toLowerCase().includes(q);
        return matchName || matchAdm;
      }
      return true;
    }) ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {error && <Alert tone="error">{error}</Alert>}
      {success && <Alert tone="success">{success}</Alert>}

      {/* Header Cards & Policy Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {/* Policy Configuration Card */}
        <Card title="Promotion & Rollover Policy">
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 'var(--space-3)',
            }}
          >
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
              School pass criteria, grace marks, and execution mode
            </p>
            {canManage && (
              <Button variant="secondary" onClick={() => setPolicyEditing(!policyEditing)}>
                {policyEditing ? 'Cancel' : 'Edit Policy'}
              </Button>
            )}
          </div>

          {!policyEditing ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                fontSize: '0.9rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Execution Mode:</span>
                <Badge tone={policy?.mode === 'AUTOMATIC' ? 'info' : 'brand'}>
                  {policy?.mode === 'PRINCIPAL_APPROVAL' ? 'Principal Approval' : policy?.mode}
                </Badge>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Min. Aggregate Pass:</span>
                <strong>{policy?.minimumAggregatePercentage}%</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Min. Subject Pass:</span>
                <strong>{policy?.minimumSubjectPercentage}%</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>
                  Max Supplementary Backlogs:
                </span>
                <strong>{policy?.maxFailingSubjectsForSupplementary} Subject(s)</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Grace Marks Policy:</span>
                <span>
                  {policy?.graceMarksPolicy.enabled
                    ? `Max ${policy.graceMarksPolicy.maxGraceMarksTotal} marks total (max ${policy.graceMarksPolicy.maxGraceMarksPerSubject}/subj)`
                    : 'Disabled'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Class 10 Stream Selection:</span>
                <span>Enabled (Period {policy?.streamSelectionPeriodNo})</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Class 12 Program Exit:</span>
                <span>Graduation (Period {policy?.terminalPeriodNo})</span>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div>
                <label
                  htmlFor="executionMode"
                  style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}
                >
                  Execution Mode
                </label>
                <select
                  id="executionMode"
                  style={{
                    width: '100%',
                    padding: 'var(--space-2)',
                    borderRadius: 'var(--radius-sm)',
                  }}
                  value={policyForm.mode ?? 'PRINCIPAL_APPROVAL'}
                  onChange={(e) =>
                    setPolicyForm({
                      ...policyForm,
                      mode: e.target.value as PromotionPolicy['mode'],
                    })
                  }
                >
                  <option value="PRINCIPAL_APPROVAL">
                    Principal Approval (Recommended Default)
                  </option>
                  <option value="MANUAL">Manual Execution</option>
                  <option value="AUTOMATIC">Fully Automatic Rollover</option>
                </select>
              </div>

              <div
                style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)' }}
              >
                <TextField
                  label="Min. Aggregate (%)"
                  type="number"
                  value={
                    policyForm.minimumAggregatePercentage !== undefined
                      ? String(policyForm.minimumAggregatePercentage)
                      : '33'
                  }
                  onChange={(e) =>
                    setPolicyForm({
                      ...policyForm,
                      minimumAggregatePercentage: parseFloat(e.target.value) || 0,
                    })
                  }
                />
                <TextField
                  label="Min. Subject (%)"
                  type="number"
                  value={
                    policyForm.minimumSubjectPercentage !== undefined
                      ? String(policyForm.minimumSubjectPercentage)
                      : '33'
                  }
                  onChange={(e) =>
                    setPolicyForm({
                      ...policyForm,
                      minimumSubjectPercentage: parseFloat(e.target.value) || 0,
                    })
                  }
                />
              </div>

              <TextField
                label="Max Failing Subjects for Supplementary"
                type="number"
                value={
                  policyForm.maxFailingSubjectsForSupplementary !== undefined
                    ? String(policyForm.maxFailingSubjectsForSupplementary)
                    : '2'
                }
                onChange={(e) =>
                  setPolicyForm({
                    ...policyForm,
                    maxFailingSubjectsForSupplementary: parseInt(e.target.value, 10) || 0,
                  })
                }
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <input
                  type="checkbox"
                  id="notifyGuardians"
                  checked={policyForm.notifyGuardians ?? true}
                  onChange={(e) =>
                    setPolicyForm({ ...policyForm, notifyGuardians: e.target.checked })
                  }
                />
                <label htmlFor="notifyGuardians" style={{ fontSize: '0.85rem' }}>
                  Notify students and guardians upon rollover confirmation
                </label>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <Button
                  variant="primary"
                  onClick={() => void handleSavePolicy()}
                  disabled={savingPolicy}
                >
                  {savingPolicy ? 'Saving...' : 'Save Policy'}
                </Button>
                <Button variant="secondary" onClick={() => setPolicyEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* Rollover Workbench Card */}
        <Card title="Annual Session Rollover Workbench">
          <p
            style={{
              margin: '0 0 var(--space-3) 0',
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
            }}
          >
            Select consecutive academic terms to evaluate student promotion and rollover
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            <div>
              <label
                htmlFor="sourceTerm"
                style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}
              >
                Source Academic Session (Current)
              </label>
              <select
                id="sourceTerm"
                style={{
                  width: '100%',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                }}
                value={sourceTermId}
                onChange={(e) => setSourceTermId(e.target.value)}
              >
                <option value="">Select source term...</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.startDate} to {t.endDate}) — {t.status}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="targetTerm"
                style={{ display: 'block', fontSize: '0.85rem', marginBottom: 'var(--space-1)' }}
              >
                Target Academic Session (New Intake)
              </label>
              <select
                id="targetTerm"
                style={{
                  width: '100%',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                }}
                value={targetTermId}
                onChange={(e) => setTargetTermId(e.target.value)}
              >
                <option value="">Select target term...</option>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.startDate} to {t.endDate}) — {t.status}
                  </option>
                ))}
              </select>
            </div>

            {canManage && (
              <Button
                variant="primary"
                onClick={() => void handleGeneratePreview()}
                disabled={generatingPreview || !sourceTermId || !targetTermId}
                style={{ marginTop: 'var(--space-1)' }}
              >
                {generatingPreview ? 'Calculating & Evaluating...' : 'Generate Promotion Preview'}
              </Button>
            )}
          </div>
        </Card>
      </div>

      {/* Active Batch Summary & KPIs */}
      {currentBatch && (
        <Card
          title={`Rollover Batch Preview: ${currentBatch.sourceTerm.name} → ${currentBatch.targetTerm.name}`}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              marginBottom: 'var(--space-4)',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <StatusBadge status={currentBatch.status} />
              </div>
              <p
                style={{
                  margin: '4px 0 0 0',
                  fontSize: '0.85rem',
                  color: 'var(--color-text-muted)',
                }}
              >
                Created: {new Date(currentBatch.createdAt).toLocaleString()} | Session Dates:{' '}
                {currentBatch.targetTerm.startDate} to {currentBatch.targetTerm.endDate}
              </p>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {canManage && currentBatch.status !== 'EXECUTED' && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => void handleSaveExceptions()}
                    disabled={savingExceptions}
                  >
                    {savingExceptions
                      ? 'Approving...'
                      : modifiedCount > 0
                        ? 'Approve Principal Overrides'
                        : 'Approve Preview (Principal)'}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void handleExecuteRollover()}
                    disabled={
                      executing ||
                      (currentBatch.status !== 'APPROVED' &&
                        currentBatch.policy.mode === 'PRINCIPAL_APPROVAL')
                    }
                  >
                    {executing ? 'Executing Rollover...' : 'Execute Rollover & Advance Students'}
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* 4-Bucket Summary Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
            }}
          >
            <div
              style={{
                padding: 'var(--space-3)',
                background: 'var(--color-surface-raised)',
                border: '1px solid var(--color-border)',
                borderLeft: '4px solid #16a34a',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                Promoted Students
              </span>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#16a34a' }}>
                {currentBatch.summary.promoted}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Advance to next period
              </span>
            </div>

            <div
              style={{
                padding: 'var(--space-3)',
                background: 'var(--color-surface-raised)',
                border: '1px solid var(--color-border)',
                borderLeft: '4px solid #d97706',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                Retained Students
              </span>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#d97706' }}>
                {currentBatch.summary.retained}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Repeat in junior cohort
              </span>
            </div>

            <div
              style={{
                padding: 'var(--space-3)',
                background: 'var(--color-surface-raised)',
                border: '1px solid var(--color-border)',
                borderLeft: '4px solid #dc2626',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                Pending Review
              </span>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#dc2626' }}>
                {currentBatch.summary.pendingReview}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Incomplete marks / holds
              </span>
            </div>

            <div
              style={{
                padding: 'var(--space-3)',
                background: 'var(--color-surface-raised)',
                border: '1px solid var(--color-border)',
                borderLeft: '4px solid #2563eb',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-muted)',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                }}
              >
                Graduated (Class 12)
              </span>
              <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#2563eb' }}>
                {currentBatch.summary.graduated}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                Program completed
              </span>
            </div>
          </div>

          {/* Student Review Table */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {(['ALL', 'PROMOTED', 'RETAINED', 'PENDING_REVIEW', 'GRADUATED'] as const).map(
                (filter) => (
                  <Button
                    key={filter}
                    variant={outcomeFilter === filter ? 'primary' : 'secondary'}
                    onClick={() => setOutcomeFilter(filter)}
                  >
                    {filter}
                  </Button>
                ),
              )}
            </div>

            <div style={{ width: '260px' }}>
              <TextField
                label="Search Filter"
                placeholder="Search student or admission no..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                fontSize: '0.85rem',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '2px solid var(--color-border)',
                    background: 'var(--color-surface-raised)',
                  }}
                >
                  <th style={{ padding: 'var(--space-2)' }}>Admission No</th>
                  <th style={{ padding: 'var(--space-2)' }}>Student Name</th>
                  <th style={{ padding: 'var(--space-2)' }}>Current Grade</th>
                  <th style={{ padding: 'var(--space-2)' }}>Exam Marks / Details</th>
                  <th style={{ padding: 'var(--space-2)' }}>Recommended</th>
                  <th style={{ padding: 'var(--space-2)' }}>Final Decision</th>
                  <th style={{ padding: 'var(--space-2)' }}>Target Grade & Section</th>
                  <th style={{ padding: 'var(--space-2)' }}>Override Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        padding: 'var(--space-4)',
                        textAlign: 'center',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      No students match the selected filter.
                    </td>
                  </tr>
                ) : (
                  filteredStudents.map((st) => (
                    <tr
                      key={st.studentId}
                      style={{ borderBottom: '1px solid var(--color-border)' }}
                    >
                      <td style={{ padding: 'var(--space-2)', fontFamily: 'monospace' }}>
                        {st.admissionNumber}
                      </td>
                      <td style={{ padding: 'var(--space-2)', fontWeight: 600 }}>{st.fullName}</td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        Grade {st.currentPeriodNo}
                        {st.currentSectionName && ` (${st.currentSectionName})`}
                      </td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        {st.evaluationDetails.aggregatePercentage !== null ? (
                          <div>
                            <strong>{st.evaluationDetails.aggregatePercentage}%</strong> aggregate
                            {st.evaluationDetails.appliedGraceMarks > 0 && (
                              <span style={{ color: '#d97706', marginLeft: '4px' }}>
                                (+{st.evaluationDetails.appliedGraceMarks} grace)
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)' }}>No formal marks</span>
                        )}
                        {st.evaluationDetails.notes.length > 0 && (
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--color-text-muted)',
                              marginTop: '2px',
                            }}
                          >
                            {st.evaluationDetails.notes.slice(0, 2).join(' • ')}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        <Badge
                          tone={
                            st.recommendedOutcome === 'PROMOTED'
                              ? 'positive'
                              : st.recommendedOutcome === 'RETAINED'
                                ? 'warning'
                                : st.recommendedOutcome === 'GRADUATED'
                                  ? 'info'
                                  : 'danger'
                          }
                        >
                          {st.recommendedOutcome}
                        </Badge>
                      </td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        {canManage && currentBatch.status !== 'EXECUTED' ? (
                          <select
                            style={{
                              padding: 'var(--space-1)',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.8rem',
                            }}
                            value={st.finalOutcome}
                            onChange={(e) =>
                              handleOverrideStudent(
                                st.studentId,
                                e.target.value as RolloverStudentEvaluation['finalOutcome'],
                                st.overrideReason ?? 'Principal administrative override',
                              )
                            }
                          >
                            <option value="PROMOTED">PROMOTED</option>
                            <option value="RETAINED">RETAINED</option>
                            <option value="PENDING_REVIEW">PENDING_REVIEW</option>
                            <option value="GRADUATED">GRADUATED</option>
                          </select>
                        ) : (
                          <Badge tone={st.finalOutcome === 'PROMOTED' ? 'positive' : 'neutral'}>
                            {st.finalOutcome}
                          </Badge>
                        )}
                      </td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        {st.targetPeriodNo ? (
                          <span>
                            Grade {st.targetPeriodNo}
                            {st.targetSectionName && ` (${st.targetSectionName})`}
                          </span>
                        ) : st.finalOutcome === 'GRADUATED' ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>Graduated</span>
                        ) : (
                          <span style={{ color: '#dc2626' }}>On Hold</span>
                        )}
                      </td>
                      <td style={{ padding: 'var(--space-2)' }}>
                        {st.finalOutcome !== st.recommendedOutcome ? (
                          canManage && currentBatch.status !== 'EXECUTED' ? (
                            <input
                              type="text"
                              placeholder="Reason required..."
                              style={{ width: '100%', padding: '4px', fontSize: '0.8rem' }}
                              value={st.overrideReason ?? ''}
                              onChange={(e) =>
                                handleOverrideStudent(st.studentId, st.finalOutcome, e.target.value)
                              }
                            />
                          ) : (
                            <span style={{ fontSize: '0.8rem' }}>{st.overrideReason}</span>
                          )
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                            Standard
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Batch History */}
      <Card title="Past Rollover Batches">
        <p
          style={{
            margin: '0 0 var(--space-3) 0',
            fontSize: '0.85rem',
            color: 'var(--color-text-muted)',
          }}
        >
          Audit records of all previous promotions and academic year rollovers
        </p>

        {batches.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
            No previous rollover batches recorded for this institution.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                fontSize: '0.85rem',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '2px solid var(--color-border)',
                    background: 'var(--color-surface-raised)',
                  }}
                >
                  <th style={{ padding: 'var(--space-2)' }}>Batch ID</th>
                  <th style={{ padding: 'var(--space-2)' }}>Source Term</th>
                  <th style={{ padding: 'var(--space-2)' }}>Target Term</th>
                  <th style={{ padding: 'var(--space-2)' }}>Status</th>
                  <th style={{ padding: 'var(--space-2)' }}>Summary Breakdown</th>
                  <th style={{ padding: 'var(--space-2)' }}>Created At</th>
                  <th style={{ padding: 'var(--space-2)' }}>Executed At</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.batchId} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: 'var(--space-2)', fontFamily: 'monospace' }}>
                      {b.batchId.slice(0, 8)}...
                    </td>
                    <td style={{ padding: 'var(--space-2)' }}>{b.sourceTermName}</td>
                    <td style={{ padding: 'var(--space-2)' }}>{b.targetTermName}</td>
                    <td style={{ padding: 'var(--space-2)' }}>
                      <StatusBadge status={b.status} />
                    </td>
                    <td style={{ padding: 'var(--space-2)' }}>
                      {b.summary.totalStudents} total (Promoted: {b.summary.promoted}, Retained:{' '}
                      {b.summary.retained}, Graduated: {b.summary.graduated})
                    </td>
                    <td style={{ padding: 'var(--space-2)' }}>
                      {new Date(b.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: 'var(--space-2)' }}>
                      {b.executedAt ? new Date(b.executedAt).toLocaleString() : 'Not executed'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
