import { AppError } from '../../shared/errors/http-errors.js';
import { uuidv7 } from '../../shared/ids/uuidv7.js';
import { generateChallenge, verifyDeviceSignature } from '../../shared/crypto/vault-crypto.js';
import type { TenantTx } from '../../shared/database/index.js';
import type { TrustedContext } from '../../shared/tenancy/trusted-context.js';
import type {
  AppointAuthorityInput,
  DelegateAuthorityInput,
  EnrollDeviceInput,
  GrantAdultConsentInput,
  InitiateRecoveryInput,
  IssueKeyGrantInput,
  PresentRecoveryShareInput,
  RevokeAuthorityInput,
  RevokeDeviceInput,
  RotateEpochInput,
  SetupCustodiansInput,
  StoreProtectedRecordInput,
  VerifyDeviceInput,
} from './vault.schemas.js';

export class VaultService {
  // -----------------------------------------------------------------------------------------------
  // 1. Institutional Security Authority (ISA)
  // -----------------------------------------------------------------------------------------------

  static async getSecurityAuthority(tx: TenantTx, ctx: TrustedContext) {
    const res = await tx.query<{
      id: string;
      user_id: string;
      title: string;
      institution_type: string;
      status: string;
      appointed_by_user_id: string;
      appointed_at: Date;
      delegated_to_user_id: string | null;
      delegated_at: Date | null;
      notes: string | null;
      user_display_name: string;
      user_email: string;
    }>(
      `SELECT
         isa.id,
         isa.user_id,
         isa.title,
         isa.institution_type,
         isa.status,
         isa.appointed_by_user_id,
         isa.appointed_at,
         isa.delegated_to_user_id,
         isa.delegated_at,
         isa.notes,
         u.display_name AS user_display_name,
         u.email AS user_email
       FROM app.institution_security_authorities isa
       JOIN app.users u ON u.id = isa.user_id AND u.organization_id = isa.organization_id
      WHERE isa.organization_id = $1
        AND isa.status = 'ACTIVE'
      LIMIT 1`,
      [ctx.tenantId],
    );

    return res.rows[0] ?? null;
  }

  static async appointSecurityAuthority(
    tx: TenantTx,
    ctx: TrustedContext,
    input: AppointAuthorityInput,
  ) {
    // Revoke any existing active ISA
    await tx.query(
      `UPDATE app.institution_security_authorities
          SET status = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE organization_id = $1 AND status = 'ACTIVE'`,
      [ctx.tenantId],
    );

    // Insert new ISA
    const id = uuidv7();
    const res = await tx.query<{ id: string; appointed_at: Date }>(
      `INSERT INTO app.institution_security_authorities (
         id, organization_id, user_id, title, institution_type, status,
         appointed_by_user_id, notes
       ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)
       RETURNING id, appointed_at`,
      [
        id,
        ctx.tenantId,
        input.userId,
        input.title,
        input.institutionType,
        ctx.userId,
        input.notes ?? null,
      ],
    );

    return {
      id: res.rows[0]!.id,
      title: input.title,
      institutionType: input.institutionType,
      appointedAt: res.rows[0]!.appointed_at,
    };
  }

  static async delegateSecurityAuthority(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: DelegateAuthorityInput,
  ) {
    const res = await tx.query<{ id: string }>(
      `UPDATE app.institution_security_authorities
          SET status = 'DELEGATED',
              delegated_to_user_id = $3,
              delegated_at = clock_timestamp(),
              notes = COALESCE($4, notes),
              updated_at = clock_timestamp()
        WHERE organization_id = $1 AND id = $2 AND status = 'ACTIVE'
        RETURNING id`,
      [ctx.tenantId, id, input.delegatedToUserId, input.notes ?? null],
    );

    if (res.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Active Security Authority record not found.');
    }

    return { success: true };
  }

  static async revokeSecurityAuthority(
    tx: TenantTx,
    ctx: TrustedContext,
    id: string,
    input: RevokeAuthorityInput,
  ) {
    const res = await tx.query<{ id: string }>(
      `UPDATE app.institution_security_authorities
          SET status = 'REVOKED',
              revoked_at = clock_timestamp(),
              notes = COALESCE($3, notes),
              updated_at = clock_timestamp()
        WHERE organization_id = $1 AND id = $2
        RETURNING id`,
      [ctx.tenantId, id, input.notes ?? null],
    );

    if (res.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Security Authority record not found.');
    }

    return { success: true };
  }

