const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const pad = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function utcToday(now) {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function make(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d;
}

function fullYear(y) {
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

/**
 * Parse a human-typed date. Returns an ISO date string (YYYY-MM-DD) or null.
 * Accepts: today, tomorrow, 2026-12-25, 25/12, 25/12/2026, 25 Dec, Dec 25, 25th December 2026.
 *
 * opts.past       allow dates before today (e.g. date of birth)
 * opts.requireYear the year must be typed (for DOB / passport expiry)
 */
export function parseDate(input, { now = new Date(), past = false, requireYear = false } = {}) {
  if (!input) return null;
  const s = String(input)
    .trim()
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ');
  const today = utcToday(now);

  if (!requireYear) {
    if (s === 'today') return toISODate(today);
    if (s === 'tomorrow' || s === 'tmrw' || s === 'tmr') {
      return toISODate(new Date(today.getTime() + 86400000));
    }
  }

  let year, month, day, m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/))) {
    // Day-first (as used in Pakistan, UK, most of the world).
    [day, month, year] = [Number(m[1]), Number(m[2]) - 1, m[3] && fullYear(m[3])];
  } else if ((m = s.match(/^(\d{1,2})[ -]([a-z]+)[ -]?(\d{2,4})?$/)) && m[2] in MONTHS) {
    [day, month, year] = [Number(m[1]), MONTHS[m[2]], m[3] && fullYear(m[3])];
  } else if ((m = s.match(/^([a-z]+) (\d{1,2})(?: (\d{2,4}))?$/)) && m[1] in MONTHS) {
    [month, day, year] = [MONTHS[m[1]], Number(m[2]), m[3] && fullYear(m[3])];
  } else {
    return null;
  }

  if (!year) {
    if (requireYear) return null;
    year = today.getUTCFullYear();
    const candidate = make(year, month, day);
    if (candidate && candidate < today && !past) year += 1;
  }
  const d = make(year, month, day);
  if (!d) return null;
  if (!past && d < today) return null;
  return toISODate(d);
}

export function formatDate(iso) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function ageOn(dobIso, onIso) {
  const [by, bm, bd] = dobIso.split('-').map(Number);
  const [y, m, d] = onIso.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}
