import { createHmac, createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CashfreeAdapter } from '../../src/modules/finance/gateways/cashfree.adapter.js';
import { defaultGatewayRegistry } from '../../src/modules/finance/gateways/gateway-registry.js';
import { PhonePeAdapter } from '../../src/modules/finance/gateways/phonepe.adapter.js';
import { RazorpayAdapter } from '../../src/modules/finance/gateways/razorpay.adapter.js';
import type { GatewayConfig } from '../../src/modules/finance/gateways/types.js';

describe('Payment Gateway Adapters Unit Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('PaymentGatewayRegistry', () => {
    it('returns correct adapter instances for supported providers', () => {
      expect(defaultGatewayRegistry.getAdapter('RAZORPAY')).toBeInstanceOf(RazorpayAdapter);
      expect(defaultGatewayRegistry.getAdapter('CASHFREE')).toBeInstanceOf(CashfreeAdapter);
      expect(defaultGatewayRegistry.getAdapter('PHONEPE')).toBeInstanceOf(PhonePeAdapter);
      expect(defaultGatewayRegistry.getSupportedProviders()).toEqual([
        'RAZORPAY',
        'CASHFREE',
        'PHONEPE',
      ]);
    });

    it('throws error for unsupported provider', () => {
      expect(() =>
        // @ts-expect-error testing invalid provider
        defaultGatewayRegistry.getAdapter('STRIPE'),
      ).toThrow(/not supported/);
    });
  });

  describe('RazorpayAdapter', () => {
    const config: GatewayConfig = {
      id: 'cfg_rzp_1',
      organizationId: 'org_1',
      campusId: 'camp_1',
      provider: 'RAZORPAY',
      mode: 'SANDBOX',
      isActive: true,
      merchantKey: 'rzp_test_key_123',
      secretKey: 'rzp_test_secret_abc',
      webhookSecret: 'rzp_wh_secret_xyz',
      settings: {},
    };

    it('creates an order via createOrder', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'order_rzp_99999',
          amount: 500000,
          currency: 'INR',
          status: 'created',
        }),
      } as unknown as Response);

      const adapter = new RazorpayAdapter({ fetchFn: mockFetch });
      const res = await adapter.createOrder(config, {
        attemptReference: 'att_anesa_123',
        amount: 500000,
        currency: 'INR',
        description: 'Term Fee',
        student: { id: 'st-1', name: 'Aarav Patel' },
      });

      expect(res.orderReference).toBe('order_rzp_99999');
      expect(res.checkoutPayload).toMatchObject({
        key: 'rzp_test_key_123',
        amount: 500000,
        currency: 'INR',
        order_id: 'order_rzp_99999',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.razorpay.com/v1/orders',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    it('verifies razorpay payment signature and status via verifyPayment', async () => {
      const orderId = 'order_rzp_99999';
      const paymentId = 'pay_rzp_11111';
      const expectedSig = createHmac('sha256', config.secretKey)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: paymentId,
          order_id: orderId,
          status: 'captured',
          amount: 500000,
          currency: 'INR',
          method: 'upi',
        }),
      } as unknown as Response);

      const adapter = new RazorpayAdapter({ fetchFn: mockFetch });
      const verification = await adapter.verifyPayment(config, {
        attemptReference: 'att_anesa_123',
        orderReference: orderId,
        gatewayPaymentRef: paymentId,
        gatewaySignature: expectedSig,
      });

      expect(verification.success).toBe(true);
      expect(verification.status).toBe('SUCCESS');
      expect(verification.gatewayPaymentRef).toBe(paymentId);
    });

    it('fails verification on tampered signature without calling server', async () => {
      const mockFetch = vi.fn();
      const adapter = new RazorpayAdapter({ fetchFn: mockFetch });
      const verification = await adapter.verifyPayment(config, {
        attemptReference: 'att_anesa_123',
        orderReference: 'order_rzp_99999',
        gatewayPaymentRef: 'pay_rzp_11111',
        gatewaySignature: 'tampered_signature_hex',
      });

      expect(verification.success).toBe(false);
      expect(verification.failureReason).toContain('signature mismatch');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('processes webhook with valid signature and payment.captured event', async () => {
      const adapter = new RazorpayAdapter();
      const rawPayload = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_wh_123',
              order_id: 'order_rzp_99999',
              amount: 500000,
              notes: {
                attempt_reference: 'att_anesa_123',
              },
            },
          },
        },
      });

      const validSig = createHmac('sha256', config.webhookSecret!).update(rawPayload).digest('hex');

      const res = await adapter.processWebhook(config, {
        rawBody: rawPayload,
        headers: {
          'x-razorpay-signature': validSig,
        },
      });

      expect(res.isValid).toBe(true);
      expect(res.eventType).toBe('payment.captured');
      expect(res.status).toBe('SUCCESS');
      expect(res.gatewayPaymentRef).toBe('pay_wh_123');
      expect(res.attemptReference).toBe('att_anesa_123');
    });
  });

  describe('CashfreeAdapter', () => {
    const config: GatewayConfig = {
      id: 'cfg_cf_1',
      organizationId: 'org_1',
      campusId: 'camp_1',
      provider: 'CASHFREE',
      mode: 'SANDBOX',
      isActive: true,
      merchantKey: 'CF_APP_KEY_123',
      secretKey: 'CF_SECRET_KEY_abc',
      webhookSecret: 'CF_WH_SECRET_xyz',
      settings: {},
    };

    it('creates an order session via createOrder', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          cf_order_id: 'cf_ord_88888',
          order_id: 'cf_ord_ref_123',
          payment_session_id: 'session_token_xyz',
          order_status: 'ACTIVE',
        }),
      } as unknown as Response);

      const adapter = new CashfreeAdapter({ fetchFn: mockFetch });
      const res = await adapter.createOrder(config, {
        attemptReference: 'att_cf_123',
        amount: 250000,
        currency: 'INR',
        description: 'Quarterly Fees',
        student: { id: 'st-2', name: 'Diya Sharma' },
      });

      expect(res.orderReference).toBe('cf_ord_ref_123');
      expect(res.paymentSessionId).toBe('session_token_xyz');
      expect(res.checkoutPayload).toMatchObject({
        payment_session_id: 'session_token_xyz',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://sandbox.cashfree.com/pg/orders',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-client-id': 'CF_APP_KEY_123',
            'x-client-secret': 'CF_SECRET_KEY_abc',
            'x-api-version': '2023-08-01',
          }),
        }),
      );
    });

    it('verifies cashfree order payments status via verifyPayment', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            cf_payment_id: 'cf_pay_9999',
            payment_status: 'SUCCESS',
            order_amount: 2500.0,
            payment_currency: 'INR',
          },
        ],
      } as unknown as Response);

      const adapter = new CashfreeAdapter({ fetchFn: mockFetch });
      const verification = await adapter.verifyPayment(config, {
        attemptReference: 'att_cf_123',
        orderReference: 'cf_ord_ref_123',
      });

      expect(verification.success).toBe(true);
      expect(verification.status).toBe('SUCCESS');
      expect(verification.gatewayPaymentRef).toBe('cf_pay_9999');
      expect(verification.amount).toBe(250000); // Converted to minor units (paise)
    });

    it('processes cashfree timestamped webhook signature via processWebhook', async () => {
      const adapter = new CashfreeAdapter();
      const rawPayload = JSON.stringify({
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        data: {
          order: {
            order_id: 'cf_ord_ref_123',
            order_tags: {
              attempt_reference: 'att_cf_123',
            },
          },
          payment: {
            cf_payment_id: 'cf_pay_9999',
            payment_status: 'SUCCESS',
            payment_amount: 2500.0,
          },
        },
      });

      const timestamp = '1700000000';
      const expectedSig = createHmac('sha256', config.webhookSecret!)
        .update(timestamp + rawPayload)
        .digest('base64');

      const res = await adapter.processWebhook(config, {
        rawBody: rawPayload,
        headers: {
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': expectedSig,
        },
      });

      expect(res.isValid).toBe(true);
      expect(res.eventType).toBe('PAYMENT_SUCCESS_WEBHOOK');
      expect(res.status).toBe('SUCCESS');
      expect(res.gatewayPaymentRef).toBe('cf_pay_9999');
      expect(res.orderReference).toBe('cf_ord_ref_123');
    });
  });

  describe('PhonePeAdapter', () => {
    const config: GatewayConfig = {
      id: 'cfg_pp_1',
      organizationId: 'org_1',
      campusId: 'camp_1',
      provider: 'PHONEPE',
      mode: 'SANDBOX',
      isActive: true,
      merchantKey: 'PGTESTPAYUAT',
      secretKey: '099eb0cd-02cf-4e2a-8aca-3e6c6aff0399',
      webhookSecret: null,
      settings: { salt_index: '1' },
    };

    it('creates an order with base64 payload and sha256 checksum', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          code: 'PAYMENT_INITIATED',
          message: 'Payment Initiated',
          data: {
            merchantTransactionId: 'att_pp_123',
            instrumentResponse: {
              redirectInfo: {
                url: 'https://mercury-uat.phonepe.com/transact/simulator?token=abc',
              },
            },
          },
        }),
      } as unknown as Response);

      const adapter = new PhonePeAdapter({ fetchFn: mockFetch });
      const res = await adapter.createOrder(config, {
        attemptReference: 'att_pp_123',
        amount: 150000,
        currency: 'INR',
        description: 'Semester 1 fees',
        student: { id: 'st-3', name: 'Rohan Gupta' },
      });

      expect(res.orderReference).toBe('att_pp_123');
      expect(res.redirectUrl).toBe('https://mercury-uat.phonepe.com/transact/simulator?token=abc');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api-preprod.phonepe.com/apis/pg-sandbox/pg/v1/pay',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-VERIFY': expect.stringMatching(/###1$/),
          }),
        }),
      );
    });

    it('verifies PhonePe status response via verifyPayment', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          code: 'PAYMENT_SUCCESS',
          message: 'Payment Success',
          data: {
            merchantTransactionId: 'att_pp_123',
            transactionId: 'T2308151234567890',
            amount: 150000,
            state: 'COMPLETED',
            responseCode: 'SUCCESS',
            paymentInstrument: {
              type: 'UPI',
            },
          },
        }),
      } as unknown as Response);

      const adapter = new PhonePeAdapter({ fetchFn: mockFetch });
      const verification = await adapter.verifyPayment(config, {
        attemptReference: 'att_pp_123',
        orderReference: 'att_pp_123',
      });

      expect(verification.success).toBe(true);
      expect(verification.status).toBe('SUCCESS');
      expect(verification.gatewayPaymentRef).toBe('T2308151234567890');
      expect(verification.paymentMethod).toBe('PHONEPE_UPI');
    });

    it('processes PhonePe webhook with valid checksum', async () => {
      const adapter = new PhonePeAdapter();
      const innerResponse = JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: {
          merchantTransactionId: 'att_pp_123',
          transactionId: 'T2308151234567890',
          amount: 150000,
          state: 'COMPLETED',
        },
      });

      const base64Response = Buffer.from(innerResponse).toString('base64');
      const rawBody = JSON.stringify({ response: base64Response });
      const expectedChecksum =
        createHash('sha256')
          .update(base64Response + config.secretKey)
          .digest('hex') + '###1';

      const res = await adapter.processWebhook(config, {
        rawBody,
        headers: {
          'x-verify': expectedChecksum,
        },
      });

      expect(res.isValid).toBe(true);
      expect(res.status).toBe('SUCCESS');
      expect(res.gatewayPaymentRef).toBe('T2308151234567890');
      expect(res.attemptReference).toBe('att_pp_123');
    });
  });
});
