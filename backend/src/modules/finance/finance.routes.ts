import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { requireContext } from '../academics/common.js';
import { FinanceService } from './finance.service.js';
import { PaymentGatewayService } from './gateway.service.js';
import {
  CreateFeeCategorySchema,
  CreateFeeStructureSchema,
  GenerateStudentDuesSchema,
  RecordOfflineReceiptSchema,
  ReverseReceiptSchema,
  CollectionSummaryQuerySchema,
  ListFeeStructuresQuerySchema,
  ListStudentDuesQuerySchema,
  ListFeeReceiptsQuerySchema,
} from './finance.schemas.js';
import {
  SaveGatewayConfigSchema,
  TestGatewayConnectionSchema,
  InitiateOnlinePaymentSchema,
  VerifyOnlinePaymentSchema,
  InitiateRefundSchema,
  ListPaymentAttemptsQuerySchema,
  ReconciliationQuerySchema,
} from './gateway.schemas.js';
import type { PaymentGatewayProvider } from './gateways/types.js';

export const registerFinanceRoutes: FastifyPluginAsync<{
  db: Database;
}> = async (app, opts) => {
  await Promise.resolve();
  const db = opts.db;
  const financeService = new FinanceService();
  const gatewayService = new PaymentGatewayService();

  // 1. Fee Categories
  app.get(
    '/api/v1/finance/categories',
    { config: { permission: 'fee.structure.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const items = await db.withTenant(ctx, (tx) => financeService.listCategories(tx, ctx));
      reply.send({ data: items });
    },
  );

  app.post(
    '/api/v1/finance/categories',
    { config: { permission: 'fee.structure.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = CreateFeeCategorySchema.parse(req.body);
      const created = await db.withTenant(ctx, (tx) =>
        financeService.createCategory(tx, ctx, body),
      );
      reply.status(201).send({ data: created });
    },
  );

  // 2. Fee Structures
  app.get(
    '/api/v1/finance/structures',
    { config: { permission: 'fee.structure.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListFeeStructuresQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) => financeService.listStructures(tx, ctx, query));
      reply.send({ data: items });
    },
  );

  app.post(
    '/api/v1/finance/structures',
    { config: { permission: 'fee.structure.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = CreateFeeStructureSchema.parse(req.body);
      const created = await db.withTenant(ctx, (tx) =>
        financeService.createStructure(tx, ctx, body),
      );
      reply.status(201).send({ data: created });
    },
  );

  app.get(
    '/api/v1/finance/structures/:id',
    { config: { permission: 'fee.structure.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id } = req.params as { id: string };
      const item = await db.withTenant(ctx, (tx) => financeService.getStructure(tx, ctx, id));
      if (!item) {
        reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Fee structure not found' } });
        return;
      }
      reply.send({ data: item });
    },
  );

  // 3. Student Dues
  app.post(
    '/api/v1/finance/dues/generate',
    { config: { permission: 'fee.dues.generate' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = GenerateStudentDuesSchema.parse(req.body);
      const result = await db.withTenant(ctx, (tx) => financeService.generateDues(tx, ctx, body));
      reply.status(201).send({ data: result });
    },
  );

  app.get(
    '/api/v1/finance/dues',
    { config: { permission: 'fee.dues.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListStudentDuesQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) => financeService.listDues(tx, ctx, query));
      reply.send({ data: items });
    },
  );

  // 4. Student Ledger
  app.get(
    '/api/v1/finance/students/:id/ledger',
    { config: { permission: 'fee.dues.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id } = req.params as { id: string };
      const ledger = await db.withTenant(ctx, (tx) => financeService.getStudentLedger(tx, ctx, id));
      reply.send({ data: ledger });
    },
  );

  // 5. Payment Receipts
  app.post(
    '/api/v1/finance/receipts',
    { config: { permission: 'fee.receipt.record' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = RecordOfflineReceiptSchema.parse(req.body);
      const receipt = await db.withTenant(ctx, (tx) => financeService.recordReceipt(tx, ctx, body));
      reply.status(201).send({ data: receipt });
    },
  );

  app.get(
    '/api/v1/finance/receipts',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListFeeReceiptsQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) => financeService.listReceipts(tx, ctx, query));
      reply.send({ data: items });
    },
  );

  app.get(
    '/api/v1/finance/receipts/:id',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id } = req.params as { id: string };
      const item = await db.withTenant(ctx, (tx) => financeService.getReceipt(tx, ctx, id));
      if (!item) {
        reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Receipt not found' } });
        return;
      }
      reply.send({ data: item });
    },
  );

  app.post(
    '/api/v1/finance/receipts/:id/reverse',
    { config: { permission: 'fee.receipt.reverse' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id } = req.params as { id: string };
      const body = ReverseReceiptSchema.parse(req.body);
      const reversed = await db.withTenant(ctx, (tx) =>
        financeService.reverseReceipt(tx, ctx, id, body),
      );
      reply.send({ data: reversed });
    },
  );

  // 6. Collection Summary
  app.get(
    '/api/v1/finance/reports/collection-summary',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = CollectionSummaryQuerySchema.parse(req.query);
      const summary = await db.withTenant(ctx, (tx) =>
        financeService.getCollectionSummary(tx, ctx, query),
      );
      reply.send({ data: summary });
    },
  );

  // 7. Payment Gateway Settings
  app.get(
    '/api/v1/finance/gateway/config',
    { config: { permission: 'fee.gateway.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const configs = await db.withTenant(ctx, (tx) => gatewayService.listConfigs(tx, ctx));
      reply.send({ data: configs });
    },
  );

  app.post(
    '/api/v1/finance/gateway/config',
    { config: { permission: 'fee.gateway.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = SaveGatewayConfigSchema.parse(req.body);
      const saved = await db.withTenant(ctx, (tx) => gatewayService.saveConfig(tx, ctx, body));
      reply.status(201).send({ data: saved });
    },
  );

  app.post(
    '/api/v1/finance/gateway/test',
    { config: { permission: 'fee.gateway.manage' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = TestGatewayConnectionSchema.parse(req.body);
      const result = await db.withTenant(ctx, (tx) => gatewayService.testConnection(tx, ctx, body));
      reply.send({ data: result });
    },
  );

  // 8. Online Payments
  app.post(
    '/api/v1/finance/payments/initiate',
    { config: { permission: 'fee.payment.initiate' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = InitiateOnlinePaymentSchema.parse(req.body);
      const result = await db.withTenant(ctx, (tx) =>
        gatewayService.initiatePayment(tx, ctx, body),
      );
      reply.status(201).send({ data: result });
    },
  );

  app.post(
    '/api/v1/finance/payments/verify',
    { config: { permission: 'fee.payment.initiate' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const body = VerifyOnlinePaymentSchema.parse(req.body);
      const result = await db.withTenant(ctx, (tx) => gatewayService.verifyPayment(tx, ctx, body));
      reply.send({ data: result });
    },
  );

  app.get(
    '/api/v1/finance/payments/attempts',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ListPaymentAttemptsQuerySchema.parse(req.query);
      const items = await db.withTenant(ctx, (tx) =>
        gatewayService.listPaymentAttempts(tx, ctx, query),
      );
      reply.send({ data: items });
    },
  );

  // 9. Payment Gateway Refunds
  app.post(
    '/api/v1/finance/receipts/:id/refund',
    { config: { permission: 'fee.refund.initiate' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { id } = req.params as { id: string };
      const body = InitiateRefundSchema.parse({
        ...(typeof req.body === 'object' && req.body !== null ? req.body : {}),
        receipt_id: id,
      });
      const result = await db.withTenant(ctx, (tx) => gatewayService.initiateRefund(tx, ctx, body));
      reply.send({ data: result });
    },
  );

  // 10. Financial Reconciliation
  app.get(
    '/api/v1/finance/reports/reconciliation',
    { config: { permission: 'fee.receipt.read' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const query = ReconciliationQuerySchema.parse(req.query);
      const report = await db.withTenant(ctx, (tx) =>
        gatewayService.getReconciliationReport(tx, ctx, query),
      );
      reply.send({ data: report });
    },
  );

  // 11. Authenticated Webhook Handler
  app.post(
    '/api/v1/finance/payments/webhook/:provider',
    { config: { permission: 'fee.payment.initiate' } },
    async (req, reply) => {
      const ctx = requireContext(req);
      const { provider } = req.params as { provider: PaymentGatewayProvider };
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const result = await db.withTenant(ctx, (tx) =>
        gatewayService.handleWebhook(
          tx,
          ctx,
          provider,
          req.headers as Record<string, string | string[] | undefined>,
          rawBody,
        ),
      );
      reply.send({ data: result });
    },
  );
};
