# Namora: book flights inside WhatsApp ✈️💬

A WhatsApp bot where customers **search flights, choose one, enter traveller details, pay, and get their
booking reference (PNR)** without leaving the chat.

```
Customer: Lahore to Dubai 25 Dec for 2
Bot:      ✈️ Lahore (LHE) → Dubai (DXB) · Fri 25 Dec · 2 adults
          [View flights ☰]   1. USD 615 · Emirates · 03:15→05:40 · nonstop …
Customer: (taps a flight) → Book this flight
Bot:      👤 Traveller 1 of 2: full name? … date of birth? … passport? …
Bot:      📝 Please check your booking … 💰 Total: USD 615   [Confirm & pay]
Bot:      🧾 Booking NM1A2B3C  [Pay now]   ← opens checkout inside WhatsApp
Bot:      🎉 Your flight is booked! PNR: XYZ123
```

## How it works

```
 WhatsApp user ─▶ Meta Cloud API ─▶ POST /webhook/whatsapp ─▶ Bot (state machine)
                                                               │      │
                                     Duffel (search + ticket) ◀┘      └▶ Stripe Checkout (pay)
                                                               ▲                │
                     ticket issued, PNR sent to WhatsApp ◀─────┴── POST /webhook/stripe
```

| Piece | Default | Production option |
|---|---|---|
| Messaging | dry-run (logs) | **WhatsApp Cloud API** (Meta) with interactive lists and buttons |
| Flights | `mock` (realistic fake fares) | **Duffel**: 300+ airlines, real ticket issuing |
| Payments | `mock` (local checkout page) | **Stripe Checkout**: cards, Apple Pay, Google Pay |
| Storage | JSON file (`data/db.json`) | Swap `src/store.js` for Postgres/Redis to run more than one instance |

**Money flow:** the customer pays *you* through Stripe. When payment succeeds, the bot re-checks the fare and
issues the ticket from your Duffel balance. If ticketing fails (sold out, price changed), **the customer gets an
automatic full refund** and a message explaining what happened. Your margin comes from `MARKUP_PERCENT`
and `SERVICE_FEE`.

### Features
- One-line search (`Karachi to Jeddah 10 Jan returning 20 Jan for 3`) or step-by-step prompts
- City or airport-code lookup, with a pick-list for cities with several airports (London → LHR/LGW/STN…)
- One-way and return trips, 1–9 adults, results sorted by price, type a new date to re-search
- Flight details: stops, durations, baggage, refund and change rules
- Traveller details are validated (name, DOB, adults 18+, gender, and passport + expiry for international trips,
  with a warning when the passport expires within 6 months of travel)
- Remembers the customer's email for next time
- Live price re-check before payment; asks the customer again if the price changed
- Payment link expiry, cancel at any time, *my bookings* history
- Webhook signature verification (Meta and Stripe), duplicate-message protection, per-user ordered processing

## Try it in 30 seconds (no accounts needed)

```bash
npm install
npm run chat      # chat with the bot in your terminal (mock flights + mock payment)
```
Type `hi`. Buttons and list items are numbered, so type the number to tap one. At the payment link, type `/pay`.

```bash
npm test          # 25 tests: parsers, full conversations, refunds, webhooks, Duffel adapter
```

## Going live

### 1. Run the server
```bash
cp .env.example .env     # fill in values as you go through the steps below
npm start                # or: docker build -t namora . && docker run -p 3000:3000 --env-file .env -v $PWD/data:/app/data namora
```
It needs a public **HTTPS** URL (e.g. Render, Railway, Fly.io or a VPS behind Caddy/Nginx). For local testing
use `ngrok http 3000`. Set `PUBLIC_URL` to that URL.

### 2. WhatsApp Cloud API
1. Create an app at <https://developers.facebook.com> → *Business* type → add the **WhatsApp** product.
2. From *WhatsApp → API Setup*, copy the **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`.
3. Create a **permanent token**: Business Settings → System users → add one with `whatsapp_business_messaging`
   permission → generate a token → `WHATSAPP_TOKEN`. (The 24-hour test token works for a first try.)
4. *App settings → Basic* → **App secret** → `WHATSAPP_APP_SECRET`.
5. *WhatsApp → Configuration → Webhook*: callback URL `https://YOUR_URL/webhook/whatsapp`,
   verify token = your `WHATSAPP_VERIFY_TOKEN`, then subscribe to the **messages** field.
6. Add your real business number and complete Meta Business verification to message any customer.

### 3. Flights with Duffel
1. Sign up at <https://duffel.com> and create a **test** access token → `DUFFEL_ACCESS_TOKEN`, then set
   `FLIGHT_PROVIDER=duffel`. Test mode books against "Duffel Airways" with fake money.
   Check the key with a live search: `npm run duffel:check -- LHE DXB 2026-12-25`.
   Prices come back in your Duffel account's balance currency (set in the Duffel dashboard), which is also
   the currency customers are charged in.
2. To sell real tickets: complete Duffel's onboarding, top up your **balance**, and switch to a `duffel_live_` token.

### 4. Payments with Stripe
1. Get your secret key → `STRIPE_SECRET_KEY`, and set `PAYMENT_PROVIDER=stripe`.
2. Developers → Webhooks → add endpoint `https://YOUR_URL/webhook/stripe` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`.
   Copy the signing secret → `STRIPE_WEBHOOK_SECRET`.

The payment page opens in WhatsApp's in-app browser, so customers never switch apps.

> **Selling from Pakistan or another country where Stripe isn't available?** Add a provider in
> `src/payments/` with the same four methods (`createCheckout`, `refund`, `cancelCheckout`, `parseWebhook`).
> Local gateways such as Safepay, PayFast, JazzCash or Easypaisa (Pakistan), or Paystack/Flutterwave (Africa),
> all support hosted checkout links. Register it in `src/payments/index.js`.

## Project layout
```
src/
  server.js              Express app: webhooks, payment pages, per-user queue
  config.js              all settings (env vars)
  bot/conversation.js    the conversation state machine
  bot/messages.js        channel-neutral text / buttons / list / pay-link messages
  whatsapp/              Cloud API payloads + webhook parsing/signature check
  flights/               mock + Duffel providers (search, getOffer, book, searchPlaces)
  payments/              mock + Stripe providers
  util/                  date/trip parsing, pricing, formatting
  store.js               JSON-file persistence (sessions, bookings, de-dup)
scripts/chat.js          terminal simulator
test/                    node:test suites
```

## Current limits / next steps
- Adults only (children/infants need extra passenger types and age checks)
- Economy by default (`CABIN_CLASS`); no seat or extra-bag selection yet
- Messages are in English. Urdu/Roman-Urdu replies can be added in `bot/conversation.js`
- WhatsApp only lets businesses send free-form messages within **24 hours** of the customer's last message.
  To send reminders later (e.g. check-in alerts), create approved **message templates**.
- Single-instance storage. Move to a database before scaling horizontally.
