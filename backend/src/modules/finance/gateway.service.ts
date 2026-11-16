import type { TenantTx } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { recordAudit } from '../../shared/audit/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import {
  encryptGatewayCredentials,
  decryptGatewayCredentials,
  maskSecret,
} from '../../shared/crypto/gateway-crypto.js';
import { defaultGatewayRegistry, PaymentGatewayRegistry } from './gateways/gateway-registry.js';
import type {
  GatewayConfig,
  PaymentGatewayProvider,
  GatewayMode,
  HealthCheckResult,
} from './gateways/types.js';
import type {
  SaveGatewayConfigInput,
  TestGatewayConnectionInput,
  InitiateOnlinePaymentInput,
  VerifyOnlinePaymentInput,
  InitiateRefundInput,
  ListPaymentAttemptsQuery,
  ReconciliationQuery,
} from './gateway.schemas.js';

export interface MaskedGatewayConfigDto {
  id: string;
  campus_id: string | null;
  provider: PaymentGatewayProvider;
  mode: GatewayMode;
  is_active: boolean;
  merchant_key_masked: string;
  has_secret_key: boolean;
  has_webhook_secret: boolean;
  settings: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentAttemptRow {
  id: string;
  campus_id: string;
  student_id: string;
  student_name?: string | undefined;
  admission_number?: string | undefined;
  student_due_id: string | null;
  gateway_config_id: string;
  provider: PaymentGatewayProvider;
  mode: GatewayMode;
  attempt_reference: string;
  order_reference: string | null;
  amount: number;
  currency: string;
  status: 'INITIATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'USER_DROPPED' | 'EXPIRED';
  gateway_payment_ref: string | null;
  failure_reason: string | null;
  receipt_id: string | null;
  metadata_json: Record<string, unknown>;
  initiated_by_user_id: string;
  created_at: string;
  updated_at: string;
}

export class PaymentGatewayService {
  readonly #registry: PaymentGatewayRegistry;

  constructor(registry: PaymentGatewayRegistry = defaultGatewayRegistry) {
    this.#registry = registry;
  }

  // ---------------------------------------------------------------------------
  // 1. Gateway Configuration Management
  // ---------------------------------------------------------------------------

  async listConfigs(client: TenantTx, ctx: TrustedContext): Promise<MaskedGatewayConfigDto[]> {
    const res = await client.query<{
      id: string;
      campus_id: string | null;
      provider: PaymentGatewayProvider;
      mode: GatewayMode;
      is_active: boolean;
      merchant_key: string;
      credentials_encrypted: string;
      webhook_secret_encrypted: string | null;
      settings_json: Record<string, unknown>;
      version: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, campus_id, provider, mode, is_active, merchant_key,
              credentials_encrypted, webhook_secret_encrypted, settings_json,
              version, created_at::text, updated_at::text
         FROM app.payment_gateway_configs
        WHERE organization_id = $1
        ORDER BY campus_id NULLS FIRST, provider ASC`,
      [ctx.tenantId],
    );

    return res.rows.map((r) => ({
      id: r.id,
      campus_id: r.campus_id,
      provider: r.provider,
      mode: r.mode,
      is_active: r.is_active,
      merchant_key_masked: maskSecret(r.merchant_key),
      has_secret_key: !!r.credentials_encrypted,
      has_webhook_secret: !!r.webhook_secret_encrypted,
      settings: r.settings_json || {},
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  async saveConfig(
    client: TenantTx,
    ctx: TrustedContext,
    input: SaveGatewayConfigInput,
  ): Promise<MaskedGatewayConfigDto> {
    const encryptedSecret = encryptGatewayCredentials(
      { secret_key: input.secret_key },
      ctx.tenantId,
    );

    const encryptedWebhook = input.webhook_secret
      ? encryptGatewayCredentials({ webhook_secret: input.webhook_secret }, ctx.tenantId)
      : null;

    // If activating this gateway, deactivate other gateways for the same campus/org scope
    if (input.is_active) {
      if (input.campus_id) {
        await client.query(
          `UPDATE app.payment_gateway_configs
              SET is_active = false
            WHERE organization_id = $1 AND campus_id = $2`,
          [ctx.tenantId, input.campus_id],
        );
      } else {
        await client.query(
          `UPDATE app.payment_gateway_configs
              SET is_active = false
            WHERE organization_id = $1 AND campus_id IS NULL`,
          [ctx.tenantId],
        );
      }
    }

    // Check if configuration already exists for (org, campus, provider)
    const existing = input.campus_id
      ? await client.query<{ id: string }>(
          `SELECT id FROM app.payment_gateway_configs
            WHERE organization_id = $1 AND campus_id = $2 AND provider = $3`,
          [ctx.tenantId, input.campus_id, input.provider],
        )
      : await client.query<{ id: string }>(
          `SELECT id FROM app.payment_gateway_configs
            WHERE organization_id = $1 AND campus_id IS NULL AND provider = $2`,
          [ctx.tenantId, input.provider],
        );

    let configId: string;

    if (existing.rows.length > 0) {
      configId = existing.rows[0]!.id;
      await client.query(
        `UPDATE app.payment_gateway_configs
            SET mode = $1, is_active = $2, merchant_key = $3,
                credentials_encrypted = $4, webhook_secret_encrypted = $5,
                settings_json = $6, updated_at = now()
          WHERE organization_id = $7 AND id = $8`,
        [
          input.mode,
          input.is_active,
          input.merchant_key,
          encryptedSecret,
          encryptedWebhook,
          JSON.stringify(input.settings || {}),
          ctx.tenantId,
          configId,
        ],
      );
    } else {
      configId = uuidv7();
      await client.query(
        `INSERT INTO app.payment_gateway_configs (
           id, organization_id, campus_id, provider, mode, is_active,
           merchant_key, credentials_encrypted, webhook_secret_encrypted, settings_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          configId,
          ctx.tenantId,
          input.campus_id ?? null,
          input.provider,
          input.mode,
          input.is_active,
          input.merchant_key,
          encryptedSecret,
          encryptedWebhook,
          JSON.stringify(input.settings || {}),
        ],
      );
    }

