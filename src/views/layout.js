import { html } from './html.js';

const csrfField = (token) => html`<input type="hidden" name="_csrf" value="${token}">`;

function nav(user, csrfToken) {
  if (user) {
    return html`
      <a href="/map">Map</a>
      <a href="/notes">My notes</a>
      <span class="who">Signed in as <strong>${user.username}</strong></span>
      <form method="post" action="/logout" class="inline">
        ${csrfField(csrfToken)}
        <button type="submit" class="link">Sign out</button>
      </form>`;
  }
  return html`
    <a href="/map">Map</a>
    <a href="/login">Sign in</a>
    <a href="/register" class="button small">Create account</a>`;
}

export function layout({ title, content, user, csrfToken, flash, wide = false, head = '', scripts = '' }) {
  const container = wide ? 'container wide' : 'container';
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${title} · SecureNotes</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${head}
  <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
  <header class="site-header">
    <div class="${container} header-inner">
      <a href="/" class="brand">SecureNotes</a>
      <nav>${nav(user, csrfToken)}</nav>
    </div>
  </header>
  <main class="${container}">
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
    ${content}
  </main>
  <footer class="site-footer">
    <div class="${container}">SecureNotes — a security-first Node.js starter.</div>
  </footer>
  ${scripts}
</body>
</html>`;
}

export { csrfField };
