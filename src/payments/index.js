import { createMockPayments } from './mock.js';

export async function createPaymentProvider(cfg, { publicUrl, returnUrl }) {
  switch (cfg.provider) {
    case 'stripe': {
      const { createStripePayments } = await import('./stripe.js');
      return createStripePayments({
        secretKey: cfg.stripeSecretKey, webhookSecret: cfg.stripeWebhookSecret, publicUrl, returnUrl,
      });
    }
    case 'mock':
      return createMockPayments({ publicUrl });
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${cfg.provider}" (use mock or stripe)`);
  }
}
