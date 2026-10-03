/**
 * E2E: the assistant's flow — documents dropped on any tab of a case, the case
 * summary, the taxpayer's missing details entered in one go, values typed into
 * the assistant and written straight onto the return, one-click decisions,
 * approval from the summary, and on to the next case.
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

/** Type into the assistant's box and send it. */
async function tell(page: Page, text: string) {
  const box = page.getByLabel('Type an answer');
  await box.fill(text);
  await box.press('Enter');
}

test('a W-2 dropped on the Assistant tab is read, and names the taxpayer', async ({ page }) => {
  await newCase(page, '2025');
  await page.getByRole('link', { name: /^Assistant/ }).click();

  await dropFiles(page, 'section[aria-label="Where the case stands"]', [{ path: 'e2e/fixtures/w2-basic-single.pdf', name: 'w2-basic-single.pdf' }]);
  const summary = page.getByRole('region', { name: 'Where the case stands' });
  await expect(summary).toContainText('I read all 1 document', { timeout: 30000 });

  // The employee's SSN, name and address come from the W-2's text layer. The name
  // is also named on the turn offering the document's reading as one click, so
  // the heading is matched rather than counted.
  await expect(page.getByRole('heading', { name: 'Maya Testpayer' }).first()).toBeVisible();

  // The filing status is the one thing left: it is typed, not chosen from a list.
  await expect(page.getByText(/filing status is required/i)).toHaveCount(0);
  await tell(page, 'single');
  await expect(page.getByText(/I read all 1 document/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maya Testpayer' }).first()).toBeVisible();

  // Anything the assistant still raised is settled by the preparer, which is what
  // unblocks approval. The Approve button only exists once nothing is open, so
  // wait for it rather than clicking at a moment the thread happens to be still.
  const settle = page.getByRole('button', { name: 'I have checked this' });
  while (await settle.count()) {
    await settle.first().click();
    await settle.first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);
  }
  const approve = summary.getByRole('button', { name: 'Approve' });
  await approve.waitFor({ state: 'visible', timeout: 30_000 });
  await approve.click();
  await expect(summary).toContainText('Approved');

  // The audit trail keeps each value entered, and each decision's note.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/Changed filingStatus/)).toBeVisible();
});

test('next case goes to the case that needs the preparer', async ({ page }) => {
  await newCase(page, '2025');
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible({ timeout: 30000 });
  const first = page.url().match(/case\/([^/]+)/)![1];

  await page.getByRole('link', { name: 'Back to cases' }).click();
  await newCase(page, '2025');
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2-basic-single.pdf');
  await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: /^Assistant/ }).click();
  await page.getByRole('region', { name: 'Where the case stands' }).getByRole('button', { name: /Next case/ }).click();
  await expect(page).toHaveURL(new RegExp(`/preparer/case/${first}`));
});

