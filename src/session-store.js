import { createHash } from 'node:crypto';
import session from 'express-session';

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Session IDs are stored hashed, so a leaked database can't be used to hijack sessions.
const hashSid = (sid) => createHash('sha256').update(sid).digest('base64url');

/** express-session store backed by Node's built-in SQLite driver. */
export class SQLiteSessionStore extends session.Store {
  #db;
  #stmts;
  #timer;
  #defaultTtlMs;

  constructor(db, { defaultTtlMs }) {
    super();
    this.#db = db;
    this.#defaultTtlMs = defaultTtlMs;
    this.#stmts = {
      get: db.prepare('SELECT data, expires FROM sessions WHERE sid_hash = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid_hash, data, expires) VALUES (?, ?, ?)
         ON CONFLICT(sid_hash) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
      ),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid_hash = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid_hash = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.#timer = setInterval(() => this.prune(), CLEANUP_INTERVAL_MS);
    this.#timer.unref();
  }

  #expiry(sess) {
    const expires = sess?.cookie?.expires;
    return expires ? new Date(expires).getTime() : Date.now() + this.#defaultTtlMs;
  }

  get(sid, cb) {
    try {
      const row = this.#stmts.get.get(hashSid(sid));
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.#stmts.destroy.run(hashSid(sid));
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.#stmts.set.run(hashSid(sid), JSON.stringify(sess), this.#expiry(sess));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.#stmts.touch.run(this.#expiry(sess), hashSid(sid));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.#stmts.destroy.run(hashSid(sid));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  prune() {
    try {
      this.#stmts.prune.run(Date.now());
    } catch (err) {
      console.error('Session cleanup failed:', err);
    }
  }

  close() {
    clearInterval(this.#timer);
  }
}
