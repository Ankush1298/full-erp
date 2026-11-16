import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import { Link } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { usePageTitle } from '../components/usePageTitle';
import { useAuth } from '../features/auth/AuthProvider';
import { can } from '../features/auth/identity';
import { CSV_PROBLEM_TEXT, parseCsv } from '../lib/csv';
import {
  commitImport,
  createImport,
  errorReportPath,
  fetchImport,
  fetchImportRows,
  splitMatching,
  validateImport,
  type ImportIssue,
  type ImportJob,
  type ImportKind,
  type ImportRow,
} from '../lib/api/imports-api';
import { importErrorMessage } from '../lib/api/messages';

interface KindConfig {
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
  permission: string;
  columns: string;
  requiredColumns: string[];
  optionalColumns: string[];
  matchingColumns: string[];
  example: string;
  targetRoute: string;
  targetLabel: string;
}

const KINDS: Record<ImportKind, KindConfig> = {
  students: {
    label: 'Student records',
    shortLabel: 'Students',
    icon: 'student',
    description: 'Enrol admitted students into institutional cohorts with admission number and official admission date.',
    permission: 'student.record.create',
    columns:
      'email, admissionNumber, admissionDate, optional campusId; optional, used only to look for a possible duplicate and never stored (sent again with each step and kept in this page only): name, dateOfBirth (YYYY-MM-DD), guardianPhone',
    requiredColumns: ['email', 'admissionNumber', 'admissionDate'],
    optionalColumns: ['campusId'],
    matchingColumns: ['name', 'dateOfBirth (YYYY-MM-DD)', 'guardianPhone'],
    example: 'email,admissionNumber,admissionDate\nasha@college.example,ADM-2026-001,2026-07-01',
    targetRoute: '/students',
    targetLabel: 'Students Directory',
  },
  faculty: {
    label: 'Employee records (faculty and staff)',
    shortLabel: 'Employees',
    icon: 'employee',
    description: 'Enrol teaching faculty and operational staff with unique employee code, role classification, and joining date.',
    permission: 'employee.record.create',
    columns: 'email, employeeCode, employeeType, joiningDate',
    requiredColumns: ['email', 'employeeCode', 'employeeType', 'joiningDate'],
    optionalColumns: [],
    matchingColumns: [],
    example:
      'email,employeeCode,employeeType,joiningDate\nravi@college.example,EMP-001,FACULTY,2026-06-01',
    targetRoute: '/users',
    targetLabel: 'Users & Staff Directory',
  },
};

/** Fixed wording per issue code: the text the server sends is never rendered. */
const ISSUE_TEXT: Readonly<Record<string, string>> = {
  REQUIRED: 'A value is required.',
  UNKNOWN_COLUMN: 'This column is not part of the import.',
  INVALID_EMAIL: 'Not a valid e-mail address.',
  INVALID_ADMISSION_NUMBER: 'Must be 1 to 50 letters, digits, "-" or "_".',
  INVALID_EMPLOYEE_CODE: 'Must be 1 to 50 letters, digits, "-" or "_".',
  INVALID_EMPLOYEE_TYPE: 'Not a known employee type.',
  INVALID_DATE: 'Must be a real date, YYYY-MM-DD.',
  ACCOUNT_NOT_FOUND: 'No account with this e-mail exists in your organisation.',
  ACCOUNT_NOT_ACTIVE: 'Only an active account can be given a student record.',
  ACCOUNT_DEACTIVATED: 'A deactivated account cannot be given an employee record.',
  ACCOUNT_HAS_STUDENT_RECORD: 'This account already has a student record.',
  ACCOUNT_HAS_EMPLOYEE_RECORD: 'This account already has an employee record.',
  ACCOUNT_HAS_STAFF_ROLE: 'This account has a staff role and cannot be given a student record.',
  ADMISSION_NUMBER_EXISTS: 'A student with this admission number already exists.',
  EMPLOYEE_CODE_EXISTS: 'An employee with this code already exists.',
  DUPLICATE_IN_FILE: 'This value already appears in an earlier row of the file.',
  FUTURE_DATE: 'The date is in the future.',
  ACCOUNT_NOT_ACTIVATED: 'The account has not accepted its invitation yet.',
  ACCOUNT_SUSPENDED: 'The account is suspended.',
  INVALID_NAME: 'The name is not valid.',
  INVALID_PHONE: 'The phone number is too long.',
  CAMPUS_NOT_FOUND: 'Campus not found in this organization.',
  UNAUTHORIZED_CAMPUS: 'You are not authorized to admit students to this campus.',
  CAMPUS_REQUIRED: 'A campus ID is required for campus-scoped admission.',
  INVALID_CAMPUS: 'Not a valid campus ID.',
  POSSIBLE_DUPLICATE_STUDENT:
    'A student with the same name, date of birth and guardian phone number may already exist.',
  POSSIBLE_DUPLICATE_IN_FILE:
    'An earlier row of this file has the same name, date of birth and guardian phone number.',
};

