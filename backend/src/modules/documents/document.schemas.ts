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
export const ENTITY_TYPES = ['student', 'employee', 'institution'] as const;

export const StorageClassSchema = Type.Union(STORAGE_CLASSES.map((c) => Type.Literal(c)));
export const ClassificationSchema = Type.Union(CLASSIFICATIONS.map((c) => Type.Literal(c)));
export const VisibilitySchema = Type.Union(VISIBILITIES.map((v) => Type.Literal(v)));
export const ContentTypeSchema = Type.Union(ALLOWED_CONTENT_TYPES.map((t) => Type.Literal(t)));
export const EntityTypeSchema = Type.Union(ENTITY_TYPES.map((t) => Type.Literal(t)));

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
 * apply the per-purpose policy. Supports student, employee, and institution entities. No tenant field is accepted.
 */
export const IntendedLinkSchema = Type.Object(
  {
    entityType: EntityTypeSchema,
    entityId: UuidV7Schema,
    purpose: Type.String({ pattern: PURPOSE_PATTERN }),
  },
  { additionalProperties: false },
);
export type IntendedLink = Static<typeof IntendedLinkSchema>;

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
    entityType: Type.Optional(EntityTypeSchema),
    entityId: Type.Optional(UuidV7Schema),
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

export const DocumentListItemSchema = Type.Object(
  {
    id: UuidV7Schema,
    originalName: Type.String(),
    storageClass: StorageClassSchema,
    classification: ClassificationSchema,
    contentType: Type.Union([Type.String(), Type.Null()]),
    sizeBytes: Type.Union([Type.Integer(), Type.Null()]),
    status: Type.String(),
    scanResult: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    uploadedBy: UuidV7Schema,
    entityType: Type.Union([Type.String(), Type.Null()]),
    entityId: Type.Union([UuidV7Schema, Type.Null()]),
    purpose: Type.Union([Type.String(), Type.Null()]),
    visibility: Type.Union([VisibilitySchema, Type.Null()]),
  },
  { additionalProperties: false },
);
export type DocumentListItem = Static<typeof DocumentListItemSchema>;

export const ListDocumentsQuerySchema = Type.Object(
  {
    view: Type.Optional(Type.Union([Type.Literal('my'), Type.Literal('institutional')])),
    entityType: Type.Optional(EntityTypeSchema),
    entityId: Type.Optional(UuidV7Schema),
    workflow: Type.Optional(
      Type.Union([
        Type.Literal('ADMISSION'),
        Type.Literal('EMPLOYMENT'),
        Type.Literal('FINANCE'),
        Type.Literal('ACADEMIC'),
        Type.Literal('COMPLIANCE'),
      ]),
    ),
    purpose: Type.Optional(Type.String({ pattern: PURPOSE_PATTERN })),
  },
  { additionalProperties: false },
);
export type ListDocumentsQuery = Static<typeof ListDocumentsQuerySchema>;

export const ListDocumentsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(DocumentListItemSchema),
  },
  { additionalProperties: false },
);

export const DocumentRequirementSchema = Type.Object(
  {
    code: Type.String(),
    title: Type.String(),
    description: Type.String(),
    workflow: Type.Union([
      Type.Literal('ADMISSION'),
      Type.Literal('EMPLOYMENT'),
      Type.Literal('FINANCE'),
      Type.Literal('ACADEMIC'),
      Type.Literal('COMPLIANCE'),
    ]),
    targetRole: Type.Union([
      Type.Literal('STUDENT'),
      Type.Literal('FACULTY'),
      Type.Literal('STAFF'),
      Type.Literal('PARENT'),
      Type.Literal('INSTITUTION'),
    ]),
    isMandatory: Type.Boolean(),
    allowedMimeTypes: Type.Array(Type.String()),
    maxSizeBytes: Type.Integer(),
    classification: ClassificationSchema,
    storageClass: StorageClassSchema,
    defaultPurpose: Type.String(),
  },
  { additionalProperties: false },
);
export type DocumentRequirement = Static<typeof DocumentRequirementSchema>;

export const ListDocumentRequirementsResponseSchema = Type.Object(
  {
    success: Type.Literal(true),
    data: Type.Array(DocumentRequirementSchema),
  },
  { additionalProperties: false },
);
