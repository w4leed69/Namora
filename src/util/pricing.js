import { config } from '../config.js';

// Currencies with no minor unit (Stripe "zero-decimal" list, common subset).
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'PYG', 'UGX', 'XAF', 'XOF', 'ISK']);

export const minorUnits = (currency) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100);

/** What the customer pays: airline fare + markup + service fee, rounded up. */
export function customerPrice(offer, pricing = config.pricing) {
  const base = Number(offer.totalAmount);
  const raw = base * (1 + (pricing.markupPercent || 0) / 100) + (pricing.serviceFee || 0);
  const unit = minorUnits(offer.currency);
  const amount = Math.ceil(raw * unit - 1e-9) / unit;
  return { amount, currency: offer.currency, base };
}

export function formatMoney(amount, currency) {
  const digits = minorUnits(currency) === 1 ? 0 : 2;
  const n = Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: Number(amount) % 1 === 0 ? 0 : digits,
    maximumFractionDigits: digits,
  });
  return `${currency} ${n}`;
}
