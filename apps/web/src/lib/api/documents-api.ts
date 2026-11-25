import { z } from 'zod';
import type { ApiClient } from './client';

export const DocumentItemSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      return {
        id: raw.id,
        file_name: raw.file_name ?? raw.fileName ?? raw.original_name ?? raw.originalName,
        original_name: raw.original_name ?? raw.originalName ?? raw.file_name ?? raw.fileName,
        file_size_bytes:
          raw.file_size_bytes !== undefined
            ? raw.file_size_bytes
            : (raw.fileSizeBytes ?? raw.size_bytes ?? raw.sizeBytes ?? null),
        size_bytes:
          raw.size_bytes !== undefined
            ? raw.size_bytes
            : (raw.sizeBytes ?? raw.file_size_bytes ?? raw.fileSizeBytes ?? null),
        mime_type:
          raw.mime_type !== undefined
            ? raw.mime_type
            : (raw.mimeType ?? raw.content_type ?? raw.contentType ?? null),
        storage_class: raw.storage_class ?? raw.storageClass ?? 'GENERAL',
        classification: raw.classification ?? 'INTERNAL',
        scan_status: raw.scan_status ?? raw.scanStatus ?? raw.scan_result ?? raw.scanResult ?? null,
        sha256: raw.sha256 ?? null,
        status: raw.status ?? 'AVAILABLE',
        created_at: raw.created_at ?? raw.createdAt ?? new Date().toISOString(),
        entity_type: raw.entity_type ?? raw.entityType ?? null,
        entity_id: raw.entity_id ?? raw.entityId ?? null,
        purpose: raw.purpose ?? null,
        visibility: raw.visibility ?? null,
        uploaded_by: raw.uploaded_by ?? raw.uploadedBy ?? null,
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
    scan_status: z.string().nullable().optional(),
    sha256: z.string().nullable().optional(),
    status: z.string().optional(),
    created_at: z.string(),
    entity_type: z.string().nullable().optional(),
    entity_id: z.string().nullable().optional(),
    purpose: z.string().nullable().optional(),
    visibility: z.string().nullable().optional(),
    uploaded_by: z.string().nullable().optional(),
  }),
);

export type DocumentItem = z.infer<typeof DocumentItemSchema>;

export const ListDocumentsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(DocumentItemSchema),
  }),
);

export const DocumentRequirementSchema = z.object({
  code: z.string(),
  title: z.string(),
  description: z.string(),
  workflow: z.enum(['ADMISSION', 'EMPLOYMENT', 'FINANCE', 'ACADEMIC', 'COMPLIANCE']),
  targetRole: z.enum(['STUDENT', 'FACULTY', 'STAFF', 'PARENT', 'INSTITUTION']),
  isMandatory: z.boolean(),
  allowedMimeTypes: z.array(z.string()),
  maxSizeBytes: z.number(),
  classification: z.enum(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
  storageClass: z.enum(['GENERAL', 'SENSITIVE', 'GENERATED']),
  defaultPurpose: z.string(),
});
export type DocumentRequirement = z.infer<typeof DocumentRequirementSchema>;

export const ListDocumentRequirementsResponseSchema = z.preprocess(
  (val: unknown) => {
    if (Array.isArray(val)) return { success: true, data: val };
    return val;
  },
  z.object({
    success: z.boolean().optional().default(true),
    data: z.array(DocumentRequirementSchema),
  }),
);

export const InitiateUploadResponseSchema = z.preprocess(
  (val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      const raw = val as Record<string, unknown>;
      const data = raw.data as Record<string, unknown> | undefined;
      if (data) {
        const upload = data.upload as Record<string, unknown> | undefined;
        return {
          success: raw.success ?? true,
          data: {
            fileId: data.fileId ?? data.file_id ?? data.upload_id ?? '',
            upload: {
              url: upload?.url ?? data.upload_url ?? '',
              method: (upload?.method as string) ?? 'PUT',
              headers:
                (upload?.headers as Record<string, string>) ??
                (data.headers as Record<string, string>) ??
                {},
              expiresAt: (upload?.expiresAt as string) ?? (data.expires_at as string) ?? '',
            },
          },
        };
      }
    }
    return val;
  },
  z.object({
    success: z.boolean(),
    data: z.object({
      fileId: z.string(),
      upload: z.object({
        url: z.string(),
        method: z.string().default('PUT'),
        headers: z.record(z.string(), z.string()).default({}),
        expiresAt: z.string(),
      }),
    }),
  }),
);

