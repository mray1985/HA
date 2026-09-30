# HATax Preparer

Automated tax preparation for professional preparers, built on its own copy of
the HATax engine and running entirely on the preparer's machine.

## What it does

The preparer drops in a client's documents; the app does the data work and
routes only judgment to the preparer (work order: `# HA Tax Preparers App`):

- **Cases, not forms.** The dashboard shows every case by status — waiting for
  documents, needs attention, needs review, ready to approve, approved.
- **Documents in, return out.** Each file is hashed and kept with its source,
  identified, read on this machine (PDF text layer, or OCR for scans and
  photos), turned into TaxFacts through schema-validated tax tools, and applied
  to the return. A value that cannot be read stays unknown — never zero.
- **Review.** Every deterministic check of the return (the diagnostics engine
  in `shared/src/diagnostics`) and every piece of document evidence that needs
  a person — held forms, unread documents, credit choices — in one checklist.
  Errors and blockers clear only by fixing the return; warnings can be decided
  with a note. Every correction and decision is in the case's audit trail.
- **Approve.** Approval is refused while anything is open and is withdrawn by
  any later change to the return. The approved return produces the federal
  filing packet and state forms.
- **Local only.** No cloud model: local models run on the preparer's CPU
  (`local-ai`), and all case data is encrypted at rest with AES-256-GCM.

## Architecture

```
preparer/
├── shared/    → @hatax/engine — tax engine, form mappings, return diagnostics
├── local-ai/  → @hatax/local-ai — TaxFacts, tax tools, document reading, two-reader verification, model gauntlet
├── client/    → @hatax/preparer — case dashboard and case review (React 19 + Vite 6 + Tailwind + Zustand 5)
├── server/    → Express + better-sqlite3 — preparer sign-in and seat (port 3002)
├── tools/     → llama.cpp CPU runtime (not committed)
└── models/    → local model weights (not committed)
```

**Tech stack:** TypeScript throughout. React 19 with Vite 6. Zustand 5 for state. Tailwind CSS. Vitest and Playwright for testing. pdf-lib for IRS and state form generation. llama.cpp (CPU) for local models.

**Engine design:** Pure functions only — no side effects, no database access, no network calls. Given a `TaxReturn` input, the engine produces a deterministic `CalculationResult`. See [Design Principles](docs/DESIGN_PRINCIPLES.md).

## Quick Start

```bash
npm install        # from this folder (preparer/)
npm run dev        # server on 3002, client on http://127.0.0.1:5174/preparer
npm test           # engine, local-AI and server tests
npm run build      # production client build

# Client unit tests and end-to-end tests
cd client && npx vitest run src/__tests__ && npx playwright test --project=chromium
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
