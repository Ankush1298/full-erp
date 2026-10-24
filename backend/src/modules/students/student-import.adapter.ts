import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { parseDate } from '../people/validation.js';
import {
  FileDuplicates,
  issue,
  sortIssues,
  utcToday,
  type CheckInputRow,
  type CheckResult,
  type ImportAdapter,
  type MatchInput,
  type MatchingCells,
  type ParseResult,
  type Proposal,
  type RawRow,
  type RowIssue,
} from '../imports/import.common.js';
import { ADMISSION_NUMBER_PATTERN } from './student.schemas.js';
import { StudentService } from './student.service.js';
import {
  POSSIBLE_DUPLICATE_IN_FILE,
  POSSIBLE_DUPLICATE_IN_FILE_MESSAGE,
  POSSIBLE_DUPLICATE_MESSAGE,
  POSSIBLE_DUPLICATE_STUDENT,
  StudentDuplicateService,
  firstEarlierMatches,
} from './student-duplicate.service.js';

// `name` is an OPTIONAL, MATCHING-ONLY column (doc 26 §3.5): it feeds the possible-duplicate check and is not stored on a
// record. The date of birth and the guardian phone are NOT columns of a stored row: the client resupplies them with every
// validate and commit request (`parseMatching`), so they never reach the database.
const COLUMNS = ['email', 'admissionNumber', 'admissionDate', 'name'] as const;
const MAX_NAME = 200;
const MAX_PHONE = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMISSION_RE = new RegExp(ADMISSION_NUMBER_PATTERN);

function hasControlCharacters(s: string): boolean {
  return Array.from(s).some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || c === 0x7f;
  });
}

interface AccountRow {
  id: string;
  email: string;
  status: string;
}

/**
 * Student-record import (Milestone 2, Batch 2; doc 26). A row names an EXISTING account by its e-mail address and gives the
 * admission number and date; a commit creates exactly what `POST /students` creates for that account (status ADMITTED), by
 * calling the same service. The import never creates accounts, sends invitations, enrols into programs or touches guardians.
 *
 * Duplicate detection: EXACT identity errors (the account has one student record, the admission number is unique per
 * organization, a repeated e-mail or admission number inside the file) and the POSSIBLE_DUPLICATE_STUDENT WARNING of doc 02
 * §6.2 (normalised name + date of birth + guardian phone all match; StudentDuplicateService, owner decisions in doc 26 §3.5).
 * The warning needs the acknowledgement of the commit; nothing is ever merged and the matching inputs are never stored on a
 * record.
 */