test('a turn about a document opens that document', async ({ page }) => {
  await newCase(page, '2025');
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible({ timeout: 30000 });

  await page.getByRole('link', { name: /^Assistant/ }).click();
  await page.getByRole('button', { name: 'Look at the document' }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  // The document's values are shown without another click.
  await expect(page.getByRole('button', { name: /Hide values read/ })).toBeVisible();
  // And the document itself, as dropped: kept encrypted with the case and shown page by page.
  await expect(page.getByRole('img', { name: /1099q-529\.pdf, page 1 of/ })).toBeVisible({ timeout: 15000 });
});

test("a returning client's next year starts from last year's case", async ({ page }) => {
  await newCase(page, '2025');
  await page.getByRole('link', { name: /^Assistant/ }).click();
  await page.getByRole('button', { name: /Enter all \d+ details at once/ }).click();
  await page.getByLabel("Taxpayer's first name").fill('Maya');
  await page.getByLabel("Taxpayer's last name").fill('Lee');
  await page.getByLabel("Taxpayer's SSN or ITIN").fill('123-45-678');
  await page.getByLabel('Street address').fill('815 Magnolia Ave');
  await page.getByLabel('City').fill('Baton Rouge');
  await page.getByLabel('State', { exact: true }).selectOption('LA');
  await page.getByLabel('ZIP code').fill('70802');
  await page.getByLabel('Filing status').selectOption({ label: 'Head of household' });
  await page.getByRole('button', { name: 'Save' }).click();
  // An SSN with 8 digits is refused, and nothing is saved until it is right.
  await expect(page.getByRole('alert').filter({ hasText: 'An SSN, ITIN or ATIN is 9 digits.' })).toBeVisible();
  await page.getByLabel("Taxpayer's SSN or ITIN").fill('123-45-6789');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Maya Lee' }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Back to cases' }).click();
  const row = page.getByRole('row', { name: /Maya Lee.*2025/ });
  await row.getByRole('button', { name: 'Start 2026' }).click();

  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByText('Tax year 2026')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Maya Lee' }).first()).toBeVisible();
  await expect(page.getByText(/Started from the 2025 case: carried name, SSN and address/)).toBeVisible();
  await expect(page.getByText(/The 2025 case was not approved/)).toBeVisible();

  // Last year's filing status is one click.
  const status = page.getByRole('listitem').filter({ hasText: '2025 case states the filing status head of household' });
  await status.getByRole('button', { name: /Use it|Save|yes/i }).first().click();
  await expect(page.getByText('2025 case states the filing status head of household')).toHaveCount(0);

  // The dashboard no longer offers 2026 for this client.
  await page.getByRole('link', { name: 'Back to cases' }).click();
  await expect(page.getByRole('button', { name: 'Start 2026' })).toHaveCount(0);
});

test('documents for several clients dropped on the dashboard go to a case each', async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await dropFiles(page, 'section[aria-label="Add documents"]', [
    { path: 'e2e/fixtures/w2-basic-single.pdf', name: 'w2-basic-single.pdf' },
    { path: 'e2e/fixtures/w2-indiana-local.pdf', name: 'w2-indiana-local.pdf' },
    { path: 'e2e/fixtures/1099q-529.pdf', name: '1099q-529.pdf' },
  ]);
  const placed = page.getByRole('list', { name: 'Documents placed' });
  await expect(placed).toContainText('Maya Testpayer — new case: w2-basic-single.pdf', { timeout: 60000 });
  await expect(placed).toContainText('Jordan Testpayer — new case: w2-indiana-local.pdf');

  // The 1099-Q names its recipient, who may be the student: the preparer places it.
  const held = page.getByRole('list', { name: 'Documents not placed' });
  await held.getByLabel('Case for 1099q-529.pdf').selectOption({ label: 'Maya Testpayer' });
  await held.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('list', { name: 'Documents not placed' })).toHaveCount(0);

  await expect(page.getByRole('row', { name: /Maya Testpayer.*2025/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Jordan Testpayer.*2025/ })).toBeVisible();
  await page.getByRole('link', { name: 'Maya Testpayer', exact: true }).first().click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('w2-basic-single.pdf', { exact: true })).toBeVisible();
});

test('a new season starts every returning client at once', async ({ page }) => {
  for (const [first, last, ssn] of [['Maya', 'Lee', '123-45-6789'], ['Sam', 'Ortiz', '987-65-4321']] as const) {
    await newCase(page, '2025');
    await page.getByRole('link', { name: /^Assistant/ }).click();
    await page.getByRole('button', { name: /Enter all \d+ details at once/ }).click();
    await page.getByLabel("Taxpayer's first name").fill(first);
    await page.getByLabel("Taxpayer's last name").fill(last);
    await page.getByLabel("Taxpayer's SSN or ITIN").fill(ssn);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: `${first} ${last}` }).first()).toBeVisible();
    await page.getByRole('link', { name: 'Back to cases' }).click();
  }
  await page.getByLabel('Tax year for a new case').selectOption('2026');
  await expect(page.getByText('2 clients from 2025 have no 2026 case yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Start 2026 for all 2' }).click();
  await expect(page.getByRole('row', { name: /Maya Lee\s*2026/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Sam Ortiz\s*2026/ })).toBeVisible();
  await expect(page.getByText(/have no 2026 case yet/)).toHaveCount(0);
});
