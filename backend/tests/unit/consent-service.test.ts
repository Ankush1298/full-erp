import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConsentService } from '../../src/modules/consent/consent.service.js';
import { AppError } from '../../src/shared/errors/http-errors.js';
import type { TenantTx } from '../../src/shared/database/tenant-tx.js';
import { issueTrustedContext } from '../../src/shared/tenancy/issue-trusted-context.js';
import { AuthorizationEngine } from '../../src/shared/authorization/engine.js';
import * as auditModule from '../../src/shared/audit/index.js';
import * as outboxModule from '../../src/shared/outbox/index.js';

describe('ConsentService (unit)', () => {
  const orgId = '01939a00-0000-7000-8000-000000000001';
  const studentUserId = '01939a00-0000-7000-8000-000000000002';
  const staffUserId = '01939a00-0000-7000-8000-000000000003';
  const guardianId = '01939a00-0000-7000-8000-000000000004';
  const consentId = '01939a00-0000-7000-8000-000000000005';

  const studentCtx = issueTrustedContext({
    tenantId: orgId,
    userId: studentUserId,
    actorKind: 'STUDENT',
  });

  const staffCtx = issueTrustedContext({
    tenantId: orgId,
    userId: staffUserId,
    actorKind: 'STAFF',
  });

  const service = new ConsentService();

  it('records consent for self: computes sha256 hash, audits tier 2, writes to outbox', async () => {
    const authAssertSpy = vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
    const recordAuditSpy = vi.spyOn(auditModule, 'recordAudit').mockResolvedValue('audit-id-1');
    const recordOutboxSpy = vi
      .spyOn(outboxModule, 'recordOutboxEvent')
      .mockResolvedValue('outbox-id-1');

    const policyText = 'Terms of service and data processing agreement 2026.';
    const expectedHash = createHash('sha256').update(policyText, 'utf8').digest('hex');

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM app.users')) {
        return Promise.resolve({ rows: [{ id: studentUserId }] });
      }
      if (sql.includes('INSERT INTO app.consents')) {
        return Promise.resolve({
          rows: [
            {
              id: consentId,
              organization_id: orgId,
              user_id: studentUserId,
              consent_type: 'DATA_PROCESSING',
              policy_version: 'v1.0',
              status: 'GRANTED',
              granted_at: new Date('2026-10-21T00:00:00Z'),
              withdrawn_at: null,
              method: 'WEB_FORM',
              ip: '127.0.0.1',
              user_agent: 'Mozilla/5.0',
              granted_by_user_id: studentUserId,
              guardian_id: null,
              policy_text_hash: expectedHash,
              version: 1,
              created_at: new Date('2026-10-21T00:00:00Z'),
              updated_at: new Date('2026-10-21T00:00:00Z'),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const result = await service.recordConsent(
      mockTx,
      studentCtx,
      studentUserId,
      {
        consentType: 'DATA_PROCESSING',
        policyVersion: 'v1.0',
        policyText,
      },
      { ip: '127.0.0.1', userAgent: 'Mozilla/5.0' },
    );

    expect(result.id).toBe(consentId);
    expect(result.status).toBe('GRANTED');
    expect(result.policyTextHash).toBe(expectedHash);
    expect(authAssertSpy).toHaveBeenCalledWith(mockTx, studentCtx, 'consent.record', {
      organization_id: orgId,
      user_id: studentUserId,
    });
    expect(recordAuditSpy).toHaveBeenCalledWith(
      mockTx,
      studentCtx,
      expect.objectContaining({
        action: 'consent.record',
        riskTier: 2,
      }),
      expect.anything(),
    );
    expect(recordOutboxSpy).toHaveBeenCalledWith(
      mockTx,
      studentCtx,
      expect.objectContaining({
        eventType: 'consent.recorded',
        aggregateType: 'consent',
      }),
    );
  });

  it('rejects recording consent on behalf with guardian when guardian cannot give consent', async () => {
    vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM app.users')) {
        return Promise.resolve({ rows: [{ id: studentUserId }] });
      }
      if (sql.includes('SELECT sg.can_give_consent')) {
        return Promise.resolve({
          rows: [
            {
              can_give_consent: false,
              valid_from: '2026-01-01',
              valid_to: null,
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    await expect(
      service.recordConsent(mockTx, staffCtx, studentUserId, {
        consentType: 'MEDIA_RECORDING',
        policyVersion: 'v1.0',
        policyText: 'Media consent policy',
        guardianId,
      }),
    ).rejects.toThrow(
      new AppError(
        403,
        'GUARDIAN_CONSENT_UNAUTHORIZED',
        'Guardian is not authorized to grant consent on behalf of student.',
      ),
    );
  });

  it('withdraws active consent: transitions GRANTED to WITHDRAWN and increments version', async () => {
    vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);
    const recordAuditSpy = vi.spyOn(auditModule, 'recordAudit').mockResolvedValue('audit-id-2');
    const recordOutboxSpy = vi
      .spyOn(outboxModule, 'recordOutboxEvent')
      .mockResolvedValue('outbox-id-2');

    const mockQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM app.consents WHERE')) {
        return Promise.resolve({
          rows: [
            {
              id: consentId,
              organization_id: orgId,
              user_id: studentUserId,
              consent_type: 'DATA_PROCESSING',
              policy_version: 'v1.0',
              status: 'GRANTED',
              granted_at: new Date('2026-10-21T00:00:00Z'),
              withdrawn_at: null,
              method: 'WEB_FORM',
              ip: null,
              user_agent: null,
              granted_by_user_id: studentUserId,
              guardian_id: null,
              policy_text_hash: 'f'.repeat(64),
              version: 1,
              created_at: new Date('2026-10-21T00:00:00Z'),
              updated_at: new Date('2026-10-21T00:00:00Z'),
            },
          ],
        });
      }
      if (sql.includes('UPDATE app.consents')) {
        return Promise.resolve({
          rows: [
            {
              id: consentId,
              organization_id: orgId,
              user_id: studentUserId,
              consent_type: 'DATA_PROCESSING',
              policy_version: 'v1.0',
              status: 'WITHDRAWN',
              granted_at: new Date('2026-10-21T00:00:00Z'),
              withdrawn_at: new Date('2026-10-21T01:00:00Z'),
              method: 'WEB_FORM',
              ip: null,
              user_agent: null,
              granted_by_user_id: studentUserId,
              guardian_id: null,
              policy_text_hash: 'f'.repeat(64),
              version: 2,
              created_at: new Date('2026-10-21T00:00:00Z'),
              updated_at: new Date('2026-10-21T01:00:00Z'),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    const withdrawn = await service.withdrawConsent(mockTx, studentCtx, consentId);
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect(withdrawn.version).toBe(2);
    expect(withdrawn.withdrawnAt).not.toBeNull();
    expect(recordAuditSpy).toHaveBeenCalledWith(
      mockTx,
      studentCtx,
      expect.objectContaining({ action: 'consent.withdraw', riskTier: 2 }),
      undefined,
    );
    expect(recordOutboxSpy).toHaveBeenCalledWith(
      mockTx,
      studentCtx,
      expect.objectContaining({ eventType: 'consent.withdrawn' }),
    );
  });

  it('withdrawConsent throws 409 when consent is already withdrawn', async () => {
    vi.spyOn(AuthorizationEngine, 'assert').mockResolvedValue(undefined);

    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: consentId,
          organization_id: orgId,
          user_id: studentUserId,
          consent_type: 'DATA_PROCESSING',
          policy_version: 'v1.0',
          status: 'WITHDRAWN',
          granted_at: new Date('2026-10-21T00:00:00Z'),
          withdrawn_at: new Date('2026-10-21T01:00:00Z'),
          version: 2,
        },
      ],
    });

    const mockTx = { query: mockQuery } as unknown as TenantTx;

    await expect(service.withdrawConsent(mockTx, studentCtx, consentId)).rejects.toThrow(
      new AppError(409, 'CONSENT_ALREADY_WITHDRAWN', 'Consent has already been withdrawn.'),
    );
  });
});
