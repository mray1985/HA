/**
 * E2E: what the app cannot do by itself is handed to the preparer.
 *
 * A form is read, some of its boxes are placed on the return, and the rest are
 * named — with the form saying in words what it is, what it does, and what a
 * person still has to do. The reader's own warnings are shown rather than
 * dropped, and the assistant explains a form it read but did not enter.
 *
 * 1099q-529.pdf is the fixture: its boxes 4a, 4b and 6 are read, and what is left
 * is named. A box the return has nowhere for is listed without an input, because
 * there would be nowhere to put what was typed — that rule is asserted here too.
 */

import { expect, test, type Page } from '@playwright/test';
import { openCaseDashboard } from './helpers/preparer';

test.beforeEach(async ({ page }) => {
  await openCaseDashboard(page);
});

async function newCaseWith1099Q(page: Page) {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await expect(page).toHaveURL(/\/documents$/);
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/1099q-529.pdf');
  await expect(page.getByText('1099q-529.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Documents' }).click();
}

/** The panel listing what the reader did not place by itself. */
function gapPanel(page: Page) {
  return page.getByText('Not added by itself — check these against the form').locator('xpath=ancestor::div[1]');
}

test('a box the app cannot place is named, and the form explains itself', async ({ page }) => {
  await newCaseWith1099Q(page);

  const panel = gapPanel(page);
  await expect(panel).toBeVisible();

  // What the form is, in words, before any box is listed.
  await expect(panel).toContainText(/529 plan or education account/i);
  // What it does to the return.
  await expect(panel).toContainText(/other income/i);
  // And what a person still has to do about it.
  await expect(panel).toContainText(/spent on qualified education/i);
  // How much of the form was placed, out of what it needs.
  await expect(panel).toContainText(/of 10 boxes on the return were filled in/);

  // The boxes are named by printed number and the form's own label.
  await expect(panel).toContainText('box 5c');
  await expect(panel).toContainText('Distribution is from: Coverdell ESA');
});

test('a box the return has nowhere for is listed without an input', async ({ page }) => {
  await newCaseWith1099Q(page);
  const panel = gapPanel(page);
  await expect(panel).toBeVisible();

  // The rule under test: an input appears only for a box that feeds a field on
  // the return. A control that silently discards what a preparer typed is worse
  // than no control, so a box with nowhere to go must not offer one.
  // The gap list nests a list per box, so the group's own row also contains the
  // word; the box's own row is the last one.
  const corrected = panel.getByRole('listitem').filter({ hasText: 'CORRECTED' }).last();
  await expect(corrected).toBeVisible();
  await expect(corrected.getByRole('button', { name: 'type the value' })).toHaveCount(0);

  // A form held in full is one entry, not a list of inputs: nothing on it is
  // established well enough to write into.
  await page.getByRole('link', { name: 'Back to cases' }).click();
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2c-wages.pdf');
  await expect(page.getByText('w2c-wages.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Documents' }).click();

  const w2c = gapPanel(page);
  await expect(w2c).toContainText(/corrected version of a W-2/i);

  // Box e feeds correctsSsnOrName, so it is offered. Box 13 is a printed square
  // with no return field behind it, so it is not. One input, on the right row.
  const enter = w2c.getByRole('button', { name: 'type the value' });
  await expect(enter).toHaveCount(1);
  await expect(w2c.getByRole('listitem').filter({ hasText: 'box e' }).last()).toContainText('type the value');
  const box13 = w2c.getByRole('listitem').filter({ hasText: 'box 13' }).last();
  await expect(box13).toBeVisible();
  await expect(box13.getByRole('button', { name: 'type the value' })).toHaveCount(0);
});

test('a value is typed into its own box and recorded against that box', async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2c-wages.pdf');
  await expect(page.getByText('w2c-wages.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: 'Documents' }).click();

  const panel = gapPanel(page);
  const row = panel.getByRole('listitem').filter({ hasText: 'box e' }).last();
  await row.getByRole('button', { name: 'type the value' }).click();

  // The input opens in place, under the box it belongs to. No PDF to open.
  const form = panel.locator('form');
  await expect(form).toBeVisible();
  await expect(form).toContainText('Enter the value');
  await form.locator('select').selectOption('yes');
  await form.getByRole('button', { name: 'Save' }).click();

  // It closes once recorded.
  await expect(form).toHaveCount(0);

  // And it was recorded against that box: the audit trail names the field and
  // both the old reading and what the preparer put in its place.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/correctsSsnOrName/).first()).toBeVisible({ timeout: 20_000 });
});

test("the reader's own warnings reach the preparer", async ({ page }) => {
  await newCaseWith1099Q(page);
  // This sentence is written by the reader while reading. It used to be produced
  // and then dropped, which is how "check these against the form" never arrived.
  await expect(page.getByText(/could not be read of 10 boxes this form needs/i)).toBeVisible();
  // And it names the boxes rather than only counting them.
  await expect(page.getByText(/box 5c/i).first()).toBeVisible();
});

// The Assistant tab's wording for a form that was read but not entered is
// covered deterministically in src/__tests__/assistantGuidance.test.ts. It is
// not asserted here on purpose: whether a given form produces that turn depends
// on how the reader's run resolves, so an end-to-end assertion on it is racy.

test('a case cannot be approved while a document has boxes the app could not place', async ({ page }) => {
  await page.getByLabel('Tax year for a new case').selectOption('2025');
  await page.getByRole('button', { name: /New case/i }).first().click();
  await page.getByLabel("Add the client's documents").setInputFiles('e2e/fixtures/w2c-wages.pdf');
  await expect(page.getByText('w2c-wages.pdf', { exact: true })).toBeVisible({ timeout: 60_000 });

  // The approval page is where the decision is made, so the unread boxes have to
  // be named there rather than only in the Documents tab.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/boxes on .* the app could not add by itself/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /^Approve$/ })).toHaveCount(0);

  // Settling it is an explicit act.
  await page.getByRole('link', { name: /^Assistant/ }).click();
  const gap = page.getByRole('listitem').filter({ hasText: 'could not be added by itself' }).first();
  await expect(gap).toBeVisible({ timeout: 20_000 });
  await gap.getByRole('button', { name: 'I have checked this' }).click();
  await page.getByRole('button', { name: 'Checked against the document' }).first().click();
  await expect(gap).toHaveCount(0);

  // It no longer holds the case open, and the note makes the inspection a
  // record rather than a click: the trail names the boxes and what was done.
  await page.getByRole('link', { name: 'Approve' }).click();
  await expect(page.getByText(/could not add by itself/i)).toHaveCount(0);
  await expect(page.getByText(/Decided:.*2 boxes on W-2C could not be added by itself — box e, box 13/s)).toBeVisible();
});
