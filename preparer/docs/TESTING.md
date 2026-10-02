# HA Tax Preparer Testing Guide

How HA Tax Preparer is tested: running the suites, what each one covers, and how to add to them.

| Suite | Where | Files | Tests |
|-------|-------|-------|-------|
| Engine | `shared/__tests__/` | 125 | 5,396 |
| Client | `client/src/__tests__/` | 47 | 977 |
| Local AI | `local-ai/__tests__/` | 26 | 456 |
| Server | `server/__tests__/` | 2 | 12 |
| End-to-end | `client/e2e/` | 5 specs | Playwright |

---

## Quick Start

```bash
# The engine (fastest, most comprehensive)
cd shared && npx vitest run

# The client: cases, document intake, review, tools
cd client && npm test

# The local AI: document reading, tax tools, client replies
cd local-ai && npm test

# The server: sign-in and the model routes
cd server && npm test

# End-to-end (Playwright starts the dev server on port 5174)
cd client && npx playwright test --project=chromium

# One file
cd shared && npx vitest run __tests__/form8615.test.ts
```

---

## Test Architecture Overview

```
preparer/
├── shared/__tests__/        125 files — the engine: forms, schedules, credits, states, the Tax Table, fuzzing
├── client/src/__tests__/     47 files — cases, document intake, review, client replies, imports, tools
├── client/e2e/                5 specs — Playwright: cases, review, the local models, the stress run, the walkthrough
├── local-ai/__tests__/       26 files — readers, page evidence, tax tools, validation, client replies
├── local-ai/gauntlet/        the model gauntlet and the stress run's documents (run by hand, with the models)
└── server/__tests__/          2 files — sign-in and the model routes
```

