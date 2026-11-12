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
  fetchGatewayConfigs,
  saveGatewayConfig,
  testGatewayConnection,
  initiateOnlinePayment,
  verifyOnlinePayment,
  fetchPaymentAttempts,
  refundPayment,
  fetchReconciliationReport,
  type FeeCategoryDto,
  type FeeStructureDto,
  type StudentDueDto,
  type FeeReceiptDto,
  type StudentLedgerDto,
  type CollectionSummaryDto,
  type GatewayConfigDto,
  type PaymentAttemptDto,
  type ReconciliationReportDto,
  type PaymentGatewayProvider,
  type GatewayMode,
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
  const canManageGateway = identity ? can(identity, 'fee.gateway.manage') : false;
  const canReadGateway = identity ? can(identity, 'fee.gateway.read') : false;
  const canInitiatePayment = identity ? can(identity, 'fee.payment.initiate') : false;
  const canRefund = identity ? can(identity, 'fee.refund.initiate') : false;

  // Active Tab
  const [activeTab, setActiveTab] = useState<
    | 'overview'
    | 'structures'
    | 'dues'
    | 'online-payments'
    | 'offline-payments'
    | 'receipts'
    | 'gateway-settings'
    | 'reconciliation'
    | 'my-ledger'
  >(isStudent ? 'my-ledger' : 'overview');

  // Data states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const [summary, setSummary] = useState<CollectionSummaryDto | null>(null);
  const [categories, setCategories] = useState<FeeCategoryDto[]>([]);
  const [structures, setStructures] = useState<FeeStructureDto[]>([]);
  const [dues, setDues] = useState<StudentDueDto[]>([]);
  const [receipts, setReceipts] = useState<FeeReceiptDto[]>([]);
  const [gatewayConfigs, setGatewayConfigs] = useState<GatewayConfigDto[]>([]);
  const [paymentAttempts, setPaymentAttempts] = useState<PaymentAttemptDto[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationReportDto | null>(null);
  const [studentLedger, setStudentLedger] = useState<StudentLedgerDto | null>(null);

  // Modals
  const [showCreateCategoryModal, setShowCreateCategoryModal] = useState(false);
  const [showCreateStructureModal, setShowCreateStructureModal] = useState(false);
  const [showGenerateDuesModal, setShowGenerateDuesModal] = useState(false);
  const [selectedReceipt, setSelectedReceipt] = useState<FeeReceiptDto | null>(null);
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reversalReason, setReversalReason] = useState('');
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundReceipt, setRefundReceipt] = useState<FeeReceiptDto | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);

  // Form states for Category
  const [newCatCode, setNewCatCode] = useState('');
  const [newCatName, setNewCatName] = useState('');
  const [newCatDesc, setNewCatDesc] = useState('');

  // Form states for Structure
  const [newStructCode, setNewStructCode] = useState('');
  const [newStructName, setNewStructName] = useState('');
  const [newStructDueDate, setNewStructDueDate] = useState('');
  const [structComponents, setStructComponents] = useState<
    Array<{ fee_category_id: string; amount: string; description: string }>
  >([{ fee_category_id: '', amount: '', description: '' }]);

  // Form states for Dues Generation
  const [selectedStructureId, setSelectedStructureId] = useState('');
  const [targetStudentIds, setTargetStudentIds] = useState('');
  const [concessionStudentId, setConcessionStudentId] = useState('');
  const [concessionAmount, setConcessionAmount] = useState('');
  const [concessionReason, setConcessionReason] = useState('');

  // Form states for Offline Payment Recording
  const [payStudentId, setPayStudentId] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('CASH');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payRemarks, setPayRemarks] = useState('');

  // Form states for Payment Gateway Settings
  const [gwProvider, setGwProvider] = useState<PaymentGatewayProvider>('RAZORPAY');
  const [gwMode, setGwMode] = useState<GatewayMode>('SANDBOX');
  const [gwMerchantKey, setGwMerchantKey] = useState('');
  const [gwSecretKey, setGwSecretKey] = useState('');
  const [gwWebhookSecret, setGwWebhookSecret] = useState('');
  const [gwPhonePeSaltIndex, setGwPhonePeSaltIndex] = useState('1');
  const [gwIsActive, setGwIsActive] = useState(false);
  const [gwTestResult, setGwTestResult] = useState<{ healthy: boolean; message: string } | null>(
    null,
  );
  const [gwTesting, setGwTesting] = useState(false);

  // Online Checkout modal states (Student/Parent or Admin online pay)
  const [showPayOnlineModal, setShowPayOnlineModal] = useState(false);
  const [payOnlineDue, setPayOnlineDue] = useState<StudentDueDto | null>(null);
  const [payOnlineAmount, setPayOnlineAmount] = useState('');
  const [onlinePayInitiating, setOnlinePayInitiating] = useState(false);
  const [onlinePayResult, setOnlinePayResult] = useState<{
    attemptReference: string;
    orderReference: string;
    provider: string;
    checkoutPayload: Record<string, unknown>;
    redirectUrl?: string | undefined;
  } | null>(null);
  const [onlinePaySimulating, setOnlinePaySimulating] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (isStudent && identity?.userId) {
        // Fetch student ledger
        const ledger = await fetchStudentLedger(client, identity.userId);
        setStudentLedger(ledger);
      } else {
        const [sumRes, catsRes, structsRes, duesRes, recsRes, gwRes, attsRes, reconRes] =
          await Promise.all([
            fetchCollectionSummary(client).catch(() => null),
            fetchFeeCategories(client).catch(() => []),
            fetchFeeStructures(client).catch(() => []),
            fetchStudentDues(client).catch(() => []),
            fetchFeeReceipts(client).catch(() => []),
            canReadGateway || canManageGateway
              ? fetchGatewayConfigs(client).catch(() => [])
              : Promise.resolve([]),
            fetchPaymentAttempts(client).catch(() => []),
            fetchReconciliationReport(client).catch(() => null),
          ]);
        setSummary(sumRes);
        setCategories(catsRes);
        setStructures(structsRes);
        setDues(duesRes);
        setReceipts(recsRes);
        setGatewayConfigs(gwRes);
        setPaymentAttempts(attsRes);
        setReconciliation(reconRes);
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
        const compPayload = structComponents
          .filter((c) => c.fee_category_id && Number(c.amount) > 0)
          .map((c) => ({
            fee_category_id: c.fee_category_id,
            amount: Math.round(Number(c.amount) * 100),
            description: c.description || undefined,
          }));

        if (compPayload.length === 0) {
          throw new Error('Please add at least one fee component with a valid amount.');
        }

        await createFeeStructure(client, {
          campus_id: 'camp-1',
          academic_year_id: 'y1',
          code: newStructCode.toUpperCase(),
          name: newStructName,
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
    if (!selectedStructureId) return;
    setActionSubmitting(true);
    void (async () => {
      try {
        const sids = targetStudentIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

        const concessions =
          concessionStudentId && Number(concessionAmount) > 0 && concessionReason
            ? [
                {
                  student_id: concessionStudentId,
                  discount_amount: Math.round(Number(concessionAmount) * 100),
                  reason: concessionReason,
                },
              ]
            : undefined;

        const res = await generateStudentDues(client, {
          fee_structure_id: selectedStructureId,
          student_ids: sids.length > 0 ? sids : undefined,
          concessions,
        });

        setShowGenerateDuesModal(false);
        setSelectedStructureId('');
        setTargetStudentIds('');
        setConcessionStudentId('');
        setConcessionAmount('');
        setConcessionReason('');
        setActionSuccess(`Generated ${res.generated_count} student dues assessments successfully.`);
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to generate dues');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleRecordOfflinePayment = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    void (async () => {
      try {
        const minorUnits = Math.round(Number(payAmount) * 100);
        await recordOfflineReceipt(client, {
          campus_id: 'camp-1',
          student_id: payStudentId,
          amount: minorUnits,
          payment_method: payMethod,
          payment_date: payDate,
          reference_number: payRef || undefined,
          remarks: payRemarks || undefined,
        });

        setPayStudentId('');
        setPayAmount('');
        setPayRef('');
        setPayRemarks('');
        setActionSuccess('Offline fee payment receipt recorded successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to record offline receipt');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleReverseReceipt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedReceipt || !reversalReason) return;
    setActionSubmitting(true);
    void (async () => {
      try {
        await reverseReceipt(client, selectedReceipt.id, { reason: reversalReason });
        setShowReverseModal(false);
        setSelectedReceipt(null);
        setReversalReason('');
        setActionSuccess('Receipt reversed successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reverse receipt');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleSaveGateway = (e: React.FormEvent) => {
    e.preventDefault();
    setActionSubmitting(true);
    setGwTestResult(null);
    void (async () => {
      try {
        await saveGatewayConfig(client, {
          provider: gwProvider,
          mode: gwMode,
          is_active: gwIsActive,
          merchant_key: gwMerchantKey,
          secret_key: gwSecretKey,
          webhook_secret: gwWebhookSecret || undefined,
          settings: gwProvider === 'PHONEPE' ? { salt_index: gwPhonePeSaltIndex } : {},
        });
        setActionSuccess(`Payment gateway ${gwProvider} configured successfully.`);
        setGwSecretKey('');
        setGwWebhookSecret('');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save gateway configuration');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  const handleTestGatewayConnection = () => {
    if (!gwMerchantKey || !gwSecretKey) {
      setError('Please provide merchant key and secret key to test connection.');
      return;
    }
    setGwTesting(true);
    setGwTestResult(null);
    void (async () => {
      try {
        const res = await testGatewayConnection(client, {
          provider: gwProvider,
          mode: gwMode,
          merchant_key: gwMerchantKey,
          secret_key: gwSecretKey,
          webhook_secret: gwWebhookSecret || undefined,
          settings: gwProvider === 'PHONEPE' ? { salt_index: gwPhonePeSaltIndex } : {},
        });
        setGwTestResult(res);
      } catch (err) {
        setGwTestResult({
          healthy: false,
          message: err instanceof Error ? err.message : 'Connection test failed',
        });
      } finally {
        setGwTesting(false);
      }
    })();
  };

  const handleOpenOnlinePayModal = (due: StudentDueDto) => {
    setPayOnlineDue(due);
    setPayOnlineAmount((due.balance_amount / 100).toFixed(2));
    setOnlinePayResult(null);
    setShowPayOnlineModal(true);
  };

  const handleInitiateOnlineCheckout = () => {
    if (!payOnlineDue || !payOnlineAmount) return;
    setOnlinePayInitiating(true);
    setError(null);
    void (async () => {
      try {
        const minorUnits = Math.round(Number(payOnlineAmount) * 100);
        const res = await initiateOnlinePayment(client, {
          student_id: payOnlineDue.student_id,
          student_due_id: payOnlineDue.id,
          amount: minorUnits,
          campus_id: payOnlineDue.campus_id,
          description: `Fee Payment for ${payOnlineDue.due_number}`,
        });
        setOnlinePayResult({
          attemptReference: res.attempt_reference,
          orderReference: res.order_reference,
          provider: res.provider,
          checkoutPayload: res.checkout_payload,
          redirectUrl: res.redirect_url,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initiate online checkout');
      } finally {
        setOnlinePayInitiating(false);
      }
    })();
  };

  const handleCompleteOnlineVerification = (attemptRef: string, mockPaymentRef: string) => {
    setOnlinePaySimulating(true);
    void (async () => {
      try {
        const res = await verifyOnlinePayment(client, {
          attempt_reference: attemptRef,
          gateway_payment_ref: mockPaymentRef,
          gateway_signature: 'sig_verified_mock',
        });
        if (res.success) {
          setActionSuccess(
            `Payment completed and verified! Receipt ${res.receipt_number || ''} issued.`,
          );
          setShowPayOnlineModal(false);
          setOnlinePayResult(null);
          await loadData();
        } else {
          setError(res.failure_reason || 'Payment verification failed at gateway');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Payment verification failed');
      } finally {
        setOnlinePaySimulating(false);
      }
    })();
  };

  const handleInitiateRefund = (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundReceipt || !refundAmount || !refundReason) return;
    setActionSubmitting(true);
    void (async () => {
      try {
        const minorUnits = Math.round(Number(refundAmount) * 100);
        await refundPayment(client, refundReceipt.id, {
          amount: minorUnits,
          reason: refundReason,
        });
        setShowRefundModal(false);
        setRefundReceipt(null);
        setRefundAmount('');
        setRefundReason('');
        setActionSuccess('Online payment refund processed successfully.');
        await loadData();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to process refund');
      } finally {
        setActionSubmitting(false);
      }
    })();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={isStudent ? 'My Fee Ledger' : 'Fees & Finance Management'}
        subtitle={
          isStudent
            ? 'View your term fees, outstanding dues, pay online via secure gateway, and access receipts.'
            : 'Manage fee structures, dues assessments, offline collections, multi-gateway online payments, and reconciliation.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {!isStudent && canRecordReceipt && (
              <Button
                variant="primary"
                onClick={() => {
                  setActiveTab('offline-payments');
                }}
              >
                Record Offline Payment
              </Button>
            )}
            {!isStudent && canManageStructure && (
              <Button variant="secondary" onClick={() => setShowCreateStructureModal(true)}>
                + New Fee Structure
              </Button>
            )}
            {!isStudent && canManageStructure && (
              <Button variant="ghost" onClick={() => setShowCreateCategoryModal(true)}>
                + Fee Category
              </Button>
            )}
          </div>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {actionSuccess && <Alert tone="success">{actionSuccess}</Alert>}

      {/* Navigation Tabs */}
      {!isStudent && (
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-6 overflow-x-auto">
            <button
              onClick={() => setActiveTab('overview')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'overview'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Overview & Collections
            </button>
            <button
              onClick={() => setActiveTab('structures')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'structures'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Fee Structures ({structures.length})
            </button>
            <button
              onClick={() => setActiveTab('dues')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'dues'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Student Dues ({dues.length})
            </button>
            <button
              onClick={() => setActiveTab('online-payments')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'online-payments'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Online Payments ({paymentAttempts.length})
            </button>
            <button
              onClick={() => setActiveTab('offline-payments')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'offline-payments'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Offline Payments
            </button>
            <button
              onClick={() => setActiveTab('receipts')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'receipts'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Receipts & Reversals ({receipts.length})
            </button>
            {(canReadGateway || canManageGateway) && (
              <button
                onClick={() => setActiveTab('gateway-settings')}
                className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeTab === 'gateway-settings'
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Gateway Settings
              </button>
            )}
            <button
              onClick={() => setActiveTab('reconciliation')}
              className={`py-3 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === 'reconciliation'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Reconciliation
            </button>
          </nav>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-12">
          <Spinner />
        </div>
      ) : (
        <>
          {/* 1. Overview & Collections */}
          {activeTab === 'overview' && !isStudent && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <StatCard
                  label="Total Collections"
                  value={formatMoney(summary?.total_collected || 0, summary?.currency || 'INR')}
                  helper={`${summary?.receipt_count || 0} valid receipts posted`}
                  tone="emerald"
                />
                <StatCard
                  label="Active Online Gateways"
                  value={
                    gatewayConfigs.find((g) => g.is_active)?.provider
                      ? `${gatewayConfigs.find((g) => g.is_active)?.provider} (${gatewayConfigs.find((g) => g.is_active)?.mode})`
                      : 'None configured'
                  }
                  helper={
                    gatewayConfigs.some((g) => g.is_active)
                      ? 'Accepting online fee payments'
                      : 'Configure gateway in settings'
                  }
                  tone="purple"
                />
                <StatCard
                  label="Online Transactions"
                  value={paymentAttempts.filter((a) => a.status === 'SUCCESS').length.toString()}
                  helper={`${paymentAttempts.length} total checkout sessions`}
                  tone="purple"
                />
                <StatCard
                  label="Reversals / Refunds"
                  value={(summary?.reversed_count || 0).toString()}
                  helper="Authorized cancellations"
                  tone="coral"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <Card title="Collections by Payment Method">
                  <div className="space-y-3 pt-2">
                    {summary?.by_payment_method &&
                    Object.keys(summary.by_payment_method).length > 0 ? (
                      Object.entries(summary.by_payment_method).map(([method, count]) => (
                        <div key={method} className="flex justify-between items-center text-sm">
                          <span className="font-medium text-gray-700">{method}</span>
                          <span className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded text-xs font-semibold">
                            {count} receipts
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-gray-500 text-sm">No payment records found.</p>
                    )}
                  </div>
                </Card>

                <Card title="Payment Gateway Multi-Tenant Status">
                  <div className="space-y-3 pt-2">
                    {gatewayConfigs.length === 0 ? (
                      <div className="text-sm text-gray-500">
                        No payment gateways configured. School is operating in offline-only mode.
                      </div>
                    ) : (
                      gatewayConfigs.map((g) => (
                        <div
                          key={g.id}
                          className="flex justify-between items-center p-3 rounded-lg border border-gray-100 bg-gray-50/50"
                        >
                          <div>
                            <div className="font-semibold text-sm text-gray-800 flex items-center space-x-2">
                              <span>{g.provider}</span>
                              <span className="text-xs px-2 py-0.5 bg-gray-200 rounded text-gray-700">
                                {g.mode}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 font-mono">
                              Key: {g.merchant_key_masked}
                            </div>
                          </div>
                          <div>
                            {g.is_active ? (
                              <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded font-bold">
                                ACTIVE
                              </span>
                            ) : (
                              <span className="text-gray-400 text-xs">Standby</span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </Card>
              </div>
            </div>
          )}

          {/* 2. Fee Structures Tab */}
          {activeTab === 'structures' && !isStudent && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-800">Academic Fee Structures</h3>
                {canManageStructure && (
                  <Button variant="primary" onClick={() => setShowCreateStructureModal(true)}>
                    + New Structure
                  </Button>
                )}
              </div>

              {structures.length === 0 ? (
                <EmptyState
                  title="No Fee Structures Configured"
                  description="Define institutional fee structures with line item components and due dates."
                  action={
                    canManageStructure ? (
                      <Button variant="primary" onClick={() => setShowCreateStructureModal(true)}>
                        Create Structure
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {structures.map((s) => (
                    <Card key={s.id} title={`${s.name} (${s.code})`}>
                      <div className="space-y-3 text-sm">
                        <div className="flex justify-between py-1 border-b border-gray-100">
                          <span className="text-gray-500">Total Amount:</span>
                          <span className="font-bold text-gray-900">
                            {formatMoney(s.total_amount, s.currency)}
                          </span>
                        </div>
                        <div className="flex justify-between py-1 border-b border-gray-100">
                          <span className="text-gray-500">Due Date:</span>
                          <span className="font-medium text-gray-800">{s.due_date}</span>
                        </div>
                        <div className="pt-2">
                          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                            Components ({s.components?.length || 0})
                          </div>
                          <div className="space-y-1">
                            {s.components?.map((c) => (
                              <div
                                key={c.id}
                                className="flex justify-between text-xs text-gray-600"
                              >
                                <span>{c.category_name || c.category_code}</span>
                                <span>{formatMoney(c.amount, s.currency)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        {canGenerateDues && (
                          <div className="pt-2">
                            <Button
                              variant="secondary"
                              className="w-full"
                              onClick={() => {
                                setSelectedStructureId(s.id);
                                setShowGenerateDuesModal(true);
                              }}
                            >
                              Generate Dues from Structure
                            </Button>
                          </div>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 3. Student Dues Tab */}
          {activeTab === 'dues' && !isStudent && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-800">Student Dues Assessments</h3>
                {canGenerateDues && (
                  <Button variant="primary" onClick={() => setShowGenerateDuesModal(true)}>
                    + Generate Dues Batch
                  </Button>
                )}
              </div>

              {dues.length === 0 ? (
                <EmptyState
                  title="No Student Dues Recorded"
                  description="Generate term dues for enrolled students based on approved fee structures."
                />
              ) : (
                <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Due Number
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Student</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Structure</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">Gross</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">Discount</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">Balance</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Status</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {dues.map((d) => (
                        <tr key={d.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-xs">{d.due_number}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900">{d.student_name}</div>
                            <div className="text-xs text-gray-500">{d.admission_number}</div>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{d.fee_structure_name}</td>
                          <td className="px-4 py-3 text-right">{formatMoney(d.gross_amount)}</td>
                          <td className="px-4 py-3 text-right text-green-600">
                            {d.discount_amount > 0 ? `-${formatMoney(d.discount_amount)}` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">
                            {formatMoney(d.balance_amount)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <StatusBadge status={d.status} />
                          </td>
                          <td className="px-4 py-3 text-center">
                            {d.balance_amount > 0 && canInitiatePayment && (
                              <Button
                                variant="secondary"
                                onClick={() => handleOpenOnlinePayModal(d)}
                              >
                                Collect Online
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 4. Online Payments Tab */}
          {activeTab === 'online-payments' && !isStudent && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-semibold text-gray-800">
                    Online Gateway Payment Attempts
                  </h3>
                  <p className="text-xs text-gray-500">
                    Real-time status of online checkout sessions via Razorpay, Cashfree, and
                    PhonePe.
                  </p>
                </div>
              </div>

              {paymentAttempts.length === 0 ? (
                <EmptyState
                  title="No Online Payment Sessions"
                  description="When students or administrators initiate online payments, checkout sessions and verification statuses will appear here."
                />
              ) : (
                <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Attempt Ref
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Student</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Gateway</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Status</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Gateway Reference
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Created At
                        </th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {paymentAttempts.map((att) => (
                        <tr key={att.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-xs font-semibold text-blue-600">
                            {att.attempt_reference}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900">{att.student_name}</div>
                            <div className="text-xs text-gray-500">{att.admission_number}</div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-semibold text-gray-800">{att.provider}</span>
                            <span className="ml-1 text-xs text-gray-500">({att.mode})</span>
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">
                            {formatMoney(att.amount, att.currency)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <StatusBadge status={att.status} />
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-gray-600">
                            {att.gateway_payment_ref || att.order_reference || '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {att.created_at ? new Date(att.created_at).toLocaleString() : '—'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {att.status !== 'SUCCESS' && (
                              <Button
                                variant="secondary"
                                onClick={() => {
                                  void (async () => {
                                    try {
                                      const res = await verifyOnlinePayment(client, {
                                        attempt_reference: att.attempt_reference,
                                        gateway_payment_ref:
                                          att.gateway_payment_ref || 'pay_manual_reverify',
                                      });
                                      if (res.success) {
                                        setActionSuccess(
                                          `Verified! Receipt ${res.receipt_number || ''} issued.`,
                                        );
                                        await loadData();
                                      } else {
                                        setError(res.failure_reason || 'Status not yet successful');
                                      }
                                    } catch (err) {
                                      setError(
                                        err instanceof Error ? err.message : 'Verification failed',
                                      );
                                    }
                                  })();
                                }}
                              >
                                Re-verify
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 5. Offline Payments Tab */}
          {activeTab === 'offline-payments' && !isStudent && (
            <div className="space-y-6 max-w-2xl mx-auto">
              <Card title="Record Offline Fee Collection">
                <p className="text-sm text-gray-500 mb-4">
                  Record verified payments made via Cash, Cheque, Demand Draft, Bank Transfer, or
                  POS/Manual UPI.
                </p>
                <form onSubmit={handleRecordOfflinePayment} className="space-y-4 pt-2">
                  <TextField
                    label="Student ID / Selection *"
                    value={payStudentId}
                    onChange={(e) => setPayStudentId(e.target.value)}
                    placeholder="e.g. st-1"
                    required
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <TextField
                      label="Amount (₹) *"
                      type="number"
                      step="0.01"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder="5000.00"
                      required
                    />

                    <TextField
                      label="Payment Date *"
                      type="date"
                      value={payDate}
                      onChange={(e) => setPayDate(e.target.value)}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="field">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Payment Method *
                      </label>
                      <select
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                      >
                        <option value="CASH">Cash</option>
                        <option value="CHEQUE">Cheque / DD</option>
                        <option value="BANK_TRANSFER">Bank Transfer (NEFT/RTGS/IMPS)</option>
                        <option value="UPI_REFERENCE">Manual UPI Reference / QR</option>
                        <option value="OTHER_OFFLINE">Other Offline</option>
                      </select>
                    </div>

                    <TextField
                      label="Reference / Instrument Number"
                      value={payRef}
                      onChange={(e) => setPayRef(e.target.value)}
                      placeholder="Cheque # or UTR / UPI Ref"
                    />
                  </div>

                  <TextField
                    label="Internal Remarks"
                    value={payRemarks}
                    onChange={(e) => setPayRemarks(e.target.value)}
                    placeholder="e.g. Deposited in SBI Bank Account #456"
                  />

                  <div className="pt-2 flex justify-end">
                    <Button type="submit" variant="primary" disabled={actionSubmitting}>
                      {actionSubmitting ? 'Posting Receipt...' : 'Generate Fee Receipt'}
                    </Button>
                  </div>
                </form>
              </Card>
            </div>
          )}

          {/* 6. Receipts & Reversals Tab */}
          {activeTab === 'receipts' && !isStudent && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-800">
                  Fee Payment Receipts Repository
                </h3>
              </div>

              {receipts.length === 0 ? (
                <EmptyState
                  title="No Fee Receipts Found"
                  description="All receipts generated from online gateway transactions and offline collections will be archived here."
                />
              ) : (
                <div className="overflow-x-auto bg-white rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Receipt Number
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Student</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">
                          Payment Date
                        </th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500">Method</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Status</th>
                        <th className="px-4 py-3 text-center font-medium text-gray-500">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {receipts.map((r) => (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono text-xs font-semibold">
                            {r.receipt_number}
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-gray-900">{r.student_name}</div>
                            <div className="text-xs text-gray-500">{r.admission_number}</div>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{r.payment_date}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-0.5 rounded text-xs font-medium ${
                                r.payment_method.startsWith('ONLINE_')
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}
                            >
                              {r.payment_method}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900">
                            {formatMoney(r.amount, r.currency)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-4 py-3 text-center space-x-2">
                            <Button variant="secondary" onClick={() => setSelectedReceipt(r)}>
                              Voucher
                            </Button>
                            {r.status === 'POSTED' &&
                              r.payment_method.startsWith('ONLINE_') &&
                              canRefund && (
                                <Button
                                  variant="secondary"
                                  onClick={() => {
                                    setRefundReceipt(r);
                                    setRefundAmount((r.amount / 100).toFixed(2));
                                    setShowRefundModal(true);
                                  }}
                                >
                                  Refund
                                </Button>
                              )}
                            {r.status === 'POSTED' && canReverseReceipt && (
                              <Button
                                variant="secondary"
                                className="text-red-600 hover:text-red-700"
                                onClick={() => {
                                  setSelectedReceipt(r);
                                  setShowReverseModal(true);
                                }}
                              >
                                Reverse
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 7. Payment Gateway Settings Tab */}
          {activeTab === 'gateway-settings' && !isStudent && (
            <div className="space-y-6 max-w-4xl mx-auto">
              <Card title="School Merchant Payment Gateway Setup">
                <p className="text-sm text-gray-500 mb-4">
                  Configure the payment gateway accounts used by Anesa to accept online fee payments
                  for your institution.
                </p>
                <form onSubmit={handleSaveGateway} className="space-y-4 pt-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="field">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Gateway Provider *
                      </label>
                      <select
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-semibold"
                        value={gwProvider}
                        onChange={(e) => setGwProvider(e.target.value as PaymentGatewayProvider)}
                      >
                        <option value="RAZORPAY">Razorpay</option>
                        <option value="CASHFREE">Cashfree Payments</option>
                        <option value="PHONEPE">PhonePe Payment Gateway</option>
                      </select>
                    </div>

                    <div className="field">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Environment Mode *
                      </label>
                      <select
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        value={gwMode}
                        onChange={(e) => setGwMode(e.target.value as GatewayMode)}
                      >
                        <option value="SANDBOX">Sandbox / Test Mode (Recommended initially)</option>
                        <option value="LIVE">Live Production Mode</option>
                      </select>
                    </div>

                    <div className="flex items-center pt-6">
                      <label className="flex items-center space-x-2 text-sm font-medium text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          checked={gwIsActive}
                          onChange={(e) => setGwIsActive(e.target.checked)}
                        />
                        <span>Set as Active Gateway for School</span>
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <TextField
                      label={
                        gwProvider === 'RAZORPAY'
                          ? 'Key ID (rzp_test_... / rzp_live_...) *'
                          : gwProvider === 'CASHFREE'
                            ? 'App ID / Client ID *'
                            : 'Merchant ID (MID) *'
                      }
                      value={gwMerchantKey}
                      onChange={(e) => setGwMerchantKey(e.target.value)}
                      placeholder="Enter merchant public ID"
                      required
                    />

                    <TextField
                      label={
                        gwProvider === 'PHONEPE'
                          ? 'Salt Key (API Secret) *'
                          : 'Secret Key / Client Secret *'
                      }
                      type="password"
                      value={gwSecretKey}
                      onChange={(e) => setGwSecretKey(e.target.value)}
                      placeholder="AES-256 encrypted at rest"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <TextField
                      label="Webhook Secret (Optional / Recommended)"
                      type="password"
                      value={gwWebhookSecret}
                      onChange={(e) => setGwWebhookSecret(e.target.value)}
                      placeholder="Used to verify asynchronous webhook signatures"
                    />

                    {gwProvider === 'PHONEPE' && (
                      <TextField
                        label="PhonePe Salt Index"
                        value={gwPhonePeSaltIndex}
                        onChange={(e) => setGwPhonePeSaltIndex(e.target.value)}
                        placeholder="Typically 1"
                      />
                    )}
                  </div>

                  {gwTestResult && (
                    <Alert tone={gwTestResult.healthy ? 'success' : 'error'}>
                      {gwTestResult.message}
                    </Alert>
                  )}

                  <div className="flex justify-between items-center pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleTestGatewayConnection}
                      disabled={gwTesting}
                    >
                      {gwTesting ? 'Testing Connectivity...' : 'Test Connection'}
                    </Button>

                    <Button type="submit" variant="primary" disabled={actionSubmitting}>
                      {actionSubmitting ? 'Saving...' : 'Save & Encrypt Gateway Config'}
                    </Button>
                  </div>
                </form>
              </Card>

              {/* Configured Gateways List */}
              <div className="space-y-3">
                <h4 className="font-semibold text-gray-800 text-sm">
                  Configured Gateways for School
                </h4>
                {gatewayConfigs.length === 0 ? (
                  <p className="text-gray-500 text-sm">No gateways configured yet.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {gatewayConfigs.map((g) => (
                      <div
                        key={g.id}
                        className={`p-4 rounded-lg border ${
                          g.is_active ? 'border-blue-500 bg-blue-50/20' : 'border-gray-200 bg-white'
                        }`}
                      >
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="font-bold text-gray-900 flex items-center space-x-2">
                              <span>{g.provider}</span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded font-semibold ${
                                  g.mode === 'LIVE'
                                    ? 'bg-purple-100 text-purple-800'
                                    : 'bg-yellow-100 text-yellow-800'
                                }`}
                              >
                                {g.mode}
                              </span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1 font-mono">
                              Merchant Key: {g.merchant_key_masked}
                            </div>
                          </div>
                          {g.is_active ? (
                            <span className="bg-green-100 text-green-800 text-xs px-2 py-1 rounded font-bold">
                              ACTIVE GATEWAY
                            </span>
                          ) : (
                            <span className="text-gray-400 text-xs">Inactive</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 8. Reconciliation Tab */}
          {activeTab === 'reconciliation' && !isStudent && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <StatCard
                  label="Online Volume"
                  value={formatMoney(reconciliation?.total_successful_online_amount || 0)}
                  helper={`${reconciliation?.total_successful_online_count || 0} successful sessions`}
                  tone="purple"
                />
                <StatCard
                  label="Offline Volume"
                  value={formatMoney(reconciliation?.total_offline_receipt_amount || 0)}
                  helper={`${reconciliation?.total_offline_receipt_count || 0} cash/cheque/bank vouchers`}
                  tone="purple"
                />
                <StatCard
                  label="Success Rate"
                  value={
                    reconciliation?.total_online_attempts
                      ? `${Math.round(
                          ((reconciliation.total_successful_online_count || 0) /
                            reconciliation.total_online_attempts) *
                            100,
                        )}%`
                      : '100%'
                  }
                  helper={`${reconciliation?.total_failed_online_count || 0} dropped/failed sessions`}
                  tone="emerald"
                />
                <StatCard
                  label="Discrepancies"
                  value={(reconciliation?.mismatches?.length || 0).toString()}
                  helper="Items requiring review"
                  tone="coral"
                />
              </div>

              <Card title="Automated Financial Reconciliation & Settlement Log">
                <p className="text-sm text-gray-500 mb-4">
                  Cross-references external payment provider checkout responses against Anesa
                  general ledger entries.
                </p>
                {reconciliation?.mismatches && reconciliation.mismatches.length > 0 ? (
                  <div className="overflow-x-auto pt-2">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium text-gray-500">
                            Attempt Ref
                          </th>
                          <th className="px-4 py-2 text-left font-medium text-gray-500">
                            Provider
                          </th>
                          <th className="px-4 py-2 text-right font-medium text-gray-500">Amount</th>
                          <th className="px-4 py-2 text-left font-medium text-gray-500">
                            Discrepancy Issue
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {reconciliation.mismatches.map((m, idx) => (
                          <tr key={idx} className="bg-red-50/30">
                            <td className="px-4 py-2 font-mono text-xs">{m.attempt_reference}</td>
                            <td className="px-4 py-2">{m.provider}</td>
                            <td className="px-4 py-2 text-right font-semibold">
                              {formatMoney(m.attempt_amount)}
                            </td>
                            <td className="px-4 py-2 text-red-700 text-xs font-medium">
                              {m.issue}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4 text-center text-sm text-gray-600">
                    All online gateway transactions and offline vouchers are fully reconciled with
                    100% integrity.
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* 9. Student / Parent Portal View (My Ledger) */}
          {activeTab === 'my-ledger' && (
            <div className="space-y-6">
              {studentLedger ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <StatCard
                      label="Total Assessed Fees"
                      value={formatMoney(studentLedger.total_gross, studentLedger.currency)}
                      helper="Cumulative academic year dues"
                      tone="purple"
                    />
                    <StatCard
                      label="Fee Concessions"
                      value={formatMoney(studentLedger.total_discount, studentLedger.currency)}
                      helper="Scholarships & fee waivers"
                      tone="emerald"
                    />
                    <StatCard
                      label="Total Paid"
                      value={formatMoney(studentLedger.total_paid, studentLedger.currency)}
                      helper="Verified collections"
                      tone="purple"
                    />
                    <StatCard
                      label="Outstanding Balance"
                      value={formatMoney(studentLedger.total_balance, studentLedger.currency)}
                      helper={studentLedger.total_balance > 0 ? 'Payment due' : 'All clear!'}
                      tone="coral"
                    />
                  </div>

                  <Card title="Outstanding Fee Dues">
                    {studentLedger.dues.length === 0 ? (
                      <p className="text-gray-500 text-sm">No dues assessments on file.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Due Number
                              </th>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Structure
                              </th>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Due Date
                              </th>
                              <th className="px-4 py-2 text-right font-medium text-gray-500">
                                Net Dues
                              </th>
                              <th className="px-4 py-2 text-right font-medium text-gray-500">
                                Balance
                              </th>
                              <th className="px-4 py-2 text-center font-medium text-gray-500">
                                Status
                              </th>
                              <th className="px-4 py-2 text-center font-medium text-gray-500">
                                Action
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {studentLedger.dues.map((d) => (
                              <tr key={d.id}>
                                <td className="px-4 py-2 font-mono text-xs">{d.due_number}</td>
                                <td className="px-4 py-2">{d.fee_structure_name}</td>
                                <td className="px-4 py-2 text-gray-600">{d.due_date}</td>
                                <td className="px-4 py-2 text-right font-medium">
                                  {formatMoney(d.net_amount)}
                                </td>
                                <td className="px-4 py-2 text-right font-bold text-gray-900">
                                  {formatMoney(d.balance_amount)}
                                </td>
                                <td className="px-4 py-2 text-center">
                                  <StatusBadge status={d.status} />
                                </td>
                                <td className="px-4 py-2 text-center">
                                  {d.balance_amount > 0 && (
                                    <Button
                                      variant="primary"
                                      onClick={() => handleOpenOnlinePayModal(d)}
                                    >
                                      Pay Online
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>

                  <Card title="Fee Payment Receipts History">
                    {studentLedger.receipts.length === 0 ? (
                      <p className="text-gray-500 text-sm">No payment receipts issued yet.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Receipt #
                              </th>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Date
                              </th>
                              <th className="px-4 py-2 text-left font-medium text-gray-500">
                                Method
                              </th>
                              <th className="px-4 py-2 text-right font-medium text-gray-500">
                                Amount
                              </th>
                              <th className="px-4 py-2 text-center font-medium text-gray-500">
                                Status
                              </th>
                              <th className="px-4 py-2 text-center font-medium text-gray-500">
                                Action
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {studentLedger.receipts.map((r) => (
                              <tr key={r.id}>
                                <td className="px-4 py-2 font-mono text-xs font-semibold">
                                  {r.receipt_number}
                                </td>
                                <td className="px-4 py-2 text-gray-600">{r.payment_date}</td>
                                <td className="px-4 py-2 text-xs">{r.payment_method}</td>
                                <td className="px-4 py-2 text-right font-bold text-gray-900">
                                  {formatMoney(r.amount, r.currency)}
                                </td>
                                <td className="px-4 py-2 text-center">
                                  <StatusBadge status={r.status} />
                                </td>
                                <td className="px-4 py-2 text-center">
                                  <Button variant="secondary" onClick={() => setSelectedReceipt(r)}>
                                    View Voucher
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </>
              ) : (
                <EmptyState
                  title="No Student Record Found"
                  description="Your student profile could not be loaded."
                />
              )}
            </div>
          )}
        </>
      )}

      {/* Online Payment Checkout Modal */}
      <Dialog
        open={showPayOnlineModal}
        onClose={() => {
          setShowPayOnlineModal(false);
          setOnlinePayResult(null);
        }}
        title="Pay School Fees Online"
      >
        <div className="space-y-4">
          {payOnlineDue && (
            <div className="p-3 bg-blue-50 rounded-lg text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">Due Number:</span>
                <span className="font-semibold text-gray-900">{payOnlineDue.due_number}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Fee Structure:</span>
                <span className="font-semibold text-gray-900">
                  {payOnlineDue.fee_structure_name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Outstanding Balance:</span>
                <span className="font-bold text-blue-700">
                  {formatMoney(payOnlineDue.balance_amount)}
                </span>
              </div>
            </div>
          )}

          {!onlinePayResult ? (
            <div className="space-y-4">
              <TextField
                label="Payment Amount (₹) *"
                type="number"
                step="0.01"
                value={payOnlineAmount}
                onChange={(e) => setPayOnlineAmount(e.target.value)}
                placeholder="Amount to pay"
                required
              />

              <div className="flex justify-end space-x-2 pt-2">
                <Button variant="secondary" onClick={() => setShowPayOnlineModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleInitiateOnlineCheckout}
                  disabled={onlinePayInitiating}
                >
                  {onlinePayInitiating ? 'Contacting Gateway...' : 'Proceed to Gateway Checkout'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Alert tone="info">
                Online payment session initiated via <strong>{onlinePayResult.provider}</strong>.
                Order Reference: <code className="font-mono">{onlinePayResult.orderReference}</code>
              </Alert>

              <div className="p-4 border rounded-lg bg-gray-50 space-y-2 text-sm">
                <div className="text-xs font-semibold text-gray-500 uppercase">
                  Gateway Checkout Simulation
                </div>
                <p className="text-gray-600">
                  In a live browser environment, this triggers the hosted Razorpay Standard modal,
                  Cashfree Checkout Drop-in, or PhonePe redirect.
                </p>
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowPayOnlineModal(false);
                    setOnlinePayResult(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() =>
                    handleCompleteOnlineVerification(
                      onlinePayResult.attemptReference,
                      `pay_${Math.floor(100000 + Math.random() * 900000)}`,
                    )
                  }
                  disabled={onlinePaySimulating}
                >
                  {onlinePaySimulating ? 'Verifying...' : 'Simulate Gateway Payment Success'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      {/* Online Refund Modal */}
      <Dialog
        open={showRefundModal}
        onClose={() => setShowRefundModal(false)}
        title="Initiate Gateway Refund"
      >
        <form onSubmit={handleInitiateRefund} className="space-y-4">
          {refundReceipt && (
            <div className="p-3 bg-gray-50 rounded text-sm space-y-1">
              <div>
                Receipt: <strong>{refundReceipt.receipt_number}</strong>
              </div>
              <div>
                Amount: <strong>{formatMoney(refundReceipt.amount, refundReceipt.currency)}</strong>
              </div>
            </div>
          )}

          <TextField
            label="Refund Amount (₹) *"
            type="number"
            step="0.01"
            value={refundAmount}
            onChange={(e) => setRefundAmount(e.target.value)}
            required
          />

          <TextField
            label="Refund Reason *"
            value={refundReason}
            onChange={(e) => setRefundReason(e.target.value)}
            placeholder="e.g. Overpayment adjustment or admission cancellation"
            required
          />

          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="secondary" onClick={() => setShowRefundModal(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="bg-red-600 hover:bg-red-700"
              disabled={actionSubmitting}
            >
              {actionSubmitting ? 'Processing Refund...' : 'Confirm Gateway Refund'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Voucher Detail Modal */}
      <Dialog
        open={!!selectedReceipt && !showReverseModal}
        onClose={() => setSelectedReceipt(null)}
        title="Payment Receipt Voucher"
      >
        {selectedReceipt && (
          <div className="space-y-4 text-sm" id="receipt-voucher">
            <div className="text-center pb-3 border-b border-gray-200">
              <h3 className="font-bold text-lg text-gray-900">Anesa Campus OS</h3>
              <p className="text-xs text-gray-500">Official Student Fee Receipt</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-gray-500 text-xs">Receipt Number:</span>
                <div className="font-mono font-bold text-gray-900">
                  {selectedReceipt.receipt_number}
                </div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Date of Payment:</span>
                <div className="font-medium text-gray-900">{selectedReceipt.payment_date}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-gray-500 text-xs">Student:</span>
                <div className="font-medium text-gray-900">{selectedReceipt.student_name}</div>
                <div className="text-xs text-gray-500">{selectedReceipt.admission_number}</div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Payment Method:</span>
                <div className="font-medium text-gray-900">{selectedReceipt.payment_method}</div>
                {selectedReceipt.reference_number && (
                  <div className="text-xs text-gray-500 font-mono">
                    Ref: {selectedReceipt.reference_number}
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-b border-gray-200 py-3">
              <div className="flex justify-between items-center text-base">
                <span className="font-bold text-gray-900">Total Paid:</span>
                <span className="font-bold text-blue-700">
                  {formatMoney(selectedReceipt.amount, selectedReceipt.currency)}
                </span>
              </div>
            </div>

            {selectedReceipt.status === 'REVERSED' && (
              <Alert tone="error">
                Receipt Reversed on{' '}
                {selectedReceipt.reversed_at
                  ? new Date(selectedReceipt.reversed_at).toLocaleDateString()
                  : ''}
                . Reason: {selectedReceipt.reversal_reason}
              </Alert>
            )}

            <div className="flex justify-end space-x-2 pt-2">
              <Button variant="secondary" onClick={() => setSelectedReceipt(null)}>
                Close
              </Button>
              <Button variant="primary" onClick={() => window.print()}>
                Print Voucher
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Reversal Confirmation Modal */}
      <Dialog
        open={showReverseModal}
        onClose={() => setShowReverseModal(false)}
        title="Authorized Fee Receipt Reversal"
      >
        <form onSubmit={handleReverseReceipt} className="space-y-4">
          <Alert tone="error">
            Reversing a receipt permanently marks it as reversed, deducts the payment from student
            balances, and reopens student dues.
          </Alert>

          <TextField
            label="Reason for Reversal *"
            value={reversalReason}
            onChange={(e) => setReversalReason(e.target.value)}
            placeholder="e.g. Duplicate cheque entry or bank cheque bounce"
            required
          />

          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="secondary" onClick={() => setShowReverseModal(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="bg-red-600 hover:bg-red-700"
              disabled={actionSubmitting}
            >
              {actionSubmitting ? 'Reversing...' : 'Confirm Reversal'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Create Category Modal */}
      <Dialog
        open={showCreateCategoryModal}
        onClose={() => setShowCreateCategoryModal(false)}
        title="Create Fee Category"
      >
        <form onSubmit={handleCreateCategory} className="space-y-4">
          <TextField
            label="Category Code *"
            value={newCatCode}
            onChange={(e) => setNewCatCode(e.target.value)}
            placeholder="e.g. TUIT, LAB, LIB"
            required
          />
          <TextField
            label="Name *"
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="e.g. Tuition Fee"
            required
          />
          <TextField
            label="Description"
            value={newCatDesc}
            onChange={(e) => setNewCatDesc(e.target.value)}
            placeholder="Optional description"
          />
          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCreateCategoryModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={actionSubmitting}>
              {actionSubmitting ? 'Creating...' : 'Create Category'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Create Structure Modal */}
      <Dialog
        open={showCreateStructureModal}
        onClose={() => setShowCreateStructureModal(false)}
        title="Create Fee Structure"
      >
        <form onSubmit={handleCreateStructure} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="Code *"
              value={newStructCode}
              onChange={(e) => setNewStructCode(e.target.value)}
              placeholder="e.g. ENG-2026-S1"
              required
            />
            <TextField
              label="Due Date *"
              type="date"
              value={newStructDueDate}
              onChange={(e) => setNewStructDueDate(e.target.value)}
              required
            />
          </div>
          <TextField
            label="Name *"
            value={newStructName}
            onChange={(e) => setNewStructName(e.target.value)}
            placeholder="e.g. B.Tech Semester 1 Fee Structure"
            required
          />

          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Fee Components *</label>
            {structComponents.map((comp, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <select
                  className="rounded border border-gray-300 px-3 py-2 text-sm flex-1"
                  value={comp.fee_category_id}
                  onChange={(e) => {
                    const next = [...structComponents];
                    next[idx]!.fee_category_id = e.target.value;
                    setStructComponents(next);
                  }}
                  required
                >
                  <option value="">Select Category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
                <TextField
                  label={`Component ${idx + 1} Amount`}
                  type="number"
                  placeholder="Amount (₹)"
                  value={comp.amount}
                  onChange={(e) => {
                    const next = [...structComponents];
                    next[idx]!.amount = e.target.value;
                    setStructComponents(next);
                  }}
                  className="w-32"
                  required
                />
                {structComponents.length > 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setStructComponents(structComponents.filter((_, i) => i !== idx));
                    }}
                  >
                    ×
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStructComponents([
                  ...structComponents,
                  { fee_category_id: '', amount: '', description: '' },
                ]);
              }}
            >
              + Add Component
            </Button>
          </div>

          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCreateStructureModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={actionSubmitting}>
              {actionSubmitting ? 'Creating...' : 'Save Structure'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Generate Dues Modal */}
      <Dialog
        open={showGenerateDuesModal}
        onClose={() => setShowGenerateDuesModal(false)}
        title="Generate Student Dues"
      >
        <form onSubmit={handleGenerateDues} className="space-y-4">
          <div className="field">
            <label className="block text-sm font-medium text-gray-700 mb-1">Fee Structure *</label>
            <select
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selectedStructureId}
              onChange={(e) => setSelectedStructureId(e.target.value)}
              required
            >
              <option value="">Select Fee Structure</option>
              {structures.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatMoney(s.total_amount)})
                </option>
              ))}
            </select>
          </div>

          <TextField
            label="Target Student IDs (Optional, comma-separated)"
            value={targetStudentIds}
            onChange={(e) => setTargetStudentIds(e.target.value)}
            placeholder="Leave empty to generate for all cohort students, or e.g. st-1, st-2"
          />

          <div className="border-t border-gray-200 pt-3 space-y-2">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Concession / Waiver (Optional)
            </div>
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="Student ID"
                value={concessionStudentId}
                onChange={(e) => setConcessionStudentId(e.target.value)}
                placeholder="Student ID (e.g. st-1)"
              />
              <TextField
                label="Discount Amount"
                type="number"
                value={concessionAmount}
                onChange={(e) => setConcessionAmount(e.target.value)}
                placeholder="Discount Amount (₹)"
              />
            </div>
            <TextField
              label="Reason for Concession"
              value={concessionReason}
              onChange={(e) => setConcessionReason(e.target.value)}
              placeholder="Reason for concession"
            />
          </div>

          <div className="flex justify-end space-x-2 pt-2">
            <Button variant="secondary" onClick={() => setShowGenerateDuesModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={actionSubmitting}>
              {actionSubmitting ? 'Generating...' : 'Generate Dues'}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
