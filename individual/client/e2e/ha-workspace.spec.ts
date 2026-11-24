import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unlockDashboard } from './helpers/unlock';

// Every record and document in this suite is fictional. The normal encryption
// gate stays enabled; seed only this test browser's freshly created return.
async function openWorkspace(page: Page) {
  await page.goto('/');
  await unlockDashboard(page);
  await page.evaluate(async () => {
    const modulePath = '/src/api/client.ts';
    const api = await import(/* @vite-ignore */ modulePath);
    const tr = api.createReturn();
    api.updateReturn(tr.id, {
      firstName: 'Jordan', lastName: 'Sample', ssn: '000000000',
      dateOfBirth: '1985-01-01', filingStatus: 1,
      addressStreet: '123 Example Lane', addressCity: 'Example', addressState: 'LA', addressZip: '00000',
      w2Income: [{ id: 'sample-w2', employerName: 'Fictional Employer', wages: 55000, federalTaxWithheld: 6000, socialSecurityWages: 55000, socialSecurityTax: 3410, medicareWages: 55000, medicareTax: 797.50 }],
      businesses: [{ id: 'sample-business', businessName: 'Fictional Design', businessDescription: 'Design services', accountingMethod: 'cash', didStartThisYear: false }],
      income1099NEC: [{ id: 'sample-nec', payerName: 'Fictional Client', amount: 12000, businessId: 'sample-business' }],
    });
    window.history.pushState({}, '', `/return/${tr.id}/workspace`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'See the whole picture.' })).toBeVisible();
  await expect(page.locator('.ha-result')).not.toContainText('Pending');
  await expect(page.locator('.ha-pdf canvas')).toBeVisible({ timeout: 30000 });
}

async function packetPDF(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((text, i) => page.drawText(text, { x: 40, y: 750 - i * 24, size: 12, font }));
  return Buffer.from(await doc.save());
}

