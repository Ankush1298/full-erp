import { uuidv7 } from '../ids/uuidv7.js';
import { findAuditMetadataProblem } from './sensitive-keys.js';

export interface OperationalAuditEvent {
  organizationId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  riskTier: 1 | 2 | 3;
  reasonText?: string;
  metadata?: Record<string, unknown>;
}

export interface OperationalAuditDb {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

const ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE_TYPE_RE = /^[a-z][a-z0-9_]{0,59}$/;
const MAX_JSON_BYTES = 16_384;

/**
 * Records an operational audit event on behalf of SYSTEM / platform tooling.
 * Appends to app.audit_events in the caller's transaction with actor_type = 'SYSTEM'.
 */
export async function recordOperationalAudit(
  db: OperationalAuditDb,
  event: OperationalAuditEvent,
): Promise<string> {
  if (!ACTION_RE.test(event.action) || event.action.length > 100) {
    throw new Error('Audit event rejected: action format.');
  }
  if (!RESOURCE_TYPE_RE.test(event.resourceType)) {
    throw new Error('Audit event rejected: resourceType format.');
  }
  if (![1, 2, 3].includes(event.riskTier)) {
    throw new Error('Audit event rejected: riskTier.');
  }

  let metadataJson: string | null = null;
  if (event.metadata !== undefined) {
    const problem = findAuditMetadataProblem(event.metadata);
    if (problem) throw new Error(`Audit event rejected: metadata: ${problem}`);
    metadataJson = JSON.stringify(event.metadata);
    if (Buffer.byteLength(metadataJson) > MAX_JSON_BYTES) {
      throw new Error('Audit event rejected: metadata is too large.');
    }
  }

  let reasonText: string | null = null;
  if (event.reasonText !== undefined) {
    reasonText = event.reasonText.trim();
    if (reasonText.length < 1 || reasonText.length > 500) {
      throw new Error('Audit event rejected: reasonText length.');
    }
  }

  const id = uuidv7();
  await db.query(
    `INSERT INTO app.audit_events
       (id, organization_id, actor_type, actor_user_id, action, resource_type, resource_id, risk_tier, reason_text, metadata)
     VALUES ($1, $2, 'SYSTEM', NULL, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      event.organizationId,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      event.riskTier,
      reasonText,
      metadataJson,
    ],
  );
  return id;
}
