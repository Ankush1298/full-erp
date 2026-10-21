import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../shared/errors/http-errors.js';
import type { TrustedContext } from '../../../shared/tenancy/trusted-context.js';
import { uuidv7 } from '../../../shared/ids/uuidv7.js';

export interface ConfirmationTokenPayload {
  tenantId: string;
  userId: string;
  toolName: string;
  payloadHash: string;
  expiresAt: number;
  nonce: string;
}

export interface ConfirmationTokenServiceOptions {
  secretKey?: string;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Generates and verifies cryptographic, payload-bound confirmation tokens
 * for two-phase write actions in the AI Gateway (ADR-013, S-9).
 *
 * Tokens are strictly bound to:
 * - the authenticated tenant (cross-tenant reuse impossible)
 * - the authenticated user (user A's token cannot be used by user B)
 * - the specific tool name
 * - the SHA-256 digest of the canonical action payload (payload tampering impossible)
 * - an expiration timestamp (replay after expiration impossible)
 * - a single-use nonce (double execution impossible)
 */
export class ConfirmationTokenService {
  private readonly secretKey: string;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private readonly consumedNonces = new Map<string, number>();

  constructor(options: ConfirmationTokenServiceOptions = {}) {
    // Secret key for HMAC signing
    this.secretKey = options.secretKey ?? 'anesa-ai-confirmation-default-secret-v3';
    this.defaultTtlMs = options.ttlMs ?? 5 * 60_000; // 5 minutes default
    this.now = options.now ?? Date.now;
  }

  /**
   * Deterministic canonical JSON serialization for stable hash computation.
   */
  static canonicalize(val: unknown): string {
    if (val === null || typeof val !== 'object') {
      return JSON.stringify(val);
    }
    if (Array.isArray(val)) {
      return '[' + val.map((v) => ConfirmationTokenService.canonicalize(v)).join(',') + ']';
    }
    const record = val as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    return (
      '{' +
      sortedKeys
        .map((k) => JSON.stringify(k) + ':' + ConfirmationTokenService.canonicalize(record[k]))
        .join(',') +
      '}'
    );
  }

  static hashPayload(payload: unknown): string {
    const canonical = ConfirmationTokenService.canonicalize(payload);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  createToken(
    ctx: TrustedContext,
    toolName: string,
    payload: unknown,
    customTtlMs?: number,
  ): { confirmToken: string; expiresAt: string } {
    const nowTime = this.now();
    const ttl = customTtlMs ?? this.defaultTtlMs;
    const expiresAt = nowTime + ttl;
    const payloadHash = ConfirmationTokenService.hashPayload(payload);

    const tokenPayload: ConfirmationTokenPayload = {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      toolName,
      payloadHash,
      expiresAt,
      nonce: uuidv7(),
    };

    const encodedData = Buffer.from(JSON.stringify(tokenPayload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secretKey)
      .update(encodedData, 'utf8')
      .digest('base64url');

    const confirmToken = `${encodedData}.${signature}`;
    return {
      confirmToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  verifyAndConsumeToken(
    ctx: TrustedContext,
    toolName: string,
    payload: unknown,
    tokenString: string,
  ): void {
    if (!tokenString || typeof tokenString !== 'string') {
      throw new AppError(400, 'CONFIRMATION_TOKEN_INVALID', 'Confirmation token is required.');
    }

    const parts = tokenString.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AppError(400, 'CONFIRMATION_TOKEN_INVALID', 'Malformed confirmation token format.');
    }

    const [encodedData, signature] = parts;
    const expectedSig = createHmac('sha256', this.secretKey)
      .update(encodedData, 'utf8')
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'base64url');
    const expBuf = Buffer.from(expectedSig, 'base64url');
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new AppError(
        400,
        'CONFIRMATION_TOKEN_INVALID',
        'Confirmation token signature is invalid.',
      );
    }

    let parsed: ConfirmationTokenPayload;
    try {
      const raw = JSON.parse(Buffer.from(encodedData, 'base64url').toString('utf8')) as unknown;
      if (!raw || typeof raw !== 'object') {
        throw new Error('Malformed token');
      }
      parsed = raw as ConfirmationTokenPayload;
    } catch {
      throw new AppError(400, 'CONFIRMATION_TOKEN_INVALID', 'Malformed confirmation token data.');
    }

    const nowTime = this.now();
    this.sweepExpiredNonces(nowTime);

    // Verify expiration
    if (parsed.expiresAt <= nowTime) {
      throw new AppError(400, 'CONFIRMATION_TOKEN_EXPIRED', 'Confirmation token has expired.');
    }

    // Verify tenant and user binding
    if (parsed.tenantId !== ctx.tenantId || parsed.userId !== ctx.userId) {
      throw new AppError(
        403,
        'CONFIRMATION_TOKEN_UNAUTHORIZED',
        'Confirmation token was not issued to the authenticated caller.',
      );
    }

    // Verify tool binding
    if (parsed.toolName !== toolName) {
      throw new AppError(
        400,
        'CONFIRMATION_TOKEN_MISMATCH',
        `Confirmation token was issued for tool ${parsed.toolName}, not ${toolName}.`,
      );
    }

    // Verify payload integrity
    const currentPayloadHash = ConfirmationTokenService.hashPayload(payload);
    if (parsed.payloadHash !== currentPayloadHash) {
      throw new AppError(
        400,
        'CONFIRMATION_TOKEN_PAYLOAD_TAMPERED',
        'Confirmation token payload hash does not match current action arguments.',
      );
    }

    // Verify single-use nonce
    if (this.consumedNonces.has(parsed.nonce)) {
      throw new AppError(
        409,
        'CONFIRMATION_TOKEN_REUSED',
        'Confirmation token has already been consumed.',
      );
    }

    // Mark nonce as consumed
    this.consumedNonces.set(parsed.nonce, parsed.expiresAt);
  }

  private sweepExpiredNonces(nowTime: number): void {
    if (this.consumedNonces.size > 10_000) {
      for (const [nonce, expiresAt] of this.consumedNonces.entries()) {
        if (expiresAt <= nowTime) {
          this.consumedNonces.delete(nonce);
        }
      }
    }
  }
}
