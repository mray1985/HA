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
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible({ timeout: 30000 });

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
  await page.getByLabel("Add the client's documents").setInputFiles(['e2e/fixtures/w2-basic-single.pdf', 'e2e/fixtures/w2c-wages.pdf']);
  await expect(page.getByText('w2c-wages.pdf', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Corrected the W-2')).toBeVisible({ timeout: 30000 });

  // The W-2c raises box 1 from 52,431.18 to 54,000.00 on the W-2 with the same EIN.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/w2c-wages\.pdf: correction \(read from the text layer/)).toBeVisible();
  await expect(page.getByText(/calculate_return: AGI \$54,000\.00/)).toBeVisible();
});

test('the Client tab asks only what the case cannot settle, and says when the local AI cannot read replies', async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: 'Client' }).click();
  const message = page.getByLabel('Message to the client');
  await expect(message).toContainText('We have your 1099-Q from');
  await expect(message).toContainText('1. How do you want to file your 2025 return');
  await expect(message).toContainText('2. How much did you pay in 2025 for qualified education expenses');
  // Box 6 is the preparer's to settle from the form, never a question for the client.
  await expect(message).not.toContainText('beneficiary');
  await expect(page.getByText(/Local AI unavailable/)).toBeVisible();
  await page.getByLabel("Client's reply").fill('We paid $5,000 in tuition.');
  await expect(page.getByRole('button', { name: 'Read reply' })).toBeDisabled();
});

test("last year's documents the case lacks are possibly missing, and the client is asked about them", async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2-basic-single.pdf');
  await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 30000 });

  // Last year's HA Tax return: the same employer's W-2, and a 1099-INT from Chase.
  await page.getByRole('button', { name: 'Other imports' }).click();
  await page.locator('input[type="file"][accept=".json,.pdf"]').setInputFiles('e2e/fixtures/prior-year-2024.json');
  await expect(page.getByText(/2024/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Tax forms' }).click();
  const missing = page.getByRole('region', { name: 'Possibly missing documents' });
  await expect(missing).toContainText('Possible missing 1099-INT from JPMORGAN CHASE BANK NA');
  await expect(missing).toContainText('the 2024 imported HA Tax return has one for $123.45');
  await expect(missing).not.toContainText('W-2');

  await page.getByRole('link', { name: 'Client' }).click();
  await expect(page.getByLabel('Message to the client')).toContainText('Did you receive an interest statement (Form 1099-INT) from JPMORGAN CHASE BANK NA for 2025?');
  await page.getByRole('link', { name: /^Review/ }).click();
  await expect(page.getByText(/Possible missing 1099-INT from JPMORGAN CHASE BANK NA: the 2024 imported HA Tax return/)).toBeVisible();
});

test('a forgotten passphrase: the lock screen deletes this computer\'s data and starts over', async ({ page }) => {
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);

  // A new window session: the vault asks for the passphrase.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByRole('button', { name: /^Unlock$/i })).toBeVisible({ timeout: 30000 });

  await page.getByRole('button', { name: 'Forgot your passphrase?' }).click();
  await expect(page.getByLabel('Type DELETE to confirm')).toBeFocused();
  const startOver = page.getByRole('button', { name: 'Delete everything and start over' });
  await expect(startOver).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('delete');
  await expect(startOver).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await startOver.click();

  await expect(page.getByRole('heading', { name: 'Create Your Passphrase' })).toBeVisible({ timeout: 30000 });
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hatax')));
  expect(left).toEqual([]);
});
