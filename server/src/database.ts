import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

const DB_DIR = resolve(process.cwd(), 'data');
mkdirSync(DB_DIR, { recursive: true });

const db = new Database(resolve(DB_DIR, 'hatax.db'), {
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
});

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

db.exec(`
CREATE TABLE IF NOT EXISTS user_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  encrypted_value BLOB NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, key)
);
`);

// ─── Prepared Statements ───────────────────────────

export const createUser = db.prepare(`
  INSERT INTO users (email, password_hash, name, role)
  VALUES (?, ?, ?, ?)
`);

export const getUserByEmail = db.prepare(`
  SELECT * FROM users WHERE email = ?
`);

export const getUserById = db.prepare(`
  SELECT id, email, name, role, created_at, updated_at, last_login
  FROM users WHERE id = ?
`);

export const updateUserLastLogin = db.prepare(`
  UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?
`);

export const createSession = db.prepare(`
  INSERT INTO sessions (id, user_id, token_hash, expires_at)
  VALUES (?, ?, ?, ?)
`);

export const getSession = db.prepare(`
  SELECT s.*, u.email, u.name, u.role
  FROM sessions s
  JOIN users u ON s.user_id = u.id
  WHERE s.id = ? AND s.expires_at > CURRENT_TIMESTAMP
`);

export const deleteSession = db.prepare(`
  DELETE FROM sessions WHERE id = ?
`);

export const deleteExpiredSessions = db.prepare(`
  DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP
`);

export const setUserData = db.prepare(`
  INSERT INTO user_data (user_id, key, encrypted_value)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id, key) DO UPDATE SET
    encrypted_value = excluded.encrypted_value,
    updated_at = CURRENT_TIMESTAMP
`);

export const getUserData = db.prepare(`
  SELECT key, encrypted_value FROM user_data WHERE user_id = ?
`);

export const getUserDataByKey = db.prepare(`
  SELECT encrypted_value FROM user_data WHERE user_id = ? AND key = ?
`);

export const deleteUserData = db.prepare(`
  DELETE FROM user_data WHERE user_id = ? AND key = ?
`);

export const getAllUsers = db.prepare(`
  SELECT id, email, name, role, created_at, last_login FROM users
`);

export default db;