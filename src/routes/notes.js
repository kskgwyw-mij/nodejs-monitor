import { Router } from 'express';
import { HttpError } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { parseId, validateNote } from '../validation.js';
import { notesPage } from '../views/pages.js';
import { render } from '../views/render.js';

const MAX_NOTES_PER_USER = 500;

export function notesRouter({ db }) {
  const router = Router();
  const stmts = {
    // Every query is scoped to the signed-in user's id, so users can never read
    // or delete someone else's notes by guessing IDs (IDOR protection).
    list: db.prepare('SELECT id, title, body, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 200'),
    count: db.prepare('SELECT count(*) AS n FROM notes WHERE user_id = ?'),
    insert: db.prepare('INSERT INTO notes (user_id, title, body) VALUES (?, ?, ?)'),
    delete: db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?'),
  };

  router.use('/notes', requireAuth);

  router.get('/notes', (req, res) => {
    render(req, res, {
      title: 'My notes',
      content: notesPage({ notes: stmts.list.all(req.user.id), csrfToken: res.locals.csrfToken }),
    });
  });

  router.post('/notes', (req, res) => {
    const { title, body, errors, valid } = validateNote(req.body);

    if (valid && stmts.count.get(req.user.id).n >= MAX_NOTES_PER_USER) {
      errors.title = `You can store up to ${MAX_NOTES_PER_USER} notes. Delete some to add more.`;
    }
    if (Object.keys(errors).length > 0) {
      return render(req, res, {
        status: 422,
        title: 'My notes',
        content: notesPage({
          notes: stmts.list.all(req.user.id),
          csrfToken: res.locals.csrfToken,
          values: { title, body },
          errors,
        }),
      });
    }

    stmts.insert.run(req.user.id, title, body);
    req.session.flash = { type: 'success', message: 'Note saved.' };
    res.redirect(303, '/notes');
  });

  router.post('/notes/:id/delete', (req, res) => {
    const id = parseId(req.params.id);
    if (id === null || stmts.delete.run(id, req.user.id).changes === 0) {
      // Same response whether the note doesn't exist or belongs to someone else.
      throw new HttpError(404, 'That note could not be found.');
    }
    req.session.flash = { type: 'success', message: 'Note deleted.' };
    res.redirect(303, '/notes');
  });

  return router;
}
