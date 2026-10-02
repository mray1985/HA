/**
 * Full walkthrough with the local AI (not part of the suite): a preparer signs
 * up, sets up the vault, starts the season, drops two clients' documents read
 * by the local models, completes Maya Testpayer's 2025 case — her W-2c, the
 * client's reply read by the reader model, the review list — approves it and
 * downloads the review package. Screenshots go to WALKTHROUGH_DIR. Runs only
 * with E2E_MODELS=1.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const OUT = process.env.WALKTHROUGH_DIR ?? 'test-results/walkthrough';
const MODEL_READ = 15 * 60_000;

test.skip(!process.env.E2E_MODELS, 'E2E_MODELS=1 is required: the documents and the reply are read by the local models');
test.use({ launchOptions: { slowMo: 250 }, video: 'on', viewport: { width: 1440, height: 900 } });
test.setTimeout(60 * 60_000);

let step = 0;
async function shot(page: Page, name: string, note = '') {
  step += 1;
  const file = join(OUT, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const line = `${new Date().toISOString()} ${String(step).padStart(2, '0')} ${name}${note ? ` — ${note}` : ''}`;
  console.log(`STEP ${line}`);
  writeFileSync(join(OUT, 'steps.log'), `${line}\n`, { flag: 'a' });
}

/** Drop files on the page the way the desktop app receives them from Explorer. */
async function dropFiles(page: Page, target: string, files: string[]) {
  const payload = files.map((path) => ({ name: path.split('/').pop()!, bytes: readFileSync(path).toString('base64') }));
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

test('the preparer, start to approval, with the local AI', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'steps.log'), '');

  // ── 1. Sign up, the vault, the season ──
  await page.goto('/preparer/register');
  await page.locator('#name').fill('Demo Preparer');
  await page.locator('#email').fill(`demo-preparer-${Date.now()}@example.com`);
  await page.locator('#password').fill('e2e-password-2026');
  await page.locator('#confirmPassword').fill('e2e-password-2026');
  await shot(page, 'register');
  await page.getByRole('button', { name: /Create Account/i }).click();

  const setup = page.getByRole('button', { name: /Set Up Encryption/i });
  await setup.waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('#passphrase').fill('e2e-passphrase-2026');
  await page.locator('#confirm').fill('e2e-passphrase-2026');
  await shot(page, 'vault-setup');
  await setup.click();

  const season = page.getByRole('button', { name: /Start this season/i });
  const dashboard = page.getByRole('button', { name: /New case/i }).first();
  await season.or(dashboard).first().waitFor({ state: 'visible', timeout: 120_000 });
  if (await season.isVisible()) {
    await shot(page, 'season');
    await season.click();
  }
  await dashboard.waitFor({ state: 'visible', timeout: 60_000 });
  await shot(page, 'dashboard');

  // ── 2. Two clients' documents, dropped at once, read by the local models ──
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await dropFiles(page, 'section[aria-label="Add documents"]', [
    'e2e/fixtures/w2-basic-single.pdf',
    'e2e/fixtures/w2-indiana-local.pdf',
    'e2e/fixtures/1099q-529.pdf',
  ]);
  await page.waitForTimeout(5_000);
  await shot(page, 'batch-reading');
  const placed = page.getByRole('list', { name: 'Documents placed' });
  await expect(placed).toContainText('Maya Testpayer', { timeout: MODEL_READ });
  await expect(placed).toContainText('Jordan Testpayer', { timeout: MODEL_READ });
  await shot(page, 'batch-placed');

  // The 1099-Q names its recipient, who may be the student: the preparer places it.
  const held = page.getByRole('list', { name: 'Documents not placed' });
  if (await held.isVisible().catch(() => false)) {
    await held.getByLabel('Case for 1099q-529.pdf').selectOption({ label: 'Maya Testpayer' });
    await shot(page, '1099q-place');
    await held.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('list', { name: 'Documents not placed' })).toHaveCount(0, { timeout: MODEL_READ });
  }
  await shot(page, 'dashboard-two-clients');

  // ── 3. Maya's case: her documents, and the source W-2 itself ──
  await page.getByRole('link', { name: 'Maya Testpayer', exact: true }).first().click();
  await page.getByRole('link', { name: 'Documents' }).click();
  await expect(page.getByText('w2-basic-single.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'maya-documents');
  const w2Card = page.getByRole('listitem').filter({ hasText: 'w2-basic-single.pdf' });
  await w2Card.getByRole('button', { name: 'Show the document' }).click();
  await expect(page.getByRole('img', { name: /w2-basic-single\.pdf, page 1 of/ })).toBeVisible({ timeout: 60_000 });
  await shot(page, 'maya-w2-source');
  await w2Card.getByRole('button', { name: 'Hide the document' }).click();

  // Her W-2c, read by the local models, corrects the W-2.
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2c-wages.pdf');
  await page.waitForTimeout(3_000);
  await shot(page, 'w2c-reading');
  await expect(page.getByText('Corrected the W-2')).toBeVisible({ timeout: MODEL_READ });
  await shot(page, 'w2c-applied');

  // ── 4. The client's questions, and her reply read by the reader model ──
  await page.getByRole('link', { name: 'Client' }).click();
  await expect(page.getByLabel('Message to the client')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'client-message');
  await page.getByLabel("Client's reply").fill(
    "Hi! I'm single and filing on my own. For the 529, we paid $12,400 in tuition and fees this year, and the distribution was paid to me. Thanks!",
  );
  await page.getByRole('button', { name: 'Read reply' }).click();
  await expect(page.getByLabel('Answers read from the reply')).toBeVisible({ timeout: MODEL_READ });
  await page.waitForTimeout(2_000);
  await shot(page, 'client-reply-read');
  // Offered facts from the reply (if any) are accepted.
  const offers = page.getByLabel('New facts in the reply');
  for (let i = 0; i < 5; i++) {
    const add = offers.getByRole('button', { name: /^(Add|Use it|Accept)$/ }).first();
    if (!(await add.isVisible().catch(() => false))) break;
    await add.click();
  }

  // ── 5. The review list: what is left, then approval ──
  await page.getByRole('link', { name: /^Review/ }).click();
  await page.waitForTimeout(2_000);
  await shot(page, 'review-open');

  const filing = page.getByRole('listitem').filter({ hasText: 'Filing status is required.' });
  if (await filing.isVisible().catch(() => false)) {
    await filing.getByRole('button', { name: 'Enter it' }).click();
    await filing.getByLabel('Filing status').selectOption({ label: 'Single' });
    await filing.getByRole('button', { name: 'Save' }).click();
  }
  const education = page.getByRole('listitem').filter({ hasText: 'qualified education expenses' });
  if (await education.first().isVisible().catch(() => false)) {
    const item = education.first();
    await item.getByRole('button', { name: /Decide|Enter|Answer/ }).first().click();
    const expenses = item.getByLabel('Qualified expenses');
    if (await expenses.isVisible().catch(() => false)) await expenses.fill('12400');
    const box6 = item.getByLabel('Box 6');
    if (await box6.isVisible().catch(() => false)) await box6.selectOption('yes');
    await item.getByRole('button', { name: 'Save' }).click();
  }
  await shot(page, 'review-entered');

  // Each remaining review item: checked against its source document.
  for (let i = 0; i < 25; i++) {
    const decide = page.getByRole('button', { name: 'Record a decision' }).first();
    if (!(await decide.isVisible().catch(() => false))) break;
    await decide.click();
    await page.getByRole('button', { name: 'Checked against the source document' }).click();
  }
  const summary = page.getByRole('region', { name: 'Return summary' });
  await shot(page, 'review-decided');
  const approve = summary.getByRole('button', { name: 'Approve' });
  if (await approve.isEnabled().catch(() => false)) {
    await approve.click();
    await expect(summary).toContainText('Approved', { timeout: 30_000 });
    await shot(page, 'approved');
  } else {
    writeFileSync(join(OUT, 'still-open.txt'), await page.locator('#main-content').innerText());
    await shot(page, 'not-approvable', 'items still open — see still-open.txt');
  }

  // ── 6. The return, the explanation, the audit trail and the package ──
  await page.getByRole('link', { name: 'Return' }).click();
  await page.waitForTimeout(6_000);
  await shot(page, 'return-forms');
  await page.getByRole('link', { name: 'Explain' }).click();
  await page.waitForTimeout(3_000);
  await shot(page, 'explain');
  await page.getByRole('link', { name: 'Approve' }).click();
  await page.waitForTimeout(2_000);
  await shot(page, 'approve-audit');
  const pkg = page.getByRole('button', { name: /review package/i });
  if (await pkg.isEnabled().catch(() => false)) {
    const download = page.waitForEvent('download', { timeout: 120_000 });
    await pkg.click();
    const file = await download;
    await file.saveAs(join(OUT, file.suggestedFilename()));
    console.log(`STEP saved ${file.suggestedFilename()}`);
  }
  writeFileSync(join(OUT, 'audit.txt'), await page.locator('#main-content').innerText());

  await page.getByRole('link', { name: 'Back to cases' }).click();
  await page.waitForTimeout(2_000);
  await shot(page, 'dashboard-end');
});
