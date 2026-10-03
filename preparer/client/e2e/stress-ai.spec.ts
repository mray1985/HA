/**
 * Stress run with the local AI (not part of the suite; E2E_MODELS=1 and
 * STRESS_DIR=<dir with docs/ and truth.json>): a preparer drops every
 * household's documents on the dashboard at once, places what the intake could
 * not, pastes each client's reply, and the run records what the app did —
 * the batch result, each case's return and documents, the review list —
 * in STRESS_DIR/run/ for scoring against the truth (local-ai/gauntlet/stress).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DIR = process.env.STRESS_DIR ?? '';
const OUT = join(DIR, 'run');
const PASSPHRASE = 'e2e-passphrase-2026';

test.skip(!process.env.E2E_MODELS || !DIR, 'E2E_MODELS=1 and STRESS_DIR are required (see local-ai/gauntlet/stress/README.md)');
// No action waits past two minutes: a control that never enables fails the step, not the run.
test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 120_000 });
test.setTimeout(4 * 60 * 60_000);

const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  writeFileSync(join(OUT, 'log.txt'), `${stamped}\n`, { flag: 'a' });
};

async function dropFiles(page: Page, target: string, files: string[]) {
  const payload = files.map((path) => {
    const name = path.split(/[\\/]/).pop()!;
    return { name, type: name.endsWith('.png') ? 'image/png' : 'application/pdf', bytes: readFileSync(path).toString('base64') };
  });
  const dataTransfer = await page.evaluateHandle((items) => {
    const dt = new DataTransfer();
    for (const item of items) {
      const bin = atob(item.bytes);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], item.name, { type: item.type }));
    }
    return dt;
  }, payload);
  await page.dispatchEvent(target, 'dragenter', { dataTransfer });
  await page.dispatchEvent(target, 'dragover', { dataTransfer });
  await page.dispatchEvent(target, 'drop', { dataTransfer });
}

/** Every case of the vault, with its documents and facts (the app's own modules, in the unlocked page). */
async function dumpCases(page: Page) {
  return page.evaluate(async () => {
    const api = await import('/src/api/client.ts' as string);
    const docs = await import('/src/services/documentIngestion.ts' as string);
    const facts = await import('/src/services/preparerTaxFacts.ts' as string);
    return (api.listReturns() as Array<{ id: string }>).map((r) => ({ taxReturn: api.getReturn(r.id), documents: docs.loadDocuments(r.id), facts: facts.loadTaxFacts(r.id) }));
  });
}

/** Open a case tab by URL; a reload must not lock the vault (the session key). */
async function openCase(page: Page, id: string, tab: string, notes: string[]) {
  await page.goto(`/preparer/case/${id}/${tab}`);
  const unlock = page.locator('#passphrase');
  const ready = page.getByRole('link', { name: 'Assistant' }).first();
  await unlock.or(ready).first().waitFor({ state: 'visible', timeout: 60_000 });
  if (await unlock.isVisible()) {
    notes.push(`reload of ${tab} asked for the passphrase`);
    await unlock.fill(PASSPHRASE);
    await page.getByRole('button', { name: /Unlock/i }).click();
    await ready.waitFor({ state: 'visible', timeout: 60_000 });
  }
}

