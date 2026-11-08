import type { TenantTx } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { recordAudit } from '../../shared/audit/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import type {
  CreateFeeCategoryInput,
  CreateFeeStructureInput,
  GenerateStudentDuesInput,
  RecordOfflineReceiptInput,
  ReverseReceiptInput,
  CollectionSummaryQuery,
  ListFeeStructuresQuery,
  ListStudentDuesQuery,
  ListFeeReceiptsQuery,
} from './finance.schemas.js';

export interface FeeCategoryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface FeeStructureRow {
  id: string;
  campus_id: string;
  academic_year_id: string;
  term_id: string | null;
  program_id: string | null;
  code: string;
  name: string;
  currency: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  due_date: string;
  total_amount: number;
  created_by_user_id: string;
  version: number;
  created_at: string;
  updated_at: string;
  components: Array<{
    id: string;
    fee_category_id: string;
    category_code: string;
    category_name: string;
    amount: number;
    description: string | null;
  }>;
}

export interface StudentDueRow {
  id: string;
  campus_id: string;
  student_id: string;
  student_name?: string;
  admission_number?: string;
  fee_structure_id: string;
  fee_structure_name?: string;
  academic_year_id: string;
  term_id: string | null;
  due_number: string;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  paid_amount: number;
  balance_amount: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'WAIVED';
  due_date: string;
  concession_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface FeeReceiptRow {
  id: string;
  campus_id: string;
  student_id: string;
  student_name?: string;
  admission_number?: string;
  receipt_number: string;
  payment_date: string;
  payment_method: 'CASH' | 'CHEQUE' | 'BANK_TRANSFER' | 'UPI_REFERENCE' | 'OTHER_OFFLINE';
  amount: number;
  currency: string;
  reference_number: string | null;
  reconciliation_status: 'RECORDED' | 'PENDING_VERIFICATION' | 'CONFIRMED';
  status: 'POSTED' | 'REVERSED';
  received_by_user_id: string;
  received_by_name?: string;
  remarks: string | null;
  reversal_reason: string | null;
  reversed_at: string | null;
  reversed_by_user_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  allocations: Array<{
    id: string;
    student_due_id: string;
    due_number?: string;
    allocated_amount: number;
  }>;
}

export class FinanceService {
  private async getStudentIdForUser(client: TenantTx, ctx: TrustedContext): Promise<string | null> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    return res.rows[0]?.id ?? null;
  }

  async createCategory(
    client: TenantTx,
    ctx: TrustedContext,
    input: CreateFeeCategoryInput,
  ): Promise<FeeCategoryRow> {
    const id = uuidv7();
    const res = await client.query<FeeCategoryRow>(
      `INSERT INTO app.fee_categories (id, organization_id, code, name, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, code) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         is_active = true
       RETURNING id, code, name, description, is_active, version, created_at::text, updated_at::text`,
      [id, ctx.tenantId, input.code.toUpperCase(), input.name, input.description ?? null],
    );
    return res.rows[0]!;
  }

  async listCategories(client: TenantTx, ctx: TrustedContext): Promise<FeeCategoryRow[]> {
    const res = await client.query<FeeCategoryRow>(
      `SELECT id, code, name, description, is_active, version, created_at::text, updated_at::text
         FROM app.fee_categories
        WHERE organization_id = $1
        ORDER BY name ASC`,
      [ctx.tenantId],
    );
    return res.rows;
  }

  async createStructure(
    client: TenantTx,
    ctx: TrustedContext,
    input: CreateFeeStructureInput,
  ): Promise<FeeStructureRow> {
    const structureId = uuidv7();
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM app.fee_structures WHERE organization_id = $1 AND code = $2`,
      [ctx.tenantId, input.code],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'DUPLICATE_FEE_STRUCTURE_CODE', `Fee structure with code "${input.code}" already exists.`);
    }

    // Insert fee structure
    await client.query(
      `INSERT INTO app.fee_structures (
         id, organization_id, campus_id, academic_year_id, term_id, program_id,
         code, name, currency, due_date, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        structureId,
        ctx.tenantId,
        input.campus_id,
        input.academic_year_id,
        input.term_id ?? null,
        input.program_id ?? null,
        input.code,
        input.name,
        input.currency ?? 'INR',
        input.due_date,
        ctx.userId,
      ],
    );

