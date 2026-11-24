import Stripe from 'stripe';
import { minorUnits } from '../util/pricing.js';

/**
 * Stripe Checkout. The bot sends a "Pay now" button; the hosted page opens in
 * WhatsApp's in-app browser (cards, Apple Pay, Google Pay), so the customer never
 * leaves WhatsApp. Stripe calls /webhook/stripe when payment succeeds.
 */
export function createStripePayments({ secretKey, webhookSecret, publicUrl, returnUrl }) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
  const stripe = new Stripe(secretKey);

  return {
    name: 'stripe',

    async createCheckout({ booking, description, customerEmail }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: customerEmail,
        client_reference_id: booking.id,
        metadata: { bookingId: booking.id },
        payment_intent_data: { metadata: { bookingId: booking.id } },
        line_items: [{
          quantity: 1,
          price_data: {
            currency: booking.currency.toLowerCase(),
            unit_amount: Math.round(booking.amount * minorUnits(booking.currency)),
            product_data: { name: description },
          },
        }],
        // Stripe requires >= 30 minutes; airline fares are usually held about that long too.
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        success_url: returnUrl ?? `${publicUrl}/pay/done?booking=${booking.id}`,
        cancel_url: returnUrl ?? `${publicUrl}/pay/cancelled?booking=${booking.id}`,
      });
      return { id: session.id, url: session.url };
    },

    async refund(booking) {
      if (!booking.paymentIntent) throw new Error(`No payment intent recorded for ${booking.id}`);
      return stripe.refunds.create({ payment_intent: booking.paymentIntent, metadata: { bookingId: booking.id } });
    },

    async cancelCheckout(booking) {
      if (booking.paymentRef) await stripe.checkout.sessions.expire(booking.paymentRef).catch(() => {});
    },

    /** Verify the Stripe signature and turn the event into { type, bookingId, ... } or null. */
    parseWebhook(rawBody, signature) {
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      const event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
      const s = event.data.object;
      if (
        (event.type === 'checkout.session.completed' && s.payment_status === 'paid') ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        return { type: 'paid', bookingId: s.metadata?.bookingId, paymentIntent: s.payment_intent, eventId: event.id };
      }
      if (event.type === 'checkout.session.expired') {
        return { type: 'expired', bookingId: s.metadata?.bookingId, eventId: event.id };
      }
      return null;
    },
  };
}
