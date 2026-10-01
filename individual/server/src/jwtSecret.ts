import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

/** A saved key shorter than this is not trusted; a new one replaces it. */
const MIN_SECRET_LENGTH = 32;

/**
 * The key that signs sign-in tokens: JWT_SECRET when it is set, otherwise a
 * random key created once per install and kept in the data folder beside the
 * database, so tokens survive restarts and no two installs share a key. A
 * fixed fallback string would let anyone forge a sign-in token for any
 * install that never set JWT_SECRET.
 */
export function resolveJwtSecret(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  const file = resolve(dataDir, 'jwt-secret');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved.length >= MIN_SECRET_LENGTH) return saved;
  }
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(48).toString('hex');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
