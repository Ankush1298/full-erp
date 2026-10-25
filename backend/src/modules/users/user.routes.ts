import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { RoleAssignmentService } from '../../shared/authorization/assignments.js';
import type { FixedWindowLimiter } from '../../shared/http/fixed-window-limiter.js';
import type { InvitationMailer } from '../../shared/email/invitation-mailer.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { UserService } from './user.service.js';
import {
  adminResetUserMfa,
  issueMfaEnrollmentTicket,
  MFA_RESET_PERMISSION,
} from '../auth/mfa/mfa.service.js';
import {
  GetUserResponseSchema,
  GrantRoleBodySchema,
  type GrantRoleBody,
  GrantRoleResponseSchema,
  ListRoleAssignmentsResponseSchema,
  ListRolesResponseSchema,
  UpdateAssignmentExpiryBodySchema,
  type UpdateAssignmentExpiryBody,
  UpdateAssignmentExpiryResponseSchema,
  InviteUserBodySchema,
  type InviteUserBody,
  InviteUserResponseSchema,
  IssueMfaTicketResponseSchema,
  ListUsersQuerySchema,
  type ListUsersQuery,
  ListUsersResponseSchema,
  OkResponseSchema,
  RevokeRoleBodySchema,
  type RevokeRoleBody,
  RoleAssignmentIdParamSchema,
  type RoleAssignmentIdParam,
  UserIdParamSchema,
  type UserIdParam,
  UserStatusChangeBodySchema,
  type UserStatusChangeBody,
} from './user.schemas.js';

function auditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  if (req.tenantContext?.sessionId) meta.sessionId = req.tenantContext.sessionId;
  return meta;
}

export interface UserRoutesOptions {
  db: Database;
  mailer: InvitationMailer;
  /** Invitations per (tenant, user) per window. Single process only (see FixedWindowLimiter). */
  inviteLimiter: FixedWindowLimiter;
}

/**
 * doc 11 §5.4 "Users" and "Roles", mounted at /api/v1. Every route is gated by a catalogued permission in the shared
 * preHandler (403 when held in no scope); the services prove the organization scope and decide everything else. The tenant
 * comes only from the session. Role assignment is a thin route over the EXISTING RoleAssignmentService (its own permission,
 * grant rules, scope containment, reason and audit apply unchanged); the invitation flow itself grants nothing.
 */
