import { useCallback, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
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

const KINDS: Record<
  ImportKind,
  { label: string; permission: string; columns: string; example: string }
> = {
  students: {
    label: 'Student records',
    permission: 'student.record.create',
    columns:
      'email, admissionNumber, admissionDate; optional, used only to look for a possible duplicate and never stored (sent again with each step and kept in this page only): name, dateOfBirth (YYYY-MM-DD), guardianPhone',
    example: 'email,admissionNumber,admissionDate\nasha@college.example,ADM-2026-001,2026-07-01',
  },
  faculty: {
    label: 'Employee records (faculty and staff)',
    permission: 'employee.record.create',
    columns: 'email, employeeCode, employeeType, joiningDate',
    example:
      'email,employeeCode,employeeType,joiningDate\nravi@college.example,EMP-001,FACULTY,2026-06-01',
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
    if (file) void file.text().then(setText);
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

  return (
    <>
      <h1>Imports</h1>
      <p className="lead">
        Import student or employee records from a CSV file in three steps: upload and validate,
        review exactly what will change, then commit. Nothing is created until you commit. Rows name
        an existing account by its e-mail address; accounts are created by invitation, not by
        import.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {!job && (
        <Card title="1. Choose the file">
          <form onSubmit={start} noValidate aria-label="Upload import file">
            <fieldset>
              <legend>Records to import</legend>
              {allowed.map((k) => (
                <label key={k} style={{ display: 'block' }}>
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      createKey.current = null;
                    }}
                  />{' '}
                  {KINDS[k].label}
                </label>
              ))}
            </fieldset>
            {allowed.length === 0 && (
              <Alert tone="info">You are not allowed to import any kind of record.</Alert>
            )}
            <p className="field-hint">
              Columns (first row): {KINDS[kind].columns}. At most 1000 rows, 200 characters per
              value. Dates are YYYY-MM-DD.
            </p>
            <div className="field">
              <label htmlFor="csv-file">CSV file</label>
              <input id="csv-file" type="file" accept=".csv,text/csv" onChange={onFile} />
            </div>
            <div className="field">
              <label htmlFor="csv-text">Or paste the CSV text</label>
              <textarea
                id="csv-text"
                rows={8}
                value={text}
                placeholder={KINDS[kind].example}
                onChange={(e) => {
                  setText(e.target.value);
                  createKey.current = null;
                }}
              />
            </div>
            {problems.length > 0 && (
              <Alert tone="error">
                <ul>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <Button type="submit" pending={busy} disabled={allowed.length === 0}>
              Upload and validate
            </Button>
          </form>
        </Card>
      )}

      {busy && !job && <Spinner label="Validating…" />}

      {job && (
        <Card title="2. Review">
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
          {(job.status === 'DRAFT' || job.status === 'VALIDATED') && (
            <Button variant="secondary" pending={busy} onClick={revalidate}>
              Validate again
            </Button>
          )}
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
          <ul aria-label="Rows">
            {rows.map((r) => (
              <li key={r.rowNo}>
                <strong>Row {r.rowNo}</strong> <Badge>{r.status}</Badge>
                <div>{describeChange(r)}</div>
                {r.errors.map((i, n) => (
                  <div key={`e${n}`} role="note">
                    Error: {issueText(i)}
                  </div>
                ))}
                {r.warnings.map((i, n) => (
                  <div key={`w${n}`} role="note">
                    Warning: {issueText(i)}
                  </div>
                ))}
              </li>
            ))}
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

      {job?.status === 'VALIDATED' && (
        <Card title="3. Commit">
          <form onSubmit={commit} noValidate aria-label="Commit import">
            <div className="field">
              <label htmlFor="commit-reason">Reason</label>
              <input
                id="commit-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
              {reasonError && <p className="field-error">{reasonError}</p>}
            </div>
            {warnings > 0 && (
              <label style={{ display: 'block' }}>
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

      {job && (job.status === 'COMMITTED' || job.status === 'FAILED') && (
        <Button variant="secondary" onClick={reset}>
          Start another import
        </Button>
      )}
    </>
  );
}
