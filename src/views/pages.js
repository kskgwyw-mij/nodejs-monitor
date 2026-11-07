import { html } from './html.js';
import { csrfField } from './layout.js';
import { LIMITS } from '../validation.js';

const fieldError = (errors, name) =>
  errors?.[name] ? html`<p class="field-error" id="${name}-error">${errors[name]}</p>` : '';

const describedBy = (errors, name) => (errors?.[name] ? html` aria-invalid="true" aria-describedby="${name}-error"` : '');

export function homePage({ user }) {
  return html`
    <section class="hero">
      <h1>Private notes, built secure by default.</h1>
      <p class="lead">A small Node.js website that shows how to get the fundamentals right:
        hardened HTTP headers, safe sessions, CSRF protection, strong password hashing,
        rate limiting and injection-safe data access.</p>
      <a class="button" href="/map">Explore the map</a>
      ${user
        ? html`<a class="button secondary" href="/notes">Go to my notes</a>`
        : html`<a class="button secondary" href="/register">Create a free account</a>`}
    </section>
    <section class="features">
      <article><h2>Strict CSP</h2><p>No inline scripts, no third-party origins, no framing. XSS has nowhere to run.</p></article>
      <article><h2>scrypt passwords</h2><p>Memory-hard hashing with per-user salts and constant-time comparison.</p></article>
      <article><h2>Hardened sessions</h2><p>HttpOnly, SameSite, <code>__Host-</code> cookies, idle and absolute timeouts, fixation-safe login.</p></article>
      <article><h2>Abuse limits</h2><p>Per-IP rate limits on login and sign-up, request size caps and slow-client timeouts.</p></article>
    </section>`;
}

function authForm({ action, heading, submitLabel, csrfToken, values = {}, errors = {}, footer, autocompletePassword }) {
  return html`
    <section class="card narrow">
      <h1>${heading}</h1>
      ${errors.form ? html`<div class="flash flash-error" role="alert">${errors.form}</div>` : ''}
      <form method="post" action="${action}" novalidate>
        ${csrfField(csrfToken)}
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required
          minlength="${LIMITS.usernameMin}" maxlength="${LIMITS.usernameMax}"
          autocomplete="username" autocapitalize="none" spellcheck="false"
          value="${values.username ?? ''}"${describedBy(errors, 'username')}>
        ${fieldError(errors, 'username')}

        <label for="password">Password</label>
        <input id="password" name="password" type="password" required
          minlength="${LIMITS.passwordMin}" maxlength="${LIMITS.passwordMax}"
          autocomplete="${autocompletePassword}"${describedBy(errors, 'password')}>
        ${fieldError(errors, 'password')}
        ${autocompletePassword === 'new-password'
          ? html`<p class="hint">At least ${LIMITS.passwordMin} characters. A passphrase of a few random words works well.</p>`
          : ''}

        <button type="submit">${submitLabel}</button>
      </form>
      <p class="muted">${footer}</p>
    </section>`;
}

export const registerPage = (opts) =>
  authForm({
    ...opts,
    action: '/register',
    heading: 'Create your account',
    submitLabel: 'Create account',
    autocompletePassword: 'new-password',
    footer: html`Already have an account? <a href="/login">Sign in</a>.`,
  });

export const loginPage = (opts) =>
  authForm({
    ...opts,
    action: '/login',
    heading: 'Sign in',
    submitLabel: 'Sign in',
    autocompletePassword: 'current-password',
    footer: html`New here? <a href="/register">Create an account</a>.`,
  });

export function notesPage({ notes, csrfToken, values = {}, errors = {} }) {
  return html`
    <h1>My notes</h1>
    <section class="card">
      <h2>New note</h2>
      <form method="post" action="/notes" novalidate>
        ${csrfField(csrfToken)}
        <label for="title">Title</label>
        <input id="title" name="title" type="text" required maxlength="${LIMITS.titleMax}"
          value="${values.title ?? ''}"${describedBy(errors, 'title')}>
        ${fieldError(errors, 'title')}

        <label for="body">Note</label>
        <textarea id="body" name="body" rows="5" maxlength="${LIMITS.bodyMax}"${describedBy(errors, 'body')}>${values.body ?? ''}</textarea>
        ${fieldError(errors, 'body')}

        <button type="submit">Save note</button>
      </form>
    </section>

    <section>
      ${notes.length === 0
        ? html`<p class="muted">No notes yet. Write your first one above.</p>`
        : html`<ul class="notes">
            ${notes.map(
              (n) => html`
              <li class="note">
                <div class="note-head">
                  <h3>${n.title}</h3>
                  <form method="post" action="/notes/${n.id}/delete" class="inline">
                    ${csrfField(csrfToken)}
                    <button type="submit" class="link danger" aria-label="Delete note: ${n.title}">Delete</button>
                  </form>
                </div>
                <p class="note-body">${n.body}</p>
                <time datetime="${n.created_at}">${new Date(n.created_at).toUTCString()}</time>
              </li>`,
            )}
          </ul>`}
    </section>`;
}

export function errorPage({ status, message }) {
  return html`
    <section class="card narrow">
      <h1>${status}</h1>
      <p>${message}</p>
      <p><a href="/">Back to the home page</a></p>
    </section>`;
}

export function mapPage({ defaultView, tileUrl, minDataZoom }) {
  return html`
    <div class="map-head">
      <h1>Explore the map</h1>
      <p class="muted">Pan and zoom the map. The OpenStreetMap categories of everything in view are listed below. Select one to highlight it on the map.</p>
    </div>
    <div id="map" class="map" role="region" aria-label="Interactive map"
      data-lat="${defaultView.lat}" data-lon="${defaultView.lon}" data-zoom="${defaultView.zoom}"
      data-min-data-zoom="${minDataZoom}" data-tile-url="${tileUrl}"></div>
    <noscript><p class="flash flash-info">The interactive map needs JavaScript.</p></noscript>

    <section class="categories" aria-labelledby="categories-heading">
      <div class="categories-head">
        <h2 id="categories-heading">Categories in view</h2>
        <button type="button" id="clear-selection" class="link" hidden>Clear highlights</button>
      </div>
      <p id="map-status" class="map-status muted" role="status" aria-live="polite">Loading…</p>
      <div id="category-list" class="category-list"></div>
      <p class="muted small">Map data © <a href="https://www.openstreetmap.org/copyright" rel="noopener noreferrer">OpenStreetMap contributors</a>, available under the Open Database License.</p>
    </section>`;
}