  // -----------------------------------------------------------------------------------------------
  // 2. Hardware / Device-Bound Authenticators (Max 2 per account)
  // -----------------------------------------------------------------------------------------------

  static async listUserDevices(tx: TenantTx, ctx: TrustedContext, targetUserId?: string) {
    const userId = targetUserId ?? ctx.userId;
    const res = await tx.query<{
      id: string;
      device_number: number;
      device_label: string;
      device_type: string;
      status: string;
      public_key: string;
      aaguid: string | null;
      enrolled_at: Date;
      last_used_at: Date | null;
    }>(
      `SELECT
         id,
         device_number,
         device_label,
         device_type,
         status,
         public_key,
         aaguid,
         enrolled_at,
         last_used_at
       FROM app.user_vault_devices
      WHERE organization_id = $1
        AND user_id = $2
      ORDER BY device_number ASC, enrolled_at ASC`,
      [ctx.tenantId, userId],
    );

    const activeDevices = res.rows.filter((d) => d.status === 'ACTIVE');
    return {
      devices: res.rows.map((d) => ({
        id: d.id,
        deviceNumber: d.device_number,
        deviceLabel: d.device_label,
        deviceType: d.device_type,
        status: d.status,
        publicKey: d.public_key,
        aaguid: d.aaguid,
        enrolledAt: d.enrolled_at,
        lastUsedAt: d.last_used_at,
      })),
      activeCount: activeDevices.length,
      maxAllowed: 2,
      canEnrollSecond: activeDevices.length === 1,
      limitReached: activeDevices.length >= 2,
    };
  }

  static async enrollDevice(tx: TenantTx, ctx: TrustedContext, input: EnrollDeviceInput) {
    // 1. Verify existing active devices count
    const activeRes = await tx.query<{ id: string; device_number: number }>(
      `SELECT id, device_number
         FROM app.user_vault_devices
        WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId],
    );

    if (activeRes.rows.length >= 2) {
      throw new AppError(
        400,
        'DEVICE_LIMIT_EXCEEDED',
        'Maximum of 2 hardware authenticators per account reached. Revoke an existing device before enrolling a new one.',
      );
    }

    // Determine device number: if 1 is active, assign 2. Else assign 1.
    const hasDevice1 = activeRes.rows.some((d) => d.device_number === 1);
    const assignedNumber = hasDevice1 ? 2 : 1;

    const id = uuidv7();
    const res = await tx.query<{
      id: string;
      device_number: number;
      enrolled_at: Date;
    }>(
      `INSERT INTO app.user_vault_devices (
         id, organization_id, user_id, device_number, device_label, device_type,
         status, public_key, attestation_format, attestation_blob, aaguid
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8, $9, $10)
       RETURNING id, device_number, created_at AS enrolled_at`,
      [
        id,
        ctx.tenantId,
        ctx.userId,
        assignedNumber,
        input.deviceLabel,
        input.deviceType,
        input.publicKey,
        input.attestationFormat ?? null,
        input.attestationBlob ?? null,
        input.aaguid ?? null,
      ],
    );

    return {
      id: res.rows[0]!.id,
      deviceNumber: res.rows[0]!.device_number,
      deviceLabel: input.deviceLabel,
      deviceType: input.deviceType,
      status: 'ACTIVE',
      enrolledAt: res.rows[0]!.enrolled_at,
    };
  }

  static generateDeviceChallenge() {
    return {
      challenge: generateChallenge(),
      issuedAt: new Date().toISOString(),
      expiresInSeconds: 300,
    };
  }

  static async verifyDevice(
    tx: TenantTx,
    ctx: TrustedContext,
    deviceId: string,
    input: VerifyDeviceInput,
  ) {
    const devRes = await tx.query<{ id: string; public_key: string; device_type: string }>(
      `SELECT id, public_key, device_type
         FROM app.user_vault_devices
        WHERE organization_id = $1 AND user_id = $2 AND id = $3 AND status = 'ACTIVE'`,
      [ctx.tenantId, ctx.userId, deviceId],
    );

    if (devRes.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Active device not found for verification.');
    }

    const device = devRes.rows[0]!;

    // Cryptographic signature verification of the challenge
    const isValid = verifyDeviceSignature(device.public_key, input.challenge, input.signature);
    if (!isValid) {
      throw new AppError(
        401,
        'DEVICE_SIGNATURE_INVALID',
        'Cryptographic challenge signature verification failed for this hardware authenticator.',
      );
    }

    await tx.query(
      `UPDATE app.user_vault_devices
          SET last_used_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, deviceId],
    );

