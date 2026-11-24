import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../src/server.js';
import { createStore } from '../src/store.js';
import { createMockProvider } from '../src/flights/mock.js';
import { createMockPayments } from '../src/payments/mock.js';
import { toWhatsAppPayload } from '../src/whatsapp/client.js';

const quiet = { info() {}, warn() {}, error() {}, log() {} };
const cfg = {
  port: 0, publicUrl: 'http://x.test', brandName: 'Namora', supportContact: '',
  whatsapp: { verifyToken: 'vt', appSecret: 'shh', displayNumber: '' },
  flights: { maxResults: 10 }, payments: { provider: 'mock' }, pricing: { markupPercent: 0, serviceFee: 0 },
};

async function start() {
  const sent = [];
  const whatsapp = { send: async (to, msgs) => sent.push(...msgs.map((m) => ({ to, ...m }))), markRead: async () => {} };
  const { app, enqueue } = await createApp({
    config: cfg, log: quiet, store: createStore(null), whatsapp,
    flights: createMockProvider(), payments: createMockPayments({ publicUrl: cfg.publicUrl }),
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, sent, server, flush: () => enqueue('923000000000', async () => {}) };
}

const sign = (body) => `sha256=${crypto.createHmac('sha256', 'shh').update(body).digest('hex')}`;
const waBody = (id, text) => JSON.stringify({
  entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '923000000000', profile: { name: 'Bilal' } }],
    messages: [{ id, from: '923000000000', type: 'text', text: { body: text } }],
  } }] }],
});

test('webhook verification handshake', async (t) => {
  const { base, server } = await start();
  t.after(() => server.close());
  let r = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42`);
  assert.equal(await r.text(), '42');
  r = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(r.status, 403);
});

test('signed messages are processed once; unsigned are rejected', async (t) => {
  const { base, sent, server, flush } = await start();
  t.after(() => server.close());
  const body = waBody('wamid.1', 'hi');
  let r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=bad' }, body });
  assert.equal(r.status, 401);

  for (let i = 0; i < 2; i++) { // Meta retry → de-duplicated
    r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    assert.equal(r.status, 200);
  }
  await new Promise((res) => setTimeout(res, 50));
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Hi Bilal/);
});

test('mock checkout page completes payment and tickets the booking', async (t) => {
  const { base, sent, server, flush } = await start();
  t.after(() => server.close());
  const post = async (id, text) => {
    const body = waBody(id, text);
    await fetch(`${base}/webhook/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
    await new Promise((res) => setTimeout(res, 20));
    await flush();
  };
  const steps = ['Lahore to Karachi 25 Dec for 1', '1', 'book', 'Bilal Ahmed', '01/02/1990', 'male', 'b@example.com', 'pay'];
  for (const [i, s] of steps.entries()) await post(`m${i}`, s);
  const link = sent.find((m) => m.type === 'cta');
  assert.ok(link, 'got payment link');
  const path = new URL(link.url).pathname;
  const page = await fetch(`${base}${path}`);
  assert.match(await page.text(), /Pay now/);
  const paid = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual' });
  assert.equal(paid.status, 303);
  await new Promise((res) => setTimeout(res, 20));
  await flush();
  assert.ok(sent.some((m) => /Your flight is booked/.test(m.text)));
});

test('WhatsApp payloads respect Cloud API limits', () => {
  const p = toWhatsAppPayload('1', { type: 'buttons', text: 'x', buttons: [{ id: 'a', title: 'A very very long button title' }] });
  assert.equal(p.interactive.action.buttons[0].reply.title.length, 20);
  const l = toWhatsAppPayload('1', { type: 'list', text: 'x', button: 'View', sections: [{ title: 'S', rows: Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, title: 'T'.repeat(30), description: 'D'.repeat(100) })) }] });
  assert.equal(l.interactive.action.sections[0].rows.length, 10);
  assert.equal(l.interactive.action.sections[0].rows[0].title.length, 24);
  assert.equal(l.interactive.action.sections[0].rows[0].description.length, 72);
  const c = toWhatsAppPayload('1', { type: 'cta', text: 'pay', label: 'Pay now', url: 'https://p' });
  assert.equal(c.interactive.type, 'cta_url');
});
