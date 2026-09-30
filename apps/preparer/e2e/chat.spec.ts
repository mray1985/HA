/**
 * E2E Tests: AI Chat Assistant
 *
 * Default mode is Private: the assistant toggle is always available, the first
 * open shows a privacy disclaimer, and accepting it shows the Private Mode
 * panel (conversational chat requires a user-supplied API key).
 */

import { test, expect, Page } from '@playwright/test';
import { unlockDashboard } from './helpers/unlock';

async function createAndOpenReturn(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await unlockDashboard(page);
  await page.getByRole('button', { name: /Start New Tax Return/i }).click();
  await expect(page).toHaveURL(/\/return\/[a-f0-9-]+/);
}

function assistantButton(page: Page) {
  return page.getByRole('button', { name: /Toggle AI assistant/i });
}

test.describe('Chat assistant', () => {
  test.beforeEach(async ({ page }) => {
    await createAndOpenReturn(page);
  });

  test('shows the assistant toggle', async ({ page }) => {
    await expect(assistantButton(page)).toBeVisible();
  });

  test('opens on the private-mode privacy disclaimer', async ({ page }) => {
    await assistantButton(page).click();

    await expect(page.getByRole('heading', { name: /Assistant/i })).toBeVisible();
    await expect(page.getByText('Private AI — Your Data Stays Here')).toBeVisible();
    await expect(page.getByText(/You confirm all actions/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /I Understand/i })).toBeVisible();
  });

  test('shows the Private Mode panel after the disclaimer is accepted', async ({ page }) => {
    await assistantButton(page).click();
    await page.getByRole('button', { name: /I Understand/i }).click();

    await expect(page.getByRole('heading', { name: 'Private Mode', exact: true })).toBeVisible();
    await expect(page.getByText('Unlock AI chat')).toBeVisible();
    await expect(page.getByText('Private AI — Your Data Stays Here')).not.toBeVisible();
  });

  test('does not show the disclaimer again after it is accepted', async ({ page }) => {
    await assistantButton(page).click();
    await page.getByRole('button', { name: /I Understand/i }).click();
    await page.getByRole('button', { name: /Close chat/i }).click();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('aria-hidden', 'true');

    await assistantButton(page).click();
    await expect(page.getByText('Private AI — Your Data Stays Here')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Private Mode', exact: true })).toBeVisible();
  });

  test('closes from the close button', async ({ page }) => {
    await assistantButton(page).click();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('aria-hidden', 'false');

    await page.getByRole('button', { name: /Close chat/i }).click();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('aria-hidden', 'true');
  });
});
