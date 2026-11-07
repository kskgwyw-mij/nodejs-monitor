/**
 * Tiny auto-escaping HTML templating.
 *
 *   html`<p>${userInput}</p>`   -> userInput is HTML-escaped
 *   html`<ul>${items.map(i => html`<li>${i}</li>`)}</ul>`  -> nested templates are kept as-is
 *
 * Every interpolated value is escaped unless it is itself the result of `html`
 * (or explicitly wrapped with `trusted`). Always quote attribute values.
 */

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const escapeHtml = (value) => String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);

/** Marks a string as trusted HTML. Never pass user input to this. */
export const trusted = (value) => new SafeHtml(String(value));

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}
