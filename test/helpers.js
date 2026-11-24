import { createBot } from '../src/bot/conversation.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/flights/mock.js';
import { createMockPayments } from '../src/payments/mock.js';

export const NOW = new Date('2026-11-24T10:00:00');
export const USER = '923001234567';

export function setup({ flights = createMockProvider({ currency: 'USD' }), payments, pricing = { markupPercent: 0, serviceFee: 0 } } = {}) {
  const store = createStore(null);
  const sent = [];
  const pay = payments ?? createMockPayments({ publicUrl: 'https://example.test' });
  const quiet = { info() {}, warn() {}, error() {}, log() {} };
  const bot = createBot({
    flights, payments: pay, store, now: () => NOW, log: quiet,
    config: { brandName: 'Namora', supportContact: '', flights: { maxResults: 10 }, pricing },
    notify: async (to, msgs) => sent.push(...msgs.map((m) => ({ to, ...m }))),
  });
  const say = async (text) => { sent.length = 0; await bot.handle(USER, { text }); return [...sent]; };
  const tap = async (replyId) => { sent.length = 0; await bot.handle(USER, { replyId }); return [...sent]; };
  const last = () => sent[sent.length - 1];
  return { bot, store, sent, say, tap, last, flights, payments: pay };
}

/** Drive a full booking for 1 adult on a domestic route (no passport needed). */
export async function bookToPaymentLink(h) {
  await h.say('Lahore to Karachi 25 Dec for 1');
  await h.tap('offer:0');
  await h.tap('offer:book');
  await h.say('Ayesha Khan');
  await h.say('14/08/1990');
  await h.tap('gender:f');
  await h.say('ayesha@example.com');
  return h.tap('confirm:pay');
}
