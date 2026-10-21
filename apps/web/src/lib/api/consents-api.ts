import { z } from 'zod';
import type { ApiClient } from './client';

export const ConsentItemSchema = z.object({
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
});

export type ConsentItem = z.infer<typeof ConsentItemSchema>;

export const ListConsentsResponseSchema = z.object({
  data: z.array(ConsentItemSchema),
  pagination: z.object({
    limit: z.number(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().optional(),
  }),
});

export type ListConsentsResponse = z.infer<typeof ListConsentsResponseSchema>;

export const ConsentResponseSchema = z.object({
  success: z.boolean(),
  data: ConsentItemSchema,
});

export function fetchMyConsents(client: ApiClient): Promise<ListConsentsResponse> {
  return client.get('/me/consents', {
    schema: ListConsentsResponseSchema,
  });
}

export function withdrawConsent(
  client: ApiClient,
  consentId: string,
): Promise<z.infer<typeof ConsentResponseSchema>> {
  return client.post(`/me/consents/${encodeURIComponent(consentId)}/withdraw`, {
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
  return client.post('/me/consents', {
    schema: ConsentResponseSchema,
    body,
  });
}