export const DownloadUrlResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    url: z.string(),
    expiresAt: z.string(),
  }),
});

export interface FetchDocumentsOptions {
  view?: 'my' | 'institutional';
  entityType?: 'student' | 'employee' | 'institution';
  entityId?: string;
  workflow?: string;
  purpose?: string;
}

export async function fetchDocuments(
  client: ApiClient,
  options?: FetchDocumentsOptions,
): Promise<DocumentItem[]> {
  const queryParams = new URLSearchParams();
  if (options?.view) queryParams.set('view', options.view);
  if (options?.entityType) queryParams.set('entityType', options.entityType);
  if (options?.entityId) queryParams.set('entityId', options.entityId);
  if (options?.workflow) queryParams.set('workflow', options.workflow);
  if (options?.purpose) queryParams.set('purpose', options.purpose);

  const queryStr = queryParams.toString();
  const url = queryStr ? `/v1/documents?${queryStr}` : '/v1/documents';

  const res = await client.get(url, {
    schema: ListDocumentsResponseSchema,
  });
  return res.data;
}

export async function fetchDocumentRequirements(client: ApiClient): Promise<DocumentRequirement[]> {
  const res = await client.get('/v1/documents/requirements', {
    schema: ListDocumentRequirementsResponseSchema,
  });
  return res.data;
}

export async function fetchStudentDocuments(
  client: ApiClient,
  studentId: string,
): Promise<DocumentItem[]> {
  const res = await client.get(`/v1/students/${encodeURIComponent(studentId)}/documents`, {
    schema: ListDocumentsResponseSchema,
  });
  return res.data;
}

export async function fetchDocumentDownloadUrl(
  client: ApiClient,
  fileId: string,
): Promise<{ url: string; expiresAt: string }> {
  const res = await client.get(`/v1/documents/${encodeURIComponent(fileId)}/download-url`, {
    schema: DownloadUrlResponseSchema,
  });
  return res.data;
}

export interface InitiateUploadPayload {
  storageClass: 'GENERAL' | 'SENSITIVE' | 'GENERATED';
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  classification?: 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';
  link: {
    entityType: 'student' | 'employee' | 'institution';
    entityId: string;
    purpose: string;
  };
  reason?: string;
}

export async function initiateUpload(
  client: ApiClient,
  body: InitiateUploadPayload,
  idempotencyKey?: string,
) {
  const key = idempotencyKey ?? crypto.randomUUID();
  return client.post('/v1/documents/uploads', {
    schema: InitiateUploadResponseSchema,
    body,
    headers: { 'idempotency-key': key },
  });
}

export async function completeUpload(
  client: ApiClient,
  uploadId: string,
): Promise<{ id: string; status: string; scanResult: string | null }> {
  const res = await client.post(`/v1/documents/uploads/${encodeURIComponent(uploadId)}/complete`, {
    schema: z.object({
      success: z.boolean(),
      data: z.object({
        id: z.string(),
        status: z.string(),
        scanResult: z.string().nullable(),
      }),
    }),
  });
  return res.data;
}

export async function linkDocument(
  client: ApiClient,
  body: {
    fileId: string;
    entityType: 'student' | 'employee' | 'institution';
    entityId: string;
    purpose: string;
    visibility?: 'OWNER_VISIBLE' | 'STAFF_ONLY';
    reason: string;
  },
) {
  return client.post('/v1/documents/links', {
    schema: z.object({
      success: z.boolean(),
      data: z.object({ id: z.string() }),
    }),
    body,
  });
}
