import { z } from 'zod';
import type { ApiClient } from './client';

export const ConsentItemSchema = z.preprocess((val: unknown) => {
  if (typeof val === 'object' && val !== null) {
    const raw = val as Record<string, unknown>;
    return {
      id: raw.id,
      organization_id: raw.organization_id ?? raw.organizationId,
      user_id: raw.user_id ?? raw.userId,
      consent_type: raw.consent_type ?? raw.consentType,
      policy_version: raw.policy_version ?? raw.policyVersion,
      status: raw.status,
      granted_at: raw.granted_at ?? raw.grantedAt,
      withdrawn_at: raw.withdrawn_at !== undefined ? raw.withdrawn_at : (raw.withdrawnAt ?? null),
      method: raw.method,
      policy_text_hash: raw.policy_text_hash ?? raw.policyTextHash,
    };
  }
  return val;
}, z.object({
  id: z.string(),
  organization_id: z.string().optional(),
  user_id: z.string().optional(),
  consent_type: z.string(),
  policy_version: z.string(),
  status: z.enum(['GRANTED', 'WITHDRAWN']),
  granted_at: z.string(),
  withdrawn_at: z.string().nullable().optional(),
  method: z.string().optional(),
  policy_text_hash: z.string().optional(),
}));

export type ConsentItem = z.infer<typeof ConsentItemSchema>;

export const ListConsentsResponseSchema = z.preprocess((val: unknown) => {
  if (Array.isArray(val)) {
    return {
      data: val,
      pagination: {
        limit: val.length,
        has_more: false,
        next_cursor: null,
      },
    };
  }
  return val;
}, z.object({
  data: z.array(ConsentItemSchema),
  pagination: z
    .object({
      limit: z.number().optional().default(0),
      has_more: z.boolean().optional().default(false),
      next_cursor: z.string().nullable().optional(),
    })
    .optional()
    .default({ limit: 0, has_more: false, next_cursor: null }),
}));

export type ListConsentsResponse = z.infer<typeof ListConsentsResponseSchema>;

export const ConsentResponseSchema = z.preprocess((val: unknown) => {
  if (typeof val === 'object' && val !== null && !('data' in val)) {
    return { success: true, data: val };
  }
  return val;
}, z.object({
  success: z.boolean().optional().default(true),
  data: ConsentItemSchema,
}));

export function fetchMyConsents(client: ApiClient): Promise<ListConsentsResponse> {
  return client.get('/v1/me/consents', {
    schema: ListConsentsResponseSchema,
  });
}

export function withdrawConsent(
  client: ApiClient,
  consentId: string,
): Promise<z.infer<typeof ConsentResponseSchema>> {
  return client.post(`/v1/me/consents/${encodeURIComponent(consentId)}/withdraw`, {
    schema: ConsentResponseSchema,
  });
}

export function recordConsent(
  client: ApiClient,
  body: {
    consent_type: string;
    policy_version: string;
    policy_text_hash: string;
    guardian_id?: string;
  },
): Promise<z.infer<typeof ConsentResponseSchema>> {
  return client.post('/v1/me/consents', {
    schema: ConsentResponseSchema,
    body,
  });
}
