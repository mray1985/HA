/**
 * E2E: the review flow's speed-ups — documents dropped on any tab of a case,
 * the return summary, the taxpayer's missing details filled in place, one-click
 * decisions, approval from the summary, and on to the next case.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openCaseDashboard } from './helpers/preparer';

test.beforeEach(async ({ page }) => {
  await openCaseDashboard(page);
});

/** Drop files on the page the way the desktop app receives them from Explorer. */
async function dropFiles(page: Page, target: string, files: Array<{ path: string; name: string }>) {
  const payload = files.map((f) => ({ name: f.name, bytes: readFileSync(f.path).toString('base64') }));
  const dataTransfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      const bin = atob(item.bytes);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], item.name, { type: 'application/pdf' }));
    }
    return dt;
  }, payload);
  await page.dispatchEvent(target, 'dragenter', { dataTransfer });
  await page.dispatchEvent(target, 'dragover', { dataTransfer });
  await page.dispatchEvent(target, 'drop', { dataTransfer });
}

async function newCase(page: Page, year: string) {
  await page.getByLabel('Tax year for a new case').selectOption(year);
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
}

test('a W-2 dropped on the Review tab is read, and the missing details are filled in place', async ({ page }) => {
  await newCase(page, '2025');
  await page.getByRole('link', { name: /^Review/ }).click();

  await dropFiles(page, 'section[aria-label="Return summary"]', [{ path: 'e2e/fixtures/w2-basic-single.pdf', name: 'w2-basic-single.pdf' }]);
  const summary = page.getByRole('region', { name: 'Return summary' });
  await expect(summary).toContainText('1 of 1 read', { timeout: 30000 });

  // Every missing taxpayer detail in one form.
  await page.getByRole('button', { name: /Enter all \d+ missing details at once/ }).click();
  await page.getByLabel("Taxpayer's first name").fill('Maya');
  await page.getByLabel("Taxpayer's last name").fill('Testpayer');
  await page.getByLabel("Taxpayer's SSN or ITIN").fill('000-12-345');
  await page.getByLabel('Street address').fill('815 Magnolia Ave');
  await page.getByLabel('City').fill('Baton Rouge');
  await page.getByLabel('State', { exact: true }).selectOption('LA');
  await page.getByLabel('ZIP code').fill('70802');
  await page.getByLabel('Filing status').selectOption({ label: 'Single' });
  await page.getByRole('button', { name: 'Save' }).click();
  // An SSN with 8 digits is refused, and nothing is saved until it is right.
  await expect(page.getByRole('alert').filter({ hasText: 'An SSN, ITIN or ATIN is 9 digits.' })).toBeVisible();
  await page.getByLabel("Taxpayer's SSN or ITIN").fill('000-12-3456');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('heading', { name: 'Maya Testpayer' })).toBeVisible();
  await expect(page.getByText('First name is required.')).toHaveCount(0);
  await expect(page.getByText('Social Security number is required.')).toHaveCount(0);

  // Decide what is left with one click each, then approve from the summary.
  for (let i = 0; i < 10; i++) {
    const decide = page.getByRole('button', { name: 'Record a decision' }).first();
    if (!(await decide.isVisible().catch(() => false))) break;
    await decide.click();
    await page.getByRole('button', { name: 'Checked against the source document' }).click();
  }
  await summary.getByRole('button', { name: 'Approve' }).click();
  await expect(summary).toContainText('Approved');

  // The audit trail keeps each value entered, and each decision's note.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/Changed addressZip/)).toBeVisible();
});

test('next case goes to the case that needs the preparer', async ({ page }) => {
  await newCase(page, '2025');
  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf')).toBeVisible({ timeout: 30000 });
  const first = page.url().match(/case\/([^/]+)/)![1];

  await page.getByRole('link', { name: 'Back to cases' }).click();
  await newCase(page, '2025');
  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/w2-basic-single.pdf');
  await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: /^Review/ }).click();
  await page.getByRole('region', { name: 'Return summary' }).getByRole('button', { name: /Next case/ }).click();
  await expect(page).toHaveURL(new RegExp(`/preparer/case/${first}`));
});

test('a review item opens its own document', async ({ page }) => {
  await newCase(page, '2025');
  await page.locator('input[type="file"]').first().setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf')).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: /^Review/ }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'enter the qualified education expenses' });
  await item.getByRole('button', { name: 'Open the document' }).click();
  await expect(page).toHaveURL(/\/documents$/);
  // The document's values are shown without another click.
  await expect(page.getByRole('button', { name: /Hide values read/ })).toBeVisible();
});

test("a returning client's next year starts from last year's case", async ({ page }) => {
  await newCase(page, '2025');
  await page.getByRole('link', { name: /^Review/ }).click();
  await page.getByRole('button', { name: /Enter all \d+ missing details at once/ }).click();
  await page.getByLabel("Taxpayer's first name").fill('Maya');
  await page.getByLabel("Taxpayer's last name").fill('Lee');
  await page.getByLabel("Taxpayer's SSN or ITIN").fill('123-45-6789');
  await page.getByLabel('Street address').fill('815 Magnolia Ave');
  await page.getByLabel('City').fill('Baton Rouge');
  await page.getByLabel('State', { exact: true }).selectOption('LA');
  await page.getByLabel('ZIP code').fill('70802');
  await page.getByLabel('Filing status').selectOption({ label: 'Head of household' });
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Maya Lee' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to cases' }).click();
  const row = page.getByRole('row', { name: /Maya Lee.*2025/ });
  await row.getByRole('button', { name: 'Start 2026' }).click();

  await expect(page).toHaveURL(/\/review$/);
  await expect(page.getByText('Tax year 2026')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maya Lee' })).toBeVisible();
  await expect(page.getByText(/Started from the 2025 case: carried name, SSN and address/)).toBeVisible();
  await expect(page.getByText(/The 2025 case was not approved/)).toBeVisible();

  // Last year's filing status is one click, and the client is still asked.
  const status = page.getByRole('listitem').filter({ hasText: '2025 case states the filing status head of household' });
  await status.getByRole('button', { name: 'Use it' }).click();
  await status.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('2025 case states the filing status head of household')).toHaveCount(0);

  // The dashboard no longer offers 2026 for this client.
  await page.getByRole('link', { name: 'Back to cases' }).click();
  await expect(page.getByRole('button', { name: 'Start 2026' })).toHaveCount(0);
});
