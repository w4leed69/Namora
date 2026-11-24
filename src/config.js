// Central configuration, read from environment variables (.env is loaded if present).
try {
  process.loadEnvFile?.();
} catch {
  /* no .env file — fine */
}

const env = (name, fallback = undefined) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

export const config = {
  port: Number(env('PORT', 3000)),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  brandName: env('BRAND_NAME', 'Namora'),
  supportContact: env('SUPPORT_CONTACT', ''),
  dataFile: env('DATA_FILE', 'data/db.json'),

  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN', 'change-me'),
    appSecret: env('WHATSAPP_APP_SECRET'),
    apiVersion: env('WHATSAPP_API_VERSION', 'v24.0'),
    // Public number customers message, used for "back to WhatsApp" links (digits only).
    displayNumber: env('WHATSAPP_DISPLAY_NUMBER', ''),
  },

  flights: {
    provider: env('FLIGHT_PROVIDER', 'mock'), // mock | duffel
    duffelToken: env('DUFFEL_ACCESS_TOKEN'),
    cabinClass: env('CABIN_CLASS', 'economy'),
    maxResults: Number(env('MAX_RESULTS', 10)),
  },

  payments: {
    provider: env('PAYMENT_PROVIDER', 'mock'), // mock | stripe
    stripeSecretKey: env('STRIPE_SECRET_KEY'),
    stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  },

  pricing: {
    markupPercent: Number(env('MARKUP_PERCENT', 0)),
    serviceFee: Number(env('SERVICE_FEE', 0)), // flat, in the offer currency, per booking
  },
};
