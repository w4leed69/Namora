import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuffelProvider } from '../src/flights/duffel.js';
import { OfferExpiredError } from '../src/flights/errors.js';

const seg = (o, d, dep, arr, no) => ({
  origin: { iata_code: o }, destination: { iata_code: d }, departing_at: dep, arriving_at: arr,
  marketing_carrier: { iata_code: 'EK' }, marketing_carrier_flight_number: no,
  passengers: [{ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }] }],
});
const OFFER = {
  id: 'off_123', total_amount: '412.30', total_currency: 'USD', expires_at: '2026-11-24T11:00:00Z',
  owner: { iata_code: 'EK', name: 'Emirates' },
  passengers: [{ id: 'pas_1', type: 'adult' }],
  passenger_identity_documents_required: true,
  conditions: { refund_before_departure: { allowed: false }, change_before_departure: { allowed: true } },
  slices: [{
    origin: { iata_code: 'LHE' }, destination: { iata_code: 'LHR' }, duration: 'PT13H20M',
    segments: [seg('LHE', 'DXB', '2026-12-25T03:15:00', '2026-12-25T05:40:00', '623'), seg('DXB', 'LHR', '2026-12-25T08:00:00', '2026-12-25T12:35:00', '1')],
  }],
};

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = url.replace('https://api.duffel.com', '');
    calls.push({ method: init.method, path, body: init.body && JSON.parse(init.body), headers: init.headers });
    const [status, json] = routes(init.method, path) ?? [404, { errors: [{ code: 'not_found' }] }];
    return { ok: status < 300, status, json: async () => json };
  };
  return { impl, calls };
}

test('search sends a correct offer request and normalises offers', async () => {
  const f = fakeFetch((m, p) => (m === 'POST' && p.startsWith('/air/offer_requests') ? [201, { data: { offers: [OFFER] } }] : null));
  const duffel = createDuffelProvider({ token: 'duffel_test_x', fetchImpl: f.impl });
  const [o] = await duffel.search({ origin: 'LHE', destination: 'LHR', departDate: '2026-12-25', adults: 2 });
  assert.equal(f.calls[0].headers['Duffel-Version'], 'v2');
  assert.deepEqual(f.calls[0].body.data.passengers, [{ type: 'adult' }, { type: 'adult' }]);
  assert.equal(o.airline.name, 'Emirates');
  assert.equal(o.slices[0].stops, 1);
  assert.equal(o.slices[0].duration, 800);
  assert.equal(o.slices[0].segments[1].flight, 'EK 1');
  assert.equal(o.baggage, '1 checked bag included');
  assert.equal(o.requiresPassport, true);
  assert.deepEqual(o.conditions, { refundable: false, changeable: true });
});

test('book creates an instant order paid from balance with passenger details', async () => {
  const f = fakeFetch((m, p) => {
    if (m === 'GET' && p === '/air/offers/off_123') return [200, { data: OFFER }];
    if (m === 'POST' && p === '/air/orders') return [201, { data: { id: 'ord_1', booking_reference: 'XYZ123' } }];
  });
  const duffel = createDuffelProvider({ token: 't', fetchImpl: f.impl });
  const res = await duffel.book({
    offerId: 'off_123', amount: '412.30', currency: 'USD',
    contact: { email: 'a@b.co', phone: '+923001234567' },
    passengers: [{ givenName: 'Ali', familyName: 'Khan', dob: '1990-01-01', gender: 'm', passport: { number: 'AB1', country: 'PK', expiry: '2030-01-01' } }],
  });
  assert.deepEqual(res, { orderId: 'ord_1', pnr: 'XYZ123' });
  const order = f.calls.find((c) => c.path === '/air/orders').body.data;
  assert.deepEqual(order.payments, [{ type: 'balance', amount: '412.30', currency: 'USD' }]);
  assert.equal(order.passengers[0].id, 'pas_1');
  assert.equal(order.passengers[0].title, 'mr');
  assert.equal(order.passengers[0].identity_documents[0].unique_identifier, 'AB1');
});

test('book refuses if the fare changed since payment', async () => {
  const f = fakeFetch((m, p) => (m === 'GET' ? [200, { data: { ...OFFER, total_amount: '500.00' } }] : null));
  const duffel = createDuffelProvider({ token: 't', fetchImpl: f.impl });
  await assert.rejects(duffel.book({ offerId: 'off_123', amount: '412.30', currency: 'USD', contact: {}, passengers: [{}] }), /Fare changed/);
  assert.equal(f.calls.some((c) => c.path === '/air/orders'), false);
});

test('expired offers raise OfferExpiredError', async () => {
  const f = fakeFetch(() => [422, { errors: [{ code: 'offer_no_longer_available', message: 'gone' }] }]);
  const duffel = createDuffelProvider({ token: 't', fetchImpl: f.impl });
  await assert.rejects(duffel.getOffer('off_x'), OfferExpiredError);
});
