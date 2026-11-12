import { createHmac } from 'node:crypto';
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

export class RazorpayAdapter implements IPaymentGatewayAdapter {
  readonly provider = 'RAZORPAY';
  readonly #baseUrl: string;
  readonly #fetchFn?: typeof fetch | undefined;

  constructor(options?: { baseUrl?: string; fetchFn?: typeof fetch }) {
    this.#baseUrl = options?.baseUrl || 'https://api.razorpay.com/v1';
    this.#fetchFn = options?.fetchFn;
  }

  get #fetch(): typeof fetch {
    return this.#fetchFn ?? globalThis.fetch;
  }

  #getAuthHeader(config: GatewayConfig): string {
    const creds = `${config.merchantKey}:${config.secretKey}`;
    return `Basic ${Buffer.from(creds).toString('base64')}`;
  }

  async createOrder(config: GatewayConfig, params: CreateOrderParams): Promise<CreateOrderResult> {
    const url = `${this.#baseUrl}/orders`;
    const payload = {
      amount: params.amount,
      currency: params.currency || 'INR',
      receipt: params.attemptReference,
      notes: {
        attempt_reference: params.attemptReference,
        student_id: params.student.id,
        student_name: params.student.name,
        description: params.description,
      },
    };

    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.#getAuthHeader(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Razorpay createOrder failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id: string; amount: number; currency: string };

    return {
      orderReference: data.id,
      checkoutPayload: {
        provider: 'RAZORPAY',
        key: config.merchantKey,
        order_id: data.id,
        amount: data.amount,
        currency: data.currency,
        name: 'Anesa Campus',
        description: params.description,
        prefill: {
          name: params.student.name,
          email: params.student.email ?? '',
          contact: params.student.phone ?? '',
        },
        theme: {
          color: '#2563eb',
        },
      },
    };
  }

  async verifyPayment(
    config: GatewayConfig,
    params: VerifyPaymentParams,
  ): Promise<PaymentVerificationResult> {
    if (!params.gatewayPaymentRef) {
      return {
        success: false,
        status: 'FAILED',
        gatewayPaymentRef: '',
        amount: 0,
        currency: 'INR',
        failureReason: 'Missing gateway payment reference',
        rawResponse: {},
      };
    }

    // Verify signature if provided
    if (params.gatewaySignature) {
      const expected = createHmac('sha256', config.secretKey)
        .update(`${params.orderReference}|${params.gatewayPaymentRef}`)
        .digest('hex');

      if (!safeEqual(expected, params.gatewaySignature)) {
        return {
          success: false,
          status: 'FAILED',
          gatewayPaymentRef: params.gatewayPaymentRef,
          amount: 0,
          currency: 'INR',
          failureReason: 'Payment signature mismatch',
          rawResponse: { signatureValid: false },
        };
      }
    }

    // Server-to-server query to verify payment status
    const url = `${this.#baseUrl}/payments/${encodeURIComponent(params.gatewayPaymentRef)}`;
    const res = await this.#fetch(url, {
      method: 'GET',
      headers: {
        Authorization: this.#getAuthHeader(config),
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        status: 'FAILED',
        gatewayPaymentRef: params.gatewayPaymentRef,
        amount: 0,
        currency: 'INR',
        failureReason: `Razorpay fetch payment failed: ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const data = (await res.json()) as {
      id: string;
      order_id?: string;
      status: string;
      amount: number;
      currency: string;
      method?: string;
      error_description?: string;
    };

    const isSuccess = data.status === 'captured' || data.status === 'authorized';

    return {
      success: isSuccess,
      status: isSuccess ? 'SUCCESS' : data.status === 'failed' ? 'FAILED' : 'PENDING',
      gatewayPaymentRef: data.id,
      amount: Number(data.amount),
      currency: data.currency,
      paymentMethod: data.method ? `RAZORPAY_${data.method.toUpperCase()}` : 'ONLINE_RAZORPAY',
      failureReason: isSuccess
        ? undefined
        : data.error_description || `Payment status: ${data.status}`,
      rawResponse: data as Record<string, unknown>,
    };
  }

  async processWebhook(
    config: GatewayConfig,
    params: WebhookVerificationParams,
  ): Promise<WebhookProcessResult> {
    const signature =
      params.headers['x-razorpay-signature'] || params.headers['X-Razorpay-Signature'];

    const secret = config.webhookSecret || config.secretKey;
    if (!signature || typeof signature !== 'string') {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Missing x-razorpay-signature header',
        rawEvent: {},
      };
    }

    const rawString =
      typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');

    const expected = createHmac('sha256', secret).update(rawString).digest('hex');
    if (!safeEqual(expected, signature)) {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Invalid webhook signature',
        rawEvent: {},
      };
    }

    let payload: {
      event?: string;
      payload?: {
        payment?: {
          entity?: {
            id?: string;
            order_id?: string;
            amount?: number;
            notes?: Record<string, string>;
          };
        };
        order?: { entity?: { id?: string; receipt?: string; amount?: number } };
        refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
      };
    };

    try {
      payload = JSON.parse(rawString);
    } catch {
      return {
        isValid: false,
        eventType: 'malformed_json',
        status: 'FAILED',
        failureReason: 'Malformed JSON webhook payload',
        rawEvent: {},
      };
    }

    const event = payload.event || 'unknown';
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const refundEntity = payload.payload?.refund?.entity;

    const gatewayPaymentRef = paymentEntity?.id || refundEntity?.payment_id;
    const orderReference = paymentEntity?.order_id || orderEntity?.id;
    const attemptReference = paymentEntity?.notes?.attempt_reference || orderEntity?.receipt;
    const amount = paymentEntity?.amount || refundEntity?.amount;

    if (event === 'payment.captured' || event === 'order.paid') {
      return {
        isValid: true,
        eventType: event,
        attemptReference,
        orderReference,
        gatewayPaymentRef,
        status: 'SUCCESS',
        amount,
        rawEvent: payload as Record<string, unknown>,
      };
    }

    if (event === 'payment.failed') {
      return {
        isValid: true,
        eventType: event,
        attemptReference,
        orderReference,
        gatewayPaymentRef,
        status: 'FAILED',
        amount,
        failureReason: 'Payment failed event from Razorpay',
        rawEvent: payload as Record<string, unknown>,
      };
    }

    if (event === 'refund.processed') {
      return {
        isValid: true,
        eventType: event,
        attemptReference,
        orderReference,
        gatewayPaymentRef,
        status: 'REFUNDED',
        amount,
        rawEvent: payload as Record<string, unknown>,
      };
    }

    return {
      isValid: true,
      eventType: event,
      status: 'IGNORED',
      rawEvent: payload as Record<string, unknown>,
    };
  }

  async initiateRefund(config: GatewayConfig, params: InitiateRefundParams): Promise<RefundResult> {
    const url = `${this.#baseUrl}/payments/${encodeURIComponent(params.gatewayPaymentRef)}/refund`;
    const payload = {
      amount: params.amount,
      notes: {
        reason: params.reason,
      },
    };

    const res = await this.#fetch(url, {
      method: 'POST',
      headers: {
        Authorization: this.#getAuthHeader(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        gatewayRefundRef: '',
        status: 'FAILED',
        failureReason: `Razorpay refund failed (${res.status}): ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const data = (await res.json()) as { id: string; status: string };

    return {
      success: true,
      gatewayRefundRef: data.id,
      status: data.status === 'processed' ? 'SUCCESS' : 'PENDING',
      rawResponse: data as Record<string, unknown>,
    };
  }

  async checkHealth(config: GatewayConfig): Promise<HealthCheckResult> {
    try {
      const url = `${this.#baseUrl}/payments?count=1`;
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: {
          Authorization: this.#getAuthHeader(config),
        },
      });

      if (!res.ok) {
        return {
          healthy: false,
          message: `Razorpay API returned status ${res.status}: Invalid credentials or unauthorized`,
        };
      }

      return {
        healthy: true,
        message: 'Successfully connected to Razorpay API',
        details: { mode: config.mode, merchantKey: config.merchantKey },
      };
    } catch (err) {
      return {
        healthy: false,
        message: `Failed to reach Razorpay API: ${(err as Error).message}`,
      };
    }
  }
}
