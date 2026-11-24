import express from 'express';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createStore } from './store.js';
import { createBot } from './bot/conversation.js';
import { createFlightProvider } from './flights/index.js';
import { createPaymentProvider } from './payments/index.js';
import { createWhatsAppClient } from './whatsapp/client.js';
import { parseIncoming, verifySignature } from './whatsapp/webhook.js';
import { formatMoney } from './util/pricing.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f0f2f5;margin:0;padding:24px 16px;color:#111b21}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:20px;margin:0 0 12px}.amt{font-size:32px;font-weight:700;margin:16px 0}.muted{color:#667781;font-size:14px}
button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;background:#25d366;color:#fff;border:0;border-radius:24px;padding:14px;font-size:16px;font-weight:600;text-decoration:none;margin-top:16px;cursor:pointer}
</style></head><body><div class="card">${body}</div></body></html>`;
}

/** Build the Express app. All dependencies are injectable for tests. */
export async function createApp(overrides = {}) {
  const cfg = overrides.config ?? config;
  const log = overrides.log ?? console;
  const store = overrides.store ?? createStore(cfg.dataFile);
  const flights = overrides.flights ?? createFlightProvider(cfg.flights);
  const waLink = cfg.whatsapp.displayNumber ? `https://wa.me/${cfg.whatsapp.displayNumber.replace(/\D/g, '')}` : null;
  const payments = overrides.payments ?? (await createPaymentProvider(cfg.payments, { publicUrl: cfg.publicUrl }));
  const whatsapp = overrides.whatsapp ?? createWhatsAppClient({ ...cfg.whatsapp, log });

  const bot = createBot({ flights, payments, store, config: cfg, log, notify: (to, msgs) => whatsapp.send(to, msgs) });

  // Process each user's events strictly in order (fast double-taps, payment webhooks…).
  const queues = new Map();
  const enqueue = (userId, task) => {
    const prev = queues.get(userId) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => log.error('[queue]', err));
    queues.set(userId, next);
    next.finally(() => queues.get(userId) === next && queues.delete(userId));
    return next;
  };

  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => res.json({ ok: true, flights: flights.name, payments: payments.name }));

  // ── WhatsApp webhook ──
  app.get('/webhook/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.whatsapp.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.sendStatus(403);
  });

  app.post(
    '/webhook/whatsapp',
    express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    (req, res) => {
      if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), cfg.whatsapp.appSecret)) {
        log.warn('[whatsapp] rejected webhook with bad signature');
        return res.sendStatus(401);
      }
      res.sendStatus(200); // acknowledge fast; Meta retries slow webhooks
      for (const msg of parseIncoming(req.body)) {
        if (!store.markSeen(msg.id)) continue;
        enqueue(msg.from, async () => {
          whatsapp.markRead?.(msg.id);
          if (msg.text === null && msg.replyId === null) {
            return whatsapp.send(msg.from, [{ type: 'text', text: 'I can only read text messages for now. Type *menu* to get started.' }]);
          }
          return bot.handle(msg.from, { text: msg.text, replyId: msg.replyId, profileName: msg.profileName });
        });
      }
    },
  );

  // ── Stripe webhook ──
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = payments.parseWebhook(req.body, req.get('stripe-signature'));
    } catch (err) {
      log.warn('[stripe] webhook rejected:', err.message);
      return res.status(400).send(`Webhook error: ${err.message}`);
    }
    res.json({ received: true });
    if (!event?.bookingId || (event.eventId && !store.markSeen(event.eventId))) return;
    const booking = store.getBooking(event.bookingId);
    if (!booking) return log.warn(`[stripe] unknown booking ${event.bookingId}`);
    if (event.type === 'paid') enqueue(booking.userId, () => bot.onPaymentSucceeded(event.bookingId, { paymentIntent: event.paymentIntent }));
    if (event.type === 'expired') enqueue(booking.userId, () => bot.onPaymentExpired(event.bookingId));
  });

  // ── Payment return pages (shown in WhatsApp's in-app browser) ──
  const backButton = waLink ? `<a class="btn" href="${esc(waLink)}">Back to WhatsApp</a>` : '<p class="muted">You can close this page and return to WhatsApp.</p>';
  app.get('/pay/done', (_req, res) =>
    res.send(page('Payment received', `<h1>✅ Payment received</h1><p>We're issuing your ticket now. Your booking confirmation will arrive in WhatsApp in a moment.</p>${backButton}`)));
  app.get('/pay/cancelled', (_req, res) =>
    res.send(page('Payment cancelled', `<h1>Payment not completed</h1><p>No money was taken. You can tap <b>Pay now</b> in WhatsApp again while the link is valid.</p>${backButton}`)));

  // ── Mock checkout (PAYMENT_PROVIDER=mock only) ──
  if (payments.name === 'mock') {
    app.get('/pay/mock/:id', (req, res) => {
      const b = store.getBooking(req.params.id);
      if (!b) return res.status(404).send(page('Not found', '<h1>Booking not found</h1>'));
      if (b.status !== 'pending_payment') {
        return res.send(page('Already handled', `<h1>Booking ${esc(b.id)}</h1><p>Status: <b>${esc(b.status)}</b></p>${backButton}`));
      }
      res.send(page('Checkout', `<h1>${esc(cfg.brandName)} checkout</h1>
        <p class="muted">Booking ${esc(b.id)} · ${esc(b.search.origin.code)} → ${esc(b.search.destination.code)}</p>
        <div class="amt">${esc(formatMoney(b.amount, b.currency))}</div>
        <p class="muted">⚠️ Test mode: no real card is charged.</p>
        <form method="post" action="/pay/mock/${encodeURIComponent(b.id)}"><button type="submit">Pay now</button></form>`));
    });
    app.post('/pay/mock/:id', (req, res) => {
      const b = store.getBooking(req.params.id);
      if (!b) return res.sendStatus(404);
      enqueue(b.userId, () => bot.onPaymentSucceeded(b.id, { paymentIntent: `mock_pi_${b.id}` }));
      res.redirect(303, '/pay/done');
    });
  }

  return { app, bot, store, enqueue };
}

// Run directly: `node src/server.js`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { app, store } = await createApp();
  const server = app.listen(config.port, () => {
    console.log(`✈️  ${config.brandName} WhatsApp bot listening on :${config.port}`);
    console.log(`   flights=${config.flights.provider} payments=${config.payments.provider} public=${config.publicUrl}`);
    console.log(`   WhatsApp webhook: ${config.publicUrl}/webhook/whatsapp`);
    if (config.payments.provider === 'stripe') console.log(`   Stripe webhook:   ${config.publicUrl}/webhook/stripe`);
    if (!config.whatsapp.appSecret) console.warn('   ⚠️  WHATSAPP_APP_SECRET not set: webhook signatures are NOT verified');
  });
  const shutdown = () => {
    store.flush();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
