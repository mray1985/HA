# Security Policy

## Architecture Overview

HA Tax Preparer is a Windows desktop app for tax professionals. The app starts its own server inside the app, bound to `127.0.0.1` on a free port, and shows the site in a locked-down window (context isolation, sandbox, no Node.js in the page). Links that leave the app open in the preparer's browser; the window itself never navigates away. The tax engine (`@hatax/engine`) is a pure computation library with no I/O, no network calls and no filesystem access. Documents and client replies are read by local models on the preparer's CPU; nothing is sent to a cloud service, and the app sends no telemetry.

## Data Storage

### Case Data (in the app, encrypted)

Cases never reach the server:

- **localStorage** — encrypted case records: the return, its facts, review decisions and audit trail
- **IndexedDB** — the source documents a preparer drops, each file encrypted with the same key
- **Encryption** — AES-256-GCM via the Web Crypto API
- **Key derivation** — PBKDF2 with 600,000 iterations + SHA-256 from the preparer's passphrase
- **Salt** — 16 random bytes, generated once on first setup
- **IV** — random 12-byte IV per encryption operation
- **Passphrase** — never stored; the derived key is non-extractable and is forgotten on lock, sign-out or wipe
- **AAD** — AES-GCM additional authenticated data (`hatax-v1`) binds ciphertext to the app context
- **Session key** — the unlocked key is kept for the window's session so a reload does not lock the preparer out; a session older than 12 hours starts with the passphrase again
- **Locks** — the screen locks after 15 minutes idle and 30 seconds after the window is hidden; the key is forgotten as soon as the local AI's running work has saved
- **Unlock throttling** — 30-second lockout after 5 failed passphrase attempts (a guard against typos; PBKDF2's iteration count is the brute-force defense)

### Server-Side

The server keeps only what sign-in needs, in a SQLite database in the user's app-data folder:

- **Accounts** — preparers only: registration creates a preparer account, and any other account is refused at sign-in. Each holds an email, name, role, password hash (bcrypt, 12 rounds) and the season seat. An admin account, which can remove users, is added to the database directly.
- **Sessions** — each sign-in's token hash and expiry; signing out ends the session, so the token stops working
- **Signing key** — `JWT_SECRET` when set, otherwise one random key per install that survives restarts

Returns, documents and replies are never stored or logged on the server. The model routes take a page image or text for one reading, return the result and keep nothing.

## PII Handling

Social Security Numbers, names and addresses are read from documents on the preparer's machine and stored only in the encrypted case. The local models receive the page or the reply text on `127.0.0.1`; no PII is sent off the computer. The calculation engine does not process or require SSNs.

## Local Models

- **Pinned files** — each approved model file is pinned by size and SHA-256 in `local-ai/src/modelManifest.ts`; any other file is refused
- **Bundled, never downloaded** — the installer carries llama.cpp's `llama-server` and the model files; the app downloads nothing
- **Run records** — each reading's model, file hash and result are kept with the case

## App Security

### Content Security Policy

The page and the server send a self-only Content Security Policy: scripts, styles, fonts, images, workers and connections from the app itself only, no frames from elsewhere, no objects. `npm run dist` refuses to build an installer whose site loads anything remote (`desktop/scripts/check-client.mjs`).

### Release Checks

Before an installer is built, `npm run dist` checks the Syncfusion license key, the API origin, the legal pages' confirmed flag, and that no remote stylesheet or page is loaded. The release build signs the program, the installer and uninstaller, and `llama-server`.

## Test Data

All example data used in tests is entirely fictional. Any SSNs, names or addresses in test fixtures are fabricated (the stress run's SSNs use area 000, which is never issued). No real taxpayer data is included in this repository.

## Dependency Supply Chain

The project uses `package-lock.json` for deterministic dependency resolution. The Syncfusion PDF Viewer (proprietary, Community License) is the only non-standard dependency; its WASM binary is vendored in `client/public/ej2-pdfviewer-lib/`. pdf.js fonts and Tesseract's OCR data are self-hosted; nothing is loaded from a CDN.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

- **Email:** security@hatax.dev
- **GitHub:** Use [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories) to submit a private report on this repository

Please do **not** open a public GitHub issue for security vulnerabilities. We will acknowledge your report within 48 hours and aim to triage it within 7 days. Fix timelines depend on severity and complexity.

## Known Security Limitations

These are inherent limitations of a local-first desktop app. They are not bugs — they are documented trade-offs.

### Offline passphrase brute-force

If an attacker obtains the app's stored data (physical access, malware, a copied user profile), they can attempt offline brute-force against the passphrase. PBKDF2 with 600,000 iterations slows each attempt to ~0.3 seconds on modern hardware. **Use a strong passphrase (16+ characters).** If the computer is compromised, encryption cannot fully protect against a determined attacker with unlimited offline time.

### Script injection is the primary threat

A script injected into the page could read decrypted case data while the vault is unlocked. Mitigations include React's output escaping, the self-only Content Security Policy, the sandboxed window, and avoiding `dangerouslySetInnerHTML`.

### The computer is the boundary

Every case on a computer is protected by that computer's passphrase. Lock the screen when away (the app locks itself after 15 minutes idle), and keep Windows itself up to date and signed in only by the preparer.

## Scope

The primary security concerns for this project are:

- **Data confidentiality** — case data stays encrypted on the preparer's computer and never leaves it
- **Correctness** — incorrect calculations could cause financial harm (see [DISCLAIMER.md](DISCLAIMER.md))
- **Dependency supply chain** — malicious or compromised dependencies or model files
- **Sign-in** — password hashes, session tokens and the signing key
- **Test data leakage** — ensuring no real PII enters the repository

If you identify an issue in any of these areas, please report it using the channels above.
