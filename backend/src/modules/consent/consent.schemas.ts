import { Type, type Static } from '@sinclair/typebox';

export const UUID_V7_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
export const SHA256_PATTERN = '^[0-9a-f]{64}$';

export const UuidV7Schema = Type.String({ pattern: UUID_V7_PATTERN });

export const CONSENT_TYPES = [
  'DATA_PROCESSING',
  'MEDIA_RECORDING',
  'DIRECTORY_LISTING',
  'RESEARCH_PARTICIPATION',
  'HEALTH_DATA_SHARING',
  'EMERGENCY_CONTACT',
] as const;

export const CONSENT_METHODS = ['WEB_FORM', 'PAPER_FORM', 'IN_PERSON'] as const;
export const CONSENT_STATUSES = ['GRANTED', 'WITHDRAWN'] as const;

export const ConsentTypeSchema = Type.String({ minLength: 1, maxLength: 40 });
export const ConsentMethodSchema = Type.Union(CONSENT_METHODS.map((m) => Type.Literal(m)));
export const ConsentStatusSchema = Type.Union(CONSENT_STATUSES.map((s) => Type.Literal(s)));

export const RecordConsentBodySchema = Type.Object(
  {
    consentType: ConsentTypeSchema,
    policyVersion: Type.String({ minLength: 1, maxLength: 20 }),
    policyText: Type.String({ minLength: 1, maxLength: 65536 }),
    method: Type.Optional(ConsentMethodSchema),
    guardianId: Type.Optional(UuidV7Schema),
  },
  { additionalProperties: false },
);
export type RecordConsentBody = Static<typeof RecordConsentBodySchema>;

export const ConsentResponseSchema = Type.Object(
  {
    id: UuidV7Schema,
    organizationId: UuidV7Schema,
    userId: UuidV7Schema,
    consentType: Type.String(),
    policyVersion: Type.String(),
    status: ConsentStatusSchema,
    grantedAt: Type.String(),
    withdrawnAt: Type.Union([Type.String(), Type.Null()]),
    method: Type.String(),
    grantedByUserId: UuidV7Schema,
    guardianId: Type.Union([UuidV7Schema, Type.Null()]),
    policyTextHash: Type.String({ pattern: SHA256_PATTERN }),
    version: Type.Integer(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type ConsentResponse = Static<typeof ConsentResponseSchema>;

export const ListConsentsResponseSchema = Type.Array(ConsentResponseSchema);
export type ListConsentsResponse = Static<typeof ListConsentsResponseSchema>;

export const ListConsentsQuerySchema = Type.Object(
  {
    consentType: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    status: Type.Optional(ConsentStatusSchema),
  },
  { additionalProperties: false },
);
export type ListConsentsQuery = Static<typeof ListConsentsQuerySchema>;

export const ConsentIdParamSchema = Type.Object(
  { id: UuidV7Schema },
  { additionalProperties: false },
);
export type ConsentIdParam = Static<typeof ConsentIdParamSchema>;

export const UserIdParamSchema = Type.Object({ id: UuidV7Schema }, { additionalProperties: false });
export type UserIdParam = Static<typeof UserIdParamSchema>;
