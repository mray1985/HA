/**
 * E2E: Form 8615 for a young filer — the step asks whether it applies, takes
 * the parent's figures, and shows the form line by line with the tax that
 * goes on Form 1040 line 16.
 */

import { expect, test } from '@playwright/test';
import { unlockDashboard } from './helpers/unlock';

test('a 15-year-old with $10,000 of interest figures Form 8615 from the parent\'s figures', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await unlockDashboard(page);
  await page.getByRole('button', { name: /Start New Tax Return/i }).click();
  await expect(page).toHaveURL(/\/return\/[a-f0-9-]+/);

  // The return so far: a dependent child with $10,000 of interest.
  await page.evaluate(async () => {
    const { useTaxReturnStore } = await import('/src/store/taxReturnStore.ts' as string);
    const s = useTaxReturnStore.getState();
    s.updateField('firstName', 'Ava');
    s.updateField('lastName', 'Lee');
    s.updateField('dateOfBirth', '2010-05-01');
    s.updateField('canBeClaimedAsDependent', true);
    s.updateField('incomeDiscovery', { '1099int': 'yes' });
    s.updateField('income1099INT', [{ id: 'int-1', payerName: 'First Bank', amount: 10000 }]);
    const steps = useTaxReturnStore.getState().getVisibleSteps();
    useTaxReturnStore.getState().setCurrentStep(steps.findIndex((step: { id: string }) => step.id === 'form_8615'));
  });

  await expect(page.getByRole('heading', { name: /Form 8615 \(kiddie tax\)/i })).toBeVisible();
  await expect(page.getByText(/Your unearned income is \$10,000 and you are 15/)).toBeVisible();
  await page.getByRole('radiogroup', { name: 'Does Form 8615 apply to you?' }).getByRole('radio', { name: 'Yes' }).click();

  await page.getByPlaceholder('First, initial, last').fill('Sam Lee');
  await page.getByLabel("Parent's SSN").fill('987654321');
  await page.getByLabel(/^Parent's filing status/).selectOption({ label: 'Married filing jointly' });
  await page.getByLabel(/^Parent's taxable income/).fill('80000');
  await page.getByLabel(/^Parent's tax\b/).fill('9126');
  await page.getByLabel(/^Parent's qualified dividends/).fill('0');
  await page.getByLabel(/^Parent's net capital gain/).fill('0');
  await page.getByLabel(/^The parent's other children's Forms 8615/).fill('0');
  await page.getByLabel(/^The parent's other children's Forms 8615/).blur();
  await page.getByRole('radiogroup', { name: "Parent's special tax computation" }).getByRole('radio', { name: 'No' }).click();

  // Line 18 replaces the child's own tax: $876 at the parent's rate plus $136 at the child's.
  await expect(page.getByText('Your tax is $1,012 (line 18), on Form 1040 line 16.')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('row', { name: /^9 Tax on line 8 at your parent's filing status \$10,002$/ })).toBeVisible();
});
