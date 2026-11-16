export type PaymentGatewayProvider = 'RAZORPAY' | 'CASHFREE' | 'PHONEPE';
export type GatewayMode = 'SANDBOX' | 'LIVE';

export interface GatewayConfig {
  id: string;
  organizationId: string;
  campusId: string | null;
  provider: PaymentGatewayProvider;
  mode: GatewayMode;
  isActive: boolean;
  merchantKey: string;
  secretKey: string;
  webhookSecret: string | null;
  settings: Record<string, unknown>;
}

export interface CreateOrderParams {
  attemptReference: string;
  amount: number; // In minor units (paise)
  currency: string;
  student: {
    id: string;
    name: string;
    email?: string | undefined;
    phone?: string | undefined;
  };
  description: string;
  returnUrl?: string | undefined;
  notifyUrl?: string | undefined;
}

export interface CreateOrderResult {
  orderReference: string;
  paymentSessionId?: string | undefined;
  redirectUrl?: string | undefined;
  checkoutPayload: Record<string, unknown>;
}

export interface VerifyPaymentParams {
  orderReference: string;
  attemptReference?: string | undefined;
  gatewayPaymentRef?: string | undefined;
  gatewaySignature?: string | undefined;
  rawPayload?: Record<string, unknown> | undefined;
}

export interface PaymentVerificationResult {
  success: boolean;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED';
  gatewayPaymentRef: string;
  amount: number;
  currency: string;
  paymentMethod?: string | undefined;
  failureReason?: string | undefined;
  rawResponse: Record<string, unknown>;
}

export interface WebhookVerificationParams {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Buffer;
}

export interface WebhookProcessResult {
  isValid: boolean;
  eventType: string;
  attemptReference?: string | undefined;
  orderReference?: string | undefined;
  gatewayPaymentRef?: string | undefined;
  status: 'SUCCESS' | 'FAILED' | 'REFUNDED' | 'IGNORED' | 'PENDING';
  amount?: number | undefined;
  failureReason?: string | undefined;
  rawEvent: Record<string, unknown>;
}

export interface InitiateRefundParams {
  gatewayPaymentRef: string;
  orderReference?: string | undefined;
  amount: number; // Minor units
  currency: string;
  reason: string;
}

export interface RefundResult {
  success: boolean;
  gatewayRefundRef: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  failureReason?: string | undefined;
  rawResponse: Record<string, unknown>;
}

export interface HealthCheckResult {
  healthy: boolean;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface IPaymentGatewayAdapter {
  readonly provider: PaymentGatewayProvider;
  createOrder(config: GatewayConfig, params: CreateOrderParams): Promise<CreateOrderResult>;
  verifyPayment(
    config: GatewayConfig,
    params: VerifyPaymentParams,
  ): Promise<PaymentVerificationResult>;
  processWebhook(
    config: GatewayConfig,
    params: WebhookVerificationParams,
  ): Promise<WebhookProcessResult>;
  initiateRefund(config: GatewayConfig, params: InitiateRefundParams): Promise<RefundResult>;
  checkHealth(config: GatewayConfig): Promise<HealthCheckResult>;
}
