import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { requireContext } from '../academics/common.js';
import { FinanceService } from './finance.service.js';
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

export const registerFinanceRoutes: FastifyPluginAsync<{
  db: Database;
}> = async (app, opts) => {
  await Promise.resolve();
  const db = opts.db;
  const financeService = new FinanceService();

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
      const created = await db.withTenant(ctx, (tx) => financeService.createCategory(tx, ctx, body));
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
      const created = await db.withTenant(ctx, (tx) => financeService.createStructure(tx, ctx, body));
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
        reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Fee structure not found' } });
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
      const reversed = await db.withTenant(ctx, (tx) => financeService.reverseReceipt(tx, ctx, id, body));
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
      const summary = await db.withTenant(ctx, (tx) => financeService.getCollectionSummary(tx, ctx, query));
      reply.send({ data: summary });
    },
  );
};
