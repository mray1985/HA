import type { Page } from '@playwright/test';

const PASSPHRASE = 'e2e-passphrase-2025';

/** Dismiss the encryption gate so the dashboard start buttons are usable. */
export async function unlockDashboard(page: Page): Promise<void> {
  const setup = page.getByRole('button', { name: /Set Up Encryption/i });
  const unlock = page.getByRole('button', { name: /^Unlock$/i });
  const gate = setup.or(unlock).first();
  const gateShown = await gate.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);

  if (gateShown && await setup.isVisible()) {
    await page.locator('#passphrase').fill(PASSPHRASE);
    await page.locator('#confirm').fill(PASSPHRASE);
    await setup.click();
  } else if (gateShown) {
    await page.locator('#passphrase').fill(PASSPHRASE);
    await unlock.click();
  }

  await page.evaluate(() => {
    localStorage.setItem('hatax:consent', JSON.stringify({
      termsVersion: 'March 2026',
      privacyVersion: 'March 2026',
      acceptedAt: new Date().toISOString(),
    }));
  });
  // PBKDF2 unlock can take several seconds on a busy CI runner.
  await page.getByRole('button', { name: /Start New Tax Return/i }).waitFor({ timeout: 20000 });
}
