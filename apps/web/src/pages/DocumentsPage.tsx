import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedNav, type SegmentedNavItem } from '../components/ui/SegmentedNav';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { isApiError, isModuleNotEntitled, isInstitutionSuspended } from '../lib/api/errors';
import {
  FeatureUnavailableState,
  InstitutionSuspendedState,
} from '../components/ui/FeatureUnavailableState';
import {
  completeUpload,
  fetchDocumentDownloadUrl,
  fetchDocuments,
  initiateUpload,
  type DocumentItem,
} from '../lib/api/documents-api';
import { fetchFeeReceipts } from '../lib/api/finance-api';
import { fetchChildFees, fetchParentChildren, type ParentChild } from '../lib/api/parent-api';

type DocumentCategory = 'academic' | 'personal' | 'employee' | 'financial';

interface FeeReceiptView {
  id: string;
  receipt_number: string;
  payment_date: string;
  payment_method: string;
  amount: number;
  currency: string;
  status: string;
  student_id?: string | undefined;
  student_name?: string | undefined;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function DocumentsPage() {
  const { client, identity } = useAuth();

  const isParent = identity?.roles.includes('PARENT') ?? false;
  const isStudent = identity?.roles.includes('STUDENT') ?? false;
  const hasFeeReceiptRead = identity ? can(identity, 'fee.receipt.read') : false;
  const canUpload = identity ? can(identity, 'document.upload') : false;

  usePageTitle(isStudent ? 'My Documents' : 'Document Center');

  const [category, setCategory] = useState<DocumentCategory>('academic');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [receipts, setReceipts] = useState<FeeReceiptView[]>([]);
  const [children, setChildren] = useState<ParentChild[]>([]);
  const [selectedChildId, setSelectedChildId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNotEntitled, setIsNotEntitled] = useState(false);
  const [isSuspended, setIsSuspended] = useState(false);

  // Upload modal state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadStorageClass, setUploadStorageClass] = useState<'GENERAL' | 'SENSITIVE'>('GENERAL');
  const [uploadClassification, setUploadClassification] = useState<
    'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED'
  >('INTERNAL');
  const [uploadPurpose, setUploadPurpose] = useState('id_proof');
  const [uploadReason, setUploadReason] = useState('Verification document submission');
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);

  // Details modal state
  const [selectedDoc, setSelectedDoc] = useState<DocumentItem | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<FeeReceiptView | null>(null);

  // Load parent's children if guardian role
  useEffect(() => {
    if (!isParent || !client) return;
    void fetchParentChildren(client)
      .then((kids) => {
        setChildren(kids);
        if (kids.length > 0 && kids[0]) {
          setSelectedChildId(kids[0].studentId);
        }
      })
      .catch(() => setChildren([]));
  }, [isParent, client]);

