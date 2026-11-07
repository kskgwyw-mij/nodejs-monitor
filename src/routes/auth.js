import { Router } from 'express';
import { dummyHash, hashPassword, needsRehash, verifyPassword } from '../security/passwords.js';
import { endSession, redirectIfAuthenticated, startAuthenticatedSession } from '../middleware/auth.js';
import { validateCredentials } from '../validation.js';
import { loginPage, registerPage } from '../views/pages.js';
import { render } from '../views/render.js';

const GENERIC_LOGIN_ERROR = 'Incorrect username or password.';
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function authRouter({ db, limiters, cookieName }) {
  const router = Router();
  const stmts = {
    findByUsername: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id, username'),
    updateHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  };

  // ---- Registration ----
  router.get('/register', redirectIfAuthenticated, (req, res) => {
    render(req, res, { title: 'Create account', content: registerPage({ csrfToken: res.locals.csrfToken }) });
  });

  router.post('/register', limiters.register, redirectIfAuthenticated, async (req, res) => {
    const { username, password, errors, valid } = validateCredentials(req.body, { isNew: true });
    const fail = (status, errs) =>
      render(req, res, {
        status,
        title: 'Create account',
        content: registerPage({ csrfToken: res.locals.csrfToken, values: { username }, errors: errs }),
      });

    if (!valid) return fail(422, errors);

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = stmts.insertUser.get(username, passwordHash);
    } catch (err) {
      if (err.errcode === SQLITE_CONSTRAINT_UNIQUE) {
        return fail(409, { username: 'That username is taken. Please choose another.' });
      }
      throw err;
    }

    await startAuthenticatedSession(req, user);
    req.session.flash = { type: 'success', message: 'Welcome! Your account has been created.' };
    res.redirect(303, '/notes');
  });

  // ---- Login ----
  router.get('/login', redirectIfAuthenticated, (req, res) => {
    render(req, res, { title: 'Sign in', content: loginPage({ csrfToken: res.locals.csrfToken }) });
  });

  router.post('/login', limiters.login, redirectIfAuthenticated, async (req, res) => {
    const { username, password, valid } = validateCredentials(req.body, { isNew: false });

    const row = valid ? stmts.findByUsername.get(username) : undefined;
    // Always run a hash comparison so timing doesn't reveal whether the user exists.
    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));

    if (!row || !ok) {
      return render(req, res, {
        status: 401,
        title: 'Sign in',
        content: loginPage({
          csrfToken: res.locals.csrfToken,
          values: { username },
          errors: { form: GENERIC_LOGIN_ERROR },
        }),
      });
    }

    // Transparently upgrade hashes created with older/weaker parameters.
    if (needsRehash(row.password_hash)) {
      stmts.updateHash.run(await hashPassword(password), row.id);
    }

    await startAuthenticatedSession(req, row);
    res.redirect(303, '/notes');
  });

  // ---- Logout (POST only, CSRF-protected) ----
  router.post('/logout', async (req, res) => {
    await endSession(req, res, cookieName);
    res.redirect(303, '/');
  });

  return router;
}
