import { spawn } from 'node:child_process';

const env = { ...process.env, PORT: process.env.PORT || '8080' };
const child = spawn('npm', ['run', 'start', '-w', 'server'], {
  stdio: 'inherit',
  env,
  shell: true,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