export const studentImportAdapter: ImportAdapter = {
  type: 'STUDENT_RECORDS',
  createPermission: 'student.record.create',
  createOperation: 'POST /api/v1/students/imports',

  parse(raw: RawRow): ParseResult {
    const errors: RowIssue[] = [];
    for (const key of Object.keys(raw)) {
      if (!(COLUMNS as readonly string[]).includes(key)) {
        errors.push(issue('UNKNOWN_COLUMN', 'This column is not part of the student import.', key));
      }
    }
    const text = (field: string): string => (raw[field] ?? '').trim();

    const email = text('email').toLowerCase();
    if (email === '') errors.push(issue('REQUIRED', 'A value is required.', 'email'));
    else if (email.length > 320 || !EMAIL_RE.test(email) || hasControlCharacters(email)) {
      errors.push(issue('INVALID_EMAIL', 'Not a valid e-mail address.', 'email'));
    }

    const admissionNumber = text('admissionNumber');
    if (admissionNumber === '') {
      errors.push(issue('REQUIRED', 'A value is required.', 'admissionNumber'));
    } else if (!ADMISSION_RE.test(admissionNumber)) {
      errors.push(
        issue(
          'INVALID_ADMISSION_NUMBER',
          'Must be 1 to 50 letters, digits, "-" or "_".',
          'admissionNumber',
        ),
      );
    }

    const admissionDateText = text('admissionDate');
    let admissionDate = '';
    if (admissionDateText === '') {
      errors.push(issue('REQUIRED', 'A value is required.', 'admissionDate'));
    } else {
      try {
        admissionDate = parseDate(admissionDateText, 'admissionDate');
      } catch {
        errors.push(
          issue('INVALID_DATE', 'Must be a real calendar date, YYYY-MM-DD.', 'admissionDate'),
        );
      }
    }

    // Matching-only cells. A missing or unusable one is not an error: it just means the check cannot match.
    const match: MatchInput = {};
    const name = text('name');
    if (name !== '') {
      if (name.length > MAX_NAME || hasControlCharacters(name)) {
        errors.push(issue('INVALID_NAME', 'The name is not valid.', 'name'));
      } else match.name = name;
    }
    if (errors.length > 0) return { proposal: null, errors: sortIssues(errors) };
    return {
      proposal: {
        action: 'CREATE_STUDENT_RECORD',
        email,
        admissionNumber,
        admissionDate,
        initialStatus: 'ADMITTED',
      },
      errors: [],
      match,
    };
  },

  parseMatching(cells: MatchingCells): { match: MatchInput; errors: RowIssue[] } {
    const errors: RowIssue[] = [];
    const match: MatchInput = {};
    const dobText = (cells.dateOfBirth ?? '').trim();
    if (dobText !== '') {
      try {
        const dob = parseDate(dobText, 'dateOfBirth');
        if (dob > utcToday()) throw new Error('future');
        match.dateOfBirth = dob;
      } catch {
        errors.push(
          issue(
            'INVALID_DATE',
            'Must be a real calendar date in the past, YYYY-MM-DD.',
            'dateOfBirth',
          ),
        );
      }
    }
    const phone = (cells.guardianPhone ?? '').trim();
    if (phone !== '') {
      if (phone.length > MAX_PHONE) {
        errors.push(issue('INVALID_PHONE', 'The phone number is too long.', 'guardianPhone'));
      } else match.guardianPhone = phone;
    }
    return { match, errors: sortIssues(errors) };
  },

  async check(
    tx: TenantTx,
    ctx: TrustedContext,
    rows: readonly CheckInputRow[],
  ): Promise<Map<number, CheckResult>> {
    const out = new Map<number, CheckResult>();
    if (rows.length === 0) return out;
    const emails = [...new Set(rows.map((r) => String(r.proposal.email)))];
    const numbers = [...new Set(rows.map((r) => String(r.proposal.admissionNumber)))];

    const accounts = await tx.query<AccountRow>(
      `SELECT id, email, status FROM app.users WHERE organization_id = $1 AND email = ANY($2::text[])`,
      [ctx.tenantId, emails],
    );
    const byEmail = new Map(accounts.rows.map((a) => [a.email, a]));
    const accountIds = accounts.rows.map((a) => a.id);

    const students = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM app.students WHERE organization_id = $1 AND user_id = ANY($2::uuid[])`,
      [ctx.tenantId, accountIds],
    );
    const withStudent = new Set(students.rows.map((r) => r.user_id));
    const employees = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM app.employees WHERE organization_id = $1 AND user_id = ANY($2::uuid[])`,
      [ctx.tenantId, accountIds],
    );
    const withEmployee = new Set(employees.rows.map((r) => r.user_id));
    const taken = await tx.query<{ admission_number: string }>(
      `SELECT admission_number FROM app.students
        WHERE organization_id = $1 AND admission_number = ANY($2::text[])`,
      [ctx.tenantId, numbers],
    );
    const takenNumbers = new Set(taken.rows.map((r) => r.admission_number));

    // Possible duplicates: one set-based, read-only, tenant-scoped check for the whole file. It runs again, unchanged, in the
    // commit-time revalidation. It sees only rows that parsed, and never an account that is itself already a student.
    const fingerprints = await StudentDuplicateService.find(
      tx,
      ctx,
      rows.map((r) => ({
        ...(r.match ?? {}),
        ...(byEmail.get(String(r.proposal.email))
          ? { excludeUserId: byEmail.get(String(r.proposal.email))!.id }
          : {}),
      })),
    );
    const possibleDuplicate = new Set(
      rows.flatMap((r, i) => (fingerprints[i] !== null ? [r.rowNo] : [])),
    );
    // The same rule between the rows of this file, in row order: a row matching an earlier row warns once, against the
    // first row of its group.
    const ordered = [...rows].sort((a, b) => a.rowNo - b.rowNo);
    const anchors = firstEarlierMatches(ordered.map((r) => r.match ?? {}));
    const inFile = new Map(
      ordered.flatMap((r, i) => {
        const a = anchors[i];
        return a === null || a === undefined ? [] : [[r.rowNo, ordered[a]!.rowNo] as const];
      }),
    );

    const duplicates = new FileDuplicates();
    const today = utcToday();
    for (const { rowNo, proposal } of rows) {
      const errors: RowIssue[] = [];
      const warnings: RowIssue[] = [];
      const email = String(proposal.email);
      const admissionNumber = String(proposal.admissionNumber);

      const firstEmail = duplicates.seen('email', email, rowNo);
      if (firstEmail !== undefined) {
        errors.push(
          issue(
            'DUPLICATE_IN_FILE',
            'This e-mail already appears in an earlier row.',
            'email',
            firstEmail,
          ),
        );
      }
      const firstNumber = duplicates.seen('admissionNumber', admissionNumber, rowNo);
      if (firstNumber !== undefined) {
        errors.push(
          issue(
            'DUPLICATE_IN_FILE',
            'This admission number already appears in an earlier row.',
            'admissionNumber',
            firstNumber,
          ),
        );
      }
      if (takenNumbers.has(admissionNumber)) {
        errors.push(
          issue(
            'ADMISSION_NUMBER_EXISTS',
            'A student with this admission number already exists.',
            'admissionNumber',
          ),
        );
      }

      const account = byEmail.get(email);
      let resolved: Proposal = proposal;
      if (!account) {
        errors.push(
          issue(
            'ACCOUNT_NOT_FOUND',
            'No account with this e-mail exists in this organization.',
            'email',
          ),
        );
      } else {
        resolved = { ...proposal, userId: account.id };
        if (account.status !== 'ACTIVE') {
          errors.push(
            issue(
              'ACCOUNT_NOT_ACTIVE',
              'Only an ACTIVE account can be given a student record.',
              'email',
            ),
          );
        }
        if (withStudent.has(account.id)) {
          errors.push(
            issue(
              'ACCOUNT_HAS_STUDENT_RECORD',
              'This account already has a student record.',
              'email',
            ),
          );
        } else if (withEmployee.has(account.id)) {
          errors.push(
            issue(
              'ACCOUNT_HAS_EMPLOYEE_RECORD',
              'This account already has an employee record.',
              'email',
            ),
          );
        } else if (
          errors.length === 0 &&
          (await AuthorizationEngine.hasStaffCapableAssignment(tx, ctx.tenantId, account.id))
        ) {
          // Same predicate as StudentService.insertRecord (the commit repeats it under the person lock). Only asked of
          // rows that passed every set-based check, to keep a 1000-row validation to a few statements.
          errors.push(
            issue(
              'ACCOUNT_HAS_STAFF_ROLE',
              'This account holds a staff role assignment and cannot be given a student record.',
              'email',
            ),
          );
        }
      }
      if (String(proposal.admissionDate) > today) {
        warnings.push(
          issue('FUTURE_DATE', 'The admission date is in the future.', 'admissionDate'),
        );
      }
      if (possibleDuplicate.has(rowNo)) {
        warnings.push(issue(POSSIBLE_DUPLICATE_STUDENT, POSSIBLE_DUPLICATE_MESSAGE));
      }
      const earlier = inFile.get(rowNo);
      if (earlier !== undefined) {
        warnings.push(
          issue(POSSIBLE_DUPLICATE_IN_FILE, POSSIBLE_DUPLICATE_IN_FILE_MESSAGE, undefined, earlier),
        );
      }
      out.set(rowNo, {
        proposal: resolved,
        errors: sortIssues(errors),
        warnings: sortIssues(warnings),
      });
    }
    return out;
  },

  accountIdOf(proposal: Proposal): string {
    return String(proposal.userId);
  },

  create(
    tx: TenantTx,
    ctx: TrustedContext,
    proposal: Proposal,
    reason: string,
    meta: AuditRequestMeta,
  ): Promise<string> {
    return StudentService.insertRecord(
      tx,
      ctx,
      {
        userId: String(proposal.userId),
        admissionNumber: String(proposal.admissionNumber),
        admissionDate: String(proposal.admissionDate),
        reason,
      },
      meta,
    );
  },
};
