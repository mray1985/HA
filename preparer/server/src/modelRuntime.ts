/**
 * The app's model runtime: one ModelRuntime for the server process.
 *
 * The desktop app sets HATAX_MODELS_DIR and HATAX_LLAMA_SERVER to the files
 * its installer bundles. Run from the repository, the models are read from
 * preparer/models and llama-server from preparer/tools/llama-cpp.
 */

import { existsSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ModelRuntime } from '@hatax/local-ai/node';
import { DATA_DIR } from './database.js';

const PREPARER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function findLlamaServer(): string {
  if (process.env.HATAX_LLAMA_SERVER) return process.env.HATAX_LLAMA_SERVER;
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const stack = [join(PREPARER_ROOT, 'tools', 'llama-cpp', 'bin')];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === exe) return path;
    }
  }
  return join(PREPARER_ROOT, 'tools', 'llama-cpp', 'bin', exe);
}

export const modelRuntime = new ModelRuntime({
  modelsDir: process.env.HATAX_MODELS_DIR ?? join(PREPARER_ROOT, 'models'),
  llamaServer: findLlamaServer(),
  stateDir: DATA_DIR,
  log: (message) => console.log(`[models] ${message}`),
});

// Model processes outlive the server on Windows unless they are stopped.
process.on('exit', () => modelRuntime.killNow());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    modelRuntime.killNow();
    process.exit(0);
  });
}
