import { text, buttons, list, cta } from './messages.js';
import { parseQuickSearch, parseName, parseEmail, parseCountry } from '../util/parse.js';
import { parseDate, formatDate, ageOn, toISODate } from '../util/dates.js';
import { customerPrice as priceWith, formatMoney } from '../util/pricing.js';
import { offerRow, offerDetails, truncate, hhmm, stopsLabel } from '../util/format.js';
import { OfferExpiredError } from '../flights/errors.js';

const GREETINGS = new Set(['hi', 'hello', 'hey', 'salam', 'salaam', 'assalam o alaikum', 'aoa', 'start', 'menu', 'home']);
const CANCEL = new Set(['cancel', 'stop', 'restart', 'reset', 'new', 'new search', 'start over']);
const BOOKINGS = new Set(['bookings', 'my bookings', 'booking', 'my booking', 'trips', 'my trips']);
const MAX_DAYS_AHEAD = 330;

const STATUS_LABEL = {
  pending_payment: '⏳ Awaiting payment',
  paid: '💳 Paid, issuing ticket',
  ticketed: '✅ Confirmed',
  failed: '❌ Failed',
  refunded: '↩️ Refunded',
  refund_failed: '⚠️ Refund in progress',
  cancelled: '✖️ Cancelled',
  expired: '⌛ Payment link expired',
};

const freshSession = (prev) => ({
  step: 'idle',
  search: {},
  pending: {},
  offers: [],
  selected: null,
  passengers: [],
  paxIndex: 0,
  paxField: null,
  placeChoices: null,
  bookingId: null,
  profile: prev?.profile ?? {}, // remembered between searches (e.g. email)
});

/**
 * Creates the WhatsApp flight-booking bot.
 *
 * flights  – flight provider (search / getOffer / book / searchPlaces)
 * payments – payment provider (createCheckout / refund / cancelCheckout)
 * store    – persistence (sessions + bookings)
 * notify   – async (userId, messages[]) => void, delivers messages to the user
 */
