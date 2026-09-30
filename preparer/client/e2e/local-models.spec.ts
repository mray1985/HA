/**
 * E2E with the local models (run with E2E_MODELS=1; needs preparer/models and
 * tools/llama-cpp): a W-2 uploaded in the app is read by Qwen3.5-0.8B through
 * the model runtime, checked by page evidence, and entered on the return.
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
  await expect(page.getByText('w2-basic-single.pdf')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 240_000 });

  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/w2-basic-single\.pdf: income_item \(read by the local models in \d+s\)/)).toBeVisible();
  await expect(page.getByText(/calculate_return: AGI \$52,431\.18/)).toBeVisible();
});
