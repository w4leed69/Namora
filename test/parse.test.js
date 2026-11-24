import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, ageOn } from '../src/util/dates.js';
import { parseQuickSearch, parseName, parseEmail, parseCountry } from '../src/util/parse.js';
import { customerPrice } from '../src/util/pricing.js';

const now = new Date('2026-11-24T10:00:00');

test('parseDate handles common formats', () => {
  assert.equal(parseDate('25 Dec', { now }), '2026-12-25');
  assert.equal(parseDate('Dec 25', { now }), '2026-12-25');
  assert.equal(parseDate('25th December 2026', { now }), '2026-12-25');
  assert.equal(parseDate('25/12', { now }), '2026-12-25');
  assert.equal(parseDate('25-12-2026', { now }), '2026-12-25');
  assert.equal(parseDate('2026-12-25', { now }), '2026-12-25');
  assert.equal(parseDate('tomorrow', { now }), '2026-11-25');
  assert.equal(parseDate('today', { now }), '2026-11-24');
});

test('parseDate rolls year forward and rejects past/invalid dates', () => {
  assert.equal(parseDate('10 Jan', { now }), '2027-01-10');
  assert.equal(parseDate('10/01/2026', { now }), null);
  assert.equal(parseDate('31/02/2027', { now }), null);
  assert.equal(parseDate('banana', { now }), null);
});

test('parseDate for birthdays requires a year and allows the past', () => {
  assert.equal(parseDate('14/08/1990', { now, past: true, requireYear: true }), '1990-08-14');
  assert.equal(parseDate('14/08', { now, past: true, requireYear: true }), null);
  assert.equal(ageOn('1990-08-14', '2026-12-25'), 36);
  assert.equal(ageOn('2008-12-26', '2026-12-25'), 17);
});

test('parseQuickSearch understands one-line trips', () => {
  assert.deepEqual(parseQuickSearch('Lahore to Dubai 25 Dec for 2', now), {
    adults: 2, origin: 'Lahore', destination: 'Dubai', departDate: '2026-12-25',
  });
  assert.deepEqual(parseQuickSearch('flights from KHI to JED on 10/01 returning 20/01 3 adults', now), {
    adults: 3, returnDate: '2027-01-20', origin: 'KHI', destination: 'JED', departDate: '2027-01-10',
  });
  assert.deepEqual(parseQuickSearch('islamabad to new york', now), { origin: 'islamabad', destination: 'new york' });
  assert.equal(parseQuickSearch('hello there', now), null);
});

test('name, email and country parsing', () => {
  assert.deepEqual(parseName('Muhammad Ali Khan'), { givenName: 'Muhammad Ali', familyName: 'Khan' });
  assert.equal(parseName('Ali'), null);
  assert.equal(parseName('AB1234567 x'), null);
  assert.equal(parseEmail(' Ali@Example.com '), 'ali@example.com');
  assert.equal(parseEmail('nope'), null);
  assert.equal(parseCountry('Pakistan'), 'PK');
  assert.equal(parseCountry('gb'), 'GB');
});

test('customerPrice applies markup and fee, rounding up', () => {
  assert.deepEqual(customerPrice({ totalAmount: '100.00', currency: 'USD' }, { markupPercent: 5, serviceFee: 2.5 }), {
    amount: 107.5, currency: 'USD', base: 100,
  });
  assert.equal(customerPrice({ totalAmount: '1000', currency: 'JPY' }, { markupPercent: 3.33, serviceFee: 0 }).amount, 1034);
});
