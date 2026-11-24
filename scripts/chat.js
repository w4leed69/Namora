#!/usr/bin/env node
// Chat with the bot in your terminal, with no WhatsApp, Duffel or Stripe needed.
//   npm run chat
// Buttons and list rows are numbered: type the number to tap one.
// When you get a payment link, type /pay to simulate a successful payment.
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { config } from '../src/config.js';
import { createStore } from '../src/store.js';
import { createBot } from '../src/bot/conversation.js';
import { createFlightProvider } from '../src/flights/index.js';
import { createMockPayments } from '../src/payments/mock.js';

const USER = '923001234567';
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bold = (s) => s.replace(/\*([^*\n]+)\*/g, '\x1b[1m$1\x1b[0m').replace(/_([^_\n]+)_/g, '\x1b[3m$1\x1b[0m');

let options = [];
let lastBookingId = null;

function render(msg) {
  console.log(green('┃ ') + bold(msg.text).split('\n').join(`\n${green('┃ ')}`));
  if (msg.type === 'buttons') {
    options = msg.buttons.map((b) => b.id);
    msg.buttons.forEach((b, i) => console.log(dim(`   [${i + 1}] ${b.title}`)));
  } else if (msg.type === 'list') {
    options = msg.sections.flatMap((s) => s.rows.map((r) => r.id));
    console.log(dim(`   ☰ ${msg.button}`));
    msg.sections.flatMap((s) => s.rows).forEach((r, i) => console.log(dim(`   [${i + 1}] ${r.title}  ${r.description ?? ''}`)));
  } else if (msg.type === 'cta') {
    options = [];
    lastBookingId = msg.url.split('/').pop();
    console.log(dim(`   🔗 ${msg.label}: ${msg.url}   (type /pay to simulate payment)`));
  } else {
    options = [];
  }
  console.log();
}

const flights = createFlightProvider(config.flights);
const payments = createMockPayments({ publicUrl: config.publicUrl });
const store = createStore(null);
const bot = createBot({
  flights, payments, store, config,
  log: { ...console, error: (...a) => console.error(dim(a.map(String).join(' '))) },
  notify: async (_to, msgs) => msgs.forEach(render),
});

console.log(dim(`${config.brandName} WhatsApp bot simulator · flights=${flights.name} · type "hi" to start, /quit to exit\n`));
const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '> ' });
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === '/quit' || line === '/exit') break;
  if (line) {
    if (!stdin.isTTY) console.log(line);
    console.log();
    const n = Number(line);
    if (line === '/pay') {
      if (!lastBookingId) console.log(dim('No payment link yet.\n'));
      else await bot.onPaymentSucceeded(lastBookingId, { paymentIntent: 'sim_pi' });
    } else if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      await bot.handle(USER, { replyId: options[n - 1], profileName: 'Test User' });
    } else {
      await bot.handle(USER, { text: line, profileName: 'Test User' });
    }
  }
  rl.prompt();
}
rl.close();
