import { formatDate } from './dates.js';
import { customerPrice, formatMoney } from './pricing.js';

export const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const hhmm = (dt) => dt.slice(11, 16); // provider times are local airport time
export const duration = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
export const stopsLabel = (n) => (n === 0 ? 'nonstop' : `${n} stop${n > 1 ? 's' : ''}`);

function dayShift(slice) {
  const diff = Math.round(
    (Date.parse(`${slice.arrivingAt.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${slice.departingAt.slice(0, 10)}T00:00:00Z`)) / 86400000,
  );
  return diff > 0 ? ` (+${diff})` : '';
}

/** One list row for the results list (WhatsApp limits: title 24, description 72). */
export function offerRow(offer, index, pricing) {
  const price = customerPrice(offer, pricing);
  const out = offer.slices[0];
  let desc = `${offer.airline.name} · ${hhmm(out.departingAt)}→${hhmm(out.arrivingAt)}${dayShift(out)} · ${stopsLabel(out.stops)} · ${duration(out.duration)}`;
  if (offer.slices[1]) desc = `${offer.airline.name} · ${stopsLabel(out.stops)} out, ${stopsLabel(offer.slices[1].stops)} back`;
  return {
    id: `offer:${index}`,
    title: truncate(`${index + 1}. ${formatMoney(price.amount, price.currency)}`, 24),
    description: truncate(desc, 72),
  };
}

export function sliceDetails(slice, label) {
  const lines = [`*${label}* · ${formatDate(slice.departingAt)}`];
  lines.push(
    `${slice.origin} ${hhmm(slice.departingAt)} → ${slice.destination} ${hhmm(slice.arrivingAt)}${dayShift(slice)}  (${duration(slice.duration)}, ${stopsLabel(slice.stops)})`,
  );
  for (const seg of slice.segments) {
    lines.push(`   ✈ ${seg.flight}  ${seg.origin} ${hhmm(seg.departingAt)} → ${seg.destination} ${hhmm(seg.arrivingAt)}`);
  }
  return lines.join('\n');
}

export function offerDetails(offer, adults, pricing) {
  const price = customerPrice(offer, pricing);
  const parts = [
    `*${offer.airline.name}*`,
    `💰 *${formatMoney(price.amount, price.currency)}* total for ${adults} adult${adults > 1 ? 's' : ''}`,
    '',
    sliceDetails(offer.slices[0], 'Outbound'),
  ];
  if (offer.slices[1]) parts.push('', sliceDetails(offer.slices[1], 'Return'));
  const extras = [];
  if (offer.baggage) extras.push(`🧳 ${offer.baggage}`);
  if (offer.conditions?.refundable != null) {
    extras.push(offer.conditions.refundable ? '↩️ Refundable (fees may apply)' : '↩️ Non-refundable');
  }
  if (offer.conditions?.changeable != null) {
    extras.push(offer.conditions.changeable ? '🔁 Changes allowed (fees may apply)' : '🔁 No changes allowed');
  }
  if (extras.length) parts.push('', ...extras);
  return parts.join('\n');
}
