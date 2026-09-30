import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/start-site.mjs
// Serves client/dist from the Express server (run `npm run build` first).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  PORT: process.env.PORT || '8080',
  CLIENT_DIST: process.env.CLIENT_DIST || resolve(root, 'client', 'dist'),
};
const child = spawn('npm', ['run', 'start', '-w', 'server'], {
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
