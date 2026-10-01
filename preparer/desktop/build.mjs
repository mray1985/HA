// Bundles the desktop main process with the preparer server, the local-ai
// runtime and the engine into dist/main.cjs. Native modules and Electron stay
// external: electron-builder rebuilds the native ones for Electron.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/main.cjs',
  external: ['electron', 'better-sqlite3', 'bcrypt'],
  sourcemap: true,
  // import.meta.url in ESM sources, for a CommonJS bundle.
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel: 'info',
});
