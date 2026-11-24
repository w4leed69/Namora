/**
 * Mock payments: the "payment link" is a local page with a Pay button
 * (see /pay/mock/:id in server.js). Use it to test the full flow end to end.
 */
export function createMockPayments({ publicUrl }) {
  return {
    name: 'mock',
    async createCheckout({ booking }) {
      return { id: `mock_pay_${booking.id}`, url: `${publicUrl}/pay/mock/${booking.id}` };
    },
    async refund(booking) {
      console.log(`[payments:mock] refunded ${booking.currency} ${booking.amount} for ${booking.id}`);
      return { id: `mock_refund_${booking.id}` };
    },
    async cancelCheckout() {},
    parseWebhook() {
      return null;
    },
  };
}
