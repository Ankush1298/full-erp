import { Type, type Static } from '@sinclair/typebox';
import { ALLOWED_CONTENT_TYPES, STORAGE_CLASSES } from '../../shared/storage/index.js';

// Self-contained primitives (the module does not reach into other modules' schemas).
export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
export const SHA256_PATTERN = '^[0-9a-f]{64}$';
/** entity link purpose and classification vocabularies (doc 02 §4.11, 03 §12.5). */
export const PURPOSE_PATTERN = '^[a-z][a-z0-9_]{0,39}$';

const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });
const ReasonSchema = Type.String({ minLength: 5, maxLength: 500 });

export const CLASSIFICATIONS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export const VISIBILITIES = ['OWNER_VISIBLE', 'STAFF_ONLY'] as const;

const StorageClassSchema = Type.Union(STORAGE_CLASSES.map((c) => Type.Literal(c)));
const ClassificationSchema = Type.Union(CLASSIFICATIONS.map((c) => Type.Literal(c)));
const VisibilitySchema = Type.Union(VISIBILITIES.map((v) => Type.Literal(v)));
const ContentTypeSchema = Type.Union(ALLOWED_CONTENT_TYPES.map((t) => Type.Literal(t)));

export const UploadIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type UploadIdParam = Static<typeof UploadIdParamSchema>;

export const DocumentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type DocumentIdParam = Static<typeof DocumentIdParamSchema>;

export const StudentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type StudentIdParam = Static<typeof StudentIdParamSchema>;

/**
 * The intended link (doc 03 §12.3 step 1): the entity the upload is FOR, so the server can authorize the upload and
 * apply the per-purpose policy. Only `student` targets exist in this slice. No tenant field is accepted.
 */
const IntendedLinkSchema = Type.Object(
  {
    entityType: Type.Literal('student'),
    entityId: UuidV7Schema,
    purpose: Type.String({ pattern: PURPOSE_PATTERN }),
  },
  { additionalProperties: false },
);

export const InitiateUploadBodySchema = Type.Object(
  {
    storageClass: StorageClassSchema,
    originalName: Type.String({ minLength: 1, maxLength: 255 }),
    contentType: ContentTypeSchema,
    sizeBytes: Type.Integer({ minimum: 1, maximum: 104857600 }),
    sha256: Type.String({ pattern: SHA256_PATTERN }),
    classification: Type.Optional(ClassificationSchema),
    link: IntendedLinkSchema,
    reason: Type.Optional(ReasonSchema),
  },
  { additionalProperties: false },
);
export type InitiateUploadBody = Static<typeof InitiateUploadBodySchema>;

export const InitiateUploadResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        fileId: UuidV7Schema,
        upload: Type.Object(
          {
            url: Type.String(),
            method: Type.Literal('PUT'),
            headers: Type.Record(Type.String(), Type.String()),
            expiresAt: Type.String(),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CompleteUploadResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      {
        id: UuidV7Schema,
        status: Type.String(),
        scanResult: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DownloadUrlResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object(
      { url: Type.String(), expiresAt: Type.String() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const LinkDocumentBodySchema = Type.Object(
  {
    fileId: UuidV7Schema,
    purpose: Type.String({ pattern: PURPOSE_PATTERN }),
    visibility: Type.Optional(VisibilitySchema),
    reason: ReasonSchema,
  },
  { additionalProperties: false },
);
export type LinkDocumentBody = Static<typeof LinkDocumentBodySchema>;

export const LinkDocumentResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Object({ id: UuidV7Schema }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
