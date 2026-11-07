import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_FIELD = '_csrf';
const TOKEN_HEADER = 'x-csrf-token';

export const newCsrfToken = () => randomBytes(32).toString('base64url');

function tokensMatch(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * CSRF protection, two independent layers:
 *  1. Fetch Metadata: browsers send Sec-Fetch-Site; reject anything that isn't
 *     same-origin (or a direct navigation) on state-changing requests.
 *  2. Synchronizer token: a per-session random token that must be echoed back
 *     in every unsafe request (hidden form field or X-CSRF-Token header).
 * Session cookies are additionally SameSite=Lax.
 */
export function csrfProtection() {
  return function csrf(req, res, next) {
    // Created lazily, only when a page actually renders a form, so anonymous
    // visitors browsing public pages don't get a session (or a cookie).
    Object.defineProperty(res.locals, 'csrfToken', {
      configurable: true,
      enumerable: true,
      get: () => (req.session.csrfToken ??= newCsrfToken()),
    });

    if (SAFE_METHODS.has(req.method)) return next();

    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return next(new HttpError(403, 'Cross-site request blocked.'));
    }

    const submitted = req.body?.[TOKEN_FIELD] ?? req.get(TOKEN_HEADER);
    if (!tokensMatch(req.session.csrfToken, submitted)) {
      return next(new HttpError(403, 'Your session expired or the form was invalid. Please go back, reload the page and try again.'));
    }
    next();
  };
}
