/**
 * E2E with the local models (run with E2E_MODELS=1; needs preparer/models and
 * tools/llama-cpp): a W-2 uploaded in the app is read by Qwen3.5-0.8B through
 * the model runtime, checked by page evidence, and entered on the return; and
 * a client's reply is read by the same model and completes a 1099-Q.
 */

import { expect, test } from '@playwright/test';
import { openCaseDashboard } from './helpers/preparer';

test.skip(!process.env.E2E_MODELS, 'set E2E_MODELS=1 to read with the local models');
test.setTimeout(300_000);

test('a W-2 is read by the local models and entered on the return', async ({ page }) => {
  await openCaseDashboard(page);
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByText(/Local AI ready: Qwen3\.5-0\.8B \+ GLM-OCR/)).toBeVisible({ timeout: 60_000 });

  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/w2-basic-single.pdf');
  await expect(page.getByText(/with Qwen3\.5-0\.8B/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('w2-basic-single.pdf', { exact: true })).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 240_000 });

  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/w2-basic-single\.pdf: income_item \(read by the local models in \d+s\)/)).toBeVisible();
  await expect(page.getByText(/calculate_return: AGI \$52,431\.18/)).toBeVisible();
});

test("a client's reply is read by the local reader and completes a 1099-Q", async ({ page }) => {
  await openCaseDashboard(page);
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByText(/Local AI ready/)).toBeVisible({ timeout: 60_000 });
  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('Recorded — needs your decision')).toBeVisible({ timeout: 240_000 });

  await page.getByRole('link', { name: /^Assistant/ }).click();
  await expect(page.getByRole('region', { name: 'Ask the client' })).toContainText('qualified education expenses');
  await page.getByLabel("Client's reply").fill('Hi Sarah! For the 529, we paid $12,400 in tuition and fees this year. Thanks!');
  await page.getByRole('button', { name: 'Read their reply' }).click();
  const answers = page.getByRole('region', { name: 'Ask the client' });
  await expect(answers).toContainText('$12,400.00', { timeout: 120_000 });

  await page.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByText('Entered on the return')).toBeVisible();
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/Client reply read: \d answered/)).toBeVisible();
  await expect(page.getByText(/Client answered "How much did you pay in 2025 for qualified education expenses.*\$12,400\.00/)).toBeVisible();
});

test("a new dependent a client's note states is offered, and added when the preparer accepts it", async ({ page }) => {
  await openCaseDashboard(page);
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole('link', { name: /^Assistant/ }).click();
  await expect(page.getByText(/Local AI unavailable/)).toHaveCount(0, { timeout: 60_000 });
  await page.getByLabel("Client's reply").fill('Big news: we had a baby girl, Lily Lee, born March 3, 2025!');
  await page.getByRole('button', { name: 'Read their reply' }).click();

  const offers = page.getByLabel('New facts in the reply');
  await expect(offers).toContainText('Add Lily Lee as a dependent (born 2025-03-03)', { timeout: 120_000 });
  await offers.getByRole('button', { name: 'Add' }).click();
  await expect(offers).toContainText('Added');
  // What the note did not say is asked next.
  await expect(page.getByRole('region', { name: 'Ask the client' })).toContainText('How is Lily Lee related to you?');
  await expect(page.getByRole('region', { name: 'Ask the client' })).toContainText('How many months of 2025 did Lily live with you?');
});

test("the client's answer about a possibly missing document is read, and settles it", async ({ page }) => {
  await openCaseDashboard(page);
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByRole('button', { name: 'Other imports' }).click();
  // Import last year's return first: no current-year documents are needed for the check.
  await expect(page.locator('input[type="file"][accept=".json,.pdf"]')).toHaveCount(1, { timeout: 30_000 });
  await page.locator('input[type="file"][accept=".json,.pdf"]').setInputFiles('e2e/fixtures/prior-year-2024.json');
  await page.getByRole('button', { name: 'Tax forms' }).click();
  await expect(page.getByRole('region', { name: 'Possibly missing documents' })).toContainText('Possible missing 1099-INT from JPMORGAN CHASE BANK NA');

  await page.getByRole('link', { name: /^Assistant/ }).click();
  await page.getByLabel("Client's reply").fill('No, I closed that Chase account last year.');
  await page.getByRole('button', { name: 'Read their reply' }).click();
  await expect(page.getByRole('region', { name: 'Ask the client' })).toContainText('from JPMORGAN CHASE BANK NA for 2025? no', { timeout: 180_000 });

  await page.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByRole('region', { name: 'Possibly missing documents' })).toContainText('The client says there is none this year');
});
