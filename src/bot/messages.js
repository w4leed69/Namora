// Channel-neutral outgoing message builders. The WhatsApp adapter (and the CLI
// simulator) render these into their own formats.

export const text = (body) => ({ type: 'text', text: body });

/** Up to 3 quick-reply buttons. `btns` is a list of [id, title]. */
export const buttons = (body, btns) => ({
  type: 'buttons',
  text: body,
  buttons: btns.map(([id, title]) => ({ id, title })),
});

/** A tappable list (max 10 rows). rows: [{ id, title, description }] */
export const list = (body, buttonLabel, rows, sectionTitle = 'Options') => ({
  type: 'list',
  text: body,
  button: buttonLabel,
  sections: [{ title: sectionTitle, rows: rows.slice(0, 10) }],
});

/** A message with a single URL button (used for the payment link). */
export const cta = (body, label, url) => ({ type: 'cta', text: body, label, url });
