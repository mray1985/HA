/**
 * Lock screen handler — handles the encryption gate that appears when
 * the app finds plaintext data without encryption configured.
 *
 * Strategy:
 * 1. Inject plaintext return into localStorage
 * 2. Reload → encryption gate appears (no encryption configured yet)
 * 3. Programmatically set a passphrase via the UI
 * 4. App auto-encrypts the plaintext return on next loadAllReturns()
 */

import type { Page } from '@playwright/test';

const FUZZER_PASSPHRASE = 'fuzzer-test-pass-2025!';

/**
 * Handle the encryption gate:
 * - If "Set Passphrase" form is shown → fill it and submit
 * - If "Unlock" form is shown → enter the passphrase and unlock
 * - If no gate → already unlocked, proceed
 */
export async function handleEncryptionGate(page: Page): Promise<void> {
  const setupButton = page.getByRole('button', { name: /Set Up Encryption/i });
  const unlockButton = page.getByRole('button', { name: /^Unlock$/i });
  const gate = setupButton.or(unlockButton).first();
  const shown = await gate.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!shown) return;

  await page.locator('#passphrase').fill(FUZZER_PASSPHRASE);
  if (await setupButton.isVisible()) {
    await page.locator('#confirm').fill(FUZZER_PASSPHRASE);
    await setupButton.click();
  } else {
    await unlockButton.click();
  }

  // Key derivation is slow; wait until the passphrase form is gone.
  await page.locator('#passphrase').waitFor({ state: 'hidden', timeout: 20000 });
}

/**
 * Skip the encryption gate entirely by setting up encryption via
 * browser evaluate (faster, no UI interaction needed).
 */
export async function setupEncryptionProgrammatically(page: Page): Promise<void> {
  await page.evaluate(async (passphrase) => {
    // Access the crypto module's setupEncryption function
    // This works because the module exposes setActiveKey and setupEncryption
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    localStorage.setItem('hatax:salt', JSON.stringify(Array.from(salt)));

    // Derive key from passphrase
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits', 'deriveKey']
    );
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    // Encrypt verification token
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode('hatax-verify-v1')
    );
    localStorage.setItem('hatax:verify', JSON.stringify({
      iv: Array.from(iv), ct: Array.from(new Uint8Array(ciphertext))
    }));

    // Store key reference for later use
    (window as unknown as Record<string, unknown>).__fuzzerCryptoKey = key;
  }, FUZZER_PASSPHRASE);
}

export { FUZZER_PASSPHRASE };
