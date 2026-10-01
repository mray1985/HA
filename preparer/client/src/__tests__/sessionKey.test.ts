/**
 * A reload in an unlocked session does not ask for the passphrase again; a new
 * session, an old one, or locking does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lock, setActiveKey, setupEncryption, verifyKey } from '../services/crypto';
import {
  forgetSessionKey, rememberSessionKey, restoreSessionKey, setSessionKeyStore, SESSION_MS,
  type SessionKeyStore, type StoredSessionKey,
} from '../services/sessionKey';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  };
}

function memoryStore(): SessionKeyStore & { map: Map<string, StoredSessionKey> } {
  const map = new Map<string, StoredSessionKey>();
  return {
    map,
    put: async (id, value) => { map.set(id, value); },
    get: async (id) => map.get(id),
    delete: async (id) => { map.delete(id); },
    entries: async () => [...map.entries()],
  };
}

const aesKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;

describe('the unlocked session', () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => {
    store = memoryStore();
    setSessionKeyStore(store);
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    setSessionKeyStore(null);
    setActiveKey(null);
    vi.unstubAllGlobals();
  });

  it('gives a reload the same key, and a new session nothing', async () => {
    const key = await aesKey();
    await rememberSessionKey(key);
    expect(await restoreSessionKey()).toBe(key);
    // A new tab or browser: no session id.
    vi.stubGlobal('sessionStorage', memoryStorage());
    expect(await restoreSessionKey()).toBeNull();
  });

  it('keeps the key non-extractable', async () => {
    const key = await aesKey();
    await rememberSessionKey(key);
    const kept = (await restoreSessionKey())!;
    expect(kept.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', kept)).rejects.toThrow();
  });

  it('does not keep a session longer than a working day, and sweeps old keys', async () => {
    await rememberSessionKey(await aesKey());
    expect(await restoreSessionKey(Date.now() + SESSION_MS + 1)).toBeNull();
    expect(store.map.size).toBe(0);
  });

  it('forgets the key when the vault locks', async () => {
    await rememberSessionKey(await aesKey());
    await forgetSessionKey();
    expect(await restoreSessionKey()).toBeNull();
    // crypto.lock() forgets it too.
    await rememberSessionKey(await aesKey());
    lock();
    await vi.waitFor(async () => expect(await restoreSessionKey()).toBeNull());
  });

  it('checks a kept key against the vault before using it', async () => {
    const vault = await setupEncryption('a passphrase for the test');
    expect(await verifyKey(vault)).toBe(true);
    expect(await verifyKey(await aesKey())).toBe(false);
  });
});
