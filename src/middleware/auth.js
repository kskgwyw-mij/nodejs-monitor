import { promisify } from 'node:util';
import { newCsrfToken } from '../security/csrf.js';

/**
 * Starts an authenticated session. The session ID is regenerated to prevent
 * session fixation, and a fresh CSRF token is issued.
 */
export async function startAuthenticatedSession(req, user) {
  await promisify(req.session.regenerate.bind(req.session))();
  req.session.userId = user.id;
  req.session.authenticatedAt = Date.now();
  req.session.csrfToken = newCsrfToken();
  await promisify(req.session.save.bind(req.session))();
}

export async function endSession(req, res, cookieName) {
  await promisify(req.session.destroy.bind(req.session))();
  res.clearCookie(cookieName, { path: '/' });
}

/** Loads req.user from the session, enforcing the absolute session lifetime. */
export function loadUser({ db, absoluteTimeoutMs }) {
  const findUser = db.prepare('SELECT id, username FROM users WHERE id = ?');

  return async function loadUserMiddleware(req, res, next) {
    const { userId, authenticatedAt } = req.session;
    if (!userId) return next();

    const expired = !authenticatedAt || Date.now() - authenticatedAt > absoluteTimeoutMs;
    const user = expired ? undefined : findUser.get(userId);

    if (!user) {
      // Expired, or the account no longer exists: drop to a fresh anonymous session.
      await promisify(req.session.regenerate.bind(req.session))();
      return next();
    }
    req.user = user;
    res.locals.user = user;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  req.session.flash = { type: 'info', message: 'Please sign in to continue.' };
  res.redirect(303, '/login');
}

export function redirectIfAuthenticated(req, res, next) {
  if (req.user) return res.redirect(303, '/notes');
  next();
}
