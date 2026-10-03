# HA Tax Preparer

Automated tax preparation for professional preparers, built on its own copy of
the HA Tax engine and running entirely on the preparer's machine.

## What it does

The preparer drops in a client's documents; the app does the data work and
routes only judgment to the preparer (work order: `# HA Tax Preparers App`):

- **Cases, not forms.** The dashboard shows every case by status — waiting for
  documents, needs attention, needs review, ready to approve, approved — most
  urgent first, and "Next case" (on every case) goes to the next one that
  needs the preparer.
- **Documents for any client.** Documents dropped on the dashboard are read,
  then each goes to the case of the person it names: a confirmed SSN (the
  taxpayer's or the spouse's), or a confirmed last four digits with the last
  name, on exactly one case of that year. People no case has get a new case,
  one per household (the same confirmed address). A document that names no
  one with confidence — a 1098-T or 1099-Q, whose person may be a dependent —
  waits on the dashboard for the preparer to place it. A batch keeps reading
  while the preparer works in a case, and says when it is done. On a case,
  files can be dropped on any tab.
- **Documents in, return out.** Each file is hashed and kept with its source,
  then read on this machine by the local models: Qwen3.5-0.8B identifies the
  form and fills its template, the page itself confirms each value (text layer
  or OCR) and reads the checkboxes, and GLM-OCR re-reads only what the page
  could not confirm. Values become TaxFacts through schema-validated tax tools
  and are applied to the return. Readers that disagree, or a printed value no
  reader read, hold the form for the preparer; a value that cannot be read
  stays unknown — never zero. Without the models (a web deployment) documents
  are read from the PDF text layer and with OCR.
- **The taxpayer from the documents.** The person each form is about (the
  W-2 employee, a 1099 recipient, the 1098 borrower) is read with the same
  two-reader check as the amounts. The return's empty SSN, name and address
  are filled from confirmed readings only — never over what the preparer
  entered. Two people with SSNs and no taxpayer yet, a document for someone
  who is not on the return, a different last name for the same SSN,
  differing addresses, and readings no second reader confirmed are review
  items with a one-click answer.
- **Last year's case starts this year's.** A returning client's next year
  starts from last year's case: identity and address carried; the filing
  status, dependents (who wait for this year's months at home), residency and
  refund account to confirm; carryovers carried only from an approved case
  and only where the engine gives next year's amount (capital loss, Form 2210
  prior-year tax, IRA basis, clean energy credit); the rest listed with last
  year's figures.
- **Missing documents.** Last year's documents — from last year's case for
  the same client (same SSN, or name and date of birth), or from an imported
  prior-year return — are compared with this year's by form and payer (EIN, or
  the payer's name without legal suffixes: "Chase" is "JPMORGAN CHASE BANK
  NA"). Each one not received is shown as *possibly* missing ("Possible
  missing 1099-INT from Chase"), raised in the assistant, and asked about in the
  message for the client; the client's "no" settles it, and their "yes" waits
  for the upload.
- **The assistant.** One conversation per case, on the Assistant tab, that
  replaces the review checklist and the client questions. Every open item is a
  turn saying what is wrong in plain words — the form's own box names, never the
  engine's field names — what is needed, and up to three ways to give it: a chip
  to click, a field form, or a type into the box at the bottom. What the
  preparer types is written straight onto the case: a number goes into the box
  that is waiting for one, a filing status onto the return, "all year" onto a
  dependent. Nothing is asked twice, and nothing is asked that the documents on
  the case already settle. What is blocking the return sorts to the top, then
  what only the client can answer, then what to check.
  - **What is on a form is never asked for.** A name, SSN or address that a
    document already carries is offered as the value on that document, one click
    to accept, and the same value is never asked for twice — including when the
    reading needs a second reader to agree, where the turn says so instead of
    asking the preparer to retype what they can see.
  - **While documents are being read, nothing is missing.** The assistant says
    what it is reading and asks nothing, so it cannot ask for a value the
    document it is halfway through is about to supply. A case with nothing read on
    it asks for the documents rather than reporting every field the return needs.
- **Client questions and replies.** The assistant asks only what the case's
  documents do not settle — a dependent's months at home or relationship, where
  the client lived, the qualified expenses a 1099-Q paid, the filing status — and
  gives them as a message to send. The client's reply is read on this machine by
  Qwen3.5-0.8B, one question at a time under a grammar, and an answer is
  recorded (as a verified client-response fact) only when the model and a reading
  of the client's own words agree; everything else stays open with the reason. A
  stated filing status waits for the preparer. New facts a reply or note states —
  a new dependent, a move, an estimated payment — are offered with only the
  values the client's words give, and are added when the preparer accepts them.
  The reply is kept word for word in the audit trail.
- **What still decides.** Every deterministic check of the return (the
  diagnostics engine in `shared/src/diagnostics`) and every piece of document
  evidence that needs a person — held forms, unread documents, credit choices —
  is what the assistant is built from; the thread is projected from those items
  on every render, so it can never disagree with them. A missing name, SSN,
  address or filing status is typed or entered in the turn (or all at once); a
  turn opens its own document. Errors and blockers clear only by fixing the
  return or the documents; warnings can be decided with a note, or with one click
  ("Checked against the document", "Confirmed with the client"). Every value
  written and every decision is in the case's audit trail.
