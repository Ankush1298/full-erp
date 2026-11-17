import { z } from 'zod';
import type { ApiClient } from './client';

export const SecurityAuthorityDtoSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    title: z.string(),
    institutionType: z.enum(['SCHOOL', 'COLLEGE', 'UNIVERSITY']),
    status: z.string(),
    appointedByUserId: z.string(),
    appointedAt: z.string(),
    delegatedToUserId: z.string().nullable(),
    delegatedAt: z.string().nullable(),
    notes: z.string().nullable(),
    userDisplayName: z.string(),
    userEmail: z.string(),
  })
  .nullable();
export type SecurityAuthorityDto = z.infer<typeof SecurityAuthorityDtoSchema>;

export const UserVaultDeviceDtoSchema = z.object({
  id: z.string(),
  deviceNumber: z.number(),
  deviceLabel: z.string(),
  deviceType: z.string(),
  status: z.string(),
  publicKey: z.string(),
  aaguid: z.string().nullable().optional(),
  enrolledAt: z.string(),
  lastUsedAt: z.string().nullable().optional(),
});
export type UserVaultDeviceDto = z.infer<typeof UserVaultDeviceDtoSchema>;

export const DevicesResponseSchema = z.object({
  devices: z.array(UserVaultDeviceDtoSchema),
  activeCount: z.number(),
  maxAllowed: z.number(),
  canEnrollSecond: z.boolean(),
  limitReached: z.boolean(),
});
export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;

export const VaultEpochDtoSchema = z
  .object({
    id: z.string(),
    epoch: z.number(),
    status: z.string(),
    smekPublicKey: z.string(),
    createdAt: z.string(),
  })
  .nullable();
export type VaultEpochDto = z.infer<typeof VaultEpochDtoSchema>;

export const RecoveryCeremonyDtoSchema = z.object({
  ceremonyId: z.string(),
  status: z.string(),
  requiredShares: z.number(),
  presentedShares: z.number(),
  createdAt: z.string(),
  isComplete: z.boolean().optional(),
});
export type RecoveryCeremonyDto = z.infer<typeof RecoveryCeremonyDtoSchema>;

export async function fetchSecurityAuthority(
  client: ApiClient,
): Promise<SecurityAuthorityDto | null> {
  const res = await client.get('/v1/vault/authority', {
    schema: z.object({
      success: z.boolean(),
      data: SecurityAuthorityDtoSchema,
    }),
  });
  return res.data;
}

export async function appointSecurityAuthority(
  client: ApiClient,
  payload: {
    title: string;
    userId: string;
    institutionType: string;
    notes?: string;
  },
): Promise<{ id: string; appointedAt: string }> {
  const res = await client.post('/v1/vault/authority/appoint', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: z.object({ id: z.string(), appointedAt: z.string() }),
    }),
  });
  return res.data;
}

export async function fetchVaultDevices(client: ApiClient): Promise<DevicesResponse> {
  const res = await client.get('/v1/vault/devices', {
    schema: z.object({
      success: z.boolean(),
      data: DevicesResponseSchema,
    }),
  });
  return res.data;
}

export async function enrollVaultDevice(
  client: ApiClient,
  payload: {
    deviceLabel: string;
    deviceType: string;
    publicKey: string;
    attestationFormat?: string;
    aaguid?: string;
  },
): Promise<UserVaultDeviceDto> {
  const res = await client.post('/v1/vault/devices/enroll', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: UserVaultDeviceDtoSchema,
    }),
  });
  return res.data;
}

export async function revokeVaultDevice(
  client: ApiClient,
  id: string,
  reason?: string,
): Promise<{ revoked: boolean }> {
  const res = await client.post(`/v1/vault/devices/${id}/revoke`, {
    body: { reason },
    schema: z.object({
      success: z.boolean(),
      data: z.object({ revoked: z.boolean() }),
    }),
  });
  return res.data;
}

export async function fetchVaultEpoch(client: ApiClient): Promise<VaultEpochDto> {
  const res = await client.get('/v1/vault/epoch', {
    schema: z.object({
      success: z.boolean(),
      data: VaultEpochDtoSchema,
    }),
  });
  return res.data;
}

export async function rotateVaultEpoch(
  client: ApiClient,
  payload: { smekPublicKey: string; reason?: string },
): Promise<VaultEpochDto> {
  const res = await client.post('/v1/vault/epoch/rotate', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: VaultEpochDtoSchema,
    }),
  });
  return res.data;
}

export async function setupRecoveryCustodians(
  client: ApiClient,
  payload: {
    vaultEpochId: string;
    custodians: Array<{
      custodianName: string;
      custodianRole: string;
      shareIndex: number;
    }>;
  },
): Promise<{ success: boolean; count: number }> {
  const res = await client.post('/v1/vault/recovery/custodians', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: z.object({ success: z.boolean(), count: z.number() }),
    }),
  });
  return res.data;
}

export async function initiateRecoveryCeremony(
  client: ApiClient,
  payload: {
    vaultEpochId: string;
    targetUserId: string;
    reason: string;
  },
): Promise<RecoveryCeremonyDto> {
  const res = await client.post('/v1/vault/recovery/ceremony', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: RecoveryCeremonyDtoSchema,
    }),
  });
  return res.data;
}

export async function presentRecoveryShare(
  client: ApiClient,
  payload: {
    ceremonyId: string;
    shareIndex: number;
    shareData: string;
  },
): Promise<{ isComplete: boolean; sharesPresented: number }> {
  const res = await client.post('/v1/vault/recovery/share', {
    body: payload,
    schema: z.object({
      success: z.boolean(),
      data: z.object({ isComplete: z.boolean(), sharesPresented: z.number() }),
    }),
  });
  return res.data;
}