**Runners:**
- **Vitest** — engine, client, local AI, server
- **Playwright** — end-to-end, in Chromium (the desktop app's browser engine)

---

## 1. Engine Tests (125 files, ~5,400 tests)

The core of the test suite. Validates every tax calculation module against IRS rules.

### 1.1 Unit Tests — Forms & Schedules (28 files)

Each IRS form/schedule has a dedicated test file with hand-calculated expected values.

```bash
cd shared && npx vitest run __tests__/form1040.test.ts
cd shared && npx vitest run __tests__/scheduleC.test.ts
cd shared && npx vitest run __tests__/amt.test.ts
```

| File | Tests | Coverage |
|------|-------|----------|
| `form1040.test.ts` | ~23 | Main 1040: income, deductions, AGI, tax, refund/owed |
| `scheduleA.test.ts` | ~25 | Itemized deductions, SALT cap, medical 7.5% AGI floor |
| `scheduleC.test.ts` | ~38 | Business income, expenses, home office, vehicle |
| `scheduleSE.test.ts` | ~8 | Self-employment tax, wage base, Additional Medicare |
| `amt.test.ts` | ~76 | Alternative Minimum Tax (Form 6251) |
| `credits.test.ts` | ~18 | CTC, AOTC, Saver's Credit, energy credits |
| `eitc.test.ts` | ~15 | Earned Income Tax Credit, phase-outs |
| `qbi.test.ts` | ~28 | Qualified Business Income deduction (Section 199A) |
| `form4562.test.ts` | ~42 | Depreciation, Section 179, MACRS |
| `form8283.test.ts` | ~32 | Non-cash charitable contributions |
| `form8582.test.ts` | ~58 | Passive activity loss limitations |
| `homeOffice.test.ts` | ~32 | Simplified ($5/sqft) and actual method |
| `vehicle.test.ts` | ~32 | Standard mileage vs. actual expenses |
| `solo401k.test.ts` | ~27 | Solo 401(k) contribution limits |
| `foreignTaxCredit.test.ts` | ~21 | Foreign tax credit (Form 1116) |
| `donationValuation.test.ts` | ~42 | FMV lookup, depreciation calculator |
| `estimatedTax.test.ts` | ~6 | Quarterly voucher calculations |
| `estimatedTaxPenalty.test.ts` | ~25 | Underpayment penalty, safe harbor |
| `military.test.ts` | ~18 | Combat zone exclusion, moving expenses |
| `k1-box13-15.test.ts` | ~48 | K-1 pass-through income routing |

### 1.2 State Tax Tests (5 files)

```bash
cd shared && npx vitest run __tests__/state-tax.test.ts
cd shared && npx vitest run __tests__/ca.test.ts
cd shared && npx vitest run __tests__/smoke-states.test.ts
```

| File | Tests | Coverage |
|------|-------|----------|
| `state-tax.test.ts` | ~138 | All 50 states: no-tax, flat, progressive, custom |
| `state-tax-progressive.test.ts` | ~68 | Progressive state bracket calculations |
| `state-allocation.test.ts` | ~56 | Multi-state: part-year, nonresident, credit for taxes paid |
| `ca.test.ts` | ~175 | California Form 540: 10+ brackets, SDI, Mental Health surcharge |
| `smoke-states.test.ts` | ~27 | Quick validation for all 50 states + DC |

### 1.3 Integration Tests (6 files)

Test interactions between modules that unit tests miss.

```bash
cd shared && npx vitest run __tests__/integration.test.ts
cd shared && npx vitest run __tests__/scenarios.test.ts
```

| File | Tests | Coverage |
|------|-------|----------|
| `integration.test.ts` | 95 | 15 realistic scenarios: AMT+NIIT, Schedule C+QBI, K-1, kiddie tax, HSA, Roth conversion |
| `scenarios.test.ts` | ~40 | Hand-calculated line-by-line IRS Pub 17 scenarios |
| `realworld-scenarios.test.ts` | ~48 | Real-world user situations |
| `cross-module.test.ts` | ~48 | Cross-module dependency validation |
| `e2e-integration.test.ts` | ~52 | Full pipeline: input → engine → output |

### 1.4 Boundary & Edge Case Tests (4 files)

```bash
cd shared && npx vitest run __tests__/boundary-values.test.ts
cd shared && npx vitest run __tests__/stress-scenarios.test.ts
```

| File | Tests | Coverage |
|------|-------|----------|
| `boundary-values.test.ts` | ~68 | Every bracket edge ±$1, standard deduction floor, SE threshold, phase-outs |
| `stress-scenarios.test.ts` | ~178 | 13 stress scenarios: AMT, depreciation, multi-state, Section 179, state EITC |
| `adversarial-phase3.test.ts` | ~48 | Multi-model AI red-team: ordering hazards, circular dependencies |
| `adversarial-scenarios.test.ts` | ~90 | Edge-case combinations designed to break the engine |

### 1.5 Cross-Validation Tests (4 files)

Independent verification that the engine computes correct results.

#### IRS Tax Table Oracle (588 tests)

```bash
cd shared && npx vitest run __tests__/irs-tax-table.test.ts
```

An independent tax calculator (NOT imported from the engine): below $100,000 of taxable income, the IRS's printed 2025 Tax Table (`__tests__/fixtures/irs-tax-table-2025.json`, from Publication 1040 (2025)); from $100,000, hard-coded brackets. Feeds W-2 returns through both and checks every field matches. `tax-table-2025.test.ts` checks the engine against all 8,248 values of the table, the $100,000 cutover, and the Qualified Dividends and Capital Gain Tax Worksheet lines 22 and 24.

| Section | Tests | What |
|---------|-------|------|
| A. Zero income | 5 | $0 wages → $0 tax, all 5 statuses |
| B. Bracket boundaries | 90 | Every bracket edge ±$1, all 5 statuses |
| C. Round-number incomes | 45 | $25k–$500k × 5 statuses |
| D. Bracket midpoints | 35 | Middle of each bracket × 5 statuses |
| E. Mathematical invariants | 354 | Identity, monotonicity, continuity, MFJ/QSS parity, filing status ordering, effective rate bounds, piecewise linearity |
| F. Extreme income levels | 59 | $1 to $10M, sanity checks at extremes |

**Invariants tested (Section E):**
1. `taxableIncome === agi - deductionAmount`
2. `totalTax >= 0`, `taxableIncome >= 0`
3. `refundAmount > 0` XOR `amountOwed > 0` (or both zero)
4. Adding $1 of income never decreases tax
5. Adding $1 changes tax by at most $0.37 (top rate)
6. MFJ and QSS produce identical results
7. MFS matches Single brackets (except 35% cap divergence)
8. `tax(MFJ) <= tax(Single)` and `tax(HOH) <= tax(Single)`
9. `0 <= effectiveTaxRate <= marginalTaxRate <= 0.37`
10. Tax is linear within any single bracket

#### IRS Constants Validation (62 tests)

```bash
cd shared && npx vitest run __tests__/rev-proc-2024-40.test.ts
```

Validates 700+ tax constants against Rev. Proc. 2024-40: brackets, standard deductions, AMT exemptions, EITC tables, NIIT thresholds, CTC, SALT cap, QBI, SE tax, IRA phase-outs, education credits, HSA limits, Section 179.

### 1.6 Advanced Testing Methodologies (5 files)

```bash
cd shared && npx vitest run __tests__/phase9-metamorphic.test.ts
cd shared && npx vitest run __tests__/phase9-properties.test.ts
cd shared && npx vitest run __tests__/mutation-testing.test.ts
```

| File | Tests | Methodology |
|------|-------|-------------|
| `phase9-metamorphic.test.ts` | ~35 | **Metamorphic relations** — transforms inputs and validates structural invariants between outputs (no oracle needed) |
| `phase9-properties.test.ts` | ~42 | **Property-based testing** — fast-check PRNG with automatic shrinking |
| `phase9-differential.test.ts` | ~28 | **Differential testing** — compares multiple calculation paths |
| `mutation-testing.test.ts` | ~88 | **Mutation testing** — mutates engine code, verifies tests detect the mutation |
| `fuzzing.test.ts` | 111 | **Fuzz testing** — probes every module with boundary values, extreme inputs, negative numbers, pathological combinations |

### 1.7 Smoke Tests (3 files)

Fast validation across the entire engine surface area.

```bash
cd shared && npx vitest run __tests__/smoke-states.test.ts
cd shared && npx vitest run __tests__/smoke-filingStatus-incomeType.test.ts
cd shared && npx vitest run __tests__/smoke-credits.test.ts
```

| File | Tests | Coverage |
|------|-------|----------|
| `smoke-states.test.ts` | ~27 | All 50 states + DC in a single pass |
| `smoke-filingStatus-incomeType.test.ts` | ~38 | Every filing status × income type combination |
| `smoke-credits.test.ts` | ~58 | All credits: CTC, AOTC, EITC, Saver's, energy, etc. |

---

## 2. Client Tests (47 files, ~980 tests)

```bash
cd client && npm test
```

### 2.1 Cases and review

| Files | Coverage |
|-------|----------|
| `caseReview`, `reviewFlow`, `stateAnswer` | The review list: findings, return fields filled in place, decisions, approval |
| `caseStore`, `caseRecords`, `sessionKey`, `backgroundWork` | The open case, encrypted records, the vault's session key, locks waiting for work |
| `batchIntake`, `caseIdentity`, `spouseCases`, `caseRollover` | Placing documents on cases, the taxpayer from the documents, joint returns, last year's case |
| `documentIngestion`, `documentFiles`, `returnApplier`, `recordTools`, `preparerDecisions` | Reading documents into facts, kept source files, applying forms to the return, preparer decisions |
| `clientReplies`, `missingDocuments`, `reviewPackage`, `acquisitionDate` | Client replies, possibly missing documents, the review package |

### 2.2 Import and parsing

| Files | Coverage |
|-------|----------|
| `pdfImporter`, `pdfExtractHelpers`, `ocrService`, `pdfStandardFonts` | Reading PDFs and scans: text layer, OCR, field detection, pdf.js fonts |
| `competitorReturnParser`, `priorYearImporter`, `priorYearTemplateBuilder` | Prior-year returns from other software and from HA Tax exports |
| `txfParser`, `fdxParser`, `csvParser`, `pdfStatementParser`, `transactionParser`, `transactionParserDedup`, `duplicateDetection` | TXF, FDX, CSV and statement imports, duplicates |
| `w2LocalBoxes`, `w2Identity`, `jaroWinkler` | W-2 local boxes and identity, name matching |

### 2.3 Tools

| Files | Coverage |
|-------|----------|
| `deductionFinderEngine`, `deductionFinderContext`, `deductionFinderRecurrence`, `mccTaxMap` | The expense scanner's deduction finder |
| `auditRiskService`, `taxCalendarService`, `scenarioLab`, `sensitivityAnalysis`, `explainCharts` | Audit risk, the tax calendar, Scenario Lab, the Explain tab's charts |
| `fuzzerCalcValidation` | Randomized returns (50 by default, `FUZZER_COUNT`) from 13 archetypes through the engine: no crash, NaN or impossible values |

---

## 3. Local AI Tests (26 files, ~460 tests)

```bash
cd local-ai && npm test
```

| Area | Files |
|------|-------|
| Reading documents | `documentReader`, `secondReading`, `pageEvidence`, `formEvidence`, `documentOcr`, `documentClassifier`, `structuredExtraction`, `identity` |
| Tax tools and facts | `taxTools`, `toolDefinitions`, `toolCaller`, `groundedToolCall`, `taxFact`, `formSchemas`, `section16Forms`, `w2Corrections`, `recordTools`, `preparerChoices` |
| Validation | `factValidation`, `formValidation` |
| Client replies | `clientAnswers`, `clientNotes`, `missingDocuments` |
| Models and intake | `modelRuntime`, `modelManifest`, `documentIngestion` |

The model gauntlet (`local-ai/gauntlet/`) reads synthetic IRS forms with the real models and is run by hand; see its README.

---

## 4. End-to-End Tests (Playwright)

```bash
cd client && npx playwright test --project=chromium
```

| Spec | Coverage |
|------|----------|
| `case-flow.spec.ts` | A new case, the dashboard, the Explain and Return tabs, a 1099-Q decision, a W-2c, the Client tab, possibly missing documents |
| `review-flow.spec.ts` | A W-2 dropped on the Review tab, the next case, a review item's document, a returning client, several clients' documents at once, a new season |
| `local-models.spec.ts` | Opt-in (`E2E_MODELS=1`): a W-2 read by the local models, client replies read by the local reader |
| `stress-ai.spec.ts` | Opt-in (`E2E_MODELS=1`, `STRESS_DIR`): seven households and 23 documents; see `local-ai/gauntlet/stress/README.md` |
| `walkthrough-ai.spec.ts` | Opt-in (`E2E_MODELS=1`): a preparer from sign-up to an approved case, with screenshots |

---

## 5. Server Tests (2 files)

```bash
cd server && npm test
```

| File | Coverage |
|------|----------|
| `auth.test.ts` | Registration, sign-in, the season seat, sessions and sign-out, the signing key |
| `models.test.ts` | The local model routes: signed-in preparers only, the runtime, page reading, reading text |

---

## Testing Methodologies

### Fuzz Testing

| Layer | File | Approach |
|-------|------|----------|
| Engine | `shared/__tests__/fuzzing.test.ts` | Boundary values, extreme inputs, negative numbers, pathological combinations |
| Client | `client/src/__tests__/fuzzerCalcValidation.test.ts` | Randomized returns from 13 archetypes |
| The app, with the models | `client/e2e/stress-ai.spec.ts` | Synthetic households' documents through intake, replies and review, scored against `truth.json` |

### Cross-Validation

| Source | File | Method |
|--------|------|--------|
| The IRS Tax Table | `tax-table-2025.test.ts` | All 8,248 values of the 2025 Tax Table (Publication 1040) |
| Independent oracle | `irs-tax-table.test.ts` | The Tax Table below $100,000, the rate schedules above |
| IRS constants | `rev-proc-2024-40.test.ts` | 700+ constants from Rev. Proc. 2024-40 |

### Adversarial Testing

Scenarios designed to break the engine through:
- Multi-provision interactions
- Ordering hazards
- Circular dependencies
- Phase-out cliff effects

### Property-Based & Metamorphic

- **Property-based:** fast-check PRNG with automatic shrinking finds minimal failing inputs
- **Metamorphic:** validates structural relationships between outputs without needing an oracle (e.g., doubling income should roughly double tax in a flat bracket)

---

## How to Add Tests

### Adding a new engine unit test

Follow the pattern in existing tests:

```typescript
import { describe, it, expect } from 'vitest';
import { calculateForm1040 } from '../src/engine/form1040.js';
import { TaxReturn, FilingStatus } from '../src/types/index.js';

function makeTaxReturn(overrides: Partial<TaxReturn> = {}): TaxReturn {
  return {
    id: 'test', taxYear: 2025, status: 'in_progress',
    currentStep: 0, currentSection: 'review',
    dependents: [], w2Income: [], income1099NEC: [], income1099K: [],
    income1099INT: [], income1099DIV: [], income1099R: [], income1099G: [],
    income1099MISC: [], income1099B: [], income1099DA: [], income1099C: [],
    income1099Q: [], incomeK1: [], income1099SA: [], incomeW2G: [],
    rentalProperties: [], otherIncome: 0, businesses: [],
    deductionMethod: 'standard', expenses: [], educationCredits: [],
    incomeDiscovery: {}, createdAt: '', updatedAt: '',
    ...overrides,
  };
}

describe('My New Test', () => {
  it('computes correct tax for ...', () => {
    const result = calculateForm1040(makeTaxReturn({
      filingStatus: FilingStatus.Single,
      w2Income: [{ id: 'w1', employerName: 'Test', wages: 50000,
        federalTaxWithheld: 5000, socialSecurityWages: 50000,
        socialSecurityTax: 3100, medicareWages: 50000, medicareTax: 725 }],
    }));
    expect(result.form1040.agi).toBe(50000);
  });
});
```

### Adding a household to the stress run

Add its documents and true values to `local-ai/gauntlet/stress/make-docs.mjs`, regenerate `docs/` and `truth.json` with `node make-docs.mjs`, and run the stress spec with the models.

---

## CI / Local Workflow

```bash
# Full local validation (recommended before pushing)
cd shared && npm test       # engine
cd client && npm test       # client
cd local-ai && npm test     # local AI (type-checks its tests first)
cd server && npm test       # server

# End-to-end (needs Playwright's Chromium)
cd client && npx playwright test --project=chromium
```

CI (`.github/workflows/ci.yml`) runs the engine, local-AI and server tests, the type checks, the end-to-end tests and the production build, and bundles the desktop app's main process. The client's unit tests run locally.

---

## Key Test File Locations

| What | Path |
|------|------|
| The IRS's 2025 Tax Table | `shared/__tests__/fixtures/irs-tax-table-2025.json`, `shared/__tests__/tax-table-2025.test.ts` |
| IRS constants validation | `shared/__tests__/rev-proc-2024-40.test.ts` |
| Integration scenarios | `shared/__tests__/integration.test.ts` |
| Boundary values | `shared/__tests__/boundary-values.test.ts` |
| Fuzz testing | `shared/__tests__/fuzzing.test.ts` |
| Client fuzzer archetypes | `client/src/__tests__/scenarioFixtures/` |
| End-to-end cases and review | `client/e2e/case-flow.spec.ts`, `client/e2e/review-flow.spec.ts` |
| The stress run | `client/e2e/stress-ai.spec.ts`, `local-ai/gauntlet/stress/` |
| Playwright config | `client/playwright.config.ts` |