export const registerUserRoutes: FastifyPluginAsync<UserRoutesOptions> = async (app, opts) => {
  await Promise.resolve();

  app.get<{ Querystring: ListUsersQuery }>(
    '/users',
    {
      config: { permission: 'user.account.read' },
      schema: { querystring: ListUsersQuerySchema, response: { 200: ListUsersResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const out = await opts.db.withTenant(ctx, (tx) => UserService.list(tx, ctx, req.query));
      return reply.status(200).send({
        success: true,
        data: out.data,
        page: { nextAfterId: out.nextAfterId },
      });
    },
  );

  app.get<{ Params: UserIdParam }>(
    '/users/:id',
    {
      config: { permission: 'user.account.read' },
      schema: { params: UserIdParamSchema, response: { 200: GetUserResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => UserService.get(tx, ctx, req.params.id));
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: UserIdParam }>(
    '/users/:id/role-assignments',
    {
      config: { permission: 'user.account.read' },
      schema: { params: UserIdParamSchema, response: { 200: ListRoleAssignmentsResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        UserService.listAssignments(tx, ctx, req.params.id),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get(
    '/roles',
    {
      config: { permission: 'user.account.read' },
      schema: { response: { 200: ListRolesResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => UserService.listRoles(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Body: InviteUserBody }>(
    '/users/invite',
    {
      config: { permission: 'user.account.invite' },
      schema: { body: InviteUserBodySchema, response: { 201: InviteUserResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const wait = opts.inviteLimiter.take(`${ctx.tenantId}:${ctx.userId}`);
      if (wait > 0) {
        void reply.header('retry-after', String(wait));
        throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many invitations. Try again later.');
      }
      const out = await opts.db.withTenant(ctx, (tx) =>
        UserService.invite(tx, ctx, req.body, {
          idempotencyKey: req.headers['idempotency-key'],
          meta: auditMeta(req),
        }),
      );

      // AFTER commit. A failure never undoes the invitation: the administrator re-invites (which rotates the token).
      let delivery: 'SENT' | 'FAILED' | 'NOT_ATTEMPTED' = 'NOT_ATTEMPTED';
      if (out.mail) {
        try {
          await opts.mailer.send(out.mail);
          delivery = 'SENT';
        } catch (err) {
          delivery = 'FAILED';
          // The error class only: a provider's message could echo the message body, which contains the token.
          req.log.warn(
            { errorName: err instanceof Error ? err.name : 'unknown' },
            'invitation delivery failed',
          );
        }
      }
      if (out.result.replayed) void reply.header('Idempotent-Replayed', 'true');
      const stored = out.result.body as { success: true; data: Record<string, unknown> };
      return reply
        .status(out.result.status)
        .send({ success: true, data: { ...stored.data, delivery } });
    },
  );

  for (const action of ['suspend', 'reactivate'] as const) {
    app.post<{ Params: UserIdParam; Body: UserStatusChangeBody }>(
      `/users/:id/${action}`,
      {
        config: { permission: 'user.account.suspend' },
        schema: {
          params: UserIdParamSchema,
          body: UserStatusChangeBodySchema,
          response: { 200: GetUserResponseSchema },
        },
      },
      async (req, reply) => {
        const ctx = req.tenantContext;
        if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
        const header = req.headers['if-match'];
        const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
        const options = { expected, meta: auditMeta(req) };
        const data = await opts.db.withTenant(ctx, (tx) =>
          action === 'suspend'
            ? UserService.suspend(tx, ctx, req.params.id, req.body, options)
            : UserService.reactivate(tx, ctx, req.params.id, req.body, options),
        );
        reply.header('ETag', `"${data.version}"`);
        return reply.status(200).send({ success: true, data });
      },
    );
  }

  // doc 10 row 10a (CRITICAL: the shared preHandler also demands the administrator's fresh PASSWORD_MFA step-up).
  app.post<{ Params: UserIdParam; Body: UserStatusChangeBody }>(
    '/users/:id/mfa/reset',
    {
      config: { permission: MFA_RESET_PERMISSION },
      schema: { params: UserIdParamSchema, body: UserStatusChangeBodySchema },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        adminResetUserMfa(tx, ctx, req.params.id, req.body, auditMeta(req)),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: UserIdParam; Body: UserStatusChangeBody }>(
    '/users/:id/mfa/enrollment-ticket',
    {
      config: { permission: MFA_RESET_PERMISSION },
      schema: {
        params: UserIdParamSchema,
        body: UserStatusChangeBodySchema,
        response: { 201: IssueMfaTicketResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        issueMfaEnrollmentTicket(tx, ctx, req.params.id, req.body, auditMeta(req)),
      );
      return reply.status(201).send({ success: true, data });
    },
  );

  app.post<{ Params: UserIdParam; Body: GrantRoleBody }>(
    '/users/:id/role-assignments',
    {
      config: { permission: 'role.assignment.grant' },
      schema: {
        params: UserIdParamSchema,
        body: GrantRoleBodySchema,
        response: { 201: GrantRoleResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const id = await opts.db.withTenant(ctx, (tx) =>
        UserService.grantRole(tx, ctx, req.params.id, req.body, auditMeta(req)),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // Expiry change. CRITICAL like a grant (a longer or unlimited assignment is a grant); If-Match = the assignment version.
  app.patch<{ Params: RoleAssignmentIdParam; Body: UpdateAssignmentExpiryBody }>(
    '/role-assignments/:id',
    {
      config: { permission: 'role.assignment.grant' },
      schema: {
        params: RoleAssignmentIdParamSchema,
        body: UpdateAssignmentExpiryBodySchema,
        response: { 200: UpdateAssignmentExpiryResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      if (expected.type !== 'version') {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'If-Match must carry the exact version of the assignment.',
        );
      }
      const data = await opts.db.withTenant(ctx, (tx) =>
        RoleAssignmentService.updateExpiry(
          tx,
          ctx,
          req.params.id,
          {
            validUntil: req.body.validUntil,
            reason: req.body.reason,
            expectedVersion: expected.version,
          },
          auditMeta(req),
        ),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Params: RoleAssignmentIdParam; Body: RevokeRoleBody }>(
    '/role-assignments/:id/revoke',
    {
      config: { permission: 'role.assignment.revoke' },
      schema: {
        params: RoleAssignmentIdParamSchema,
        body: RevokeRoleBodySchema,
        response: { 200: OkResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      await opts.db.withTenant(ctx, (tx) =>
        RoleAssignmentService.revoke(tx, ctx, req.params.id, req.body.reason, auditMeta(req)),
      );
      return reply.status(200).send({ success: true });
    },
  );
};
