import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/start-site.mjs <individual|preparer>
// Serves that app's built dist from the Express server (run build:<app> first).
const APPS = ['individual', 'preparer'];
const app = process.argv[2] || 'preparer';
if (!APPS.includes(app)) {
  console.error(`Unknown app "${app}". Use one of: ${APPS.join(', ')}`);
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  PORT: process.env.PORT || '8080',
  CLIENT_DIST: process.env.CLIENT_DIST || resolve(root, 'apps', app, 'dist'),
};
const child = spawn('npm', ['run', 'start', '-w', 'server'], {
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
