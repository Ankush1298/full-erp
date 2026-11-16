import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import { VaultService } from './vault.service.js';
import {
  AppointAuthoritySchema,
  DelegateAuthoritySchema,
  RevokeAuthoritySchema,
  EnrollDeviceSchema,
  VerifyDeviceSchema,
  RevokeDeviceSchema,
  RotateEpochSchema,
  SetupCustodiansSchema,
  InitiateRecoverySchema,
  PresentRecoveryShareSchema,
  IssueKeyGrantSchema,
  StoreProtectedRecordSchema,
  GrantAdultConsentSchema,
} from './vault.schemas.js';

export const registerVaultRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  if (!opts.db) {
    throw new Error('Database dependency is required for vault routes.');
  }

  // 1. Get Security Authority
  app.get(
    '/authority',
    {
      config: { permission: 'vault.authority.read' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.getSecurityAuthority(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 2. Appoint Security Authority
  app.post(
    '/authority/appoint',
    {
      config: { permission: 'vault.authority.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = AppointAuthoritySchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.appointSecurityAuthority(tx, ctx, parsed),
      );
      return reply.status(201).send({ success: true, data });
    },
  );

  // 3. Delegate Security Authority
  app.post<{ Params: { id: string } }>(
    '/authority/:id/delegate',
    {
      config: { permission: 'vault.authority.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = DelegateAuthoritySchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.delegateSecurityAuthority(tx, ctx, req.params.id, parsed),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 4. Revoke Security Authority
  app.post<{ Params: { id: string } }>(
    '/authority/:id/revoke',
    {
      config: { permission: 'vault.authority.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = RevokeAuthoritySchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.revokeSecurityAuthority(tx, ctx, req.params.id, parsed),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 5. List Authenticator Devices (Current user)
  app.get(
    '/devices',
    {
      config: { permission: 'vault.device.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.listUserDevices(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 6. Enroll Authenticator Device (Enforces max 2 devices)
  app.post(
    '/devices/enroll',
    {
      config: { permission: 'vault.device.enroll' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = EnrollDeviceSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.enrollDevice(tx, ctx, parsed));
      return reply.status(201).send({ success: true, data });
    },
  );

  // 6b. Issue Cryptographic Device Challenge
  app.post(
    '/devices/challenge',
    {
      config: { permission: 'vault.device.enroll' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = VaultService.generateDeviceChallenge();
      return reply.status(200).send({ success: true, data });
    },
  );

  // 7. Verify Authenticator Device
  app.post<{ Params: { id: string } }>(
    '/devices/:id/verify',
    {
      config: { permission: 'vault.device.enroll' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = VerifyDeviceSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.verifyDevice(tx, ctx, req.params.id, parsed),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 8. Revoke Authenticator Device
  app.post<{ Params: { id: string } }>(
    '/devices/:id/revoke',
    {
      config: { permission: 'vault.device.enroll' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = RevokeDeviceSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.revokeDevice(tx, ctx, req.params.id, parsed),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 9. Get Current Vault Epoch
  app.get(
    '/epoch',
    {
      config: { permission: 'vault.authority.read' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.getCurrentEpoch(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 10. Rotate Epoch
  app.post(
    '/epoch/rotate',
    {
      config: { permission: 'vault.authority.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = RotateEpochSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.rotateEpoch(tx, ctx, parsed));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 11. Setup 2-of-3 Recovery Custodians
  app.post(
    '/recovery/custodians',
    {
      config: { permission: 'vault.recovery.initiate' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = SetupCustodiansSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.setupCustodians(tx, ctx, parsed));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 12. Initiate Recovery Ceremony
  app.post(
    '/recovery/ceremony',
    {
      config: { permission: 'vault.recovery.initiate' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = InitiateRecoverySchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.initiateRecoveryCeremony(tx, ctx, parsed),
      );
      return reply.status(201).send({ success: true, data });
    },
  );

  // 13. Present Recovery Share
  app.post(
    '/recovery/share',
    {
      config: { permission: 'vault.recovery.initiate' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = PresentRecoveryShareSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.presentRecoveryShare(tx, ctx, parsed),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 14. Issue Capability Key Grant
  app.post(
    '/grants/issue',
    {
      config: { permission: 'vault.grant.issue' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = IssueKeyGrantSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.issueKeyGrant(tx, ctx, parsed));
      return reply.status(201).send({ success: true, data });
    },
  );

  // 15. Get Active Grants for Device
  app.get<{ Params: { deviceId: string } }>(
    '/grants/device/:deviceId',
    {
      config: { permission: 'vault.record.read' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.getActiveGrantsForDevice(tx, ctx, req.params.deviceId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 16. Store Protected Record (Zero-Access: Backend stores ciphertext only!)
  app.post(
    '/records',
    {
      config: { permission: 'vault.record.write' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = StoreProtectedRecordSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.storeProtectedRecord(tx, ctx, parsed),
      );
      return reply.status(201).send({ success: true, data });
    },
  );

  // 17. Retrieve Protected Record (Zero-Access: Returns ciphertext envelope!)
  app.get<{ Params: { entityType: string; entityId: string } }>(
    '/records/:entityType/:entityId',
    {
      config: { permission: 'vault.record.read' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.getProtectedRecord(tx, ctx, req.params.entityType, req.params.entityId),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  // 18. Adult Student Consents: List
  app.get(
    '/adult-consents',
    {
      config: { permission: 'adult.consent.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => VaultService.listAdultConsents(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  // 19. Adult Student Consents: Grant
  app.post(
    '/adult-consents',
    {
      config: { permission: 'adult.consent.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const parsed = GrantAdultConsentSchema.parse(req.body);
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.grantAdultConsent(tx, ctx, parsed),
      );
      return reply.status(201).send({ success: true, data });
    },
  );

  // 20. Adult Student Consents: Revoke
  app.delete<{ Params: { id: string } }>(
    '/adult-consents/:id',
    {
      config: { permission: 'adult.consent.manage' },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        VaultService.revokeAdultConsent(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );
};
