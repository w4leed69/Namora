#!/usr/bin/env node
// Checks your Duffel key with a live search (no booking is made).
//   DUFFEL_ACCESS_TOKEN=duffel_test_... npm run duffel:check -- LHE DXB 2026-12-25
import { config } from '../src/config.js';
import { createDuffelProvider } from '../src/flights/duffel.js';
import { formatMoney } from '../src/util/pricing.js';

const [origin = 'LHE', destination = 'DXB', date] = process.argv.slice(2);
const departDate = date ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const duffel = createDuffelProvider({ token: config.flights.duffelToken, cabinClass: config.flights.cabinClass });

console.log(`Searching ${origin} → ${destination} on ${departDate}…`);
const offers = await duffel.search({ origin, destination, departDate, adults: 1 });
console.log(`✅ Duffel key works: ${offers.length} offers`);
for (const o of offers.slice(0, 10)) {
  const s = o.slices[0];
  console.log(`  ${formatMoney(o.totalAmount, o.currency).padEnd(14)} ${o.airline.name.padEnd(32)} ${s.departingAt.slice(11, 16)}→${s.arrivingAt.slice(11, 16)}  ${s.stops ? `${s.stops} stop` : 'nonstop'}`);
}
