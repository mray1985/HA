import { defineConfig } from '@playwright/test';

// The desktop app (Electron): run after `npm run build` (unpackaged) or
// `npm run pack` in ../desktop; DESKTOP_EXE points at a packaged build.
export default defineConfig({
  testDir: './e2e-desktop',
  timeout: 600_000,
  workers: 1,
  reporter: 'line',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
