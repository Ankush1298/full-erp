import { createHash } from 'node:crypto';
import { AppError, resourceNotFound } from '../../shared/errors/http-errors.js';
import type { TenantTx } from '../../shared/database/index.js';
import { isUuidV7, uuidv7 } from '../../shared/ids/uuidv7.js';
import { isTrustedContext, type TrustedContext } from '../../shared/tenancy/trusted-context.js';
import { recordAudit, type AuditRequestMeta } from '../../shared/audit/index.js';
import { AuthorizationEngine } from '../../shared/authorization/engine.js';
import { recordOutboxEvent } from '../../shared/outbox/index.js';
import type { ConsentResponse, ListConsentsQuery, RecordConsentBody } from './consent.schemas.js';

import { StudentGuardianService } from '../students/student-guardian.service.js';

function ensureTrusted(ctx: TrustedContext): void {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }
}

export interface ConsentRow {
  id: string;
  organization_id: string;
  user_id: string;
  consent_type: string;
  policy_version: string;
  status: 'GRANTED' | 'WITHDRAWN';
  granted_at: Date;
  withdrawn_at: Date | null;
  method: string;
  ip: string | null;
  user_agent: string | null;
  granted_by_user_id: string;
  guardian_id: string | null;
  policy_text_hash: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toDto(row: ConsentRow): ConsentResponse {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    consentType: row.consent_type,
    policyVersion: row.policy_version,
    status: row.status,
    grantedAt: row.granted_at.toISOString(),
    withdrawnAt: row.withdrawn_at ? row.withdrawn_at.toISOString() : null,
    method: row.method,
    grantedByUserId: row.granted_by_user_id,
    guardianId: row.guardian_id ?? null,
    policyTextHash: row.policy_text_hash,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ConsentService {
  /**
   * Records a point-in-time explicit consent (doc 02 §4.3, doc 10 rows 39-41).
   * Generates a policy text hash, verifies guardian authority when specified,
   * enforces tenant isolation, emits audit event, and registers outbox event.
   */
  public async recordConsent(
    tx: TenantTx,
    ctx: TrustedContext,
    targetUserId: string,
    body: RecordConsentBody,
    meta?: AuditRequestMeta,
  ): Promise<ConsentResponse> {
    ensureTrusted(ctx);

    if (!isUuidV7(targetUserId)) {
      throw new AppError(400, 'INVALID_USER_ID', 'Target userId must be a valid UUIDv7.');
    }

    // Authorization: assert consent.record for self, or staff guardian management on behalf.
    if (targetUserId === ctx.userId) {
      await AuthorizationEngine.assert(tx, ctx, 'consent.record', {
        organization_id: ctx.tenantId,
        user_id: targetUserId,
      });
    } else {
      AuthorizationEngine.assertStaffActor(ctx);
      await AuthorizationEngine.assert(tx, ctx, 'student.guardian.manage', {
        organization_id: ctx.tenantId,
      });
    }

    // Verify target user exists in this tenant.
    const { rows: userRows } = await tx.query<{ id: string }>(
      `SELECT id FROM app.users WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, targetUserId],
    );
    if (userRows.length === 0) {
      throw resourceNotFound();
    }

    // Guardian-granted consent validation
    if (body.guardianId !== undefined) {
      if (!isUuidV7(body.guardianId)) {
        throw new AppError(400, 'INVALID_GUARDIAN_ID', 'guardianId must be a valid UUIDv7.');
      }
      const isAuthorized = await StudentGuardianService.verifyConsentAuthority(
        tx,
        ctx.tenantId,
        targetUserId,
        body.guardianId,
      );
      if (!isAuthorized) {
        throw new AppError(
          403,
          'GUARDIAN_CONSENT_UNAUTHORIZED',
          'Guardian is not authorized to grant consent on behalf of student.',
        );
      }
    }

    const policyTextHash = createHash('sha256').update(body.policyText, 'utf8').digest('hex');
    const id = uuidv7();
    const method = body.method ?? 'WEB_FORM';

    const { rows: insertRows } = await tx.query<ConsentRow>(
      `INSERT INTO app.consents (
         id, organization_id, user_id, consent_type, policy_version, status,
         method, ip, user_agent, granted_by_user_id, guardian_id, policy_text_hash
       ) VALUES (
         $1, $2, $3, $4, $5, 'GRANTED',
         $6, $7::inet, $8, $9, $10, $11
       ) RETURNING *`,
      [
        id,
        ctx.tenantId,
        targetUserId,
        body.consentType,
        body.policyVersion,
        method,
        meta?.ip ?? null,
        meta?.userAgent ?? null,
        ctx.userId,
        body.guardianId ?? null,
        policyTextHash,
      ],
    );

    const consent = insertRows[0];
    if (!consent) {
      throw new AppError(500, 'INSERT_FAILED', 'Failed to record consent.');
    }

    // Audit event (risk tier 2: sensitive compliance action)
    await recordAudit(
      tx,
      ctx,
      {
        action: 'consent.record',
        resourceType: 'consent',
        resourceId: id,
        riskTier: 2,
        metadata: {
          consentType: body.consentType,
          policyVersion: body.policyVersion,
          targetUserId,
          guardianId: body.guardianId ?? null,
        },
      },
      meta,
    );

    // Outbox event for decoupled relay
    await recordOutboxEvent(tx, ctx, {
      eventType: 'consent.recorded',
      aggregateType: 'consent',
      aggregateId: id,
      payload: {
        consentId: id,
        userId: targetUserId,
        consentType: body.consentType,
        policyVersion: body.policyVersion,
        policyTextHash,
        grantedByUserId: ctx.userId,
      },
    });

    return toDto(consent);
  }

  /**
   * Withdraws an existing active consent.
   * Forward-only transition: GRANTED -> WITHDRAWN.
   */
  public async withdrawConsent(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    meta?: AuditRequestMeta,
  ): Promise<ConsentResponse> {
    ensureTrusted(ctx);

    if (!isUuidV7(id)) {
      throw new AppError(400, 'INVALID_CONSENT_ID', 'Consent id must be a valid UUIDv7.');
    }

    const { rows } = await tx.query<ConsentRow>(
      `SELECT * FROM app.consents WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, id],
    );

    if (rows.length === 0) {
      throw resourceNotFound();
    }

    const existing = rows[0];
    if (!existing) {
      throw resourceNotFound();
    }

    // Authorization: assert consent.withdraw for the consent subject
    await AuthorizationEngine.assert(tx, ctx, 'consent.withdraw', {
      organization_id: ctx.tenantId,
      user_id: existing.user_id,
    });

    if (existing.status === 'WITHDRAWN') {
      throw new AppError(409, 'CONSENT_ALREADY_WITHDRAWN', 'Consent has already been withdrawn.');
    }

    const { rows: updatedRows } = await tx.query<ConsentRow>(
      `UPDATE app.consents
          SET status = 'WITHDRAWN',
              withdrawn_at = now(),
              version = version + 1,
              updated_at = now()
        WHERE organization_id = $1 AND id = $2 AND version = $3
        RETURNING *`,
      [ctx.tenantId, id, existing.version],
    );

    if (updatedRows.length === 0) {
      throw new AppError(409, 'CONCURRENT_UPDATE', 'Consent record was modified concurrently.');
    }

    const updated = updatedRows[0];
    if (!updated) {
      throw new AppError(409, 'CONCURRENT_UPDATE', 'Consent record was modified concurrently.');
    }

    // Audit event (risk tier 2)
    await recordAudit(
      tx,
      ctx,
      {
        action: 'consent.withdraw',
        resourceType: 'consent',
        resourceId: id,
        riskTier: 2,
        metadata: {
          consentType: existing.consent_type,
          targetUserId: existing.user_id,
        },
      },
      meta,
    );

    // Outbox event
    await recordOutboxEvent(tx, ctx, {
      eventType: 'consent.withdrawn',
      aggregateType: 'consent',
      aggregateId: id,
      payload: {
        consentId: id,
        userId: existing.user_id,
        consentType: existing.consent_type,
      },
    });

    return toDto(updated);
  }

  /**
   * Lists consents matching query criteria, scoped by tenant and permissions.
   */
  public async listConsents(
    tx: TenantTx,
    ctx: TrustedContext,
    targetUserId: string | undefined,
    query: ListConsentsQuery,
  ): Promise<ConsentResponse[]> {
    ensureTrusted(ctx);

    const target = targetUserId ?? ctx.userId;
    if (target) {
      await AuthorizationEngine.assert(tx, ctx, 'consent.read', {
        organization_id: ctx.tenantId,
        user_id: target,
      });
    } else {
      await AuthorizationEngine.assert(tx, ctx, 'consent.read', {
        organization_id: ctx.tenantId,
      });
    }

    if (targetUserId) {
      const { rows: userRows } = await tx.query<{ id: string }>(
        `SELECT id FROM app.users WHERE organization_id = $1 AND id = $2`,
        [ctx.tenantId, targetUserId],
      );
      if (userRows.length === 0) {
        throw resourceNotFound();
      }
    }

    const conditions: string[] = ['organization_id = $1'];
    const params: unknown[] = [ctx.tenantId];

    if (target) {
      params.push(target);
      conditions.push(`user_id = $${params.length}`);
    }

    if (query.consentType) {
      params.push(query.consentType);
      conditions.push(`consent_type = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }

    const { rows } = await tx.query<ConsentRow>(
      `SELECT * FROM app.consents
        WHERE ${conditions.join(' AND ')}
        ORDER BY granted_at DESC`,
      params,
    );

    return rows.map(toDto);
  }

  /**
   * Retrieves a single consent by ID.
   */
  public async getConsentById(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
  ): Promise<ConsentResponse> {
    ensureTrusted(ctx);

    if (!isUuidV7(id)) {
      throw new AppError(400, 'INVALID_CONSENT_ID', 'Consent id must be a valid UUIDv7.');
    }

    const { rows } = await tx.query<ConsentRow>(
      `SELECT * FROM app.consents WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, id],
    );

    if (rows.length === 0) {
      throw resourceNotFound();
    }

    const consent = rows[0];
    if (!consent) {
      throw resourceNotFound();
    }
    await AuthorizationEngine.assert(tx, ctx, 'consent.read', {
      organization_id: ctx.tenantId,
      user_id: consent.user_id,
    });

    return toDto(consent);
  }

  /**
   * Internal/Service helper: checks if there is currently an active GRANTED consent.
   */
  public async hasActiveConsent(
    tx: TenantTx,
    ctx: TrustedContext,
    userId: string,
    consentType: string,
  ): Promise<boolean> {
    ensureTrusted(ctx);

    const { rows } = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM app.consents
        WHERE organization_id = $1
          AND user_id = $2
          AND consent_type = $3
          AND status = 'GRANTED'`,
      [ctx.tenantId, userId, consentType],
    );

    return Number(rows[0]?.count ?? '0') > 0;
  }
}