- **Approve.** Approval is refused while anything is open and is withdrawn by
  any later change to the return. The approved return produces the federal
  filing packet and state forms.
- **Local only.** No cloud model: the models run on the preparer's CPU, one
  at a time, through llama.cpp (`local-ai/src/modelRuntime.ts`), from files
  pinned by SHA-256 and bundled by the installer. All case data is encrypted at
  rest with AES-256-GCM.

### How the assistant decides where a typed answer goes

The preparer types into one box. Each message is scored against the open turns
(`client/src/services/assistantAnswers.ts`) and goes to the one it fits best —
by the box it names, the kind of value it is, and how much that turn unblocks.
The reading itself is deterministic: amounts, counts, yes/no, filing statuses,
relationships, residency and states are read from the words, with no model in
the loop. That is the same rule the client's replies already follow — a value
goes onto a return only when the words say so. When the words settle nothing,
the message is offered to the client's-reply pipeline for the open questions and
for any new fact it states. When even that cannot run, the assistant says plainly
that it did not understand and nothing is written.

## Architecture

```
preparer/
├── shared/    → @hatax/engine — tax engine, form mappings, return diagnostics
├── local-ai/  → @hatax/local-ai — TaxFacts, tax tools, document reading, two-reader verification, model gauntlet
├── client/    → @hatax/preparer — case dashboard and the assistant (React 19 + Vite 6 + Tailwind + Zustand 5)
├── server/    → Express + better-sqlite3 — sign-in, seat, local model routes (port 3002)
├── desktop/   → Electron app and Windows installer (bundles the site, llama.cpp and the models)
├── tools/     → llama.cpp CPU runtime, b11262 (not committed)
└── models/    → approved model files, as <repo>/<file> (not committed)
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
E2E_MODELS=1 npx playwright test e2e/local-models.spec.ts --project=chromium   # with the models
```

### Desktop app

The approved model files (`local-ai/src/modelManifest.ts`) go under `models/`
as `<repo>/<file>`, and llama.cpp b11262 (win-cpu-x64) under
`tools/llama-cpp/bin`. Building the native modules for Electron needs Visual
Studio Build Tools and Python.

```bash
npm run build -w client
cd desktop && npm install
npm start          # run from the repository
npm run pack       # release/win-unpacked
npm run dist       # release/HA-Tax-Preparer-Setup-<version>.exe
# The desktop app end to end (unpackaged, or DESKTOP_EXE=<packaged exe>):
cd ../client && npx playwright test -c playwright.desktop.config.ts
```

A build for testers, before the legal pages are confirmed:

```bash
npm run build:test -w client   # labeled "Test build" in the window title and on every screen
cd desktop && npm run dist:test   # release/HA-Tax-Preparer-Test-Setup-<version>.exe
```

`npm run dist` refuses a test build of the client, and `npm run dist:test` a
release build, so a test build is never released by mistake.

The program and installer icon is `desktop/build/icon.ico`, made from
`client/public/icons/icon-512.png` by `npm run icon`.

#### The Syncfusion license key

The PDF viewer, the PDF text reader and the charts are Syncfusion Essential JS 2
components. Without a license key every page using them shows Syncfusion's
license banner. Get a key for version 32 (the version in `client/package.json`)
at https://www.syncfusion.com/account/claim-license-key and, on the build
machine, put it in `client/.env.local` (never committed):

```
VITE_SYNCFUSION_LICENSE_KEY=<the key>
```

or set `VITE_SYNCFUSION_LICENSE_KEY` in the build environment (a CI secret).
The client build records whether it had the key in `client/dist/build-info.json`
(never the key itself); `npm run dist` refuses to package a client built
without it, and `npm run pack` warns. A new Syncfusion major version needs a
new key.

#### Signing the installer

An unsigned installer shows Windows SmartScreen's "Unknown publisher" warning,
and Windows 11 Smart App Control can block unsigned programs outright. The
build signs the program, the installer and uninstaller, `llama-server` and
every DLL and native module it ships (Microsoft's own DLLs keep their
signature) when the build machine has a code-signing certificate. Nothing about
the certificate is committed; set one of these before `npm run dist`:

| Certificate | Environment |
|---|---|
| `.pfx` file | `WIN_CSC_LINK` (path, https URL or base64), `WIN_CSC_KEY_PASSWORD` |
| Windows certificate store or USB token (every OV/EV certificate issued since June 2023) | `HATAX_SIGN_CERT_SHA1` (thumbprint) or `HATAX_SIGN_CERT_SUBJECT` |
| Azure Trusted Signing | `HATAX_AZURE_SIGN_ENDPOINT`, `HATAX_AZURE_SIGN_ACCOUNT`, `HATAX_AZURE_SIGN_PROFILE`, `HATAX_SIGN_PUBLISHER`, and `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |

Set `HATAX_REQUIRE_SIGNING=1` for release builds: the build then fails instead
of producing an unsigned installer. Signatures are SHA-256 and timestamped, so
they stay valid after the certificate expires. A signed installer names the
publisher and passes Smart App Control. SmartScreen's warning goes away once
the certificate has download reputation. Since 2024 an EV certificate no longer
skips that step.

Check a build with PowerShell:
`Get-AuthenticodeSignature release\*.exe, release\win-unpacked\*.exe`.

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
