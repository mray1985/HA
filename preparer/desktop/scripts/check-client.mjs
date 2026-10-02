// Checks the client build the installer packages (../client/dist): it must
// exist, must have been built with the Syncfusion license key (or every page
// using Syncfusion shows its license banner), and its stylesheets and pages
// must not load anything from another host (the Privacy Policy says nothing
// leaves the computer; Syncfusion's themes import Google Fonts).
//
// Usage: node scripts/check-client.mjs [--warn]
//   --warn reports a problem without failing (npm run pack, for local testing).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

if (info.apiOrigin) {
  problem(`the client was built with an API origin (${info.apiOrigin}); the desktop app's API is its own server. Unset VITE_API_BASE and VITE_API_ORIGIN and rebuild.`);
}

// The Terms of Use and Privacy Policy state the business's facts from
// client/src/pages/legal.ts: a release waits until they are filled and reviewed.
const legal = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'pages', 'legal.ts'), 'utf8');
if (!/\bconfirmed:\s*true\b/.test(legal) || /contact@example\.com/.test(legal)) {
  problem('client/src/pages/legal.ts is not confirmed: fill in the company, contact address and governing law, have counsel review the Terms and Privacy pages, then set confirmed: true and rebuild.');
}

/** Stylesheets and pages that load from another host: a remote @import, or a <link> to one. */
function remoteLoads(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...remoteLoads(path));
    else if (/\.(css|html)$/.test(entry.name)) {
      const text = readFileSync(path, 'utf8');
      if (/@import\s+(url\()?\s*["']?(https?:)?\/\//i.test(text) || /<link[^>]+href=["']https?:\/\//i.test(text)) found.push(path);
    }
  }
  return found;
}
const remote = remoteLoads(dist);
if (remote.length > 0) {
  problem(`the client build loads stylesheets from another host (${remote.join(', ')}); the app must not reach the internet. See client/postcss.config.js.`);
}

console.log(`client build ${info.builtAt}: Syncfusion license key present; nothing loaded from another host.`);
