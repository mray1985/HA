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
  await ensureTaxpayerSession(page);
  await page.getByRole('button', { name: /Start New Tax Return/i }).waitFor({ timeout: 20000 });
}

/** Create a taxpayer account when the dashboard redirects to sign-in. */
export async function ensureTaxpayerSession(page: Page): Promise<void> {
  const dashboard = page.getByRole('button', { name: /Start New Tax Return|Continue where you left off/i });
  const signIn = page.getByText('Sign in to your account');
  await dashboard.or(signIn).first().waitFor({ state: 'visible', timeout: 30000 });
  if (!(await signIn.isVisible().catch(() => false))) return;

  await page.getByRole('link', { name: /Create an account/i }).click();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.locator('#name').fill('E2E Taxpayer');
  await page.locator('#email').fill(`e2e-${suffix}@example.com`);
  await page.locator('#password').fill('e2e-password-2025');
  await page.locator('#confirmPassword').fill('e2e-password-2025');
  await page.getByRole('button', { name: /Create Account/i }).click();
  await dashboard.first().waitFor({ state: 'visible', timeout: 30000 });
}