    return {
      verified: true,
      deviceId: device.id,
      deviceType: device.device_type,
      userPresenceVerified: true,
      userVerificationVerified: true,
    };
  }

  static async revokeDevice(
    tx: TenantTx,
    ctx: TrustedContext,
    deviceId: string,
    input: RevokeDeviceInput,
  ) {
    const res = await tx.query<{ id: string; device_number: number }>(
      `UPDATE app.user_vault_devices
          SET status = 'REVOKED',
              revoked_at = clock_timestamp(),
              revoked_reason = COALESCE($4, revoked_reason),
              updated_at = clock_timestamp()
        WHERE organization_id = $1 AND user_id = $2 AND id = $3 AND status = 'ACTIVE'
        RETURNING id, device_number`,
      [ctx.tenantId, ctx.userId, deviceId, input.reason ?? null],
    );

    if (res.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Active device not found for revocation.');
    }

    // Revoke any active key grants issued to this device
    await tx.query(
      `UPDATE app.vault_key_grants
          SET status = 'REVOKED', updated_at = clock_timestamp()
        WHERE organization_id = $1 AND device_id = $2 AND status = 'ACTIVE'`,
      [ctx.tenantId, deviceId],
    );

    return {
      revoked: true,
      deviceId: res.rows[0]!.id,
      deviceNumber: res.rows[0]!.device_number,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // 3. Vault Epoch Management
  // -----------------------------------------------------------------------------------------------

  static async getCurrentEpoch(tx: TenantTx, ctx: TrustedContext) {
    const res = await tx.query<{
      id: string;
      epoch: number;
      status: string;
      smek_public_key: string;
      created_at: Date;
    }>(
      `SELECT id, epoch, status, smek_public_key, created_at
         FROM app.institution_vault_epochs
        WHERE organization_id = $1 AND status = 'ACTIVE'
        ORDER BY epoch DESC
        LIMIT 1`,
      [ctx.tenantId],
    );

    if (res.rows.length === 0) {
      // Auto-initialize Epoch 1 if not exists
      const id = uuidv7();
      const initRes = await tx.query<{
        id: string;
        epoch: number;
        status: string;
        smek_public_key: string;
        created_at: Date;
      }>(
        `INSERT INTO app.institution_vault_epochs (
           id, organization_id, epoch, status, smek_public_key, created_by_user_id
         ) VALUES ($1, $2, 1, 'ACTIVE', 'INITIAL_SMEK_PUBKEY_PLACEHOLDER', $3)
         RETURNING id, epoch, status, smek_public_key, created_at`,
        [id, ctx.tenantId, ctx.userId],
      );
      return initRes.rows[0]!;
    }

    return res.rows[0]!;
  }

  static async rotateEpoch(tx: TenantTx, ctx: TrustedContext, input: RotateEpochInput) {
    const current = await this.getCurrentEpoch(tx, ctx);

    // Mark current epoch as ROTATED
    await tx.query(
      `UPDATE app.institution_vault_epochs
          SET status = 'ROTATED', rotated_at = clock_timestamp(), rotation_reason = $3
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, current.id, input.reason ?? 'Scheduled cryptographic rotation'],
    );

    // Create next epoch
    const nextEpochNum = current.epoch + 1;
    const id = uuidv7();
    const res = await tx.query<{
      id: string;
      epoch: number;
      status: string;
      smek_public_key: string;
      created_at: Date;
    }>(
      `INSERT INTO app.institution_vault_epochs (
         id, organization_id, epoch, status, smek_public_key, created_by_user_id
       ) VALUES ($1, $2, $3, 'ACTIVE', $4, $5)
       RETURNING id, epoch, status, smek_public_key, created_at`,
      [id, ctx.tenantId, nextEpochNum, input.smekPublicKey, ctx.userId],
    );

    return res.rows[0]!;
  }

  // -----------------------------------------------------------------------------------------------
  // 4. 2-of-3 Recovery Custodians & Ceremony
  // -----------------------------------------------------------------------------------------------

  static async listCustodians(tx: TenantTx, ctx: TrustedContext, epochId: string) {
    const res = await tx.query<{
      id: string;
      share_index: number;
      custodian_name: string;
      custodian_role: string;
      created_at: Date;
    }>(
      `SELECT id, share_index, custodian_name, custodian_role, created_at
         FROM app.institution_recovery_custodians
        WHERE organization_id = $1 AND vault_epoch_id = $2
        ORDER BY share_index ASC`,
      [ctx.tenantId, epochId],
    );
    return res.rows;
  }

  static async setupCustodians(tx: TenantTx, ctx: TrustedContext, input: SetupCustodiansInput) {
    for (const c of input.custodians) {
      await tx.query(
        `INSERT INTO app.institution_recovery_custodians (
           id, organization_id, vault_epoch_id, share_index, custodian_name, custodian_role, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
         ON CONFLICT (organization_id, vault_epoch_id, share_index)
         DO UPDATE SET
           custodian_name = EXCLUDED.custodian_name,
           custodian_role = EXCLUDED.custodian_role,
           status = 'ACTIVE'`,
        [uuidv7(), ctx.tenantId, input.vaultEpochId, c.shareIndex, c.custodianName, c.custodianRole],
      );
    }

    return { success: true, count: 3 };
  }

  static async initiateRecoveryCeremony(
    tx: TenantTx,
    ctx: TrustedContext,
    input: InitiateRecoveryInput,
  ) {
    const id = uuidv7();
    const res = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO app.institution_recovery_ceremonies (
         id, organization_id, vault_epoch_id, target_user_id, initiated_by_user_id,
         status, required_shares, reason
       ) VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', 2, $6)
       RETURNING id, created_at`,
      [id, ctx.tenantId, input.vaultEpochId, input.targetUserId, ctx.userId, input.reason],
    );

    return {
      ceremonyId: res.rows[0]!.id,
      status: 'IN_PROGRESS',
      requiredShares: 2,
      presentedShares: 0,
      createdAt: res.rows[0]!.created_at,
    };
  }

  static async presentRecoveryShare(
    tx: TenantTx,
    ctx: TrustedContext,
    input: PresentRecoveryShareInput,
  ) {
    const ceremonyRes = await tx.query<{
      id: string;
      status: string;
      shares_presented: number;
      presented_share_indices: number[];
      vault_epoch_id: string;
    }>(
      `SELECT id, status, shares_presented, presented_share_indices, vault_epoch_id
         FROM app.institution_recovery_ceremonies
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, input.ceremonyId],
    );

    const ceremony = ceremonyRes.rows[0];
    if (!ceremony || ceremony.status !== 'IN_PROGRESS') {
      throw new AppError(400, 'INVALID_CEREMONY', 'Recovery ceremony is not currently active.');
    }

    if (ceremony.presented_share_indices.includes(input.shareIndex)) {
      throw new AppError(400, 'DUPLICATE_SHARE', 'This custodian share has already been presented.');
    }

    const updatedIndices = [...ceremony.presented_share_indices, input.shareIndex];
    const newSharesCount = ceremony.shares_presented + 1;
    const isComplete = newSharesCount >= 2;

    await tx.query(
      `UPDATE app.institution_recovery_ceremonies
          SET shares_presented = $3,
              presented_share_indices = $4,
              status = CASE WHEN $5 THEN 'COMPLETED' ELSE status END,
              completed_at = CASE WHEN $5 THEN clock_timestamp() ELSE completed_at END,
              updated_at = clock_timestamp()
        WHERE organization_id = $1 AND id = $2`,
      [ctx.tenantId, input.ceremonyId, newSharesCount, updatedIndices, isComplete],
    );

    return {
      ceremonyId: input.ceremonyId,
      sharesPresented: newSharesCount,
      requiredShares: 2,
      isComplete,
      status: isComplete ? 'COMPLETED' : 'IN_PROGRESS',
    };
  }

  // -----------------------------------------------------------------------------------------------
  // 5. Scoped Capability Key Grants
  // -----------------------------------------------------------------------------------------------

  static async issueKeyGrant(tx: TenantTx, ctx: TrustedContext, input: IssueKeyGrantInput) {
    const id = uuidv7();
    const res = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO app.vault_key_grants (
         id, organization_id, vault_epoch_id, device_id, user_id,
         capability_key_name, scope_type, scope_target_id,
         wrapped_capability_key, ephemeral_public_key, iv, tag,
         status, issued_by_user_id, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13, $14)
       RETURNING id, created_at`,
      [
        id,
        ctx.tenantId,
        input.vaultEpochId,
        input.deviceId,
        input.userId,
        input.capabilityKeyName,
        input.scopeType,
        input.scopeTargetId ?? null,
        input.wrappedCapabilityKey,
        input.ephemeralPublicKey,
        input.iv,
        input.tag,
        ctx.userId,
        input.expiresAt ?? null,
      ],
    );

    return {
      grantId: res.rows[0]!.id,
      capabilityKeyName: input.capabilityKeyName,
      scopeType: input.scopeType,
      createdAt: res.rows[0]!.created_at,
    };
  }

  static async getActiveGrantsForDevice(
    tx: TenantTx,
    ctx: TrustedContext,
    deviceId: string,
  ) {
    const res = await tx.query<{
      id: string;
      capability_key_name: string;
      scope_type: string;
      scope_target_id: string | null;
      wrapped_capability_key: string;
      ephemeral_public_key: string;
      iv: string;
      tag: string;
      expires_at: Date | null;
    }>(
      `SELECT
         id,
         capability_key_name,
         scope_type,
         scope_target_id,
         wrapped_capability_key,
         ephemeral_public_key,
         iv,
         tag,
         expires_at
       FROM app.vault_key_grants
      WHERE organization_id = $1
        AND device_id = $2
        AND user_id = $3
        AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [ctx.tenantId, deviceId, ctx.userId],
    );

    return res.rows.map((r) => ({
      grantId: r.id,
      capabilityKeyName: r.capability_key_name,
      scopeType: r.scope_type,
      scopeTargetId: r.scope_target_id,
      wrappedCapabilityKey: r.wrapped_capability_key,
      ephemeralPublicKey: r.ephemeral_public_key,
      iv: r.iv,
      tag: r.tag,
      expiresAt: r.expires_at,
    }));
  }

  // -----------------------------------------------------------------------------------------------
  // 6. Zero-Access Protected Records (Backend NEVER decrypts!)
  // -----------------------------------------------------------------------------------------------

  static async storeProtectedRecord(
    tx: TenantTx,
    ctx: TrustedContext,
    input: StoreProtectedRecordInput,
  ) {
    const id = uuidv7();
    const res = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO app.vault_protected_records (
         id, organization_id, vault_epoch_id, entity_type, entity_id,
         capability_key_name, ciphertext, iv, auth_tag, aad_context
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id, entity_type, entity_id)
       DO UPDATE SET
         vault_epoch_id = EXCLUDED.vault_epoch_id,
         capability_key_name = EXCLUDED.capability_key_name,
         ciphertext = EXCLUDED.ciphertext,
         iv = EXCLUDED.iv,
         auth_tag = EXCLUDED.auth_tag,
         aad_context = EXCLUDED.aad_context,
         updated_at = clock_timestamp()
       RETURNING id, created_at`,
      [
        id,
        ctx.tenantId,
        input.vaultEpochId,
        input.entityType,
        input.entityId,
        input.capabilityKeyName,
        input.ciphertext,
        input.iv,
        input.authTag,
        JSON.stringify(input.aadContext),
      ],
    );

    return {
      id: res.rows[0]!.id,
      entityType: input.entityType,
      entityId: input.entityId,
      storedAt: res.rows[0]!.created_at,
    };
  }

  static async getProtectedRecord(
    tx: TenantTx,
    ctx: TrustedContext,
    entityType: string,
    entityId: string,
  ) {
    const res = await tx.query<{
      id: string;
      vault_epoch_id: string;
      entity_type: string;
      entity_id: string;
      capability_key_name: string;
      ciphertext: string;
      iv: string;
      auth_tag: string;
      aad_context: any;
      created_at: Date;
    }>(
      `SELECT
         id,
         vault_epoch_id,
         entity_type,
         entity_id,
         capability_key_name,
         ciphertext,
         iv,
         auth_tag,
         aad_context,
         created_at
       FROM app.vault_protected_records
      WHERE organization_id = $1
        AND entity_type = $2
        AND entity_id = $3`,
      [ctx.tenantId, entityType, entityId],
    );

    if (res.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Protected vault record not found.');
    }

    const r = res.rows[0]!;
    return {
      id: r.id,
      vaultEpochId: r.vault_epoch_id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      capabilityKeyName: r.capability_key_name,
      ciphertext: r.ciphertext,
      iv: r.iv,
      authTag: r.auth_tag,
      aadContext: typeof r.aad_context === 'string' ? JSON.parse(r.aad_context) : r.aad_context,
      createdAt: r.created_at,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // 7. Adult Student Consent Management
  // -----------------------------------------------------------------------------------------------

  static async grantAdultConsent(
    tx: TenantTx,
    ctx: TrustedContext,
    input: GrantAdultConsentInput,
  ) {
    // Assert user is a student
    const studentRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    if (!studentRes.rows[0]) {
      throw new AppError(403, 'FORBIDDEN', 'Only enrolled students may grant guardian consent.');
    }
    const studentId = studentRes.rows[0].id;

    const id = uuidv7();
    const res = await tx.query<{ id: string; granted_at: Date }>(
      `INSERT INTO app.adult_guardian_consents (
         id, organization_id, student_id, guardian_id, consent_scope, status, expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
       ON CONFLICT (organization_id, student_id, guardian_id, consent_scope) WHERE (status = 'ACTIVE')
       DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         updated_at = clock_timestamp()
       RETURNING id, granted_at`,
      [
        id,
        ctx.tenantId,
        studentId,
        input.guardianId,
        input.consentScope,
        input.expiresAt ?? null,
      ],
    );

    return {
      consentId: res.rows[0]!.id,
      status: 'ACTIVE',
      grantedAt: res.rows[0]!.granted_at,
    };
  }

  static async revokeAdultConsent(tx: TenantTx, ctx: TrustedContext, consentId: string) {
    // Assert user is a student
    const studentRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    if (!studentRes.rows[0]) {
      throw new AppError(403, 'FORBIDDEN', 'Only students may revoke their consent.');
    }
    const studentId = studentRes.rows[0].id;

    const res = await tx.query<{ id: string }>(
      `UPDATE app.adult_guardian_consents
          SET status = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE organization_id = $1 AND student_id = $2 AND id = $3 AND status = 'ACTIVE'
        RETURNING id`,
      [ctx.tenantId, studentId, consentId],
    );

    if (res.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Active consent record not found.');
    }

    return { revoked: true, consentId: res.rows[0]!.id };
  }

  static async listAdultConsents(tx: TenantTx, ctx: TrustedContext) {
    const studentRes = await tx.query<{ id: string }>(
      `SELECT id FROM app.students WHERE organization_id = $1 AND user_id = $2`,
      [ctx.tenantId, ctx.userId],
    );
    if (!studentRes.rows[0]) {
      return [];
    }
    const studentId = studentRes.rows[0].id;

    const res = await tx.query<{
      id: string;
      guardian_id: string;
      consent_scope: string;
      status: string;
      granted_at: Date;
      expires_at: Date | null;
      guardian_name: string;
    }>(
      `SELECT
         agc.id,
         agc.guardian_id,
         agc.consent_scope,
         agc.status,
         agc.granted_at,
         agc.expires_at,
         COALESCE(u.display_name, g.full_name) AS guardian_name
       FROM app.adult_guardian_consents agc
       JOIN app.guardians g ON g.id = agc.guardian_id AND g.organization_id = agc.organization_id
       LEFT JOIN app.users u ON u.id = g.user_id AND u.organization_id = g.organization_id
      WHERE agc.organization_id = $1
        AND agc.student_id = $2
      ORDER BY agc.granted_at DESC`,
      [ctx.tenantId, studentId],
    );

    return res.rows.map((r) => ({
      id: r.id,
      guardianId: r.guardian_id,
      guardianName: r.guardian_name,
      consentScope: r.consent_scope,
      status: r.status,
      grantedAt: r.granted_at,
      expiresAt: r.expires_at,
    }));
  }
}
