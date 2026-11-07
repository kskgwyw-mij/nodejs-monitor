import { layout } from './layout.js';

/** Renders a full page, consuming any one-time flash message from the session. */
export function render(req, res, { title, content, status = 200, wide, head, scripts }) {
  const flash = req.session?.flash;
  if (flash) delete req.session.flash;

  const page = layout({
    title,
    content,
    user: req.user,
    // The layout only needs a token for the signed-in "Sign out" form.
    csrfToken: req.user && req.session ? res.locals.csrfToken : undefined,
    flash,
    wide,
    head,
    scripts,
  });
  res.status(status).type('html').send(page.toString());
}
