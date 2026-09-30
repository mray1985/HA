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

test('the Explain and Return tabs render for a new case', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);

  await page.getByRole('link', { name: 'Explain' }).click();
  await expect(page.getByRole('heading', { name: 'From income to taxable income' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Calculation trace' })).toBeVisible();

  await page.getByRole('link', { name: 'Return' }).click();
  await expect(page).toHaveURL(/\/return$/);
  expect(errors).toEqual([]);
});

test('a 1099-Q waits for the qualified expenses, and the review list takes the decision', async ({ page }) => {
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf')).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: /^Review/ }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'enter the qualified education expenses' });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Decide' }).click();
  await item.getByLabel('Qualified expenses').fill('5000');
  // A text layer cannot see box 6, so the form asks who received the distribution too.
  await item.getByRole('button', { name: 'Save' }).click();
  await expect(item.getByRole('alert')).toContainText('Answer every question');
  await item.getByLabel('Box 6').selectOption('yes');
  await item.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('enter the qualified education expenses')).toHaveCount(0);

  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/Decided for 1099q-529\.pdf.*qualifiedExpenses=5000/)).toBeVisible();
});

test('a W-2c read from its text layer corrects the W-2 it names', async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.locator('input[type="file"]').first().setInputFiles(['e2e/fixtures/w2-basic-single.pdf', 'e2e/fixtures/w2c-wages.pdf']);
  await expect(page.getByText('w2c-wages.pdf')).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Corrected the W-2')).toBeVisible({ timeout: 30000 });

  // The W-2c raises box 1 from 52,431.18 to 54,000.00 on the W-2 with the same EIN.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/w2c-wages\.pdf: correction \(read from the text layer/)).toBeVisible();
  await expect(page.getByText(/calculate_return: AGI \$54,000\.00/)).toBeVisible();
});