const issueText = (i: ImportIssue): string =>
  `${ISSUE_TEXT[i.code] ?? 'There is a problem with this row.'}${i.field ? ` (${i.field})` : ''}${
    i.relatedRow ? ` First seen in row ${i.relatedRow}.` : ''
  }`;

/** The exact change the commit would apply, in words, built only from the normalised fields. */
function describeChange(row: ImportRow): string {
  const n = row.normalized;
  if (!n) return 'No change (the row cannot be read).';
  const s = (k: string): string => (typeof n[k] === 'string' ? n[k] : '');
  if (n.action === 'CREATE_STUDENT_RECORD') {
    return `Create student record for ${s('email')}: admission number ${s('admissionNumber')}, admitted ${s('admissionDate')}, status ${s('initialStatus')}.`;
  }
  if (n.action === 'CREATE_EMPLOYEE_RECORD') {
    return `Create employee record for ${s('email')}: code ${s('employeeCode')}, type ${s('employeeType')}, joined ${s('joiningDate')}, status ${s('initialStatus')}.`;
  }
  return 'Create a record.';
}

export function ImportsPage() {
  usePageTitle('Imports');
  const { client, identity } = useAuth();
  const [kind, setKind] = useState<ImportKind>('students');
  const [text, setText] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showPasteBox, setShowPasteBox] = useState(false);

  // One Idempotency-Key per intent: a double click or a retry replays instead of importing twice. The commit key is tied to
  // the job version the administrator previewed, so a refreshed preview is a new intent.
  const createKey = useRef<string | null>(null);
  const commitKey = useRef<{ version: number; key: string } | null>(null);

  const loadRows = useCallback(
    async (id: string, after: number, replace: boolean) => {
      const page = await fetchImportRows(client, kind, id, after);
      setRows((prev) => (replace ? page.data : [...prev, ...page.data]));
      setNext(page.page.nextAfterRowNo);
    },
    [client, kind],
  );

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(importErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** After a refused commit the server has already stored a refreshed preview (or closed the job): show it. */
  const reload = async (id: string): Promise<void> => {
    try {
      setJob(await fetchImport(client, kind, id));
      await loadRows(id, 0, true);
    } catch {
      /* the error already shown stays; the user can reload the page */
    }
  };

  if (!identity) return null;
  const allowed = (Object.keys(KINDS) as ImportKind[]).filter((k) =>
    can(identity, KINDS[k].permission),
  );

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) {
      void file.text().then((content) => {
        setText(content);
        createKey.current = null;
      });
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (): void => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void file.text().then((content) => {
        setText(content);
        createKey.current = null;
      });
    }
  };

  const downloadTemplate = (k: ImportKind): void => {
    const content =
      k === 'students'
        ? 'email,admissionNumber,admissionDate,campusId,name,dateOfBirth,guardianPhone\nasha.student@example.edu,ADM-2026-001,2026-07-01,,Asha Sharma,2008-04-12,9876543210\n'
        : 'email,employeeCode,employeeType,joiningDate\nprof.kumar@example.edu,EMP-001,FACULTY,2026-06-01\nadmin.verma@example.edu,EMP-002,STAFF,2026-06-01\n';
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `anesa_${k}_template.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const start = (e: FormEvent): void => {
    e.preventDefault();
    const parsed = parseCsv(text);
    if (parsed.problems.length > 0) {
      setProblems(parsed.problems.map((p) => CSV_PROBLEM_TEXT[p]));
      return;
    }
    setProblems([]);
    createKey.current ??= crypto.randomUUID();
    const key = createKey.current;
    // The matching-only columns (date of birth, guardian phone) are never sent with the rows: they stay in this page's memory
    // (`text`) and travel with each validate and commit request.
    const split = splitMatching(parsed.rows);
    void run(async () => {
      const created = await createImport(client, kind, split.rows, key);
      const validated = await validateImport(client, kind, created.data.id, split.matching);
      setJob(validated);
      await loadRows(validated.id, 0, true);
    });
  };

  /** The matching entries of the file currently held in memory (empty after a reload: the server then refuses a commit). */
  const matchingOfText = (): ReturnType<typeof splitMatching>['matching'] =>
    splitMatching(parseCsv(text).rows).matching;

  const revalidate = (): void => {
    if (!job) return;
    void run(async () => {
      setJob(await validateImport(client, kind, job.id, matchingOfText()));
      await loadRows(job.id, 0, true);
    });
  };

  const commit = (e: FormEvent): void => {
    e.preventDefault();
    if (!job) return;
    if (reason.trim().length < 5) {
      setReasonError('Give a reason of at least 5 characters.');
      return;
    }
    setReasonError(null);
    if (commitKey.current?.version !== job.version) {
      commitKey.current = { version: job.version, key: crypto.randomUUID() };
    }
    const key = commitKey.current.key;
    const matchingNow = matchingOfText();
    void run(async () => {
      try {
        const done = await commitImport(
          client,
          kind,
          job,
          {
            reason: reason.trim(),
            acknowledgeWarnings: ack,
            ...(matchingNow.length > 0 ? { matching: matchingNow } : {}),
          },
          key,
        );
        setJob({
          ...job,
          status: 'COMMITTED',
          version: done.version,
          summary: { ...job.summary, createdRows: done.createdRows },
        });
        setNotice(
          `Imported. ${done.createdRows} record${done.createdRows === 1 ? '' : 's'} created.`,
        );
      } catch (err) {
        await reload(job.id);
        throw err;
      }
    });
  };

  const backToUpload = (): void => {
    setJob(null);
    setRows([]);
    setNext(null);
    createKey.current = null;
  };

  const reset = (): void => {
    setJob(null);
    setRows([]);
    setNext(null);
    setText('');
    setReason('');
    setAck(false);
    setError(null);
    setNotice(null);
    createKey.current = null;
    commitKey.current = null;
  };

  const warnings = job?.summary.rowsWithWarnings ?? 0;
  const hasIssues = (job?.summary.errorCount ?? 0) + (job?.summary.warningCount ?? 0) > 0;

  // Parsed row preview before upload
  const parsedPreview = text.trim() ? parseCsv(text) : null;
  const previewRows = parsedPreview?.rows.slice(0, 5) ?? [];
  const firstPreviewRow = previewRows[0];
  const previewHeaders = firstPreviewRow ? Object.keys(firstPreviewRow) : [];

  // Determine current wizard step
  const currentStep = !job ? 1 : job.status === 'COMMITTED' ? 3 : 2;

  return (
    <>
      <PageHeader
        title="Imports"
        subtitle="Import student or employee records from a CSV file in three steps: upload and validate, review exactly what will change, then commit. Nothing is created until you commit."
      />

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {/* Introduction Guide Panel */}
      <section className="import-intro-panel" aria-label="Import process overview">
        <div className="import-intro-header">
          <div className="import-intro-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <h2 className="import-intro-title">Institutional Bulk Record Ingestion</h2>
        </div>
        <p className="import-intro-desc">
          Automate student cohort enrolment and employee onboarding safely. Bulk ingestion eliminates manual record entry while strictly enforcing institution-wide schema validation, duplicate detection, and two-phase preview before committing.
        </p>
        <div className="import-highlights-grid">
          <div className="import-highlight-item">
            <strong>Target Administrators</strong>
            <p>Designed for Admissions Registrars, Academic Deans, and HR Staff managing large batches.</p>
          </div>
          <div className="import-highlight-item">
            <strong>Created vs Matched</strong>
            <p>Created records bind to active accounts. Name, DOB, and phone are matching-only probes and are never stored.</p>
          </div>
          <div className="import-highlight-item">
            <strong>Strict Review Gate</strong>
            <p>No records are written to the database until an authorized administrator verifies the preview and provides an audit reason.</p>
          </div>
          <div className="import-highlight-item">
            <strong>Security & Injection Safe</strong>
            <p>Tenant-isolated with RLS enforcement, formula prefix neutralization, and full audit logging.</p>
          </div>
        </div>
      </section>

      {/* 3-Stage Progress Stepper */}
      <nav className="import-stepper" aria-label="Import progress">
        <div className={`import-step-node ${currentStep === 1 ? 'active' : 'completed'}`}>
          <div className="import-step-circle">{currentStep > 1 ? '✓' : '1'}</div>
          <div className="import-step-text">
            <span className="import-step-sub">Step 1</span>
            <span className="import-step-name">Prepare & Upload</span>
          </div>
        </div>
        <span className="import-step-arrow" aria-hidden="true">→</span>
        <div
          className={`import-step-node ${
            currentStep === 2 ? 'active' : currentStep > 2 ? 'completed' : ''
          }`}
        >
          <div className="import-step-circle">{currentStep > 2 ? '✓' : '2'}</div>
          <div className="import-step-text">
            <span className="import-step-sub">Step 2</span>
            <span className="import-step-name">Validate & Review</span>
          </div>
        </div>
        <span className="import-step-arrow" aria-hidden="true">→</span>
        <div
          className={`import-step-node ${
            currentStep === 3 && job?.status === 'COMMITTED'
              ? 'completed'
              : currentStep === 3 || job?.status === 'VALIDATED'
                ? 'active'
                : ''
          }`}
        >
          <div className="import-step-circle">{job?.status === 'COMMITTED' ? '✓' : '3'}</div>
          <div className="import-step-text">
            <span className="import-step-sub">Step 3</span>
            <span className="import-step-name">Confirm & Import</span>
          </div>
        </div>
      </nav>

      {/* Step 1: Prepare & Upload */}
      {!job && (
        <Card title="1. Choose the file">
          <form onSubmit={start} noValidate aria-label="Upload import file">
            <fieldset style={{ border: 'none', padding: 0, margin: '0 0 var(--space-4) 0' }}>
              <legend style={{ fontWeight: 700, fontSize: '0.9375rem', marginBottom: 'var(--space-3)' }}>
                Records to import
              </legend>
              <div className="import-kinds-container">
                {allowed.map((k) => (
                  <label
                    key={k}
                    className={`import-kind-option ${kind === k ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === k}
                      onChange={() => {
                        setKind(k);
                        createKey.current = null;
                      }}
                    />
                    <div className="import-kind-content">
                      <div className="import-kind-title">{KINDS[k].label}</div>
                      <div className="import-kind-summary">{KINDS[k].description}</div>
                    </div>
                  </label>
                ))}
              </div>
            </fieldset>

            {allowed.length === 0 && (
              <Alert tone="info">You are not allowed to import any kind of record.</Alert>
            )}

            {/* Template Download and Documentation Bar */}
            <div className="import-template-actions">
              <div className="import-template-info">
                <strong>Need an example format?</strong> Download a pre-formatted CSV template with standard institutional column headers.
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={() => downloadTemplate(kind)}
              >
                Download {KINDS[kind].shortLabel} CSV Template
              </Button>
            </div>

            {/* Documentation & Limits */}
            <div className="field-hint" style={{ marginBottom: 'var(--space-4)' }}>
              Columns (first row): {KINDS[kind].columns}. At most 1000 rows, 200 characters per
              value. Dates are YYYY-MM-DD.
            </div>

            {/* Accessible Drag-and-Drop Dropzone */}
            <div
              className={`import-dropzone ${isDragging ? 'dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                className="file-input-native"
                aria-label="Upload CSV file"
              />
              <div className="import-dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                  <path d="M12 12v9" />
                  <path d="m8 16 4-4 4 4" />
                </svg>
              </div>
              <div className="import-dropzone-title">
                Drag and drop your institutional CSV file here, or click to browse
              </div>
              <div className="import-dropzone-sub">
                Supports UTF-8 CSV up to 1,000 rows. Clean spreadsheet formatting is verified on upload.
              </div>
            </div>

            {/* Secondary Paste Mode */}
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
                <label htmlFor="csv-text" style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                  Or paste the CSV text
                </label>
                <button
                  type="button"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-primary)',
                    fontSize: '0.8125rem',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                  onClick={() => setShowPasteBox((v) => !v)}
                >
                  {showPasteBox ? 'Collapse paste area' : 'Expand paste area'}
                </button>
              </div>
              <textarea
                id="csv-text"
                rows={showPasteBox || text.length > 0 ? 8 : 4}
                value={text}
                placeholder={KINDS[kind].example}
                onChange={(e) => {
                  setText(e.target.value);
                  createKey.current = null;
                }}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.8125rem' }}
              />
            </div>

            {/* In-Memory Parsed Preview (before validation) */}
            {previewRows.length > 0 && (
              <div className="import-parsed-preview">
                <div style={{ padding: '0.5rem 0.75rem', background: '#f5f3f9', fontWeight: 600, fontSize: '0.8125rem', borderBottom: '1px solid var(--color-border)' }}>
                  Detected Data Preview ({parsedPreview?.rows.length ?? 0} rows found in CSV)
                </div>
                <table className="import-parsed-table">
                  <thead>
                    <tr>
                      <th style={{ width: '3rem' }}>#</th>
                      {previewHeaders.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((r, idx) => (
                      <tr key={idx}>
                        <td style={{ fontWeight: 600, color: 'var(--color-muted)' }}>{idx + 1}</td>
                        {previewHeaders.map((h) => (
                          <td key={h}>{r[h] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {problems.length > 0 && (
              <Alert tone="error">
                <ul>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            )}

            <div style={{ marginTop: 'var(--space-4)' }}>
              <Button type="submit" pending={busy} disabled={allowed.length === 0}>
                Upload and validate
              </Button>
            </div>
          </form>
        </Card>
      )}

      {busy && !job && <Spinner label="Validating…" />}

      {/* Step 2: Validate & Review */}
      {job && (
        <Card title="2. Review">
          {/* Summary Stats Cards */}
          <div className="import-stats-row">
            <div className="import-stat-card">
              <div className="import-stat-num">{job.rowCount}</div>
              <div className="import-stat-lbl">Total Rows</div>
            </div>
            <div className="import-stat-card stat-valid">
              <div className="import-stat-num" style={{ color: 'var(--color-emerald)' }}>
                {job.summary.validRows ?? 0}
              </div>
              <div className="import-stat-lbl">Valid Records</div>
            </div>
            <div className="import-stat-card stat-warnings">
              <div className="import-stat-num" style={{ color: '#d97706' }}>
                {warnings}
              </div>
              <div className="import-stat-lbl">Warnings / Duplicates</div>
            </div>
            <div className="import-stat-card stat-errors">
              <div className="import-stat-num" style={{ color: 'var(--color-coral)' }}>
                {job.summary.invalidRows ?? 0}
              </div>
              <div className="import-stat-lbl">Rejected Rows</div>
            </div>
          </div>

          <p>
            <Badge>{job.status}</Badge> {job.rowCount} row{job.rowCount === 1 ? '' : 's'}:{' '}
            {job.summary.validRows ?? 0} valid, {job.summary.invalidRows ?? 0} with errors,{' '}
            {warnings} with warnings.
          </p>

          {hasIssues && (
            <p>
              <a href={client.url(errorReportPath(kind, job.id))} download>
                Download the error report (CSV)
              </a>
            </p>
          )}

          <div style={{ display: 'flex', gap: 'var(--space-3)', margin: 'var(--space-3) 0' }}>
            <Button variant="secondary" onClick={backToUpload}>
              ← Back to Upload / Modify
            </Button>
            {(job.status === 'DRAFT' || job.status === 'VALIDATED') && (
              <Button variant="secondary" pending={busy} onClick={revalidate}>
                Validate again
              </Button>
            )}
          </div>

          {job.status === 'DRAFT' && (
            <Alert tone="info">
              Some rows have errors. Fix the file and upload it again; a job with errors cannot be
              committed.
            </Alert>
          )}

          {job.status === 'FAILED' && (
            <Alert tone="error">
              This import was closed and nothing was imported. Download the error report, fix the
              file and import again.
            </Alert>
          )}

          {/* Proposed Changes Row List */}
          <ul aria-label="Rows" className="import-rows-list">
            {rows.map((r) => {
              const isDuplicate = r.warnings.some((w) => w.code.includes('DUPLICATE'));
              const isInvalid = r.status === 'INVALID' || r.errors.length > 0;
              const isNew = r.status === 'VALID' && !isDuplicate;

              return (
                <li
                  key={r.rowNo}
                  className={`import-row-card ${isInvalid ? 'row-invalid' : isDuplicate ? 'row-warning' : ''}`}
                >
                  <div className="import-row-header">
                    <div>
                      <strong>Row {r.rowNo}</strong> <Badge>{r.status}</Badge>
                      {isNew && <span className="badge-row-new">NEW RECORD</span>}
                      {isDuplicate && <span className="badge-row-duplicate">POSSIBLE DUPLICATE</span>}
                      {isInvalid && <span className="badge-row-invalid">REJECTED / INVALID</span>}
                    </div>
                  </div>
                  <div className="import-row-change">{describeChange(r)}</div>
                  {r.errors.map((i, n) => (
                    <div key={`e${n}`} role="note" style={{ color: 'var(--color-coral)', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
                      Error: {issueText(i)}
                    </div>
                  ))}
                  {r.warnings.map((i, n) => (
                    <div key={`w${n}`} role="note" style={{ color: '#b45309', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
                      Warning: {issueText(i)}
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>

          {next !== null && (
            <Button
              variant="secondary"
              pending={busy}
              onClick={() => void run(() => loadRows(job.id, next, false))}
            >
              Show more rows
            </Button>
          )}
        </Card>
      )}

      {/* Step 3: Confirm & Commit */}
      {job?.status === 'VALIDATED' && (
        <Card title="3. Commit">
          <div style={{ marginBottom: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 'var(--radius)' }}>
            <strong style={{ color: '#065f46' }}>Ready to commit:</strong>{' '}
            <span style={{ color: '#047857' }}>
              {job.summary.validRows ?? 0} record{(job.summary.validRows ?? 0) === 1 ? '' : 's'} will be safely created. No existing records will be silently overwritten.
            </span>
          </div>

          <form onSubmit={commit} noValidate aria-label="Commit import">
            <div className="field">
              <label htmlFor="commit-reason">Reason</label>
              <input
                id="commit-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="e.g. Approved Fall 2026 admissions batch"
              />
              {reasonError && <p className="field-error">{reasonError}</p>}
            </div>
            {warnings > 0 && (
              <label style={{ display: 'block', margin: 'var(--space-3) 0', fontWeight: 600 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I
                have reviewed the warnings
              </label>
            )}
            <Button type="submit" pending={busy}>
              Commit import
            </Button>
          </form>
        </Card>
      )}

      {/* Post-Commit / Post-Failed Actions */}
      {job && (job.status === 'COMMITTED' || job.status === 'FAILED') && (
        <Card title={job.status === 'COMMITTED' ? 'Import Complete' : 'Import Terminated'}>
          {job.status === 'COMMITTED' && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <p style={{ fontSize: '0.9375rem', marginBottom: 'var(--space-3)' }}>
                The import job has completed successfully and all audit records have been permanently logged. You can view the newly created records directly in the module register:
              </p>
              <Link
                to={KINDS[kind].targetRoute}
                className="btn btn-primary"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  textDecoration: 'none',
                  padding: '0.5rem 1rem',
                  background: 'var(--color-primary)',
                  color: '#ffffff',
                  borderRadius: 'var(--radius)',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  marginRight: 'var(--space-3)',
                }}
              >
                Go to {KINDS[kind].targetLabel} →
              </Link>
            </div>
          )}
          <Button variant="secondary" onClick={reset}>
            Start another import
          </Button>
        </Card>
      )}
    </>
  );
}
