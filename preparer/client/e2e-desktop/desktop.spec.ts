/**
 * The desktop app, end to end: Electron starts the server and the local model
 * runtime from the bundled files, and a W-2 dropped into a case is read by
 * Qwen3.5-0.8B (with page evidence and GLM-OCR on call) and entered on the
 * return. Closed and opened again, the app is at the same address, asks for
 * the passphrase, and still has the case. Runs the unpackaged app from
 * ../desktop, or DESKTOP_EXE.
 */

import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCaseDashboard, PASSPHRASE } from '../e2e/helpers/preparer';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, '..', '..', 'desktop');
const require = createRequire(import.meta.url);

function launch(userData: string) {
  return electron.launch(process.env.DESKTOP_EXE
    ? { executablePath: process.env.DESKTOP_EXE, args: [`--user-data-dir=${userData}`] }
    : { executablePath: require(join(DESKTOP, 'node_modules', 'electron')) as unknown as string, args: [DESKTOP, `--user-data-dir=${userData}`] });
}

test('the desktop app reads a W-2 with its bundled models, and keeps the case after a restart', async () => {
  // A fresh profile: no earlier sign-in, vault or model state.
  const userData = mkdtempSync(join(tmpdir(), 'hatax-desktop-'));
  let origin = '';
  try {
    const app = await launch(userData);
    try {
      const page = await app.firstWindow();
      await page.waitForURL(/127\.0\.0\.1:\d+\/preparer/);
      origin = new URL(page.url()).origin;
      await openCaseDashboard(page, origin);

      await page.getByRole('button', { name: /New case/i }).first().click();
      await expect(page).toHaveURL(/\/documents$/);
      await expect(page.getByText(/Local AI ready: Qwen3\.5-0\.8B \+ GLM-OCR/)).toBeVisible({ timeout: 180_000 });

      await page.locator('input[type="file"]').first().setInputFiles(resolve(HERE, '..', 'e2e', 'fixtures', 'w2-basic-single.pdf'));
      await expect(page.getByText('Entered on the return')).toBeVisible({ timeout: 300_000 });

      await page.getByRole('link', { name: 'Approve' }).click();
      await expect(page.getByText(/w2-basic-single\.pdf: income_item \(read by the local models in \d+s\)/)).toBeVisible();
      await expect(page.getByText(/calculate_return: AGI \$52,431\.18/)).toBeVisible();
    } finally {
      await app.close();
    }

    // Opened again: the same address (the browser storage that holds the vault
    // and the cases belongs to it), the passphrase, and last session's case.
    const again = await launch(userData);
    try {
      const page = await again.firstWindow();
      await page.waitForURL(/127\.0\.0\.1:\d+\/preparer/);
      expect(new URL(page.url()).origin).toBe(origin);
      await expect(page.getByRole('button', { name: /^Unlock$/i })).toBeVisible({ timeout: 60_000 });
      await page.locator('#passphrase').fill(PASSPHRASE);
      await page.getByRole('button', { name: /^Unlock$/i }).click();
      await expect(page.getByText('Maya Testpayer').first()).toBeVisible({ timeout: 60_000 });
    } finally {
      await again.close();
    }
  } finally {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