    // Insert components
    for (const comp of input.components) {
      const compId = uuidv7();
      await client.query(
        `INSERT INTO app.fee_structure_components (
           id, organization_id, fee_structure_id, fee_category_id, amount, description
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [compId, ctx.tenantId, structureId, comp.fee_category_id, comp.amount, comp.description ?? null],
      );
    }

    return (await this.getStructure(client, ctx, structureId))!;
  }

  async listStructures(
    client: TenantTx,
    ctx: TrustedContext,
    query: ListFeeStructuresQuery,
  ): Promise<FeeStructureRow[]> {
    const conditions = ['s.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`s.campus_id = $${params.length}`);
    }
    if (query.academic_year_id) {
      params.push(query.academic_year_id);
      conditions.push(`s.academic_year_id = $${params.length}`);
    }
    if (query.term_id) {
      params.push(query.term_id);
      conditions.push(`s.term_id = $${params.length}`);
    }

    const res = await client.query<{
      id: string;
      campus_id: string;
      academic_year_id: string;
      term_id: string | null;
      program_id: string | null;
      code: string;
      name: string;
      currency: string;
      status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
      due_date: string;
      total_amount: string;
      created_by_user_id: string;
      version: number;
      created_at: string;
      updated_at: string;
      components_json: string;
    }>(
      `SELECT s.id, s.campus_id, s.academic_year_id, s.term_id, s.program_id,
              s.code, s.name, s.currency, s.status, s.due_date::text,
              s.created_by_user_id, s.version, s.created_at::text, s.updated_at::text,
              COALESCE(SUM(c.amount), 0)::text AS total_amount,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', c.id,
                    'fee_category_id', c.fee_category_id,
                    'category_code', cat.code,
                    'category_name', cat.name,
                    'amount', c.amount,
                    'description', c.description
                  )
                ) FILTER (WHERE c.id IS NOT NULL),
                '[]'
              )::text AS components_json
         FROM app.fee_structures s
         LEFT JOIN app.fee_structure_components c ON c.organization_id = s.organization_id AND c.fee_structure_id = s.id
         LEFT JOIN app.fee_categories cat ON cat.organization_id = s.organization_id AND cat.id = c.fee_category_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY s.id
        ORDER BY s.created_at DESC`,
      params,
    );

    return res.rows.map((r) => ({
      ...r,
      total_amount: Number(r.total_amount),
      components: JSON.parse(r.components_json) as FeeStructureRow['components'],
    }));
  }

  async getStructure(
    client: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<FeeStructureRow | null> {
    const list = await this.listStructures(client, ctx, {});
    return list.find((s) => s.id === id) ?? null;
  }

  async generateDues(
    client: TenantTx,
    ctx: TrustedContext,
    input: GenerateStudentDuesInput,
  ): Promise<{
    fee_structure_id: string;
    generated_count: number;
    skipped_count: number;
    dues: StudentDueRow[];
  }> {
    const structure = await this.getStructure(client, ctx, input.fee_structure_id);
    if (!structure) {
      throw new AppError(404, 'FEE_STRUCTURE_NOT_FOUND', 'Fee structure not found.');
    }
    if (structure.total_amount <= 0) {
      throw new AppError(400, 'EMPTY_FEE_STRUCTURE', 'Cannot generate dues for fee structure with no components.');
    }

    // Identify target students
    let targetStudentIds: string[];
    if (input.student_ids && input.student_ids.length > 0) {
      targetStudentIds = input.student_ids;
    } else {
      // Auto-identify active students enrolled in this campus/term/program
      const conditions = [
        's.organization_id = $1',
        's.status = $2',
      ];
      const params: unknown[] = [ctx.tenantId, 'ACTIVE'];

      if (structure.program_id) {
        params.push(structure.program_id);
        conditions.push(`EXISTS (
          SELECT 1
            FROM app.term_enrollments te
            JOIN app.cohort_periods cp ON cp.organization_id = te.organization_id AND cp.id = te.cohort_period_id
            JOIN app.cohorts c ON c.organization_id = cp.organization_id AND c.id = cp.cohort_id
           WHERE te.organization_id = s.organization_id
             AND te.student_id = s.id
             AND c.program_id = $${params.length}
        )`);
      }

      if (structure.term_id) {
        params.push(structure.term_id);
        conditions.push(`EXISTS (
          SELECT 1 FROM app.term_enrollments te
           WHERE te.organization_id = s.organization_id AND te.student_id = s.id AND te.term_id = $${params.length}
        )`);
      }

      const res = await client.query<{ id: string }>(
        `SELECT s.id FROM app.students s WHERE ${conditions.join(' AND ')}`,
        params,
      );
      targetStudentIds = res.rows.map((r) => r.id);
    }

    if (targetStudentIds.length === 0) {
      return {
        fee_structure_id: structure.id,
        generated_count: 0,
        skipped_count: 0,
        dues: [],
      };
    }

    const concessionsMap = new Map<string, { amount: number; reason: string }>();
    if (input.concessions) {
      for (const c of input.concessions) {
        concessionsMap.set(c.student_id, { amount: c.discount_amount, reason: c.reason });
      }
    }

    let generatedCount = 0;
    let skippedCount = 0;
    const generatedDues: StudentDueRow[] = [];

    for (const studentId of targetStudentIds) {
      // Check existing due for this student and structure
      const existing = await client.query<StudentDueRow>(
        `SELECT id, due_number, gross_amount, discount_amount, net_amount, paid_amount, balance_amount, status
           FROM app.student_dues
          WHERE organization_id = $1 AND fee_structure_id = $2 AND student_id = $3`,
        [ctx.tenantId, structure.id, studentId],
      );

      if (existing.rows.length > 0) {
        skippedCount++;
        continue;
      }

      const dueId = uuidv7();
      const gross = structure.total_amount;
      const concession = concessionsMap.get(studentId);
      const discount = concession ? Math.min(concession.amount, gross) : 0;
      const net = gross - discount;
      const year = new Date().getFullYear();
      const randomSuffix = Math.floor(10000 + Math.random() * 90000).toString();
      const dueNumber = `DUE-${year}-${randomSuffix}`;

      const inserted = await client.query<StudentDueRow>(
        `INSERT INTO app.student_dues (
           id, organization_id, campus_id, student_id, fee_structure_id,
           academic_year_id, term_id, due_number, gross_amount, discount_amount,
           net_amount, paid_amount, balance_amount, status, due_date,
           concession_reason, generated_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $11, 'PENDING', $12, $13, $14)
         RETURNING id, campus_id, student_id, fee_structure_id, academic_year_id, term_id,
                   due_number, gross_amount::int, discount_amount::int, net_amount::int,
                   paid_amount::int, balance_amount::int, status, due_date::text,
                   concession_reason, version, created_at::text, updated_at::text`,
        [
          dueId,
          ctx.tenantId,
          structure.campus_id,
          studentId,
          structure.id,
          structure.academic_year_id,
          structure.term_id,
          dueNumber,
          gross,
          discount,
          net,
          structure.due_date,
          concession?.reason ?? null,
          ctx.userId,
        ],
      );

      generatedCount++;
      generatedDues.push(inserted.rows[0]!);
    }

    return {
      fee_structure_id: structure.id,
      generated_count: generatedCount,
      skipped_count: skippedCount,
      dues: generatedDues,
    };
  }

  async listDues(
    client: TenantTx,
    ctx: TrustedContext,
    query: ListStudentDuesQuery,
  ): Promise<StudentDueRow[]> {
    const conditions = ['d.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    // If caller is student, strictly enforce student_id = actor's student ID
    if (AuthorizationEngine.isStudentActor(ctx)) {
      const studentId = await this.getStudentIdForUser(client, ctx);
      params.push(studentId);
      conditions.push(`d.student_id = $${params.length}`);
    } else if (query.student_id) {
      params.push(query.student_id);
      conditions.push(`d.student_id = $${params.length}`);
    }

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`d.campus_id = $${params.length}`);
    }
    if (query.academic_year_id) {
      params.push(query.academic_year_id);
      conditions.push(`d.academic_year_id = $${params.length}`);
    }
    if (query.term_id) {
      params.push(query.term_id);
      conditions.push(`d.term_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`d.status = $${params.length}`);
    }

    const res = await client.query<{
      id: string;
      campus_id: string;
      student_id: string;
      student_name: string;
      admission_number: string;
      fee_structure_id: string;
      fee_structure_name: string;
      academic_year_id: string;
      term_id: string | null;
      due_number: string;
      gross_amount: string;
      discount_amount: string;
      net_amount: string;
      paid_amount: string;
      balance_amount: string;
      status: 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'WAIVED';
      due_date: string;
      concession_reason: string | null;
      version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT d.id, d.campus_id, d.student_id,
              u.display_name AS student_name,
              s.admission_number,
              d.fee_structure_id,
              fs.name AS fee_structure_name,
              d.academic_year_id, d.term_id, d.due_number,
              d.gross_amount::text, d.discount_amount::text, d.net_amount::text,
              d.paid_amount::text, d.balance_amount::text, d.status, d.due_date::text,
              d.concession_reason, d.version, d.created_at::text, d.updated_at::text
         FROM app.student_dues d
         JOIN app.students s ON s.organization_id = d.organization_id AND s.id = d.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         JOIN app.fee_structures fs ON fs.organization_id = d.organization_id AND fs.id = d.fee_structure_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.due_date ASC, d.created_at DESC`,
      params,
    );

    return res.rows.map((r) => ({
      ...r,
      gross_amount: Number(r.gross_amount),
      discount_amount: Number(r.discount_amount),
      net_amount: Number(r.net_amount),
      paid_amount: Number(r.paid_amount),
      balance_amount: Number(r.balance_amount),
    }));
  }

  async recordReceipt(
    client: TenantTx,
    ctx: TrustedContext,
    input: RecordOfflineReceiptInput,
  ): Promise<FeeReceiptRow> {
    // Idempotency check
    if (input.idempotency_key) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM app.fee_receipts
          WHERE organization_id = $1 AND idempotency_key = $2`,
        [ctx.tenantId, input.idempotency_key],
      );
      if (existing.rows.length > 0) {
        return (await this.getReceipt(client, ctx, existing.rows[0]!.id))!;
      }
    }

    const studentRes = await client.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, input.student_id],
    );
    if (studentRes.rows.length === 0) {
      throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student record not found.');
    }

    const receiptId = uuidv7();
    const year = new Date().getFullYear();
    const randomSuffix = Math.floor(10000 + Math.random() * 90000).toString();
    const receiptNumber = `REC-${year}-${randomSuffix}`;

    await client.query(
      `INSERT INTO app.fee_receipts (
         id, organization_id, campus_id, student_id, receipt_number, payment_date,
         payment_method, amount, currency, reference_number, reconciliation_status,
         received_by_user_id, idempotency_key, remarks
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        receiptId,
        ctx.tenantId,
        input.campus_id,
        input.student_id,
        receiptNumber,
        input.payment_date,
        input.payment_method,
        input.amount,
        input.currency ?? 'INR',
        input.reference_number ?? null,
        input.reconciliation_status ?? 'RECORDED',
        ctx.userId,
        input.idempotency_key ?? null,
        input.remarks ?? null,
      ],
    );

    // Allocation logic:
    // If allocations explicitly provided, allocate to those.
    // Otherwise, automatically distribute payment amount across student's outstanding dues.
    let remainingToAllocate = input.amount;

    if (input.allocations && input.allocations.length > 0) {
      for (const alloc of input.allocations) {
        const dueRes = await client.query<{
          id: string;
          net_amount: string;
          paid_amount: string;
          balance_amount: string;
          status: string;
        }>(
          `SELECT id, net_amount::text, paid_amount::text, balance_amount::text, status
             FROM app.student_dues
            WHERE organization_id = $1 AND id = $2 AND student_id = $3
            FOR UPDATE`,
          [ctx.tenantId, alloc.student_due_id, input.student_id],
        );
        if (dueRes.rows.length === 0) {
          throw new AppError(404, 'DUE_NOT_FOUND', `Student due ${alloc.student_due_id} not found.`);
        }
        const due = dueRes.rows[0]!;
        const currentBalance = Number(due.balance_amount);
        if (alloc.amount > currentBalance) {
          throw new AppError(
            422,
            'OVERALLOCATION',
            `Allocation amount (${alloc.amount}) exceeds outstanding due balance (${currentBalance}).`,
          );
        }

        const allocId = uuidv7();
        await client.query(
          `INSERT INTO app.fee_receipt_allocations (
             id, organization_id, receipt_id, student_due_id, allocated_amount
           ) VALUES ($1, $2, $3, $4, $5)`,
          [allocId, ctx.tenantId, receiptId, due.id, alloc.amount],
        );

        const newPaid = Number(due.paid_amount) + alloc.amount;
        const newBalance = Number(due.net_amount) - newPaid;
        const newStatus = newBalance === 0 ? 'PAID' : 'PARTIAL';

        await client.query(
          `UPDATE app.student_dues
              SET paid_amount = $1, balance_amount = $2, status = $3
            WHERE organization_id = $4 AND id = $5`,
          [newPaid, newBalance, newStatus, ctx.tenantId, due.id],
        );

        remainingToAllocate -= alloc.amount;
      }
    } else {
      // Auto-allocation across outstanding dues
      const outstandingDues = await client.query<{
        id: string;
        net_amount: string;
        paid_amount: string;
        balance_amount: string;
      }>(
        `SELECT id, net_amount::text, paid_amount::text, balance_amount::text
           FROM app.student_dues
          WHERE organization_id = $1 AND student_id = $2 AND status IN ('PENDING', 'PARTIAL')
          ORDER BY due_date ASC, created_at ASC
          FOR UPDATE`,
        [ctx.tenantId, input.student_id],
      );

      for (const due of outstandingDues.rows) {
        if (remainingToAllocate <= 0) break;
        const dueBalance = Number(due.balance_amount);
        const toPay = Math.min(dueBalance, remainingToAllocate);

        const allocId = uuidv7();
        await client.query(
          `INSERT INTO app.fee_receipt_allocations (
             id, organization_id, receipt_id, student_due_id, allocated_amount
           ) VALUES ($1, $2, $3, $4, $5)`,
          [allocId, ctx.tenantId, receiptId, due.id, toPay],
        );

        const newPaid = Number(due.paid_amount) + toPay;
        const newBalance = Number(due.net_amount) - newPaid;
        const newStatus = newBalance === 0 ? 'PAID' : 'PARTIAL';

        await client.query(
          `UPDATE app.student_dues
              SET paid_amount = $1, balance_amount = $2, status = $3
            WHERE organization_id = $4 AND id = $5`,
          [newPaid, newBalance, newStatus, ctx.tenantId, due.id],
        );

        remainingToAllocate -= toPay;
      }
    }

    // Tier 2 Audit Event
    await recordAudit(client, ctx, {
      action: 'fee.receipt.record',
      resourceType: 'fee_receipt',
      resourceId: receiptId,
      riskTier: 2,
      reasonCode: 'FEE_PAYMENT_RECORDED',
      reasonText: `Recorded ${input.payment_method} payment of ${input.amount} for student ${input.student_id}`,
    });

    return (await this.getReceipt(client, ctx, receiptId))!;
  }

  async getReceipt(
    client: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<FeeReceiptRow | null> {
    const list = await this.listReceipts(client, ctx, {});
    return list.find((r) => r.id === id) ?? null;
  }

  async listReceipts(
    client: TenantTx,
    ctx: TrustedContext,
    query: ListFeeReceiptsQuery,
  ): Promise<FeeReceiptRow[]> {
    const conditions = ['r.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (AuthorizationEngine.isStudentActor(ctx)) {
      const studentId = await this.getStudentIdForUser(client, ctx);
      params.push(studentId);
      conditions.push(`r.student_id = $${params.length}`);
    } else if (query.student_id) {
      params.push(query.student_id);
      conditions.push(`r.student_id = $${params.length}`);
    }

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`r.campus_id = $${params.length}`);
    }
    if (query.payment_method) {
      params.push(query.payment_method);
      conditions.push(`r.payment_method = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`r.status = $${params.length}`);
    }
    if (query.from_date) {
      params.push(query.from_date);
      conditions.push(`r.payment_date >= $${params.length}`);
    }
    if (query.to_date) {
      params.push(query.to_date);
      conditions.push(`r.payment_date <= $${params.length}`);
    }

    const res = await client.query<{
      id: string;
      campus_id: string;
      student_id: string;
      student_name: string;
      admission_number: string;
      receipt_number: string;
      payment_date: string;
      payment_method: FeeReceiptRow['payment_method'];
      amount: string;
      currency: string;
      reference_number: string | null;
      reconciliation_status: FeeReceiptRow['reconciliation_status'];
      status: FeeReceiptRow['status'];
      received_by_user_id: string;
      received_by_name: string;
      remarks: string | null;
      reversal_reason: string | null;
      reversed_at: string | null;
      reversed_by_user_id: string | null;
      version: number;
      created_at: string;
      updated_at: string;
      allocations_json: string;
    }>(
      `SELECT r.id, r.campus_id, r.student_id,
              u.display_name AS student_name,
              s.admission_number,
              r.receipt_number, r.payment_date::text, r.payment_method,
              r.amount::text, r.currency, r.reference_number,
              r.reconciliation_status, r.status, r.received_by_user_id,
              COALESCE(recv.display_name, 'Staff Officer') AS received_by_name,
              r.remarks, r.reversal_reason, r.reversed_at::text, r.reversed_by_user_id,
              r.version, r.created_at::text, r.updated_at::text,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', a.id,
                    'student_due_id', a.student_due_id,
                    'due_number', d.due_number,
                    'allocated_amount', a.allocated_amount
                  )
                ) FILTER (WHERE a.id IS NOT NULL),
                '[]'
              )::text AS allocations_json
         FROM app.fee_receipts r
         JOIN app.students s ON s.organization_id = r.organization_id AND s.id = r.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
         LEFT JOIN app.users recv ON recv.organization_id = r.organization_id AND recv.id = r.received_by_user_id
         LEFT JOIN app.fee_receipt_allocations a ON a.organization_id = r.organization_id AND a.receipt_id = r.id
         LEFT JOIN app.student_dues d ON d.organization_id = a.organization_id AND d.id = a.student_due_id
        WHERE ${conditions.join(' AND ')}
        GROUP BY r.id, u.display_name, s.admission_number, recv.display_name
        ORDER BY r.payment_date DESC, r.created_at DESC`,
      params,
    );

    return res.rows.map((r) => ({
      ...r,
      amount: Number(r.amount),
      allocations: JSON.parse(r.allocations_json) as FeeReceiptRow['allocations'],
    }));
  }

  async reverseReceipt(
    client: TenantTx,
    ctx: TrustedContext,
    receiptId: string,
    input: ReverseReceiptInput,
  ): Promise<FeeReceiptRow> {
    const receiptRes = await client.query<{
      id: string;
      status: string;
      amount: string;
      student_id: string;
    }>(
      `SELECT id, status, amount::text, student_id
         FROM app.fee_receipts
        WHERE organization_id = $1 AND id = $2
        FOR UPDATE`,
      [ctx.tenantId, receiptId],
    );

    if (receiptRes.rows.length === 0) {
      throw new AppError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
    }
    const receipt = receiptRes.rows[0]!;
    if (receipt.status === 'REVERSED') {
      throw new AppError(409, 'ALREADY_REVERSED', 'This receipt has already been reversed.');
    }

    // Roll back allocations on student dues
    const allocationsRes = await client.query<{
      student_due_id: string;
      allocated_amount: string;
    }>(
      `SELECT student_due_id, allocated_amount::text
         FROM app.fee_receipt_allocations
        WHERE organization_id = $1 AND receipt_id = $2`,
      [ctx.tenantId, receiptId],
    );

    for (const alloc of allocationsRes.rows) {
      const allocated = Number(alloc.allocated_amount);
      const dueRes = await client.query<{
        id: string;
        net_amount: string;
        paid_amount: string;
      }>(
        `SELECT id, net_amount::text, paid_amount::text
           FROM app.student_dues
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE`,
        [ctx.tenantId, alloc.student_due_id],
      );

      if (dueRes.rows.length > 0) {
        const due = dueRes.rows[0]!;
        const newPaid = Math.max(0, Number(due.paid_amount) - allocated);
        const newBalance = Number(due.net_amount) - newPaid;
        const newStatus = newPaid === 0 ? 'PENDING' : 'PARTIAL';

        await client.query(
          `UPDATE app.student_dues
              SET paid_amount = $1, balance_amount = $2, status = $3
            WHERE organization_id = $4 AND id = $5`,
          [newPaid, newBalance, newStatus, ctx.tenantId, due.id],
        );
      }
    }

    // Update receipt status
    await client.query(
      `UPDATE app.fee_receipts
          SET status = 'REVERSED',
              reversal_reason = $1,
              reversed_at = now(),
              reversed_by_user_id = $2
        WHERE organization_id = $3 AND id = $4`,
      [input.reason, ctx.userId, ctx.tenantId, receiptId],
    );

    // Tier 3 Audit Event (Critical reversal)
    await recordAudit(client, ctx, {
      action: 'fee.receipt.reverse',
      resourceType: 'fee_receipt',
      resourceId: receiptId,
      riskTier: 3,
      reasonCode: 'FEE_RECEIPT_REVERSED',
      reasonText: input.reason,
    });

    return (await this.getReceipt(client, ctx, receiptId))!;
  }

  async getStudentLedger(
    client: TenantTx,
    ctx: TrustedContext,
    studentId: string,
  ): Promise<{
    student_id: string;
    student_name: string;
    admission_number: string;
    campus_name: string;
    total_gross: number;
    total_discount: number;
    total_net: number;
    total_paid: number;
    total_balance: number;
    currency: string;
    dues: StudentDueRow[];
    receipts: FeeReceiptRow[];
  }> {
    if (AuthorizationEngine.isStudentActor(ctx)) {
      const ownStudentId = await this.getStudentIdForUser(client, ctx);
      if (ownStudentId !== studentId) {
        throw new AppError(403, 'FORBIDDEN', 'Students may view only their own fee ledger.');
      }
    }

    const studentRes = await client.query<{
      display_name: string;
      admission_number: string;
    }>(
      `SELECT u.display_name, s.admission_number
         FROM app.students s
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE s.organization_id = $1 AND s.id = $2`,
      [ctx.tenantId, studentId],
    );

    if (studentRes.rows.length === 0) {
      throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student record not found.');
    }
    const student = studentRes.rows[0]!;

    const dues = await this.listDues(client, ctx, { student_id: studentId });
    const receipts = await this.listReceipts(client, ctx, { student_id: studentId });

    let totalGross = 0;
    let totalDiscount = 0;
    let totalNet = 0;
    let totalPaid = 0;
    let totalBalance = 0;

    for (const d of dues) {
      if (d.status !== 'CANCELLED' && d.status !== 'WAIVED') {
        totalGross += d.gross_amount;
        totalDiscount += d.discount_amount;
        totalNet += d.net_amount;
        totalPaid += d.paid_amount;
        totalBalance += d.balance_amount;
      }
    }

    return {
      student_id: studentId,
      student_name: student.display_name,
      admission_number: student.admission_number,
      campus_name: '',
      total_gross: totalGross,
      total_discount: totalDiscount,
      total_net: totalNet,
      total_paid: totalPaid,
      total_balance: totalBalance,
      currency: 'INR',
      dues,
      receipts,
    };
  }

  async getCollectionSummary(
    client: TenantTx,
    ctx: TrustedContext,
    query: CollectionSummaryQuery,
  ): Promise<{
    total_collected: number;
    currency: string;
    receipt_count: number;
    reversed_count: number;
    by_payment_method: Record<string, number>;
    by_reconciliation_status: Record<string, number>;
  }> {
    const conditions = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`campus_id = $${params.length}`);
    }
    if (query.from_date) {
      params.push(query.from_date);
      conditions.push(`payment_date >= $${params.length}`);
    }
    if (query.to_date) {
      params.push(query.to_date);
      conditions.push(`payment_date <= $${params.length}`);
    }

    const res = await client.query<{
      status: string;
      payment_method: string;
      reconciliation_status: string;
      total_amount: string;
      count: string;
    }>(
      `SELECT status, payment_method, reconciliation_status,
              SUM(amount)::text AS total_amount,
              COUNT(*)::text AS count
         FROM app.fee_receipts
        WHERE ${conditions.join(' AND ')}
        GROUP BY status, payment_method, reconciliation_status`,
      params,
    );

    let totalCollected = 0;
    let receiptCount = 0;
    let reversedCount = 0;
    const byPaymentMethod: Record<string, number> = {
      CASH: 0,
      CHEQUE: 0,
      BANK_TRANSFER: 0,
      UPI_REFERENCE: 0,
      OTHER_OFFLINE: 0,
    };
    const byReconciliationStatus: Record<string, number> = {
      RECORDED: 0,
      PENDING_VERIFICATION: 0,
      CONFIRMED: 0,
    };

    for (const row of res.rows) {
      const amt = Number(row.total_amount);
      const cnt = Number(row.count);

      if (row.status === 'POSTED') {
        totalCollected += amt;
        receiptCount += cnt;
        byPaymentMethod[row.payment_method] = (byPaymentMethod[row.payment_method] ?? 0) + amt;
        byReconciliationStatus[row.reconciliation_status] =
          (byReconciliationStatus[row.reconciliation_status] ?? 0) + amt;
      } else if (row.status === 'REVERSED') {
        reversedCount += cnt;
      }
    }

    return {
      total_collected: totalCollected,
      currency: 'INR',
      receipt_count: receiptCount,
      reversed_count: reversedCount,
      by_payment_method: byPaymentMethod,
      by_reconciliation_status: byReconciliationStatus,
    };
  }
}
