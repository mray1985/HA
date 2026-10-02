import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'hatax-db-'));
process.env.HATAX_DB_PATH = join(dir, 'earlier-release.db');

// A database an earlier release created, with its unused user_data table.
const earlier = new Database(process.env.HATAX_DB_PATH);
earlier.exec('CREATE TABLE user_data (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key TEXT NOT NULL, encrypted_value BLOB NOT NULL)');
earlier.close();

const { db, closeDatabase } = await import('../src/database.js');

afterAll(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const table = (name: string) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

describe('database', () => {
  it('drops the user_data table an earlier release created, and keeps sign-in tables', () => {
    expect(table('user_data')).toBeUndefined();
    expect(table('users')).toBeDefined();
    expect(table('sessions')).toBeDefined();
  });
});
