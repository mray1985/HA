/**
 * E2E: the preparer's case flow — dashboard, a new case, its review and the
 * approval gate.
 */

import { expect, test } from '@playwright/test';
import { openCaseDashboard } from './helpers/preparer';

test.beforeEach(async ({ page }) => {
  await openCaseDashboard(page);
});

test('a new case opens on its documents, and the review lists what is missing', async ({ page }) => {
  await expect(page.getByText('No cases yet')).toBeVisible();
  await page.getByLabel('Tax year for a new case').selectOption('2026');
  await page.getByRole('button', { name: /New case/i }).first().click();

  await expect(page).toHaveURL(/\/preparer\/case\/[a-f0-9-]+\/documents$/);
  await expect(page.getByText('Tax year 2026')).toBeVisible();
  await expect(page.getByText(/Drop or choose the client/)).toBeVisible();

  await page.getByRole('link', { name: /^Review/ }).click();
  await expect(page.getByText('First name is required.')).toBeVisible();
  await expect(page.getByText('Social Security number is required.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Taxpayer & filing status' })).toBeVisible();

  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText('Not ready')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approve$/ })).toHaveCount(0);
});

test('the dashboard counts the case as waiting for documents', async ({ page }) => {
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole('link', { name: 'Back to cases' }).click();

  const row = page.getByRole('row', { name: /New client/ });
  await expect(row).toContainText('Waiting for documents');
  await expect(page.getByRole('button', { name: /1\s*Waiting for documents/ })).toBeVisible();
});
