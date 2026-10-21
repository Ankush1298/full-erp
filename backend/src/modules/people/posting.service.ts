import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditEvent, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine, type ResourceScope } from '../../shared/authorization/engine.js';
import type { ExpectedVersion } from '../../shared/settings/index.js';
import {
  type ClosePostingBody,
  type CreatePostingBody,
  type EmployeePostingDto,
  type UpdatePostingBody,
} from './posting.schemas.js';
import { invalid, parseDate, parseReason } from './validation.js';

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

interface PostingRow {
  id: string;
  organization_id: string;
  employee_id: string;
  department_id: string;
  designation_id: string | null;
  valid_from: string;
  valid_to: string | null;
  is_primary: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  // Joined fields for scope resolution:
  user_id?: string;
  campus_id?: string;
}

const COLS = `id, organization_id, employee_id, department_id, designation_id,
              valid_from::text AS valid_from, valid_to::text AS valid_to,
              is_primary, version, created_at, updated_at`;

function toDto(r: PostingRow): EmployeePostingDto {
  return {
    id: r.id,
    organizationId: r.organization_id,
    employeeId: r.employee_id,
    departmentId: r.department_id,
    designationId: r.designation_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isPrimary: r.is_primary,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class PostingService {
  /**
   * Lists posting history for an employee.
   * Authorized by employee.profile.read.
   */
  static async listByEmployee(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
  ): Promise<EmployeePostingDto[]> {
    ensureTrusted(ctx);
    if (!isUuidV7(employeeId)) throw invalid('Invalid employee ID.');

    const empRes = await tx.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM app.employees WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, employeeId],
    );
    const emp = empRes.rows[0];
    if (!emp) throw resourceNotFound();

    await AuthorizationEngine.assert(tx, ctx, 'employee.profile.read', {
      organization_id: ctx.tenantId,
      user_id: emp.user_id,
      employee_id: emp.id,
    });

    const res = await tx.query<PostingRow>(
      `SELECT ${COLS} FROM app.employee_postings
        WHERE organization_id = $1 AND employee_id = $2
        ORDER BY valid_from DESC, created_at DESC`,
      [ctx.tenantId, employeeId],
    );

    return res.rows.map(toDto);
  }

  /**
   * Retrieves a single posting by ID.
   * Authorized by employee.profile.read.
   */
  static async getById(
    tx: TenantTx,
    ctx: TrustedContext,
    postingId: string,
  ): Promise<EmployeePostingDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(postingId)) throw invalid('Invalid posting ID.');

    const res = await tx.query<PostingRow>(
      `SELECT p.id, p.organization_id, p.employee_id, p.department_id, p.designation_id,
              p.valid_from::text AS valid_from, p.valid_to::text AS valid_to,
              p.is_primary, p.version, p.created_at, p.updated_at,
              e.user_id, d.campus_id
         FROM app.employee_postings p
         JOIN app.employees e ON e.organization_id = p.organization_id AND e.id = p.employee_id
         JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
        WHERE p.organization_id = $1 AND p.id = $2`,
      [ctx.tenantId, postingId],
    );
    const row = res.rows[0];
    if (!row) throw resourceNotFound();

    // A posting is read through its employee: the scope is the employee's active primary posting (doc 06 §3), derived
    // by the engine. The posting's own department is deliberately not offered as a claim.
    const scope: ResourceScope = { organization_id: ctx.tenantId, employee_id: row.employee_id };
    if (row.user_id) scope.user_id = row.user_id;

    await AuthorizationEngine.assert(tx, ctx, 'employee.profile.read', scope);

    return toDto(row);
  }

  /**
   * Creates an employee posting.
   * Enforces Decision C (at most one active primary posting).
   * Authorized by employee.record.update.
   */
  static async create(
    tx: TenantTx,
    ctx: TrustedContext,
    employeeId: string,
    input: CreatePostingBody,
    meta: AuditRequestMeta = {},
  ): Promise<string> {
    ensureTrusted(ctx);
    if (!isUuidV7(employeeId)) throw invalid('Invalid employee ID.');
    if (!input || typeof input !== 'object') throw invalid('Posting payload is required.');
    if (!isUuidV7(input.departmentId)) throw invalid('Invalid department ID.');
    if (input.designationId !== undefined && !isUuidV7(input.designationId)) {
      throw invalid('Invalid designation ID.');
    }

    const validFrom = parseDate(input.validFrom, 'validFrom');
    const validTo = input.validTo ? parseDate(input.validTo, 'validTo') : null;
    if (validTo !== null && validTo < validFrom) {
      throw invalid('validTo must not be earlier than validFrom.');
    }
    const isPrimary = input.isPrimary === true;
    const reason = parseReason(input.reason);

    // Lock the parent employee row (lock ordering: employee -> postings)
    const empRes = await tx.query<{
      id: string;
      user_id: string;
      status: string;
      leaving_date: string | null;
    }>(
      `SELECT id, user_id, status, leaving_date::text AS leaving_date
         FROM app.employees
        WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, employeeId],
    );
    const emp = empRes.rows[0];
    if (!emp) throw resourceNotFound();
    if (emp.status === 'SEPARATED') {
      throw new AppError(409, 'CONFLICT', 'Cannot create postings for a separated employee.');
    }

    // Verify department exists and is active in this tenant
    const deptRes = await tx.query<{
      id: string;
      campus_id: string;
      status: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, campus_id, status, deleted_at FROM app.departments
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, input.departmentId],
    );
    const dept = deptRes.rows[0];
    if (!dept || dept.deleted_at !== null) throw resourceNotFound();
    if (dept.status !== 'ACTIVE') {
      throw new AppError(409, 'CONFLICT', 'Postings can only be created in an ACTIVE department.');
    }

    // If designation is provided, verify it is active
    if (input.designationId) {
      const desRes = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM app.designations WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, input.designationId],
      );
      const des = desRes.rows[0];
      if (!des) throw resourceNotFound();
      if (des.status !== 'ACTIVE') {
        throw new AppError(409, 'CONFLICT', 'Postings can only use an ACTIVE designation.');
      }
    }

    // Authorize caller to manage employee record in target department / campus
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update', {
      organization_id: ctx.tenantId,
      department_id: dept.id,
      campus_id: dept.campus_id,
    });
    // And authorize touching this employee record
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update', {
      organization_id: ctx.tenantId,
      user_id: emp.user_id,
      employee_id: emp.id,
    });

    // Decision C: Enforce at most one active primary posting
    if (isPrimary && validTo === null) {
      const existingPrimary = await tx.query(
        `SELECT 1 FROM app.employee_postings
          WHERE organization_id = $1 AND employee_id = $2 AND is_primary = true AND valid_to IS NULL`,
        [ctx.tenantId, employeeId],
      );
      if ((existingPrimary.rowCount ?? 0) > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'An active primary posting already exists for this employee.',
        );
      }
    }

    const id = uuidv7();
    try {
      await tx.query(
        `INSERT INTO app.employee_postings
           (id, organization_id, employee_id, department_id, designation_id, valid_from, valid_to, is_primary)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8)`,
        [
          id,
          ctx.tenantId,
          employeeId,
          dept.id,
          input.designationId ?? null,
          validFrom,
          validTo,
          isPrimary,
        ],
      );
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'employee_postings_one_primary_uq') {
        throw new AppError(
          409,
          'CONFLICT',
          'An active primary posting already exists for this employee.',
        );
      }
      if (e.code === '23P01' && e.constraint === 'employee_postings_no_overlap') {
        throw new AppError(
          409,
          'CONFLICT',
          'Employee posting overlaps an existing posting in this department.',
        );
      }
      throw err;
    }

    await recordAudit(
      tx,
      ctx,
      {
        action: 'employee.posting.create',
        resourceType: 'employee_posting',
        resourceId: id,
        departmentId: dept.id,
        campusId: dept.campus_id,
        riskTier: 2,
        reasonText: reason,
        changes: {
          employeeId,
          departmentId: dept.id,
          designationId: input.designationId ?? null,
          validFrom,
          validTo,
          isPrimary,
        },
      },
      meta,
    );

    return id;
  }

  /**
   * Updates an existing employee posting.
   * Closed postings cannot be re-opened or modified.
   * Authorized by employee.record.update.
   */
  static async update(
    tx: TenantTx,
    ctx: TrustedContext,
    postingId: string,
    input: UpdatePostingBody,
    options: { expected?: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<EmployeePostingDto> {
    ensureTrusted(ctx);
    if (!isUuidV7(postingId)) throw invalid('Invalid posting ID.');
    if (!input || typeof input !== 'object') throw invalid('Update payload is required.');

    const reason = parseReason(input.reason);
    if (
      input.designationId === undefined &&
      input.validTo === undefined &&
      input.isPrimary === undefined
    ) {
      throw invalid('At least one field to change must be provided.');
    }

    // Lock order is employee -> postings everywhere (create, separation, the posting guard). Taking the posting first
    // would deadlock against a concurrent separation, which holds the employee and then wants this posting.
    const owner = await tx.query<{ employee_id: string }>(
      'SELECT employee_id FROM app.employee_postings WHERE organization_id = $1 AND id = $2',
      [ctx.tenantId, postingId],
    );
    if (!owner.rows[0]) throw resourceNotFound();
    await tx.query(
      'SELECT 1 FROM app.employees WHERE organization_id = $1 AND id = $2 FOR NO KEY UPDATE',
      [ctx.tenantId, owner.rows[0].employee_id],
    );

    const current = await tx.query<PostingRow>(
      `SELECT p.id, p.organization_id, p.employee_id, p.department_id, p.designation_id,
              p.valid_from::text AS valid_from, p.valid_to::text AS valid_to,
              p.is_primary, p.version, p.created_at, p.updated_at,
              e.user_id, d.campus_id
         FROM app.employee_postings p
         JOIN app.employees e ON e.organization_id = p.organization_id AND e.id = p.employee_id
         JOIN app.departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
        WHERE p.organization_id = $1 AND p.id = $2 FOR NO KEY UPDATE OF p`,
      [ctx.tenantId, postingId],
    );
    const row = current.rows[0];
    if (!row) throw resourceNotFound();

    if (row.valid_to !== null) {
      throw new AppError(409, 'CONFLICT', 'A closed employee posting cannot be modified.');
    }

    const deptScope: ResourceScope = {
      organization_id: ctx.tenantId,
      department_id: row.department_id,
    };
    if (row.campus_id) deptScope.campus_id = row.campus_id;
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update', deptScope);

    const empScope: ResourceScope = {
      organization_id: ctx.tenantId,
      employee_id: row.employee_id,
    };
    if (row.user_id) empScope.user_id = row.user_id;
    await AuthorizationEngine.assert(tx, ctx, 'employee.record.update', empScope);

    if (options.expected) {
      const exp = options.expected;
      if (exp.type === 'initial' || (exp.type === 'version' && exp.version !== row.version)) {
        throw new AppError(409, 'CONFLICT', 'Employee posting version mismatch.');
      }
    }

    let finalDesignation = row.designation_id;
    if (input.designationId !== undefined) {
      if (input.designationId === null) {
        finalDesignation = null;
      } else {
        if (!isUuidV7(input.designationId)) throw invalid('Invalid designation ID.');
        const desRes = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM app.designations WHERE organization_id = $1 AND id = $2`,
          [ctx.tenantId, input.designationId],
        );
        if (!desRes.rows[0] || desRes.rows[0].status !== 'ACTIVE') {
          throw new AppError(409, 'CONFLICT', 'Designation must be ACTIVE.');
        }
        finalDesignation = input.designationId;
      }
    }

    let finalValidTo: string | null = row.valid_to;
    if (input.validTo !== undefined) {
      finalValidTo = parseDate(input.validTo, 'validTo');
      if (finalValidTo !== null && finalValidTo < row.valid_from) {
        throw invalid('validTo must not be earlier than validFrom.');
      }
    }

    const finalPrimary = input.isPrimary !== undefined ? input.isPrimary : row.is_primary;

    if (finalPrimary && finalValidTo === null && !row.is_primary) {
      const existing = await tx.query(
        `SELECT 1 FROM app.employee_postings
          WHERE organization_id = $1 AND employee_id = $2 AND is_primary = true AND valid_to IS NULL AND id <> $3`,
        [ctx.tenantId, row.employee_id, postingId],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          'An active primary posting already exists for this employee.',
        );
      }
    }

    const changes: Record<string, unknown> = {};
    if (finalDesignation !== row.designation_id) {
      changes.designationId = { old: row.designation_id, new: finalDesignation };
    }
    if (finalValidTo !== row.valid_to) {
      changes.validTo = { old: row.valid_to, new: finalValidTo };
    }
    if (finalPrimary !== row.is_primary) {
      changes.isPrimary = { old: row.is_primary, new: finalPrimary };
    }
    if (Object.keys(changes).length === 0) return toDto(row);

    const isClosing = row.valid_to === null && finalValidTo !== null;
    const action = isClosing ? 'employee.posting.close' : 'employee.posting.update';

    try {
      const updated = await tx.query<PostingRow>(
        `UPDATE app.employee_postings
            SET designation_id = $3, valid_to = $4::date, is_primary = $5
          WHERE organization_id = $1 AND id = $2 AND version = $6
          RETURNING ${COLS}`,
        [ctx.tenantId, postingId, finalDesignation, finalValidTo, finalPrimary, row.version],
      );
      const saved = updated.rows[0];
      if (!saved) throw new AppError(409, 'CONFLICT', 'Posting was changed concurrently. Retry.');

      const auditEvt: AuditEvent = {
        action,
        resourceType: 'employee_posting',
        resourceId: postingId,
        departmentId: row.department_id,
        riskTier: 2,
        reasonText: reason,
        changes,
      };
      if (row.campus_id) auditEvt.campusId = row.campus_id;

      await recordAudit(tx, ctx, auditEvt, options.meta ?? {});

      return toDto(saved);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'employee_postings_one_primary_uq') {
        throw new AppError(
          409,
          'CONFLICT',
          'An active primary posting already exists for this employee.',
        );
      }
      throw err;
    }
  }

  /**
   * Explicit close operation for a posting.
   */
  static async close(
    tx: TenantTx,
    ctx: TrustedContext,
    postingId: string,
    input: ClosePostingBody,
    options: { expected?: ExpectedVersion; meta?: AuditRequestMeta },
  ): Promise<EmployeePostingDto> {
    return this.update(
      tx,
      ctx,
      postingId,
      { validTo: input.validTo, reason: input.reason },
      options,
    );
  }
}