export function createBot({ flights, payments, store, notify, config, now = () => new Date(), log = console }) {
  const brand = config.brandName;
  const maxResults = config.flights?.maxResults ?? 10;
  const pricing = config.pricing ?? { markupPercent: 0, serviceFee: 0 };
  const customerPrice = (offer) => priceWith(offer, pricing);

  // ───────────────────────────── entry points ─────────────────────────────

  async function handle(userId, input) {
    const session = store.getSession(userId) ?? freshSession();
    const raw = (input.text ?? '').trim();
    const ctx = {
      userId,
      session,
      input: { text: raw, lower: raw.toLowerCase(), replyId: input.replyId ?? null, name: input.profileName },
      send: (...msgs) => notify(userId, msgs),
    };
    try {
      await route(ctx);
    } catch (err) {
      log.error('[bot] error while handling message', err);
      await ctx.send(text('😓 Sorry, something went wrong on our side. Please try again, or type *menu* to start over.'));
    }
    ctx.session.updatedAt = new Date().toISOString();
    store.saveSession(userId, ctx.session);
  }

  async function onPaymentSucceeded(bookingId, details = {}) {
    const booking = store.getBooking(bookingId);
    if (!booking) return log.warn(`[bot] payment for unknown booking ${bookingId}`);
    const send = (...m) => notify(booking.userId, m);
    const money = formatMoney(booking.amount, booking.currency);

    if (booking.status === 'cancelled' || booking.status === 'expired') {
      store.updateBooking(bookingId, { paymentIntent: details.paymentIntent });
      return refundAndNotify(booking.id, 'this booking was already cancelled when your payment came through');
    }
    if (booking.status !== 'pending_payment') return; // duplicate webhook — already handled

    store.updateBooking(bookingId, { status: 'paid', paymentIntent: details.paymentIntent, paidAt: new Date().toISOString() });
    await send(text(`✅ Payment of *${money}* received for booking *${bookingId}*.\nIssuing your ticket with the airline now…`));

    try {
      const order = await flights.book({
        offerId: booking.offerId,
        passengers: booking.passengers,
        amount: booking.offer.totalAmount,
        currency: booking.offer.currency,
        contact: booking.contact,
      });
      const done = store.updateBooking(bookingId, { status: 'ticketed', pnr: order.pnr, orderId: order.orderId });
      await send(text(confirmationMessage(done)));
      await send(buttons('Anything else I can help with?', [['menu:search', 'Book another flight'], ['menu:bookings', 'My bookings']]));
      resetSessionIfOn(booking.userId, bookingId);
    } catch (err) {
      log.error(`[bot] ticketing failed for ${bookingId}`, err);
      store.updateBooking(bookingId, { status: 'failed', error: err.message });
      await refundAndNotify(bookingId, 'the airline could not confirm this fare (it may have just sold out)');
    }
  }

  async function onPaymentExpired(bookingId) {
    const booking = store.getBooking(bookingId);
    if (!booking || booking.status !== 'pending_payment') return;
    store.updateBooking(bookingId, { status: 'expired' });
    resetSessionIfOn(booking.userId, bookingId);
    await notify(booking.userId, [
      buttons(`⌛ The payment link for booking *${bookingId}* has expired, so nothing was charged.\nFares change often. Search again to get today's price.`, [
        ['menu:search', 'Search flights'],
      ]),
    ]);
  }

  async function refundAndNotify(bookingId, reason) {
    const booking = store.getBooking(bookingId);
    const send = (...m) => notify(booking.userId, m);
    const money = formatMoney(booking.amount, booking.currency);
    try {
      await payments.refund(booking);
      store.updateBooking(bookingId, { status: 'refunded', refundedAt: new Date().toISOString() });
      await send(text(`😔 Sorry, ${reason}.\n\nWe've issued a *full refund of ${money}* to your original payment method. It usually appears within 5–10 business days.`));
    } catch (err) {
      log.error(`[bot] refund failed for ${bookingId}`, err);
      store.updateBooking(bookingId, { status: 'refund_failed', refundError: err.message });
      await send(text(`😔 Sorry, ${reason}.\n\nOur team will refund *${money}* to you manually. Your reference is *${bookingId}*.${supportLine()}`));
    }
    resetSessionIfOn(booking.userId, bookingId);
    await send(buttons('Would you like to look for another flight?', [['menu:search', 'Search flights']]));
  }

  function resetSessionIfOn(userId, bookingId) {
    const s = store.getSession(userId);
    if (s?.bookingId === bookingId) store.saveSession(userId, freshSession(s));
  }

  // ───────────────────────────── routing ─────────────────────────────

  async function route(ctx) {
    const { input, session } = ctx;
    const cmd = input.replyId ? null : input.lower.replace(/[!.?]+$/, '');

    if (cmd !== null) {
      if (GREETINGS.has(cmd)) return welcome(ctx);
      if (CANCEL.has(cmd)) return cancel(ctx);
      if (cmd === 'help') return help(ctx);
      if (BOOKINGS.has(cmd)) return showBookings(ctx);
    }

    switch (input.replyId) {
      case 'menu:search':
      case 'search:new':
        return startSearch(ctx);
      case 'menu:bookings':
        return showBookings(ctx);
      case 'menu:help':
        return help(ctx);
      case 'search:again':
        return session.search.adults ? runSearch(ctx) : startSearch(ctx);
      case 'confirm:cancel':
        return cancel(ctx);
    }

    // A whole trip typed in one line: "Lahore to Dubai 25 Dec for 2"
    if (!input.replyId && ['idle', 'origin', 'destination', 'results', 'no_results', 'offer'].includes(session.step)) {
      const q = parseQuickSearch(input.text, now());
      if (q) return quickSearch(ctx, q);
    }

    const handler = STEPS[session.step] ?? STEPS.idle;
    return handler(ctx);
  }

  const STEPS = {
    idle: async (ctx) => {
      if (ctx.input.replyId) return welcome(ctx, '⏱️ That option has expired.');
      return welcome(ctx, ctx.session.step === 'idle' && ctx.session.greeted ? "🤔 I didn't quite get that." : null);
    },
    origin: (ctx) => placeStep(ctx, 'origin'),
    destination: (ctx) => placeStep(ctx, 'destination'),

    trip_type: async (ctx) => {
      const { input, session } = ctx;
      const v = input.replyId ?? input.lower;
      if (['trip:oneway', 'one way', 'one-way', 'oneway', '1'].includes(v)) session.search.tripType = 'oneway';
      else if (['trip:return', 'return', 'round trip', 'roundtrip', 'round-trip', '2'].includes(v)) session.search.tripType = 'return';
      else return reprompt(ctx, 'Please tap *One-way* or *Return*.');
      return advance(ctx);
    },

    depart_date: async (ctx) => {
      const d = validTravelDate(ctx.input.text);
      if (!d) return reprompt(ctx, dateHelp());
      ctx.session.search.departDate = d;
      if (ctx.session.search.returnDate && ctx.session.search.returnDate < d) delete ctx.session.search.returnDate;
      return advance(ctx);
    },

    return_date: async (ctx) => {
      const d = validTravelDate(ctx.input.text);
      if (!d) return reprompt(ctx, dateHelp());
      if (d < ctx.session.search.departDate) {
        return reprompt(ctx, `The return date must be on or after ${formatDate(ctx.session.search.departDate)}.`);
      }
      ctx.session.search.returnDate = d;
      return advance(ctx);
    },

    adults: async (ctx) => {
      const { input, session } = ctx;
      const n = Number(input.replyId?.startsWith('adults:') ? input.replyId.slice(7) : input.text);
      if (!Number.isInteger(n) || n < 1 || n > 9) return reprompt(ctx, 'Please send a number of travellers from 1 to 9.');
      session.search.adults = n;
      return advance(ctx);
    },

    results: (ctx) => resultsStep(ctx),
    no_results: (ctx) => resultsStep(ctx),

    offer: async (ctx) => {
      const { input } = ctx;
      const v = input.replyId ?? input.lower;
      if (['offer:book', 'book', 'yes', 'book this'].includes(v)) return startPassengers(ctx);
      if (['offer:back', 'back', 'other', 'others'].includes(v)) return showResults(ctx);
      if (/^\d+$/.test(input.text) || input.replyId?.startsWith('offer:')) return resultsStep(ctx);
      return reprompt(ctx);
    },

    pax: (ctx) => passengerStep(ctx),

    email: async (ctx) => {
      const { input, session } = ctx;
      const email = input.replyId === 'email:saved' ? session.profile.email : parseEmail(input.text);
      if (!email) return reprompt(ctx, "That doesn't look like a valid email address.");
      session.profile.email = email;
      session.contactEmail = email;
      return showConfirm(ctx);
    },

    confirm: async (ctx) => {
      const { input } = ctx;
      const v = input.replyId ?? input.lower;
      if (['confirm:pay', 'pay', 'confirm', 'yes', 'continue'].includes(v)) return checkout(ctx);
      if (['confirm:edit', 'edit'].includes(v)) return startPassengers(ctx);
      if (v === 'offer:back') return showResults(ctx);
      return reprompt(ctx);
    },

    awaiting_payment: async (ctx) => {
      const booking = store.getBooking(ctx.session.bookingId);
      if (!booking || booking.status !== 'pending_payment') {
        ctx.session = freshSession(ctx.session);
        return welcome(ctx);
      }
      return sendPaymentLink(ctx, booking, true);
    },

    searching: async (ctx) => ctx.send(text('🔎 Still searching, one moment please…')),
  };

  // ───────────────────────────── menu & misc ─────────────────────────────

  async function welcome(ctx, prefix = null) {
    const name = ctx.input.name ? ` ${ctx.input.name.split(' ')[0]}` : '';
    ctx.session = freshSession(ctx.session);
    ctx.session.greeted = true;
    const intro = prefix
      ? `${prefix}\n\n`
      : `👋 Hi${name}! Welcome to *${brand}*.\nI can find flights, book them and take payment, all right here in WhatsApp.\n\n`;
    await ctx.send(
      buttons(
        `${intro}Tap *Search flights*, or just type your trip, e.g.\n_Lahore to Dubai 25 Dec for 2_`,
        [['menu:search', 'Search flights'], ['menu:bookings', 'My bookings'], ['menu:help', 'Help']],
      ),
    );
  }

  async function help(ctx) {
    await ctx.send(
      buttons(
        [
          `ℹ️ *How ${brand} works*`,
          '',
          '1️⃣ Tell me where and when you want to fly',
          '2️⃣ Pick a flight from the list',
          '3️⃣ Enter traveller details',
          '4️⃣ Pay securely. The payment page opens inside WhatsApp',
          '5️⃣ Get your booking reference (PNR) right here',
          '',
          '*Shortcuts*',
          '• _Karachi to Jeddah 10 Jan returning 20 Jan for 3_',
          '• *menu*: start over',
          '• *my bookings*: see your trips',
          '• *cancel*: cancel what you are doing',
        ].join('\n') + supportLine(),
        [['menu:search', 'Search flights'], ['menu:bookings', 'My bookings']],
      ),
    );
  }

  const supportLine = () => (config.supportContact ? `\n\nNeed a human? Contact ${config.supportContact}` : '');

  async function cancel(ctx) {
    const { session } = ctx;
    if (session.bookingId) {
      const booking = store.getBooking(session.bookingId);
      if (booking?.status === 'pending_payment') {
        store.updateBooking(booking.id, { status: 'cancelled' });
        await payments.cancelCheckout?.(booking).catch(() => {});
      }
    }
    ctx.session = freshSession(session);
    await ctx.send(buttons('👍 Cancelled. What would you like to do next?', [['menu:search', 'Search flights'], ['menu:bookings', 'My bookings']]));
  }

  async function showBookings(ctx) {
    const all = store.listBookings(ctx.userId).filter((b) => b.status !== 'cancelled').slice(0, 5);
    if (!all.length) {
      return ctx.send(buttons("You don't have any bookings yet.", [['menu:search', 'Search flights']]));
    }
    const lines = all.map((b) => {
      const s = b.search;
      const route = `${s.origin.code}→${s.destination.code}${s.returnDate ? `→${s.origin.code}` : ''}`;
      const pnr = b.pnr ? ` · PNR *${b.pnr}*` : '';
      return `*${b.id}* · ${route} · ${formatDate(s.departDate)}\n${STATUS_LABEL[b.status] ?? b.status}${pnr}`;
    });
    await ctx.send(buttons(`🧳 *Your recent bookings*\n\n${lines.join('\n\n')}`, [['menu:search', 'Search flights']]));
  }

  // ───────────────────────────── search setup ─────────────────────────────

  async function startSearch(ctx) {
    ctx.session = freshSession(ctx.session);
    ctx.session.greeted = true;
    return advance(ctx);
  }

  async function quickSearch(ctx, q) {
    ctx.session = freshSession(ctx.session);
    ctx.session.greeted = true;
    const s = ctx.session.search;
    if (q.departDate && validTravelDate(q.departDate)) s.departDate = q.departDate;
    if (q.returnDate && s.departDate) {
      s.returnDate = q.returnDate;
      s.tripType = 'return';
    } else if (s.departDate) {
      s.tripType = 'oneway';
    }
    if (q.adults) s.adults = q.adults;
    ctx.session.pending = { origin: q.origin, destination: q.destination };
    return advance(ctx);
  }

  /** Ask for the next missing piece of the search, or run it when complete. */
  async function advance(ctx) {
    const { session, send } = ctx;
    const s = session.search;

    for (const field of ['origin', 'destination']) {
      if (s[field]) continue;
      const pendingQuery = session.pending?.[field];
      if (pendingQuery) {
        delete session.pending[field];
        if (!(await resolvePlace(ctx, field, pendingQuery))) return;
        continue;
      }
      session.step = field;
      return send(
        text(field === 'origin'
          ? '🛫 Where are you flying *from*?\nType a city or airport code, e.g. _Lahore_ or _LHE_.'
          : `🛬 Flying from *${s.origin.city} (${s.origin.code})*. Where to?`),
      );
    }

    if (!s.tripType) {
      session.step = 'trip_type';
      return send(buttons(`✈️ ${s.origin.city} → ${s.destination.city}\nOne-way or return?`, [['trip:oneway', 'One-way'], ['trip:return', 'Return']]));
    }
    if (!s.departDate) {
      session.step = 'depart_date';
      return send(text(`📅 What date do you want to ${s.tripType === 'return' ? 'leave' : 'fly'}?\n_e.g. 25 Dec, 25/12/2026 or tomorrow_`));
    }
    if (s.tripType === 'return' && !s.returnDate) {
      session.step = 'return_date';
      return send(text(`📅 And the return date? (leaving ${formatDate(s.departDate)})`));
    }
    if (!s.adults) {
      session.step = 'adults';
      return send(buttons('👥 How many adult travellers (18+)?\nTap one, or type a number up to 9.', [['adults:1', '1'], ['adults:2', '2'], ['adults:3', '3']]));
    }
    return runSearch(ctx);
  }

  async function placeStep(ctx, field) {
    const { input, session } = ctx;
    let picked = null;
    if (input.replyId?.startsWith('place:')) {
      picked = session.placeChoices?.find((p) => p.code === input.replyId.slice(6));
      if (!picked) return reprompt(ctx, '⏱️ That option has expired.');
    } else if (/^\d+$/.test(input.text) && session.placeChoices?.[Number(input.text) - 1]) {
      picked = session.placeChoices[Number(input.text) - 1];
    }
    if (picked) {
      session.placeChoices = null;
      if (!(await setPlace(ctx, field, picked))) return;
      return advance(ctx);
    }
    if (!input.text) return reprompt(ctx);
    if (await resolvePlace(ctx, field, input.text)) return advance(ctx);
  }

  async function resolvePlace(ctx, field, query) {
    const { session, send } = ctx;
    const places = await flights.searchPlaces(query);
    session.step = field;
    if (!places.length) {
      await send(text(`🤔 I couldn't find an airport for "${query}".\nTry the city name or the 3-letter airport code (e.g. _LHE_, _DXB_).`));
      return false;
    }
    const exact = places.find((p) => p.code.toLowerCase() === query.trim().toLowerCase());
    if (exact || places.length === 1) return setPlace(ctx, field, exact ?? places[0]);

    session.placeChoices = places.slice(0, 10);
    await send(
      list(
        `📍 Which ${field === 'origin' ? 'departure' : 'arrival'} airport do you mean for "${query}"?`,
        'Choose airport',
        session.placeChoices.map((p) => ({
          id: `place:${p.code}`,
          title: truncate(`${p.city} (${p.code})`, 24),
          description: truncate(p.name, 72),
        })),
        'Airports',
      ),
    );
    return false;
  }

  async function setPlace(ctx, field, place) {
    const s = ctx.session.search;
    const other = s[field === 'origin' ? 'destination' : 'origin'];
    if (other && (other.code === place.code || (other.city && other.city === place.city))) {
      ctx.session.step = field;
      await ctx.send(text(`Departure and destination can't both be ${place.city}. Please choose a different ${field === 'origin' ? 'departure city' : 'destination'}.`));
      return false;
    }
    s[field] = { code: place.code, city: place.city, name: place.name, country: place.country };
    return true;
  }

  function validTravelDate(input) {
    const d = parseDate(input, { now: now() });
    if (!d) return null;
    const max = new Date(now().getTime() + MAX_DAYS_AHEAD * 86400000);
    return d <= toISODate(max) ? d : null;
  }

  const dateHelp = () =>
    `Please send a date between today and ${MAX_DAYS_AHEAD} days from now, e.g. _25 Dec_, _25/12/2026_ or _tomorrow_.`;

  // ───────────────────────────── results ─────────────────────────────

  async function runSearch(ctx) {
    const { session, send } = ctx;
    const s = session.search;
    session.step = 'searching';
    await send(text(`🔎 Searching flights ${s.origin.code} → ${s.destination.code}…`));
    let offers;
    try {
      offers = await flights.search({
        origin: s.origin.code,
        destination: s.destination.code,
        departDate: s.departDate,
        returnDate: s.tripType === 'return' ? s.returnDate : undefined,
        adults: s.adults,
      });
    } catch (err) {
      log.error('[bot] search failed', err);
      session.step = 'no_results';
      return send(buttons('😓 The airline search is not responding right now.', [['search:again', 'Try again'], ['search:new', 'New search']]));
    }
    if (!offers.length) {
      session.step = 'no_results';
      return send(buttons(`😕 No flights found for ${formatDate(s.departDate)}.\nType another date to try again, or start a new search.`, [['search:new', 'New search']]));
    }
    session.offers = offers.slice(0, maxResults);
    session.selected = null;
    return showResults(ctx);
  }

  async function showResults(ctx) {
    const { session, send } = ctx;
    const s = session.search;
    session.step = 'results';
    const dates = s.tripType === 'return' ? `${formatDate(s.departDate)} – ${formatDate(s.returnDate)}` : formatDate(s.departDate);
    await send(
      list(
        [
          `✈️ *${s.origin.city} (${s.origin.code}) → ${s.destination.city} (${s.destination.code})*`,
          `${dates} · ${s.adults} adult${s.adults > 1 ? 's' : ''}${s.tripType === 'return' ? ' · return' : ''}`,
          '',
          `I found ${session.offers.length} options, cheapest first. Tap *View flights* to choose.`,
          '_Prices are totals for all travellers, incl. taxes._',
          '',
          'Tip: type another date to search a different day.',
        ].join('\n'),
        'View flights',
        session.offers.map((o, i) => offerRow(o, i, pricing)),
        'Flights',
      ),
    );
  }

  async function resultsStep(ctx) {
    const { input, session } = ctx;
    let idx = null;
    if (input.replyId?.startsWith('offer:')) idx = Number(input.replyId.slice(6));
    else if (/^\d{1,2}$/.test(input.text)) idx = Number(input.text) - 1;

    if (idx !== null) {
      if (!session.offers?.[idx]) return reprompt(ctx, '⏱️ That flight is no longer in the list.');
      return showOffer(ctx, idx);
    }
    const d = input.text && validTravelDate(input.text);
    if (d && session.search.adults) {
      session.search.departDate = d;
      if (session.search.returnDate && session.search.returnDate < d) {
        session.search.returnDate = null;
        return advance(ctx);
      }
      return runSearch(ctx);
    }
    return reprompt(ctx, session.step === 'no_results' ? dateHelp() : null);
  }

  async function showOffer(ctx, idx) {
    const { session, send } = ctx;
    session.selected = idx;
    session.step = 'offer';
    const offer = session.offers[idx];
    const details = offerDetails(offer, session.search.adults, pricing);
    const actions = [['offer:book', 'Book this flight'], ['offer:back', 'Other flights'], ['search:new', 'New search']];
    if (details.length <= 1000) return send(buttons(details, actions));
    await send(text(details));
    return send(buttons('Would you like to book this flight?', actions));
  }

  // ───────────────────────────── travellers ─────────────────────────────

  const selectedOffer = (session) => session.offers?.[session.selected];

  async function startPassengers(ctx) {
    const { session, send } = ctx;
    const offer = selectedOffer(session);
    if (!offer) return startSearch(ctx);
    session.passengers = [];
    session.paxIndex = 0;
    session.paxField = 'name';
    session.step = 'pax';
    const doc = offer.requiresPassport ? 'passport' : 'ID card / passport';
    await send(text(`Great choice! 🙌\nI need a few details for ${session.search.adults > 1 ? 'each traveller' : 'the traveller'}, *exactly as written on their ${doc}*.`));
    return askPax(ctx);
  }

  function paxFields(session) {
    const fields = ['name', 'dob', 'gender'];
    if (selectedOffer(session)?.requiresPassport) fields.push('passport_number', 'passport_country', 'passport_expiry');
    return fields;
  }

  async function askPax(ctx) {
    const { session, send } = ctx;
    const n = session.search.adults;
    const i = session.paxIndex;
    const who = n > 1 ? `Traveller ${i + 1} of ${n}` : 'Traveller';
    const first = session.passengers[i]?.givenName;
    switch (session.paxField) {
      case 'name':
        return send(text(`👤 *${who}*: full name? (first and last name)\n_e.g. Ayesha Khan_`));
      case 'dob':
        return send(text(`🎂 ${first}'s date of birth? (DD/MM/YYYY)`));
      case 'gender':
        return send(buttons(`${first}'s gender (as on passport)?`, [['gender:m', 'Male'], ['gender:f', 'Female']]));
      case 'passport_number':
        return send(text(`🛂 ${first}'s passport number?`));
      case 'passport_country':
        return send(text('Which country issued the passport? (e.g. _Pakistan_ or _PK_)'));
      case 'passport_expiry':
        return send(text('Passport expiry date? (DD/MM/YYYY)'));
    }
  }

  async function passengerStep(ctx) {
    const { input, session } = ctx;
    const i = session.paxIndex;
    const pax = (session.passengers[i] ??= {});
    const lastTravelDate = (session.search.returnDate ?? session.search.departDate);

    switch (session.paxField) {
      case 'name': {
        const name = parseName(input.text);
        if (!name) return reprompt(ctx, 'Please send the first *and* last name, using letters only.');
        Object.assign(pax, name);
        break;
      }
      case 'dob': {
        const dob = parseDate(input.text, { now: now(), past: true, requireYear: true });
        if (!dob) return reprompt(ctx, 'Please use the format DD/MM/YYYY, e.g. 14/08/1990.');
        const age = ageOn(dob, session.search.departDate);
        if (age < 18) return reprompt(ctx, 'Sorry, I can only book adults (18+) at the moment. Please enter an adult traveller, or type *cancel*.');
        if (age > 120) return reprompt(ctx, 'That date of birth looks wrong. Please check it.');
        pax.dob = dob;
        break;
      }
      case 'gender': {
        const v = input.replyId ?? input.lower;
        if (['gender:m', 'male', 'm'].includes(v)) pax.gender = 'm';
        else if (['gender:f', 'female', 'f'].includes(v)) pax.gender = 'f';
        else return reprompt(ctx, 'Please tap *Male* or *Female*.');
        break;
      }
      case 'passport_number': {
        const num = input.text.replace(/[\s-]/g, '').toUpperCase();
        if (!/^[A-Z0-9]{5,20}$/.test(num)) return reprompt(ctx, "That passport number doesn't look right. Please check it.");
        pax.passport = { number: num };
        break;
      }
      case 'passport_country': {
        const c = parseCountry(input.text);
        if (!c) return reprompt(ctx, 'Please send the country name or its 2-letter code (e.g. PK, GB, US).');
        pax.passport.country = c;
        break;
      }
      case 'passport_expiry': {
        const exp = parseDate(input.text, { now: now(), requireYear: true });
        if (!exp || exp <= lastTravelDate) return reprompt(ctx, 'The passport must still be valid after your travel dates. Please check the expiry date (DD/MM/YYYY).');
        pax.passport.expiry = exp;
        break;
      }
      default:
        return startPassengers(ctx);
    }

    const fields = paxFields(session);
    const next = fields[fields.indexOf(session.paxField) + 1];
    if (next) {
      session.paxField = next;
      return askPax(ctx);
    }
    if (pax.passport?.expiry) {
      const sixMonths = new Date(`${lastTravelDate}T00:00:00Z`);
      sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6);
      if (pax.passport.expiry < toISODate(sixMonths)) {
        await ctx.send(text(`⚠️ Heads-up: ${pax.givenName}'s passport expires less than 6 months after travel. Many countries refuse entry in that case.`));
      }
    }
    if (session.paxIndex + 1 < session.search.adults) {
      session.paxIndex += 1;
      session.paxField = 'name';
      return askPax(ctx);
    }
    return askEmail(ctx);
  }

  async function askEmail(ctx) {
    const { session, send } = ctx;
    session.step = 'email';
    session.paxField = null;
    if (session.profile.email) {
      return send(buttons(`📧 Which email should we use for this booking?\nTap below or type a different address.`, [['email:saved', truncate(session.profile.email, 20)]]));
    }
    return send(text('📧 Last step: your email address (for the booking confirmation)?'));
  }

  // ───────────────────────────── confirm & pay ─────────────────────────────

  async function showConfirm(ctx) {
    const { session, send } = ctx;
    session.step = 'confirm';
    const offer = selectedOffer(session);
    const price = customerPrice(offer);
    const slices = offer.slices.map((sl, k) =>
      `${k === 0 ? '🛫' : '🛬'} ${sl.origin} → ${sl.destination} · ${formatDate(sl.departingAt)} ${hhmm(sl.departingAt)} (${stopsLabel(sl.stops)})`);
    const pax = session.passengers.map((p, k) =>
      `${k + 1}. ${p.gender === 'm' ? 'Mr' : 'Ms'} ${p.givenName} ${p.familyName} · born ${formatDate(p.dob)}${p.passport ? ` · 🛂 ${p.passport.number}` : ''}`);
    await send(
      buttons(
        [
          '📝 *Please check your booking*',
          '',
          `*${offer.airline.name}*`,
          ...slices,
          '',
          '*Travellers*',
          ...pax,
          '',
          `📧 ${session.contactEmail}`,
          '',
          `💰 *Total: ${formatMoney(price.amount, price.currency)}*`,
        ].join('\n'),
        [['confirm:pay', 'Confirm & pay'], ['confirm:edit', 'Edit details'], ['confirm:cancel', 'Cancel']],
      ),
    );
  }

  async function checkout(ctx) {
    const { session, send, userId } = ctx;
    const offer = selectedOffer(session);
    if (!offer) return startSearch(ctx);

    await send(text('⏳ Confirming the latest price with the airline…'));
    let fresh;
    try {
      fresh = await flights.getOffer(offer.id);
    } catch (err) {
      if (!(err instanceof OfferExpiredError)) throw err;
      session.step = 'no_results';
      return send(buttons('⌛ This fare has just expired or sold out. Search again to see current prices.', [['search:again', 'Search again'], ['search:new', 'New search']]));
    }
    if (fresh.totalAmount !== offer.totalAmount || fresh.currency !== offer.currency) {
      session.offers[session.selected] = fresh;
      const p = customerPrice(fresh);
      return send(buttons(`⚠️ The airline has changed the price to *${formatMoney(p.amount, p.currency)}*. Do you want to continue?`, [
        ['confirm:pay', 'Continue'],
        ['offer:back', 'Other flights'],
        ['confirm:cancel', 'Cancel'],
      ]));
    }

    const price = customerPrice(fresh);
    const s = session.search;
    const booking = store.createBooking({
      userId,
      offerId: fresh.id,
      offer: fresh,
      search: s,
      passengers: session.passengers,
      contact: { email: session.contactEmail, phone: /^\d{8,15}$/.test(userId) ? `+${userId}` : undefined },
      amount: price.amount,
      currency: price.currency,
    });

    let link;
    try {
      link = await payments.createCheckout({
        booking,
        description: `Flight ${s.origin.code}→${s.destination.code}${s.tripType === 'return' ? `→${s.origin.code}` : ''} · ${s.adults} traveller${s.adults > 1 ? 's' : ''} · ${booking.id}`,
        customerEmail: session.contactEmail,
      });
    } catch (err) {
      store.updateBooking(booking.id, { status: 'cancelled', error: err.message });
      throw err;
    }
    const saved = store.updateBooking(booking.id, { paymentRef: link.id, paymentUrl: link.url });
    session.bookingId = booking.id;
    session.step = 'awaiting_payment';
    return sendPaymentLink(ctx, saved, false);
  }

  async function sendPaymentLink(ctx, booking, reminder) {
    const money = formatMoney(booking.amount, booking.currency);
    const body = reminder
      ? `⏳ Booking *${booking.id}* is waiting for payment of *${money}*.\nTap *Pay now* to finish, or type *cancel* to cancel it.`
      : [
        `🧾 Booking *${booking.id}* is ready.`,
        `Total: *${money}*`,
        '',
        'Tap *Pay now* to pay securely by card, Apple Pay or Google Pay. The page opens right here in WhatsApp.',
        '',
        "⏳ The link is valid for 30 minutes. I'll confirm your ticket here as soon as payment goes through.",
      ].join('\n');
    return ctx.send(cta(body, 'Pay now', booking.paymentUrl));
  }

  function confirmationMessage(b) {
    const slices = b.offer.slices.map((sl) =>
      `✈️ ${sl.origin} → ${sl.destination} · ${formatDate(sl.departingAt)}\n    ${hhmm(sl.departingAt)} → ${hhmm(sl.arrivingAt)} · ${sl.segments.map((g) => g.flight).join(', ')}`);
    return [
      '🎉 *Your flight is booked!*',
      '',
      `Airline booking reference (PNR): *${b.pnr}*`,
      `${brand} reference: ${b.id}`,
      '',
      `*${b.offer.airline.name}*`,
      ...slices,
      '',
      `👥 ${b.passengers.map((p) => `${p.givenName} ${p.familyName}`).join(', ')}`,
      `💳 Paid: ${formatMoney(b.amount, b.currency)}`,
      '',
      `Use the PNR to check in on the ${b.offer.airline.name} website or at the airport, and bring the passport${b.passengers.length > 1 ? 's' : ''} used for booking. Have a great trip! 🌍`,
    ].join('\n');
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Re-ask whatever the current step needs, optionally after an error line. */
  async function reprompt(ctx, error = null) {
    const { session, send } = ctx;
    if (error) await send(text(error));
    switch (session.step) {
      case 'origin':
      case 'destination':
        if (session.placeChoices) return send(text('Tap *Choose airport* above, or type a different city.'));
        return advance(ctx);
      case 'trip_type':
      case 'depart_date':
      case 'return_date':
      case 'adults':
        return advance(ctx);
      case 'results':
        return send(text(`Tap *View flights* above, or type a number 1–${session.offers.length}. Type a date to search another day, or *new* for a new search.`));
      case 'no_results':
        return error ? undefined : send(buttons('Type a different date, or start over.', [['search:new', 'New search']]));
      case 'offer':
        return showOffer(ctx, session.selected);
      case 'pax':
        return askPax(ctx);
      case 'email':
        return askEmail(ctx);
      case 'confirm':
        return showConfirm(ctx);
      default:
        return welcome(ctx, error ? null : "🤔 I didn't quite get that.");
    }
  }

  return { handle, onPaymentSucceeded, onPaymentExpired };
}
