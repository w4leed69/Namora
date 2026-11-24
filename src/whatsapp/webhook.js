import crypto from 'node:crypto';

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // not configured — accept (logged at startup)
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Extract incoming user messages from a WhatsApp webhook body.
 * Returns [{ id, from, profileName, text, replyId, type }]
 */
export function parseIncoming(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        const msg = { id: m.id, from: m.from, profileName: names[m.from], type: m.type, text: null, replyId: null };
        if (m.type === 'text') msg.text = m.text?.body ?? '';
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          msg.replyId = r?.id ?? null;
          msg.text = r?.title ?? '';
        } else if (m.type === 'button') {
          msg.replyId = m.button?.payload ?? null;
          msg.text = m.button?.text ?? '';
        }
        out.push(msg);
      }
    }
  }
  return out;
}