test.describe('Connected HA workspace', () => {
  test.setTimeout(120000);

  test('shows and links the three screens, switches explanation mode, and downloads the IRS PDF', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openWorkspace(page);
    await expect(page.locator('.ha-three > .ha-panel')).toHaveCount(3);
    await page.locator('.ha-source-links').getByRole('button', { name: /Adjusted gross income/ }).hover();
    await expect(page.locator('.ha-explanation-rows .selected')).toContainText('Adjusted gross income');
    await expect(page.locator('.ha-pdf-highlight')).toBeVisible();
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await expect(page.locator('.ha-bars meter')).toHaveCount(6);
    await page.getByRole('button', { name: 'Written', exact: true }).click();
    await expect(page.locator('.ha-narrative')).toContainText('allowed adjustments');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('HA-2025-f1040-review.pdf');
    await page.screenshot({ path: test.info().outputPath('three-screens-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Plain language', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('three-screens-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('runs the game, searches the Taxtionary, and loads Radio audio', async ({ page }) => {
    await page.goto('/ha');
    await expect(page.getByRole('heading', { name: 'Win the tax game.' })).toBeVisible();
    const answers = ['Taxable income', 'No', 'Tax paid ahead', 'Review business purpose and category', 'Understand the return and make accurate decisions'];
    for (let i = 0; i < answers.length; i++) {
      await page.getByRole('button', { name: answers[i], exact: true }).click();
      await expect(page.getByText('Correct. +100 points', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: i === answers.length - 1 ? 'See results' : 'Next question', exact: true }).click();
    }
    await expect(page.getByText(/500 of 500 points/)).toBeVisible();
    await page.getByRole('button', { name: 'Play again', exact: true }).click();
    await expect(page.getByText('Question 1 of 5 · 0 points', { exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'HA workspace' }).getByRole('button', { name: 'Taxtionary', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a tax word' }).fill('withholding');
    await expect(page.locator('.ha-definitions dt')).toHaveText(['Withholding', 'Estimated tax']);
    const radio = page.getByRole('complementary', { name: 'HA Tax Radio' });
    await radio.getByRole('button', { name: 'Transcript & audio' }).click();
    await expect(radio.locator('.ha-radio-details')).toContainText('reduces');
    await expect.poll(() => radio.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState), { timeout: 15000 }).toBeGreaterThan(0);
    await radio.getByRole('button', { name: 'Play lesson' }).click();
    await expect(radio.getByRole('button', { name: 'Pause lesson' })).toBeVisible();
    await radio.getByRole('button', { name: 'Pause lesson' }).click();
    await expect(radio.getByRole('button', { name: 'Play lesson' })).toBeVisible();
  });

  test('transfers a reviewed HAKeeper expense once and connects its lesson', async ({ page }) => {
    await openWorkspace(page);
    const before = await page.locator('.ha-result').innerText();
    const navigation = page.getByRole('navigation', { name: 'HA workspace' });
    await navigation.getByRole('button', { name: 'HAKeeper', exact: true }).click();
    await page.getByLabel('Date', { exact: true }).fill('2025-04-01');
    await page.getByLabel('Business purpose', { exact: true }).fill('Fictional printer supplies');
    await page.getByLabel('Business portion ($)', { exact: true }).fill('100');
    await page.getByRole('button', { name: 'Add expense', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Fictional printer supplies', exact: true })).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Review Schedule C transfer', exact: true }).click();
      await page.getByRole('button', { name: 'Apply reviewed expenses', exact: true }).click();
    }
    const transferred = await page.evaluate(async () => {
      const modulePath = '/src/store/taxReturnStore.ts';
      const { useTaxReturnStore } = await import(/* @vite-ignore */ modulePath);
      return useTaxReturnStore.getState().taxReturn.expenses;
    });
    expect(transferred).toHaveLength(1);
    expect(transferred[0]).toMatchObject({ amount: 100, scheduleCLine: 22, businessId: 'sample-business' });
    await page.getByRole('button', { name: 'Listen to the bookkeeping lesson', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Radio lesson' })).toHaveValue('1');
    await navigation.getByRole('button', { name: 'Three screens', exact: true }).click();
    await expect(page.locator('.ha-result')).not.toHaveText(before);
    await expect(page.locator('.ha-pdf canvas')).toBeVisible();
  });

  test('reads K-1, QBI statement, and K-3 PDFs together and applies only reviewed K-1 values', async ({ page }) => {
    await openWorkspace(page);
    await page.getByRole('navigation', { name: 'HA workspace' }).getByRole('button', { name: 'Statements', exact: true }).click();
    await page.getByLabel('Upload the K-1, K-3, and supporting statement PDFs together').setInputFiles([
      { name: 'fictional-k1.pdf', mimeType: 'application/pdf', buffer: await packetPDF(['Schedule K-1 (Form 1065) 2025', 'Entity EIN: 12-3456789', 'Recipient TIN: 000-00-0000', 'Tax year: 2025', 'Ordinary business income (loss): 2000']) },
      { name: 'fictional-qbi.pdf', mimeType: 'application/pdf', buffer: await packetPDF(['Supplemental Statement', 'Box 20 Code Z', 'Qualified business income (loss): 1500']) },
      { name: 'fictional-k3.pdf', mimeType: 'application/pdf', buffer: await packetPDF(['Schedule K-3 (Form 1065) 2025', 'Part II Foreign Tax Credit Limitation', 'Country code: CA', 'Passive category General category', 'Interest income: 100 200']) },
    ]);
    await expect(page.getByRole('status').filter({ hasText: 'Read 3 pages across 3 files.' })).toBeVisible({ timeout: 30000 });
    await page.getByLabel('Entity name', { exact: true }).fill('Fictional Partnership');
    await page.getByRole('checkbox', { name: 'Ordinary business income (loss)', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Section 199A qualified business income', exact: true }).check();
    await expect(page.getByRole('checkbox', { name: 'Interest income', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: /I verified the entity/ }).check();
    await page.getByRole('button', { name: 'Apply selected reviewed K-1 fields', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Reviewed fields applied to the K-1' })).toBeVisible();
    const applied = await page.evaluate(async () => {
      const modulePath = '/src/store/taxReturnStore.ts';
      const { useTaxReturnStore } = await import(/* @vite-ignore */ modulePath);
      return useTaxReturnStore.getState().taxReturn.incomeK1;
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ entityEin: '12-3456789', ordinaryBusinessIncome: 2000, section199AQBI: 1500 });
    expect(applied[0].interestIncome).toBeUndefined();
    await page.getByRole('searchbox', { name: 'Find a box, code, word, or amount' }).fill('1500');
    await expect(page.locator('.ha-packet-text button')).toHaveCount(1);
    await page.locator('.ha-packet-text button').click();
    await expect(page.locator('.ha-packet-text button')).toContainText('fictional-qbi.pdf');
    await page.screenshot({ path: test.info().outputPath('packet-reviewed.png'), fullPage: true });
  });
});
