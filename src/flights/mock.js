import crypto from 'node:crypto';
import { airportByCode, searchLocalAirports } from '../data/airports.js';
import { OfferExpiredError, ProviderError } from './errors.js';

const AIRLINES = [
  { code: 'PK', name: 'PIA' },
  { code: 'EK', name: 'Emirates' },
  { code: 'QR', name: 'Qatar Airways' },
  { code: 'EY', name: 'Etihad' },
  { code: 'TK', name: 'Turkish Airlines' },
  { code: 'FZ', name: 'flydubai' },
  { code: 'PA', name: 'airblue' },
  { code: 'SV', name: 'Saudia' },
  { code: 'G9', name: 'Air Arabia' },
  { code: 'WY', name: 'Oman Air' },
];
const HUBS = ['DXB', 'DOH', 'IST', 'AUH', 'JED', 'MCT'];

function rng(seedText) {
  let a = crypto.createHash('sha256').update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n) => String(n).padStart(2, '0');
function addMinutes(localIso, mins) {
  const d = new Date(`${localIso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  return d.toISOString().slice(0, 19);
}

function buildSlice(rand, origin, destination, date, airline, nonstopMins) {
  const depart = `${date}T${pad(Math.floor(rand() * 22) + 1)}:${pad(Math.floor(rand() * 12) * 5)}:00`;
  const stops = rand() < 0.55 ? 0 : 1;
  const flightNo = () => `${airline.code} ${100 + Math.floor(rand() * 800)}`;
  if (stops === 0) {
    const arrive = addMinutes(depart, nonstopMins);
    return {
      origin, destination, departingAt: depart, arrivingAt: arrive, duration: nonstopMins, stops,
      segments: [{ flight: flightNo(), origin, destination, departingAt: depart, arrivingAt: arrive }],
    };
  }
  const hubs = HUBS.filter((h) => h !== origin && h !== destination);
  const hub = hubs[Math.floor(rand() * hubs.length)];
  const leg1 = Math.round(nonstopMins * 0.55);
  const leg2 = Math.round(nonstopMins * 0.65);
  const layover = 60 + Math.floor(rand() * 8) * 30;
  const a1 = addMinutes(depart, leg1);
  const d2 = addMinutes(a1, layover);
  const a2 = addMinutes(d2, leg2);
  return {
    origin, destination, departingAt: depart, arrivingAt: a2, duration: leg1 + layover + leg2, stops,
    segments: [
      { flight: flightNo(), origin, destination: hub, departingAt: depart, arrivingAt: a1 },
      { flight: flightNo(), origin: hub, destination, departingAt: d2, arrivingAt: a2 },
    ],
  };
}

/**
 * Offline provider that generates realistic-looking, deterministic fares.
 * Lets you develop and demo the whole WhatsApp flow without any API keys.
 */
export function createMockProvider({ currency = process.env.MOCK_CURRENCY || 'USD', failBooking = false } = {}) {
  const offers = new Map();

  return {
    name: 'mock',

    async searchPlaces(query) {
      return searchLocalAirports(query).map((a) => ({
        code: a.code, name: a.name, city: a.city, country: a.country,
      }));
    },

    async search({ origin, destination, departDate, returnDate, adults }) {
      const routeRand = rng(`${origin}-${destination}`);
      const nonstopMins = 80 + Math.floor(routeRand() * 560);
      const basePrice = 60 + nonstopMins * (0.45 + routeRand() * 0.4);
      const rand = rng(`${origin}-${destination}-${departDate}-${returnDate ?? ''}`);
      const count = 6 + Math.floor(rand() * 4);
      const expiresAt = new Date(Date.now() + 30 * 60000).toISOString();

      const results = [];
      for (let i = 0; i < count; i++) {
        const airline = AIRLINES[Math.floor(rand() * AIRLINES.length)];
        const slices = [buildSlice(rand, origin, destination, departDate, airline, nonstopMins)];
        if (returnDate) slices.push(buildSlice(rand, destination, origin, returnDate, airline, nonstopMins));
        const stopsFactor = slices.some((s) => s.stops) ? 0.82 : 1;
        const perPax = basePrice * (0.8 + rand() * 0.7) * stopsFactor * (returnDate ? 1.8 : 1);
        const intl = airportByCode(origin)?.country !== airportByCode(destination)?.country;
        const offer = {
          id: `mock_off_${crypto.randomBytes(6).toString('hex')}`,
          provider: 'mock',
          airline,
          totalAmount: (Math.round(perPax * adults * 100) / 100).toFixed(2),
          currency,
          slices,
          passengerIds: Array.from({ length: adults }, (_, k) => `mock_pas_${k}`),
          requiresPassport: intl,
          expiresAt,
          baggage: rand() < 0.7 ? `${rand() < 0.5 ? 1 : 2} checked bag(s) included` : 'Cabin bag only',
          conditions: { refundable: rand() < 0.4, changeable: rand() < 0.7 },
        };
        offers.set(offer.id, offer);
        results.push(offer);
      }
      return results.sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));
    },

    async getOffer(id) {
      const offer = offers.get(id);
      if (!offer || Date.parse(offer.expiresAt) < Date.now()) throw new OfferExpiredError();
      return structuredClone(offer);
    },

    async book({ offerId, passengers }) {
      if (failBooking) throw new ProviderError('Airline rejected the booking (mock failure)');
      const offer = offers.get(offerId);
      if (!offer) throw new OfferExpiredError();
      if (passengers.length !== offer.passengerIds.length) throw new ProviderError('Passenger count mismatch');
      const pnr = crypto.randomBytes(3).toString('hex').toUpperCase();
      return { orderId: `mock_ord_${crypto.randomBytes(6).toString('hex')}`, pnr };
    },
  };
}
