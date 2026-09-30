# Contributing to HATax

Thank you for your interest in contributing to HATax. This guide explains how to add features, write tests, and maintain the authority-backed standards that make this engine trustworthy.

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free experience for everyone. Be respectful, assume good intent, give and receive constructive feedback gracefully, and focus on what is best for the project. Unacceptable behavior can be reported to the maintainers and will be addressed promptly.

## No Authority, No Merge

Every tax computation in HATax must trace to a primary legal authority. If a calculation cannot cite an IRC section, Treasury Regulation, Revenue Procedure, or IRS Form/Worksheet, it will not be merged. This is the project's core integrity rule.

Acceptable authority sources:

- **IRC** -- Internal Revenue Code sections (e.g., IRC Section 63)
- **Treas. Reg.** -- Treasury Regulations (e.g., Treas. Reg. 1.63-1)
- **Rev. Proc.** -- Revenue Procedures (e.g., Rev. Proc. 2024-40)
- **IRS Forms/Worksheets** -- Published IRS forms and their instructions (e.g., Form 1040 Line 15, Qualified Dividends and Capital Gain Tax Worksheet)

## Project Structure

HATax is a monorepo with two apps on one engine:

```
tax-project/
├── shared/            @hatax/engine — tax calculation engine (pure functions)
├── apps/individual/   Free household app — React + Vite wizard (BYOK is the only AI)
├── apps/preparer/     Preparer app — same wizard + preparer seat + local AI intake
├── apps/public/       Static assets (IRS/state PDFs, OCR data, icons) served by both apps
├── local-ai/          @hatax/local-ai — preparer-only TaxFacts, tax tools, local model runners
└── server/            Express backend (optional AI features: chat, OCR, expense scanning; preparer sign-in)
```

- **`shared/`** is the core — all tax math lives here. No I/O, no side effects, no dependencies on the apps or server.
- **`apps/individual/`** is the free UI — wizard steps, form filling, PDF export, BYOK AI chat, tools.
- **`apps/preparer/`** is the individual UI plus preparer pages and document intake. It is the only app that may import `@hatax/local-ai`.
- **`local-ai/`** holds the work-order AI stack. `@hatax/local-ai` is browser-safe; `@hatax/local-ai/node` spawns local models and must never be imported from a Vite bundle.
- **`server/`** is optional — provides BYOK API proxying for AI features. The individual app works fully offline without it.

## Development Setup

### Prerequisites

- Node.js 20+ (LTS)
- npm 10+

### Installation

```bash
git clone <repo-url>
cd tax-project
npm install          # installs all three packages via workspaces
```

### Environment Variables

```bash
# Copy the example env files
cp apps/individual/.env.example apps/individual/.env
cp apps/preparer/.env.example apps/preparer/.env
cp server/.env.example server/.env
```

The client requires a **Syncfusion Community License key** in `apps/individual/.env` and `apps/preparer/.env` for the PDF viewer and charts. Syncfusion Community License is free for individuals and companies with less than $1M revenue. Get your key at [syncfusion.com](https://www.syncfusion.com/products/communitylicense).

### Running the App

```bash
# Start the client dev server
cd apps/individual && npm run dev

# Start the server (optional, only needed for AI features)
cd server && npm run dev
```

### Running Tests

```bash
# Shared engine tests (fastest, most comprehensive — 5,000+ tests)
cd shared && npx vitest run

# Client unit/service tests (~1,000+ tests)
cd apps/individual && npx vitest run

# Server tests
cd server && npx vitest run

# E2E tests (requires browser binaries)
cd apps/individual && npx playwright test

# Watch mode (re-runs on file changes)
cd shared && npx vitest
```

See [`TESTING.md`](./TESTING.md) for the full testing guide.

## How to Add a New Tax Feature

### 1. Include `@authority` Tags in JSDoc

Every exported function must document its legal basis:

```typescript
/**
 * Calculates the standard deduction for the given filing status.
 *
 * @authority IRC Section 63(c)
 * @authority Rev. Proc. 2024-40 Section 3.01
 * @param filingStatus - The taxpayer's filing status
 * @param taxYear - The tax year for computation
 * @returns The standard deduction amount in dollars
 */
export function computeStandardDeduction(
  filingStatus: FilingStatus,
  taxYear: number
): number { ... }
```

### 2. Add a YAML Authority File

Create a corresponding authority file in `shared/authorities/` that documents the legal chain for your feature:

```yaml
id: standard-deduction
title: Standard Deduction
authorities:
  - type: IRC
    section: "63(c)"
    description: Defines the standard deduction
  - type: RevProc
    citation: "Rev. Proc. 2024-40, Section 3.01"
    description: Inflation-adjusted amounts for 2025
```

### 3. Include Tests with IRS Form/Worksheet References

Every test must reference the IRS form, line, or worksheet it validates against:

```typescript
describe('Standard Deduction', () => {
  // Form 1040, Line 12a
  it('returns $15,750 for Single filer in 2025', () => {
    expect(computeStandardDeduction('single', 2025)).toBe(15750);
  });
});
```

### 4. Use TypeScript Strict Mode

All code must compile under TypeScript strict mode (`"strict": true` in `tsconfig.json`). No `any` types. No type assertions unless absolutely necessary and documented.

### 5. Pure Functions Only (Engine)

Tax computation functions in `shared/` must be pure:

- **No side effects** -- no logging, no console output, no mutation of external state
- **No database access** -- the engine has no concept of persistence
- **No network calls** -- no HTTP requests, no API calls
- **No filesystem access** -- no reading or writing files at runtime
- **Deterministic** -- same inputs always produce the same outputs

### 6. Handle All Five Filing Statuses

Every feature that varies by filing status must handle all five:

1. Single
2. Married Filing Jointly
3. Married Filing Separately
4. Head of Household
5. Qualifying Surviving Spouse

Missing a filing status is a test failure.

## Adding Wizard Steps (Client)

All wizard step components live in `apps/individual/src/components/steps/`, with a copy in `apps/preparer/src/components/steps/` — a wizard change must land in both apps. Follow the **[Step Style Guide](./STEP_STYLE_GUIDE.md)** for required elements and ordering. Every data entry step must include:

1. `<StepWarningsBanner stepId="..." />` — first element
2. `<SectionIntro />` — icon + title + description
3. `<CalloutCard />` — at least one
4. Form content
5. `<StepNavigation />` — last element

See the [UI Color Reference](./STEP_STYLE_GUIDE.md#ui-color-reference) for color conventions.

## Test Requirements

### Behavioral Tests

Each feature needs behavioral tests that verify correct output for representative inputs across all filing statuses.

### IRS Worksheet Traces

Where an IRS worksheet exists for the computation, include a test that walks through the worksheet line by line, asserting intermediate values. This makes auditing easy and catches regressions at the step level.

## How to Update Constants for a New Tax Year

When the IRS publishes a new Revenue Procedure with inflation-adjusted amounts (typically in the fall):

1. Create a new constants file: `shared/src/constants/tax20XX.ts` (e.g., `tax2026.ts`)
2. Copy the structure from the previous year's file
3. Update all values from the new Revenue Procedure
4. Add the `@authority` tag citing the specific Revenue Procedure
5. Add or update tests to cover the new year
6. Update the YAML authority file with the new citation

## Project Conventions

- All monetary values are stored as **dollars rounded to 2 decimal places** using the shared `round2()` utility
- Functions are organized by tax concept (deductions, credits, income, etc.)
- Each module exports pure functions and their associated types
- IRS link text must always be "Learn more on IRS.gov" with an `<ExternalLink />` icon
