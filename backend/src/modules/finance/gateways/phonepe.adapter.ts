import { createHash } from 'node:crypto';
import { safeEqual } from '../../../shared/crypto/gateway-crypto.js';
import type {
  CreateOrderParams,
  CreateOrderResult,
  GatewayConfig,
  HealthCheckResult,
  InitiateRefundParams,
  IPaymentGatewayAdapter,
  PaymentVerificationResult,
  RefundResult,
  VerifyPaymentParams,
  WebhookProcessResult,
  WebhookVerificationParams,
} from './types.js';

export class PhonePeAdapter implements IPaymentGatewayAdapter {
  readonly provider = 'PHONEPE';
  readonly #fetchFn?: typeof fetch | undefined;

  constructor(options?: { fetchFn?: typeof fetch }) {
    this.#fetchFn = options?.fetchFn;
  }

  get #fetch(): typeof fetch {
    return this.#fetchFn ?? globalThis.fetch;
  }

  #getBaseUrl(config: GatewayConfig): string {
    return config.mode === 'LIVE'
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  }

  #getSaltKeyAndIndex(config: GatewayConfig): { saltKey: string; saltIndex: string } {
    const saltKey = config.secretKey;
    const saltIndex = (config.settings?.salt_index as string) || '1';
    return { saltKey, saltIndex };
  }

  #calculateChecksum(stringToHash: string, saltIndex: string): string {
    const sha256 = createHash('sha256').update(stringToHash).digest('hex');
    return `${sha256}###${saltIndex}`;
  }

  async createOrder(config: GatewayConfig, params: CreateOrderParams): Promise<CreateOrderResult> {
    const baseUrl = this.#getBaseUrl(config);
    const endpoint = '/pg/v1/pay';
    const { saltKey, saltIndex } = this.#getSaltKeyAndIndex(config);

    const payload = {
      merchantId: config.merchantKey,
      merchantTransactionId: params.attemptReference,
      merchantUserId: params.student.id,
      amount: params.amount, // in minor units (paise)
      redirectUrl:
        params.returnUrl ||
        `https://example.com/payment/callback?attempt_ref=${params.attemptReference}`,
      redirectMode: 'POST',
      callbackUrl: params.notifyUrl,
      paymentInstrument: {
        type: 'PAY_PAGE',
      },
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const xVerify = this.#calculateChecksum(`${base64Payload}${endpoint}${saltKey}`, saltIndex);

    const res = await this.#fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      body: JSON.stringify({ request: base64Payload }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`PhonePe pay initiation failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      success: boolean;
      code: string;
      message: string;
      data?: {
        instrumentResponse?: {
          redirectInfo?: {
            url?: string;
            method?: string;
          };
        };
      };
    };

    if (!data.success) {
      throw new Error(`PhonePe pay initiation error (${data.code}): ${data.message}`);
    }

    const redirectUrl = data.data?.instrumentResponse?.redirectInfo?.url;

    return {
      orderReference: params.attemptReference,
      redirectUrl,
      checkoutPayload: {
        provider: 'PHONEPE',
        merchantId: config.merchantKey,
        merchantTransactionId: params.attemptReference,
        amount: params.amount,
        redirectUrl,
        mode: config.mode.toLowerCase(),
      },
    };
  }

  async verifyPayment(
    config: GatewayConfig,
    params: VerifyPaymentParams,
  ): Promise<PaymentVerificationResult> {
    const baseUrl = this.#getBaseUrl(config);
    const merchantId = config.merchantKey;
    const transactionId = params.attemptReference || params.orderReference;
    const endpoint = `/pg/v1/status/${encodeURIComponent(merchantId)}/${encodeURIComponent(transactionId)}`;
    const { saltKey, saltIndex } = this.#getSaltKeyAndIndex(config);

    const xVerify = this.#calculateChecksum(`${endpoint}${saltKey}`, saltIndex);

    const res = await this.#fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
        'X-MERCHANT-ID': merchantId,
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        status: 'FAILED',
        gatewayPaymentRef: params.gatewayPaymentRef || '',
        amount: 0,
        currency: 'INR',
        failureReason: `PhonePe status check failed: ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const data = (await res.json()) as {
      success: boolean;
      code: string;
      message: string;
      data?: {
        merchantTransactionId: string;
        transactionId: string;
        amount: number;
        state: string;
        responseCode: string;
        paymentInstrument?: { type?: string };
      };
    };

    const isSuccess =
      data.success && data.code === 'PAYMENT_SUCCESS' && data.data?.state === 'COMPLETED';

    return {
      success: isSuccess,
      status: isSuccess
        ? 'SUCCESS'
        : data.data?.state === 'FAILED' || data.code === 'PAYMENT_ERROR'
          ? 'FAILED'
          : 'PENDING',
      gatewayPaymentRef: data.data?.transactionId || transactionId,
      amount: data.data?.amount ? Number(data.data.amount) : 0,
      currency: 'INR',
      paymentMethod: data.data?.paymentInstrument?.type
        ? `PHONEPE_${data.data.paymentInstrument.type.toUpperCase()}`
        : 'ONLINE_PHONEPE',
      failureReason: isSuccess ? undefined : data.message || `PhonePe response: ${data.code}`,
      rawResponse: data as Record<string, unknown>,
    };
  }

  async processWebhook(
    config: GatewayConfig,
    params: WebhookVerificationParams,
  ): Promise<WebhookProcessResult> {
    const xVerify =
      params.headers['x-verify'] || params.headers['X-VERIFY'] || params.headers['X-Verify'];

    if (!xVerify || typeof xVerify !== 'string') {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Missing X-VERIFY header',
        rawEvent: {},
      };
    }

    const rawString =
      typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');

    let bodyObj: { response?: string };
    try {
      bodyObj = JSON.parse(rawString);
    } catch {
      return {
        isValid: false,
        eventType: 'malformed_json',
        status: 'FAILED',
        failureReason: 'Malformed JSON webhook payload',
        rawEvent: {},
      };
    }

    const base64Response = bodyObj.response;
    if (!base64Response) {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Missing response string in payload',
        rawEvent: bodyObj,
      };
    }

    const { saltKey, saltIndex } = this.#getSaltKeyAndIndex(config);
    const expected = this.#calculateChecksum(`${base64Response}${saltKey}`, saltIndex);

    if (!safeEqual(expected, xVerify)) {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Invalid PhonePe webhook checksum signature',
        rawEvent: bodyObj,
      };
    }

    let decoded: {
      success?: boolean;
      code?: string;
      data?: {
        merchantTransactionId?: string;
        transactionId?: string;
        amount?: number;
        state?: string;
        responseCode?: string;
      };
    };

    try {
      decoded = JSON.parse(Buffer.from(base64Response, 'base64').toString('utf8'));
    } catch {
      return {
        isValid: false,
        eventType: 'malformed_base64_json',
        status: 'FAILED',
        failureReason: 'Malformed decoded JSON data',
        rawEvent: bodyObj,
      };
    }

    const isSuccess =
      decoded.success && decoded.code === 'PAYMENT_SUCCESS' && decoded.data?.state === 'COMPLETED';
    const isFailed = decoded.data?.state === 'FAILED' || decoded.code === 'PAYMENT_ERROR';

    return {
      isValid: true,
      eventType: decoded.code || 'PHONEPE_WEBHOOK',
      attemptReference: decoded.data?.merchantTransactionId,
      orderReference: decoded.data?.merchantTransactionId,
      gatewayPaymentRef: decoded.data?.transactionId,
      status: isSuccess ? 'SUCCESS' : isFailed ? 'FAILED' : 'PENDING',
      amount: decoded.data?.amount ? Number(decoded.data.amount) : undefined,
      failureReason: isSuccess ? undefined : decoded.code,
      rawEvent: decoded as Record<string, unknown>,
    };
  }

  async initiateRefund(config: GatewayConfig, params: InitiateRefundParams): Promise<RefundResult> {
    const baseUrl = this.#getBaseUrl(config);
    const endpoint = '/pg/v1/refund';
    const { saltKey, saltIndex } = this.#getSaltKeyAndIndex(config);

    const refundTxnId = `REF_${Date.now()}`;
    const payload = {
      merchantId: config.merchantKey,
      merchantUserId: 'SYSTEM',
      originalTransactionId: params.orderReference || params.gatewayPaymentRef,
      merchantTransactionId: refundTxnId,
      amount: params.amount,
      callbackUrl: 'https://example.com/refund/callback',
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const xVerify = this.#calculateChecksum(`${base64Payload}${endpoint}${saltKey}`, saltIndex);

    const res = await this.#fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': xVerify,
      },
      body: JSON.stringify({ request: base64Payload }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        gatewayRefundRef: '',
        status: 'FAILED',
        failureReason: `PhonePe refund failed (${res.status}): ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const data = (await res.json()) as {
      success: boolean;
      code: string;
      data?: {
        transactionId?: string;
        state?: string;
      };
    };

    const isSuccess =
      data.success && (data.code === 'PAYMENT_SUCCESS' || data.data?.state === 'COMPLETED');

    return {
      success: isSuccess,
      gatewayRefundRef: data.data?.transactionId || refundTxnId,
      status: isSuccess ? 'SUCCESS' : 'PENDING',
      rawResponse: data as Record<string, unknown>,
    };
  }

  async checkHealth(config: GatewayConfig): Promise<HealthCheckResult> {
    const { saltKey, saltIndex } = this.#getSaltKeyAndIndex(config);
    if (!saltKey || saltKey.length < 8) {
      return {
        healthy: false,
        message: 'Invalid or missing PhonePe Salt Key',
      };
    }
    if (!config.merchantKey || config.merchantKey.trim().length === 0) {
      return {
        healthy: false,
        message: 'Missing PhonePe Merchant ID',
      };
    }

    return {
      healthy: true,
      message: 'PhonePe gateway configuration parameters validated successfully',
      details: {
        mode: config.mode,
        merchantId: config.merchantKey,
        saltIndex,
      },
    };
  }
}
