import { z } from 'zod';
import type { ApiClient } from './client';
import { SuccessSchema } from './schemas';

export const MfaStatusDataSchema = z.object({
  enrolled: z.boolean(),
  required: z.boolean(),
  sessionVerified: z.boolean(),
  confirmedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  pendingEnrollment: z.boolean(),
  unusedRecoveryCodes: z.number(),
});
export type MfaStatus = z.infer<typeof MfaStatusDataSchema>;

export const MfaStatusResponseSchema = z.object({
  success: z.literal(true),
  data: MfaStatusDataSchema,
});

export const MfaEnrollStartDataSchema = z.object({
  factorId: z.string(),
  secret: z.string(),
  otpauthUri: z.string(),
  algorithm: z.literal('SHA1'),
  digits: z.number(),
  period: z.number(),
  expiresInSeconds: z.number(),
});
export type MfaEnrollStartData = z.infer<typeof MfaEnrollStartDataSchema>;

export const MfaEnrollStartResponseSchema = z.object({
  success: z.literal(true),
  data: MfaEnrollStartDataSchema,
});

export const MfaVerifyDataSchema = z.object({
  recoveryCodes: z.array(z.string()),
  step: z.object({
    authStrength: z.string(),
  }),
});
export type MfaVerifyData = z.infer<typeof MfaVerifyDataSchema>;

export const MfaVerifyResponseSchema = z.object({
  success: z.literal(true),
  data: MfaVerifyDataSchema,
});

export const MfaChallengeDataSchema = z.object({
  authStrength: z.string(),
  method: z.string(),
});
export type MfaChallengeData = z.infer<typeof MfaChallengeDataSchema>;

export const MfaChallengeResponseSchema = z.object({
  success: z.literal(true),
  data: MfaChallengeDataSchema,
});

export const MfaRecoveryCodesDataSchema = z.object({
  recoveryCodes: z.array(z.string()),
});
export const MfaRecoveryCodesResponseSchema = z.object({
  success: z.literal(true),
  data: MfaRecoveryCodesDataSchema,
});

export async function fetchMfaStatus(client: ApiClient): Promise<MfaStatus> {
  const res = await client.get('/me/mfa', { schema: MfaStatusResponseSchema });
  return res.data;
}

export async function startMfaEnrollment(
  client: ApiClient,
  ticket?: string,
): Promise<MfaEnrollStartData> {
  const body = ticket ? { ticket: ticket.trim() } : {};
  const res = await client.post('/me/mfa/totp/enroll', {
    body,
    schema: MfaEnrollStartResponseSchema,
  });
  return res.data;
}

export async function cancelMfaEnrollment(client: ApiClient): Promise<void> {
  await client.delete('/me/mfa/totp/enroll', { schema: SuccessSchema });
}

export async function verifyMfaEnrollment(client: ApiClient, code: string): Promise<MfaVerifyData> {
  const res = await client.post('/me/mfa/totp/verify', {
    body: { code },
    schema: MfaVerifyResponseSchema,
  });
  return res.data;
}

export async function submitMfaChallenge(
  client: ApiClient,
  input: { code?: string; recoveryCode?: string },
): Promise<MfaChallengeData> {
  const res = await client.post('/auth/mfa/challenge', {
    body: input,
    schema: MfaChallengeResponseSchema,
  });
  return res.data;
}

export async function regenerateRecoveryCodes(client: ApiClient): Promise<string[]> {
  const res = await client.post('/me/mfa/recovery-codes/regenerate', {
    schema: MfaRecoveryCodesResponseSchema,
  });
  return res.data.recoveryCodes;
}

export async function disableMfa(client: ApiClient): Promise<void> {
  await client.delete('/me/mfa/totp', { schema: SuccessSchema });
}
