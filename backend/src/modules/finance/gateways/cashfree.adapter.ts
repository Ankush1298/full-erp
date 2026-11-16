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

export class CashfreeAdapter implements IPaymentGatewayAdapter {
  readonly provider = 'CASHFREE';
  readonly #fetchFn?: typeof fetch | undefined;
  readonly #apiVersion: string = '2023-08-01';

  constructor(options?: { fetchFn?: typeof fetch }) {
    this.#fetchFn = options?.fetchFn;
  }

  get #fetch(): typeof fetch {
    return this.#fetchFn ?? globalThis.fetch;
  }

  #getBaseUrl(config: GatewayConfig): string {
    return config.mode === 'LIVE'
      ? 'https://api.cashfree.com/pg'
      : 'https://sandbox.cashfree.com/pg';
  }

  #getHeaders(config: GatewayConfig): Record<string, string> {
    return {
      'x-client-id': config.merchantKey,
      'x-client-secret': config.secretKey,
      'x-api-version': this.#apiVersion,
      'Content-Type': 'application/json',
    };
  }

  async createOrder(config: GatewayConfig, params: CreateOrderParams): Promise<CreateOrderResult> {
    const baseUrl = this.#getBaseUrl(config);
    const url = `${baseUrl}/orders`;

    const payload = {
      order_id: params.attemptReference,
      order_amount: Number((params.amount / 100).toFixed(2)),
      order_currency: params.currency || 'INR',
      customer_details: {
        customer_id: params.student.id,
        customer_name: params.student.name,
        customer_email: params.student.email || 'student@example.com',
        customer_phone: params.student.phone || '9999999999',
      },
      order_meta: {
        return_url:
          params.returnUrl ||
          `https://example.com/payment/status?order_id=${params.attemptReference}`,
        notify_url: params.notifyUrl,
      },
      order_note: params.description,
    };

    const res = await this.#fetch(url, {
      method: 'POST',
      headers: this.#getHeaders(config),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cashfree createOrder failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      order_id: string;
      payment_session_id: string;
      order_status: string;
    };

    return {
      orderReference: data.order_id,
      paymentSessionId: data.payment_session_id,
      checkoutPayload: {
        provider: 'CASHFREE',
        payment_session_id: data.payment_session_id,
        order_id: data.order_id,
        mode: config.mode.toLowerCase(),
      },
    };
  }

  async verifyPayment(
    config: GatewayConfig,
    params: VerifyPaymentParams,
  ): Promise<PaymentVerificationResult> {
    const baseUrl = this.#getBaseUrl(config);
    const orderId = params.orderReference;
    const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}/payments`;

    const res = await this.#fetch(url, {
      method: 'GET',
      headers: this.#getHeaders(config),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        status: 'FAILED',
        gatewayPaymentRef: params.gatewayPaymentRef || '',
        amount: 0,
        currency: 'INR',
        failureReason: `Cashfree payment fetch failed: ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const payments = (await res.json()) as Array<{
      cf_payment_id: string | number;
      payment_status: string;
      order_amount: number;
      payment_currency: string;
      payment_method?: Record<string, unknown>;
      payment_message?: string;
    }>;

    if (!Array.isArray(payments) || payments.length === 0) {
      return {
        success: false,
        status: 'PENDING',
        gatewayPaymentRef: '',
        amount: 0,
        currency: 'INR',
        failureReason: 'No payment transaction records found for order',
        rawResponse: { payments },
      };
    }

    // Look for successful payment
    const successPayment = payments.find((p) => p.payment_status === 'SUCCESS');
    if (successPayment) {
      const amountPaise = Math.round(Number(successPayment.order_amount) * 100);
      return {
        success: true,
        status: 'SUCCESS',
        gatewayPaymentRef: String(successPayment.cf_payment_id),
        amount: amountPaise,
        currency: successPayment.payment_currency || 'INR',
        paymentMethod: 'ONLINE_CASHFREE',
        rawResponse: successPayment as Record<string, unknown>,
      };
    }

    const latest = payments[0]!;
    return {
      success: false,
      status: latest.payment_status === 'FAILED' ? 'FAILED' : 'PENDING',
      gatewayPaymentRef: String(latest.cf_payment_id),
      amount: Math.round(Number(latest.order_amount) * 100),
      currency: latest.payment_currency || 'INR',
      failureReason: latest.payment_message || `Payment status: ${latest.payment_status}`,
      rawResponse: latest as Record<string, unknown>,
    };
  }

  async processWebhook(
    config: GatewayConfig,
    params: WebhookVerificationParams,
  ): Promise<WebhookProcessResult> {
    const signature =
      params.headers['x-webhook-signature'] || params.headers['X-Webhook-Signature'];
    const timestamp =
      params.headers['x-webhook-timestamp'] || params.headers['X-Webhook-Timestamp'];

    if (!signature || typeof signature !== 'string') {
      return {
        isValid: false,
        eventType: 'unknown',
        status: 'FAILED',
        failureReason: 'Missing x-webhook-signature header',
        rawEvent: {},
      };
    }

    const rawString =
      typeof params.rawBody === 'string' ? params.rawBody : params.rawBody.toString('utf8');

    // Signature algorithm for Cashfree: HMAC-SHA256 of (timestamp + rawBody)
    const secret = config.webhookSecret || config.secretKey;
    const bodyToSign = timestamp ? `${timestamp}${rawString}` : rawString;
    const expected = createHmac('sha256', secret).update(bodyToSign).digest('base64');

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
      type?: string;
      event_time?: string;
      data?: {
        order?: { order_id?: string; order_amount?: number };
        payment?: {
          cf_payment_id?: string | number;
          payment_status?: string;
          payment_amount?: number;
          payment_message?: string;
        };
        refund?: {
          cf_refund_id?: string | number;
          refund_status?: string;
          refund_amount?: number;
        };
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

    const type = payload.type || 'unknown';
    const orderId = payload.data?.order?.order_id;
    const payment = payload.data?.payment;
    const refund = payload.data?.refund;

    const gatewayPaymentRef = payment?.cf_payment_id ? String(payment.cf_payment_id) : undefined;
    const amount = payment?.payment_amount
      ? Math.round(Number(payment.payment_amount) * 100)
      : undefined;

    if (type === 'PAYMENT_SUCCESS_WEBHOOK') {
      return {
        isValid: true,
        eventType: type,
        attemptReference: orderId,
        orderReference: orderId,
        gatewayPaymentRef,
        status: 'SUCCESS',
        amount,
        rawEvent: payload as Record<string, unknown>,
      };
    }

    if (type === 'PAYMENT_FAILED_WEBHOOK') {
      return {
        isValid: true,
        eventType: type,
        attemptReference: orderId,
        orderReference: orderId,
        gatewayPaymentRef,
        status: 'FAILED',
        amount,
        failureReason: payment?.payment_message || 'Payment failed',
        rawEvent: payload as Record<string, unknown>,
      };
    }

    if (type === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      return {
        isValid: true,
        eventType: type,
        attemptReference: orderId,
        orderReference: orderId,
        gatewayPaymentRef,
        status: 'FAILED',
        failureReason: 'User dropped checkout session',
        rawEvent: payload as Record<string, unknown>,
      };
    }

    if (type === 'REFUND_STATUS_WEBHOOK') {
      return {
        isValid: true,
        eventType: type,
        attemptReference: orderId,
        orderReference: orderId,
        gatewayPaymentRef: refund?.cf_refund_id ? String(refund.cf_refund_id) : undefined,
        status: 'REFUNDED',
        amount: refund?.refund_amount ? Math.round(Number(refund.refund_amount) * 100) : undefined,
        rawEvent: payload as Record<string, unknown>,
      };
    }

    return {
      isValid: true,
      eventType: type,
      status: 'IGNORED',
      rawEvent: payload as Record<string, unknown>,
    };
  }

  async initiateRefund(config: GatewayConfig, params: InitiateRefundParams): Promise<RefundResult> {
    const baseUrl = this.#getBaseUrl(config);
    const orderId = params.orderReference || params.gatewayPaymentRef;
    const url = `${baseUrl}/orders/${encodeURIComponent(orderId)}/refunds`;

    const refundId = `rfnd_${Date.now()}`;
    const payload = {
      refund_amount: Number((params.amount / 100).toFixed(2)),
      refund_id: refundId,
      refund_note: params.reason,
    };

    const res = await this.#fetch(url, {
      method: 'POST',
      headers: this.#getHeaders(config),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        success: false,
        gatewayRefundRef: '',
        status: 'FAILED',
        failureReason: `Cashfree refund failed (${res.status}): ${errText}`,
        rawResponse: { error: errText },
      };
    }

    const data = (await res.json()) as {
      cf_refund_id: string | number;
      refund_status: string;
    };

    return {
      success: true,
      gatewayRefundRef: String(data.cf_refund_id || refundId),
      status: data.refund_status === 'SUCCESS' ? 'SUCCESS' : 'PENDING',
      rawResponse: data as Record<string, unknown>,
    };
  }

  async checkHealth(config: GatewayConfig): Promise<HealthCheckResult> {
    try {
      const baseUrl = this.#getBaseUrl(config);
      const url = `${baseUrl}/orders?limit=1`;
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: this.#getHeaders(config),
      });

      if (!res.ok) {
        return {
          healthy: false,
          message: `Cashfree API returned status ${res.status}: Invalid credentials or unauthorized`,
        };
      }

      return {
        healthy: true,
        message: 'Successfully connected to Cashfree API',
        details: { mode: config.mode, merchantKey: config.merchantKey },
      };
    } catch (err) {
      return {
        healthy: false,
        message: `Failed to reach Cashfree API: ${(err as Error).message}`,
      };
    }
  }
}
