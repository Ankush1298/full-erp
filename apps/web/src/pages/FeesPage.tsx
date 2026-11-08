import { useEffect, useState } from 'react';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Dialog } from '../components/ui/Dialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { TextField } from '../components/ui/TextField';
import { Button } from '../components/ui/Button';
import { Alert } from '../components/ui/Alert';
import { Card } from '../components/ui/Card';
import {
  fetchFeeCategories,
  createFeeCategory,
  fetchFeeStructures,
  createFeeStructure,
  generateStudentDues,
  fetchStudentDues,
  fetchStudentLedger,
  recordOfflineReceipt,
  fetchFeeReceipts,
  reverseReceipt,
  fetchCollectionSummary,
  type FeeCategoryDto,
  type FeeStructureDto,
  type StudentDueDto,
  type FeeReceiptDto,
  type StudentLedgerDto,
  type CollectionSummaryDto,
  type PaymentMethod,
} from '../lib/api/finance-api';

function formatMoney(minorUnits: number, currency = 'INR'): string {
  const major = minorUnits / 100;
  return major.toLocaleString('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function FeesPage() {
  const { client, identity } = useAuth();
  const isStudent = identity?.actorKind === 'STUDENT';

  const canManageStructure = identity ? can(identity, 'fee.structure.manage') : false;
  const canGenerateDues = identity ? can(identity, 'fee.dues.generate') : false;
  const canRecordReceipt = identity ? can(identity, 'fee.receipt.record') : false;
  const canReverseReceipt = identity ? can(identity, 'fee.receipt.reverse') : false;

  // Active Tab
  const [activeTab, setActiveTab] = useState<'overview' | 'structures' | 'dues' | 'receipts' | 'my-ledger'>(
    isStudent ? 'my-ledger' : 'overview',
  );

  // Data states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const [summary, setSummary] = useState<CollectionSummaryDto | null>(null);
  const [categories, setCategories] = useState<FeeCategoryDto[]>([]);
  const [structures, setStructures] = useState<FeeStructureDto[]>([]);
  const [dues, setDues] = useState<StudentDueDto[]>([]);
  const [receipts, setReceipts] = useState<FeeReceiptDto[]>([]);
  const [studentLedger, setStudentLedger] = useState<StudentLedgerDto | null>(null);

  // Modals
  const [showCreateCategoryModal, setShowCreateCategoryModal] = useState(false);
  const [showCreateStructureModal, setShowCreateStructureModal] = useState(false);
  const [showGenerateDuesModal, setShowGenerateDuesModal] = useState(false);
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<FeeReceiptDto | null>(null);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reversalReason, setReversalReason] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // Form states for Category
  const [newCatCode, setNewCatCode] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');

  // Form states for Structure
  const [newStructCode, setNewStructCode] = useState('');
  const [newStructName, setNewStructName] = useState('');
  const [newStructDueDate, setNewStructDueDate] = useState('');
  const [structComponents, setStructComponents] = useState<Array<{ fee_category_id: string; amount: string; description: string }>>([
    { fee_category_id: '', amount: '', description: '' },
  ]);

  // Form states for Dues Generation
  const [selectedStructureId, setSelectedStructureId] = useState('');
  const [targetStudentIds, setTargetStudentIds] = useState('');
  const [concessionStudentId, setConcessionStudentId] = useState('');
  const [concessionAmount, setConcessionAmount] = useState('');
  const [concessionReason, setConcessionReason] = useState('');

  // Form states for Payment Recording
  const [payStudentId, setPayStudentId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('CASH');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payRemarks, setPayRemarks] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isStudent && identity?.userId) {
        // Fetch student ledger
        const ledger = await fetchStudentLedger(client, identity.userId);
        setStudentLedger(ledger);
      } else {
        const [sumRes, catsRes, structsRes, duesRes, recsRes] = await Promise.all([
          fetchCollectionSummary(client).catch(() => null),
          fetchFeeCategories(client).catch(() => []),
          fetchFeeStructures(client).catch(() => []),
          fetchStudentDues(client).catch(() => []),
          fetchFeeReceipts(client).catch(() => []),
        ]);
        setSummary(sumRes);
        setCategories(catsRes);
        setStructures(structsRes);
        setDues(duesRes);
        setReceipts(recsRes);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load finance data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent, identity?.userId]);

  const handleCreateCategory = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    void (async () => {
      try {
        await createFeeCategory(client, {
          code: newCatCode.toUpperCase(),
          name: newCatName,
          description: newCatDesc || undefined,
        });
        setShowCreateCategoryModal(false);
        setNewCatCode('');
        setNewCatName('');
        setNewCatDesc('');
        setActionSuccess('Fee category created successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create fee category');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleCreateStructure = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    void (async () => {
      try {
        // Find campus from context or default
        const compPayload = structComponents
          .filter((c) => c.fee_category_id && Number(c.amount) > 0)
          .map((c) => ({
            fee_category_id: c.fee_category_id,
            amount: Math.round(Number(c.amount) * 100), // convert to minor units
            description: c.description || undefined,
          }));

        if (compPayload.length === 0) {
          throw new Error('At least one fee component with positive amount is required.');
        }

        await createFeeStructure(client, {
          campus_id: 'camp-1',
          academic_year_id: 'y1',
          code: newStructCode.toUpperCase(),
          name: newStructName,
          currency: 'INR',
          due_date: newStructDueDate,
          components: compPayload,
        });

        setShowCreateStructureModal(false);
        setNewStructCode('');
        setNewStructName('');
        setNewStructDueDate('');
        setStructComponents([{ fee_category_id: '', amount: '', description: '' }]);
        setActionSuccess('Fee structure created successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create fee structure');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleGenerateDues = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    void (async () => {
      try {
        const sIds = targetStudentIds
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);

        const concessions = concessionStudentId && Number(concessionAmount) > 0
          ? [
              {
                student_id: concessionStudentId.trim(),
                discount_amount: Math.round(Number(concessionAmount) * 100),
                reason: concessionReason.trim() || 'Institutional concession',
              },
            ]
          : undefined;

        const res = await generateStudentDues(client, {
          fee_structure_id: selectedStructureId,
          student_ids: sIds.length > 0 ? sIds : undefined,
          concessions,
        });

        setShowGenerateDuesModal(false);
        setSelectedStructureId('');
        setTargetStudentIds('');
        setConcessionStudentId('');
        setConcessionAmount('');
        setConcessionReason('');
        setActionSuccess(`Generated ${res.generated_count} dues (${res.skipped_count} skipped/existing).`);
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to generate dues');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleRecordPayment = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    void (async () => {
      try {
        const amtMinor = Math.round(Number(payAmount) * 100);
        if (amtMinor <= 0) throw new Error('Payment amount must be positive.');

        await recordOfflineReceipt(client, {
          campus_id: 'camp-1',
          student_id: payStudentId.trim(),
          amount: amtMinor,
          payment_method: payMethod,
          payment_date: payDate,
          reference_number: payRef.trim() || undefined,
          reconciliation_status: payMethod === 'CASH' ? 'CONFIRMED' : 'PENDING_VERIFICATION',
          remarks: payRemarks.trim() || undefined,
        });

        setShowRecordPaymentModal(false);
        setPayStudentId('');
        setPayAmount('');
        setPayRef('');
        setPayRemarks('');
        setActionSuccess('Offline payment recorded successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record offline payment');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleReverseReceipt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReceipt) return;
    setActionSubmitting(true);
    void (async () => {
      try {
        await reverseReceipt(client, selectedReceipt.id, {
          reason: reversalReason.trim(),
        });
        setShowReverseModal(false);
        setSelectedReceipt(null);
        setReversalReason('');
        setActionSuccess('Receipt reversed and balances rolled back successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reverse receipt');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  if (loading) {
    return (
      <div className="finance-loading p-8 flex flex-col items-center justify-center min-h-[350px]">
        <Spinner />
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">Loading financial records...</p>
      </div>
    );
  }

  const outstandingTotal = dues
    .filter((d) => d.status !== 'CANCELLED' && d.status !== 'WAIVED')
    .reduce((acc, d) => acc + d.balance_amount, 0);

  return (
    <div className="finance-page p-6 max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Fees & Finance Management"
        subtitle={
          isStudent
            ? 'View your assessed academic dues, payment history, and verified receipts.'
            : 'Manage fee structures, student dues assessments, offline payments, and reconciliation.'
        }
        actions={
          !isStudent ? (
            <div className="flex flex-wrap items-center gap-3">
              {canManageStructure && (
                <Button
                  variant="secondary"
                  onClick={() => setShowCreateStructureModal(true)}
                >
                  Create Fee Structure
                </Button>
              )}
              {canGenerateDues && (
                <Button
                  variant="secondary"
                  onClick={() => setShowGenerateDuesModal(true)}
                >
                  Generate Dues
                </Button>
              )}
              {canRecordReceipt && (
                <Button
                  variant="primary"
                  onClick={() => setShowRecordPaymentModal(true)}
                >
                  Record Offline Payment
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {error && (
        <Alert tone="error">
          {error}
        </Alert>
      )}

      {actionSuccess && (
        <Alert tone="success">
          {actionSuccess}
        </Alert>
      )}

      {/* Navigation Tabs */}
      <nav aria-label="Finance Navigation Tabs" className="border-b border-[var(--color-border-subtle)] pb-2 flex gap-4">
        {!isStudent && (
          <>
            <button
              type="button"
              className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
                activeTab === 'overview'
                  ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
              }`}
              onClick={() => setActiveTab('overview')}
            >
              Overview & Collections
            </button>
            <button
              type="button"
              className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
                activeTab === 'structures'
                  ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
              }`}
              onClick={() => setActiveTab('structures')}
            >
              Fee Structures ({structures.length})
            </button>
            <button
              type="button"
              className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
                activeTab === 'dues'
                  ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
              }`}
              onClick={() => setActiveTab('dues')}
            >
              Student Dues ({dues.length})
            </button>
            <button
              type="button"
              className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
                activeTab === 'receipts'
                  ? 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold'
                  : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]'
              }`}
              onClick={() => setActiveTab('receipts')}
            >
              Receipts & Reversals ({receipts.length})
            </button>
          </>
        )}
        {isStudent && (
          <button
            type="button"
            className="px-4 py-2 font-medium text-sm rounded-lg bg-[var(--color-primary-subtle)] text-[var(--color-primary)] font-semibold"
          >
            My Fee Ledger
          </button>
        )}
      </nav>

      {/* Tab: Overview & Collections */}
      {activeTab === 'overview' && !isStudent && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Total Net Collected"
              value={formatMoney(summary?.total_collected ?? 0)}
              helper="Verified and posted collections"
              tone="purple"
            />
            <StatCard
              label="Total Outstanding Dues"
              value={formatMoney(outstandingTotal)}
              helper="Remaining balances across students"
              tone="coral"
            />
            <StatCard
              label="Active Receipts"
              value={summary?.receipt_count ?? receipts.filter((r) => r.status === 'POSTED').length}
              helper="Posted transactions"
              tone="emerald"
            />
            <StatCard
              label="Reversed Receipts"
              value={summary?.reversed_count ?? receipts.filter((r) => r.status === 'REVERSED').length}
              helper="Audited rollbacks"
              tone="amber"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card title="Collections by Payment Method">
              <div className="space-y-3 pt-3">
                {Object.entries(summary?.by_payment_method ?? {}).map(([method, amount]) => (
                  <div key={method} className="flex justify-between items-center py-2 border-b border-[var(--color-border-subtle)] last:border-0">
                    <span className="text-sm font-medium">{method.replace(/_/g, ' ')}</span>
                    <span className="font-semibold text-sm">{formatMoney(amount)}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="Reconciliation Status Breakdown">
              <div className="space-y-3 pt-3">
                {Object.entries(summary?.by_reconciliation_status ?? {}).map(([status, amount]) => (
                  <div key={status} className="flex justify-between items-center py-2 border-b border-[var(--color-border-subtle)] last:border-0">
                    <span className="flex items-center gap-2">
                      <StatusBadge status={status} />
                    </span>
                    <span className="font-semibold text-sm">{formatMoney(amount)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* Tab: Fee Structures */}
      {activeTab === 'structures' && !isStudent && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-[var(--color-fg-muted)]">
              Institution fee schedules, broken down into itemized categories.
            </p>
            {canManageStructure && (
              <Button
                variant="secondary"
                onClick={() => setShowCreateCategoryModal(true)}
              >
                Manage Categories ({categories.length})
              </Button>
            )}
          </div>

          {structures.length === 0 ? (
            <EmptyState
              title="No Fee Structures Configured"
              description="Create standard fee structures with categorized tuition and lab components."
              action={
                canManageStructure ? (
                  <Button variant="primary" onClick={() => setShowCreateStructureModal(true)}>
                    Create First Fee Structure
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] border-b border-[var(--color-border-subtle)]">
                  <tr>
                    <th className="p-3">Code</th>
                    <th className="p-3">Name</th>
                    <th className="p-3">Components</th>
                    <th className="p-3">Total Amount</th>
                    <th className="p-3">Due Date</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {structures.map((s) => (
                    <tr key={s.id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                      <td className="p-3 font-mono font-medium">{s.code}</td>
                      <td className="p-3 font-medium text-[var(--color-fg-default)]">{s.name}</td>
                      <td className="p-3 text-[var(--color-fg-muted)]">
                        {s.components.length} item{s.components.length !== 1 ? 's' : ''}
                      </td>
                      <td className="p-3 font-semibold text-[var(--color-fg-default)]">
                        {formatMoney(s.total_amount, s.currency)}
                      </td>
                      <td className="p-3 text-[var(--color-fg-muted)]">{s.due_date}</td>
                      <td className="p-3">
                        <StatusBadge status={s.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Student Dues */}
      {activeTab === 'dues' && !isStudent && (
        <div className="space-y-4">
          {dues.length === 0 ? (
            <EmptyState
              title="No Student Dues Generated"
              description="Generate dues for students from an active fee structure to begin billing."
              action={
                canGenerateDues ? (
                  <Button variant="primary" onClick={() => setShowGenerateDuesModal(true)}>
                    Generate Dues
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] border-b border-[var(--color-border-subtle)]">
                  <tr>
                    <th className="p-3">Due #</th>
                    <th className="p-3">Student</th>
                    <th className="p-3">Fee Structure</th>
                    <th className="p-3">Gross</th>
                    <th className="p-3">Concession</th>
                    <th className="p-3">Paid</th>
                    <th className="p-3">Balance Remaining</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Due Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {dues.map((d) => (
                    <tr key={d.id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                      <td className="p-3 font-mono font-medium">{d.due_number}</td>
                      <td className="p-3">
                        <div className="font-medium text-[var(--color-fg-default)]">{d.student_name || 'Student'}</div>
                        <div className="text-xs text-[var(--color-fg-muted)] font-mono">{d.admission_number || d.student_id.slice(0, 8)}</div>
                      </td>
                      <td className="p-3">{d.fee_structure_name || 'Standard Structure'}</td>
                      <td className="p-3">{formatMoney(d.gross_amount)}</td>
                      <td className="p-3 text-[var(--color-accent-coral)]">{d.discount_amount > 0 ? `-${formatMoney(d.discount_amount)}` : '—'}</td>
                      <td className="p-3 font-medium text-[var(--color-accent-emerald)]">{formatMoney(d.paid_amount)}</td>
                      <td className="p-3 font-bold text-[var(--color-fg-default)]">{formatMoney(d.balance_amount)}</td>
                      <td className="p-3">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="p-3 text-[var(--color-fg-muted)]">{d.due_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Receipts & Offline Payments */}
      {activeTab === 'receipts' && !isStudent && (
        <div className="space-y-4">
          {receipts.length === 0 ? (
            <EmptyState
              title="No Receipts Recorded"
              description="Offline receipts (Cash, Bank Transfer, Cheque, UPI) recorded by operators appear here."
              action={
                canRecordReceipt ? (
                  <Button variant="primary" onClick={() => setShowRecordPaymentModal(true)}>
                    Record Payment
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
              <table className="w-full text-left text-sm">
                <thead className="bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] border-b border-[var(--color-border-subtle)]">
                  <tr>
                    <th className="p-3">Receipt #</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Student</th>
                    <th className="p-3">Method</th>
                    <th className="p-3">Reference #</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Reconciliation</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {receipts.map((r) => (
                    <tr key={r.id} className="hover:bg-[var(--color-bg-subtle)] transition-colors">
                      <td className="p-3 font-mono font-medium">{r.receipt_number}</td>
                      <td className="p-3 text-[var(--color-fg-muted)]">{r.payment_date}</td>
                      <td className="p-3">
                        <div className="font-medium text-[var(--color-fg-default)]">{r.student_name || 'Student'}</div>
                        <div className="text-xs text-[var(--color-fg-muted)] font-mono">{r.admission_number || r.student_id.slice(0, 8)}</div>
                      </td>
                      <td className="p-3 font-medium">{r.payment_method.replace(/_/g, ' ')}</td>
                      <td className="p-3 font-mono text-xs text-[var(--color-fg-muted)]">{r.reference_number || '—'}</td>
                      <td className="p-3 font-semibold text-[var(--color-fg-default)]">{formatMoney(r.amount, r.currency)}</td>
                      <td className="p-3">
                        <StatusBadge status={r.reconciliation_status} />
                      </td>
                      <td className="p-3">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="p-3">
                        <Button
                          variant="secondary"
                          onClick={() => setSelectedReceipt(r)}
                        >
                          View Receipt
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Tab: Student Self-Service Ledger */}
      {(isStudent || activeTab === 'my-ledger') && studentLedger && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="Assessed Net Fees"
              value={formatMoney(studentLedger.total_net, studentLedger.currency)}
              helper="Total tuition and term fees"
              tone="purple"
            />
            <StatCard
              label="Total Amount Paid"
              value={formatMoney(studentLedger.total_paid, studentLedger.currency)}
              helper="Confirmed payments & receipts"
              tone="emerald"
            />
            <StatCard
              label="Remaining Balance"
              value={formatMoney(studentLedger.total_balance, studentLedger.currency)}
              helper="Outstanding balance due"
              tone={studentLedger.total_balance > 0 ? 'coral' : 'emerald'}
            />
          </div>

          <Card title="Assigned Fee Dues">
            {studentLedger.dues.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)] pt-3">No dues currently assigned.</p>
            ) : (
              <div className="divide-y divide-[var(--color-border-subtle)] pt-3">
                {studentLedger.dues.map((d) => (
                  <div key={d.id} className="py-3 flex justify-between items-center">
                    <div>
                      <div className="font-medium text-sm text-[var(--color-fg-default)]">{d.fee_structure_name || 'Academic Fee'}</div>
                      <div className="text-xs text-[var(--color-fg-muted)] font-mono">Due: {d.due_number} | Due Date: {d.due_date}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold text-sm">{formatMoney(d.balance_amount)} balance</div>
                      <div className="text-xs text-[var(--color-fg-muted)]">{formatMoney(d.paid_amount)} of {formatMoney(d.net_amount)} paid</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Payment History & Receipts">
            {studentLedger.receipts.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-muted)] pt-3">No receipts recorded yet.</p>
            ) : (
              <div className="divide-y divide-[var(--color-border-subtle)] pt-3">
                {studentLedger.receipts.map((r) => (
                  <div key={r.id} className="py-3 flex justify-between items-center">
                    <div>
                      <div className="font-medium text-sm text-[var(--color-fg-default)]">
                        {r.payment_method.replace(/_/g, ' ')} Payment
                      </div>
                      <div className="text-xs text-[var(--color-fg-muted)] font-mono">
                        Receipt: {r.receipt_number} | Date: {r.payment_date}
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="font-semibold text-sm">{formatMoney(r.amount, r.currency)}</div>
                        <StatusBadge status={r.status} />
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => setSelectedReceipt(r)}
                      >
                        Print Receipt
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Modal: Create Fee Category */}
      <Dialog
        open={showCreateCategoryModal}
        onClose={() => setShowCreateCategoryModal(false)}
        title="Create Fee Category"
        description="Define an institutional fee head (e.g. Tuition, Laboratory, Library)."
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowCreateCategoryModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleCreateCategory} disabled={actionSubmitting}>
              {actionSubmitting ? 'Creating...' : 'Create Category'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleCreateCategory} className="space-y-4">
          <TextField
            label="Category Code (Uppercase)"
            value={newCatCode}
            onChange={(e) => setNewCatCode(e.target.value.toUpperCase())}
            placeholder="e.g. TUIT, LAB, LIB"
            required
          />
          <TextField
            label="Category Name"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="e.g. Tuition Fee"
            required
          />
          <TextField
            label="Description"
            value={newCatDesc}
            onChange={(e) => setNewCatDesc(e.target.value)}
            placeholder="Optional purpose notes"
          />
        </form>
      </Dialog>

      {/* Modal: Create Fee Structure */}
      <Dialog
        open={showCreateStructureModal}
        onClose={() => setShowCreateStructureModal(false)}
        title="Create Fee Structure"
        description="Bundle multiple categorized components into a billing structure with exact minor-unit arithmetic."
        maxWidth="lg"
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowCreateStructureModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleCreateStructure} disabled={actionSubmitting}>
              {actionSubmitting ? 'Saving...' : 'Save Structure'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleCreateStructure} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <TextField
              label="Structure Code"
              value={newStructCode}
              onChange={(e) => setNewStructCode(e.target.value.toUpperCase())}
              placeholder="e.g. STR-UG-2026-T1"
              required
            />
            <TextField
              label="Structure Name"
              value={newStructName}
              onChange={(e) => setNewStructName(e.target.value)}
              placeholder="e.g. Semester 1 Standard Fee"
              required
            />
            <TextField
              label="Due Date"
              type="date"
              value={newStructDueDate}
              onChange={(e) => setNewStructDueDate(e.target.value)}
              required
            />
          </div>

          <div className="border-t border-[var(--color-border-subtle)] pt-4">
            <div className="flex justify-between items-center mb-2">
              <h4 className="text-sm font-semibold">Fee Components</h4>
              <Button
                variant="secondary"
                type="button"
                onClick={() =>
                  setStructComponents([...structComponents, { fee_category_id: '', amount: '', description: '' }])
                }
              >
                + Add Component
              </Button>
            </div>

            <div className="space-y-3">
              {structComponents.map((comp, idx) => (
                <div key={idx} className="flex flex-wrap sm:flex-nowrap gap-2 items-center">
                  <select
                    className="h-10 px-3 py-2 text-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] flex-1"
                    value={comp.fee_category_id}
                    onChange={(e) => {
                      const updated = [...structComponents];
                      if (updated[idx]) updated[idx].fee_category_id = e.target.value;
                      setStructComponents(updated);
                    }}
                    required
                  >
                    <option value="">Select Category...</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    step="0.01"
                    placeholder="Amount (e.g. 5000.00)"
                    className="h-10 px-3 py-2 text-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] w-36"
                    value={comp.amount}
                    onChange={(e) => {
                      const updated = [...structComponents];
                      if (updated[idx]) updated[idx].amount = e.target.value;
                      setStructComponents(updated);
                    }}
                    required
                  />

                  <input
                    type="text"
                    placeholder="Component description"
                    className="h-10 px-3 py-2 text-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] flex-1"
                    value={comp.description}
                    onChange={(e) => {
                      const updated = [...structComponents];
                      if (updated[idx]) updated[idx].description = e.target.value;
                      setStructComponents(updated);
                    }}
                  />

                  {structComponents.length > 1 && (
                    <Button
                      variant="ghost"
                      className="text-red-600"
                      type="button"
                      onClick={() => setStructComponents(structComponents.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </form>
      </Dialog>

      {/* Modal: Generate Dues */}
      <Dialog
        open={showGenerateDuesModal}
        onClose={() => setShowGenerateDuesModal(false)}
        title="Generate Student Dues"
        description="Assess student dues from an active fee structure with deterministic idempotency."
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowGenerateDuesModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleGenerateDues} disabled={actionSubmitting}>
              {actionSubmitting ? 'Generating...' : 'Generate Dues'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleGenerateDues} className="space-y-4">
          <div>
            <label htmlFor="fee-structure-select" className="block text-sm font-medium mb-1">Fee Structure</label>
            <select
              id="fee-structure-select"
              className="w-full h-10 px-3 py-2 text-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]"
              value={selectedStructureId}
              onChange={(e) => setSelectedStructureId(e.target.value)}
              required
            >
              <option value="">Select structure...</option>
              {structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code}) — {formatMoney(s.total_amount)}
                </option>
              ))}
            </select>
          </div>

          <TextField
            label="Target Student UUIDs (Comma or newline separated, leave empty for all enrolled)"
            value={targetStudentIds}
            onChange={(e) => setTargetStudentIds(e.target.value)}
            placeholder="e.g. 01a1b..., 01a1b..."
          />

          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <h4 className="text-xs font-semibold text-[var(--color-fg-muted)] mb-2 uppercase">Optional Student Concession / Scholarship</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="Student UUID"
                className="h-9 px-2 text-xs rounded border border-[var(--color-border-subtle)]"
                value={concessionStudentId}
                onChange={(e) => setConcessionStudentId(e.target.value)}
              />
              <input
                type="number"
                step="0.01"
                placeholder="Discount Amount"
                className="h-9 px-2 text-xs rounded border border-[var(--color-border-subtle)]"
                value={concessionAmount}
                onChange={(e) => setConcessionAmount(e.target.value)}
              />
              <input
                type="text"
                placeholder="Scholarship Reason"
                className="h-9 px-2 text-xs rounded border border-[var(--color-border-subtle)]"
                value={concessionReason}
                onChange={(e) => setConcessionReason(e.target.value)}
              />
            </div>
          </div>
        </form>
      </Dialog>

      {/* Modal: Record Offline Payment */}
      <Dialog
        open={showRecordPaymentModal}
        onClose={() => setShowRecordPaymentModal(false)}
        title="Record Offline Payment"
        description="Record cash, bank transfer, cheque, or UPI reference with automated allocation."
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowRecordPaymentModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleRecordPayment} disabled={actionSubmitting}>
              {actionSubmitting ? 'Recording...' : 'Record Payment'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleRecordPayment} className="space-y-4">
          <TextField
            label="Student UUID"
            value={payStudentId}
            onChange={(e) => setPayStudentId(e.target.value)}
            placeholder="Student account ID"
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField
              label="Amount Received (in major units, e.g. 3000.00)"
              type="number"
              step="0.01"
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              required
            />
            <div>
              <label htmlFor="pay-method-select" className="block text-sm font-medium mb-1">Payment Method</label>
              <select
                id="pay-method-select"
                className="w-full h-10 px-3 py-2 text-sm rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                required
              >
                <option value="CASH">Cash Deposit</option>
                <option value="BANK_TRANSFER">Bank Wire / NEFT / RTGS</option>
                <option value="CHEQUE">Cheque / Demand Draft</option>
                <option value="UPI_REFERENCE">UPI Reference</option>
                <option value="OTHER_OFFLINE">Other Offline</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField
              label="External Reference / UTR Number"
              value={payRef}
              onChange={(e) => setPayRef(e.target.value)}
              placeholder="e.g. UTR-HDFC-123456"
            />
            <TextField
              label="Payment Date"
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              required
            />
          </div>

          <TextField
            label="Cashier Remarks"
            value={payRemarks}
            onChange={(e) => setPayRemarks(e.target.value)}
            placeholder="e.g. Deposited at main administration counter"
          />
        </form>
      </Dialog>

      {/* Modal: View & Print Stamped Official Receipt */}
      {selectedReceipt && (
        <Dialog
          open={Boolean(selectedReceipt)}
          onClose={() => setSelectedReceipt(null)}
          title={`Official Fee Receipt — ${selectedReceipt.receipt_number}`}
          description="Institutional verified proof of offline payment."
          maxWidth="lg"
          footer={
            <div className="flex justify-between items-center w-full">
              <div>
                {!isStudent && canReverseReceipt && selectedReceipt.status === 'POSTED' && (
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => setShowReverseModal(true)}
                  >
                    Reverse Receipt
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setSelectedReceipt(null)}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => window.print()}>
                  Print Receipt
                </Button>
              </div>
            </div>
          }
        >
          <div className="p-6 border border-[var(--color-border-subtle)] rounded-xl bg-white text-gray-900 space-y-6 print:border-0 print:p-0">
            {/* Header */}
            <div className="text-center border-b pb-4">
              <h2 className="text-xl font-bold tracking-tight">ANESA CAMPUS OS</h2>
              <p className="text-xs text-gray-500 uppercase tracking-widest">Official Fee Acknowledgment Receipt</p>
            </div>

            {/* Receipt Meta */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Receipt Number</p>
                <p className="font-mono font-bold">{selectedReceipt.receipt_number}</p>
                <p className="text-xs text-gray-500 mt-2">Payment Date</p>
                <p className="font-medium">{selectedReceipt.payment_date}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Student Name</p>
                <p className="font-bold">{selectedReceipt.student_name || 'Enrolled Student'}</p>
                <p className="text-xs text-gray-500 mt-2">Admission Number</p>
                <p className="font-mono">{selectedReceipt.admission_number || selectedReceipt.student_id.slice(0, 10)}</p>
              </div>
            </div>

            {/* Payment Details */}
            <div className="border rounded-lg p-3 bg-gray-50 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Payment Method:</span>
                <span className="font-semibold">{selectedReceipt.payment_method.replace(/_/g, ' ')}</span>
              </div>
              {selectedReceipt.reference_number && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Reference Number:</span>
                  <span className="font-mono">{selectedReceipt.reference_number}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Reconciliation Status:</span>
                <span className="font-semibold text-emerald-700">{selectedReceipt.reconciliation_status}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Receipt Status:</span>
                <span className="font-semibold">{selectedReceipt.status}</span>
              </div>
            </div>

            {/* Allocations Breakdown */}
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Applied Dues Allocation</h4>
              {selectedReceipt.allocations.length === 0 ? (
                <p className="text-xs text-gray-400">Allocated to account balance</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-gray-500">
                      <th className="py-1 text-left">Due Number</th>
                      <th className="py-1 text-right">Allocated Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedReceipt.allocations.map((a) => (
                      <tr key={a.id} className="border-b">
                        <td className="py-2 font-mono">{a.due_number || a.student_due_id.slice(0, 8)}</td>
                        <td className="py-2 text-right font-medium">{formatMoney(a.allocated_amount, selectedReceipt.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Total Stamped Box */}
            <div className="flex justify-between items-center border-t-2 border-gray-900 pt-4">
              <div>
                <p className="text-xs text-gray-500">Receiving Cashier / Operator</p>
                <p className="text-sm font-medium">{selectedReceipt.received_by_name || 'Accounts Office'}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-500">Total Amount Received</p>
                <p className="text-2xl font-black text-gray-950">
                  {formatMoney(selectedReceipt.amount, selectedReceipt.currency)}
                </p>
              </div>
            </div>

            {selectedReceipt.status === 'REVERSED' && (
              <div className="bg-red-50 border border-red-200 text-red-800 p-3 rounded-lg text-xs">
                <p className="font-bold">RECEIPT REVERSED</p>
                <p>Reason: {selectedReceipt.reversal_reason || 'Administrative Reversal'}</p>
                <p className="text-gray-500 mt-1">Reversed At: {selectedReceipt.reversed_at}</p>
              </div>
            )}
          </div>
        </Dialog>
      )}

      {/* Modal: Step-Up Reversal Reason */}
      <Dialog
        open={showReverseModal}
        onClose={() => setShowReverseModal(false)}
        title="Confirm Receipt Reversal"
        description="CRITICAL ACTION: Reversing this receipt will restore student balances and audit the reversal. Step-up authorization is required."
        footer={
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setShowReverseModal(false)}>
              Cancel
            </Button>
            <Button variant="secondary" className="btn-danger text-red-600" onClick={handleReverseReceipt} disabled={actionSubmitting || reversalReason.trim().length < 5}>
              {actionSubmitting ? 'Reversing...' : 'Confirm Reversal'}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleReverseReceipt} className="space-y-4">
          <TextField
            label="Mandatory Audit Reversal Reason (Min 5 chars)"
            value={reversalReason}
            onChange={(e) => setReversalReason(e.target.value)}
            placeholder="e.g. Wrong bank UTR reference entered by counter cashier"
            required
          />
        </form>
      </Dialog>
    </div>
  );
}
