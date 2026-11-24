import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookToPaymentLink, USER } from './helpers.js';
import { ProviderError } from '../src/flights/errors.js';

test('greeting shows the main menu', async () => {
  const h = setup();
  const out = await h.say('hi');
  assert.equal(out[0].type, 'buttons');
  assert.deepEqual(out[0].buttons.map((b) => b.id), ['menu:search', 'menu:bookings', 'menu:help']);
});

test('step-by-step search asks for each field, then lists flights', async () => {
  const h = setup();
  await h.tap('menu:search');
  assert.match(h.last().text, /flying \*from\*/);
  await h.say('LHE');
  assert.match(h.last().text, /Where to\?/);
  await h.say('London');
  assert.equal(h.last().type, 'list'); // LHR / LGW / STN / ...
  await h.tap('place:LHR');
  assert.deepEqual(h.last().buttons.map((b) => b.id), ['trip:oneway', 'trip:return']);
  await h.tap('trip:return');
  await h.say('20 Dec');
  await h.say('15 Dec'); // before departure → rejected
  assert.equal(h.store.getSession(USER).step, 'return_date');
  await h.say('5 Jan');
  await h.tap('adults:2');
  const results = h.last();
  assert.equal(results.type, 'list');
  assert.ok(results.sections[0].rows.length >= 6);
  const s = h.store.getSession(USER);
  assert.equal(s.step, 'results');
  assert.deepEqual([s.search.departDate, s.search.returnDate, s.search.adults], ['2026-12-20', '2027-01-05', 2]);
  assert.equal(s.offers[0].slices.length, 2);
});

test('same origin and destination is rejected', async () => {
  const h = setup();
  await h.say('Lahore to LHE 25 Dec');
  assert.match(h.sent.map((m) => m.text).join('\n'), /can't both be Lahore/);
  assert.equal(h.store.getSession(USER).step, 'destination');
});

test('full booking: details → payment link → ticket', async () => {
  const h = setup();
  const out = await bookToPaymentLink(h);
  const link = out.find((m) => m.type === 'cta');
  assert.ok(link, 'payment link sent');
  const bookingId = h.store.getSession(USER).bookingId;
  assert.equal(link.url, `https://example.test/pay/mock/${bookingId}`);
  assert.equal(h.store.getBooking(bookingId).status, 'pending_payment');

  // Texting while payment is pending re-sends the link
  const again = await h.say('hello?');
  assert.equal(again[0].type, 'buttons'); // greeting resets to menu…
  // …but the booking is still payable
  h.sent.length = 0;
  await h.bot.onPaymentSucceeded(bookingId, { paymentIntent: 'pi_1' });
  const b = h.store.getBooking(bookingId);
  assert.equal(b.status, 'ticketed');
  assert.match(b.pnr, /^[A-F0-9]{6}$/);
  assert.ok(h.sent.some((m) => m.text.includes(b.pnr)));

  // Duplicate webhook is ignored
  h.sent.length = 0;
  await h.bot.onPaymentSucceeded(bookingId, { paymentIntent: 'pi_1' });
  assert.equal(h.sent.length, 0);

  const list = await h.say('my bookings');
  assert.match(list[0].text, new RegExp(b.pnr));
});

test('international route asks for passport details', async () => {
  const h = setup();
  await h.say('Lahore to DXB 25 Dec for 1');
  await h.tap('offer:0');
  await h.tap('offer:book');
  await h.say('Ali Khan');
  await h.say('01/01/1985');
  const q = await h.tap('gender:m');
  assert.match(q[0].text, /passport number/);
  await h.say('ab 123 4567');
  await h.say('Pakistan');
  await h.say('01/01/2026'); // expired
  assert.match(h.sent[0].text, /must still be valid/);
  await h.say('01/03/2027'); // valid, but < 6 months after travel → warning
  assert.ok(h.sent.some((m) => /less than 6 months/.test(m.text)));
  const pax = h.store.getSession(USER).passengers[0];
  assert.deepEqual(pax.passport, { number: 'AB1234567', country: 'PK', expiry: '2027-03-01' });
});

test('minors are rejected (adults only)', async () => {
  const h = setup();
  await h.say('Lahore to Karachi 25 Dec for 1');
  await h.tap('offer:0');
  await h.tap('offer:book');
  await h.say('Young Person');
  await h.say('01/01/2015');
  assert.match(h.sent[0].text, /adults \(18\+\)/);
  assert.equal(h.store.getSession(USER).paxField, 'dob');
});

test('typing a new date on the results list re-searches', async () => {
  const h = setup();
  await h.say('Lahore to Karachi 25 Dec for 1');
  await h.say('28 Dec');
  assert.equal(h.store.getSession(USER).search.departDate, '2026-12-28');
  assert.equal(h.last().type, 'list');
});

test('price change before payment asks the customer to confirm', async () => {
  const flights = (await import('../src/flights/mock.js')).createMockProvider({ currency: 'USD' });
  const realGet = flights.getOffer;
  flights.getOffer = async (id) => ({ ...(await realGet(id)), totalAmount: '999.00' });
  const h = setup({ flights });
  const out = await bookToPaymentLink(h);
  assert.match(out.at(-1).text, /changed the price to \*USD 999\*/);
  assert.equal(h.store.getSession(USER).step, 'confirm');
  const out2 = await h.tap('confirm:pay');
  assert.equal(out2.at(-1).type, 'cta');
});

test('ticketing failure after payment triggers an automatic refund', async () => {
  const flights = (await import('../src/flights/mock.js')).createMockProvider({ currency: 'USD' });
  flights.book = async () => { throw new ProviderError('sold out'); };
  let refunded = null;
  const payments = {
    name: 'test',
    createCheckout: async ({ booking }) => ({ id: 'cs_1', url: `https://pay.test/${booking.id}` }),
    refund: async (b) => { refunded = b; },
    cancelCheckout: async () => {},
  };
  const h = setup({ flights, payments });
  await bookToPaymentLink(h);
  const id = h.store.getSession(USER).bookingId;
  await h.bot.onPaymentSucceeded(id, { paymentIntent: 'pi_9' });
  assert.equal(h.store.getBooking(id).status, 'refunded');
  assert.equal(refunded.paymentIntent, 'pi_9');
  assert.ok(h.sent.some((m) => /full refund/.test(m.text)));
});

test('payment after the user cancelled is refunded, not ticketed', async () => {
  const h = setup();
  await bookToPaymentLink(h);
  const id = h.store.getSession(USER).bookingId;
  await h.say('cancel');
  assert.equal(h.store.getBooking(id).status, 'cancelled');
  await h.bot.onPaymentSucceeded(id, { paymentIntent: 'pi_2' });
  assert.equal(h.store.getBooking(id).status, 'refunded');
});

test('markup is applied to the price the customer pays', async () => {
  const h = setup({ pricing: { markupPercent: 10, serviceFee: 5 } });
  await bookToPaymentLink(h);
  const b = h.store.getBooking(h.store.getSession(USER).bookingId);
  const expected = Math.ceil((Number(b.offer.totalAmount) * 1.1 + 5) * 100 - 1e-9) / 100;
  assert.equal(b.amount, expected);
});
