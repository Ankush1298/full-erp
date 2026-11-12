import type { IPaymentGatewayAdapter, PaymentGatewayProvider } from './types.js';
import { RazorpayAdapter } from './razorpay.adapter.js';
import { CashfreeAdapter } from './cashfree.adapter.js';
import { PhonePeAdapter } from './phonepe.adapter.js';
import { AppError } from '../../../shared/errors/http-errors.js';

export class PaymentGatewayRegistry {
  readonly #adapters: Map<PaymentGatewayProvider, IPaymentGatewayAdapter> = new Map();

  constructor(customAdapters?: Partial<Record<PaymentGatewayProvider, IPaymentGatewayAdapter>>) {
    this.#adapters.set('RAZORPAY', customAdapters?.RAZORPAY || new RazorpayAdapter());
    this.#adapters.set('CASHFREE', customAdapters?.CASHFREE || new CashfreeAdapter());
    this.#adapters.set('PHONEPE', customAdapters?.PHONEPE || new PhonePeAdapter());
  }

  getAdapter(provider: PaymentGatewayProvider): IPaymentGatewayAdapter {
    const adapter = this.#adapters.get(provider);
    if (!adapter) {
      throw new AppError(
        400,
        'UNSUPPORTED_GATEWAY',
        `Payment gateway provider ${provider} is not supported.`,
      );
    }
    return adapter;
  }

  registerAdapter(provider: PaymentGatewayProvider, adapter: IPaymentGatewayAdapter): void {
    this.#adapters.set(provider, adapter);
  }

  getSupportedProviders(): PaymentGatewayProvider[] {
    return Array.from(this.#adapters.keys());
  }
}

export const defaultGatewayRegistry = new PaymentGatewayRegistry();
