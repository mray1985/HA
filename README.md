# HATax

Private, browser-based tax preparation powered by an open-source tax engine.

## What is HATax?

HATax is a free, open-source tax preparation app. The federal engine covers tax years 2024, 2025, and 2026. Your tax data never leaves your browser — all calculations happen client-side using the `@hatax/engine` library, encrypted at rest with AES-256-GCM.

**Two modes:**
- **Private Mode** (default) — fully offline, zero data leaves your device
- **BYOK Mode** (optional) — add your own Anthropic API key for AI chat, expense scanning, and document extraction. PII is stripped before anything is sent.

**Key features:**
- 90+ tax features covering ~85-90% of individual filers
- All 50 states + DC tax coverage
- Full Form 1040 with Schedules A-H, SE, D, and 30+ supplemental forms
- 41 IRS PDF templates + 43 state PDF templates with auto-populated field mapping
- Every computation traced to IRC, Treasury Regulations, or Revenue Procedures
- 5,071 tests across 99 test files (`npm test`)
- Offline-capable — installable on desktop and mobile

## Architecture

HATax ships as two apps built on one tax engine:

- **Individual app** (`apps/individual`) — the free household app described above. No AI beyond optional BYOK.
- **Preparer app** (`apps/preparer`) — the same wizard plus a preparer seat, client document intake, and the local AI stack (`local-ai`). Local models run on the preparer's machine and never ship in the individual app.

```
tax-project/
├── shared/            → @hatax/engine (open-source tax calculation library, used by both apps)
├── apps/individual/   → @hatax/individual — free household app (React 19 + Vite 6 + Tailwind CSS + Zustand 5)
├── apps/preparer/     → @hatax/preparer — preparer seat + document intake + local AI
├── apps/public/       → IRS/state form PDFs, OCR data and icons served by both apps
├── local-ai/          → @hatax/local-ai — preparer-only TaxFacts, tax tools, classifiers, Q4_K_M model runners
├── server/            → Express + better-sqlite3 + pdf-lib (BYOK proxy, preparer sign-in)
└── docs/              → Project documentation
```

**Tech stack:** TypeScript throughout. React 19 with Vite 6. Zustand 5 for state. Tailwind CSS with HA Tax service brand colors. Vitest for testing. pdf-lib for IRS form generation.

**Engine design:** Pure functions only — no side effects, no database access, no network calls. Given a `TaxReturn` input, the engine produces a deterministic `CalculationResult`. See [Design Principles](docs/DESIGN_PRINCIPLES.md).

## Quick Start

```bash
# Install dependencies (from repo root)
npm install

# Individual app only (Private Mode — no API key, no server required)
npm run dev:individual
# → http://127.0.0.1:5173

# Preparer app (needs the Express server for sign-in)
# npm run dev:server & npm run dev:preparer
# → http://127.0.0.1:5174/preparer

# Optional: server + both apps together
# npm run dev

# Engine + local-AI tests
npm test
```

## Tax Coverage

| Category | Coverage |
|----------|----------|
| Income types | W-2, 1099-INT/DIV/OID/R/MISC/NEC/B/G/SA/DA/Q/C, SSA-1099, K-1 (partnership/S-Corp/estate), Schedule C/E/F, W-2G, Form 6252 (installment sales), Form 4835 (farm rental) |
| Deductions | Standard, itemized (Schedule A), QBI (199A), SEHI (Form 7206), Schedule 1-A (OBBBA), IRA, HSA, Archer MSA (Form 8853), student loan, educator, home office, vehicle, prior-year NOL carryforward, current-year NOL (reported, not deducted on the same return), investment interest, sales tax SALT alternative, nonbusiness bad debt |
| Credits | CTC/ACTC/ODC, EITC, AOTC/LLC, dependent care, saver's, clean energy, EV, energy efficiency, FTC, PTC, adoption with a five-year carryforward, elderly/disabled, excess SS, EV refueling, scholarship (§25F), prior year AMT (Form 8801) |
| Capital gains | Schedule D, preferential rates (0/15/20%), 25% unrecaptured §1250, 28% collectibles and non-excluded §1202 gain, §1202 exclusion, §1231 five-year lookback, partial §121 home-sale exclusion, NIIT, $3k loss limit, carryforward |
| AMT | Full Form 6251 (Parts I-III) with preferential rates in the AMT, including the §1202 preference on 50% and 75% stock |
| Penalties | Form 5329 (IRA/HSA/Coverdell ESA excess contributions, early distributions), Form 4684 (casualties & thefts) |
| State taxes | All 50 states + DC (8 no-tax, 13 flat, 20 progressive, 10 custom including New Hampshire). Most custom state bracket tables are tax year 2025 only |
| Depreciation | Form 4562 with Section 179, bonus, MACRS GDS, and straight-line ADS, under half-year and mid-quarter conventions |

See [Scope Matrix](docs/SCOPE_MATRIX.md) for the complete feature list.

## Documentation

| Document | Description |
|----------|-------------|
| [Scope Matrix](docs/SCOPE_MATRIX.md) | Supported vs. unsupported features |
| [Design Principles](docs/DESIGN_PRINCIPLES.md) | Architecture philosophy and engine design |
| [Authorities](docs/AUTHORITIES.md) | Module-by-module legal authority reference |
| [Contributing](docs/CONTRIBUTING.md) | How to contribute ("no authority, no merge") |
| [Security](docs/SECURITY.md) | Security policy and vulnerability reporting |
| [Disclaimer](docs/DISCLAIMER.md) | Legal disclaimer — not tax advice |

## License

MIT. See [LICENSE](LICENSE).
