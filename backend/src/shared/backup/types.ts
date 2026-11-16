export interface BackupMetadata {
  backupId: string;
  createdAt: string;
  sourceDatabase: string;
  sourceHost: string;
  sourcePort: number;
  serverVersion: string;
  schemaVersion: string;
  institutionCount: number;
  encryption: {
    algorithm: 'aes-256-gcm';
    ivHex: string;
    authTagHex: string;
    keyId: string;
  };
  integrity: {
    plaintextSha256: string;
    ciphertextSha256: string;
    sizeBytes: number;
    cipherSizeBytes: number;
  };
  retention: {
    retentionDays: number;
    expiresAt: string;
  };
  status: 'COMPLETED' | 'VERIFIED' | 'FAILED';
  verification?: {
    verifiedAt: string;
    pgRestoreCheck: boolean;
    integrityVerified: boolean;
  };
}
