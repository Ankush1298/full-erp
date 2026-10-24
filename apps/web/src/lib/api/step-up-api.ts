import { z } from 'zod';
import type { ApiClient } from './client';
import { MfaChallengeResponseSchema } from './mfa-api';

/**
 * Session re-verification ("step-up"), against the endpoints the backend actually has:
 *  - POST /auth/step-up {password}            -> authStrength PASSWORD_REAUTH (password re-entered on THIS session)
 *  - POST /auth/mfa/challenge {code|recoveryCode} -> authStrength PASSWORD_MFA   (second factor on THIS session)
 * A CRITICAL route needs PASSWORD_MFA (the backend default, never lowered here); PASSWORD_REAUTH is a weaker level that is
 * NOT interchangeable with it (it satisfies only routes that ask for exactly that, e.g. the first MFA enrollment).
 *
 * Both calls are `public: true` ON PURPOSE: a wrong password or code is a 401 INVALID_CREDENTIALS, which the client would
 * otherwise read as "session expired" and sign the user out. A genuinely dead session answers 401 UNAUTHORIZED, which the
 * step-up dialog handles explicitly. Neither the password nor a code is stored, logged or put in a URL.
 */
export type StepUpLevel = 'PASSWORD_REAUTH' | 'PASSWORD_MFA';

const RANK: Record<string, number> = { PASSWORD: 1, PASSWORD_REAUTH: 2, PASSWORD_MFA: 3 };

/** Does the strength the server reported satisfy the level the caller needs? Unknown strings never do. */
export function satisfiesLevel(reported: string, needed: StepUpLevel): boolean {
  const have = RANK[reported];
  return have !== undefined && have >= (RANK[needed] ?? Infinity);
}

const PasswordStepUpResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ steppedUp: z.literal(true), authStrength: z.string() }),
});

/** Resolves with the strength the server granted; rejects with ApiError. */
export async function submitPasswordStepUp(client: ApiClient, entered: string): Promise<string> {
  const res = await client.post('/auth/step-up', {
    body: { password: entered },
    schema: PasswordStepUpResponseSchema,
    public: true,
  });
  return res.data.authStrength;
}

export async function submitMfaStepUp(
  client: ApiClient,
  input: { code: string } | { recoveryCode: string },
): Promise<string> {
  const res = await client.post('/auth/mfa/challenge', {
    body: input,
    schema: MfaChallengeResponseSchema,
    public: true,
  });
  return res.data.authStrength;
}
