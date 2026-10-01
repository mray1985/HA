// Checks the client build the installer packages (../client/dist): it must
// exist and must have been built with the Syncfusion license key, or every
// page using Syncfusion shows its license banner.
//
// Usage: node scripts/check-client.mjs [--warn]
//   --warn reports a problem without failing (npm run pack, for local testing).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const warnOnly = process.argv.includes('--warn');
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

function problem(message) {
  if (warnOnly) {
    console.warn(`warning: ${message}`);
    process.exit(0);
  }
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!existsSync(resolve(dist, 'index.html'))) {
  problem(`no client build at ${dist}. Run \`npm run build -w client\` from preparer/ first.`);
}

let info;
try {
  info = JSON.parse(readFileSync(resolve(dist, 'build-info.json'), 'utf8'));
} catch {
  problem('the client build has no build-info.json; it predates the license check. Rebuild it with `npm run build -w client`.');
}

if (info.syncfusionLicensed !== true) {
  problem(
    'the client was built without VITE_SYNCFUSION_LICENSE_KEY, so its PDF viewer and charts would show the Syncfusion license banner. ' +
      'Put the key in preparer/client/.env.local (or the build environment) and rebuild the client.',
  );
}

console.log(`client build ${info.builtAt}: Syncfusion license key present.`);
