import { uuidv7 } from '../ids/uuidv7.js';
import type { TenantTx } from '../database/tenant-tx.js';
import { isTrustedContext, type TrustedContext } from '../tenancy/trusted-context.js';
import { AppError } from '../errors/http-errors.js';

export interface OutboxEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupKey?: string;
}

export interface OutboxEventRow {
  id: string;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
  available_at: string;
  processed_at: string | null;
  attempts: number;
  last_error: string | null;
  dedup_key: string | null;
  created_at: string;
}

/**
 * Persists a domain event to app.outbox_events within the active tenant transaction (doc 03 §13.1).
 * Transactional guarantee: the event is committed if and only if the business transaction commits.
 */
export async function recordOutboxEvent(
  tx: TenantTx,
  ctx: TrustedContext,
  input: OutboxEventInput,
): Promise<string> {
  if (!isTrustedContext(ctx)) {
    throw new AppError(500, 'UNTRUSTED_CONTEXT', 'Database access requires a trusted context.');
  }

  const id = uuidv7();
  await tx.query(
    `INSERT INTO app.outbox_events (
       id, organization_id, event_type, aggregate_type, aggregate_id, payload, dedup_key
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      id,
      ctx.tenantId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.dedupKey ?? null,
    ],
  );

  return id;
}
