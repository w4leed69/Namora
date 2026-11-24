import { truncate } from '../util/format.js';

/** Convert a channel-neutral message (see bot/messages.js) into a WhatsApp Cloud API payload. */
export function toWhatsAppPayload(to, msg) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to };
  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: truncate(msg.text, 4096), preview_url: false } };
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: truncate(msg.text, 1024) },
          action: {
            buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: truncate(b.title, 20) } })),
          },
        },
      };
    case 'list':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: truncate(msg.text, 1024) },
          action: {
            button: truncate(msg.button, 20),
            sections: msg.sections.map((s) => ({
              title: truncate(s.title, 24),
              rows: s.rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: truncate(r.title, 24),
                ...(r.description && { description: truncate(r.description, 72) }),
              })),
            })),
          },
        },
      };
    case 'cta':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          body: { text: truncate(msg.text, 1024) },
          action: { name: 'cta_url', parameters: { display_text: truncate(msg.label, 20), url: msg.url } },
        },
      };
    default:
      throw new Error(`Unknown message type ${msg.type}`);
  }
}

export function createWhatsAppClient({ token, phoneNumberId, apiVersion, fetchImpl = fetch, log = console }) {
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const enabled = Boolean(token && phoneNumberId);
  if (!enabled) log.warn('[whatsapp] WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set: outgoing messages will only be logged');

  async function post(payload) {
    if (!enabled) {
      log.info(`[whatsapp:dry-run] → ${payload.to ?? ''} ${JSON.stringify(payload.text ?? payload.interactive ?? payload.status)}`);
      return;
    }
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp API ${res.status}: ${body}`);
    }
    return res.json();
  }

  return {
    async send(to, messages) {
      for (const msg of messages) {
        try {
          await post(toWhatsAppPayload(to, msg));
        } catch (err) {
          log.error('[whatsapp] send failed', err.message);
        }
      }
    },
    /** Blue ticks + "typing…" indicator while the bot works. */
    async markRead(messageId) {
      try {
        await post({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
      } catch (err) {
        log.warn('[whatsapp] mark-read failed', err.message);
      }
    },
  };
}
