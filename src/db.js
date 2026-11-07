import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX IF NOT EXISTS notes_user_idx ON notes(user_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT    PRIMARY KEY,
  data     TEXT    NOT NULL,
  expires  INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
`;

/**
 * Opens (and migrates) the SQLite database using Node's built-in driver.
 * All queries in this app go through prepared statements with bound
 * parameters, so user input is never concatenated into SQL.
 */
export function openDatabase(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    allowExtension: false, // never allow loading native SQLite extensions
  });

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    PRAGMA trusted_schema = OFF;
  `);
  db.exec(SCHEMA);
  return db;
}
