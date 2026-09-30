import type { Page } from '@playwright/test';

const PASSPHRASE = 'e2e-passphrase-2026';

/**
 * Register a new preparer, set up the vault, start the season seat, and land
 * on the case dashboard.
 */
export async function openCaseDashboard(page: Page, origin = ''): Promise<void> {
  await page.goto(`${origin}/preparer/register`);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.locator('#name').fill('E2E Preparer');
  await page.locator('#email').fill(`e2e-preparer-${suffix}@example.com`);
  await page.locator('#password').fill('e2e-password-2026');
  await page.locator('#confirmPassword').fill('e2e-password-2026');
  await page.getByRole('button', { name: /Create Account/i }).click();

  const setup = page.getByRole('button', { name: /Set Up Encryption/i });
  const unlock = page.getByRole('button', { name: /^Unlock$/i });
  const season = page.getByRole('button', { name: /Start this season/i });
  const dashboard = page.getByRole('button', { name: /New case/i }).first();

  // PBKDF2 key derivation can take several seconds on a busy CI runner.
  for (let step = 0; step < 4; step++) {
    await setup.or(unlock).or(season).or(dashboard).first().waitFor({ state: 'visible', timeout: 30000 });
    if (await dashboard.isVisible()) return;
    if (await setup.isVisible()) {
      await page.locator('#passphrase').fill(PASSPHRASE);
      await page.locator('#confirm').fill(PASSPHRASE);
      await setup.click();
    } else if (await unlock.isVisible()) {
      await page.locator('#passphrase').fill(PASSPHRASE);
      await unlock.click();
    } else if (await season.isVisible()) {
      await season.click();
    }
    await page.waitForTimeout(250);
  }
  await dashboard.waitFor({ state: 'visible', timeout: 30000 });
}
