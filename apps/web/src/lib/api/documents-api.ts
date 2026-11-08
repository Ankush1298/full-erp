import { z } from 'zod';
import type { ApiClient } from './client';

export const DocumentItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        file_name: raw.file_name ?? raw.fileName,
        original_name: raw.original_name ?? raw.originalName,
        file_size_bytes:
          raw.file_size_bytes !== undefined
            ? raw.file_size_bytes
            : (raw.fileSizeBytes ?? raw.size_bytes ?? raw.sizeBytes ?? null),
        size_bytes:
          raw.size_bytes !== undefined
            ? raw.size_bytes
            : (raw.sizeBytes ?? raw.file_size_bytes ?? raw.fileSizeBytes ?? null),
        mime_type: raw.mime_type !== undefined ? raw.mime_type : (raw.mimeType ?? null),
        storage_class: raw.storage_class ?? raw.storageClass,
        classification: raw.classification,
        scan_status: raw.scan_status ?? raw.scanStatus,
        status: raw.status,
        created_at: raw.created_at ?? raw.createdAt,
      };
    }
    return val;
  },
  z.object({
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
  }),
);

export type DocumentItem = z.infer<typeof DocumentItemSchema>;

export const ListStudentDocumentsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(DocumentItemSchema),
  }),
);

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
    .get(`/v1/students/${encodeURIComponent(studentId)}/documents`, {
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
  return client.post('/v1/documents/uploads', {
    schema: InitiateUploadResponseSchema,
    body,
    ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
  });
}
