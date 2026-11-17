import { z } from 'zod';

export const InstitutionTitleEnum = z.enum([
  'SCHOOL_OWNER',
  'SCHOOL_PRINCIPAL',
  'COLLEGE_PRINCIPAL',
  'COLLEGE_DEAN',
  'UNIVERSITY_CHANCELLOR',
  'UNIVERSITY_VICE_CHANCELLOR',
  'UNIVERSITY_REGISTRAR',
  'DESIGNATED_SECURITY_AUTHORITY',
]);

export const InstitutionTypeEnum = z.enum(['SCHOOL', 'COLLEGE', 'UNIVERSITY']);

export const DeviceTypeEnum = z.enum(['SECURITY_KEY', 'PLATFORM_AUTHENTICATOR', 'SMART_CARD']);

export const CapabilityKeyNameEnum = z.enum([
  'CWK_STUDENTS_PII',
  'CWK_ACADEMICS_MARKS',
  'CWK_HOMEWORK_SUBMISSIONS',
  'CWK_FINANCE_PRIVATE',
  'CWK_DOCUMENTS_VAULT',
]);

export const ScopeTypeEnum = z.enum([
  'ORGANIZATION',
  'CAMPUS',
  'DEPARTMENT',
  'COURSE_OFFERING',
  'SECTION',
  'SELF',
]);

export const EntityTypeEnum = z.enum([
  'STUDENT_RECORD',
  'EXAM_MARK',
  'HOMEWORK_SUBMISSION',
  'FEE_LEDGER',
  'STUDENT_DOCUMENT',
]);

export const ConsentScopeEnum = z.enum(['ALL', 'ACADEMICS_ONLY', 'FINANCE_ONLY']);

export const AppointAuthoritySchema = z.object({
  title: InstitutionTitleEnum,
  userId: z.string().uuid(),
  institutionType: InstitutionTypeEnum.default('SCHOOL'),
  notes: z.string().max(1000).optional(),
});
export type AppointAuthorityInput = z.infer<typeof AppointAuthoritySchema>;

export const DelegateAuthoritySchema = z.object({
  delegatedToUserId: z.string().uuid(),
  notes: z.string().max(1000).optional(),
});
export type DelegateAuthorityInput = z.infer<typeof DelegateAuthoritySchema>;

export const RevokeAuthoritySchema = z.object({
  notes: z.string().max(1000).optional(),
});
export type RevokeAuthorityInput = z.infer<typeof RevokeAuthoritySchema>;

export const EnrollDeviceSchema = z.object({
  deviceLabel: z.string().min(2).max(120),
  deviceType: DeviceTypeEnum.default('PLATFORM_AUTHENTICATOR'),
  publicKey: z.string().min(10).max(2000), // SPKI Base64 or PEM
  attestationFormat: z.string().max(64).optional(),
  attestationBlob: z.string().optional(),
  aaguid: z.string().max(64).optional(),
});
export type EnrollDeviceInput = z.infer<typeof EnrollDeviceSchema>;

export const VerifyDeviceSchema = z.object({
  challenge: z.string().min(8),
  signature: z.string().min(8),
});
export type VerifyDeviceInput = z.infer<typeof VerifyDeviceSchema>;

export const RevokeDeviceSchema = z.object({
  reason: z.string().max(255).optional(),
});
export type RevokeDeviceInput = z.infer<typeof RevokeDeviceSchema>;

export const RotateEpochSchema = z.object({
  smekPublicKey: z.string().min(10),
  reason: z.string().max(500).optional(),
});
export type RotateEpochInput = z.infer<typeof RotateEpochSchema>;

export const SetupCustodiansSchema = z.object({
  vaultEpochId: z.string().uuid(),
  custodians: z
    .array(
      z.object({
        custodianName: z.string().min(2).max(120),
        custodianRole: z.string().min(2).max(120),
        shareIndex: z.number().int().min(1).max(3),
      }),
    )
    .length(3), // Exactly 3 custodians for 2-of-3 Shamir's scheme
});
export type SetupCustodiansInput = z.infer<typeof SetupCustodiansSchema>;

export const InitiateRecoverySchema = z.object({
  vaultEpochId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});
export type InitiateRecoveryInput = z.infer<typeof InitiateRecoverySchema>;

export const PresentRecoveryShareSchema = z.object({
  ceremonyId: z.string().uuid(),
  shareIndex: z.number().int().min(1).max(3),
  shareData: z.string().min(10), // Base64 share
});
export type PresentRecoveryShareInput = z.infer<typeof PresentRecoveryShareSchema>;

export const IssueKeyGrantSchema = z.object({
  vaultEpochId: z.string().uuid(),
  deviceId: z.string().uuid(),
  userId: z.string().uuid(),
  capabilityKeyName: CapabilityKeyNameEnum,
  scopeType: ScopeTypeEnum,
  scopeTargetId: z.string().uuid().optional(),
  wrappedCapabilityKey: z.string().min(1),
  ephemeralPublicKey: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  expiresAt: z.string().datetime().optional(),
});
export type IssueKeyGrantInput = z.infer<typeof IssueKeyGrantSchema>;

export const StoreProtectedRecordSchema = z.object({
  vaultEpochId: z.string().uuid(),
  entityType: EntityTypeEnum,
  entityId: z.string().uuid(),
  capabilityKeyName: CapabilityKeyNameEnum,
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  aadContext: z.record(z.string(), z.any()),
});
export type StoreProtectedRecordInput = z.infer<typeof StoreProtectedRecordSchema>;

export const GrantAdultConsentSchema = z.object({
  guardianId: z.string().uuid(),
  consentScope: ConsentScopeEnum.default('ALL'),
  expiresAt: z.string().datetime().optional(),
});
export type GrantAdultConsentInput = z.infer<typeof GrantAdultConsentSchema>;
