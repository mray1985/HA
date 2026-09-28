/**
 * Navigator — injects a generated TaxReturn into localStorage,
 * handles encryption, and walks through all visible wizard steps.
 */

import type { Page } from '@playwright/test';
import type { FuzzerTaxReturn } from '../generators/base';
import { handleEncryptionGate, setupEncryptionProgrammatically, FUZZER_PASSPHRASE } from './lock-screen';
import { ensureTaxpayerSession } from '../../helpers/unlock';

const USE_PROGRAMMATIC_ENCRYPTION = process.env.FUZZER_ENCRYPTION === 'programmatic';

/**
 * Inject a TaxReturn into the app via localStorage and navigate to the wizard.
 */
export async function injectAndOpen(page: Page, taxReturn: FuzzerTaxReturn): Promise<void> {
  // 1. Clear everything
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());

  await page.evaluate(({ tr, id }) => {
    localStorage.setItem(`hatax:return:${id}`, JSON.stringify(tr));
    localStorage.setItem('hatax:returns', JSON.stringify([id]));
    localStorage.setItem('hatax:consent', JSON.stringify({
      termsVersion: 'March 2026',
      privacyVersion: 'March 2026',
      acceptedAt: new Date().toISOString(),
    }));
  }, { tr: taxReturn, id: taxReturn.id });

  if (USE_PROGRAMMATIC_ENCRYPTION) {
    await setupEncryptionProgrammatically(page);
  }

  // A full navigation drops the in-memory key, so open the return with a
  // client-side click after the gate is dismissed.
  await page.reload();
  await handleEncryptionGate(page);
  await ensureTaxpayerSession(page);

  const openReturn = page.getByRole('button', { name: /Continue where you left off/i });
  await openReturn.waitFor({ state: 'visible', timeout: 30000 });
  await openReturn.click();
  await page.waitForURL(new RegExp(`/return/${taxReturn.id}`));
  await page.getByRole('button', { name: /Let.*Go|^Continue$|^Done/i }).first()
    .waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Walk through all visible wizard steps by clicking the nav button.
 * Returns the list of step IDs that were visited and any errors found.
 */
export async function walkAllSteps(page: Page): Promise<{ visitedSteps: string[]; errors: string[] }> {
  const visitedSteps: string[] = [];
  const errors: string[] = [];
  let stuckCount = 0;
  let lastStepLabel = '';

  for (let i = 0; i < 100; i++) { // safety cap
    // Extract current step label from DOM (sidebar active item or page heading)
    const stepLabel = await extractStepLabel(page, i);
    visitedSteps.push(stepLabel);

    // Check for error boundary DURING walk (not just after)
    const hasErrorBoundary = await page.getByText(/Something went wrong/i).isVisible({ timeout: 200 }).catch(() => false);
    if (hasErrorBoundary) {
      errors.push(`Error boundary triggered at step ${i} (${stepLabel})`);
      break;
    }

    const clicked = await clickNavButton(page);
    if (!clicked) {
      const onLastStep = await page.getByRole('heading', { name: /Export & PDF|Filing Instructions/i }).isVisible().catch(() => false);
      if (onLastStep) break;
      const disabledContinue = await page.locator('button:has-text("Continue"):disabled').isVisible().catch(() => false);
      if (disabledContinue) {
        errors.push(`Continue button disabled at step ${i} (${stepLabel}) — validation may be blocking`);
      }
      stuckCount++;
      if (stuckCount >= 2) break;
    } else if (stepLabel === lastStepLabel) {
      stuckCount++;
      if (stuckCount >= 3) break;
    } else {
      stuckCount = 0;
    }
    lastStepLabel = stepLabel;

    await page.waitForTimeout(100);
  }

  return { visitedSteps, errors };
}

/**
 * Extract the current step label from the DOM.
 * Tries: active sidebar item → page heading → fallback to index.
 */
async function extractStepLabel(page: Page, index: number): Promise<string> {
  // Try 1: Active sidebar item (highlighted/current step)
  const sidebarLabel = await page.evaluate(() => {
    // Look for active/current sidebar link
    const selectors = [
      '[aria-current="step"]',
      '[aria-current="true"]',
      '[data-active="true"]',
      '.active-step',
      'nav a[class*="active"]',
      'nav button[class*="active"]',
      // Fallback: look for a highlighted sidebar item with distinct styling
      'nav li[class*="current"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) return el.textContent.trim();
    }
    return null;
  }).catch(() => null);

  if (sidebarLabel) return sidebarLabel;

  // Try 2: Main content heading (h1, h2, or step title)
  const heading = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    const h = main.querySelector('h1, h2, [class*="step-title"], [class*="stepTitle"]');
    return h?.textContent?.trim() || null;
  }).catch(() => null);

  if (heading) return heading.slice(0, 60); // truncate long headings

  // Fallback
  return `step-${index}`;
}

/**
 * Click the main navigation button. Returns true if a button was found and clicked.
 */
async function clickNavButton(page: Page): Promise<boolean> {
  // The welcome step has "Let's Go", other steps have "Continue" or "Done"
  // The step action sits at the bottom of the page. An earlier hidden match
  // (chat, menus) must not block the walk.
  const buttons = page.getByRole('button', { name: /Let.*Go|^Continue|^Done$|^Done with|^Next$|Download Forms/i });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const count = await buttons.count();
    for (let i = count - 1; i >= 0; i--) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        await btn.click({ force: true, timeout: 3000 });
        return true;
      }
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/**
 * Navigate via sidebar to a specific section and walk its steps.
 */
export async function navigateToSection(page: Page, sectionLabel: string): Promise<void> {
  const sectionLink = page.getByText(sectionLabel, { exact: false }).first();
  if (await sectionLink.isVisible().catch(() => false)) {
    await sectionLink.click();
    await page.waitForTimeout(500);
  }
}
