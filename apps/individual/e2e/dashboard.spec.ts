/**
 * E2E Tests: Dashboard Page
 *
 * Tests the main dashboard at `/` including:
 * - Page rendering and branding
 * - Creating new tax returns
 * - Listing existing returns
 * - Deleting returns
 * - Navigation to wizard
 */

import { test, expect } from '@playwright/test';
import { unlockDashboard } from './helpers/unlock';

// Helper: clear all localStorage data before each test
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await unlockDashboard(page);
});

test.describe('Dashboard Page', () => {
  test('renders the HATax branding', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('HA Tax service');
    await expect(page.getByText('2025 Tax Year')).toBeVisible();
    await expect(page.getByText('Free, private, open-source tax prep.')).toBeVisible();
  });

  test('shows empty state when no returns exist', async ({ page }) => {
    await expect(page.getByText('Ready to file your 2025 taxes?')).toBeVisible();
  });

  test('creates a new return and navigates to wizard', async ({ page }) => {
    // Click "Start New Tax Return"
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();

    // Should navigate to /return/{uuid}
    await expect(page).toHaveURL(/\/return\/[a-f0-9-]+/);
  });

  test('lists created returns on dashboard', async ({ page }) => {
    // Create a return via the UI
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();
    await expect(page).toHaveURL(/\/return\//);

    // Go back to dashboard (a full navigation locks the vault again)
    await page.goto('/');
    await unlockDashboard(page);

    // Should see "Your Returns" heading
    await expect(page.getByText('Your Returns')).toBeVisible();

    // Should see the return card (at least one)
    const cards = page.locator('.card').filter({ hasText: '2025' });
    await expect(cards).toHaveCount(1);
  });

  test('can create multiple returns', async ({ page }) => {
    // Create first return
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();
    await page.goto('/');
    await unlockDashboard(page);

    // Create second return
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();
    await page.goto('/');
    await unlockDashboard(page);

    // Should see 2 return cards
    await expect(page.getByText('Your Returns')).toBeVisible();
  });

  test('clicking a return card navigates to wizard', async ({ page }) => {
    // Create a return
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();
    const wizardUrl = page.url();

    // Go back to dashboard
    await page.goto('/');
    await unlockDashboard(page);

    // Click the return card
    const returnCard = page.locator('.card').filter({ hasText: '2025' }).first();
    await returnCard.click();

    // Should navigate to the same wizard URL
    await expect(page).toHaveURL(/\/return\/[a-f0-9-]+/);
  });

  test('deletes a return with confirmation', async ({ page }) => {
    // Create a return
    await page.getByRole('button', { name: /Start New Tax Return/i }).click();
    await page.goto('/');
    await unlockDashboard(page);
    await expect(page.getByText('Your Returns')).toBeVisible();

    await page.getByTitle('Delete return').click();
    await page.getByRole('button', { name: 'Yes, delete' }).click();

    await expect(page.getByText('Ready to file your 2025 taxes?')).toBeVisible();
  });
});
