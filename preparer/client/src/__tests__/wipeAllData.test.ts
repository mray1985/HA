import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wipeAllData } from '../api/client';

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
}

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)!);
  return keys;
}

describe('wipeAllData', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('window', { location: { replace: vi.fn() } });
  });

  it('removes the vault, the cases, the saved sign-in, and what earlier builds left: AI settings, an API key and chat history', async () => {
    localStorage.setItem('hatax:salt', '[1,2,3]');
    localStorage.setItem('hatax:verify', 'enc');
    localStorage.setItem('hatax-preparer:returns', JSON.stringify(['ret-1']));
    localStorage.setItem('hatax-preparer:return:ret-1', 'enc');
    localStorage.setItem('hatax:ai-settings', '{"mode":"byok"}');
    localStorage.setItem('hatax:ai-key-enc', 'enc');
    localStorage.setItem('hatax:ai-key-migrate', 'test-api-key');
    localStorage.setItem('hatax-preparer:chat:ret-1', 'enc');
    localStorage.setItem('hatax:chat:ret-2', 'enc');
    // The saved sign-in and anything else the app keeps go too.
    localStorage.setItem('hatax-auth', '{"state":{}}');
    localStorage.setItem('hatax-auth-enc', 'enc');
    localStorage.setItem('hatax-preparer:model-runs:ret-1', 'enc');
    localStorage.setItem('another-site:setting', '1');

    await wipeAllData();

    expect(storedKeys()).toEqual(['another-site:setting']);
    expect(window.location.replace).toHaveBeenCalledWith('/');
  });
});