test('stress: seven households, every document read by the local AI', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'log.txt'), '');
  const truth = JSON.parse(readFileSync(join(DIR, 'truth.json'), 'utf8')) as {
    taxYear: number;
    documents: Array<{ file: string; household: string }>;
    replies: Record<string, string>;
  };
  const files = readdirSync(join(DIR, 'docs')).map((f) => join(DIR, 'docs', f));
  const notes: string[] = [];
  page.on('load', () => log(`page load: ${page.url()}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => log(`page error: ${e.message.slice(0, 300)}`));

  // ── Sign up, the vault, the season ──
  await page.goto('/preparer/register');
  await page.locator('#name').fill('Stress Preparer');
  await page.locator('#email').fill(`stress-preparer-${Date.now()}@example.com`);
  await page.locator('#password').fill('e2e-password-2026');
  await page.locator('#confirmPassword').fill('e2e-password-2026');
  await page.getByRole('button', { name: /Create Account/i }).click();
  const setup = page.getByRole('button', { name: /Set Up Encryption/i });
  await setup.waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('#passphrase').fill(PASSPHRASE);
  await page.locator('#confirm').fill(PASSPHRASE);
  await setup.click();
  const season = page.getByRole('button', { name: /Start this season/i });
  const dashboard = page.getByRole('button', { name: /New case/i }).first();
  await season.or(dashboard).first().waitFor({ state: 'visible', timeout: 120_000 });
  if (await season.isVisible()) await season.click();
  await dashboard.waitFor({ state: 'visible', timeout: 60_000 });

  // ── Every document at once ──
  await page.getByLabel('Tax year for a new case').selectOption(String(truth.taxYear));
  log(`dropping ${files.length} documents`);
  const started = Date.now();
  await dropFiles(page, 'section[aria-label="Add documents"]', files);
  const status = page.locator('section[aria-label="Add documents"] [role="status"]');
  await status.waitFor({ state: 'visible', timeout: 60_000 });
  // Done when the status has been gone for three polls in a row (it can blink between files).
  let last = '';
  const toastsSeen = new Set<string>();
  const yearSelect = page.getByLabel('Tax year for a new case');
  let lockedDuringBatch = false;
  for (let gone = 0; gone < 3;) {
    // The idle lock during a long batch: the work keeps its key until it has
    // saved; the preparer comes back after it ends and unlocks.
    if (await page.locator('#passphrase').isVisible().catch(() => false)) {
      if (!lockedDuringBatch) { lockedDuringBatch = true; log('the vault locked during the batch'); notes.push('the vault idle-locked during the batch'); }
      const running = await page.evaluate(async () => (await import('/src/services/backgroundWork.ts' as string)).backgroundWorkRunning() as boolean);
      if (running) { await page.waitForTimeout(5_000); continue; }
      log('the batch ended while locked; unlocking');
      await page.locator('#passphrase').fill(PASSPHRASE);
      await page.getByRole('button', { name: /Unlock/i }).click();
      await page.getByRole('button', { name: /New case/i }).first().waitFor({ state: 'visible', timeout: 60_000 });
      gone = 0;
      continue;
    }
    const visible = await status.isVisible().catch(() => false);
    gone = visible ? 0 : gone + 1;
    const text = visible ? ((await status.textContent().catch(() => '')) ?? '') : '';
    if (visible && text !== last) { log(`batch: ${text}`); last = text; }
    for (const t of await page.locator('[data-sonner-toast]').allInnerTexts().catch(() => [])) {
      if (!toastsSeen.has(t)) { toastsSeen.add(t); log(`toast: ${t.replace(/\s+/g, ' ')}`); }
    }
    if (!visible) {
      const year = await yearSelect.inputValue().catch(() => 'no dashboard');
      const locked = await page.locator('#passphrase').isVisible().catch(() => false);
      log(`status gone (${gone}/3): url ${page.url()}, year ${year}, lock screen ${locked}`);
    }
    await page.waitForTimeout(5_000);
  }
  if (!(await page.getByLabel('Tax year for a new case').inputValue()).includes(String(truth.taxYear))) {
    notes.push('the dashboard was reloaded during the batch (its tax year reset)');
  }
  const batchSeconds = Math.round((Date.now() - started) / 1000);
  log(`batch done in ${batchSeconds}s`);
  const section = page.locator('section[aria-label="Add documents"]');
  const batchText = await section.innerText();
  writeFileSync(join(OUT, 'batch.txt'), batchText);

  // ── What the intake could not place, the preparer places (one decision each) ──
  const held = page.getByRole('list', { name: 'Documents not placed' });
  const preparerPlaced: Array<{ file: string; to: string | null }> = [];
  for (let i = 0; i < 30 && (await held.isVisible().catch(() => false)); i++) {
    const select = held.getByRole('combobox').first();
    const label = (await select.getAttribute('aria-label')) ?? '';
    const file = label.replace(/^Case for /, '');
    const household = truth.documents.find((d) => d.file === file)?.household ?? null;
    const options = await select.locator('option').allTextContents();
    const option = household ? options.find((o) => o.includes(household)) : undefined;
    if (!option) {
      preparerPlaced.push({ file, to: null });
      log(`not placed, no case to choose for ${file} (options: ${options.join(' | ')})`);
      break;
    }
    await select.selectOption({ label: option });
    await held.getByRole('button', { name: 'Add' }).first().click();
    await expect(page.getByRole('combobox', { name: label })).toHaveCount(0, { timeout: 30 * 60_000 });
    preparerPlaced.push({ file, to: option });
    log(`preparer placed ${file} on ${option}`);
  }

  const afterIntake = await dumpCases(page);
  writeFileSync(join(OUT, 'cases-after-intake.json'), JSON.stringify(afterIntake, null, 2));

  // ── Each client's reply, read by the local reader ──
  const replies: Array<{ household: string; returnId: string | null; answered: string; answers: string; offers: string[]; seconds: number }> = [];
  for (const [household, reply] of Object.entries(truth.replies)) {
    const [first, last] = household.toUpperCase().split(' ');
    const named = (r: unknown) => {
      const t = r as { firstName?: string; lastName?: string };
      return (t.firstName ?? '').toUpperCase() === first && (t.lastName ?? '').toUpperCase() === last;
    };
    // The household's case: by its taxpayer, or — a case the intake left unnamed
    // (two adults on one case) — by the household's documents on it.
    const match = afterIntake.find(({ taxReturn }) => named(taxReturn))
      ?? afterIntake.find(({ documents }) => (documents as Array<{ fileName: string }>).some((d) => truth.documents.find((t) => t.file === d.fileName)?.household === household));
    if (!match) {
      replies.push({ household, returnId: null, answered: 'no case', answers: '', offers: [], seconds: 0 });
      log(`no case for ${household}`);
      continue;
    }
    const id = (match.taxReturn as { id: string }).id;
    if (!named(match.taxReturn)) {
      // The preparer chooses the taxpayer from the people the documents name.
      await openCase(page, id, 'assistant', notes);
      const choose = page.getByRole('button', { name: 'Choose the taxpayer' }).first();
      if (await choose.isVisible().catch(() => false)) {
        await choose.click();
        const select = page.getByLabel('Taxpayer');
        if (await select.isVisible().catch(() => false)) {
          const option = (await select.locator('option').allTextContents()).find((o) => o.toUpperCase().startsWith(`${first} ${last}`));
          if (option) await select.selectOption({ label: option });
        }
        await page.getByRole('button', { name: 'Save' }).click();
        log(`preparer chose ${household} as the taxpayer of the unnamed case`);
        notes.push(`${household}'s case was unnamed after intake; the preparer chose the taxpayer`);
      } else {
        log(`${household}'s case is unnamed and offers no taxpayer to choose`);
      }
    }
    await openCase(page, id, 'assistant', notes);
    await page.getByLabel("Client's reply").fill(reply);
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Read their reply' }).click();
    const answers = page.getByRole('region', { name: 'Ask the client' });
    const failed = page.getByRole('alert');
    // The count line, not the list: a reply that answers no open question leaves the list empty (not visible).
    const done = page.getByText(/\d+ of \d+ questions? answered/);
    await done.or(failed).first().waitFor({ state: 'visible', timeout: 30 * 60_000 });
    const seconds = Math.round((Date.now() - t0) / 1000);
    const answered = (await page.getByText(/question(s)? answered/).first().textContent().catch(() => null)) ?? (await failed.textContent().catch(() => '')) ?? '';
    const answersText = (await answers.innerText().catch(() => '')) ?? '';
    const offers = page.getByLabel('New facts in the reply');
    const offerTexts: string[] = [];
    if (await offers.isVisible().catch(() => false)) {
      const items = offers.getByRole('listitem');
      const n = await items.count();
      for (let k = 0; k < n; k++) offerTexts.push((await items.nth(k).innerText()).replace(/\s+/g, ' '));
      // The preparer adds each offered fact (one decision each). A business expense
      // waits for its Schedule C line — and its business, when the return has several —
      // which only the preparer gives: here, line 27a and the first business.
      for (let k = 0; k < n; k++) {
        const item = items.nth(k);
        const add = item.getByRole('button', { name: 'Add', exact: true });
        if (!(await add.isVisible().catch(() => false))) continue;
        const line = item.getByLabel('Schedule C line for this expense');
        if (await line.isVisible().catch(() => false)) await line.selectOption({ label: 'Line 27a — Other expenses' });
        const business = item.getByLabel('Business this expense belongs to');
        if (await business.isVisible().catch(() => false)) await business.selectOption({ index: 1 });
        try {
          await add.click({ timeout: 30_000 });
        } catch {
          log(`could not add the offer: ${offerTexts[k]}`);
        }
        await page.waitForTimeout(500);
      }
    }
    replies.push({ household, returnId: id, answered: answered.trim(), answers: answersText, offers: offerTexts, seconds });
    log(`${household}: ${answered.trim()} in ${seconds}s; ${offerTexts.length} new facts offered`);
  }
  writeFileSync(join(OUT, 'replies.json'), JSON.stringify(replies, null, 2));

  // ── The review list of every case ──
  const final = await dumpCases(page);
  const reviews: Record<string, string> = {};
  for (const { taxReturn } of final) {
    const id = (taxReturn as { id: string }).id;
    await openCase(page, id, 'assistant', notes);
    await page.waitForTimeout(3_000);
    reviews[id] = await page.locator('#main-content').innerText();
  }
  writeFileSync(join(OUT, 'cases-final.json'), JSON.stringify(final, null, 2));
  writeFileSync(join(OUT, 'reviews.json'), JSON.stringify(reviews, null, 2));
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ batchSeconds, preparerPlaced, notes }, null, 2));
  log(`done: ${final.length} cases; notes: ${notes.join('; ') || 'none'}`);
});
