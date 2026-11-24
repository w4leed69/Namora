import { searchLocalAirports } from '../data/airports.js';
import { OfferExpiredError, ProviderError } from './errors.js';

const API = 'https://api.duffel.com';

function isoDurationToMinutes(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  if (!m) return 0;
  return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

function summariseBaggage(offer) {
  const bags = offer.slices?.[0]?.segments?.[0]?.passengers?.[0]?.baggages ?? [];
  const checked = bags.filter((b) => b.type === 'checked').reduce((n, b) => n + (b.quantity || 0), 0);
  if (checked > 0) return `${checked} checked bag${checked > 1 ? 's' : ''} included`;
  if (bags.length) return 'Cabin bag only';
  return null;
}

export function normaliseOffer(o) {
  return {
    id: o.id,
    provider: 'duffel',
    airline: { code: o.owner?.iata_code, name: o.owner?.name ?? o.owner?.iata_code },
    totalAmount: o.total_amount,
    currency: o.total_currency,
    slices: o.slices.map((s) => {
      const segs = s.segments;
      return {
        origin: s.origin.iata_code,
        destination: s.destination.iata_code,
        departingAt: segs[0].departing_at,
        arrivingAt: segs[segs.length - 1].arriving_at,
        duration: isoDurationToMinutes(s.duration),
        stops: segs.length - 1 + segs.reduce((n, g) => n + (g.stops?.length || 0), 0),
        segments: segs.map((g) => ({
          flight: `${g.marketing_carrier?.iata_code ?? ''} ${g.marketing_carrier_flight_number ?? ''}`.trim(),
          origin: g.origin.iata_code,
          destination: g.destination.iata_code,
          departingAt: g.departing_at,
          arrivingAt: g.arriving_at,
        })),
      };
    }),
    passengerIds: o.passengers.map((p) => p.id),
    requiresPassport: Boolean(o.passenger_identity_documents_required),
    expiresAt: o.expires_at,
    baggage: summariseBaggage(o),
    conditions: {
      refundable: o.conditions?.refund_before_departure ? Boolean(o.conditions.refund_before_departure.allowed) : null,
      changeable: o.conditions?.change_before_departure ? Boolean(o.conditions.change_before_departure.allowed) : null,
    },
  };
}

/**
 * Duffel (https://duffel.com) — search 300+ airlines and issue real tickets.
 * Tickets are paid from your Duffel balance; the customer pays you via the
 * payment provider first. Use a `duffel_test_...` token for sandbox.
 */
export function createDuffelProvider({ token, cabinClass = 'economy', maxResults = 10, fetchImpl = fetch }) {
  if (!token) throw new Error('DUFFEL_ACCESS_TOKEN is required when FLIGHT_PROVIDER=duffel');

  async function call(method, path, body) {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Duffel-Version': 'v2',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify({ data: body }) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json.errors?.[0] ?? {};
      const code = err.code ?? '';
      if (res.status === 404 || /offer.*(expired|no_longer_available)|(expired|no_longer_available).*offer/.test(code)) {
        throw new OfferExpiredError(err.message);
      }
      throw new ProviderError(err.message || `Duffel ${method} ${path} failed (${res.status})`, json.errors);
    }
    return json.data;
  }

  return {
    name: 'duffel',

    async searchPlaces(query) {
      try {
        const data = await call('GET', `/places/suggestions?query=${encodeURIComponent(query)}`);
        const places = data
          .filter((p) => p.iata_code && (p.type === 'airport' || p.type === 'city'))
          .map((p) => ({
            code: p.iata_code,
            name: p.type === 'city' ? `${p.name} (all airports)` : p.name,
            city: p.city_name ?? p.name,
            country: p.iata_country_code,
          }));
        if (places.length) return places.slice(0, 10);
      } catch (e) {
        console.warn('[duffel] place search failed, using local list:', e.message);
      }
      return searchLocalAirports(query);
    },

    async search({ origin, destination, departDate, returnDate, adults }) {
      const slices = [{ origin, destination, departure_date: departDate }];
      if (returnDate) slices.push({ origin: destination, destination: origin, departure_date: returnDate });
      const data = await call('POST', '/air/offer_requests?return_offers=true&supplier_timeout=20000', {
        slices,
        passengers: Array.from({ length: adults }, () => ({ type: 'adult' })),
        cabin_class: cabinClass,
      });
      return (data.offers ?? [])
        .map(normaliseOffer)
        .sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount))
        .slice(0, maxResults);
    },

    async getOffer(id) {
      return normaliseOffer(await call('GET', `/air/offers/${id}`));
    },

    async book({ offerId, passengers, amount, currency, contact }) {
      const offer = await this.getOffer(offerId);
      if (Number(offer.totalAmount) !== Number(amount) || offer.currency !== currency) {
        throw new ProviderError(`Fare changed from ${currency} ${amount} to ${offer.currency} ${offer.totalAmount}`);
      }
      const order = await call('POST', '/air/orders', {
        type: 'instant',
        selected_offers: [offerId],
        payments: [{ type: 'balance', amount: offer.totalAmount, currency: offer.currency }],
        passengers: passengers.map((p, i) => ({
          id: offer.passengerIds[i],
          title: p.gender === 'm' ? 'mr' : 'ms',
          gender: p.gender,
          given_name: p.givenName,
          family_name: p.familyName,
          born_on: p.dob,
          email: contact.email,
          phone_number: contact.phone,
          ...(p.passport && {
            identity_documents: [{
              type: 'passport',
              unique_identifier: p.passport.number,
              issuing_country_code: p.passport.country,
              expires_on: p.passport.expiry,
            }],
          }),
        })),
      });
      return { orderId: order.id, pnr: order.booking_reference };
    },
  };
}
