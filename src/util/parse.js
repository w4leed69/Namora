import { parseDate } from './dates.js';

const PAX_RE = /\b(?:for\s+)?(\d{1,2})\s*(?:adults?|people|persons?|passengers?|pax|travell?ers?|seats?)\b|\bfor\s+(\d{1,2})\b/i;
const RETURN_RE = /\s+(?:and\s+)?(?:returning|return|back|coming back)\s+(?:on\s+)?(.+)$/i;
const ROUTE_RE = /^(?:(?:i\s+want\s+to\s+)?(?:find|search|book|get|need)\s+)?(?:a\s+)?(?:(?:cheap|one[- ]way|return)\s+)?(?:flights?|tickets?)?\s*(?:from\s+)?(.+?)\s+(?:to|->|→)\s+(.+)$/i;

/**
 * Parse a one-line search like "Lahore to Dubai 25 Dec for 2" or
 * "KHI to JED on 10/01 returning 20/01 2 adults".
 * Returns { origin, destination, departDate?, returnDate?, adults? } or null.
 * origin/destination are raw text — they still need resolving to airports.
 */
export function parseQuickSearch(text, now = new Date()) {
  let s = String(text).trim().replace(/\s+/g, ' ');
  if (!/\s(?:to|->|→)\s/i.test(s)) return null;

  const result = {};
  const pax = s.match(PAX_RE);
  if (pax) {
    const n = Number(pax[1] ?? pax[2]);
    if (n >= 1 && n <= 9) result.adults = n;
    s = (s.slice(0, pax.index) + s.slice(pax.index + pax[0].length)).replace(/\s+/g, ' ').trim();
  }

  const ret = s.match(RETURN_RE);
  if (ret) {
    const d = parseDate(ret[1].trim(), { now });
    if (d) {
      result.returnDate = d;
      s = s.slice(0, ret.index).trim();
    }
  }

  const route = s.match(ROUTE_RE);
  if (!route) return null;
  result.origin = route[1].trim();

  // Split "dubai on 25 dec" / "dubai 25 dec" into destination + date.
  const rest = route[2].trim();
  const onIdx = rest.toLowerCase().lastIndexOf(' on ');
  if (onIdx > 0) {
    const d = parseDate(rest.slice(onIdx + 4), { now });
    if (d) {
      result.destination = rest.slice(0, onIdx).trim();
      result.departDate = d;
    }
  }
  if (!result.destination) {
    const tokens = rest.split(' ');
    for (let i = 1; i < tokens.length; i++) {
      const d = parseDate(tokens.slice(i).join(' '), { now });
      if (d) {
        result.destination = tokens.slice(0, i).join(' ');
        result.departDate = d;
        break;
      }
    }
  }
  if (!result.destination) result.destination = rest;
  if (result.returnDate && result.departDate && result.returnDate < result.departDate) {
    delete result.returnDate;
  }
  if (!result.origin || !result.destination) return null;
  return result;
}

export function parseName(text) {
  const parts = String(text).trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length < 2) return null;
  if (!parts.every((p) => /^[\p{L}][\p{L}'.-]*$/u.test(p))) return null;
  const familyName = parts.pop();
  return { givenName: parts.join(' '), familyName };
}

export function parseEmail(text) {
  const s = String(text).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) ? s.toLowerCase() : null;
}

const COUNTRY_NAMES = {
  pakistan: 'PK', india: 'IN', bangladesh: 'BD', 'united kingdom': 'GB', uk: 'GB', britain: 'GB',
  'united states': 'US', usa: 'US', america: 'US', canada: 'CA', uae: 'AE',
  'united arab emirates': 'AE', 'saudi arabia': 'SA', ksa: 'SA', qatar: 'QA', oman: 'OM',
  turkey: 'TR', turkiye: 'TR', afghanistan: 'AF', china: 'CN', germany: 'DE', france: 'FR',
  'sri lanka': 'LK', nepal: 'NP', malaysia: 'MY', australia: 'AU', egypt: 'EG',
};

export function parseCountry(text) {
  const s = String(text).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_NAMES[s] ?? null;
}