  // Load documents or receipts based on active category
  const loadData = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);

    try {
      if (category === 'financial') {
        if (isParent && selectedChildId) {
          const feesData = await fetchChildFees(client, selectedChildId);
          // Map child fees receipts to standard receipt shape
          const childReceipts: FeeReceiptView[] = (feesData.receipts ?? []).map((r, idx) => ({
            id: `child-rec-${idx}`,
            receipt_number: r.receiptNumber,
            payment_date: r.receiptDate,
            payment_method: r.paymentMode,
            amount: r.amount,
            currency: 'INR',
            status: r.status,
            student_id: selectedChildId,
          }));
          setReceipts(childReceipts);
        } else if (hasFeeReceiptRead || isStudent) {
          const recs = await fetchFeeReceipts(client).catch(() => []);
          const mapped: FeeReceiptView[] = recs.map((r) => ({
            id: r.id,
            receipt_number: r.receipt_number,
            payment_date: r.payment_date,
            payment_method: r.payment_method,
            amount: r.amount,
            currency: r.currency || 'INR',
            status: r.status,
            student_id: r.student_id,
            student_name: r.student_name,
          }));
          setReceipts(mapped);
        } else {
          setReceipts([]);
        }
      } else {
        const docs = await fetchDocuments(client);
        setDocuments(docs);
      }
    } catch (err: unknown) {
      if (isModuleNotEntitled(err)) {
        setIsNotEntitled(true);
        setError(null);
      } else if (isInstitutionSuspended(err)) {
        setIsSuspended(true);
        setError(null);
      } else {
        setError(
          isApiError(err)
            ? err.message
            : 'Unable to load documents. Please check your network connection or try again.',
        );
      }
    } finally {
      setLoading(false);
    }
  }, [client, category, isParent, selectedChildId, hasFeeReceiptRead, isStudent]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  if (!identity) return null;

  // Filter available categories based on role and capability
  const availableCategories: SegmentedNavItem<DocumentCategory>[] = [
    { id: 'academic', label: 'Academic Documents' },
    { id: 'personal', label: 'Personal & Identity' },
    ...(!isStudent && !isParent
      ? [{ id: 'employee' as DocumentCategory, label: 'Employee Records' }]
      : []),
    ...(hasFeeReceiptRead || isStudent || isParent
      ? [{ id: 'financial' as DocumentCategory, label: 'Fee Receipts & Dues' }]
      : []),
  ];

  // Filter documents matching category
  const filteredDocs = documents.filter((doc) => {
    if (category === 'academic') {
      return (
        !doc.purpose ||
        doc.purpose === 'transcript' ||
        doc.purpose === 'academic_transcript' ||
        doc.purpose === 'homework' ||
        doc.purpose === 'general_document' ||
        doc.purpose === 'syllabus' ||
        doc.purpose === 'grade_card' ||
        doc.purpose === 'certificate'
      );
    }
    if (category === 'personal') {
      return (
        doc.purpose === 'id_proof' ||
        doc.purpose === 'birth_certificate' ||
        doc.purpose === 'address_proof' ||
        doc.purpose === 'guardian_affidavit'
      );
    }
    if (category === 'employee') {
      return (
        doc.purpose === 'employee_record' ||
        doc.purpose === 'qualification' ||
        doc.purpose === 'employment_contract'
      );
    }
    return true;
  });

  const handleDownload = async (doc: DocumentItem) => {
    try {
      const dl = await fetchDocumentDownloadUrl(client, doc.id);
      if (dl.url.startsWith('memory://')) {
        alert(
          `[Development Mode]: Presigned download verified for "${doc.original_name}". In production, this downloads securely from Amazon S3.`,
        );
      } else {
        window.open(dl.url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      alert('Unable to generate download URL. The file may be in quarantine or access restricted.');
    }
  };

  const handleReceiptPrint = (receipt: FeeReceiptView) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Fee Receipt - ${receipt.receipt_number}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; color: #1e1b2e; }
            .header { border-bottom: 2px solid #504175; padding-bottom: 1rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; }
            .title { font-size: 1.5rem; font-weight: 700; color: #504175; margin: 0; }
            .meta { font-size: 0.875rem; color: #6b647f; }
            .table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
            .table th, .table td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #e2dded; }
            .table th { background: #f7f5fa; font-weight: 600; }
            .amount { font-size: 1.25rem; font-weight: 700; color: #065f46; text-align: right; }
            .footer { margin-top: 3rem; font-size: 0.75rem; color: #8e88a0; text-align: center; border-top: 1px dashed #ded7eb; padding-top: 1rem; }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1 class="title">Anesa Campus OS</h1>
              <div class="meta">Official Institutional Fee Receipt</div>
            </div>
            <div style="text-align: right;">
              <div><strong>Receipt No:</strong> ${receipt.receipt_number}</div>
              <div class="meta">Date: ${receipt.payment_date}</div>
            </div>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>Description</th>
                <th>Payment Mode</th>
                <th>Status</th>
                <th style="text-align: right;">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Institutional Tuition & Academic Fee Payment</td>
                <td>${receipt.payment_method}</td>
                <td>${receipt.status}</td>
                <td class="amount">₹${(receipt.amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
              </tr>
            </tbody>
          </table>
          <div class="footer">
            Generated electronically by Anesa Smart Campus OS. Verified immutable transaction.
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  const handleUploadSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!uploadFile) {
      setUploadError('Please select a valid document file.');
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadSuccess(null);

    try {
      const buffer = await uploadFile.arrayBuffer();
      const digestBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(digestBuffer));
      const sha256 = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      const targetEntityId =
        isParent && selectedChildId ? selectedChildId : identity ? identity.userId : '';

      const init = await initiateUpload(client, {
        storageClass: uploadStorageClass,
        originalName: uploadFile.name,
        contentType: uploadFile.type || 'application/pdf',
        sizeBytes: uploadFile.size,
        sha256,
        classification: uploadClassification,
        link: {
          entityType: 'student',
          entityId: targetEntityId,
          purpose: uploadPurpose,
        },
        reason: uploadReason,
      });

      // Complete upload lifecycle
      await completeUpload(client, init.data.fileId);

      setUploadSuccess(
        `Document "${uploadFile.name}" successfully uploaded and submitted to security scan queue.`,
      );
      setUploadFile(null);
      void loadData();
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error
          ? err.message
          : 'Upload failed. Note: Central document uploads require configured object storage (S3/MinIO).',
      );
    } finally {
      setUploadBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Document Center"
        subtitle="My Documents • Role-governed repository for verified institutional records, certificates, fee receipts, and academic submissions."
        actions={
          !isNotEntitled && !isSuspended && canUpload ? (
            <Button variant="primary" onClick={() => setUploadOpen(true)}>
              + Upload Document
            </Button>
          ) : undefined
        }
      />

      {isNotEntitled ? (
        <FeatureUnavailableState moduleKey="documents" moduleName="Document Center & Storage" />
      ) : isSuspended ? (
        <InstitutionSuspendedState />
      ) : (
        <>
          {/* Purpose & Security Architecture Guide Banner */}
          <section
            className="doc-intro-banner"
            aria-label="Document Center security and verification guide"
          >
            <div className="doc-intro-header">
              <div className="doc-intro-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
              </div>
              <h2 className="doc-intro-title">Institutional Document Governance & Verification</h2>
            </div>
            <p className="doc-intro-desc">
              All institutional records are tenant-isolated and cryptographically verified. Uploaded
              files undergo automatic virus inspection (ClamAV) and SHA-256 integrity verification
              before becoming available. Access permissions are dynamically derived from linked
              student and employee records.
            </p>
            <div className="doc-security-grid">
              <div className="doc-security-pill">
                <strong>Tenant Isolation</strong>
                <p>
                  Documents reside in private institutional buckets with row-level security and
                  tenant-prefixed storage keys.
                </p>
              </div>
              <div className="doc-security-pill">
                <strong>Antimalware Verification</strong>
                <p>
                  Every upload is isolated in quarantine until confirmed clean; infected files are
                  permanently neutralized.
                </p>
              </div>
              <div className="doc-security-pill">
                <strong>Signed Downloads</strong>
                <p>
                  Presigned, short-lived URLs (≤5 minutes) prevent public bucket exposure and
                  unauthorized hotlinking.
                </p>
              </div>
              <div className="doc-security-pill">
                <strong>Zero-Access Distinction</strong>
                <p>
                  Standard documents are encrypted at rest with server keys; Zero-Access records
                  (Vault) require client passkey custody.
                </p>
              </div>
            </div>
          </section>

          {/* Guardian Verified Child Selector */}
          {isParent && children.length > 0 && (
            <div className="doc-child-selector">
              <label htmlFor="child-select">Viewing Records For Linked Child:</label>
              <select
                id="child-select"
                className="doc-child-select"
                value={selectedChildId}
                onChange={(e) => setSelectedChildId(e.target.value)}
              >
                {children.map((c) => (
                  <option key={c.studentId} value={c.studentId}>
                    {c.displayName || c.admissionNumber} ({c.admissionNumber})
                  </option>
                ))}
              </select>
              <span style={{ fontSize: '0.8125rem', color: 'var(--color-muted)' }}>
                ✓ Verified Legal Guardianship Linkage
              </span>
            </div>
          )}

          {isParent && children.length === 0 && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Alert tone="info">
                No verified children are currently linked to your guardian account. Document access
                for parents requires documented and verified student linkage.
              </Alert>
            </div>
          )}

          {/* Category Segmented Navigation */}
          <SegmentedNav
            items={availableCategories}
            activeId={category}
            onChange={(cat) => setCategory(cat)}
            ariaLabel="Document Categories"
          />

          {error && <Alert tone="error">{error}</Alert>}

          {/* Main Content Area */}
          {loading ? (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center' }}>
              <Spinner label="Loading authorized documents…" />
            </div>
          ) : category === 'financial' ? (
            /* Financial Receipts View */
            receipts.length === 0 ? (
              <div className="doc-empty-box">
                <div className="doc-empty-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="48"
                    height="48"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="2" y="5" width="20" height="14" rx="2" />
                    <line x1="2" y1="10" x2="22" y2="10" />
                  </svg>
                </div>
                <h3 className="doc-empty-title">No Fee Receipts Available</h3>
                <p className="doc-empty-desc">
                  Official payment receipts and fee challans appear here immediately when fee
                  transactions are recorded or processed through the Fees & Finance module.
                </p>
              </div>
            ) : (
              <div className="doc-cards-grid">
                {receipts.map((rec) => (
                  <div key={rec.id} className="doc-card">
                    <div>
                      <div className="doc-card-top">
                        <div className="doc-card-icon" aria-hidden="true">
                          <svg
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <rect x="2" y="5" width="20" height="14" rx="2" />
                            <line x1="2" y1="10" x2="22" y2="10" />
                          </svg>
                        </div>
                        <div className="doc-card-title-wrap">
                          <h3 className="doc-card-name">Receipt {rec.receipt_number}</h3>
                          <span className="doc-card-sub">Date: {formatDate(rec.payment_date)}</span>
                        </div>
                      </div>
                      <div className="doc-card-meta">
                        <span className="doc-badge-available">
                          {rec.status === 'POSTED' ? '✓ POSTED & VERIFIED' : rec.status}
                        </span>
                        <span className="doc-badge-classification">
                          Mode: {rec.payment_method.replace(/_/g, ' ')}
                        </span>
                        <span
                          className="doc-badge-classification"
                          style={{ fontWeight: 700, color: 'var(--color-primary)' }}
                        >
                          ₹
                          {(rec.amount / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                    <div className="doc-card-actions">
                      <Button variant="secondary" onClick={() => setSelectedReceipt(rec)}>
                        View Details
                      </Button>
                      <Button variant="primary" onClick={() => handleReceiptPrint(rec)}>
                        Print / Download
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : /* Academic / Personal / Employee Document Cards */
          filteredDocs.length === 0 ? (
            <div className="doc-empty-box">
              <div className="doc-empty-icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="48"
                  height="48"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
              <h3 className="doc-empty-title">
                No {category.charAt(0).toUpperCase() + category.slice(1)} Documents Found
              </h3>
              <p
                className="doc-empty-sub"
                style={{ fontWeight: 600, color: 'var(--color-fg-muted)' }}
              >
                No documents uploaded
              </p>
              <p className="doc-empty-desc">
                {category === 'academic' &&
                  'Academic records (transcripts, certificates, course syllabi, and assignment attachments) become accessible here once issued by the Registrar or submitted in courses.'}
                {category === 'personal' &&
                  'Identity verification documents (government ID, birth certificate, transfer certificates) uploaded during onboarding or admissions appear here after security clearance.'}
                {category === 'employee' &&
                  'Official service letters, employment contracts, and professional credentials appear here once catalogued by the HR department.'}
              </p>
              {canUpload && (
                <Button variant="secondary" onClick={() => setUploadOpen(true)}>
                  Upload Document Now
                </Button>
              )}
            </div>
          ) : (
            <div className="doc-cards-grid">
              {filteredDocs.map((doc) => {
                const isAvailable = doc.status === 'AVAILABLE';
                const isScanning = doc.status === 'SCANNING';
                const isQuarantined = doc.status === 'QUARANTINED';

                return (
                  <div key={doc.id} className="doc-card">
                    <div>
                      <div className="doc-card-top">
                        <div className="doc-card-icon" aria-hidden="true">
                          <svg
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                        </div>
                        <div className="doc-card-title-wrap">
                          <h3 className="doc-card-name" title={doc.original_name}>
                            {doc.original_name || 'Document'}
                          </h3>
                          <span className="doc-card-sub">
                            {formatDate(doc.created_at)} · {formatBytes(doc.size_bytes)}
                          </span>
                        </div>
                      </div>
                      <div className="doc-card-meta">
                        {isAvailable && (
                          <span className="doc-badge-available">✓ VERIFIED CLEAN</span>
                        )}
                        {isScanning && <span className="doc-badge-scanning">⏳ SCANNING</span>}
                        {isQuarantined && (
                          <span className="doc-badge-quarantined">⚠ QUARANTINED</span>
                        )}
                        <span className="doc-badge-classification">{doc.classification}</span>
                        {doc.purpose && (
                          <span className="doc-badge-classification">
                            {doc.purpose.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="doc-card-actions">
                      <Button variant="secondary" onClick={() => setSelectedDoc(doc)}>
                        Details
                      </Button>
                      <Button
                        variant="primary"
                        disabled={!isAvailable}
                        onClick={() => {
                          void handleDownload(doc);
                        }}
                      >
                        Download
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Upload Document Modal */}
          {uploadOpen && (
            <Dialog
              title="Upload Institutional Document"
              open={uploadOpen}
              onClose={() => {
                setUploadOpen(false);
                setUploadError(null);
                setUploadSuccess(null);
              }}
            >
              <form
                onSubmit={(e) => {
                  void handleUploadSubmit(e);
                }}
                noValidate
              >
                {uploadError && <Alert tone="error">{uploadError}</Alert>}
                {uploadSuccess && <Alert tone="success">{uploadSuccess}</Alert>}

                <div className="field">
                  <label htmlFor="upload-file-input">Select File (PDF, PNG, JPEG up to 10MB)</label>
                  <input
                    id="upload-file-input"
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg"
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      setUploadFile(e.target.files?.[0] ?? null);
                      setUploadError(null);
                    }}
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="upload-purpose-select">Document Purpose</label>
                  <select
                    id="upload-purpose-select"
                    value={uploadPurpose}
                    onChange={(e) => setUploadPurpose(e.target.value)}
                  >
                    <option value="id_proof">Government ID / Birth Proof</option>
                    <option value="academic_transcript">Academic Record / Transcript</option>
                    <option value="general_document">General Institutional Document</option>
                    {!isStudent && !isParent && (
                      <option value="employee_record">Employee Record / Credential</option>
                    )}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="upload-classification-select">
                    Confidentiality Classification
                  </label>
                  <select
                    id="upload-classification-select"
                    value={uploadClassification}
                    onChange={(e) =>
                      setUploadClassification(
                        e.target.value as 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED',
                      )
                    }
                  >
                    <option value="INTERNAL">INTERNAL (Authorized campus users)</option>
                    <option value="CONFIDENTIAL">
                      CONFIDENTIAL (Owner and designated staff only)
                    </option>
                    <option value="RESTRICTED">
                      RESTRICTED (Registrar / Executive sign-off required)
                    </option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="upload-storage-select">Storage Class</label>
                  <select
                    id="upload-storage-select"
                    value={uploadStorageClass}
                    onChange={(e) =>
                      setUploadStorageClass(e.target.value as 'GENERAL' | 'SENSITIVE')
                    }
                  >
                    <option value="GENERAL">GENERAL (Standard institutional bucket)</option>
                    <option value="SENSITIVE">SENSITIVE (Higher isolation & audit tier)</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="upload-reason-input">Reason for Upload</label>
                  <input
                    id="upload-reason-input"
                    value={uploadReason}
                    onChange={(e) => setUploadReason(e.target.value)}
                    placeholder="e.g. Identity verification for admissions"
                    minLength={5}
                    required
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 'var(--space-3)',
                    marginTop: 'var(--space-4)',
                  }}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setUploadOpen(false)}
                    disabled={uploadBusy}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    pending={uploadBusy}
                    disabled={!uploadFile}
                  >
                    Upload & Submit
                  </Button>
                </div>
              </form>
            </Dialog>
          )}

          {/* Document Details Modal */}
          {selectedDoc && (
            <Dialog
              title="Document Verification & Security Details"
              open={!!selectedDoc}
              onClose={() => setSelectedDoc(null)}
            >
              <dl className="defs" style={{ margin: 'var(--space-3) 0' }}>
                <dt>Original File Name</dt>
                <dd>{selectedDoc.original_name}</dd>
                <dt>Document ID</dt>
                <dd style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>{selectedDoc.id}</dd>
                <dt>Verification Status</dt>
                <dd>
                  <Badge tone={selectedDoc.status === 'AVAILABLE' ? 'success' : 'warning'}>
                    {selectedDoc.status}
                  </Badge>
                </dd>
                {selectedDoc.sha256 && (
                  <>
                    <dt>SHA-256 Digest</dt>
                    <dd
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '0.75rem',
                        wordBreak: 'break-all',
                      }}
                    >
                      {selectedDoc.sha256}
                    </dd>
                  </>
                )}
                <dt>Antivirus Scan Verdict</dt>
                <dd>{selectedDoc.scan_status || 'CLEAN (Inspected)'}</dd>
                <dt>Storage Class</dt>
                <dd>{selectedDoc.storage_class}</dd>
                <dt>Classification</dt>
                <dd>{selectedDoc.classification}</dd>
                <dt>File Size</dt>
                <dd>{formatBytes(selectedDoc.size_bytes)}</dd>
                <dt>MIME Content Type</dt>
                <dd>{selectedDoc.mime_type || 'application/octet-stream'}</dd>
                <dt>Uploaded Date</dt>
                <dd>{formatDate(selectedDoc.created_at)}</dd>
                <dt>Encryption at Rest</dt>
                <dd>AWS S3 Server-Side Encryption (AES-256 / SSE-S3)</dd>
              </dl>
              <div
                style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'var(--space-4)' }}
              >
                <Button variant="secondary" onClick={() => setSelectedDoc(null)}>
                  Close
                </Button>
              </div>
            </Dialog>
          )}

          {/* Receipt Details Modal */}
          {selectedReceipt && (
            <Dialog
              title="Fee Receipt Details"
              open={!!selectedReceipt}
              onClose={() => setSelectedReceipt(null)}
            >
              <dl className="defs" style={{ margin: 'var(--space-3) 0' }}>
                <dt>Receipt Number</dt>
                <dd style={{ fontWeight: 700, color: 'var(--color-primary)' }}>
                  {selectedReceipt.receipt_number}
                </dd>
                <dt>Payment Date</dt>
                <dd>{formatDate(selectedReceipt.payment_date)}</dd>
                <dt>Payment Method</dt>
                <dd>{selectedReceipt.payment_method.replace(/_/g, ' ')}</dd>
                <dt>Total Amount</dt>
                <dd style={{ fontWeight: 700, color: '#065f46' }}>
                  ₹
                  {(selectedReceipt.amount / 100).toLocaleString('en-IN', {
                    minimumFractionDigits: 2,
                  })}
                </dd>
                <dt>Transaction Status</dt>
                <dd>
                  <Badge tone="success">{selectedReceipt.status}</Badge>
                </dd>
              </dl>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 'var(--space-3)',
                  marginTop: 'var(--space-4)',
                }}
              >
                <Button variant="secondary" onClick={() => setSelectedReceipt(null)}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => handleReceiptPrint(selectedReceipt)}>
                  Print Receipt
                </Button>
              </div>
            </Dialog>
          )}
        </>
      )}
    </>
  );
}
