import { expect, type Page } from '@playwright/test';
import { unlockDashboard } from './unlock';

/** Click the wizard's primary forward button once it has rendered. */
export async function clickNavButton(page: Page): Promise<void> {
  const target = page.getByRole('button', { name: /Let.*Go|^Continue$|^Done/i }).first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  await target.click();
}

/** Open a wizard step from the sidebar. My Info steps are expanded on first load. */
export async function openSidebarStep(page: Page, name: string): Promise<void> {
  // A selected step can append a warning count, e.g. "Filing Status 1 warning".
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+\\d|$)`);
  await page.getByRole('button', { name: pattern }).first().click();
}

/**
 * A full reload drops the in-memory encryption key and returns to the lock screen.
 * Unlock, then reopen the return that was in progress.
 */
export async function reopenCurrentReturn(page: Page): Promise<void> {
  await page.reload();
  await unlockDashboard(page);
  if (!page.url().includes('/return/')) {
    await page.getByRole('button', { name: /Continue where you left off/i }).click();
    await expect(page).toHaveURL(/\/return\//);
  }
}
