import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

const DB_PATH = process.env.HATAX_DB_PATH
  ? resolve(process.env.HATAX_DB_PATH)
  : resolve(process.cwd(), 'data', 'hatax.db');
/** Folder holding the database and the install's token-signing key. */
export const DATA_DIR = resolve(DB_PATH, '..');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH, {
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
});

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ─── Schema ────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'preparer',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`);

for (const sql of [
  `ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'inactive'`,
  `ALTER TABLE users ADD COLUMN subscription_until TEXT`,
]) {
  try {
    db.exec(sql);
  } catch {
    // Column already exists on databases created after this migration.
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// Earlier releases created a user_data table that nothing ever wrote to.
db.exec('DROP TABLE IF EXISTS user_data');

// ─── Row types ─────────────────────────────────────

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
  last_login: string | null;
  subscription_status: string | null;
  subscription_until: string | null;
}

/** A user as the API may return it (no password hash). */
export type PublicUserRow = Omit<UserRow, 'password_hash'>;

export interface SessionRow {
  id: string;
  user_id: number;
  /** SHA-256 of the sign-in token issued with this session. */
  token_hash: string;
  expires_at: string;
  created_at: string;
  email: string;
  name: string | null;
  role: string;
}

// ─── Prepared Statements ───────────────────────────
// Expiry times are ISO strings ("…T…Z"); datetime() normalizes both sides so
// a session expires at its time, not at the end of its day.

export const createUser = db.prepare<[string, string, string, string]>(`
  INSERT INTO users (email, password_hash, name, role)
  VALUES (?, ?, ?, ?)
`);

export const getUserByEmail = db.prepare<[string], UserRow>(`
  SELECT * FROM users WHERE email = ?
`);

export const getUserById = db.prepare<[number], PublicUserRow>(`
  SELECT id, email, name, role, created_at, updated_at, last_login,
         subscription_status, subscription_until
  FROM users WHERE id = ?
`);

export const activateSubscription = db.prepare<[string, number]>(`
  UPDATE users SET subscription_status = 'active', subscription_until = ? WHERE id = ?
`);

export const updateUserLastLogin = db.prepare<[number]>(`
  UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?
`);

export const createSession = db.prepare<[string, number, string, string]>(`
  INSERT INTO sessions (id, user_id, token_hash, expires_at)
  VALUES (?, ?, ?, ?)
`);

export const getSession = db.prepare<[string], SessionRow>(`
  SELECT s.*, u.email, u.name, u.role
  FROM sessions s
  JOIN users u ON s.user_id = u.id
  WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')
`);

export const deleteSession = db.prepare<[string]>(`
  DELETE FROM sessions WHERE id = ?
`);

export const deleteExpiredSessions = db.prepare<[]>(`
  DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')
`);

/** Removes the user; their sessions go with them (ON DELETE CASCADE). */
export const deleteUser = db.prepare<[number]>(`
  DELETE FROM users WHERE id = ?
`);

export function closeDatabase(): void {
  db.close();
}

export { db };
export default db;