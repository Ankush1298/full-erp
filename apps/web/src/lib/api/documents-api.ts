import { z } from 'zod';
import type { ApiClient } from './client';

export const DocumentItemSchema = z.object({
  id: z.string(),
  file_name: z.string().optional(),
  original_name: z.string().optional(),
  file_size_bytes: z.number().nullable().optional(),
  size_bytes: z.number().nullable().optional(),
  mime_type: z.string().nullable().optional(),
  storage_class: z.string().optional(),
  classification: z.string().optional(),
  scan_status: z.string().optional(),
  status: z.string().optional(),
  created_at: z.string(),
});

export type DocumentItem = z.infer<typeof DocumentItemSchema>;

export const ListStudentDocumentsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(DocumentItemSchema),
});

export const InitiateUploadResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    upload_id: z.string(),
    upload_url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    expires_at: z.string(),
  }),
});

export function fetchStudentDocuments(
  client: ApiClient,
  studentId: string,
): Promise<DocumentItem[]> {
  return client
    .get(`/students/${encodeURIComponent(studentId)}/documents`, {
      schema: ListStudentDocumentsResponseSchema,
    })
    .then((res) => res.data);
}

export function initiateUpload(
  client: ApiClient,
  body: {
    storage_class: 'GENERAL' | 'SENSITIVE' | 'GENERATED';
    original_name: string;
    declared_mime: string;
    classification: 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  },
  idempotencyKey?: string,
) {
  return client.post('/documents/uploads', {
    schema: InitiateUploadResponseSchema,
    body,
    ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
  });
}
