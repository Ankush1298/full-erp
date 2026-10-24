import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import {
  FileDuplicates,
  issue,
  sortIssues,
  utcToday,
  type CheckInputRow,
  type CheckResult,
  type ImportAdapter,
  type ParseResult,
  type Proposal,
  type RawRow,
  type RowIssue,
} from '../imports/import.common.js';
import { EMPLOYEE_CODE_PATTERN, EMPLOYEE_TYPES, type EmployeeType } from './employee.schemas.js';
import { EmployeeService } from './employee.service.js';
import { parseDate } from './validation.js';

const COLUMNS = ['email', 'employeeCode', 'employeeType', 'joiningDate'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = new RegExp(EMPLOYEE_CODE_PATTERN);

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
 * Employee-record import (Milestone 2, Batch 2; doc 26): the "faculty" import of doc 04 Part 16, which creates employee
 * records of any employee_type for EXISTING accounts, exactly as `POST /faculty/employees` does, by calling the same
 * service. No accounts, invitations, postings or role assignments are created. Duplicate detection is exact identity only:
 * the account, the employee code and a repeated e-mail or code inside the file. The documents define no fuzzy rule for staff.
 */
export const employeeImportAdapter: ImportAdapter = {
  type: 'EMPLOYEE_RECORDS',
  createPermission: 'employee.record.create',
  createOperation: 'POST /api/v1/faculty/imports',

  parse(raw: RawRow): ParseResult {
    const errors: RowIssue[] = [];
    for (const key of Object.keys(raw)) {
      if (!(COLUMNS as readonly string[]).includes(key)) {
        errors.push(
          issue('UNKNOWN_COLUMN', 'This column is not part of the employee import.', key),
        );
      }
    }
    const text = (field: string): string => (raw[field] ?? '').trim();

    const email = text('email').toLowerCase();
    if (email === '') errors.push(issue('REQUIRED', 'A value is required.', 'email'));
    else if (email.length > 320 || !EMAIL_RE.test(email) || hasControlCharacters(email)) {
      errors.push(issue('INVALID_EMAIL', 'Not a valid e-mail address.', 'email'));
    }

    const employeeCode = text('employeeCode');
    if (employeeCode === '') errors.push(issue('REQUIRED', 'A value is required.', 'employeeCode'));
    else if (!CODE_RE.test(employeeCode)) {
      errors.push(
        issue(
          'INVALID_EMPLOYEE_CODE',
          'Must be 1 to 50 letters, digits, "-" or "_".',
          'employeeCode',
        ),
      );
    }

    const employeeType = text('employeeType');
    if (employeeType === '') errors.push(issue('REQUIRED', 'A value is required.', 'employeeType'));
    else if (!(EMPLOYEE_TYPES as readonly string[]).includes(employeeType)) {
      errors.push(
        issue(
          'INVALID_EMPLOYEE_TYPE',
          `Must be one of ${EMPLOYEE_TYPES.join(', ')}.`,
          'employeeType',
        ),
      );
    }

    const joiningDateText = text('joiningDate');
    let joiningDate = '';
    if (joiningDateText === '')
      errors.push(issue('REQUIRED', 'A value is required.', 'joiningDate'));
    else {
      try {
        joiningDate = parseDate(joiningDateText, 'joiningDate');
      } catch {
        errors.push(
          issue('INVALID_DATE', 'Must be a real calendar date, YYYY-MM-DD.', 'joiningDate'),
        );
      }
    }

    if (errors.length > 0) return { proposal: null, errors: sortIssues(errors) };
    return {
      proposal: {
        action: 'CREATE_EMPLOYEE_RECORD',
        email,
        employeeCode,
        employeeType,
        joiningDate,
        initialStatus: 'ACTIVE',
      },
      errors: [],
    };
  },

  async check(
    tx: TenantTx,
    ctx: TrustedContext,
    rows: readonly CheckInputRow[],
  ): Promise<Map<number, CheckResult>> {
    const out = new Map<number, CheckResult>();
    if (rows.length === 0) return out;
    const emails = [...new Set(rows.map((r) => String(r.proposal.email)))];
    const codes = [...new Set(rows.map((r) => String(r.proposal.employeeCode)))];

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
    const taken = await tx.query<{ employee_code: string }>(
      `SELECT employee_code FROM app.employees
        WHERE organization_id = $1 AND employee_code = ANY($2::text[])`,
      [ctx.tenantId, codes],
    );
    const takenCodes = new Set(taken.rows.map((r) => r.employee_code));

    const duplicates = new FileDuplicates();
    const today = utcToday();
    for (const { rowNo, proposal } of rows) {
      const errors: RowIssue[] = [];
      const warnings: RowIssue[] = [];
      const email = String(proposal.email);
      const code = String(proposal.employeeCode);

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
      const firstCode = duplicates.seen('employeeCode', code, rowNo);
      if (firstCode !== undefined) {
        errors.push(
          issue(
            'DUPLICATE_IN_FILE',
            'This employee code already appears in an earlier row.',
            'employeeCode',
            firstCode,
          ),
        );
      }
      if (takenCodes.has(code)) {
        errors.push(
          issue(
            'EMPLOYEE_CODE_EXISTS',
            'An employee with this code already exists.',
            'employeeCode',
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
        if (account.status === 'DEACTIVATED') {
          errors.push(
            issue(
              'ACCOUNT_DEACTIVATED',
              'A deactivated account cannot be given an employee record.',
              'email',
            ),
          );
        } else if (account.status === 'INVITED') {
          warnings.push(
            issue(
              'ACCOUNT_NOT_ACTIVATED',
              'The account has not accepted its invitation yet.',
              'email',
            ),
          );
        } else if (account.status === 'SUSPENDED') {
          warnings.push(issue('ACCOUNT_SUSPENDED', 'The account is suspended.', 'email'));
        }
        if (withStudent.has(account.id)) {
          errors.push(
            issue(
              'ACCOUNT_HAS_STUDENT_RECORD',
              'This account already has a student record.',
              'email',
            ),
          );
        }
        if (withEmployee.has(account.id)) {
          errors.push(
            issue(
              'ACCOUNT_HAS_EMPLOYEE_RECORD',
              'This account already has an employee record.',
              'email',
            ),
          );
        }
      }
      if (String(proposal.joiningDate) > today) {
        warnings.push(issue('FUTURE_DATE', 'The joining date is in the future.', 'joiningDate'));
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
    return EmployeeService.insertRecord(
      tx,
      ctx,
      {
        userId: String(proposal.userId),
        code: String(proposal.employeeCode),
        employeeType: String(proposal.employeeType) as EmployeeType,
        joiningDate: String(proposal.joiningDate),
        reason,
      },
      meta,
    );
  },
};
