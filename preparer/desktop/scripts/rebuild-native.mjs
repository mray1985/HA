// Rebuilds this app's native modules (better-sqlite3, bcrypt) for Electron,
// in desktop/node_modules only. electron-builder's own rebuild searches every
// parent folder for node_modules, which rebuilt the preparer workspace's copies
// for Electron and broke the server and its tests under Node.
import { rebuild } from '@electron/rebuild';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronVersion = createRequire(import.meta.url)('electron/package.json').version;

await rebuild({
  buildPath: desktop,
  projectRootPath: desktop,
  electronVersion,
  onlyModules: ['better-sqlite3', 'bcrypt'],
  force: true,
});
console.log(`native modules rebuilt for Electron ${electronVersion} in ${desktop}\node_modules`);
