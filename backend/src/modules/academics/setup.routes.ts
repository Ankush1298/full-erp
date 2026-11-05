import type { FastifyInstance } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { IdParamSchema, type IdParam } from './academic.schemas.js';
import { DataResponse, TermRecordSchema } from './calendar.schemas.js';
import { etag, expectedVersion, extractAuditMeta, requireContext } from './common.js';
import {
  ActivationBodySchema,
  SetupWizardService,
  WizardResponseSchema,
  type ActivationBody,
} from './setup-wizard.service.js';
import {
  ChecklistResponseSchema,
  SetupService,
  TerminologyResponseSchema,
} from './setup.service.js';

/**
 * Terminology labels (academic.program.read), the setup checklist and setup wizard (organization-scoped
 * academic.term.manage), and the wizard's checked term activation (academic.term.manage on the term's campus).
 */
export function registerSetupRoutes(app: FastifyInstance, db: Database): void {
  app.get(
    '/terminology',
    {
      config: { permission: 'academic.program.read' },
      schema: { response: { 200: TerminologyResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SetupService.terminology(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.get(
    '/setup-checklist',
    {
      config: { permission: 'academic.term.manage' },
      schema: { response: { 200: ChecklistResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SetupService.checklist(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.get(
    '/setup-wizard',
    {
      config: { permission: 'academic.term.manage' },
      schema: { response: { 200: WizardResponseSchema } },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const data = await db.withTenant(ctx, (tx) => SetupWizardService.overview(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );
  app.post<{ Params: IdParam; Body: ActivationBody }>(
    '/terms/:id/activation',
    {
      config: { permission: 'academic.term.manage' },
      schema: {
        params: IdParamSchema,
        body: ActivationBodySchema,
        response: { 200: DataResponse(TermRecordSchema) },
      },
    },
    async (req, reply) => {
      const ctx = requireContext(req);
      const expected = expectedVersion(req);
      const meta = extractAuditMeta(req);
      const data = await db.withTenant(ctx, (tx) =>
        SetupWizardService.activateTerm(tx, ctx, req.params.id, req.body ?? {}, { expected, meta }),
      );
      etag(reply, data.version);
      return reply.status(200).send({ success: true, data });
    },
  );
}
