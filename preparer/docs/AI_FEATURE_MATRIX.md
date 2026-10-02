# AI Feature Matrix

What HA Tax Preparer's local models do, what is deterministic, and what works without the models. **Every new feature that uses a model must be added to this matrix.**

## The models

| Model | Job | Runs |
|-------|-----|------|
| **Qwen3.5-0.8B** | Identifies each document's form and fills its template; reads client replies, one question at a time under a grammar | On the preparer's CPU, through llama.cpp |
| **GLM-OCR** | Second reader: re-reads only the values the page could not confirm | On the preparer's CPU, through llama.cpp |

The models run one at a time, from files pinned by SHA-256 in `local-ai/src/modelManifest.ts` and bundled by the installer. There is no cloud model: no document, reply or return leaves the computer.

## Feature Matrix

"Without the models" is a web deployment, or the desktop app before the model files are installed.

### Tax engine and review

| Feature | With the models | Without | Notes |
|---------|-----------------|---------|-------|
| Tax engine (federal and state) | Yes | Yes | Deterministic |
| Review checklist (diagnostics, held forms, decisions) | Yes | Yes | Deterministic; errors and blockers clear only by fixing the return |
| Approval gate and filing packet | Yes | Yes | Deterministic |
| Explain tab (flow, brackets, effective rate, trace) | Yes | Yes | Deterministic |
| Scenarios tab (what-if, sensitivity) | Yes | Yes | Full engine re-run |
| Audit risk, tax calendar (Approve tab) | Yes | Yes | Deterministic |

### Documents

| Feature | With the models | Without | Notes |
|---------|-----------------|---------|-------|
| PDF text layer | Yes | Yes | Read locally |
| OCR (scans, photos) | Yes | Yes | Tesseract.js, self-hosted, local |
| Form identification and template filling | Yes | No | Qwen3.5-0.8B |
| Page evidence (each value confirmed on the page, checkboxes) | Yes | No | Text layer or OCR against the model's reading |
| Second reading | Yes | No | GLM-OCR re-reads what the page could not confirm |
| Reading from the text layer and OCR alone | — | Yes | The form is held for the preparer where a value is not read |
| The taxpayer from the documents | Yes | Partial | The same two-reader check as the amounts |
| Placing documents on cases | Yes | Yes | Confirmed SSN, or last four digits with the last name |
| Prior-year returns (HA Tax and other software) | Yes | Yes | Deterministic import |
| CSV, TXF and FDX imports | Yes | Yes | Deterministic |

A value no reader can read stays unknown — never zero — and readers that disagree hold the form for the preparer.

### Clients

| Feature | With the models | Without | Notes |
|---------|-----------------|---------|-------|
| Client questions (Client tab) | Yes | Yes | Only what the documents do not settle |
| Possibly missing documents | Yes | Yes | Compared with last year's by form and payer |
| Reading a client's reply | Yes | No | Recorded only when the model and a reading of the client's own words agree |
| New facts a reply states (a dependent, a move, a payment) | Yes | No | Offered; added when the preparer accepts |
| The reply in the audit trail | Yes | Yes | Kept word for word |

### Expense scanner

| Feature | With the models | Without | Notes |
|---------|-----------------|---------|-------|
| Transaction categorization | Yes | Yes | Rules on the preparer's machine (`transactionCrossValidator`); no model |
| Deduction finder | Yes | Yes | Deterministic patterns and recurrence |
| Apply to return | Yes | Yes | Shows each change before it is applied |

### Transaction Import Formats

| Format | Supported | Notes |
|--------|-----------|-------|
| Chase CSV | Yes | Auto-detected |
| Bank of America CSV | Yes | Auto-detected |
| Citi CSV | Yes | Split debit/credit columns |
| American Express CSV | Yes | Includes MCC codes |
| Wells Fargo CSV | Yes | Auto-detected |
| Monarch Money CSV | Yes | Auto-detected via institution/notes columns |
| YNAB CSV | Yes | Outflow/inflow format |
| Copilot CSV | Yes | Auto-detected via account name/status columns |
| Apple Card CSV | Yes | Amount (USD) format, includes MCC |
| Generic CSV | Yes | Fuzzy column matching fallback |

### Privacy and security

| Feature | Notes |
|---------|-------|
| AES-256-GCM encryption | Every case, document file and audit trail, at rest |
| No outbound AI requests | The models are local; there is nothing to strip or send |
| Model run records | Each reading's model, file hash and result are kept with the case |

## Adding a New Feature

When building a new feature, ask:

1. **Does it need a model?** If yes, it runs on the local models only — never a cloud service.
2. **What happens without the models?** Hold the work for the preparer with the reason; never guess a value.
3. **Can a reading be checked?** Confirm it against the page, a second reader or the client's own words before it reaches the return.
4. **Is it in the audit trail?** Every model reading that changes a case must be recorded.

## Design Principles

- **The engine decides the tax.** Models read documents and replies; they never compute or choose a tax amount.
- **Fail closed.** An unread or disputed value is held for the preparer, never zero and never assumed.
- **The preparer decides.** Model readings are offered or held; the preparer accepts, corrects and approves.
- **Be honest about tradeoffs.** Say what was not read, and why.