    await recordAudit(client, ctx, {
      action: 'fee.gateway.manage',
      resourceType: 'payment_gateway_config',
      resourceId: configId,
      riskTier: 3,
      reasonCode: 'PAYMENT_GATEWAY_CONFIGURED',
      metadata: {
        provider: input.provider,
        mode: input.mode,
        is_active: input.is_active,
        campus_id: input.campus_id ?? null,
      },
    });

    const [saved] = await this.listConfigs(client, ctx);
    return saved!;
  }

  async testConnection(
    _client: TenantTx,
    _ctx: TrustedContext,
    input: TestGatewayConnectionInput,
  ): Promise<HealthCheckResult> {
    const adapter = this.#registry.getAdapter(input.provider);
    const mockConfig: GatewayConfig = {
      id: 'test',
      organizationId: 'test',
      campusId: null,
      provider: input.provider,
      mode: input.mode,
      isActive: false,
      merchantKey: input.merchant_key,
      secretKey: input.secret_key,
      webhookSecret: input.webhook_secret ?? null,
      settings: input.settings ?? {},
    };

    return adapter.checkHealth(mockConfig);
  }

  async getActiveConfig(
    client: TenantTx,
    ctx: TrustedContext,
    campusId?: string,
  ): Promise<GatewayConfig> {
    // Try campus-specific first, then fallback to organization default
    let res = campusId
      ? await client.query<{
          id: string;
          organization_id: string;
          campus_id: string | null;
          provider: PaymentGatewayProvider;
          mode: GatewayMode;
          is_active: boolean;
          merchant_key: string;
          credentials_encrypted: string;
          webhook_secret_encrypted: string | null;
          settings_json: Record<string, unknown>;
        }>(
          `SELECT id, organization_id, campus_id, provider, mode, is_active,
                  merchant_key, credentials_encrypted, webhook_secret_encrypted, settings_json
             FROM app.payment_gateway_configs
            WHERE organization_id = $1 AND campus_id = $2 AND is_active = true
            LIMIT 1`,
          [ctx.tenantId, campusId],
        )
      : { rows: [] };

    if (res.rows.length === 0) {
      res = await client.query(
        `SELECT id, organization_id, campus_id, provider, mode, is_active,
                merchant_key, credentials_encrypted, webhook_secret_encrypted, settings_json
           FROM app.payment_gateway_configs
          WHERE organization_id = $1 AND campus_id IS NULL AND is_active = true
          LIMIT 1`,
        [ctx.tenantId],
      );
    }

    if (res.rows.length === 0) {
      throw new AppError(
        400,
        'NO_ACTIVE_GATEWAY',
        'No active payment gateway is configured for this campus or organization. Please contact school administration.',
      );
    }

    const row = res.rows[0]!;
    const creds = decryptGatewayCredentials<{ secret_key: string }>(
      row.credentials_encrypted,
      ctx.tenantId,
    );

    let webhookSecret: string | null = null;
    if (row.webhook_secret_encrypted) {
      const wh = decryptGatewayCredentials<{ webhook_secret: string }>(
        row.webhook_secret_encrypted,
        ctx.tenantId,
      );
      webhookSecret = wh.webhook_secret;
    }

    return {
      id: row.id,
      organizationId: row.organization_id,
      campusId: row.campus_id,
      provider: row.provider,
      mode: row.mode,
      isActive: row.is_active,
      merchantKey: row.merchant_key,
      secretKey: creds.secret_key,
      webhookSecret,
      settings: row.settings_json || {},
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Online Payment Checkout Initiation
  // ---------------------------------------------------------------------------

  async initiatePayment(
    client: TenantTx,
    ctx: TrustedContext,
    input: InitiateOnlinePaymentInput,
  ): Promise<{
    attempt_id: string;
    attempt_reference: string;
    order_reference: string;
    provider: PaymentGatewayProvider;
    amount: number;
    currency: string;
    checkout_payload: Record<string, unknown>;
    redirect_url?: string | undefined;
  }> {
    // If student actor, enforce student isolation
    if (AuthorizationEngine.isStudentActor(ctx)) {
      const studentSelf = await client.query<{ id: string }>(
        `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
        [ctx.tenantId, ctx.userId],
      );
      if (studentSelf.rows.length === 0 || studentSelf.rows[0]!.id !== input.student_id) {
        throw new AppError(403, 'FORBIDDEN', 'Students can only pay their own fee dues.');
      }
    }

    // Verify student details
    const studentRes = await client.query<{
      id: string;
      campus_id: string | null;
      display_name: string;
      email: string | null;
    }>(
      `SELECT s.id, s.campus_id, u.display_name, u.email
         FROM app.students s
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE s.organization_id = $1 AND s.id = $2`,
      [ctx.tenantId, input.student_id],
    );

    if (studentRes.rows.length === 0) {
      throw new AppError(404, 'STUDENT_NOT_FOUND', 'Student record not found.');
    }
    const student = studentRes.rows[0]!;
    const campusId = input.campus_id || student.campus_id;
    if (!campusId) {
      throw new AppError(
        400,
        'CAMPUS_REQUIRED',
        'Campus context is required to determine payment gateway.',
      );
    }

    // Resolve dues to pay
    const dueIds = input.due_ids || (input.student_due_id ? [input.student_due_id] : []);
    let targetAmount = input.amount;
    let dueRows: Array<{ id: string; balance_amount: string; due_number: string }> = [];

    if (dueIds.length > 0) {
      const duesRes = await client.query<{
        id: string;
        balance_amount: string;
        due_number: string;
      }>(
        `SELECT id, balance_amount::text, due_number
           FROM app.student_dues
          WHERE organization_id = $1 AND student_id = $2 AND id = ANY($3::app.uuid_v7[])
            AND status IN ('PENDING', 'PARTIAL')`,
        [ctx.tenantId, student.id, dueIds],
      );

      if (duesRes.rows.length === 0) {
        throw new AppError(
          400,
          'NO_OUTSTANDING_DUES',
          'Selected dues are already settled or invalid.',
        );
      }
      dueRows = duesRes.rows;

      const totalOutstanding = dueRows.reduce((sum, d) => sum + Number(d.balance_amount), 0);
      if (!targetAmount) {
        targetAmount = totalOutstanding;
      } else if (targetAmount > totalOutstanding) {
        throw new AppError(
          422,
          'AMOUNT_EXCEEDS_DUES',
          `Payment amount (${targetAmount}) exceeds total outstanding dues (${totalOutstanding}).`,
        );
      }
    } else {
      if (!targetAmount || targetAmount <= 0) {
        throw new AppError(
          400,
          'AMOUNT_REQUIRED',
          'Payment amount must be specified if dues are not selected.',
        );
      }
    }

    // Get active gateway configuration
    const config = await this.getActiveConfig(client, ctx, campusId);
    const adapter = this.#registry.getAdapter(config.provider);

    // Create unique attempt reference
    const year = new Date().getFullYear();
    const randomSuffix = Math.floor(100000 + Math.random() * 900000).toString();
    const attemptReference = `PAY-${year}-${randomSuffix}`;
    const attemptId = uuidv7();

    // Call adapter to create order
    const orderResult = await adapter.createOrder(config, {
      attemptReference,
      amount: targetAmount,
      currency: 'INR',
      student: {
        id: student.id,
        name: student.display_name,
        email: student.email || undefined,
      },
      description:
        input.description ||
        `School Fee Payment - ${dueRows.map((d) => d.due_number).join(', ') || student.display_name}`,
      returnUrl: input.return_url,
      notifyUrl: input.notify_url,
    });

    // Save payment attempt to database
    await client.query(
      `INSERT INTO app.payment_attempts (
         id, organization_id, campus_id, student_id, student_due_id,
         gateway_config_id, provider, mode, attempt_reference, order_reference,
         amount, currency, status, metadata_json, initiated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        attemptId,
        ctx.tenantId,
        campusId,
        student.id,
        dueRows.length === 1 ? dueRows[0]!.id : null,
        config.id,
        config.provider,
        config.mode,
        attemptReference,
        orderResult.orderReference,
        targetAmount,
        'INR',
        'INITIATED',
        JSON.stringify({
          due_ids: dueRows.map((d) => d.id),
          payment_session_id: orderResult.paymentSessionId,
        }),
        ctx.userId,
      ],
    );

    await recordAudit(client, ctx, {
      action: 'fee.payment.initiate',
      resourceType: 'payment_attempt',
      resourceId: attemptId,
      riskTier: 2,
      reasonCode: 'ONLINE_PAYMENT_INITIATED',
      metadata: {
        attempt_reference: attemptReference,
        provider: config.provider,
        amount: targetAmount,
        student_id: student.id,
      },
    });

    return {
      attempt_id: attemptId,
      attempt_reference: attemptReference,
      order_reference: orderResult.orderReference,
      provider: config.provider,
      amount: targetAmount,
      currency: 'INR',
      checkout_payload: orderResult.checkoutPayload,
      redirect_url: orderResult.redirectUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Authoritative Verification and Exactly-Once Fee Receipt Posting
  // ---------------------------------------------------------------------------

  async verifyPayment(
    client: TenantTx,
    ctx: TrustedContext,
    input: VerifyOnlinePaymentInput,
  ): Promise<{
    success: boolean;
    status: string;
    receipt_id?: string | undefined;
    receipt_number?: string | undefined;
    attempt_reference: string;
    amount: number;
    failure_reason?: string | undefined;
  }> {
    // 1. Lock payment attempt row FOR UPDATE
    const attemptRes = await client.query<{
      id: string;
      organization_id: string;
      campus_id: string;
      student_id: string;
      student_due_id: string | null;
      gateway_config_id: string;
      provider: PaymentGatewayProvider;
      mode: GatewayMode;
      attempt_reference: string;
      order_reference: string | null;
      amount: string;
      currency: string;
      status: string;
      gateway_payment_ref: string | null;
      receipt_id: string | null;
      metadata_json: Record<string, unknown>;
    }>(
      `SELECT id, organization_id, campus_id, student_id, student_due_id,
              gateway_config_id, provider, mode, attempt_reference, order_reference,
              amount::text, currency, status, gateway_payment_ref, receipt_id, metadata_json
         FROM app.payment_attempts
        WHERE organization_id = $1 AND attempt_reference = $2
        FOR UPDATE`,
      [ctx.tenantId, input.attempt_reference],
    );

    if (attemptRes.rows.length === 0) {
      throw new AppError(
        404,
        'ATTEMPT_NOT_FOUND',
        `Payment attempt ${input.attempt_reference} not found.`,
      );
    }

    const attempt = attemptRes.rows[0]!;

    // STRICT IDEMPOTENCY: If already posted and receipt exists, return cleanly!
    if (attempt.status === 'SUCCESS' && attempt.receipt_id) {
      const receiptRes = await client.query<{ receipt_number: string }>(
        `SELECT receipt_number FROM app.fee_receipts WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, attempt.receipt_id],
      );
      return {
        success: true,
        status: 'SUCCESS',
        receipt_id: attempt.receipt_id,
        receipt_number: receiptRes.rows[0]?.receipt_number,
        attempt_reference: attempt.attempt_reference,
        amount: Number(attempt.amount),
      };
    }

    // Load gateway config
    const configRes = await client.query<{
      id: string;
      organization_id: string;
      campus_id: string | null;
      provider: PaymentGatewayProvider;
      mode: GatewayMode;
      merchant_key: string;
      credentials_encrypted: string;
      webhook_secret_encrypted: string | null;
      settings_json: Record<string, unknown>;
    }>(
      `SELECT id, organization_id, campus_id, provider, mode, merchant_key,
              credentials_encrypted, webhook_secret_encrypted, settings_json
         FROM app.payment_gateway_configs
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, attempt.gateway_config_id],
    );

    if (configRes.rows.length === 0) {
      throw new AppError(500, 'GATEWAY_CONFIG_MISSING', 'Gateway configuration record missing.');
    }

    const configRow = configRes.rows[0]!;
    const creds = decryptGatewayCredentials<{ secret_key: string }>(
      configRow.credentials_encrypted,
      ctx.tenantId,
    );
    let webhookSecret: string | null = null;
    if (configRow.webhook_secret_encrypted) {
      webhookSecret = decryptGatewayCredentials<{ webhook_secret: string }>(
        configRow.webhook_secret_encrypted,
        ctx.tenantId,
      ).webhook_secret;
    }

    const config: GatewayConfig = {
      id: configRow.id,
      organizationId: configRow.organization_id,
      campusId: configRow.campus_id,
      provider: configRow.provider,
      mode: configRow.mode,
      isActive: true,
      merchantKey: configRow.merchant_key,
      secretKey: creds.secret_key,
      webhookSecret,
      settings: configRow.settings_json || {},
    };

    // Execute server-to-server verification via provider adapter
    const adapter = this.#registry.getAdapter(config.provider);
    const verification = await adapter.verifyPayment(config, {
      orderReference: attempt.order_reference || input.order_reference || attempt.attempt_reference,
      attemptReference: attempt.attempt_reference,
      gatewayPaymentRef: input.gateway_payment_ref || attempt.gateway_payment_ref || undefined,
      gatewaySignature: input.gateway_signature,
      rawPayload: input.raw_payload,
    });

    if (!verification.success) {
      await client.query(
        `UPDATE app.payment_attempts
            SET status = 'FAILED', failure_reason = $1, updated_at = now()
          WHERE organization_id = $2 AND id = $3`,
        [verification.failureReason || 'Payment verification failed', ctx.tenantId, attempt.id],
      );

      return {
        success: false,
        status: verification.status,
        attempt_reference: attempt.attempt_reference,
        amount: Number(attempt.amount),
        failure_reason: verification.failureReason,
      };
    }

    // 2. Verification succeeded -> Post immutable receipt and allocations!
    const receiptId = uuidv7();
    const year = new Date().getFullYear();
    const randomSuffix = Math.floor(10000 + Math.random() * 90000).toString();
    const receiptNumber = `REC-${year}-${randomSuffix}`;
    const paymentDate = new Date().toISOString().split('T')[0]!;
    const paymentMethod = `ONLINE_${config.provider}`;
    const amount = Number(attempt.amount);

    await client.query(
      `INSERT INTO app.fee_receipts (
         id, organization_id, campus_id, student_id, receipt_number, payment_date,
         payment_method, amount, currency, reference_number, reconciliation_status,
         received_by_user_id, idempotency_key, remarks, payment_attempt_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        receiptId,
        ctx.tenantId,
        attempt.campus_id,
        attempt.student_id,
        receiptNumber,
        paymentDate,
        paymentMethod,
        amount,
        attempt.currency,
        verification.gatewayPaymentRef,
        'CONFIRMED',
        ctx.userId,
        attempt.attempt_reference, // idempotent posting key
        `Online Fee Payment via ${config.provider} (Order: ${attempt.order_reference || attempt.attempt_reference})`,
        attempt.id,
      ],
    );

    // 3. Allocate to student dues
    let remainingToAllocate = amount;
    const metaDueIds = (attempt.metadata_json?.due_ids as string[]) || [];
    const targetDueIds =
      metaDueIds.length > 0 ? metaDueIds : attempt.student_due_id ? [attempt.student_due_id] : [];

    if (targetDueIds.length > 0) {
      for (const dueId of targetDueIds) {
        if (remainingToAllocate <= 0) break;
        const dueRes = await client.query<{
          id: string;
          net_amount: string;
          paid_amount: string;
          balance_amount: string;
        }>(
          `SELECT id, net_amount::text, paid_amount::text, balance_amount::text
             FROM app.student_dues
            WHERE organization_id = $1 AND id = $2 AND student_id = $3
            FOR UPDATE`,
          [ctx.tenantId, dueId, attempt.student_id],
        );

        if (dueRes.rows.length > 0) {
          const due = dueRes.rows[0]!;
          const currentBalance = Number(due.balance_amount);
          const allocAmount = Math.min(remainingToAllocate, currentBalance);

          if (allocAmount > 0) {
            const allocId = uuidv7();
            await client.query(
              `INSERT INTO app.fee_receipt_allocations (
                 id, organization_id, receipt_id, student_due_id, allocated_amount
               ) VALUES ($1, $2, $3, $4, $5)`,
              [allocId, ctx.tenantId, receiptId, due.id, allocAmount],
            );

            const newPaid = Number(due.paid_amount) + allocAmount;
            const newBalance = Number(due.net_amount) - newPaid;
            const newStatus = newBalance === 0 ? 'PAID' : 'PARTIAL';

            await client.query(
              `UPDATE app.student_dues
                  SET paid_amount = $1, balance_amount = $2, status = $3
                WHERE organization_id = $4 AND id = $5`,
              [newPaid, newBalance, newStatus, ctx.tenantId, due.id],
            );

            remainingToAllocate -= allocAmount;
          }
        }
      }
    }

    // Auto-allocate any remainder across oldest outstanding dues
    if (remainingToAllocate > 0) {
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
        [ctx.tenantId, attempt.student_id],
      );

      for (const due of outstandingDues.rows) {
        if (remainingToAllocate <= 0) break;
        const currentBalance = Number(due.balance_amount);
        const allocAmount = Math.min(remainingToAllocate, currentBalance);

        if (allocAmount > 0) {
          const allocId = uuidv7();
          await client.query(
            `INSERT INTO app.fee_receipt_allocations (
               id, organization_id, receipt_id, student_due_id, allocated_amount
             ) VALUES ($1, $2, $3, $4, $5)`,
            [allocId, ctx.tenantId, receiptId, due.id, allocAmount],
          );

          const newPaid = Number(due.paid_amount) + allocAmount;
          const newBalance = Number(due.net_amount) - newPaid;
          const newStatus = newBalance === 0 ? 'PAID' : 'PARTIAL';

          await client.query(
            `UPDATE app.student_dues
                SET paid_amount = $1, balance_amount = $2, status = $3
              WHERE organization_id = $4 AND id = $5`,
            [newPaid, newBalance, newStatus, ctx.tenantId, due.id],
          );

          remainingToAllocate -= allocAmount;
        }
      }
    }

    // 4. Update payment attempt status to SUCCESS
    await client.query(
      `UPDATE app.payment_attempts
          SET status = 'SUCCESS',
              gateway_payment_ref = $1,
              gateway_signature = $2,
              receipt_id = $3,
              updated_at = now()
        WHERE organization_id = $4 AND id = $5`,
      [
        verification.gatewayPaymentRef,
        input.gateway_signature ?? null,
        receiptId,
        ctx.tenantId,
        attempt.id,
      ],
    );

    // 5. Tier 2 Audit Event
    await recordAudit(client, ctx, {
      action: 'fee.receipt.record',
      resourceType: 'fee_receipt',
      resourceId: receiptId,
      riskTier: 2,
      reasonCode: 'ONLINE_PAYMENT_VERIFIED_AND_POSTED',
      metadata: {
        receipt_number: receiptNumber,
        attempt_reference: attempt.attempt_reference,
        amount,
        gateway_payment_ref: verification.gatewayPaymentRef,
        provider: config.provider,
      },
    });

    return {
      success: true,
      status: 'SUCCESS',
      receipt_id: receiptId,
      receipt_number: receiptNumber,
      attempt_reference: attempt.attempt_reference,
      amount,
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Webhook Processing (Idempotent server-side webhook handler)
  // ---------------------------------------------------------------------------

  async handleWebhook(
    client: TenantTx,
    ctx: TrustedContext,
    provider: PaymentGatewayProvider,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string | Buffer,
  ): Promise<{ processed: boolean; status: string; eventType: string }> {
    const config = await this.getActiveConfig(client, ctx);
    const adapter = this.#registry.getAdapter(provider);

    const result = await adapter.processWebhook(config, {
      headers,
      rawBody,
    });

    if (!result.isValid) {
      throw new AppError(
        400,
        'INVALID_WEBHOOK_SIGNATURE',
        result.failureReason || 'Webhook signature invalid',
      );
    }

    if (result.status === 'SUCCESS' && (result.attemptReference || result.orderReference)) {
      const ref = result.attemptReference || result.orderReference!;
      // Find attempt
      const attemptRes = await client.query<{ attempt_reference: string }>(
        `SELECT attempt_reference FROM app.payment_attempts
          WHERE organization_id = $1 AND (attempt_reference = $2 OR order_reference = $2)`,
        [ctx.tenantId, ref],
      );

      if (attemptRes.rows.length > 0) {
        await this.verifyPayment(client, ctx, {
          attempt_reference: attemptRes.rows[0]!.attempt_reference,
          gateway_payment_ref: result.gatewayPaymentRef,
        });
      }
    }

    return {
      processed: true,
      status: result.status,
      eventType: result.eventType,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. Refunds
  // ---------------------------------------------------------------------------

  async initiateRefund(
    client: TenantTx,
    ctx: TrustedContext,
    input: InitiateRefundInput,
  ): Promise<{
    success: boolean;
    refund_id: string;
    gateway_refund_ref: string;
    status: string;
    amount: number;
  }> {
    // 1. Fetch receipt and linked payment attempt
    const receiptRes = await client.query<{
      id: string;
      campus_id: string;
      student_id: string;
      amount: string;
      currency: string;
      status: string;
      payment_method: string;
      payment_attempt_id: string | null;
      reference_number: string | null;
    }>(
      `SELECT id, campus_id, student_id, amount::text, currency, status,
              payment_method, payment_attempt_id, reference_number
         FROM app.fee_receipts
        WHERE organization_id = $1 AND id = $2
        FOR UPDATE`,
      [ctx.tenantId, input.receipt_id],
    );

    if (receiptRes.rows.length === 0) {
      throw new AppError(404, 'RECEIPT_NOT_FOUND', 'Fee receipt not found.');
    }

    const receipt = receiptRes.rows[0]!;
    if (receipt.status === 'REVERSED') {
      throw new AppError(
        400,
        'RECEIPT_ALREADY_REVERSED',
        'Cannot refund an already reversed receipt.',
      );
    }

    if (!receipt.payment_attempt_id) {
      throw new AppError(
        400,
        'NOT_AN_ONLINE_PAYMENT',
        'Refund can only be initiated for online gateway payment receipts. For offline payments, use Receipt Reversal.',
      );
    }

    const attemptRes = await client.query<{
      id: string;
      gateway_config_id: string;
      provider: PaymentGatewayProvider;
      gateway_payment_ref: string | null;
      order_reference: string | null;
      amount: string;
    }>(
      `SELECT id, gateway_config_id, provider, gateway_payment_ref, order_reference, amount::text
         FROM app.payment_attempts
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, receipt.payment_attempt_id],
    );

    if (attemptRes.rows.length === 0 || !attemptRes.rows[0]!.gateway_payment_ref) {
      throw new AppError(
        400,
        'ATTEMPT_PAYMENT_REF_MISSING',
        'Gateway payment reference missing from attempt.',
      );
    }

    const attempt = attemptRes.rows[0]!;
    const receiptAmount = Number(receipt.amount);
    if (input.amount > receiptAmount) {
      throw new AppError(
        422,
        'REFUND_EXCEEDS_AMOUNT',
        `Refund amount (${input.amount}) exceeds receipt amount (${receiptAmount}).`,
      );
    }

    // Load gateway config
    const configRes = await client.query<{
      id: string;
      organization_id: string;
      campus_id: string | null;
      provider: PaymentGatewayProvider;
      mode: GatewayMode;
      merchant_key: string;
      credentials_encrypted: string;
      webhook_secret_encrypted: string | null;
      settings_json: Record<string, unknown>;
    }>(
      `SELECT id, organization_id, campus_id, provider, mode, merchant_key,
              credentials_encrypted, webhook_secret_encrypted, settings_json
         FROM app.payment_gateway_configs
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, attempt.gateway_config_id],
    );

    const configRow = configRes.rows[0]!;
    const creds = decryptGatewayCredentials<{ secret_key: string }>(
      configRow.credentials_encrypted,
      ctx.tenantId,
    );
    const config: GatewayConfig = {
      id: configRow.id,
      organizationId: configRow.organization_id,
      campusId: configRow.campus_id,
      provider: configRow.provider,
      mode: configRow.mode,
      isActive: true,
      merchantKey: configRow.merchant_key,
      secretKey: creds.secret_key,
      webhookSecret: null,
      settings: configRow.settings_json || {},
    };

    const adapter = this.#registry.getAdapter(config.provider);
    const refundResult = await adapter.initiateRefund(config, {
      gatewayPaymentRef: attempt.gateway_payment_ref || '',
      orderReference: attempt.order_reference || undefined,
      amount: input.amount,
      currency: receipt.currency,
      reason: input.reason,
    });

    if (!refundResult.success) {
      throw new AppError(
        502,
        'GATEWAY_REFUND_FAILED',
        refundResult.failureReason || 'Payment gateway refund request failed',
      );
    }

    const refundId = uuidv7();
    await client.query(
      `INSERT INTO app.payment_refunds (
         id, organization_id, campus_id, receipt_id, payment_attempt_id,
         gateway_refund_ref, amount, currency, status, reason, initiated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        refundId,
        ctx.tenantId,
        receipt.campus_id,
        receipt.id,
        attempt.id,
        refundResult.gatewayRefundRef,
        input.amount,
        receipt.currency,
        refundResult.status,
        input.reason,
        ctx.userId,
      ],
    );

    // If full refund, reverse the receipt and re-open dues
    if (input.amount === receiptAmount) {
      await client.query(
        `UPDATE app.fee_receipts
            SET status = 'REVERSED',
                reversal_reason = $1,
                reversed_at = now(),
                reversed_by_user_id = $2
          WHERE organization_id = $3 AND id = $4`,
        [`Full gateway refund processed: ${input.reason}`, ctx.userId, ctx.tenantId, receipt.id],
      );

      // Revert allocations from student dues
      const allocations = await client.query<{ student_due_id: string; allocated_amount: string }>(
        `SELECT student_due_id, allocated_amount::text
           FROM app.fee_receipt_allocations
          WHERE organization_id = $1 AND receipt_id = $2`,
        [ctx.tenantId, receipt.id],
      );

      for (const alloc of allocations.rows) {
        const dueRes = await client.query<{ paid_amount: string; net_amount: string }>(
          `SELECT paid_amount::text, net_amount::text FROM app.student_dues
            WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [ctx.tenantId, alloc.student_due_id],
        );
        if (dueRes.rows.length > 0) {
          const due = dueRes.rows[0]!;
          const newPaid = Math.max(0, Number(due.paid_amount) - Number(alloc.allocated_amount));
          const newBalance = Number(due.net_amount) - newPaid;
          const newStatus = newPaid === 0 ? 'PENDING' : 'PARTIAL';

          await client.query(
            `UPDATE app.student_dues
                SET paid_amount = $1, balance_amount = $2, status = $3
              WHERE organization_id = $4 AND id = $5`,
            [newPaid, newBalance, newStatus, ctx.tenantId, alloc.student_due_id],
          );
        }
      }
    }

    await recordAudit(client, ctx, {
      action: 'fee.refund.initiate',
      resourceType: 'payment_refund',
      resourceId: refundId,
      riskTier: 3,
      reasonCode: 'PAYMENT_GATEWAY_REFUNDED',
      metadata: {
        receipt_id: receipt.id,
        amount: input.amount,
        gateway_refund_ref: refundResult.gatewayRefundRef,
        provider: config.provider,
      },
    });

    return {
      success: true,
      refund_id: refundId,
      gateway_refund_ref: refundResult.gatewayRefundRef,
      status: refundResult.status,
      amount: input.amount,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. List Payment Attempts & Reconciliation
  // ---------------------------------------------------------------------------

  async listPaymentAttempts(
    client: TenantTx,
    ctx: TrustedContext,
    query: ListPaymentAttemptsQuery,
  ): Promise<PaymentAttemptRow[]> {
    const conditions = ['a.organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (query.campus_id) {
      params.push(query.campus_id);
      conditions.push(`a.campus_id = $${params.length}`);
    }

    if (query.student_id) {
      params.push(query.student_id);
      conditions.push(`a.student_id = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      conditions.push(`a.status = $${params.length}`);
    }

    if (query.from_date) {
      params.push(`${query.from_date}T00:00:00Z`);
      conditions.push(`a.created_at >= $${params.length}`);
    }

    if (query.to_date) {
      params.push(`${query.to_date}T23:59:59Z`);
      conditions.push(`a.created_at <= $${params.length}`);
    }

    // Student self filtering
    if (AuthorizationEngine.isStudentActor(ctx)) {
      conditions.push(
        `a.student_id IN (SELECT s.id FROM app.students s WHERE s.user_id = '${ctx.userId}')`,
      );
    }

    const res = await client.query<{
      id: string;
      campus_id: string;
      student_id: string;
      student_name: string;
      admission_number: string | null;
      student_due_id: string | null;
      gateway_config_id: string;
      provider: PaymentGatewayProvider;
      mode: GatewayMode;
      attempt_reference: string;
      order_reference: string | null;
      amount: string;
      currency: string;
      status: 'INITIATED' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'USER_DROPPED' | 'EXPIRED';
      gateway_payment_ref: string | null;
      failure_reason: string | null;
      receipt_id: string | null;
      metadata_json: Record<string, unknown>;
      initiated_by_user_id: string;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT a.id, a.campus_id, a.student_id, u.display_name AS student_name,
              s.admission_number, a.student_due_id, a.gateway_config_id,
              a.provider, a.mode, a.attempt_reference, a.order_reference,
              a.amount::text, a.currency, a.status, a.gateway_payment_ref,
              a.failure_reason, a.receipt_id, a.metadata_json, a.initiated_by_user_id,
              a.created_at::text, a.updated_at::text
         FROM app.payment_attempts a
         JOIN app.students s ON s.organization_id = a.organization_id AND s.id = a.student_id
         JOIN app.users u ON u.organization_id = s.organization_id AND u.id = s.user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC`,
      params,
    );

    return res.rows.map((r) => ({
      ...r,
      admission_number: r.admission_number || undefined,
      amount: Number(r.amount),
    }));
  }

  async getReconciliationReport(
    client: TenantTx,
    ctx: TrustedContext,
    query: ReconciliationQuery,
  ): Promise<{
    total_online_attempts: number;
    total_successful_online_amount: number;
    total_successful_online_count: number;
    total_failed_online_count: number;
    total_offline_receipt_amount: number;
    total_offline_receipt_count: number;
    mismatches: Array<{
      attempt_reference: string;
      order_reference: string | null;
      provider: string;
      attempt_status: string;
      attempt_amount: number;
      receipt_id: string | null;
      issue: string;
    }>;
  }> {
    const attempts = await this.listPaymentAttempts(client, ctx, {
      campus_id: query.campus_id,
      from_date: query.from_date,
      to_date: query.to_date,
    });

    let totalOnlineSuccessAmount = 0;
    let totalOnlineSuccessCount = 0;
    let totalOnlineFailedCount = 0;
    const mismatches: Array<{
      attempt_reference: string;
      order_reference: string | null;
      provider: string;
      attempt_status: string;
      attempt_amount: number;
      receipt_id: string | null;
      issue: string;
    }> = [];

    for (const att of attempts) {
      if (att.status === 'SUCCESS') {
        totalOnlineSuccessAmount += att.amount;
        totalOnlineSuccessCount++;
        if (!att.receipt_id) {
          mismatches.push({
            attempt_reference: att.attempt_reference,
            order_reference: att.order_reference,
            provider: att.provider,
            attempt_status: att.status,
            attempt_amount: att.amount,
            receipt_id: null,
            issue: 'Gateway payment successful but fee receipt not posted',
          });
        }
      } else if (att.status === 'FAILED') {
        totalOnlineFailedCount++;
      } else if (att.status === 'PENDING' || att.status === 'INITIATED') {
        // Flag attempts older than 30 mins as pending review
        const createdMs = new Date(att.created_at).getTime();
        if (Date.now() - createdMs > 30 * 60 * 1000) {
          mismatches.push({
            attempt_reference: att.attempt_reference,
            order_reference: att.order_reference,
            provider: att.provider,
            attempt_status: att.status,
            attempt_amount: att.amount,
            receipt_id: null,
            issue: 'Payment attempt unconfirmed for >30 minutes (re-verification recommended)',
          });
        }
      }
    }

    // Offline receipts summary for same range
    const offlineRes = await client.query<{
      count: string;
      total_amount: string;
    }>(
      `SELECT count(*)::text AS count, coalesce(sum(amount), 0)::text AS total_amount
         FROM app.fee_receipts
        WHERE organization_id = $1
          AND status = 'POSTED'
          AND payment_method NOT LIKE 'ONLINE_%'`,
      [ctx.tenantId],
    );

    return {
      total_online_attempts: attempts.length,
      total_successful_online_amount: totalOnlineSuccessAmount,
      total_successful_online_count: totalOnlineSuccessCount,
      total_failed_online_count: totalOnlineFailedCount,
      total_offline_receipt_amount: Number(offlineRes.rows[0]?.total_amount || 0),
      total_offline_receipt_count: Number(offlineRes.rows[0]?.count || 0),
      mismatches,
    };
  }
}
